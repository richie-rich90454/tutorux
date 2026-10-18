#include "playback_platform.hpp"

#include <alsa/asoundlib.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace tutorux::audio::detail {
namespace {

    constexpr std::size_t minimumFramesPerBuffer = 256;
    constexpr std::size_t maximumFramesPerBuffer = 4'096;

    core::Error alsaPlaybackError(std::string_view operation, int errorCode) {
        return core::error("audio_playback_device_failed",
                           std::string(operation) + ": " + snd_strerror(errorCode));
    }

    class PcmDevice final {
      public:
        PcmDevice() = default;
        PcmDevice(const PcmDevice&) = delete;
        PcmDevice& operator=(const PcmDevice&) = delete;
        ~PcmDevice() {
            if (device_)
                snd_pcm_close(device_);
        }

        snd_pcm_t** put() noexcept {
            return &device_;
        }

        snd_pcm_t* get() const noexcept {
            return device_;
        }

      private:
        snd_pcm_t* device_{};
    };

} // namespace

core::Result<PcmPlaybackResult> playPcmSource(PcmPlaybackSource source) {
    if (!source.readFrames || source.sampleRateHz < 8'000 || source.sampleRateHz > 384'000 ||
        source.channelCount == 0 || source.channelCount > 8) {
        return std::unexpected(core::error(
            "audio_playback_format_invalid",
            "Playback requires 16-bit PCM with a supported sample rate and channel count."));
    }

    PcmDevice device;
    int result = snd_pcm_open(device.put(), "default", SND_PCM_STREAM_PLAYBACK, 0);
    if (result < 0)
        return std::unexpected(
            alsaPlaybackError("Opening the default ALSA playback device", result));

    result = snd_pcm_set_params(device.get(), SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
                                source.channelCount, source.sampleRateHz, 1, 200'000);
    if (result < 0) {
        return std::unexpected(alsaPlaybackError("Configuring ALSA PCM playback", result));
    }

    const std::size_t framesPerBuffer =
        std::clamp(static_cast<std::size_t>(source.sampleRateHz / 20U), minimumFramesPerBuffer,
                   maximumFramesPerBuffer);
    std::vector<std::int16_t> samples(framesPerBuffer * source.channelCount);
    PcmPlaybackResult playback;
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

        snd_pcm_uframes_t writtenFrames = 0;
        while (writtenFrames < *frameCount) {
            const auto* frameStart =
                samples.data() + static_cast<std::size_t>(writtenFrames) * source.channelCount;
            const snd_pcm_uframes_t remainingFrames =
                static_cast<snd_pcm_uframes_t>(*frameCount - writtenFrames);
            result = static_cast<int>(snd_pcm_writei(device.get(), frameStart, remainingFrames));
            if (result == -EINTR)
                continue;
            if (result < 0) {
                const int recovered = snd_pcm_recover(device.get(), result, 1);
                if (recovered < 0) {
                    return std::unexpected(
                        alsaPlaybackError("Recovering ALSA playback after an underrun", recovered));
                }
                continue;
            }
            if (result == 0)
                continue;
            writtenFrames += static_cast<snd_pcm_uframes_t>(result);
            playback.playedFrames += static_cast<std::uint64_t>(result);
            if (source.progress)
                source.progress(playback.playedFrames);
            if (source.stopRequested && source.stopRequested())
                break;
        }
        if (source.stopRequested && source.stopRequested())
            break;
    }

    if (playback.reachedEnd) {
        result = snd_pcm_drain(device.get());
        if (result < 0)
            return std::unexpected(alsaPlaybackError("Draining ALSA playback", result));
    } else {
        static_cast<void>(snd_pcm_drop(device.get()));
    }
    return playback;
}

} // namespace tutorux::audio::detail
