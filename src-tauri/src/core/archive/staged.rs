use std::collections::BTreeSet;
use std::sync::Arc;

use crate::core::error::{err, CoreError, Result};
use crate::core::format::{encode_record_frame, ArchiveRecord, RecordType, ZERO_UUID};
use crate::core::index::{build_index_tree, primary_index_key};
use crate::core::source::{ByteSource, CompositeSource};

use super::append_prepare::backfill_legacy_secondary_indexes;
use super::commit::{encode_commit_payload, encode_locator};
use super::support::{new_uuid, now_us, sha256};
use super::ArchiveSnapshot;

pub trait ArchiveStaging {
    fn append(&mut self, bytes: &[u8]) -> Result<()>;
    fn seal(&mut self) -> Result<Arc<dyn ByteSource>>;
    fn abort(&mut self) -> Result<()>;
}

pub fn append_staged_asset_records(
    snapshot: &ArchiveSnapshot,
    records: impl IntoIterator<Item = ArchiveRecord>,
    staging: &mut dyn ArchiveStaging,
) -> Result<ArchiveSnapshot> {
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock the archive before importing materials.",
        );
    }
    if snapshot.source.size() != snapshot.published_end_offset {
        return err(
            "archive_recovery_required",
            "Review or recover trailing data before importing materials.",
        );
    }
    let manifest = snapshot
        .get_record(RecordType::SETTINGS, &snapshot.header.id)?
        .ok_or_else(|| {
            CoreError::new(
                "archive_manifest_missing",
                "Archive manifest is missing or invalid.",
            )
        })?;
    if !super::is_supported_manifest(Some(&manifest)) {
        return err(
            "archive_manifest_missing",
            "Archive manifest is missing or invalid.",
        );
    }
    let mut index = snapshot.index.clone();
    let mut manifest_fields = manifest.fields.clone();
    backfill_legacy_secondary_indexes(snapshot, &mut index, &mut manifest_fields)?;
    manifest_fields.insert("updated_at_us".to_owned(), now_us().to_string());

    let mut written: BTreeSet<String> = BTreeSet::new();
    let mut cursor = snapshot.source.size();
    let mut record_count = 0u64;
    let mut metadata_count = 0usize;
    let result = (|| -> Result<ArchiveSnapshot> {
        for input in records {
            if input.record_type != RecordType::ASSET_BLOB
                && input.record_type != RecordType::ASSET_METADATA
            {
                return err(
                    "asset_import_record_invalid",
                    "The material import contains an unsupported record type.",
                );
            }
            let key = primary_index_key(input.record_type, &input.id);
            if index.contains_key(&key) || written.contains(&key) {
                return err(
                    "record_duplicate",
                    "The material import would overwrite an existing record.",
                );
            }
            if input.record_type == RecordType::ASSET_METADATA {
                metadata_count += 1;
            }
            let record = ArchiveRecord {
                id: input.id.to_lowercase(),
                revision: 1,
                previous_offset: 0,
                ..input
            };
            let frame = snapshot.encode_record_frame_for_append(&record)?;
            staging.append(&frame)?;
            index.insert(key.clone(), cursor);
            written.insert(key);
            for alias in crate::core::archive::secondary_index_keys(&record)? {
                if index.contains_key(&alias) {
                    return err(
                        "asset_blob_index_invalid",
                        "A material content index already exists.",
                    );
                }
                index.insert(alias, cursor);
            }
            cursor += frame.len() as u64;
            record_count += 1;
        }
        if metadata_count == 0 {
            return err(
                "asset_import_record_invalid",
                "A material import must contain at least one material record.",
            );
        }
        let manifest_key = primary_index_key(RecordType::SETTINGS, &snapshot.header.id);
        let previous_offset = index.get(&manifest_key).copied().ok_or_else(|| {
            CoreError::new("archive_manifest_missing", "Archive manifest is missing.")
        })?;
        let mut updated_manifest = manifest.clone();
        updated_manifest.fields = manifest_fields;
        updated_manifest.revision = manifest.revision + 1;
        updated_manifest.previous_offset = previous_offset;
        let manifest_frame = snapshot.encode_record_frame_for_append(&updated_manifest)?;
        staging.append(&manifest_frame)?;
        index.insert(manifest_key, cursor);
        cursor += manifest_frame.len() as u64;
        record_count += 1;

        let ordered: Vec<(String, u64)> = index
            .iter()
            .map(|(key, offset)| (key.clone(), *offset))
            .collect();
        let authenticate_ref = snapshot.data_key().map(|key| {
            move |payload: &[u8]| key.authenticate_bytes("TUTORUX-INDEX-PAGE-V1", payload)
        });
        let tree = build_index_tree(
            &ordered,
            cursor,
            authenticate_ref
                .as_ref()
                .map(|f| f as &dyn Fn(&[u8]) -> Vec<u8>),
        )?;
        for frame in &tree.frames {
            staging.append(frame)?;
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
        staging.append(&encode_record_frame(
            RecordType::COMMIT,
            ZERO_UUID,
            generation,
            snapshot.commit.offset,
            &commit_payload,
            0,
            0,
        )?)?;
        staging.append(&encode_locator(commit_offset, generation))?;
        let stage_source = staging.seal()?;
        let source: Arc<dyn ByteSource> = Arc::new(CompositeSource::new(
            Arc::clone(&snapshot.source),
            stage_source,
        ));
        let mut next = ArchiveSnapshot::open(source)?;
        if let Some(key) = snapshot.data_key() {
            next.set_data_key(key.clone());
            next.verify_authenticated()?;
        }
        next.verify()?;
        for key in &written {
            let Some(expected) = index.get(key).copied() else {
                continue;
            };
            if next.all_index_entries().get(key) != Some(&expected) {
                return err(
                    "archive_write_verification_failed",
                    "A staged material index could not be verified.",
                );
            }
        }
        Ok(next)
    })();
    if result.is_err() {
        let _ = staging.abort();
    }
    result
}
