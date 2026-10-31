mod backfill;
mod common;
mod compact;
mod encryption;
mod header;
mod rebuild;
mod rebuild_index;
mod recovery;
mod repair;
mod retained;
mod trash;
mod types;

pub use backfill::{backfill_archive_secondary_indexes, backfill_secondary_indexes};
pub use compact::{compact_archive, compact_archive_result, compact_archive_with_options};
pub use encryption::{change_passphrase, enable_encryption};
pub use header::{recover_checksum_damaged_archive_header, recover_magic_damaged_archive_header};
pub use rebuild::rebuild_archive;
pub use rebuild_index::rebuild_damaged_primary_index;
pub use recovery::{discard_tail, inspect_recovery, inspect_recovery_source, recover_unpublished};
pub use repair::{repair_archive, repair_archive_result};
pub use trash::{plan_trash_purge, purge_trashed_archive_bytes, purge_trashed_archive_snapshot};
pub use types::{
    ArchiveRepairResult, ArchiveTrashPurgePlan, BackfillResult, CompactionOptions,
    CompactionResult, RecoveryInspection, TrashPurgeBlocker, TrashPurgeReference,
};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_more;
