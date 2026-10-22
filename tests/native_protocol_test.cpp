// Native provider protocol coverage against real loopback HTTP responses.
#include "tutorux/ai/cloudflare.hpp"
#include "tutorux/ai/native_protocol.hpp"
#include "tutorux/ai/replicate.hpp"

#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {

#ifdef _WIN32
using NativeSocket = SOCKET;
constexpr NativeSocket invalidSocket = INVALID_SOCKET;
void closeSocket(NativeSocket socket) {
    if (socket != invalidSocket)
        closesocket(socket);
}
#else
using NativeSocket = int;
constexpr NativeSocket invalidSocket = -1;
void closeSocket(NativeSocket socket) {
    if (socket != invalidSocket)
        ::close(socket);
}
#endif

bool expect(bool condition, std::string_view label) {
    if (condition)
        return true;
    std::cerr << "native protocols: " << label << '\n';
    return false;
}

class SocketRuntime final {
  public:
    bool start() {
#ifdef _WIN32
        WSADATA data{};
        return WSAStartup(MAKEWORD(2, 2), &data) == 0;
#else
        return true;
#endif
    }
    ~SocketRuntime() {
#ifdef _WIN32
        WSACleanup();
#endif
    }
};

class OneShotServer final {
  public:
    ~OneShotServer() {
        closeSocket(listener_);
        if (worker_.joinable())
            worker_.join();
    }

    bool start(std::string body, std::string contentType = "application/json") {
        listener_ = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (listener_ == invalidSocket)
            return false;
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address.sin_port = 0;
#ifdef _WIN32
        int addressLength = sizeof(address);
#else
        socklen_t addressLength = sizeof(address);
#endif
        if (::bind(listener_, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0 ||
            ::getsockname(listener_, reinterpret_cast<sockaddr*>(&address), &addressLength) != 0 ||
            ::listen(listener_, 1) != 0) {
            return false;
        }
        port_ = ntohs(address.sin_port);
        worker_ = std::thread([this, body = std::move(body),
                               contentType = std::move(contentType)]() {
            const NativeSocket client = ::accept(listener_, nullptr, nullptr);
            if (client == invalidSocket)
                return;
            std::array<char, 4096> buffer{};
            std::string request;
            while (request.find("\r\n\r\n") == std::string::npos) {
#ifdef _WIN32
                const int count = ::recv(client, buffer.data(), static_cast<int>(buffer.size()), 0);
#else
                const ssize_t count = ::recv(client, buffer.data(), buffer.size(), 0);
#endif
                if (count <= 0)
                    break;
                request.append(buffer.data(), static_cast<std::size_t>(count));
            }
            const std::size_t headerEnd = request.find("\r\n\r\n");
            std::size_t contentLength = 0;
            if (headerEnd != std::string::npos) {
                const std::size_t lengthHeader = request.find("Content-Length:");
                if (lengthHeader != std::string::npos) {
                    const std::size_t valueStart =
                        request.find_first_not_of(" \t", lengthHeader + 15);
                    const std::size_t valueEnd = request.find("\r\n", valueStart);
                    static_cast<void>(std::from_chars(request.data() + valueStart,
                                                      request.data() + valueEnd,
                                                      contentLength));
                }
                while (request.size() - (headerEnd + 4) < contentLength) {
#ifdef _WIN32
                    const int count =
                        ::recv(client, buffer.data(), static_cast<int>(buffer.size()), 0);
#else
                    const ssize_t count = ::recv(client, buffer.data(), buffer.size(), 0);
#endif
                    if (count <= 0)
                        break;
                    request.append(buffer.data(), static_cast<std::size_t>(count));
                }
            }
            request_ = request;
            const std::string response = "HTTP/1.1 200 OK\r\nContent-Type: " + contentType +
                                         "\r\nContent-Length: " + std::to_string(body.size()) +
                                         "\r\nConnection: close\r\n\r\n" + body;
            std::size_t offset = 0;
            while (offset < response.size()) {
#ifdef _WIN32
                const int count = ::send(client, response.data() + offset,
                                         static_cast<int>(response.size() - offset), 0);
#else
                const ssize_t count =
                    ::send(client, response.data() + offset, response.size() - offset, 0);
#endif
                if (count <= 0)
                    break;
                offset += static_cast<std::size_t>(count);
            }
            closeSocket(client);
        });
        return true;
    }

    std::string url(std::string_view path = {}) const {
        return "http://127.0.0.1:" + std::to_string(port_) + std::string(path);
    }

    const std::string& request() const {
        return request_;
    }

    void join() {
        if (worker_.joinable())
            worker_.join();
    }

  private:
    NativeSocket listener_{invalidSocket};
    std::uint16_t port_{};
    std::thread worker_;
    std::string request_;
};

bool contains(std::string_view haystack, std::string_view needle) {
    return haystack.find(needle) != std::string_view::npos;
}

} // namespace

int main() {
    using namespace tutorux;
    SocketRuntime runtime;
    if (!runtime.start())
        return 1;
    bool okay = true;

    // Endpoint and request-body contracts.
    okay &= expect(ai::nativeGenerationEndpoint(ai::NativeProtocol::anthropicMessages,
                                                "http://127.0.0.1:1/v1", "claude", false) ==
                       "http://127.0.0.1:1/v1/v1/messages",
                   "Anthropic endpoint is wrong");
    okay &= expect(ai::nativeGenerationEndpoint(ai::NativeProtocol::geminiGenerateContent,
                                                "http://127.0.0.1:1/v1beta", "models/gemini", false) ==
                       "http://127.0.0.1:1/v1beta/models/gemini:generateContent",
                   "Gemini endpoint is wrong");
    okay &= expect(ai::nativeGenerationEndpoint(ai::NativeProtocol::cohereChatV2,
                                                "http://127.0.0.1:1", "command", false) ==
                       "http://127.0.0.1:1/v2/chat",
                   "Cohere endpoint is wrong");
    okay &= expect(ai::nativeGenerationEndpoint(ai::NativeProtocol::perplexityAgent,
                                                "http://127.0.0.1:1", "sonar", false) ==
                       "http://127.0.0.1:1/agent",
                   "Perplexity endpoint is wrong");
    okay &= expect(ai::nativeGenerationEndpoint(ai::NativeProtocol::openAiResponses,
                                                "http://127.0.0.1:1", "gpt", false) ==
                       "http://127.0.0.1:1/responses",
                   "Responses endpoint is wrong");
    okay &= expect(ai::nativeGenerationEndpoint(ai::NativeProtocol::ollamaChat,
                                                "http://127.0.0.1:1/v1", "llama", false) ==
                       "http://127.0.0.1:1/api/chat",
                   "Ollama endpoint is wrong");

    const std::array protocols{
        ai::NativeProtocol::anthropicMessages, ai::NativeProtocol::geminiGenerateContent,
        ai::NativeProtocol::cohereChatV2,      ai::NativeProtocol::perplexityAgent,
        ai::NativeProtocol::openAiResponses,   ai::NativeProtocol::ollamaChat};
    const std::array names{"anthropic", "gemini", "cohere", "perplexity", "responses", "ollama"};
    for (std::size_t index = 0; index < protocols.size(); ++index) {
        const auto protocol = protocols[index];
        auto body = ai::nativeGenerationRequestBody(protocol, "fixture-model", "System prompt",
                                                    "User content", 256, {}, true, false);
        const bool streamField =
            protocol == ai::NativeProtocol::geminiGenerateContent ||
            (body && contains(*body, "\"stream\":true"));
        const bool valid =
            body && (protocol == ai::NativeProtocol::geminiGenerateContent ||
                     contains(*body, "fixture-model")) &&
            contains(*body, "System prompt") && contains(*body, "User content") && streamField;
        if (!valid && body)
            std::cerr << "native protocols: body " << names[index] << ": " << *body << '\n';
        okay &= expect(valid, std::string("native request body is incomplete: ") +
                                  names[index]);
    }
    auto structured = ai::nativeGenerationRequestBody(
        ai::NativeProtocol::geminiGenerateContent, "gemini", "system", "user", 10, {}, false,
        true);
    okay &= expect(structured && contains(*structured, "responseMimeType"),
                   "Gemini structured output is not requested");
    okay &= expect(!ai::nativeGenerationRequestBody(ai::NativeProtocol::anthropicMessages,
                                                    "claude", "system", "user", 10, {}, false,
                                                    true),
                   "unsupported structured output was accepted");
    okay &= expect(!ai::nativeGenerationRequestBody(ai::NativeProtocol::anthropicMessages, "",
                                                    "system", "user", 10),
                   "empty model ID was accepted");
    okay &= expect(!ai::nativeGenerationRequestBody(ai::NativeProtocol::anthropicMessages,
                                                    "claude", "system", "user", 0),
                   "zero output tokens was accepted");

    struct Fixture final {
        ai::NativeProtocol protocol;
        std::string_view response;
        std::string_view expectedRequestPath;
    };
    constexpr std::array fixtures{
        Fixture{ai::NativeProtocol::anthropicMessages,
                "{\"id\":\"msg-1\",\"model\":\"fixture-model\",\"content\":[{\"type\":\"text\","
                "\"text\":\"guide text\"}]}",
                "/v1/messages"},
        Fixture{ai::NativeProtocol::geminiGenerateContent,
                "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"guide text\"}]}}],"
                "\"modelVersion\":\"fixture-model\"}",
                ":generateContent"},
        Fixture{ai::NativeProtocol::cohereChatV2,
                "{\"id\":\"cohere-1\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":"
                "\"guide text\"}]}}",
                "/v2/chat"},
        Fixture{ai::NativeProtocol::perplexityAgent,
                "{\"id\":\"perplexity-1\",\"model\":\"fixture-model\",\"output\":[{\"content\":"
                "[{\"type\":\"output_text\",\"text\":\"guide text\"}]}]}",
                "/agent"},
        Fixture{ai::NativeProtocol::openAiResponses,
                "{\"id\":\"resp-1\",\"model\":\"fixture-model\",\"output\":[{\"content\":[{\"type\":"
                "\"output_text\",\"text\":\"guide text\"}]}]}",
                "/responses"},
        Fixture{ai::NativeProtocol::ollamaChat,
                "{\"model\":\"fixture-model\",\"message\":{\"content\":\"guide text\"},\"done\":true}",
                "/api/chat"},
    };
    for (const auto& fixture : fixtures) {
        OneShotServer server;
        okay &= expect(server.start(std::string(fixture.response)),
                       "native response server failed");
        ai::GenerationRequest request;
        request.endpoint = server.url();
        request.modelId = "fixture-model";
        request.systemPrompt = "system";
        request.userContent = "user";
        request.maximumOutputTokens = 256;
        request.enableStreaming = false;
        auto generated = ai::generateNative(std::move(request), fixture.protocol);
        server.join();
        okay &= expect(generated && generated->statusCode == 200 &&
                           generated->content == "guide text" &&
                           contains(server.request(), std::string(fixture.expectedRequestPath)),
                       "native generation failed: " + std::string(fixture.expectedRequestPath));
        if (generated && generated->content != "guide text") {
            std::cerr << "native protocols: content=" << generated->content
                      << " error=" << generated->errorMessage << '\n';
        }
    }

    // Model discovery for the native catalog shapes.
    {
        OneShotServer anthropic;
        anthropic.start("{\"data\":[{\"id\":\"claude-fixture\",\"display_name\":\"Claude\"}]}");
        auto models = ai::listNativeModels(ai::NativeProtocol::anthropicMessages,
                                           anthropic.url(), "fixture-key");
        anthropic.join();
        okay &= expect(models && models->size() == 1 &&
                           models->front().id == "claude-fixture",
                       "Anthropic model discovery failed");
    }
    {
        OneShotServer gemini;
        gemini.start("{\"models\":[{\"name\":\"models/gemini-fixture\","
                     "\"displayName\":\"Gemini\","
                     "\"supportedGenerationMethods\":[\"generateContent\"]}]}");
        auto models = ai::listNativeModels(ai::NativeProtocol::geminiGenerateContent,
                                           gemini.url(), "fixture-key");
        gemini.join();
        okay &= expect(models && models->size() == 1 &&
                           models->front().id == "gemini-fixture",
                       "Gemini model discovery failed");
    }
    {
        OneShotServer ollama;
        ollama.start("{\"models\":[{\"name\":\"llama-fixture\",\"model\":\"llama-fixture\","
                     "\"details\":{\"family\":\"llama\",\"parameter_size\":\"8B\"}}]}");
        auto models = ai::listNativeModels(ai::NativeProtocol::ollamaChat, ollama.url(), {});
        ollama.join();
        okay &= expect(models && models->size() == 1 &&
                           models->front().id == "llama-fixture",
                       "Ollama model discovery failed");
    }
    {
        OneShotServer ollama;
        ollama.start("{\"details\":{\"family\":\"llama\",\"parameter_size\":\"8B\","
                     "\"quantization_level\":\"Q4\"},\"capabilities\":[\"completion\"],"
                     "\"model_info\":{\"general.context_length\":32768}}");
        auto details = ai::inspectOllamaModel(ollama.url(), "llama-fixture");
        ollama.join();
        okay &= expect(details && details->family == "llama" &&
                           details->contextLength == 32768 &&
                           details->capabilities.size() == 1,
                       "Ollama model inspection failed");
    }

    // Replicate request planning and validation.
    {
        ai::GenerationRequest request;
        request.endpoint = "https://api.replicate.com/v1";
        request.modelId = "owner/model";
        request.apiKey = "fixture-token";
        request.systemPrompt = "system";
        request.userContent = "content";
        request.maximumOutputTokens = 100;
        request.modelId = "invalid-model";
        okay &= expect(!ai::prepareReplicateGeneration(request),
                       "invalid Replicate model ID accepted");
        okay &= expect(!ai::listReplicateModels("", {}),
                       "Replicate model discovery accepted a missing token");
    }

    // Cloudflare endpoint and token validation.
    {
        okay &= expect(!ai::listCloudflareWorkersAiModels(
                           "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1", {}),
                       "Cloudflare discovery accepted a missing token");
        okay &= expect(!ai::listCloudflareWorkersAiModels(
                           "http://api.cloudflare.com/client/v4/accounts/abc/ai/v1",
                           "token"),
                       "Cloudflare discovery accepted a non-HTTPS endpoint");
        okay &= expect(!ai::listCloudflareWorkersAiModels(
                           "https://api.cloudflare.com/client/v4/accounts/abc/other",
                           "token"),
                       "Cloudflare discovery accepted a non-AI endpoint");
    }

    return okay ? 0 : 1;
}
