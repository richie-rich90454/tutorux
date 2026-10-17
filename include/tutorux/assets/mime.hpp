#pragma once

#include <cstddef>
#include <span>
#include <string_view>

namespace tutorux::assets {

    std::string_view detectMimeType(std::string_view fileName,
                                    std::span<const std::byte> content) noexcept;

} // namespace tutorux::assets
