#include "tutorux/assets/import.hpp"

#include "tutorux/assets/mime.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/hash.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <fstream>
#include <limits>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

namespace tutorux::assets {
namespace {

    constexpr std::size_t ioBufferSize = 64U * 1024U;
    constexpr std::size_t signaturePrefixSize = 32;
    constexpr std::size_t archiveAssetChunkBytes = 8U * 1024U * 1024U;
    constexpr std::size_t archiveAssetBatchChunkCount = 4;

    std::string pathFileNameUtf8(const std::filesystem::path& path) {
        const std::u8string fileName = path.filename().u8string();
        return {reinterpret_cast<const char*>(fileName.data()), fileName.size()};
    }

    core::Error fileError(std::string code, std::string message) {
        return core::error(std::move(code), std::move(message));
    }

    core::Result<std::uint64_t> parseUnsigned(std::string_view value, std::string_view fieldName) {
        std::uint64_t parsed = 0;
        const auto [end, errorCode] =
            std::from_chars(value.data(), value.data() + value.size(), parsed);
        if (errorCode != std::errc{} || end != value.data() + value.size()) {
            return std::unexpected(
                fileError("asset_metadata_invalid",
                          "Asset " + std::string(fieldName) + " metadata is invalid."));
        }
        return parsed;
    }

    std::vector<std::string_view> splitIdentifiers(std::string_view value) {
        std::vector<std::string_view> identifiers;
        std::size_t start = 0;
        while (start < value.size()) {
            const std::size_t end = value.find(',', start);
            const std::size_t itemEnd = end == std::string_view::npos ? value.size() : end;
            if (itemEnd == start)
                return {};
            identifiers.push_back(value.substr(start, itemEnd - start));
            if (end == std::string_view::npos)
                break;
            start = end + 1;
        }
        return identifiers;
    }

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
                                              std::chrono::system_clock::now().time_since_epoch())
                                              .count());
    }

} // namespace

core::Result<FileInspection> inspectFile(const std::filesystem::path& path,
                                         std::uint64_t maximumBytes) {
    std::error_code errorCode;
    const std::uint64_t expectedSize = std::filesystem::file_size(path, errorCode);
    if (errorCode) {
        return std::unexpected(
            fileError("asset_read_failed", "Unable to read the selected asset file."));
    }
    if (expectedSize > maximumBytes) {
        return std::unexpected(
            fileError("asset_size_limit", "The selected asset exceeds the configured size limit."));
    }

    std::ifstream input(path, std::ios::binary);
    if (!input) {
        return std::unexpected(
            fileError("asset_read_failed", "Unable to open the selected asset file."));
    }

    domain::Sha256Builder hash;
    std::array<std::byte, ioBufferSize> buffer{};
    std::array<std::byte, signaturePrefixSize> prefix{};
    std::uint64_t byteSize = 0;
    std::size_t prefixSize = 0;
    while (input) {
        input.read(reinterpret_cast<char*>(buffer.data()),
                   static_cast<std::streamsize>(buffer.size()));
        const std::streamsize count = input.gcount();
        if (count < 0) {
            return std::unexpected(
                fileError("asset_read_failed", "The selected asset could not be read."));
        }
        const std::size_t chunkSize = static_cast<std::size_t>(count);
        if (chunkSize > maximumBytes - byteSize) {
            return std::unexpected(
                fileError("asset_size_limit",
                          "The selected asset grew beyond the configured size limit."));
        }
        const auto chunk = std::span<const std::byte>(buffer.data(), chunkSize);
        hash.update(chunk);
        const std::size_t prefixCount = std::min(prefix.size() - prefixSize, chunkSize);
        std::copy_n(chunk.begin(), prefixCount, prefix.begin() + prefixSize);
        prefixSize += prefixCount;
        byteSize += static_cast<std::uint64_t>(chunkSize);
        if (input.bad()) {
            return std::unexpected(
                fileError("asset_read_failed", "The selected asset could not be read completely."));
        }
    }
    if (byteSize != expectedSize) {
        return std::unexpected(
            fileError("asset_source_changed",
                      "The selected asset changed while it was being inspected."));
    }

    const auto prefixSpan = std::span<const std::byte>(prefix.data(), prefixSize);
    FileInspection inspection;
    inspection.byteSize = byteSize;
    inspection.sha256 = domain::hexHash(hash.finish());
    inspection.mimeType = detectMimeType(pathFileNameUtf8(path), prefixSpan);
    return inspection;
}

core::Result<std::vector<std::byte>> readVerifiedFile(const std::filesystem::path& path,
                                                      const FileInspection& inspection) {
    if (inspection.byteSize > std::numeric_limits<std::size_t>::max() ||
        inspection.byteSize >
            static_cast<std::uint64_t>(std::numeric_limits<std::streamsize>::max())) {
        return std::unexpected(
            fileError("asset_size_limit", "The selected asset cannot fit in one archive record."));
    }

    std::ifstream input(path, std::ios::binary);
    if (!input) {
        return std::unexpected(
            fileError("asset_read_failed", "Unable to reopen the selected asset file."));
    }
    std::vector<std::byte> content(static_cast<std::size_t>(inspection.byteSize));
    if (!content.empty()) {
        input.read(reinterpret_cast<char*>(content.data()),
                   static_cast<std::streamsize>(content.size()));
        if (input.gcount() != static_cast<std::streamsize>(content.size())) {
            return std::unexpected(
                fileError("asset_source_changed",
                          "The selected asset changed while it was being imported."));
        }
    }
    char extraByte{};
    if (input.get(extraByte)) {
        return std::unexpected(fileError("asset_source_changed",
                                         "The selected asset grew while it was being imported."));
    }
    if (input.bad()) {
        return std::unexpected(
            fileError("asset_read_failed", "The selected asset could not be read completely."));
    }

    domain::Sha256Builder hash;
    hash.update(content);
    if (domain::hexHash(hash.finish()) != inspection.sha256) {
        return std::unexpected(
            fileError("asset_source_changed",
                      "The selected asset changed while it was being imported."));
    }
    return content;
}

core::Result<ArchiveAssetImport> importIntoArchive(archive::Archive& archive,
                                                   const std::filesystem::path& path,
                                                   std::string_view sessionId,
                                                   std::uint64_t maximumBytes) {
    auto inspection = inspectFile(path, maximumBytes);
    if (!inspection)
        return std::unexpected(inspection.error());

    archive::Uuid blobId{};
    bool deduplicated = false;
    std::uint32_t chunkCount = 0;
    auto existingBlob = archive.getByIndexKey("BLOB:" + inspection->sha256);
    if (!existingBlob)
        return std::unexpected(existingBlob.error());
    if (*existingBlob) {
        const archive::Record& existing = **existingBlob;
        if (existing.type != archive::RecordType::AssetBlob ||
            domain::getField(existing, "content_hash") != inspection->sha256) {
            return std::unexpected(
                fileError("asset_blob_index_invalid",
                          "Content hash index points to an invalid asset blob."));
        }
        archive::Record candidate;
        candidate.type = archive::RecordType::AssetMetadata;
        candidate.fields = {
            {"blob_id",      archive::uuidToString(existing.id)  },
            {"content_hash", inspection->sha256                  },
            {"byte_size",    std::to_string(inspection->byteSize)}
        };
        if (auto status = visitArchiveAsset(archive,
                                            candidate,
                                            [](std::span<const std::byte>) -> core::Status {
                                                return {};
                                            });
            !status) {
            return std::unexpected(status.error());
        }
        blobId = existing.id;
        deduplicated = true;
        if (domain::getField(existing, "record_role") == "asset-blob-manifest") {
            auto parsedCount =
                parseUnsigned(domain::getField(existing, "chunk_count"), "chunk count");
            if (!parsedCount)
                return std::unexpected(parsedCount.error());
            if (*parsedCount > std::numeric_limits<std::uint32_t>::max())
                return std::unexpected(fileError("asset_chunk_count_invalid",
                                                 "Asset chunk count exceeds the supported range."));
            chunkCount = static_cast<std::uint32_t>(*parsedCount);
        } else {
            chunkCount = 1;
        }
    } else {
        std::ifstream input(path, std::ios::binary);
        if (!input)
            return std::unexpected(
                fileError("asset_read_failed", "Unable to reopen the selected asset."));

        blobId = archive::randomUuid();
        domain::Sha256Builder sourceHash;
        std::vector<std::string> chunkIds;
        std::vector<archive::Record> chunkBatch;
        chunkBatch.reserve(archiveAssetBatchChunkCount);
        std::uint64_t bytesRemaining = inspection->byteSize;
        std::uint64_t bytesRead = 0;
        while (bytesRemaining > 0) {
            const std::size_t chunkSize = static_cast<std::size_t>(
                std::min<std::uint64_t>(bytesRemaining, archiveAssetChunkBytes));
            archive::Record chunk;
            chunk.type = archive::RecordType::AssetBlob;
            chunk.id = archive::randomUuid();
            chunk.fields = {
                {"record_role", "asset-blob-chunk"             },
                {"manifest_id", archive::uuidToString(blobId)  },
                {"chunk_index", std::to_string(chunkIds.size())},
                {"byte_size",   std::to_string(chunkSize)      }
            };
            chunk.blob.resize(chunkSize);
            input.read(reinterpret_cast<char*>(chunk.blob.data()),
                       static_cast<std::streamsize>(chunkSize));
            if (input.gcount() != static_cast<std::streamsize>(chunkSize))
                return std::unexpected(
                    fileError("asset_source_changed",
                              "The selected asset changed during archive import."));

            sourceHash.update(chunk.blob);
            chunkIds.push_back(archive::uuidToString(chunk.id));
            bytesRead += static_cast<std::uint64_t>(chunkSize);
            bytesRemaining -= static_cast<std::uint64_t>(chunkSize);
            chunkBatch.push_back(std::move(chunk));
            if (chunkBatch.size() == archiveAssetBatchChunkCount || bytesRemaining == 0) {
                if (auto status = archive.putMany(std::move(chunkBatch)); !status)
                    return std::unexpected(status.error());
                chunkBatch.clear();
                chunkBatch.reserve(archiveAssetBatchChunkCount);
            }
        }

        char extraByte{};
        if (input.get(extraByte) || input.bad() || bytesRead != inspection->byteSize ||
            domain::hexHash(sourceHash.finish()) != inspection->sha256) {
            return std::unexpected(fileError("asset_source_changed",
                                             "The selected asset changed during archive import."));
        }
        if (chunkIds.size() > std::numeric_limits<std::uint32_t>::max()) {
            return std::unexpected(fileError("asset_chunk_count_invalid",
                                             "The asset requires too many archive chunks."));
        }

        std::string encodedChunkIds;
        for (const auto& chunkId : chunkIds) {
            if (!encodedChunkIds.empty())
                encodedChunkIds.push_back(',');
            encodedChunkIds += chunkId;
        }
        chunkCount = static_cast<std::uint32_t>(chunkIds.size());
        archive::Record manifest;
        manifest.type = archive::RecordType::AssetBlob;
        manifest.id = blobId;
        manifest.fields = {
            {"record_role",  "asset-blob-manifest"               },
            {"content_hash", inspection->sha256                  },
            {"byte_size",    std::to_string(inspection->byteSize)},
            {"chunk_count",  std::to_string(chunkCount)          },
            {"chunk_ids",    std::move(encodedChunkIds)          }
        };

        archive::Record metadata;
        metadata.type = archive::RecordType::AssetMetadata;
        metadata.id = archive::randomUuid();
        const std::string fileName = pathFileNameUtf8(path);
        metadata.fields = {
            {"filename",      fileName                             },
            {"mime_type",     inspection->mimeType                 },
            {"byte_size",     std::to_string(inspection->byteSize) },
            {"content_hash",  inspection->sha256                   },
            {"blob_id",       archive::uuidToString(blobId)        },
            {"blob_count",    std::to_string(chunkCount)           },
            {"origin",        "user-import"                        },
            {"created_at_us", std::to_string(nowUnixMicroseconds())}
        };
        if (!sessionId.empty())
            metadata.fields["session_id"] = std::string(sessionId);
        if (auto status = archive.putMany({std::move(manifest), metadata}); !status)
            return std::unexpected(status.error());
        return ArchiveAssetImport{std::move(metadata), false, chunkCount};
    }

    archive::Record metadata;
    metadata.type = archive::RecordType::AssetMetadata;
    metadata.id = archive::randomUuid();
    metadata.fields = {
        {"filename",      pathFileNameUtf8(path)               },
        {"mime_type",     inspection->mimeType                 },
        {"byte_size",     std::to_string(inspection->byteSize) },
        {"content_hash",  inspection->sha256                   },
        {"blob_id",       archive::uuidToString(blobId)        },
        {"blob_count",    std::to_string(chunkCount)           },
        {"origin",        "user-import"                        },
        {"created_at_us", std::to_string(nowUnixMicroseconds())}
    };
    if (!sessionId.empty())
        metadata.fields["session_id"] = std::string(sessionId);
    if (auto status = archive.put(metadata); !status)
        return std::unexpected(status.error());
    return ArchiveAssetImport{std::move(metadata), deduplicated, chunkCount};
}

core::Status
visitArchiveAsset(const archive::Archive& archive,
                  const archive::Record& metadata,
                  const std::function<core::Status(std::span<const std::byte>)>& visitor) {
    if (!visitor)
        return std::unexpected(fileError("asset_visitor_invalid", "Asset visitor is required."));
    auto manifestId = archive::uuidFromString(domain::getField(metadata, "blob_id"));
    if (!manifestId)
        return std::unexpected(fileError("asset_blob_id_invalid", "Asset blob ID is invalid."));
    auto manifest = archive.get(archive::RecordType::AssetBlob, *manifestId);
    if (!manifest || !*manifest || domain::isDeleted(**manifest))
        return std::unexpected(fileError("asset_blob_missing", "Asset content is missing."));

    domain::Sha256Builder hash;
    std::uint64_t byteCount = 0;
    const std::string expectedHash = domain::getField(metadata, "content_hash");
    const std::string role = domain::getField(**manifest, "record_role");
    if (role != "asset-blob-manifest") {
        hash.update((*manifest)->blob);
        byteCount = (*manifest)->blob.size();
        if (auto status = visitor((*manifest)->blob); !status)
            return status;
    } else {
        const auto chunkIds = splitIdentifiers(domain::getField(**manifest, "chunk_ids"));
        auto expectedChunkCount =
            parseUnsigned(domain::getField(**manifest, "chunk_count"), "chunk count");
        if (!expectedChunkCount || *expectedChunkCount != chunkIds.size())
            return std::unexpected(fileError("asset_chunk_manifest_invalid",
                                             "Asset chunk manifest count is inconsistent."));
        for (std::size_t index = 0; index < chunkIds.size(); ++index) {
            auto chunkId = archive::uuidFromString(chunkIds[index]);
            if (!chunkId)
                return std::unexpected(fileError("asset_chunk_id_invalid",
                                                 "Asset manifest contains an invalid chunk ID."));
            auto chunk = archive.get(archive::RecordType::AssetBlob, *chunkId);
            if (!chunk || !*chunk || domain::isDeleted(**chunk) ||
                domain::getField(**chunk, "record_role") != "asset-blob-chunk" ||
                domain::getField(**chunk, "manifest_id") != archive::uuidToString(*manifestId) ||
                domain::getField(**chunk, "chunk_index") != std::to_string(index)) {
                return std::unexpected(fileError("asset_chunk_missing",
                                                 "An asset chunk is missing or out of sequence."));
            }
            if ((*chunk)->blob.size() > std::numeric_limits<std::uint64_t>::max() - byteCount)
                return std::unexpected(
                    fileError("asset_size_invalid",
                              "Asset content size exceeds the supported range."));
            byteCount += static_cast<std::uint64_t>((*chunk)->blob.size());
            hash.update((*chunk)->blob);
            if (auto status = visitor((*chunk)->blob); !status)
                return status;
        }
    }
    auto expectedByteCount = parseUnsigned(domain::getField(metadata, "byte_size"), "byte size");
    if (!expectedByteCount || *expectedByteCount != byteCount ||
        domain::hexHash(hash.finish()) != expectedHash) {
        return std::unexpected(fileError("asset_content_integrity_failed",
                                         "Asset byte count or SHA-256 does not match."));
    }
    return {};
}

} // namespace tutorux::assets
