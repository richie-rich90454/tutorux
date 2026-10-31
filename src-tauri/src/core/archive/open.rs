use std::collections::BTreeMap;
use std::sync::Arc;

use crate::core::crypto::{envelope_from_record, unwrap_data_key};
use crate::core::error::{err, CoreError, Result};
use crate::core::format::{
    decode_archive_header, decode_stored_payload, ArchiveHeader, RecordType, ARCHIVE_HEADER_SIZE,
};
use crate::core::index::{read_frame_at, read_index_tree};
use crate::core::source::ByteSource;

use super::commit::{decode_commit, scan_commit_frame_offsets, valid_locator};
use super::support::sha256;
use super::ArchiveSnapshot;
use super::{CommitInfo, LOCATOR_SIZE, RECOVERY_WINDOW};

impl ArchiveSnapshot {
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
        Self::open(Arc::new(crate::core::source::MemorySource::new(bytes)))
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
        let key = unwrap_data_key(passphrase, &envelope, &self.header.id)?;
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

    pub(crate) fn verify_encryption_authentication(&self) -> Result<()> {
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
                super::find_consistent_commit(source.as_ref(), &header, commit)
            else {
                continue;
            };
            if consistent.offset != offset {
                continue;
            }
            let published_end_offset = super::commit_published_end(source.as_ref(), &consistent)
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
                                        super::find_consistent_commit(
                                            source,
                                            header,
                                            commit.clone(),
                                        )
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
