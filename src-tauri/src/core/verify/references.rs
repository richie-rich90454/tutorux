use std::collections::BTreeMap;

use crate::core::archive::{valid_uuid, ArchiveRecord, ArchiveSnapshot, RecordType};
use crate::core::index::primary_index_key;

use super::assets::{asset_fields_match, collect_asset_content};
use super::guide::validate_guide_semantics;
use super::helpers::is_digits;
use super::VerificationLookup;

pub(crate) fn check_live_record_references(
    record: &ArchiveRecord,
    lookup: &VerificationLookup<'_>,
    live_by_key: &BTreeMap<String, ArchiveRecord>,
    issues: &mut Vec<String>,
) {
    if record.record_type == RecordType::SESSION {
        let student_id = record.field("student_id").unwrap_or("").to_lowercase();
        if !student_id.is_empty()
            && student_id != "anonymous"
            && (!valid_uuid(&student_id) || lookup.live(RecordType::STUDENT, &student_id).is_none())
        {
            issues.push(format!(
                "Session {} references a missing student.",
                record.id
            ));
        }
    } else if is_session_manifest_type(record.record_type) {
        check_session_reference(record, lookup, false, issues);
    }
    if record.record_type == RecordType::ASSET_BLOB
        && record.field("record_role") == Some("asset-blob-manifest")
    {
        let content = collect_asset_content(record, lookup);
        match content.issue {
            Some(issue) => issues.push(format!("Asset blob manifest {}: {issue}", record.id)),
            None => {
                if (record.field("content_hash").is_some() || record.field("byte_size").is_some())
                    && !asset_fields_match(record, &content.bytes)
                {
                    issues.push(format!(
                        "Asset blob manifest {} content does not match its hash.",
                        record.id
                    ));
                }
            }
        }
    }
    if record.record_type == RecordType::ASSET_METADATA {
        let role = record.field("record_role").unwrap_or("");
        if role != "audio-track" && role != "recording-take" {
            let blob_id = record.field("blob_id").unwrap_or("").to_lowercase();
            let blob = if valid_uuid(&blob_id) {
                lookup.live(RecordType::ASSET_BLOB, &blob_id)
            } else {
                None
            };
            let Some(blob) = blob else {
                issues.push(format!("Asset {} references a missing blob.", record.id));
                return;
            };
            let content = collect_asset_content(blob, lookup);
            match content.issue {
                Some(issue) => issues.push(format!("Asset {}: {issue}", record.id)),
                None => {
                    if !asset_fields_match(record, &content.bytes) {
                        issues.push(format!(
                            "Asset {} content is missing or does not match its hash.",
                            record.id
                        ));
                    }
                }
            }
        }
    }
    if record.record_type == RecordType::EVIDENCE_EDGE {
        for field in ["from_id", "to_id"] {
            let id = record.field(field).unwrap_or("").to_lowercase();
            if !valid_uuid(&id) || lookup.live(RecordType::EVIDENCE_NODE, &id).is_none() {
                issues.push(format!(
                    "Evidence edge {} references a missing node.",
                    record.id
                ));
            }
        }
    }
    if record.record_type == RecordType::GUIDE {
        for issue in validate_guide_semantics(record, lookup, live_by_key, true) {
            issues.push(format!("Guide {}: {issue}", record.id));
        }
    }
}

pub(crate) fn check_historical_references(
    record: &ArchiveRecord,
    lookup: &VerificationLookup<'_>,
    issues: &mut Vec<String>,
) {
    if record.record_type == RecordType::SESSION {
        let student_id = record.field("student_id").unwrap_or("").to_lowercase();
        if !student_id.is_empty()
            && student_id != "anonymous"
            && (!valid_uuid(&student_id) || lookup.get(RecordType::STUDENT, &student_id).is_none())
        {
            issues.push(format!(
                "Historical revision {} references a missing student.",
                record.id
            ));
        }
    } else if is_session_manifest_type(record.record_type) {
        check_session_reference(record, lookup, true, issues);
    }
    if record.record_type == RecordType::ASSET_METADATA {
        let blob_id = record.field("blob_id").unwrap_or("").to_lowercase();
        if !valid_uuid(&blob_id) || lookup.get(RecordType::ASSET_BLOB, &blob_id).is_none() {
            issues.push(format!(
                "Historical revision {} references a missing asset blob.",
                record.id
            ));
        }
    }
    if record.record_type == RecordType::ASSET_BLOB
        && record.field("record_role") == Some("asset-blob-manifest")
    {
        let content = collect_asset_content(record, lookup);
        if let Some(issue) = content.issue {
            issues.push(format!(
                "Historical asset blob manifest {}: {issue}",
                record.id
            ));
        }
    }
    if record.record_type == RecordType::EVIDENCE_EDGE {
        for field in ["from_id", "to_id"] {
            let id = record.field(field).unwrap_or("").to_lowercase();
            if !valid_uuid(&id) || lookup.get(RecordType::EVIDENCE_NODE, &id).is_none() {
                issues.push(format!(
                    "Historical revision {} references a missing evidence node.",
                    record.id
                ));
            }
        }
    }
    if record.record_type == RecordType::GUIDE {
        let empty_live: BTreeMap<String, ArchiveRecord> = BTreeMap::new();
        for issue in validate_guide_semantics(record, lookup, &empty_live, false) {
            issues.push(format!("Historical revision {}: {issue}", record.id));
        }
    }
}

fn check_session_reference(
    record: &ArchiveRecord,
    lookup: &VerificationLookup<'_>,
    historical: bool,
    issues: &mut Vec<String>,
) {
    let session_id = record.field("session_id").unwrap_or("");
    if session_id.is_empty() {
        return;
    }
    let normalized = session_id.to_lowercase();
    if !valid_uuid(&normalized) {
        issues.push(format!("Invalid session reference in {}.", record.id));
        return;
    }
    let found = if historical {
        lookup.get(RecordType::SESSION, &normalized).is_some()
    } else {
        lookup.live(RecordType::SESSION, &normalized).is_some()
    };
    if !found {
        issues.push(format!(
            "{} {} references a missing session {}.",
            if historical {
                "Historical revision"
            } else {
                "Record"
            },
            record.id,
            session_id
        ));
    }
}

fn is_session_manifest_type(record_type: u16) -> bool {
    matches!(
        record_type,
        RecordType::TRANSCRIPT_SEGMENT
            | RecordType::ANNOTATION
            | RecordType::AUDIO_CHUNK
            | RecordType::ASSET_METADATA
            | RecordType::EVIDENCE_NODE
            | RecordType::GUIDE
    )
}

pub(crate) fn check_manifest_counts(
    snapshot: &ArchiveSnapshot,
    live_by_key: &BTreeMap<String, ArchiveRecord>,
    issues: &mut Vec<String>,
) {
    let Some(manifest) = live_by_key.get(&primary_index_key(
        RecordType::SETTINGS,
        &snapshot.header.id,
    )) else {
        return;
    };
    let live_students = live_by_key
        .values()
        .filter(|record| record.record_type == RecordType::STUDENT)
        .count();
    let live_sessions = live_by_key
        .values()
        .filter(|record| record.record_type == RecordType::SESSION)
        .count();
    for (field, actual) in [
        ("student_count", live_students),
        ("session_count", live_sessions),
    ] {
        let Some(raw) = manifest.field(field) else {
            continue;
        };
        if !is_digits(raw) || raw.parse::<u64>().ok() != Some(actual as u64) {
            issues.push(format!(
                "Archive manifest {field} does not match the live record count."
            ));
        }
    }
}
