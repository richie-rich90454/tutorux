#include "tutorux/command/json.hpp"

#include <cstdint>
#include <optional>
#include <utility>

namespace tutorux::command {
namespace {

    std::optional<std::size_t> invalidUtf8Offset(std::string_view text) {
        for (std::size_t offset = 0; offset < text.size();) {
            const auto lead = static_cast<unsigned char>(text[offset]);
            if (lead <= 0x7fU) {
                ++offset;
                continue;
            }
            std::size_t length = 0;
            unsigned char secondMinimum = 0x80U;
            unsigned char secondMaximum = 0xbfU;
            if (lead >= 0xc2U && lead <= 0xdfU) {
                length = 2;
            } else if (lead >= 0xe0U && lead <= 0xefU) {
                length = 3;
                if (lead == 0xe0U)
                    secondMinimum = 0xa0U;
                if (lead == 0xedU)
                    secondMaximum = 0x9fU;
            } else if (lead >= 0xf0U && lead <= 0xf4U) {
                length = 4;
                if (lead == 0xf0U)
                    secondMinimum = 0x90U;
                if (lead == 0xf4U)
                    secondMaximum = 0x8fU;
            } else {
                return offset;
            }
            if (text.size() - offset < length)
                return offset;
            const auto second = static_cast<unsigned char>(text[offset + 1]);
            if (second < secondMinimum || second > secondMaximum)
                return offset;
            for (std::size_t index = 2; index < length; ++index) {
                const auto continuation = static_cast<unsigned char>(text[offset + index]);
                if (continuation < 0x80U || continuation > 0xbfU)
                    return offset + index;
            }
            offset += length;
        }
        return std::nullopt;
    }

    class JsonParser final {
      public:
        JsonParser(std::string_view input, std::size_t maximumDepth, std::size_t maximumValues)
            : input_(input)
            , maximumDepth_(maximumDepth)
            , maximumValues_(maximumValues) {}

        core::Result<JsonValue> parse() {
            skipWhitespace();
            auto value = parseValue(0);
            if (!value)
                return value;
            skipWhitespace();
            if (position_ != input_.size())
                return failure<JsonValue>("Unexpected data after the JSON value.");
            return value;
        }

      private:
        template <typename Value> core::Result<Value> failure(std::string message) const {
            return std::unexpected(
                core::error("json_invalid",
                            std::move(message) + " (byte " + std::to_string(position_) + ")."));
        }

        void skipWhitespace() {
            while (position_ < input_.size()) {
                const char character = input_[position_];
                if (character != ' ' && character != '\t' && character != '\n' && character != '\r')
                    break;
                ++position_;
            }
        }

        core::Result<JsonValue> parseValue(std::size_t depth) {
            skipWhitespace();
            if (depth > maximumDepth_)
                return failure<JsonValue>("JSON nesting exceeds the configured depth limit.");
            if (++valueCount_ > maximumValues_)
                return failure<JsonValue>("JSON value count exceeds the configured limit.");
            if (position_ >= input_.size())
                return failure<JsonValue>("Expected a JSON value.");

            switch (input_[position_]) {
                case 'n':
                    return parseLiteral("null", JsonValue{nullptr});
                case 't':
                    return parseLiteral("true", JsonValue{true});
                case 'f':
                    return parseLiteral("false", JsonValue{false});
                case '"': {
                    auto string = parseString();
                    if (!string)
                        return std::unexpected(string.error());
                    return JsonValue{std::move(*string)};
                }
                case '[':
                    return parseArray(depth);
                case '{':
                    return parseObject(depth);
                default:
                    if (input_[position_] == '-' || isDigit(input_[position_]))
                        return parseNumber();
                    return failure<JsonValue>("Unexpected character while parsing a JSON value.");
            }
        }

        core::Result<JsonValue> parseLiteral(std::string_view literal, JsonValue value) {
            if (input_.substr(position_, literal.size()) != literal)
                return failure<JsonValue>("Invalid JSON literal.");
            position_ += literal.size();
            return value;
        }

        core::Result<std::uint16_t> parseHexUnit() {
            if (input_.size() - position_ < 4)
                return failure<std::uint16_t>("Incomplete Unicode escape.");
            std::uint16_t value = 0;
            for (std::size_t index = 0; index < 4; ++index) {
                const char digit = input_[position_++];
                value = static_cast<std::uint16_t>(value << 4U);
                if (digit >= '0' && digit <= '9')
                    value = static_cast<std::uint16_t>(value | (digit - '0'));
                else if (digit >= 'a' && digit <= 'f')
                    value = static_cast<std::uint16_t>(value | (digit - 'a' + 10));
                else if (digit >= 'A' && digit <= 'F')
                    value = static_cast<std::uint16_t>(value | (digit - 'A' + 10));
                else
                    return failure<std::uint16_t>("Invalid hexadecimal digit in Unicode escape.");
            }
            return value;
        }

        static void appendUtf8(std::string& output, std::uint32_t codepoint) {
            if (codepoint <= 0x7fU) {
                output.push_back(static_cast<char>(codepoint));
            } else if (codepoint <= 0x7ffU) {
                output.push_back(static_cast<char>(0xc0U | (codepoint >> 6U)));
                output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
            } else if (codepoint <= 0xffffU) {
                output.push_back(static_cast<char>(0xe0U | (codepoint >> 12U)));
                output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
                output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
            } else {
                output.push_back(static_cast<char>(0xf0U | (codepoint >> 18U)));
                output.push_back(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3fU)));
                output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
                output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
            }
        }

        core::Result<std::string> parseString() {
            if (position_ >= input_.size() || input_[position_] != '"')
                return failure<std::string>("Expected a JSON string.");
            ++position_;
            std::string value;
            while (position_ < input_.size()) {
                const unsigned char character = static_cast<unsigned char>(input_[position_++]);
                if (character == '"')
                    return value;
                if (character < 0x20U)
                    return failure<std::string>("Unescaped control character in JSON string.");
                if (character != '\\') {
                    value.push_back(static_cast<char>(character));
                    continue;
                }
                if (position_ >= input_.size())
                    return failure<std::string>("Incomplete JSON string escape.");
                switch (input_[position_++]) {
                    case '"':
                        value.push_back('"');
                        break;
                    case '\\':
                        value.push_back('\\');
                        break;
                    case '/':
                        value.push_back('/');
                        break;
                    case 'b':
                        value.push_back('\b');
                        break;
                    case 'f':
                        value.push_back('\f');
                        break;
                    case 'n':
                        value.push_back('\n');
                        break;
                    case 'r':
                        value.push_back('\r');
                        break;
                    case 't':
                        value.push_back('\t');
                        break;
                    case 'u': {
                        auto first = parseHexUnit();
                        if (!first)
                            return std::unexpected(first.error());
                        std::uint32_t codepoint = *first;
                        if (*first >= 0xd800U && *first <= 0xdbffU) {
                            if (input_.size() - position_ < 6 || input_[position_] != '\\' ||
                                input_[position_ + 1] != 'u')
                                return failure<std::string>(
                                    "High surrogate is missing its low surrogate.");
                            position_ += 2;
                            auto second = parseHexUnit();
                            if (!second)
                                return std::unexpected(second.error());
                            if (*second < 0xdc00U || *second > 0xdfffU)
                                return failure<std::string>("Invalid low surrogate.");
                            codepoint = 0x10000U +
                                        ((static_cast<std::uint32_t>(*first) - 0xd800U) << 10U) +
                                        (static_cast<std::uint32_t>(*second) - 0xdc00U);
                        } else if (*first >= 0xdc00U && *first <= 0xdfffU) {
                            return failure<std::string>("Unexpected low surrogate.");
                        }
                        appendUtf8(value, codepoint);
                        break;
                    }
                    default:
                        return failure<std::string>("Invalid JSON string escape.");
                }
            }
            return failure<std::string>("Unterminated JSON string.");
        }

        core::Result<JsonValue> parseNumber() {
            const std::size_t start = position_;
            if (input_[position_] == '-')
                ++position_;
            if (position_ >= input_.size())
                return failure<JsonValue>("Incomplete JSON number.");
            if (input_[position_] == '0') {
                ++position_;
                if (position_ < input_.size() && isDigit(input_[position_]))
                    return failure<JsonValue>("Leading zero in JSON number.");
            } else if (input_[position_] >= '1' && input_[position_] <= '9') {
                while (position_ < input_.size() && isDigit(input_[position_]))
                    ++position_;
            } else {
                return failure<JsonValue>("Invalid JSON number.");
            }
            if (position_ < input_.size() && input_[position_] == '.') {
                ++position_;
                const std::size_t fractionStart = position_;
                while (position_ < input_.size() && isDigit(input_[position_]))
                    ++position_;
                if (fractionStart == position_)
                    return failure<JsonValue>("JSON number fraction has no digits.");
            }
            if (position_ < input_.size() &&
                (input_[position_] == 'e' || input_[position_] == 'E')) {
                ++position_;
                if (position_ < input_.size() &&
                    (input_[position_] == '+' || input_[position_] == '-'))
                    ++position_;
                const std::size_t exponentStart = position_;
                while (position_ < input_.size() && isDigit(input_[position_]))
                    ++position_;
                if (exponentStart == position_)
                    return failure<JsonValue>("JSON number exponent has no digits.");
            }
            return JsonValue{JsonNumber{std::string(input_.substr(start, position_ - start))}};
        }

        core::Result<JsonValue> parseArray(std::size_t depth) {
            ++position_;
            skipWhitespace();
            JsonValue::Array values;
            if (consume(']'))
                return JsonValue{std::move(values)};
            while (true) {
                auto value = parseValue(depth + 1);
                if (!value)
                    return value;
                values.push_back(std::move(*value));
                skipWhitespace();
                if (consume(']'))
                    return JsonValue{std::move(values)};
                if (!consume(','))
                    return failure<JsonValue>("Expected ',' or ']' in JSON array.");
                skipWhitespace();
            }
        }

        core::Result<JsonValue> parseObject(std::size_t depth) {
            ++position_;
            skipWhitespace();
            JsonValue::Object values;
            if (consume('}'))
                return JsonValue{std::move(values)};
            while (true) {
                auto key = parseString();
                if (!key)
                    return std::unexpected(key.error());
                skipWhitespace();
                if (!consume(':'))
                    return failure<JsonValue>("Expected ':' after JSON object key.");
                auto value = parseValue(depth + 1);
                if (!value)
                    return value;
                if (!values.emplace(std::move(*key), std::move(*value)).second)
                    return failure<JsonValue>("Duplicate JSON object key.");
                skipWhitespace();
                if (consume('}'))
                    return JsonValue{std::move(values)};
                if (!consume(','))
                    return failure<JsonValue>("Expected ',' or '}' in JSON object.");
                skipWhitespace();
            }
        }

        bool consume(char expected) {
            if (position_ >= input_.size() || input_[position_] != expected)
                return false;
            ++position_;
            return true;
        }

        static bool isDigit(char character) {
            return character >= '0' && character <= '9';
        }

        std::string_view input_;
        std::size_t maximumDepth_{};
        std::size_t maximumValues_{};
        std::size_t valueCount_{};
        std::size_t position_{};
    };

} // namespace

const JsonValue::Array* JsonValue::asArray() const noexcept {
    return std::get_if<Array>(&value);
}

const JsonValue::Object* JsonValue::asObject() const noexcept {
    return std::get_if<Object>(&value);
}

const std::string* JsonValue::asString() const noexcept {
    return std::get_if<std::string>(&value);
}

core::Result<JsonValue> parseJson(std::string_view input,
                                  std::size_t maximumDepth,
                                  std::size_t maximumValues,
                                  std::size_t maximumBytes) {
    if (input.size() > maximumBytes)
        return std::unexpected(
            core::error("json_too_large", "JSON input exceeds the configured byte limit."));
    if (const auto invalidOffset = invalidUtf8Offset(input)) {
        return std::unexpected(core::error("json_utf8_invalid",
                                           "JSON input is not valid UTF-8 (byte " +
                                               std::to_string(*invalidOffset) + ")."));
    }
    return JsonParser(input, maximumDepth, maximumValues).parse();
}

std::string jsonEscape(std::string_view value) {
    static constexpr char digits[] = "0123456789abcdef";
    std::string escaped;
    escaped.reserve(value.size() + 2);
    for (const char rawCharacter : value) {
        const auto character = static_cast<unsigned char>(rawCharacter);
        switch (character) {
            case '"':
                escaped += "\\\"";
                break;
            case '\\':
                escaped += "\\\\";
                break;
            case '\b':
                escaped += "\\b";
                break;
            case '\f':
                escaped += "\\f";
                break;
            case '\n':
                escaped += "\\n";
                break;
            case '\r':
                escaped += "\\r";
                break;
            case '\t':
                escaped += "\\t";
                break;
            default:
                if (character < 0x20U) {
                    escaped += "\\u00";
                    escaped.push_back(digits[(character >> 4U) & 0xfU]);
                    escaped.push_back(digits[character & 0xfU]);
                } else {
                    escaped.push_back(static_cast<char>(character));
                }
        }
    }
    return escaped;
}

std::string toJson(const JsonObject& object) {
    std::string json = "{";
    bool first = true;
    for (const auto& [key, value] : object) {
        if (!first)
            json.push_back(',');
        first = false;
        json += "\"" + jsonEscape(key) + "\":\"" + jsonEscape(value) + "\"";
    }
    json.push_back('}');
    return json;
}

std::string toJsonArray(const std::vector<JsonObject>& objects) {
    std::string json = "[";
    for (std::size_t index = 0; index < objects.size(); ++index) {
        if (index != 0)
            json.push_back(',');
        json += toJson(objects[index]);
    }
    json.push_back(']');
    return json;
}

} // namespace tutorux::command
