#pragma once

#include "tutorux/archive/archive.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace tutorux::audio {

// A recording take is one continuous capture or one imported source. Tracks
// within a take may be synchronized (for example microphone + system audio).
struct RecordingTake final {
    std::string id;
    std::string sessionId;
    std::string label;
    std::string source;
    std::string state;
    std::uint64_t startedAtUs{};
    std::uint64_t endedAtUs{};
    std::uint64_t durationUs{};
    std::vector<std::string> trackIds;
    bool legacy{};
};

// Take metadata is stored as an additive AssetMetadata record so version 1
// archives and older readers continue to work.
archive::Record makeRecordingTakeRecord(const archive::Uuid& takeId,
                                        const archive::Uuid& sessionId,
                                        std::string source,
                                        std::string state,
                                        const std::vector<archive::Uuid>& trackIds,
                                        std::uint64_t startedAtUs);

core::Status updateRecordingTake(archive::Archive& archive,
                                 const archive::Uuid& takeId,
                                 std::string state,
                                 std::uint64_t durationUs,
                                 std::uint64_t endedAtUs = 0);

core::Status renameRecordingTake(archive::Archive& archive,
                                 const archive::Uuid& takeId,
                                 std::string label);

core::Status setRecordingTakeDeleted(archive::Archive& archive,
                                     const archive::Uuid& takeId,
                                     bool deleted);

core::Result<std::vector<RecordingTake>> listRecordingTakes(
    archive::Archive& archive,
    const archive::Uuid& sessionId);

} // namespace tutorux::audio
