#pragma once

#include "tutorux/core/result.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <map>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::archive {

using Uuid = std::array<std::byte, 16>;
using Bytes = std::vector<std::byte>;

inline constexpr std::size_t kArchiveHeaderSize = 64;
inline constexpr std::size_t kRecordHeaderSize = 64;
inline constexpr std::size_t kLocatorSize = 32;
inline constexpr std::uint64_t kMaximumRecordPayload = 256ULL * 1024ULL * 1024ULL;
inline constexpr std::uint64_t kRecoveryWindow = 64ULL * 1024ULL * 1024ULL;
inline constexpr std::uint64_t kArchiveCapabilityEncrypted = 1ULL;
inline constexpr std::uint16_t kSupportedArchiveMajorVersion = 1;
inline constexpr std::uint16_t kSupportedArchiveMinorVersion = 0;
inline constexpr std::uint64_t kKnownArchiveCapabilities = kArchiveCapabilityEncrypted;
inline constexpr std::uint8_t kRecordFlagEncrypted = 1U;

enum class RecordType : std::uint16_t {
    Student = 1,
    Session = 2,
    AudioChunk = 3,
    TranscriptSegment = 4,
    Annotation = 5,
    AssetMetadata = 6,
    AssetBlob = 7,
    EvidenceNode = 8,
    EvidenceEdge = 9,
    Guide = 10,
    Settings = 11,
    AiJob = 12,
    Encryption = 13,
    WaveformIndex = 14,
    IndexPage = 250,
    Commit = 251,
};

struct ArchiveHeader final {
    Uuid id{};
    std::uint16_t majorVersion{kSupportedArchiveMajorVersion};
    std::uint16_t minorVersion{kSupportedArchiveMinorVersion};
    std::uint64_t createdAtUs{};
    std::uint64_t capabilities{};
};

struct ArchiveVersion final {
    std::uint16_t major{};
    std::uint16_t minor{};
};

struct Record final {
    RecordType type{RecordType::Settings};
    Uuid id{};
    std::uint64_t revision{};
    std::uint64_t previousOffset{};
    std::map<std::string, std::string, std::less<>> fields;
    Bytes blob;
};

struct RecordLocation final {
    std::uint64_t offset{};
    std::uint64_t length{};
};

struct CommitInfo final {
    std::uint64_t generation{};
    std::uint64_t offset{};
    std::uint64_t previousOffset{};
    std::uint64_t rootOffset{};
    std::array<std::byte, 32> rootHash{};
    Uuid transactionId{};
    std::uint64_t recordCount{};
};

std::uint32_t crc32(std::span<const std::byte> data);
core::Result<Bytes> encodeArchiveHeader(const ArchiveHeader& header);
core::Result<ArchiveVersion> inspectArchiveVersion(std::span<const std::byte> bytes);
core::Result<ArchiveHeader> decodeArchiveHeader(std::span<const std::byte> bytes);
core::Result<Bytes> encodeRecordPayload(const Record& record);
core::Result<Record> decodeRecordPayload(RecordType type, Uuid id, std::uint64_t revision, std::uint64_t previousOffset,
                                         std::span<const std::byte> payload);
std::string uuidToString(const Uuid& id);
core::Result<Uuid> uuidFromString(std::string_view value);
Uuid randomUuid();
std::string recordTypeName(RecordType type);
core::Result<RecordType> recordTypeFromName(std::string_view name);

} // namespace tutorux::archive
