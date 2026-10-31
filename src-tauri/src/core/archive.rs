use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::core::crypto::{
    envelope_from_record, envelope_to_record, verify_manifest_authentication, wrap_data_key,
    ArchiveDataKey, RecordEncryptionContext,
};
use crate::core::error::{err, CoreError, Result};
use crate::core::format::{
    compress_record_payload, decode_archive_header, decode_record_payload, decode_stored_payload,
    encode_archive_header, encode_record_frame, encode_record_payload, record_type_name,
    uuid_from_bytes, ArchiveHeader, ArchiveRecord, RecordFrame, RecordType, ARCHIVE_HEADER_SIZE,
    CAPABILITY_ENCRYPTED, ZERO_UUID,
};
use crate::core::index::{
    build_index_tree, encode_index_page, primary_index_key, read_frame_at, read_index_tree,
};
use crate::core::source::{ByteSource, CompositeSource, MemorySource};

#[path = "verify.rs"]
pub mod verify;
pub use verify::{verify_full, verify_history, FullVerificationResult, HistoryVerificationResult};

const LOCATOR_SIZE: u64 = 32;
const RECOVERY_WINDOW: u64 = 64 * 1024 * 1024;
pub(crate) const SECONDARY_INDEX_PREFIXES: [&str; 7] = [
    "ANNOTATIONSESSION:",
    "STUDENTSESSION:",
    "EVIDENCEADJ:",
    "TRANSCRIPTSESSION:",
    "GUIDESOURCE:",
    "AUDIOSESSION:",
    "BLOB:",
];
const CREDENTIAL_METADATA_FIELDS: [&str; 20] = [
    "credentialstorage",
    "apikeyenv",
    "tokenbudget",
    "tokensbudget",
    "tokencount",
    "tokenscount",
    "tokenlimit",
    "tokenslimit",
    "tokenusage",
    "tokensusage",
    "maxoutputtokens",
    "maximumoutputtokens",
    "tokenizerinformation",
    "contexttokens",
    "trainingcontexttokens",
    "usedtokens",
    "estimatedtokens",
    "requestedoutputtokens",
    "inputtokenupperbound",
    "",
];
const CREDENTIAL_MARKERS: [&str; 12] = [
    "password",
    "passwd",
    "passphrase",
    "secret",
    "credential",
    "apikey",
    "authorization",
    "privatekey",
    "accesskey",
    "authkey",
    "bearertoken",
    "refreshtoken",
];
const NON_SECRET_TOKEN_SUFFIXES: [&str; 8] = [
    "tokenbudget",
    "tokensbudget",
    "tokencount",
    "tokenscount",
    "tokenlimit",
    "tokenslimit",
    "tokenusage",
    "tokensusage",
];

pub fn now_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_micros() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInfo {
    pub generation: u64,
    pub offset: u64,
    pub previous_offset: u64,
    pub root_offset: u64,
    pub root_hash: Vec<u8>,
    pub transaction_id: String,
    pub record_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveManifest {
    pub display_name: String,
    pub description: String,
    pub created_at_us: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerificationResult {
    pub generation: u64,
    pub current_records: usize,
    pub live_records: usize,
    pub deleted_records: usize,
    pub index_entries: usize,
}

#[derive(Clone)]
pub struct ArchiveSnapshot {
    pub source: Arc<dyn ByteSource>,
    pub header: ArchiveHeader,
    pub commit: CommitInfo,
    pub index: BTreeMap<String, u64>,
    pub published_end_offset: u64,
    data_key: Option<ArchiveDataKey>,
}

impl std::fmt::Debug for ArchiveSnapshot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ArchiveSnapshot")
            .field("id", &self.header.id)
            .field("generation", &self.commit.generation)
            .field("encrypted", &self.encrypted())
            .field("index_entries", &self.index.len())
            .finish()
    }
}

impl ArchiveSnapshot {
    pub fn encrypted(&self) -> bool {
        self.header.capabilities & CAPABILITY_ENCRYPTED != 0
    }

    pub fn locked(&self) -> bool {
        self.encrypted() && self.data_key.is_none()
    }

    pub fn can_mutate(&self) -> bool {
        !self.encrypted() || self.data_key.is_some()
    }

    pub fn data_key(&self) -> Option<&ArchiveDataKey> {
        self.data_key.as_ref()
    }

    pub fn set_data_key(&mut self, key: ArchiveDataKey) {
        self.data_key = Some(key);
    }

    pub fn verify_authenticated(&self) -> Result<()> {
        self.verify_encryption_authentication()
    }

    pub fn open(source: Arc<dyn ByteSource>) -> Result<Self> {
        if source.size() < ARCHIVE_HEADER_SIZE {
            return err("archive_truncated", "Archive header is truncated.");
        }
        let header = decode_archive_header(&source.read(0, ARCHIVE_HEADER_SIZE as usize)?)?;
        let recent_start = if source.size() > RECOVERY_WINDOW + ARCHIVE_HEADER_SIZE {
            source.size() - RECOVERY_WINDOW
        } else {
            ARCHIVE_HEADER_SIZE
        };
        let mut candidate = scan_for_committed_root(source.as_ref(), recent_start, &header)?;
        if candidate.is_none() && recent_start != ARCHIVE_HEADER_SIZE {
            candidate = scan_for_committed_root(source.as_ref(), ARCHIVE_HEADER_SIZE, &header)?;
        }
        let candidate = candidate.ok_or_else(|| {
            CoreError::new(
                "archive_commit_missing",
                "No valid committed archive generation was found.",
            )
        })?;
        Ok(Self {
            source,
            header,
            commit: candidate.0,
            index: candidate.1,
            published_end_offset: candidate.2,
            data_key: None,
        })
    }

    pub fn open_bytes(bytes: Vec<u8>) -> Result<Self> {
        Self::open(Arc::new(MemorySource::new(bytes)))
    }

    pub fn unlock(&self, passphrase: &str) -> Result<Self> {
        if !self.encrypted() {
            return err("archive_not_encrypted", "This archive is not encrypted.");
        }
        if !self.locked() {
            return Ok(self.clone());
        }
        let envelope_record = self.get_record(RecordType::ENCRYPTION, &self.header.id)?;
        let envelope_record = envelope_record.ok_or_else(|| {
            CoreError::new(
                "archive_encryption_metadata_missing",
                "Encrypted archive is missing its key-wrapping metadata.",
            )
        })?;
        let envelope = envelope_from_record(&envelope_record, &self.header.id)?;
        let key = crate::core::crypto::unwrap_data_key(passphrase, &envelope, &self.header.id)?;
        let unlocked = Self {
            source: Arc::clone(&self.source),
            header: self.header.clone(),
            commit: self.commit.clone(),
            index: self.index.clone(),
            published_end_offset: self.published_end_offset,
            data_key: Some(key),
        };
        unlocked.verify_encryption_authentication()?;
        Ok(unlocked)
    }

    pub fn lock(&mut self) {
        self.data_key = None;
    }

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

    pub fn list_audio_chunk_metadata(
        &self,
        session_id: &str,
        track_id: &str,
        include_deleted: bool,
    ) -> Result<Vec<ArchiveRecord>> {
        let session = session_id.to_lowercase();
        let track = track_id.to_lowercase();
        if !valid_uuid(&session) || !valid_uuid(&track) {
            return err(
                "audio_chunk_identity_invalid",
                "A recording needs a valid session and track identifier.",
            );
        }
        let session_prefix = format!("AUDIOSESSION:{session}:");
        let track_prefix = format!("{session_prefix}{track}:");
        let session_keys: Vec<&String> = self
            .index
            .keys()
            .filter(|key| key.starts_with(&session_prefix))
            .collect();
        let indexed_keys: Vec<&String> = if session_keys.is_empty() {
            self.index
                .keys()
                .filter(|key| key.starts_with("AUDIO:"))
                .collect()
        } else {
            session_keys
                .into_iter()
                .filter(|key| key.starts_with(&track_prefix))
                .collect()
        };
        let mut keys = indexed_keys;
        keys.sort();
        let mut chunks = Vec::new();
        for key in keys {
            let offset = self.index[key];
            let frame = read_frame_at(self.source.as_ref(), offset)?;
            let record = self.decode_frame_record(&frame)?;
            if record.record_type != RecordType::AUDIO_CHUNK {
                return err(
                    "audio_chunk_index_invalid",
                    "The recording index points to a non-audio record.",
                );
            }
            if record.field("session_id").map(str::to_lowercase).as_deref() != Some(&session)
                || record.field("track_id").map(str::to_lowercase).as_deref() != Some(&track)
            {
                if key.starts_with("AUDIOSESSION:") {
                    return err(
                        "audio_chunk_index_invalid",
                        "The recording index points to a different session or track.",
                    );
                }
                continue;
            }
            let sequence = record.field("sequence_number").unwrap_or("");
            if sequence.is_empty() || !sequence.bytes().all(|byte| byte.is_ascii_digit()) {
                return err(
                    "audio_chunk_metadata_invalid",
                    "A recording chunk has an invalid sequence number.",
                );
            }
            if key.starts_with("AUDIOSESSION:")
                && key != &format!("{track_prefix}{:020}", sequence.parse::<u64>().unwrap_or(0))
            {
                return err(
                    "audio_chunk_index_invalid",
                    "The recording index sequence does not match its chunk.",
                );
            }
            if include_deleted || !record.deleted() {
                chunks.push(record);
            }
        }
        chunks.sort_by(|left, right| {
            let left_sequence = left.field("sequence_number").unwrap_or("");
            let right_sequence = right.field("sequence_number").unwrap_or("");
            let left_value = left_sequence.parse::<u64>().unwrap_or(0);
            let right_value = right_sequence.parse::<u64>().unwrap_or(0);
            left_value
                .cmp(&right_value)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(chunks)
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
                &RecordEncryptionContext {
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
            return verify_manifest_authentication(record, self.data_key.as_ref().unwrap());
        }
        Ok(record)
    }

    fn verify_encryption_authentication(&self) -> Result<()> {
        if !self.encrypted() {
            return Ok(());
        }
        let key = self.data_key.as_ref().ok_or_else(|| {
            CoreError::new(
                "archive_locked",
                "Unlock this archive before verifying its authentication data.",
            )
        })?;
        let commit_frame = read_frame_at(self.source.as_ref(), self.commit.offset)?;
        let commit_payload = decode_stored_payload(
            commit_frame.codec,
            commit_frame.flags,
            &commit_frame.stored_payload,
        )?;
        if commit_frame.record_type != RecordType::COMMIT
            || commit_frame.flags != 0
            || commit_payload.len() != 124
            || !key.authentication_matches(
                "TUTORUX-COMMIT-V1",
                &commit_payload[..92],
                &commit_payload[92..],
            )
        {
            return err(
                "archive_commit_authentication_failed",
                "Encrypted archive commit authentication failed.",
            );
        }
        let root_frame = read_frame_at(self.source.as_ref(), self.commit.root_offset)?;
        if root_frame.record_type != RecordType::INDEX_PAGE
            || sha256(&root_frame.stored_payload) != self.commit.root_hash
        {
            return err(
                "archive_index_authentication_failed",
                "Encrypted archive root index does not match its committed hash.",
            );
        }
        let verified = read_index_tree(
            self.source.as_ref(),
            self.commit.offset,
            self.commit.root_offset,
            true,
            Some(key),
        )?;
        if verified != self.index {
            return err(
                "archive_index_authentication_failed",
                "Authenticated index does not match the opened archive index.",
            );
        }
        let manifest = self
            .get_record(RecordType::SETTINGS, &self.header.id)?
            .ok_or_else(|| {
                CoreError::new(
                    "archive_manifest_missing",
                    "Encrypted archive manifest is missing or invalid.",
                )
            })?;
        if manifest.field("record_role") != Some("archive-manifest") {
            return err(
                "archive_manifest_missing",
                "Encrypted archive manifest is missing or invalid.",
            );
        }
        Ok(())
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
            source: Arc::clone(&self.source),
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

    pub fn open_for_recovery(source: Arc<dyn ByteSource>) -> Result<Self> {
        match Self::open(Arc::clone(&source)) {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) if error.code != "archive_commit_missing" => return Err(error),
            Err(_) => {}
        }
        if source.size() < ARCHIVE_HEADER_SIZE {
            return err("archive_truncated", "Archive header is truncated.");
        }
        let header = decode_archive_header(&source.read(0, ARCHIVE_HEADER_SIZE as usize)?)?;
        let mut offsets = scan_commit_frame_offsets(source.as_ref())?;
        offsets.sort_unstable();
        for offset in offsets.into_iter().rev() {
            let Ok(commit) = decode_commit(source.as_ref(), offset) else {
                continue;
            };
            let Ok(Some((consistent, index))) =
                find_consistent_commit(source.as_ref(), &header, commit)
            else {
                continue;
            };
            if consistent.offset != offset {
                continue;
            }
            let published_end_offset = commit_published_end(source.as_ref(), &consistent)
                .unwrap_or_else(|_| {
                    read_frame_at(source.as_ref(), consistent.offset)
                        .map(|frame| frame.end_offset)
                        .unwrap_or(consistent.offset)
                });
            return Ok(Self {
                source,
                header,
                commit: consistent,
                index,
                published_end_offset,
                data_key: None,
            });
        }
        err(
            "archive_commit_missing",
            "No valid committed archive generation was found.",
        )
    }

    fn encode_record_frame_for_append(&self, record: &ArchiveRecord) -> Result<Vec<u8>> {
        if self.encrypted() && self.data_key.is_none() {
            return err("archive_locked", "Unlock this archive before editing it.");
        }
        encode_record_for_write(&self.header, self.data_key.as_ref(), record)
    }

    pub fn append_records(&self, changes: &[ArchiveRecord]) -> Result<ArchiveSnapshot> {
        if self.locked() {
            return err("archive_locked", "Unlock this archive before editing it.");
        }
        if changes.is_empty() {
            return Ok(self.clone());
        }
        if self.encrypted()
            && changes.iter().any(|record| {
                record.record_type == RecordType::ENCRYPTION
                    && record.id.eq_ignore_ascii_case(&self.header.id)
            })
        {
            return err(
                "archive_passphrase_change_unsupported",
                "Passphrase changes must use the archive re-keying operation so prior key envelopes are removed.",
            );
        }
        if self.source.size() != self.published_end_offset {
            return err(
                "archive_recovery_required",
                "This archive has uncommitted trailing data. Review or recover it before making changes.",
            );
        }

        let explicit_manifest = changes.iter().find(|record| {
            record.record_type == RecordType::SETTINGS
                && record.id.eq_ignore_ascii_case(&self.header.id)
        });
        let stored_manifest = self.get_record(RecordType::SETTINGS, &self.header.id)?;
        let current_manifest = explicit_manifest.cloned().or(stored_manifest.clone());
        if !is_supported_manifest(current_manifest.as_ref()) {
            return err(
                "archive_manifest_missing",
                "Archive manifest is missing or invalid.",
            );
        }
        for change in changes {
            if change.record_type != RecordType::SETTINGS {
                continue;
            }
            let credential_record = is_credential_settings_record(change);
            let sensitive_material = has_sensitive_credential_material(change);
            if credential_record && !self.encrypted() {
                return err(
                    "credential_encryption_required",
                    "Credential records can be stored only in an encrypted archive.",
                );
            }
            if sensitive_material && !credential_record {
                return err(
                    "sensitive_setting_key_rejected",
                    "Credential-bearing settings must use the encrypted credential representation.",
                );
            }
        }

        let mut audio_session_ids = BTreeSet::new();
        for change in changes {
            if change.record_type != RecordType::AUDIO_CHUNK {
                continue;
            }
            let session_id = change.field("session_id").unwrap_or("").to_lowercase();
            if valid_uuid(&session_id) {
                audio_session_ids.insert(session_id);
            }
            let previous = self.get_record(RecordType::AUDIO_CHUNK, &change.id)?;
            let identity = |record: &ArchiveRecord| {
                format!(
                    "{}\u{0}{}\u{0}{}",
                    record.field("session_id").unwrap_or("").to_lowercase(),
                    record.field("track_id").unwrap_or("").to_lowercase(),
                    record.field("sequence_number").unwrap_or("")
                )
            };
            if let Some(previous) = previous {
                if identity(&previous) != identity(change) {
                    return err(
                        "audio_chunk_identity_immutable",
                        "An audio chunk's session, track, and sequence identity cannot change.",
                    );
                }
            }
        }

        let students = self.list_records(RecordType::STUDENT, true)?;
        let sessions = self.list_records(RecordType::SESSION, true)?;
        let mut student_by_id: BTreeMap<String, ArchiveRecord> = students
            .into_iter()
            .map(|record| (record.id.to_lowercase(), record))
            .collect();
        let mut session_by_id: BTreeMap<String, ArchiveRecord> = sessions
            .into_iter()
            .map(|record| (record.id.to_lowercase(), record))
            .collect();
        for change in changes {
            if change.record_type == RecordType::STUDENT {
                student_by_id.insert(change.id.to_lowercase(), change.clone());
            }
            if change.record_type == RecordType::SESSION {
                session_by_id.insert(change.id.to_lowercase(), change.clone());
            }
        }

        let mut manifest_fields = current_manifest.as_ref().unwrap().fields.clone();
        manifest_fields.insert(
            "student_count".to_owned(),
            student_by_id
                .values()
                .filter(|record| !record.deleted())
                .count()
                .to_string(),
        );
        manifest_fields.insert(
            "session_count".to_owned(),
            session_by_id
                .values()
                .filter(|record| !record.deleted())
                .count()
                .to_string(),
        );
        manifest_fields.insert("updated_at_us".to_owned(), now_us().to_string());

        let mut index = self.index.clone();
        for migration in secondary_index_migrations() {
            manifest_fields.insert(migration.version_field.to_owned(), "1".to_owned());
        }
        // Backfill secondary indexes for archives created before the version markers.
        for migration in secondary_index_migrations() {
            if stored_manifest
                .as_ref()
                .and_then(|record| record.field(migration.version_field))
                == Some("1")
            {
                continue;
            }
            for record in self.list_records(migration.record_type, true)? {
                if let Some(offset) = index
                    .get(&primary_index_key(record.record_type, &record.id))
                    .copied()
                {
                    for key in secondary_index_keys(&record)? {
                        if key.starts_with(migration.prefix) {
                            index.insert(key, offset);
                        }
                    }
                }
            }
        }

        let has_guide_index_changes = changes.iter().any(|record| {
            record.record_type == RecordType::GUIDE || is_guide_source_record(record)
        });
        if has_guide_index_changes
            && manifest_fields.get("guide_source_index_version") != Some(&"1".to_owned())
        {
            for guide in self.list_records(RecordType::GUIDE, true)? {
                let Some(guide_offset) = index
                    .get(&primary_index_key(RecordType::GUIDE, &guide.id))
                    .copied()
                else {
                    continue;
                };
                for alias in secondary_index_keys(&guide)? {
                    if alias.starts_with("GUIDESOURCE:") {
                        index.insert(alias, guide_offset);
                    }
                }
            }
            manifest_fields.insert("guide_source_index_version".to_owned(), "1".to_owned());
        }

        let manifest_changed = changes.iter().any(|record| {
            record.record_type == RecordType::SETTINGS
                && record.id.eq_ignore_ascii_case(&self.header.id)
        });
        let mut write_changes: Vec<ArchiveRecord> = if manifest_changed {
            changes
                .iter()
                .map(|record| {
                    if record.record_type == RecordType::SETTINGS
                        && record.id.eq_ignore_ascii_case(&self.header.id)
                    {
                        let mut updated = record.clone();
                        updated.fields = manifest_fields.clone();
                        updated
                    } else {
                        record.clone()
                    }
                })
                .collect()
        } else {
            let mut updated_manifest = current_manifest.as_ref().unwrap().clone();
            updated_manifest.fields = manifest_fields.clone();
            let mut updated = changes.to_vec();
            updated.push(updated_manifest);
            updated
        };

        let mut changes_by_key: BTreeMap<String, ArchiveRecord> = BTreeMap::new();
        for record in write_changes {
            let key = primary_index_key(record.record_type, &record.id);
            if changes_by_key.insert(key, record).is_some() {
                return err(
                    "record_duplicate",
                    "A single archive transaction cannot update one record twice.",
                );
            }
        }
        let keys: Vec<String> = changes_by_key.keys().cloned().collect();
        for key in keys {
            let record = changes_by_key[&key].clone();
            if record.record_type != RecordType::GUIDE {
                continue;
            }
            if let Some(previous) = self.get_record(RecordType::GUIDE, &record.id)? {
                changes_by_key.insert(
                    key,
                    preserve_guide_source_history(&previous, &record, &index),
                );
            }
        }

        let mut stale_guides: BTreeMap<String, ArchiveRecord> = BTreeMap::new();
        let changed_guide_source_ids: BTreeSet<String> = changes
            .iter()
            .filter(|record| is_guide_source_record(record))
            .map(|record| record.id.to_lowercase())
            .collect();
        for source_id in &changed_guide_source_ids {
            let mut candidate_ids = BTreeSet::new();
            let prefix = format!("GUIDESOURCE:{source_id}:");
            for alias in index.keys() {
                if let Some(guide_id) = alias.strip_prefix(&prefix) {
                    candidate_ids.insert(guide_id.to_owned());
                }
            }
            for record in changes_by_key.values() {
                if record.record_type == RecordType::GUIDE
                    && guide_cited_source_ids(record).contains(source_id)
                {
                    candidate_ids.insert(record.id.to_lowercase());
                }
            }
            for guide_id in candidate_ids {
                let key = primary_index_key(RecordType::GUIDE, &guide_id);
                let current = stale_guides
                    .get(&guide_id)
                    .cloned()
                    .or_else(|| changes_by_key.get(&key).cloned());
                let current = match current {
                    Some(record) => Some(record),
                    None => self.get_record(RecordType::GUIDE, &guide_id)?,
                };
                let Some(current) = current else { continue };
                if current.deleted() {
                    continue;
                }
                let updated = mark_guide_blocks_stale(&current, source_id);
                if updated != current {
                    stale_guides.insert(
                        guide_id,
                        preserve_guide_source_history(&current, &updated, &index),
                    );
                }
            }
        }
        for (guide_id, guide) in stale_guides {
            changes_by_key.insert(primary_index_key(RecordType::GUIDE, &guide_id), guide);
        }

        if !audio_session_ids.is_empty() {
            manifest_fields.insert("audio_chunk_index_version".to_owned(), "1".to_owned());
            for session_id in &audio_session_ids {
                let key = primary_index_key(RecordType::SESSION, session_id);
                if let Some(changed_session) = changes_by_key.get(&key) {
                    if changed_session.field("audio_chunk_index_version") != Some("1") {
                        let mut updated = changed_session.clone();
                        updated
                            .fields
                            .insert("audio_chunk_index_version".to_owned(), "1".to_owned());
                        changes_by_key.insert(key, updated);
                    }
                    continue;
                }
                if let Some(stored_session) = self.get_record(RecordType::SESSION, session_id)? {
                    if stored_session.field("audio_chunk_index_version") == Some("1") {
                        continue;
                    }
                    let mut updated = stored_session;
                    updated
                        .fields
                        .insert("audio_chunk_index_version".to_owned(), "1".to_owned());
                    changes_by_key.insert(key, updated);
                }
            }
        }
        write_changes = changes_by_key.values().cloned().collect();
        // The manifest fields computed above must survive any audio-session insert.
        if let Some(manifest) = write_changes.iter_mut().find(|record| {
            record.record_type == RecordType::SETTINGS
                && record.id.eq_ignore_ascii_case(&self.header.id)
        }) {
            for (name, value) in &manifest_fields {
                manifest.fields.insert(name.clone(), value.clone());
            }
        }

        let mut tail: Vec<u8> = Vec::new();
        let mut cursor = self.source.size();
        let mut changed_keys = HashSet::new();
        let mut written_records = Vec::new();
        for change in &write_changes {
            if change.record_type == RecordType::INDEX_PAGE
                || change.record_type == RecordType::COMMIT
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
                let previous_frame = read_frame_at(self.source.as_ref(), previous_offset)?;
                revision = previous_frame.revision + 1;
                let previous_record = self
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
            let frame = self.encode_record_frame_for_append(&record)?;
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
        let authenticate = if self.encrypted() {
            let key = self.data_key.as_ref().unwrap();
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
        let generation = self.commit.generation + 1;
        let commit_body = encode_commit_payload(
            generation,
            self.commit.offset,
            tree.root_offset,
            &root_hash,
            &transaction_id,
            write_changes.len() as u64,
        );
        let commit_payload = if self.encrypted() {
            let mut payload = commit_body.clone();
            payload.extend_from_slice(
                &self
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
            self.commit.offset,
            &commit_payload,
            0,
            0,
        )?;
        tail.extend_from_slice(&commit_frame);
        tail.extend_from_slice(&encode_locator(commit_offset, generation));

        let next_source: Arc<dyn ByteSource> = Arc::new(CompositeSource::new(
            Arc::clone(&self.source),
            Arc::new(MemorySource::new(tail)),
        ));
        let mut next = ArchiveSnapshot::open(next_source)?;
        if self.encrypted() {
            next.data_key = self.data_key.clone();
            next.verify_encryption_authentication()?;
            for record in &written_records {
                let verified = next
                    .get_record(record.record_type, &record.id)?
                    .ok_or_else(|| {
                        CoreError::new(
                            "archive_write_verification_failed",
                            "The encrypted record could not be read back after writing.",
                        )
                    })?;
                let is_manifest = record.record_type == RecordType::SETTINGS
                    && record.id.eq_ignore_ascii_case(&self.header.id);
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
        }
        Ok(next)
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
    SECONDARY_INDEX_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn valid_uuid(value: &str) -> bool {
    crate::core::format::valid_uuid(value)
}

pub fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

pub fn is_supported_manifest(record: Option<&ArchiveRecord>) -> bool {
    let Some(record) = record else {
        return false;
    };
    if record.field("record_role") == Some("archive-manifest") {
        return true;
    }
    record.field("record_role") == Some("tutorux-session-package")
        && record.field("package_version") == Some("1")
        && valid_uuid(record.field("source_session_id").unwrap_or(""))
}

pub fn canonical_setting_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        .collect()
}

pub fn is_sensitive_setting_key(value: &str) -> bool {
    let normalized = canonical_setting_key(value);
    if CREDENTIAL_METADATA_FIELDS.contains(&normalized.as_str()) {
        return false;
    }
    if CREDENTIAL_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return true;
    }
    if !normalized.contains("token") {
        return false;
    }
    !NON_SECRET_TOKEN_SUFFIXES
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
}

pub fn is_credential_settings_record(record: &ArchiveRecord) -> bool {
    if record.record_type != RecordType::SETTINGS {
        return false;
    }
    let mut found_role = false;
    for (name, value) in &record.fields {
        if canonical_setting_key(name) != "recordrole" {
            continue;
        }
        found_role = true;
        if value.to_lowercase() != "credential" {
            return false;
        }
    }
    found_role
}

pub fn has_sensitive_credential_material(record: &ArchiveRecord) -> bool {
    if record.record_type != RecordType::SETTINGS {
        return false;
    }
    for (name, value) in &record.fields {
        if is_sensitive_setting_key(name) {
            return true;
        }
        if canonical_setting_key(name) == "key" && is_sensitive_setting_key(value) {
            return true;
        }
    }
    false
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

fn guide_cited_source_ids(record: &ArchiveRecord) -> BTreeSet<String> {
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

fn preserve_guide_source_history(
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

fn mark_guide_blocks_stale(record: &ArchiveRecord, source_id: &str) -> ArchiveRecord {
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
        now_us().to_string(),
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

pub fn encode_record_for_write(
    header: &ArchiveHeader,
    data_key: Option<&ArchiveDataKey>,
    record: &ArchiveRecord,
) -> Result<Vec<u8>> {
    let encrypted = header.capabilities & CAPABILITY_ENCRYPTED != 0;
    let is_metadata = record.id.eq_ignore_ascii_case(&header.id);
    let is_manifest = record.record_type == RecordType::SETTINGS && is_metadata;
    let is_encryption_metadata = record.record_type == RecordType::ENCRYPTION && is_metadata;
    let mut record_to_write = record.clone();
    if encrypted && is_manifest {
        let key = data_key.ok_or_else(|| {
            CoreError::new("archive_locked", "Unlock this archive before editing it.")
        })?;
        record_to_write.fields.remove("manifest_auth");
        let unsigned_payload = encode_record_payload(&record_to_write)?;
        let authentication = key.authenticate_bytes("TUTORUX-MANIFEST-V1", &unsigned_payload);
        record_to_write.fields.insert(
            "manifest_auth".to_owned(),
            authentication
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        );
    }
    let payload = encode_record_payload(&record_to_write)?;
    let can_compress = record_to_write.record_type != RecordType::ASSET_BLOB
        && (record_to_write.record_type != RecordType::AUDIO_CHUNK
            || record_to_write.field("codec") == Some("none"));
    let (codec, encoded_payload) = if can_compress {
        compress_record_payload(&payload)?
    } else {
        (0, payload)
    };
    let protect = encrypted && !is_manifest && !is_encryption_metadata;
    let (stored_payload, flags) = if protect {
        let key = data_key.ok_or_else(|| {
            CoreError::new("archive_locked", "Unlock this archive before editing it.")
        })?;
        (
            key.encrypt_record_payload(
                &encoded_payload,
                &RecordEncryptionContext {
                    archive_id: &header.id,
                    record_type: record_to_write.record_type,
                    record_id: &record_to_write.id,
                    revision: record_to_write.revision,
                    previous_offset: record_to_write.previous_offset,
                    codec,
                },
            )?,
            1,
        )
    } else {
        (encoded_payload, 0)
    };
    encode_record_frame(
        record_to_write.record_type,
        &record_to_write.id,
        record_to_write.revision,
        record_to_write.previous_offset,
        &stored_payload,
        codec,
        flags,
    )
}

pub fn encode_commit_payload(
    generation: u64,
    previous_offset: u64,
    root_offset: u64,
    root_hash: &[u8],
    transaction_id: &str,
    record_count: u64,
) -> Vec<u8> {
    let mut payload = vec![0u8; 92];
    payload[..4].copy_from_slice(b"TXCM");
    payload[4..6].copy_from_slice(&1u16.to_le_bytes());
    payload[8..16].copy_from_slice(&generation.to_le_bytes());
    payload[16..24].copy_from_slice(&previous_offset.to_le_bytes());
    payload[24..32].copy_from_slice(&root_offset.to_le_bytes());
    payload[32..64].copy_from_slice(root_hash);
    payload[64..80].copy_from_slice(
        &crate::core::format::uuid_to_bytes(transaction_id).expect("valid transaction id"),
    );
    payload[80..88].copy_from_slice(&record_count.to_le_bytes());
    payload[88..92].copy_from_slice(&1u32.to_le_bytes());
    payload
}

pub fn encode_locator(commit_offset: u64, generation: u64) -> Vec<u8> {
    let mut locator = vec![0u8; LOCATOR_SIZE as usize];
    locator[..8].copy_from_slice(b"TUXLOC1\0");
    locator[8..16].copy_from_slice(&commit_offset.to_le_bytes());
    locator[16..24].copy_from_slice(&generation.to_le_bytes());
    let checksum = crate::core::format::crc32(&locator[..24]);
    locator[24..28].copy_from_slice(&checksum.to_le_bytes());
    locator
}

pub fn create_archive_bytes(
    display_name: &str,
    description: &str,
    created_at_us: u64,
) -> Result<Vec<u8>> {
    if display_name.trim().is_empty() {
        return err("archive_name_invalid", "Archive name must not be empty.");
    }
    let header = ArchiveHeader {
        id: new_uuid(),
        major_version: 1,
        minor_version: 0,
        created_at_us,
        capabilities: 0,
    };
    let encoded_header = encode_archive_header(&header);
    let empty_root_payload = encode_index_page(&crate::core::index::IndexPage {
        leaf: true,
        entries: Vec::new(),
        separators: Vec::new(),
        children: Vec::new(),
    })?;
    let empty_root = encode_record_frame(
        RecordType::INDEX_PAGE,
        ZERO_UUID,
        1,
        0,
        &empty_root_payload,
        0,
        0,
    )?;
    let manifest = ArchiveRecord {
        record_type: RecordType::SETTINGS,
        id: header.id.clone(),
        revision: 1,
        previous_offset: 0,
        fields: BTreeMap::from([
            ("record_role".to_owned(), "archive-manifest".to_owned()),
            ("display_name".to_owned(), display_name.to_owned()),
            ("description".to_owned(), description.to_owned()),
            ("student_count".to_owned(), "0".to_owned()),
            ("session_count".to_owned(), "0".to_owned()),
            ("created_at_us".to_owned(), created_at_us.to_string()),
        ]),
        blob: Vec::new(),
    };
    let manifest_offset = ARCHIVE_HEADER_SIZE + empty_root.len() as u64;
    let manifest_payload = encode_record_payload(&manifest)?;
    let manifest_frame = encode_record_frame(
        manifest.record_type,
        &manifest.id,
        manifest.revision,
        manifest.previous_offset,
        &manifest_payload,
        0,
        0,
    )?;
    let root_payload = encode_index_page(&crate::core::index::IndexPage {
        leaf: true,
        entries: vec![(
            primary_index_key(RecordType::SETTINGS, &header.id),
            manifest_offset,
        )],
        separators: Vec::new(),
        children: Vec::new(),
    })?;
    let root_offset = manifest_offset + manifest_frame.len() as u64;
    let root_frame =
        encode_record_frame(RecordType::INDEX_PAGE, ZERO_UUID, 1, 0, &root_payload, 0, 0)?;
    let root_hash = sha256(&root_payload);
    let commit_offset = root_offset + root_frame.len() as u64;
    let transaction_id = new_uuid();
    let commit_payload = encode_commit_payload(1, 0, root_offset, &root_hash, &transaction_id, 1);
    let commit_frame =
        encode_record_frame(RecordType::COMMIT, ZERO_UUID, 1, 0, &commit_payload, 0, 0)?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&encoded_header);
    bytes.extend_from_slice(&empty_root);
    bytes.extend_from_slice(&manifest_frame);
    bytes.extend_from_slice(&root_frame);
    bytes.extend_from_slice(&commit_frame);
    bytes.extend_from_slice(&encode_locator(commit_offset, 1));
    Ok(bytes)
}

pub fn create_encrypted_archive_bytes(
    display_name: &str,
    description: &str,
    passphrase: &str,
    created_at_us: u64,
) -> Result<Vec<u8>> {
    if display_name.trim().is_empty() {
        return err("archive_name_invalid", "Archive name must not be empty.");
    }
    let header = ArchiveHeader {
        id: new_uuid(),
        major_version: 1,
        minor_version: 0,
        created_at_us,
        capabilities: CAPABILITY_ENCRYPTED,
    };
    let encoded_header = encode_archive_header(&header);
    let data_key = ArchiveDataKey::create_random();
    let envelope = wrap_data_key(passphrase, &data_key, &header.id)?;
    let empty_root_payload = encode_index_page(&crate::core::index::IndexPage {
        leaf: true,
        entries: Vec::new(),
        separators: Vec::new(),
        children: Vec::new(),
    })?;
    let mut empty_root_payload_authenticated = empty_root_payload.clone();
    empty_root_payload_authenticated.extend_from_slice(
        &data_key.authenticate_bytes("TUTORUX-INDEX-PAGE-V1", &empty_root_payload),
    );
    let empty_root = encode_record_frame(
        RecordType::INDEX_PAGE,
        ZERO_UUID,
        1,
        0,
        &empty_root_payload_authenticated,
        0,
        0,
    )?;
    let encryption_record = envelope_to_record(&envelope, &header.id)?;
    let encryption_payload = encode_record_payload(&encryption_record)?;
    let encryption_frame = encode_record_frame(
        encryption_record.record_type,
        &encryption_record.id,
        encryption_record.revision,
        encryption_record.previous_offset,
        &encryption_payload,
        0,
        0,
    )?;
    let mut manifest = ArchiveRecord {
        record_type: RecordType::SETTINGS,
        id: header.id.clone(),
        revision: 1,
        previous_offset: 0,
        fields: BTreeMap::from([
            ("record_role".to_owned(), "archive-manifest".to_owned()),
            ("display_name".to_owned(), display_name.to_owned()),
            ("description".to_owned(), description.to_owned()),
            ("student_count".to_owned(), "0".to_owned()),
            ("session_count".to_owned(), "0".to_owned()),
            ("created_at_us".to_owned(), created_at_us.to_string()),
        ]),
        blob: Vec::new(),
    };
    let manifest_authentication =
        data_key.authenticate_bytes("TUTORUX-MANIFEST-V1", &encode_record_payload(&manifest)?);
    manifest.fields.insert(
        "manifest_auth".to_owned(),
        manifest_authentication
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    );
    let manifest_payload = encode_record_payload(&manifest)?;
    let manifest_frame = encode_record_frame(
        manifest.record_type,
        &manifest.id,
        manifest.revision,
        manifest.previous_offset,
        &manifest_payload,
        0,
        0,
    )?;
    let encryption_offset = ARCHIVE_HEADER_SIZE + empty_root.len() as u64;
    let manifest_offset = encryption_offset + encryption_frame.len() as u64;
    let root_offset = manifest_offset + manifest_frame.len() as u64;
    let mut entries = vec![
        (
            primary_index_key(RecordType::ENCRYPTION, &header.id),
            encryption_offset,
        ),
        (
            primary_index_key(RecordType::SETTINGS, &header.id),
            manifest_offset,
        ),
    ];
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let tree = build_index_tree(
        &entries,
        root_offset,
        Some(&|payload| data_key.authenticate_bytes("TUTORUX-INDEX-PAGE-V1", payload)),
    )?;
    let transaction_id = new_uuid();
    let commit_body = encode_commit_payload(
        1,
        0,
        tree.root_offset,
        &sha256(&tree.root_payload),
        &transaction_id,
        2,
    );
    let mut commit_payload = commit_body.clone();
    commit_payload
        .extend_from_slice(&data_key.authenticate_bytes("TUTORUX-COMMIT-V1", &commit_body));
    let commit_offset = tree.end_offset;
    let commit_frame =
        encode_record_frame(RecordType::COMMIT, ZERO_UUID, 1, 0, &commit_payload, 0, 0)?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&encoded_header);
    bytes.extend_from_slice(&empty_root);
    bytes.extend_from_slice(&encryption_frame);
    bytes.extend_from_slice(&manifest_frame);
    for frame in &tree.frames {
        bytes.extend_from_slice(frame);
    }
    bytes.extend_from_slice(&commit_frame);
    bytes.extend_from_slice(&encode_locator(commit_offset, 1));
    Ok(bytes)
}

fn valid_locator(locator: &[u8]) -> bool {
    locator.len() == LOCATOR_SIZE as usize
        && &locator[..8] == b"TUXLOC1\0"
        && crate::core::format::crc32(&locator[..24])
            == u32::from_le_bytes([locator[24], locator[25], locator[26], locator[27]])
        && locator[28..32].iter().all(|byte| *byte == 0)
}

pub fn decode_commit(source: &dyn ByteSource, offset: u64) -> Result<CommitInfo> {
    let frame = read_frame_at(source, offset)?;
    let payload = decode_stored_payload(frame.codec, frame.flags, &frame.stored_payload)?;
    if frame.record_type != RecordType::COMMIT
        || frame.id != ZERO_UUID
        || (payload.len() != 92 && payload.len() != 124)
        || &payload[..4] != b"TXCM"
    {
        return err("commit_invalid", "Commit record has an invalid structure.");
    }
    let version = u16::from_le_bytes([payload[4], payload[5]]);
    let reserved = u16::from_le_bytes([payload[6], payload[7]]);
    let generation = u64::from_le_bytes(payload[8..16].try_into().unwrap());
    let previous_offset = u64::from_le_bytes(payload[16..24].try_into().unwrap());
    let root_offset = u64::from_le_bytes(payload[24..32].try_into().unwrap());
    let root_hash = payload[32..64].to_vec();
    let transaction_id = uuid_from_bytes(&payload[64..80])?;
    let record_count = u64::from_le_bytes(payload[80..88].try_into().unwrap());
    let archive_version = u32::from_le_bytes(payload[88..92].try_into().unwrap());
    if version != 1
        || reserved != 0
        || generation == 0
        || archive_version != 1
        || frame.revision != generation
        || frame.previous_offset != previous_offset
        || root_offset < ARCHIVE_HEADER_SIZE
        || root_offset >= offset
        || previous_offset >= offset
    {
        return err("commit_invalid", "Commit metadata is invalid.");
    }
    Ok(CommitInfo {
        generation,
        offset,
        previous_offset,
        root_offset,
        root_hash,
        transaction_id,
        record_count,
    })
}

fn locator_matches(locator: &[u8], commit: &CommitInfo) -> bool {
    valid_locator(locator)
        && u64::from_le_bytes(locator[8..16].try_into().unwrap()) == commit.offset
        && u64::from_le_bytes(locator[16..24].try_into().unwrap()) == commit.generation
}

/// End of a commit's publication locator, tolerating crash bytes before the locator.
pub fn commit_published_end(source: &dyn ByteSource, commit: &CommitInfo) -> Result<u64> {
    let frame = read_frame_at(source, commit.offset)?;
    if frame.record_type != RecordType::COMMIT {
        return err(
            "archive_commit_invalid",
            "Commit offset points to a non-commit record.",
        );
    }
    let locator_offset = frame.end_offset;
    if source.size().saturating_sub(locator_offset) >= LOCATOR_SIZE {
        let locator = source.read(locator_offset, LOCATOR_SIZE as usize)?;
        if locator_matches(&locator, commit) {
            return Ok(locator_offset + LOCATOR_SIZE);
        }
    }
    let chunk_size = 64 * 1024u64;
    let mut position = locator_offset;
    while position + LOCATOR_SIZE <= source.size() {
        let length = (source.size() - position).min(chunk_size) as usize;
        let bytes = source.read(position, length)?;
        for index in 0..=bytes.len().saturating_sub(LOCATOR_SIZE as usize) {
            if &bytes[index..index + 8] != b"TUXLOC1\0" {
                continue;
            }
            let locator = &bytes[index..index + LOCATOR_SIZE as usize];
            if locator_matches(locator, commit) {
                return Ok(position + index as u64 + LOCATOR_SIZE);
            }
        }
        position += length as u64;
    }
    err(
        "archive_locator_invalid",
        "A commit publication locator is invalid or points to a different generation.",
    )
}

pub fn scan_commit_frame_offsets(source: &dyn ByteSource) -> Result<Vec<u64>> {
    let mut offsets = Vec::new();
    let chunk_size = 64 * 1024u64;
    let mut cursor = ARCHIVE_HEADER_SIZE;
    while cursor + 64 <= source.size() {
        let length = (source.size() - cursor).min(chunk_size + 63) as usize;
        let bytes = source.read(cursor, length)?;
        let mut local = 0usize;
        while local + 64 <= bytes.len() {
            if &bytes[local..local + 4] == b"TXRC" {
                let absolute = cursor + local as u64;
                if let Ok(frame) = read_frame_at(source, absolute) {
                    if frame.record_type == RecordType::COMMIT
                        && decode_commit(source, absolute).is_ok()
                    {
                        offsets.push(absolute);
                    }
                }
            }
            local += 8;
        }
        cursor += chunk_size;
    }
    offsets.sort_unstable();
    offsets.dedup();
    Ok(offsets)
}

fn scan_for_committed_root(
    source: &dyn ByteSource,
    search_start: u64,
    header: &ArchiveHeader,
) -> Result<Option<(CommitInfo, BTreeMap<String, u64>, u64)>> {
    let chunk_size = 64 * 1024u64;
    let mut chunk_end = source.size();
    while chunk_end > search_start {
        let chunk_start = if chunk_end - search_start > chunk_size {
            chunk_end - chunk_size
        } else {
            search_start
        };
        let read_start = if chunk_start - search_start > LOCATOR_SIZE - 1 {
            chunk_start - (LOCATOR_SIZE - 1)
        } else {
            search_start
        };
        let bytes = source.read(read_start, (chunk_end - read_start) as usize)?;
        if bytes.len() >= LOCATOR_SIZE as usize {
            let mut index = bytes.len() - LOCATOR_SIZE as usize;
            loop {
                let candidate_offset = read_start + index as u64;
                if candidate_offset >= chunk_start && &bytes[index..index + 8] == b"TUXLOC1\0" {
                    let locator = &bytes[index..index + LOCATOR_SIZE as usize];
                    if valid_locator(locator) {
                        let commit_offset = u64::from_le_bytes(locator[8..16].try_into().unwrap());
                        let generation = u64::from_le_bytes(locator[16..24].try_into().unwrap());
                        if commit_offset >= ARCHIVE_HEADER_SIZE && commit_offset < candidate_offset
                        {
                            if let Ok(commit) = decode_commit(source, commit_offset) {
                                if commit.generation == generation {
                                    if let Ok(Some((consistent, index))) =
                                        find_consistent_commit(source, header, commit.clone())
                                    {
                                        if consistent.offset == commit.offset {
                                            return Ok(Some((
                                                consistent,
                                                index,
                                                candidate_offset + LOCATOR_SIZE,
                                            )));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if index == 0 {
                    break;
                }
                index -= 1;
            }
        }
        chunk_end = chunk_start;
    }
    Ok(None)
}

pub fn find_consistent_commit(
    source: &dyn ByteSource,
    header: &ArchiveHeader,
    first: CommitInfo,
) -> Result<Option<(CommitInfo, BTreeMap<String, u64>)>> {
    let mut commit = Some(first);
    for _ in 0..1024 {
        let Some(current) = commit else {
            return Ok(None);
        };
        let valid_chain = if current.previous_offset == 0 {
            current.generation == 1
        } else {
            decode_commit(source, current.previous_offset)
                .map(|previous| previous.generation + 1 == current.generation)
                .unwrap_or(false)
        };
        if !valid_chain {
            commit = if current.previous_offset == 0 {
                None
            } else {
                decode_commit(source, current.previous_offset).ok()
            };
            continue;
        }
        let root_result = read_frame_at(source, current.root_offset).and_then(|root_frame| {
            if root_frame.record_type != RecordType::INDEX_PAGE
                || sha256(&root_frame.stored_payload) != current.root_hash
            {
                return Err(CoreError::new(
                    "commit_invalid",
                    "Commit root hash does not match its index page.",
                ));
            }
            let encrypted = header.capabilities & CAPABILITY_ENCRYPTED != 0;
            read_index_tree(source, current.offset, current.root_offset, encrypted, None)
        });
        match root_result {
            Ok(index) => return Ok(Some((current, index))),
            Err(_) => {
                commit = if current.previous_offset == 0 {
                    None
                } else {
                    decode_commit(source, current.previous_offset).ok()
                };
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_archive_round_trips() {
        let bytes = create_archive_bytes("Test archive", "", 1).unwrap();
        let snapshot = ArchiveSnapshot::open_bytes(bytes).unwrap();
        assert_eq!(
            snapshot.get_manifest().unwrap().display_name,
            "Test archive"
        );
        let updated = snapshot
            .append_records(&[ArchiveRecord::new(
                RecordType::STUDENT,
                new_uuid(),
                [("display_name", "Mina")],
            )])
            .unwrap();
        assert_eq!(updated.get_manifest().unwrap().display_name, "Test archive");
    }

    #[test]
    fn encrypted_archive_round_trips() {
        let passphrase = "a sufficiently long passphrase";
        let bytes = create_encrypted_archive_bytes("Secret archive", "", passphrase, 1).unwrap();
        let locked = ArchiveSnapshot::open_bytes(bytes).unwrap();
        assert!(locked.locked());
        let unlocked = locked.unlock(passphrase).unwrap();
        assert_eq!(
            unlocked.get_manifest().unwrap().display_name,
            "Secret archive"
        );
    }

    #[test]
    fn reads_typescript_encrypted_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("encrypted-v1.tux");
        let bytes = std::fs::read(path).expect("fixture exists");
        let locked = ArchiveSnapshot::open_bytes(bytes).expect("fixture opens");
        assert!(locked.locked());
        let unlocked = locked
            .unlock("Tutorux cross-language fixture phrase 2026")
            .expect("fixture unlocks");
        let result = unlocked.verify().expect("fixture verifies");
        assert_eq!(result.current_records, 3);
        let students = unlocked
            .list_records(RecordType::STUDENT, true)
            .expect("students list");
        assert_eq!(students.len(), 1);
        assert_eq!(students[0].field("display_name"), Some("Interop Student"));
    }
}
