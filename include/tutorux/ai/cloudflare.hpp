#pragma once

#include "tutorux/ai/openai_compatible.hpp"

#include <functional>
#include <string_view>
#include <vector>

namespace tutorux::ai {

core::Result<std::vector<ProviderModel>>
listCloudflareWorkersAiModels(std::string_view compatibleEndpoint,
                              std::string_view apiToken,
                              std::function<bool()> cancelled = {});

} // namespace tutorux::ai
