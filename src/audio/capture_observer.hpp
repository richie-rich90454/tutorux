#pragma once

#include "tutorux/audio/capture.hpp"

#include <algorithm>
#include <exception>
#include <limits>
#include <span>
#include <string>

namespace tutorux::audio::detail {

inline constexpr std::size_t kMaximumPcmNotificationBytes = 1'048'576;

inline std::uint64_t sampleOffsetMicroseconds(std::uint64_t samples, std::uint32_t sampleRateHz) noexcept {
    if (sampleRateHz == 0)
        return 0;
    const std::uint64_t seconds = samples / sampleRateHz;
    const std::uint64_t remainder = samples % sampleRateHz;
    constexpr std::uint64_t microsecondsPerSecond = 1'000'000ULL;
    if (seconds > std::numeric_limits<std::uint64_t>::max() / microsecondsPerSecond)
        return std::numeric_limits<std::uint64_t>::max();
    const std::uint64_t wholeSeconds = seconds * microsecondsPerSecond;
    const std::uint64_t fractionalSecond = (remainder * microsecondsPerSecond) / sampleRateHz;
    return fractionalSecond > std::numeric_limits<std::uint64_t>::max() - wholeSeconds ? std::numeric_limits<std::uint64_t>::max()
                                                                                       : wholeSeconds + fractionalSecond;
}

inline void notifyPcmChunk(const CaptureOptions& options, CaptureSummary& summary, std::uint64_t recordingStartedAtUs,
                           std::uint64_t firstSampleIndex, std::uint64_t frameCount, std::span<const std::byte> samples) {
    if (!options.pcmChunk || summary.pcmObserverFailure)
        return;

    if (samples.size() > kMaximumPcmNotificationBytes) {
        summary.pcmObserverFailure =
            core::error("audio_pcm_observer_chunk_oversized", "A committed PCM chunk exceeded the 1 MiB live-observer limit.");
        return;
    }

    const std::uint64_t offsetUs = sampleOffsetMicroseconds(firstSampleIndex, summary.sampleRateHz);
    const std::uint64_t timestampUs = offsetUs > std::numeric_limits<std::uint64_t>::max() - recordingStartedAtUs
                                          ? std::numeric_limits<std::uint64_t>::max()
                                          : recordingStartedAtUs + offsetUs;
    const PcmCaptureChunk chunk{
        summary.trackId,  summary.sampleRateHz, summary.channelCount, timestampUs,
        firstSampleIndex, frameCount,           summary.sampleFormat, samples,
    };

    try {
        options.pcmChunk(chunk);
    } catch (const std::exception& error) {
        summary.pcmObserverFailure =
            core::error("audio_pcm_observer_failed", std::string("The PCM observer callback threw an exception: ") + error.what());
    } catch (...) {
        summary.pcmObserverFailure = core::error("audio_pcm_observer_failed", "The PCM observer callback threw an unknown exception.");
    }
}

} // namespace tutorux::audio::detail
