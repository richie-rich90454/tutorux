use std::collections::{BTreeMap, BTreeSet};

use crate::core::format::ArchiveRecord;

#[derive(Debug, Clone, Default)]
pub struct SanitizedCopyOptions {
    pub include_students: BTreeSet<String>,
    pub exclude_students: BTreeSet<String>,
    pub include_sessions: BTreeSet<String>,
    pub exclude_sessions: BTreeSet<String>,
    pub include_recording_tracks: BTreeSet<String>,
    pub exclude_recording_tracks: BTreeSet<String>,
    pub include_recordings: bool,
    pub include_private_annotations: bool,
    pub include_generation_logs: bool,
    pub include_credentials: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SanitizedCopySummary {
    pub source_generation: u64,
    pub selection_fingerprint: String,
    pub students: usize,
    pub sessions: usize,
    pub annotations: usize,
    pub assets: usize,
    pub evidence_items: usize,
    pub guides: usize,
    pub recording_tracks: usize,
    pub recordings: usize,
    pub generation_logs: usize,
    pub credentials: usize,
}

#[derive(Debug, Clone)]
pub struct SanitizedCopyResult {
    pub snapshot: crate::core::archive::ArchiveSnapshot,
    pub summary: SanitizedCopySummary,
}

#[derive(Debug, Clone)]
pub struct SanitizedCopyPlan {
    pub(crate) metadata: BTreeMap<u16, Vec<ArchiveRecord>>,
    pub(crate) keep: BTreeMap<u16, BTreeSet<String>>,
    pub(crate) metadata_updates: BTreeMap<String, ArchiveRecord>,
    pub(crate) source_recording_tracks_by_session: BTreeMap<String, BTreeSet<String>>,
    pub(crate) recording_tracks_by_session: BTreeMap<String, BTreeSet<String>>,
    pub(crate) recording_chunks_by_session: BTreeMap<String, usize>,
    pub(crate) source_manifest_id: String,
    pub(crate) retained_notes: BTreeSet<String>,
    pub(crate) encrypted_source: bool,
    pub summary: SanitizedCopySummary,
}

impl SanitizedCopyPlan {
    pub(crate) fn records(&self, record_type: u16) -> &[ArchiveRecord] {
        self.metadata
            .get(&record_type)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub(crate) fn keep_set(&mut self, record_type: u16) -> &mut BTreeSet<String> {
        self.keep.entry(record_type).or_default()
    }

    pub(crate) fn kept(&self, record_type: u16) -> &BTreeSet<String> {
        static EMPTY: BTreeSet<String> = BTreeSet::new();
        self.keep.get(&record_type).unwrap_or(&EMPTY)
    }

    pub(crate) fn has_kept(&self, record_type: u16, id: &str) -> bool {
        parse_uuid(id)
            .map(|id| self.kept(record_type).contains(&id))
            .unwrap_or(false)
    }
}

pub(crate) fn parse_uuid(value: &str) -> Option<String> {
    let id = value.to_lowercase();
    if crate::core::format::valid_uuid(&id) {
        Some(id)
    } else {
        None
    }
}

pub(crate) fn lower(value: &str) -> String {
    value.to_lowercase()
}

pub(crate) fn field(record: &ArchiveRecord, name: &str) -> String {
    record.field(name).unwrap_or("").to_owned()
}

pub(crate) fn active(record: &ArchiveRecord) -> bool {
    record.field("_deleted") != Some("true")
}

pub(crate) fn split_ids(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .collect()
}
