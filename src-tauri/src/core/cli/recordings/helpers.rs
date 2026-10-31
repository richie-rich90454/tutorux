use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{open_archive, CliContext, CliError, CliResult};
use crate::core::error::Result;
use crate::core::format::{ArchiveRecord, RecordType};

pub(super) fn open_unlocked(path: &std::path::Path, context: &CliContext) -> CliResult<ArchiveSnapshot> {
    let snapshot = open_archive(path, context.passphrase())?;
    if snapshot.locked() {
        return Err(CliError(
            "This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned(),
        )
        .into());
    }
    Ok(snapshot)
}

pub(super) fn require_session(snapshot: &ArchiveSnapshot, id: &str) -> CliResult<ArchiveRecord> {
    match snapshot.get_record(RecordType::SESSION, id)? {
        Some(record) if !record.deleted() => Ok(record),
        _ => Err(CliError("Session was not found in this archive.".to_owned()).into()),
    }
}

pub(super) fn should_change_trash_state(record: &ArchiveRecord, deleted: bool, group: &str) -> bool {
    let currently = record.field("_deleted") == Some("true");
    if deleted {
        !currently
    } else {
        currently
            && record
                .field("_trash_group_id")
                .map(|value| value.eq_ignore_ascii_case(group))
                .unwrap_or(false)
    }
}

pub(super) fn apply_recording_trash(
    record: &mut ArchiveRecord,
    deleted: bool,
    group: &str,
    timestamp: &str,
) {
    if deleted {
        record
            .fields
            .insert("_deleted".to_owned(), "true".to_owned());
        record
            .fields
            .insert("_trash_group_id".to_owned(), group.to_owned());
        record
            .fields
            .insert("deleted_at_us".to_owned(), timestamp.to_owned());
    } else {
        record.fields.remove("_deleted");
        record.fields.remove("_trash_group_id");
        record.fields.remove("deleted_at_us");
        record
            .fields
            .insert("restored_at_us".to_owned(), timestamp.to_owned());
    }
    record
        .fields
        .insert("updated_at_us".to_owned(), timestamp.to_owned());
}

pub(super) fn split_ids(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
        .collect()
}

pub(super) fn session_chunks(
    snapshot: &ArchiveSnapshot,
    session_id: &str,
    track_id: Option<&str>,
) -> Result<Vec<ArchiveRecord>> {
    let mut chunks: Vec<ArchiveRecord> = snapshot
        .list_records(RecordType::AUDIO_CHUNK, false)?
        .into_iter()
        .filter(|record| {
            record.field("session_id").map(str::to_lowercase)
                == Some(session_id.to_lowercase())
                && track_id
                    .map(|track| record.field("track_id").map(str::to_lowercase) == Some(track.to_lowercase()))
                    .unwrap_or(true)
        })
        .collect();
    chunks.sort_by(|left, right| {
        let left_sequence = left.field("sequence_number").unwrap_or("0").parse::<u64>().unwrap_or(0);
        let right_sequence = right.field("sequence_number").unwrap_or("0").parse::<u64>().unwrap_or(0);
        left_sequence.cmp(&right_sequence)
    });
    Ok(chunks)
}

pub(super) fn session_track_ids(snapshot: &ArchiveSnapshot, session: &ArchiveRecord) -> Vec<String> {
    let mut track_ids: Vec<String> = split_ids(session.field("recording_track_ids").unwrap_or(""));
    for id in split_ids(session.field("recording_track_id").unwrap_or("")) {
        if !track_ids.contains(&id) {
            track_ids.push(id);
        }
    }
    for id in split_ids(session.field("audio_import_track_id").unwrap_or("")) {
        if !track_ids.contains(&id) {
            track_ids.push(id);
        }
    }
    if let Ok(records) = snapshot.list_records(RecordType::ASSET_METADATA, false) {
        for record in records {
            if record.field("record_role") == Some("audio-track")
                && record.field("session_id").map(str::to_lowercase)
                    == Some(session.id.to_lowercase())
            {
                let id = record.id.to_lowercase();
                if !track_ids.contains(&id) {
                    track_ids.push(id);
                }
            }
        }
    }
    track_ids
}

pub(super) fn select_track(
    snapshot: &ArchiveSnapshot,
    session: &ArchiveRecord,
    requested: Option<&str>,
) -> CliResult<String> {
    let tracks = session_track_ids(snapshot, session);
    if let Some(requested) = requested {
        let requested = requested.to_lowercase();
        if tracks.iter().any(|track| track == &requested) {
            return Ok(requested);
        }
        return Err(CliError("Select an available audio track for this session.".to_owned()).into());
    }
    tracks
        .into_iter()
        .next()
        .ok_or_else(|| CliError("Select an available audio track for this session.".to_owned()).into())
}
