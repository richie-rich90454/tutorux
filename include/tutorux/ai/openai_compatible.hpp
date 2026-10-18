#pragma once

#include "tutorux/ai/http.hpp"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace tutorux::ai {

struct TextContentPart final {
    std::string text;
};

struct ImageContentPart final {
    std::string mediaType;
    std::string fileName;
    std::vector<std::byte> bytes;
};

struct AudioContentPart final {
    std::string mediaType;
    std::string fileName;
    std::vector<std::byte> bytes;
    std::string transcript;
};

struct DocumentContentPart final {
    std::string mediaType;
    std::string fileName;
    std::vector<std::byte> bytes;
    std::string extractedText;
};

struct VideoFrameContentPart final {
    std::int64_t timestampUs{};
    ImageContentPart image;
};

struct VideoContentPart final {
    std::string fileName;
    std::string mediaType;
    std::vector<std::byte> bytes;
    std::vector<VideoFrameContentPart> frames;
    std::string transcript;
};

using ContentPart = std::variant<TextContentPart,
                                 ImageContentPart,
                                 AudioContentPart,
                                 DocumentContentPart,
                                 VideoContentPart>;

enum class ContentSerialization {
    openAiChat,
    openAiResponses,
    anthropicMessages,
    gemini,
    ollama,
    textOnly,
};

core::Result<std::string> serializeContentParts(std::span<const ContentPart> content,
                                                std::string_view fallbackText,
                                                ContentSerialization serialization);

struct ProviderModel final {
    ProviderModel() = default;
    ProviderModel(std::string modelId, std::string modelOwner = {})
        : id(std::move(modelId))
        , owner(std::move(modelOwner)) {}

    std::string id;
    std::string owner;
    std::string protocolFamily{"openai-chat-completions"};
    std::string contextWindow;
    std::string maximumOutputTokens;
    std::string inputModalities{"unknown"};
    std::string outputModalities{"unknown"};
    std::string structuredOutputSupport{"unknown"};
    std::string streamingSupport{"unknown"};
    std::string toolSupport{"unknown"};
    std::string tokenizerInformation{"unknown"};
    std::string pricingInformation{"unknown"};
    std::string availabilityStatus{"unknown"};
    std::string verificationStatus{"discovered-not-verified"};
    std::string metadataSource{"provider-model-api"};
};

struct GenerationRequest final {
    std::string providerId;
    std::string endpoint;
    std::string modelId;
    std::string apiKey;
    std::string apiKeyHeaderName;
    std::string systemPrompt;
    std::string userContent;
    std::vector<ContentPart> content;
    std::uint32_t maximumOutputTokens{4096};
    bool requireStructuredOutput{};
    bool enableStreaming{true};
    bool useMaxCompletionTokens{};
    std::function<bool()> cancelled;
    std::function<void(std::string_view)> onText;
};

void wipeGenerationInput(GenerationRequest& request) noexcept;
void wipeContentParts(std::vector<ContentPart>& content) noexcept;

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
listOpenAiCompatibleModels(std::string_view endpoint,
                           std::string_view apiKey,
                           std::function<bool()> cancelled = {},
                           std::string_view apiKeyHeaderName = "Authorization");
core::Result<GenerationResponse> generateOpenAiCompatible(GenerationRequest request);

} // namespace tutorux::ai
