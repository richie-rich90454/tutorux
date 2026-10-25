#include "tutorux/audio/wav_import.hpp"
#include "tutorux/audio/recording_take.hpp"

#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <fstream>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::audio {
namespace {

    using archive::Archive;
    using archive::Bytes;
    using archive::Record;
    using archive::RecordType;
    using archive::Uuid;

    struct DataRange final {
        std::uint64_t offset{};
        std::uint64_t length{};
    };

    struct WaveFormat final {
        std::uint16_t formatTag{};
        std::uint16_t channelCount{};
        std::uint32_t sampleRateHz{};
        std::uint32_t byteRate{};
        std::uint16_t blockAlign{};
        std::uint16_t bitsPerSample{};
        std::uint32_t channelMask{};
        std::string sampleFormat;
        std::vector<DataRange> data;
        std::uint64_t dataBytes{};
    };

    std::uint16_t readU16(const std::array<unsigned char, 40>& bytes, std::size_t offset) {
        return static_cast<std::uint16_t>(bytes[offset]) | static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[offset + 1]) << 8U);
    }

    std::uint32_t readU32(std::span<const unsigned char> bytes, std::size_t offset) {
        return static_cast<std::uint32_t>(bytes[offset]) | (static_cast<std::uint32_t>(bytes[offset + 1]) << 8U) |
               (static_cast<std::uint32_t>(bytes[offset + 2]) << 16U) | (static_cast<std::uint32_t>(bytes[offset + 3]) << 24U);
    }

    bool matches(std::span<const unsigned char> bytes, std::string_view magic) {
        if (bytes.size() < magic.size())
            return false;
        for (std::size_t index = 0; index < magic.size(); ++index) {
            if (bytes[index] != static_cast<unsigned char>(magic[index]))
                return false;
        }
        return true;
    }

    core::Result<std::vector<unsigned char>> readAt(std::ifstream& input, std::uint64_t offset, std::size_t count) {
        if (offset > static_cast<std::uint64_t>(std::numeric_limits<std::streamoff>::max()) ||
            count > static_cast<std::size_t>(std::numeric_limits<std::streamsize>::max())) {
            return std::unexpected(core::error("wave_offset_invalid", "WAV file offset exceeds the supported range."));
        }
        std::vector<unsigned char> bytes(count);
        input.clear();
        input.seekg(static_cast<std::streamoff>(offset));
        if (!input)
            return std::unexpected(core::error("wave_read_failed", "Unable to seek in the WAV source."));
        if (count > 0 && !input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(count))) {
            return std::unexpected(core::error("wave_read_failed", "WAV source ended before the requested data."));
        }
        return bytes;
    }

    core::Result<WaveFormat> inspectWave(std::ifstream& input, std::uint64_t fileSize) {
        auto header = readAt(input, 0, 12);
        if (!header)
            return std::unexpected(header.error());
        if (!matches(*header, "RIFF") || !matches(std::span<const unsigned char>(*header).subspan(8), "WAVE")) {
            return std::unexpected(core::error("wave_format_invalid", "Input must be a little-endian RIFF/WAVE file."));
        }
        const std::uint64_t riffEnd = 8ULL + readU32(*header, 4);
        if (riffEnd < 12 || riffEnd > fileSize) {
            return std::unexpected(core::error("wave_size_invalid", "RIFF length exceeds the source file."));
        }

        WaveFormat format;
        bool foundFormat = false;
        std::uint64_t cursor = 12;
        while (riffEnd - cursor >= 8) {
            auto chunkHeader = readAt(input, cursor, 8);
            if (!chunkHeader)
                return std::unexpected(chunkHeader.error());
            const std::uint64_t payloadOffset = cursor + 8;
            const std::uint32_t chunkSize = readU32(*chunkHeader, 4);
            if (chunkSize > riffEnd - payloadOffset) {
                return std::unexpected(core::error("wave_chunk_invalid", "A RIFF chunk extends beyond the declared file."));
            }
            if (matches(*chunkHeader, "fmt ")) {
                if (foundFormat || chunkSize < 16 || chunkSize > 1024U * 1024U) {
                    return std::unexpected(core::error("wave_format_invalid", "WAV format chunk is duplicated or invalid."));
                }
                const auto formatReadSize = static_cast<std::size_t>(std::min<std::uint32_t>(chunkSize, 40));
                auto formatBytes = readAt(input, payloadOffset, formatReadSize);
                if (!formatBytes)
                    return std::unexpected(formatBytes.error());
                std::array<unsigned char, 40> fields{};
                std::copy(formatBytes->begin(), formatBytes->end(), fields.begin());
                format.formatTag = readU16(fields, 0);
                format.channelCount = readU16(fields, 2);
                format.sampleRateHz = readU32(*formatBytes, 4);
                format.byteRate = readU32(*formatBytes, 8);
                format.blockAlign = readU16(fields, 12);
                format.bitsPerSample = readU16(fields, 14);
                if (format.formatTag == 0xfffeU) {
                    static constexpr std::array<unsigned char, 12> guidTail{0x00, 0x00, 0x10, 0x00, 0x80, 0x00,
                                                                            0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
                    if (chunkSize < 40 || readU16(fields, 16) < 22 || readU16(fields, 18) != format.bitsPerSample ||
                        !std::equal(guidTail.begin(), guidTail.end(), fields.begin() + 28)) {
                        return std::unexpected(
                            core::error("wave_format_unsupported", "Only PCM or IEEE-float WAVE extensible formats are supported."));
                    }
                    format.channelMask = readU32(*formatBytes, 20);
                    const std::uint32_t subFormat = readU32(*formatBytes, 24);
                    if (subFormat != 1 && subFormat != 3) {
                        return std::unexpected(
                            core::error("wave_format_unsupported", "Compressed and non-PCM WAV formats are not supported."));
                    }
                    format.formatTag = static_cast<std::uint16_t>(subFormat);
                }
                foundFormat = true;
            } else if (matches(*chunkHeader, "data")) {
                if (format.dataBytes > std::numeric_limits<std::uint64_t>::max() - chunkSize) {
                    return std::unexpected(core::error("wave_size_invalid", "WAV data length overflowed."));
                }
                format.data.push_back({payloadOffset, chunkSize});
                format.dataBytes += chunkSize;
            }
            const std::uint64_t paddedSize = static_cast<std::uint64_t>(chunkSize) + (static_cast<std::uint64_t>(chunkSize) & 1U);
            if (paddedSize > riffEnd - payloadOffset) {
                return std::unexpected(core::error("wave_chunk_invalid", "RIFF chunk padding exceeds the declared file."));
            }
            cursor = payloadOffset + paddedSize;
        }
        if (cursor != riffEnd) {
            return std::unexpected(core::error("wave_chunk_invalid", "RIFF file ends with an incomplete chunk header."));
        }

        if (!foundFormat || format.data.empty() || format.dataBytes == 0) {
            return std::unexpected(core::error("wave_content_missing", "WAV must contain one format and nonempty audio data."));
        }
        if (format.channelCount == 0 || format.channelCount > 8 || format.sampleRateHz < 8'000 || format.sampleRateHz > 384'000) {
            return std::unexpected(core::error("wave_format_invalid", "WAV channel count or sample rate is unsupported."));
        }
        if (format.formatTag != 1 && format.formatTag != 3) {
            return std::unexpected(core::error("wave_format_unsupported", "Only PCM and IEEE-float WAV audio is supported."));
        }
        if ((format.formatTag == 1 && format.bitsPerSample != 8 && format.bitsPerSample != 16 && format.bitsPerSample != 24 &&
             format.bitsPerSample != 32) ||
            (format.formatTag == 3 && format.bitsPerSample != 32)) {
            return std::unexpected(
                core::error("wave_format_unsupported", "Supported WAV samples are PCM 8/16/24/32-bit or IEEE float 32-bit."));
        }
        const std::uint32_t bytesPerSample = format.bitsPerSample / 8U;
        const std::uint32_t expectedAlign = format.channelCount * bytesPerSample;
        const std::uint64_t expectedByteRate = static_cast<std::uint64_t>(format.sampleRateHz) * expectedAlign;
        if (format.blockAlign != expectedAlign || expectedByteRate != format.byteRate || format.dataBytes % format.blockAlign != 0 ||
            std::any_of(format.data.begin(), format.data.end(), [&](const DataRange& range) {
                return range.length % format.blockAlign != 0;
            })) {
            return std::unexpected(core::error("wave_format_invalid", "WAV block alignment or byte rate is inconsistent."));
        }
        if (format.formatTag == 3)
            format.sampleFormat = "pcm_f32le";
        else if (format.bitsPerSample == 8)
            format.sampleFormat = "pcm_u8";
        else
            format.sampleFormat = "pcm_s" + std::to_string(format.bitsPerSample) + "le";
        return format;
    }

    std::uint64_t samplesToMicroseconds(std::uint64_t sampleIndex, std::uint32_t sampleRateHz) {
        const std::uint64_t wholeSeconds = sampleIndex / sampleRateHz;
        const std::uint64_t remainingSamples = sampleIndex % sampleRateHz;
        return wholeSeconds * 1'000'000ULL + (remainingSamples * 1'000'000ULL) / sampleRateHz;
    }

    core::Result<std::uint64_t> parseUnsigned(std::string_view value, std::string_view label) {
        std::uint64_t parsed = 0;
        const auto [end, errorCode] = std::from_chars(value.data(), value.data() + value.size(), parsed);
        if (errorCode != std::errc{} || end != value.data() + value.size()) {
            return std::unexpected(
                core::error("audio_recovery_record_invalid", "Audio recovery found an invalid " + std::string(label) + " value."));
        }
        return parsed;
    }

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    }

    core::Status updateSession(Archive& archive, Record& session, std::string state, std::string importState, std::uint64_t chunks,
                               std::uint64_t samples, std::string errorMessage = {}) {
        session.fields["recording_state"] = std::move(state);
        session.fields["audio_import_state"] = std::move(importState);
        session.fields["audio_chunks_imported"] = std::to_string(chunks);
        session.fields["audio_samples_imported"] = std::to_string(samples);
        session.fields["audio_import_error"] = std::move(errorMessage);
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        return archive.put(session);
    }

} // namespace

core::Result<ImportSummary> importPcmStream(Archive& archive, const Uuid& sessionId, const std::filesystem::path& source,
                                            PcmImportSource format, PcmChunkReader readChunk, bool allowAdditionalTrack) {
    if (!readChunk || format.sampleRateHz < 8'000 || format.sampleRateHz > 384'000 || format.channelCount == 0 || format.channelCount > 8 ||
        format.sampleCount == 0) {
        return std::unexpected(core::error("audio_import_format_invalid", "Decoded audio format or stream length is invalid."));
    }
    std::uint64_t bytesPerSample = 0;
    if (format.sampleFormat == "pcm_u8")
        bytesPerSample = 1;
    else if (format.sampleFormat == "pcm_s16le")
        bytesPerSample = 2;
    else if (format.sampleFormat == "pcm_s24le")
        bytesPerSample = 3;
    else if (format.sampleFormat == "pcm_s32le" || format.sampleFormat == "pcm_f32le")
        bytesPerSample = 4;
    const std::uint64_t blockAlign = bytesPerSample * format.channelCount;
    if (blockAlign == 0 || format.sampleCount > std::numeric_limits<std::uint64_t>::max() / blockAlign) {
        return std::unexpected(core::error("audio_import_format_invalid", "Decoded audio byte count exceeds the supported range."));
    }
    const std::uint64_t expectedBytes = format.sampleCount * blockAlign;
    constexpr std::uint64_t maximumChunkBytes = 1024ULL * 1024ULL;
    constexpr std::size_t chunksPerTransaction = 8;
    const std::uint64_t alignedChunkBytes = (maximumChunkBytes / blockAlign) * blockAlign;
    const std::uint64_t expectedChunkCount = expectedBytes / alignedChunkBytes + (expectedBytes % alignedChunkBytes != 0 ? 1 : 0);

    auto sessionResult = archive.get(RecordType::Session, sessionId);
    if (!sessionResult)
        return std::unexpected(sessionResult.error());
    if (!*sessionResult || domain::isDeleted(**sessionResult)) {
        return std::unexpected(core::error("session_not_found", "Session was not found in the selected archive."));
    }
    Record session = std::move(**sessionResult);
    const std::string recordingState = domain::getField(session, "recording_state");
    if (recordingState == "initializing" || recordingState == "recording" || recordingState == "paused" || recordingState == "finalizing") {
        return std::unexpected(core::error("audio_import_session_busy", "Session already has an active recording state."));
    }
    bool sessionAlreadyHasAudio = false;
    if (auto status = archive.forEachAudioChunk(sessionId, std::nullopt,
                                                [&](Record&& chunk) {
                                                    if (domain::getField(chunk, "session_id") == archive::uuidToString(sessionId)) {
                                                        sessionAlreadyHasAudio = true;
                                                        return false;
                                                    }
                                                    return true;
                                                });
        !status) {
        return std::unexpected(status.error());
    }
    if (sessionAlreadyHasAudio && !allowAdditionalTrack) {
        return std::unexpected(
            core::error("audio_import_already_present", "Session already contains audio chunks; merge or replace audio explicitly first."));
    }

    ImportSummary summary;
    summary.trackId = archive::randomUuid();
    summary.takeId = archive::randomUuid();
    summary.sampleRateHz = format.sampleRateHz;
    summary.channelCount = format.channelCount;
    summary.sampleCount = format.sampleCount;
    summary.durationUs = samplesToMicroseconds(summary.sampleCount, summary.sampleRateHz);
    summary.byteCount = expectedBytes;
    const std::uint64_t takeStartedAtUs = nowUnixMicroseconds();
    auto takeRecord = makeRecordingTakeRecord(summary.takeId, sessionId, "imported-file",
                                               "importing", {summary.trackId}, takeStartedAtUs);
    session.fields["audio_import_take_id"] = archive::uuidToString(summary.takeId);
    session.fields["audio_import_track_id"] = archive::uuidToString(summary.trackId);
    session.fields["audio_import_expected_chunks"] = std::to_string(expectedChunkCount);
    session.fields["audio_import_expected_samples"] = std::to_string(summary.sampleCount);
    session.fields["audio_import_expected_bytes"] = std::to_string(summary.byteCount);
    session.fields["audio_import_sample_rate_hz"] = std::to_string(summary.sampleRateHz);
    session.fields["audio_import_channel_count"] = std::to_string(summary.channelCount);
    session.fields["audio_import_channel_mask"] = std::to_string(format.channelMask);
    session.fields["audio_import_sample_format"] = format.sampleFormat;
    session.fields["audio_import_source_codec"] = format.sourceCodec;
    session.fields["audio_import_bytes"] = "0";
    if (auto status = archive.putMany({std::move(takeRecord), session}); !status)
        return std::unexpected(status.error());

    std::uint64_t sequenceNumber = 0;
    std::uint64_t firstSampleIndex = 0;
    std::uint64_t committedChunkCount = 0;
    std::uint64_t committedSamples = 0;
    std::vector<Record> transaction;
    transaction.reserve(chunksPerTransaction + 1);
    auto commitChunkBatch = [&]() -> core::Status {
        if (transaction.empty())
            return {};
        const std::uint64_t batchChunkCount = transaction.size();
        session.fields["recording_state"] = "recording";
        session.fields["audio_import_state"] = "importing";
        session.fields["audio_chunks_imported"] = std::to_string(committedChunkCount + batchChunkCount);
        session.fields["audio_samples_imported"] = std::to_string(firstSampleIndex);
        session.fields["audio_import_bytes"] = std::to_string(firstSampleIndex * blockAlign);
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        transaction.push_back(session);
        auto status = archive.putMany(std::move(transaction));
        transaction.clear();
        transaction.reserve(chunksPerTransaction + 1);
        if (!status)
            return status;
        committedChunkCount += batchChunkCount;
        committedSamples = firstSampleIndex;
        return {};
    };
    auto failImport = [&](const core::Error& failure) -> core::Result<ImportSummary> {
        session.fields.erase("audio_imported_at_us");
        session.fields["audio_import_bytes"] = std::to_string(committedSamples * blockAlign);
        auto status = updateSession(archive, session, "interrupted", "interrupted", committedChunkCount, committedSamples, failure.message);
        const auto takeStatus = updateRecordingTake(archive, summary.takeId,
                                                    committedChunkCount == 0 ? "failed" : "partial",
                                                    samplesToMicroseconds(committedSamples, summary.sampleRateHz));
        if (!status) {
            return std::unexpected(
                core::error(failure.code, failure.message + " Unable to persist interrupted state: " + status.error().message));
        }
        if (!takeStatus)
            return std::unexpected(core::error(failure.code, failure.message +
                                                              " Unable to persist take state: " + takeStatus.error().message));
        return std::unexpected(failure);
    };

    std::uint64_t remainingBytes = expectedBytes;
    while (remainingBytes > 0) {
        const std::uint64_t chunkBytes = std::min(remainingBytes, alignedChunkBytes);
        if (chunkBytes > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
            return failImport(core::error("audio_import_chunk_invalid", "Audio chunk exceeds this platform's range."));
        }
        auto raw = readChunk(static_cast<std::size_t>(chunkBytes));
        if (!raw)
            return failImport(raw.error());
        if (raw->size() != chunkBytes) {
            return failImport(
                core::error("audio_source_length_changed", "Decoded audio ended before its declared sample count was reached."));
        }
        if (raw->size() % blockAlign != 0) {
            return failImport(core::error("audio_import_chunk_invalid", "Decoded audio chunk is not frame-aligned."));
        }

        const std::uint64_t sampleCount = raw->size() / blockAlign;
        const std::uint64_t nextSampleIndex = firstSampleIndex + sampleCount;
        Bytes payload = std::move(*raw);
        Record chunk;
        chunk.type = RecordType::AudioChunk;
        chunk.id = archive::randomUuid();
        chunk.fields = {
            {"session_id", archive::uuidToString(sessionId)},
            {"track_id", archive::uuidToString(summary.trackId)},
            {"sequence_number", std::to_string(sequenceNumber)},
            {"first_sample_index", std::to_string(firstSampleIndex)},
            {"sample_count", std::to_string(sampleCount)},
            {"timeline_start_us", std::to_string(samplesToMicroseconds(firstSampleIndex, summary.sampleRateHz))},
            {"timeline_end_us", std::to_string(samplesToMicroseconds(nextSampleIndex, summary.sampleRateHz))},
            {"sample_format", format.sampleFormat},
            {"sample_rate_hz", std::to_string(summary.sampleRateHz)},
            {"channel_count", std::to_string(summary.channelCount)},
            {"channel_mask", std::to_string(format.channelMask)},
            {"codec", "none"},
            {"source_codec", format.sourceCodec},
            {"payload_checksum", std::to_string(archive::crc32(payload))},
            {"source_filename", source.filename().string()}
        };
        chunk.blob = std::move(payload);
        transaction.push_back(std::move(chunk));
        ++sequenceNumber;
        firstSampleIndex = nextSampleIndex;
        remainingBytes -= chunkBytes;

        if (transaction.size() >= chunksPerTransaction) {
            if (auto status = commitChunkBatch(); !status)
                return failImport(status.error());
        }
    }
    auto trailing = readChunk(static_cast<std::size_t>(blockAlign));
    if (!trailing)
        return failImport(trailing.error());
    if (!trailing->empty()) {
        return failImport(core::error("audio_source_length_changed", "Decoded audio exceeds its declared sample count."));
    }

    if (!transaction.empty()) {
        const std::uint64_t batchChunkCount = transaction.size();
        session.fields["recording_state"] = "finalizing";
        session.fields["audio_import_state"] = "finalizing";
        session.fields["audio_chunks_imported"] = std::to_string(committedChunkCount + batchChunkCount);
        session.fields["audio_samples_imported"] = std::to_string(firstSampleIndex);
        session.fields["audio_import_bytes"] = std::to_string(summary.byteCount);
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        transaction.push_back(session);
        if (auto status = archive.putMany(std::move(transaction)); !status)
            return failImport(status.error());
        committedChunkCount += batchChunkCount;
        committedSamples = firstSampleIndex;
    }
    session.fields["audio_imported_at_us"] = std::to_string(nowUnixMicroseconds());
    if (auto status = updateSession(archive, session, "completed", "completed", sequenceNumber, summary.sampleCount); !status) {
        return failImport(status.error());
    }
    if (auto status = updateRecordingTake(archive, summary.takeId, "completed", summary.durationUs); !status)
        return std::unexpected(status.error());
    summary.chunkCount = sequenceNumber;
    summary.completed = true;
    return summary;
}

core::Result<ImportSummary> importWave(Archive& archive, const Uuid& sessionId, const std::filesystem::path& source,
                                       bool allowAdditionalTrack) {
    std::error_code errorCode;
    const auto status = std::filesystem::symlink_status(source, errorCode);
    if (errorCode || std::filesystem::is_symlink(status) || !std::filesystem::is_regular_file(status)) {
        return std::unexpected(core::error("wave_source_invalid", "Audio source must be a regular, non-symlink file."));
    }
    std::string extension = source.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char c) {
        return static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
    });
    if (extension != ".wav" && extension != ".wave") {
        return std::unexpected(core::error("wave_extension_invalid", "Audio import currently accepts WAV files."));
    }
    const std::uint64_t fileSize = std::filesystem::file_size(source, errorCode);
    if (errorCode)
        return std::unexpected(core::error("wave_source_read_failed", errorCode.message()));
    std::ifstream input(source, std::ios::binary);
    if (!input)
        return std::unexpected(core::error("wave_source_read_failed", "Unable to open the audio source."));
    auto format = inspectWave(input, fileSize);
    if (!format)
        return std::unexpected(format.error());

    auto sessionResult = archive.get(RecordType::Session, sessionId);
    if (!sessionResult)
        return std::unexpected(sessionResult.error());
    if (!*sessionResult || domain::isDeleted(**sessionResult)) {
        return std::unexpected(core::error("session_not_found", "Session was not found in the selected archive."));
    }
    Record session = std::move(**sessionResult);
    const std::string recordingState = domain::getField(session, "recording_state");
    if (recordingState == "initializing" || recordingState == "recording" || recordingState == "paused" || recordingState == "finalizing") {
        return std::unexpected(core::error("audio_import_session_busy", "Session already has an active recording state."));
    }
    bool sessionAlreadyHasAudio = false;
    if (auto status = archive.forEachAudioChunk(sessionId, std::nullopt,
                                                [&](Record&& chunk) {
                                                    if (domain::getField(chunk, "session_id") == archive::uuidToString(sessionId)) {
                                                        sessionAlreadyHasAudio = true;
                                                        return false;
                                                    }
                                                    return true;
                                                });
        !status) {
        return std::unexpected(status.error());
    }
    if (sessionAlreadyHasAudio && !allowAdditionalTrack) {
        return std::unexpected(
            core::error("audio_import_already_present", "Session already contains audio chunks; merge or replace audio explicitly first."));
    }

    ImportSummary summary;
    summary.trackId = archive::randomUuid();
    summary.takeId = archive::randomUuid();
    summary.sampleRateHz = format->sampleRateHz;
    summary.channelCount = format->channelCount;
    summary.sampleCount = format->dataBytes / format->blockAlign;
    summary.durationUs = samplesToMicroseconds(summary.sampleCount, summary.sampleRateHz);
    summary.byteCount = format->dataBytes;
    const std::uint64_t takeStartedAtUs = nowUnixMicroseconds();
    auto takeRecord = makeRecordingTakeRecord(summary.takeId, sessionId, "imported-file",
                                               "importing", {summary.trackId}, takeStartedAtUs);
    constexpr std::uint64_t maximumChunkBytes = 1024ULL * 1024ULL;
    constexpr std::size_t chunksPerTransaction = 8;
    const std::uint64_t alignedChunkBytes = (maximumChunkBytes / format->blockAlign) * format->blockAlign;
    std::uint64_t expectedChunkCount = 0;
    for (const DataRange& range : format->data) {
        const std::uint64_t rangeChunkCount = range.length / alignedChunkBytes + (range.length % alignedChunkBytes != 0 ? 1 : 0);
        if (expectedChunkCount > std::numeric_limits<std::uint64_t>::max() - rangeChunkCount) {
            return std::unexpected(core::error("wave_size_invalid", "WAV chunk count overflowed."));
        }
        expectedChunkCount += rangeChunkCount;
    }
    session.fields["audio_import_track_id"] = archive::uuidToString(summary.trackId);
    session.fields["audio_import_take_id"] = archive::uuidToString(summary.takeId);
    session.fields["audio_import_expected_chunks"] = std::to_string(expectedChunkCount);
    session.fields["audio_import_expected_samples"] = std::to_string(summary.sampleCount);
    session.fields["audio_import_expected_bytes"] = std::to_string(summary.byteCount);
    session.fields["audio_import_sample_rate_hz"] = std::to_string(summary.sampleRateHz);
    session.fields["audio_import_channel_count"] = std::to_string(summary.channelCount);
    session.fields["audio_import_channel_mask"] = std::to_string(format->channelMask);
    session.fields["audio_import_sample_format"] = format->sampleFormat;
    session.fields["audio_import_bytes"] = "0";
    if (auto status = archive.putMany({std::move(takeRecord), session}); !status) {
        return std::unexpected(status.error());
    }

    std::uint64_t sequenceNumber = 0;
    std::uint64_t firstSampleIndex = 0;
    std::uint64_t committedChunkCount = 0;
    std::uint64_t committedSamples = 0;
    std::vector<Record> transaction;
    transaction.reserve(chunksPerTransaction + 1);
    auto commitChunkBatch = [&]() -> core::Status {
        if (transaction.empty())
            return {};
        const std::uint64_t batchChunkCount = transaction.size();
        session.fields["recording_state"] = "recording";
        session.fields["audio_import_state"] = "importing";
        session.fields["audio_chunks_imported"] = std::to_string(committedChunkCount + batchChunkCount);
        session.fields["audio_samples_imported"] = std::to_string(firstSampleIndex);
        session.fields["audio_import_bytes"] = std::to_string(firstSampleIndex * format->blockAlign);
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        transaction.push_back(session);
        auto status = archive.putMany(std::move(transaction));
        transaction.clear();
        transaction.reserve(chunksPerTransaction + 1);
        if (!status)
            return status;
        committedChunkCount += batchChunkCount;
        committedSamples = firstSampleIndex;
        return {};
    };

    auto failImport = [&](const core::Error& failure) -> core::Result<ImportSummary> {
        session.fields.erase("audio_imported_at_us");
        session.fields["audio_import_bytes"] = std::to_string(committedSamples * static_cast<std::uint64_t>(format->blockAlign));
        auto status = updateSession(archive, session, "interrupted", "interrupted", committedChunkCount, committedSamples, failure.message);
        const auto takeStatus = updateRecordingTake(
            archive, summary.takeId, committedChunkCount == 0 ? "failed" : "partial",
            samplesToMicroseconds(committedSamples, summary.sampleRateHz));
        if (!status) {
            return std::unexpected(
                core::error(failure.code, failure.message + " Unable to persist interrupted state: " + status.error().message));
        }
        if (!takeStatus)
            return std::unexpected(core::error(failure.code, failure.message +
                                                              " Unable to persist take state: " + takeStatus.error().message));
        return std::unexpected(failure);
    };

    for (const DataRange& range : format->data) {
        std::uint64_t rangeOffset = range.offset;
        std::uint64_t rangeRemaining = range.length;
        while (rangeRemaining > 0) {
            std::uint64_t chunkLength = std::min(rangeRemaining, alignedChunkBytes);
            chunkLength -= chunkLength % format->blockAlign;
            if (chunkLength == 0 || chunkLength > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
                return failImport(core::error("wave_chunk_invalid", "Audio chunk length exceeds this platform's range."));
            }
            auto raw = readAt(input, rangeOffset, static_cast<std::size_t>(chunkLength));
            if (!raw)
                return failImport(raw.error());
            Bytes payload;
            payload.reserve(raw->size());
            for (const unsigned char byte : *raw)
                payload.push_back(static_cast<std::byte>(byte));

            const std::uint64_t sampleCount = chunkLength / format->blockAlign;
            const std::uint64_t nextSampleIndex = firstSampleIndex + sampleCount;
            Record chunk;
            chunk.type = RecordType::AudioChunk;
            chunk.id = archive::randomUuid();
            chunk.fields = {
                {"session_id", archive::uuidToString(sessionId)},
                {"track_id", archive::uuidToString(summary.trackId)},
                {"sequence_number", std::to_string(sequenceNumber)},
                {"first_sample_index", std::to_string(firstSampleIndex)},
                {"sample_count", std::to_string(sampleCount)},
                {"timeline_start_us", std::to_string(samplesToMicroseconds(firstSampleIndex, format->sampleRateHz))},
                {"timeline_end_us", std::to_string(samplesToMicroseconds(nextSampleIndex, format->sampleRateHz))},
                {"sample_format", format->sampleFormat},
                {"sample_rate_hz", std::to_string(format->sampleRateHz)},
                {"channel_count", std::to_string(format->channelCount)},
                {"channel_mask", std::to_string(format->channelMask)},
                {"codec", "none"},
                {"payload_checksum", std::to_string(archive::crc32(payload))},
                {"source_filename", source.filename().string()}
            };
            chunk.blob = std::move(payload);
            transaction.push_back(std::move(chunk));
            ++sequenceNumber;
            firstSampleIndex = nextSampleIndex;
            rangeOffset += chunkLength;
            rangeRemaining -= chunkLength;

            if (transaction.size() >= chunksPerTransaction) {
                if (auto status = commitChunkBatch(); !status)
                    return failImport(status.error());
            }
        }
    }

    if (!transaction.empty()) {
        const std::uint64_t batchChunkCount = transaction.size();
        session.fields["recording_state"] = "finalizing";
        session.fields["audio_import_state"] = "finalizing";
        session.fields["audio_chunks_imported"] = std::to_string(committedChunkCount + batchChunkCount);
        session.fields["audio_samples_imported"] = std::to_string(firstSampleIndex);
        session.fields["audio_import_bytes"] = std::to_string(format->dataBytes);
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        transaction.push_back(session);
        if (auto status = archive.putMany(std::move(transaction)); !status)
            return failImport(status.error());
        committedChunkCount += batchChunkCount;
        committedSamples = firstSampleIndex;
    }
    session.fields["audio_imported_at_us"] = std::to_string(nowUnixMicroseconds());
    if (auto status = updateSession(archive, session, "completed", "completed", sequenceNumber, summary.sampleCount); !status) {
        return failImport(status.error());
    }
    if (auto status = updateRecordingTake(archive, summary.takeId, "completed", summary.durationUs); !status)
        return std::unexpected(status.error());
    summary.chunkCount = sequenceNumber;
    summary.completed = true;
    return summary;
}

core::Result<ImportSummary> recoverWaveImport(Archive& archive, const Uuid& sessionId) {
    auto sessionResult = archive.get(RecordType::Session, sessionId);
    if (!sessionResult)
        return std::unexpected(sessionResult.error());
    if (!*sessionResult || domain::isDeleted(**sessionResult)) {
        return std::unexpected(core::error("session_not_found", "Session was not found in the selected archive."));
    }
    Record session = std::move(**sessionResult);
    const auto importTakeId = archive::uuidFromString(
        domain::getField(session, "audio_import_take_id"));
    const auto persistTakeRecoveryState = [&](std::string state, std::uint64_t durationUs) {
        return importTakeId ? updateRecordingTake(archive, *importTakeId, std::move(state),
                                                  durationUs)
                            : core::Status{};
    };
    const std::string importState = domain::getField(session, "audio_import_state");
    if (importState != "importing" && importState != "finalizing" && importState != "interrupted" && importState != "completed") {
        return std::unexpected(core::error("audio_recovery_unavailable", "Session has no recoverable WAV import metadata."));
    }

    auto trackId = archive::uuidFromString(domain::getField(session, "audio_import_track_id"));
    auto expectedChunks = parseUnsigned(domain::getField(session, "audio_import_expected_chunks"), "expected chunk count");
    auto expectedSamples = parseUnsigned(domain::getField(session, "audio_import_expected_samples"), "expected sample count");
    auto expectedBytes = parseUnsigned(domain::getField(session, "audio_import_expected_bytes"), "expected byte count");
    auto sampleRate = parseUnsigned(domain::getField(session, "audio_import_sample_rate_hz"), "sample rate");
    auto channelCount = parseUnsigned(domain::getField(session, "audio_import_channel_count"), "channel count");
    if (!trackId || !expectedChunks || !expectedSamples || !expectedBytes || !sampleRate || !channelCount || *expectedChunks == 0 ||
        *expectedSamples == 0 || *expectedBytes == 0 || *sampleRate < 8'000 || *sampleRate > 384'000 || *channelCount == 0 ||
        *channelCount > 8) {
        const std::string reason = "Saved audio import metadata is incomplete.";
        session.fields["audio_import_bytes"] = "0";
        auto status = updateSession(archive, session, "interrupted", "interrupted", 0, 0, reason);
        if (!status)
            return std::unexpected(status.error());
        if (auto takeStatus = persistTakeRecoveryState("failed", 0); !takeStatus)
            return std::unexpected(takeStatus.error());
        return std::unexpected(core::error("audio_recovery_metadata_invalid", reason));
    }

    const std::string sampleFormat = domain::getField(session, "audio_import_sample_format");
    std::uint64_t bytesPerSample = 0;
    if (sampleFormat == "pcm_u8")
        bytesPerSample = 1;
    else if (sampleFormat == "pcm_s16le")
        bytesPerSample = 2;
    else if (sampleFormat == "pcm_s24le")
        bytesPerSample = 3;
    else if (sampleFormat == "pcm_s32le" || sampleFormat == "pcm_f32le")
        bytesPerSample = 4;
    const std::uint64_t blockAlign = bytesPerSample * *channelCount;
    if (blockAlign == 0 || *expectedSamples > std::numeric_limits<std::uint64_t>::max() / blockAlign ||
        *expectedSamples * blockAlign != *expectedBytes) {
        const std::string reason = "Saved audio format does not match its expected byte count.";
        session.fields["audio_import_bytes"] = "0";
        auto status = updateSession(archive, session, "interrupted", "interrupted", 0, 0, reason);
        if (!status)
            return std::unexpected(status.error());
        if (auto takeStatus = persistTakeRecoveryState("failed", 0); !takeStatus)
            return std::unexpected(takeStatus.error());
        return std::unexpected(core::error("audio_recovery_metadata_invalid", reason));
    }

    ImportSummary summary;
    summary.trackId = *trackId;
    summary.takeId = importTakeId.value_or(Uuid{});
    summary.sampleRateHz = static_cast<std::uint32_t>(*sampleRate);
    summary.channelCount = static_cast<std::uint16_t>(*channelCount);
    const std::uint64_t maximumTimestampSample = (std::numeric_limits<std::uint64_t>::max() / 1'000'000ULL) * *sampleRate;
    std::string failureReason;
    std::uint64_t recoveredSamples = 0;
    std::uint64_t recoveredBytes = 0;
    auto chunkStatus = archive.forEachAudioChunk(sessionId, *trackId, [&](Record&& chunk) {
        const auto sequence = parseUnsigned(domain::getField(chunk, "sequence_number"), "chunk sequence");
        const auto firstSample = parseUnsigned(domain::getField(chunk, "first_sample_index"), "first sample index");
        const auto sampleCount = parseUnsigned(domain::getField(chunk, "sample_count"), "sample count");
        const auto checksum = parseUnsigned(domain::getField(chunk, "payload_checksum"), "payload checksum");
        const auto startTime = parseUnsigned(domain::getField(chunk, "timeline_start_us"), "start timestamp");
        const auto endTime = parseUnsigned(domain::getField(chunk, "timeline_end_us"), "end timestamp");
        if (!sequence || !firstSample || !sampleCount || !checksum || !startTime || !endTime || *sequence != summary.chunkCount ||
            *firstSample != recoveredSamples || *sampleCount == 0 || domain::getField(chunk, "sample_format") != sampleFormat ||
            domain::getField(chunk, "codec") != "none" || domain::getField(chunk, "sample_rate_hz") != std::to_string(*sampleRate) ||
            domain::getField(chunk, "channel_count") != std::to_string(*channelCount) ||
            domain::getField(chunk, "channel_mask") != domain::getField(session, "audio_import_channel_mask", "0") ||
            *sampleCount > std::numeric_limits<std::uint64_t>::max() / blockAlign ||
            *firstSample > std::numeric_limits<std::uint64_t>::max() - *sampleCount ||
            *firstSample + *sampleCount > maximumTimestampSample ||
            recoveredSamples > std::numeric_limits<std::uint64_t>::max() - *sampleCount ||
            recoveredBytes > std::numeric_limits<std::uint64_t>::max() - chunk.blob.size() ||
            *sampleCount * blockAlign != chunk.blob.size() || *checksum > std::numeric_limits<std::uint32_t>::max() ||
            archive::crc32(chunk.blob) != *checksum || *startTime != samplesToMicroseconds(*firstSample, summary.sampleRateHz) ||
            *endTime != samplesToMicroseconds(*firstSample + *sampleCount, summary.sampleRateHz)) {
            failureReason = "A committed audio chunk is missing, malformed, or corrupt.";
            return false;
        }
        recoveredSamples += *sampleCount;
        recoveredBytes += chunk.blob.size();
        ++summary.chunkCount;
        return true;
    });
    if (!chunkStatus)
        return std::unexpected(chunkStatus.error());
    summary.sampleCount = recoveredSamples;
    summary.byteCount = recoveredBytes;
    summary.durationUs = samplesToMicroseconds(recoveredSamples, summary.sampleRateHz);
    summary.completed = failureReason.empty() && summary.chunkCount == *expectedChunks && summary.sampleCount == *expectedSamples &&
                        summary.byteCount == *expectedBytes;
    if (!summary.completed && failureReason.empty())
        failureReason = "Committed chunks do not reach the expected end of the WAV.";

    session.fields["audio_import_bytes"] = std::to_string(summary.byteCount);
    if (summary.completed)
        session.fields["audio_imported_at_us"] = std::to_string(nowUnixMicroseconds());
    else
        session.fields.erase("audio_imported_at_us");
    auto status =
        updateSession(archive, session, summary.completed ? "completed" : "interrupted", summary.completed ? "completed" : "interrupted",
                      summary.chunkCount, summary.sampleCount, summary.completed ? std::string{} : failureReason);
    if (!status)
        return std::unexpected(status.error());
    if (auto takeStatus = persistTakeRecoveryState(summary.completed ? "completed" : "partial",
                                                   summary.durationUs);
        !takeStatus)
        return std::unexpected(takeStatus.error());
    return summary;
}

} // namespace tutorux::audio
