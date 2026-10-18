#pragma once

#include "tutorux/archive/archive.hpp"
#include "tutorux/core/result.hpp"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::assets {

struct FileInspection final {
    std::uint64_t byteSize{};
    std::string sha256;
    std::string mimeType;
};

core::Result<FileInspection> inspectFile(const std::filesystem::path& path,
                                         std::uint64_t maximumBytes);
core::Result<std::vector<std::byte>> readVerifiedFile(const std::filesystem::path& path,
                                                      const FileInspection& inspection);
struct ArchiveAssetImport final {
    archive::Record metadata;
    bool contentDeduplicated{};
    std::uint32_t chunkCount{};
};

core::Result<ArchiveAssetImport>
importIntoArchive(archive::Archive& archive,
                  const std::filesystem::path& path,
                  std::string_view sessionId = {},
                  std::uint64_t maximumBytes = std::numeric_limits<std::uint64_t>::max());
core::Status
visitArchiveAsset(const archive::Archive& archive,
                  const archive::Record& metadata,
                  const std::function<core::Status(std::span<const std::byte>)>& visitor);

} // namespace tutorux::assets
