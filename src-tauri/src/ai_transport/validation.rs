use reqwest::Url;
use std::net::{Ipv4Addr, Ipv6Addr};

use super::{AiTransportRequest, CredentialStorage, TransportPolicy, MAX_REPLICATE_RESPONSE_BYTES};

const MAX_CREDENTIAL_BYTES: usize = 4096;

pub(super) fn valid_replicate_request_id(request_id: &str) -> bool {
    let segments = request_id.split('-').collect::<Vec<_>>();
    segments.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(segments)
            .all(|(expected, segment)| {
                segment.len() == *expected && segment.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
}

pub(super) fn validate_request(
    request: &AiTransportRequest,
    policy: TransportPolicy,
) -> Result<(), String> {
    if request.provider_id.len() > 64
        || request.model.trim().is_empty()
        || request.model.len() > 1024
        || request.model.chars().any(char::is_control)
    {
        return Err("Choose a valid provider model before sending.".to_owned());
    }
    let local = is_local_provider(&request.provider_id);
    let requires_credential = !local;
    if (requires_credential && request.credential_storage == CredentialStorage::None)
        || (!requires_credential
            && (request.credential_storage != CredentialStorage::None
                || !request.credential.is_empty()))
        || (request.credential_storage == CredentialStorage::SystemKeychain
            && !request.credential.is_empty())
        || (request.credential_storage == CredentialStorage::EncryptedArchive
            && request.credential.is_empty())
    {
        return Err("The saved provider credential is missing or invalid.".to_owned());
    }

    let url = Url::parse(&request.endpoint)
        .map_err(|_| "The reviewed provider endpoint is invalid.".to_owned())?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Provider endpoints cannot contain credentials or fragments.".to_owned());
    }
    let loopback_override =
        policy.allow_loopback_http && url.scheme() == "http" && is_loopback_host(&url);
    if local {
        if url.scheme() != "http" || !is_loopback_host(&url) || url.query().is_some() {
            return Err(
                "Local model requests are limited to an HTTP loopback endpoint.".to_owned(),
            );
        }
    } else if url.scheme() != "https" && !loopback_override {
        return Err("Cloud provider requests require HTTPS.".to_owned());
    }

    let path = url.path();
    if request.provider_id == "opencode-zen"
        && open_code_zen_protocol_for_model(&request.model) == "restricted"
    {
        return Err(
            "OpenCode Zen Jev models return structured classifications, not tutoring guide text."
                .to_owned(),
        );
    }

    let (expected_accept, route_valid) = if request.provider_id == "replicate" {
        (
            "application/json",
            is_replicate_route(&url, &request.model, loopback_override),
        )
    } else if is_openai_compatible_provider(&request.provider_id) {
        let valid_query = if request.provider_id == "cloudflare-workers-ai" {
            is_cloudflare_workers_ai_route(&url)
        } else {
            url.query().is_none()
        };
        (
            "text/event-stream",
            path.ends_with("/chat/completions") && valid_query,
        )
    } else if request.provider_id == "opencode-zen" {
        (
            "text/event-stream",
            is_open_code_zen_route(&url, &request.model),
        )
    } else {
        match request.provider_id.as_str() {
            "anthropic" => (
                "text/event-stream",
                path.ends_with("/v1/messages") && url.query().is_none(),
            ),
            "google-gemini" => {
                let model = request
                    .model
                    .strip_prefix("models/")
                    .unwrap_or(&request.model);
                let expected = format!(
                    "/models/{}:streamGenerateContent",
                    encode_path_segment(model)
                );
                (
                    "text/event-stream",
                    path.ends_with(&expected) && url.query() == Some("alt=sse"),
                )
            }
            "cohere" => (
                "text/event-stream",
                path.ends_with("/v2/chat") && url.query().is_none(),
            ),
            "perplexity" => (
                "text/event-stream",
                path.ends_with("/agent") && url.query().is_none(),
            ),
            "ollama" => ("application/x-ndjson", path.ends_with("/api/chat")),
            _ => return Err("This provider is not supported for desktop requests.".to_owned()),
        }
    };
    if !route_valid {
        return Err("The endpoint does not match the reviewed provider route.".to_owned());
    }
    if request.accept != expected_accept {
        return Err("The provider response type changed after review.".to_owned());
    }
    let body: serde_json::Value = serde_json::from_str(&request.request_body)
        .map_err(|_| "The reviewed provider request is not valid JSON.".to_owned())?;
    if !body.is_object() {
        return Err("The reviewed provider request must be a JSON object.".to_owned());
    }
    let model_is_in_url = request.provider_id == "replicate"
        || request.provider_id == "google-gemini"
        || (request.provider_id == "opencode-zen"
            && open_code_zen_protocol_for_model(&request.model) == "gemini");
    if !model_is_in_url
        && body.get("model").and_then(serde_json::Value::as_str) != Some(request.model.as_str())
    {
        return Err("The reviewed request model changed after preview.".to_owned());
    }
    if request.provider_id == "replicate" {
        let input = body.get("input").and_then(serde_json::Value::as_object);
        let version = body.get("version").and_then(serde_json::Value::as_str);
        let prompt = input
            .and_then(|input| input.get("prompt"))
            .and_then(serde_json::Value::as_str);
        let supported_inputs = [
            "prompt",
            "system_prompt",
            "max_new_tokens",
            "max_tokens",
            "max_output_tokens",
        ];
        let token_inputs = ["max_new_tokens", "max_tokens", "max_output_tokens"];
        let has_valid_tokens = input.is_some_and(|input| {
            let count = token_inputs
                .iter()
                .filter(|name| input.contains_key(**name))
                .count();
            count <= 1
                && token_inputs.iter().all(|name| {
                    input.get(*name).is_none_or(|value| {
                        value
                            .as_u64()
                            .is_some_and(|tokens| (1..=1_000_000).contains(&tokens))
                    })
                })
        });
        if body.as_object().is_none_or(|object| object.len() != 2)
            || version.is_none_or(|version| {
                version.trim().is_empty()
                    || version.len() > 256
                    || version.chars().any(char::is_control)
            })
            || input.is_none_or(|input| {
                !input.contains_key("prompt")
                    || input
                        .keys()
                        .any(|name| !supported_inputs.contains(&name.as_str()))
                    || input.get("system_prompt").is_some_and(|value| {
                        value
                            .as_str()
                            .is_none_or(|text| text.len() > MAX_REPLICATE_RESPONSE_BYTES)
                    })
                    || !has_valid_tokens
            })
            || prompt.is_none_or(|prompt| {
                prompt.trim().is_empty() || prompt.len() > MAX_REPLICATE_RESPONSE_BYTES
            })
        {
            return Err(
                "The reviewed Replicate request must contain one bounded text prompt.".to_owned(),
            );
        }
        if request.replicate_request_id.is_empty()
            || !valid_replicate_request_id(&request.replicate_request_id)
        {
            return Err("The Replicate request identifier is invalid.".to_owned());
        }
    }
    if !model_is_in_url && body.get("stream").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("The reviewed request is not configured for streaming.".to_owned());
    }
    Ok(())
}

pub(super) fn validate_replicate_model_inspection(
    request: &AiTransportRequest,
) -> Result<(), String> {
    if request.provider_id != "replicate"
        || request.cancel_replicate_request
        || request.model.trim().is_empty()
        || request.model.len() > 257
        || !request.request_body.is_empty()
        || !request.request_body_hash.is_empty()
        || !request.confirmed_body_hash.is_empty()
        || !request.replicate_request_id.is_empty()
        || request.endpoint != request.confirmed_endpoint
        || request.accept != "application/json"
        || !is_replicate_model_route(
            &Url::parse(&request.endpoint)
                .map_err(|_| "The Replicate model endpoint is invalid.".to_owned())?,
            &request.model,
        )
        || request.credential_storage == CredentialStorage::None
        || (request.credential_storage == CredentialStorage::SystemKeychain
            && !request.credential.is_empty())
        || (request.credential_storage == CredentialStorage::EncryptedArchive
            && request.credential.is_empty())
    {
        return Err("The Replicate model-schema request is invalid or changed.".to_owned());
    }
    Ok(())
}

fn is_openai_compatible_provider(provider_id: &str) -> bool {
    matches!(
        provider_id,
        "openai"
            | "openai-compatible"
            | "xai"
            | "openrouter"
            | "together"
            | "fireworks"
            | "deepinfra"
            | "novita"
            | "nebius"
            | "groq"
            | "cerebras"
            | "sambanova"
            | "nvidia"
            | "deepseek"
            | "mistral"
            | "huggingface"
            | "moonshot"
            | "zai"
            | "minimax"
            | "siliconflow"
            | "alibaba-cloud"
            | "baidu"
            | "tencent-cloud"
            | "volcengine"
            | "bedrock"
            | "azure-openai"
            | "cloudflare-workers-ai"
            | "ai21"
            | "lm-studio"
            | "llama.cpp-server"
    )
}

fn is_replicate_route(url: &Url, model: &str, allow_loopback_http: bool) -> bool {
    let Some((owner, name)) = split_replicate_model_id(model) else {
        return false;
    };
    let official_origin = url.scheme() == "https"
        && url.host_str() == Some("api.replicate.com")
        && url.port().is_none();
    let loopback_origin = allow_loopback_http && url.scheme() == "http" && is_loopback_host(url);
    let path = url.path();
    (official_origin || loopback_origin)
        && url.query().is_none()
        && url.fragment().is_none()
        && (path == "/v1/predictions" || path == format!("/v1/models/{owner}/{name}/predictions"))
}

fn is_replicate_model_route(url: &Url, model: &str) -> bool {
    let Some((owner, name)) = split_replicate_model_id(model) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("api.replicate.com")
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == format!("/v1/models/{owner}/{name}")
}

fn split_replicate_model_id(model: &str) -> Option<(&str, &str)> {
    let (owner, name) = model.split_once('/')?;
    let valid_part = |part: &str| {
        !part.is_empty()
            && part.len() <= 128
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    };
    if model.matches('/').count() != 1 || !valid_part(owner) || !valid_part(name) {
        return None;
    }
    Some((owner, name))
}

pub(super) fn is_local_provider(provider_id: &str) -> bool {
    matches!(provider_id, "ollama" | "lm-studio" | "llama.cpp-server")
}

fn is_cloudflare_workers_ai_route(url: &Url) -> bool {
    if url.host_str() != Some("api.cloudflare.com") || url.port().is_some() || url.query().is_some()
    {
        return false;
    }
    let Some(account_path) = url
        .path()
        .strip_prefix("/client/v4/accounts/")
        .and_then(|path| path.strip_suffix("/ai/v1/chat/completions"))
    else {
        return false;
    };
    !account_path.is_empty()
        && account_path
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

pub(super) fn open_code_zen_protocol_for_model(model: &str) -> &'static str {
    if model.starts_with("jev-") {
        "restricted"
    } else if model.starts_with("gpt-")
        || model.starts_with("grok-")
        || model.starts_with("muse-spark-")
    {
        "openai-responses"
    } else if model.starts_with("claude-")
        || model.starts_with("qwen3.5-")
        || model.starts_with("qwen3.6-")
        || model.starts_with("qwen3.7-")
        || model.starts_with("qwen3.8-flash")
    {
        "anthropic"
    } else if model.starts_with("gemini-") {
        "gemini"
    } else {
        "openai-chat"
    }
}

fn is_open_code_zen_route(url: &Url, model: &str) -> bool {
    match open_code_zen_protocol_for_model(model) {
        "openai-chat" => {
            url.path().ends_with("/openai/v1/chat/completions") && url.query().is_none()
        }
        "openai-responses" => url.path().ends_with("/openai/v1/responses") && url.query().is_none(),
        "anthropic" => url.path().ends_with("/anthropic/v1/messages") && url.query().is_none(),
        "gemini" => {
            let model = model.strip_prefix("models/").unwrap_or(model);
            let expected = format!(
                "/google/v1beta/models/{}:streamGenerateContent",
                encode_path_segment(model)
            );
            url.path().ends_with(&expected) && url.query() == Some("alt=sse")
        }
        _ => false,
    }
}

pub(super) fn validate_credential(credential: &str) -> Result<(), String> {
    if credential.is_empty()
        || credential.len() > MAX_CREDENTIAL_BYTES
        || credential
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("The saved provider credential is missing or invalid.".to_owned());
    }
    Ok(())
}

pub(super) fn is_loopback_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if host
        .parse::<Ipv4Addr>()
        .is_ok_and(|address| address.is_loopback())
    {
        return true;
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<Ipv6Addr>()
        .is_ok_and(|address| address.is_loopback())
}

pub(super) fn encode_path_segment(value: &str) -> String {
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

pub(super) fn constant_time_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}
