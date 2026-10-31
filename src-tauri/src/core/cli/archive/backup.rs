use std::path::Path;

use serde_json::json;

use crate::core::cli::{
    emit, open_archive, resolve_path, write_new_file, CliContext, CliError, CliOutput, CliResult,
    ParsedArguments,
};
use crate::core::maintenance::{discard_tail, inspect_recovery, recover_unpublished};

use super::helpers::{read_bytes, same_path};
use super::save;

pub(super) fn backup(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    if !args.flag("confirm-sensitive") {
        return Err(CliError(
            "A full archive copy may contain student histories, recordings, private annotations, and credentials. Review the destination and retry with --confirm-sensitive."
                .to_owned(),
        )
        .into());
    }
    let destination = resolve_path(args.required_option("output")?);
    if same_path(path, &destination) {
        return Err(CliError(
            "Backup output must be a separate archive copy.".to_owned(),
        )
        .into());
    }
    let snapshot = open_archive(path, context.passphrase())?;
    let bytes = read_bytes(&snapshot)?;
    write_new_file(&destination, &bytes)?;
    let value = json!({
        "path": path.display().to_string(),
        "output": destination.display().to_string(),
        "bytes": bytes.len().to_string(),
        "status": "created",
        "encrypted": snapshot.encrypted(),
        "original_preserved": true,
    });
    emit(
        output,
        value,
        &format!(
            "Backup created at {}; the original archive was preserved.",
            destination.display()
        ),
        args.json(),
    );
    Ok(0)
}

pub(super) fn recover(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_archive(path, context.passphrase())?;
    let inspection = inspect_recovery(&snapshot)?;
    let inspect_only = args.flag("inspect") || !args.flag("apply");
    let discard_tail_requested = args.flag("discard-tail");
    let mut changed = false;
    let mut operation = "inspect";
    let mut message = String::new();
    let mut resulting_generation = inspection.committed_generation;
    let mut remaining_trailing = inspection.trailing_bytes;
    let mut discarded = 0u64;
    let mut recovered_generations = 0usize;
    let mut pending: Option<Vec<u8>> = None;
    if !inspect_only {
        if snapshot.locked() {
            return Err(CliError(
                "A passphrase is required to verify the unpublished generation.".to_owned(),
            )
            .into());
        }
        if discard_tail_requested {
            operation = "discard-tail";
            if inspection.trailing_bytes == 0 {
                message = "The archive has no uncommitted trailing bytes to discard.".to_owned();
            } else {
                pending = Some(discard_tail(&snapshot)?);
                changed = true;
                remaining_trailing = 0;
            }
        } else if inspection.has_unpublished_commit {
            operation = "recover";
            match recover_unpublished(&snapshot) {
                Ok((bytes, generation, generations, discarded_bytes)) => {
                    pending = Some(bytes);
                    changed = true;
                    resulting_generation = generation;
                    recovered_generations = generations;
                    discarded = discarded_bytes;
                    remaining_trailing = 0;
                }
                Err(error) => {
                    message = error.message;
                }
            }
        } else {
            message = "No unpublished generation passed full integrity verification.".to_owned();
        }
    }
    drop(snapshot);
    if let Some(bytes) = pending {
        save::save_bytes(path, &bytes)?;
    }
    let value = json!({
        "path": path.display().to_string(),
        "archive": path.display().to_string(),
        "action": operation,
        "passphrase_supplied": context.passphrase().is_some(),
        "previousGeneration": inspection.committed_generation.to_string(),
        "recoveredGeneration": inspection.recoverable_generation.to_string(),
        "recoveredGenerations": recovered_generations,
        "discardedTrailingBytes": discarded.to_string(),
        "recoverable": inspection.recoverable,
        "applied": changed,
        "changed": changed,
        "resulting_committed_generation": resulting_generation.to_string(),
        "remaining_trailing_bytes": remaining_trailing.to_string(),
        "inspection": {
            "archive_header_valid": true,
            "recovery_assessment_complete": true,
            "header_repair_candidate": false,
            "header_repair_available": false,
            "header_repair_generation": "0",
            "committed_generation": inspection.committed_generation.to_string(),
            "candidate_generation": inspection.candidate_generation.to_string(),
            "recoverable_generation": inspection.recoverable_generation.to_string(),
            "trailing_bytes": inspection.trailing_bytes.to_string(),
            "has_unpublished_commit": inspection.has_unpublished_commit,
            "encrypted": inspection.encrypted,
            "requires_passphrase": inspection.locked,
            "recoverable": inspection.recoverable,
            "recovered_generations": recovered_generations,
            "discarded_trailing_bytes": discarded.to_string(),
            "issues": inspection.issues,
        },
    });
    let summary = format!(
        "Committed generation: {}\nUnpublished candidate generation: {}\nRecoverable generation: {}\nEncrypted: {}\nPassphrase: {}\nTrailing bytes: {}{}{}",
        inspection.committed_generation,
        if inspection.has_unpublished_commit {
            inspection.candidate_generation.to_string()
        } else {
            "none".to_owned()
        },
        if inspection.recoverable {
            inspection.recoverable_generation.to_string()
        } else {
            "none".to_owned()
        },
        if inspection.encrypted { "yes" } else { "no" },
        if inspection.locked { "required" } else { "not required" },
        inspection.trailing_bytes,
        if inspect_only {
            "\nAction: inspection only; archive bytes were not changed."
        } else if changed {
            "\nAction: recovery completed."
        } else {
            "\nAction: recovery made no changes."
        },
        if message.is_empty() {
            String::new()
        } else {
            format!("\n{message}")
        }
    );
    emit(output, value, &summary, args.json());
    if !inspect_only && !changed && !discard_tail_requested && !inspection.has_unpublished_commit {
        return Ok(2);
    }
    Ok(0)
}
