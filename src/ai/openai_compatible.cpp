#include "tutorux/ai/openai_compatible.hpp"

#include "tutorux/command/json.hpp"

#include <sodium.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <string_view>
#include <unordered_set>

namespace tutorux::ai {
namespace {

    using command::JsonValue;

    constexpr std::size_t maximumModels = 50'000;
    constexpr std::size_t maximumGeneratedTextBytes = 8U * 1024U * 1024U;
    constexpr std::size_t maximumRequestBytes = 16U * 1024U * 1024U;

    bool addJsonStringSize(std::size_t& total, std::string_view value, std::size_t maximum) {
        if (total > maximum - std::min<std::size_t>(maximum, 2U))
            return false;
        total += 2U;
        for (const char rawCharacter : value) {
            const auto character = static_cast<unsigned char>(rawCharacter);
            const std::size_t byteCount =
                character < 0x20U ? 6U : (character == '"' || character == '\\' ? 2U : 1U);
            if (byteCount > maximum - total)
                return false;
            total += byteCount;
        }
        return true;
    }

    bool requestFitsLimit(const GenerationRequest& request) {
        std::size_t estimatedSize = 512U;
        return addJsonStringSize(estimatedSize, request.modelId, maximumRequestBytes) &&
               addJsonStringSize(estimatedSize, request.systemPrompt, maximumRequestBytes) &&
               addJsonStringSize(estimatedSize, request.userContent, maximumRequestBytes);
    }

    class GenerationInputWiper final {
      public:
        explicit GenerationInputWiper(GenerationRequest& request) noexcept
            : request_(request) {}
        ~GenerationInputWiper() {
            wipeGenerationInput(request_);
        }

      private:
        GenerationRequest& request_;
    };

    const JsonValue* member(const JsonValue::Object& object, std::string_view name) {
        const auto found = object.find(name);
        return found == object.end() ? nullptr : &found->second;
    }

    std::string endpointUrl(std::string_view endpoint, std::string_view path) {
        while (!endpoint.empty() && endpoint.back() == '/')
            endpoint.remove_suffix(1);
        return std::string(endpoint) + std::string(path);
    }

    core::Status validateEndpoint(std::string_view endpoint, std::string_view apiKey) {
        if (endpoint.empty() || endpoint.find_first_of("?#\r\n") != std::string_view::npos ||
            (apiKey.empty() && !isLoopbackHttpUrl(endpoint))) {
            return std::unexpected(
                core::error("ai_provider_configuration_invalid",
                            "Remote providers require HTTPS and an API key. An API key may be "
                            "omitted only for a loopback HTTP service."));
        }
        return {};
    }

    std::string authorizationHeader(std::string_view apiKey) {
        std::string header;
        header.reserve(7 + apiKey.size());
        header = "Bearer ";
        header.append(apiKey);
        return header;
    }

    core::Error httpError(const HttpResponse& response) {
        if (response.cancelled) {
            return core::error("ai_request_cancelled", "The AI request was cancelled.");
        }
        if (response.responseTooLarge) {
            return core::error("ai_response_too_large",
                               "The provider response exceeded the 16 MiB transport limit.");
        }
        if (!response.transportError.empty()) {
            return core::error("ai_network_error",
                               "The provider request failed: " + response.transportError);
        }
        if (response.statusCode == 401 || response.statusCode == 403) {
            return core::error("ai_authentication_failed",
                               "The provider rejected authentication or model access.");
        }
        if (response.statusCode == 429) {
            return core::error("ai_rate_limited",
                               response.retryAfter.empty()
                                   ? "The provider rate limit was reached."
                                   : "The provider rate limit was reached; Retry-After is " +
                                         response.retryAfter + ".");
        }
        if (response.statusCode >= 500) {
            return core::error("ai_provider_unavailable",
                               "The provider returned a server error (HTTP " +
                                   std::to_string(response.statusCode) + ").");
        }
        return core::error("ai_provider_response_invalid",
                           "The provider returned HTTP " + std::to_string(response.statusCode) +
                               ".");
    }

    const JsonValue::Object* objectAt(const JsonValue* value) {
        return value ? value->asObject() : nullptr;
    }

    const JsonValue::Array* arrayAt(const JsonValue* value) {
        return value ? value->asArray() : nullptr;
    }

    const JsonValue* firstArrayValue(const JsonValue::Array* values) {
        return values && !values->empty() ? &values->front() : nullptr;
    }

    std::string readOptionalString(const JsonValue::Object& object, std::string_view name) {
        const JsonValue* value = member(object, name);
        return value && value->asString() ? *value->asString() : std::string{};
    }

    std::string readOptionalInteger(const JsonValue::Object& object, std::string_view name) {
        const JsonValue* value = member(object, name);
        if (!value)
            return {};
        if (const auto* number = std::get_if<command::JsonNumber>(&value->value))
            return number->text;
        if (const auto* text = value->asString())
            return *text;
        return {};
    }

    std::string readStringList(const JsonValue::Object& object, std::string_view name) {
        const auto* values = arrayAt(member(object, name));
        if (!values)
            return {};
        std::string output;
        for (const auto& value : *values) {
            const auto* text = value.asString();
            if (!text || text->empty())
                continue;
            if (!output.empty())
                output.push_back(',');
            output += *text;
        }
        return output;
    }

    class EventDecoder final {
      public:
        explicit EventDecoder(const GenerationRequest& request)
            : request_(request) {}

        bool feed(std::string_view chunk) {
            if (mode_ == Mode::unknown) {
                detector_.append(chunk);
                detectMode();
                if (mode_ == Mode::unknown)
                    return true;
                if (mode_ == Mode::json) {
                    detector_.clear();
                    return true;
                }
                const std::string initial = std::move(detector_);
                detector_.clear();
                return feedLines(initial);
            }
            return mode_ == Mode::json || feedLines(chunk);
        }

        bool finish(std::string_view rawResponse) {
            if (mode_ == Mode::json || mode_ == Mode::unknown)
                return parseJsonResponse(rawResponse);
            if (!line_.empty()) {
                if (!processLine(std::move(line_)))
                    return false;
                line_.clear();
            }
            return dispatchEvent();
        }

        const std::string& content() const noexcept {
            return content_;
        }
        const std::string& responseId() const noexcept {
            return responseId_;
        }
        const std::string& modelId() const noexcept {
            return modelId_;
        }
        const std::string& error() const noexcept {
            return error_;
        }

      private:
        enum class Mode {
            unknown,
            eventStream,
            json
        };

        void detectMode() {
            std::size_t first = 0;
            while (first < detector_.size() &&
                   std::isspace(static_cast<unsigned char>(detector_[first]))) {
                ++first;
            }
            const std::string_view probe(detector_.data() + first, detector_.size() - first);
            constexpr std::array<std::string_view, 3> eventPrefixes{"data:", ":", "event:"};
            for (const std::string_view prefix : eventPrefixes) {
                if (probe.starts_with(prefix)) {
                    mode_ = Mode::eventStream;
                    return;
                }
            }
            for (const std::string_view prefix : eventPrefixes) {
                if (prefix.starts_with(probe))
                    return;
            }
            if (!probe.empty() && (probe.front() == '{' || probe.front() == '[')) {
                mode_ = Mode::json;
                return;
            }
            if (probe.size() >= 8) {
                error_ = "The provider response was not a supported event stream or JSON value.";
                mode_ = Mode::eventStream;
            }
        }

        bool feedLines(std::string_view chunk) {
            for (char character : chunk) {
                if (character == '\n') {
                    if (!processLine(std::move(line_)))
                        return false;
                    line_.clear();
                } else {
                    if (line_.size() >= maximumGeneratedTextBytes) {
                        error_ = "The provider event exceeded the configured size limit.";
                        return false;
                    }
                    line_.push_back(character);
                }
            }
            return true;
        }

        bool processLine(std::string line) {
            if (!line.empty() && line.back() == '\r')
                line.pop_back();
            if (line.empty())
                return dispatchEvent();
            if (line.front() == ':')
                return true;
            if (line.starts_with("data:")) {
                std::string_view data(line);
                data.remove_prefix(5);
                if (!data.empty() && data.front() == ' ')
                    data.remove_prefix(1);
                if (!eventData_.empty())
                    eventData_.push_back('\n');
                eventData_.append(data);
            }
            return true;
        }

        bool dispatchEvent() {
            if (eventData_.empty())
                return true;
            if (eventData_ == "[DONE]") {
                eventData_.clear();
                return true;
            }
            auto parsed = command::parseJson(eventData_, 32, 100'000, maximumGeneratedTextBytes);
            eventData_.clear();
            if (!parsed) {
                error_ = "The provider stream contained malformed JSON event data.";
                return false;
            }
            const JsonValue::Object* root = parsed->asObject();
            if (!root) {
                error_ = "The provider stream event was not a JSON object.";
                return false;
            }
            saveResponseMetadata(*root);
            const JsonValue::Array* choices = arrayAt(member(*root, "choices"));
            const JsonValue* firstChoice = firstArrayValue(choices);
            const JsonValue::Object* choiceObject = objectAt(firstChoice);
            const JsonValue::Object* deltaObject =
                choiceObject ? objectAt(member(*choiceObject, "delta")) : nullptr;
            if (!deltaObject)
                return true;
            const std::string delta = readOptionalString(*deltaObject, "content");
            if (delta.empty())
                return true;
            if (delta.size() > maximumGeneratedTextBytes - content_.size()) {
                error_ = "Generated guide text exceeded the 8 MiB output limit.";
                return false;
            }
            content_ += delta;
            if (request_.onText) {
                try {
                    request_.onText(delta);
                } catch (...) {
                    error_ = "The output callback failed while receiving generated text.";
                    return false;
                }
            }
            return true;
        }

        void saveResponseMetadata(const JsonValue::Object& root) {
            if (responseId_.empty())
                responseId_ = readOptionalString(root, "id");
            if (modelId_.empty())
                modelId_ = readOptionalString(root, "model");
        }

        bool parseJsonResponse(std::string_view response) {
            auto parsed = command::parseJson(response, 32, 100'000, maximumGeneratedTextBytes);
            if (!parsed) {
                error_ = "The provider response was not valid JSON.";
                return false;
            }
            const JsonValue::Object* root = parsed->asObject();
            if (!root) {
                error_ = "The provider response was not a JSON object.";
                return false;
            }
            saveResponseMetadata(*root);
            const JsonValue::Array* choices = arrayAt(member(*root, "choices"));
            const JsonValue* firstChoice = firstArrayValue(choices);
            const JsonValue::Object* choiceObject = objectAt(firstChoice);
            const JsonValue::Object* messageObject =
                choiceObject ? objectAt(member(*choiceObject, "message")) : nullptr;
            if (!messageObject) {
                error_ = "The provider response did not contain a chat completion.";
                return false;
            }
            content_ = readOptionalString(*messageObject, "content");
            if (request_.onText && !content_.empty()) {
                try {
                    request_.onText(content_);
                } catch (...) {
                    error_ = "The output callback failed while receiving generated text.";
                    return false;
                }
            }
            if (content_.empty()) {
                error_ = "The provider response contained no generated text.";
                return false;
            }
            return true;
        }

        const GenerationRequest& request_;
        Mode mode_{Mode::unknown};
        std::string detector_;
        std::string line_;
        std::string eventData_;
        std::string content_;
        std::string responseId_;
        std::string modelId_;
        std::string error_;
    };

} // namespace

core::Result<std::vector<ProviderModel>>
listOpenAiCompatibleModels(std::string_view endpoint,
                           std::string_view apiKey,
                           std::function<bool()> cancelled,
                           std::string_view apiKeyHeaderName) {
    if (apiKeyHeaderName != "Authorization" && apiKeyHeaderName != "api-key") {
        return std::unexpected(core::error("ai_provider_configuration_invalid",
                                           "The provider API-key header name is not supported."));
    }
    if (auto status = validateEndpoint(endpoint, apiKey); !status)
        return std::unexpected(status.error());
    HttpRequest request;
    request.url = endpointUrl(endpoint, "/models");
    request.method = "GET";
    request.maximumResponseBytes = 4U * 1024U * 1024U;
    request.timeout = std::chrono::seconds(30);
    request.cancelled = std::move(cancelled);
    if (!apiKey.empty()) {
        request.headers.emplace_back(apiKeyHeaderName,
                                     apiKeyHeaderName == "Authorization"
                                         ? authorizationHeader(apiKey)
                                         : std::string(apiKey));
    }
    auto response = performHttp(std::move(request));
    if (!response)
        return std::unexpected(response.error());
    if (response->cancelled)
        return std::unexpected(
            core::error("ai_request_cancelled", "Model discovery was cancelled."));
    if (response->responseTooLarge)
        return std::unexpected(
            core::error("ai_model_catalog_too_large", "The provider model list exceeded 4 MiB."));
    if (!response->transportError.empty() || response->statusCode < 200 ||
        response->statusCode >= 300) {
        return std::unexpected(httpError(*response));
    }
    auto parsed = command::parseJson(response->body, 32, 200'000, 4U * 1024U * 1024U);
    if (!parsed)
        return std::unexpected(core::error("ai_model_catalog_invalid",
                                           "The provider returned an invalid model catalog."));
    const JsonValue::Object* root = parsed->asObject();
    const JsonValue::Array* entries = root ? arrayAt(member(*root, "data")) : parsed->asArray();
    if (!entries || entries->size() > maximumModels) {
        return std::unexpected(core::error("ai_model_catalog_invalid",
                                           "The provider model catalog has an invalid shape."));
    }
    std::vector<ProviderModel> models;
    models.reserve(entries->size());
    std::unordered_set<std::string> seenIds;
    seenIds.reserve(entries->size());
    for (const JsonValue& entry : *entries) {
        const JsonValue::Object* modelObject = entry.asObject();
        const JsonValue* idValue = modelObject ? member(*modelObject, "id") : nullptr;
        if (!modelObject || !idValue || !idValue->asString() || idValue->asString()->empty() ||
            idValue->asString()->size() > 1024) {
            return std::unexpected(core::error("ai_model_catalog_invalid",
                                               "A provider model entry has an invalid ID."));
        }
        std::string owner = readOptionalString(*modelObject, "owned_by");
        if (owner.empty())
            owner = readOptionalString(*modelObject, "organization");
        ProviderModel model{*idValue->asString(), std::move(owner)};
        model.contextWindow = readOptionalInteger(*modelObject, "context_length");
        model.maximumOutputTokens = readOptionalInteger(*modelObject, "max_output_tokens");
        if (model.maximumOutputTokens.empty())
            model.maximumOutputTokens = readOptionalInteger(*modelObject, "max_completion_tokens");
        model.availabilityStatus = "listed";

        const JsonValue::Object* architecture = objectAt(member(*modelObject, "architecture"));
        if (architecture) {
            const std::string input = readStringList(*architecture, "input_modalities");
            const std::string output = readStringList(*architecture, "output_modalities");
            if (!input.empty())
                model.inputModalities = input;
            if (!output.empty())
                model.outputModalities = output;
        }

        if (const auto* parameters = arrayAt(member(*modelObject, "supported_parameters"))) {
            bool supportsTools = false;
            bool supportsStructuredOutput = false;
            bool supportsStreaming = false;
            for (const auto& parameter : *parameters) {
                const auto* name = parameter.asString();
                if (!name)
                    continue;
                supportsTools = supportsTools || *name == "tools" || *name == "tool_choice";
                supportsStructuredOutput = supportsStructuredOutput || *name == "response_format";
                supportsStreaming = supportsStreaming || *name == "stream";
            }
            model.toolSupport = supportsTools ? "supported" : "unsupported";
            model.structuredOutputSupport = supportsStructuredOutput ? "supported" : "unsupported";
            model.streamingSupport = supportsStreaming ? "supported" : "unsupported";
        }
        if (seenIds.insert(model.id).second)
            models.push_back(std::move(model));
    }
    return models;
}

core::Result<GenerationResponse> generateOpenAiCompatible(GenerationRequest request) {
    GenerationInputWiper inputWiper(request);
    if (!request.apiKeyHeaderName.empty() && request.apiKeyHeaderName != "Authorization" &&
        request.apiKeyHeaderName != "api-key") {
        return std::unexpected(core::error("ai_provider_configuration_invalid",
                                           "The provider API-key header name is not supported."));
    }
    if (auto status = validateEndpoint(request.endpoint, request.apiKey); !status)
        return std::unexpected(status.error());
    if (request.modelId.empty() || request.modelId.size() > 1024 ||
        request.maximumOutputTokens == 0 || request.maximumOutputTokens > 1'000'000) {
        return std::unexpected(
            core::error("ai_generation_request_invalid",
                        "A model ID and output-token limit within 1 to 1,000,000 are required."));
    }
    auto serializedUserContent = serializeContentParts(request.content,
                                                       request.userContent,
                                                       ContentSerialization::openAiChat);
    if (!serializedUserContent)
        return std::unexpected(serializedUserContent.error());
    const std::string tokenLimitField =
        request.useMaxCompletionTokens ? "max_completion_tokens" : "max_tokens";
    std::string body = "{\"model\":\"" + command::jsonEscape(request.modelId) +
                       "\",\"stream\":" + (request.enableStreaming ? "true" : "false") + ",\"" +
                       tokenLimitField + "\":" + std::to_string(request.maximumOutputTokens) +
                       ",\"messages\":[{\"role\":\"system\",\"content\":\"" +
                       command::jsonEscape(request.systemPrompt) +
                       "\"},{\"role\":\"user\",\"content\":" + *serializedUserContent + "}]}";
    if (request.requireStructuredOutput) {
        const std::size_t messagesPosition = body.find(",\"messages\":");
        if (messagesPosition == std::string::npos) {
            return std::unexpected(
                core::error("ai_request_invalid",
                            "Unable to apply the structured-output request format."));
        }
        body.insert(messagesPosition, ",\"response_format\":{\"type\":\"json_object\"}");
    }
    if (body.size() > maximumRequestBytes || !requestFitsLimit(request) ||
        !command::parseJson(body, 32, 100'000, maximumRequestBytes)) {
        return std::unexpected(
            core::error("ai_request_invalid",
                        "The generation request is invalid or exceeds the 16 MiB request limit."));
    }

    EventDecoder decoder(request);
    HttpRequest httpRequest;
    httpRequest.url = endpointUrl(request.endpoint, "/chat/completions");
    httpRequest.method = "POST";
    httpRequest.accept = request.enableStreaming ? "text/event-stream" : "application/json";
    if (!request.apiKey.empty()) {
        const std::string_view headerName =
            request.apiKeyHeaderName.empty() ? "Authorization" : request.apiKeyHeaderName;
        httpRequest.headers.emplace_back(
            headerName,
            headerName == "Authorization" ? authorizationHeader(request.apiKey) : request.apiKey);
    }
    httpRequest.headers.emplace_back("Content-Type", "application/json");
    httpRequest.body = std::move(body);
    httpRequest.maximumResponseBytes = 16U * 1024U * 1024U;
    httpRequest.cancelled = request.cancelled;
    httpRequest.onChunk = [&](std::string_view chunk) {
        return decoder.feed(chunk);
    };
    auto response = performHttp(std::move(httpRequest));
    if (!response)
        return std::unexpected(response.error());

    GenerationResponse generated;
    generated.statusCode = response->statusCode;
    generated.rawResponse = std::move(response->body);
    generated.retryAfter = std::move(response->retryAfter);
    generated.cancelled = response->cancelled;
    generated.responseTooLarge = response->responseTooLarge;
    generated.responseId = decoder.responseId();
    generated.resolvedModelId = decoder.modelId();
    generated.content = decoder.content();
    if (response->cancelled || response->responseTooLarge || !response->transportError.empty() ||
        response->statusCode < 200 || response->statusCode >= 300) {
        const core::Error error = httpError(*response);
        generated.errorCode = error.code;
        generated.errorMessage = error.message;
        return generated;
    }
    if (response->callbackAborted || !decoder.error().empty()) {
        generated.errorCode = "ai_stream_invalid";
        generated.errorMessage = decoder.error().empty()
                                     ? "The provider stream stopped before it was complete."
                                     : decoder.error();
        return generated;
    }
    if (!decoder.finish(generated.rawResponse)) {
        generated.errorCode = "ai_response_invalid";
        generated.errorMessage = decoder.error();
        return generated;
    }
    generated.responseId = decoder.responseId();
    generated.resolvedModelId = decoder.modelId();
    if (generated.content.empty()) {
        generated.errorCode = "ai_response_empty";
        generated.errorMessage = "The provider returned no generated text.";
    }
    return generated;
}

} // namespace tutorux::ai
