use std::path::Path;

use serde_json::json;

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{
    cancellation, emit, open_archive, CliContext, CliError, CliOutput, CliResult, ParsedArguments,
};
use crate::core::format::RecordType;
use crate::core::verify::{verify_full, verify_history};

use super::helpers::{counter, file_stem, is_writable};

pub(super) fn unlock(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_archive(path, context.passphrase())?;
    if snapshot.locked() {
        return Err(CliError(
            "This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned(),
        )
        .into());
    }
    let verification = snapshot.verify()?;
    let value = json!({
        "path": path.display().to_string(),
        "encrypted": snapshot.encrypted(),
        "generation": snapshot.commit.generation.to_string(),
        "status": if snapshot.encrypted() { "unlocked" } else { "not-encrypted" },
        "verified": true,
    });
    let summary = if snapshot.encrypted() {
        format!(
            "Archive unlocked and verified at generation {} ({} records).",
            snapshot.commit.generation, verification.current_records
        )
    } else {
        format!(
            "Archive is not encrypted; generation {} was verified.",
            snapshot.commit.generation
        )
    };
    emit(output, value, &summary, args.json());
    Ok(0)
}

fn record_counts(snapshot: &ArchiveSnapshot) -> CliResult<(usize, usize)> {
    const TYPES: [u16; 14] = [
        RecordType::STUDENT,
        RecordType::SESSION,
        RecordType::AUDIO_CHUNK,
        RecordType::TRANSCRIPT_SEGMENT,
        RecordType::ANNOTATION,
        RecordType::ASSET_METADATA,
        RecordType::ASSET_BLOB,
        RecordType::EVIDENCE_NODE,
        RecordType::EVIDENCE_EDGE,
        RecordType::GUIDE,
        RecordType::SETTINGS,
        RecordType::AI_JOB,
        RecordType::ENCRYPTION,
        RecordType::WAVEFORM_INDEX,
    ];
    let mut live = 0usize;
    let mut deleted = 0usize;
    for record_type in TYPES {
        cancellation::check("Archive verification")?;
        let Ok(records) = snapshot.list_record_metadata(record_type, true) else {
            continue;
        };
        for record in records {
            if record.deleted() {
                deleted += 1;
            } else {
                live += 1;
            }
        }
    }
    Ok((live, deleted))
}

pub(super) fn run(
    action: &str,
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    if action == "verify" {
        cancellation::check("Archive verification")?;
    }
    let snapshot = open_archive(path, context.passphrase())?;
    if action == "verify" && snapshot.locked() {
        return Err(CliError(
            "This archive is encrypted. Provide --passphrase-env to verify it.".to_owned(),
        )
        .into());
    }
    let writable = is_writable(path);
    let recovery_needed = snapshot.source.size() > snapshot.published_end_offset;
    let full_requested = action == "verify" && args.flag("full");
    let history_requested = action == "verify" && args.flag("history");
    let mut full = None;
    let mut history = None;
    let mut verification = None;
    let mut verification_error: Option<String> = None;
    if !snapshot.locked() {
        if history_requested {
            match verify_history(&snapshot) {
                Ok(result) => history = Some(result),
                Err(error) => verification_error = Some(error.message),
            }
        } else if full_requested {
            match verify_full(&snapshot) {
                Ok(result) => full = Some(result),
                Err(error) => verification_error = Some(error.message),
            }
        } else {
            match snapshot.verify() {
                Ok(result) => verification = Some(result),
                Err(error) => verification_error = Some(error.message),
            }
        }
    }
    let manifest = snapshot.get_manifest().ok();
    let manifest_record = snapshot
        .get_record(RecordType::SETTINGS, &snapshot.header.id)
        .ok()
        .flatten();
    if action == "verify" {
        cancellation::check("Archive verification")?;
    }
    let student_count = counter(manifest_record.as_ref().and_then(|record| record.field("student_count")));
    let session_count = counter(manifest_record.as_ref().and_then(|record| record.field("session_count")));
    let valid = verification_error.is_none()
        && (history.is_some()
            || full
                .as_ref()
                .map(|result| result.valid)
                .unwrap_or(verification.is_some()));
    let health = if snapshot.locked() {
        "locked"
    } else if recovery_needed {
        "recovery-required"
    } else if verification_error.is_some()
        || full.as_ref().map(|result| !result.valid).unwrap_or(false)
    {
        "invalid"
    } else {
        "healthy"
    };
    let (live, records_verified, deleted, records_checked, index_pages_checked) =
        if let Some(history) = &history {
            (
                history.current.live_records,
                history.current.current_records,
                history.current.deleted_records,
                history.current.current_records,
                0,
            )
        } else if let Some(full) = &full {
            (
                full.live_records,
                full.current_records,
                full.deleted_records,
                full.records_checked,
                full.index_pages_checked,
            )
        } else if let Some(verification) = &verification {
            let (live, deleted) = record_counts(&snapshot)?;
            (
                live,
                verification.current_records,
                deleted,
                verification.current_records,
                0,
            )
        } else {
            (0, 0, 0, 0, 0)
        };
    let issues: Vec<String> = full
        .as_ref()
        .map(|result| result.issues.clone())
        .or_else(|| {
            verification_error
                .as_ref()
                .map(|error| error.split(';').map(str::trim).map(str::to_owned).collect())
        })
        .unwrap_or_default();
    let verification_scope = if verification_error.is_some() {
        "failed"
    } else if full_requested {
        "full-semantic"
    } else if history.is_some() {
        "reachable-revisions-and-committed-generations"
    } else if verification.is_some() {
        "all-current-primary-records-and-index"
    } else {
        "header-and-index"
    };
    let value = json!({
        "path": path.display().to_string(),
        "name": manifest.as_ref().map(|manifest| manifest.display_name.clone()).unwrap_or_else(|| file_stem(path)),
        "description": manifest.as_ref().map(|manifest| manifest.description.clone()).unwrap_or_default(),
        "id": snapshot.header.id,
        "archiveId": snapshot.header.id,
        "archive_id": snapshot.header.id,
        "generation": snapshot.commit.generation.to_string(),
        "size": snapshot.source.size().to_string(),
        "size_bytes": snapshot.source.size().to_string(),
        "student_count": student_count,
        "session_count": session_count,
        "created_at_us": snapshot.header.created_at_us.to_string(),
        "format_major": snapshot.header.major_version.to_string(),
        "format_minor": snapshot.header.minor_version.to_string(),
        "formatMajor": snapshot.header.major_version,
        "formatMinor": snapshot.header.minor_version,
        "writable": writable,
        "health": health,
        "recoveryNeeded": recovery_needed,
        "metadataOnly": false,
        "metadata_only": false,
        "encrypted": snapshot.encrypted(),
        "locked": snapshot.locked(),
        "verified": valid,
        "valid": valid,
        "records": live,
        "recordsVerified": records_verified,
        "records_checked": records_checked,
        "index_pages_checked": index_pages_checked,
        "deletedRecords": deleted,
        "issues": issues,
        "historicalRevisionsVerified": history.as_ref().map(|result| result.historical_revisions),
        "commitsVerified": history.as_ref().map(|result| result.verified_commits),
        "verificationScope": verification_scope,
    });
    let summary = if snapshot.locked() {
        format!(
            "{}: generation {}, encrypted records are locked.",
            file_stem(path),
            snapshot.commit.generation
        )
    } else if action == "verify" && (full_requested || verification_error.is_some()) {
        if valid {
            format!(
                "{}: full verification passed at generation {} ({} record revisions, {} index pages).",
                file_stem(path),
                snapshot.commit.generation,
                records_checked,
                index_pages_checked
            )
        } else {
            format!(
                "{}: verification failed at generation {}.\n{}",
                file_stem(path),
                snapshot.commit.generation,
                issues.join("\n")
            )
        }
    } else if action == "verify" && history.is_some() {
        format!(
            "{}: generation {}, {} live records verified ({} in Trash); {} historical revisions across {} commits.",
            file_stem(path),
            snapshot.commit.generation,
            live,
            deleted,
            history.as_ref().map(|result| result.historical_revisions).unwrap_or(0),
            history.as_ref().map(|result| result.verified_commits).unwrap_or(0)
        )
    } else if action == "verify" {
        format!(
            "{}: generation {}, {} live records verified ({} in Trash).",
            file_stem(path),
            snapshot.commit.generation,
            live,
            deleted
        )
    } else {
        format!(
            "{}: generation {}, {} live records ({} in Trash).",
            file_stem(path),
            snapshot.commit.generation,
            live,
            deleted
        )
    };
    emit(output, value, &summary, args.json());
    if verification_error.is_some() || (full_requested && !valid) {
        return Ok(2);
    }
    Ok(0)
}
