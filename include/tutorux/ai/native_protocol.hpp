#pragma once

#include "tutorux/ai/openai_compatible.hpp"

#include <string>
#include <string_view>
#include <vector>

namespace tutorux::ai {

    enum class NativeProtocol {
        anthropicMessages,
        geminiGenerateContent,
        cohereChatV2,
        perplexityAgent,
    };

    std::string nativeGenerationEndpoint(NativeProtocol protocol, std::string_view endpoint,
                                         std::string_view modelId);
    core::Result<std::string> nativeGenerationRequestBody(NativeProtocol protocol,
                                                          std::string_view modelId,
                                                          std::string_view systemPrompt,
                                                          std::string_view userContent,
                                                          std::uint32_t maximumOutputTokens);
    core::Result<std::vector<ProviderModel>> listNativeModels(NativeProtocol protocol,
                                                              std::string_view endpoint,
                                                              std::string_view apiKey,
                                                              std::function<bool()> cancelled = {});
    core::Result<std::vector<ProviderModel>>
    listAlibabaModelStudioModels(std::string_view compatibleEndpoint, std::string_view apiKey,
                                 std::function<bool()> cancelled = {});
    core::Result<GenerationResponse> generateNative(GenerationRequest request,
                                                    NativeProtocol protocol);

} // namespace tutorux::ai
