#pragma once

#include "tutorux/core/result.hpp"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <string_view>

namespace tutorux::transcription {

    struct TranscriptSourceCue final {
        std::string text;
        std::optional<std::int64_t> startTimeUs;
        std::optional<std::int64_t> endTimeUs;
        std::uint64_t sourceIndex{};
        std::string sourceId;
    };

    core::Status
    visitTranscriptSource(const std::filesystem::path& path, std::string_view format,
                          const std::function<core::Status(TranscriptSourceCue&&)>& visitor);

} // namespace tutorux::transcription
