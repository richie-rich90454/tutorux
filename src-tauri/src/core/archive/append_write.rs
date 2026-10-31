use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use crate::core::error::{err, CoreError, Result};
use crate::core::format::{encode_record_frame, ArchiveRecord, RecordType, ZERO_UUID};
use crate::core::index::{build_index_tree, primary_index_key};
use crate::core::source::{ByteSource, CompositeSource, MemorySource};

use super::append_prepare::PreparedTransaction;
use super::commit::{encode_commit_payload, encode_locator};
use super::encode::encode_record_for_write;
use super::indexes::secondary_index_keys;
use super::support::{new_uuid, sha256};
use super::ArchiveSnapshot;

impl ArchiveSnapshot {
    pub(crate) fn encode_record_frame_for_append(&self, record: &ArchiveRecord) -> Result<Vec<u8>> {
        if self.encrypted() && self.data_key.is_none() {
            return err("archive_locked", "Unlock this archive before editing it.");
        }
        encode_record_for_write(&self.header, self.data_key.as_ref(), record)
    }
}

pub(crate) fn write_transaction(
    snapshot: &ArchiveSnapshot,
    prepared: PreparedTransaction,
) -> Result<ArchiveSnapshot> {
    let PreparedTransaction {
        mut index,
        manifest_fields,
        write_changes,
    } = prepared;
    let mut tail: Vec<u8> = Vec::new();
    let mut cursor = snapshot.source.size();
    let mut changed_keys = HashSet::new();
    let mut written_records = Vec::new();
    for change in &write_changes {
        if change.record_type == RecordType::INDEX_PAGE || change.record_type == RecordType::COMMIT
        {
            return err(
                "record_type_invalid",
                "Index and commit records are managed by the archive writer.",
            );
        }
        let key = primary_index_key(change.record_type, &change.id);
        if !changed_keys.insert(key.clone()) {
            return err(
                "record_duplicate",
                "A single archive transaction cannot update one record twice.",
            );
        }
        let previous = index.get(&key).copied();
        let mut revision = 1u64;
        let mut previous_secondary_keys = Vec::new();
        if let Some(previous_offset) = previous {
            let previous_frame =
                crate::core::index::read_frame_at(snapshot.source.as_ref(), previous_offset)?;
            revision = previous_frame.revision + 1;
            let previous_record = snapshot
                .get_record(change.record_type, &change.id)?
                .ok_or_else(|| {
                    CoreError::new(
                        "record_index_mismatch",
                        "Archive index points to a different record.",
                    )
                })?;
            previous_secondary_keys = secondary_index_keys(&previous_record)?;
        }
        let record = ArchiveRecord {
            id: change.id.to_lowercase(),
            revision,
            previous_offset: previous.unwrap_or(0),
            ..change.clone()
        };
        let frame = snapshot.encode_record_frame_for_append(&record)?;
        written_records.push(record.clone());
        tail.extend_from_slice(&frame);
        index.insert(key, cursor);
        let next_secondary_keys = secondary_index_keys(&record)?;
        let next_key_set: HashSet<&String> = next_secondary_keys.iter().collect();
        for previous_key in previous_secondary_keys {
            if !next_key_set.contains(&previous_key)
                && !previous_key.starts_with("GUIDESOURCE:")
                && !previous_key.starts_with("BLOB:")
                && previous
                    .map(|offset| index.get(&previous_key).copied() == Some(offset))
                    .unwrap_or(false)
            {
                index.remove(&previous_key);
            }
        }
        if let Some(audio_key) = next_secondary_keys
            .iter()
            .find(|key| key.starts_with("AUDIOSESSION:"))
        {
            if let Some(indexed_offset) = index.get(audio_key).copied() {
                if Some(indexed_offset) != previous {
                    return err(
                        "audio_chunk_sequence_duplicate",
                        "A recording track already contains this chunk sequence number.",
                    );
                }
            }
        }
        for secondary_key in next_secondary_keys {
            index.insert(secondary_key, cursor);
        }
        cursor += frame.len() as u64;
    }

    let ordered: Vec<(String, u64)> = index
        .iter()
        .map(|(key, offset)| (key.clone(), *offset))
        .collect();
    let authenticate = if snapshot.encrypted() {
        let key = snapshot.data_key.as_ref().unwrap();
        Some(move |payload: &[u8]| key.authenticate_bytes("TUTORUX-INDEX-PAGE-V1", payload))
    } else {
        None
    };
    let authenticate_ref = authenticate
        .as_ref()
        .map(|function| function as &dyn Fn(&[u8]) -> Vec<u8>);
    let tree = build_index_tree(&ordered, cursor, authenticate_ref)?;
    for frame in &tree.frames {
        tail.extend_from_slice(frame);
    }
    cursor = tree.end_offset;
    let root_hash = sha256(&tree.root_payload);
    let transaction_id = new_uuid();
    let commit_offset = cursor;
    let generation = snapshot.commit.generation + 1;
    let commit_body = encode_commit_payload(
        generation,
        snapshot.commit.offset,
        tree.root_offset,
        &root_hash,
        &transaction_id,
        write_changes.len() as u64,
    );
    let commit_payload = if snapshot.encrypted() {
        let mut payload = commit_body.clone();
        payload.extend_from_slice(
            &snapshot
                .data_key
                .as_ref()
                .unwrap()
                .authenticate_bytes("TUTORUX-COMMIT-V1", &commit_body),
        );
        payload
    } else {
        commit_body
    };
    let commit_frame = encode_record_frame(
        RecordType::COMMIT,
        ZERO_UUID,
        generation,
        snapshot.commit.offset,
        &commit_payload,
        0,
        0,
    )?;
    tail.extend_from_slice(&commit_frame);
    tail.extend_from_slice(&encode_locator(commit_offset, generation));

    let next_source: Arc<dyn ByteSource> = Arc::new(CompositeSource::new(
        Arc::clone(&snapshot.source),
        Arc::new(MemorySource::new(tail)),
    ));
    let mut next = ArchiveSnapshot::open(next_source)?;
    if snapshot.encrypted() {
        next.data_key = snapshot.data_key.clone();
        next.verify_encryption_authentication()?;
        verify_written_records(&next, snapshot, &written_records, &manifest_fields)?;
    }
    Ok(next)
}

fn verify_written_records(
    next: &ArchiveSnapshot,
    snapshot: &ArchiveSnapshot,
    written_records: &[ArchiveRecord],
    _manifest_fields: &BTreeMap<String, String>,
) -> Result<()> {
    for record in written_records {
        let verified = next
            .get_record(record.record_type, &record.id)?
            .ok_or_else(|| {
                CoreError::new(
                    "archive_write_verification_failed",
                    "The encrypted record could not be read back after writing.",
                )
            })?;
        let is_manifest = record.record_type == RecordType::SETTINGS
            && record.id.eq_ignore_ascii_case(&snapshot.header.id);
        let expected_fields: BTreeMap<String, String> = if is_manifest {
            record
                .fields
                .iter()
                .filter(|(name, _)| name.as_str() != "manifest_auth")
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        } else {
            record.fields.clone()
        };
        let verified_fields: BTreeMap<String, String> = if is_manifest {
            verified
                .fields
                .iter()
                .filter(|(name, _)| name.as_str() != "manifest_auth")
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        } else {
            verified.fields.clone()
        };
        let fields_match = verified_fields.len() == expected_fields.len()
            && expected_fields
                .iter()
                .all(|(name, value)| verified_fields.get(name) == Some(value));
        if verified.record_type != record.record_type
            || verified.id != record.id
            || verified.revision != record.revision
            || verified.previous_offset != record.previous_offset
            || !fields_match
            || verified.blob != record.blob
        {
            return err(
                "archive_write_verification_failed",
                "Encrypted record contents changed during write verification.",
            );
        }
    }
    Ok(())
}
