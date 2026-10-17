#pragma once

#include "tutorux/core/result.hpp"

#include <chrono>
#include <cstddef>
#include <functional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace tutorux::ai {

    struct HttpRequest final {
        std::string url;
        std::string method{"GET"};
        std::string accept{"application/json"};
        std::vector<std::pair<std::string, std::string>> headers;
        std::string body;
        std::size_t maximumResponseBytes{16U * 1024U * 1024U};
        std::chrono::milliseconds connectTimeout{15'000};
        std::chrono::milliseconds timeout{300'000};
        std::function<bool()> cancelled;
        std::function<bool(std::string_view)> onChunk;
    };

    struct HttpResponse final {
        long statusCode{};
        std::string contentType;
        std::string retryAfter;
        std::string body;
        std::string transportError;
        bool cancelled{};
        bool callbackAborted{};
        bool responseTooLarge{};
    };

    bool isLoopbackHttpUrl(std::string_view url);
    core::Result<HttpResponse> performHttp(HttpRequest request);

} // namespace tutorux::ai
