#pragma once

#include "tutorux/audio/timeline.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <span>

namespace tutorux::audio {

struct PlaybackOptions final {
    std::optional<archive::Uuid> trackId;
    std::uint64_t startFrame{};
    std::optional<std::uint64_t> maximumFrames;
    std::function<bool()> stopRequested;
    std::function<void(std::uint64_t playedFrames, std::uint64_t totalFrames)> progress;
};

struct PlaybackSummary final {
    AudioTimelineInfo timeline;
    std::uint64_t startFrame{};
    std::uint64_t playedFrames{};
    std::uint64_t gapFramesPlayed{};
    std::uint64_t durationUs{};
    bool completed{};
};

struct PcmBufferPlaybackSummary final {
    std::uint64_t playedFrames{};
    bool completed{};
};

core::Result<PlaybackSummary> playArchiveTrack(archive::Archive& archive,
                                               const archive::Uuid& sessionId,
                                               PlaybackOptions options = {});

core::Result<PcmBufferPlaybackSummary> playPcmBuffer(
    std::uint32_t sampleRateHz, std::uint16_t channelCount,
    std::span<const std::int16_t> interleavedSamples,
    std::function<bool()> stopRequested = {},
    std::function<void(std::uint64_t playedFrames)> progress = {});

} // namespace tutorux::audio
