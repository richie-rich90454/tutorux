#include "playback_platform.hpp"

#if defined(__APPLE__)
#include <AudioToolbox/AudioQueue.h>

#include <algorithm>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>
#endif

namespace tutorux::audio::detail {

#if defined(__APPLE__)
namespace {

    constexpr std::size_t minimumFramesPerBuffer = 256;
    constexpr std::size_t maximumFramesPerBuffer = 4'096;

    core::Error audioQueueError(std::string_view operation, OSStatus status) {
        return core::error("audio_playback_device_failed", std::string(operation) +
                                                               " failed (OSStatus " +
                                                               std::to_string(status) + ").");
    }

    struct OutputContext final {
        std::mutex mutex;
        std::condition_variable condition;
        bool bufferCompleted{};
    };

    void outputCallback(void* userData, AudioQueueRef, AudioQueueBufferRef) noexcept {
        auto& context = *static_cast<OutputContext*>(userData);
        {
            std::lock_guard lock(context.mutex);
            context.bufferCompleted = true;
        }
        context.condition.notify_one();
    }

    class AudioQueueOwner final {
      public:
        AudioQueueOwner() = default;
        AudioQueueOwner(const AudioQueueOwner&) = delete;
        AudioQueueOwner& operator=(const AudioQueueOwner&) = delete;
        ~AudioQueueOwner() {
            if (queue_)
                static_cast<void>(AudioQueueDispose(queue_, true));
        }

        AudioQueueRef* put() noexcept {
            return &queue_;
        }

        AudioQueueRef get() const noexcept {
            return queue_;
        }

      private:
        AudioQueueRef queue_{};
    };

} // namespace

core::Result<PcmPlaybackResult> playPcmSource(PcmPlaybackSource source) {
    if (!source.readFrames || source.sampleRateHz < 8'000 || source.sampleRateHz > 384'000 ||
        source.channelCount == 0 || source.channelCount > 8) {
        return std::unexpected(core::error(
            "audio_playback_format_invalid",
            "Playback requires 16-bit PCM with a supported sample rate and channel count."));
    }

    const std::uint32_t bytesPerFrame = static_cast<std::uint32_t>(source.channelCount) * 2U;
    AudioStreamBasicDescription format{};
    format.mSampleRate = source.sampleRateHz;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked |
                          kAudioFormatFlagsNativeEndian;
    format.mBytesPerPacket = bytesPerFrame;
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = bytesPerFrame;
    format.mChannelsPerFrame = source.channelCount;
    format.mBitsPerChannel = 16;

    OutputContext context;
    AudioQueueOwner queue;
    OSStatus status =
        AudioQueueNewOutput(&format, outputCallback, &context, nullptr, nullptr, 0, queue.put());
    if (status != noErr)
        return std::unexpected(audioQueueError("Creating the CoreAudio output queue", status));

    const std::size_t framesPerBuffer =
        std::clamp(static_cast<std::size_t>(source.sampleRateHz / 20U), minimumFramesPerBuffer,
                   maximumFramesPerBuffer);
    const std::size_t bufferBytes = framesPerBuffer * bytesPerFrame;
    AudioQueueBufferRef buffer{};
    status = AudioQueueAllocateBuffer(queue.get(), static_cast<UInt32>(bufferBytes), &buffer);
    if (status != noErr)
        return std::unexpected(audioQueueError("Allocating a CoreAudio playback buffer", status));

    std::vector<std::int16_t> samples(framesPerBuffer * source.channelCount);
    PcmPlaybackResult playback;
    bool started = false;
    while (true) {
        if (source.stopRequested && source.stopRequested())
            break;
        auto frameCount = source.readFrames(samples);
        if (!frameCount)
            return std::unexpected(frameCount.error());
        if (*frameCount == 0) {
            playback.reachedEnd = true;
            break;
        }

        const auto byteCount = static_cast<UInt32>(*frameCount * bytesPerFrame);
        std::memcpy(buffer->mAudioData, samples.data(), static_cast<std::size_t>(byteCount));
        buffer->mAudioDataByteSize = byteCount;
        {
            std::lock_guard lock(context.mutex);
            context.bufferCompleted = false;
        }
        status = AudioQueueEnqueueBuffer(queue.get(), buffer, 0, nullptr);
        if (status != noErr)
            return std::unexpected(
                audioQueueError("Submitting a CoreAudio playback buffer", status));
        if (!started) {
            status = AudioQueueStart(queue.get(), nullptr);
            if (status != noErr)
                return std::unexpected(audioQueueError("Starting CoreAudio playback", status));
            started = true;
        }
        {
            std::unique_lock lock(context.mutex);
            context.condition.wait(lock, [&] {
                return context.bufferCompleted;
            });
        }
        playback.playedFrames += *frameCount;
        if (source.progress)
            source.progress(playback.playedFrames);
    }

    if (started) {
        status = AudioQueueStop(queue.get(), !playback.reachedEnd);
        if (status != noErr)
            return std::unexpected(audioQueueError("Stopping CoreAudio playback", status));
    }
    return playback;
}

#endif

} // namespace tutorux::audio::detail
