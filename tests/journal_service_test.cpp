#include "tutorux/application/journal-service.hpp"

#include "tutorux/archive/archive.hpp"
#include "tutorux/domain/entities.hpp"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>

namespace {

int fail(std::string_view message) {
    std::cerr << "journal service: " << message << '\n';
    return 1;
}

} // namespace

int main() {
    using namespace tutorux;
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto directory = std::filesystem::temp_directory_path() /
                           ("tutorux-journal-service-" + std::to_string(nonce));
    std::error_code error;
    std::filesystem::create_directories(directory, error);
    if (error)
        return fail("could not create test directory");
    const auto archivePath = directory / "Journal.tux";

    domain::JournalNotesDocument document;
    document.id = archive::randomUuid();
    document.createdAtUs = "1700000000000000";
    document.updatedAtUs = document.createdAtUs;
    const std::string blockId = archive::uuidToString(archive::randomUuid());
    document.blocks.push_back({blockId, "paragraph", "Original note."});
    {
        auto created = archive::Archive::create(archivePath, "Journal service test");
        if (!created)
            return fail("could not create archive");
        auto record = domain::toRecord(document);
        record.fields["removed_block_count"] = "1";
        record.fields["removed_block_0_id"] = archive::uuidToString(archive::randomUuid());
        record.fields["removed_block_0_kind"] = "quote";
        record.fields["removed_block_0_text"] = "Recoverable removed note.";
        record.fields["removed_block_0_index"] = "0";
        record.fields["last_removed_block_id"] = record.fields["removed_block_0_id"];
        record.fields["last_removed_block_kind"] = "quote";
        record.fields["last_removed_block_text"] = "Recoverable removed note.";
        record.fields["last_removed_block_index"] = "0";
        if (auto status = created->put(std::move(record)); !status)
            return fail("could not seed note document");
    }

    const application::NoteBlockUpdateRequest request{
        archive::uuidToString(document.id), blockId, "heading", "Updated title"};
    const auto updated = application::JournalService{}.updateNoteBlock(archivePath, {}, request);
    if (!updated)
        return fail(updated.error().message);
    if (updated->document.blocks.size() != 1 || updated->document.blocks[0].kind != "heading" ||
        updated->document.blocks[0].text != "Updated title") {
        return fail("the update result did not contain the saved block");
    }

    {
        auto reopened = archive::Archive::open(archivePath, false);
        if (!reopened)
            return fail("could not reopen updated archive");
        auto stored = reopened->get(archive::RecordType::Settings, document.id);
        if (!stored || !*stored)
            return fail("updated notes document could not be loaded");
        const auto storedDocument = domain::journalNotesDocumentFromRecord(**stored);
        if (!storedDocument || storedDocument->blocks[0].kind != "heading" ||
            storedDocument->blocks[0].text != "Updated title") {
            return fail("the update did not persist across archive reopen");
        }
        if (domain::getField(**stored, "removed_block_count") != "1" ||
            domain::getField(**stored, "removed_block_0_text") != "Recoverable removed note." ||
            domain::getField(**stored, "last_removed_block_id").empty()) {
            return fail("updating a block discarded its recoverable removal history");
        }
        if (updated->revision != (**stored).revision)
            return fail("the service returned the wrong saved revision");
    }

    auto invalid = request;
    invalid.kind = "unsupported";
    const auto rejected = application::JournalService{}.updateNoteBlock(archivePath, {}, invalid);
    if (rejected || rejected.error().code != "journal_block_kind_invalid")
        return fail("an invalid block kind was not rejected");

    auto missing = request;
    missing.blockId = archive::uuidToString(archive::randomUuid());
    const auto missingBlock = application::JournalService{}.updateNoteBlock(archivePath, {}, missing);
    if (missingBlock || missingBlock.error().code != "journal_block_not_found")
        return fail("a stale block selection was not rejected");

    std::filesystem::remove_all(directory, error);
    return 0;
}
