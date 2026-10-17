#pragma once

#include "tutorux/ai/http.hpp"

#include <cstdint>
#include <functional>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::ai {

    struct ProviderModel final {
        std::string id;
        std::string owner;
    };

    struct GenerationRequest final {
        std::string endpoint;
        std::string modelId;
        std::string apiKey;
        std::string systemPrompt;
        std::string userContent;
        std::uint32_t maximumOutputTokens{4096};
        bool useMaxCompletionTokens{};
        std::function<bool()> cancelled;
        std::function<void(std::string_view)> onText;
    };

    struct GenerationResponse final {
        long statusCode{};
        std::string content;
        std::string rawResponse;
        std::string responseId;
        std::string resolvedModelId;
        std::string retryAfter;
        std::string errorCode;
        std::string errorMessage;
        bool cancelled{};
        bool responseTooLarge{};
    };

    core::Result<std::vector<ProviderModel>>
    listOpenAiCompatibleModels(std::string_view endpoint, std::string_view apiKey,
                               std::function<bool()> cancelled = {});
    core::Result<GenerationResponse> generateOpenAiCompatible(GenerationRequest request);

} // namespace tutorux::ai
