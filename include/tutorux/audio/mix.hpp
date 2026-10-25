#pragma once

#include "tutorux/archive/archive.hpp"
#include "tutorux/core/result.hpp"

#include <string>
#include <vector>

namespace tutorux::audio {

struct TrackMixSummary final {
    archive::Uuid trackId{};
    std::uint32_t sampleRateHz{};
    std::uint16_t channelCount{};
    std::uint64_t frameCount{};
    std::uint64_t durationUs{};
    std::uint64_t chunkCount{};
};

// Mix synchronized tracks from one take into a new, recoverable track in that
// take. Source tracks are left untouched. The output uses signed 16-bit PCM.
core::Result<TrackMixSummary> mixTracksIntoTake(archive::Archive& archive,
                                                const archive::Uuid& sessionId,
                                                const archive::Uuid& takeId,
                                                const std::vector<archive::Uuid>& trackIds,
                                                std::string label);

} // namespace tutorux::audio
