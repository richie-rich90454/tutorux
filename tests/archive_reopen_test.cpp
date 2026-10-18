#include "tutorux/archive/archive.hpp"

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

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
    return 0;
}
