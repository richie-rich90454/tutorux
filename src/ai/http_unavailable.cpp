#include "tutorux/ai/http.hpp"

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>

namespace tutorux::ai {

bool isLoopbackHttpUrl(std::string_view url) {
    constexpr std::string_view prefix = "http://";
    if (!url.starts_with(prefix) || url.find_first_of("?#\r\n") != std::string_view::npos)
        return false;
    const std::string_view authority = url.substr(prefix.size());
    const auto path = authority.find('/');
    const std::string_view hostPort = authority.substr(0, path);
    if (hostPort.find('@') != std::string_view::npos)
        return false;
    const auto colon = hostPort.rfind(':');
    const std::string_view host = hostPort.substr(0, colon);
    std::string normalized;
    normalized.reserve(host.size());
    for (const char character : host) {
        normalized.push_back(
            static_cast<char>(std::tolower(static_cast<unsigned char>(character))));
    }
    if (normalized != "localhost" && normalized != "127.0.0.1" && normalized != "::1" &&
        normalized != "[::1]") {
        return false;
    }
    if (colon != std::string_view::npos && colon + 1 < hostPort.size()) {
        return std::all_of(hostPort.begin() + static_cast<std::ptrdiff_t>(colon) + 1,
                           hostPort.end(), [](unsigned char character) {
                               return std::isdigit(character) != 0;
                           });
    }
    return true;
}

core::Result<HttpResponse> performHttp(HttpRequest) {
    return std::unexpected(core::error(
        "ai_network_unavailable",
        "Network providers are not compiled into this profile. Use the full build for AI requests."));
}

} // namespace tutorux::ai
