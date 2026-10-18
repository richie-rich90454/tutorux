#pragma once

#include "tutorux/ai/openai_compatible.hpp"

namespace tutorux::ai {

struct ReplicateGenerationPlan final {
    std::string modelId;
    std::string modelVersion;
    std::string endpoint;
    std::string requestBody;
};

core::Result<std::vector<ProviderModel>> listReplicateModels(std::string_view apiToken,
                                                             std::function<bool()> cancelled = {});

core::Result<ReplicateGenerationPlan> prepareReplicateGeneration(const GenerationRequest& request);

core::Result<GenerationResponse> generateReplicate(GenerationRequest request,
                                                   ReplicateGenerationPlan plan);

} // namespace tutorux::ai
