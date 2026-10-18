#pragma once

#include "tutorux/core/result.hpp"
#include "tutorux/document/guide_image.hpp"
#include "tutorux/domain/guide.hpp"

#include <span>
#include <string>

namespace tutorux::document {

core::Result<std::string> renderGuidePdf(const domain::GuideDocument& guide,
                                         std::span<const GuideImageAsset> images = {});

} // namespace tutorux::document
