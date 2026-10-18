#include "tutorux/ai/http.hpp"

#include <emscripten.h>
#include <emscripten/fetch.h>
#include <sodium.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <limits>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::ai {
namespace {

    constexpr std::size_t kMaximumHeaderBytes = 64U * 1024U;
    constexpr std::size_t kMaximumRequestBytes = 16U * 1024U * 1024U;

    struct TransferState final {
        std::mutex mutex;
        HttpResponse response;
        std::size_t maximumResponseBytes{};
        bool completed{};
        bool closeRequested{};
    };

    class SensitiveRequestWiper final {
      public:
        explicit SensitiveRequestWiper(HttpRequest& request)
            : request_(request) {}

        ~SensitiveRequestWiper() {
            if (!request_.body.empty())
                sodium_memzero(request_.body.data(), request_.body.size());
            for (auto& [name, value] : request_.headers) {
                static_cast<void>(name);
                if (!value.empty())
                    sodium_memzero(value.data(), value.size());
            }
        }

      private:
        HttpRequest& request_;
    };

    std::string lowerAscii(std::string_view value) {
        std::string normalized;
        normalized.reserve(value.size());
        for (const char character : value) {
            normalized.push_back(
                static_cast<char>(std::tolower(static_cast<unsigned char>(character))));
        }
        return normalized;
    }

    std::string_view urlHost(std::string_view url, std::string_view& scheme) {
        const std::size_t separator = url.find("://");
        if (separator == std::string_view::npos)
            return {};
        scheme = url.substr(0, separator);
        const std::size_t hostStart = separator + 3;
        const std::size_t hostEnd = url.find_first_of("/:?#", hostStart);
        return url.substr(hostStart,
                          hostEnd == std::string_view::npos ? url.size() - hostStart
                                                            : hostEnd - hostStart);
    }

    bool validRequestUrl(std::string_view url) {
        if (url.empty() || url.size() > 16U * 1024U ||
            std::any_of(url.begin(), url.end(), [](char rawCharacter) {
                const auto character = static_cast<unsigned char>(rawCharacter);
                return character <= 0x20U || character == 0x7fU || character == '\\';
            })) {
            return false;
        }
        std::string_view scheme;
        const std::string_view host = urlHost(url, scheme);
        if (host.empty() || host.find('@') != std::string_view::npos)
            return false;
        const std::string normalizedScheme = lowerAscii(scheme);
        return normalizedScheme == "https" || isLoopbackHttpUrl(url);
    }

    bool validHeaderName(std::string_view name) {
        if (name.empty())
            return false;
        constexpr std::string_view punctuation{"!#$%&'*+-.^_`|~"};
        return std::all_of(name.begin(), name.end(), [punctuation](char rawCharacter) {
            const auto character = static_cast<unsigned char>(rawCharacter);
            return (character >= 'a' && character <= 'z') ||
                   (character >= 'A' && character <= 'Z') ||
                   (character >= '0' && character <= '9') ||
                   punctuation.find(rawCharacter) != std::string_view::npos;
        });
    }

    bool validHeaderValue(std::string_view value) {
        return std::all_of(value.begin(), value.end(), [](char rawCharacter) {
            const auto character = static_cast<unsigned char>(rawCharacter);
            return character == '\t' || (character >= 0x20U && character != 0x7fU);
        });
    }

    void finishFetch(emscripten_fetch_t* fetch, bool transportSucceeded) {
        auto* state = static_cast<TransferState*>(fetch->userData);
        if (!state) {
            emscripten_fetch_close(fetch);
            return;
        }
        bool closeAfterCallback = false;
        {
            std::lock_guard lock(state->mutex);
            state->response.statusCode = static_cast<long>(fetch->status);
            if (fetch->numBytes > state->maximumResponseBytes) {
                state->response.responseTooLarge = true;
            } else if (fetch->numBytes > 0 && fetch->data) {
                state->response.body.assign(fetch->data, static_cast<std::size_t>(fetch->numBytes));
            }
            if (!transportSucceeded && fetch->status == 0) {
                state->response.transportError = fetch->statusText;
                if (state->response.transportError.empty())
                    state->response.transportError = "Browser network request failed.";
            }
            const std::size_t responseHeaderBytes =
                emscripten_fetch_get_response_headers_length(fetch);
            if (responseHeaderBytes > 0 && responseHeaderBytes <= kMaximumHeaderBytes) {
                std::vector<char> responseHeaders(responseHeaderBytes + 1U, '\0');
                const std::size_t copiedBytes =
                    emscripten_fetch_get_response_headers(fetch,
                                                          responseHeaders.data(),
                                                          responseHeaders.size());
                std::string_view headers(responseHeaders.data(),
                                         std::min(copiedBytes, responseHeaderBytes));
                std::size_t lineStart = 0;
                while (lineStart < headers.size()) {
                    const std::size_t lineEnd = headers.find("\r\n", lineStart);
                    const std::string_view line = headers.substr(lineStart,
                                                                 lineEnd == std::string_view::npos
                                                                     ? headers.size() - lineStart
                                                                     : lineEnd - lineStart);
                    const std::size_t separator = line.find(':');
                    if (separator != std::string_view::npos) {
                        const std::string name = lowerAscii(line.substr(0, separator));
                        std::string_view value = line.substr(separator + 1U);
                        while (!value.empty() && (value.front() == ' ' || value.front() == '\t'))
                            value.remove_prefix(1);
                        if (name == "content-type")
                            state->response.contentType = value;
                        else if (name == "retry-after")
                            state->response.retryAfter = value;
                    }
                    if (lineEnd == std::string_view::npos)
                        break;
                    lineStart = lineEnd + 2U;
                }
            }
            state->completed = true;
            closeAfterCallback = !state->closeRequested;
            state->closeRequested = true;
        }
        if (closeAfterCallback)
            emscripten_fetch_close(fetch);
    }

    void fetchSucceeded(emscripten_fetch_t* fetch) {
        finishFetch(fetch, true);
    }

    void fetchFailed(emscripten_fetch_t* fetch) {
        finishFetch(fetch, false);
    }

    void fetchProgress(emscripten_fetch_t* fetch) {
        auto* state = static_cast<TransferState*>(fetch->userData);
        if (!state)
            return;
        const std::uint64_t maximumBytes = static_cast<std::uint64_t>(state->maximumResponseBytes);
        const std::uint64_t receivedBytes =
            fetch->numBytes > std::numeric_limits<std::uint64_t>::max() - fetch->dataOffset
                ? std::numeric_limits<std::uint64_t>::max()
                : fetch->dataOffset + fetch->numBytes;
        const std::uint64_t observedBytes = std::max(fetch->totalBytes, receivedBytes);
        if (observedBytes <= maximumBytes)
            return;
        {
            std::lock_guard lock(state->mutex);
            state->response.responseTooLarge = true;
            state->closeRequested = true;
        }
        emscripten_fetch_close(fetch);
    }

    std::vector<const char*> makeHeaderPointers(const std::vector<std::string>& headers) {
        std::vector<const char*> pointers;
        pointers.reserve(headers.size() + 1U);
        for (const std::string& header : headers)
            pointers.push_back(header.c_str());
        pointers.push_back(nullptr);
        return pointers;
    }

} // namespace

bool isLoopbackHttpUrl(std::string_view url) {
    std::string_view scheme;
    const std::string_view authority = urlHost(url, scheme);
    if (lowerAscii(scheme) != "http" || authority.empty() ||
        authority.find('@') != std::string_view::npos) {
        return false;
    }

    std::string_view host = authority;
    if (host.front() == '[') {
        const std::size_t bracket = host.find(']');
        if (bracket == std::string_view::npos)
            return false;
        const std::string_view suffix = host.substr(bracket + 1);
        if (!suffix.empty() &&
            (suffix.front() != ':' || suffix.size() == 1U ||
             suffix.find_first_not_of("0123456789", 1U) != std::string_view::npos)) {
            return false;
        }
        host = host.substr(0, bracket + 1);
    } else if (const std::size_t colon = host.find(':'); colon != std::string_view::npos) {
        const std::string_view port = host.substr(colon + 1);
        if (port.empty() || port.find_first_not_of("0123456789") != std::string_view::npos)
            return false;
        host = host.substr(0, colon);
    }

    const std::string normalizedHost = lowerAscii(host);
    return normalizedHost == "localhost" || normalizedHost == "127.0.0.1" ||
           normalizedHost == "[::1]";
}

core::Result<HttpResponse> performHttp(HttpRequest request) {
    SensitiveRequestWiper requestWiper(request);
    if (!validRequestUrl(request.url)) {
        return std::unexpected(core::error(
            "ai_http_url_invalid",
            "Browser requests require HTTPS, or plain HTTP to a loopback address, with no user "
            "information in the URL."));
    }
    if (request.body.size() > kMaximumRequestBytes) {
        return std::unexpected(
            core::error("ai_http_request_too_large", "Browser AI requests are limited to 16 MiB."));
    }
    if (request.method.empty() || request.method.size() >= 32U ||
        !validHeaderName(request.method) || !validHeaderValue(request.accept)) {
        return std::unexpected(core::error("ai_http_request_invalid",
                                           "Browser request method or Accept header is invalid."));
    }
    if (request.maximumResponseBytes == 0 || request.maximumResponseBytes > kMaximumRequestBytes ||
        request.accept.size() > kMaximumHeaderBytes ||
        request.timeout <= std::chrono::milliseconds::zero()) {
        return std::unexpected(core::error(
            "ai_http_limits_invalid",
            "Browser request limits must allow a response and a positive timeout under 16 MiB."));
    }
    if (request.cancelled && request.cancelled()) {
        HttpResponse cancelled;
        cancelled.cancelled = true;
        return cancelled;
    }

    std::vector<std::string> requestHeaders;
    std::size_t headerBytes = request.accept.size();
    requestHeaders.reserve(request.headers.size() + 1U);
    if (!request.accept.empty()) {
        requestHeaders.push_back("Accept");
        requestHeaders.push_back(request.accept);
    }
    for (const auto& [name, value] : request.headers) {
        if (!validHeaderName(name) || !validHeaderValue(value)) {
            return std::unexpected(
                core::error("ai_http_header_invalid",
                            "Browser request headers contain an invalid name or value."));
        }
        if (headerBytes > kMaximumHeaderBytes - 2U ||
            name.size() > kMaximumHeaderBytes - headerBytes - 2U ||
            value.size() > kMaximumHeaderBytes - headerBytes - 2U - name.size()) {
            return std::unexpected(core::error("ai_http_headers_too_large",
                                               "Browser request headers exceed the 64 KiB limit."));
        }
        headerBytes += name.size() + value.size() + 2U;
        requestHeaders.push_back(name);
        requestHeaders.push_back(value);
    }
    const std::vector<const char*> headerPointers = makeHeaderPointers(requestHeaders);

    const auto timeoutCount = std::min<std::int64_t>(
        request.timeout.count(),
        static_cast<std::int64_t>(std::numeric_limits<std::uint32_t>::max()));
    emscripten_fetch_attr_t attributes{};
    emscripten_fetch_attr_init(&attributes);
    const std::size_t methodLength =
        std::min(request.method.size(), sizeof(attributes.requestMethod) - 1U);
    std::copy_n(request.method.data(), methodLength, attributes.requestMethod);
    attributes.requestMethod[methodLength] = '\0';
    attributes.attributes = EMSCRIPTEN_FETCH_LOAD_TO_MEMORY | EMSCRIPTEN_FETCH_REPLACE;
    attributes.requestHeaders = requestHeaders.empty() ? nullptr : headerPointers.data();
    attributes.requestData = request.body.empty() ? nullptr : request.body.data();
    attributes.requestDataSize = request.body.size();
    attributes.timeoutMSecs = static_cast<std::uint32_t>(timeoutCount);
    attributes.onsuccess = fetchSucceeded;
    attributes.onerror = fetchFailed;

    TransferState state;
    state.maximumResponseBytes = request.maximumResponseBytes;
    attributes.userData = &state;
    attributes.onprogress = fetchProgress;
    emscripten_fetch_t* fetch = emscripten_fetch(&attributes, request.url.c_str());
    if (!fetch) {
        return std::unexpected(core::error("ai_http_initialization_failed",
                                           "The browser could not start the network request."));
    }

    const auto effectiveTimeout = std::chrono::milliseconds(timeoutCount);
    const auto deadline = std::chrono::steady_clock::now() + effectiveTimeout;
    while (true) {
        {
            std::lock_guard lock(state.mutex);
            if (state.completed)
                break;
        }
        if (request.cancelled && request.cancelled()) {
            {
                std::lock_guard lock(state.mutex);
                state.closeRequested = true;
            }
            emscripten_fetch_close(fetch);
            HttpResponse cancelled;
            cancelled.cancelled = true;
            return cancelled;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            {
                std::lock_guard lock(state.mutex);
                state.closeRequested = true;
            }
            emscripten_fetch_close(fetch);
            return std::unexpected(
                core::error("ai_http_timeout",
                            "The browser network request exceeded its configured timeout."));
        }
        emscripten_sleep(10);
    }

    HttpResponse response;
    {
        std::lock_guard lock(state.mutex);
        response = std::move(state.response);
    }
    if (response.body.size() > request.maximumResponseBytes) {
        response.body.clear();
        response.responseTooLarge = true;
    }
    if (request.onChunk && !response.body.empty() && !request.onChunk(response.body))
        response.callbackAborted = true;
    return response;
}

} // namespace tutorux::ai
