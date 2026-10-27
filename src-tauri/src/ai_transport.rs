use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{
    header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    redirect::Policy,
    Client, Url,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    net::{Ipv4Addr, Ipv6Addr},
    time::Duration,
};
use tauri::ipc::Channel;
use zeroize::{Zeroize, Zeroizing};

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 4096;
const CHANNEL_BATCH_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTransportRequest {
    provider_id: String,
    endpoint: String,
    confirmed_endpoint: String,
    model: String,
    accept: String,
    request_body: String,
    request_body_hash: String,
    confirmed_body_hash: String,
    credential_storage: CredentialStorage,
    credential: String,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum CredentialStorage {
    None,
    EncryptedArchive,
    SystemKeychain,
}

impl Drop for AiTransportRequest {
    fn drop(&mut self) {
        self.credential.zeroize();
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiTransportEvent {
    Chunk { base64: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTransportResult {
    status: u16,
    content_type: String,
    response_bytes: usize,
    complete: bool,
}

#[tauri::command]
pub async fn send_ai_request(
    mut request: AiTransportRequest,
    on_chunk: Channel<AiTransportEvent>,
) -> Result<AiTransportResult, String> {
    let body = request.request_body.as_bytes();
    if body.is_empty() || body.len() > MAX_REQUEST_BYTES {
        request.credential.zeroize();
        return Err(
            "The reviewed provider request is empty or exceeds the 16 MiB limit.".to_owned(),
        );
    }
    let body_hash = format!("{:x}", Sha256::digest(body));
    if !constant_time_equal(&body_hash, &request.request_body_hash)
        || !constant_time_equal(&body_hash, &request.confirmed_body_hash)
        || request.endpoint != request.confirmed_endpoint
    {
        request.credential.zeroize();
        return Err("The request changed after review. Prepare and review it again.".to_owned());
    }
    validate_request(&request)?;

    let credential = match request.credential_storage {
        CredentialStorage::None => Zeroizing::new(String::new()),
        CredentialStorage::EncryptedArchive => {
            Zeroizing::new(std::mem::take(&mut request.credential))
        }
        CredentialStorage::SystemKeychain => {
            let provider_id = request.provider_id.clone();
            tauri::async_runtime::spawn_blocking(move || crate::credentials::load(&provider_id))
                .await
                .map_err(|_| "The system credential store could not be read.".to_owned())??
        }
    };
    if !credential.is_empty() {
        validate_credential(&credential)?;
    }

    let provider_id = request.provider_id.as_str();
    let local = provider_id == "ollama";
    let endpoint = Url::parse(&request.endpoint)
        .map_err(|_| "The reviewed provider endpoint is invalid.".to_owned())?;
    let mut client_builder = Client::builder()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(120))
        .timeout(Duration::from_secs(600));
    if local {
        client_builder = client_builder.no_proxy();
    }
    let client = client_builder
        .build()
        .map_err(|_| "The secure provider connection could not be initialized.".to_owned())?;

    let mut builder = client
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, request.accept.as_str());
    if !credential.is_empty() {
        let auth_value = if provider_id == "anthropic" || provider_id == "google-gemini" {
            HeaderValue::from_str(&credential)
                .map_err(|_| "The saved provider credential is invalid.".to_owned())?
        } else {
            let mut bearer_value = Zeroizing::new(String::with_capacity(7 + credential.len()));
            bearer_value.push_str("Bearer ");
            bearer_value.push_str(credential.as_str());
            HeaderValue::from_str(bearer_value.as_str())
                .map_err(|_| "The saved provider credential is invalid.".to_owned())?
        };
        let auth_header = match provider_id {
            "anthropic" => "x-api-key",
            "google-gemini" => "x-goog-api-key",
            _ => AUTHORIZATION.as_str(),
        };
        let parsed_name = reqwest::header::HeaderName::from_bytes(auth_header.as_bytes())
            .map_err(|_| "The provider authentication header is invalid.".to_owned())?;
        builder = builder.header(parsed_name, auth_value);
    }
    if provider_id == "anthropic" {
        builder = builder.header("anthropic-version", "2023-06-01");
    }

    let response_result = builder
        .body(std::mem::take(&mut request.request_body))
        .send()
        .await;
    drop(credential);
    let mut response = response_result
        .map_err(|_| "The provider request could not be completed. Check the endpoint and connection, then try again.".to_owned())?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let mut total = 0usize;
    let mut batch = Vec::with_capacity(CHANNEL_BATCH_BYTES);
    let mut complete = true;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                complete = false;
                break;
            }
        };
        let allowed = MAX_RESPONSE_BYTES.saturating_sub(total);
        let copied_bytes = allowed.min(chunk.len());
        let mut remaining = &chunk[..copied_bytes];
        total += copied_bytes;
        while !remaining.is_empty() {
            let room = CHANNEL_BATCH_BYTES - batch.len();
            let copied = room.min(remaining.len());
            batch.extend_from_slice(&remaining[..copied]);
            remaining = &remaining[copied..];
            if batch.len() == CHANNEL_BATCH_BYTES {
                send_batch(&on_chunk, &mut batch)?;
            }
        }
        if copied_bytes != chunk.len() {
            complete = false;
            break;
        }
    }
    if !batch.is_empty() {
        send_batch(&on_chunk, &mut batch)?;
    }

    Ok(AiTransportResult {
        status: status.as_u16(),
        content_type,
        response_bytes: total,
        complete,
    })
}

fn validate_request(request: &AiTransportRequest) -> Result<(), String> {
    if request.provider_id.len() > 64
        || request.model.trim().is_empty()
        || request.model.len() > 1024
        || request.model.chars().any(char::is_control)
    {
        return Err("Choose a valid provider model before sending.".to_owned());
    }
    let local = request.provider_id == "ollama";
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
    if local {
        if url.scheme() != "http" || !is_loopback_host(&url) || url.query().is_some() {
            return Err("Ollama requests are limited to an HTTP loopback endpoint.".to_owned());
        }
    } else if url.scheme() != "https" {
        return Err("Cloud provider requests require HTTPS.".to_owned());
    }

    let path = url.path();
    let (expected_accept, route_valid) = match request.provider_id.as_str() {
        "openai" | "openai-compatible" => (
            "text/event-stream",
            path.ends_with("/chat/completions") && url.query().is_none(),
        ),
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
    if request.provider_id != "google-gemini"
        && body.get("model").and_then(serde_json::Value::as_str) != Some(request.model.as_str())
    {
        return Err("The reviewed request model changed after preview.".to_owned());
    }
    if request.provider_id != "google-gemini"
        && body.get("stream").and_then(serde_json::Value::as_bool) != Some(true)
    {
        return Err("The reviewed request is not configured for streaming.".to_owned());
    }
    Ok(())
}

fn validate_credential(credential: &str) -> Result<(), String> {
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

fn is_loopback_host(url: &Url) -> bool {
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

fn constant_time_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn send_batch(channel: &Channel<AiTransportEvent>, batch: &mut Vec<u8>) -> Result<(), String> {
    channel
        .send(AiTransportEvent::Chunk {
            base64: BASE64.encode(batch.as_slice()),
        })
        .map_err(|_| "The provider response could not be delivered to the app.".to_owned())?;
    batch.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        constant_time_equal, encode_path_segment, is_loopback_host, validate_request,
        AiTransportRequest, CredentialStorage,
    };
    use reqwest::Url;

    fn request(provider_id: &str, endpoint: &str, model: &str, accept: &str) -> AiTransportRequest {
        AiTransportRequest {
            provider_id: provider_id.to_owned(),
            endpoint: endpoint.to_owned(),
            confirmed_endpoint: endpoint.to_owned(),
            model: model.to_owned(),
            accept: accept.to_owned(),
            request_body: if provider_id == "google-gemini" {
                r#"{"contents":[],"generationConfig":{"maxOutputTokens":64}}"#.to_owned()
            } else if provider_id == "ollama" {
                format!(r#"{{"model":"{model}","stream":true,"messages":[]}}"#)
            } else {
                format!(r#"{{"model":"{model}","stream":true,"messages":[]}}"#)
            },
            request_body_hash: String::new(),
            confirmed_body_hash: String::new(),
            credential_storage: if provider_id == "ollama" {
                CredentialStorage::None
            } else {
                CredentialStorage::EncryptedArchive
            },
            credential: if provider_id == "ollama" {
                String::new()
            } else {
                "key".to_owned()
            },
        }
    }

    #[test]
    fn loopback_validation_accepts_only_literal_or_localhost_addresses() {
        assert!(is_loopback_host(
            &Url::parse("http://127.0.0.1:11434").expect("url")
        ));
        assert!(is_loopback_host(
            &Url::parse("http://127.12.34.56:11434").expect("url")
        ));
        assert!(is_loopback_host(
            &Url::parse("http://[::1]:11434").expect("url")
        ));
        assert!(is_loopback_host(
            &Url::parse("http://localhost:11434").expect("url")
        ));
        assert!(!is_loopback_host(
            &Url::parse("http://127.0.0.1.example.org").expect("url")
        ));
        assert!(!is_loopback_host(
            &Url::parse("http://192.168.1.20").expect("url")
        ));
    }

    #[test]
    fn provider_routes_bind_streaming_and_transport_to_expected_protocols() {
        let openai = request(
            "openai",
            "https://api.example/v1/chat/completions",
            "gpt-x",
            "text/event-stream",
        );
        assert!(validate_request(&openai).is_ok());
        let gemini = request(
            "google-gemini",
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
            "gemini-2.5-pro",
            "text/event-stream",
        );
        assert!(validate_request(&gemini).is_ok());
        let ollama = request(
            "ollama",
            "http://127.0.0.1:11434/api/chat",
            "qwen3",
            "application/x-ndjson",
        );
        assert!(validate_request(&ollama).is_ok());

        let mut wrong_route = openai;
        wrong_route.endpoint = "https://api.example/collect".to_owned();
        assert!(validate_request(&wrong_route).is_err());
        let remote_ollama = request(
            "ollama",
            "http://192.168.1.20/api/chat",
            "qwen3",
            "application/x-ndjson",
        );
        assert!(validate_request(&remote_ollama).is_err());
    }

    #[test]
    fn keychain_requests_reference_a_provider_without_sending_a_secret_over_ipc() {
        let mut keychain = request(
            "openai",
            "https://api.example/v1/chat/completions",
            "gpt-x",
            "text/event-stream",
        );
        keychain.credential_storage = CredentialStorage::SystemKeychain;
        keychain.credential.clear();
        assert!(validate_request(&keychain).is_ok());

        keychain.credential = "unexpected-frontend-secret".to_owned();
        assert!(validate_request(&keychain).is_err());
    }

    #[test]
    fn google_model_path_uses_component_encoding_and_hash_comparison_is_exact() {
        assert_eq!(
            encode_path_segment("models/gemini 2.5"),
            "models%2Fgemini%202.5"
        );
        assert!(constant_time_equal("abc123", "abc123"));
        assert!(!constant_time_equal("abc123", "abc124"));
        assert!(!constant_time_equal("abc123", "abc12"));
    }
}
