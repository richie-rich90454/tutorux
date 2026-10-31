use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::core::archive::{decode_commit, scan_commit_frame_offsets, ArchiveSnapshot};
use crate::core::cli::{
    emit, open_archive, require_unlocked, resolve_path, CliContext, CliError, CliOutput, CliResult,
    ParsedArguments,
};
use crate::core::maintenance::{
    backfill_archive_secondary_indexes, compact_archive_with_options, plan_trash_purge,
    purge_trashed_archive_snapshot, rebuild_damaged_primary_index,
    recover_checksum_damaged_archive_header, recover_magic_damaged_archive_header,
    recover_unpublished, repair_archive_result, CompactionOptions,
};
use crate::core::source::{ByteSource, FileSource};

use super::helpers::{count_history, read_bytes, same_path};
use super::save;

fn unlock_for_cli(
    snapshot: ArchiveSnapshot,
    passphrase: Option<&str>,
    message: &str,
) -> CliResult<ArchiveSnapshot> {
    if !snapshot.locked() {
        return Ok(snapshot);
    }
    let passphrase = passphrase.ok_or_else(|| CliError(message.to_owned()))?;
    Ok(snapshot.unlock(passphrase)?)
}

fn verify_output(bytes: &[u8], passphrase: Option<&str>, message: &str) -> CliResult<()> {
    let snapshot = unlock_for_cli(
        ArchiveSnapshot::open_bytes(bytes.to_vec())?,
        passphrase,
        message,
    )?;
    snapshot.verify_authenticated()?;
    snapshot.verify()?;
    Ok(())
}

fn recover_damaged_header(
    source: Arc<dyn ByteSource>,
    passphrase: Option<&str>,
    magic: bool,
) -> CliResult<ArchiveSnapshot> {
    let recovered = if magic {
        recover_magic_damaged_archive_header(source, passphrase)
    } else {
        recover_checksum_damaged_archive_header(source, passphrase)
    };
    match recovered {
        Ok(snapshot) => Ok(snapshot),
        Err(error) if error.code == "archive_locked" => Err(CliError(
            "This archive is encrypted. Provide --passphrase-env to repair a copy.".to_owned(),
        )
        .into()),
        Err(error) => Err(error.into()),
    }
}

fn source_generation(source: &dyn ByteSource) -> u64 {
    scan_commit_frame_offsets(source)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|offset| decode_commit(source, offset).ok())
        .map(|commit| commit.generation)
        .max()
        .unwrap_or(0)
}

pub(super) fn compact(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = require_unlocked(&open_archive(path, context.passphrase())?)?;
    let result = compact_archive_with_options(
        &snapshot,
        &CompactionOptions {
            prune_unreferenced_assets: args.flag("prune-unreferenced-assets"),
            purge_deleted_records: false,
        },
    )?;
    let applied = !args.flag("preview");
    let compacted = ArchiveSnapshot::open_bytes(result.bytes.clone())?;
    let previous_generation = snapshot.commit.generation;
    let compacted_generation = compacted.commit.generation;
    drop(compacted);
    drop(snapshot);
    if applied {
        save::save_bytes(path, &result.bytes)?;
    }
    let value = json!({
        "path": path.display().to_string(),
        "generation": previous_generation.to_string(),
        "compactedGeneration": compacted_generation.to_string(),
        "originalBytes": result.original_bytes.to_string(),
        "compactedBytes": result.compacted_bytes.to_string(),
        "bytesSaved": result.original_bytes.saturating_sub(result.compacted_bytes).to_string(),
        "recordsPreserved": result.preserved_records,
        "prunedAssetRecords": result.pruned_asset_records,
        "applied": applied,
    });
    let summary = if applied {
        format!(
            "Compacted {} from {} to {} bytes; pruned {} unreferenced asset records.",
            path.display(),
            result.original_bytes,
            result.compacted_bytes,
            result.pruned_asset_records
        )
    } else {
        format!(
            "Compaction preview: {} would shrink from {} to {} bytes and prune {} unreferenced asset records.",
            path.display(),
            result.original_bytes,
            result.compacted_bytes,
            result.pruned_asset_records
        )
    };
    emit(output, value, &summary, args.json());
    Ok(0)
}

pub(super) fn backfill(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = require_unlocked(&open_archive(path, context.passphrase())?)?;
    let result = backfill_archive_secondary_indexes(&snapshot)?;
    let applied = args.flag("apply");
    let previous_generation = snapshot.commit.generation;
    let resulting_generation = result.snapshot.commit.generation;
    let pending = if applied && (result.added_entries > 0 || result.schema_versions_updated) {
        Some(read_bytes(&result.snapshot)?)
    } else {
        None
    };
    drop(snapshot);
    if let Some(bytes) = pending {
        save::save_bytes(path, &bytes)?;
    }
    let value = json!({
        "path": path.display().to_string(),
        "previousGeneration": previous_generation.to_string(),
        "resultingGeneration": resulting_generation.to_string(),
        "addedEntries": result.added_entries,
        "conflictingEntries": result.conflicting_entries,
        "schemaVersionsUpdated": result.schema_versions_updated,
        "applied": applied,
    });
    let summary = format!(
        "{} missing secondary index entries; {} existing conflicting aliases preserved; {}.",
        result.added_entries,
        result.conflicting_entries,
        if result.schema_versions_updated {
            "schema versions updated"
        } else {
            "schema versions unchanged"
        }
    );
    let summary = if applied {
        format!("Index migration complete: {summary}")
    } else {
        format!("Index migration preview: {summary} Add --apply to publish changes.")
    };
    emit(output, value, &summary, args.json());
    Ok(0)
}

pub(super) fn repair(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    if !args.flag("confirm-sensitive") {
        return Err(CliError(
            "A repaired copy contains student records, recordings, annotations, and credentials. Review the destination and retry with --confirm-sensitive."
                .to_owned(),
        )
        .into());
    }
    let destination = resolve_path(args.required_option("output")?);
    if !destination
        .extension()
        .map(|extension| extension.eq_ignore_ascii_case("tux"))
        .unwrap_or(false)
    {
        return Err(CliError(
            "Repaired archive copies must use the .tux extension.".to_owned(),
        )
        .into());
    }
    if same_path(path, &destination) {
        return Err(CliError(
            "Repaired output must be a separate archive copy.".to_owned(),
        )
        .into());
    }
    let passphrase = context.passphrase();
    let source: Arc<dyn ByteSource> = Arc::new(FileSource::open(path)?);
    let (snapshot, reconstructed_header) = match ArchiveSnapshot::open_for_recovery(Arc::clone(&source))
    {
        Ok(snapshot) => (snapshot, false),
        Err(error) if error.code == "archive_header_checksum" => (
            recover_damaged_header(Arc::clone(&source), passphrase, false)?,
            true,
        ),
        Err(error) if error.code == "archive_magic_invalid" => (
            recover_damaged_header(Arc::clone(&source), passphrase, true)?,
            true,
        ),
        Err(error) => return Err(error.into()),
    };
    let snapshot = unlock_for_cli(
        snapshot,
        passphrase,
        "This archive is encrypted. Provide --passphrase-env to repair a copy.",
    )?;
    let original_bytes = snapshot.source.size();
    let mut repair_source = snapshot.clone();
    let mut recovered_tail_bytes = 0u64;
    if reconstructed_header && snapshot.source.size() > snapshot.published_end_offset {
        if let Ok((bytes, _generation, _generations, discarded)) = recover_unpublished(&snapshot) {
            if let Ok(recovered) = ArchiveSnapshot::open_bytes(bytes) {
                if let Ok(recovered) = unlock_for_cli(
                    recovered,
                    passphrase,
                    "This archive is encrypted. Provide --passphrase-env to repair a copy.",
                ) {
                    repair_source = recovered;
                    recovered_tail_bytes = discarded;
                }
            }
        }
    }
    let result = repair_archive_result(&repair_source)?;
    verify_output(
        &result.bytes,
        passphrase,
        "This repaired copy is encrypted. Provide --passphrase-env to verify it.",
    )?;
    save::write_new_archive(&destination, &result.bytes)?;
    let discarded_bytes = result.discarded_trailing_bytes + recovered_tail_bytes;
    let value = json!({
        "path": path.display().to_string(),
        "output": destination.display().to_string(),
        "status": "repaired-copy",
        "original_preserved": true,
        "selected_verified_generation": result.selected_generation.to_string(),
        "discarded_bytes": discarded_bytes.to_string(),
        "discarded_region_start": result.discarded_region_start.to_string(),
        "discarded_region_end": result.discarded_region_end.to_string(),
        "discarded_record_frames": result.discarded_record_frames,
        "discarded_record_frame_bytes": result.discarded_record_frame_bytes.to_string(),
        "unattributed_bytes": result.unattributed_bytes.to_string(),
        "original_bytes": original_bytes.to_string(),
        "compacted_bytes": result.compacted_bytes.to_string(),
        "records_preserved": result.preserved_records,
    });
    emit(
        output,
        value,
        &format!(
            "Validated repair copy created at {}; the original archive was preserved. Selected verified generation {}; discarded {} source bytes.",
            destination.display(),
            result.selected_generation,
            discarded_bytes
        ),
        args.json(),
    );
    Ok(0)
}

pub(super) fn rebuild_index(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    _context: &CliContext,
) -> CliResult<i32> {
    if !args.flag("confirm-sensitive") {
        return Err(CliError(
            "An index-rebuilt copy contains private archive records. Review the destination and retry with --confirm-sensitive."
                .to_owned(),
        )
        .into());
    }
    let destination = resolve_path(args.required_option("output")?);
    if !destination
        .extension()
        .map(|extension| extension.eq_ignore_ascii_case("tux"))
        .unwrap_or(false)
    {
        return Err(CliError(
            "Index-rebuilt archive copies must use the .tux extension.".to_owned(),
        )
        .into());
    }
    if same_path(path, &destination) {
        return Err(CliError(
            "Index rebuild output must be a separate archive copy.".to_owned(),
        )
        .into());
    }
    let source: Arc<dyn ByteSource> = Arc::new(FileSource::open(path)?);
    let generation = source_generation(source.as_ref());
    let bytes = rebuild_damaged_primary_index(source)?;
    let rebuilt = ArchiveSnapshot::open_bytes(bytes.clone())?;
    let live = rebuilt.verify()?;
    let recovered_revisions = count_history(&rebuilt)?;
    drop(rebuilt);
    save::write_new_archive(&destination, &bytes)?;
    emit(
        output,
        json!({
            "path": path.display().to_string(),
            "output": destination.display().to_string(),
            "status": "rebuilt-index-copy",
            "original_preserved": true,
            "source_generation": generation.to_string(),
            "recovered_records": live.current_records,
            "recovered_revisions": recovered_revisions,
            "limitations": "Only complete published unencrypted v1 logs with known record types and intact record headers are supported; secondary aliases are reconstructed from understood schemas.",
        }),
        &format!(
            "Index-rebuilt copy created at {}; the original was preserved. Recovered {} records and {} revisions through generation {}.",
            destination.display(),
            live.current_records,
            recovered_revisions,
            generation
        ),
        args.json(),
    );
    Ok(0)
}

pub(super) fn purge_trash(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = require_unlocked(&open_archive(path, context.passphrase())?)?;
    let plan = plan_trash_purge(&snapshot)?;
    let applied = args.flag("apply") && !args.flag("preview");
    let blockers: Vec<Value> = plan
        .blockers
        .iter()
        .map(|blocker| {
            json!({
                "recordId": blocker.record_id,
                "recordType": blocker.record_type,
                "label": blocker.label,
                "references": blocker.references.iter().map(|reference| json!({
                    "recordId": reference.record_id,
                    "recordType": reference.record_type,
                    "label": reference.label,
                    "fields": reference.fields,
                })).collect::<Vec<Value>>(),
            })
        })
        .collect();
    let original_bytes = snapshot.source.size();
    let mut compacted_generation = plan.generation;
    let mut purge = None;
    if applied {
        let result = purge_trashed_archive_snapshot(&snapshot)?;
        compacted_generation = ArchiveSnapshot::open_bytes(result.bytes.clone())?.commit.generation;
        purge = Some(result);
    }
    drop(snapshot);
    if let Some(result) = &purge {
        save::save_bytes(path, &result.bytes)?;
    }
    let compacted_bytes = purge.as_ref().map(|result| result.compacted_bytes).unwrap_or(0);
    let value = json!({
        "path": path.display().to_string(),
        "status": if applied { "purged" } else { "preview" },
        "generation": plan.generation.to_string(),
        "compactedGeneration": compacted_generation.to_string(),
        "deletedRecords": plan.deleted_records,
        "opaqueRecords": plan.opaque_records,
        "blockers": blockers,
        "applied": applied,
        "originalBytes": original_bytes.to_string(),
        "compactedBytes": compacted_bytes.to_string(),
        "bytesSaved": original_bytes.saturating_sub(compacted_bytes).to_string(),
        "recordsPreserved": purge.as_ref().map(|result| result.preserved_records).unwrap_or(0),
        "prunedAssetRecords": purge.as_ref().map(|result| result.pruned_asset_records).unwrap_or(0),
        "purgeRemovedRecords": purge.as_ref().map(|result| result.purge_removed_records).unwrap_or(0),
    });
    let summary = if applied {
        format!(
            "Purged Trash from {}: removed {} deleted records and preserved {} records.",
            path.display(),
            purge.as_ref().map(|result| result.purge_removed_records).unwrap_or(0),
            purge.as_ref().map(|result| result.preserved_records).unwrap_or(0)
        )
    } else {
        format!(
            "Trash purge preview for {}: {} deleted records, {} active blockers, {} opaque records. Add --apply to purge.",
            path.display(),
            plan.deleted_records,
            plan.blockers.len(),
            plan.opaque_records
        )
    };
    emit(output, value, &summary, args.json());
    Ok(0)
}
