#pragma once

#include "tutorux/core/result.hpp"

#include <cstddef>
#include <map>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace tutorux::command {

using JsonObject = std::map<std::string, std::string, std::less<>>;

struct JsonNumber final {
    std::string text;
};

struct JsonValue final {
    using Array = std::vector<JsonValue>;
    using Object = std::map<std::string, JsonValue, std::less<>>;
    using Storage = std::variant<std::nullptr_t, bool, JsonNumber, std::string, Array, Object>;

    Storage value;

    const Array* asArray() const noexcept;
    const Object* asObject() const noexcept;
    const std::string* asString() const noexcept;
};

std::string jsonEscape(std::string_view value);
std::string toJson(const JsonObject& object);
std::string toJsonArray(const std::vector<JsonObject>& objects);
core::Result<JsonValue> parseJson(std::string_view input,
                                  std::size_t maximumDepth = 64,
                                  std::size_t maximumValues = 1'000'000,
                                  std::size_t maximumBytes = 16U * 1024U * 1024U);

} // namespace tutorux::command
