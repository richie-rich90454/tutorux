#include "tutorux/application/journal-service.hpp"

#include "tutorux/archive/archive.hpp"
#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <chrono>

namespace tutorux::application {

core::Result<NoteBlockUpdateResult> JournalService::updateNoteBlock(
    const std::filesystem::path& archivePath, std::string_view passphrase,
    const NoteBlockUpdateRequest& request) const {
    const auto documentId = archive::uuidFromString(request.documentId);
    if (!documentId) {
        return std::unexpected(core::error(
            "journal_document_id_invalid", "Select a valid notes document from this archive."));
    }
    if (request.blockId.empty()) {
        return std::unexpected(core::error("journal_block_id_invalid",
                                           "Select a note block before saving."));
    }
    if (!domain::isValidJournalNoteBlockKind(request.kind)) {
        return std::unexpected(core::error("journal_block_kind_invalid",
                                           "The requested note block type is invalid."));
    }

    auto opened = archive::Archive::open(archivePath, true, passphrase);
    if (!opened)
        return std::unexpected(opened.error());
    auto loaded = opened->get(archive::RecordType::Settings, *documentId);
    if (!loaded)
        return std::unexpected(loaded.error());
    if (!*loaded || domain::getField(**loaded, "record_role") != "journal-notes" ||
        domain::isDeleted(**loaded)) {
        return std::unexpected(core::error("journal_document_not_found",
                                           "Journal notes document was not found."));
    }

    auto document = domain::journalNotesDocumentFromRecord(**loaded);
    if (!document)
        return std::unexpected(document.error());
    const auto block = std::find_if(document->blocks.begin(), document->blocks.end(),
                                    [&](const auto& candidate) {
                                        return candidate.id == request.blockId;
                                    });
    if (block == document->blocks.end()) {
        return std::unexpected(core::error("journal_block_not_found",
                                           "Note block was not found in this document."));
    }

    block->kind = request.kind;
    block->text = request.text;
    document->updatedAtUs = std::to_string(std::chrono::duration_cast<std::chrono::microseconds>(
                                               std::chrono::system_clock::now().time_since_epoch())
                                               .count());

    const auto originalFields = (**loaded).fields;
    auto updatedRecord = **loaded;
    updatedRecord.fields = domain::toRecord(*document).fields;
    for (const auto& [key, value] : originalFields) {
        if (key == "removed_block_count" || key.starts_with("removed_block_") ||
            key == "last_removed_block_id" || key == "last_removed_block_kind" ||
            key == "last_removed_block_text" || key == "last_removed_block_index") {
            updatedRecord.fields[key] = value;
        }
    }
    const std::uint64_t nextRevision = updatedRecord.revision + 1;
    if (auto status = opened->put(std::move(updatedRecord)); !status)
        return std::unexpected(status.error());

    return NoteBlockUpdateResult{std::move(*document), nextRevision};
}

} // namespace tutorux::application
