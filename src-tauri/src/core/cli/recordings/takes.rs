use std::collections::BTreeMap;

use serde_json::Value;

use crate::core::archive::now_us;
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{ArchiveRecord, RecordType};

use super::helpers::{
    apply_recording_trash, open_unlocked, require_session, should_change_trash_state, split_ids,
};

pub(super) fn take_list(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    require_session(&snapshot, &session_id)?;
    let mut records: Vec<ArchiveRecord> = snapshot
        .list_records(RecordType::ASSET_METADATA, args.flag("include-deleted"))?
        .into_iter()
        .filter(|record| record.field("record_role") == Some("recording-take"))
        .filter(|record| record.field("session_id").map(str::to_lowercase) == Some(session_id.clone()))
        .collect();
    records.sort_by(|left, right| left.id.cmp(&right.id));
    emit(
        output,
        Value::Array(records.iter().map(crate::core::cli::records::plain).collect()),
        &format!("{} recording take(s).", records.len()),
        args.json(),
    );
    Ok(0)
}

pub(super) fn take_rename(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    let take_id = args.required_option("take")?.to_lowercase();
    let label = args.required_option("label")?.to_owned();
    require_session(&snapshot, &session_id)?;
    let mut take = snapshot
        .get_record(RecordType::ASSET_METADATA, &take_id)?
        .ok_or_else(|| CliError("Recording take was not found.".to_owned()))?;
    if take.field("record_role") != Some("recording-take") || take.deleted() {
        return Err(CliError("Recording take was not found.".to_owned()).into());
    }
    take.fields.insert("label".to_owned(), label);
    take.fields.insert("updated_at_us".to_owned(), now_us().to_string());
    let next = snapshot.append_records(&[take])?;
    crate::core::cli::records::save_replacing(path, &next)?;
    let saved = next.get_record(RecordType::ASSET_METADATA, &take_id)?.unwrap();
    emit(
        output,
        Value::Array(vec![crate::core::cli::records::plain(&saved)]),
        "Recording take renamed.",
        args.json(),
    );
    Ok(0)
}

pub(super) fn set_take_deleted(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    let take_id = args.required_option("take")?.to_lowercase();
    let deleted = action == "take-delete";
    let mut session = require_session(&snapshot, &session_id)?;
    let mut take = snapshot
        .get_record(RecordType::ASSET_METADATA, &take_id)?
        .filter(|record| record.field("record_role") == Some("recording-take"))
        .ok_or_else(|| CliError("Recording take was not found.".to_owned()))?;
    let currently_deleted = take.deleted();
    if currently_deleted == deleted {
        return Err(CliError(if deleted {
            "This recording take is already in Trash."
        } else {
            "This recording take is not in Trash."
        }
        .to_owned())
        .into());
    }
    let track_ids = split_ids(take.field("track_ids").unwrap_or(""));
    if track_ids.is_empty() {
        return Err(CliError("This recording take has no linked audio tracks.".to_owned()).into());
    }
    let timestamp = now_us().to_string();
    let session_track_ids = split_ids(session.field("recording_track_ids").unwrap_or(""));
    let mut take_fields = take.fields.clone();
    let mut session_fields = session.fields.clone();
    if deleted {
        let affected: Vec<String> = track_ids
            .iter()
            .filter(|id| session_track_ids.contains(id))
            .cloned()
            .collect();
        if !affected.is_empty() {
            take_fields.insert(
                "_trash_restore_session_track_ids".to_owned(),
                affected.join(","),
            );
            session_fields.insert(
                "recording_track_ids".to_owned(),
                session_track_ids
                    .iter()
                    .filter(|id| !track_ids.contains(id))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        let primary = session_fields
            .get("recording_track_id")
            .map(|id| id.to_lowercase())
            .unwrap_or_default();
        if track_ids.contains(&primary) {
            take_fields.insert("_trash_restore_session_primary_track_id".to_owned(), primary);
            session_fields.remove("recording_track_id");
        }
        let imported = session_fields
            .get("audio_import_track_id")
            .map(|id| id.to_lowercase())
            .unwrap_or_default();
        if track_ids.contains(&imported) {
            take_fields.insert("_trash_restore_audio_import_track_id".to_owned(), imported);
            session_fields.remove("audio_import_track_id");
        }
    } else {
        let restore_ids = split_ids(
            take_fields
                .get("_trash_restore_session_track_ids")
                .map(String::as_str)
                .unwrap_or(""),
        );
        let mut restored_session_ids = session_track_ids.clone();
        for id in &restore_ids {
            if !restored_session_ids.contains(id) {
                restored_session_ids.push(id.clone());
            }
        }
        if !restore_ids.is_empty() {
            session_fields.insert(
                "recording_track_ids".to_owned(),
                restored_session_ids.join(","),
            );
        }
        if let Some(primary) = take_fields
            .get("_trash_restore_session_primary_track_id")
            .map(|id| id.to_lowercase())
        {
            if track_ids.contains(&primary) {
                session_fields.insert("recording_track_id".to_owned(), primary);
            }
            take_fields.remove("_trash_restore_session_primary_track_id");
        }
        if let Some(imported) = take_fields
            .get("_trash_restore_audio_import_track_id")
            .map(|id| id.to_lowercase())
        {
            if track_ids.contains(&imported) {
                session_fields.insert("audio_import_track_id".to_owned(), imported);
            }
            take_fields.remove("_trash_restore_audio_import_track_id");
        }
        take_fields.remove("_trash_restore_session_track_ids");
    }
    session_fields.insert(
        "recording_track_count".to_owned(),
        split_ids(
            session_fields
                .get("recording_track_ids")
                .map(String::as_str)
                .unwrap_or(""),
        )
        .len()
        .to_string(),
    );
    session_fields.insert("updated_at_us".to_owned(), timestamp.clone());
    if deleted {
        take_fields.insert("_deleted".to_owned(), "true".to_owned());
        take_fields.insert("_trash_group_id".to_owned(), take.id.clone());
        take_fields.insert("deleted_at_us".to_owned(), timestamp.clone());
    } else {
        take_fields.remove("_deleted");
        take_fields.remove("_trash_group_id");
        take_fields.remove("deleted_at_us");
        take_fields.insert("restored_at_us".to_owned(), timestamp.clone());
    }
    take_fields.insert("updated_at_us".to_owned(), timestamp.clone());
    let mut changes = Vec::new();
    session.fields = session_fields;
    changes.push(session);
    take.fields = take_fields;
    changes.push(take.clone());
    let mut visible_ids = vec![take.id.clone()];
    for record in snapshot.list_records(RecordType::ASSET_METADATA, true)? {
        if record.field("record_role") == Some("audio-track")
            && record.field("session_id").map(str::to_lowercase)
                == Some(session_id.clone())
            && track_ids.contains(
                &record
                    .field("track_id")
                    .unwrap_or(&record.id)
                    .to_lowercase(),
            )
        {
            if !should_change_trash_state(&record, deleted, &take_id) {
                continue;
            }
            let mut updated = record.clone();
            apply_recording_trash(&mut updated, deleted, &take_id, &timestamp);
            visible_ids.push(updated.id.clone());
            changes.push(updated);
        }
    }
    for track_id in &track_ids {
        for mut chunk in snapshot.list_records(RecordType::AUDIO_CHUNK, true)? {
            if chunk.field("track_id").map(str::to_lowercase).as_deref()
                == Some(track_id.as_str())
                && chunk.field("session_id").map(str::to_lowercase)
                    == Some(session_id.clone())
                && should_change_trash_state(&chunk, deleted, &take_id)
            {
                apply_recording_trash(&mut chunk, deleted, &take_id, &timestamp);
                changes.push(chunk);
            }
        }
    }
    let next = snapshot.append_records(&changes)?;
    crate::core::cli::records::save_replacing(path, &next)?;
    let mut visible_records: BTreeMap<String, ArchiveRecord> = BTreeMap::new();
    for record in next.list_records(RecordType::ASSET_METADATA, true)? {
        visible_records.insert(record.id.to_lowercase(), record);
    }
    let visible: Vec<Value> = visible_ids
        .iter()
        .filter_map(|id| visible_records.get(&id.to_lowercase()))
        .map(|record| crate::core::cli::records::plain(record))
        .collect();
    emit(
        output,
        Value::Array(visible),
        if deleted {
            "Recording take and its audio moved to Trash."
        } else {
            "Recording take and its audio restored."
        },
        args.json(),
    );
    Ok(0)
}

pub(super) fn track_rename(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    let track_id = args.required_option("track")?.to_lowercase();
    let label = args.required_option("label")?.to_owned();
    require_session(&snapshot, &session_id)?;
    let mut track = snapshot
        .get_record(RecordType::ASSET_METADATA, &track_id)?
        .filter(|record| {
            record.field("record_role") == Some("audio-track")
                && record.field("session_id").map(str::to_lowercase).as_deref()
                    == Some(session_id.as_str())
        })
        .ok_or_else(|| CliError("The selected track does not belong to this session.".to_owned()))?;
    track.fields.insert("label".to_owned(), label);
    track.fields.insert("updated_at_us".to_owned(), now_us().to_string());
    let next = snapshot.append_records(&[track])?;
    crate::core::cli::records::save_replacing(path, &next)?;
    let saved = next.get_record(RecordType::ASSET_METADATA, &track_id)?.unwrap();
    emit(
        output,
        Value::Array(vec![crate::core::cli::records::plain(&saved)]),
        "Recording track renamed.",
        args.json(),
    );
    Ok(0)
}
