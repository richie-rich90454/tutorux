use std::collections::BTreeMap;
use std::sync::Arc;

use crate::core::crypto::ArchiveDataKey;
use crate::core::error::Result;
use crate::core::source::ByteSource;

mod append;
mod append_prepare;
mod append_write;
mod audio;
mod commit;
mod create;
mod encode;
mod indexes;
mod open;
mod read;
mod staged;
mod support;

pub use commit::{
    commit_published_end, decode_commit, encode_commit_payload, encode_locator,
    find_consistent_commit, scan_commit_frame_offsets,
};
pub use create::{create_archive_bytes, create_encrypted_archive_bytes};
pub use encode::encode_record_for_write;
pub use indexes::{
    is_guide_source_record, is_secondary_index_prefix, primary_key, secondary_index_keys,
};
pub use staged::{append_staged_asset_records, ArchiveStaging};
pub use support::*;

pub use crate::core::format::{ArchiveHeader, ArchiveRecord, RecordFrame, RecordType, ZERO_UUID};

pub(crate) use indexes::{audio_session_index_key, secondary_index_migrations};
pub(crate) use support::SECONDARY_INDEX_PREFIXES;

pub mod verify {
    pub use crate::core::verify::*;
}

pub use crate::core::verify::{
    verify_full, verify_history, FullVerificationResult, HistoryVerificationResult,
};

const LOCATOR_SIZE: u64 = 32;
const RECOVERY_WINDOW: u64 = 64 * 1024 * 1024;

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
    pub header: crate::core::format::ArchiveHeader,
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
        self.header.capabilities & crate::core::format::CAPABILITY_ENCRYPTED != 0
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

    pub fn lock(&mut self) {
        self.data_key = None;
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_append;
