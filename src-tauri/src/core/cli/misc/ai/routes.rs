use serde_json::{json, Value};

use crate::core::cli::misc::providers::{
    is_openai_compatible, open_code_zen_protocol, ProviderDef,
};
use crate::core::cli::{CliError, CliResult};

use super::AI_GENERATION_SYSTEM_PROMPT;

pub(super) fn provider_request(
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
        (
            format!(
                "{endpoint}/models/{}:streamGenerateContent?alt=sse",
                encode_path_segment(model.strip_prefix("models/").unwrap_or(model))
            ),
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
    } else if provider.id == "opencode-zen" {
        open_code_zen_request(endpoint, model, max_tokens, &prompt)?
    } else if is_openai_compatible(provider) {
        (
            format!("{endpoint}/chat/completions"),
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
    } else {
        return Err(CliError(format!(
            "{} is not supported for CLI generation.",
            provider.name
        ))
        .into());
    };
    Ok((
        url,
        accept,
        serde_json::to_string(&body).unwrap_or_default(),
    ))
}

fn open_code_zen_request(
    endpoint: &str,
    model: &str,
    max_tokens: u64,
    prompt: &str,
) -> CliResult<(String, String, Value)> {
    let protocol = open_code_zen_protocol(model);
    if protocol == "restricted" {
        return Err(CliError(
            "OpenCode Zen Jev models return structured classifications, not tutoring guide text."
                .to_owned(),
        )
        .into());
    }
    let base = endpoint.trim_end_matches('/');
    let root = base.strip_suffix("/v1").unwrap_or(base);
    let sse = "text/event-stream".to_owned();
    let value = match protocol {
        "openai-responses" => (
            format!("{root}/openai/v1/responses"),
            sse,
            json!({
                "model": model,
                "instructions": AI_GENERATION_SYSTEM_PROMPT,
                "input": [{
                    "role": "user",
                    "content": [{"type": "input_text", "text": prompt}],
                }],
                "max_output_tokens": max_tokens,
                "stream": true,
            }),
        ),
        "anthropic" => (
            format!("{root}/anthropic/v1/messages"),
            sse,
            json!({
                "model": model,
                "max_tokens": max_tokens,
                "system": AI_GENERATION_SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": prompt}],
                "stream": true,
            }),
        ),
        "gemini" => (
            format!(
                "{root}/google/v1beta/models/{}:streamGenerateContent?alt=sse",
                encode_path_segment(model.strip_prefix("models/").unwrap_or(model))
            ),
            sse,
            json!({
                "systemInstruction": {"parts": [{"text": AI_GENERATION_SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": max_tokens},
            }),
        ),
        _ => (
            format!("{root}/openai/v1/chat/completions"),
            sse,
            json!({
                "model": model,
                "messages": [
                    {"role": "system", "content": AI_GENERATION_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": max_tokens,
                "stream": true,
            }),
        ),
    };
    Ok(value)
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::encode_path_segment;
    use super::provider_request;
    use crate::core::cli::misc::providers::provider_by_id;

    fn body(value: &str) -> serde_json::Value {
        serde_json::from_str(value).expect("request body")
    }

    fn route(
        provider: &crate::core::cli::misc::providers::ProviderDef,
        model: &str,
    ) -> (String, String, String) {
        provider_request(
            provider,
            "https://opencode.ai/inference/v1",
            model,
            800,
            &serde_json::json!({"manifest": {}}),
        )
        .map_err(|_| ())
        .expect("route")
    }

    #[test]
    fn opencode_zen_routes_match_the_desktop_gateway_paths() {
        let zen = provider_by_id("opencode-zen").expect("zen provider");

        let (url, accept, raw) = route(zen, "qwen3-coder");
        assert_eq!(
            url,
            "https://opencode.ai/inference/openai/v1/chat/completions"
        );
        assert_eq!(accept, "text/event-stream");
        assert_eq!(body(&raw)["model"], "qwen3-coder");
        assert_eq!(body(&raw)["stream"], true);

        let (url, _, raw) = route(zen, "gpt-5");
        assert_eq!(url, "https://opencode.ai/inference/openai/v1/responses");
        assert_eq!(body(&raw)["max_output_tokens"], 800);
        assert_eq!(body(&raw)["input"][0]["content"][0]["type"], "input_text");

        let (url, _, raw) = route(zen, "claude-sonnet-4");
        assert_eq!(url, "https://opencode.ai/inference/anthropic/v1/messages");
        assert_eq!(body(&raw)["max_tokens"], 800);
        assert!(body(&raw)["system"].is_string());

        let (url, _, raw) = route(zen, "gemini-2.5-pro");
        assert_eq!(
            url,
            "https://opencode.ai/inference/google/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
        );
        assert_eq!(body(&raw)["generationConfig"]["maxOutputTokens"], 800);
    }

    #[test]
    fn opencode_zen_rejects_structured_classification_models() {
        let zen = provider_by_id("opencode-zen").expect("zen provider");
        let result = provider_request(
            zen,
            "https://opencode.ai/inference/v1",
            "jev-classifier",
            800,
            &serde_json::json!({}),
        );
        assert!(result.is_err());
    }

    #[test]
    fn gemini_models_encode_path_segments() {
        assert_eq!(encode_path_segment("gemini 2.5/pro"), "gemini%202.5%2Fpro");
    }
}
