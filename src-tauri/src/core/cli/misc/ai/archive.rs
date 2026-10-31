use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::core::archive::{new_uuid, now_us, ArchiveSnapshot};
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{ArchiveRecord, RecordType};

use super::super::providers::ProviderDef;
use super::ready;

pub(super) fn package(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = ready(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    let session = snapshot
        .get_record(RecordType::SESSION, &session_id)?
        .filter(|record| !record.deleted())
        .ok_or_else(|| CliError("Session was not found.".to_owned()))?;
    let template = args.option("template").unwrap_or("auto");
    let transcript: Vec<Value> = snapshot
        .list_records(RecordType::TRANSCRIPT_SEGMENT, false)?
        .into_iter()
        .filter(|record| record.field("session_id").map(str::to_lowercase) == Some(session_id.clone()))
        .map(|record| crate::core::cli::records::plain(&record))
        .collect();
    let annotations: Vec<Value> = snapshot
        .list_records(RecordType::ANNOTATION, false)?
        .into_iter()
        .filter(|record| record.field("session_id").map(str::to_lowercase) == Some(session_id.clone()))
        .map(|record| crate::core::cli::records::plain(&record))
        .collect();
    let evidence: Vec<Value> = snapshot
        .list_records(RecordType::EVIDENCE_NODE, false)?
        .into_iter()
        .filter(|record| record.field("session_id").map(str::to_lowercase) == Some(session_id.clone()))
        .map(|record| crate::core::cli::records::plain(&record))
        .collect();
    let assets: Vec<Value> = snapshot
        .list_records(RecordType::ASSET_METADATA, false)?
        .into_iter()
        .filter(|record| record.field("session_id").map(str::to_lowercase) == Some(session_id.clone()))
        .map(|record| crate::core::cli::records::plain(&record))
        .collect();
    let package = json!({
        "format": "tutorux-ai-package-v1",
        "session": crate::core::cli::records::plain(&session),
        "template_id": template,
        "transcript": transcript,
        "annotations": annotations,
        "evidence": evidence,
        "assets": assets,
        "attached_images": [],
        "image_ids": args.option("image-ids").unwrap_or(""),
    });
    let bytes = serde_json::to_vec_pretty(&package).unwrap_or_default();
    let content_hash = format!("{:x}", Sha256::digest(&bytes));
    let id = new_uuid();
    let mut job = ArchiveRecord::new(
        RecordType::AI_JOB,
        &id,
        [
            ("session_id", session_id.clone()),
            ("mode", "manual".to_owned()),
            ("requested_mode", "manual".to_owned()),
            ("status", "package-ready".to_owned()),
            ("format", "json".to_owned()),
            ("template_id", template.to_owned()),
            ("content_hash", content_hash.clone()),
            ("package_bytes", bytes.len().to_string()),
            ("transcript_segments", package["transcript"].as_array().map_or(0, Vec::len).to_string()),
            ("annotations", package["annotations"].as_array().map_or(0, Vec::len).to_string()),
            ("evidence", package["evidence"].as_array().map_or(0, Vec::len).to_string()),
            ("assets", package["assets"].as_array().map_or(0, Vec::len).to_string()),
            ("created_at_us", now_us().to_string()),
        ],
    );
    job.blob = bytes;
    let next = snapshot.append_records(&[job.clone()])?;
    crate::core::cli::records::save_replacing(path, &next)?;
    let destination = args.option("output").map(crate::core::cli::resolve_path);
    if let Some(destination) = &destination {
        if crate::core::cli::records::same_path_public(destination, path) {
            return Err(CliError("Package output cannot replace its source archive.".to_owned()).into());
        }
        crate::core::cli::write_file_atomically(destination, &job.blob)?;
    }
    emit(
        output,
        json!({
            "job_id": id,
            "session_id": session_id,
            "template_id": template,
            "content_hash": content_hash,
            "package_bytes": job.blob.len(),
            "transcript_segments": job.field("transcript_segments").and_then(|value| value.parse::<u64>().ok()).unwrap_or(0),
            "annotations": job.field("annotations").and_then(|value| value.parse::<u64>().ok()).unwrap_or(0),
            "evidence": job.field("evidence").and_then(|value| value.parse::<u64>().ok()).unwrap_or(0),
            "assets": job.field("assets").and_then(|value| value.parse::<u64>().ok()).unwrap_or(0),
            "output": destination.as_ref().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default(),
        }),
        &format!("AI package {id} prepared. SHA-256: {content_hash}."),
        args.json(),
    );
    Ok(0)
}

pub(super) fn import(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = ready(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    if !snapshot
        .get_record(RecordType::SESSION, &session_id)?
        .is_some_and(|record| !record.deleted())
    {
        return Err(CliError("Session was not found.".to_owned()).into());
    }
    let input = crate::core::cli::resolve_path(args.required_option("input")?);
    let text = std::fs::read_to_string(&input).map_err(|error| {
        crate::core::error::CoreError::new(
            "ai_import_failed",
            format!("Could not read AI response: {error}"),
        )
    })?;
    if text.len() > 16 * 1024 * 1024 {
        return Err(CliError("Response must be between 1 byte and 16 MiB.".to_owned()).into());
    }
    let title = args.option("title").unwrap_or("Imported AI response");
    let id = new_uuid();
    let filename = input
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("response");
    let mut record = ArchiveRecord::new(
        RecordType::AI_JOB,
        &id,
        [
            ("session_id", session_id.clone()),
            ("mode", "manual".to_owned()),
            ("status", "response-needs-correction".to_owned()),
            ("schema_valid", "false".to_owned()),
            ("source_validation", "missing-evidence".to_owned()),
            (
                "import_warnings",
                "The response was stored for review; create or edit a guide before reuse.".to_owned(),
            ),
            ("guide_id", String::new()),
            ("title", title.to_owned()),
            ("original_filename", filename.to_owned()),
            ("content_hash", format!("{:x}", Sha256::digest(text.as_bytes()))),
            ("created_at_us", now_us().to_string()),
        ],
    );
    record.blob = text.into_bytes();
    let next = snapshot.append_records(&[record])?;
    crate::core::cli::records::save_replacing(path, &next)?;
    emit(
        output,
        json!({
            "job_id": id,
            "guide_id": "",
            "status": "response-needs-correction",
            "schema_valid": false,
            "source_validation": "missing-evidence",
            "warnings": ["The response was stored for review; create or edit a guide before reuse."],
        }),
        "Imported AI response for review.",
        args.json(),
    );
    Ok(0)
}

pub(super) fn jobs(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = ready(path, context)?;
    let records = snapshot.list_records(RecordType::AI_JOB, args.flag("include-deleted"))?;
    emit(
        output,
        Value::Array(records.iter().map(crate::core::cli::records::plain).collect()),
        &format!("{} AI job(s).", records.len()),
        args.json(),
    );
    Ok(0)
}

pub(super) fn cancel(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let id = args.required_position(0, "AI job ID")?.to_lowercase();
    let snapshot = ready(path, context)?;
    let job = snapshot
        .get_record(RecordType::AI_JOB, &id)?
        .filter(|record| !record.deleted())
        .ok_or_else(|| CliError("AI job was not found.".to_owned()))?;
    let mut updated = job;
    updated
        .fields
        .insert("status".to_owned(), "cancelled".to_owned());
    updated
        .fields
        .insert("updated_at_us".to_owned(), now_us().to_string());
    let next = snapshot.append_records(&[updated.clone()])?;
    crate::core::cli::records::save_replacing(path, &next)?;
    emit(
        output,
        crate::core::cli::records::plain(&updated),
        &format!("AI job {id} cancelled."),
        args.json(),
    );
    Ok(0)
}

pub(super) fn resolve_credential(
    snapshot: &ArchiveSnapshot,
    provider: &ProviderDef,
    args: &ParsedArguments,
) -> CliResult<String> {
    let env_name = args
        .option("api-key-env")
        .map(str::to_owned)
        .or_else(|| provider.credential_key.map(str::to_owned));
    if let Some(name) = env_name {
        if !name.is_empty() {
            if !name.bytes().enumerate().all(|(index, byte)| {
                byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
            }) {
                return Err(CliError("Invalid API key environment variable name.".to_owned()).into());
            }
            if let Ok(value) = std::env::var(&name) {
                if !value.is_empty() {
                    return Ok(value);
                }
            }
        }
    }
    if snapshot.encrypted() {
        if let Ok(records) = snapshot.list_records(RecordType::SETTINGS, false) {
            if let Some(record) = records.into_iter().find(|record| {
                record.field("record_role") == Some("credential")
                    && (record.field("provider_id") == Some(provider.id)
                        || record.field("key") == provider.credential_key)
            }) {
                return Ok(record.field("value").unwrap_or("").to_owned());
            }
        }
    }
    if provider.credential_key.is_some() {
        if let Ok(value) = crate::credentials::load(provider.id) {
            return Ok(value.to_string());
        }
    }
    Ok(String::new())
}

