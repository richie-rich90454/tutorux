#pragma once

#include "tutorux/core/result.hpp"

#include <cstddef>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace tutorux::command {

struct ZipEntry final {
    std::string path;
    std::vector<std::byte> contents;
};

core::Result<std::vector<std::byte>> encodeStoredZip(std::span<const ZipEntry> entries);

} // namespace tutorux::command
