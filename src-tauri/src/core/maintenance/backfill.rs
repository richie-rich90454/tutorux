use std::collections::BTreeSet;
use std::sync::Arc;

use crate::core::archive::{
    encode_commit_payload, encode_locator, encode_record_for_write, new_uuid, sha256,
    ArchiveSnapshot,
};
use crate::core::error::{err, CoreError, Result};
use crate::core::format::{encode_record_frame, RecordType, ZERO_UUID};
use crate::core::index::{build_index_tree, primary_index_key, read_frame_at};
use crate::core::source::{ByteSource, CompositeSource, MemorySource};

use super::common::require_clean_tail;
use super::types::BackfillResult;

pub fn backfill_archive_secondary_indexes(snapshot: &ArchiveSnapshot) -> Result<BackfillResult> {
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before rebuilding indexes.",
        );
    }
    require_clean_tail(snapshot)?;
    snapshot.get_manifest()?;
    snapshot.verify()?;
    let mut index = snapshot.index.clone();
    let mut added_entries = 0usize;
    let mut conflicting_entries = 0usize;
    let mut conflicting_version_fields: BTreeSet<&'static str> = BTreeSet::new();
    for (key, offset) in snapshot.all_index_entries() {
        let Some((_, id)) = super::retained::single_colon_key(key) else {
            continue;
        };
        if !crate::core::archive::valid_uuid(id) {
            continue;
        }
        let frame = read_frame_at(snapshot.source.as_ref(), *offset)?;
        if crate::core::format::record_type_name(frame.record_type) == "unknown"
            || key != &primary_index_key(frame.record_type, &frame.id)
        {
            continue;
        }
        let Some(record) = snapshot.get_record(frame.record_type, &frame.id)? else {
            return err(
                "record_index_mismatch",
                "Archive primary index points to a missing record.",
            );
        };
        for alias in crate::core::archive::secondary_index_keys(&record)? {
            match index.get(&alias).copied() {
                None => {
                    index.insert(alias, *offset);
                    added_entries += 1;
                }
                Some(existing) if existing == *offset => {}
                Some(_) => {
                    conflicting_entries += 1;
                    if let Some(migration) = crate::core::archive::secondary_index_migrations()
                        .iter()
                        .find(|migration| alias.starts_with(migration.prefix))
                    {
                        conflicting_version_fields.insert(migration.version_field);
                    }
                }
            }
        }
    }
    let manifest = snapshot
        .get_record(RecordType::SETTINGS, &snapshot.header.id)?
        .ok_or_else(|| {
            CoreError::new(
                "archive_manifest_missing",
                "Archive manifest is missing or invalid.",
            )
        })?;
    if !crate::core::archive::is_supported_manifest(Some(&manifest)) {
        return err(
            "archive_manifest_missing",
            "Archive manifest is missing or invalid.",
        );
    }
    let manifest_key = primary_index_key(RecordType::SETTINGS, &snapshot.header.id);
    let manifest_offset = index.get(&manifest_key).copied().ok_or_else(|| {
        CoreError::new(
            "archive_manifest_missing",
            "Archive manifest index entry is missing.",
        )
    })?;
    let mut manifest_fields = manifest.fields.clone();
    for migration in crate::core::archive::secondary_index_migrations() {
        manifest_fields.insert(
            migration.version_field.to_owned(),
            if conflicting_version_fields.contains(migration.version_field) {
                "0".to_owned()
            } else {
                "1".to_owned()
            },
        );
    }
    let versions_changed = crate::core::archive::secondary_index_migrations()
        .iter()
        .any(|migration| {
            manifest.fields.get(migration.version_field)
                != manifest_fields.get(migration.version_field)
        });
    if added_entries == 0 && !versions_changed {
        return Ok(BackfillResult {
            snapshot: snapshot.clone(),
            added_entries,
            conflicting_entries,
            schema_versions_updated: false,
        });
    }

    let mut tail: Vec<u8> = Vec::new();
    let mut cursor = snapshot.source.size();
    let mut record_count = 0u64;
    if versions_changed {
        let mut updated = manifest.clone();
        updated.fields = manifest_fields;
        updated.revision = manifest.revision + 1;
        updated.previous_offset = manifest_offset;
        let frame = encode_record_for_write(&snapshot.header, snapshot.data_key(), &updated)?;
        tail.extend_from_slice(&frame);
        index.insert(manifest_key, cursor);
        cursor += frame.len() as u64;
        record_count += 1;
    }
    let ordered: Vec<(String, u64)> = index
        .iter()
        .map(|(key, offset)| (key.clone(), *offset))
        .collect();
    let authenticate_ref = snapshot
        .data_key()
        .map(|key| move |payload: &[u8]| key.authenticate_bytes("TUTORUX-INDEX-PAGE-V1", payload));
    let tree = build_index_tree(
        &ordered,
        cursor,
        authenticate_ref
            .as_ref()
            .map(|f| f as &dyn Fn(&[u8]) -> Vec<u8>),
    )?;
    for frame in &tree.frames {
        tail.extend_from_slice(frame);
    }
    let generation = snapshot.commit.generation + 1;
    let commit_body = encode_commit_payload(
        generation,
        snapshot.commit.offset,
        tree.root_offset,
        &sha256(&tree.root_payload),
        &new_uuid(),
        record_count,
    );
    let commit_payload = if let Some(key) = snapshot.data_key() {
        let mut payload = commit_body.clone();
        payload.extend_from_slice(&key.authenticate_bytes("TUTORUX-COMMIT-V1", &commit_body));
        payload
    } else {
        commit_body
    };
    let commit_offset = tree.end_offset;
    tail.extend_from_slice(&encode_record_frame(
        RecordType::COMMIT,
        ZERO_UUID,
        generation,
        snapshot.commit.offset,
        &commit_payload,
        0,
        0,
    )?);
    tail.extend_from_slice(&encode_locator(commit_offset, generation));
    let next_source: Arc<dyn ByteSource> = Arc::new(CompositeSource::new(
        Arc::clone(&snapshot.source),
        Arc::new(MemorySource::new(tail)),
    ));
    let mut migrated = ArchiveSnapshot::open(next_source)?;
    if let Some(key) = snapshot.data_key() {
        migrated.set_data_key(key.clone());
        migrated.verify_authenticated()?;
    }
    migrated.verify()?;
    Ok(BackfillResult {
        snapshot: migrated,
        added_entries,
        conflicting_entries,
        schema_versions_updated: versions_changed,
    })
}

pub fn backfill_secondary_indexes(snapshot: &ArchiveSnapshot) -> Result<Vec<u8>> {
    let result = backfill_archive_secondary_indexes(snapshot)?;
    result
        .snapshot
        .source
        .read(0, result.snapshot.source.size() as usize)
}
