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

enum class ApiScope {
    Any,
    Journal,
    Profile,
    Session,
};

struct SensitiveStrings final {
    std::string passphrase;
    std::string newPassphrase;

    ~SensitiveStrings() {
        if (!passphrase.empty())
            sodium_memzero(passphrase.data(), passphrase.size());
        if (!newPassphrase.empty())
            sodium_memzero(newPassphrase.data(), newPassphrase.size());
    }
};

struct SensitiveJsonFields final {
    JsonValue::Object* object{};

    ~SensitiveJsonFields() {
        if (!object)
            return;
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
};

std::string errorResponse(std::string_view code, std::string_view message) {
    return tutorux::command::toJson(JsonObject{
        {"ok",         "false"             },
        {"exit_code",  "1"                 },
        {"error_code", std::string(code)   },
        {"error",      std::string(message)},
    });
}

bool commandMatchesScope(const std::vector<std::string>& arguments, ApiScope scope) {
    if (scope == ApiScope::Any)
        return true;

    std::size_t commandIndex = 0;
    while (commandIndex < arguments.size()) {
        const std::string_view argument = arguments[commandIndex];
        if (argument == "--json" || argument == "--quiet" || argument == "--verbose" ||
            argument == "--no-color") {
            ++commandIndex;
            continue;
        }
        const std::size_t equals = argument.find('=');
        const std::string_view option =
            argument.substr(0, equals == std::string_view::npos ? argument.size() : equals);
        if (option == "--archive" || option == "--directory" || option == "--passphrase-env" ||
            option == "--new-passphrase-env" || option == "--source-passphrase-env") {
            commandIndex += equals == std::string_view::npos ? 2 : 1;
            continue;
        }
        break;
    }
    if (commandIndex >= arguments.size())
        return false;
    if (arguments.size() - commandIndex < 2)
        return false;

    if (scope == ApiScope::Journal) {
        return arguments[commandIndex] == "journal" &&
               (arguments[commandIndex + 1] == "entry" ||
                arguments[commandIndex + 1] == "collection" ||
                arguments[commandIndex + 1] == "tag");
    }
    if (scope == ApiScope::Profile)
        return arguments[commandIndex] == "student";
    return arguments[commandIndex] == "session";
}

bool resolveApiScope(const JsonValue::Object* object, ApiScope requiredScope,
                     ApiScope& resolvedScope) {
    resolvedScope = requiredScope;
    if (!object)
        return true;

    const auto apiField = object->find("api");
    if (apiField == object->end())
        return true;
    const auto* apiName = std::get_if<std::string>(&apiField->second.value);
    if (!apiName)
        return false;

    ApiScope requestedScope;
    if (*apiName == "journal.v1")
        requestedScope = ApiScope::Journal;
    else if (*apiName == "profile.v1")
        requestedScope = ApiScope::Profile;
    else if (*apiName == "session.v1")
        requestedScope = ApiScope::Session;
    else
        return false;

    if (requiredScope != ApiScope::Any && requiredScope != requestedScope)
        return false;
    resolvedScope = requestedScope;
    return true;
}

const char* dispatchJson(const char* input, ApiScope scope) {
    thread_local std::string response;
    if (!input) {
        response = errorResponse("web_request_invalid", "Command input is missing.");
        return response.c_str();
    }

    auto parsed = tutorux::command::parseJson(std::string_view(input), 16, 4096, 1U << 20U);
    if (!parsed) {
        response = errorResponse(parsed.error().code, parsed.error().message);
        return response.c_str();
    }

    JsonValue::Array* values = std::get_if<JsonValue::Array>(&parsed->value);
    JsonValue::Object* object = std::get_if<JsonValue::Object>(&parsed->value);
    SensitiveJsonFields jsonFields{object};
    ApiScope resolvedScope;
    if (!resolveApiScope(object, scope, resolvedScope)) {
        response = errorResponse("web_api_invalid", "The requested browser API version is missing, "
                                                    "invalid, or does not match its entry point.");
        return response.c_str();
    }
    if (object) {
        const auto argumentsField = object->find("arguments");
        if (argumentsField != object->end())
            values = std::get_if<JsonValue::Array>(&argumentsField->second.value);
    }

    SensitiveStrings secrets;
    if (object) {
        const auto readSecret = [&](std::string_view fieldName, std::string& destination) {
            const auto field = object->find(fieldName);
            if (field == object->end())
                return true;
            const auto* value = std::get_if<std::string>(&field->second.value);
            if (!value)
                return false;
            if (value->size() > 4096)
                return false;
            destination = *value;
            return true;
        };

        if (!readSecret("passphrase", secrets.passphrase) ||
            !readSecret("newPassphrase", secrets.newPassphrase)) {
            response = errorResponse("web_request_invalid",
                                     "Archive passphrases must be JSON strings under 4 KiB.");
            return response.c_str();
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

    if (!commandMatchesScope(arguments, resolvedScope)) {
        response = errorResponse(
            "web_command_scope",
            "The requested command is outside this browser API's supported command group.");
        return response.c_str();
    }

    tutorux::command::DispatchControl control;
    control.archivePassphrase = secrets.passphrase;
    control.newArchivePassphrase = secrets.newPassphrase;
    auto result = tutorux::command::dispatch(arguments, {}, control);
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

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* tutorux_web_dispatch_json(const char* input) {
    return dispatchJson(input, ApiScope::Any);
}

EMSCRIPTEN_KEEPALIVE const char* tutorux_web_journal_dispatch_json(const char* input) {
    return dispatchJson(input, ApiScope::Journal);
}

EMSCRIPTEN_KEEPALIVE const char* tutorux_web_profile_dispatch_json(const char* input) {
    return dispatchJson(input, ApiScope::Profile);
}

EMSCRIPTEN_KEEPALIVE const char* tutorux_web_session_dispatch_json(const char* input) {
    return dispatchJson(input, ApiScope::Session);
}

int main() {
    return 0;
}

} // extern "C"
