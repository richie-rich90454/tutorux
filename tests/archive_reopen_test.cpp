#include "tutorux/archive/archive.hpp"
#include "tutorux/domain/hash.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <span>
#include <string>
#include <type_traits>
#include <vector>

namespace {

struct TemporaryDirectory final {
    std::filesystem::path path;

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

bool rewriteArchiveHeader(const std::filesystem::path& path, const tutorux::archive::ArchiveHeader& header) {
    auto encoded = tutorux::archive::encodeArchiveHeader(header);
    if (!encoded)
        return false;
    std::fstream file(path, std::ios::binary | std::ios::in | std::ios::out);
    if (!file)
        return false;
    file.write(reinterpret_cast<const char*>(encoded->data()), static_cast<std::streamsize>(encoded->size()));
    return file.good();
}

std::string readFileContents(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

template <typename Integer> void appendLittle(tutorux::archive::Bytes& bytes, Integer value) {
    using Unsigned = std::make_unsigned_t<Integer>;
    const auto bits = static_cast<Unsigned>(value);
    for (std::size_t index = 0; index < sizeof(Integer); ++index)
        bytes.push_back(static_cast<std::byte>((bits >> (index * 8U)) & 0xffU));
}

template <typename Integer> Integer readLittle(std::span<const std::byte> bytes, std::size_t offset) {
    using Unsigned = std::make_unsigned_t<Integer>;
    Unsigned value = 0;
    for (std::size_t index = 0; index < sizeof(Integer); ++index) {
        value |= static_cast<Unsigned>(std::to_integer<unsigned int>(bytes[offset + index])) << (index * 8U);
    }
    return static_cast<Integer>(value);
}

template <typename Integer> void writeLittle(tutorux::archive::Bytes& bytes, std::size_t offset, Integer value) {
    using Unsigned = std::make_unsigned_t<Integer>;
    const auto bits = static_cast<Unsigned>(value);
    for (std::size_t index = 0; index < sizeof(Integer); ++index)
        bytes[offset + index] = static_cast<std::byte>((bits >> (index * 8U)) & 0xffU);
}

tutorux::archive::Bytes readFileBytes(const std::filesystem::path& path) {
    const std::string contents = readFileContents(path);
    tutorux::archive::Bytes bytes;
    bytes.reserve(contents.size());
    for (const unsigned char character : contents)
        bytes.push_back(static_cast<std::byte>(character));
    return bytes;
}

bool writeFileBytes(const std::filesystem::path& path, std::span<const std::byte> bytes) {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file)
        return false;
    file.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    return file.good();
}

void updateFrameChecksums(tutorux::archive::Bytes& bytes, std::size_t frameOffset) {
    const std::uint64_t payloadLength = readLittle<std::uint64_t>(bytes, frameOffset + 12);
    const auto payload = std::span<const std::byte>(bytes).subspan(frameOffset + tutorux::archive::kRecordHeaderSize,
                                                                   static_cast<std::size_t>(payloadLength));
    writeLittle(bytes, frameOffset + 56, tutorux::archive::crc32(payload));
    writeLittle(bytes, frameOffset + 60, tutorux::archive::crc32(std::span<const std::byte>(bytes).subspan(frameOffset, 60)));
}

bool updateRootPageAndCommit(const std::filesystem::path& path, std::uint64_t rootOffset, std::uint64_t commitOffset,
                             tutorux::archive::Bytes& bytes) {
    const auto rootPayload = std::span<const std::byte>(bytes).subspan(
        static_cast<std::size_t>(rootOffset) + tutorux::archive::kRecordHeaderSize,
        static_cast<std::size_t>(readLittle<std::uint64_t>(bytes, static_cast<std::size_t>(rootOffset) + 12)));
    const auto rootHash = tutorux::domain::sha256(rootPayload);
    updateFrameChecksums(bytes, static_cast<std::size_t>(rootOffset));
    const std::size_t commitPayloadOffset = static_cast<std::size_t>(commitOffset) + tutorux::archive::kRecordHeaderSize;
    std::copy(rootHash.begin(), rootHash.end(), bytes.begin() + static_cast<std::ptrdiff_t>(commitPayloadOffset + 32));
    updateFrameChecksums(bytes, static_cast<std::size_t>(commitOffset));
    return writeFileBytes(path, bytes);
}

tutorux::archive::Bytes makeFrame(tutorux::archive::RecordType type, const tutorux::archive::Uuid& id, std::span<const std::byte> payload) {
    using namespace tutorux::archive;
    Bytes frame;
    frame.insert(frame.end(), {std::byte{'T'}, std::byte{'X'}, std::byte{'R'}, std::byte{'C'}});
    appendLittle(frame, static_cast<std::uint16_t>(type));
    appendLittle<std::uint16_t>(frame, 1);
    appendLittle<std::uint32_t>(frame, static_cast<std::uint32_t>(kRecordHeaderSize));
    appendLittle(frame, static_cast<std::uint64_t>(payload.size()));
    frame.insert(frame.end(), id.begin(), id.end());
    appendLittle<std::uint64_t>(frame, 1);
    appendLittle<std::uint64_t>(frame, 0);
    frame.push_back(std::byte{});
    frame.push_back(std::byte{});
    appendLittle<std::uint16_t>(frame, 0);
    appendLittle(frame, crc32(payload));
    appendLittle(frame, crc32(frame));
    frame.insert(frame.end(), payload.begin(), payload.end());
    const std::size_t padding = (8U - (payload.size() % 8U)) % 8U;
    frame.insert(frame.end(), padding, std::byte{});
    return frame;
}

std::optional<std::uint64_t> findFrameOffset(std::span<const std::byte> bytes, tutorux::archive::RecordType type,
                                             const tutorux::archive::Uuid& id) {
    for (std::size_t offset = tutorux::archive::kArchiveHeaderSize; offset + tutorux::archive::kRecordHeaderSize <= bytes.size();
         offset += 8) {
        if (bytes[offset] != std::byte{'T'} || bytes[offset + 1] != std::byte{'X'} || bytes[offset + 2] != std::byte{'R'} ||
            bytes[offset + 3] != std::byte{'C'} || readLittle<std::uint16_t>(bytes, offset + 4) != static_cast<std::uint16_t>(type)) {
            continue;
        }
        if (std::equal(id.begin(), id.end(), bytes.begin() + static_cast<std::ptrdiff_t>(offset + 20)))
            return offset;
    }
    return std::nullopt;
}

std::optional<std::size_t> findLeafValueOffset(std::span<const std::byte> bytes, std::uint64_t rootOffset, std::string_view key) {
    const std::size_t payloadOffset = static_cast<std::size_t>(rootOffset) + tutorux::archive::kRecordHeaderSize;
    if (bytes[payloadOffset + 6] != std::byte{0})
        return std::nullopt;
    const std::uint16_t count = readLittle<std::uint16_t>(bytes, payloadOffset + 8);
    std::size_t cursor = payloadOffset + 10;
    for (std::uint16_t entry = 0; entry < count; ++entry) {
        const std::uint16_t keyLength = readLittle<std::uint16_t>(bytes, cursor);
        cursor += 2;
        const std::string_view actualKey(reinterpret_cast<const char*>(bytes.data() + cursor), keyLength);
        cursor += keyLength;
        const std::size_t valueOffset = cursor;
        cursor += sizeof(std::uint64_t);
        if (actualKey == key)
            return valueOffset;
    }
    return std::nullopt;
}

} // namespace

int main() {
    using namespace tutorux;

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() / ("tutorux-archive-reopen-" + std::to_string(uniqueSuffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode) {
        std::cerr << "Unable to create the archive test directory: " << errorCode.message() << '\n';
        return 1;
    }
    const auto archivePath = temporary.path / "small.tux";

    {
        auto created = archive::Archive::create(archivePath, "Reopen regression");
        if (!created) {
            std::cerr << "Archive creation failed: " << created.error().message << '\n';
            return 1;
        }
    }

    {
        auto reopened = archive::Archive::open(archivePath);
        if (!reopened) {
            std::cerr << "Archive reopen failed: " << reopened.error().message << '\n';
            return 1;
        }

        auto verification = reopened->verify(true);
        if (!verification || !verification->valid) {
            std::cerr << "New archive failed full verification.\n";
            if (verification) {
                for (const auto& issue : verification->issues)
                    std::cerr << "  " << issue << '\n';
            } else {
                std::cerr << "  " << verification.error().message << '\n';
            }
            return 1;
        }
    }

    auto duplicate = archive::Archive::create(archivePath, "Must not overwrite");
    if (duplicate || !archive::inspectArchive(archivePath)) {
        std::cerr << "Archive initialization replaced or damaged an existing archive.\n";
        return 1;
    }

    std::filesystem::create_directories(temporary.path / "nested", errorCode);
    if (errorCode)
        return 1;
    {
        auto nested = archive::Archive::create(temporary.path / "nested" / "ignored.tux", "Nested");
        if (!nested) {
            std::cerr << "Nested archive creation failed: " << nested.error().message << '\n';
            return 1;
        }
    }
    auto discovered = archive::Archive::discover(temporary.path);
    if (!discovered || discovered->size() != 1 || discovered->front().path != archivePath) {
        std::cerr << "Archive discovery did not stay at the selected directory level.\n";
        return 1;
    }

    const auto compatibilityPath = temporary.path / "compatibility.tux";
    archive::ArchiveHeader compatibilityHeader;
    {
        auto created = archive::Archive::create(compatibilityPath, "Compatibility test");
        if (!created) {
            std::cerr << "Compatibility archive creation failed: " << created.error().message << '\n';
            return 1;
        }
        compatibilityHeader = created->header();
    }
    compatibilityHeader.minorVersion = static_cast<std::uint16_t>(archive::kSupportedArchiveMinorVersion + 1U);
    if (!rewriteArchiveHeader(compatibilityPath, compatibilityHeader)) {
        std::cerr << "Unable to write a newer-minor compatibility fixture.\n";
        return 1;
    }
    auto newerMinorOpen = archive::Archive::open(compatibilityPath, true);
    auto newerMinorInfo = archive::inspectArchive(compatibilityPath);
    if (newerMinorOpen || newerMinorOpen.error().code != "archive_version_unsupported" || !newerMinorInfo ||
        !newerMinorInfo->metadataOnly || newerMinorInfo->healthStatus != "unsupported-version" ||
        newerMinorInfo->formatMinor != compatibilityHeader.minorVersion) {
        std::cerr << "A newer minor archive version was not limited to safe metadata inspection.\n";
        return 1;
    }

    compatibilityHeader.minorVersion = archive::kSupportedArchiveMinorVersion;
    compatibilityHeader.capabilities |= 1ULL << 1U;
    if (!rewriteArchiveHeader(compatibilityPath, compatibilityHeader)) {
        std::cerr << "Unable to write an unknown-capability compatibility fixture.\n";
        return 1;
    }
    auto unknownCapabilityOpen = archive::Archive::open(compatibilityPath, true);
    auto unknownCapabilityInfo = archive::inspectArchive(compatibilityPath);
    if (unknownCapabilityOpen || unknownCapabilityOpen.error().code != "archive_capability_unsupported" || !unknownCapabilityInfo ||
        !unknownCapabilityInfo->metadataOnly || unknownCapabilityInfo->healthStatus != "unsupported-capability") {
        std::cerr << "An archive with an unknown capability was not limited to safe metadata "
                     "inspection.\n";
        return 1;
    }

    const archive::Uuid revisionId = archive::randomUuid();
    {
        auto writable = archive::Archive::open(archivePath, true);
        if (!writable) {
            std::cerr << "Archive writer reopen failed: " << writable.error().message << '\n';
            return 1;
        }
        archive::Record largeBlob;
        largeBlob.type = archive::RecordType::AssetBlob;
        largeBlob.id = archive::randomUuid();
        largeBlob.blob.resize(128 * 1024, std::byte{0x5a});
        if (auto status = writable->put(std::move(largeBlob)); !status) {
            std::cerr << "Large record append failed: " << status.error().message << '\n';
            return 1;
        }

        archive::Record firstRevision;
        firstRevision.type = archive::RecordType::Annotation;
        firstRevision.id = revisionId;
        firstRevision.fields["content"] = "original wording";
        if (auto status = writable->put(std::move(firstRevision)); !status) {
            std::cerr << "Initial revision write failed: " << status.error().message << '\n';
            return 1;
        }
        archive::Record latestRevision;
        latestRevision.type = archive::RecordType::Annotation;
        latestRevision.id = revisionId;
        latestRevision.fields["content"] = "edited wording";
        if (auto status = writable->put(std::move(latestRevision)); !status) {
            std::cerr << "Edited revision write failed: " << status.error().message << '\n';
            return 1;
        }
    }

    const auto checkHistory = [revisionId](const archive::Archive& archive) {
        auto latest = archive.getRevision(archive::RecordType::Annotation, revisionId, 0);
        auto original = archive.getRevision(archive::RecordType::Annotation, revisionId, 1);
        return latest && *latest && original && *original && (**latest).fields.at("content") == "edited wording" &&
               (**original).fields.at("content") == "original wording";
    };

    {
        auto largeReopen = archive::Archive::open(archivePath);
        if (!largeReopen) {
            std::cerr << "Large archive reopen failed: " << largeReopen.error().message << '\n';
            return 1;
        }
        auto verification = largeReopen->verify(true);
        if (!verification || !verification->valid || !checkHistory(*largeReopen)) {
            std::cerr << "Large archive failed integrity or revision-history verification.\n";
            return 1;
        }
    }

    {
        auto writable = archive::Archive::open(archivePath, true);
        if (!writable) {
            std::cerr << "Archive writer reopen failed before compaction: " << writable.error().message << '\n';
            return 1;
        }
        if (auto status = writable->compact(); !status) {
            std::cerr << "Archive compaction failed: " << status.error().message << '\n';
            return 1;
        }
        auto verification = writable->verify(true);
        if (!verification || !verification->valid || !checkHistory(*writable)) {
            std::cerr << "Compacted archive lost integrity or revision history.\n";
            return 1;
        }
    }

    auto compacted = archive::Archive::open(archivePath);
    if (!compacted || !checkHistory(*compacted)) {
        std::cerr << "Compacted archive did not reopen with its retained revision history.\n";
        return 1;
    }

    const auto corruptHeaderPath = temporary.path / "corrupt-header.tux";
    {
        auto created = archive::Archive::create(corruptHeaderPath, "Corrupt header recovery test");
        if (!created) {
            std::cerr << "Corrupt-header fixture creation failed: " << created.error().message << '\n';
            return 1;
        }
    }
    {
        std::fstream file(corruptHeaderPath, std::ios::binary | std::ios::in | std::ios::out);
        if (!file) {
            std::cerr << "Unable to open the corrupt-header fixture.\n";
            return 1;
        }
        file.seekp(0);
        file.put('X');
        file.flush();
        if (!file) {
            std::cerr << "Unable to corrupt the archive header fixture.\n";
            return 1;
        }
    }
    const std::string corruptHeaderBytes = readFileContents(corruptHeaderPath);
    auto corruptHeaderReport = archive::Archive::inspectRecovery(corruptHeaderPath);
    if (!corruptHeaderReport || corruptHeaderReport->archiveHeaderValid || corruptHeaderReport->recoveryAssessmentComplete ||
        corruptHeaderReport->recoverable || corruptHeaderReport->issues.empty() ||
        corruptHeaderReport->issues.front().find("Recovery candidates were not scanned") == std::string::npos ||
        readFileContents(corruptHeaderPath) != corruptHeaderBytes) {
        std::cerr << "Corrupt-header recovery inspection did not return a non-destructive diagnostic.\n";
        return 1;
    }

    const auto truncatedHeaderPath = temporary.path / "truncated-header.tux";
    {
        std::ofstream file(truncatedHeaderPath, std::ios::binary | std::ios::trunc);
        file.write("TUX", 3);
        if (!file) {
            std::cerr << "Unable to create the truncated-header fixture.\n";
            return 1;
        }
    }
    const std::string truncatedHeaderBytes = readFileContents(truncatedHeaderPath);
    auto truncatedHeaderReport = archive::Archive::inspectRecovery(truncatedHeaderPath);
    if (!truncatedHeaderReport || truncatedHeaderReport->archiveHeaderValid || truncatedHeaderReport->recoveryAssessmentComplete ||
        truncatedHeaderReport->recoverable || truncatedHeaderReport->issues.empty() ||
        truncatedHeaderReport->issues.front().find("header is truncated") == std::string::npos ||
        readFileContents(truncatedHeaderPath) != truncatedHeaderBytes) {
        std::cerr << "Truncated-header recovery inspection did not return a non-destructive diagnostic.\n";
        return 1;
    }

    const auto overlappingFramesPath = temporary.path / "overlapping-frames.tux";
    const archive::Uuid outerBlobId = archive::randomUuid();
    const archive::Uuid nestedBlobId = archive::randomUuid();
    archive::CommitInfo overlappingCommit;
    {
        auto created = archive::Archive::create(overlappingFramesPath, "Overlapping frame test");
        if (!created)
            return 1;
        archive::Record nestedBlob;
        nestedBlob.type = archive::RecordType::AssetBlob;
        nestedBlob.id = nestedBlobId;
        nestedBlob.blob = {std::byte{'n'}, std::byte{'e'}, std::byte{'s'}, std::byte{'t'}};
        auto nestedPayload = archive::encodeRecordPayload(nestedBlob);
        if (!nestedPayload)
            return 1;
        const archive::Bytes nestedFrame = makeFrame(archive::RecordType::AssetBlob, nestedBlobId, *nestedPayload);
        archive::Record outerBlob;
        outerBlob.type = archive::RecordType::AssetBlob;
        outerBlob.id = outerBlobId;
        outerBlob.blob = nestedFrame;
        if (auto status = created->put(std::move(outerBlob)); !status)
            return 1;

        archive::Record indexedNestedBlob;
        indexedNestedBlob.type = archive::RecordType::AssetBlob;
        indexedNestedBlob.id = nestedBlobId;
        indexedNestedBlob.blob = {std::byte{'r'}, std::byte{'e'}, std::byte{'a'}, std::byte{'l'}};
        if (auto status = created->put(std::move(indexedNestedBlob)); !status)
            return 1;
        overlappingCommit = created->commitInfo();
    }
    {
        auto bytes = readFileBytes(overlappingFramesPath);
        const auto outerOffset = findFrameOffset(bytes, archive::RecordType::AssetBlob, outerBlobId);
        const auto valueOffset =
            findLeafValueOffset(bytes, overlappingCommit.rootOffset, "ASSET-BLOB:" + archive::uuidToString(nestedBlobId));
        if (!outerOffset || !valueOffset)
            return 1;
        const std::uint64_t nestedOffset = *outerOffset + archive::kRecordHeaderSize + 16U;
        writeLittle(bytes, *valueOffset, nestedOffset);
        if (!updateRootPageAndCommit(overlappingFramesPath, overlappingCommit.rootOffset, overlappingCommit.offset, bytes))
            return 1;
    }
    {
        auto overlapping = archive::Archive::open(overlappingFramesPath);
        if (!overlapping)
            return 1;
        auto verification = overlapping->verify(true);
        if (!verification || verification->valid ||
            std::none_of(verification->issues.begin(), verification->issues.end(), [](const std::string& issue) {
                return issue.find("Physical archive record spans overlap") != std::string::npos;
            })) {
            std::cerr << "Full verification did not detect overlapping reachable record frames.\n";
            return 1;
        }
    }

    const auto separatorPath = temporary.path / "invalid-separator.tux";
    archive::CommitInfo separatorCommit;
    {
        auto created = archive::Archive::create(separatorPath, "B+ tree separator test");
        if (!created)
            return 1;
        std::vector<archive::Record> students;
        students.reserve(96);
        for (std::size_t index = 0; index < 96; ++index) {
            archive::Record student;
            student.type = archive::RecordType::Student;
            student.id = archive::randomUuid();
            student.fields["display_name"] = "Student " + std::to_string(index);
            students.push_back(std::move(student));
        }
        if (auto status = created->putMany(std::move(students)); !status)
            return 1;
        separatorCommit = created->commitInfo();
    }
    {
        auto bytes = readFileBytes(separatorPath);
        const std::size_t payloadOffset = static_cast<std::size_t>(separatorCommit.rootOffset) + archive::kRecordHeaderSize;
        if (bytes[payloadOffset + 6] != std::byte{1} || readLittle<std::uint16_t>(bytes, payloadOffset + 8) != 1) {
            std::cerr << "Separator corruption fixture did not produce an internal root page.\n";
            return 1;
        }
        const std::size_t separatorOffset = payloadOffset + 21U;
        bytes[separatorOffset] = std::byte{'U'};
        if (!updateRootPageAndCommit(separatorPath, separatorCommit.rootOffset, separatorCommit.offset, bytes))
            return 1;
    }
    {
        auto separatorArchive = archive::Archive::open(separatorPath);
        if (!separatorArchive)
            return 1;
        auto verification = separatorArchive->verify(true);
        if (!verification || verification->valid ||
            std::none_of(verification->issues.begin(), verification->issues.end(), [](const std::string& issue) {
                return issue.find("separator") != std::string::npos;
            })) {
            std::cerr << "Full verification did not detect a separator outside its child key ranges.\n";
            return 1;
        }
    }

    const auto historicalReferencePath = temporary.path / "historical-reference.tux";
    {
        auto created = archive::Archive::create(historicalReferencePath, "Historical reference test");
        if (!created)
            return 1;
        const archive::Uuid sessionId = archive::randomUuid();
        archive::Record session;
        session.type = archive::RecordType::Session;
        session.id = sessionId;
        if (auto status = created->put(std::move(session)); !status)
            return 1;

        archive::Record firstAnnotation;
        firstAnnotation.type = archive::RecordType::Annotation;
        firstAnnotation.id = archive::randomUuid();
        const archive::Uuid annotationId = firstAnnotation.id;
        firstAnnotation.fields["session_id"] = archive::uuidToString(archive::randomUuid());
        if (auto status = created->put(std::move(firstAnnotation)); !status)
            return 1;
        archive::Record repairedAnnotation;
        repairedAnnotation.type = archive::RecordType::Annotation;
        repairedAnnotation.id = annotationId;
        repairedAnnotation.fields["session_id"] = archive::uuidToString(sessionId);
        if (auto status = created->put(std::move(repairedAnnotation)); !status)
            return 1;
    }
    {
        auto historical = archive::Archive::open(historicalReferencePath);
        if (!historical)
            return 1;
        auto verification = historical->verify(true);
        if (!verification || verification->valid ||
            std::none_of(verification->issues.begin(), verification->issues.end(), [](const std::string& issue) {
                return issue.find("historical revision") != std::string::npos && issue.find("Session reference") != std::string::npos;
            })) {
            std::cerr << "Full verification did not validate semantic references in older revisions.\n";
            return 1;
        }
    }
    return 0;
}
