#pragma once

#include "tutorux/archive/archive.hpp"

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::domain {

struct Journal final {
    archive::Uuid id{};
    std::string title{"Tutorux journal"};
    std::string createdAtUs;
    std::string updatedAtUs;
};

struct JournalEntry final {
    archive::Uuid id{};
    std::string title{"Untitled entry"};
    std::string date;
    std::vector<std::string> collectionIds;
    std::vector<std::string> tagIds;
    std::string notesDocumentId;
    std::vector<std::string> sessionIds;
    std::vector<std::string> studyGuideIds;
    std::vector<std::string> attachmentIds;
    std::string createdAtUs;
    std::string updatedAtUs;
};

struct JournalCollection final {
    archive::Uuid id{};
    std::string name;
    std::string description;
    std::string color;
    std::string createdAtUs;
    std::string updatedAtUs;
};

struct JournalTag final {
    archive::Uuid id{};
    std::string name;
    std::string color;
    std::string createdAtUs;
    std::string updatedAtUs;
};

struct JournalNoteBlock final {
    std::string id;
    std::string kind{"paragraph"};
    std::string text;
};

struct JournalNotesDocument final {
    archive::Uuid id{};
    std::string entryId;
    std::string sessionId;
    std::vector<JournalNoteBlock> blocks;
    std::string createdAtUs;
    std::string updatedAtUs;
};

archive::Record toRecord(const Journal& journal);
archive::Record toRecord(const JournalEntry& entry);
archive::Record toRecord(const JournalCollection& collection);
archive::Record toRecord(const JournalTag& tag);
archive::Record toRecord(const JournalNotesDocument& document);

tutorux::core::Result<Journal> journalFromRecord(const archive::Record& record);
tutorux::core::Result<JournalEntry> journalEntryFromRecord(const archive::Record& record);
tutorux::core::Result<JournalCollection> journalCollectionFromRecord(const archive::Record& record);
tutorux::core::Result<JournalTag> journalTagFromRecord(const archive::Record& record);
tutorux::core::Result<JournalNotesDocument>
journalNotesDocumentFromRecord(const archive::Record& record);

bool isValidJournalDate(std::string_view value) noexcept;
bool isValidJournalNoteBlockKind(std::string_view value) noexcept;

} // namespace tutorux::domain
