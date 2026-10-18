#include "tutorux/audio/wav_export.hpp"

#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <type_traits>
#include <unordered_set>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#endif

namespace tutorux::audio {
namespace {

    struct AudioChunkReference final {
        archive::Uuid id{};
        std::uint64_t sequence{};
        std::uint64_t firstSample{};
        std::uint64_t sampleCount{};
        std::uint64_t gapBeforeSamples{};
        std::uint32_t sampleRateHz{};
        std::uint16_t channelCount{};
    };

    class TemporaryFile final {
      public:
        explicit TemporaryFile(std::filesystem::path path)
            : path_(std::move(path)) {}

        TemporaryFile(const TemporaryFile&) = delete;
        TemporaryFile& operator=(const TemporaryFile&) = delete;

        ~TemporaryFile() {
            if (active_) {
                std::error_code ignored;
                std::filesystem::remove(path_, ignored);
            }
        }

        const std::filesystem::path& path() const noexcept {
            return path_;
        }

        void release() noexcept {
            active_ = false;
        }

      private:
        std::filesystem::path path_;
        bool active_{true};
    };

    std::string_view field(const archive::Record& record, std::string_view name) {
        const auto found = record.fields.find(name);
        return found == record.fields.end() ? std::string_view{} : found->second;
    }

    core::Result<std::uint64_t> readInteger(const archive::Record& record, std::string_view name) {
        const auto value = field(record, name);
        if (value.empty()) {
            return std::unexpected(
                core::error("audio_export_record_invalid",
                            "Audio chunk is missing the '" + std::string(name) + "' field."));
        }
        std::uint64_t parsed = 0;
        const auto [end, errorCode] =
            std::from_chars(value.data(), value.data() + value.size(), parsed);
        if (errorCode != std::errc{} || end != value.data() + value.size()) {
            return std::unexpected(
                core::error("audio_export_record_invalid",
                            "Audio chunk has an invalid '" + std::string(name) + "' field."));
        }
        return parsed;
    }

    template <typename Integer> bool writeLittleEndian(std::ostream& output, Integer value) {
        using Unsigned = std::make_unsigned_t<Integer>;
        Unsigned bits = static_cast<Unsigned>(value);
        std::array<char, sizeof(Integer)> bytes{};
        for (std::size_t index = 0; index < bytes.size(); ++index) {
            bytes[index] = static_cast<char>(bits & static_cast<Unsigned>(0xffU));
            bits >>= 8U;
        }
        output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
        return output.good();
    }

    bool writeTag(std::ostream& output, std::string_view tag) {
        output.write(tag.data(), static_cast<std::streamsize>(tag.size()));
        return output.good();
    }

    bool writeWaveHeader(std::ostream& output, std::uint32_t sampleRateHz,
                         std::uint16_t channelCount, std::uint64_t dataBytes,
                         std::uint64_t sampleCount, bool rf64) {
        const std::uint16_t bitsPerSample = 16;
        const std::uint16_t blockAlign = static_cast<std::uint16_t>(channelCount * 2U);
        const std::uint32_t byteRate = sampleRateHz * static_cast<std::uint32_t>(blockAlign);
        if (rf64) {
            const std::uint64_t riffSize = dataBytes + 72U;
            return writeTag(output, "RF64") &&
                   writeLittleEndian(output, std::uint32_t{0xffffffffU}) &&
                   writeTag(output, "WAVE") && writeTag(output, "ds64") &&
                   writeLittleEndian(output, std::uint32_t{28}) &&
                   writeLittleEndian(output, riffSize) && writeLittleEndian(output, dataBytes) &&
                   writeLittleEndian(output, sampleCount) &&
                   writeLittleEndian(output, std::uint32_t{0}) && writeTag(output, "fmt ") &&
                   writeLittleEndian(output, std::uint32_t{16}) &&
                   writeLittleEndian(output, std::uint16_t{1}) &&
                   writeLittleEndian(output, channelCount) &&
                   writeLittleEndian(output, sampleRateHz) && writeLittleEndian(output, byteRate) &&
                   writeLittleEndian(output, blockAlign) &&
                   writeLittleEndian(output, bitsPerSample) && writeTag(output, "data") &&
                   writeLittleEndian(output, std::uint32_t{0xffffffffU});
        }

        return writeTag(output, "RIFF") &&
               writeLittleEndian(output, static_cast<std::uint32_t>(dataBytes + 36U)) &&
               writeTag(output, "WAVE") && writeTag(output, "fmt ") &&
               writeLittleEndian(output, std::uint32_t{16}) &&
               writeLittleEndian(output, std::uint16_t{1}) &&
               writeLittleEndian(output, channelCount) && writeLittleEndian(output, sampleRateHz) &&
               writeLittleEndian(output, byteRate) && writeLittleEndian(output, blockAlign) &&
               writeLittleEndian(output, bitsPerSample) && writeTag(output, "data") &&
               writeLittleEndian(output, static_cast<std::uint32_t>(dataBytes));
    }

    core::Status writeSilence(std::ostream& output, std::uint64_t byteCount) {
        static constexpr std::array<char, 64U * 1024U> silence{};
        while (byteCount != 0) {
            const std::size_t blockSize =
                static_cast<std::size_t>(std::min<std::uint64_t>(byteCount, silence.size()));
            output.write(silence.data(), static_cast<std::streamsize>(blockSize));
            if (!output.good()) {
                return std::unexpected(
                    core::error("audio_export_write_failed", "Writing WAV audio data failed."));
            }
            byteCount -= blockSize;
        }
        return {};
    }

    core::Result<std::vector<AudioChunkReference>>
    collectTrackChunks(archive::Archive& archive, const archive::Uuid& sessionId,
                       const archive::Uuid& trackId) {
        std::vector<AudioChunkReference> chunks;
        std::optional<core::Error> callbackError;
        auto status = archive.forEachAudioChunk(sessionId, trackId, [&](archive::Record&& record) {
            auto sequence = readInteger(record, "sequence_number");
            auto firstSample = readInteger(record, "first_sample_index");
            auto sampleCount = readInteger(record, "sample_count");
            auto sampleRate = readInteger(record, "sample_rate_hz");
            auto channels = readInteger(record, "channel_count");
            const auto gapValue = field(record, "gap_before_samples");
            auto gapBefore = gapValue.empty() ? core::Result<std::uint64_t>(std::uint64_t{0})
                                              : readInteger(record, "gap_before_samples");
            if (!sequence || !firstSample || !sampleCount || !sampleRate || !channels ||
                !gapBefore) {
                callbackError = !sequence      ? sequence.error()
                                : !firstSample ? firstSample.error()
                                : !sampleCount ? sampleCount.error()
                                : !sampleRate  ? sampleRate.error()
                                : !channels    ? channels.error()
                                               : gapBefore.error();
                return false;
            }
            if (*sampleRate > std::numeric_limits<std::uint32_t>::max() ||
                *channels > std::numeric_limits<std::uint16_t>::max()) {
                callbackError =
                    core::error("audio_export_record_invalid",
                                "Audio chunk has an out-of-range sample rate or channel count.");
                return false;
            }
            chunks.push_back({record.id, *sequence, *firstSample, *sampleCount, *gapBefore,
                              static_cast<std::uint32_t>(*sampleRate),
                              static_cast<std::uint16_t>(*channels)});
            return true;
        });
        if (!status)
            return std::unexpected(status.error());
        if (callbackError)
            return std::unexpected(std::move(*callbackError));
        if (chunks.empty()) {
            return std::unexpected(
                core::error("audio_track_not_found",
                            "The selected recording track has no committed audio chunks."));
        }
        std::ranges::sort(chunks, {}, &AudioChunkReference::sequence);
        return chunks;
    }

    core::Result<std::unordered_set<std::string>> collectTrackIds(archive::Archive& archive,
                                                                  const archive::Uuid& sessionId) {
        std::unordered_set<std::string> trackIds;
        std::optional<core::Error> callbackError;
        auto status = archive.forEachAudioChunk(sessionId, {}, [&](archive::Record&& record) {
            const auto trackId = field(record, "track_id");
            if (trackId.empty()) {
                callbackError = core::error("audio_export_record_invalid",
                                            "An audio chunk is missing its track ID.");
                return false;
            }
            trackIds.emplace(trackId);
            return true;
        });
        if (!status)
            return std::unexpected(status.error());
        if (callbackError)
            return std::unexpected(std::move(*callbackError));
        return trackIds;
    }

    core::Result<std::filesystem::path> temporaryPathFor(const std::filesystem::path& destination) {
        const auto parent = destination.has_parent_path() ? destination.parent_path()
                                                          : std::filesystem::current_path();
        std::error_code errorCode;
        if (!std::filesystem::is_directory(parent, errorCode) || errorCode) {
            return std::unexpected(
                core::error("audio_export_directory_invalid",
                            "The WAV export directory does not exist or cannot be accessed."));
        }
        auto temporary = parent / destination.filename();
        temporary += ".tutorux-" + archive::uuidToString(archive::randomUuid()) + ".tmp";
        return temporary;
    }

    core::Status publishFile(const std::filesystem::path& source,
                             const std::filesystem::path& destination, bool overwrite) {
#ifdef _WIN32
        const DWORD flags = MOVEFILE_WRITE_THROUGH | (overwrite ? MOVEFILE_REPLACE_EXISTING : 0U);
        if (!MoveFileExW(source.c_str(), destination.c_str(), flags)) {
            const DWORD errorCode = GetLastError();
            return std::unexpected(
                core::error("audio_export_publish_failed",
                            "Publishing the WAV export failed with Windows error " +
                                std::to_string(errorCode) + "."));
        }
#elif defined(__EMSCRIPTEN__)
        std::error_code errorCode;
        if (!overwrite && std::filesystem::exists(destination, errorCode)) {
            return std::unexpected(core::error(
                "audio_export_destination_exists",
                "The WAV export destination already exists. Pass --overwrite to replace it."));
        }
        if (errorCode) {
            return std::unexpected(core::error("audio_export_publish_failed",
                                               "Inspecting the WAV destination failed."));
        }
        std::filesystem::rename(source, destination, errorCode);
        if (errorCode) {
            return std::unexpected(
                core::error("audio_export_publish_failed",
                            "Publishing the WAV export failed: " + errorCode.message()));
        }
#else
        std::error_code errorCode;
        if (overwrite) {
            std::filesystem::rename(source, destination, errorCode);
        } else {
            std::filesystem::create_hard_link(source, destination, errorCode);
            if (!errorCode) {
                std::filesystem::remove(source, errorCode);
                if (errorCode) {
                    std::error_code rollbackError;
                    std::filesystem::remove(destination, rollbackError);
                }
            }
        }
        if (errorCode) {
            return std::unexpected(
                core::error("audio_export_publish_failed",
                            "Publishing the WAV export failed: " + errorCode.message()));
        }
#endif
        return {};
    }

} // namespace

core::Result<ExportSummary> exportWave(archive::Archive& archive, const archive::Uuid& sessionId,
                                       const std::filesystem::path& destination,
                                       std::optional<archive::Uuid> trackId,
                                       bool fillGapsWithSilence, bool overwrite) {
    auto session = archive.get(archive::RecordType::Session, sessionId);
    if (!session)
        return std::unexpected(session.error());
    if (!*session || domain::isDeleted(**session)) {
        return std::unexpected(
            core::error("session_not_found", "Session was not found in the archive."));
    }
    if (destination.empty() || destination.filename().empty()) {
        return std::unexpected(core::error("audio_export_destination_invalid",
                                           "Choose a destination file for the WAV export."));
    }

    if (!trackId) {
        auto trackIds = collectTrackIds(archive, sessionId);
        if (!trackIds)
            return std::unexpected(trackIds.error());
        if (trackIds->empty()) {
            return std::unexpected(core::error("audio_track_not_found",
                                               "The selected session contains no audio tracks."));
        }
        if (trackIds->size() != 1) {
            return std::unexpected(
                core::error("audio_track_selection_required",
                            "This session has multiple audio tracks. Select one with --track."));
        }
        auto parsedTrackId = archive::uuidFromString(*trackIds->begin());
        if (!parsedTrackId)
            return std::unexpected(parsedTrackId.error());
        trackId = *parsedTrackId;
    }

    auto chunks = collectTrackChunks(archive, sessionId, *trackId);
    if (!chunks)
        return std::unexpected(chunks.error());
    const std::uint32_t sampleRateHz = chunks->front().sampleRateHz;
    const std::uint16_t channelCount = chunks->front().channelCount;
    if (sampleRateHz < 8'000 || sampleRateHz > 384'000 || channelCount == 0 || channelCount > 8) {
        return std::unexpected(core::error("audio_export_format_invalid",
                                           "The recording track has an unsupported WAV format."));
    }

    std::uint64_t expectedFirstSample = 0;
    std::uint64_t storedSampleCount = 0;
    bool hasGaps = false;
    std::uint64_t expectedSequence = chunks->front().sequence;
    if (expectedSequence != 0) {
        return std::unexpected(core::error("audio_export_sequence_invalid",
                                           "Recording chunk sequence does not start at zero."));
    }
    for (const auto& chunk : *chunks) {
        if (chunk.sequence != expectedSequence || chunk.sampleCount == 0 ||
            chunk.sampleRateHz != sampleRateHz || chunk.channelCount != channelCount ||
            chunk.gapBeforeSamples >
                std::numeric_limits<std::uint64_t>::max() - expectedFirstSample ||
            chunk.firstSample != expectedFirstSample + chunk.gapBeforeSamples) {
            return std::unexpected(core::error(
                "audio_export_sequence_invalid",
                "Recording chunks have inconsistent format, sequence, or timeline metadata."));
        }
        hasGaps = hasGaps || chunk.gapBeforeSamples != 0;
        if (storedSampleCount > std::numeric_limits<std::uint64_t>::max() - chunk.sampleCount ||
            chunk.sampleCount > std::numeric_limits<std::uint64_t>::max() /
                                    (static_cast<std::uint64_t>(channelCount) * 2U)) {
            return std::unexpected(
                core::error("audio_export_size_invalid", "The WAV export exceeds supported size."));
        }
        storedSampleCount += chunk.sampleCount;
        expectedFirstSample = chunk.firstSample + chunk.sampleCount;
        if (expectedFirstSample < chunk.firstSample ||
            expectedSequence == std::numeric_limits<std::uint64_t>::max()) {
            return std::unexpected(
                core::error("audio_export_sequence_invalid", "Recording timeline overflowed."));
        }
        ++expectedSequence;
    }
    if (hasGaps && !fillGapsWithSilence) {
        return std::unexpected(core::error(
            "audio_export_gaps_require_confirmation",
            "The selected track contains missing audio intervals. Use --fill-gaps to export the "
            "timeline with explicitly inserted silence."));
    }

    const std::uint64_t exportFrames =
        fillGapsWithSilence ? expectedFirstSample : storedSampleCount;
    if (exportFrames > std::numeric_limits<std::uint64_t>::max() /
                           (static_cast<std::uint64_t>(channelCount) * 2U)) {
        return std::unexpected(
            core::error("audio_export_size_invalid", "The WAV export exceeds supported size."));
    }
    const std::uint64_t dataBytes = exportFrames * channelCount * 2U;
    if (dataBytes > static_cast<std::uint64_t>(std::numeric_limits<std::streamoff>::max()) - 128U) {
        return std::unexpected(
            core::error("audio_export_size_invalid", "The WAV export exceeds supported size."));
    }

    std::error_code errorCode;
    const bool destinationExists = std::filesystem::exists(destination, errorCode);
    if (errorCode) {
        return std::unexpected(core::error("audio_export_destination_invalid",
                                           "The WAV export destination cannot be inspected."));
    }
    if (destinationExists && !overwrite) {
        return std::unexpected(core::error(
            "audio_export_destination_exists",
            "The WAV export destination already exists. Pass --overwrite to replace it."));
    }

    auto temporaryPath = temporaryPathFor(destination);
    if (!temporaryPath)
        return std::unexpected(temporaryPath.error());
    TemporaryFile temporary(*temporaryPath);
    std::ofstream output(temporary.path(), std::ios::binary | std::ios::out | std::ios::trunc);
    if (!output) {
        return std::unexpected(
            core::error("audio_export_open_failed", "Opening the temporary WAV export failed."));
    }

    constexpr std::uint64_t maximumRiffDataBytes =
        static_cast<std::uint64_t>(std::numeric_limits<std::uint32_t>::max()) - 36U;
    const bool useRf64 = dataBytes > maximumRiffDataBytes;
    if (!writeWaveHeader(output, sampleRateHz, channelCount, dataBytes, exportFrames, useRf64)) {
        return std::unexpected(
            core::error("audio_export_write_failed", "Writing the WAV header failed."));
    }

    const std::uint64_t bytesPerFrame = static_cast<std::uint64_t>(channelCount) * 2U;
    for (const auto& reference : *chunks) {
        if (fillGapsWithSilence && reference.gapBeforeSamples != 0) {
            const std::uint64_t silenceBytes = reference.gapBeforeSamples * bytesPerFrame;
            if (auto status = writeSilence(output, silenceBytes); !status)
                return std::unexpected(status.error());
        }

        auto record = archive.get(archive::RecordType::AudioChunk, reference.id);
        if (!record)
            return std::unexpected(record.error());
        if (!*record || domain::isDeleted(**record)) {
            return std::unexpected(core::error("audio_export_chunk_missing",
                                               "An audio chunk disappeared during WAV export."));
        }
        const auto& chunk = **record;
        if (field(chunk, "sample_format") != "pcm_s16le") {
            return std::unexpected(core::error(
                "audio_export_format_unsupported",
                "The selected track contains a codec that cannot be exported as PCM WAV."));
        }
        const auto expectedPayloadBytes = reference.sampleCount * bytesPerFrame;
        if (chunk.blob.size() != expectedPayloadBytes) {
            return std::unexpected(core::error(
                "audio_export_chunk_invalid",
                "An audio chunk's payload size does not match its declared sample count."));
        }
        const auto checksum = field(chunk, "payload_checksum");
        if (!checksum.empty()) {
            auto expectedChecksum = readInteger(chunk, "payload_checksum");
            if (!expectedChecksum ||
                *expectedChecksum > std::numeric_limits<std::uint32_t>::max() ||
                archive::crc32(chunk.blob) != *expectedChecksum) {
                return std::unexpected(
                    core::error("audio_export_checksum_failed",
                                "An audio chunk failed its payload checksum during WAV export."));
            }
        }

        if constexpr (std::endian::native == std::endian::big) {
            archive::Bytes littleEndianPayload = chunk.blob;
            for (std::size_t offset = 0; offset < littleEndianPayload.size(); offset += 2)
                std::swap(littleEndianPayload[offset], littleEndianPayload[offset + 1]);
            output.write(reinterpret_cast<const char*>(littleEndianPayload.data()),
                         static_cast<std::streamsize>(littleEndianPayload.size()));
        } else {
            output.write(reinterpret_cast<const char*>(chunk.blob.data()),
                         static_cast<std::streamsize>(chunk.blob.size()));
        }
        if (!output.good()) {
            return std::unexpected(
                core::error("audio_export_write_failed", "Writing WAV audio data failed."));
        }
    }

    output.flush();
    if (!output.good()) {
        return std::unexpected(
            core::error("audio_export_write_failed", "Flushing the WAV export failed."));
    }
    output.close();
    if (output.fail()) {
        return std::unexpected(
            core::error("audio_export_write_failed", "Closing the WAV export failed."));
    }

    if (auto status = publishFile(temporary.path(), destination, overwrite); !status)
        return std::unexpected(status.error());
    temporary.release();

    return ExportSummary{*trackId,
                         destination,
                         sampleRateHz,
                         channelCount,
                         exportFrames,
                         static_cast<std::uint64_t>(chunks->size()),
                         exportFrames * 1'000'000ULL / sampleRateHz,
                         dataBytes,
                         useRf64,
                         hasGaps && fillGapsWithSilence};
}

} // namespace tutorux::audio
