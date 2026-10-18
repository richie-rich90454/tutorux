#include "tutorux/archive/archive.hpp"
#include "tutorux/archive/compression.hpp"

#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/guide.hpp"
#include "tutorux/domain/hash.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstring>
#include <fstream>
#include <functional>
#include <limits>
#include <set>
#include <string_view>

#ifdef _WIN32
#include <Windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace tutorux::archive {
namespace {

    using core::Error;
    using core::Result;
    using core::Status;

    constexpr std::size_t kIndexPageTargetSize = 3072;
    constexpr std::uint16_t kRecordVersion = 1;
    constexpr std::uint8_t kUncompressedCodec =
        static_cast<std::uint8_t>(RecordCodec::uncompressed);
    constexpr std::uint8_t kLz4BlockCodec = static_cast<std::uint8_t>(RecordCodec::lz4Block);

    template <typename Integer> void appendLittle(Bytes& output, Integer value) {
        using Unsigned = std::make_unsigned_t<Integer>;
        const auto bits = static_cast<Unsigned>(value);
        for (std::size_t index = 0; index < sizeof(Integer); ++index) {
            output.push_back(static_cast<std::byte>((bits >> (index * 8U)) & 0xffU));
        }
    }

    template <typename Integer>
    Result<Integer> readLittle(std::span<const std::byte> input, std::size_t& cursor) {
        if (cursor > input.size() || input.size() - cursor < sizeof(Integer)) {
            return std::unexpected(
                core::error("archive_truncated", "Archive structure is truncated."));
        }
        using Unsigned = std::make_unsigned_t<Integer>;
        std::uint64_t bits = 0;
        for (std::size_t index = 0; index < sizeof(Integer); ++index) {
            bits |= static_cast<std::uint64_t>(std::to_integer<unsigned int>(input[cursor + index]))
                    << (index * 8U);
        }
        cursor += sizeof(Integer);
        return static_cast<Integer>(static_cast<Unsigned>(bits));
    }

    bool matches(std::span<const std::byte> input, std::string_view magic) {
        if (input.size() < magic.size())
            return false;
        for (std::size_t index = 0; index < magic.size(); ++index) {
            if (input[index] != static_cast<std::byte>(magic[index]))
                return false;
        }
        return true;
    }

    Bytes macInput(std::string_view label, std::span<const std::byte> payload) {
        Bytes input;
        input.reserve(label.size() + payload.size());
        for (const char character : label)
            input.push_back(static_cast<std::byte>(character));
        input.insert(input.end(), payload.begin(), payload.end());
        return input;
    }

    std::uint64_t nowUnixMicroseconds() {
        const auto now = std::chrono::system_clock::now().time_since_epoch();
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(now).count());
    }

    std::string indexKey(RecordType type, const Uuid& id) {
        std::string name = recordTypeName(type);
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char character) {
            return static_cast<char>(character >= 'a' && character <= 'z' ? character - 'a' + 'A'
                                                                          : character);
        });
        return name + ":" + uuidToString(id);
    }

    Result<std::uint64_t> parseEncryptionLimit(const Record& record, std::string_view key) {
        const std::string value = domain::getField(record, key);
        std::uint64_t parsed = 0;
        const auto [end, errorCode] =
            std::from_chars(value.data(), value.data() + value.size(), parsed);
        if (value.empty() || errorCode != std::errc{} || end != value.data() + value.size()) {
            return std::unexpected(
                core::error("archive_encryption_metadata_invalid",
                            "Archive encryption metadata contains an invalid KDF limit."));
        }
        return parsed;
    }

    template <std::size_t Size>
    Status copyHexField(const Record& record,
                        std::string_view field,
                        std::array<std::byte, Size>& destination) {
        auto decoded = decodeHex(domain::getField(record, field));
        if (!decoded || decoded->size() != destination.size()) {
            return std::unexpected(core::error("archive_encryption_metadata_invalid",
                                               "Archive encryption metadata contains an invalid " +
                                                   std::string(field) + " value."));
        }
        std::copy(decoded->begin(), decoded->end(), destination.begin());
        return {};
    }

    Result<EncryptionEnvelope> parseEncryptionEnvelope(const Record& record) {
        if (record.type != RecordType::Encryption ||
            domain::getField(record, "encryption_version") != "1" ||
            domain::getField(record, "kdf") != "argon2id13" ||
            domain::getField(record, "aead") != "xchacha20-poly1305-ietf") {
            return std::unexpected(
                core::error("archive_encryption_metadata_invalid",
                            "Archive encryption metadata version or algorithm is unsupported."));
        }
        EncryptionEnvelope envelope;
        if (auto status = copyHexField(record, "salt", envelope.salt); !status)
            return std::unexpected(status.error());
        if (auto status = copyHexField(record, "nonce", envelope.nonce); !status)
            return std::unexpected(status.error());
        if (auto status = copyHexField(record, "wrapped_key", envelope.wrappedKey); !status)
            return std::unexpected(status.error());
        auto opsLimit = parseEncryptionLimit(record, "opslimit");
        auto memoryLimit = parseEncryptionLimit(record, "memlimit");
        if (!opsLimit || !memoryLimit)
            return std::unexpected(!opsLimit ? opsLimit.error() : memoryLimit.error());
        envelope.opsLimit = *opsLimit;
        envelope.memoryLimit = *memoryLimit;
        return envelope;
    }

    std::optional<std::string> indexPrefixEnd(std::string_view prefix) {
        std::string end(prefix);
        for (std::size_t index = end.size(); index > 0; --index) {
            auto& character = end[index - 1];
            if (static_cast<unsigned char>(character) != 0xffU) {
                character = static_cast<char>(static_cast<unsigned char>(character) + 1U);
                end.resize(index);
                return end;
            }
        }
        return std::nullopt;
    }

    std::optional<std::string> audioSessionIndexKey(const Record& record) {
        if (record.type != RecordType::AudioChunk)
            return std::nullopt;
        const auto sessionField = record.fields.find("session_id");
        const auto trackField = record.fields.find("track_id");
        const auto sequenceField = record.fields.find("sequence_number");
        if (sessionField == record.fields.end() || trackField == record.fields.end() ||
            sequenceField == record.fields.end()) {
            return std::nullopt;
        }
        auto sessionId = uuidFromString(sessionField->second);
        auto trackId = uuidFromString(trackField->second);
        std::uint64_t sequence = 0;
        const auto [end, errorCode] =
            std::from_chars(sequenceField->second.data(),
                            sequenceField->second.data() + sequenceField->second.size(),
                            sequence);
        if (!sessionId || !trackId || errorCode != std::errc{} ||
            end != sequenceField->second.data() + sequenceField->second.size()) {
            return std::nullopt;
        }
        std::string sequenceText = std::to_string(sequence);
        sequenceText.insert(0, 20 - sequenceText.size(), '0');
        return "AUDIOSESSION:" + uuidToString(*sessionId) + ":" + uuidToString(*trackId) + ":" +
               sequenceText;
    }

    std::set<std::string, std::less<>> guideSourceIndexKeys(const Record& record) {
        std::set<std::string, std::less<>> keys;
        if (record.type != RecordType::Guide)
            return keys;
        const auto addSourceIds = [&](std::string_view value) {
            std::size_t start = 0;
            while (start < value.size()) {
                const auto comma = value.find(',', start);
                const auto end = comma == std::string_view::npos ? value.size() : comma;
                if (end > start) {
                    auto sourceId = uuidFromString(value.substr(start, end - start));
                    if (sourceId) {
                        keys.insert("GUIDESOURCE:" + uuidToString(*sourceId) + ":" +
                                    uuidToString(record.id));
                    }
                }
                if (comma == std::string_view::npos)
                    break;
                start = comma + 1;
            }
        };
        constexpr std::string_view fieldPrefix = "section.";
        constexpr std::string_view fieldSuffix = ".source_ids";
        for (const auto& [field, value] : record.fields) {
            if (!field.starts_with(fieldPrefix) || !field.ends_with(fieldSuffix))
                continue;
            addSourceIds(value);
        }
        const auto history = record.fields.find("source_index_history");
        if (history != record.fields.end())
            addSourceIds(history->second);
        return keys;
    }

    void preserveGuideSourceHistory(Record& current,
                                    const Record& previous,
                                    const std::set<std::string, std::less<>>& aliases) {
        if (current.type != RecordType::Guide)
            return;
        std::set<std::string, std::less<>> sourceIds;
        const auto addSourceIds = [&](std::string_view value) {
            std::size_t start = 0;
            while (start < value.size()) {
                const auto comma = value.find(',', start);
                const auto end = comma == std::string_view::npos ? value.size() : comma;
                if (end > start)
                    sourceIds.emplace(value.substr(start, end - start));
                if (comma == std::string_view::npos)
                    break;
                start = comma + 1;
            }
        };
        if (const auto history = previous.fields.find("source_index_history");
            history != previous.fields.end()) {
            addSourceIds(history->second);
        }
        constexpr std::string_view aliasPrefix = "GUIDESOURCE:";
        for (const std::string& alias : aliases) {
            if (!alias.starts_with(aliasPrefix))
                continue;
            const auto separator = alias.find(':', aliasPrefix.size());
            if (separator != std::string::npos)
                sourceIds.insert(alias.substr(aliasPrefix.size(), separator - aliasPrefix.size()));
        }
        std::string encoded;
        for (const std::string& sourceId : sourceIds) {
            if (!encoded.empty())
                encoded.push_back(',');
            encoded += sourceId;
        }
        if (!encoded.empty())
            current.fields["source_index_history"] = std::move(encoded);
    }

    bool isGuideSourceType(RecordType type) {
        return type == RecordType::Student || type == RecordType::Session ||
               type == RecordType::TranscriptSegment || type == RecordType::Annotation ||
               type == RecordType::AssetMetadata || type == RecordType::EvidenceNode;
    }

    bool markGuideBlocksStale(Record& guide, std::string_view sourceId) {
        bool changed = false;
        constexpr std::string_view fieldPrefix = "section.";
        constexpr std::string_view fieldSuffix = ".source_ids";
        for (const auto& [field, value] : guide.fields) {
            if (!field.starts_with(fieldPrefix) || !field.ends_with(fieldSuffix))
                continue;
            std::size_t start = 0;
            bool citesSource = false;
            while (start < value.size()) {
                const auto comma = value.find(',', start);
                const auto end = comma == std::string::npos ? value.size() : comma;
                if (value.substr(start, end - start) == sourceId) {
                    citesSource = true;
                    break;
                }
                if (comma == std::string::npos)
                    break;
                start = comma + 1;
            }
            if (!citesSource)
                continue;
            std::string staleField = field.substr(0, field.size() - fieldSuffix.size());
            staleField += "stale";
            if (guide.fields[staleField] != "true") {
                guide.fields[staleField] = "true";
                changed = true;
            }
        }
        if (changed) {
            guide.fields["stale_sources_updated_at_us"] = std::to_string(nowUnixMicroseconds());
            guide.fields["stale_source_id"] = std::string(sourceId);
            std::size_t staleBlockCount = 0;
            for (const auto& [field, value] : guide.fields) {
                if (field.starts_with("section.") && field.ends_with(".stale") && value == "true") {
                    ++staleBlockCount;
                }
            }
            guide.fields["stale_block_count"] = std::to_string(staleBlockCount);
        }
        return changed;
    }

    struct FrameHeader final {
        RecordType type{};
        std::uint16_t version{};
        std::uint64_t payloadLength{};
        Uuid id{};
        std::uint64_t revision{};
        std::uint64_t previousOffset{};
        std::uint8_t codec{};
        std::uint8_t flags{};
        std::uint32_t payloadChecksum{};
    };

    Result<FrameHeader> decodeFrameHeader(std::span<const std::byte> bytes) {
        if (bytes.size() < kRecordHeaderSize || !matches(bytes, "TXRC")) {
            return std::unexpected(
                core::error("record_header_invalid", "Record header magic or length is invalid."));
        }
        std::size_t cursor = 4;
        auto type = readLittle<std::uint16_t>(bytes, cursor);
        auto version = readLittle<std::uint16_t>(bytes, cursor);
        auto headerLength = readLittle<std::uint32_t>(bytes, cursor);
        auto payloadLength = readLittle<std::uint64_t>(bytes, cursor);
        if (!type || !version || !headerLength || !payloadLength ||
            *headerLength != kRecordHeaderSize || *version != kRecordVersion ||
            *payloadLength > kMaximumRecordPayload) {
            return std::unexpected(
                core::error("record_header_invalid", "Record framing fields are invalid."));
        }
        FrameHeader header;
        header.type = static_cast<RecordType>(*type);
        header.version = *version;
        header.payloadLength = *payloadLength;
        std::copy_n(bytes.begin() + static_cast<std::ptrdiff_t>(cursor), 16, header.id.begin());
        cursor += 16;
        auto revision = readLittle<std::uint64_t>(bytes, cursor);
        auto previous = readLittle<std::uint64_t>(bytes, cursor);
        if (!revision || !previous)
            return std::unexpected(
                core::error("record_header_invalid", "Record framing fields are truncated."));
        header.revision = *revision;
        header.previousOffset = *previous;
        header.codec = std::to_integer<std::uint8_t>(bytes[cursor++]);
        header.flags = std::to_integer<std::uint8_t>(bytes[cursor++]);
        auto reserved = readLittle<std::uint16_t>(bytes, cursor);
        auto payloadChecksum = readLittle<std::uint32_t>(bytes, cursor);
        auto headerChecksum = readLittle<std::uint32_t>(bytes, cursor);
        if (!payloadChecksum || !headerChecksum || crc32(bytes.first(60)) != *headerChecksum ||
            !reserved || *reserved != 0 ||
            (header.flags & static_cast<std::uint8_t>(~kRecordFlagEncrypted)) != 0 ||
            (header.codec != kUncompressedCodec && header.codec != kLz4BlockCodec)) {
            return std::unexpected(core::error("record_header_checksum",
                                               "Record header checksum or codec is invalid."));
        }
        header.payloadChecksum = *payloadChecksum;
        return header;
    }

    Bytes encodeFrameHeader(RecordType type,
                            std::uint64_t payloadLength,
                            const Uuid& id,
                            std::uint64_t revision,
                            std::uint64_t previousOffset,
                            std::span<const std::byte> payload,
                            std::uint8_t flags = 0,
                            std::uint8_t codec = kUncompressedCodec) {
        Bytes header;
        header.reserve(kRecordHeaderSize);
        for (char character : std::string_view("TXRC", 4))
            header.push_back(static_cast<std::byte>(character));
        appendLittle(header, static_cast<std::uint16_t>(type));
        appendLittle(header, kRecordVersion);
        appendLittle<std::uint32_t>(header, static_cast<std::uint32_t>(kRecordHeaderSize));
        appendLittle(header, payloadLength);
        header.insert(header.end(), id.begin(), id.end());
        appendLittle(header, revision);
        appendLittle(header, previousOffset);
        header.push_back(static_cast<std::byte>(codec));
        header.push_back(static_cast<std::byte>(flags));
        appendLittle<std::uint16_t>(header, 0);
        appendLittle(header, crc32(payload));
        appendLittle(header, crc32(header));
        return header;
    }

    Result<RecordLocation> appendFrame(ArchiveFile& file,
                                       RecordType type,
                                       const Uuid& id,
                                       std::uint64_t revision,
                                       std::uint64_t previousOffset,
                                       std::span<const std::byte> payload,
                                       std::uint8_t flags = 0,
                                       std::uint8_t codec = kUncompressedCodec) {
        if (!file.writable())
            return std::unexpected(
                core::error("archive_read_only", "Archive was opened read-only."));
        if (payload.size() > kMaximumRecordPayload) {
            return std::unexpected(
                core::error("record_payload_limit", "Record exceeds the v1 payload limit."));
        }
        auto currentSize = file.size();
        if (!currentSize)
            return std::unexpected(currentSize.error());
        const std::uint64_t padding = (8U - ((kRecordHeaderSize + payload.size()) % 8U)) % 8U;
        if (*currentSize > std::numeric_limits<std::uint64_t>::max() - kRecordHeaderSize -
                               payload.size() - padding) {
            return std::unexpected(
                core::error("archive_size_limit", "Archive offset range was exceeded."));
        }
        const Bytes header = encodeFrameHeader(type,
                                               payload.size(),
                                               id,
                                               revision,
                                               previousOffset,
                                               payload,
                                               flags,
                                               codec);
        const std::uint64_t offset = *currentSize;
        if (auto status = file.write(offset, header); !status)
            return std::unexpected(status.error());
        if (auto status = file.write(offset + kRecordHeaderSize, payload); !status)
            return std::unexpected(status.error());
        if (padding != 0) {
            const std::array<std::byte, 8> zeroes{};
            if (auto status = file.write(
                    offset + kRecordHeaderSize + payload.size(),
                    std::span<const std::byte>(zeroes).first(static_cast<std::size_t>(padding)));
                !status)
                return std::unexpected(status.error());
        }
        return RecordLocation{offset, kRecordHeaderSize + payload.size() + padding};
    }

    Result<std::pair<FrameHeader, Bytes>> readFrame(const ArchiveFile& file,
                                                    std::uint64_t offset,
                                                    std::optional<RecordType> expected = {}) {
        auto fileSize = file.size();
        if (!fileSize)
            return std::unexpected(fileSize.error());
        if (offset % 8U != 0 || offset > *fileSize || *fileSize - offset < kRecordHeaderSize) {
            return std::unexpected(
                core::error("record_offset_invalid",
                            "Record offset is unaligned or outside the archive."));
        }
        auto rawHeader = file.read(offset, kRecordHeaderSize);
        if (!rawHeader)
            return std::unexpected(rawHeader.error());
        auto header = decodeFrameHeader(*rawHeader);
        if (!header)
            return std::unexpected(header.error());
        if (expected && header->type != *expected) {
            return std::unexpected(core::error("record_type_mismatch",
                                               "Referenced archive record has the wrong type."));
        }
        const std::uint64_t payloadOffset = offset + kRecordHeaderSize;
        if (header->payloadLength > *fileSize - payloadOffset) {
            return std::unexpected(
                core::error("record_offset_invalid", "Record payload extends beyond the archive."));
        }
        auto payload = file.read(payloadOffset, static_cast<std::size_t>(header->payloadLength));
        if (!payload)
            return std::unexpected(payload.error());
        if (crc32(*payload) != header->payloadChecksum) {
            return std::unexpected(
                core::error("record_payload_checksum", "Record payload checksum is invalid."));
        }
        const std::uint64_t padding = (8U - (header->payloadLength % 8U)) % 8U;
        const std::uint64_t paddingOffset = payloadOffset + header->payloadLength;
        if (padding > *fileSize - paddingOffset) {
            return std::unexpected(
                core::error("record_offset_invalid", "Record alignment padding is truncated."));
        }
        if (padding != 0) {
            auto paddingBytes = file.read(paddingOffset, static_cast<std::size_t>(padding));
            if (!paddingBytes)
                return std::unexpected(paddingBytes.error());
            if (std::any_of(paddingBytes->begin(), paddingBytes->end(), [](std::byte value) {
                    return value != std::byte{};
                })) {
                return std::unexpected(core::error("record_padding_invalid",
                                                   "Record alignment padding must be zero."));
            }
        }
        return std::pair{*header, std::move(*payload)};
    }

    struct DecodedCommit final {
        CommitInfo info;
        std::uint32_t archiveVersion{};
        bool hasAuthentication{};
    };

    Result<DecodedCommit> decodeCommit(const ArchiveFile& file, std::uint64_t offset) {
        auto framed = readFrame(file, offset, RecordType::Commit);
        if (!framed)
            return std::unexpected(framed.error());
        const auto& payload = framed->second;
        if ((payload.size() != 92 && payload.size() != 124) || !matches(payload, "TXCM")) {
            return std::unexpected(
                core::error("commit_invalid", "Commit record has an invalid structure."));
        }
        std::size_t cursor = 4;
        auto version = readLittle<std::uint16_t>(payload, cursor);
        auto reserved = readLittle<std::uint16_t>(payload, cursor);
        auto generation = readLittle<std::uint64_t>(payload, cursor);
        auto previousOffset = readLittle<std::uint64_t>(payload, cursor);
        auto rootOffset = readLittle<std::uint64_t>(payload, cursor);
        if (!version || *version != 1 || !reserved || *reserved != 0 || !generation ||
            *generation == 0 || !previousOffset || !rootOffset) {
            return std::unexpected(core::error("commit_invalid", "Commit fields are invalid."));
        }
        DecodedCommit decoded;
        decoded.info.generation = *generation;
        decoded.info.offset = offset;
        decoded.info.previousOffset = *previousOffset;
        decoded.info.rootOffset = *rootOffset;
        std::copy_n(payload.begin() + static_cast<std::ptrdiff_t>(cursor),
                    32,
                    decoded.info.rootHash.begin());
        cursor += 32;
        std::copy_n(payload.begin() + static_cast<std::ptrdiff_t>(cursor),
                    16,
                    decoded.info.transactionId.begin());
        cursor += 16;
        auto recordCount = readLittle<std::uint64_t>(payload, cursor);
        auto archiveVersion = readLittle<std::uint32_t>(payload, cursor);
        if (!recordCount || !archiveVersion || *archiveVersion != 1) {
            return std::unexpected(core::error("commit_invalid", "Commit metadata is invalid."));
        }
        decoded.info.recordCount = *recordCount;
        decoded.archiveVersion = *archiveVersion;
        decoded.hasAuthentication = payload.size() == 124;
        return decoded;
    }

    bool isLocatorValid(std::span<const std::byte> bytes) {
        if (bytes.size() < kLocatorSize || !matches(bytes, std::string_view("TUXLOC1\0", 8)))
            return false;
        std::size_t cursor = 24;
        auto checksum = readLittle<std::uint32_t>(bytes, cursor);
        auto reserved = readLittle<std::uint32_t>(bytes, cursor);
        return checksum && reserved && *reserved == 0 && crc32(bytes.first(24)) == *checksum;
    }

    Result<std::uint64_t> findLatestCommitOffset(const ArchiveFile& file) {
        auto fileSize = file.size();
        if (!fileSize)
            return std::unexpected(fileSize.error());
        if (*fileSize < kArchiveHeaderSize + kLocatorSize) {
            return std::unexpected(
                core::error("archive_uncommitted", "Archive has no committed generation."));
        }
        const std::uint64_t recentSearchStart = std::max<std::uint64_t>(
            kArchiveHeaderSize,
            *fileSize > kRecoveryWindow ? *fileSize - kRecoveryWindow : kArchiveHeaderSize);
        constexpr std::size_t kChunkSize = 64 * 1024;
        const auto scanForLocator =
            [&](std::uint64_t searchStart) -> Result<std::optional<std::uint64_t>> {
            std::uint64_t chunkEnd = *fileSize;
            while (chunkEnd > searchStart) {
                const std::uint64_t chunkStart =
                    chunkEnd - searchStart > kChunkSize ? chunkEnd - kChunkSize : searchStart;
                const std::uint64_t readStart = chunkStart > searchStart + kLocatorSize
                                                    ? chunkStart - (kLocatorSize - 1)
                                                    : searchStart;
                const auto readLength = static_cast<std::size_t>(chunkEnd - readStart);
                auto chunk = file.read(readStart, readLength);
                if (!chunk)
                    return std::unexpected(chunk.error());
                if (chunk->size() >= kLocatorSize) {
                    for (std::size_t index = chunk->size() - kLocatorSize + 1; index-- > 0;) {
                        const std::uint64_t absoluteOffset = readStart + index;
                        if (absoluteOffset < chunkStart ||
                            absoluteOffset + kLocatorSize > *fileSize)
                            continue;
                        const auto candidate =
                            std::span<const std::byte>(*chunk).subspan(index, kLocatorSize);
                        if (!isLocatorValid(candidate))
                            continue;
                        std::size_t cursor = 8;
                        auto commitOffset = readLittle<std::uint64_t>(candidate, cursor);
                        auto generation = readLittle<std::uint64_t>(candidate, cursor);
                        if (!commitOffset || !generation || *commitOffset < kArchiveHeaderSize ||
                            *commitOffset >= absoluteOffset)
                            continue;
                        auto commit = decodeCommit(file, *commitOffset);
                        if (!commit || commit->info.generation != *generation)
                            continue;
                        return std::optional<std::uint64_t>(*commitOffset);
                    }
                }
                chunkEnd = chunkStart;
            }
            return std::optional<std::uint64_t>{};
        };
        auto recent = scanForLocator(recentSearchStart);
        if (!recent)
            return std::unexpected(recent.error());
        if (*recent)
            return **recent;
        if (recentSearchStart != kArchiveHeaderSize) {
            auto fullScan = scanForLocator(kArchiveHeaderSize);
            if (!fullScan)
                return std::unexpected(fullScan.error());
            if (*fullScan)
                return **fullScan;
        }
        return std::unexpected(
            core::error("archive_commit_missing",
                        "No valid commit locator was found after scanning the archive."));
    }

    std::string extensionLower(const std::filesystem::path& path) {
        std::string extension = path.extension().string();
        std::transform(extension.begin(),
                       extension.end(),
                       extension.begin(),
                       [](unsigned char character) {
                           return static_cast<char>(character >= 'A' && character <= 'Z'
                                                        ? character - 'A' + 'a'
                                                        : character);
                       });
        return extension;
    }

    std::string joinStrings(const std::vector<std::string>& values, std::string_view delimiter) {
        std::string output;
        for (std::size_t index = 0; index < values.size(); ++index) {
            if (index != 0)
                output += delimiter;
            output += values[index];
        }
        return output;
    }

} // namespace

struct Archive::IndexPage final {
    struct LeafEntry final {
        std::string key;
        std::uint64_t valueOffset{};
    };
    bool leaf{true};
    std::vector<LeafEntry> entries;
    std::vector<std::string> separators;
    std::vector<std::uint64_t> children;
};

core::Result<Archive> Archive::create(const std::filesystem::path& path,
                                      std::string_view displayName,
                                      std::string_view description) {
    if (extensionLower(path) != ".tux") {
        return std::unexpected(core::error("archive_extension_invalid",
                                           "Portable archives must use the .tux extension."));
    }
    bool createdFile = false;
    auto initialize = [&]() -> core::Result<Archive> {
        auto file = ArchiveFile::open(path, true, true);
        if (!file)
            return std::unexpected(file.error());
        createdFile = true;

        ArchiveHeader header;
        header.id = randomUuid();
        header.createdAtUs = nowUnixMicroseconds();
        auto encodedHeader = encodeArchiveHeader(header);
        if (!encodedHeader)
            return std::unexpected(encodedHeader.error());
        if (auto status = file->write(0, *encodedHeader); !status)
            return std::unexpected(status.error());
        if (auto status = file->flush(); !status)
            return std::unexpected(status.error());

        Archive archive(std::move(*file), header, CommitInfo{});
        IndexPage emptyRoot;
        auto rootOffset = archive.writeIndexPage(emptyRoot);
        if (!rootOffset)
            return std::unexpected(rootOffset.error());
        archive.commit_.rootOffset = *rootOffset;
        Record manifest;
        manifest.type = RecordType::Settings;
        manifest.id = header.id;
        manifest.fields = {
            {"record_role",   "archive-manifest"                },
            {"display_name",  std::string(displayName)          },
            {"description",   std::string(description)          },
            {"student_count", "0"                               },
            {"session_count", "0"                               },
            {"created_at_us", std::to_string(header.createdAtUs)}
        };
        if (auto status = archive.put(std::move(manifest)); !status)
            return std::unexpected(status.error());
        return archive;
    };

    auto archive = initialize();
    if (!archive && createdFile) {
        std::error_code ignored;
        std::filesystem::remove(path, ignored);
    }
    return archive;
}

core::Result<Archive> Archive::open(const std::filesystem::path& path,
                                    bool writable,
                                    std::string_view passphrase,
                                    bool allowLocked) {
    auto file = ArchiveFile::open(path, writable);
    if (!file)
        return std::unexpected(file.error());
    auto rawHeader = file->read(0, kArchiveHeaderSize);
    if (!rawHeader)
        return std::unexpected(rawHeader.error());
    auto header = decodeArchiveHeader(*rawHeader);
    if (!header)
        return std::unexpected(header.error());
    auto commitOffset = findLatestCommitOffset(*file);
    if (!commitOffset)
        return std::unexpected(commitOffset.error());
    auto currentOffset = *commitOffset;
    std::optional<DecodedCommit> latest;
    for (std::size_t attempt = 0; attempt < 1024 && currentOffset != 0; ++attempt) {
        auto candidate = decodeCommit(*file, currentOffset);
        if (candidate) {
            auto rootPage = readFrame(*file, candidate->info.rootOffset, RecordType::IndexPage);
            if (rootPage && domain::sha256(rootPage->second) == candidate->info.rootHash) {
                latest = *candidate;
                break;
            }
            currentOffset = candidate->info.previousOffset;
        } else {
            break;
        }
    }
    if (!latest) {
        return std::unexpected(
            core::error("archive_commit_invalid",
                        "No consistent committed archive generation could be opened."));
    }
    Archive archive(std::move(*file), *header, latest->info);
    archive.encryptionEnabled_ = (header->capabilities & kArchiveCapabilityEncrypted) != 0;
    if (archive.encryptionEnabled_) {
        archive.allowUnverifiedIndexReads_ = true;
        auto metadata = archive.encryptionMetadata();
        if (!metadata)
            return std::unexpected(metadata.error());
        auto envelope = parseEncryptionEnvelope(*metadata);
        if (!envelope)
            return std::unexpected(envelope.error());
        archive.encryptionEnvelope_ = *envelope;
        if (passphrase.empty()) {
            if (!allowLocked) {
                return std::unexpected(
                    core::error("archive_locked",
                                "Archive is encrypted; provide its passphrase to unlock."));
            }
            return archive;
        }
        auto key = unwrapArchiveKey(passphrase, *envelope, header->id);
        if (!key)
            return std::unexpected(key.error());
        archive.dataKey_.emplace(std::move(*key));
        archive.allowUnverifiedIndexReads_ = false;
        if (auto status = archive.verifyIndexAuthentication(); !status)
            return std::unexpected(status.error());
    }
    return archive;
}

core::Result<std::vector<ArchiveInfo>> Archive::discover(const std::filesystem::path& directory) {
    std::error_code errorCode;
    if (!std::filesystem::is_directory(directory, errorCode)) {
        return std::unexpected(
            core::error("directory_invalid", "Archive discovery path is not a directory."));
    }
    std::vector<ArchiveInfo> archives;
    std::filesystem::directory_iterator iterator(directory, errorCode);
    if (errorCode)
        return std::unexpected(core::error("directory_read_failed", errorCode.message()));
    const std::filesystem::directory_iterator end;
    for (; iterator != end; iterator.increment(errorCode)) {
        if (errorCode)
            return std::unexpected(core::error("directory_read_failed", errorCode.message()));
        const auto& entry = *iterator;
        std::error_code typeError;
        const auto status = entry.symlink_status(typeError);
        if (typeError || std::filesystem::is_symlink(status) ||
            !std::filesystem::is_regular_file(status) || extensionLower(entry.path()) != ".tux")
            continue;
        auto info = inspectArchive(entry.path());
        if (info) {
            archives.push_back(std::move(*info));
        } else {
            ArchiveInfo invalid;
            invalid.path = std::filesystem::absolute(entry.path());
            invalid.displayName = entry.path().stem().string();
            invalid.healthStatus = info.error().code;
            invalid.fileSize = std::filesystem::file_size(entry.path(), typeError);
            archives.push_back(std::move(invalid));
        }
    }
    std::sort(archives.begin(),
              archives.end(),
              [](const ArchiveInfo& left, const ArchiveInfo& right) {
                  return left.path.filename().native() < right.path.filename().native();
              });
    return archives;
}

core::Result<ArchiveInfo> inspectArchive(const std::filesystem::path& path,
                                         std::string_view passphrase) {
    auto archive = Archive::open(path, false, passphrase, true);
    if (!archive)
        return std::unexpected(archive.error());
    ArchiveInfo info;
    info.path = std::filesystem::absolute(path);
    info.id = archive->header().id;
    info.generation = archive->commitInfo().generation;
    info.createdAtUs = archive->header().createdAtUs;
    if (archive->locked())
        info.healthStatus = "locked";
    std::error_code errorCode;
    info.fileSize = std::filesystem::file_size(path, errorCode);
    if (errorCode)
        return std::unexpected(core::error("archive_stat_failed", errorCode.message()));
    auto manifest = archive->get(RecordType::Settings, archive->header().id);
    if (manifest && *manifest) {
        info.displayName = domain::getField(**manifest, "display_name", path.stem().string());
        info.description = domain::getField(**manifest, "description");
        const auto studentCount = domain::getField(**manifest, "student_count", "0");
        const auto sessionCount = domain::getField(**manifest, "session_count", "0");
        std::from_chars(studentCount.data(),
                        studentCount.data() + studentCount.size(),
                        info.studentCount);
        std::from_chars(sessionCount.data(),
                        sessionCount.data() + sessionCount.size(),
                        info.sessionCount);
    } else {
        info.displayName = path.stem().string();
    }
    return info;
}

core::Result<Bytes> Archive::readRecordPayloadAt(std::uint64_t offset,
                                                 std::optional<RecordType> expected) const {
    auto framed = readFrame(file_, offset, expected);
    if (!framed)
        return std::unexpected(framed.error());
    return std::move(framed->second);
}

core::Result<Record> Archive::readRecordAt(std::uint64_t offset) const {
    auto framed = readFrame(file_, offset);
    if (!framed)
        return std::unexpected(framed.error());
    const FrameHeader& header = framed->first;
    const bool encryptedRecord = (header.flags & kRecordFlagEncrypted) != 0;
    const bool plaintextManifest = header.type == RecordType::Settings && header.id == header_.id;
    const bool plaintextEncryptionMetadata =
        header.type == RecordType::Encryption && header.id == header_.id;
    const bool protectedRecord = !plaintextManifest && !plaintextEncryptionMetadata &&
                                 header.type != RecordType::IndexPage &&
                                 header.type != RecordType::Commit;
    if (encryptedRecord) {
        if (!encryptionEnabled_ || !dataKey_) {
            return std::unexpected(
                core::error("archive_locked",
                            "Archive record is encrypted and requires its passphrase."));
        }
        auto plaintext = decryptRecordPayload(framed->second,
                                              *dataKey_,
                                              header_.id,
                                              header.type,
                                              header.id,
                                              header.revision,
                                              header.previousOffset,
                                              header.codec);
        if (!plaintext)
            return std::unexpected(plaintext.error());
        auto decodedPayload =
            decompressRecordPayload(static_cast<RecordCodec>(header.codec), *plaintext);
        if (!decodedPayload)
            return std::unexpected(decodedPayload.error());
        return decodeRecordPayload(header.type,
                                   header.id,
                                   header.revision,
                                   header.previousOffset,
                                   *decodedPayload);
    }
    if (encryptionEnabled_ && protectedRecord) {
        return std::unexpected(core::error("archive_record_unencrypted",
                                           "Encrypted archive contains a plaintext data record."));
    }
    auto decodedPayload =
        decompressRecordPayload(static_cast<RecordCodec>(header.codec), framed->second);
    if (!decodedPayload)
        return std::unexpected(decodedPayload.error());
    auto record = decodeRecordPayload(header.type,
                                      header.id,
                                      header.revision,
                                      header.previousOffset,
                                      *decodedPayload);
    if (!record)
        return std::unexpected(record.error());
    if (encryptionEnabled_ && plaintextManifest && dataKey_) {
        const auto authenticationField = record->fields.find("manifest_auth");
        if (authenticationField == record->fields.end()) {
            return std::unexpected(
                core::error("archive_manifest_authentication_failed",
                            "Encrypted archive manifest has no authentication tag."));
        }
        auto authentication = decodeHex(authenticationField->second);
        record->fields.erase(authenticationField);
        auto unsignedPayload = encodeRecordPayload(*record);
        if (!authentication || !unsignedPayload) {
            return std::unexpected(
                core::error("archive_manifest_authentication_failed",
                            "Encrypted archive manifest authentication data is malformed."));
        }
        const Bytes input = macInput("TUTORUX-MANIFEST-V1", *unsignedPayload);
        if (!authenticationMatches(input, *authentication, *dataKey_)) {
            return std::unexpected(
                core::error("archive_manifest_authentication_failed",
                            "Encrypted archive manifest authentication failed."));
        }
    }
    return record;
}

core::Result<std::optional<std::uint64_t>> Archive::findOffset(std::string_view key) const {
    if (commit_.rootOffset == 0)
        return std::optional<std::uint64_t>{};
    std::uint64_t pageOffset = commit_.rootOffset;
    for (std::size_t depth = 0; depth < 32; ++depth) {
        auto page = readIndexPage(pageOffset);
        if (!page)
            return std::unexpected(page.error());
        if (page->leaf) {
            const auto found =
                std::lower_bound(page->entries.begin(),
                                 page->entries.end(),
                                 key,
                                 [](const IndexPage::LeafEntry& entry, std::string_view target) {
                                     return entry.key < target;
                                 });
            if (found == page->entries.end() || found->key != key)
                return std::optional<std::uint64_t>{};
            return std::optional<std::uint64_t>{found->valueOffset};
        }
        const auto child = static_cast<std::size_t>(
            std::upper_bound(page->separators.begin(), page->separators.end(), key) -
            page->separators.begin());
        if (child >= page->children.size()) {
            return std::unexpected(core::error("index_invalid", "B+ tree child index is invalid."));
        }
        pageOffset = page->children[child];
    }
    return std::unexpected(
        core::error("index_depth_exceeded", "B+ tree depth exceeds the v1 limit."));
}

core::Result<std::optional<Record>> Archive::get(RecordType type, const Uuid& id) const {
    std::lock_guard lock(*mutex_);
    return getByIndexKey(indexKey(type, id));
}

core::Result<std::optional<Record>>
Archive::getRevision(RecordType type, const Uuid& id, std::size_t revisionIndex) const {
    std::lock_guard lock(*mutex_);
    auto current = get(type, id);
    if (!current || !*current)
        return current;
    Record record = std::move(**current);
    for (std::size_t revision = 0; revision < revisionIndex; ++revision) {
        if (record.previousOffset == 0)
            return std::optional<Record>{};
        auto previous = readRecordAt(record.previousOffset);
        if (!previous)
            return std::unexpected(previous.error());
        record = std::move(*previous);
    }
    return std::optional<Record>{std::move(record)};
}

core::Result<std::optional<Record>> Archive::getByIndexKey(std::string_view key) const {
    std::lock_guard lock(*mutex_);
    auto offset = findOffset(key);
    if (!offset)
        return std::unexpected(offset.error());
    if (!*offset)
        return std::optional<Record>{};
    auto record = readRecordAt(**offset);
    if (!record)
        return std::unexpected(record.error());
    return std::optional<Record>{std::move(*record)};
}

core::Status Archive::forEachIndexPrefix(std::string_view indexPrefix,
                                         const std::function<bool(Record&&)>& visitor,
                                         bool includeDeleted) const {
    std::lock_guard lock(*mutex_);
    if (!visitor)
        return std::unexpected(core::error("archive_visitor_invalid", "Record visitor is empty."));
    if (indexPrefix.empty()) {
        return std::unexpected(
            core::error("archive_index_prefix_invalid", "Index prefix cannot be empty."));
    }
    if (commit_.rootOffset == 0)
        return {};
    const auto rangeEnd = indexPrefixEnd(indexPrefix);
    bool keepGoing = true;
    std::function<Status(std::uint64_t, std::size_t)> visit = [&](std::uint64_t offset,
                                                                  std::size_t depth) -> Status {
        if (depth > 32) {
            return std::unexpected(
                core::error("index_depth_exceeded", "B+ tree depth exceeds the v1 limit."));
        }
        auto page = readIndexPage(offset);
        if (!page)
            return std::unexpected(page.error());
        if (page->leaf) {
            for (const auto& entry : page->entries) {
                if (entry.key < indexPrefix)
                    continue;
                if (!entry.key.starts_with(indexPrefix))
                    break;
                auto record = readRecordAt(entry.valueOffset);
                if (!record)
                    return std::unexpected(record.error());
                const auto deleted = record->fields.find("_deleted");
                if (!includeDeleted && deleted != record->fields.end() &&
                    deleted->second == "true") {
                    continue;
                }
                if (!visitor(std::move(*record))) {
                    keepGoing = false;
                    return {};
                }
            }
            return {};
        }
        const std::size_t firstChild = static_cast<std::size_t>(
            std::upper_bound(page->separators.begin(), page->separators.end(), indexPrefix) -
            page->separators.begin());
        const std::size_t childEnd =
            rangeEnd ? static_cast<std::size_t>(std::lower_bound(page->separators.begin(),
                                                                 page->separators.end(),
                                                                 *rangeEnd) -
                                                page->separators.begin()) +
                           1
                     : page->children.size();
        for (std::size_t child = firstChild; child < childEnd && child < page->children.size();
             ++child) {
            if (auto status = visit(page->children[child], depth + 1); !status)
                return status;
            if (!keepGoing)
                break;
        }
        return {};
    };
    return visit(commit_.rootOffset, 0);
}

core::Status Archive::forEach(RecordType type,
                              const std::function<bool(Record&&)>& visitor,
                              bool includeDeleted) const {
    std::lock_guard lock(*mutex_);
    if (!visitor)
        return std::unexpected(core::error("archive_visitor_invalid", "Record visitor is empty."));
    std::string prefix = recordTypeName(type);
    std::transform(prefix.begin(), prefix.end(), prefix.begin(), [](unsigned char character) {
        return static_cast<char>(character >= 'a' && character <= 'z' ? character - 'a' + 'A'
                                                                      : character);
    });
    prefix.push_back(':');
    bool typeMismatch = false;
    auto status = forEachIndexPrefix(
        prefix,
        [&](Record&& record) {
            if (record.type != type) {
                typeMismatch = true;
                return false;
            }
            return visitor(std::move(record));
        },
        includeDeleted);
    if (!status)
        return status;
    if (typeMismatch) {
        return std::unexpected(
            core::error("record_type_mismatch", "Index entry points to the wrong record type."));
    }
    return {};
}

core::Status Archive::forEachAudioChunk(const Uuid& sessionId,
                                        const std::optional<Uuid>& trackId,
                                        const std::function<bool(Record&&)>& visitor,
                                        bool includeDeleted) const {
    std::lock_guard lock(*mutex_);
    if (!visitor)
        return std::unexpected(core::error("archive_visitor_invalid", "Record visitor is empty."));
    const std::string sessionIdText = uuidToString(sessionId);
    const std::string trackIdText = trackId ? uuidToString(*trackId) : std::string{};
    auto session = get(RecordType::Session, sessionId);
    if (!session)
        return std::unexpected(session.error());
    const bool hasAudioIndex =
        *session && domain::getField(**session, "audio_chunk_index_version") == "1";
    if (hasAudioIndex) {
        std::string prefix = "AUDIOSESSION:" + sessionIdText + ":";
        if (trackId)
            prefix += trackIdText + ":";
        bool invalidIndex = false;
        auto status = forEachIndexPrefix(
            prefix,
            [&](Record&& record) {
                if (record.type != RecordType::AudioChunk ||
                    domain::getField(record, "session_id") != sessionIdText ||
                    (trackId && domain::getField(record, "track_id") != trackIdText)) {
                    invalidIndex = true;
                    return false;
                }
                return visitor(std::move(record));
            },
            includeDeleted);
        if (!status)
            return status;
        if (invalidIndex) {
            return std::unexpected(core::error("audio_chunk_index_invalid",
                                               "Audio session index points to an invalid chunk."));
        }
        return {};
    }

    struct ChunkReference final {
        std::uint64_t sequence{};
        Uuid id{};
    };
    std::vector<ChunkReference> references;
    if (auto status = forEach(
            RecordType::AudioChunk,
            [&](Record&& record) {
                if (domain::getField(record, "session_id") != sessionIdText ||
                    (trackId && domain::getField(record, "track_id") != trackIdText)) {
                    return true;
                }
                std::uint64_t sequence = std::numeric_limits<std::uint64_t>::max();
                const std::string sequenceText = domain::getField(record, "sequence_number");
                const auto [end, errorCode] =
                    std::from_chars(sequenceText.data(),
                                    sequenceText.data() + sequenceText.size(),
                                    sequence);
                if (errorCode != std::errc{} || end != sequenceText.data() + sequenceText.size())
                    sequence = std::numeric_limits<std::uint64_t>::max();
                references.push_back({sequence, record.id});
                return true;
            },
            includeDeleted);
        !status) {
        return status;
    }
    std::sort(references.begin(), references.end(), [](const auto& left, const auto& right) {
        if (left.sequence != right.sequence)
            return left.sequence < right.sequence;
        return left.id < right.id;
    });
    for (const ChunkReference& reference : references) {
        auto record = get(RecordType::AudioChunk, reference.id);
        if (!record)
            return std::unexpected(record.error());
        if (!*record) {
            return std::unexpected(core::error("audio_chunk_index_invalid",
                                               "Audio chunk disappeared during archive scan."));
        }
        if (!visitor(std::move(**record)))
            break;
    }
    return {};
}

core::Result<std::vector<Record>> Archive::list(RecordType type, bool includeDeleted) const {
    std::lock_guard lock(*mutex_);
    std::vector<Record> records;
    if (auto status = forEach(
            type,
            [&](Record&& record) {
                records.push_back(std::move(record));
                return true;
            },
            includeDeleted);
        !status) {
        return std::unexpected(status.error());
    }
    return records;
}

core::Result<RecordLocation> Archive::appendRecord(const Record& record) {
    Record recordToWrite = record;
    const bool plaintextManifest = record.type == RecordType::Settings && record.id == header_.id;
    if (encryptionEnabled_ && plaintextManifest) {
        if (!dataKey_)
            return std::unexpected(
                core::error("archive_locked",
                            "Archive is locked and cannot authenticate its manifest."));
        recordToWrite.fields.erase("manifest_auth");
        auto unsignedPayload = encodeRecordPayload(recordToWrite);
        if (!unsignedPayload)
            return std::unexpected(unsignedPayload.error());
        const Bytes input = macInput("TUTORUX-MANIFEST-V1", *unsignedPayload);
        const auto authentication = authenticateBytes(input, *dataKey_);
        recordToWrite.fields["manifest_auth"] = encodeHex(authentication);
    }
    auto payload = encodeRecordPayload(recordToWrite);
    if (!payload)
        return std::unexpected(payload.error());
    EncodedPayload encodedPayload;
    const bool uncompressedAssetBlob = record.type == RecordType::AssetBlob;
    const bool losslessPcmAudio =
        record.type == RecordType::AudioChunk && domain::getField(recordToWrite, "codec") == "none";
    if (!uncompressedAssetBlob && (record.type != RecordType::AudioChunk || losslessPcmAudio)) {
        auto compressed = compressRecordPayload(std::move(*payload));
        if (!compressed)
            return std::unexpected(compressed.error());
        encodedPayload = std::move(*compressed);
    } else {
        encodedPayload.bytes = std::move(*payload);
    }
    const auto codec = static_cast<std::uint8_t>(encodedPayload.codec);
    const bool plaintextEncryptionMetadata =
        record.type == RecordType::Encryption && record.id == header_.id;
    if (!encryptionEnabled_ || plaintextManifest || plaintextEncryptionMetadata)
        return appendFrame(file_,
                           record.type,
                           record.id,
                           record.revision,
                           record.previousOffset,
                           encodedPayload.bytes,
                           0,
                           codec);
    if (!dataKey_) {
        return std::unexpected(
            core::error("archive_locked", "Archive is locked and cannot append records."));
    }
    auto encryptedPayload = encryptRecordPayload(encodedPayload.bytes,
                                                 *dataKey_,
                                                 header_.id,
                                                 record.type,
                                                 record.id,
                                                 record.revision,
                                                 record.previousOffset,
                                                 codec);
    if (!encryptedPayload)
        return std::unexpected(encryptedPayload.error());
    return appendFrame(file_,
                       record.type,
                       record.id,
                       record.revision,
                       record.previousOffset,
                       *encryptedPayload,
                       kRecordFlagEncrypted,
                       codec);
}

core::Result<Record> Archive::encryptionMetadata() const {
    auto record = get(RecordType::Encryption, header_.id);
    if (!record)
        return std::unexpected(record.error());
    if (!*record || domain::isDeleted(**record)) {
        return std::unexpected(
            core::error("archive_encryption_metadata_missing",
                        "Encrypted archive is missing its key-wrapping metadata."));
    }
    return std::move(**record);
}

core::Status Archive::writeEncryptionMetadata(const EncryptionEnvelope& envelope) {
    Record metadata;
    metadata.type = RecordType::Encryption;
    metadata.id = header_.id;
    metadata.fields = {
        {"encryption_version", "1"                                 },
        {"kdf",                "argon2id13"                        },
        {"aead",               "xchacha20-poly1305-ietf"           },
        {"salt",               encodeHex(envelope.salt)            },
        {"nonce",              encodeHex(envelope.nonce)           },
        {"wrapped_key",        encodeHex(envelope.wrappedKey)      },
        {"opslimit",           std::to_string(envelope.opsLimit)   },
        {"memlimit",           std::to_string(envelope.memoryLimit)}
    };
    if (auto status = put(std::move(metadata)); !status)
        return status;
    encryptionEnvelope_ = envelope;
    return {};
}

core::Status Archive::enableEncryption(std::string_view passphrase) {
    std::lock_guard lock(*mutex_);
    if (!writable()) {
        return std::unexpected(
            core::error("archive_read_only",
                        "Archive must be opened for writing to enable encryption."));
    }
    if (encryptionEnabled_) {
        return std::unexpected(
            core::error("archive_already_encrypted", "Archive is already encrypted."));
    }
    if (passphrase.size() < 12) {
        return std::unexpected(core::error("archive_passphrase_too_short",
                                           "Archive passphrases must contain at least 12 bytes."));
    }
    auto key = SecretKey::createRandom();
    if (!key)
        return std::unexpected(key.error());
    auto envelope = wrapArchiveKey(passphrase, *key, header_.id);
    if (!envelope)
        return std::unexpected(envelope.error());
    return rewrite(true, *envelope, &*key);
}

core::Status Archive::changePassphrase(std::string_view passphrase) {
    std::lock_guard lock(*mutex_);
    if (!writable()) {
        return std::unexpected(
            core::error("archive_read_only",
                        "Archive must be opened for writing to change its passphrase."));
    }
    if (!encryptionEnabled_ || !dataKey_) {
        return std::unexpected(
            core::error("archive_not_unlocked",
                        "Unlock an encrypted archive before changing its passphrase."));
    }
    if (passphrase.size() < 12) {
        return std::unexpected(core::error("archive_passphrase_too_short",
                                           "Archive passphrases must contain at least 12 bytes."));
    }
    auto envelope = wrapArchiveKey(passphrase, *dataKey_, header_.id);
    if (!envelope)
        return std::unexpected(envelope.error());
    if (auto status = writeEncryptionMetadata(*envelope); !status)
        return status;
    return compact();
}

core::Result<std::uint64_t> Archive::writeIndexPage(const IndexPage& page) {
    Bytes payload;
    for (char character : std::string_view("TXPG", 4))
        payload.push_back(static_cast<std::byte>(character));
    appendLittle<std::uint16_t>(payload, 1);
    payload.push_back(static_cast<std::byte>(page.leaf ? 0 : 1));
    payload.push_back(std::byte{});
    const std::size_t count = page.leaf ? page.entries.size() : page.separators.size();
    if (count > std::numeric_limits<std::uint16_t>::max()) {
        return std::unexpected(core::error("index_page_full", "Index page has too many entries."));
    }
    appendLittle<std::uint16_t>(payload, static_cast<std::uint16_t>(count));
    if (page.leaf) {
        for (const auto& entry : page.entries) {
            if (entry.key.empty() || entry.key.size() > 192) {
                return std::unexpected(
                    core::error("index_key_invalid", "Index key exceeds the v1 key limit."));
            }
            appendLittle<std::uint16_t>(payload, static_cast<std::uint16_t>(entry.key.size()));
            for (const char character : entry.key) {
                payload.push_back(static_cast<std::byte>(static_cast<unsigned char>(character)));
            }
            appendLittle(payload, entry.valueOffset);
        }
    } else {
        if (page.children.size() != page.separators.size() + 1 || page.children.empty()) {
            return std::unexpected(
                core::error("index_page_invalid", "Internal index page has invalid children."));
        }
        appendLittle(payload, page.children.front());
        for (std::size_t index = 0; index < page.separators.size(); ++index) {
            const auto& key = page.separators[index];
            if (key.empty() || key.size() > 192) {
                return std::unexpected(
                    core::error("index_key_invalid", "Index key exceeds the v1 key limit."));
            }
            appendLittle<std::uint16_t>(payload, static_cast<std::uint16_t>(key.size()));
            for (const char character : key) {
                payload.push_back(static_cast<std::byte>(static_cast<unsigned char>(character)));
            }
            appendLittle(payload, page.children[index + 1]);
        }
    }
    if (payload.size() > kIndexPageTargetSize && count > 1) {
        return std::unexpected(
            core::error("index_page_full", "Index page exceeds its target size."));
    }
    if (encryptionEnabled_) {
        if (!dataKey_)
            return std::unexpected(
                core::error("archive_locked",
                            "Archive is locked and cannot authenticate index pages."));
        const Bytes input = macInput("TUTORUX-INDEX-PAGE-V1", payload);
        const auto authentication = authenticateBytes(input, *dataKey_);
        payload.insert(payload.end(), authentication.begin(), authentication.end());
    }
    Uuid zeroId{};
    auto location = appendFrame(file_, RecordType::IndexPage, zeroId, 1, 0, payload);
    if (!location)
        return std::unexpected(location.error());
    return location->offset;
}

core::Result<Archive::IndexPage> Archive::readIndexPage(std::uint64_t offset) const {
    auto framed = readFrame(file_, offset, RecordType::IndexPage);
    if (!framed)
        return std::unexpected(framed.error());
    std::span<const std::byte> payload = framed->second;
    if (encryptionEnabled_) {
        if (payload.size() < 32) {
            return std::unexpected(core::error("archive_index_authentication_failed",
                                               "Encrypted index page is truncated."));
        }
        const auto body = payload.first(payload.size() - 32);
        const auto authentication = payload.last(32);
        if (dataKey_) {
            const Bytes input = macInput("TUTORUX-INDEX-PAGE-V1", body);
            if (!authenticationMatches(input, authentication, *dataKey_)) {
                return std::unexpected(core::error("archive_index_authentication_failed",
                                                   "Encrypted index page authentication failed."));
            }
        } else if (!allowUnverifiedIndexReads_) {
            return std::unexpected(
                core::error("archive_locked",
                            "Archive index is authenticated and requires its passphrase."));
        }
        payload = body;
    }
    if (payload.size() < 10 || !matches(payload, "TXPG")) {
        return std::unexpected(
            core::error("index_page_invalid", "Index page magic or length is invalid."));
    }
    std::size_t cursor = 4;
    auto version = readLittle<std::uint16_t>(payload, cursor);
    const auto kind = std::to_integer<std::uint8_t>(payload[cursor++]);
    const auto reserved = std::to_integer<std::uint8_t>(payload[cursor++]);
    auto count = readLittle<std::uint16_t>(payload, cursor);
    if (!version || *version != 1 || kind > 1 || reserved != 0 || !count) {
        return std::unexpected(core::error("index_page_invalid", "Index page fields are invalid."));
    }
    IndexPage page;
    page.leaf = kind == 0;
    if (page.leaf) {
        page.entries.reserve(*count);
        for (std::uint16_t index = 0; index < *count; ++index) {
            auto keyLength = readLittle<std::uint16_t>(payload, cursor);
            if (!keyLength || *keyLength == 0 || *keyLength > 192 || cursor > payload.size() ||
                payload.size() - cursor < *keyLength) {
                return std::unexpected(core::error("index_page_invalid", "Leaf key is invalid."));
            }
            std::string key;
            key.reserve(*keyLength);
            for (std::uint16_t character = 0; character < *keyLength; ++character)
                key.push_back(static_cast<char>(std::to_integer<unsigned char>(payload[cursor++])));
            auto value = readLittle<std::uint64_t>(payload, cursor);
            if (!value || *value < kArchiveHeaderSize) {
                return std::unexpected(
                    core::error("index_page_invalid", "Leaf record offset is invalid."));
            }
            if (!page.entries.empty() && page.entries.back().key >= key) {
                return std::unexpected(
                    core::error("index_page_order", "Leaf keys are not strictly ordered."));
            }
            page.entries.push_back({std::move(key), *value});
        }
    } else {
        auto firstChild = readLittle<std::uint64_t>(payload, cursor);
        if (!firstChild || *firstChild < kArchiveHeaderSize) {
            return std::unexpected(
                core::error("index_page_invalid", "Internal page child offset is invalid."));
        }
        page.children.push_back(*firstChild);
        for (std::uint16_t index = 0; index < *count; ++index) {
            auto keyLength = readLittle<std::uint16_t>(payload, cursor);
            if (!keyLength || *keyLength == 0 || *keyLength > 192 || cursor > payload.size() ||
                payload.size() - cursor < *keyLength) {
                return std::unexpected(
                    core::error("index_page_invalid", "Internal separator key is invalid."));
            }
            std::string key;
            key.reserve(*keyLength);
            for (std::uint16_t character = 0; character < *keyLength; ++character)
                key.push_back(static_cast<char>(std::to_integer<unsigned char>(payload[cursor++])));
            auto child = readLittle<std::uint64_t>(payload, cursor);
            if (!child || *child < kArchiveHeaderSize ||
                (!page.separators.empty() && page.separators.back() >= key)) {
                return std::unexpected(
                    core::error("index_page_invalid", "Internal separator or child is invalid."));
            }
            page.separators.push_back(std::move(key));
            page.children.push_back(*child);
        }
    }
    if (cursor != payload.size()) {
        return std::unexpected(
            core::error("index_page_trailing_data", "Index page has trailing bytes."));
    }
    return page;
}

core::Result<Archive::InsertResult>
Archive::insertIndex(std::uint64_t pageOffset, std::string_view key, std::uint64_t valueOffset) {
    auto page = readIndexPage(pageOffset);
    if (!page)
        return std::unexpected(page.error());
    if (page->leaf) {
        auto entry =
            std::lower_bound(page->entries.begin(),
                             page->entries.end(),
                             key,
                             [](const IndexPage::LeafEntry& candidate, std::string_view target) {
                                 return candidate.key < target;
                             });
        if (entry != page->entries.end() && entry->key == key)
            entry->valueOffset = valueOffset;
        else
            page->entries.insert(entry, IndexPage::LeafEntry{std::string(key), valueOffset});
        std::size_t size = 10;
        for (const auto& candidate : page->entries)
            size += 2 + candidate.key.size() + 8;
        if (size <= kIndexPageTargetSize) {
            auto left = writeIndexPage(*page);
            if (!left)
                return std::unexpected(left.error());
            return InsertResult{*left, std::nullopt};
        }
        const std::size_t middle = page->entries.size() / 2;
        IndexPage rightPage;
        rightPage.entries.assign(page->entries.begin() + static_cast<std::ptrdiff_t>(middle),
                                 page->entries.end());
        page->entries.erase(page->entries.begin() + static_cast<std::ptrdiff_t>(middle),
                            page->entries.end());
        const std::string separator = rightPage.entries.front().key;
        auto leftOffset = writeIndexPage(*page);
        if (!leftOffset)
            return std::unexpected(leftOffset.error());
        auto rightOffset = writeIndexPage(rightPage);
        if (!rightOffset)
            return std::unexpected(rightOffset.error());
        return InsertResult{
            *leftOffset,
            std::pair{separator, *rightOffset}
        };
    }
    const auto childIndex = static_cast<std::size_t>(
        std::upper_bound(page->separators.begin(), page->separators.end(), key) -
        page->separators.begin());
    if (childIndex >= page->children.size()) {
        return std::unexpected(core::error("index_invalid", "B+ tree child index is invalid."));
    }
    auto inserted = insertIndex(page->children[childIndex], key, valueOffset);
    if (!inserted)
        return std::unexpected(inserted.error());
    page->children[childIndex] = inserted->leftOffset;
    if (inserted->split) {
        page->separators.insert(page->separators.begin() + static_cast<std::ptrdiff_t>(childIndex),
                                inserted->split->first);
        page->children.insert(page->children.begin() + static_cast<std::ptrdiff_t>(childIndex + 1),
                              inserted->split->second);
    }
    std::size_t size = 10 + 8;
    for (const auto& separator : page->separators)
        size += 2 + separator.size() + 8;
    if (size <= kIndexPageTargetSize) {
        auto left = writeIndexPage(*page);
        if (!left)
            return std::unexpected(left.error());
        return InsertResult{*left, std::nullopt};
    }
    const std::size_t middle = page->separators.size() / 2;
    const std::string promoted = page->separators[middle];
    IndexPage rightPage;
    rightPage.leaf = false;
    rightPage.separators.assign(page->separators.begin() + static_cast<std::ptrdiff_t>(middle + 1),
                                page->separators.end());
    rightPage.children.assign(page->children.begin() + static_cast<std::ptrdiff_t>(middle + 1),
                              page->children.end());
    page->separators.erase(page->separators.begin() + static_cast<std::ptrdiff_t>(middle),
                           page->separators.end());
    page->children.erase(page->children.begin() + static_cast<std::ptrdiff_t>(middle + 1),
                         page->children.end());
    auto leftOffset = writeIndexPage(*page);
    if (!leftOffset)
        return std::unexpected(leftOffset.error());
    auto rightOffset = writeIndexPage(rightPage);
    if (!rightOffset)
        return std::unexpected(rightOffset.error());
    return InsertResult{
        *leftOffset,
        std::pair{promoted, *rightOffset}
    };
}

core::Result<std::uint64_t> Archive::indexRecord(std::string_view key, std::uint64_t valueOffset) {
    if (commit_.rootOffset == 0) {
        IndexPage empty;
        auto root = writeIndexPage(empty);
        if (!root)
            return std::unexpected(root.error());
        commit_.rootOffset = *root;
    }
    auto inserted = insertIndex(commit_.rootOffset, key, valueOffset);
    if (!inserted)
        return std::unexpected(inserted.error());
    if (!inserted->split)
        return inserted->leftOffset;
    IndexPage newRoot;
    newRoot.leaf = false;
    newRoot.separators.push_back(inserted->split->first);
    newRoot.children = {inserted->leftOffset, inserted->split->second};
    return writeIndexPage(newRoot);
}

core::Status Archive::put(Record record) {
    std::lock_guard lock(*mutex_);
    return putMany({std::move(record)});
}

core::Status Archive::putMany(std::vector<Record> records) {
    std::lock_guard lock(*mutex_);
    return putManyInternal(std::move(records), true);
}

core::Status Archive::putManyInternal(std::vector<Record> records, bool invalidateGuides) {
    std::lock_guard lock(*mutex_);
    if (!writable())
        return std::unexpected(core::error("archive_read_only", "Archive was opened read-only."));
    if (records.empty())
        return {};
    struct Rollback final {
        explicit Rollback(std::function<void()> callback)
            : callback(std::move(callback)) {}
        ~Rollback() {
            if (callback)
                callback();
        }
        void release() {
            callback = {};
        }
        std::function<void()> callback;
    };
    const CommitInfo previousCommit = commit_;
    Rollback rollback([this, previousCommit] {
        commit_ = previousCommit;
    });
    const Uuid transactionId = randomUuid();
    std::uint64_t newRootOffset = commit_.rootOffset;
    std::uint64_t domainRecordCount = 0;
    auto manifestResult = get(RecordType::Settings, header_.id);
    if (!manifestResult)
        return std::unexpected(manifestResult.error());
    std::optional<Record> manifest;
    if (manifestResult && *manifestResult)
        manifest = std::move(**manifestResult);
    std::uint64_t studentCount = 0;
    std::uint64_t sessionCount = 0;
    if (manifest) {
        const auto parseCount = [](const Record& record, std::string_view key) {
            const auto found = record.fields.find(key);
            std::uint64_t value = 0;
            if (found != record.fields.end())
                std::from_chars(found->second.data(),
                                found->second.data() + found->second.size(),
                                value);
            return value;
        };
        studentCount = parseCount(*manifest, "student_count");
        sessionCount = parseCount(*manifest, "session_count");
    }
    const bool hasAudioChunks =
        std::any_of(records.begin(), records.end(), [](const Record& record) {
            return record.type == RecordType::AudioChunk;
        });
    const bool hasGuideChanges =
        std::any_of(records.begin(), records.end(), [](const Record& record) {
            return record.type == RecordType::Guide;
        });
    const bool hasGuideSourceChanges =
        invalidateGuides && std::any_of(records.begin(), records.end(), [](const Record& record) {
            return isGuideSourceType(record.type);
        });
    const bool manifestHasGuideIndex =
        manifest && domain::getField(*manifest, "guide_source_index_version") == "1";
    const bool migrateGuideSourceIndex =
        (hasGuideChanges || hasGuideSourceChanges) && !manifestHasGuideIndex;
    if (migrateGuideSourceIndex) {
        if (manifest)
            manifest->fields["guide_source_index_version"] = "1";
        for (auto record = records.rbegin(); record != records.rend(); ++record) {
            if (record->type == RecordType::Settings && record->id == header_.id) {
                record->fields["guide_source_index_version"] = "1";
                break;
            }
        }
    }
    std::set<std::string, std::less<>> changedGuideSourceIds;
    if (hasAudioChunks) {
        std::set<std::string> indexedSessionIds;
        for (const Record& record : records) {
            if (record.type != RecordType::AudioChunk)
                continue;
            const auto sessionField = record.fields.find("session_id");
            if (sessionField == record.fields.end())
                continue;
            auto sessionId = uuidFromString(sessionField->second);
            if (sessionId)
                indexedSessionIds.insert(uuidToString(*sessionId));
        }
        for (Record& record : records) {
            if (record.type == RecordType::Session &&
                indexedSessionIds.contains(uuidToString(record.id))) {
                record.fields["audio_chunk_index_version"] = "1";
            }
        }
    }
    for (Record& record : records) {
        if (record.id == Uuid{})
            record.id = randomUuid();
        if (invalidateGuides && isGuideSourceType(record.type))
            changedGuideSourceIds.insert(uuidToString(record.id));
        const std::string key = indexKey(record.type, record.id);
        std::set<std::string, std::less<>> guideSourceAliases;
        auto existingOffset = findOffset(key);
        if (!existingOffset)
            return std::unexpected(existingOffset.error());
        if (*existingOffset) {
            auto existing = readRecordAt(**existingOffset);
            if (!existing)
                return std::unexpected(existing.error());
            if (record.type == RecordType::AudioChunk &&
                audioSessionIndexKey(*existing) != audioSessionIndexKey(record)) {
                return std::unexpected(core::error(
                    "audio_chunk_identity_immutable",
                    "An audio chunk's session, track, and sequence identity cannot change."));
            }
            if (record.type == RecordType::Guide) {
                guideSourceAliases = guideSourceIndexKeys(*existing);
                preserveGuideSourceHistory(record, *existing, guideSourceAliases);
            }
            record.previousOffset = **existingOffset;
            record.revision = existing->revision + 1;
            const bool wasDeleted =
                existing->fields.contains("_deleted") && existing->fields.at("_deleted") == "true";
            const bool isDeletedNow =
                record.fields.contains("_deleted") && record.fields.at("_deleted") == "true";
            if (!wasDeleted && isDeletedNow && record.type == RecordType::Student &&
                studentCount > 0)
                --studentCount;
            if (wasDeleted && !isDeletedNow && record.type == RecordType::Student)
                ++studentCount;
            if (!wasDeleted && isDeletedNow && record.type == RecordType::Session &&
                sessionCount > 0)
                --sessionCount;
            if (wasDeleted && !isDeletedNow && record.type == RecordType::Session)
                ++sessionCount;
        } else {
            record.revision = std::max<std::uint64_t>(record.revision, 1);
            if (record.type == RecordType::Session)
                record.fields.try_emplace("audio_chunk_index_version", "1");
            if (record.type == RecordType::Student &&
                (!record.fields.contains("_deleted") || record.fields.at("_deleted") != "true"))
                ++studentCount;
            if (record.type == RecordType::Session &&
                (!record.fields.contains("_deleted") || record.fields.at("_deleted") != "true"))
                ++sessionCount;
        }
        const auto audioIndexKey = audioSessionIndexKey(record);
        if (record.type == RecordType::AudioChunk && !audioIndexKey) {
            return std::unexpected(core::error(
                "audio_chunk_metadata_invalid",
                "Audio chunks require valid session, track, and sequence identifiers."));
        }
        if (audioIndexKey) {
            auto indexedOffset = findOffset(*audioIndexKey);
            if (!indexedOffset)
                return std::unexpected(indexedOffset.error());
            if (*indexedOffset) {
                auto indexedRecord = readRecordAt(**indexedOffset);
                if (!indexedRecord)
                    return std::unexpected(indexedRecord.error());
                if (indexedRecord->type != record.type || indexedRecord->id != record.id) {
                    return std::unexpected(core::error(
                        "audio_chunk_sequence_duplicate",
                        "A recording track already contains this chunk sequence number."));
                }
            }
        }
        auto location = appendRecord(record);
        if (!location)
            return std::unexpected(location.error());
        auto indexRoot = indexRecord(key, location->offset);
        if (!indexRoot)
            return std::unexpected(indexRoot.error());
        newRootOffset = *indexRoot;
        commit_.rootOffset = newRootOffset;
        ++domainRecordCount;

        if (record.type == RecordType::AssetBlob) {
            const auto hash = record.fields.find("content_hash");
            if (hash != record.fields.end()) {
                auto hashRoot = indexRecord("BLOB:" + hash->second, location->offset);
                if (!hashRoot)
                    return std::unexpected(hashRoot.error());
                newRootOffset = *hashRoot;
                commit_.rootOffset = newRootOffset;
            }
        }
        if (audioIndexKey) {
            auto audioRoot = indexRecord(*audioIndexKey, location->offset);
            if (!audioRoot)
                return std::unexpected(audioRoot.error());
            newRootOffset = *audioRoot;
            commit_.rootOffset = newRootOffset;
        }
        if (record.type == RecordType::Guide) {
            const auto currentAliases = guideSourceIndexKeys(record);
            guideSourceAliases.insert(currentAliases.begin(), currentAliases.end());
            for (const std::string& alias : guideSourceAliases) {
                auto guideRoot = indexRecord(alias, location->offset);
                if (!guideRoot)
                    return std::unexpected(guideRoot.error());
                newRootOffset = *guideRoot;
                commit_.rootOffset = newRootOffset;
            }
        }
    }

    if (migrateGuideSourceIndex) {
        std::optional<Error> migrationError;
        auto migrationStatus = forEach(
            RecordType::Guide,
            [&](Record&& guide) {
                auto latestOffset = findOffset(indexKey(RecordType::Guide, guide.id));
                if (!latestOffset) {
                    migrationError = latestOffset.error();
                    return false;
                }
                if (!*latestOffset) {
                    migrationError = core::error(
                        "guide_source_index_migration_failed",
                        "Guide disappeared while its source index was being initialized.");
                    return false;
                }
                const auto aliases = guideSourceIndexKeys(guide);
                for (const std::string& alias : aliases) {
                    auto guideRoot = indexRecord(alias, **latestOffset);
                    if (!guideRoot) {
                        migrationError = guideRoot.error();
                        return false;
                    }
                    commit_.rootOffset = *guideRoot;
                    newRootOffset = *guideRoot;
                }
                return true;
            },
            true);
        if (!migrationStatus)
            return migrationStatus;
        if (migrationError)
            return std::unexpected(std::move(*migrationError));
    }

    if (invalidateGuides && !changedGuideSourceIds.empty()) {
        std::map<Uuid, Record> staleGuides;
        std::optional<Error> staleIndexError;
        for (const std::string& sourceId : changedGuideSourceIds) {
            const std::string prefix = "GUIDESOURCE:" + sourceId + ":";
            auto status = forEachIndexPrefix(
                prefix,
                [&](Record&& indexedGuide) {
                    if (indexedGuide.type != RecordType::Guide) {
                        staleIndexError =
                            core::error("guide_source_index_invalid",
                                        "Guide source index points to a non-guide record.");
                        return false;
                    }
                    auto latestOffset = findOffset(indexKey(RecordType::Guide, indexedGuide.id));
                    if (!latestOffset) {
                        staleIndexError = latestOffset.error();
                        return false;
                    }
                    if (!*latestOffset) {
                        staleIndexError =
                            core::error("guide_source_index_invalid",
                                        "Guide source index points to a missing guide record.");
                        return false;
                    }
                    auto latestGuide = readRecordAt(**latestOffset);
                    if (!latestGuide) {
                        staleIndexError = latestGuide.error();
                        return false;
                    }
                    if (domain::isDeleted(*latestGuide))
                        return true;
                    auto [position, inserted] =
                        staleGuides.try_emplace(latestGuide->id, std::move(*latestGuide));
                    static_cast<void>(inserted);
                    markGuideBlocksStale(position->second, sourceId);
                    return true;
                },
                true);
            if (!status)
                return status;
            if (staleIndexError)
                return std::unexpected(std::move(*staleIndexError));
        }

        for (auto& [guideId, guide] : staleGuides) {
            static_cast<void>(guideId);
            auto previousOffset = findOffset(indexKey(RecordType::Guide, guide.id));
            if (!previousOffset)
                return std::unexpected(previousOffset.error());
            if (!*previousOffset)
                continue;
            auto previous = readRecordAt(**previousOffset);
            if (!previous)
                return std::unexpected(previous.error());
            if (domain::isDeleted(*previous))
                continue;
            if (guide.fields == previous->fields && guide.blob == previous->blob)
                continue;
            guide.previousOffset = **previousOffset;
            guide.revision = previous->revision + 1;
            auto location = appendRecord(guide);
            if (!location)
                return std::unexpected(location.error());
            auto guideRoot = indexRecord(indexKey(RecordType::Guide, guide.id), location->offset);
            if (!guideRoot)
                return std::unexpected(guideRoot.error());
            newRootOffset = *guideRoot;
            commit_.rootOffset = newRootOffset;
            for (const std::string& alias : guideSourceIndexKeys(guide)) {
                auto aliasRoot = indexRecord(alias, location->offset);
                if (!aliasRoot)
                    return std::unexpected(aliasRoot.error());
                newRootOffset = *aliasRoot;
                commit_.rootOffset = newRootOffset;
            }
            ++domainRecordCount;
        }
    }
    if (manifest && std::none_of(records.begin(), records.end(), [&](const Record& record) {
            return record.type == RecordType::Settings && record.id == header_.id;
        })) {
        if (hasAudioChunks)
            manifest->fields["audio_chunk_index_version"] = "1";
        manifest->fields["student_count"] = std::to_string(studentCount);
        manifest->fields["session_count"] = std::to_string(sessionCount);
        manifest->fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        auto previousManifestOffset = findOffset(indexKey(RecordType::Settings, header_.id));
        if (!previousManifestOffset)
            return std::unexpected(previousManifestOffset.error());
        if (*previousManifestOffset) {
            manifest->previousOffset = **previousManifestOffset;
            ++manifest->revision;
        }
        auto location = appendRecord(*manifest);
        if (!location)
            return std::unexpected(location.error());
        auto indexRoot = indexRecord(indexKey(RecordType::Settings, header_.id), location->offset);
        if (!indexRoot)
            return std::unexpected(indexRoot.error());
        newRootOffset = *indexRoot;
        commit_.rootOffset = newRootOffset;
        ++domainRecordCount;
    }
    commit_.rootOffset = newRootOffset;
    auto status = publishCommit(newRootOffset, transactionId, domainRecordCount);
    if (status)
        rollback.release();
    return status;
}

core::Status Archive::publishCommit(std::uint64_t rootOffset,
                                    const Uuid& transactionId,
                                    std::uint64_t recordCount) {
    auto rootPage = readFrame(file_, rootOffset, RecordType::IndexPage);
    if (!rootPage)
        return std::unexpected(rootPage.error());
    const auto rootHash = domain::sha256(rootPage->second);
    Bytes payload;
    for (char character : std::string_view("TXCM", 4))
        payload.push_back(static_cast<std::byte>(character));
    appendLittle<std::uint16_t>(payload, 1);
    appendLittle<std::uint16_t>(payload, 0);
    appendLittle(payload, commit_.generation + 1);
    appendLittle(payload, commit_.offset);
    appendLittle(payload, rootOffset);
    payload.insert(payload.end(), rootHash.begin(), rootHash.end());
    payload.insert(payload.end(), transactionId.begin(), transactionId.end());
    appendLittle(payload, recordCount);
    appendLittle<std::uint32_t>(payload, 1);
    if (encryptionEnabled_) {
        if (!dataKey_) {
            return std::unexpected(
                core::error("archive_locked",
                            "Archive is locked and cannot authenticate a commit."));
        }
        const Bytes input = macInput("TUTORUX-COMMIT-V1", payload);
        const auto authentication = authenticateBytes(input, *dataKey_);
        payload.insert(payload.end(), authentication.begin(), authentication.end());
    }
    Uuid zeroId{};
    auto location = appendFrame(file_,
                                RecordType::Commit,
                                zeroId,
                                commit_.generation + 1,
                                commit_.offset,
                                payload);
    if (!location)
        return std::unexpected(location.error());
    if (auto status = file_.flush(); !status)
        return status;
    Bytes locator;
    for (char character : std::string_view("TUXLOC1\0", 8))
        locator.push_back(static_cast<std::byte>(character));
    appendLittle(locator, location->offset);
    appendLittle(locator, commit_.generation + 1);
    appendLittle(locator, crc32(locator));
    appendLittle<std::uint32_t>(locator, 0);
    std::uint64_t locatorOffset = 0;
    if (auto status = file_.append(locator, locatorOffset); !status)
        return status;
    if (auto status = file_.flush(); !status)
        return status;
    commit_.generation += 1;
    commit_.previousOffset = commit_.offset;
    commit_.offset = location->offset;
    commit_.rootOffset = rootOffset;
    commit_.rootHash = rootHash;
    commit_.transactionId = transactionId;
    commit_.recordCount = recordCount;
    return {};
}

core::Result<std::vector<std::pair<std::string, std::uint64_t>>> Archive::allIndexEntries() const {
    std::vector<std::pair<std::string, std::uint64_t>> entries;
    if (commit_.rootOffset == 0)
        return entries;
    std::set<std::uint64_t> visited;
    std::function<Status(std::uint64_t, std::size_t)> visit = [&](std::uint64_t offset,
                                                                  std::size_t depth) -> Status {
        if (depth > 32 || !visited.insert(offset).second) {
            return std::unexpected(
                core::error("index_cycle", "B+ tree contains a cycle or excessive depth."));
        }
        auto page = readIndexPage(offset);
        if (!page)
            return std::unexpected(page.error());
        if (page->leaf) {
            for (const auto& entry : page->entries)
                entries.emplace_back(entry.key, entry.valueOffset);
        } else {
            for (std::uint64_t child : page->children) {
                if (auto status = visit(child, depth + 1); !status)
                    return status;
            }
        }
        return {};
    };
    if (auto status = visit(commit_.rootOffset, 0); !status)
        return std::unexpected(status.error());
    return entries;
}

core::Status Archive::verifyCommitAuthentication() const {
    if (!encryptionEnabled_)
        return {};
    if (!dataKey_) {
        return std::unexpected(
            core::error("archive_locked", "Unlock the archive before verifying its commit."));
    }
    auto framed = readFrame(file_, commit_.offset, RecordType::Commit);
    if (!framed)
        return std::unexpected(framed.error());
    if (framed->second.size() != 124) {
        return std::unexpected(core::error("archive_commit_authentication_failed",
                                           "Encrypted archive commit has no MAC."));
    }
    const auto body = std::span<const std::byte>(framed->second).first(92);
    const auto authentication = std::span<const std::byte>(framed->second).last(32);
    const Bytes input = macInput("TUTORUX-COMMIT-V1", body);
    if (!authenticationMatches(input, authentication, *dataKey_)) {
        return std::unexpected(core::error("archive_commit_authentication_failed",
                                           "Archive commit authentication failed."));
    }
    return {};
}

core::Status Archive::verifyIndexAuthentication() const {
    if (!encryptionEnabled_)
        return {};
    if (!dataKey_) {
        return std::unexpected(
            core::error("archive_locked", "Unlock the archive before verifying its index."));
    }
    if (auto status = verifyCommitAuthentication(); !status)
        return status;
    auto root = readIndexPage(commit_.rootOffset);
    if (!root)
        return std::unexpected(root.error());
    auto manifest = get(RecordType::Settings, header_.id);
    if (!manifest)
        return std::unexpected(manifest.error());
    if (!*manifest || domain::isDeleted(**manifest)) {
        return std::unexpected(
            core::error("archive_manifest_missing", "Encrypted archive manifest is missing."));
    }
    return {};
}

core::Result<VerificationReport> Archive::verify(bool full) const {
    std::lock_guard lock(*mutex_);
    if (locked()) {
        return std::unexpected(
            core::error("archive_locked", "Unlock the archive before verifying its contents."));
    }
    VerificationReport report;
    report.generation = commit_.generation;
    if (auto status = verifyIndexAuthentication(); !status) {
        report.issues.push_back(status.error().message);
        report.valid = false;
        return report;
    }
    auto manifest = get(RecordType::Settings, header_.id);
    if (!manifest) {
        report.issues.push_back(manifest.error().message);
        return report;
    }
    const bool guideSourceIndexEnabled =
        *manifest && !domain::isDeleted(**manifest) &&
        domain::getField(**manifest, "guide_source_index_version") == "1";
    auto root = readIndexPage(commit_.rootOffset);
    if (!root) {
        report.issues.push_back(root.error().message);
        return report;
    }
    auto rootFrame = readFrame(file_, commit_.rootOffset, RecordType::IndexPage);
    if (!rootFrame || domain::sha256(rootFrame->second) != commit_.rootHash) {
        report.issues.push_back("Latest commit root hash does not match its index page.");
        return report;
    }
    auto entries = allIndexEntries();
    if (!entries) {
        report.issues.push_back(entries.error().message);
        return report;
    }
    if (full) {
        std::set<std::uint64_t> pageOffsets;
        std::function<Status(std::uint64_t, std::size_t)> checkPage =
            [&](std::uint64_t offset, std::size_t depth) -> Status {
            if (depth > 32 || !pageOffsets.insert(offset).second) {
                return std::unexpected(
                    core::error("index_cycle", "B+ tree contains a cycle or excessive depth."));
            }
            auto page = readIndexPage(offset);
            if (!page)
                return std::unexpected(page.error());
            if (!page->leaf) {
                for (const auto child : page->children) {
                    if (auto status = checkPage(child, depth + 1); !status)
                        return status;
                }
            }
            return {};
        };
        if (auto status = checkPage(commit_.rootOffset, 0); !status)
            report.issues.push_back(status.error().message);
        report.indexPagesChecked = pageOffsets.size();

        std::set<std::uint64_t> checkedRecordOffsets;
        std::vector<Record> currentRecords;
        for (const auto& [key, latestOffset] : *entries) {
            auto latest = readRecordAt(latestOffset);
            if (!latest) {
                report.issues.push_back("Index key '" + key + "': " + latest.error().message);
                continue;
            }
            if (key == indexKey(latest->type, latest->id)) {
                currentRecords.push_back(*latest);
                if (latest->type == RecordType::AudioChunk) {
                    auto sessionId = uuidFromString(domain::getField(*latest, "session_id"));
                    auto session = sessionId
                                       ? get(RecordType::Session, *sessionId)
                                       : Result<std::optional<Record>>(std::optional<Record>{});
                    const bool audioIndexEnabled =
                        session && *session &&
                        domain::getField(**session, "audio_chunk_index_version") == "1";
                    if (!session)
                        report.issues.push_back("Audio chunk session could not be read.");
                    if (audioIndexEnabled) {
                        const auto expectedKey = audioSessionIndexKey(*latest);
                        auto indexedOffset = expectedKey ? findOffset(*expectedKey)
                                                         : Result<std::optional<std::uint64_t>>(
                                                               std::optional<std::uint64_t>{});
                        if (!expectedKey || !indexedOffset || !*indexedOffset ||
                            **indexedOffset != latestOffset) {
                            report.issues.push_back("Audio chunk " + uuidToString(latest->id) +
                                                    " is missing its session sequence index.");
                        }
                    }
                }
                if (latest->type == RecordType::Guide && guideSourceIndexEnabled) {
                    for (const std::string& expectedKey : guideSourceIndexKeys(*latest)) {
                        auto indexedOffset = findOffset(expectedKey);
                        if (!indexedOffset || !*indexedOffset || **indexedOffset != latestOffset) {
                            report.issues.push_back("Guide " + uuidToString(latest->id) +
                                                    " is missing its source reference index.");
                        }
                    }
                }
            } else if (key.starts_with("AUDIOSESSION:")) {
                const auto expectedKey = audioSessionIndexKey(*latest);
                auto primaryOffset = findOffset(indexKey(latest->type, latest->id));
                if (latest->type != RecordType::AudioChunk || !expectedKey || *expectedKey != key ||
                    !primaryOffset || !*primaryOffset || **primaryOffset != latestOffset) {
                    report.issues.push_back("Audio session index key does not match its record.");
                }
            } else if (key.starts_with("GUIDESOURCE:")) {
                constexpr std::string_view prefix = "GUIDESOURCE:";
                const auto sourceSeparator = key.find(':', prefix.size());
                const bool sourceIdValid =
                    sourceSeparator != std::string::npos &&
                    static_cast<bool>(uuidFromString(
                        std::string_view(key).substr(prefix.size(),
                                                     sourceSeparator - prefix.size())));
                const bool guideIdMatches =
                    sourceSeparator != std::string::npos &&
                    key.substr(sourceSeparator + 1) == uuidToString(latest->id);
                auto primaryOffset = findOffset(indexKey(RecordType::Guide, latest->id));
                const auto expectedAliases = guideSourceIndexKeys(*latest);
                if (latest->type != RecordType::Guide || !sourceIdValid || !guideIdMatches ||
                    !expectedAliases.contains(key) || !primaryOffset || !*primaryOffset ||
                    **primaryOffset != latestOffset) {
                    report.issues.push_back(
                        "Guide source index does not reference the current guide revision.");
                }
            }
            std::uint64_t offset = latestOffset;
            Record current = std::move(*latest);
            while (offset != 0 && checkedRecordOffsets.insert(offset).second) {
                ++report.recordsChecked;
                const auto previousOffset = current.previousOffset;
                if (previousOffset == 0)
                    break;
                if (previousOffset >= offset) {
                    report.issues.push_back(
                        "Record revision points forward or to itself at offset " +
                        std::to_string(offset) + ".");
                    break;
                }
                auto previous = readRecordAt(previousOffset);
                if (!previous) {
                    report.issues.push_back("Revision at offset " + std::to_string(previousOffset) +
                                            " is invalid: " + previous.error().message);
                    break;
                }
                if (previous->type != current.type || previous->id != current.id ||
                    previous->revision >= current.revision) {
                    report.issues.push_back("Revision lineage is inconsistent for " +
                                            uuidToString(current.id) + ".");
                    break;
                }
                offset = previousOffset;
                current = std::move(*previous);
            }
        }

        const auto checkSessionReference = [&](const Record& record) {
            const auto sessionId = record.fields.find("session_id");
            if (sessionId == record.fields.end() || sessionId->second.empty())
                return;
            auto parsedId = uuidFromString(sessionId->second);
            if (!parsedId) {
                report.issues.push_back("Invalid session reference in " + uuidToString(record.id) +
                                        ".");
                return;
            }
            auto session = get(RecordType::Session, *parsedId);
            if (!session || !*session || domain::isDeleted(**session))
                report.issues.push_back("Missing session reference " + sessionId->second + ".");
        };
        for (const auto& record : currentRecords) {
            if (domain::isDeleted(record))
                continue;
            if (record.type == RecordType::Session) {
                const auto studentId = record.fields.find("student_id");
                if (studentId != record.fields.end() && !studentId->second.empty() &&
                    studentId->second != "anonymous") {
                    auto parsedId = uuidFromString(studentId->second);
                    auto student = parsedId
                                       ? get(RecordType::Student, *parsedId)
                                       : Result<std::optional<Record>>(std::unexpected(
                                             core::error("id_invalid", "Invalid student ID.")));
                    if (!student || !*student || domain::isDeleted(**student))
                        report.issues.push_back("Session " + uuidToString(record.id) +
                                                " references a missing student.");
                }
            } else if (record.type == RecordType::Annotation ||
                       record.type == RecordType::TranscriptSegment ||
                       record.type == RecordType::AudioChunk ||
                       record.type == RecordType::AssetMetadata ||
                       record.type == RecordType::EvidenceNode ||
                       record.type == RecordType::Guide) {
                checkSessionReference(record);
            }
            if (record.type == RecordType::AssetMetadata) {
                auto blobId = uuidFromString(domain::getField(record, "blob_id"));
                auto blob = blobId ? get(RecordType::AssetBlob, *blobId)
                                   : Result<std::optional<Record>>(std::unexpected(
                                         core::error("id_invalid", "Invalid asset blob ID.")));
                if (!blob || !*blob || domain::isDeleted(**blob)) {
                    report.issues.push_back("Asset " + uuidToString(record.id) +
                                            " references a missing blob.");
                } else {
                    domain::Sha256Builder contentHash;
                    std::uint64_t byteCount = 0;
                    bool contentAvailable = true;
                    const std::string role = domain::getField(**blob, "record_role");
                    if (role != "asset-blob-manifest") {
                        contentHash.update((*blob)->blob);
                        byteCount = static_cast<std::uint64_t>((*blob)->blob.size());
                    } else {
                        const std::string chunkIds = domain::getField(**blob, "chunk_ids");
                        std::uint64_t expectedChunkCount = 0;
                        const std::string chunkCount = domain::getField(**blob, "chunk_count");
                        const auto [countEnd, countError] =
                            std::from_chars(chunkCount.data(),
                                            chunkCount.data() + chunkCount.size(),
                                            expectedChunkCount);
                        if (countError != std::errc{} ||
                            countEnd != chunkCount.data() + chunkCount.size()) {
                            contentAvailable = false;
                        } else {
                            std::size_t start = 0;
                            std::uint64_t chunkIndex = 0;
                            while (start < chunkIds.size()) {
                                const std::size_t end = chunkIds.find(',', start);
                                const std::size_t itemEnd =
                                    end == std::string::npos ? chunkIds.size() : end;
                                auto chunkId = uuidFromString(
                                    std::string_view(chunkIds.data() + start, itemEnd - start));
                                auto chunk = chunkId
                                                 ? get(RecordType::AssetBlob, *chunkId)
                                                 : Result<std::optional<Record>>(std::unexpected(
                                                       core::error("id_invalid",
                                                                   "Invalid asset chunk ID.")));
                                if (!chunk || !*chunk || domain::isDeleted(**chunk) ||
                                    domain::getField(**chunk, "record_role") !=
                                        "asset-blob-chunk" ||
                                    domain::getField(**chunk, "manifest_id") !=
                                        uuidToString((*blob)->id) ||
                                    domain::getField(**chunk, "chunk_index") !=
                                        std::to_string(chunkIndex) ||
                                    (*chunk)->blob.size() >
                                        std::numeric_limits<std::uint64_t>::max() - byteCount) {
                                    contentAvailable = false;
                                    break;
                                }
                                contentHash.update((*chunk)->blob);
                                byteCount += static_cast<std::uint64_t>((*chunk)->blob.size());
                                ++chunkIndex;
                                if (end == std::string::npos)
                                    break;
                                start = end + 1;
                            }
                            if (chunkIndex != expectedChunkCount)
                                contentAvailable = false;
                        }
                    }
                    const std::string expectedBytes = domain::getField(record, "byte_size");
                    std::uint64_t expectedByteCount = 0;
                    const auto [sizeEnd, sizeError] =
                        std::from_chars(expectedBytes.data(),
                                        expectedBytes.data() + expectedBytes.size(),
                                        expectedByteCount);
                    if (sizeError != std::errc{} ||
                        sizeEnd != expectedBytes.data() + expectedBytes.size() ||
                        byteCount != expectedByteCount || !contentAvailable ||
                        domain::hexHash(contentHash.finish()) !=
                            domain::getField(record, "content_hash")) {
                        report.issues.push_back("Asset " + uuidToString(record.id) +
                                                " content is missing or does not match its hash.");
                    }
                }
            }
            if (record.type == RecordType::Guide) {
                auto guide = domain::guideFromRecord(record);
                if (!guide)
                    report.issues.push_back(guide.error().message);
                else if (auto status = domain::validateGuide(*guide, *this, false); !status)
                    report.issues.push_back(status.error().message);
            }
            if (record.type == RecordType::EvidenceEdge) {
                for (const auto field : {"from_id", "to_id"}) {
                    auto id = uuidFromString(domain::getField(record, field));
                    auto node = id ? get(RecordType::EvidenceNode, *id)
                                   : Result<std::optional<Record>>(std::unexpected(
                                         core::error("id_invalid", "Invalid evidence ID.")));
                    if (!node || !*node || domain::isDeleted(**node))
                        report.issues.push_back("Evidence edge references a missing node.");
                }
            }
        }
    } else {
        report.indexPagesChecked = 1;
    }
    report.valid = report.issues.empty();
    return report;
}

core::Status Archive::backup(const std::filesystem::path& destination) const {
    std::lock_guard lock(*mutex_);
    if (std::filesystem::absolute(path()) == std::filesystem::absolute(destination)) {
        return std::unexpected(
            core::error("backup_same_path", "Backup destination must differ from the archive."));
    }
    std::error_code errorCode;
    if (!std::filesystem::copy_file(path(),
                                    destination,
                                    std::filesystem::copy_options::none,
                                    errorCode)) {
        return std::unexpected(core::error("backup_failed", errorCode.message()));
    }
    return {};
}

core::Status Archive::repairCopy(const std::filesystem::path& source,
                                 const std::filesystem::path& destination,
                                 std::string_view passphrase) {
    std::error_code pathError;
    const auto absoluteSource = std::filesystem::weakly_canonical(source, pathError);
    if (pathError) {
        return std::unexpected(
            core::error("archive_path_invalid", "Unable to resolve the source archive path."));
    }
    const auto absoluteDestination = std::filesystem::weakly_canonical(destination, pathError);
    if (pathError) {
        return std::unexpected(
            core::error("archive_path_invalid", "Unable to resolve the repair destination path."));
    }
    if (absoluteSource == absoluteDestination) {
        return std::unexpected(core::error("archive_repair_same_path",
                                           "Repair output must be a separate archive copy."));
    }
    if (std::filesystem::exists(destination, pathError)) {
        return std::unexpected(
            core::error("archive_repair_destination_exists", "Repair output already exists."));
    }
    if (pathError) {
        return std::unexpected(
            core::error("archive_path_invalid", "Unable to inspect the repair destination path."));
    }

    const auto parent =
        destination.has_parent_path() ? destination.parent_path() : std::filesystem::current_path();
    if (!std::filesystem::is_directory(parent, pathError) || pathError) {
        return std::unexpected(core::error("archive_repair_directory_invalid",
                                           "Repair destination directory is unavailable."));
    }
    const auto temporaryPath =
        parent / (destination.filename().string() + "." + uuidToString(randomUuid()) + ".partial");
    struct TemporaryArchive final {
        std::filesystem::path path;
        ~TemporaryArchive() {
            std::error_code ignored;
            std::filesystem::remove(path, ignored);
        }
    } temporary{temporaryPath};

    {
        auto original = Archive::open(source, false, passphrase);
        if (!original)
            return std::unexpected(original.error());
        auto report = original->verify(true);
        if (!report)
            return std::unexpected(report.error());
        if (!report->valid) {
            return std::unexpected(
                core::error("archive_repair_source_invalid",
                            "The newest consistent generation contains damaged reachable records; "
                            "preserving the original without producing a misleading repair copy."));
        }
        if (auto status = original->backup(temporaryPath); !status)
            return status;
    }

    {
        auto repaired = Archive::open(temporaryPath, true, passphrase);
        if (!repaired)
            return std::unexpected(repaired.error());
        if (auto status = repaired->compact(); !status)
            return status;
        auto report = repaired->verify(true);
        if (!report)
            return std::unexpected(report.error());
        if (!report->valid) {
            return std::unexpected(
                core::error("archive_repair_validation_failed",
                            "The repaired copy did not pass full integrity validation."));
        }
    }

#ifdef _WIN32
    if (!MoveFileExW(temporaryPath.c_str(), destination.c_str(), MOVEFILE_WRITE_THROUGH)) {
        const auto nativeError = GetLastError();
        return std::unexpected(
            core::error("archive_repair_publish_failed",
                        "Unable to publish the repaired archive copy (Windows error " +
                            std::to_string(nativeError) + ")."));
    }
#else
    if (::link(temporaryPath.c_str(), destination.c_str()) != 0) {
        return std::unexpected(core::error(
            "archive_repair_publish_failed",
            "Unable to publish the repaired archive copy without replacing another file: " +
                std::string(std::strerror(errno))));
    }
    const auto destinationParent = parent.empty() ? std::filesystem::path(".") : parent;
    const int directoryHandle = ::open(destinationParent.c_str(), O_RDONLY);
    if (directoryHandle >= 0) {
        ::fsync(directoryHandle);
        ::close(directoryHandle);
    }
#endif
    return {};
}

core::Status Archive::compact() {
    std::lock_guard lock(*mutex_);
    return rewrite(encryptionEnabled_, encryptionEnvelope_, dataKey_ ? &*dataKey_ : nullptr);
}

core::Status
Archive::rewrite(bool encrypted, std::optional<EncryptionEnvelope> envelope, const SecretKey* key) {
    if (!writable())
        return std::unexpected(
            core::error("archive_read_only", "Archive must be opened for writing to compact."));
    if (encrypted && (!envelope || !key || !*key)) {
        return std::unexpected(core::error("archive_encryption_state_invalid",
                                           "Encrypted rewrite has no active key envelope."));
    }
    if (!encrypted && (envelope || key)) {
        return std::unexpected(core::error("archive_encryption_state_invalid",
                                           "Plaintext rewrite received encryption state."));
    }
    std::optional<SecretKey> replacementKey;
    if (encrypted) {
        auto copiedKey = SecretKey::copyOf(key->bytes());
        if (!copiedKey)
            return std::unexpected(copiedKey.error());
        replacementKey.emplace(std::move(*copiedKey));
    }
    const auto archivePath = path();
    ArchiveHeader replacementHeader = header_;
    if (encrypted)
        replacementHeader.capabilities |= kArchiveCapabilityEncrypted;
    else
        replacementHeader.capabilities &= ~kArchiveCapabilityEncrypted;
    const auto temporaryPath =
        archivePath.parent_path() /
        (archivePath.filename().string() + "." + uuidToString(randomUuid()) + ".partial");
    std::error_code cleanupError;
    auto temporaryFile = ArchiveFile::open(temporaryPath, true, true);
    if (!temporaryFile)
        return std::unexpected(temporaryFile.error());
    auto encodedHeader = encodeArchiveHeader(replacementHeader);
    if (!encodedHeader)
        return std::unexpected(encodedHeader.error());
    if (auto status = temporaryFile->write(0, *encodedHeader); !status) {
        std::filesystem::remove(temporaryPath, cleanupError);
        return status;
    }
    if (auto status = temporaryFile->flush(); !status) {
        std::filesystem::remove(temporaryPath, cleanupError);
        return status;
    }
    Archive compacted(std::move(*temporaryFile), replacementHeader, CommitInfo{});
    compacted.encryptionEnabled_ = encrypted;
    compacted.encryptionEnvelope_ = envelope;
    if (encrypted) {
        auto copiedKey = SecretKey::copyOf(replacementKey->bytes());
        if (!copiedKey) {
            compacted.file_ = ArchiveFile{};
            std::filesystem::remove(temporaryPath, cleanupError);
            return std::unexpected(copiedKey.error());
        }
        compacted.dataKey_.emplace(std::move(*copiedKey));
    }
    IndexPage emptyRoot;
    auto rootOffset = compacted.writeIndexPage(emptyRoot);
    if (!rootOffset) {
        std::filesystem::remove(temporaryPath, cleanupError);
        return std::unexpected(rootOffset.error());
    }
    compacted.commit_.rootOffset = *rootOffset;

    if (encrypted) {
        if (auto status = compacted.writeEncryptionMetadata(*envelope); !status) {
            compacted.file_ = ArchiveFile{};
            std::filesystem::remove(temporaryPath, cleanupError);
            return status;
        }
    }

    auto entries = allIndexEntries();
    if (!entries) {
        compacted.file_ = ArchiveFile{};
        std::filesystem::remove(temporaryPath, cleanupError);
        return std::unexpected(entries.error());
    }
    std::set<std::string> retainedAssetBlobIds;
    std::vector<Uuid> pendingAssetBlobIds;
    for (const auto& [key, latestOffset] : *entries) {
        auto latest = readRecordAt(latestOffset);
        if (!latest) {
            compacted.file_ = ArchiveFile{};
            std::filesystem::remove(temporaryPath, cleanupError);
            return std::unexpected(latest.error());
        }
        if (key != indexKey(latest->type, latest->id) || latest->type != RecordType::AssetMetadata)
            continue;
        Record current = std::move(*latest);
        while (true) {
            auto blobId = uuidFromString(domain::getField(current, "blob_id"));
            if (!blobId) {
                compacted.file_ = ArchiveFile{};
                std::filesystem::remove(temporaryPath, cleanupError);
                return std::unexpected(
                    core::error("compaction_asset_reference_invalid",
                                "Asset metadata contains an invalid content reference."));
            }
            pendingAssetBlobIds.push_back(*blobId);
            if (current.previousOffset == 0)
                break;
            auto previous = readRecordAt(current.previousOffset);
            if (!previous || previous->type != RecordType::AssetMetadata ||
                previous->id != current.id || previous->revision >= current.revision) {
                compacted.file_ = ArchiveFile{};
                std::filesystem::remove(temporaryPath, cleanupError);
                return std::unexpected(
                    previous ? core::error("compaction_revision_invalid",
                                           "Asset metadata revision lineage is invalid.")
                             : previous.error());
            }
            current = std::move(*previous);
        }
    }
    for (std::size_t index = 0; index < pendingAssetBlobIds.size(); ++index) {
        const Uuid blobId = pendingAssetBlobIds[index];
        const std::string blobKey = uuidToString(blobId);
        if (!retainedAssetBlobIds.insert(blobKey).second)
            continue;
        auto latest = get(RecordType::AssetBlob, blobId);
        if (!latest || !*latest || domain::isDeleted(**latest)) {
            compacted.file_ = ArchiveFile{};
            std::filesystem::remove(temporaryPath, cleanupError);
            return std::unexpected(
                core::error("compaction_asset_blob_missing",
                            "Asset metadata references content that cannot be retained."));
        }
        Record current = std::move(**latest);
        while (true) {
            if (domain::getField(current, "record_role") == "asset-blob-manifest") {
                const std::string chunkIds = domain::getField(current, "chunk_ids");
                std::size_t start = 0;
                while (start < chunkIds.size()) {
                    const std::size_t end = chunkIds.find(',', start);
                    const std::size_t itemEnd = end == std::string::npos ? chunkIds.size() : end;
                    auto chunkId =
                        uuidFromString(std::string_view(chunkIds.data() + start, itemEnd - start));
                    if (!chunkId) {
                        compacted.file_ = ArchiveFile{};
                        std::filesystem::remove(temporaryPath, cleanupError);
                        return std::unexpected(
                            core::error("compaction_asset_manifest_invalid",
                                        "Asset manifest contains an invalid chunk reference."));
                    }
                    pendingAssetBlobIds.push_back(*chunkId);
                    if (end == std::string::npos)
                        break;
                    start = end + 1;
                }
            }
            if (current.previousOffset == 0)
                break;
            auto previous = readRecordAt(current.previousOffset);
            if (!previous || previous->type != RecordType::AssetBlob ||
                previous->id != current.id || previous->revision >= current.revision) {
                compacted.file_ = ArchiveFile{};
                std::filesystem::remove(temporaryPath, cleanupError);
                return std::unexpected(previous
                                           ? core::error("compaction_revision_invalid",
                                                         "Asset blob revision lineage is invalid.")
                                           : previous.error());
            }
            current = std::move(*previous);
        }
    }
    std::vector<Record> liveAndHistoricalRecords;
    std::set<std::uint64_t> visitedRecords;
    for (const auto& [key, latestOffset] : *entries) {
        auto latest = readRecordAt(latestOffset);
        if (!latest) {
            compacted.file_ = ArchiveFile{};
            std::filesystem::remove(temporaryPath, cleanupError);
            return std::unexpected(latest.error());
        }
        if (key != indexKey(latest->type, latest->id))
            continue;
        if (latest->type == RecordType::AssetBlob &&
            !retainedAssetBlobIds.contains(uuidToString(latest->id)))
            continue;
        if (latest->type == RecordType::Encryption)
            continue;
        std::vector<Record> revisions;
        Record current = std::move(*latest);
        std::uint64_t currentOffset = latestOffset;
        while (true) {
            if (!visitedRecords.insert(currentOffset).second) {
                compacted.file_ = ArchiveFile{};
                std::filesystem::remove(temporaryPath, cleanupError);
                return std::unexpected(
                    core::error("revision_cycle", "Record revision chain contains a cycle."));
            }
            revisions.push_back(std::move(current));
            const auto previousOffset = revisions.back().previousOffset;
            if (previousOffset == 0)
                break;
            auto previous = readRecordAt(previousOffset);
            if (!previous) {
                compacted.file_ = ArchiveFile{};
                std::filesystem::remove(temporaryPath, cleanupError);
                return std::unexpected(previous.error());
            }
            if (previous->type != revisions.back().type || previous->id != revisions.back().id ||
                previous->revision >= revisions.back().revision) {
                compacted.file_ = ArchiveFile{};
                std::filesystem::remove(temporaryPath, cleanupError);
                return std::unexpected(core::error("revision_lineage_invalid",
                                                   "Record revision lineage is inconsistent."));
            }
            currentOffset = previousOffset;
            current = std::move(*previous);
        }
        std::reverse(revisions.begin(), revisions.end());
        for (auto& revision : revisions) {
            revision.previousOffset = 0;
            liveAndHistoricalRecords.push_back(std::move(revision));
        }
    }
    if (auto status = compacted.putManyInternal(std::move(liveAndHistoricalRecords), false);
        !status) {
        compacted.file_ = ArchiveFile{};
        std::filesystem::remove(temporaryPath, cleanupError);
        return status;
    }
    auto verification = compacted.verify(true);
    if (!verification || !verification->valid) {
        compacted.file_ = ArchiveFile{};
        std::filesystem::remove(temporaryPath, cleanupError);
        return std::unexpected(core::error("compaction_verification_failed",
                                           verification ? joinStrings(verification->issues, "; ")
                                                        : verification.error().message));
    }
    if (auto status = compacted.file_.flush(); !status) {
        compacted.file_ = ArchiveFile{};
        std::filesystem::remove(temporaryPath, cleanupError);
        return status;
    }
    const CommitInfo compactedCommit = compacted.commit_;
    compacted.file_ = ArchiveFile{};
    file_ = ArchiveFile{};
#ifdef _WIN32
    if (!MoveFileExW(temporaryPath.c_str(),
                     archivePath.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        const auto nativeError = GetLastError();
        std::filesystem::remove(temporaryPath, cleanupError);
        auto restored = ArchiveFile::open(archivePath, true);
        if (restored)
            file_ = std::move(*restored);
        return std::unexpected(core::error("compaction_publish_failed",
                                           "Atomic archive replacement failed (Windows error " +
                                               std::to_string(nativeError) + ")."));
    }
#else
    std::error_code renameError;
    std::filesystem::rename(temporaryPath, archivePath, renameError);
    if (renameError) {
        std::filesystem::remove(temporaryPath, cleanupError);
        auto restored = ArchiveFile::open(archivePath, true);
        if (restored)
            file_ = std::move(*restored);
        return std::unexpected(core::error("compaction_publish_failed", renameError.message()));
    }
    const auto directory =
        archivePath.parent_path().empty() ? std::filesystem::path(".") : archivePath.parent_path();
    const int directoryHandle = ::open(directory.c_str(), O_RDONLY);
    if (directoryHandle >= 0) {
        ::fsync(directoryHandle);
        ::close(directoryHandle);
    }
#endif
    auto replacement = ArchiveFile::open(archivePath, true);
    if (!replacement)
        return std::unexpected(replacement.error());
    file_ = std::move(*replacement);
    header_ = replacementHeader;
    commit_ = compactedCommit;
    encryptionEnabled_ = encrypted;
    encryptionEnvelope_ = envelope;
    dataKey_.reset();
    if (replacementKey)
        dataKey_.emplace(std::move(*replacementKey));
    return {};
}

} // namespace tutorux::archive
