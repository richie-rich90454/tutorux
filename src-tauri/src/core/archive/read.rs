use std::collections::{BTreeMap, BTreeSet};

use crate::core::error::{err, CoreError, Result};
use crate::core::format::{
    decode_record_payload, decode_stored_payload, record_type_name, ArchiveRecord, RecordFrame,
    RecordType,
};
use crate::core::index::{primary_index_key, read_frame_at};

use super::support::{is_supported_manifest, valid_uuid};
use super::{ArchiveManifest, ArchiveSnapshot, CommitInfo, VerificationResult};

impl ArchiveSnapshot {
    pub fn get_manifest(&self) -> Result<ArchiveManifest> {
        let record = self
            .get_record(RecordType::SETTINGS, &self.header.id)?
            .ok_or_else(|| {
                CoreError::new(
                    "archive_manifest_missing",
                    "Archive manifest is missing or invalid.",
                )
            })?;
        if !is_supported_manifest(Some(&record)) {
            return err(
                "archive_manifest_missing",
                "Archive manifest is missing or invalid.",
            );
        }
        Ok(ArchiveManifest {
            display_name: record
                .field("display_name")
                .unwrap_or("Tutorux archive")
                .to_owned(),
            description: record.field("description").unwrap_or("").to_owned(),
            created_at_us: record
                .field("created_at_us")
                .map(str::to_owned)
                .unwrap_or_else(|| self.header.created_at_us.to_string()),
        })
    }

    pub fn get_record(&self, record_type: u16, id: &str) -> Result<Option<ArchiveRecord>> {
        let key = primary_index_key(record_type, id);
        let Some(offset) = self.index.get(&key).copied() else {
            return Ok(None);
        };
        let frame = read_frame_at(self.source.as_ref(), offset)?;
        if frame.record_type != record_type || !frame.id.eq_ignore_ascii_case(id) {
            return err(
                "record_index_mismatch",
                "Archive index points to a different record.",
            );
        }
        Ok(Some(self.decode_frame_record(&frame)?))
    }

    pub fn get_record_by_index_key(&self, key: &str) -> Result<Option<ArchiveRecord>> {
        let Some(offset) = self.index.get(key).copied() else {
            return Ok(None);
        };
        let frame = read_frame_at(self.source.as_ref(), offset)?;
        Ok(Some(self.decode_frame_record(&frame)?))
    }

    pub fn get_record_history(
        &self,
        record_type: u16,
        id: &str,
        limit: usize,
    ) -> Result<Vec<ArchiveRecord>> {
        if limit == 0 || limit > 10_000 {
            return err(
                "history_limit_invalid",
                "History limit must be between 1 and 10000.",
            );
        }
        let mut history = Vec::new();
        let mut current = self.get_record(record_type, id)?;
        while let Some(record) = current {
            if history.len() >= limit {
                break;
            }
            let previous_offset = record.previous_offset;
            history.push(record);
            if previous_offset == 0 {
                break;
            }
            let frame = read_frame_at(self.source.as_ref(), previous_offset)?;
            if frame.record_type != record_type || !frame.id.eq_ignore_ascii_case(id) {
                return err(
                    "record_index_mismatch",
                    "Archive revision chain points to a different record.",
                );
            }
            current = Some(self.decode_frame_record(&frame)?);
        }
        Ok(history)
    }

    pub fn list_records(
        &self,
        record_type: u16,
        include_deleted: bool,
    ) -> Result<Vec<ArchiveRecord>> {
        let prefix = format!("{}:", record_type_name(record_type).to_uppercase());
        let mut records = Vec::new();
        for (key, offset) in &self.index {
            if !key.starts_with(&prefix) || key.len() != prefix.len() + 36 {
                continue;
            }
            let frame = read_frame_at(self.source.as_ref(), *offset)?;
            if frame.record_type != record_type
                || !frame.id.eq_ignore_ascii_case(&key[prefix.len()..])
            {
                return err(
                    "record_index_mismatch",
                    "Archive index points to a different record.",
                );
            }
            let record = self.decode_frame_record(&frame)?;
            if include_deleted || !record.deleted() {
                records.push(record);
            }
        }
        Ok(records)
    }

    pub fn list_record_metadata(
        &self,
        record_type: u16,
        include_deleted: bool,
    ) -> Result<Vec<ArchiveRecord>> {
        let mut records = self.list_records(record_type, include_deleted)?;
        for record in &mut records {
            record.blob.clear();
        }
        Ok(records)
    }

    pub fn index_entry_count(&self) -> usize {
        self.index.len()
    }

    pub fn all_index_entries(&self) -> &BTreeMap<String, u64> {
        &self.index
    }

    pub fn audio_track_ids_by_session(&self) -> BTreeMap<String, BTreeSet<String>> {
        let mut tracks: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for key in self.index.keys() {
            let parts: Vec<&str> = key.split(':').collect();
            if parts.len() != 4 || parts[0] != "AUDIOSESSION" {
                continue;
            }
            if !valid_uuid(parts[1]) || !valid_uuid(parts[2]) || parts[3].len() != 20 {
                continue;
            }
            tracks
                .entry(parts[1].to_lowercase())
                .or_default()
                .insert(parts[2].to_lowercase());
        }
        tracks
    }

    pub fn decode_frame_payload(&self, frame: &RecordFrame) -> Result<Vec<u8>> {
        let metadata_record = (frame.record_type == RecordType::SETTINGS
            || frame.record_type == RecordType::ENCRYPTION)
            && frame.id.eq_ignore_ascii_case(&self.header.id);
        if frame.flags & 1 != 0 {
            if !self.encrypted() || metadata_record {
                return err(
                    "archive_record_encryption_invalid",
                    "Archive record encryption flags are inconsistent with its type or header.",
                );
            }
            let key = self.data_key.as_ref().ok_or_else(|| {
                CoreError::new(
                    "archive_locked",
                    "Unlock this archive before reading its encrypted records.",
                )
            })?;
            let plaintext = key.decrypt_record_payload(
                &frame.stored_payload,
                &crate::core::crypto::RecordEncryptionContext {
                    archive_id: &self.header.id,
                    record_type: frame.record_type,
                    record_id: &frame.id,
                    revision: frame.revision,
                    previous_offset: frame.previous_offset,
                    codec: frame.codec,
                },
            )?;
            return decode_stored_payload(frame.codec, 0, &plaintext);
        }
        if self.encrypted() && !metadata_record {
            return err(
                "archive_record_unencrypted",
                "Encrypted archive contains a plaintext data record.",
            );
        }
        decode_stored_payload(frame.codec, frame.flags, &frame.stored_payload)
    }

    pub fn decode_frame_record(&self, frame: &RecordFrame) -> Result<ArchiveRecord> {
        let payload = self.decode_frame_payload(frame)?;
        let record = decode_record_payload(
            frame.record_type,
            &frame.id,
            frame.revision,
            frame.previous_offset,
            &payload,
        )?;
        if self.encrypted()
            && self.data_key.is_some()
            && frame.record_type == RecordType::SETTINGS
            && frame.id.eq_ignore_ascii_case(&self.header.id)
        {
            return crate::core::crypto::verify_manifest_authentication(
                record,
                self.data_key.as_ref().unwrap(),
            );
        }
        Ok(record)
    }

    pub fn verify_revision_frame(&self, frame: &RecordFrame) -> Result<()> {
        if record_type_name(frame.record_type) == "unknown" {
            self.decode_frame_payload(frame)?;
        } else {
            self.decode_frame_record(frame)?;
        }
        Ok(())
    }

    pub fn open_generation(
        &self,
        commit: CommitInfo,
        index: BTreeMap<String, u64>,
        published_end_offset: u64,
    ) -> Self {
        Self {
            source: std::sync::Arc::clone(&self.source),
            header: self.header.clone(),
            commit,
            index,
            published_end_offset,
            data_key: self.data_key.clone(),
        }
    }

    pub fn record_chain(&self, record_type: u16, id: &str) -> Result<Vec<ArchiveRecord>> {
        let mut chain = Vec::new();
        let mut current = self.get_record(record_type, id)?;
        while let Some(record) = current {
            if chain.len() >= 1_000_000 {
                return err(
                    "revision_chain_limit",
                    "Archive revision chain exceeds the verification limit.",
                );
            }
            let previous_offset = record.previous_offset;
            chain.push(record);
            if previous_offset == 0 {
                break;
            }
            let frame = read_frame_at(self.source.as_ref(), previous_offset)?;
            if frame.record_type != record_type || !frame.id.eq_ignore_ascii_case(id) {
                return err(
                    "record_index_mismatch",
                    "Archive revision chain points to a different record.",
                );
            }
            current = Some(self.decode_frame_record(&frame)?);
        }
        Ok(chain)
    }

    pub fn verify(&self) -> Result<VerificationResult> {
        let mut records = 0usize;
        let mut live = 0usize;
        let mut deleted = 0usize;
        for (key, offset) in &self.index {
            let frame = read_frame_at(self.source.as_ref(), *offset)?;
            if frame.record_type == RecordType::INDEX_PAGE
                || frame.record_type == RecordType::COMMIT
            {
                continue;
            }
            let record = self.decode_frame_record(&frame)?;
            if key.starts_with(&format!(
                "{}:",
                record_type_name(record.record_type).to_uppercase()
            )) {
                records += 1;
            }
            if record.deleted() {
                deleted += 1;
            } else {
                live += 1;
            }
        }
        Ok(VerificationResult {
            generation: self.commit.generation,
            current_records: records,
            live_records: live,
            deleted_records: deleted,
            index_entries: self.index.len(),
        })
    }
}
