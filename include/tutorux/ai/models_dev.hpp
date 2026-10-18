#pragma once

#include "tutorux/ai/openai_compatible.hpp"

#include <functional>
#include <string_view>
#include <vector>

namespace tutorux::ai {

core::Result<std::vector<ProviderModel>>
listModelsDevProviderModels(std::string_view providerId, std::function<bool()> cancelled = {});

} // namespace tutorux::ai
