#include "tutorux/command/dispatcher.hpp"
#include "tutorux/command/json.hpp"

#include <emscripten/emscripten.h>
#include <sodium.h>

#include <string>
#include <string_view>
#include <vector>

namespace {

using tutorux::command::JsonObject;
using tutorux::command::JsonValue;

std::string errorResponse(std::string_view code, std::string_view message) {
    return tutorux::command::toJson(JsonObject{
        {"ok",         "false"             },
        {"exit_code",  "1"                 },
        {"error_code", std::string(code)   },
        {"error",      std::string(message)},
    });
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* tutorux_web_dispatch_json(const char* input) {
    thread_local std::string response;
    if (!input) {
        response = errorResponse("web_request_invalid", "Command input is missing.");
        return response.c_str();
    }

    const std::string_view json(input);
    auto parsed = tutorux::command::parseJson(json, 16, 4096, 1U << 20U);
    if (!parsed) {
        response = errorResponse(parsed.error().code, parsed.error().message);
        return response.c_str();
    }
    JsonValue::Array* mutableValues = std::get_if<JsonValue::Array>(&parsed->value);
    JsonValue::Object* object = std::get_if<JsonValue::Object>(&parsed->value);
    JsonValue::Array* values = mutableValues;
    std::string passphrase;
    std::string newPassphrase;
    if (object) {
        const auto argumentsField = object->find("arguments");
        if (argumentsField != object->end())
            values = std::get_if<JsonValue::Array>(&argumentsField->second.value);
        for (const auto [fieldName, target] : {
                 std::pair<std::string_view, std::string*>{"passphrase",    &passphrase   },
                 {"newPassphrase", &newPassphrase}
        }) {
            const auto field = object->find(fieldName);
            if (field == object->end())
                continue;
            if (const auto* value = std::get_if<std::string>(&field->second.value)) {
                if (value->size() > 4096) {
                    response = errorResponse("web_request_invalid",
                                             "Archive passphrases must be at most 4 KiB.");
                    return response.c_str();
                }
                *target = *value;
            } else {
                response = errorResponse("web_request_invalid",
                                         "Archive passphrases must be JSON strings.");
                return response.c_str();
            }
        }
    }
    if (!values || values->empty()) {
        response = errorResponse("web_request_invalid",
                                 "Command input must be a non-empty JSON string array.");
        return response.c_str();
    }

    std::vector<std::string> arguments;
    arguments.reserve(values->size());
    for (const JsonValue& value : *values) {
        const std::string* argument = value.asString();
        if (!argument || argument->size() > 64U * 1024U) {
            response = errorResponse("web_request_invalid",
                                     "Every command argument must be a string under 64 KiB.");
            return response.c_str();
        }
        arguments.push_back(*argument);
    }

    tutorux::command::DispatchControl control;
    control.archivePassphrase = passphrase;
    control.newArchivePassphrase = newPassphrase;
    auto result = tutorux::command::dispatch(arguments, {}, control);
    if (!passphrase.empty())
        sodium_memzero(passphrase.data(), passphrase.size());
    if (!newPassphrase.empty())
        sodium_memzero(newPassphrase.data(), newPassphrase.size());
    if (object) {
        for (const std::string_view fieldName : {"passphrase", "newPassphrase"}) {
            const auto field = object->find(fieldName);
            if (field == object->end())
                continue;
            if (auto* value = std::get_if<std::string>(&field->second.value);
                value && !value->empty()) {
                sodium_memzero(value->data(), value->size());
            }
        }
    }
    if (!result) {
        response = errorResponse(result.error().code, result.error().message);
        return response.c_str();
    }
    response = tutorux::command::toJson(JsonObject{
        {"ok",        result->exitCode == 0 ? "true" : "false"},
        {"exit_code", std::to_string(result->exitCode)        },
        {"output",    result->output                          },
    });
    return response.c_str();
}

int main() {
    return 0;
}

} // extern "C"
