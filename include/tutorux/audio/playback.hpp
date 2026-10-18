#pragma once

#include "tutorux/audio/timeline.hpp"

#include <cstdint>
#include <functional>
#include <optional>

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

core::Result<PlaybackSummary> playArchiveTrack(archive::Archive& archive,
                                               const archive::Uuid& sessionId,
                                               PlaybackOptions options = {});

} // namespace tutorux::audio
