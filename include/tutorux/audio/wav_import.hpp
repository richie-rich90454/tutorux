#pragma once

#include "tutorux/archive/archive.hpp"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>

namespace tutorux::audio {

struct ImportSummary final {
    archive::Uuid trackId{};
    archive::Uuid takeId{};
    std::uint32_t sampleRateHz{};
    std::uint16_t channelCount{};
    std::uint64_t sampleCount{};
    std::uint64_t chunkCount{};
    std::uint64_t durationUs{};
    std::uint64_t byteCount{};
    bool completed{};
};

struct PcmImportSource final {
    std::uint32_t sampleRateHz{};
    std::uint16_t channelCount{};
    std::uint32_t channelMask{};
    std::uint64_t sampleCount{};
    std::string sampleFormat;
    std::string sourceCodec;
};

using PcmChunkReader = std::function<core::Result<archive::Bytes>(std::size_t exactByteCount)>;

core::Result<ImportSummary> importWave(archive::Archive& archive, const archive::Uuid& sessionId, const std::filesystem::path& source,
                                       bool allowAdditionalTrack = false);

core::Result<ImportSummary> importPcmStream(archive::Archive& archive, const archive::Uuid& sessionId, const std::filesystem::path& source,
                                            PcmImportSource format, PcmChunkReader readChunk, bool allowAdditionalTrack = false);

core::Result<ImportSummary> importAudio(archive::Archive& archive, const archive::Uuid& sessionId, const std::filesystem::path& source,
                                        bool allowAdditionalTrack = false);

// WAV is always available. Compressed formats require the bundled FFmpeg decoder.
bool hasCompressedAudioImport() noexcept;

core::Result<ImportSummary> recoverWaveImport(archive::Archive& archive, const archive::Uuid& sessionId);

} // namespace tutorux::audio
