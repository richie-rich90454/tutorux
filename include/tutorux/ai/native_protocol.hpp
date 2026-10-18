#pragma once

#include "tutorux/ai/openai_compatible.hpp"

#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::ai {

enum class NativeProtocol {
    anthropicMessages,
    geminiGenerateContent,
    openAiResponses,
    cohereChatV2,
    perplexityAgent,
    ollamaChat,
};

struct OllamaModelDetails final {
    std::string family;
    std::string parameterSize;
    std::string quantizationLevel;
    std::vector<std::string> capabilities;
    std::uint64_t contextLength{};
};

std::string nativeGenerationEndpoint(NativeProtocol protocol,
                                     std::string_view endpoint,
                                     std::string_view modelId,
                                     bool enableStreaming = true);
core::Result<std::string> nativeGenerationRequestBody(NativeProtocol protocol,
                                                      std::string_view modelId,
                                                      std::string_view systemPrompt,
                                                      std::string_view userContent,
                                                      std::uint32_t maximumOutputTokens,
                                                      std::span<const ContentPart> content = {},
                                                      bool enableStreaming = true,
                                                      bool requireStructuredOutput = false);
core::Result<std::vector<ProviderModel>> listNativeModels(NativeProtocol protocol,
                                                          std::string_view endpoint,
                                                          std::string_view apiKey,
                                                          std::function<bool()> cancelled = {});
core::Result<OllamaModelDetails> inspectOllamaModel(std::string_view endpoint,
                                                    std::string_view modelId,
                                                    std::function<bool()> cancelled = {});
core::Result<std::vector<ProviderModel>>
listAlibabaModelStudioModels(std::string_view compatibleEndpoint,
                             std::string_view apiKey,
                             std::function<bool()> cancelled = {});
core::Result<GenerationResponse> generateNative(GenerationRequest request, NativeProtocol protocol);

} // namespace tutorux::ai
