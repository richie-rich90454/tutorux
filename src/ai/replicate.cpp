#include "tutorux/ai/replicate.hpp"

#include "tutorux/ai/http.hpp"
#include "tutorux/command/json.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <ranges>
#include <string_view>
#include <thread>
#include <unordered_set>
#include <utility>

#include <sodium.h>

namespace tutorux::ai {
namespace {

    using command::JsonValue;

    constexpr std::string_view apiRoot = "https://api.replicate.com/v1";
    constexpr std::size_t maximumModelResults = 500;
    constexpr std::size_t maximumResponseBytes = 8U * 1024U * 1024U;
    constexpr std::size_t maximumGeneratedBytes = 8U * 1024U * 1024U;

    class StringWiper final {
      public:
        explicit StringWiper(std::string& value)
            : value_(value) {}
        ~StringWiper() {
            if (!value_.empty())
                sodium_memzero(value_.data(), value_.size());
        }

      private:
        std::string& value_;
    };

    const JsonValue* member(const JsonValue::Object& object, std::string_view name) {
        const auto found = object.find(name);
        return found == object.end() ? nullptr : &found->second;
    }

    const JsonValue::Object* objectAt(const JsonValue* value) {
        return value ? value->asObject() : nullptr;
    }

    const JsonValue::Array* arrayAt(const JsonValue* value) {
        return value ? value->asArray() : nullptr;
    }

    std::string stringAt(const JsonValue::Object& object, std::string_view name) {
        const JsonValue* value = member(object, name);
        return value && value->asString() ? *value->asString() : std::string{};
    }

    bool booleanAt(const JsonValue::Object& object, std::string_view name) {
        const JsonValue* value = member(object, name);
        const bool* boolean = value ? std::get_if<bool>(&value->value) : nullptr;
        return boolean && *boolean;
    }

    std::string encodeQuery(std::string_view value) {
        static constexpr char digits[] = "0123456789ABCDEF";
        std::string encoded;
        for (const char rawCharacter : value) {
            const auto character = static_cast<unsigned char>(rawCharacter);
            const bool unreserved = (character >= 'a' && character <= 'z') ||
                                    (character >= 'A' && character <= 'Z') ||
                                    (character >= '0' && character <= '9') || character == '-' ||
                                    character == '.' || character == '_' || character == '~';
            if (unreserved) {
                encoded.push_back(static_cast<char>(character));
            } else {
                encoded.push_back('%');
                encoded.push_back(digits[character >> 4U]);
                encoded.push_back(digits[character & 0x0FU]);
            }
        }
        return encoded;
    }

    bool validModelPart(std::string_view value) {
        return !value.empty() && value.size() <= 128 &&
               std::ranges::all_of(value, [](const unsigned char character) {
                   return std::isalnum(character) != 0 || character == '-' || character == '_' ||
                          character == '.';
               });
    }

    core::Result<std::pair<std::string, std::string>> splitModelId(std::string_view modelId) {
        const auto slash = modelId.find('/');
        if (slash == std::string_view::npos ||
            modelId.find('/', slash + 1U) != std::string_view::npos) {
            return std::unexpected(
                core::error("ai_model_id_invalid",
                            "Replicate model IDs must use the owner/model format."));
        }
        const auto owner = modelId.substr(0, slash);
        const auto name = modelId.substr(slash + 1U);
        if (!validModelPart(owner) || !validModelPart(name)) {
            return std::unexpected(
                core::error("ai_model_id_invalid",
                            "Replicate owner and model IDs contain invalid characters."));
        }
        return std::pair<std::string, std::string>{owner, name};
    }

    HttpRequest
    baseRequest(std::string url, std::string_view apiToken, std::function<bool()> cancelled) {
        HttpRequest request;
        request.url = std::move(url);
        request.headers.emplace_back("Authorization", "Bearer " + std::string(apiToken));
        request.timeout = std::chrono::seconds(65);
        request.maximumResponseBytes = maximumResponseBytes;
        request.cancelled = std::move(cancelled);
        return request;
    }

    core::Error responseError(const HttpResponse& response, std::string_view operation) {
        if (response.cancelled)
            return core::error("operation_cancelled",
                               "Replicate " + std::string(operation) + " was cancelled.");
        if (response.responseTooLarge)
            return core::error("ai_response_too_large",
                               "Replicate " + std::string(operation) + " exceeded 8 MiB.");
        if (!response.transportError.empty())
            return core::error("ai_network_error",
                               "Replicate request failed: " + response.transportError);
        if (response.statusCode == 401 || response.statusCode == 403)
            return core::error("ai_authentication_failed",
                               "Replicate rejected the API token or model access.");
        if (response.statusCode == 429)
            return core::error("ai_rate_limited", "Replicate rate limited the request.");
        return core::error("ai_provider_http_error",
                           "Replicate " + std::string(operation) + " returned HTTP " +
                               std::to_string(response.statusCode) + ".");
    }

    core::Result<JsonValue> parseObject(std::string_view text, std::string_view context) {
        auto parsed = command::parseJson(text, 48, 300'000, maximumResponseBytes);
        if (!parsed || !parsed->asObject()) {
            return std::unexpected(
                core::error("ai_provider_response_invalid",
                            "Replicate " + std::string(context) + " returned invalid JSON."));
        }
        return std::move(*parsed);
    }

    core::Result<HttpResponse> performChecked(HttpRequest request, std::string_view operation) {
        auto response = performHttp(std::move(request));
        if (!response)
            return std::unexpected(response.error());
        if (response->statusCode < 200 || response->statusCode >= 300 || response->cancelled ||
            response->responseTooLarge || !response->transportError.empty()) {
            return std::unexpected(responseError(*response, operation));
        }
        return response;
    }

    std::string modelIdAt(const JsonValue::Object& model) {
        const std::string owner = stringAt(model, "owner");
        const std::string name = stringAt(model, "name");
        if (!owner.empty() && !name.empty())
            return owner + "/" + name;
        return stringAt(model, "id");
    }

    std::string outputText(const JsonValue& value) {
        if (const auto* text = value.asString())
            return *text;
        const auto* values = value.asArray();
        if (!values)
            return {};
        std::string combined;
        for (const auto& item : *values) {
            const auto* text = item.asString();
            if (!text)
                return {};
            if (text->size() > maximumGeneratedBytes - combined.size())
                return {};
            combined.append(*text);
        }
        return combined;
    }

    core::Result<std::string> predictionStatusText(std::string_view body,
                                                   GenerationResponse& result) {
        auto parsed = parseObject(body, "prediction");
        if (!parsed)
            return std::unexpected(parsed.error());
        const auto* object = parsed->asObject();
        result.responseId = stringAt(*object, "id");
        const std::string status = stringAt(*object, "status");
        if (status == "failed") {
            const JsonValue* error = member(*object, "error");
            const auto* message = error ? error->asString() : nullptr;
            result.errorCode = "ai_generation_failed";
            result.errorMessage =
                message && !message->empty() ? *message : "The Replicate prediction failed.";
            return std::string{};
        }
        if (status == "canceled" || status == "cancelled") {
            result.cancelled = true;
            result.errorCode = "operation_cancelled";
            result.errorMessage = "The Replicate prediction was cancelled.";
            return std::string{};
        }
        if (status != "succeeded")
            return std::string{};
        const JsonValue* output = member(*object, "output");
        std::string text = output ? outputText(*output) : std::string{};
        if (text.empty() || text.size() > maximumGeneratedBytes) {
            result.errorCode = "ai_response_empty";
            result.errorMessage = "The Replicate model returned no plain-text output.";
            return std::string{};
        }
        return text;
    }

    void cancelPrediction(std::string_view predictionId, std::string_view apiToken) {
        if (predictionId.empty() || predictionId.size() > 128 ||
            std::ranges::any_of(predictionId, [](const unsigned char character) {
                return std::isalnum(character) == 0 && character != '-';
            })) {
            return;
        }
        HttpRequest request = baseRequest(std::string(apiRoot) + "/predictions/" +
                                              std::string(predictionId) + "/cancel",
                                          apiToken,
                                          {});
        request.method = "POST";
        request.timeout = std::chrono::seconds(10);
        request.maximumResponseBytes = 1024U * 1024U;
        static_cast<void>(performHttp(std::move(request)));
    }

} // namespace

core::Result<std::vector<ProviderModel>> listReplicateModels(std::string_view apiToken,
                                                             std::function<bool()> cancelled) {
    if (apiToken.empty()) {
        return std::unexpected(
            core::error("ai_api_key_missing", "Set REPLICATE_API_TOKEN before model discovery."));
    }
    static constexpr std::array queries{"language model",
                                        "text generation",
                                        "chat model",
                                        "instruction following",
                                        "text completion"};
    std::vector<ProviderModel> models;
    std::unordered_set<std::string> seen;
    for (const std::string_view query : queries) {
        if (cancelled && cancelled())
            return std::unexpected(
                core::error("operation_cancelled", "Replicate model discovery was cancelled."));
        HttpRequest request =
            baseRequest(std::string(apiRoot) + "/search?query=" + encodeQuery(query) + "&limit=50",
                        apiToken,
                        cancelled);
        auto response = performChecked(std::move(request), "model search");
        if (!response)
            return std::unexpected(response.error());
        auto parsed = parseObject(response->body, "model search");
        if (!parsed)
            return std::unexpected(parsed.error());
        const auto* root = parsed->asObject();
        const JsonValue::Array* entries = arrayAt(member(*root, "models"));
        if (!entries)
            entries = arrayAt(member(*root, "results"));
        if (!entries)
            entries = arrayAt(member(*root, "data"));
        if (!entries || entries->size() > 50) {
            return std::unexpected(
                core::error("ai_model_catalog_invalid",
                            "Replicate returned an invalid model search result."));
        }
        for (const auto& entry : *entries) {
            const auto* model = entry.asObject();
            if (!model)
                continue;
            const std::string id = modelIdAt(*model);
            auto split = splitModelId(id);
            if (!split || !seen.insert(id).second)
                continue;
            const std::string owner = stringAt(*model, "owner");
            models.push_back({id, owner});
            if (models.size() > maximumModelResults) {
                return std::unexpected(core::error("ai_model_catalog_too_large",
                                                   "Replicate model search exceeded 500 results."));
            }
        }
    }
    std::sort(models.begin(),
              models.end(),
              [](const ProviderModel& left, const ProviderModel& right) {
                  return left.id < right.id;
              });
    return models;
}

core::Result<ReplicateGenerationPlan> prepareReplicateGeneration(const GenerationRequest& request) {
    if (request.apiKey.empty()) {
        return std::unexpected(
            core::error("ai_api_key_missing", "Set REPLICATE_API_TOKEN before generation."));
    }
    auto ownerAndName = splitModelId(request.modelId);
    if (!ownerAndName)
        return std::unexpected(ownerAndName.error());
    if (request.userContent.size() > maximumGeneratedBytes ||
        request.systemPrompt.size() > maximumGeneratedBytes - request.userContent.size()) {
        return std::unexpected(
            core::error("ai_package_too_large",
                        "The Replicate prompt exceeds the 8 MiB request limit."));
    }
    const std::string url =
        std::string(apiRoot) + "/models/" + ownerAndName->first + "/" + ownerAndName->second;
    HttpRequest metadataRequest;
    metadataRequest.url = url;
    metadataRequest.headers.emplace_back("Authorization", "Bearer " + request.apiKey);
    metadataRequest.timeout = std::chrono::seconds(30);
    metadataRequest.maximumResponseBytes = maximumResponseBytes;
    metadataRequest.cancelled = request.cancelled;
    auto response = performChecked(std::move(metadataRequest), "model inspection");
    if (!response)
        return std::unexpected(response.error());
    auto parsed = parseObject(response->body, "model metadata");
    if (!parsed)
        return std::unexpected(parsed.error());
    const auto* root = parsed->asObject();
    const auto* latest = objectAt(member(*root, "latest_version"));
    const std::string version = latest ? stringAt(*latest, "id") : std::string{};
    const auto* schema = latest ? objectAt(member(*latest, "openapi_schema")) : nullptr;
    const auto* components = schema ? objectAt(member(*schema, "components")) : nullptr;
    const auto* schemas = components ? objectAt(member(*components, "schemas")) : nullptr;
    const auto* input = schemas ? objectAt(member(*schemas, "Input")) : nullptr;
    const auto* properties = input ? objectAt(member(*input, "properties")) : nullptr;
    const auto* prompt = properties ? objectAt(member(*properties, "prompt")) : nullptr;
    if (version.empty() || !properties || !prompt || stringAt(*prompt, "type") != "string") {
        return std::unexpected(core::error(
            "ai_model_capability_unsupported",
            "Replicate generation requires a versioned model with a string prompt input."));
    }
    const auto* required = input ? arrayAt(member(*input, "required")) : nullptr;
    const auto* systemPromptInput = objectAt(member(*properties, "system_prompt"));
    const bool hasSystemPrompt =
        systemPromptInput && stringAt(*systemPromptInput, "type") == "string";
    std::string tokenInputName;
    for (const std::string_view candidate : {"max_new_tokens", "max_tokens", "max_output_tokens"}) {
        const auto* property = objectAt(member(*properties, candidate));
        if (property && stringAt(*property, "type") == "integer") {
            tokenInputName = candidate;
            break;
        }
    }
    for (const auto& requiredValue : required ? *required : JsonValue::Array{}) {
        const auto* name = requiredValue.asString();
        if (!name)
            continue;
        if (*name != "prompt" && *name != "system_prompt" && *name != tokenInputName) {
            return std::unexpected(core::error(
                "ai_model_capability_unsupported",
                "The selected Replicate model requires an input Tutorux cannot safely infer: '" +
                    *name + "'."));
        }
        if (*name == "system_prompt" && !hasSystemPrompt) {
            return std::unexpected(core::error(
                "ai_model_capability_unsupported",
                "The selected Replicate model requires a supported system_prompt input."));
        }
    }
    for (const auto& [name, value] : *properties) {
        const auto* property = value.asObject();
        if (property && booleanAt(*property, "x-cog-secret") && required &&
            std::ranges::any_of(*required, [&](const JsonValue& requiredValue) {
                const auto* requiredName = requiredValue.asString();
                return requiredName && *requiredName == name;
            })) {
            return std::unexpected(core::error(
                "ai_model_secret_input_unsupported",
                "The selected Replicate model requires an author-defined secret input."));
        }
    }

    std::string promptText;
    StringWiper promptTextWiper(promptText);
    if (hasSystemPrompt) {
        promptText = request.userContent;
    } else {
        promptText.reserve(request.systemPrompt.size() + 2U + request.userContent.size());
        promptText = request.systemPrompt;
        promptText += "\n\n";
        promptText += request.userContent;
    }
    std::string body = "{\"input\":{\"prompt\":\"" + command::jsonEscape(promptText) + "\"";
    if (hasSystemPrompt)
        body += ",\"system_prompt\":\"" + command::jsonEscape(request.systemPrompt) + "\"";
    if (!tokenInputName.empty())
        body += ",\"" + tokenInputName + "\":" + std::to_string(request.maximumOutputTokens);
    body += "}}";
    if (body.size() > maximumResponseBytes ||
        !command::parseJson(body, 32, 100'000, maximumResponseBytes)) {
        sodium_memzero(body.data(), body.size());
        return std::unexpected(
            core::error("ai_request_invalid", "The Replicate request exceeds its 8 MiB limit."));
    }
    return ReplicateGenerationPlan{request.modelId,
                                   version,
                                   std::string(apiRoot) + "/models/" + ownerAndName->first + "/" +
                                       ownerAndName->second + "/predictions",
                                   std::move(body)};
}

core::Result<GenerationResponse> generateReplicate(GenerationRequest request,
                                                   ReplicateGenerationPlan plan) {
    GenerationResponse generated;
    StringWiper keyWiper(request.apiKey);
    StringWiper bodyWiper(plan.requestBody);
    if (plan.requestBody.empty() || request.apiKey.empty())
        return std::unexpected(core::error("ai_generation_request_invalid",
                                           "The Replicate generation plan is incomplete."));
    HttpRequest createRequest = baseRequest(plan.endpoint, request.apiKey, request.cancelled);
    createRequest.method = "POST";
    createRequest.headers.emplace_back("Content-Type", "application/json");
    createRequest.headers.emplace_back("Prefer", "wait=60");
    createRequest.body = plan.requestBody;
    createRequest.timeout = std::chrono::seconds(65);
    auto response = performHttp(std::move(createRequest));
    if (!response)
        return std::unexpected(response.error());
    generated.statusCode = response->statusCode;
    generated.rawResponse = std::move(response->body);
    generated.cancelled = response->cancelled;
    generated.responseTooLarge = response->responseTooLarge;
    if (response->statusCode < 200 || response->statusCode >= 300 || response->cancelled ||
        response->responseTooLarge || !response->transportError.empty()) {
        const auto error = responseError(*response, "prediction creation");
        generated.errorCode = error.code;
        generated.errorMessage = error.message;
        return generated;
    }

    auto prediction = parseObject(generated.rawResponse, "prediction creation");
    if (!prediction)
        return std::unexpected(prediction.error());
    const auto* predictionObject = prediction->asObject();
    const std::string predictionId = stringAt(*predictionObject, "id");
    if (predictionId.empty() || predictionId.size() > 128 ||
        std::ranges::any_of(predictionId, [](const unsigned char character) {
            return std::isalnum(character) == 0 && character != '-';
        })) {
        return std::unexpected(core::error("ai_provider_response_invalid",
                                           "Replicate returned an invalid prediction ID."));
    }
    const std::string getUrl = std::string(apiRoot) + "/predictions/" + predictionId;
    auto text = predictionStatusText(generated.rawResponse, generated);
    if (!text)
        return std::unexpected(text.error());
    if (!text->empty()) {
        generated.content = std::move(*text);
        if (request.onText)
            request.onText(generated.content);
        return generated;
    }
    if (!generated.errorCode.empty())
        return generated;

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(5);
    std::chrono::milliseconds delay{500};
    while (std::chrono::steady_clock::now() < deadline) {
        if (request.cancelled && request.cancelled()) {
            cancelPrediction(predictionId, request.apiKey);
            generated.cancelled = true;
            generated.errorCode = "operation_cancelled";
            generated.errorMessage = "Replicate prediction cancellation was requested.";
            return generated;
        }
        std::this_thread::sleep_for(delay);
        HttpRequest pollRequest = baseRequest(getUrl, request.apiKey, request.cancelled);
        pollRequest.timeout = std::chrono::seconds(20);
        auto poll = performHttp(std::move(pollRequest));
        if (!poll)
            return std::unexpected(poll.error());
        generated.statusCode = poll->statusCode;
        if (poll->statusCode < 200 || poll->statusCode >= 300 || poll->cancelled ||
            poll->responseTooLarge || !poll->transportError.empty()) {
            const auto error = responseError(*poll, "prediction polling");
            generated.errorCode = error.code;
            generated.errorMessage = error.message;
            return generated;
        }
        if (!generated.rawResponse.empty())
            sodium_memzero(generated.rawResponse.data(), generated.rawResponse.size());
        generated.rawResponse = std::move(poll->body);
        text = predictionStatusText(generated.rawResponse, generated);
        if (!text)
            return std::unexpected(text.error());
        if (!text->empty()) {
            generated.content = std::move(*text);
            if (request.onText)
                request.onText(generated.content);
            return generated;
        }
        if (!generated.errorCode.empty())
            return generated;
        delay = std::min(delay + std::chrono::milliseconds(500), std::chrono::milliseconds(5'000));
    }
    cancelPrediction(predictionId, request.apiKey);
    generated.errorCode = "ai_prediction_timeout";
    generated.errorMessage = "Replicate prediction exceeded the five-minute wait limit.";
    return generated;
}

} // namespace tutorux::ai
