#include "tutorux/ai/http.hpp"

#include <curl/curl.h>
#include <sodium.h>

#include <algorithm>
#include <cctype>
#include <limits>
#include <mutex>
#include <string_view>

namespace tutorux::ai {
namespace {

    constexpr std::size_t maximumHeaderBytes = 64U * 1024U;
    constexpr std::size_t maximumRequestBodyBytes = 16U * 1024U * 1024U;

    struct TransferState final {
        HttpRequest* request{};
        HttpResponse* response{};
        std::size_t headerBytes{};
        bool callbackFailed{};
    };

    class CurlHandle final {
      public:
        explicit CurlHandle(CURL* handle) noexcept
            : handle_(handle) {}
        ~CurlHandle() {
            if (handle_)
                curl_easy_cleanup(handle_);
        }
        CurlHandle(const CurlHandle&) = delete;
        CurlHandle& operator=(const CurlHandle&) = delete;
        CURL* get() const noexcept {
            return handle_;
        }

      private:
        CURL* handle_{};
    };

    class CurlHeaders final {
      public:
        ~CurlHeaders() {
            for (curl_slist* current = headers_; current; current = current->next) {
                if (current->data)
                    sodium_memzero(current->data, std::char_traits<char>::length(current->data));
            }
            curl_slist_free_all(headers_);
        }
        CurlHeaders(const CurlHeaders&) = delete;
        CurlHeaders& operator=(const CurlHeaders&) = delete;
        CurlHeaders() = default;

        bool append(std::string_view value) {
            std::string terminated(value);
            curl_slist* next = curl_slist_append(headers_, terminated.c_str());
            if (!terminated.empty())
                sodium_memzero(terminated.data(), terminated.size());
            if (!next)
                return false;
            headers_ = next;
            return true;
        }

        curl_slist* get() const noexcept {
            return headers_;
        }

      private:
        curl_slist* headers_{};
    };

    class SensitiveRequestWiper final {
      public:
        explicit SensitiveRequestWiper(HttpRequest& request) noexcept
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

    std::string trim(std::string_view text) {
        while (!text.empty() && (text.back() == '\r' || text.back() == '\n' || text.back() == ' ' ||
                                 text.back() == '\t')) {
            text.remove_suffix(1);
        }
        while (!text.empty() && (text.front() == ' ' || text.front() == '\t'))
            text.remove_prefix(1);
        return std::string(text);
    }

    bool isLoopbackHost(std::string_view host) {
        std::string normalized;
        normalized.reserve(host.size());
        for (const char character : host)
            normalized.push_back(
                static_cast<char>(std::tolower(static_cast<unsigned char>(character))));
        return normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1" ||
               normalized == "[::1]";
    }

    bool isLoopbackHttpUrlImpl(std::string_view url) {
        CURLU* parsed = curl_url();
        if (!parsed)
            return false;
        const CURLUcode parseResult =
            curl_url_set(parsed, CURLUPART_URL, std::string(url).c_str(), 0);
        char* schemeValue = nullptr;
        char* hostValue = nullptr;
        char* userValue = nullptr;
        char* passwordValue = nullptr;
        const bool partsRead =
            parseResult == CURLUE_OK &&
            curl_url_get(parsed, CURLUPART_SCHEME, &schemeValue, 0) == CURLUE_OK &&
            curl_url_get(parsed, CURLUPART_HOST, &hostValue, 0) == CURLUE_OK;
        const bool hasUser = curl_url_get(parsed, CURLUPART_USER, &userValue, 0) == CURLUE_OK;
        const bool hasPassword =
            curl_url_get(parsed, CURLUPART_PASSWORD, &passwordValue, 0) == CURLUE_OK;
        const bool loopback = partsRead && !hasUser && !hasPassword &&
                              url.find_first_of("?#\r\n") == std::string_view::npos &&
                              std::string_view(schemeValue) == "http" && isLoopbackHost(hostValue);
        curl_free(schemeValue);
        curl_free(hostValue);
        curl_free(userValue);
        curl_free(passwordValue);
        curl_url_cleanup(parsed);
        return loopback;
    }

    core::Status validateUrl(std::string_view url) {
        CURLU* parsed = curl_url();
        if (!parsed)
            return std::unexpected(
                core::error("ai_http_initialization_failed", "Unable to validate request URL."));
        const CURLUcode parseResult =
            curl_url_set(parsed, CURLUPART_URL, std::string(url).c_str(), 0);
        char* schemeValue = nullptr;
        char* hostValue = nullptr;
        char* userValue = nullptr;
        char* passwordValue = nullptr;
        const bool partsRead =
            parseResult == CURLUE_OK &&
            curl_url_get(parsed, CURLUPART_SCHEME, &schemeValue, 0) == CURLUE_OK &&
            curl_url_get(parsed, CURLUPART_HOST, &hostValue, 0) == CURLUE_OK;
        const bool hasUser = curl_url_get(parsed, CURLUPART_USER, &userValue, 0) == CURLUE_OK;
        const bool hasPassword =
            curl_url_get(parsed, CURLUPART_PASSWORD, &passwordValue, 0) == CURLUE_OK;
        bool valid = false;
        if (partsRead && !hasUser && !hasPassword) {
            const std::string_view scheme(schemeValue);
            const std::string_view host(hostValue);
            valid = scheme == "https" || (scheme == "http" && isLoopbackHost(host));
        }
        curl_free(schemeValue);
        curl_free(hostValue);
        curl_free(userValue);
        curl_free(passwordValue);
        curl_url_cleanup(parsed);
        if (!valid) {
            return std::unexpected(core::error("ai_http_url_invalid",
                                               "AI requests require HTTPS; plain HTTP is "
                                               "allowed only for a loopback service."));
        }
        return {};
    }

    std::size_t writeBody(char* data, std::size_t size, std::size_t count, void* userData) {
        if (size != 0 && count > std::numeric_limits<std::size_t>::max() / size)
            return 0;
        const std::size_t byteCount = size * count;
        auto& state = *static_cast<TransferState*>(userData);
        if (byteCount > state.request->maximumResponseBytes - state.response->body.size()) {
            state.response->responseTooLarge = true;
            return 0;
        }
        try {
            const std::string_view chunk(data, byteCount);
            state.response->body.append(chunk);
            if (state.request->onChunk && !state.request->onChunk(chunk)) {
                state.response->callbackAborted = true;
                return 0;
            }
            return byteCount;
        } catch (...) {
            state.callbackFailed = true;
            return 0;
        }
    }

    std::size_t readHeader(char* data, std::size_t size, std::size_t count, void* userData) {
        if (size != 0 && count > std::numeric_limits<std::size_t>::max() / size)
            return 0;
        const std::size_t byteCount = size * count;
        auto& state = *static_cast<TransferState*>(userData);
        if (byteCount > maximumHeaderBytes - state.headerBytes)
            return 0;
        state.headerBytes += byteCount;
        const std::string_view line(data, byteCount);
        const std::size_t separator = line.find(':');
        if (separator == std::string_view::npos)
            return byteCount;
        std::string name = trim(line.substr(0, separator));
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char character) {
            return static_cast<char>(std::tolower(character));
        });
        const std::string value = trim(line.substr(separator + 1));
        if (name == "content-type")
            state.response->contentType = value;
        else if (name == "retry-after")
            state.response->retryAfter = value;
        return byteCount;
    }

    int transferProgress(void* userData, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
        auto& state = *static_cast<TransferState*>(userData);
        if (!state.request->cancelled)
            return 0;
        try {
            if (state.request->cancelled()) {
                state.response->cancelled = true;
                return 1;
            }
        } catch (...) {
            state.callbackFailed = true;
            return 1;
        }
        return 0;
    }

    bool isValidHeader(std::string_view name, std::string_view value) {
        if (name.empty() || name.find_first_of(":\r\n") != std::string_view::npos ||
            value.find_first_of("\r\n") != std::string_view::npos) {
            return false;
        }
        return true;
    }

} // namespace

bool isLoopbackHttpUrl(std::string_view url) {
    return isLoopbackHttpUrlImpl(url);
}

core::Result<HttpResponse> performHttp(HttpRequest request) {
    SensitiveRequestWiper wiper(request);
    static std::once_flag globalInitialization;
    static CURLcode globalInitializationResult = CURLE_FAILED_INIT;
    std::call_once(globalInitialization, [] {
        globalInitializationResult = curl_global_init(CURL_GLOBAL_DEFAULT);
    });
    if (globalInitializationResult != CURLE_OK) {
        return std::unexpected(core::error("ai_http_initialization_failed",
                                           "Unable to initialize the HTTPS runtime."));
    }
    if (auto status = validateUrl(request.url); !status)
        return std::unexpected(status.error());
    if (request.method != "GET" && request.method != "POST") {
        return std::unexpected(
            core::error("ai_http_method_invalid", "AI requests support GET and POST only."));
    }
    if (request.body.size() > maximumRequestBodyBytes) {
        return std::unexpected(core::error("ai_http_request_too_large",
                                           "AI request body exceeds the 16 MiB transport limit."));
    }
    if (request.maximumResponseBytes == 0 || request.timeout.count() <= 0 ||
        request.connectTimeout.count() <= 0) {
        return std::unexpected(core::error("ai_http_limits_invalid",
                                           "AI request limits and timeouts must be positive."));
    }
    CurlHandle handle(curl_easy_init());
    if (!handle.get()) {
        return std::unexpected(
            core::error("ai_http_initialization_failed", "Unable to create an HTTPS request."));
    }

    CurlHeaders headers;
    if (!isValidHeader("Accept", request.accept) || !headers.append("Accept: " + request.accept)) {
        return std::unexpected(
            core::error("ai_http_initialization_failed", "Unable to allocate request headers."));
    }
    for (const auto& [name, value] : request.headers) {
        if (!isValidHeader(name, value) || !headers.append(name + ": " + value)) {
            return std::unexpected(
                core::error("ai_http_header_invalid", "AI request contains an invalid header."));
        }
    }

    HttpResponse response;
    TransferState state{&request, &response};
    char errorBuffer[CURL_ERROR_SIZE]{};
    const auto setOption = [&](CURLoption option, auto value) {
        return curl_easy_setopt(handle.get(), option, value) == CURLE_OK;
    };
    const long connectTimeout = static_cast<long>(
        std::min<std::int64_t>(request.connectTimeout.count(), std::numeric_limits<long>::max()));
    const long timeout = static_cast<long>(
        std::min<std::int64_t>(request.timeout.count(), std::numeric_limits<long>::max()));
    if (!setOption(CURLOPT_URL, request.url.c_str()) ||
        !setOption(CURLOPT_PROTOCOLS_STR, "http,https") ||
        !setOption(CURLOPT_REDIR_PROTOCOLS_STR, "https") ||
        !setOption(CURLOPT_FOLLOWLOCATION, 0L) || !setOption(CURLOPT_SSL_VERIFYPEER, 1L) ||
        !setOption(CURLOPT_SSL_VERIFYHOST, 2L) || !setOption(CURLOPT_NOSIGNAL, 1L) ||
        !setOption(CURLOPT_CONNECTTIMEOUT_MS, connectTimeout) ||
        !setOption(CURLOPT_TIMEOUT_MS, timeout) || !setOption(CURLOPT_HTTPHEADER, headers.get()) ||
        !setOption(CURLOPT_WRITEFUNCTION, &writeBody) || !setOption(CURLOPT_WRITEDATA, &state) ||
        !setOption(CURLOPT_HEADERFUNCTION, &readHeader) || !setOption(CURLOPT_HEADERDATA, &state) ||
        !setOption(CURLOPT_XFERINFOFUNCTION, &transferProgress) ||
        !setOption(CURLOPT_XFERINFODATA, &state) || !setOption(CURLOPT_NOPROGRESS, 0L) ||
        !setOption(CURLOPT_ERRORBUFFER, errorBuffer) ||
        !setOption(CURLOPT_USERAGENT, "Tutorux/1.0")) {
        return std::unexpected(
            core::error("ai_http_initialization_failed", "Unable to configure HTTPS request."));
    }
#ifdef _WIN32
    if (!setOption(CURLOPT_SSL_OPTIONS, CURLSSLOPT_NATIVE_CA)) {
        return std::unexpected(core::error(
            "ai_http_initialization_failed",
            "Unable to configure certificate verification with the Windows trust store."));
    }
#endif
    if (request.method == "GET") {
        if (!setOption(CURLOPT_HTTPGET, 1L)) {
            return std::unexpected(
                core::error("ai_http_initialization_failed", "Unable to configure GET request."));
        }
    } else {
        if (request.body.size() >
            static_cast<std::size_t>(std::numeric_limits<curl_off_t>::max())) {
            return std::unexpected(core::error("ai_http_request_too_large",
                                               "AI request body exceeds the transport limit."));
        }
        if (!setOption(CURLOPT_POST, 1L) || !setOption(CURLOPT_POSTFIELDS, request.body.data()) ||
            !setOption(CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(request.body.size()))) {
            return std::unexpected(
                core::error("ai_http_initialization_failed", "Unable to configure POST request."));
        }
    }

    const CURLcode transferCode = curl_easy_perform(handle.get());
    static_cast<void>(
        curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &response.statusCode));
    if (transferCode != CURLE_OK && !response.cancelled && !response.callbackAborted &&
        !response.responseTooLarge) {
        response.transportError =
            errorBuffer[0] == '\0' ? curl_easy_strerror(transferCode) : errorBuffer;
    }
    if (state.callbackFailed) {
        return std::unexpected(
            core::error("ai_http_callback_failed",
                        "An AI response callback failed while processing data."));
    }
    return response;
}

} // namespace tutorux::ai
