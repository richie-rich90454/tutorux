#include "tutorux/ai/http.hpp"
#include "tutorux/ai/http_retry.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <winhttp.h>

#include <sodium.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <cwctype>
#include <limits>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace tutorux::ai {
namespace {

    constexpr std::size_t maximumRequestBodyBytes = 16U * 1024U * 1024U;

    struct InternetHandle final {
        HINTERNET value{};

        InternetHandle() = default;
        explicit InternetHandle(HINTERNET handle) noexcept
            : value(handle) {}
        ~InternetHandle() {
            if (value)
                WinHttpCloseHandle(value);
        }
        InternetHandle(const InternetHandle&) = delete;
        InternetHandle& operator=(const InternetHandle&) = delete;
        InternetHandle(InternetHandle&& other) noexcept
            : value(other.value) {
            other.value = nullptr;
        }
        InternetHandle& operator=(InternetHandle&& other) noexcept {
            if (this != &other) {
                if (value)
                    WinHttpCloseHandle(value);
                value = other.value;
                other.value = nullptr;
            }
            return *this;
        }
        explicit operator bool() const noexcept {
            return value != nullptr;
        }
    };

    class WideStringWiper final {
      public:
        explicit WideStringWiper(std::wstring& value) noexcept
            : value_(value) {}
        ~WideStringWiper() {
            if (!value_.empty()) {
                SecureZeroMemory(value_.data(), value_.size() * sizeof(wchar_t));
            }
        }
        WideStringWiper(const WideStringWiper&) = delete;
        WideStringWiper& operator=(const WideStringWiper&) = delete;

      private:
        std::wstring& value_;
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

    core::Error transportError(std::string code, std::string message) {
        return core::error(std::move(code), std::move(message));
    }

    std::string lastErrorMessage(std::string_view operation) {
        return std::string(operation) + " failed with Windows error " +
               std::to_string(GetLastError()) + ".";
    }

    std::wstring widen(std::string_view value) {
        if (value.empty())
            return {};
        const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0);
        if (size <= 0)
            return {};
        std::wstring wide(static_cast<std::size_t>(size), L'\0');
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                static_cast<int>(value.size()), wide.data(), size) != size) {
            return {};
        }
        return wide;
    }

    std::string narrow(std::wstring_view value) {
        if (value.empty())
            return {};
        const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                                             nullptr, 0, nullptr, nullptr);
        if (size <= 0)
            return {};
        std::string narrow(static_cast<std::size_t>(size), '\0');
        if (WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                                narrow.data(), size, nullptr, nullptr) != size) {
            return {};
        }
        return narrow;
    }

    bool isLoopbackHost(std::wstring_view host) {
        std::wstring normalized(host);
        std::transform(normalized.begin(), normalized.end(), normalized.begin(),
                       [](wchar_t character) { return std::towlower(character); });
        return normalized == L"localhost" || normalized == L"127.0.0.1" ||
               normalized == L"::1" || normalized == L"[::1]";
    }

    bool isValidHeader(std::string_view name, std::string_view value) {
        return !name.empty() && name.find_first_of(":\r\n") == std::string_view::npos &&
               value.find_first_of("\r\n") == std::string_view::npos;
    }

    struct ParsedUrl final {
        std::wstring host;
        std::wstring path;
        INTERNET_PORT port{};
        bool secure{};
    };

    core::Result<ParsedUrl> parseUrl(std::string_view url, bool loopbackOnly) {
        if (url.empty() || url.size() > 65'535U ||
            url.find_first_of("\r\n#") != std::string_view::npos) {
            return std::unexpected(
                transportError("ai_http_url_invalid", "The request URL is not valid."));
        }
        const std::wstring wideUrl = widen(url);
        if (wideUrl.empty())
            return std::unexpected(
                transportError("ai_http_url_invalid", "The request URL is not valid UTF-8."));

        URL_COMPONENTS components{};
        components.dwStructSize = sizeof(components);
        components.dwSchemeLength = static_cast<DWORD>(-1);
        components.dwHostNameLength = static_cast<DWORD>(-1);
        components.dwUrlPathLength = static_cast<DWORD>(-1);
        components.dwExtraInfoLength = static_cast<DWORD>(-1);
        components.dwUserNameLength = static_cast<DWORD>(-1);
        components.dwPasswordLength = static_cast<DWORD>(-1);
        if (!WinHttpCrackUrl(wideUrl.c_str(), static_cast<DWORD>(wideUrl.size()), 0,
                             &components)) {
            return std::unexpected(
                transportError("ai_http_url_invalid", "The request URL could not be parsed."));
        }
        if (components.dwUserNameLength != 0 || components.dwPasswordLength != 0)
            return std::unexpected(transportError(
                "ai_http_url_invalid", "AI request URLs must not contain embedded credentials."));

        ParsedUrl parsed;
        parsed.host.assign(components.lpszHostName, components.dwHostNameLength);
        parsed.port = components.nPort;
        parsed.secure = components.nScheme == INTERNET_SCHEME_HTTPS;
        if (components.nScheme != INTERNET_SCHEME_HTTPS &&
            !(components.nScheme == INTERNET_SCHEME_HTTP && isLoopbackHost(parsed.host))) {
            return std::unexpected(transportError(
                "ai_http_url_invalid",
                "AI requests require HTTPS; plain HTTP is allowed only for a loopback service."));
        }
        if (loopbackOnly && !isLoopbackHost(parsed.host))
            return std::unexpected(transportError("ai_http_url_invalid",
                                                  "The local provider URL must point at loopback."));
        parsed.path = components.dwUrlPathLength == 0
                          ? std::wstring(L"/")
                          : std::wstring(components.lpszUrlPath, components.dwUrlPathLength);
        if (components.dwExtraInfoLength != 0) {
            parsed.path.append(components.lpszExtraInfo, components.dwExtraInfoLength);
        }
        if (parsed.port == 0)
            parsed.port = parsed.secure ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT;
        return parsed;
    }

    std::string queryHeader(HINTERNET request, const wchar_t* name) {
        DWORD bytes = 0;
        static_cast<void>(
            WinHttpQueryHeaders(request, WINHTTP_QUERY_CUSTOM, name, WINHTTP_NO_OUTPUT_BUFFER,
                                &bytes, WINHTTP_NO_HEADER_INDEX));
        if (bytes == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER)
            return {};
        std::wstring value(bytes / sizeof(wchar_t), L'\0');
        if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_CUSTOM, name, value.data(), &bytes,
                                 WINHTTP_NO_HEADER_INDEX)) {
            return {};
        }
        if (!value.empty() && value.back() == L'\0')
            value.pop_back();
        return narrow(value);
    }

    bool bodyTooLarge(std::size_t current, DWORD available, std::size_t limit) {
        return available > limit - current;
    }

} // namespace

bool isLoopbackHttpUrl(std::string_view url) {
    auto parsed = parseUrl(url, true);
    return parsed && !parsed->secure;
}

core::Result<HttpResponse> performHttp(HttpRequest request) {
    SensitiveRequestWiper wiper(request);
    if (request.method == "GET" && !request.onChunk && request.maximumRetries != 0U) {
        constexpr std::uint8_t maximumAutomaticRetries = 2;
        const std::uint8_t retries = std::min(request.maximumRetries, maximumAutomaticRetries);
        request.maximumRetries = 0;
        for (std::uint8_t attempt = 0;; ++attempt) {
            if (attempt != 0U) {
                const auto cancellation = detail::checkCancellation(request.cancelled);
                if (cancellation.callbackFailed) {
                    return std::unexpected(core::error(
                        "ai_cancellation_callback_failed",
                        "The cancellation callback failed before a provider retry."));
                }
                if (cancellation.requested) {
                    HttpResponse cancelled;
                    cancelled.cancelled = true;
                    return cancelled;
                }
            }
            HttpRequest retryRequest = request;
            auto response = performHttp(std::move(retryRequest));
            if (!response)
                return std::unexpected(response.error());
            if (attempt >= retries || !detail::isTransientHttpFailure(*response))
                return response;
            const auto delay = detail::retryAfterDelay(response->retryAfter, attempt);
            if (!delay) {
                if (!response->body.empty())
                    sodium_memzero(response->body.data(), response->body.size());
                return response;
            }
            if (!response->body.empty())
                sodium_memzero(response->body.data(), response->body.size());
            auto remaining = *delay;
            while (remaining > std::chrono::milliseconds::zero()) {
                const auto cancellation = detail::checkCancellation(request.cancelled);
                if (cancellation.callbackFailed) {
                    return std::unexpected(core::error(
                        "ai_cancellation_callback_failed",
                        "The cancellation callback failed during provider retry backoff."));
                }
                if (cancellation.requested) {
                    HttpResponse cancelled;
                    cancelled.cancelled = true;
                    return cancelled;
                }
                const auto interval = std::min(remaining, std::chrono::milliseconds{25});
                std::this_thread::sleep_for(interval);
                remaining -= interval;
            }
        }
    }
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
    for (const auto& [name, value] : request.headers) {
        if (!isValidHeader(name, value))
            return std::unexpected(
                core::error("ai_http_header_invalid", "AI request contains an invalid header."));
    }
    if (!isValidHeader("Accept", request.accept)) {
        return std::unexpected(
            core::error("ai_http_header_invalid", "AI request contains an invalid Accept header."));
    }

    auto parsed = parseUrl(request.url, false);
    if (!parsed)
        return std::unexpected(parsed.error());

    const DWORD accessType = isLoopbackHost(parsed->host)
                                 ? WINHTTP_ACCESS_TYPE_NO_PROXY
                                 : WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY;
    InternetHandle session(WinHttpOpen(L"Tutorux/1.0", accessType, WINHTTP_NO_PROXY_NAME,
                                       WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session)
        return std::unexpected(
            core::error("ai_http_initialization_failed", "Unable to initialize the HTTPS runtime."));

    const auto milliseconds = [](std::chrono::milliseconds value) {
        return static_cast<int>(std::min<std::int64_t>(value.count(), 2'147'483'647LL));
    };
    if (!WinHttpSetTimeouts(session.value, milliseconds(request.connectTimeout),
                            milliseconds(request.connectTimeout), milliseconds(request.timeout),
                            milliseconds(request.timeout))) {
        return std::unexpected(core::error("ai_http_initialization_failed",
                                           "Unable to configure HTTPS timeouts."));
    }

    const std::wstring method = widen(request.method);
    const std::wstring accept = widen("Accept: " + request.accept + "\r\n");
    InternetHandle connection(
        WinHttpConnect(session.value, parsed->host.c_str(), parsed->port, 0));
    if (!connection)
        return std::unexpected(
            core::error("ai_http_initialization_failed", "Unable to connect to the provider."));

    InternetHandle handle(WinHttpOpenRequest(
        connection.value, method.c_str(), parsed->path.c_str(), nullptr, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES, parsed->secure ? WINHTTP_FLAG_SECURE : 0));
    if (!handle)
        return std::unexpected(
            core::error("ai_http_initialization_failed", "Unable to create an HTTPS request."));

    DWORD disableRedirects = WINHTTP_DISABLE_REDIRECTS;
    if (!WinHttpSetOption(handle.value, WINHTTP_OPTION_DISABLE_FEATURE, &disableRedirects,
                          sizeof(disableRedirects))) {
        return std::unexpected(core::error("ai_http_initialization_failed",
                                           "Unable to disable provider redirects."));
    }

    std::wstring headers = accept;
    for (const auto& [name, value] : request.headers) {
        headers += widen(name + ": " + value + "\r\n");
    }
    WideStringWiper headersWiper(headers);
    if (request.method == "GET") {
        if (!WinHttpSendRequest(handle.value, headers.c_str(), static_cast<DWORD>(headers.size()),
                                WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
            return std::unexpected(
                core::error("ai_http_transport_failed", lastErrorMessage("Sending GET request")));
        }
    } else {
        if (request.body.size() > std::numeric_limits<DWORD>::max())
            return std::unexpected(core::error("ai_http_request_too_large",
                                               "AI request body exceeds the transport limit."));
        if (!WinHttpSendRequest(handle.value, headers.c_str(), static_cast<DWORD>(headers.size()),
                                request.body.data(), static_cast<DWORD>(request.body.size()),
                                static_cast<DWORD>(request.body.size()), 0)) {
            return std::unexpected(
                core::error("ai_http_transport_failed", lastErrorMessage("Sending POST request")));
        }
    }
    if (!WinHttpReceiveResponse(handle.value, nullptr)) {
        return std::unexpected(
            core::error("ai_http_transport_failed", lastErrorMessage("Receiving response")));
    }

    HttpResponse response;
    DWORD statusCode = 0;
    DWORD statusBytes = sizeof(statusCode);
    if (WinHttpQueryHeaders(handle.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusBytes,
                            WINHTTP_NO_HEADER_INDEX)) {
        response.statusCode = static_cast<long>(statusCode);
    }
    response.contentType = queryHeader(handle.value, L"Content-Type");
    response.retryAfter = queryHeader(handle.value, L"Retry-After");

    for (;;) {
        if (request.cancelled) {
            try {
                if (request.cancelled()) {
                    response.cancelled = true;
                    break;
                }
            } catch (...) {
                return std::unexpected(core::error(
                    "ai_http_callback_failed", "The cancellation callback failed during a request."));
            }
        }
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(handle.value, &available)) {
            response.transportError = lastErrorMessage("Reading response");
            break;
        }
        if (available == 0)
            break;
        if (bodyTooLarge(response.body.size(), available, request.maximumResponseBytes)) {
            response.responseTooLarge = true;
            break;
        }
        std::string buffer(available, '\0');
        DWORD read = 0;
        if (!WinHttpReadData(handle.value, buffer.data(), available, &read)) {
            response.transportError = lastErrorMessage("Reading response body");
            break;
        }
        if (read == 0)
            break;
        buffer.resize(read);
        try {
            response.body.append(buffer);
            if (request.onChunk && !request.onChunk(buffer)) {
                response.callbackAborted = true;
                break;
            }
        } catch (...) {
            return std::unexpected(core::error(
                "ai_http_callback_failed", "An AI response callback failed while processing data."));
        }
    }
    return response;
}

} // namespace tutorux::ai
