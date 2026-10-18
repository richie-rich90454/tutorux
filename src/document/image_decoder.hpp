#pragma once

#include "tutorux/core/result.hpp"

#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>
#include <vector>

namespace tutorux::document::detail {

struct DecodedRgbaImage final {
    std::uint32_t width{};
    std::uint32_t height{};
    std::vector<std::uint8_t> pixels;
};

core::Result<DecodedRgbaImage> decodePortableImage(std::string_view mimeType,
                                                   std::span<const std::byte> encoded);

} // namespace tutorux::document::detail
