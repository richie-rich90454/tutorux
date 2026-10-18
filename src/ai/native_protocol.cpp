#include "tutorux/ai/native_protocol.hpp"

#include "tutorux/command/json.hpp"

#include <sodium.h>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <ranges>
#include <string_view>
#include <unordered_set>

namespace tutorux::ai {
namespace {

    using command::JsonValue;

    constexpr std::size_t maximumModels = 50'000;
    constexpr std::size_t maximumResponseBytes = 16U * 1024U * 1024U;
    constexpr std::size_t maximumGeneratedTextBytes = 8U * 1024U * 1024U;
    constexpr std::size_t maximumEventBytes = 1024U * 1024U;
    constexpr std::uint32_t maximumOutputTokens = 1'000'000;

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

    std::string readString(const JsonValue::Object& object, std::string_view name) {
        const JsonValue* value = member(object, name);
        return value && value->asString() ? *value->asString() : std::string{};
    }

    std::string readScalar(const JsonValue::Object& object, std::string_view name) {
        const JsonValue* value = member(object, name);
        if (!value)
            return {};
        if (const auto* number = std::get_if<command::JsonNumber>(&value->value))
            return number->text;
        if (const auto* text = value->asString())
            return *text;
        return {};
    }

    bool readBoolean(const JsonValue::Object& object, std::string_view name) {
        const JsonValue* value = member(object, name);
        const bool* boolean = value ? std::get_if<bool>(&value->value) : nullptr;
        return boolean && *boolean;
    }

    std::string trimEndpoint(std::string_view endpoint) {
        while (!endpoint.empty() && endpoint.back() == '/')
            endpoint.remove_suffix(1);
        return std::string(endpoint);
    }

    std::string ollamaBaseEndpoint(std::string_view endpoint) {
        std::string base = trimEndpoint(endpoint);
        if (base.ends_with("/v1"))
            base.resize(base.size() - 3);
        return base;
    }

    std::string endpointUrl(std::string_view endpoint, std::string_view path) {
        return trimEndpoint(endpoint) + std::string(path);
    }

    std::string percentEncode(std::string_view value) {
        static constexpr char digits[] = "0123456789ABCDEF";
        std::string encoded;
        encoded.reserve(value.size());
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

    bool validModelId(std::string_view modelId) {
        if (modelId.empty() || modelId.size() > 1024)
            return false;
        return std::ranges::none_of(modelId, [](const unsigned char character) {
            return character < 0x20U || character == 0x7FU;
        });
    }

    std::string normalizedGeminiModel(std::string_view modelId) {
        constexpr std::string_view prefix = "models/";
        if (modelId.starts_with(prefix))
            modelId.remove_prefix(prefix.size());
        return std::string(modelId);
    }

    core::Status validateEndpoint(std::string_view endpoint, std::string_view apiKey,
                                  bool allowMissingRemoteKey = false) {
        if (endpoint.empty() || endpoint.find_first_of("?#\r\n") != std::string_view::npos ||
            (apiKey.empty() && !allowMissingRemoteKey && !isLoopbackHttpUrl(endpoint))) {
            return std::unexpected(core::error(
                "ai_provider_configuration_invalid",
                "Remote providers require HTTPS and an API key. An API key may be omitted "
                "only for a loopback HTTP service."));
        }
        return {};
    }

    std::string authorizationHeader(std::string_view apiKey) {
        return std::string(apiKey);
    }

    core::Error httpError(const HttpResponse& response) {
        if (response.cancelled)
            return core::error("ai_request_cancelled", "The AI request was cancelled.");
        if (response.responseTooLarge)
            return core::error("ai_response_too_large",
                               "The provider response exceeded the 16 MiB transport limit.");
        if (!response.transportError.empty())
            return core::error("ai_network_error",
                               "The provider request failed: " + response.transportError);
        if (response.statusCode == 401 || response.statusCode == 403)
            return core::error("ai_authentication_failed",
                               "The provider rejected authentication or model access.");
        if (response.statusCode == 429)
            return core::error("ai_rate_limited",
                               response.retryAfter.empty()
                                   ? "The provider rate limit was reached."
                                   : "The provider rate limit was reached; Retry-After is " +
                                         response.retryAfter + ".");
        if (response.statusCode >= 500)
            return core::error("ai_provider_unavailable",
                               "The provider returned a server error (HTTP " +
                                   std::to_string(response.statusCode) + ").");
        return core::error("ai_provider_response_invalid", "The provider returned HTTP " +
                                                               std::to_string(response.statusCode) +
                                                               ".");
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

    class StringWiper final {
      public:
        explicit StringWiper(std::string& value) noexcept
            : value_(value) {}
        ~StringWiper() {
            if (!value_.empty())
                sodium_memzero(value_.data(), value_.size());
        }

      private:
        std::string& value_;
    };

    bool appendText(std::string& content, std::string_view text, std::string& error) {
        if (text.size() > maximumGeneratedTextBytes - content.size()) {
            error = "Generated guide text exceeded the 8 MiB output limit.";
            return false;
        }
        content.append(text);
        return true;
    }

    bool emitText(const GenerationRequest& request, std::string_view text, std::string& content,
                  std::string& error) {
        if (text.empty())
            return true;
        if (!appendText(content, text, error))
            return false;
        if (request.onText) {
            try {
                request.onText(text);
            } catch (...) {
                error = "The output callback failed while receiving generated text.";
                return false;
            }
        }
        return true;
    }

    std::string nestedText(const JsonValue::Object& root, std::string_view first,
                           std::string_view second) {
        const JsonValue::Object* nested = objectAt(member(root, first));
        return nested ? readString(*nested, second) : std::string{};
    }

    bool collectAnthropicContent(const JsonValue::Object& root, const GenerationRequest& request,
                                 GenerationResponse& generated, std::string& error) {
        const JsonValue::Array* blocks = arrayAt(member(root, "content"));
        if (!blocks)
            return true;
        for (const JsonValue& blockValue : *blocks) {
            const JsonValue::Object* block = blockValue.asObject();
            if (block && readString(*block, "type") == "text" &&
                !emitText(request, readString(*block, "text"), generated.content, error)) {
                return false;
            }
        }
        return true;
    }

    bool collectGeminiContent(const JsonValue::Object& root, const GenerationRequest& request,
                              GenerationResponse& generated, std::string& error) {
        const JsonValue::Array* candidates = arrayAt(member(root, "candidates"));
        const JsonValue::Object* candidate =
            candidates && !candidates->empty() ? candidates->front().asObject() : nullptr;
        const JsonValue::Object* content =
            candidate ? objectAt(member(*candidate, "content")) : nullptr;
        const JsonValue::Array* parts = content ? arrayAt(member(*content, "parts")) : nullptr;
        if (!parts)
            return true;
        for (const JsonValue& partValue : *parts) {
            const JsonValue::Object* part = partValue.asObject();
            if (part && !emitText(request, readString(*part, "text"), generated.content, error))
                return false;
        }
        return true;
    }

    bool collectCohereContent(const JsonValue::Object& root, const GenerationRequest& request,
                              GenerationResponse& generated, std::string& error) {
        const JsonValue::Object* message = objectAt(member(root, "message"));
        const JsonValue::Array* content = message ? arrayAt(member(*message, "content")) : nullptr;
        if (!content)
            return true;
        for (const JsonValue& blockValue : *content) {
            const JsonValue::Object* block = blockValue.asObject();
            if (block && readString(*block, "type") == "text" &&
                !emitText(request, readString(*block, "text"), generated.content, error)) {
                return false;
            }
        }
        return true;
    }

    bool collectPerplexityContent(const JsonValue::Object& root, const GenerationRequest& request,
                                  GenerationResponse& generated, std::string& error) {
        const JsonValue::Array* output = arrayAt(member(root, "output"));
        if (!output)
            return true;
        for (const JsonValue& itemValue : *output) {
            const JsonValue::Object* item = itemValue.asObject();
            const JsonValue::Array* content = item ? arrayAt(member(*item, "content")) : nullptr;
            if (!content)
                continue;
            for (const JsonValue& blockValue : *content) {
                const JsonValue::Object* block = blockValue.asObject();
                if (block && readString(*block, "type") == "output_text" &&
                    !emitText(request, readString(*block, "text"), generated.content, error)) {
                    return false;
                }
            }
        }
        return true;
    }

    bool collectOllamaContent(const JsonValue::Object& root, const GenerationRequest& request,
                              GenerationResponse& generated, std::string& error) {
        if (const JsonValue* failure = member(root, "error")) {
            const std::string* message = failure->asString();
            error =
                message && !message->empty() ? *message : "The Ollama service reported an error.";
            return false;
        }
        if (generated.resolvedModelId.empty())
            generated.resolvedModelId = readString(root, "model");
        const JsonValue::Object* message = objectAt(member(root, "message"));
        if (message &&
            !emitText(request, readString(*message, "content"), generated.content, error)) {
            return false;
        }
        if (readBoolean(root, "done"))
            return true;
        return true;
    }

    std::string nestedText(const JsonValue::Object& root, std::string_view first,
                           std::string_view second, std::string_view third) {
        const JsonValue::Object* nested = objectAt(member(root, first));
        return nested ? nestedText(*nested, second, third) : std::string{};
    }

    std::string nestedText(const JsonValue::Object& root, std::string_view first,
                           std::string_view second, std::string_view third,
                           std::string_view fourth) {
        const JsonValue::Object* nested = objectAt(member(root, first));
        return nested ? nestedText(*nested, second, third, fourth) : std::string{};
    }

    class NativeStreamDecoder final {
      public:
        NativeStreamDecoder(const GenerationRequest& request, NativeProtocol protocol)
            : request_(request)
            , protocol_(protocol) {}

        bool feed(std::string_view chunk) {
            if (line_.size() > maximumEventBytes - std::min(maximumEventBytes, chunk.size())) {
                error_ = "The provider stream event exceeded the 1 MiB limit.";
                return false;
            }
            line_.append(chunk);
            std::size_t newline = 0;
            while ((newline = line_.find('\n')) != std::string::npos) {
                std::string line = line_.substr(0, newline);
                line_.erase(0, newline + 1);
                if (!line.empty() && line.back() == '\r')
                    line.pop_back();
                if (!processLine(line))
                    return false;
            }
            if (line_.size() > maximumEventBytes) {
                error_ = "The provider stream event exceeded the 1 MiB limit.";
                return false;
            }
            return true;
        }

        bool finish(std::string_view rawResponse, GenerationResponse& generated) {
            if (!line_.empty()) {
                std::string line = std::move(line_);
                line_.clear();
                if (!line.empty() && line.back() == '\r')
                    line.pop_back();
                if (!processLine(line))
                    return false;
            }
            if (!eventData_.empty() && !processEvent(decoded_))
                return false;
            if (!plainResponse_.empty())
                return transferDecoded(parseResponse(plainResponse_, decoded_), generated);
            if (!eventSeen_ && !rawResponse.empty())
                return transferDecoded(parseResponse(rawResponse, decoded_), generated);
            if ((eventSeen_ || protocol_ == NativeProtocol::ollamaChat) && !streamComplete_) {
                error_ = "The provider stream ended before its completion event.";
                return false;
            }
            transferDecoded(true, generated);
            return true;
        }

        const std::string& error() const noexcept {
            return error_;
        }

      private:
        bool processLine(std::string_view line) {
            if (protocol_ == NativeProtocol::ollamaChat) {
                if (line.empty())
                    return true;
                eventSeen_ = true;
                auto parsed = command::parseJson(line, 32, 100'000, maximumEventBytes);
                const JsonValue::Object* root = parsed ? parsed->asObject() : nullptr;
                if (!root) {
                    error_ = "The Ollama stream contained an invalid JSON record.";
                    return false;
                }
                if (!collectOllamaContent(*root, request_, decoded_, error_))
                    return false;
                streamComplete_ = streamComplete_ || readBoolean(*root, "done");
                return true;
            }
            if (plainMode_) {
                if (line.size() + plainResponse_.size() > maximumResponseBytes) {
                    error_ = "The provider response exceeded the 16 MiB limit.";
                    return false;
                }
                plainResponse_.append(line);
                plainResponse_.push_back('\n');
                return true;
            }
            if (line.empty())
                return processEvent(decoded_);
            if (line.starts_with("data:")) {
                eventSeen_ = true;
                std::string_view value = line.substr(5);
                if (!value.empty() && value.front() == ' ')
                    value.remove_prefix(1);
                if (value.size() > maximumEventBytes - eventData_.size()) {
                    error_ = "The provider stream event exceeded the 1 MiB limit.";
                    return false;
                }
                if (!eventData_.empty())
                    eventData_.push_back('\n');
                eventData_.append(value);
                return true;
            }
            if (line.starts_with("event:")) {
                eventSeen_ = true;
                return true;
            }
            if (line.front() == ':' || line.starts_with("id:") || line.starts_with("retry:"))
                return true;
            const auto first = line.find_first_not_of(" \t");
            if (first != std::string_view::npos && line[first] == '{') {
                plainMode_ = true;
                plainResponse_.assign(line);
                plainResponse_.push_back('\n');
                return true;
            }
            error_ = "The provider response was neither a valid event stream nor a JSON object.";
            return false;
        }

        bool processEvent(GenerationResponse& generated) {
            if (eventData_.empty()) {
                return true;
            }
            const std::string_view payload = eventData_;
            eventData_.clear();
            if (payload == "[DONE]") {
                streamComplete_ = true;
                return true;
            }
            auto parsed = command::parseJson(payload, 32, 100'000, maximumEventBytes);
            if (!parsed) {
                error_ = "The provider stream contained malformed JSON event data.";
                return false;
            }
            const JsonValue::Object* root = parsed->asObject();
            if (!root) {
                error_ = "The provider stream event was not a JSON object.";
                return false;
            }
            if (generated.responseId.empty()) {
                generated.responseId = readString(*root, "id");
                if (generated.responseId.empty())
                    generated.responseId = nestedText(*root, "message", "id");
            }
            if (generated.resolvedModelId.empty()) {
                generated.resolvedModelId = readString(*root, "model");
                if (generated.resolvedModelId.empty())
                    generated.resolvedModelId = nestedText(*root, "message", "model");
                if (generated.resolvedModelId.empty())
                    generated.resolvedModelId = readString(*root, "modelVersion");
            }
            const JsonValue::Object* providerError = objectAt(member(*root, "error"));
            if (providerError) {
                const std::string message = readString(*providerError, "message");
                error_ = message.empty() ? "The provider reported a stream error." : message;
                return false;
            }
            const std::string type = readString(*root, "type");
            if (protocol_ == NativeProtocol::anthropicMessages) {
                if (type == "message_stop") {
                    streamComplete_ = true;
                    return true;
                }
                const JsonValue::Object* delta = objectAt(member(*root, "delta"));
                if (delta && readString(*delta, "type") == "text_delta") {
                    return emitText(request_, readString(*delta, "text"), generated.content,
                                    error_);
                }
                if (type == "error") {
                    error_ = "The provider reported a stream error.";
                    return false;
                }
                return true;
            }
            if (protocol_ == NativeProtocol::cohereChatV2) {
                if (type == "message-end") {
                    streamComplete_ = true;
                    return true;
                }
                if (type == "error") {
                    error_ = readString(*root, "message");
                    if (error_.empty())
                        error_ = "The provider reported a stream error.";
                    return false;
                }
                if (type == "content-delta") {
                    return emitText(request_,
                                    nestedText(*root, "delta", "message", "content", "text"),
                                    generated.content, error_);
                }
                return true;
            }
            if (protocol_ == NativeProtocol::perplexityAgent ||
                protocol_ == NativeProtocol::openAiResponses) {
                if (type == "response.completed") {
                    const JsonValue::Object* response = objectAt(member(*root, "response"));
                    if (response) {
                        if (generated.responseId.empty())
                            generated.responseId = readString(*response, "id");
                        if (generated.resolvedModelId.empty())
                            generated.resolvedModelId = readString(*response, "model");
                    }
                    streamComplete_ = true;
                    return true;
                }
                if (type == "response.failed" || type == "error") {
                    const JsonValue::Object* response = objectAt(member(*root, "response"));
                    const JsonValue::Object* failure = response
                                                           ? objectAt(member(*response, "error"))
                                                           : objectAt(member(*root, "error"));
                    error_ = failure ? readString(*failure, "message") : std::string{};
                    if (error_.empty())
                        error_ = "The provider reported a generation error.";
                    return false;
                }
                if (type == "response.incomplete") {
                    error_ = "The provider ended the response before generation completed.";
                    return false;
                }
                if (type == "response.output_text.delta")
                    return emitText(request_, readString(*root, "delta"), generated.content,
                                    error_);
                return true;
            }
            const JsonValue::Array* candidates = arrayAt(member(*root, "candidates"));
            const JsonValue::Object* candidate =
                candidates && !candidates->empty() ? candidates->front().asObject() : nullptr;
            if (candidate && !readString(*candidate, "finishReason").empty())
                streamComplete_ = true;
            return collectGeminiContent(*root, request_, generated, error_);
        }

        bool parseResponse(std::string_view response, GenerationResponse& generated) {
            auto parsed = command::parseJson(response, 32, 100'000, maximumResponseBytes);
            if (!parsed) {
                error_ = "The provider response was not valid JSON.";
                return false;
            }
            const JsonValue::Object* root = parsed->asObject();
            if (!root) {
                error_ = "The provider response was not a JSON object.";
                return false;
            }
            generated.responseId = readString(*root, "id");
            generated.resolvedModelId = readString(*root, "model");
            if (generated.resolvedModelId.empty())
                generated.resolvedModelId = readString(*root, "modelVersion");
            const JsonValue::Object* providerError = objectAt(member(*root, "error"));
            if (providerError) {
                error_ = readString(*providerError, "message");
                if (error_.empty())
                    error_ = "The provider reported a generation error.";
                return false;
            }
            if (protocol_ == NativeProtocol::anthropicMessages)
                return collectAnthropicContent(*root, request_, generated, error_);
            if (protocol_ == NativeProtocol::cohereChatV2)
                return collectCohereContent(*root, request_, generated, error_);
            if (protocol_ == NativeProtocol::perplexityAgent ||
                protocol_ == NativeProtocol::openAiResponses)
                return collectPerplexityContent(*root, request_, generated, error_);
            if (protocol_ == NativeProtocol::ollamaChat)
                return collectOllamaContent(*root, request_, generated, error_);
            return collectGeminiContent(*root, request_, generated, error_);
        }

        bool transferDecoded(bool parsed, GenerationResponse& generated) {
            generated.content = std::move(decoded_.content);
            generated.responseId = std::move(decoded_.responseId);
            generated.resolvedModelId = std::move(decoded_.resolvedModelId);
            return parsed;
        }

        const GenerationRequest& request_;
        NativeProtocol protocol_;
        std::string line_;
        std::string eventData_;
        std::string plainResponse_;
        std::string error_;
        GenerationResponse decoded_;
        bool eventSeen_{};
        bool plainMode_{};
        bool streamComplete_{};
    };

    core::Result<HttpResponse> sendModelRequest(NativeProtocol protocol, std::string url,
                                                std::string_view apiKey,
                                                std::function<bool()> cancelled) {
        HttpRequest request;
        request.url = std::move(url);
        request.method = "GET";
        request.maximumResponseBytes = 4U * 1024U * 1024U;
        request.timeout = std::chrono::seconds(30);
        request.cancelled = std::move(cancelled);
        if (protocol == NativeProtocol::anthropicMessages) {
            request.headers.emplace_back("x-api-key", authorizationHeader(apiKey));
            request.headers.emplace_back("anthropic-version", "2023-06-01");
        } else if (protocol == NativeProtocol::cohereChatV2) {
            request.headers.emplace_back("Authorization", "Bearer " + std::string(apiKey));
        } else if (protocol == NativeProtocol::perplexityAgent) {
            // Perplexity model discovery is public and does not require credentials.
        } else if (protocol == NativeProtocol::openAiResponses) {
            request.headers.emplace_back("Authorization", "Bearer " + std::string(apiKey));
        } else if (protocol == NativeProtocol::ollamaChat) {
            // Ollama local services do not use credentials.
        } else if (!apiKey.empty()) {
            request.headers.emplace_back("x-goog-api-key", authorizationHeader(apiKey));
        }
        return performHttp(std::move(request));
    }

    core::Result<std::vector<ProviderModel>> parseAnthropicModels(std::string_view endpoint,
                                                                  std::string_view apiKey,
                                                                  std::function<bool()> cancelled) {
        std::vector<ProviderModel> models;
        std::unordered_set<std::string> seen;
        std::string afterId;
        for (std::size_t page = 0; page < 50; ++page) {
            if (cancelled && cancelled())
                return std::unexpected(
                    core::error("ai_request_cancelled", "Model discovery was cancelled."));
            std::string url = endpointUrl(endpoint, "/v1/models?limit=1000");
            if (!afterId.empty())
                url += "&after_id=" + percentEncode(afterId);
            auto response = sendModelRequest(NativeProtocol::anthropicMessages, std::move(url),
                                             apiKey, cancelled);
            if (!response)
                return std::unexpected(response.error());
            if (response->cancelled)
                return std::unexpected(
                    core::error("ai_request_cancelled", "Model discovery was cancelled."));
            if (response->responseTooLarge)
                return std::unexpected(core::error("ai_model_catalog_too_large",
                                                   "The provider model list exceeded 4 MiB."));
            if (!response->transportError.empty() || response->statusCode < 200 ||
                response->statusCode >= 300)
                return std::unexpected(httpError(*response));
            auto parsed = command::parseJson(response->body, 32, 200'000, 4U * 1024U * 1024U);
            const JsonValue::Object* root = parsed ? parsed->asObject() : nullptr;
            const JsonValue::Array* entries = root ? arrayAt(member(*root, "data")) : nullptr;
            if (!entries || entries->size() > 1000)
                return std::unexpected(
                    core::error("ai_model_catalog_invalid",
                                "The provider model catalog has an invalid shape."));
            for (const JsonValue& entry : *entries) {
                const JsonValue::Object* object = entry.asObject();
                const std::string id = object ? readString(*object, "id") : std::string{};
                if (id.empty() || id.size() > 1024)
                    return std::unexpected(core::error(
                        "ai_model_catalog_invalid", "A provider model entry has an invalid ID."));
                if (seen.insert(id).second) {
                    std::string owner = object ? readString(*object, "display_name") : "";
                    if (owner.empty() && object)
                        owner = readString(*object, "type");
                    ProviderModel model{id, std::move(owner)};
                    model.inputModalities = "text,unknown";
                    models.push_back(std::move(model));
                }
            }
            if (models.size() > maximumModels)
                return std::unexpected(core::error("ai_model_catalog_invalid",
                                                   "The provider model catalog is too large."));
            if (!root || !readBoolean(*root, "has_more"))
                return models;
            const std::string nextId = readString(*root, "last_id");
            if (nextId.empty() || nextId == afterId)
                return std::unexpected(
                    core::error("ai_model_catalog_invalid",
                                "The provider model pagination cursor is invalid."));
            afterId = nextId;
        }
        return std::unexpected(core::error("ai_model_catalog_too_large",
                                           "The provider model catalog exceeded 50,000 models."));
    }

    core::Result<std::vector<ProviderModel>> parseGeminiModels(std::string_view endpoint,
                                                               std::string_view apiKey,
                                                               std::function<bool()> cancelled) {
        std::vector<ProviderModel> models;
        std::unordered_set<std::string> seen;
        std::string pageToken;
        for (std::size_t page = 0; page < 50; ++page) {
            if (cancelled && cancelled())
                return std::unexpected(
                    core::error("ai_request_cancelled", "Model discovery was cancelled."));
            std::string url = endpointUrl(endpoint, "/models?pageSize=1000");
            if (!pageToken.empty())
                url += "&pageToken=" + percentEncode(pageToken);
            auto response = sendModelRequest(NativeProtocol::geminiGenerateContent, std::move(url),
                                             apiKey, cancelled);
            if (!response)
                return std::unexpected(response.error());
            if (response->cancelled)
                return std::unexpected(
                    core::error("ai_request_cancelled", "Model discovery was cancelled."));
            if (response->responseTooLarge)
                return std::unexpected(core::error("ai_model_catalog_too_large",
                                                   "The provider model list exceeded 4 MiB."));
            if (!response->transportError.empty() || response->statusCode < 200 ||
                response->statusCode >= 300)
                return std::unexpected(httpError(*response));
            auto parsed = command::parseJson(response->body, 32, 200'000, 4U * 1024U * 1024U);
            const JsonValue::Object* root = parsed ? parsed->asObject() : nullptr;
            const JsonValue::Array* entries = root ? arrayAt(member(*root, "models")) : nullptr;
            if (!entries || entries->size() > 1000)
                return std::unexpected(
                    core::error("ai_model_catalog_invalid",
                                "The provider model catalog has an invalid shape."));
            for (const JsonValue& entry : *entries) {
                const JsonValue::Object* object = entry.asObject();
                if (!object)
                    return std::unexpected(
                        core::error("ai_model_catalog_invalid",
                                    "A provider model entry has an invalid shape."));
                const JsonValue::Array* methods =
                    arrayAt(member(*object, "supportedGenerationMethods"));
                const bool supportsGeneration =
                    methods && std::ranges::any_of(*methods, [](const JsonValue& method) {
                        const std::string* text = method.asString();
                        return text && *text == "generateContent";
                    });
                const std::string name = readString(*object, "baseModelId").empty()
                                             ? readString(*object, "name")
                                             : readString(*object, "baseModelId");
                constexpr std::string_view prefix = "models/";
                const std::string id = name.starts_with(prefix) ? name.substr(prefix.size()) : name;
                if (!supportsGeneration)
                    continue;
                if (id.empty() || id.size() > 1024)
                    return std::unexpected(core::error(
                        "ai_model_catalog_invalid", "A provider model entry has an invalid ID."));
                if (seen.insert(id).second) {
                    ProviderModel model{id, readString(*object, "displayName")};
                    model.contextWindow = readScalar(*object, "inputTokenLimit");
                    model.maximumOutputTokens = readScalar(*object, "outputTokenLimit");
                    model.inputModalities = "text,unknown";
                    models.push_back(std::move(model));
                }
            }
            if (models.size() > maximumModels)
                return std::unexpected(core::error("ai_model_catalog_invalid",
                                                   "The provider model catalog is too large."));
            const std::string nextToken = readString(*root, "nextPageToken");
            if (nextToken.empty())
                return models;
            if (nextToken == pageToken)
                return std::unexpected(
                    core::error("ai_model_catalog_invalid",
                                "The provider model pagination cursor is invalid."));
            pageToken = nextToken;
        }
        return std::unexpected(core::error("ai_model_catalog_too_large",
                                           "The provider model catalog exceeded 50,000 models."));
    }

    core::Result<std::vector<ProviderModel>> parseCohereModels(std::string_view endpoint,
                                                               std::string_view apiKey,
                                                               std::function<bool()> cancelled) {
        std::vector<ProviderModel> models;
        std::unordered_set<std::string> seen;
        std::string pageToken;
        for (std::size_t page = 0; page < 50; ++page) {
            if (cancelled && cancelled())
                return std::unexpected(
                    core::error("ai_request_cancelled", "Model discovery was cancelled."));
            std::string url = endpointUrl(endpoint, "/v2/models?page_size=1000&endpoint=chat");
            if (!pageToken.empty())
                url += "&page_token=" + percentEncode(pageToken);
            auto response =
                sendModelRequest(NativeProtocol::cohereChatV2, std::move(url), apiKey, cancelled);
            if (!response)
                return std::unexpected(response.error());
            if (response->cancelled)
                return std::unexpected(
                    core::error("ai_request_cancelled", "Model discovery was cancelled."));
            if (response->responseTooLarge)
                return std::unexpected(core::error("ai_model_catalog_too_large",
                                                   "The provider model list exceeded 4 MiB."));
            if (!response->transportError.empty() || response->statusCode < 200 ||
                response->statusCode >= 300)
                return std::unexpected(httpError(*response));
            auto parsed = command::parseJson(response->body, 32, 200'000, 4U * 1024U * 1024U);
            const JsonValue::Object* root = parsed ? parsed->asObject() : nullptr;
            const JsonValue::Array* entries = root ? arrayAt(member(*root, "models")) : nullptr;
            if (!entries || entries->size() > 1000)
                return std::unexpected(
                    core::error("ai_model_catalog_invalid",
                                "The provider model catalog has an invalid shape."));
            for (const JsonValue& entry : *entries) {
                const JsonValue::Object* object = entry.asObject();
                const std::string id = object ? readString(*object, "name") : std::string{};
                if (id.empty() || id.size() > 1024)
                    return std::unexpected(core::error(
                        "ai_model_catalog_invalid", "A provider model entry has an invalid ID."));
                if (seen.insert(id).second)
                    models.push_back({id, "Cohere"});
            }
            if (models.size() > maximumModels)
                return std::unexpected(core::error("ai_model_catalog_too_large",
                                                   "The provider model catalog is too large."));
            const std::string nextToken = readString(*root, "next_page_token");
            if (nextToken.empty())
                return models;
            if (nextToken == pageToken)
                return std::unexpected(
                    core::error("ai_model_catalog_invalid",
                                "The provider model pagination cursor is invalid."));
            pageToken = nextToken;
        }
        return std::unexpected(core::error("ai_model_catalog_too_large",
                                           "The provider model catalog exceeded 50,000 models."));
    }

    core::Result<std::vector<ProviderModel>>
    parsePerplexityModels(std::string_view endpoint, std::string_view apiKey,
                          std::function<bool()> cancelled) {
        static_cast<void>(apiKey);
        if (cancelled && cancelled())
            return std::unexpected(
                core::error("ai_request_cancelled", "Model discovery was cancelled."));
        auto response = sendModelRequest(NativeProtocol::perplexityAgent,
                                         endpointUrl(endpoint, "/models"), {}, cancelled);
        if (!response)
            return std::unexpected(response.error());
        if (response->cancelled)
            return std::unexpected(
                core::error("ai_request_cancelled", "Model discovery was cancelled."));
        if (response->responseTooLarge)
            return std::unexpected(core::error("ai_model_catalog_too_large",
                                               "The provider model list exceeded 4 MiB."));
        if (!response->transportError.empty() || response->statusCode < 200 ||
            response->statusCode >= 300)
            return std::unexpected(httpError(*response));
        auto parsed = command::parseJson(response->body, 32, 200'000, 4U * 1024U * 1024U);
        if (!parsed)
            return std::unexpected(core::error("ai_model_catalog_invalid",
                                               "The provider returned an invalid model catalog."));
        const JsonValue::Object* root = parsed->asObject();
        const JsonValue::Array* entries = root ? arrayAt(member(*root, "data")) : nullptr;
        if (!entries || entries->size() > maximumModels)
            return std::unexpected(core::error("ai_model_catalog_invalid",
                                               "The provider model catalog has an invalid shape."));
        std::vector<ProviderModel> models;
        models.reserve(entries->size());
        std::unordered_set<std::string> seen;
        seen.reserve(entries->size());
        for (const JsonValue& entry : *entries) {
            const JsonValue::Object* object = entry.asObject();
            const std::string id = object ? readString(*object, "id") : std::string{};
            if (id.empty() || id.size() > 1024)
                return std::unexpected(core::error("ai_model_catalog_invalid",
                                                   "A provider model entry has an invalid ID."));
            if (seen.insert(id).second)
                models.push_back({id, readString(*object, "owned_by")});
        }
        return models;
    }

    core::Result<std::vector<ProviderModel>> parseOllamaModels(std::string_view endpoint,
                                                               std::function<bool()> cancelled) {
        auto response = sendModelRequest(NativeProtocol::ollamaChat,
                                         endpointUrl(ollamaBaseEndpoint(endpoint), "/api/tags"), {},
                                         std::move(cancelled));
        if (!response)
            return std::unexpected(response.error());
        if (response->cancelled)
            return std::unexpected(
                core::error("ai_request_cancelled", "Model discovery was cancelled."));
        if (response->responseTooLarge)
            return std::unexpected(
                core::error("ai_model_catalog_too_large", "The Ollama model list exceeded 4 MiB."));
        if (!response->transportError.empty() || response->statusCode < 200 ||
            response->statusCode >= 300)
            return std::unexpected(httpError(*response));

        auto parsed = command::parseJson(response->body, 32, 200'000, 4U * 1024U * 1024U);
        const JsonValue::Object* root = parsed ? parsed->asObject() : nullptr;
        const JsonValue::Array* entries = root ? arrayAt(member(*root, "models")) : nullptr;
        if (!entries || entries->size() > maximumModels)
            return std::unexpected(core::error("ai_model_catalog_invalid",
                                               "The Ollama model list has an invalid shape."));

        std::vector<ProviderModel> models;
        models.reserve(entries->size());
        std::unordered_set<std::string> seen;
        seen.reserve(entries->size());
        for (const JsonValue& entry : *entries) {
            const JsonValue::Object* object = entry.asObject();
            if (!object)
                return std::unexpected(core::error("ai_model_catalog_invalid",
                                                   "An Ollama model entry is not an object."));
            std::string id = readString(*object, "model");
            if (id.empty())
                id = readString(*object, "name");
            if (id.empty() || id.size() > 1024)
                return std::unexpected(core::error("ai_model_catalog_invalid",
                                                   "An Ollama model entry has an invalid name."));
            if (!seen.insert(id).second)
                continue;
            std::string owner;
            if (const JsonValue::Object* details = objectAt(member(*object, "details"))) {
                owner = readString(*details, "family");
                const std::string size = readString(*details, "parameter_size");
                if (!size.empty())
                    owner += (owner.empty() ? "" : " · ") + size;
            }
            models.push_back({std::move(id), std::move(owner)});
        }
        return models;
    }

} // namespace

std::string nativeGenerationEndpoint(NativeProtocol protocol, std::string_view endpoint,
                                     std::string_view modelId, bool enableStreaming) {
    if (protocol == NativeProtocol::anthropicMessages)
        return endpointUrl(endpoint, "/v1/messages");
    if (protocol == NativeProtocol::cohereChatV2)
        return endpointUrl(endpoint, "/v2/chat");
    if (protocol == NativeProtocol::perplexityAgent)
        return endpointUrl(endpoint, "/agent");
    if (protocol == NativeProtocol::openAiResponses)
        return endpointUrl(endpoint, "/responses");
    if (protocol == NativeProtocol::ollamaChat)
        return endpointUrl(ollamaBaseEndpoint(endpoint), "/api/chat");
    const std::string model = normalizedGeminiModel(modelId);
    return endpointUrl(
        endpoint, "/models/" + percentEncode(model) +
                      (enableStreaming ? ":streamGenerateContent?alt=sse" : ":generateContent"));
}

core::Result<std::string>
nativeGenerationRequestBody(NativeProtocol protocol, std::string_view modelId,
                            std::string_view systemPrompt, std::string_view userContent,
                            std::uint32_t outputTokens, std::span<const ContentPart> content,
                            bool enableStreaming, bool requireStructuredOutput) {
    if (!validModelId(modelId) || outputTokens == 0 || outputTokens > maximumOutputTokens)
        return std::unexpected(core::error(
            "ai_generation_request_invalid",
            "A valid model ID and output-token limit within 1 to 1,000,000 are required."));
    if (requireStructuredOutput && protocol != NativeProtocol::ollamaChat &&
        protocol != NativeProtocol::openAiResponses &&
        protocol != NativeProtocol::geminiGenerateContent) {
        return std::unexpected(
            core::error("ai_structured_output_unsupported",
                        "The selected native protocol cannot enforce structured JSON output."));
    }
    const ContentSerialization contentSerialization =
        protocol == NativeProtocol::ollamaChat          ? ContentSerialization::ollama
        : protocol == NativeProtocol::anthropicMessages ? ContentSerialization::anthropicMessages
        : protocol == NativeProtocol::geminiGenerateContent ? ContentSerialization::gemini
        : protocol == NativeProtocol::openAiResponses       ? ContentSerialization::openAiResponses
                                                            : ContentSerialization::textOnly;
    auto userPart = serializeContentParts(content, userContent, contentSerialization);
    if (!userPart)
        return std::unexpected(userPart.error());
    std::string body;
    if (protocol == NativeProtocol::ollamaChat) {
        body = "{\"model\":\"" + command::jsonEscape(modelId) +
               "\",\"stream\":" + std::string(enableStreaming ? "true" : "false");
        if (requireStructuredOutput)
            body += ",\"format\":\"json\"";
        body += ",\"messages\":[{\"role\":\"system\",\"content\":\"" +
                command::jsonEscape(systemPrompt) + "\"}," + *userPart +
                "],\"options\":{\"num_predict\":" + std::to_string(outputTokens) + "}}";
    } else if (protocol == NativeProtocol::anthropicMessages) {
        body = "{\"model\":\"" + command::jsonEscape(modelId) +
               "\",\"max_tokens\":" + std::to_string(outputTokens) +
               ",\"stream\":" + std::string(enableStreaming ? "true" : "false") + ",\"system\":\"" +
               command::jsonEscape(systemPrompt) +
               "\",\"messages\":[{\"role\":\"user\",\"content\":" + *userPart + "}]}";
    } else if (protocol == NativeProtocol::cohereChatV2) {
        body = "{\"model\":\"" + command::jsonEscape(modelId) +
               "\",\"stream\":" + std::string(enableStreaming ? "true" : "false") +
               ",\"max_tokens\":" + std::to_string(outputTokens) +
               ",\"messages\":[{\"role\":\"system\",\"content\":\"" +
               command::jsonEscape(systemPrompt) +
               "\"},{\"role\":\"user\",\"content\":" + *userPart + "}]}";
    } else if (protocol == NativeProtocol::perplexityAgent) {
        body = "{\"model\":\"" + command::jsonEscape(modelId) + "\",\"instructions\":\"" +
               command::jsonEscape(systemPrompt) + "\",\"input\":" + *userPart +
               ",\"max_output_tokens\":" + std::to_string(outputTokens) +
               ",\"stream\":" + std::string(enableStreaming ? "true" : "false") + "}";
    } else if (protocol == NativeProtocol::openAiResponses) {
        body = "{\"model\":\"" + command::jsonEscape(modelId) + "\",\"instructions\":\"" +
               command::jsonEscape(systemPrompt) +
               "\",\"input\":[{\"role\":\"user\",\"content\":" + *userPart +
               "}],\"max_output_tokens\":" + std::to_string(outputTokens) +
               ",\"stream\":" + std::string(enableStreaming ? "true" : "false");
        if (requireStructuredOutput)
            body += ",\"text\":{\"format\":{\"type\":\"json_object\"}}";
        body.push_back('}');
    } else {
        body = "{\"systemInstruction\":{\"parts\":[{\"text\":\"" +
               command::jsonEscape(systemPrompt) +
               "\"}]},\"contents\":[{\"role\":\"user\","
               "\"parts\":" +
               *userPart +
               "}],\"generationConfig\":{\"maxOutputTokens\":" + std::to_string(outputTokens);
        if (requireStructuredOutput)
            body += ",\"responseMimeType\":\"application/json\"";
        body += "}}";
    }
    if (body.size() > maximumResponseBytes ||
        !command::parseJson(body, 32, 100'000, maximumResponseBytes)) {
        sodium_memzero(body.data(), body.size());
        return std::unexpected(
            core::error("ai_request_invalid",
                        "The generation request is invalid or exceeds the 16 MiB limit."));
    }
    return body;
}

core::Result<std::vector<ProviderModel>> listNativeModels(NativeProtocol protocol,
                                                          std::string_view endpoint,
                                                          std::string_view apiKey,
                                                          std::function<bool()> cancelled) {
    if (auto status =
            validateEndpoint(endpoint, apiKey, protocol == NativeProtocol::perplexityAgent);
        !status)
        return std::unexpected(status.error());
    if (protocol == NativeProtocol::anthropicMessages)
        return parseAnthropicModels(endpoint, apiKey, std::move(cancelled));
    if (protocol == NativeProtocol::ollamaChat)
        return parseOllamaModels(endpoint, std::move(cancelled));
    if (protocol == NativeProtocol::cohereChatV2)
        return parseCohereModels(endpoint, apiKey, std::move(cancelled));
    if (protocol == NativeProtocol::perplexityAgent)
        return parsePerplexityModels(endpoint, apiKey, std::move(cancelled));
    return parseGeminiModels(endpoint, apiKey, std::move(cancelled));
}

core::Result<OllamaModelDetails> inspectOllamaModel(std::string_view endpoint,
                                                    std::string_view modelId,
                                                    std::function<bool()> cancelled) {
    if (auto status = validateEndpoint(endpoint, {}); !status)
        return std::unexpected(status.error());
    if (!validModelId(modelId))
        return std::unexpected(
            core::error("ai_model_id_invalid", "A valid Ollama model name is required."));
    if (cancelled && cancelled())
        return std::unexpected(
            core::error("ai_request_cancelled", "Model inspection was cancelled."));

    HttpRequest request;
    request.url = endpointUrl(ollamaBaseEndpoint(endpoint), "/api/show");
    request.method = "POST";
    request.headers.emplace_back("Content-Type", "application/json");
    request.maximumResponseBytes = 4U * 1024U * 1024U;
    request.timeout = std::chrono::seconds(30);
    request.cancelled = std::move(cancelled);
    request.body = "{\"model\":\"" + command::jsonEscape(modelId) + "\",\"verbose\":false}";
    auto response = performHttp(std::move(request));
    if (!response)
        return std::unexpected(response.error());
    if (response->cancelled)
        return std::unexpected(
            core::error("ai_request_cancelled", "Model inspection was cancelled."));
    if (response->responseTooLarge)
        return std::unexpected(
            core::error("ai_model_metadata_too_large", "Ollama model metadata exceeded 4 MiB."));
    if (!response->transportError.empty() || response->statusCode < 200 ||
        response->statusCode >= 300)
        return std::unexpected(httpError(*response));

    auto parsed = command::parseJson(response->body, 32, 200'000, 4U * 1024U * 1024U);
    const JsonValue::Object* root = parsed ? parsed->asObject() : nullptr;
    if (!root)
        return std::unexpected(
            core::error("ai_model_metadata_invalid", "Ollama returned invalid model metadata."));
    OllamaModelDetails details;
    if (const JsonValue::Object* modelDetails = objectAt(member(*root, "details"))) {
        details.family = readString(*modelDetails, "family");
        details.parameterSize = readString(*modelDetails, "parameter_size");
        details.quantizationLevel = readString(*modelDetails, "quantization_level");
    }
    if (const JsonValue::Array* capabilities = arrayAt(member(*root, "capabilities"))) {
        if (capabilities->size() > 64)
            return std::unexpected(core::error("ai_model_metadata_invalid",
                                               "Ollama returned too many model capabilities."));
        for (const JsonValue& capability : *capabilities) {
            const std::string* name = capability.asString();
            if (!name || name->empty() || name->size() > 128)
                return std::unexpected(core::error("ai_model_metadata_invalid",
                                                   "Ollama returned an invalid capability."));
            details.capabilities.push_back(*name);
        }
    }
    if (const JsonValue::Object* modelInfo = objectAt(member(*root, "model_info"))) {
        for (const auto& [name, value] : *modelInfo) {
            if (!name.ends_with(".context_length"))
                continue;
            const command::JsonNumber* number = std::get_if<command::JsonNumber>(&value.value);
            if (!number)
                continue;
            std::uint64_t contextLength{};
            const auto [end, errorCode] = std::from_chars(
                number->text.data(), number->text.data() + number->text.size(), contextLength);
            if (errorCode == std::errc{} && end == number->text.data() + number->text.size())
                details.contextLength = std::max(details.contextLength, contextLength);
        }
    }
    return details;
}

core::Result<std::vector<ProviderModel>>
listAlibabaModelStudioModels(std::string_view compatibleEndpoint, std::string_view apiKey,
                             std::function<bool()> cancelled) {
    if (auto status = validateEndpoint(compatibleEndpoint, apiKey); !status)
        return std::unexpected(status.error());
    constexpr std::string_view compatibleSuffix = "/compatible-mode/v1";
    std::string base = trimEndpoint(compatibleEndpoint);
    if (!base.ends_with(compatibleSuffix)) {
        return std::unexpected(
            core::error("ai_provider_endpoint_invalid",
                        "Alibaba model discovery requires a regional endpoint ending in "
                        "/compatible-mode/v1."));
    }
    base.resize(base.size() - compatibleSuffix.size());

    constexpr std::size_t pageSize = 100;
    constexpr std::size_t maximumPages = maximumModels / pageSize;
    std::vector<ProviderModel> models;
    std::unordered_set<std::string> seen;
    for (std::size_t pageNumber = 1; pageNumber <= maximumPages; ++pageNumber) {
        if (cancelled && cancelled())
            return std::unexpected(
                core::error("ai_request_cancelled", "Model discovery was cancelled."));
        HttpRequest request;
        request.url = base +
                      "/api/v1/models?capabilities=TG&page_no=" + std::to_string(pageNumber) +
                      "&page_size=" + std::to_string(pageSize);
        request.method = "GET";
        request.headers.emplace_back("Authorization", "Bearer " + std::string(apiKey));
        request.maximumResponseBytes = 4U * 1024U * 1024U;
        request.timeout = std::chrono::seconds(30);
        request.cancelled = cancelled;
        auto response = performHttp(std::move(request));
        if (!response)
            return std::unexpected(response.error());
        if (response->cancelled)
            return std::unexpected(
                core::error("ai_request_cancelled", "Model discovery was cancelled."));
        if (response->responseTooLarge)
            return std::unexpected(core::error("ai_model_catalog_too_large",
                                               "The provider model list exceeded 4 MiB."));
        if (!response->transportError.empty() || response->statusCode < 200 ||
            response->statusCode >= 300)
            return std::unexpected(httpError(*response));
        auto parsed = command::parseJson(response->body, 32, 200'000, 4U * 1024U * 1024U);
        const JsonValue::Object* root = parsed ? parsed->asObject() : nullptr;
        const JsonValue::Object* output = root ? objectAt(member(*root, "output")) : nullptr;
        const JsonValue::Array* entries = output ? arrayAt(member(*output, "models")) : nullptr;
        if (!entries || entries->size() > pageSize)
            return std::unexpected(core::error("ai_model_catalog_invalid",
                                               "The provider model catalog has an invalid shape."));
        for (const JsonValue& entry : *entries) {
            const JsonValue::Object* object = entry.asObject();
            const std::string id = object ? readString(*object, "model") : std::string{};
            if (id.empty() || id.size() > 1024)
                return std::unexpected(core::error("ai_model_catalog_invalid",
                                                   "A provider model entry has an invalid ID."));
            if (seen.insert(id).second) {
                std::string owner = readString(*object, "provider");
                if (owner.empty())
                    owner = readString(*object, "inference_provider");
                models.push_back({id, std::move(owner)});
            }
        }
        if (models.size() > maximumModels)
            return std::unexpected(core::error("ai_model_catalog_too_large",
                                               "The provider model catalog is too large."));
        const JsonValue* totalValue = member(*output, "total");
        const command::JsonNumber* totalNumber =
            totalValue ? std::get_if<command::JsonNumber>(&totalValue->value) : nullptr;
        std::size_t total{};
        if (totalNumber) {
            const auto [end, errorCode] =
                std::from_chars(totalNumber->text.data(),
                                totalNumber->text.data() + totalNumber->text.size(), total);
            if (errorCode != std::errc{} ||
                end != totalNumber->text.data() + totalNumber->text.size()) {
                return std::unexpected(core::error("ai_model_catalog_invalid",
                                                   "The provider model count is invalid."));
            }
            if (total > maximumModels)
                return std::unexpected(core::error("ai_model_catalog_too_large",
                                                   "The provider model catalog is too large."));
        }
        if (entries->size() < pageSize || (total != 0 && models.size() >= total))
            return models;
    }
    return std::unexpected(core::error("ai_model_catalog_too_large",
                                       "The provider model catalog exceeded 50,000 models."));
}

core::Result<GenerationResponse> generateNative(GenerationRequest request,
                                                NativeProtocol protocol) {
    GenerationInputWiper inputWiper(request);
    if (auto status = validateEndpoint(request.endpoint, request.apiKey); !status)
        return std::unexpected(status.error());
    if (!validModelId(request.modelId) || request.maximumOutputTokens == 0 ||
        request.maximumOutputTokens > maximumOutputTokens) {
        return std::unexpected(core::error(
            "ai_generation_request_invalid",
            "A valid model ID and output-token limit within 1 to 1,000,000 are required."));
    }
    auto bodyResult = nativeGenerationRequestBody(protocol, request.modelId, request.systemPrompt,
                                                  request.userContent, request.maximumOutputTokens,
                                                  request.content, request.enableStreaming,
                                                  request.requireStructuredOutput);
    if (!bodyResult)
        return std::unexpected(bodyResult.error());
    std::string body = std::move(*bodyResult);
    StringWiper bodyWiper(body);

    NativeStreamDecoder decoder(request, protocol);
    HttpRequest httpRequest;
    httpRequest.url = nativeGenerationEndpoint(protocol, request.endpoint, request.modelId,
                                               request.enableStreaming);
    httpRequest.method = "POST";
    httpRequest.accept =
        request.enableStreaming
            ? protocol == NativeProtocol::ollamaChat ? "application/x-ndjson" : "text/event-stream"
            : "application/json";
    httpRequest.headers.emplace_back("Content-Type", "application/json");
    if (protocol == NativeProtocol::anthropicMessages) {
        if (!request.apiKey.empty())
            httpRequest.headers.emplace_back("x-api-key", authorizationHeader(request.apiKey));
        httpRequest.headers.emplace_back("anthropic-version", "2023-06-01");
    } else if (protocol == NativeProtocol::cohereChatV2) {
        if (!request.apiKey.empty())
            httpRequest.headers.emplace_back("Authorization", "Bearer " + request.apiKey);
    } else if (protocol == NativeProtocol::perplexityAgent) {
        if (!request.apiKey.empty())
            httpRequest.headers.emplace_back("Authorization", "Bearer " + request.apiKey);
    } else if (protocol == NativeProtocol::openAiResponses) {
        if (!request.apiKey.empty())
            httpRequest.headers.emplace_back("Authorization", "Bearer " + request.apiKey);
    } else if (protocol == NativeProtocol::ollamaChat) {
        // Ollama local services do not use credentials.
    } else if (!request.apiKey.empty()) {
        httpRequest.headers.emplace_back("x-goog-api-key", authorizationHeader(request.apiKey));
    }
    httpRequest.body = body;
    httpRequest.maximumResponseBytes = maximumResponseBytes;
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
    if (!decoder.finish(generated.rawResponse, generated)) {
        generated.errorCode = "ai_response_invalid";
        generated.errorMessage = decoder.error();
        return generated;
    }
    if (generated.content.empty()) {
        generated.errorCode = "ai_response_empty";
        generated.errorMessage = "The provider returned no generated text.";
    }
    return generated;
}

} // namespace tutorux::ai
