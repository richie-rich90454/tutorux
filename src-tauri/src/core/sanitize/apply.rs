use std::collections::BTreeSet;

use crate::core::archive::is_sensitive_setting_key;
use crate::core::format::{ArchiveRecord, RecordType};

use super::plan::NormalizedOptions;
use super::types::{field, lower, parse_uuid, split_ids, SanitizedCopyPlan};

pub(crate) fn sanitize_record(
    source: &ArchiveRecord,
    plan: &SanitizedCopyPlan,
    options: &NormalizedOptions,
    source_manifest_id: &str,
) -> ArchiveRecord {
    let mut record = source.clone();
    record.revision = 1;
    record.previous_offset = 0;
    if record.record_type == RecordType::SETTINGS && record.id.to_lowercase() == source_manifest_id
    {
        return record;
    }
    if record.record_type == RecordType::SESSION {
        let tracks = plan
            .recording_tracks_by_session
            .get(&record.id.to_lowercase());
        match tracks {
            None => {
                record
                    .fields
                    .insert("session_type".to_owned(), "notes-only".to_owned());
                record
                    .fields
                    .insert("recording_state".to_owned(), "not-started".to_owned());
                let keys: Vec<String> = record.fields.keys().cloned().collect();
                for name in keys {
                    if name.starts_with("recording_") || name.starts_with("audio_import_") {
                        record.fields.remove(&name);
                    }
                }
            }
            Some(tracks) if tracks.is_empty() => {
                record
                    .fields
                    .insert("session_type".to_owned(), "notes-only".to_owned());
                record
                    .fields
                    .insert("recording_state".to_owned(), "not-started".to_owned());
                let keys: Vec<String> = record.fields.keys().cloned().collect();
                for name in keys {
                    if name.starts_with("recording_") || name.starts_with("audio_import_") {
                        record.fields.remove(&name);
                    }
                }
            }
            Some(tracks) => {
                prune_list_field(&mut record.fields, "recording_track_ids", tracks);
                let primary_track = field(&record, "recording_track_id");
                if !primary_track.is_empty() && !has_id(tracks, &primary_track) {
                    record
                        .fields
                        .insert("recording_track_id".to_owned(), String::new());
                }
                let imported_track = field(&record, "audio_import_track_id");
                if !imported_track.is_empty() && !has_id(tracks, &imported_track) {
                    let keys: Vec<String> = record.fields.keys().cloned().collect();
                    for name in keys {
                        if name.starts_with("audio_import_") {
                            record.fields.remove(&name);
                        }
                    }
                }
                record
                    .fields
                    .insert("recording_track_count".to_owned(), tracks.len().to_string());
                record.fields.insert(
                    "recording_audio_chunks".to_owned(),
                    plan.recording_chunks_by_session
                        .get(&record.id.to_lowercase())
                        .copied()
                        .unwrap_or(0)
                        .to_string(),
                );
                if let Some(source_tracks) = plan
                    .source_recording_tracks_by_session
                    .get(&record.id.to_lowercase())
                {
                    if source_tracks.len() > tracks.len() {
                        for name in [
                            "recording_source",
                            "recording_device_id",
                            "recording_durability",
                            "recording_sample_format",
                            "recording_sample_rate_hz",
                            "recording_channel_count",
                            "recording_channel_mask",
                            "recording_samples",
                            "recording_timeline_samples",
                            "recording_bytes",
                            "recording_discontinuities",
                            "recording_duration_us",
                        ] {
                            record.fields.remove(name);
                        }
                    }
                }
            }
        }
        let student_id = parse_uuid(&field(&record, "student_id"));
        if student_id
            .as_ref()
            .map(|id| !plan.kept(RecordType::STUDENT).contains(id))
            .unwrap_or(false)
        {
            record
                .fields
                .insert("student_id".to_owned(), "anonymous".to_owned());
        }
        for name in ["entry_id", "notes_document_id"] {
            let id = field(&record, name);
            if !id.is_empty() && !plan.has_kept(RecordType::SETTINGS, &id) {
                record.fields.insert(name.to_owned(), String::new());
            }
        }
    }
    if record.record_type == RecordType::TRANSCRIPT_SEGMENT {
        prune_list_field(
            &mut record.fields,
            "linked_asset_ids",
            plan.kept(RecordType::ASSET_METADATA),
        );
    }
    if record.record_type == RecordType::ANNOTATION {
        prune_list_field(
            &mut record.fields,
            "linked_asset_ids",
            plan.kept(RecordType::ASSET_METADATA),
        );
        prune_list_field(
            &mut record.fields,
            "linked_evidence_ids",
            plan.kept(RecordType::EVIDENCE_NODE),
        );
    }
    if record.record_type == RecordType::EVIDENCE_NODE {
        prune_list_field(
            &mut record.fields,
            "source_segment_ids",
            plan.kept(RecordType::TRANSCRIPT_SEGMENT),
        );
        prune_list_field(
            &mut record.fields,
            "source_asset_ids",
            plan.kept(RecordType::ASSET_METADATA),
        );
    }
    if record.record_type == RecordType::SETTINGS
        && lower(&field(&record, "record_role")) == "journal-entry"
    {
        prune_list_field(
            &mut record.fields,
            "session_ids",
            plan.kept(RecordType::SESSION),
        );
        prune_list_field(
            &mut record.fields,
            "study_guide_ids",
            plan.kept(RecordType::GUIDE),
        );
        prune_list_field(
            &mut record.fields,
            "attachment_ids",
            plan.kept(RecordType::ASSET_METADATA),
        );
        let notes_id = field(&record, "notes_document_id");
        if !notes_id.is_empty() && !plan.has_kept(RecordType::SETTINGS, &notes_id) {
            record
                .fields
                .insert("notes_document_id".to_owned(), String::new());
        }
    }
    if record.record_type == RecordType::GUIDE {
        record.fields.remove("source_index_history");
        record.fields.remove("stale_source_id");
        record.fields.remove("stale_source_ids");
        let entry_id = field(&record, "entry_id");
        if !entry_id.is_empty() && !plan.has_kept(RecordType::SETTINGS, &entry_id) {
            record.fields.insert("entry_id".to_owned(), String::new());
        }
    }
    if record.record_type == RecordType::SETTINGS && !options.include_credentials {
        let keys: Vec<String> = record.fields.keys().cloned().collect();
        for name in keys {
            if is_sensitive_setting_key(&name) {
                record.fields.remove(&name);
            }
        }
    }
    record
}

fn prune_list_field(
    fields: &mut std::collections::BTreeMap<String, String>,
    name: &str,
    valid: &BTreeSet<String>,
) {
    let Some(value) = fields.get(name).cloned() else {
        return;
    };
    let value = split_ids(&value)
        .into_iter()
        .filter(|id| {
            parse_uuid(id)
                .map(|id| valid.contains(&id))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>()
        .join(",");
    fields.insert(name.to_owned(), value);
}

fn has_id(ids: &BTreeSet<String>, raw_id: &str) -> bool {
    parse_uuid(raw_id)
        .map(|id| ids.contains(&id))
        .unwrap_or(false)
}
