#include "tutorux/application/trash-service.hpp"

#include "tutorux/archive/archive.hpp"
#include "tutorux/audio/recording_take.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/journal.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <charconv>
#include <chrono>
#include <iomanip>
#include <iterator>
#include <optional>
#include <set>
#include <sstream>
#include <string_view>
#include <utility>

namespace tutorux::application {
namespace {

    using archive::Archive;
    using archive::Record;
    using archive::RecordType;

    struct RecoverableNoteBlock final {
        std::string id;
        std::string kind;
        std::string text;
        std::size_t index{};
    };

    constexpr std::array kVisibleRecordTypes{
        RecordType::Student,          RecordType::Session,       RecordType::TranscriptSegment,
        RecordType::Annotation,      RecordType::AssetMetadata, RecordType::EvidenceNode,
        RecordType::EvidenceEdge,    RecordType::Guide,         RecordType::Settings,
    };

    std::string field(const Record& record, std::string_view name,
                      std::string_view fallback = {}) {
        return domain::getField(record, name, fallback);
    }

    std::string nowUs() {
        return std::to_string(std::chrono::duration_cast<std::chrono::microseconds>(
                                  std::chrono::system_clock::now().time_since_epoch())
                                  .count());
    }

    std::string deletedAtLabel(std::string_view value) {
        std::int64_t timestampUs = 0;
        const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), timestampUs);
        if (error != std::errc{} || end != value.data() + value.size() || timestampUs < 0)
            return "Deletion date unavailable";
        using namespace std::chrono;
        const sys_time<microseconds> timestamp{microseconds{timestampUs}};
        const auto day = floor<days>(timestamp);
        const year_month_day date{day};
        const hh_mm_ss time{floor<seconds>(timestamp - day)};
        std::ostringstream output;
        output << "Deleted " << std::setfill('0') << std::setw(4)
               << static_cast<int>(date.year()) << '-' << std::setw(2)
               << static_cast<unsigned int>(date.month()) << '-' << std::setw(2)
               << static_cast<unsigned int>(date.day()) << ' ' << std::setw(2)
               << time.hours().count() << ':' << std::setw(2) << time.minutes().count() << " UTC";
        return output.str();
    }

    bool visibleSettingsRole(std::string_view role) {
        return role == "journal-entry" || role == "journal-collection" || role == "journal-tag" ||
               role == "journal-notes" || role == "guide-template";
    }

    std::optional<std::vector<RecoverableNoteBlock>> recoverableNoteBlocks(const Record& record) {
        std::vector<RecoverableNoteBlock> blocks;
        const auto countText = field(record, "removed_block_count");
        if (!countText.empty()) {
            std::size_t count{};
            const auto [end, error] =
                std::from_chars(countText.data(), countText.data() + countText.size(), count);
            if (error != std::errc{} || end != countText.data() + countText.size() || count > 256)
                return std::nullopt;
            blocks.reserve(count);
            for (std::size_t index = 0; index < count; ++index) {
                const auto prefix = "removed_block_" + std::to_string(index) + "_";
                RecoverableNoteBlock block;
                block.id = field(record, prefix + "id");
                block.kind = field(record, prefix + "kind");
                block.text = field(record, prefix + "text");
                const auto indexText = field(record, prefix + "index");
                const auto [indexEnd, indexError] = std::from_chars(
                    indexText.data(), indexText.data() + indexText.size(), block.index);
                if (block.id.empty() || !domain::isValidJournalNoteBlockKind(block.kind) ||
                    indexError != std::errc{} || indexEnd != indexText.data() + indexText.size())
                    return std::nullopt;
                blocks.push_back(std::move(block));
            }
        }
        if (!blocks.empty())
            return blocks;

        const auto id = field(record, "last_removed_block_id");
        const auto kind = field(record, "last_removed_block_kind");
        const auto text = field(record, "last_removed_block_text");
        const auto indexText = field(record, "last_removed_block_index");
        if (id.empty() && kind.empty() && text.empty() && indexText.empty())
            return blocks;
        RecoverableNoteBlock legacy;
        legacy.id = id;
        legacy.kind = kind;
        legacy.text = text;
        const auto [indexEnd, indexError] =
            std::from_chars(indexText.data(), indexText.data() + indexText.size(), legacy.index);
        if (legacy.id.empty() || !domain::isValidJournalNoteBlockKind(legacy.kind) ||
            indexError != std::errc{} || indexEnd != indexText.data() + indexText.size())
            return std::nullopt;
        blocks.push_back(std::move(legacy));
        return blocks;
    }

    void writeRecoveryStack(Record& record,
                            const std::vector<RecoverableNoteBlock>& blocks) {
        std::erase_if(record.fields, [](const auto& item) {
            return item.first.starts_with("removed_block_") ||
                   item.first == "last_removed_block_id" ||
                   item.first == "last_removed_block_kind" ||
                   item.first == "last_removed_block_text" ||
                   item.first == "last_removed_block_index";
        });
        record.fields["removed_block_count"] = std::to_string(blocks.size());
        for (std::size_t index = 0; index < blocks.size(); ++index) {
            const auto prefix = "removed_block_" + std::to_string(index) + "_";
            record.fields[prefix + "id"] = blocks[index].id;
            record.fields[prefix + "kind"] = blocks[index].kind;
            record.fields[prefix + "text"] = blocks[index].text;
            record.fields[prefix + "index"] = std::to_string(blocks[index].index);
        }
        if (!blocks.empty()) {
            const auto& newest = blocks.back();
            record.fields["last_removed_block_id"] = newest.id;
            record.fields["last_removed_block_kind"] = newest.kind;
            record.fields["last_removed_block_text"] = newest.text;
            record.fields["last_removed_block_index"] = std::to_string(newest.index);
        }
    }

    core::Status restoreNoteBlock(Archive& archive, const archive::Uuid& documentId,
                                  std::string_view blockId) {
        auto loaded = archive.get(RecordType::Settings, documentId);
        if (!loaded)
            return std::unexpected(loaded.error());
        if (!*loaded || domain::isDeleted(**loaded) ||
            field(**loaded, "record_role") != "journal-notes")
            return std::unexpected(core::error("trash_note_block_unavailable",
                                                "The session notes containing this block are unavailable."));

        auto blocks = recoverableNoteBlocks(**loaded);
        if (!blocks)
            return std::unexpected(core::error("trash_note_block_invalid",
                                                "The saved note block recovery data is invalid."));
        const auto removed = std::find_if(blocks->begin(), blocks->end(),
                                          [&](const RecoverableNoteBlock& item) {
                                              return item.id == blockId;
                                          });
        if (removed == blocks->end())
            return std::unexpected(core::error("trash_note_block_unavailable",
                                                "This note block is no longer in Trash."));

        auto document = domain::journalNotesDocumentFromRecord(**loaded);
        if (!document)
            return std::unexpected(document.error());
        if (std::any_of(document->blocks.begin(), document->blocks.end(),
                        [&](const domain::JournalNoteBlock& item) { return item.id == blockId; }))
            return std::unexpected(core::error("trash_note_block_conflict",
                                                "A note block with this identifier is already active."));
        const auto saved = *removed;
        blocks->erase(removed);
        const auto insertionIndex = std::min(saved.index, document->blocks.size());
        document->blocks.insert(document->blocks.begin() + static_cast<std::ptrdiff_t>(insertionIndex),
                                {saved.id, saved.kind, saved.text});
        document->updatedAtUs = nowUs();

        Record updated = std::move(**loaded);
        auto serialized = domain::toRecord(*document);
        for (const auto& [name, value] : serialized.fields)
            updated.fields.insert_or_assign(name, value);
        writeRecoveryStack(updated, *blocks);
        updated.fields["updated_at_us"] = document->updatedAtUs;
        return archive.put(std::move(updated));
    }

    std::string labelFor(const Record& record) {
        const auto role = field(record, "record_role");
        if (record.type == RecordType::Student)
            return field(record, "display_name", "Unnamed student");
        if (record.type == RecordType::Session)
            return field(record, "title", "Untitled session");
        if (record.type == RecordType::TranscriptSegment)
            return field(record, "text", "Transcript segment");
        if (record.type == RecordType::Annotation)
            return field(record, "title", field(record, "content", "Marker"));
        if (record.type == RecordType::AssetMetadata) {
            if (role == "recording-take")
                return field(record, "label", "Recording take");
            if (role == "audio-track")
                return field(record, "label", field(record, "source", "Audio track"));
            return field(record, "display_name", field(record, "original_name",
                       field(record, "name", "Material")));
        }
        if (record.type == RecordType::EvidenceNode)
            return field(record, "title", field(record, "claim", field(record, "text", "Evidence")));
        if (record.type == RecordType::EvidenceEdge)
            return field(record, "label", field(record, "edge_type", "Evidence link"));
        if (record.type == RecordType::Guide)
            return field(record, "title", "Untitled guide");
        if (role == "journal-entry")
            return field(record, "title", "Untitled journal entry");
        if (role == "journal-collection")
            return field(record, "name", "Journal collection");
        if (role == "journal-tag")
            return field(record, "name", "Journal tag");
        if (role == "journal-notes")
            return "Journal notes";
        if (role == "guide-template")
            return field(record, "name", "Guide template");
        return "Deleted record";
    }

    std::string detailFor(const Record& record) {
        if (record.type == RecordType::TranscriptSegment)
            return field(record, "speaker", "Transcript");
        if (record.type == RecordType::Annotation)
            return field(record, "type", "Marker");
        if (record.type == RecordType::AssetMetadata && field(record, "record_role") == "audio-track")
            return "Audio track · " + field(record, "source", "Recording");
        if (record.type == RecordType::AssetMetadata)
            return field(record, "mime_type", field(record, "source", "Material"));
        if (record.type == RecordType::Settings) {
            const auto role = field(record, "record_role");
            if (role == "journal-entry")
                return "Journal entry";
            if (role == "journal-collection")
                return "Journal collection";
            if (role == "journal-tag")
                return "Journal tag";
            if (role == "guide-template")
                return "Guide template";
            if (role == "journal-notes")
                return "Notes document";
        }
        return {};
    }

    std::string typeLabel(const Record& record) {
        switch (record.type) {
        case RecordType::Student: return "Student";
        case RecordType::Session: return "Session";
        case RecordType::TranscriptSegment: return "Transcript segment";
        case RecordType::Annotation: return "Marker";
        case RecordType::AssetMetadata:
            if (field(record, "record_role") == "recording-take") return "Recording take";
            if (field(record, "record_role") == "audio-track") return "Audio track";
            return "Material";
        case RecordType::EvidenceNode: return "Evidence";
        case RecordType::EvidenceEdge: return "Evidence link";
        case RecordType::Guide: return "Study guide";
        case RecordType::Settings:
            if (field(record, "record_role") == "journal-entry") return "Journal entry";
            if (field(record, "record_role") == "journal-collection") return "Collection";
            if (field(record, "record_role") == "journal-tag") return "Tag";
            if (field(record, "record_role") == "guide-template") return "Guide template";
            if (field(record, "record_role") == "journal-notes") return "Notes";
            return "Record";
        default: return "Record";
        }
    }

    bool csvContains(std::string_view list, std::string_view id) {
        std::size_t start = 0;
        while (start <= list.size()) {
            const auto comma = list.find(',', start);
            const auto end = comma == std::string_view::npos ? list.size() : comma;
            if (list.substr(start, end - start) == id)
                return true;
            if (comma == std::string_view::npos)
                break;
            start = comma + 1;
        }
        return false;
    }

    bool isReferenceField(std::string_view name) {
        return name.ends_with("_id") || name.ends_with("_ids");
    }

    void markRestored(Record& record) {
        record.fields.erase("_deleted");
        record.fields.erase("deleted_at_us");
        record.fields.erase("_trash_group_id");
        record.fields["restored_at_us"] = nowUs();
        record.fields["updated_at_us"] = nowUs();
    }

    void mergeCsvField(Record& record, std::string_view fieldName,
                       std::string_view valuesToAdd) {
        if (valuesToAdd.empty())
            return;
        std::string merged = field(record, fieldName);
        std::size_t start = 0;
        while (start <= valuesToAdd.size()) {
            const auto comma = valuesToAdd.find(',', start);
            const auto end = comma == std::string_view::npos ? valuesToAdd.size() : comma;
            const auto token = valuesToAdd.substr(start, end - start);
            if (!token.empty() && !csvContains(merged, token)) {
                if (!merged.empty())
                    merged.push_back(',');
                merged.append(token);
            }
            if (comma == std::string_view::npos)
                break;
            start = comma + 1;
        }
        record.fields[std::string(fieldName)] = std::move(merged);
    }

    core::Status restoreSessionGroup(Archive& archive, Record session) {
        const std::string sessionId = archive::uuidToString(session.id);
        std::vector<Record> transaction;
        std::set<std::string, std::less<>> restoredIds{sessionId};
        const auto collect = [&](RecordType type, bool legacySessionChildren = false) -> core::Status {
            auto records = archive.list(type, true);
            if (!records)
                return std::unexpected(records.error());
            for (auto& record : *records) {
                const bool groupMatch = field(record, "_trash_group_id") == sessionId;
                const bool legacyMatch = legacySessionChildren && domain::isDeleted(record) &&
                                         field(record, "session_id") == sessionId;
                if ((record.type == session.type && record.id == session.id) ||
                    (!groupMatch && !legacyMatch))
                    continue;
                if (domain::isDeleted(record)) {
                    markRestored(record);
                    restoredIds.insert(archive::uuidToString(record.id));
                    transaction.push_back(std::move(record));
                }
            }
            return {};
        };

        for (const auto type : {RecordType::AudioChunk, RecordType::TranscriptSegment,
                                RecordType::Annotation, RecordType::AssetMetadata,
                                RecordType::EvidenceNode, RecordType::EvidenceEdge,
                                RecordType::Guide, RecordType::WaveformIndex,
                                RecordType::Settings}) {
            const bool legacyChildren = type == RecordType::AudioChunk || type == RecordType::TranscriptSegment ||
                                        type == RecordType::Annotation || type == RecordType::AssetMetadata ||
                                        type == RecordType::EvidenceNode || type == RecordType::Guide ||
                                        type == RecordType::WaveformIndex || type == RecordType::Settings;
            if (auto status = collect(type, legacyChildren); !status)
                return status;
        }

        // Restore evidence edges that point at records in the recovered group,
        // including older archives that predate explicit group metadata.
        auto edges = archive.list(RecordType::EvidenceEdge, true);
        if (!edges)
            return std::unexpected(edges.error());
        for (auto& edge : *edges) {
            if (!domain::isDeleted(edge))
                continue;
            if (field(edge, "session_id") != sessionId &&
                !restoredIds.contains(field(edge, "from_id")) &&
                !restoredIds.contains(field(edge, "to_id")))
                continue;
            if (std::any_of(transaction.begin(), transaction.end(), [&](const Record& existing) {
                    return existing.type == edge.type && existing.id == edge.id;
                }))
                continue;
            markRestored(edge);
            restoredIds.insert(archive::uuidToString(edge.id));
            transaction.push_back(std::move(edge));
        }

        // Reattach relations removed from journal entries during group delete.
        auto settings = archive.list(RecordType::Settings);
        if (!settings)
            return std::unexpected(settings.error());
        const std::string entryId = field(session, "entry_id");
        for (auto& record : *settings) {
            if (field(record, "record_role") != "journal-entry" || domain::isDeleted(record))
                continue;
            bool changed = false;
            if (field(record, "_trash_session_group_id") == sessionId) {
                mergeCsvField(record, "session_ids", field(record, "_trash_restore_session_refs"));
                mergeCsvField(record, "study_guide_ids", field(record, "_trash_restore_guide_refs"));
                mergeCsvField(record, "attachment_ids", field(record, "_trash_restore_asset_refs"));
                for (const auto key : {"_trash_session_group_id", "_trash_restore_session_refs",
                                       "_trash_restore_guide_refs", "_trash_restore_asset_refs"})
                    record.fields.erase(key);
                changed = true;
            } else if (!entryId.empty() && archive::uuidToString(record.id) == entryId &&
                       !csvContains(field(record, "session_ids"), sessionId)) {
                // Best effort for session groups created before relation
                // snapshots were included in the archive.
                mergeCsvField(record, "session_ids", sessionId);
                changed = true;
            }
            if (changed) {
                record.fields["updated_at_us"] = nowUs();
                transaction.push_back(std::move(record));
            }
        }

        markRestored(session);
        transaction.push_back(std::move(session));
        return archive.putMany(std::move(transaction));
    }

    core::Result<std::vector<Record>> allCurrentRecords(Archive& archive, bool includeDeleted) {
        std::vector<Record> all;
        for (const auto type : {RecordType::Student, RecordType::Session, RecordType::AudioChunk,
                                RecordType::TranscriptSegment, RecordType::Annotation,
                                RecordType::AssetMetadata, RecordType::AssetBlob,
                                RecordType::EvidenceNode, RecordType::EvidenceEdge,
                                RecordType::Guide, RecordType::Settings, RecordType::AiJob,
                                RecordType::WaveformIndex}) {
            auto records = archive.list(type, includeDeleted);
            if (!records)
                return std::unexpected(records.error());
            all.insert(all.end(), std::make_move_iterator(records->begin()),
                       std::make_move_iterator(records->end()));
        }
        return all;
    }

} // namespace

TrashSnapshot TrashService::snapshot(const std::filesystem::path& archivePath,
                                     std::string_view passphrase) const {
    TrashSnapshot result;
    auto opened = Archive::open(archivePath, false, passphrase);
    if (!opened) {
        result.errorMessage = opened.error().message;
        return result;
    }
    result.generation = opened->commitInfo().generation;
    for (const auto type : kVisibleRecordTypes) {
        auto records = opened->list(type, true);
        if (!records) {
            result.errorMessage = records.error().message;
            result.items.clear();
            return result;
        }
        for (const auto& record : *records) {
            const std::string role = field(record, "record_role");
            if (type == RecordType::Settings && role == "journal-notes" &&
                !domain::isDeleted(record)) {
                auto removedBlocks = recoverableNoteBlocks(record);
                if (!removedBlocks) {
                    result.errorMessage =
                        "A saved session note has invalid recovery data and cannot be listed in Trash.";
                    result.items.clear();
                    return result;
                }
                for (const auto& block : *removedBlocks) {
                    TrashItem item;
                    item.type = RecordType::Settings;
                    item.typeLabel = "Session note block";
                    item.id = "note-block:" + archive::uuidToString(record.id) + ":" + block.id;
                    item.title = block.text.empty() ? "Empty note block" : block.text;
                    if (item.title.size() > 120) {
                        item.title.resize(117);
                        item.title += "…";
                    }
                    item.detail = "Removed " + block.kind + " block from session notes";
                    item.deletedAtUs = "Removed from notes";
                    item.sessionId = field(record, "session_id");
                    result.items.push_back(std::move(item));
                }
            }
            if (!domain::isDeleted(record))
                continue;
            if (type == RecordType::Settings && !visibleSettingsRole(role))
                continue;
            if (type == RecordType::AssetMetadata &&
                (role == "waveform-pyramid" ||
                 role == "sparse-timestamp-seek-index" || role == "asset-blob-manifest" ||
                 role == "asset-blob-chunk"))
                continue;
            const std::string groupId = field(record, "_trash_group_id");
            // The owning session or take is the one user-facing Trash row;
            // its synchronized tracks and other dependent records are restored
            // with it as one operation.
            if (!groupId.empty() && groupId != archive::uuidToString(record.id))
                continue;

            TrashItem item;
            item.type = type;
            item.typeLabel = typeLabel(record);
            item.id = archive::uuidToString(record.id);
            item.title = labelFor(record);
            item.detail = detailFor(record);
            item.deletedAtUs = deletedAtLabel(field(record, "deleted_at_us"));
            item.sessionId = field(record, "session_id");
            item.restoresGroup = type == RecordType::Session;
            if (item.restoresGroup)
                item.sessionId = item.id;
            if (type == RecordType::AssetMetadata && role == "recording-take")
                item.sessionId = field(record, "session_id");
            if (type == RecordType::AssetMetadata && role == "audio-track")
                item.sessionId = field(record, "session_id");
            result.items.push_back(std::move(item));
        }
    }
    std::stable_sort(result.items.begin(), result.items.end(), [](const TrashItem& left, const TrashItem& right) {
        if (left.deletedAtUs != right.deletedAtUs)
            return left.deletedAtUs > right.deletedAtUs;
        if (left.typeLabel != right.typeLabel)
            return left.typeLabel < right.typeLabel;
        return left.title < right.title;
    });
    return result;
}

core::Status TrashService::restore(const std::filesystem::path& archivePath,
                                   std::string_view passphrase,
                                   RecordType type,
                                   std::string_view idText) const {
    constexpr std::string_view noteBlockPrefix = "note-block:";
    if (type == RecordType::Settings && idText.starts_with(noteBlockPrefix)) {
        idText.remove_prefix(noteBlockPrefix.size());
        const auto separator = idText.find(':');
        if (separator == std::string_view::npos ||
            idText.find(':', separator + 1) != std::string_view::npos)
            return std::unexpected(core::error("trash_note_block_id_invalid",
                                                "The note block Trash identifier is invalid."));
        const auto documentId = archive::uuidFromString(idText.substr(0, separator));
        const auto blockId = archive::uuidFromString(idText.substr(separator + 1));
        if (!documentId || !blockId)
            return std::unexpected(core::error("trash_note_block_id_invalid",
                                                "The note block Trash identifier is invalid."));
        auto opened = Archive::open(archivePath, true, passphrase);
        if (!opened)
            return std::unexpected(opened.error());
        return restoreNoteBlock(*opened, *documentId, archive::uuidToString(*blockId));
    }
    auto id = archive::uuidFromString(idText);
    if (!id)
        return std::unexpected(id.error());
    auto opened = Archive::open(archivePath, true, passphrase);
    if (!opened)
        return std::unexpected(opened.error());
    auto loaded = opened->get(type, *id);
    if (!loaded)
        return std::unexpected(loaded.error());
    if (!*loaded || !domain::isDeleted(**loaded))
        return std::unexpected(core::error("trash_item_unavailable", "This item is no longer in Trash."));
    Record record = std::move(**loaded);
    if (type == RecordType::Session)
        return restoreSessionGroup(*opened, std::move(record));
    if (type == RecordType::AssetMetadata && field(record, "record_role") == "recording-take")
        return audio::setRecordingTakeDeleted(*opened, record.id, false);
    if (type == RecordType::AssetMetadata && field(record, "record_role") == "audio-track")
        return audio::setRecordingTrackDeleted(*opened, record.id, false);

    if (type == RecordType::EvidenceNode) {
        const std::string groupId = archive::uuidToString(record.id);
        auto edges = opened->list(RecordType::EvidenceEdge, true);
        if (!edges)
            return std::unexpected(edges.error());
        std::vector<Record> transaction;
        for (auto& edge : *edges) {
            if (!domain::isDeleted(edge) || field(edge, "_trash_group_id") != groupId)
                continue;
            markRestored(edge);
            transaction.push_back(std::move(edge));
        }
        markRestored(record);
        transaction.push_back(std::move(record));
        return opened->putMany(std::move(transaction));
    }

    if (type == RecordType::EvidenceEdge) {
        for (const auto key : {"from_id", "to_id"}) {
            auto endpointId = archive::uuidFromString(field(record, key));
            if (!endpointId)
                return std::unexpected(endpointId.error());
            auto endpoint = opened->get(RecordType::EvidenceNode, *endpointId);
            if (!endpoint)
                return std::unexpected(endpoint.error());
            if (!*endpoint || domain::isDeleted(**endpoint))
                return std::unexpected(core::error(
                    "trash_link_endpoint_missing",
                    "Restore both linked evidence items before restoring this relationship."));
        }
    }

    if (type == RecordType::Guide) {
        const std::string guideId = archive::uuidToString(record.id);
        auto settings = opened->list(RecordType::Settings);
        if (!settings)
            return std::unexpected(settings.error());
        std::vector<Record> transaction;
        for (auto& entry : *settings) {
            if (field(entry, "record_role") != "journal-entry" || domain::isDeleted(entry) ||
                field(entry, "_trash_guide_group_id") != guideId)
                continue;
            mergeCsvField(entry, "study_guide_ids", field(entry, "_trash_restore_guide_refs"));
            entry.fields.erase("_trash_guide_group_id");
            entry.fields.erase("_trash_restore_guide_refs");
            entry.fields["updated_at_us"] = nowUs();
            transaction.push_back(std::move(entry));
        }
        markRestored(record);
        transaction.push_back(std::move(record));
        return opened->putMany(std::move(transaction));
    }

    if (type == RecordType::Settings && field(record, "record_role") == "journal-entry") {
        const std::string entryId = archive::uuidToString(record.id);
        auto settings = opened->list(RecordType::Settings, true);
        if (!settings)
            return std::unexpected(settings.error());
        std::vector<Record> transaction;
        for (auto& linked : *settings) {
            if (field(linked, "record_role") != "journal-notes" ||
                field(linked, "entry_id") != entryId || !domain::isDeleted(linked))
                continue;
            markRestored(linked);
            transaction.push_back(std::move(linked));
        }
        markRestored(record);
        transaction.push_back(std::move(record));
        return opened->putMany(std::move(transaction));
    }

    if (type == RecordType::Settings &&
        (field(record, "record_role") == "journal-collection" ||
         field(record, "record_role") == "journal-tag")) {
        const std::string relationId = archive::uuidToString(record.id);
        const bool collection = field(record, "record_role") == "journal-collection";
        auto settings = opened->list(RecordType::Settings);
        if (!settings)
            return std::unexpected(settings.error());
        std::vector<Record> transaction;
        for (auto& entry : *settings) {
            if (field(entry, "record_role") != "journal-entry" || domain::isDeleted(entry))
                continue;
            const std::string refsKey = collection ? "_trash_restore_collection_refs" : "_trash_restore_tag_refs";
            if (csvContains(field(entry, refsKey), relationId)) {
                mergeCsvField(entry, collection ? "collection_ids" : "tag_ids", relationId);
                auto saved = field(entry, refsKey);
                std::vector<std::string> retained;
                std::size_t start = 0;
                while (start <= saved.size()) {
                    const auto comma = saved.find(',', start);
                    const auto end = comma == std::string::npos ? saved.size() : comma;
                    const auto token = saved.substr(start, end - start);
                    if (token != relationId && !token.empty())
                        retained.push_back(token);
                    if (comma == std::string::npos)
                        break;
                    start = comma + 1;
                }
                std::string remaining;
                for (const auto& token : retained) {
                    if (!remaining.empty()) remaining.push_back(',');
                    remaining += token;
                }
                if (remaining.empty()) entry.fields.erase(refsKey);
                else entry.fields[refsKey] = std::move(remaining);
                entry.fields["updated_at_us"] = nowUs();
                transaction.push_back(std::move(entry));
            }
        }
        markRestored(record);
        transaction.push_back(std::move(record));
        return opened->putMany(std::move(transaction));
    }

    markRestored(record);
    return opened->put(std::move(record));
}

core::Status TrashService::purge(const std::filesystem::path& archivePath,
                                 std::string_view passphrase) const {
    auto opened = Archive::open(archivePath, true, passphrase);
    if (!opened)
        return std::unexpected(opened.error());
    auto all = allCurrentRecords(*opened, true);
    if (!all)
        return std::unexpected(all.error());
    std::set<std::string, std::less<>> deletedIds;
    for (const auto& record : *all) {
        if (domain::isDeleted(record))
            deletedIds.insert(archive::uuidToString(record.id));
    }
    std::set<std::string, std::less<>> activeReferences;
    for (const auto& record : *all) {
        if (domain::isDeleted(record))
            continue;
        for (const auto& [name, value] : record.fields) {
            if (!isReferenceField(name) || name.starts_with("_trash_"))
                continue;
            if (name.ends_with("_ids")) {
                std::size_t start = 0;
                while (start <= value.size()) {
                    const auto comma = value.find(',', start);
                    const auto end = comma == std::string::npos ? value.size() : comma;
                    if (end != start)
                        activeReferences.insert(value.substr(start, end - start));
                    if (comma == std::string::npos)
                        break;
                    start = comma + 1;
                }
            } else if (!value.empty()) {
                activeReferences.insert(value);
            }
        }
    }
    for (const auto& id : deletedIds) {
        if (activeReferences.contains(id))
            return std::unexpected(core::error(
                "trash_purge_reference_blocked",
                "A trashed record is still linked from an active record. Restore it or remove the active link before purging Trash."));
    }
    if (auto status = opened->purgeDeleted(); !status)
        return status;

    // Group-delete snapshots are only needed while the referenced group is in
    // Trash. Remove the private recovery fields after permanent purge.
    auto activeRecords = allCurrentRecords(*opened, false);
    if (!activeRecords)
        return std::unexpected(activeRecords.error());
    std::vector<Record> cleanup;
    for (auto& record : *activeRecords) {
        bool changed = false;
        for (auto iterator = record.fields.begin(); iterator != record.fields.end();) {
            if (field(record, "record_role") == "journal-notes" &&
                iterator->first == "removed_block_count") {
                iterator->second = "0";
                changed = true;
                ++iterator;
            } else if (iterator->first.starts_with("_trash_restore_") ||
                iterator->first == "_trash_session_group_id" ||
                iterator->first == "_trash_guide_group_id" ||
                (field(record, "record_role") == "journal-notes" &&
                 (iterator->first == "removed_block_count" ||
                  iterator->first.starts_with("removed_block_") ||
                  iterator->first == "last_removed_block_id" ||
                  iterator->first == "last_removed_block_kind" ||
                  iterator->first == "last_removed_block_text" ||
                  iterator->first == "last_removed_block_index"))) {
                iterator = record.fields.erase(iterator);
                changed = true;
            } else {
                ++iterator;
            }
        }
        if (changed) {
            record.fields["updated_at_us"] = nowUs();
            cleanup.push_back(std::move(record));
        }
    }
    if (!cleanup.empty())
        return opened->putMany(std::move(cleanup));
    return {};
}

} // namespace tutorux::application
