#pragma once

#include "tutorux/archive/archive.hpp"

#include <cstdint>
#include <filesystem>

namespace tutorux::audio {

    struct ImportSummary final {
        archive::Uuid trackId{};
        std::uint32_t sampleRateHz{};
        std::uint16_t channelCount{};
        std::uint64_t sampleCount{};
        std::uint64_t chunkCount{};
        std::uint64_t durationUs{};
        std::uint64_t byteCount{};
        bool completed{};
    };

    core::Result<ImportSummary> importWave(archive::Archive& archive,
                                           const archive::Uuid& sessionId,
                                           const std::filesystem::path& source);

    core::Result<ImportSummary> recoverWaveImport(archive::Archive& archive,
                                                  const archive::Uuid& sessionId);

} // namespace tutorux::audio
