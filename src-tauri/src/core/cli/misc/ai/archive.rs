use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::core::archive::{new_uuid, now_us, ArchiveSnapshot};
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{ArchiveRecord, RecordType};

use super::super::providers::ProviderDef;
use super::package::create_package;
use super::response::create as create_proposal;
use super::ready;

pub(super) fn package(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let format = args.option("format").unwrap_or("json");
    if !["json", "markdown", "md", "parts", "zip"].contains(&format) {
        return Err(CliError("Package format must be json, markdown, parts, or zip.".to_owned()).into());
    }
    let mode = args.option("mode").unwrap_or("manual");
    if !matches!(mode, "manual" | "local") {
        return Err(CliError("Package mode must be manual or local.".to_owned()).into());
    }
    if mode == "local" && format != "json" {
        return Err(CliError("Local packages require JSON format.".to_owned()).into());
    }
    if format == "zip" && !args.flag("confirm-sensitive") {
        return Err(CliError(
            "ZIP packages include session materials; use --confirm-sensitive to export them.".to_owned(),
        )
        .into());
    }
    let snapshot = ready(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    let image_ids: Vec<String> = args
        .option("image-ids")
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();
    let summary = create_package(
        &snapshot,
        &session_id,
        args.option("template").unwrap_or("auto"),
        &image_ids,
    )?;
    let mut job = summary.job.clone();
    job.fields.insert("requested_mode".to_owned(), mode.to_owned());
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
            "job_id": job.id,
            "session_id": summary.session_id,
            "template_id": summary.template_id,
            "content_hash": summary.content_hash,
            "package_bytes": summary.byte_length,
            "transcript_segments": summary.transcript_count,
            "annotations": summary.annotation_count,
            "evidence": summary.evidence_count,
            "assets": summary.asset_count,
            "output": destination.as_ref().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default(),
        }),
        &format!("AI package {} prepared. SHA-256: {}.", job.id, summary.content_hash),
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
    let bytes = std::fs::read(&input).map_err(|error| {
        crate::core::error::CoreError::new(
            "ai_import_failed",
            format!("Could not read AI response: {error}"),
        )
    })?;
    if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
        return Err(CliError("Response must be between 1 byte and 16 MiB.".to_owned()).into());
    }
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| CliError("The response was not valid UTF-8.".to_owned()))?;
    let response_template = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.get("template_id").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "general".to_owned());
    let expected_template = args.option("template").unwrap_or(&response_template).to_owned();
    let mut proposal = create_proposal(&text, &session_id, &expected_template);
    if let Some(title) = args.option("title") {
        proposal.draft.title = title.to_owned();
    }
    let scope = crate::core::cli::records::read_guide_scope(&snapshot, &session_id)?;
    let mut source_validation = "passed";
    let guide = match crate::core::cli::records::make_guide_record(&proposal.draft, &scope, None) {
        Ok(record) => record,
        Err(_) => {
            source_validation = "failed";
            proposal.warnings.push(
                "Some source links need correction; the original response was kept as editable text."
                    .to_owned(),
            );
            let fallback = crate::core::cli::records::GuideDraft {
                title: "AI response — review required".to_owned(),
                session_id: session_id.clone(),
                entry_id: String::new(),
                template_id: expected_template.clone(),
                sections: vec![crate::core::cli::records::GuideSection {
                    id: new_uuid(),
                    heading: "Generated response — review required".to_owned(),
                    blocks: vec![crate::core::cli::records::GuideBlock {
                        kind: "paragraph".to_owned(),
                        text: text.clone(),
                        source_ids: Vec::new(),
                        stale: false,
                        origin: "ai-generated".to_owned(),
                    }],
                }],
            };
            crate::core::cli::records::make_guide_record(&fallback, &scope, None)?
        }
    };
    if source_validation == "passed"
        && !proposal
            .draft
            .sections
            .iter()
            .any(|section| section.blocks.iter().any(|block| !block.source_ids.is_empty()))
    {
        source_validation = "missing-evidence";
    }
    let status = if proposal.schema_valid && source_validation == "passed" {
        "response-imported"
    } else {
        "response-needs-correction"
    };
    let filename = input
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("response");
    let mut job = ArchiveRecord::new(
        RecordType::AI_JOB,
        new_uuid(),
        [
            ("session_id", session_id.clone()),
            ("mode", "manual".to_owned()),
            ("status", status.to_owned()),
            ("schema_valid", proposal.schema_valid.to_string()),
            ("source_validation", source_validation.to_owned()),
            ("import_warnings", proposal.warnings.join("\n")),
            ("guide_id", guide.id.clone()),
            ("original_filename", filename.to_owned()),
            ("content_hash", format!("{:x}", Sha256::digest(&bytes))),
            ("created_at_us", now_us().to_string()),
        ],
    );
    job.blob = bytes;
    let mut changes =
        crate::core::cli::records::guide_records_with_entry_links(&guide, None, &scope.records)?;
    changes.push(job.clone());
    let next = snapshot.append_records(&changes)?;
    crate::core::cli::records::save_replacing(path, &next)?;
    emit(
        output,
        json!({
            "job_id": job.id,
            "guide_id": guide.id,
            "status": status,
            "schema_valid": proposal.schema_valid,
            "source_validation": source_validation,
            "warnings": proposal.warnings,
        }),
        &format!("Imported response as unapproved guide {} ({status}).", guide.id),
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

