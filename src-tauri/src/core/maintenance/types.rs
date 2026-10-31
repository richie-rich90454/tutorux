use crate::core::archive::ArchiveSnapshot;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CompactionOptions {
    pub prune_unreferenced_assets: bool,
    pub purge_deleted_records: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionResult {
    pub bytes: Vec<u8>,
    pub original_bytes: u64,
    pub compacted_bytes: u64,
    pub preserved_records: usize,
    pub pruned_asset_records: usize,
    pub purge_removed_records: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveRepairResult {
    pub bytes: Vec<u8>,
    pub original_bytes: u64,
    pub compacted_bytes: u64,
    pub preserved_records: usize,
    pub pruned_asset_records: usize,
    pub purge_removed_records: usize,
    pub selected_generation: u64,
    pub discarded_trailing_bytes: u64,
    pub discarded_region_start: u64,
    pub discarded_region_end: u64,
    pub discarded_record_frames: usize,
    pub discarded_record_frame_bytes: u64,
    pub unattributed_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryInspection {
    pub archive_header_valid: bool,
    pub recovery_assessment_complete: bool,
    pub header_repair_candidate: bool,
    pub header_repair_available: bool,
    pub header_repair_generation: u64,
    pub committed_generation: u64,
    pub candidate_generation: u64,
    pub recoverable_generation: u64,
    pub trailing_bytes: u64,
    pub has_unpublished_commit: bool,
    pub encrypted: bool,
    pub requires_passphrase: bool,
    pub locked: bool,
    pub recoverable: bool,
    pub recovered_generations: usize,
    pub discarded_trailing_bytes: u64,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct BackfillResult {
    pub snapshot: ArchiveSnapshot,
    pub added_entries: usize,
    pub conflicting_entries: usize,
    pub schema_versions_updated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashPurgeReference {
    pub record_id: String,
    pub record_type: String,
    pub label: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashPurgeBlocker {
    pub record_id: String,
    pub record_type: String,
    pub label: String,
    pub references: Vec<TrashPurgeReference>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveTrashPurgePlan {
    pub generation: u64,
    pub deleted_records: usize,
    pub blockers: Vec<TrashPurgeBlocker>,
    pub opaque_records: usize,
}
