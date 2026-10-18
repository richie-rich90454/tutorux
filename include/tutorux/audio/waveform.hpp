#pragma once

#include "tutorux/audio/timeline.hpp"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <vector>

namespace tutorux::audio {

struct WaveformBucket final {
    std::uint64_t startFrame{};
    std::uint64_t endFrame{};
    std::int16_t minimum{};
    std::int16_t maximum{};
    bool containsGap{};
};

struct WaveformSummary final {
    AudioTimelineInfo timeline;
    std::vector<WaveformBucket> buckets;
};

core::Result<WaveformSummary> buildWaveform(archive::Archive& archive,
                                            const archive::Uuid& sessionId,
                                            std::optional<archive::Uuid> trackId = {},
                                            std::size_t maximumBuckets = 512,
                                            std::function<bool()> stopRequested = {});

} // namespace tutorux::audio
