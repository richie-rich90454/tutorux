#pragma once

#include "tutorux/archive/archive.hpp"

#include <set>

namespace tutorux::archive {

struct SanitizedCopyOptions final {
    std::set<Uuid> includeStudents;
    std::set<Uuid> excludeStudents;
    std::set<Uuid> includeSessions;
    std::set<Uuid> excludeSessions;
    std::set<Uuid> includeRecordingTracks;
    std::set<Uuid> excludeRecordingTracks;
    bool includeRecordings{};
    bool includePrivateAnnotations{};
    bool includeGenerationLogs{};
    bool includeCredentials{};
};

struct SanitizedCopySummary final {
    std::uint64_t sourceGeneration{};
    std::string selectionFingerprint;
    std::uint64_t students{};
    std::uint64_t sessions{};
    std::uint64_t annotations{};
    std::uint64_t assets{};
    std::uint64_t evidenceItems{};
    std::uint64_t guides{};
    std::uint64_t recordingTracks{};
    std::uint64_t recordings{};
    std::uint64_t generationLogs{};
    std::uint64_t credentials{};
};

core::Result<SanitizedCopySummary> previewSanitizedCopy(const Archive& source,
                                                        const SanitizedCopyOptions& options);
core::Status createSanitizedCopy(const Archive& source, const SanitizedCopyOptions& options,
                                 const SanitizedCopySummary& expected,
                                 const std::filesystem::path& destination,
                                 std::string_view destinationPassphrase = {});

} // namespace tutorux::archive
