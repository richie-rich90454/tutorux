use std::path::Path;

use serde_json::{json, Value};

use crate::core::archive::{now_us, ArchiveSnapshot};
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{ArchiveRecord, RecordType};

use super::super::providers::{
    authentication, open_code_zen_protocol, validate_endpoint, ProviderDef,
};
use super::{
    provider_or_error, ready, resolve_credential, structured_output, MAX_MODELS_RESPONSE_BYTES,
    OLLAMA_METADATA_MAX_BYTES,
};

pub(super) fn models(
    
    action: &str,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = ready(path, context)?;
    let provider = provider_or_error(args.required_option("provider")?)?;
    if provider.id == "embedded-gguf" {
        return embedded_models(action, args, output, &snapshot);
    }
    if provider.id == "replicate" {
        return Err(CliError(
            "Replicate does not expose a model catalog through this CLI; configure a model identifier directly."
                .to_owned(),
        )
        .into());
    }
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
    let credential = zeroize::Zeroizing::new(resolve_credential(&snapshot, provider, args)?);
    if !provider.local && credential.is_empty() {
        return Err(CliError("A provider API key is required for model discovery.".to_owned()).into());
    }
    let model_ids = discover_models(provider, &endpoint, &credential)?;
    if action == "test" {
        emit(
            output,
            json!({
                "provider": provider.id,
                "status": "connected",
                "model_count": model_ids.len(),
            }),
            &format!("Connected to {}; {} model(s) available.", provider.name, model_ids.len()),
            args.json(),
        );
        return Ok(0);
    }
    let checked_at = now_us().to_string();
    let rows: Vec<Value> = model_ids
        .iter()
        .map(|model_id| {
            json!({
                "provider_id": provider.id,
                "model_id": model_id,
                "owner": "",
                "catalog_state": "listed",
                "capabilities": format!("structured={};streaming={};tools=unknown", structured_output(provider.id, model_id), if matches!(provider.id, "replicate" | "embedded-gguf") { "unsupported" } else { "supported" }),
                "protocol_family": protocol_family(provider.id, model_id),
                "context_window": "",
                "maximum_output_tokens": "",
                "input_modalities": "",
                "output_modalities": "",
                "structured_output_support": structured_output(provider.id, model_id),
                "streaming_support": if matches!(provider.id, "replicate" | "embedded-gguf") { "unsupported" } else { "supported" },
                "tool_support": "unknown",
                "tokenizer_information": "unknown",
                "pricing_information": "unknown",
                "availability_status": "listed",
                "verification_status": "unverified",
                "metadata_source": "provider-api",
                "api_family": protocol_family(provider.id, model_id),
                "catalog_source": "provider-api",
                "discovered_at_us": checked_at,
                "catalog_freshness": "fresh",
                "catalog_age_seconds": "0",
                "catalog_checked_at_us": checked_at,
                "catalog_ttl_seconds": "3600",
                "catalog_status": "fresh",
                "catalog_refresh_source": "provider-api",
            })
        })
        .collect();
    emit(
        output,
        Value::Array(rows),
        &format!("{} model(s) discovered for {}.", model_ids.len(), provider.name),
        args.json(),
    );
    Ok(0)
}

pub(super) fn embedded_models(
    action: &str,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    snapshot: &ArchiveSnapshot,
) -> CliResult<i32> {
    let models: Vec<ArchiveRecord> = snapshot
        .list_records(RecordType::SETTINGS, false)?
        .into_iter()
        .filter(|record| {
            record.field("record_role") == Some("model-reference")
                && matches!(record.field("provider"), Some("llama.cpp-embedded") | Some("embedded-gguf"))
        })
        .collect();
    if action == "test" {
        emit(
            output,
            json!({
                "provider": "embedded-gguf",
                "status": "connected",
                "model_count": models.len(),
            }),
            &format!("Embedded GGUF runtime is available; {} model reference(s).", models.len()),
            args.json(),
        );
        return Ok(0);
    }
    emit(
        output,
        Value::Array(models.iter().map(crate::core::cli::records::plain).collect()),
        &format!("{} embedded model reference(s).", models.len()),
        args.json(),
    );
    Ok(0)
}

fn protocol_family(provider_id: &str, model: &str) -> &'static str {
    match provider_id {
        "anthropic" => "anthropic-messages",
        "google-gemini" => "gemini-generate-content",
        "cohere" => "cohere-chat-v2",
        "perplexity" => "perplexity-agent",
        "ollama" => "ollama-chat",
        "replicate" => "replicate-prediction-api",
        "embedded-gguf" => "embedded-gguf-runtime",
        "opencode-zen" if open_code_zen_protocol(model) == "anthropic" => "anthropic-messages",
        "opencode-zen" if open_code_zen_protocol(model) == "gemini" => "gemini-generate-content",
        "opencode-zen" if open_code_zen_protocol(model) == "openai-responses" => "openai-responses",
        _ => "openai-chat-completions",
    }
}

fn discover_models(
    provider: &ProviderDef,
    endpoint: &str,
    credential: &str,
) -> CliResult<Vec<String>> {
    if provider.id == "ollama" {
        let root = endpoint.strip_suffix("/v1").unwrap_or(endpoint);
        let value = block_http(
            |client| {
                client
                    .get(format!("{root}/api/tags"))
                    .timeout(std::time::Duration::from_secs(20))
            },
            MAX_MODELS_RESPONSE_BYTES,
        )?;
        return Ok(value
            .get("models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model.get("name").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default());
    }
    let mut headers: Vec<(&'static str, String)> = Vec::new();
    if !credential.is_empty() {
        let (name, raw) = authentication(provider, "").unwrap_or(("Authorization", false));
        let value = if raw || name.eq_ignore_ascii_case("api-key") || name.eq_ignore_ascii_case("x-goog-api-key") || name.eq_ignore_ascii_case("x-api-key") {
            credential.to_owned()
        } else {
            format!("Bearer {credential}")
        };
        headers.push((name, value));
    }
    let value = block_http(
        |client| {
            let mut request = client
                .get(format!("{endpoint}/models"))
                .header(reqwest::header::ACCEPT, "application/json")
                .timeout(std::time::Duration::from_secs(20));
            for (name, value) in &headers {
                request = request.header(*name, value);
            }
            request
        },
        MAX_MODELS_RESPONSE_BYTES,
    )?;
    let models = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .ok_or_else(|| CliError("The provider returned no model catalog.".to_owned()))?;
    Ok(models
        .iter()
        .filter_map(|model| {
            model
                .get("id")
                .or_else(|| model.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect())
}

pub(super) fn ollama_context_length(endpoint: &str, model: &str) -> CliResult<Option<u64>> {
    let root = endpoint.strip_suffix("/v1").unwrap_or(endpoint);
    let value = block_http(
        |client| {
            client
                .post(format!("{root}/api/show"))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(
                    serde_json::to_string(&json!({"model": model, "verbose": false}))
                        .unwrap_or_default(),
                )
                .timeout(std::time::Duration::from_secs(30))
        },
        OLLAMA_METADATA_MAX_BYTES,
    )?;
    let length = value
        .get("model_info")
        .and_then(Value::as_object)
        .map(|info| {
            info.iter()
                .filter(|(name, value)| name.ends_with(".context_length") && value.is_u64())
                .filter_map(|(_, value)| value.as_u64())
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    Ok((length > 0).then_some(length))
}

pub(super) fn block_http(
    make: impl FnOnce(reqwest::Client) -> reqwest::RequestBuilder,
    limit: usize,
) -> CliResult<Value> {
    let result: Result<Value, CliError> = tauri::async_runtime::block_on(async {
        let response = make(reqwest::Client::new()).send().await.map_err(|error| {
            CliError(format!("The provider request could not be completed: {error}"))
        })?;
        if !response.status().is_success() {
            return Err(CliError(format!(
                "The provider returned HTTP {}.",
                response.status().as_u16()
            )));
        }
        if response.content_length().unwrap_or(0) as usize > limit {
            return Err(CliError("The provider response exceeded the supported limit.".to_owned()));
        }
        let bytes = response.bytes().await.map_err(|error| {
            CliError(format!("The provider response could not be read: {error}"))
        })?;
        if bytes.len() > limit {
            return Err(CliError("The provider response exceeded the supported limit.".to_owned()));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| CliError("The provider returned invalid JSON.".to_owned()))
    });
    result.map_err(Into::into)
}

