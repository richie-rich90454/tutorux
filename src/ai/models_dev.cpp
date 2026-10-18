#include "tutorux/ai/models_dev.hpp"

#include "tutorux/ai/http.hpp"
#include "tutorux/command/json.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>

namespace tutorux::ai {
namespace {

    constexpr std::size_t maximumModels = 50'000;
    constexpr std::size_t maximumResponseBytes = 32U * 1024U * 1024U;

    const command::JsonValue* member(const command::JsonValue::Object& object,
                                     std::string_view key) {
        const auto found = object.find(key);
        return found == object.end() ? nullptr : &found->second;
    }

    std::string stringField(const command::JsonValue::Object& object, std::string_view key) {
        const auto* value = member(object, key);
        const auto* text = value ? value->asString() : nullptr;
        return text ? *text : std::string{};
    }

    std::string scalarField(const command::JsonValue::Object& object, std::string_view key) {
        const auto* value = member(object, key);
        if (!value)
            return {};
        if (const auto* number = std::get_if<command::JsonNumber>(&value->value))
            return number->text;
        if (const auto* text = value->asString())
            return *text;
        return {};
    }

    std::string boolCapability(const command::JsonValue::Object& object, std::string_view key) {
        const auto* value = member(object, key);
        const auto* flag = value ? std::get_if<bool>(&value->value) : nullptr;
        return flag ? (*flag ? "supported" : "unsupported") : "unknown";
    }

    std::string joinStringList(const command::JsonValue::Array& values) {
        std::string result;
        for (const auto& item : values) {
            const auto* text = item.asString();
            if (!text || text->empty())
                continue;
            if (!result.empty())
                result.push_back(',');
            result += *text;
        }
        return result;
    }

    std::string priceInformation(const command::JsonValue::Object& object) {
        std::string result;
        for (const std::string_view key : {"input", "output", "cache_read", "cache_write"}) {
            const std::string value = scalarField(object, key);
            if (value.empty())
                continue;
            if (!result.empty())
                result.push_back(';');
            result += key;
            result.push_back('=');
            result += value;
        }
        return result;
    }

    core::Error responseError(const HttpResponse& response) {
        if (response.cancelled) {
            return core::error("operation_cancelled",
                               "The models.dev catalog request was cancelled.");
        }
        if (response.responseTooLarge) {
            return core::error("ai_model_catalog_too_large",
                               "The models.dev catalog exceeded the response limit.");
        }
        if (!response.transportError.empty()) {
            return core::error("ai_model_catalog_unavailable",
                               "The models.dev catalog request failed: " + response.transportError);
        }
        return core::error("ai_model_catalog_unavailable", "The models.dev catalog returned HTTP " +
                                                               std::to_string(response.statusCode) +
                                                               ".");
    }

} // namespace

std::optional<std::string_view> modelsDevProviderCatalogId(std::string_view providerId) noexcept {
    static constexpr std::array<std::pair<std::string_view, std::string_view>, 34> mappings{
        {
         {"openai", "openai"},
         {"anthropic", "anthropic"},
         {"google-gemini", "google"},
         {"xai", "xai"},
         {"openrouter", "openrouter"},
         {"together", "togetherai"},
         {"fireworks", "fireworks"},
         {"deepinfra", "deepinfra"},
         {"novita", "novita"},
         {"nebius", "nebius"},
         {"groq", "groq"},
         {"cerebras", "cerebras"},
         {"sambanova", "sambanova"},
         {"nvidia", "nvidia"},
         {"deepseek", "deepseek"},
         {"mistral", "mistral"},
         {"cohere", "cohere"},
         {"perplexity", "perplexity"},
         {"huggingface", "huggingface"},
         {"replicate", "replicate"},
         {"cloudflare-workers-ai", "cloudflare"},
         {"moonshot", "moonshotai"},
         {"zai", "zai"},
         {"minimax", "minimax"},
         {"siliconflow", "siliconflow"},
         {"ai21", "ai21"},
         {"bedrock", "amazon-bedrock"},
         {"azure-openai", "azure"},
         {"alibaba-cloud", "alibaba"},
         {"baidu", "baidu"},
         {"tencent-cloud", "tencent"},
         {"volcengine", "volcengine"},
         {"opencode-go", "opencode"},
         {"opencode-zen", "opencode"},
         }
    };
    const auto found = std::find_if(mappings.begin(), mappings.end(), [&](const auto& mapping) {
        return mapping.first == providerId;
    });
    return found == mappings.end() ? std::nullopt : std::optional<std::string_view>{found->second};
}

core::Result<std::vector<ProviderModel>>
listModelsDevProviderModels(std::string_view providerId, std::function<bool()> cancelled) {
    const auto catalogProviderId = modelsDevProviderCatalogId(providerId);
    if (!catalogProviderId) {
        return std::unexpected(
            core::error("ai_provider_id_invalid", "The models.dev provider ID is invalid."));
    }

    HttpRequest request;
    request.url = "https://models.dev/api.json";
    request.maximumResponseBytes = maximumResponseBytes;
    request.timeout = std::chrono::seconds(30);
    request.cancelled = cancelled;
    auto response = performHttp(std::move(request));
    if (!response)
        return std::unexpected(response.error());
    if (response->statusCode < 200 || response->statusCode >= 300 || response->cancelled ||
        response->responseTooLarge || !response->transportError.empty()) {
        return std::unexpected(responseError(*response));
    }

    auto parsed = command::parseJson(response->body, 64, 1'000'000, maximumResponseBytes);
    if (!parsed) {
        return std::unexpected(core::error("ai_model_catalog_invalid",
                                           "models.dev returned an invalid provider catalog."));
    }
    const auto* root = parsed->asObject();
    const auto* providerValue = root ? member(*root, *catalogProviderId) : nullptr;
    const auto* provider = providerValue ? providerValue->asObject() : nullptr;
    const auto* modelsValue = provider ? member(*provider, "models") : nullptr;
    const auto* providerModels = modelsValue ? modelsValue->asObject() : nullptr;
    if (!provider || !providerModels || providerModels->size() > maximumModels) {
        return std::unexpected(
            core::error("ai_model_catalog_unavailable",
                        "models.dev does not currently publish a model catalog for provider '" +
                            std::string(*catalogProviderId) + "'."));
    }

    const std::string owner = stringField(*provider, "name");
    std::vector<ProviderModel> models;
    models.reserve(providerModels->size());
    std::unordered_set<std::string> seenIds;
    seenIds.reserve(providerModels->size());
    for (const auto& [catalogKey, value] : *providerModels) {
        const auto* model = value.asObject();
        std::string modelId = model ? stringField(*model, "id") : std::string{};
        if (modelId.empty())
            modelId = catalogKey;
        if (modelId.empty() || modelId.size() > 1024) {
            return std::unexpected(core::error("ai_model_catalog_invalid",
                                               "models.dev returned a model with an invalid ID."));
        }
        if (!seenIds.insert(modelId).second)
            continue;

        ProviderModel descriptor{std::move(modelId), owner};
        descriptor.metadataSource = "models.dev";
        descriptor.availabilityStatus = stringField(*model, "status");
        if (descriptor.availabilityStatus.empty())
            descriptor.availabilityStatus = "unknown";
        descriptor.tokenizerInformation = stringField(*model, "tokenizer");
        if (descriptor.tokenizerInformation.empty())
            descriptor.tokenizerInformation = "unknown";
        descriptor.toolSupport = boolCapability(*model, "tool_call");

        if (const auto* limitValue = member(*model, "limit")) {
            if (const auto* limit = limitValue->asObject()) {
                descriptor.contextWindow = scalarField(*limit, "context");
                descriptor.maximumOutputTokens = scalarField(*limit, "output");
            }
        }
        if (const auto* modalitiesValue = member(*model, "modalities")) {
            if (const auto* modalities = modalitiesValue->asObject()) {
                const auto* inputValue = member(*modalities, "input");
                const auto* input = inputValue ? inputValue->asArray() : nullptr;
                const auto* outputValue = member(*modalities, "output");
                const auto* output = outputValue ? outputValue->asArray() : nullptr;
                const std::string inputNames = input ? joinStringList(*input) : std::string{};
                const std::string outputNames = output ? joinStringList(*output) : std::string{};
                if (!inputNames.empty())
                    descriptor.inputModalities = inputNames;
                if (!outputNames.empty())
                    descriptor.outputModalities = outputNames;
            }
        }
        if (const auto* costValue = member(*model, "cost")) {
            if (const auto* cost = costValue->asObject())
                descriptor.pricingInformation = priceInformation(*cost);
        }
        if (descriptor.pricingInformation.empty())
            descriptor.pricingInformation = "unknown";
        models.push_back(std::move(descriptor));
    }
    std::sort(models.begin(), models.end(),
              [](const ProviderModel& left, const ProviderModel& right) {
                  return left.id < right.id;
              });
    return models;
}

} // namespace tutorux::ai
