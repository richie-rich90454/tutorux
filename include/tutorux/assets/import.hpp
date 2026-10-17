#pragma once

#include "tutorux/core/result.hpp"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
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

} // namespace tutorux::assets
