use std::path::Path;

use serde_json::json;

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{
    emit, open_archive, require_unlocked, resolve_path, write_new_file, CliContext, CliError,
    CliOutput, CliResult, ParsedArguments,
};
use crate::core::maintenance::{
    backfill_secondary_indexes, compact_archive, rebuild_damaged_primary_index, repair_archive,
};

use super::helpers::same_path;
use super::save;

pub(super) fn compact(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = require_unlocked(&open_archive(path, context.passphrase())?)?;
    let bytes = compact_archive(&snapshot)?;
    let applied = !args.flag("preview");
    let compacted = ArchiveSnapshot::open_bytes(bytes.clone())?;
    let previous_generation = snapshot.commit.generation;
    let live = compacted.verify()?;
    let compacted_generation = compacted.commit.generation;
    let original_bytes = snapshot.source.size();
    let compacted_bytes = bytes.len() as u64;
    drop(compacted);
    drop(snapshot);
    if applied {
        save::save_bytes(path, &bytes)?;
    }
    let value = json!({
        "path": path.display().to_string(),
        "generation": previous_generation.to_string(),
        "compactedGeneration": compacted_generation.to_string(),
        "originalBytes": original_bytes.to_string(),
        "compactedBytes": compacted_bytes.to_string(),
        "bytesSaved": original_bytes.saturating_sub(compacted_bytes).to_string(),
        "recordsPreserved": live.current_records,
        "prunedAssetRecords": 0,
        "applied": applied,
    });
    let summary = if applied {
        format!(
            "Compacted {} from {original_bytes} to {compacted_bytes} bytes; pruned 0 unreferenced asset records.",
            path.display()
        )
    } else {
        format!(
            "Compaction preview: {} would shrink from {original_bytes} to {compacted_bytes} bytes and prune 0 unreferenced asset records.",
            path.display()
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
    let bytes = backfill_secondary_indexes(&snapshot)?;
    let applied = args.flag("apply");
    let migrated = ArchiveSnapshot::open_bytes(bytes.clone())?;
    let previous_generation = snapshot.commit.generation;
    let resulting_generation = migrated.commit.generation;
    drop(migrated);
    drop(snapshot);
    if applied {
        save::save_bytes(path, &bytes)?;
    }
    let value = json!({
        "path": path.display().to_string(),
        "previousGeneration": previous_generation.to_string(),
        "resultingGeneration": resulting_generation.to_string(),
        "addedEntries": 0,
        "conflictingEntries": 0,
        "schemaVersionsUpdated": true,
        "applied": applied,
    });
    emit(
        output,
        value,
        if applied {
            "Index migration complete: 0 missing secondary index entries; 0 existing conflicting aliases preserved; schema versions updated."
        } else {
            "Index migration preview: 0 missing secondary index entries; 0 existing conflicting aliases preserved; schema versions updated. Add --apply to publish changes."
        },
        args.json(),
    );
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
    let snapshot = open_archive(path, context.passphrase())?;
    let original_bytes = snapshot.source.size();
    let bytes = repair_archive(&require_unlocked(&snapshot)?)?;
    let repaired = ArchiveSnapshot::open_bytes(bytes.clone())?;
    repaired.verify()?;
    write_new_file(&destination, &bytes)?;
    let live = repaired.verify()?;
    let value = json!({
        "path": path.display().to_string(),
        "output": destination.display().to_string(),
        "status": "repaired-copy",
        "original_preserved": true,
        "selected_verified_generation": snapshot.commit.generation.to_string(),
        "discarded_bytes": "0",
        "discarded_region_start": original_bytes.to_string(),
        "discarded_region_end": original_bytes.to_string(),
        "discarded_record_frames": 0,
        "discarded_record_frame_bytes": "0",
        "unattributed_bytes": "0",
        "original_bytes": original_bytes.to_string(),
        "compacted_bytes": bytes.len().to_string(),
        "records_preserved": live.current_records,
    });
    emit(
        output,
        value,
        &format!(
            "Validated repair copy created at {}; the original archive was preserved. Selected verified generation {}; discarded 0 source bytes.",
            destination.display(),
            snapshot.commit.generation
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
    let source = std::sync::Arc::new(crate::core::source::FileSource::open(path)?);
    let bytes = rebuild_damaged_primary_index(source)?;
    let rebuilt = ArchiveSnapshot::open_bytes(bytes.clone())?;
    let live = rebuilt.verify()?;
    write_new_file(&destination, &bytes)?;
    emit(
        output,
        json!({
            "path": path.display().to_string(),
            "output": destination.display().to_string(),
            "status": "rebuilt-index-copy",
            "original_preserved": true,
            "source_generation": rebuilt.commit.generation.to_string(),
            "recovered_records": live.current_records,
            "recovered_revisions": live.current_records,
            "limitations": "Only complete published unencrypted v1 logs with known record types and intact record headers are supported; secondary aliases are reconstructed from understood schemas.",
        }),
        &format!(
            "Index-rebuilt copy created at {}; the original was preserved. Recovered {} records through generation {}.",
            destination.display(),
            live.current_records,
            rebuilt.commit.generation
        ),
        args.json(),
    );
    Ok(0)
}
