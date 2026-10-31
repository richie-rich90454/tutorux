use std::path::Path;
use std::sync::Arc;

use serde_json::json;

use crate::core::cli::{
    emit, open_archive, resolve_path, write_new_file, CliContext, CliError, CliOutput, CliResult,
    ParsedArguments,
};
use crate::core::maintenance::{discard_tail, inspect_recovery_source, recover_unpublished};
use crate::core::source::FileSource;

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
    let apply_requested = args.flag("apply");
    let discard_tail_requested = args.flag("discard-tail");
    let recover_unpublished_requested = args.flag("recover-unpublished")
        || (apply_requested && !discard_tail_requested && !args.flag("inspect"));
    if recover_unpublished_requested && discard_tail_requested {
        return Err(CliError(
            "Choose either --recover-unpublished or --discard-tail, not both.".to_owned(),
        )
        .into());
    }
    if args.flag("inspect") && (recover_unpublished_requested || discard_tail_requested) {
        return Err(CliError(
            "Choose --inspect or a recovery action, not both.".to_owned(),
        )
        .into());
    }
    let inspect_only = args.flag("inspect")
        || (!recover_unpublished_requested && !discard_tail_requested);
    let source = Arc::new(FileSource::open(path)?);
    let inspection = inspect_recovery_source(source, context.passphrase())?;
    let mut changed = false;
    let mut operation = "inspect";
    let mut message = String::new();
    let mut resulting_generation = inspection.committed_generation;
    let mut remaining_trailing = inspection.trailing_bytes;
    let mut pending: Option<Vec<u8>> = None;
    if !inspect_only {
        if !inspection.archive_header_valid {
            return Err(CliError(if inspection.header_repair_available {
                "The original header is damaged. Use 'archive repair FILE --output COPY.tux --confirm-sensitive' to create a fully verified copy first; no in-place recovery was performed."
                    .to_owned()
            } else {
                "The archive header is damaged and no safe in-place recovery is available. Restore a known-good header before repair; no archive bytes were changed."
                    .to_owned()
            })
            .into());
        }
        operation = if recover_unpublished_requested {
            "recover-unpublished"
        } else {
            "discard-tail"
        };
        if recover_unpublished_requested && !inspection.recoverable {
            message = if inspection.requires_passphrase {
                "A passphrase is required to verify the unpublished generation.".to_owned()
            } else {
                "No unpublished generation passed full integrity verification.".to_owned()
            };
        } else if discard_tail_requested && inspection.trailing_bytes == 0 {
            message = "The archive has no uncommitted trailing bytes to discard.".to_owned();
        } else if apply_requested {
            let snapshot = open_archive(path, context.passphrase())?;
            if recover_unpublished_requested {
                match recover_unpublished(&snapshot) {
                    Ok((bytes, generation, _generations, _discarded)) => {
                        pending = Some(bytes);
                        resulting_generation = generation;
                        changed = true;
                        remaining_trailing = 0;
                    }
                    Err(error) => {
                        message = error.message;
                    }
                }
            } else {
                pending = Some(discard_tail(&snapshot)?);
                changed = true;
                remaining_trailing = 0;
            }
        }
    }
    if let Some(bytes) = pending {
        save::save_bytes(path, &bytes)?;
    }
    let mut value = json!({
        "path": path.display().to_string(),
        "archive": path.display().to_string(),
        "action": operation,
        "passphrase_supplied": context.passphrase().is_some(),
        "previousGeneration": inspection.committed_generation.to_string(),
        "recoveredGeneration": inspection.recoverable_generation.to_string(),
        "recoveredGenerations": inspection.recovered_generations,
        "discardedTrailingBytes": inspection.discarded_trailing_bytes.to_string(),
        "recoverable": inspection.recoverable,
        "applied": changed,
        "changed": changed,
        "resulting_committed_generation": resulting_generation.to_string(),
        "remaining_trailing_bytes": remaining_trailing.to_string(),
        "inspection": {
            "archive_header_valid": inspection.archive_header_valid,
            "recovery_assessment_complete": inspection.recovery_assessment_complete,
            "header_repair_candidate": inspection.header_repair_candidate,
            "header_repair_available": inspection.header_repair_available,
            "header_repair_generation": inspection.header_repair_generation.to_string(),
            "committed_generation": inspection.committed_generation.to_string(),
            "candidate_generation": inspection.candidate_generation.to_string(),
            "recoverable_generation": inspection.recoverable_generation.to_string(),
            "trailing_bytes": inspection.trailing_bytes.to_string(),
            "has_unpublished_commit": inspection.has_unpublished_commit,
            "encrypted": inspection.encrypted,
            "requires_passphrase": inspection.requires_passphrase,
            "recoverable": inspection.recoverable,
            "recovered_generations": inspection.recovered_generations,
            "discarded_trailing_bytes": inspection.discarded_trailing_bytes.to_string(),
            "issues": inspection.issues,
        },
    });
    if !message.is_empty() {
        if let Some(object) = value.as_object_mut() {
            object.insert("message".to_owned(), json!(message));
        }
    }
    let summary = format!(
        "Archive header: {}\nCommitted generation: {}\nUnpublished candidate generation: {}\nRecoverable generation: {}\nEncrypted: {}\nPassphrase: {}\nTrailing bytes: {}{}{}",
        if inspection.archive_header_valid {
            "valid"
        } else {
            "invalid or unreadable"
        },
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
        if inspection.requires_passphrase {
            "required"
        } else {
            "not required"
        },
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
    if !inspect_only && recover_unpublished_requested && !inspection.recoverable {
        return Ok(2);
    }
    Ok(0)
}
