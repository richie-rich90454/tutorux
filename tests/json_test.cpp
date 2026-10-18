#include "tutorux/command/json.hpp"

#include <iostream>
#include <string>
#include <string_view>

namespace {

int reportFailure(std::string_view step, std::string_view detail) {
    std::cerr << step << ": " << detail << '\n';
    return 1;
}

} // namespace

int main() {
    using namespace tutorux::command;

    auto parsed =
        parseJson(R"({"title":"数学 \ud83d\udcda","sections":[{"blocks":[true,null,12.5e-2]}]})");
    if (!parsed)
        return reportFailure("valid JSON", parsed.error().message);
    const auto* root = parsed->asObject();
    if (!root)
        return reportFailure("root type", "Expected an object.");
    const auto title = root->find("title");
    if (title == root->end() || !title->second.asString() || *title->second.asString() != "数学 📚")
        return reportFailure("Unicode escapes", "Surrogate pair was not decoded correctly.");
    const auto sections = root->find("sections");
    if (sections == root->end() || !sections->second.asArray() ||
        sections->second.asArray()->size() != 1)
        return reportFailure("array parsing", "Nested array was not preserved.");

    for (const std::string malformed :
         {R"({"x":1,"x":2})", R"({"x":01})", R"({"x":"\ud800"})", R"([true,])", "true false"}) {
        if (parseJson(malformed))
            return reportFailure("invalid JSON rejection", malformed);
    }

    if (parseJson("[[[0]]]", 2))
        return reportFailure("nesting limit", "Excessive nesting was accepted.");
    if (parseJson("[0,1,2]", 64, 3))
        return reportFailure("value limit", "Excessive value count was accepted.");
    if (parseJson("1234", 64, 100, 3))
        return reportFailure("byte limit", "Oversized JSON was accepted.");
    if (parseJson(std::string_view("\xc0\xaf", 2)))
        return reportFailure("UTF-8 validation", "Overlong UTF-8 encoding was accepted.");

    return 0;
}
