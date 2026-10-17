#include "tutorux/assets/import.hpp"

#include "tutorux/assets/mime.hpp"
#include "tutorux/domain/hash.hpp"

#include <algorithm>
#include <array>
#include <fstream>
#include <limits>
#include <span>
#include <utility>

namespace tutorux::assets {
    namespace {

        constexpr std::size_t ioBufferSize = 64U * 1024U;
        constexpr std::size_t signaturePrefixSize = 32;

        std::string pathFileNameUtf8(const std::filesystem::path& path) {
            const std::u8string fileName = path.filename().u8string();
            return {reinterpret_cast<const char*>(fileName.data()), fileName.size()};
        }

        core::Error fileError(std::string code, std::string message) {
            return core::error(std::move(code), std::move(message));
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
            return std::unexpected(fileError(
                "asset_size_limit", "The selected asset exceeds the configured size limit."));
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
                return std::unexpected(fileError(
                    "asset_read_failed", "The selected asset could not be read completely."));
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
            return std::unexpected(fileError(
                "asset_size_limit", "The selected asset cannot fit in one archive record."));
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
            return std::unexpected(fileError(
                "asset_source_changed", "The selected asset grew while it was being imported."));
        }
        if (input.bad()) {
            return std::unexpected(
                fileError("asset_read_failed", "The selected asset could not be read completely."));
        }

        domain::Sha256Builder hash;
        hash.update(content);
        if (domain::hexHash(hash.finish()) != inspection.sha256) {
            return std::unexpected(fileError(
                "asset_source_changed", "The selected asset changed while it was being imported."));
        }
        return content;
    }

} // namespace tutorux::assets
