#pragma once

#include "tutorux/ai/http.hpp"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <ctime>
#include <iomanip>
#include <optional>
#include <sstream>
#include <string_view>

namespace tutorux::ai::detail {

inline bool isTransientHttpFailure(const HttpResponse& response) noexcept {
    if (response.cancelled || response.callbackAborted || response.responseTooLarge)
        return false;
    if (!response.transportError.empty())
        return true;
    return response.statusCode == 408 || response.statusCode == 425 || response.statusCode == 429 ||
           response.statusCode == 500 || response.statusCode == 502 || response.statusCode == 503 ||
           response.statusCode == 504;
}

inline std::optional<std::chrono::milliseconds> retryAfterDelay(std::string_view retryAfter,
                                                                std::uint32_t retryIndex) {
    constexpr std::chrono::milliseconds maximumDelay{10'000};
    std::uint64_t seconds{};
    const auto [numberEnd, numberError] =
        std::from_chars(retryAfter.data(), retryAfter.data() + retryAfter.size(), seconds);
    const bool numericDelay =
        !retryAfter.empty() && std::all_of(retryAfter.begin(), retryAfter.end(), [](char value) {
            return value >= '0' && value <= '9';
        });
    if (numericDelay) {
        if (numberError != std::errc{} || numberEnd != retryAfter.data() + retryAfter.size() ||
            seconds > static_cast<std::uint64_t>(maximumDelay.count() / 1000)) {
            return std::nullopt;
        }
        return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::seconds(seconds));
    }

    std::tm date{};
    std::istringstream dateStream{std::string(retryAfter)};
    dateStream >> std::get_time(&date, "%a, %d %b %Y %H:%M:%S GMT");
    if (!dateStream.fail() && dateStream.peek() == std::char_traits<char>::eof()) {
        const std::chrono::year_month_day calendarDate{
            std::chrono::year{date.tm_year + 1900},
            std::chrono::month{static_cast<unsigned int>(date.tm_mon + 1)},
            std::chrono::day{static_cast<unsigned int>(date.tm_mday)}};
        if (calendarDate.ok() && date.tm_hour >= 0 && date.tm_hour < 24 && date.tm_min >= 0 &&
            date.tm_min < 60 && date.tm_sec >= 0 && date.tm_sec < 60) {
            const auto target =
                std::chrono::sys_days{calendarDate} + std::chrono::hours{date.tm_hour} +
                std::chrono::minutes{date.tm_min} + std::chrono::seconds{date.tm_sec};
            const auto now =
                std::chrono::floor<std::chrono::seconds>(std::chrono::system_clock::now());
            if (target <= now)
                return std::chrono::milliseconds::zero();
            const auto delay = std::chrono::duration_cast<std::chrono::milliseconds>(target - now);
            if (delay > maximumDelay)
                return std::nullopt;
            return delay;
        }
    }

    const auto exponential = std::chrono::milliseconds{250} * (1U << retryIndex);
    return std::min(exponential, maximumDelay);
}

struct CancellationCheck final {
    bool requested{};
    bool callbackFailed{};
};

inline CancellationCheck checkCancellation(const std::function<bool()>& callback) noexcept {
    if (!callback)
        return {};
    try {
        return {callback(), false};
    } catch (...) {
        return {false, true};
    }
}

} // namespace tutorux::ai::detail
