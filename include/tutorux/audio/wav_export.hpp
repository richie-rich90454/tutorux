#pragma once

#include "tutorux/archive/archive.hpp"

#include <cstdint>
#include <filesystem>
#include <optional>

namespace tutorux::audio {

struct ExportSummary final {
    archive::Uuid trackId{};
    std::filesystem::path destination;
    std::uint32_t sampleRateHz{};
    std::uint16_t channelCount{};
    std::uint64_t sampleCount{};
    std::uint64_t chunkCount{};
    std::uint64_t durationUs{};
    std::uint64_t dataBytes{};
    bool usedRf64{};
    bool insertedSilenceForGaps{};
};

core::Result<ExportSummary> exportWave(archive::Archive& archive, const archive::Uuid& sessionId,
                                       const std::filesystem::path& destination,
                                       std::optional<archive::Uuid> trackId = {},
                                       bool fillGapsWithSilence = false, bool overwrite = false);

} // namespace tutorux::audio
