use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::core::archive::{now_us, ArchiveSnapshot};
use crate::core::cli::{emit, parse_integer, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{ArchiveRecord, RecordType};
use crate::embedded_ai::{generate_model_text, inspect_model_path};

use super::provider_or_error;
use super::super::providers::{is_openai_compatible, open_code_zen_protocol, validate_endpoint, ProviderDef};
use super::{ready, resolve_credential, AI_GENERATION_SYSTEM_PROMPT};

pub(super) fn generate(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = ready(path, context)?;
    let job_id = args.required_option("job")?.to_lowercase();
    let job = snapshot
        .get_record(RecordType::AI_JOB, &job_id)?
        .filter(|record| !record.deleted())
        .ok_or_else(|| CliError("AI job was not found.".to_owned()))?;
    if job.blob.is_empty() {
        return Err(CliError(
            "Prepare an AI package with `ai package` before generating.".to_owned(),
        )
        .into());
    }
    let provider = provider_or_error(args.required_option("provider")?)?;
    if !provider.generation_available {
        return Err(CliError(provider.generation_unavailable_reason.to_owned()).into());
    }
    if job.field("requested_mode") == Some("local") && !provider.local {
        return Err(CliError("A local package can only be sent to a local provider.".to_owned()).into());
    }
    let configured = snapshot.get_record(
        RecordType::SETTINGS,
        &crate::core::cli::records::deterministic_uuid(&format!("ai-provider:{}", provider.id)),
    )?;
    let model = args
        .option("model")
        .map(str::to_owned)
        .or_else(|| configured.as_ref().and_then(|value| value.field("selected_model").map(str::to_owned)))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CliError("Select a model with --model or `ai configure --model`.".to_owned()))?;
    let max_tokens = parse_integer(args.option("max-tokens"), "max-tokens", 4096, 1, 1_000_000)?;
    let the_package: Value = serde_json::from_slice(&job.blob)
        .map_err(|_| CliError("The stored AI package is invalid.".to_owned()))?;

    if provider.id == "embedded-gguf" {
        return generate_embedded(
            args, output, path, provider, &model, max_tokens, &snapshot, &job, &the_package,
        );
    }
    if provider.id == "replicate" {
        return Err(CliError(
            "Replicate prediction orchestration is available in the desktop host; the Rust CLI cannot review and poll a Replicate generation yet."
                .to_owned(),
        )
        .into());
    }
    let endpoint = configured
        .as_ref()
        .and_then(|value| value.field("endpoint"))
        .map(str::to_owned)
        .unwrap_or_else(|| provider.default_endpoint.to_owned());
    let endpoint = validate_endpoint(&endpoint, provider).map_err(CliError)?;
    let credential = resolve_credential(&snapshot, provider, args)?;
    let (url, accept, body) = provider_request(provider, &endpoint, &model, max_tokens, &the_package)?;
    let body_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let request_output = args.option("request-output").map(crate::core::cli::resolve_path);
    if let Some(destination) = &request_output {
        if crate::core::cli::records::same_path_public(destination, path) {
            return Err(CliError("Request output cannot replace its source archive.".to_owned()).into());
        }
        crate::core::cli::write_file_atomically(destination, body.as_bytes())?;
    }
    let result = json!({
        "provider": provider.id,
        "endpoint": url,
        "model": model,
        "package_hash": job.field("content_hash").unwrap_or(""),
        "request_body_hash": body_hash,
        "request_bytes": body.len(),
        "local_only": provider.local,
        "credential_available": !credential.is_empty(),
    });
    if !args.flags.contains("confirm-outbound") && !provider.local {
        emit(
            output,
            result,
            &format!(
                "Review request to {url}. Request SHA-256: {body_hash}. Retry with --confirm-outbound --confirm-hash {body_hash}."
            ),
            args.json(),
        );
        return Ok(0);
    }
    if !provider.local
        && (credential.is_empty() || args.option("confirm-hash") != Some(body_hash.as_str()))
    {
        return Err(CliError(
            "Provide a provider API key and confirm the exact request hash.".to_owned(),
        )
        .into());
    }
    let response = tauri::async_runtime::block_on(crate::ai_transport::headless::send(
        crate::ai_transport::headless::HeadlessAiRequest {
            provider_id: provider.id.to_owned(),
            endpoint: url,
            model: model.clone(),
            accept,
            body,
            credential: zeroize::Zeroizing::new(credential),
            replicate_request_id: String::new(),
            cancel_replicate_request: false,
            inspect_replicate_model: false,
        },
    ))
    .map_err(CliError)?;
    if response.status >= 400 {
        return Err(CliError(format!(
            "The provider returned HTTP {}: {}",
            response.status,
            String::from_utf8_lossy(&response.body).chars().take(400).collect::<String>()
        ))
        .into());
    }
    let mut updated = job.clone();
    updated
        .fields
        .insert("status".to_owned(), "response-received".to_owned());
    updated
        .fields
        .insert("provider_id".to_owned(), provider.id.to_owned());
    updated.fields.insert("selected_model".to_owned(), model.clone());
    updated
        .fields
        .insert("request_body_hash".to_owned(), body_hash.clone());
    updated
        .fields
        .insert("response_bytes".to_owned(), response.response_bytes.to_string());
    updated
        .fields
        .insert("updated_at_us".to_owned(), now_us().to_string());
    updated.blob = response.body;
    let next = snapshot.append_records(&[updated])?;
    crate::core::cli::records::save_replacing(path, &next)?;
    emit(
        output,
        json!({
            "provider": provider.id,
            "model": model,
            "job_id": job.id,
            "status": "response-received",
            "http_status": response.status,
            "content_type": response.content_type,
            "response_bytes": response.response_bytes,
            "complete": response.complete,
            "request_body_hash": body_hash,
        }),
        &format!("AI job {}: response received ({} bytes).", job.id, response.response_bytes),
        args.json(),
    );
    Ok(0)
}

fn generate_embedded(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    provider: &ProviderDef,
    model: &str,
    max_tokens: u64,
    snapshot: &ArchiveSnapshot,
    job: &ArchiveRecord,
    package: &Value,
) -> CliResult<i32> {
    let reference = snapshot
        .list_records(RecordType::SETTINGS, false)?
        .into_iter()
        .find(|record| {
            record.field("record_role") == Some("model-reference")
                && record.field("model_id") == Some(model)
                && matches!(record.field("provider"), Some("llama.cpp-embedded") | Some("embedded-gguf"))
                && record.field("active") == Some("true")
        })
        .ok_or_else(|| CliError("Select an active embedded GGUF model reference first.".to_owned()))?;
    let model_path = reference.field("path").unwrap_or("");
    if model_path.is_empty() {
        return Err(CliError("The model reference has no GGUF path.".to_owned()).into());
    }
    let resolved = if Path::new(model_path).is_absolute() {
        std::path::PathBuf::from(model_path)
    } else {
        path.parent().unwrap_or_else(|| Path::new(".")).join(model_path)
    };
    let inspection = inspect_model_path(&resolved.to_string_lossy()).map_err(CliError)?;
    let threads = reference
        .field("cpu_threads")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|value| u32::try_from(value.get()).unwrap_or(4).clamp(1, 16))
                .unwrap_or(4)
        });
    let mut response = String::new();
    let mut stream_error: Option<String> = None;
    let generated = generate_model_text(
        &inspection.path,
        AI_GENERATION_SYSTEM_PROMPT,
        &serde_json::to_string(package).unwrap_or_default(),
        max_tokens.min(u64::from(u32::MAX)) as u32,
        threads,
        &mut |text| {
            if response.len() + text.len() > 8 * 1024 * 1024 {
                stream_error = Some("Generated local text exceeded the 8 MiB output limit.".to_owned());
                return Err(stream_error.clone().unwrap_or_default());
            }
            response.push_str(text);
            Ok(())
        },
    )
    .map_err(CliError)?;
    if let Some(error) = stream_error {
        return Err(CliError(error).into());
    }
    let mut updated = job.clone();
    updated
        .fields
        .insert("status".to_owned(), "response-received".to_owned());
    updated
        .fields
        .insert("provider_id".to_owned(), provider.id.to_owned());
    updated
        .fields
        .insert("selected_model".to_owned(), model.to_owned());
    updated.fields.insert(
        "response_bytes".to_owned(),
        response.len().to_string(),
    );
    updated
        .fields
        .insert("generated_tokens".to_owned(), generated.0.to_string());
    updated
        .fields
        .insert("updated_at_us".to_owned(), now_us().to_string());
    updated.blob = response.into_bytes();
    let next = snapshot.append_records(&[updated.clone()])?;
    crate::core::cli::records::save_replacing(path, &next)?;
    let destination = args.option("output").map(crate::core::cli::resolve_path);
    if let Some(destination) = &destination {
        crate::core::cli::write_file_atomically(destination, &updated.blob)?;
    }
    emit(
        output,
        json!({
            "provider": provider.id,
            "model": model,
            "job_id": job.id,
            "status": "response-received",
            "generated_tokens": generated.0.to_string(),
            "response_bytes": updated.blob.len(),
            "output": destination.as_ref().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default(),
        }),
        &format!("AI job {}: local response generated.", job.id),
        args.json(),
    );
    Ok(0)
}

fn provider_request(
    provider: &ProviderDef,
    endpoint: &str,
    model: &str,
    max_tokens: u64,
    package: &Value,
) -> CliResult<(String, String, String)> {
    let prompt = serde_json::to_string(package).unwrap_or_default();
    let (url, accept, body) = if provider.id == "anthropic" {
        (
            format!("{endpoint}/v1/messages"),
            "text/event-stream".to_owned(),
            json!({
                "model": model,
                "max_tokens": max_tokens,
                "system": AI_GENERATION_SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": prompt}],
                "stream": true,
            }),
        )
    } else if provider.id == "google-gemini" {
        let model = model.strip_prefix("models/").unwrap_or(model);
        (
            format!("{endpoint}/models/{model}:streamGenerateContent?alt=sse"),
            "text/event-stream".to_owned(),
            json!({
                "systemInstruction": {"parts": [{"text": AI_GENERATION_SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": max_tokens},
            }),
        )
    } else if provider.id == "cohere" {
        (
            format!("{endpoint}/v2/chat"),
            "text/event-stream".to_owned(),
            json!({
                "model": model,
                "messages": [
                    {"role": "system", "content": AI_GENERATION_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": max_tokens,
                "stream": true,
            }),
        )
    } else if provider.id == "perplexity" {
        (
            format!("{endpoint}/agent"),
            "text/event-stream".to_owned(),
            json!({
                "model": model,
                "messages": [
                    {"role": "system", "content": AI_GENERATION_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": max_tokens,
                "stream": true,
            }),
        )
    } else if provider.id == "ollama" {
        (
            format!("{endpoint}/api/chat"),
            "application/x-ndjson".to_owned(),
            json!({
                "model": model,
                "messages": [
                    {"role": "system", "content": AI_GENERATION_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "stream": true,
                "options": {"num_predict": max_tokens},
            }),
        )
    } else if is_openai_compatible(provider) || provider.id == "opencode-zen" {
        let url = format!("{endpoint}/chat/completions");
        if provider.id == "opencode-zen" && open_code_zen_protocol(model) == "anthropic" {
            (
                format!("{endpoint}/v1/messages"),
                "text/event-stream".to_owned(),
                json!({
                    "model": model,
                    "max_tokens": max_tokens,
                    "system": AI_GENERATION_SYSTEM_PROMPT,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": true,
                }),
            )
        } else {
            (
                url,
                "text/event-stream".to_owned(),
                json!({
                    "model": model,
                    "messages": [
                        {"role": "system", "content": AI_GENERATION_SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                    ],
                    "max_tokens": max_tokens,
                    "stream": true,
                }),
            )
        }
    } else {
        return Err(CliError(format!(
            "{} is not supported for CLI generation.",
            provider.name
        ))
        .into());
    };
    Ok((url, accept, serde_json::to_string(&body).unwrap_or_default()))
}

