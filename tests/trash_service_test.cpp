#include "tutorux/application/trash-service.hpp"

#include "tutorux/archive/archive.hpp"
#include "tutorux/audio/recording_take.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/journal.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <iostream>
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
    std::cerr << "trash service: " << message << '\n';
    return 1;
}

tutorux::archive::Record record(tutorux::archive::RecordType type,
                                const tutorux::archive::Uuid& id,
                                std::initializer_list<std::pair<std::string, std::string>> fields) {
    tutorux::archive::Record value;
    value.type = type;
    value.id = id;
    value.fields.insert(fields.begin(), fields.end());
    return value;
}

} // namespace

int main() {
    using namespace tutorux;
    const auto suffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() /
                                 ("tutorux-trash-service-" + std::to_string(suffix))};
    std::error_code filesystemError;
    std::filesystem::create_directories(temporary.path, filesystemError);
    if (filesystemError)
        return fail("could not create a temporary directory");

    const auto archivePath = temporary.path / "trash.tux";
    archive::Uuid sessionId{};
    archive::Uuid entryId{};
    archive::Uuid collectionId{};
    archive::Uuid takeId{};
    archive::Uuid trackId{};
    archive::Uuid guideId{};
    archive::Uuid evidenceId{};
    archive::Uuid evidencePeerId{};
    archive::Uuid evidenceEdgeId{};
    archive::Uuid studentId{};
    archive::Uuid purgeMarkerId{};
    archive::Uuid notesDocumentId{};
    archive::Uuid noteBlockRestoreId{};
    archive::Uuid noteBlockPurgeId{};
    {
        auto created = archive::Archive::create(archivePath, "Trash service test");
        if (!created)
            return fail(created.error().message);

        sessionId = archive::randomUuid();
        entryId = archive::randomUuid();
        collectionId = archive::randomUuid();
        takeId = archive::randomUuid();
        trackId = archive::randomUuid();
        guideId = archive::randomUuid();
        evidenceId = archive::randomUuid();
        evidencePeerId = archive::randomUuid();
        evidenceEdgeId = archive::randomUuid();
        studentId = archive::randomUuid();
        purgeMarkerId = archive::randomUuid();

        domain::Session session;
        session.id = sessionId;
        session.studentId = "anonymous";
        session.title = "Deleted session";
        session.entryId = archive::uuidToString(entryId);
        auto sessionRecord = domain::toRecord(session);
        sessionRecord.fields["recording_track_ids"] = archive::uuidToString(trackId);
        sessionRecord.fields["recording_track_id"] = archive::uuidToString(trackId);
        sessionRecord.fields["_deleted"] = "true";
        sessionRecord.fields["_trash_group_id"] = archive::uuidToString(sessionId);

        const std::string sessionText = archive::uuidToString(sessionId);
        const std::string entryText = archive::uuidToString(entryId);
        const std::string takeText = archive::uuidToString(takeId);
        const std::string trackText = archive::uuidToString(trackId);
        auto entry = record(archive::RecordType::Settings, entryId,
                            {{"record_role", "journal-entry"},
                             {"title", "Session journal"},
                             {"session_ids", ""},
                             {"collection_ids", ""},
                             {"_trash_session_group_id", sessionText},
                             {"_trash_restore_session_refs", sessionText},
                             {"_trash_restore_collection_refs", archive::uuidToString(collectionId)}});

        auto collection = record(archive::RecordType::Settings, collectionId,
                                 {{"record_role", "journal-collection"}, {"name", "Week 1"},
                                  {"_deleted", "true"}});

        auto annotation = record(archive::RecordType::Annotation, archive::randomUuid(),
                                {{"session_id", sessionText}, {"title", "Marker"},
                                 {"_deleted", "true"}, {"_trash_group_id", sessionText}});

        auto take = audio::makeRecordingTakeRecord(takeId, sessionId, "microphone", "completed",
                                                   {trackId}, 1'700'000'000'000'000ULL);
        take.fields["_deleted"] = "true";
        take.fields["_trash_group_id"] = sessionText;

        auto track = record(archive::RecordType::AssetMetadata, trackId,
                            {{"record_role", "audio-track"}, {"session_id", sessionText},
                             {"track_id", trackText}, {"recording_take_id", takeText},
                             {"source", "microphone"}, {"_deleted", "true"},
                             {"_trash_group_id", sessionText}});
        auto chunk = record(archive::RecordType::AudioChunk, archive::randomUuid(),
                            {{"session_id", sessionText}, {"track_id", trackText},
                             {"sequence_number", "0"}, {"first_sample_index", "0"},
                             {"sample_count", "0"}, {"gap_before_samples", "0"},
                             {"sample_rate_hz", "8000"}, {"channel_count", "1"},
                             {"sample_format", "pcm_s16le"}, {"codec", "none"},
                             {"payload_checksum", "0"},
                             {"_deleted", "true"}, {"_trash_group_id", sessionText}});

        auto detachedSession = record(archive::RecordType::Session, archive::randomUuid(),
                                      {{"title", "Live session referencing a trashed student"},
                                       {"student_id", archive::uuidToString(studentId)}});
        auto student = record(archive::RecordType::Student, studentId,
                              {{"display_name", "Trashed student"}, {"_deleted", "true"}});
        auto purgeMarker = record(archive::RecordType::Annotation, purgeMarkerId,
                                 {{"title", "Purge me"}, {"_deleted", "true"}});

        if (auto status = created->putMany({std::move(sessionRecord), std::move(entry),
                                            std::move(collection),
                                            std::move(annotation), std::move(take),
                                            std::move(track), std::move(chunk),
                                            std::move(detachedSession), std::move(student),
                                            std::move(purgeMarker)}); !status)
            return fail(status.error().message);
    }

    application::TrashService service;
    auto snapshot = service.snapshot(archivePath, {});
    if (!snapshot.errorMessage.empty())
        return fail(snapshot.errorMessage);
    if (snapshot.items.size() != 4)
        return fail("Trash should show the grouped session, collection, student, and marker only");

    if (auto status = service.restore(archivePath, {}, archive::RecordType::Session,
                                     archive::uuidToString(sessionId)); !status)
        return fail(status.error().message);
    snapshot = service.snapshot(archivePath, {});
    if (!snapshot.errorMessage.empty())
        return fail(snapshot.errorMessage);
    if (snapshot.items.size() != 3)
        return fail("restoring a session should recover its group and leave unrelated Trash items");

    {
        auto opened = archive::Archive::open(archivePath, false);
        if (!opened)
            return fail(opened.error().message);
        auto restoredSession = opened->get(archive::RecordType::Session, sessionId);
        auto restoredTake = opened->get(archive::RecordType::AssetMetadata, takeId);
        auto restoredTrack = opened->get(archive::RecordType::AssetMetadata, trackId);
        auto restoredEntry = opened->get(archive::RecordType::Settings, entryId);
        auto chunks = opened->list(archive::RecordType::AudioChunk, true);
        if (!restoredSession || !*restoredSession || domain::isDeleted(**restoredSession) ||
            !restoredTake || !*restoredTake || domain::isDeleted(**restoredTake) ||
            !restoredTrack || !*restoredTrack || domain::isDeleted(**restoredTrack) ||
            !restoredEntry || !*restoredEntry ||
            domain::getField(**restoredEntry, "session_ids") != archive::uuidToString(sessionId))
            return fail("session restore did not restore its records and journal relationship");
        if (!chunks || chunks->empty() || domain::isDeleted(chunks->front()))
            return fail("session restore did not restore its audio chunk");
    }

    if (auto status = service.restore(archivePath, {}, archive::RecordType::Settings,
                                     archive::uuidToString(collectionId)); !status)
        return fail(status.error().message);
    {
        auto opened = archive::Archive::open(archivePath, false);
        if (!opened)
            return fail(opened.error().message);
        auto restoredEntry = opened->get(archive::RecordType::Settings, entryId);
        if (!restoredEntry || !*restoredEntry ||
            domain::getField(**restoredEntry, "collection_ids") != archive::uuidToString(collectionId))
            return fail("restoring a journal collection did not restore its prior entry relation");
    }
    snapshot = service.snapshot(archivePath, {});
    if (!snapshot.errorMessage.empty() || snapshot.items.size() != 2)
        return fail("restoring the collection should leave only unrelated Trash items");

    notesDocumentId = archive::randomUuid();
    noteBlockRestoreId = archive::randomUuid();
    noteBlockPurgeId = archive::randomUuid();
    {
        auto opened = archive::Archive::open(archivePath, true);
        if (!opened)
            return fail(opened.error().message);
        domain::JournalNotesDocument notes;
        notes.id = notesDocumentId;
        notes.entryId = archive::uuidToString(entryId);
        notes.sessionId = archive::uuidToString(sessionId);
        notes.createdAtUs = "1700000000000000";
        notes.updatedAtUs = notes.createdAtUs;
        auto noteRecord = domain::toRecord(notes);
        noteRecord.fields["removed_block_count"] = "2";
        noteRecord.fields["removed_block_0_id"] = archive::uuidToString(noteBlockRestoreId);
        noteRecord.fields["removed_block_0_kind"] = "paragraph";
        noteRecord.fields["removed_block_0_text"] = "Restore this observation";
        noteRecord.fields["removed_block_0_index"] = "0";
        noteRecord.fields["removed_block_1_id"] = archive::uuidToString(noteBlockPurgeId);
        noteRecord.fields["removed_block_1_kind"] = "heading";
        noteRecord.fields["removed_block_1_text"] = "Purge this removed heading";
        noteRecord.fields["removed_block_1_index"] = "1";
        noteRecord.fields["last_removed_block_id"] = archive::uuidToString(noteBlockPurgeId);
        noteRecord.fields["last_removed_block_kind"] = "heading";
        noteRecord.fields["last_removed_block_text"] = "Purge this removed heading";
        noteRecord.fields["last_removed_block_index"] = "1";
        if (auto status = opened->put(std::move(noteRecord)); !status)
            return fail(status.error().message);
    }
    snapshot = service.snapshot(archivePath, {});
    const std::string restoreBlockToken = "note-block:" + archive::uuidToString(notesDocumentId) + ":" +
                                          archive::uuidToString(noteBlockRestoreId);
    const std::string purgeBlockToken = "note-block:" + archive::uuidToString(notesDocumentId) + ":" +
                                        archive::uuidToString(noteBlockPurgeId);
    if (!snapshot.errorMessage.empty() ||
        std::none_of(snapshot.items.begin(), snapshot.items.end(), [&](const auto& item) {
            return item.id == restoreBlockToken && item.typeLabel == "Session note block";
        }) ||
        std::none_of(snapshot.items.begin(), snapshot.items.end(), [&](const auto& item) {
            return item.id == purgeBlockToken;
        }))
        return fail("removed note blocks should appear as individually recoverable Trash items");
    if (auto status = service.restore(archivePath, {}, archive::RecordType::Settings,
                                      restoreBlockToken); !status)
        return fail(status.error().message);
    snapshot = service.snapshot(archivePath, {});
    if (!snapshot.errorMessage.empty() ||
        std::any_of(snapshot.items.begin(), snapshot.items.end(), [&](const auto& item) {
            return item.id == restoreBlockToken;
        }) ||
        std::none_of(snapshot.items.begin(), snapshot.items.end(), [&](const auto& item) {
            return item.id == purgeBlockToken;
        }))
        return fail("restoring a note block should remove only that block from Trash");
    {
        auto opened = archive::Archive::open(archivePath, false);
        if (!opened)
            return fail(opened.error().message);
        auto stored = opened->get(archive::RecordType::Settings, notesDocumentId);
        if (!stored || !*stored)
            return fail("restored note block document is missing");
        auto notes = domain::journalNotesDocumentFromRecord(**stored);
        if (!notes || notes->blocks.size() != 1 ||
            notes->blocks.front().id != archive::uuidToString(noteBlockRestoreId) ||
            notes->blocks.front().text != "Restore this observation" ||
            domain::getField(**stored, "removed_block_count") != "1")
            return fail("restoring a note block did not preserve its content or the remaining recovery item");
    }

    // A recording take is one Trash item. Its tracks and chunks move with it,
    // and the active session stops referencing the removed track until Undo.
    {
        auto opened = archive::Archive::open(archivePath, true);
        if (!opened)
            return fail(opened.error().message);
        auto activeTake = opened->get(archive::RecordType::AssetMetadata, takeId);
        if (!activeTake || !*activeTake)
            return fail("restored take is missing");
        if (auto status = audio::setRecordingTakeDeleted(*opened, takeId, true); !status)
            return fail(status.error().message);
        auto currentSession = opened->get(archive::RecordType::Session, sessionId);
        if (!currentSession || !*currentSession ||
            domain::getField(**currentSession, "recording_track_ids").find(archive::uuidToString(trackId)) != std::string::npos)
            return fail("taking audio out of Trash left a live session track reference");
    }
    snapshot = service.snapshot(archivePath, {});
    if (!snapshot.errorMessage.empty())
        return fail(snapshot.errorMessage);
    if (std::none_of(snapshot.items.begin(), snapshot.items.end(), [&](const auto& item) {
            return item.id == archive::uuidToString(takeId) && item.typeLabel == "Recording take";
        }))
        return fail("Trash does not show the deleted recording take");
    if (auto status = service.restore(archivePath, {}, archive::RecordType::AssetMetadata,
                                     archive::uuidToString(takeId)); !status)
        return fail(status.error().message);
    {
        auto opened = archive::Archive::open(archivePath, false);
        if (!opened)
            return fail(opened.error().message);
        auto currentSession = opened->get(archive::RecordType::Session, sessionId);
        auto currentTrack = opened->get(archive::RecordType::AssetMetadata, trackId);
        auto chunks = opened->list(archive::RecordType::AudioChunk, true);
        if (!currentSession || !*currentSession ||
            domain::getField(**currentSession, "recording_track_ids") != archive::uuidToString(trackId) ||
            !currentTrack || !*currentTrack || domain::isDeleted(**currentTrack) ||
            !chunks || chunks->empty() || domain::isDeleted(chunks->front()))
            return fail("take restore did not recover its selected track and session relation");
    }

    // A deleted guide is restored together with its journal-entry relation.
    {
        auto opened = archive::Archive::open(archivePath, true);
        if (!opened)
            return fail(opened.error().message);
        auto guide = record(archive::RecordType::Guide, guideId,
                            {{"title", "Deleted guide"},
                             {"entry_id", archive::uuidToString(entryId)},
                             {"section_count", "0"},
                             {"_deleted", "true"},
                             {"_trash_group_id", archive::uuidToString(guideId)}});
        auto entry = opened->get(archive::RecordType::Settings, entryId);
        if (!entry || !*entry)
            return fail("journal entry for guide restore is missing");
        (**entry).fields["study_guide_ids"] = "";
        (**entry).fields["_trash_restore_guide_refs"] = archive::uuidToString(guideId);
        (**entry).fields["_trash_guide_group_id"] = archive::uuidToString(guideId);
        if (auto status = opened->putMany({std::move(guide), std::move(**entry)}); !status)
            return fail(status.error().message);
    }
    if (auto status = service.restore(archivePath, {}, archive::RecordType::Guide,
                                     archive::uuidToString(guideId)); !status)
        return fail(status.error().message);
    {
        auto opened = archive::Archive::open(archivePath, false);
        if (!opened)
            return fail(opened.error().message);
        auto restoredGuide = opened->get(archive::RecordType::Guide, guideId);
        auto restoredEntry = opened->get(archive::RecordType::Settings, entryId);
        if (!restoredGuide || !*restoredGuide || domain::isDeleted(**restoredGuide) ||
            !restoredEntry || !*restoredEntry ||
            domain::getField(**restoredEntry, "study_guide_ids") != archive::uuidToString(guideId))
            return fail("guide restore did not reattach its journal relationship");
    }

    // Evidence relationships deleted with a node restore as one recoverable unit.
    {
        auto opened = archive::Archive::open(archivePath, true);
        if (!opened)
            return fail(opened.error().message);
        const std::string sessionText = archive::uuidToString(sessionId);
        const std::string evidenceText = archive::uuidToString(evidenceId);
        const std::string peerText = archive::uuidToString(evidencePeerId);
        auto evidence = record(archive::RecordType::EvidenceNode, evidenceId,
                               {{"session_id", sessionText}, {"title", "Deleted evidence"},
                                {"content", "Observation"}, {"_deleted", "true"},
                                {"_trash_group_id", evidenceText}});
        auto edge = record(archive::RecordType::EvidenceEdge, evidenceEdgeId,
                           {{"from_id", evidenceText}, {"to_id", peerText},
                            {"relationship", "supports"}, {"_deleted", "true"},
                            {"_trash_group_id", evidenceText}});
        auto peer = record(archive::RecordType::EvidenceNode, evidencePeerId,
                           {{"session_id", sessionText}, {"title", "Peer evidence"},
                            {"content", "Related"}});
        if (auto status = opened->putMany({std::move(evidence), std::move(edge), std::move(peer)}); !status)
            return fail(status.error().message);
    }
    if (auto status = service.restore(archivePath, {}, archive::RecordType::EvidenceNode,
                                     archive::uuidToString(evidenceId)); !status)
        return fail(status.error().message);
    {
        auto opened = archive::Archive::open(archivePath, false);
        if (!opened)
            return fail(opened.error().message);
        auto restoredEdge = opened->get(archive::RecordType::EvidenceEdge, evidenceEdgeId);
        auto restoredEvidence = opened->get(archive::RecordType::EvidenceNode, evidenceId);
        if (!restoredEvidence || !*restoredEvidence || domain::isDeleted(**restoredEvidence) ||
            !restoredEdge || !*restoredEdge || domain::isDeleted(**restoredEdge))
            return fail("restoring evidence did not restore its grouped relationship");
    }

    auto blockedPurge = service.purge(archivePath, {});
    if (blockedPurge || blockedPurge.error().code != "trash_purge_reference_blocked")
        return fail("permanent purge did not protect a trashed student referenced by a live session");
    if (auto status = service.restore(archivePath, {}, archive::RecordType::Student,
                                     archive::uuidToString(studentId)); !status)
        return fail(status.error().message);
    {
        auto opened = archive::Archive::open(archivePath, true);
        if (!opened)
            return fail(opened.error().message);
        if (auto status = opened->compact(); !status)
            return fail(status.error().message);
    }
    snapshot = service.snapshot(archivePath, {});
    if (!snapshot.errorMessage.empty() ||
        std::none_of(snapshot.items.begin(), snapshot.items.end(), [&](const auto& item) {
            return item.id == archive::uuidToString(purgeMarkerId);
        }))
        return fail("ordinary archive compaction should preserve recoverable Trash records");
    if (auto status = service.purge(archivePath, {}); !status)
        return fail(status.error().message);
    {
        auto opened = archive::Archive::open(archivePath, false);
        if (!opened)
            return fail(opened.error().message);
        auto purged = opened->get(archive::RecordType::Annotation, purgeMarkerId);
        if (!purged || *purged)
            return fail("permanent purge did not remove the trashed marker");
        auto notes = opened->get(archive::RecordType::Settings, notesDocumentId);
        if (!notes || !*notes || domain::getField(**notes, "removed_block_count") != "0" ||
            !domain::getField(**notes, "last_removed_block_id").empty())
            return fail("permanent Trash purge did not clear unrecovered note blocks");
    }
    return 0;
}
