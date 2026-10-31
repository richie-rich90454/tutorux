use std::path::Path;

use serde_json::{json, Value};

use crate::core::cli::{
    emit, open_archive, require_unlocked, resolve_path, CliContext, CliError, CliOutput, CliResult,
    ParsedArguments,
};
use crate::core::sanitize::{
    create_sanitized_copy, preview_sanitized_copy, SanitizedCopySummary,
};

use super::helpers::{environment_name, passphrase_from_env, read_bytes, same_path};
use super::save;
use super::selection;

pub(super) fn run(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    let destination = resolve_path(args.required_option("output")?);
    if !destination
        .extension()
        .map(|extension| extension.eq_ignore_ascii_case("tux"))
        .unwrap_or(false)
    {
        return Err(CliError(
            "Sanitized archive copies must use the .tux extension.".to_owned(),
        )
        .into());
    }
    let options = selection::options(args)?;
    let new_passphrase_environment = environment_name(args, "new-passphrase-env")?;
    if same_path(path, &destination) {
        return Err(CliError(
            "Sanitized output must be a separate archive copy.".to_owned(),
        )
        .into());
    }
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err(CliError(
            "The sanitized-copy destination directory is unavailable.".to_owned(),
        )
        .into());
    }
    if destination.exists() {
        return Err(CliError(format!(
            "Sanitized output already exists: {}",
            destination.display()
        ))
        .into());
    }
    let confirmed = args.flag("confirm-sensitive");
    let reviewed_output = args.option("expected-output").map(resolve_path);
    if confirmed {
        require_confirmation_options(args)?;
        let reviewed = reviewed_output
            .as_ref()
            .ok_or_else(|| CliError(confirmation_message()))?;
        if !same_path(reviewed, &destination) {
            return Err(CliError(
                "The output path differs from the reviewed preview; preview again.".to_owned(),
            )
            .into());
        }
    }

    let snapshot = require_unlocked(&open_archive(path, context.passphrase())?)?;
    let summary = preview_sanitized_copy(&snapshot, &options)?;
    let encrypted_output =
        snapshot.encrypted() || options.include_credentials || new_passphrase_environment.is_some();
    if !confirmed {
        let value = sanitized_summary(&summary, &destination, "preview-required", encrypted_output);
        let summary_text = format!(
            "Sanitized copy preview for {}:\n  Students: {}\n  Sessions: {}\n  Annotations: {}\n  Assets: {}\n  Evidence items: {}\n  Guides: {}\n  Recording tracks: {}\n  Recording chunks: {}\n  Generation logs: {}\n  Credentials: {}\nEncrypted output: {}.\nReview the selection, encryption choice, and destination; confirm with --confirm-sensitive --expected-generation {} --expected-selection {} --expected-output \"{}\" --expected-encrypted-output {}.",
            destination.display(),
            summary.students,
            summary.sessions,
            summary.annotations,
            summary.assets,
            summary.evidence_items,
            summary.guides,
            summary.recording_tracks,
            summary.recordings,
            summary.generation_logs,
            summary.credentials,
            if encrypted_output {
                "yes (provide --new-passphrase-env when confirming)"
            } else {
                "no"
            },
            summary.source_generation,
            summary.selection_fingerprint,
            destination.display(),
            if encrypted_output { "yes" } else { "no" },
        );
        emit(output, value, &summary_text, args.json());
        return Ok(0);
    }

    let expected_generation = args.option("expected-generation").unwrap_or_default();
    if !expected_generation.bytes().all(|byte| byte.is_ascii_digit())
        || expected_generation != summary.source_generation.to_string()
    {
        return Err(CliError(
            "The source generation differs from the reviewed preview; preview again.".to_owned(),
        )
        .into());
    }
    if args.option("expected-selection") != Some(summary.selection_fingerprint.as_str()) {
        return Err(CliError(
            "The selection differs from the reviewed preview; preview again.".to_owned(),
        )
        .into());
    }
    if args.option("expected-encrypted-output") != Some(if encrypted_output { "yes" } else { "no" }) {
        return Err(CliError(
            "The output encryption choice differs from the reviewed preview; preview again."
                .to_owned(),
        )
        .into());
    }
    let new_passphrase = passphrase_from_env(args, "new-passphrase-env")?;
    if encrypted_output && new_passphrase.is_none() {
        return Err(CliError(
            "An encrypted output passphrase is required to preserve source protection or include credentials; provide --new-passphrase-env."
                .to_owned(),
        )
        .into());
    }
    let created = create_sanitized_copy(&snapshot, &options, &summary, new_passphrase.as_deref())?;
    let bytes = read_bytes(&created.snapshot)?;
    let summary = created.summary;
    drop(snapshot);
    if destination.exists() {
        return Err(CliError(format!(
            "Sanitized output already exists: {}",
            destination.display()
        ))
        .into());
    }
    save::save_bytes(&destination, &bytes)?;
    let value = sanitized_summary(&summary, &destination, "created", encrypted_output);
    emit(
        output,
        value,
        &format!(
            "Sanitized {}archive created at {}.",
            if encrypted_output { "encrypted " } else { "" },
            destination.display()
        ),
        args.json(),
    );
    Ok(0)
}

fn confirmation_message() -> String {
    "Confirm the reviewed preview with --expected-generation, --expected-selection, --expected-output, and --expected-encrypted-output yes|no.".to_owned()
}

fn require_confirmation_options(args: &ParsedArguments) -> CliResult<()> {
    if args.option("expected-generation").is_none()
        || args.option("expected-selection").is_none()
        || args.option("expected-encrypted-output").is_none()
        || args.option("expected-output").is_none()
    {
        return Err(CliError(confirmation_message()).into());
    }
    Ok(())
}

fn sanitized_summary(
    summary: &SanitizedCopySummary,
    output: &Path,
    status: &str,
    encrypted_output: bool,
) -> Value {
    json!({
        "status": status,
        "output": output.display().to_string(),
        "encrypted_output": encrypted_output,
        "source_generation": summary.source_generation.to_string(),
        "selection_fingerprint": summary.selection_fingerprint,
        "students": summary.students,
        "sessions": summary.sessions,
        "annotations": summary.annotations,
        "assets": summary.assets,
        "evidence_items": summary.evidence_items,
        "guides": summary.guides,
        "recording_tracks": summary.recording_tracks,
        "recording_chunks": summary.recordings,
        "generation_logs": summary.generation_logs,
        "credentials": summary.credentials,
        "warning": "Review included records and destination before confirming; excluded data is omitted from the new archive.",
    })
}
