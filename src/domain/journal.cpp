#include "tutorux/domain/journal.hpp"

#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <utility>

namespace tutorux::domain {
namespace {

    constexpr std::size_t maximumJournalItems = 10'000;

    std::string nowUnixMicroseconds() {
        return std::to_string(std::chrono::duration_cast<std::chrono::microseconds>(
                                  std::chrono::system_clock::now().time_since_epoch())
                                  .count());
    }

    std::string timestampOrNow(const std::string& timestamp) {
        return timestamp.empty() ? nowUnixMicroseconds() : timestamp;
    }

    std::string encodeIds(const std::vector<std::string>& ids) {
        std::string value;
        for (const auto& id : ids) {
            if (!value.empty())
                value.push_back(',');
            value += id;
        }
        return value;
    }

    std::vector<std::string> decodeIds(std::string_view value) {
        std::vector<std::string> ids;
        std::size_t offset = 0;
        while (offset < value.size()) {
            const auto comma = value.find(',', offset);
            const auto end = comma == std::string_view::npos ? value.size() : comma;
            if (end > offset)
                ids.emplace_back(value.substr(offset, end - offset));
            if (comma == std::string_view::npos)
                break;
            offset = comma + 1;
        }
        return ids;
    }

    archive::Record baseRecord(const archive::Uuid& id, std::string_view role,
                               const std::string& createdAtUs, const std::string& updatedAtUs) {
        archive::Record record;
        record.type = archive::RecordType::Settings;
        record.id = id;
        const auto created = timestampOrNow(createdAtUs);
        record.fields = {
            {"record_role",   std::string(role)          },
            {"created_at_us", created                    },
            {"updated_at_us", timestampOrNow(updatedAtUs)}
        };
        return record;
    }

    tutorux::core::Result<std::size_t> parseCount(const archive::Record& record,
                                                  std::string_view key) {
        const std::string countText = getField(record, key);
        std::size_t count = 0;
        const auto [end, errorCode] =
            std::from_chars(countText.data(), countText.data() + countText.size(), count);
        if (errorCode != std::errc{} || end != countText.data() + countText.size() ||
            count > maximumJournalItems) {
            return std::unexpected(tutorux::core::error(
                "journal_record_invalid", "Journal document block count is invalid."));
        }
        return count;
    }

    std::string noteBlockKey(std::size_t index, std::string_view suffix) {
        return "block." + std::to_string(index) + "." + std::string(suffix);
    }

    bool hasRole(const archive::Record& record, std::string_view expectedRole) {
        return record.type == archive::RecordType::Settings &&
               getField(record, "record_role") == expectedRole && !isDeleted(record);
    }

    tutorux::core::Error invalidRecord(std::string_view kind) {
        return tutorux::core::error("journal_record_invalid",
                                    "Record is not a valid " + std::string(kind) + ".");
    }

} // namespace

archive::Record toRecord(const Journal& journal) {
    auto record = baseRecord(journal.id, "journal", journal.createdAtUs, journal.updatedAtUs);
    record.fields["title"] = journal.title;
    return record;
}

archive::Record toRecord(const JournalEntry& entry) {
    auto record = baseRecord(entry.id, "journal-entry", entry.createdAtUs, entry.updatedAtUs);
    record.fields["title"] = entry.title;
    record.fields["entry_date"] = entry.date;
    record.fields["collection_ids"] = encodeIds(entry.collectionIds);
    record.fields["tag_ids"] = encodeIds(entry.tagIds);
    record.fields["notes_document_id"] = entry.notesDocumentId;
    record.fields["session_ids"] = encodeIds(entry.sessionIds);
    record.fields["study_guide_ids"] = encodeIds(entry.studyGuideIds);
    record.fields["attachment_ids"] = encodeIds(entry.attachmentIds);
    return record;
}

archive::Record toRecord(const JournalCollection& collection) {
    auto record = baseRecord(collection.id, "journal-collection", collection.createdAtUs,
                             collection.updatedAtUs);
    record.fields["name"] = collection.name;
    record.fields["description"] = collection.description;
    record.fields["color"] = collection.color;
    return record;
}

archive::Record toRecord(const JournalTag& tag) {
    auto record = baseRecord(tag.id, "journal-tag", tag.createdAtUs, tag.updatedAtUs);
    record.fields["name"] = tag.name;
    record.fields["color"] = tag.color;
    return record;
}

archive::Record toRecord(const JournalNotesDocument& document) {
    auto record =
        baseRecord(document.id, "journal-notes", document.createdAtUs, document.updatedAtUs);
    record.fields["entry_id"] = document.entryId;
    record.fields["session_id"] = document.sessionId;
    record.fields["block_count"] = std::to_string(document.blocks.size());
    for (std::size_t index = 0; index < document.blocks.size(); ++index) {
        const auto& block = document.blocks[index];
        record.fields[noteBlockKey(index, "id")] = block.id;
        record.fields[noteBlockKey(index, "kind")] = block.kind;
        record.fields[noteBlockKey(index, "text")] = block.text;
    }
    return record;
}

tutorux::core::Result<Journal> journalFromRecord(const archive::Record& record) {
    if (!hasRole(record, "journal"))
        return std::unexpected(invalidRecord("journal"));
    return Journal{record.id, getField(record, "title", "Tutorux journal"),
                   getField(record, "created_at_us"), getField(record, "updated_at_us")};
}

tutorux::core::Result<JournalEntry> journalEntryFromRecord(const archive::Record& record) {
    if (!hasRole(record, "journal-entry"))
        return std::unexpected(invalidRecord("journal entry"));
    JournalEntry entry;
    entry.id = record.id;
    entry.title = getField(record, "title", "Untitled entry");
    entry.date = getField(record, "entry_date");
    if (!entry.date.empty() && !isValidJournalDate(entry.date))
        return std::unexpected(invalidRecord("journal entry date"));
    entry.collectionIds = decodeIds(getField(record, "collection_ids"));
    entry.tagIds = decodeIds(getField(record, "tag_ids"));
    entry.notesDocumentId = getField(record, "notes_document_id");
    entry.sessionIds = decodeIds(getField(record, "session_ids"));
    entry.studyGuideIds = decodeIds(getField(record, "study_guide_ids"));
    entry.attachmentIds = decodeIds(getField(record, "attachment_ids"));
    entry.createdAtUs = getField(record, "created_at_us");
    entry.updatedAtUs = getField(record, "updated_at_us");
    return entry;
}

tutorux::core::Result<JournalCollection>
journalCollectionFromRecord(const archive::Record& record) {
    if (!hasRole(record, "journal-collection"))
        return std::unexpected(invalidRecord("journal collection"));
    return JournalCollection{record.id,
                             getField(record, "name"),
                             getField(record, "description"),
                             getField(record, "color"),
                             getField(record, "created_at_us"),
                             getField(record, "updated_at_us")};
}

tutorux::core::Result<JournalTag> journalTagFromRecord(const archive::Record& record) {
    if (!hasRole(record, "journal-tag"))
        return std::unexpected(invalidRecord("journal tag"));
    return JournalTag{record.id, getField(record, "name"), getField(record, "color"),
                      getField(record, "created_at_us"), getField(record, "updated_at_us")};
}

tutorux::core::Result<JournalNotesDocument>
journalNotesDocumentFromRecord(const archive::Record& record) {
    if (!hasRole(record, "journal-notes"))
        return std::unexpected(invalidRecord("journal notes document"));
    auto blockCount = parseCount(record, "block_count");
    if (!blockCount)
        return std::unexpected(blockCount.error());
    JournalNotesDocument document;
    document.id = record.id;
    document.entryId = getField(record, "entry_id");
    document.sessionId = getField(record, "session_id");
    document.createdAtUs = getField(record, "created_at_us");
    document.updatedAtUs = getField(record, "updated_at_us");
    document.blocks.reserve(*blockCount);
    for (std::size_t index = 0; index < *blockCount; ++index) {
        JournalNoteBlock block;
        block.id = getField(record, noteBlockKey(index, "id"));
        block.kind = getField(record, noteBlockKey(index, "kind"));
        block.text = getField(record, noteBlockKey(index, "text"));
        if (block.id.empty() || !isValidJournalNoteBlockKind(block.kind))
            return std::unexpected(invalidRecord("journal note block"));
        document.blocks.push_back(std::move(block));
    }
    return document;
}

bool isValidJournalDate(std::string_view value) noexcept {
    if (value.size() != 10 || value[4] != '-' || value[7] != '-')
        return false;
    const auto parsePart = [&](std::size_t start, std::size_t length) {
        unsigned int part = 0;
        const auto [end, errorCode] =
            std::from_chars(value.data() + start, value.data() + start + length, part);
        return errorCode == std::errc{} && end == value.data() + start + length ? part : 0U;
    };
    if (!std::all_of(value.begin(), value.end(), [index = std::size_t{0}](char character) mutable {
            const auto current = index++;
            return current == 4 || current == 7 ? character == '-'
                                                : character >= '0' && character <= '9';
        })) {
        return false;
    }
    const unsigned int year = parsePart(0, 4);
    const unsigned int month = parsePart(5, 2);
    const unsigned int day = parsePart(8, 2);
    if (year == 0 || month == 0 || month > 12 || day == 0)
        return false;
    constexpr std::array<unsigned int, 12> daysPerMonth{31, 28, 31, 30, 31, 30,
                                                        31, 31, 30, 31, 30, 31};
    const bool leapYear = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    const unsigned int maximumDay =
        month == 2 && leapYear ? 29 : daysPerMonth[static_cast<std::size_t>(month - 1)];
    return day <= maximumDay;
}

bool isValidJournalNoteBlockKind(std::string_view value) noexcept {
    static constexpr std::array kinds{"paragraph", "heading", "bullet-list", "numbered-list",
                                      "checklist", "quote",   "code"};
    return std::find(kinds.begin(), kinds.end(), value) != kinds.end();
}

} // namespace tutorux::domain
