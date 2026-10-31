use std::collections::{BTreeMap, BTreeSet};

use crate::core::error::{err, CoreError, Result};
use crate::core::format::{ArchiveRecord, RecordType};
use crate::core::index::primary_index_key;

use super::support::valid_uuid;

#[derive(Debug, Clone, Copy)]
pub(crate) struct SecondaryIndexMigration {
    pub(crate) record_type: u16,
    pub(crate) prefix: &'static str,
    pub(crate) version_field: &'static str,
}

pub(crate) fn secondary_index_migrations() -> [SecondaryIndexMigration; 5] {
    [
        SecondaryIndexMigration {
            record_type: RecordType::ANNOTATION,
            prefix: "ANNOTATIONSESSION:",
            version_field: "annotation_session_time_index_version",
        },
        SecondaryIndexMigration {
            record_type: RecordType::SESSION,
            prefix: "STUDENTSESSION:",
            version_field: "student_session_index_version",
        },
        SecondaryIndexMigration {
            record_type: RecordType::EVIDENCE_EDGE,
            prefix: "EVIDENCEADJ:",
            version_field: "evidence_adjacency_index_version",
        },
        SecondaryIndexMigration {
            record_type: RecordType::TRANSCRIPT_SEGMENT,
            prefix: "TRANSCRIPTSESSION:",
            version_field: "transcript_session_index_version",
        },
        SecondaryIndexMigration {
            record_type: RecordType::AUDIO_CHUNK,
            prefix: "AUDIOSESSION:",
            version_field: "audio_chunk_index_version",
        },
    ]
}

pub fn is_secondary_index_prefix(key: &str) -> bool {
    super::support::SECONDARY_INDEX_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

fn is_guide_source_type(record_type: u16) -> bool {
    matches!(
        record_type,
        RecordType::STUDENT
            | RecordType::SESSION
            | RecordType::TRANSCRIPT_SEGMENT
            | RecordType::ANNOTATION
            | RecordType::ASSET_METADATA
            | RecordType::EVIDENCE_NODE
    )
}

pub fn is_guide_source_record(record: &ArchiveRecord) -> bool {
    is_guide_source_type(record.record_type)
        || (record.record_type == RecordType::SETTINGS
            && record.field("record_role") == Some("journal-notes"))
}

pub(crate) fn guide_cited_source_ids(record: &ArchiveRecord) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for (key, value) in &record.fields {
        if key.starts_with("section.") && key.ends_with(".source_ids") {
            for id in value.split(',') {
                let normalized = id.trim().to_lowercase();
                if valid_uuid(&normalized) {
                    ids.insert(normalized);
                }
            }
        }
    }
    ids
}

fn guide_source_ids(record: &ArchiveRecord) -> BTreeSet<String> {
    let mut ids = guide_cited_source_ids(record);
    for id in record
        .field("source_index_history")
        .unwrap_or("")
        .split(',')
    {
        let normalized = id.trim().to_lowercase();
        if valid_uuid(&normalized) {
            ids.insert(normalized);
        }
    }
    ids
}

pub(crate) fn preserve_guide_source_history(
    previous: &ArchiveRecord,
    current: &ArchiveRecord,
    index: &BTreeMap<String, u64>,
) -> ArchiveRecord {
    let mut history = guide_source_ids(previous);
    history.extend(guide_source_ids(current));
    let suffix = format!(":{}", current.id.to_lowercase());
    for alias in index.keys() {
        if !alias.starts_with("GUIDESOURCE:") || !alias.ends_with(&suffix) {
            continue;
        }
        let source_id = &alias["GUIDESOURCE:".len()..alias.len() - suffix.len()];
        if valid_uuid(source_id) {
            history.insert(source_id.to_owned());
        }
    }
    if history.is_empty() {
        return current.clone();
    }
    let value = history.into_iter().collect::<Vec<_>>().join(",");
    if current.field("source_index_history") == Some(value.as_str()) {
        return current.clone();
    }
    let mut updated = current.clone();
    updated
        .fields
        .insert("source_index_history".to_owned(), value);
    updated
}

pub(crate) fn mark_guide_blocks_stale(record: &ArchiveRecord, source_id: &str) -> ArchiveRecord {
    let mut fields = record.fields.clone();
    let mut changed = false;
    let keys: Vec<String> = fields.keys().cloned().collect();
    for key in keys {
        if !key.starts_with("section.") || !key.ends_with(".source_ids") {
            continue;
        }
        let value = fields[&key].clone();
        if !value
            .split(',')
            .any(|id| id.trim().to_lowercase() == source_id)
        {
            continue;
        }
        let stale_key = format!("{}{}", &key[..key.len() - "source_ids".len()], "stale");
        if fields.get(&stale_key).map(String::as_str) == Some("true") {
            continue;
        }
        fields.insert(stale_key, "true".to_owned());
        changed = true;
    }
    if !changed {
        return record.clone();
    }
    let stale_block_count = fields
        .iter()
        .filter(|(key, value)| {
            key.starts_with("section.") && key.ends_with(".stale") && value.as_str() == "true"
        })
        .count();
    fields.insert(
        "stale_sources_updated_at_us".to_owned(),
        super::support::now_us().to_string(),
    );
    fields.insert("stale_source_id".to_owned(), source_id.to_owned());
    fields.insert(
        "stale_block_count".to_owned(),
        stale_block_count.to_string(),
    );
    let mut updated = record.clone();
    updated.fields = fields;
    updated
}

pub(crate) fn audio_session_index_key(record: &ArchiveRecord) -> Result<Option<String>> {
    if record.record_type != RecordType::AUDIO_CHUNK {
        return Ok(None);
    }
    let session_id = record.field("session_id").unwrap_or("");
    let track_id = record.field("track_id").unwrap_or("");
    let sequence = record.field("sequence_number").unwrap_or("");
    if !valid_uuid(session_id)
        || !valid_uuid(track_id)
        || sequence.is_empty()
        || !sequence.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Ok(None);
    }
    let Ok(sequence_number) = sequence.parse::<u64>() else {
        return Ok(None);
    };
    Ok(Some(format!(
        "AUDIOSESSION:{}:{}:{:020}",
        session_id.to_lowercase(),
        track_id.to_lowercase(),
        sequence_number
    )))
}

fn guide_source_index_keys(record: &ArchiveRecord) -> Vec<String> {
    if record.record_type != RecordType::GUIDE {
        return Vec::new();
    }
    let mut keys = BTreeSet::new();
    let mut add_sources = |value: &str| {
        for source_id in value.split(',') {
            let normalized = source_id.trim().to_lowercase();
            if valid_uuid(&normalized) {
                keys.insert(format!(
                    "GUIDESOURCE:{}:{}",
                    normalized,
                    record.id.to_lowercase()
                ));
            }
        }
    };
    for (field, value) in &record.fields {
        if field.starts_with("section.") && field.ends_with(".source_ids") {
            add_sources(value);
        }
    }
    add_sources(record.field("source_index_history").unwrap_or(""));
    keys.into_iter().collect()
}

pub fn secondary_index_keys(record: &ArchiveRecord) -> Result<Vec<String>> {
    let mut keys = BTreeSet::new();
    let session_id = record.field("session_id").unwrap_or("");
    let add = |prefix: &str, id: &str, keys: &mut BTreeSet<String>| {
        if valid_uuid(id) {
            keys.insert(format!(
                "{}{}:{}",
                prefix,
                id.to_lowercase(),
                record.id.to_lowercase()
            ));
        }
    };
    if record.record_type == RecordType::ASSET_BLOB {
        if let Some(content_hash) = record.field("content_hash") {
            if content_hash.len() != 64
                || !content_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return err("asset_hash_invalid", "Asset blob content hash is invalid.");
            }
            keys.insert(format!("BLOB:{}", content_hash.to_lowercase()));
        }
    }
    if record.record_type == RecordType::ANNOTATION && valid_uuid(session_id) {
        let start_time = record.field("start_time_us").unwrap_or("");
        if !start_time.is_empty() && start_time.bytes().all(|byte| byte.is_ascii_digit()) {
            if let Ok(timestamp) = start_time.parse::<u64>() {
                if timestamp <= i64::MAX as u64 {
                    keys.insert(format!(
                        "ANNOTATIONSESSION:{}:{:020}:{}",
                        session_id.to_lowercase(),
                        timestamp,
                        record.id.to_lowercase()
                    ));
                }
            }
        }
    }
    if record.record_type == RecordType::SESSION {
        let student_id = record.field("student_id").unwrap_or("");
        if !student_id.is_empty() && student_id != "anonymous" {
            add("STUDENTSESSION:", student_id, &mut keys);
        }
    }
    if record.record_type == RecordType::TRANSCRIPT_SEGMENT {
        add("TRANSCRIPTSESSION:", session_id, &mut keys);
    }
    if record.record_type == RecordType::EVIDENCE_EDGE {
        add(
            "EVIDENCEADJ:",
            record.field("from_id").unwrap_or(""),
            &mut keys,
        );
        add(
            "EVIDENCEADJ:",
            record.field("to_id").unwrap_or(""),
            &mut keys,
        );
    }
    if record.record_type == RecordType::AUDIO_CHUNK {
        let key = audio_session_index_key(record)?.ok_or_else(|| {
            CoreError::new(
                "audio_chunk_metadata_invalid",
                "Audio chunks require valid session, track, and sequence identifiers.",
            )
        })?;
        keys.insert(key);
    }
    if record.record_type == RecordType::GUIDE {
        for key in guide_source_index_keys(record) {
            keys.insert(key);
        }
    }
    Ok(keys.into_iter().collect())
}

pub fn primary_key(record_type: u16, id: &str) -> String {
    primary_index_key(record_type, id)
}
