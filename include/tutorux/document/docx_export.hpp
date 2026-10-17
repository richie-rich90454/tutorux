#pragma once

#include "tutorux/core/result.hpp"
#include "tutorux/domain/guide.hpp"

#include <string>

namespace tutorux::document {

    core::Result<std::string> renderGuideDocx(const domain::GuideDocument& guide);

} // namespace tutorux::document
