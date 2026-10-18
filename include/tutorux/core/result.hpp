#pragma once

#include <expected>
#include <string>
#include <utility>

namespace tutorux::core {

struct Error final {
    std::string code;
    std::string message;
};

template <typename Value> using Result = std::expected<Value, Error>;

using Status = Result<void>;

inline Error error(std::string code, std::string message) {
    return Error{std::move(code), std::move(message)};
}

} // namespace tutorux::core
