use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::core::archive::{new_uuid, now_us, ArchiveSnapshot};
use crate::core::cli::{emit, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{ArchiveRecord, RecordType};

use super::super::providers::{validate_endpoint, ProviderDef};
use super::replicate_schema::{build_prompt, inspect_schema, split_model};
use super::{resolve_credential, AI_GENERATION_SYSTEM_PROMPT};

const OUTPUT_PREVIEW_CHARS: usize = 40_000;

struct PredictionSummary {
    id: String,
    status: String,
    error: Option<String>,
    output_kind: &'static str,
    output_count: usize,
    output_text: Option<String>,
    output_urls: Vec<String>,
}

pub(super) fn generate(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    snapshot: &ArchiveSnapshot,
    provider: &ProviderDef,
    model: &str,
    max_tokens: u64,
    job: &ArchiveRecord,
    package: &Value,
) -> CliResult<i32> {
    let configured = snapshot.get_record(
        RecordType::SETTINGS,
        &crate::core::cli::records::deterministic_uuid(&format!("ai-provider:{}", provider.id)),
    )?;
    let endpoint = configured
        .as_ref()
        .and_then(|value| value.field("endpoint"))
        .map(str::to_owned)
        .unwrap_or_else(|| provider.default_endpoint.to_owned());
    let endpoint = validate_endpoint(&endpoint, provider).map_err(CliError)?;
    let credential = resolve_credential(snapshot, provider, args)?;
    if !credential.is_empty()
        && (credential.len() > 4096 || !credential.bytes().all(|byte| byte.is_ascii_graphic()))
    {
        return Err(CliError("The saved Replicate API token is invalid.".to_owned()).into());
    }
    let (owner, name) = split_model(model)?;
    let schema_url = format!("{endpoint}/models/{owner}/{name}");
    let schema = inspect_schema(&schema_url, &credential)?;
    let prompt = build_prompt(package, schema.has_system_prompt)?;
    let mut input = json!({ "prompt": prompt });
    if schema.has_system_prompt {
        input["system_prompt"] = json!(AI_GENERATION_SYSTEM_PROMPT);
    }
    if let Some(token_input) = schema.token_input {
        input[token_input] = json!(max_tokens);
    }
    let body = serde_json::to_string(&json!({
        "version": schema.version,
        "input": input,
    }))
    .unwrap_or_default();
    let body_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let request_output = args
        .option("request-output")
        .map(crate::core::cli::resolve_path);
    if let Some(destination) = &request_output {
        if crate::core::cli::records::same_path_public(destination, path) {
            return Err(
                CliError("Request output cannot replace its source archive.".to_owned()).into(),
            );
        }
        crate::core::cli::write_file_atomically(destination, body.as_bytes())?;
    }
    let prediction_endpoint = format!("{schema_url}/predictions");
    let result = json!({
        "provider": provider.id,
        "endpoint": prediction_endpoint,
        "model": model,
        "package_hash": job.field("content_hash").unwrap_or(""),
        "request_body_hash": body_hash,
        "request_bytes": body.len(),
        "local_only": false,
        "credential_available": !credential.is_empty(),
    });
    if !args.flags.contains("confirm-outbound") {
        emit(
            output,
            result,
            &format!(
                "Review request to {prediction_endpoint}. Request SHA-256: {body_hash}. Retry with --confirm-outbound --confirm-hash {body_hash}."
            ),
            args.json(),
        );
        return Ok(0);
    }
    if credential.is_empty() || args.option("confirm-hash") != Some(body_hash.as_str()) {
        return Err(CliError(
            "Provide a provider API key and confirm the exact request hash.".to_owned(),
        )
        .into());
    }
    let prediction_id = new_uuid();
    let response = tauri::async_runtime::block_on(crate::ai_transport::headless::send(
        crate::ai_transport::headless::HeadlessAiRequest {
            provider_id: provider.id.to_owned(),
            endpoint: prediction_endpoint.clone(),
            model: model.to_owned(),
            accept: "application/json".to_owned(),
            body,
            credential: zeroize::Zeroizing::new(credential),
            replicate_request_id: prediction_id,
            cancel_replicate_request: false,
            inspect_replicate_model: false,
        },
    ))
    .map_err(CliError)?;
    let prediction = summarize_prediction(&response.body);
    let status = if response.cancelled {
        "cancelled"
    } else if response.status >= 400
        || prediction
            .as_ref()
            .is_some_and(|value| value.status == "failed")
    {
        "provider-error"
    } else if response.error_message.is_some() || !response.complete {
        "response-partial"
    } else {
        "response-received"
    };
    let error_message = response
        .error_message
        .clone()
        .or_else(|| prediction.as_ref().and_then(|value| value.error.clone()))
        .or_else(|| {
            (response.status >= 400).then(|| match response.status {
                401 | 403 => "Replicate rejected the API token or model access. Its raw response was saved for export.".to_owned(),
                429 => "Replicate rate limited the prediction. Its raw response was saved for export.".to_owned(),
                408 => "Replicate prediction timed out after five minutes.".to_owned(),
                status => format!("The provider returned HTTP {status}. Its raw response was saved for export."),
            })
        });
    let error_code = if response.cancelled {
        "operation_cancelled".to_owned()
    } else if response.status >= 400 {
        format!("provider_http_{}", response.status)
    } else if status == "response-partial" {
        "response_partial".to_owned()
    } else {
        String::new()
    };
    let mut updated = job.clone();
    updated
        .fields
        .insert("status".to_owned(), status.to_owned());
    if !error_code.is_empty() {
        updated
            .fields
            .insert("error_code".to_owned(), error_code.clone());
    }
    updated
        .fields
        .insert("provider_id".to_owned(), provider.id.to_owned());
    updated.fields.insert("mode".to_owned(), "byok".to_owned());
    updated.fields.insert(
        "processing_boundary".to_owned(),
        "remote-provider".to_owned(),
    );
    updated
        .fields
        .insert("source_package_job_id".to_owned(), job.id.clone());
    updated.fields.insert(
        "request_package_sha256".to_owned(),
        job.field("content_hash").unwrap_or("").to_owned(),
    );
    updated
        .fields
        .insert("outbound_consent_hash".to_owned(), body_hash.clone());
    updated.fields.insert(
        "outbound_consent_method".to_owned(),
        "explicit-replicate-prediction-lifecycle".to_owned(),
    );
    updated
        .fields
        .insert("outbound_confirmed_at_us".to_owned(), now_us().to_string());
    updated
        .fields
        .insert("max_output_tokens".to_owned(), max_tokens.to_string());
    updated.fields.insert(
        "replicate_model_schema_version".to_owned(),
        schema.version.clone(),
    );
    updated
        .fields
        .insert("model_id".to_owned(), model.to_owned());
    updated
        .fields
        .insert("selected_model".to_owned(), model.to_owned());
    updated
        .fields
        .insert("request_body_hash".to_owned(), body_hash.clone());
    updated.fields.insert(
        "response_bytes".to_owned(),
        response.response_bytes.to_string(),
    );
    updated
        .fields
        .insert("http_status".to_owned(), response.status.to_string());
    updated.fields.insert(
        "response_content_type".to_owned(),
        response.content_type.clone(),
    );
    updated.fields.insert(
        "response_complete".to_owned(),
        response.complete.to_string(),
    );
    updated.fields.insert(
        "response_sha256".to_owned(),
        format!("{:x}", Sha256::digest(&response.body)),
    );
    if let Some(message) = &error_message {
        updated
            .fields
            .insert("error_message".to_owned(), message.clone());
    }
    if let Some(value) = &prediction {
        updated
            .fields
            .insert("provider_response_id".to_owned(), value.id.clone());
        updated
            .fields
            .insert("replicate_prediction_id".to_owned(), value.id.clone());
        updated
            .fields
            .insert("replicate_status".to_owned(), value.status.clone());
    }
    updated
        .fields
        .insert("updated_at_us".to_owned(), now_us().to_string());
    updated.blob = response.body;
    let next = snapshot.append_records(&[updated])?;
    crate::core::cli::records::save_replacing(path, &next)?;

    let mut report = json!({
        "provider": provider.id,
        "model": model,
        "job_id": job.id,
        "status": status,
        "http_status": response.status,
        "content_type": response.content_type,
        "response_bytes": response.response_bytes,
        "complete": response.complete,
        "cancelled": response.cancelled,
        "request_body_hash": body_hash,
        "prediction_endpoint": prediction_endpoint,
    });
    if !error_code.is_empty() {
        report["error_code"] = json!(error_code);
    }
    if let Some(message) = &error_message {
        report["error_message"] = json!(message);
    }
    if let Some(value) = &prediction {
        report["prediction_id"] = json!(value.id);
        report["prediction_status"] = json!(value.status);
        report["output_kind"] = json!(value.output_kind);
        report["output_count"] = json!(value.output_count);
        if !value.output_urls.is_empty() {
            report["output_urls"] = json!(value.output_urls);
        }
        if let Some(text) = &value.output_text {
            let truncated = text.chars().count() > OUTPUT_PREVIEW_CHARS;
            report["output_text"] =
                json!(text.chars().take(OUTPUT_PREVIEW_CHARS).collect::<String>());
            report["output_text_truncated"] = json!(truncated);
        }
    }
    emit(
        output,
        report,
        &format!(
            "AI job {}: {status} ({} bytes).",
            job.id, response.response_bytes
        ),
        args.json(),
    );
    Ok(0)
}

fn summarize_prediction(bytes: &[u8]) -> Option<PredictionSummary> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let id = value.get("id")?.as_str()?.to_owned();
    let status = value.get("status")?.as_str()?.to_ascii_lowercase();
    let output = value.get("output");
    let mut urls = Vec::new();
    let mut text = None;
    let mut count = 0usize;
    let mut kind = "none";
    match output {
        Some(Value::String(value)) => {
            count = 1;
            if value.starts_with("https://") || value.starts_with("http://") {
                kind = "files";
                urls.push(value.clone());
            } else {
                kind = "text";
                text = Some(value.clone());
            }
        }
        Some(Value::Array(items)) => {
            count = items.len();
            let strings: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            if !items.is_empty() && strings.len() == items.len() {
                if strings
                    .iter()
                    .all(|value| value.starts_with("https://") || value.starts_with("http://"))
                {
                    kind = "files";
                    urls.extend(strings.iter().map(|value| (*value).to_owned()));
                } else {
                    kind = "text";
                    text = Some(strings.concat());
                }
            } else if !items.is_empty() {
                kind = "unknown";
            }
        }
        _ => {}
    }
    let error = match value.get("error") {
        Some(Value::String(message)) if !message.trim().is_empty() => Some(message.clone()),
        Some(Value::Object(object)) => object
            .get("message")
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty())
            .map(str::to_owned),
        _ => None,
    };
    Some(PredictionSummary {
        id,
        status,
        error,
        output_kind: kind,
        output_count: count,
        output_text: text,
        output_urls: urls,
    })
}

#[cfg(test)]
mod tests {
    use super::summarize_prediction;

    #[test]
    fn prediction_summary_reads_text_and_image_outputs() {
        let text = summarize_prediction(
            br#"{"id":"p1","status":"succeeded","output":["hello"," world"]}"#,
        )
        .expect("text");
        assert_eq!(text.output_kind, "text");
        assert_eq!(text.output_text.as_deref(), Some("hello world"));

        let images = summarize_prediction(
            br#"{"id":"p2","status":"succeeded","output":["https://example.test/a.png"]}"#,
        )
        .expect("images");
        assert_eq!(images.output_kind, "files");
        assert_eq!(images.output_urls.len(), 1);

        let failed = summarize_prediction(
            br#"{"id":"p3","status":"failed","error":{"message":"model failed"}}"#,
        )
        .expect("failed");
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.error.as_deref(), Some("model failed"));
    }
}
