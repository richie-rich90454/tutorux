use std::collections::{BTreeMap, BTreeSet};

use crate::core::archive::ArchiveSnapshot;
use crate::core::error::{err, Result};
use crate::core::format::{record_type_name, ArchiveRecord, RecordType};

use super::common::require_clean_tail;
use super::compact::compact_archive_internal;
use super::types::{
    ArchiveTrashPurgePlan, CompactionOptions, CompactionResult, TrashPurgeBlocker,
    TrashPurgeReference,
};

const TRASH_TYPES: [u16; 14] = [
    RecordType::STUDENT,
    RecordType::SESSION,
    RecordType::AUDIO_CHUNK,
    RecordType::TRANSCRIPT_SEGMENT,
    RecordType::ANNOTATION,
    RecordType::ASSET_METADATA,
    RecordType::ASSET_BLOB,
    RecordType::EVIDENCE_NODE,
    RecordType::EVIDENCE_EDGE,
    RecordType::GUIDE,
    RecordType::SETTINGS,
    RecordType::AI_JOB,
    RecordType::ENCRYPTION,
    RecordType::WAVEFORM_INDEX,
];

const TRASH_REFERENCE_TYPES: [u16; 13] = [
    RecordType::STUDENT,
    RecordType::SESSION,
    RecordType::AUDIO_CHUNK,
    RecordType::TRANSCRIPT_SEGMENT,
    RecordType::ANNOTATION,
    RecordType::ASSET_METADATA,
    RecordType::ASSET_BLOB,
    RecordType::EVIDENCE_NODE,
    RecordType::EVIDENCE_EDGE,
    RecordType::GUIDE,
    RecordType::SETTINGS,
    RecordType::AI_JOB,
    RecordType::WAVEFORM_INDEX,
];

fn record_label(record: &ArchiveRecord) -> String {
    let label = record
        .field("display_name")
        .or_else(|| record.field("title"))
        .or_else(|| record.field("label"))
        .or_else(|| record.field("original_name"))
        .or_else(|| record.field("name"))
        .or_else(|| record.field("content"))
        .or_else(|| record.field("text"))
        .or_else(|| record.field("record_role"))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{} record", record_type_name(record.record_type)));
    label.chars().take(120).collect()
}

fn list_trash_records(snapshot: &ArchiveSnapshot) -> Result<Vec<ArchiveRecord>> {
    let mut records = Vec::new();
    for record_type in TRASH_TYPES {
        records.extend(snapshot.list_record_metadata(record_type, true)?);
    }
    Ok(records)
}

pub fn plan_trash_purge(snapshot: &ArchiveSnapshot) -> Result<ArchiveTrashPurgePlan> {
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before purging Trash.",
        );
    }
    let records = list_trash_records(snapshot)?;
    let deleted: Vec<&ArchiveRecord> = records
        .iter()
        .filter(|record| record.field("_deleted") == Some("true"))
        .collect();
    let deleted_ids: BTreeSet<String> = deleted
        .iter()
        .map(|record| record.id.to_lowercase())
        .collect();
    let mut references_by_target: BTreeMap<String, BTreeMap<String, TrashPurgeReference>> =
        BTreeMap::new();
    for record in &records {
        if !TRASH_REFERENCE_TYPES.contains(&record.record_type)
            || record.field("_deleted") == Some("true")
        {
            continue;
        }
        for (name, value) in &record.fields {
            if !name.ends_with("_id") && !name.ends_with("_ids") {
                continue;
            }
            if name.starts_with("_trash_") || value.is_empty() {
                continue;
            }
            let ids: Vec<&str> = if name.ends_with("_ids") {
                value.split(',').collect()
            } else {
                vec![value.as_str()]
            };
            for raw_id in ids {
                let target_id = raw_id.trim().to_lowercase();
                if !deleted_ids.contains(&target_id) {
                    continue;
                }
                let target = references_by_target.entry(target_id).or_default();
                let reference_key = format!("{}:{}", record.record_type, record.id.to_lowercase());
                target
                    .entry(reference_key)
                    .and_modify(|reference| {
                        if !reference.fields.iter().any(|field| field == name) {
                            reference.fields.push(name.clone());
                        }
                    })
                    .or_insert_with(|| TrashPurgeReference {
                        record_id: record.id.clone(),
                        record_type: record_type_name(record.record_type).to_owned(),
                        label: record_label(record),
                        fields: vec![name.clone()],
                    });
            }
        }
    }
    let by_id: BTreeMap<String, &ArchiveRecord> = deleted
        .iter()
        .map(|record| (record.id.to_lowercase(), *record))
        .collect();
    let mut blockers: Vec<TrashPurgeBlocker> = references_by_target
        .into_iter()
        .filter_map(|(record_id, references)| {
            let record = by_id.get(&record_id)?;
            let mut references: Vec<TrashPurgeReference> = references.into_values().collect();
            references.sort_by(|left, right| left.label.cmp(&right.label));
            Some(TrashPurgeBlocker {
                record_id: record.id.clone(),
                record_type: record_type_name(record.record_type).to_owned(),
                label: record_label(record),
                references,
            })
        })
        .collect();
    blockers.sort_by(|left, right| left.label.cmp(&right.label));
    let opaque_records = snapshot
        .all_index_entries()
        .keys()
        .filter(|key| key.starts_with("UNKNOWN:"))
        .count();
    Ok(ArchiveTrashPurgePlan {
        generation: snapshot.commit.generation,
        deleted_records: deleted.len(),
        blockers,
        opaque_records,
    })
}

pub fn purge_trashed_archive_snapshot(snapshot: &ArchiveSnapshot) -> Result<CompactionResult> {
    let plan = plan_trash_purge(snapshot)?;
    if let Some(blocker) = plan.blockers.first() {
        return err(
            "trash_purge_reference_blocked",
            &format!(
                "\u{201c}{}\u{201d} is still linked from an active record. Restore it or remove the active link before purging Trash.",
                blocker.label
            ),
        );
    }
    if plan.opaque_records > 0 {
        return err(
            "trash_purge_opaque_records",
            &format!(
                "{} record(s) from a newer archive version cannot be checked for active links. Open this archive in a compatible version before purging Trash.",
                plan.opaque_records
            ),
        );
    }
    require_clean_tail(snapshot)?;
    let mut cleanup_records = Vec::new();
    for record in list_trash_records(snapshot)? {
        if record.field("_deleted") == Some("true") {
            continue;
        }
        let mut fields = record.fields.clone();
        let mut changed = false;
        let is_journal_notes =
            fields.get("record_role").map(String::as_str) == Some("journal-notes");
        let keys: Vec<String> = fields.keys().cloned().collect();
        for key in keys {
            if key.starts_with("_trash_restore_")
                || key == "_trash_session_group_id"
                || key == "_trash_guide_group_id"
                || (is_journal_notes
                    && (key.starts_with("removed_block_")
                        || key == "last_removed_block_id"
                        || key == "last_removed_block_kind"
                        || key == "last_removed_block_text"
                        || key == "last_removed_block_index"))
            {
                fields.remove(&key);
                changed = true;
            }
        }
        if is_journal_notes && fields.contains_key("removed_block_count") {
            if fields.get("removed_block_count").map(String::as_str) != Some("0") {
                changed = true;
            }
            fields.insert("removed_block_count".to_owned(), "0".to_owned());
        }
        if changed {
            fields.insert(
                "updated_at_us".to_owned(),
                crate::core::archive::now_us().to_string(),
            );
            let mut updated = record.clone();
            updated.fields = fields;
            cleanup_records.push(updated);
        }
    }
    let cleaned = snapshot.append_records(&cleanup_records)?;
    compact_archive_internal(
        &cleaned,
        false,
        &CompactionOptions {
            prune_unreferenced_assets: false,
            purge_deleted_records: true,
        },
    )
}

pub fn purge_trashed_archive_bytes(snapshot: &ArchiveSnapshot) -> Result<Vec<u8>> {
    Ok(purge_trashed_archive_snapshot(snapshot)?.bytes)
}
