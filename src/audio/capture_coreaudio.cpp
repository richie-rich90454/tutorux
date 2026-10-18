#include "tutorux/audio/coreaudio_backend.hpp"

#include "tutorux/domain/entities.hpp"
#include "capture_observer.hpp"
#include "preflight_metrics.hpp"

#if defined(__APPLE__)
#include <AudioToolbox/AudioQueue.h>
#include <CoreAudio/CoreAudio.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>
#endif

namespace tutorux::audio {

#if defined(__APPLE__)
namespace {

    constexpr std::uint32_t kSampleRateHz = 48'000;
    constexpr std::uint16_t kChannelCount = 1;
    constexpr std::size_t kQueueSlots = 16;
    constexpr std::size_t kQueueBufferCount = 3;
    constexpr std::size_t kMaximumQueueBufferBytes = 1U << 20U;

    core::Error coreAudioError(std::string code, std::string_view operation, OSStatus status) {
        return core::error(std::move(code), std::string(operation) + " failed (OSStatus " + std::to_string(status) + ").");
    }

    std::uint64_t samplesToMicroseconds(std::uint64_t samples) {
        const std::uint64_t seconds = samples / kSampleRateHz;
        const std::uint64_t remainder = samples % kSampleRateHz;
        return seconds * 1'000'000ULL + (remainder * 1'000'000ULL) / kSampleRateHz;
    }

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    }

    core::Status updateRecordingSession(archive::Archive& archive, archive::Record& session, std::string state, std::uint64_t chunks,
                                        std::uint64_t samples, std::uint64_t bytes, std::string error = {}) {
        session.fields["recording_state"] = std::move(state);
        session.fields["recording_audio_chunks"] = std::to_string(chunks);
        session.fields["recording_samples"] = std::to_string(samples);
        session.fields["recording_bytes"] = std::to_string(bytes);
        session.fields["recording_error"] = std::move(error);
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        return archive.put(session);
    }

    core::Result<AudioDeviceID> defaultInputDevice() {
        AudioObjectPropertyAddress address{
            kAudioHardwarePropertyDefaultInputDevice,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain,
        };
        AudioDeviceID deviceId = kAudioObjectUnknown;
        UInt32 size = sizeof(deviceId);
        const OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, &deviceId);
        if (status != noErr || deviceId == kAudioObjectUnknown) {
            return std::unexpected(coreAudioError("audio_default_device_failed", "Reading the default CoreAudio input", status));
        }
        return deviceId;
    }

    core::Result<AudioDeviceID> parseDeviceId(std::string_view value) {
        if (value.empty())
            return defaultInputDevice();
        AudioDeviceID deviceId{};
        const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), deviceId);
        if (error != std::errc{} || end != value.data() + value.size() || deviceId == kAudioObjectUnknown) {
            return std::unexpected(core::error("audio_device_id_invalid", "The CoreAudio device ID must be a numeric ID."));
        }
        return deviceId;
    }

    struct AudioQueueContext final {
        struct Slot final {
            std::vector<std::byte> bytes;
        };

        std::array<Slot, kQueueSlots> slots;
        std::mutex mutex;
        std::condition_variable condition;
        AudioQueueRef queue{};
        std::size_t head{};
        std::size_t count{};
        bool stopping{};
        bool discontinuity{};
        OSStatus callbackError{noErr};
    };

    void inputCallback(void* userData, AudioQueueRef queue, AudioQueueBufferRef buffer, const AudioTimeStamp*, UInt32,
                       const AudioStreamPacketDescription*) noexcept {
        auto& context = *static_cast<AudioQueueContext*>(userData);
        bool shouldRequeue = false;
        {
            std::lock_guard lock(context.mutex);
            if (!context.stopping && buffer->mAudioDataByteSize != 0) {
                const std::size_t writeIndex = (context.head + context.count) % kQueueSlots;
                auto& destination = context.slots[writeIndex].bytes;
                const std::size_t byteCount = buffer->mAudioDataByteSize;
                if (context.count == kQueueSlots || byteCount > destination.capacity()) {
                    context.discontinuity = true;
                } else {
                    destination.resize(byteCount);
                    std::memcpy(destination.data(), buffer->mAudioData, byteCount);
                    ++context.count;
                }
                shouldRequeue = true;
            }
        }
        if (shouldRequeue) {
            const OSStatus status = AudioQueueEnqueueBuffer(queue, buffer, 0, nullptr);
            if (status != noErr) {
                std::lock_guard lock(context.mutex);
                context.callbackError = status;
            }
        }
        context.condition.notify_one();
    }

    void discardInputCallback(void*, AudioQueueRef, AudioQueueBufferRef, const AudioTimeStamp*, UInt32,
                              const AudioStreamPacketDescription*) noexcept {}

    struct PreflightAudioQueueContext final {
        std::mutex mutex;
        std::condition_variable condition;
        detail::LevelAccumulator levels;
        std::uint64_t framesMeasured{};
        OSStatus callbackError{noErr};
        bool stopping{};
    };

    void preflightInputCallback(void* userData, AudioQueueRef queue, AudioQueueBufferRef buffer, const AudioTimeStamp*, UInt32,
                                const AudioStreamPacketDescription*) noexcept {
        auto& context = *static_cast<PreflightAudioQueueContext*>(userData);
        bool shouldRequeue = false;
        {
            std::lock_guard lock(context.mutex);
            if (!context.stopping) {
                if (buffer->mAudioDataByteSize % sizeof(std::int16_t) != 0 ||
                    buffer->mAudioDataByteSize > buffer->mAudioDataBytesCapacity) {
                    context.callbackError = kAudio_ParamError;
                } else {
                    const auto frameCount = static_cast<std::uint64_t>(buffer->mAudioDataByteSize / sizeof(std::int16_t));
                    if (frameCount > std::numeric_limits<std::uint64_t>::max() - context.framesMeasured) {
                        context.callbackError = kAudio_ParamError;
                    } else {
                        const auto* samples = static_cast<const std::int16_t*>(buffer->mAudioData);
                        for (std::uint64_t index = 0; index < frameCount; ++index) {
                            context.levels.add(static_cast<double>(samples[index]) / 32'768.0);
                        }
                        context.framesMeasured += frameCount;
                        shouldRequeue = true;
                    }
                }
            }
        }
        if (shouldRequeue) {
            const OSStatus status = AudioQueueEnqueueBuffer(queue, buffer, 0, nullptr);
            if (status != noErr) {
                std::lock_guard lock(context.mutex);
                context.callbackError = status;
            }
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
                AudioQueueDispose(queue_, true);
        }

        AudioQueueRef* put() {
            return &queue_;
        }
        AudioQueueRef get() const {
            return queue_;
        }

      private:
        AudioQueueRef queue_{};
    };

    AudioStreamBasicDescription captureFormat() {
        AudioStreamBasicDescription format{};
        format.mSampleRate = kSampleRateHz;
        format.mFormatID = kAudioFormatLinearPCM;
        format.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked | kAudioFormatFlagsNativeEndian;
        format.mBytesPerPacket = sizeof(std::int16_t) * kChannelCount;
        format.mFramesPerPacket = 1;
        format.mBytesPerFrame = sizeof(std::int16_t) * kChannelCount;
        format.mChannelsPerFrame = kChannelCount;
        format.mBitsPerChannel = 16;
        return format;
    }

    core::Status createInputQueue(AudioQueueOwner& owner, AudioDeviceID deviceId, AudioQueueInputCallback callback, void* context,
                                  std::size_t bufferBytes) {
        const auto format = captureFormat();
        OSStatus status = AudioQueueNewInput(&format, callback, context, nullptr, kCFRunLoopCommonModes, 0, owner.put());
        if (status != noErr)
            return std::unexpected(coreAudioError("audio_queue_create_failed", "Creating a CoreAudio input queue", status));
        status = AudioQueueSetProperty(owner.get(), kAudioQueueProperty_CurrentDevice, &deviceId, sizeof(deviceId));
        if (status != noErr)
            return std::unexpected(coreAudioError("audio_device_open_failed", "Selecting the CoreAudio input device", status));

        if (context) {
            auto& queueContext = *static_cast<AudioQueueContext*>(context);
            queueContext.queue = owner.get();
            for (auto& slot : queueContext.slots)
                slot.bytes.reserve(bufferBytes);
        }
        return {};
    }

    core::Status allocateAndEnqueueBuffers(AudioQueueRef queue, std::size_t bufferBytes) {
        for (std::size_t index = 0; index < kQueueBufferCount; ++index) {
            AudioQueueBufferRef buffer{};
            const OSStatus status = AudioQueueAllocateBuffer(queue, static_cast<UInt32>(bufferBytes), &buffer);
            if (status != noErr)
                return std::unexpected(coreAudioError("audio_buffer_allocate_failed", "Allocating a CoreAudio input buffer", status));
            const OSStatus enqueueStatus = AudioQueueEnqueueBuffer(queue, buffer, 0, nullptr);
            if (enqueueStatus != noErr)
                return std::unexpected(coreAudioError("audio_buffer_enqueue_failed", "Queuing a CoreAudio input buffer", enqueueStatus));
        }
        return {};
    }

    core::Status appendCapturedChunk(archive::Archive& archive, archive::Record& session, const archive::Uuid& sessionId,
                                     const archive::Uuid& trackId, std::uint64_t sequence, std::uint64_t firstSample,
                                     std::uint64_t frameCount, std::uint64_t totalStoredSamples, std::uint64_t totalStoredBytes,
                                     bool containsDiscontinuity, archive::Bytes payload) {
        if (firstSample > std::numeric_limits<std::uint64_t>::max() - frameCount ||
            totalStoredSamples > std::numeric_limits<std::uint64_t>::max() - frameCount ||
            payload.size() > std::numeric_limits<std::uint64_t>::max() - totalStoredBytes ||
            sequence == std::numeric_limits<std::uint64_t>::max()) {
            return std::unexpected(core::error("audio_capture_counter_invalid", "Recording counters overflowed."));
        }
        archive::Record chunk;
        chunk.type = archive::RecordType::AudioChunk;
        chunk.id = archive::randomUuid();
        chunk.fields = {
            {"session_id", archive::uuidToString(sessionId)},
            {"track_id", archive::uuidToString(trackId)},
            {"sequence_number", std::to_string(sequence)},
            {"first_sample_index", std::to_string(firstSample)},
            {"sample_count", std::to_string(frameCount)},
            {"gap_before_samples", "0"},
            {"timeline_start_us", std::to_string(samplesToMicroseconds(firstSample))},
            {"timeline_end_us", std::to_string(samplesToMicroseconds(firstSample + frameCount))},
            {"sample_format", "pcm_s16le"},
            {"sample_rate_hz", std::to_string(kSampleRateHz)},
            {"channel_count", std::to_string(kChannelCount)},
            {"channel_mask", "0"},
            {"codec", "none"},
            {"source", domain::getField(session, "recording_source", "microphone")},
            {"contains_device_discontinuity", containsDiscontinuity ? "true" : "false"},
            {"payload_checksum", std::to_string(archive::crc32(payload))}
        };
        chunk.blob = std::move(payload);

        session.fields["recording_audio_chunks"] = std::to_string(sequence + 1);
        session.fields["recording_samples"] = std::to_string(totalStoredSamples + frameCount);
        session.fields["recording_timeline_samples"] = std::to_string(firstSample + frameCount);
        session.fields["recording_bytes"] = std::to_string(totalStoredBytes + chunk.blob.size());
        session.fields["recording_state"] = "recording";
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        std::vector<archive::Record> transaction;
        transaction.reserve(2);
        transaction.push_back(std::move(chunk));
        transaction.push_back(session);
        return archive.putMany(std::move(transaction));
    }

} // namespace

core::Result<CaptureDeviceProbe> probeCoreAudioCaptureDevice(std::string deviceId) {
    auto parsedDeviceId = parseDeviceId(deviceId);
    if (!parsedDeviceId)
        return std::unexpected(parsedDeviceId.error());
    AudioQueueOwner queue;
    if (auto status = createInputQueue(queue, *parsedDeviceId, discardInputCallback, nullptr, 4'800 * sizeof(std::int16_t)); !status) {
        return std::unexpected(status.error());
    }
    return CaptureDeviceProbe{std::to_string(*parsedDeviceId), "pcm_s16le", kSampleRateHz, kChannelCount};
}

core::Result<CapturePreflightSummary> preflightCoreAudioCaptureDevice(CapturePreflightOptions options) {
    if (auto status = detail::validatePreflightOptions(options); !status)
        return std::unexpected(status.error());
    auto parsedDeviceId = parseDeviceId(options.deviceId);
    if (!parsedDeviceId)
        return std::unexpected(parsedDeviceId.error());

    PreflightAudioQueueContext callbackContext;
    AudioQueueOwner queue;
    const auto format = captureFormat();
    OSStatus audioStatus =
        AudioQueueNewInput(&format, preflightInputCallback, &callbackContext, nullptr, kCFRunLoopCommonModes, 0, queue.put());
    if (audioStatus != noErr) {
        return std::unexpected(coreAudioError("audio_queue_create_failed", "Creating a microphone check input queue", audioStatus));
    }
    audioStatus = AudioQueueSetProperty(queue.get(), kAudioQueueProperty_CurrentDevice, &*parsedDeviceId, sizeof(*parsedDeviceId));
    if (audioStatus != noErr) {
        return std::unexpected(coreAudioError("audio_device_open_failed", "Selecting the microphone check device", audioStatus));
    }

    constexpr std::size_t kPreflightBufferBytes = 4'800 * sizeof(std::int16_t);
    if (auto status = allocateAndEnqueueBuffers(queue.get(), kPreflightBufferBytes); !status)
        return std::unexpected(status.error());
    audioStatus = AudioQueueStart(queue.get(), nullptr);
    if (audioStatus != noErr) {
        return std::unexpected(coreAudioError("audio_preflight_start_failed", "Starting the microphone access check", audioStatus));
    }

    const auto startedAt = std::chrono::steady_clock::now();
    auto nextNotification = startedAt + options.levelInterval;
    const auto deadline = startedAt + options.duration;
    while (std::chrono::steady_clock::now() < deadline) {
        detail::LevelMeasurement window;
        std::uint64_t framesMeasured = 0;
        OSStatus callbackError = noErr;
        {
            std::unique_lock lock(callbackContext.mutex);
            callbackContext.condition.wait_until(lock, nextNotification, [&] {
                return callbackContext.callbackError != noErr;
            });
            callbackError = callbackContext.callbackError;
            if (callbackError == noErr) {
                window = callbackContext.levels.takeWindow();
                framesMeasured = callbackContext.framesMeasured;
            }
        }
        if (callbackError != noErr) {
            AudioQueueStop(queue.get(), true);
            return std::unexpected(coreAudioError("audio_preflight_callback_failed", "Receiving microphone check samples", callbackError));
        }

        const auto now = std::chrono::steady_clock::now();
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - startedAt);
        if (window.sampleValueCount != 0) {
            auto level = detail::makeCaptureInputLevel(window, kChannelCount, elapsed);
            level.framesMeasured = framesMeasured;
            if (auto status = detail::notifyPreflightLevel(options, level); !status) {
                AudioQueueStop(queue.get(), true);
                return std::unexpected(status.error());
            }
        }
        nextNotification += options.levelInterval;
        if (nextNotification <= now)
            nextNotification = now + options.levelInterval;
    }

    audioStatus = AudioQueueStop(queue.get(), true);
    if (audioStatus != noErr) {
        return std::unexpected(coreAudioError("audio_preflight_stop_failed", "Stopping the microphone access check", audioStatus));
    }

    detail::LevelMeasurement finalWindow;
    detail::LevelMeasurement total;
    std::uint64_t framesMeasured = 0;
    OSStatus callbackError = noErr;
    {
        std::lock_guard lock(callbackContext.mutex);
        callbackContext.stopping = true;
        callbackError = callbackContext.callbackError;
        finalWindow = callbackContext.levels.takeWindow();
        total = callbackContext.levels.total();
        framesMeasured = callbackContext.framesMeasured;
    }
    if (callbackError != noErr) {
        return std::unexpected(coreAudioError("audio_preflight_callback_failed", "Receiving microphone check samples", callbackError));
    }
    if (framesMeasured == 0) {
        return std::unexpected(
            core::error("audio_preflight_no_samples", "The selected microphone opened, but it produced no samples during the check."));
    }

    if (finalWindow.sampleValueCount != 0) {
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - startedAt);
        auto level = detail::makeCaptureInputLevel(finalWindow, kChannelCount, elapsed);
        level.framesMeasured = framesMeasured;
        if (auto status = detail::notifyPreflightLevel(options, level); !status)
            return std::unexpected(status.error());
    }

    CaptureDeviceProbe device{std::to_string(*parsedDeviceId), "pcm_s16le", kSampleRateHz, kChannelCount};
    return detail::makeCapturePreflightSummary(
        std::move(device), total, std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - startedAt));
}

core::Result<CaptureSummary> captureCoreAudio(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options) {
    if (options.source == DeviceKind::playback && options.deviceId.empty()) {
        return std::unexpected(
            core::error("audio_monitor_required", "Select a CoreAudio virtual loopback input explicitly for system-audio capture."));
    }
    if (options.maximumDuration && options.maximumDuration->count() <= 0) {
        return std::unexpected(core::error("audio_capture_duration_invalid", "Maximum capture duration must be positive."));
    }
    auto sessionResult = archive.get(archive::RecordType::Session, sessionId);
    if (!sessionResult)
        return std::unexpected(sessionResult.error());
    if (!*sessionResult || domain::isDeleted(**sessionResult)) {
        return std::unexpected(core::error("session_not_found", "Session was not found in the archive."));
    }
    archive::Record session = std::move(**sessionResult);
    const std::string previousState = domain::getField(session, "recording_state");
    if (previousState == "initializing" || previousState == "recording" || previousState == "paused" || previousState == "finalizing") {
        return std::unexpected(core::error("audio_capture_session_busy", "Session already has an active recording."));
    }
    bool sessionHasAudio = false;
    if (auto status = archive.forEachAudioChunk(sessionId, options.trackId,
                                                [&](archive::Record&&) {
                                                    sessionHasAudio = true;
                                                    return false;
                                                });
        !status) {
        return std::unexpected(status.error());
    }
    if (sessionHasAudio) {
        return std::unexpected(
            core::error("audio_capture_audio_exists", "Session already contains audio. Create a new session or explicitly merge audio."));
    }

    auto parsedDeviceId = parseDeviceId(options.deviceId);
    if (!parsedDeviceId)
        return std::unexpected(parsedDeviceId.error());
    constexpr std::size_t kQueueBufferBytes = 4'800 * sizeof(std::int16_t);
    AudioQueueContext callbackContext;
    AudioQueueOwner queue;
    if (auto status = createInputQueue(queue, *parsedDeviceId, inputCallback, &callbackContext, kQueueBufferBytes); !status) {
        return std::unexpected(status.error());
    }
    if (auto status = allocateAndEnqueueBuffers(queue.get(), kQueueBufferBytes); !status)
        return std::unexpected(status.error());

    CaptureSummary summary;
    summary.trackId = options.trackId.value_or(archive::randomUuid());
    summary.deviceId = activeDeviceId;
    summary.sampleFormat = "pcm_s16le";
    summary.sampleRateHz = kSampleRateHz;
    summary.channelCount = kChannelCount;
    summary.channelMask = 0;
    const std::string activeDeviceId = std::to_string(*parsedDeviceId);
    session.fields["recording_track_id"] = archive::uuidToString(summary.trackId);
    const std::string sourceName = options.source == DeviceKind::microphone ? "microphone" : "system-audio-loopback";
    session.fields["recording_source"] = sourceName;
    session.fields["recording_durability"] = options.durability == DurabilityPolicy::maximum        ? "maximum"
                                             : options.durability == DurabilityPolicy::reducedWrite ? "reduced-write"
                                                                                                    : "default";
    session.fields["recording_device_id"] = activeDeviceId;
    session.fields["recording_consent"] = "explicit";
    session.fields["recording_consent_at_us"] = std::to_string(nowUnixMicroseconds());
    session.fields["recording_consent_confirmed_by"] = options.consentConfirmedBy;
    session.fields["recording_consent_sources"] = sourceName;
    session.fields["recording_consent_policy_version"] = "1";
    session.fields["recording_sample_format"] = "pcm_s16le";
    session.fields["recording_sample_rate_hz"] = std::to_string(kSampleRateHz);
    session.fields["recording_channel_count"] = std::to_string(kChannelCount);
    session.fields["recording_channel_mask"] = "0";
    const std::uint64_t recordingStartedAtUs = nowUnixMicroseconds();
    session.fields["recording_started_at_us"] = std::to_string(recordingStartedAtUs);
    session.fields["recording_audio_chunks"] = "0";
    session.fields["recording_samples"] = "0";
    session.fields["recording_timeline_samples"] = "0";
    session.fields["recording_bytes"] = "0";
    session.fields["recording_discontinuities"] = "0";
    if (auto status = updateRecordingSession(archive, session, "initializing", 0, 0, 0); !status) {
        return std::unexpected(status.error());
    }
    if (options.stateChanged)
        options.stateChanged("initializing", "Preparing the CoreAudio input.");

    if (options.waitForSynchronizedStart && !options.waitForSynchronizedStart()) {
        const auto error =
            core::error("audio_synchronized_start_cancelled", "A synchronized capture peer failed before both tracks started.");
        if (auto status = updateRecordingSession(archive, session, "failed", 0, 0, 0, error.message); !status) {
            return std::unexpected(status.error());
        }
        return std::unexpected(error);
    }
    OSStatus audioStatus = AudioQueueStart(queue.get(), nullptr);
    if (audioStatus != noErr) {
        const auto error = coreAudioError("audio_capture_start_failed", "Starting CoreAudio input", audioStatus);
        if (auto status = updateRecordingSession(archive, session, "failed", 0, 0, 0, error.message); !status) {
            return std::unexpected(status.error());
        }
        return std::unexpected(error);
    }
    if (auto status = updateRecordingSession(archive, session, "recording", 0, 0, 0); !status) {
        AudioQueueStop(queue.get(), true);
        return std::unexpected(status.error());
    }
    if (options.stateChanged)
        options.stateChanged("recording", "Microphone capture is active.");

    const std::uint64_t intervalMilliseconds = options.durability == DurabilityPolicy::maximum        ? 100U
                                               : options.durability == DurabilityPolicy::reducedWrite ? 2'000U
                                                                                                      : 500U;
    const std::uint64_t bytesPerFrame = sizeof(std::int16_t);
    const std::uint64_t framesPerChunk = std::max<std::uint64_t>(1, kSampleRateHz * intervalMilliseconds / 1'000U);
    archive::Bytes pending;
    pending.reserve(static_cast<std::size_t>(framesPerChunk * bytesPerFrame));
    std::uint64_t sequence = 0;
    std::uint64_t storedSamples = 0;
    std::uint64_t storedBytes = 0;
    std::uint64_t timelineEndSample = 0;
    bool pendingDiscontinuity = false;
    bool paused = false;
    const auto startedAt = std::chrono::steady_clock::now();
    auto pausedAt = std::chrono::steady_clock::time_point{};
    auto totalPause = std::chrono::steady_clock::duration::zero();
    std::optional<core::Error> streamFailure;

    const auto writePending = [&]() -> core::Status {
        if (pending.empty())
            return {};
        if (pending.size() % bytesPerFrame != 0) {
            return std::unexpected(core::error("audio_capture_chunk_invalid", "Captured CoreAudio samples are misaligned."));
        }
        const std::uint64_t frames = pending.size() / bytesPerFrame;
        archive::Bytes payload = std::move(pending);
        pending.clear();
        archive::Bytes observerSamples;
        if (options.pcmChunk && !summary.pcmObserverFailure)
            observerSamples = payload;
        auto status = appendCapturedChunk(archive, session, sessionId, summary.trackId, sequence, timelineEndSample, frames, storedSamples,
                                          storedBytes, pendingDiscontinuity, std::move(payload));
        if (!status)
            return status;
        if (!observerSamples.empty()) {
            detail::notifyPcmChunk(options, summary, recordingStartedAtUs, timelineEndSample, frames, observerSamples);
        }
        ++sequence;
        storedSamples += frames;
        storedBytes += frames * bytesPerFrame;
        timelineEndSample += frames;
        pendingDiscontinuity = false;
        summary.chunkCount = sequence;
        summary.sampleCount = storedSamples;
        summary.timelineSampleCount = timelineEndSample;
        summary.byteCount = storedBytes;
        summary.durationUs = samplesToMicroseconds(timelineEndSample);
        if (options.progress)
            options.progress(summary);
        return {};
    };

    const auto consumeOne = [&]() -> bool {
        std::unique_lock lock(callbackContext.mutex);
        callbackContext.condition.wait_for(lock, std::chrono::milliseconds(100), [&] {
            return callbackContext.count != 0 || callbackContext.callbackError != noErr || callbackContext.stopping;
        });
        if (callbackContext.callbackError != noErr) {
            streamFailure = coreAudioError("audio_capture_callback_failed", "Receiving CoreAudio input", callbackContext.callbackError);
            callbackContext.callbackError = noErr;
            return false;
        }
        if (callbackContext.discontinuity) {
            pendingDiscontinuity = true;
            callbackContext.discontinuity = false;
        }
        if (callbackContext.count == 0)
            return true;
        auto& slot = callbackContext.slots[callbackContext.head];
        pending.insert(pending.end(), slot.bytes.begin(), slot.bytes.end());
        slot.bytes.clear();
        callbackContext.head = (callbackContext.head + 1) % kQueueSlots;
        --callbackContext.count;
        lock.unlock();
        if (pending.size() >= framesPerChunk * bytesPerFrame)
            return static_cast<bool>(writePending());
        return true;
    };

    while (true) {
        if (options.stopRequested && options.stopRequested())
            break;
        const auto now = std::chrono::steady_clock::now();
        const bool pauseRequested = options.pauseRequested && options.pauseRequested();
        if (pauseRequested && !paused) {
            while (true) {
                std::lock_guard lock(callbackContext.mutex);
                if (callbackContext.count == 0)
                    break;
                if (!consumeOne())
                    break;
            }
            if (streamFailure)
                break;
            if (auto status = writePending(); !status) {
                streamFailure = status.error();
                break;
            }
            audioStatus = AudioQueuePause(queue.get());
            if (audioStatus != noErr) {
                streamFailure = coreAudioError("audio_capture_pause_failed", "Pausing CoreAudio input", audioStatus);
                break;
            }
            if (auto status = updateRecordingSession(archive, session, "paused", sequence, storedSamples, storedBytes); !status) {
                streamFailure = status.error();
                break;
            }
            paused = true;
            pausedAt = now;
            if (options.stateChanged)
                options.stateChanged("paused", "Microphone capture is paused.");
        }
        if (paused) {
            if (options.stopRequested && options.stopRequested())
                break;
            if (options.pauseRequested && !options.pauseRequested()) {
                audioStatus = AudioQueueStart(queue.get(), nullptr);
                if (audioStatus != noErr) {
                    streamFailure = coreAudioError("audio_capture_resume_failed", "Resuming CoreAudio input", audioStatus);
                    break;
                }
                const auto resumedAt = std::chrono::steady_clock::now();
                totalPause += resumedAt - pausedAt;
                paused = false;
                if (auto status = updateRecordingSession(archive, session, "recording", sequence, storedSamples, storedBytes); !status) {
                    streamFailure = status.error();
                    break;
                }
                if (options.stateChanged)
                    options.stateChanged("recording", "Microphone capture resumed.");
            } else {
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                continue;
            }
        }
        if (options.maximumDuration && now - startedAt - totalPause >= *options.maximumDuration) {
            break;
        }
        if (!consumeOne())
            break;
    }

    {
        std::lock_guard lock(callbackContext.mutex);
        callbackContext.stopping = true;
    }
    callbackContext.condition.notify_all();
    AudioQueueStop(queue.get(), true);
    if (!streamFailure) {
        while (true) {
            std::lock_guard lock(callbackContext.mutex);
            if (callbackContext.count == 0)
                break;
            if (!consumeOne())
                break;
        }
    }
    if (!streamFailure) {
        if (auto status = writePending(); !status)
            streamFailure = status.error();
    }
    if (streamFailure) {
        const std::string state = sequence == 0 ? "failed" : "interrupted";
        auto status = updateRecordingSession(archive, session, state, sequence, storedSamples, storedBytes, streamFailure->message);
        if (!status) {
            return std::unexpected(core::error(
                streamFailure->code, streamFailure->message + " Unable to persist the capture failure state: " + status.error().message));
        }
        if (options.stateChanged)
            options.stateChanged(state, streamFailure->message);
        return std::unexpected(*streamFailure);
    }

    session.fields["recording_stopped_at_us"] = std::to_string(nowUnixMicroseconds());
    if (auto status = updateRecordingSession(archive, session, "completed", sequence, storedSamples, storedBytes); !status) {
        return std::unexpected(status.error());
    }
    summary.completed = true;
    summary.state = "completed";
    if (options.stateChanged)
        options.stateChanged("completed", "Recording is durably saved.");
    return summary;
}

#else

core::Result<CaptureDeviceProbe> probeCoreAudioCaptureDevice(std::string) {
    return std::unexpected(core::error("audio_backend_unavailable", "This build does not include the CoreAudio backend."));
}

core::Result<CapturePreflightSummary> preflightCoreAudioCaptureDevice(CapturePreflightOptions) {
    return std::unexpected(core::error("audio_backend_unavailable", "This build does not include the CoreAudio backend."));
}

core::Result<CaptureSummary> captureCoreAudio(archive::Archive&, const archive::Uuid&, CaptureOptions) {
    return std::unexpected(core::error("audio_backend_unavailable", "This build does not include the CoreAudio backend."));
}

#endif

} // namespace tutorux::audio
