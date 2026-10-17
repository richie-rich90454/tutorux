#include "tutorux/archive/format.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <limits>
#include <random>

namespace tutorux::archive {
    namespace {

        template <typename Integer> void writeLittle(Bytes& bytes, Integer value) {
            using Unsigned = std::make_unsigned_t<Integer>;
            const auto bits = static_cast<Unsigned>(value);
            for (std::size_t index = 0; index < sizeof(Integer); ++index) {
                bytes.push_back(static_cast<std::byte>((bits >> (index * 8U)) & 0xffU));
            }
        }

        template <typename Integer>
        core::Result<Integer> readLittle(std::span<const std::byte> bytes, std::size_t& cursor) {
            if (cursor > bytes.size() || bytes.size() - cursor < sizeof(Integer)) {
                return std::unexpected(
                    core::error("archive_truncated", "Archive field is truncated."));
            }
            using Unsigned = std::make_unsigned_t<Integer>;
            std::uint64_t bits = 0;
            for (std::size_t index = 0; index < sizeof(Integer); ++index) {
                bits |=
                    static_cast<std::uint64_t>(std::to_integer<unsigned int>(bytes[cursor + index]))
                    << (index * 8U);
            }
            cursor += sizeof(Integer);
            return static_cast<Integer>(static_cast<Unsigned>(bits));
        }

        bool hasMagic(std::span<const std::byte> bytes, std::string_view magic) {
            if (bytes.size() < magic.size())
                return false;
            for (std::size_t index = 0; index < magic.size(); ++index) {
                if (bytes[index] != static_cast<std::byte>(magic[index]))
                    return false;
            }
            return true;
        }

        std::string normalizeName(std::string_view value) {
            std::string normalized;
            normalized.reserve(value.size());
            for (const char character : value) {
                const auto byte = static_cast<unsigned char>(character);
                normalized.push_back(
                    byte >= 'A' && byte <= 'Z' ? static_cast<char>(byte - 'A' + 'a') : character);
            }
            return normalized;
        }

    } // namespace

    std::uint32_t crc32(std::span<const std::byte> data) {
        std::uint32_t crc = 0xffffffffU;
        for (const std::byte byte : data) {
            crc ^= std::to_integer<std::uint32_t>(byte);
            for (unsigned int bit = 0; bit < 8; ++bit) {
                const std::uint32_t mask = 0U - (crc & 1U);
                crc = (crc >> 1U) ^ (0xedb88320U & mask);
            }
        }
        return ~crc;
    }

    core::Result<Bytes> encodeArchiveHeader(const ArchiveHeader& header) {
        Bytes bytes;
        bytes.reserve(kArchiveHeaderSize);
        for (char character : std::string_view("TUTORUX\0", 8))
            bytes.push_back(static_cast<std::byte>(character));
        writeLittle(bytes, header.majorVersion);
        writeLittle(bytes, header.minorVersion);
        writeLittle<std::uint32_t>(bytes, static_cast<std::uint32_t>(kArchiveHeaderSize));
        bytes.insert(bytes.end(), header.id.begin(), header.id.end());
        writeLittle(bytes, header.createdAtUs);
        writeLittle(bytes, header.capabilities);
        bytes.insert(bytes.end(), 12, std::byte{});
        writeLittle(bytes, crc32(bytes));
        if (bytes.size() != kArchiveHeaderSize) {
            return std::unexpected(
                core::error("archive_format_internal", "Invalid archive header size."));
        }
        return bytes;
    }

    core::Result<ArchiveHeader> decodeArchiveHeader(std::span<const std::byte> bytes) {
        if (bytes.size() < kArchiveHeaderSize ||
            !hasMagic(bytes, std::string_view("TUTORUX\0", 8))) {
            return std::unexpected(
                core::error("archive_magic_invalid", "File is not a Tutorux archive."));
        }
        if (crc32(bytes.first(60)) != [&] {
                std::size_t cursor = 60;
                auto checksum = readLittle<std::uint32_t>(bytes, cursor);
                return checksum ? *checksum : 0U;
            }()) {
            return std::unexpected(
                core::error("archive_header_checksum", "Archive header checksum is invalid."));
        }
        std::size_t cursor = 8;
        ArchiveHeader header;
        auto major = readLittle<std::uint16_t>(bytes, cursor);
        auto minor = readLittle<std::uint16_t>(bytes, cursor);
        auto length = readLittle<std::uint32_t>(bytes, cursor);
        if (!major || !minor || !length || *length != kArchiveHeaderSize) {
            return std::unexpected(
                core::error("archive_header_invalid", "Archive header fields are invalid."));
        }
        header.majorVersion = *major;
        header.minorVersion = *minor;
        if (header.majorVersion > 1) {
            return std::unexpected(core::error("archive_version_unsupported",
                                               "This archive uses a newer major format version."));
        }
        if (header.majorVersion != 1) {
            return std::unexpected(
                core::error("archive_version_unsupported", "Unsupported archive version."));
        }
        std::copy_n(bytes.begin() + static_cast<std::ptrdiff_t>(cursor), 16, header.id.begin());
        cursor += 16;
        auto createdAt = readLittle<std::uint64_t>(bytes, cursor);
        auto capabilities = readLittle<std::uint64_t>(bytes, cursor);
        if (!createdAt || !capabilities) {
            return std::unexpected(
                core::error("archive_header_invalid", "Archive header fields are invalid."));
        }
        header.createdAtUs = *createdAt;
        header.capabilities = *capabilities;
        if (std::any_of(bytes.begin() + 48, bytes.begin() + 60,
                        [](std::byte value) { return value != std::byte{}; })) {
            return std::unexpected(core::error("archive_header_reserved",
                                               "Reserved archive header bytes must be zero."));
        }
        return header;
    }

    core::Result<Bytes> encodeRecordPayload(const Record& record) {
        if (record.fields.size() > std::numeric_limits<std::uint16_t>::max()) {
            return std::unexpected(
                core::error("record_field_limit", "Record contains too many fields."));
        }
        Bytes bytes;
        bytes.reserve(16 + record.blob.size());
        for (char character : std::string_view("TXMD", 4))
            bytes.push_back(static_cast<std::byte>(character));
        writeLittle<std::uint16_t>(bytes, 1);
        writeLittle<std::uint16_t>(bytes, static_cast<std::uint16_t>(record.fields.size()));
        writeLittle<std::uint64_t>(bytes, static_cast<std::uint64_t>(record.blob.size()));
        for (const auto& [key, value] : record.fields) {
            if (key.empty() || key.size() > std::numeric_limits<std::uint16_t>::max() ||
                value.size() > std::numeric_limits<std::uint32_t>::max()) {
                return std::unexpected(
                    core::error("record_field_limit", "Record field exceeds format limits."));
            }
            writeLittle<std::uint16_t>(bytes, static_cast<std::uint16_t>(key.size()));
            writeLittle<std::uint32_t>(bytes, static_cast<std::uint32_t>(value.size()));
            for (const char character : key) {
                bytes.push_back(static_cast<std::byte>(static_cast<unsigned char>(character)));
            }
            for (const char character : value) {
                bytes.push_back(static_cast<std::byte>(static_cast<unsigned char>(character)));
            }
        }
        bytes.insert(bytes.end(), record.blob.begin(), record.blob.end());
        if (bytes.size() > kMaximumRecordPayload) {
            return std::unexpected(
                core::error("record_payload_limit", "Record payload exceeds the v1 limit."));
        }
        return bytes;
    }

    core::Result<Record> decodeRecordPayload(RecordType type, Uuid id, std::uint64_t revision,
                                             std::uint64_t previousOffset,
                                             std::span<const std::byte> payload) {
        if (payload.size() < 16 || !hasMagic(payload, "TXMD")) {
            return std::unexpected(
                core::error("record_payload_invalid", "Domain record payload is malformed."));
        }
        std::size_t cursor = 4;
        auto schema = readLittle<std::uint16_t>(payload, cursor);
        auto count = readLittle<std::uint16_t>(payload, cursor);
        auto blobSize = readLittle<std::uint64_t>(payload, cursor);
        if (!schema || *schema != 1 || !count || !blobSize) {
            return std::unexpected(
                core::error("record_schema_unsupported", "Unsupported record schema."));
        }
        Record record{type, id, revision, previousOffset, {}, {}};
        for (std::uint16_t fieldIndex = 0; fieldIndex < *count; ++fieldIndex) {
            auto keyLength = readLittle<std::uint16_t>(payload, cursor);
            auto valueLength = readLittle<std::uint32_t>(payload, cursor);
            if (!keyLength || !valueLength || *keyLength == 0 || cursor > payload.size() ||
                payload.size() - cursor < static_cast<std::size_t>(*keyLength) + *valueLength) {
                return std::unexpected(
                    core::error("record_field_invalid", "Record field exceeds its payload."));
            }
            std::string key;
            std::string value;
            key.reserve(*keyLength);
            value.reserve(*valueLength);
            for (std::uint16_t index = 0; index < *keyLength; ++index)
                key.push_back(static_cast<char>(std::to_integer<unsigned char>(payload[cursor++])));
            for (std::uint32_t index = 0; index < *valueLength; ++index)
                value.push_back(
                    static_cast<char>(std::to_integer<unsigned char>(payload[cursor++])));
            if (!record.fields.emplace(std::move(key), std::move(value)).second) {
                return std::unexpected(core::error("record_field_duplicate",
                                                   "Record contains duplicate field names."));
            }
        }
        if (*blobSize != payload.size() - cursor) {
            return std::unexpected(
                core::error("record_blob_invalid", "Record blob length is inconsistent."));
        }
        record.blob.assign(payload.begin() + static_cast<std::ptrdiff_t>(cursor), payload.end());
        return record;
    }

    std::string uuidToString(const Uuid& id) {
        static constexpr char digits[] = "0123456789abcdef";
        std::string output;
        output.reserve(36);
        for (std::size_t index = 0; index < id.size(); ++index) {
            if (index == 4 || index == 6 || index == 8 || index == 10)
                output.push_back('-');
            const auto value = std::to_integer<unsigned int>(id[index]);
            output.push_back(digits[(value >> 4U) & 0xfU]);
            output.push_back(digits[value & 0xfU]);
        }
        return output;
    }

    core::Result<Uuid> uuidFromString(std::string_view value) {
        Uuid id{};
        std::size_t outputIndex = 0;
        int highNibble = -1;
        for (const char character : value) {
            if (character == '-')
                continue;
            unsigned int nibble = 0;
            if (character >= '0' && character <= '9')
                nibble = static_cast<unsigned int>(character - '0');
            else if (character >= 'a' && character <= 'f')
                nibble = static_cast<unsigned int>(character - 'a' + 10);
            else if (character >= 'A' && character <= 'F')
                nibble = static_cast<unsigned int>(character - 'A' + 10);
            else
                return std::unexpected(
                    core::error("id_invalid", "Identifier must be a hexadecimal UUID."));
            if (highNibble < 0)
                highNibble = static_cast<int>(nibble);
            else {
                if (outputIndex >= id.size()) {
                    return std::unexpected(
                        core::error("id_invalid", "Identifier must be a 128-bit UUID."));
                }
                id[outputIndex++] =
                    static_cast<std::byte>((static_cast<unsigned int>(highNibble) << 4U) | nibble);
                highNibble = -1;
            }
        }
        if (outputIndex != id.size() || highNibble >= 0) {
            return std::unexpected(core::error("id_invalid", "Identifier must be a 128-bit UUID."));
        }
        return id;
    }

    Uuid randomUuid() {
        std::random_device source;
        Uuid id{};
        for (std::byte& byte : id)
            byte = static_cast<std::byte>(source() & 0xffU);
        id[6] = static_cast<std::byte>((std::to_integer<unsigned int>(id[6]) & 0x0fU) | 0x40U);
        id[8] = static_cast<std::byte>((std::to_integer<unsigned int>(id[8]) & 0x3fU) | 0x80U);
        return id;
    }

    std::string recordTypeName(RecordType type) {
        switch (type) {
        case RecordType::Student:
            return "student";
        case RecordType::Session:
            return "session";
        case RecordType::AudioChunk:
            return "audio";
        case RecordType::TranscriptSegment:
            return "transcript";
        case RecordType::Annotation:
            return "annotation";
        case RecordType::AssetMetadata:
            return "asset";
        case RecordType::AssetBlob:
            return "asset-blob";
        case RecordType::EvidenceNode:
            return "evidence";
        case RecordType::EvidenceEdge:
            return "evidence-edge";
        case RecordType::Guide:
            return "guide";
        case RecordType::Settings:
            return "settings";
        case RecordType::AiJob:
            return "ai-job";
        case RecordType::Encryption:
            return "encryption";
        case RecordType::IndexPage:
            return "index";
        case RecordType::Commit:
            return "commit";
        }
        return "unknown";
    }

    core::Result<RecordType> recordTypeFromName(std::string_view name) {
        const std::string normalized = normalizeName(name);
        if (normalized == "student")
            return RecordType::Student;
        if (normalized == "session")
            return RecordType::Session;
        if (normalized == "audio")
            return RecordType::AudioChunk;
        if (normalized == "transcript")
            return RecordType::TranscriptSegment;
        if (normalized == "annotation")
            return RecordType::Annotation;
        if (normalized == "asset")
            return RecordType::AssetMetadata;
        if (normalized == "asset-blob")
            return RecordType::AssetBlob;
        if (normalized == "evidence")
            return RecordType::EvidenceNode;
        if (normalized == "evidence-edge")
            return RecordType::EvidenceEdge;
        if (normalized == "guide")
            return RecordType::Guide;
        if (normalized == "settings")
            return RecordType::Settings;
        if (normalized == "ai-job")
            return RecordType::AiJob;
        if (normalized == "encryption")
            return RecordType::Encryption;
        return std::unexpected(
            core::error("record_type_invalid", "Unknown record type '" + normalized + "'."));
    }

} // namespace tutorux::archive
