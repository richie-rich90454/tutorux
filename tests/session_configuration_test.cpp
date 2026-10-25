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
    if (!idText)
        return fail("Session creation did not return a valid session ID.");
    const auto sessionId = archive::uuidFromString(*idText);
    if (!sessionId)
        return fail("Session creation did not return a valid session ID.");

    const auto notesId = archive::randomUuid();
    const std::string notesIdText = archive::uuidToString(notesId);
    const auto firstBlockId = archive::uuidToString(archive::randomUuid());
    const auto secondBlockId = archive::uuidToString(archive::randomUuid());
    domain::JournalNotesDocument notes;
    notes.id = notesId;
    notes.sessionId = archive::uuidToString(*sessionId);
    notes.blocks = {{firstBlockId, "paragraph", "Keep this sentence."},
                    {secondBlockId, "heading", "Later section"}};
    {
        auto writable = archive::Archive::open(archivePath, true);
        if (!writable)
            return fail(writable.error().message);
        if (auto status = writable->put(domain::toRecord(notes)); !status)
            return fail(status.error().message);
    }
    auto removedBlock = command::dispatch({"--archive", archivePath.string(), "journal", "document",
                                            "remove-block", notesIdText, "--block-id", firstBlockId});
    if (!removedBlock || removedBlock->exitCode != 0)
        return fail(removedBlock ? removedBlock->output : removedBlock.error().message);
    {
        auto afterRemoval = archive::Archive::open(archivePath, false);
        if (!afterRemoval)
            return fail(afterRemoval.error().message);
        auto stored = afterRemoval->get(archive::RecordType::Settings, notesId);
        if (!stored || !*stored)
            return fail("The notes document disappeared after removing a block.");
        auto parsed = domain::journalNotesDocumentFromRecord(**stored);
        if (!parsed || parsed->blocks.size() != 1 ||
            domain::getField(**stored, "last_removed_block_id") != firstBlockId)
            return fail("Removing a note block did not retain a recoverable snapshot.");
    }
    auto restoredBlock = command::dispatch({"--archive", archivePath.string(), "journal", "document",
                                             "restore-block", notesIdText, "--block-id", firstBlockId});
    if (!restoredBlock || restoredBlock->exitCode != 0)
        return fail(restoredBlock ? restoredBlock->output : restoredBlock.error().message);
    {
        auto afterRestore = archive::Archive::open(archivePath, false);
        if (!afterRestore)
            return fail(afterRestore.error().message);
        auto stored = afterRestore->get(archive::RecordType::Settings, notesId);
        if (!stored || !*stored)
            return fail("The notes document disappeared after restoring a block.");
        auto parsed = domain::journalNotesDocumentFromRecord(**stored);
        if (!parsed || parsed->blocks.size() != 2 || parsed->blocks.front().id != firstBlockId ||
            domain::getField(**stored, "last_removed_block_id") != "")
            return fail("Restoring a note block did not reinstate its identity and position.");
    }

    for (const auto& blockId : {firstBlockId, secondBlockId}) {
        auto remove = command::dispatch({"--archive", archivePath.string(), "journal", "document",
                                          "remove-block", notesIdText, "--block-id", blockId});
        if (!remove || remove->exitCode != 0)
            return fail(remove ? remove->output : remove.error().message);
    }
    {
        auto afterRemovals = archive::Archive::open(archivePath, false);
        if (!afterRemovals)
            return fail(afterRemovals.error().message);
        auto stored = afterRemovals->get(archive::RecordType::Settings, notesId);
        if (!stored || !*stored || domain::getField(**stored, "removed_block_count") != "2" ||
            domain::getField(**stored, "last_removed_block_id") != secondBlockId)
            return fail("Removing multiple note blocks did not preserve the full recovery stack.");
    }
    for (const auto& blockId : {secondBlockId, firstBlockId}) {
        auto restore = command::dispatch({"--archive", archivePath.string(), "journal", "document",
                                          "restore-block", notesIdText, "--block-id", blockId});
        if (!restore || restore->exitCode != 0)
            return fail(restore ? restore->output : restore.error().message);
    }
    {
        auto afterStackRestore = archive::Archive::open(archivePath, false);
        if (!afterStackRestore)
            return fail(afterStackRestore.error().message);
        auto stored = afterStackRestore->get(archive::RecordType::Settings, notesId);
        if (!stored || !*stored)
            return fail("The notes document disappeared after restoring the recovery stack.");
        auto parsed = domain::journalNotesDocumentFromRecord(**stored);
        if (!parsed || parsed->blocks.size() != 2 || parsed->blocks[0].id != firstBlockId ||
            parsed->blocks[1].id != secondBlockId || domain::getField(**stored, "removed_block_count") != "0")
            return fail("Restoring multiple note blocks did not reinstate their original order and identity.");
    }

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
