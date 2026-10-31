use std::collections::BTreeSet;

use crate::core::archive::ArchiveSnapshot;
use crate::core::crypto::envelope_from_record;
use crate::core::error::{err, CoreError, Result};
use crate::core::format::RecordType;
use crate::core::index::primary_index_key;

use super::common::{apply_index_version_flags, require_clean_tail, require_valid_full};
use super::rebuild::rebuild_and_verify;
use super::retained::{collect_retained_chains, prune_unreferenced_assets, remove_deleted_chains};
use super::types::{CompactionOptions, CompactionResult};

pub(crate) fn compact_archive_internal(
    snapshot: &ArchiveSnapshot,
    allow_unpublished_tail: bool,
    options: &CompactionOptions,
) -> Result<CompactionResult> {
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before compacting it.",
        );
    }
    if !allow_unpublished_tail {
        require_clean_tail(snapshot)?;
    }
    snapshot.get_manifest()?;
    require_valid_full(snapshot, "archive_compaction_source_invalid")?;
    let mut chains = collect_retained_chains(snapshot)?;
    if !chains
        .iter()
        .any(|chain| chain.key == primary_index_key(RecordType::SETTINGS, &snapshot.header.id))
    {
        return err(
            "archive_compaction_primary_index_missing",
            "The archive has no primary records to compact.",
        );
    }
    let mut removed_offsets: BTreeSet<u64> = BTreeSet::new();
    let mut purge_removed_records = 0usize;
    if options.purge_deleted_records {
        let (removed, offsets) = remove_deleted_chains(&mut chains);
        purge_removed_records = removed;
        removed_offsets.extend(offsets);
    }
    let mut pruned_asset_records = 0usize;
    if options.prune_unreferenced_assets {
        let (pruned, offsets) = prune_unreferenced_assets(&mut chains)?;
        pruned_asset_records = pruned;
        removed_offsets.extend(offsets);
    }
    apply_index_version_flags(&mut chains, &snapshot.header.id)?;
    let preserved_records = chains.iter().map(|chain| chain.revisions.len()).sum();
    let envelope = if snapshot.encrypted() {
        let record = snapshot
            .get_record(RecordType::ENCRYPTION, &snapshot.header.id)?
            .ok_or_else(|| {
                CoreError::new(
                    "archive_encryption_metadata_missing",
                    "Encrypted archive is missing its key-wrapping metadata.",
                )
            })?;
        Some(envelope_from_record(&record, &snapshot.header.id)?)
    } else {
        None
    };
    let (bytes, compacted) = rebuild_and_verify(
        &snapshot.header,
        chains,
        Some(snapshot.all_index_entries()),
        &removed_offsets,
        snapshot.data_key(),
        snapshot.data_key(),
        envelope.as_ref(),
        "archive_compaction_verification_failed",
    )?;
    debug_assert_eq!(compacted.commit.generation, 1);
    Ok(CompactionResult {
        original_bytes: snapshot.source.size(),
        compacted_bytes: bytes.len() as u64,
        preserved_records,
        pruned_asset_records,
        purge_removed_records,
        bytes,
    })
}

pub fn compact_archive(snapshot: &ArchiveSnapshot) -> Result<Vec<u8>> {
    Ok(compact_archive_internal(snapshot, false, &CompactionOptions::default())?.bytes)
}

pub fn compact_archive_result(snapshot: &ArchiveSnapshot) -> Result<CompactionResult> {
    compact_archive_internal(snapshot, false, &CompactionOptions::default())
}

pub fn compact_archive_with_options(
    snapshot: &ArchiveSnapshot,
    options: &CompactionOptions,
) -> Result<CompactionResult> {
    compact_archive_internal(snapshot, false, options)
}
