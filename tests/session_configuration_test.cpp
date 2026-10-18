#include "tutorux/archive/archive.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/command/json.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/journal.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace {

struct TemporaryDirectory final {
    std::filesystem::path path;

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

int fail(std::string_view message) {
    std::cerr << message << '\n';
    return 1;
}

} // namespace

int main() {
    using namespace tutorux;

    const auto suffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() / ("tutorux-session-configuration-" + std::to_string(suffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode)
        return fail("Could not create the session-configuration fixture directory.");

    const auto archivePath = temporary.path / "session.tux";
    {
        auto created = archive::Archive::create(archivePath, "Session configuration test");
        if (!created)
            return fail(created.error().message);
    }

    const std::vector<std::string> arguments{"--archive",
                                             archivePath.string(),
                                             "--json",
                                             "session",
                                             "create",
                                             "--title",
                                             "Language-aware lesson",
                                             "--language",
                                             "zh-Hant",
                                             "--recording-source",
                                             "system-audio",
                                             "--guide-template",
                                             "builtin-worked-examples"};
    auto createdSession = command::dispatch(arguments);
    if (!createdSession || createdSession->exitCode != 0)
        return fail(createdSession ? createdSession->output : createdSession.error().message);

    auto response = command::parseJson(createdSession->output);
    const auto* object = response ? response->asObject() : nullptr;
    if (!object)
        return fail("Session creation did not return a JSON object.");
    const auto idField = object->find("id");
    const auto* idText = idField == object->end() ? nullptr : idField->second.asString();
    const auto sessionId = idText ? archive::uuidFromString(*idText) : std::nullopt;
    if (!sessionId)
        return fail("Session creation did not return a valid session ID.");

    auto opened = archive::Archive::open(archivePath, false);
    if (!opened)
        return fail(opened.error().message);
    auto sessionRecord = opened->get(archive::RecordType::Session, *sessionId);
    if (!sessionRecord || !*sessionRecord)
        return fail("The created session could not be reopened from the archive.");
    auto session = domain::sessionFromRecord(**sessionRecord);
    if (!session || session->transcriptionLanguage != "zh-Hant" || session->recordingSource != "system-audio" ||
        session->guideTemplateId != "builtin-worked-examples") {
        return fail("Session language, capture source, or guide template did not persist.");
    }

    const auto entryId = archive::uuidFromString(session->entryId);
    if (!entryId)
        return fail("A session created without an entry was not linked to an automatic journal entry.");
    auto entryRecord = opened->get(archive::RecordType::Settings, *entryId);
    if (!entryRecord || !*entryRecord)
        return fail("The automatic journal entry could not be reopened.");
    auto entry = domain::journalEntryFromRecord(**entryRecord);
    if (!entry ||
        std::find(entry->sessionIds.begin(), entry->sessionIds.end(), archive::uuidToString(*sessionId)) == entry->sessionIds.end()) {
        return fail("The automatic journal entry does not reference its session.");
    }
    return 0;
}
