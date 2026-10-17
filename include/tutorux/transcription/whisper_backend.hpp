#pragma once

#include "tutorux/archive/archive.hpp"

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>

namespace tutorux::transcription {

    struct WhisperOptions final {
        std::filesystem::path modelPath;
        std::string language{"auto"};
        std::optional<archive::Uuid> trackId;
        std::optional<std::int64_t> startTimeUs;
        std::optional<std::int64_t> endTimeUs;
        std::uint32_t threadCount{};
        bool replaceProvisional{};
    };

    struct WhisperSummary final {
        archive::Uuid trackId{};
        std::uint64_t segmentsCreated{};
        std::uint64_t segmentsSuperseded{};
        std::uint64_t audioDurationUs{};
        std::string modelName;
        std::string backendVersion;
    };

    core::Result<WhisperSummary> transcribeSession(archive::Archive& archive,
                                                   const archive::Uuid& sessionId,
                                                   WhisperOptions options);

} // namespace tutorux::transcription
