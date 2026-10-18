#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace tutorux::document {

struct GuideImageAsset final {
    std::string assetId;
    std::string mimeType;
    std::vector<std::byte> bytes;
};

} // namespace tutorux::document
