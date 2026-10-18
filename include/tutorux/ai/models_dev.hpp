#pragma once

#include "tutorux/ai/openai_compatible.hpp"

#include <functional>
#include <optional>
#include <string_view>
#include <vector>

namespace tutorux::ai {

core::Result<std::vector<ProviderModel>>
listModelsDevProviderModels(std::string_view providerId, std::function<bool()> cancelled = {});
std::optional<std::string_view> modelsDevProviderCatalogId(std::string_view providerId) noexcept;

} // namespace tutorux::ai
