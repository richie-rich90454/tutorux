#include "tutorux/audio/recording_take.hpp"

#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <charconv>
#include <cctype>
#include <chrono>
#include <cstddef>
#include <iterator>
#include <set>
#include <string_view>

namespace tutorux::audio {
namespace {

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::system_clock::now().time_since_epoch())
                .count());
    }

    std::uint64_t unsignedField(const archive::Record& record, std::string_view name) {
        const std::string value = domain::getField(record, name);
        std::uint64_t parsed = 0;
        const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), parsed);
        return error == std::errc{} && end == value.data() + value.size() ? parsed : 0;
    }

    std::vector<std::string> splitIds(std::string_view value) {
        std::vector<std::string> ids;
        for (std::size_t start = 0; start < value.size();) {
            const auto comma = value.find(',', start);
            const auto end = comma == std::string_view::npos ? value.size() : comma;
            const auto id = value.substr(start, end - start);
            if (!id.empty())
                ids.emplace_back(id);
            start = comma == std::string_view::npos ? value.size() : comma + 1;
        }
        return ids;
    }

    std::string joinIds(const std::vector<std::string>& ids) {
        std::string result;
        for (const auto& id : ids) {
            if (!result.empty())
                result.push_back(',');
            result += id;
        }
        return result;
    }

    RecordingTake takeFromRecord(const archive::Record& record) {
        RecordingTake take;
        take.id = archive::uuidToString(record.id);
        take.sessionId = domain::getField(record, "session_id");
        take.label = domain::getField(record, "label", "Recording");
        take.source = domain::getField(record, "source");
        take.state = domain::getField(record, "state", "unknown");
        take.startedAtUs = unsignedField(record, "started_at_us");
        take.endedAtUs = unsignedField(record, "ended_at_us");
        take.durationUs = unsignedField(record, "duration_us");
        take.trackIds = splitIds(domain::getField(record, "track_ids"));
        return take;
    }

} // namespace

archive::Record makeRecordingTakeRecord(const archive::Uuid& takeId,
                                        const archive::Uuid& sessionId,
                                        std::string source,
                                        std::string state,
                                        const std::vector<archive::Uuid>& trackIds,
                                        std::uint64_t startedAtUs) {
    std::vector<std::string> encodedIds;
    encodedIds.reserve(trackIds.size());
    for (const auto& id : trackIds)
        encodedIds.push_back(archive::uuidToString(id));

    archive::Record record;
    record.type = archive::RecordType::AssetMetadata;
    record.id = takeId;
    record.fields = {
        {"record_role", "recording-take"},
        {"session_id", archive::uuidToString(sessionId)},
        {"label", "Recording"},
        {"source", std::move(source)},
        {"state", std::move(state)},
        {"track_ids", joinIds(encodedIds)},
        {"started_at_us", std::to_string(startedAtUs)},
        {"ended_at_us", "0"},
        {"duration_us", "0"},
        {"created_at_us", std::to_string(startedAtUs)},
        {"updated_at_us", std::to_string(startedAtUs)},
    };
    return record;
}

bool containsId(const std::vector<std::string>& ids, std::string_view id) {
    return std::find(ids.begin(), ids.end(), id) != ids.end();
}

std::vector<std::string> withoutIds(const std::vector<std::string>& ids,
                                    const std::vector<std::string>& removed) {
    std::vector<std::string> result;
    for (const auto& id : ids) {
        if (!containsId(removed, id))
            result.push_back(id);
    }
    return result;
}

core::Status updateRecordingTake(archive::Archive& archive,
                                 const archive::Uuid& takeId,
                                 std::string state,
                                 std::uint64_t durationUs,
                                 std::uint64_t endedAtUs) {
    auto loaded = archive.get(archive::RecordType::AssetMetadata, takeId);
    if (!loaded)
        return std::unexpected(loaded.error());
    if (!*loaded || domain::isDeleted(**loaded) ||
        domain::getField(**loaded, "record_role") != "recording-take") {
        return std::unexpected(core::error("recording_take_not_found",
                                           "Recording take metadata is missing."));
    }
    auto record = std::move(**loaded);
    record.fields["state"] = std::move(state);
    record.fields["duration_us"] = std::to_string(durationUs);
    const std::string_view currentState = record.fields["state"];
    const bool active = currentState == "initializing" || currentState == "multi-track-initializing" ||
                        currentState == "recording" || currentState == "paused" ||
                        currentState == "finalizing";
    record.fields["ended_at_us"] = active ? "0" :
        std::to_string(endedAtUs == 0 ? nowUnixMicroseconds() : endedAtUs);
    record.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
    return archive.put(std::move(record));
}

core::Status renameRecordingTake(archive::Archive& archive, const archive::Uuid& takeId,
                                 std::string label) {
    while (!label.empty() && std::isspace(static_cast<unsigned char>(label.front())) != 0)
        label.erase(label.begin());
    while (!label.empty() && std::isspace(static_cast<unsigned char>(label.back())) != 0)
        label.pop_back();
    if (label.empty() || label.size() > 120 ||
        label.find_first_of("\r\n") != std::string::npos ||
        label.find('\0') != std::string::npos) {
        return std::unexpected(core::error(
            "recording_take_label_invalid",
            "Take names must contain 1–120 characters on one line."));
    }
    auto loaded = archive.get(archive::RecordType::AssetMetadata, takeId);
    if (!loaded)
        return std::unexpected(loaded.error());
    if (!*loaded || domain::isDeleted(**loaded) ||
        domain::getField(**loaded, "record_role") != "recording-take") {
        return std::unexpected(core::error("recording_take_not_found",
                                           "Recording take metadata is missing."));
    }
    auto record = std::move(**loaded);
    record.fields["label"] = std::move(label);
    record.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
    return archive.put(std::move(record));
}

core::Status renameRecordingTrack(archive::Archive& archive, const archive::Uuid& trackId,
                                  std::string label) {
    while (!label.empty() && std::isspace(static_cast<unsigned char>(label.front())) != 0)
        label.erase(label.begin());
    while (!label.empty() && std::isspace(static_cast<unsigned char>(label.back())) != 0)
        label.pop_back();
    if (label.empty() || label.size() > 120 || label.find_first_of("\r\n") != std::string::npos ||
        label.find('\0') != std::string::npos) {
        return std::unexpected(core::error(
            "recording_track_label_invalid", "Track names must contain 1–120 characters on one line."));
    }
    auto loaded = archive.get(archive::RecordType::AssetMetadata, trackId);
    if (!loaded)
        return std::unexpected(loaded.error());
    if (!*loaded || domain::isDeleted(**loaded) ||
        domain::getField(**loaded, "record_role") != "audio-track" ||
        domain::getField(**loaded, "recording_take_id").empty()) {
        return std::unexpected(core::error(
            "recording_track_not_found", "Select a saved track from a recording take."));
    }
    auto record = std::move(**loaded);
    record.fields["label"] = std::move(label);
    record.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
    return archive.put(std::move(record));
}

core::Status setRecordingTrackDeleted(archive::Archive& archive,
                                      const archive::Uuid& trackId,
                                      bool deleted) {
    auto loadedTrack = archive.get(archive::RecordType::AssetMetadata, trackId);
    if (!loadedTrack)
        return std::unexpected(loadedTrack.error());
    if (!*loadedTrack || domain::getField(**loadedTrack, "record_role") != "audio-track") {
        return std::unexpected(core::error("recording_track_not_found", "The recording track is unavailable."));
    }
    if (domain::isDeleted(**loadedTrack) == deleted) {
        return std::unexpected(core::error(
            deleted ? "recording_track_already_deleted" : "recording_track_not_deleted",
            deleted ? "The track is already in Trash." : "The track is not in Trash."));
    }
    auto track = std::move(**loadedTrack);
    const auto sessionText = domain::getField(track, "session_id");
    const auto takeText = domain::getField(track, "recording_take_id");
    const auto trackText = archive::uuidToString(trackId);
    auto sessionId = archive::uuidFromString(sessionText);
    auto takeId = archive::uuidFromString(takeText);
    if (!sessionId || !takeId || takeText.empty()) {
        return std::unexpected(core::error(
            "recording_track_link_invalid", "This track is not linked to a restorable recording take."));
    }
    auto loadedTake = archive.get(archive::RecordType::AssetMetadata, *takeId);
    if (!loadedTake)
        return std::unexpected(loadedTake.error());
    if (!*loadedTake || domain::isDeleted(**loadedTake) ||
        domain::getField(**loadedTake, "record_role") != "recording-take" ||
        domain::getField(**loadedTake, "session_id") != sessionText) {
        return std::unexpected(core::error(
            "recording_track_take_missing", "Restore the parent take before restoring or removing this track."));
    }
    auto take = std::move(**loadedTake);
    auto linkedTracks = splitIds(domain::getField(take, "track_ids"));
    if (deleted && !containsId(linkedTracks, trackText)) {
        return std::unexpected(core::error(
            "recording_track_link_invalid", "The selected track is not linked to its recording take."));
    }
    auto loadedSession = archive.get(archive::RecordType::Session, *sessionId);
    if (!loadedSession)
        return std::unexpected(loadedSession.error());
    if (!*loadedSession || domain::isDeleted(**loadedSession)) {
        return std::unexpected(core::error("session_not_found", "The parent session is unavailable."));
    }
    auto session = std::move(**loadedSession);
    auto sessionTracks = splitIds(domain::getField(session, "recording_track_ids"));
    std::vector<archive::Record> transaction;
    const auto now = std::to_string(nowUnixMicroseconds());

    if (deleted) {
        const auto takePosition = std::find(linkedTracks.begin(), linkedTracks.end(), trackText);
        const auto sessionPosition = std::find(sessionTracks.begin(), sessionTracks.end(), trackText);
        track.fields["_trash_restore_take_track_index"] = std::to_string(
            static_cast<std::size_t>(std::distance(linkedTracks.begin(), takePosition)));
        track.fields["_trash_restore_session_track_index"] = std::to_string(
            static_cast<std::size_t>(std::distance(sessionTracks.begin(), sessionPosition)));
        linkedTracks.erase(std::remove(linkedTracks.begin(), linkedTracks.end(), trackText),
                           linkedTracks.end());
        sessionTracks.erase(std::remove(sessionTracks.begin(), sessionTracks.end(), trackText),
                            sessionTracks.end());
        take.fields["track_ids"] = joinIds(linkedTracks);
        if (domain::getField(session, "recording_track_id") == trackText) {
            track.fields["_trash_restore_was_primary"] = "true";
            if (!sessionTracks.empty()) {
                session.fields["recording_track_id"] = sessionTracks.front();
                track.fields["_trash_restore_fallback_primary_id"] = sessionTracks.front();
            } else {
                session.fields.erase("recording_track_id");
                track.fields.erase("_trash_restore_fallback_primary_id");
            }
        }
        track.fields["_deleted"] = "true";
        track.fields["_trash_group_id"] = trackText;
        track.fields["deleted_at_us"] = now;
    } else {
        if (containsId(linkedTracks, trackText)) {
            return std::unexpected(core::error(
                "recording_track_restore_conflict", "This track is already linked to its take."));
        }
        const auto savedPosition = [](const archive::Record& record, std::string_view key,
                                      std::size_t fallback) {
            const auto found = record.fields.find(key);
            if (found == record.fields.end())
                return fallback;
            std::uint64_t parsed = 0;
            const auto [end, error] = std::from_chars(found->second.data(),
                                                       found->second.data() + found->second.size(),
                                                       parsed);
            if (error != std::errc{} || end != found->second.data() + found->second.size())
                return fallback;
            return static_cast<std::size_t>(std::min<std::uint64_t>(parsed, fallback));
        };
        const auto takePosition = savedPosition(track, "_trash_restore_take_track_index",
                                                linkedTracks.size());
        linkedTracks.insert(linkedTracks.begin() + static_cast<std::ptrdiff_t>(takePosition),
                            trackText);
        sessionTracks.erase(std::remove(sessionTracks.begin(), sessionTracks.end(), trackText),
                            sessionTracks.end());
        const auto sessionPosition = savedPosition(track, "_trash_restore_session_track_index",
                                                   sessionTracks.size());
        sessionTracks.insert(sessionTracks.begin() + static_cast<std::ptrdiff_t>(sessionPosition),
                             trackText);
        take.fields["track_ids"] = joinIds(linkedTracks);
        const auto currentPrimary = domain::getField(session, "recording_track_id");
        const auto fallbackPrimary = domain::getField(track, "_trash_restore_fallback_primary_id");
        const bool wasPrimary = domain::getField(track, "_trash_restore_was_primary") == "true";
        if (wasPrimary && (currentPrimary.empty() ||
                           (!fallbackPrimary.empty() && currentPrimary == fallbackPrimary))) {
            session.fields["recording_track_id"] = trackText;
        }
        track.fields.erase("_trash_restore_was_primary");
        track.fields.erase("_trash_restore_fallback_primary_id");
        track.fields.erase("_trash_restore_take_track_index");
        track.fields.erase("_trash_restore_session_track_index");
        track.fields.erase("_deleted");
        track.fields.erase("_trash_group_id");
        track.fields.erase("deleted_at_us");
        track.fields["restored_at_us"] = now;
    }

    take.fields["updated_at_us"] = now;
    session.fields["recording_track_ids"] = joinIds(sessionTracks);
    session.fields["updated_at_us"] = now;
    track.fields["updated_at_us"] = now;
    transaction.push_back(std::move(take));
    transaction.push_back(std::move(session));
    transaction.push_back(std::move(track));

    for (const auto type : {archive::RecordType::AudioChunk,
                            archive::RecordType::WaveformIndex}) {
        auto children = archive.list(type, true);
        if (!children)
            return std::unexpected(children.error());
        for (auto& child : *children) {
            if (domain::getField(child, "session_id") != sessionText ||
                domain::getField(child, "track_id") != trackText ||
                domain::isDeleted(child) == deleted)
                continue;
            if (deleted) {
                child.fields["_deleted"] = "true";
                child.fields["_trash_group_id"] = trackText;
                child.fields["deleted_at_us"] = now;
            } else {
                child.fields.erase("_deleted");
                child.fields.erase("_trash_group_id");
                child.fields.erase("deleted_at_us");
                child.fields["restored_at_us"] = now;
            }
            child.fields["updated_at_us"] = now;
            transaction.push_back(std::move(child));
        }
    }
    return archive.putMany(std::move(transaction));
}

core::Status setRecordingTakeDeleted(archive::Archive& archive, const archive::Uuid& takeId,
                                     bool deleted) {
    auto loaded = archive.get(archive::RecordType::AssetMetadata, takeId);
    if (!loaded)
        return std::unexpected(loaded.error());
    if (!*loaded || domain::getField(**loaded, "record_role") != "recording-take") {
        return std::unexpected(core::error("recording_take_not_found",
                                           "Recording take metadata is missing."));
    }
    if (domain::isDeleted(**loaded) == deleted) {
        return std::unexpected(core::error(
            deleted ? "recording_take_already_deleted" : "recording_take_not_deleted",
            deleted ? "Recording take is already in Trash." : "Recording take is not in Trash."));
    }
    auto record = std::move(**loaded);
    const auto sessionId = domain::getField(record, "session_id");
    const auto takeIdText = archive::uuidToString(takeId);
    const auto trackIds = splitIds(domain::getField(record, "track_ids"));
    std::vector<archive::Record> transaction;

    if (deleted)
        record.fields["_deleted"] = "true";
    else
        record.fields.erase("_deleted");
    if (deleted)
        record.fields["_trash_group_id"] = takeIdText;
    else
        record.fields.erase("_trash_group_id");
    record.fields[deleted ? "deleted_at_us" : "restored_at_us"] =
        std::to_string(nowUnixMicroseconds());
    record.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
    auto sessionUuid = archive::uuidFromString(sessionId);
    if (sessionUuid) {
        auto session = archive.get(archive::RecordType::Session, *sessionUuid);
        if (!session)
            return std::unexpected(session.error());
        if (*session && !domain::isDeleted(**session)) {
            auto updatedSession = std::move(**session);
            auto sessionTrackIds = splitIds(domain::getField(updatedSession, "recording_track_ids"));
            bool sessionChanged = false;
            if (deleted) {
                std::vector<std::string> removed;
                for (const auto& id : trackIds) {
                    if (containsId(sessionTrackIds, id))
                        removed.push_back(id);
                }
                if (!removed.empty()) {
                    // Store each take's restore scope on the take itself. Session-level
                    // restore keys are overwritten when users trash multiple takes before
                    // restoring any of them.
                    record.fields["_trash_restore_session_track_ids"] = joinIds(removed);
                    updatedSession.fields["recording_track_ids"] = joinIds(withoutIds(sessionTrackIds, removed));
                    sessionChanged = true;
                }
                const auto legacyTrackId = domain::getField(updatedSession, "recording_track_id");
                if (containsId(trackIds, legacyTrackId)) {
                    record.fields["_trash_restore_session_primary_track_id"] = legacyTrackId;
                    updatedSession.fields.erase("recording_track_id");
                    sessionChanged = true;
                }
            } else {
                auto restoreIds = splitIds(
                    domain::getField(record, "_trash_restore_session_track_ids"));
                bool usedLegacyRestoreIds = false;
                // Older archives stored this one-take scope on the session. Accept that
                // representation only when every referenced track belongs to this take.
                if (restoreIds.empty()) {
                    const auto legacyRestoreIds = splitIds(
                        domain::getField(updatedSession, "_trash_restore_track_ids"));
                    if (!legacyRestoreIds.empty() &&
                        std::all_of(legacyRestoreIds.begin(), legacyRestoreIds.end(),
                                    [&](const auto& id) { return containsId(trackIds, id); })) {
                        restoreIds = legacyRestoreIds;
                        usedLegacyRestoreIds = true;
                    }
                }
                if (!restoreIds.empty()) {
                    for (const auto& id : restoreIds) {
                        if (!containsId(trackIds, id))
                            return std::unexpected(core::error(
                                "recording_take_restore_scope_changed",
                                "The stored track restore scope no longer matches this take."));
                    }
                    for (const auto& id : restoreIds) {
                        if (!containsId(sessionTrackIds, id))
                            sessionTrackIds.push_back(id);
                    }
                    updatedSession.fields["recording_track_ids"] = joinIds(sessionTrackIds);
                    record.fields.erase("_trash_restore_session_track_ids");
                    if (usedLegacyRestoreIds)
                        updatedSession.fields.erase("_trash_restore_track_ids");
                    sessionChanged = true;
                }
                auto restoreLegacyId = domain::getField(
                    record, "_trash_restore_session_primary_track_id");
                bool usedLegacyPrimaryId = false;
                if (restoreLegacyId.empty()) {
                    const auto legacyRestoreId = domain::getField(
                        updatedSession, "_trash_restore_recording_track_id");
                    if (containsId(trackIds, legacyRestoreId)) {
                        restoreLegacyId = legacyRestoreId;
                        usedLegacyPrimaryId = true;
                    }
                }
                if (!restoreLegacyId.empty()) {
                    updatedSession.fields["recording_track_id"] = std::string(restoreLegacyId);
                    record.fields.erase("_trash_restore_session_primary_track_id");
                    if (usedLegacyPrimaryId)
                        updatedSession.fields.erase("_trash_restore_recording_track_id");
                    sessionChanged = true;
                }
            }
            if (sessionChanged) {
                updatedSession.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
                transaction.push_back(std::move(updatedSession));
            }
        }
    }

    transaction.push_back(std::move(record));

    const auto markChildren = [&](archive::RecordType type,
                                  std::string_view trackField) -> core::Status {
        auto records = archive.list(type, true);
        if (!records)
            return std::unexpected(records.error());
        for (auto& child : *records) {
            if (domain::getField(child, "session_id") != sessionId ||
                !containsId(trackIds, domain::getField(child, trackField)))
                continue;
            if (domain::isDeleted(child) != deleted)
                continue;
            if (deleted) {
                child.fields["_deleted"] = "true";
                child.fields["_trash_group_id"] = takeIdText;
                child.fields["deleted_at_us"] = std::to_string(nowUnixMicroseconds());
            } else {
                child.fields.erase("_deleted");
                child.fields.erase("_trash_group_id");
                child.fields.erase("deleted_at_us");
                child.fields["restored_at_us"] = std::to_string(nowUnixMicroseconds());
            }
            child.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
            transaction.push_back(std::move(child));
        }
        return {};
    };

    auto metadata = archive.list(archive::RecordType::AssetMetadata, true);
    if (!metadata)
        return std::unexpected(metadata.error());
    for (auto& track : *metadata) {
        if (domain::getField(track, "record_role") != "audio-track" ||
            domain::getField(track, "session_id") != sessionId ||
            !containsId(trackIds, domain::getField(track, "track_id")) ||
            domain::isDeleted(track) != deleted)
            continue;
        if (deleted) {
            track.fields["_deleted"] = "true";
            track.fields["_trash_group_id"] = takeIdText;
            track.fields["deleted_at_us"] = std::to_string(nowUnixMicroseconds());
        } else {
            track.fields.erase("_deleted");
            track.fields.erase("_trash_group_id");
            track.fields.erase("deleted_at_us");
            track.fields["restored_at_us"] = std::to_string(nowUnixMicroseconds());
        }
        track.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        transaction.push_back(std::move(track));
    }
    if (auto status = markChildren(archive::RecordType::AudioChunk, "track_id"); !status)
        return status;
    if (auto status = markChildren(archive::RecordType::WaveformIndex, "track_id"); !status)
        return status;
    return archive.putMany(std::move(transaction));
}

core::Result<std::vector<RecordingTake>> listRecordingTakes(
    archive::Archive& archive,
    const archive::Uuid& sessionId) {
    const std::string sessionText = archive::uuidToString(sessionId);
    auto metadata = archive.list(archive::RecordType::AssetMetadata, true);
    if (!metadata)
        return std::unexpected(metadata.error());

    std::vector<RecordingTake> takes;
    std::set<std::string, std::less<>> assignedTracks;
    for (const auto& record : *metadata) {
        if (domain::getField(record, "record_role") != "recording-take" ||
            domain::getField(record, "session_id") != sessionText) {
            continue;
        }
        auto take = takeFromRecord(record);
        assignedTracks.insert(take.trackIds.begin(), take.trackIds.end());
        if (domain::isDeleted(record))
            continue;
        takes.push_back(std::move(take));
    }

    // Collect legacy tracks and any newly linked tracks whose take record was
    // interrupted before it could be finalized. They remain visible and
    // recoverable instead of disappearing from the session.
    std::set<std::string, std::less<>> unassignedTracks;
    for (const auto& record : *metadata) {
        if (domain::isDeleted(record) || domain::getField(record, "record_role") != "audio-track" ||
            domain::getField(record, "session_id") != sessionText) {
            continue;
        }
        const std::string trackId = domain::getField(record, "track_id");
        if (!trackId.empty() && !assignedTracks.contains(trackId))
            unassignedTracks.insert(trackId);
    }

    auto session = archive.get(archive::RecordType::Session, sessionId);
    if (!session)
        return std::unexpected(session.error());
    if (*session && !domain::isDeleted(**session)) {
        const auto addUnassigned = [&](std::string_view id) {
            if (!id.empty() && !assignedTracks.contains(id))
                unassignedTracks.emplace(id);
        };
        for (const auto& id : splitIds(domain::getField(**session, "recording_track_ids")))
            addUnassigned(id);
        addUnassigned(domain::getField(**session, "recording_track_id"));
        addUnassigned(domain::getField(**session, "audio_import_track_id"));
    }

    if (!unassignedTracks.empty()) {
        RecordingTake legacy;
        legacy.id = "legacy-" + sessionText;
        legacy.sessionId = sessionText;
        legacy.label = "Earlier recording";
        legacy.source = "legacy";
        legacy.state = "completed";
        legacy.legacy = true;
        legacy.trackIds.assign(unassignedTracks.begin(), unassignedTracks.end());
        takes.push_back(std::move(legacy));
    }

    std::stable_sort(takes.begin(), takes.end(), [](const auto& left, const auto& right) {
        if (left.startedAtUs != right.startedAtUs)
            return left.startedAtUs < right.startedAtUs;
        return left.id < right.id;
    });
    for (std::size_t index = 0; index < takes.size(); ++index) {
        if (takes[index].legacy && takes.size() > 1)
            takes[index].label = "Earlier recording";
        else if (takes[index].legacy)
            takes[index].label = "Recording 1";
        if (!takes[index].legacy && takes[index].label == "Recording")
            takes[index].label += " " + std::to_string(index + 1);
    }
    return takes;
}

} // namespace tutorux::audio
