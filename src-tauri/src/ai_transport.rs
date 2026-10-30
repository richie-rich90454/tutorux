use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{
    header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    redirect::Policy,
    Client, Url,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, Ipv6Addr},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use zeroize::{Zeroize, Zeroizing};

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPLICATE_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 4096;
const CHANNEL_BATCH_BYTES: usize = 32 * 1024;
const REPLICATE_API_ROOT: &str = "https://api.replicate.com/v1";

static REPLICATE_CANCELLATIONS: OnceLock<Mutex<ReplicateCancellationState>> = OnceLock::new();
const MAX_PENDING_REPLICATE_CANCELLATIONS: usize = 128;
const PENDING_REPLICATE_CANCELLATION_TTL: Duration = Duration::from_secs(120);

#[derive(Default)]
struct ReplicateCancellationState {
    active: HashMap<String, Arc<AtomicBool>>,
    pending: HashMap<String, Instant>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTransportRequest {
    #[serde(default)]
    provider_id: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    confirmed_endpoint: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    accept: String,
    #[serde(default)]
    request_body: String,
    #[serde(default)]
    request_body_hash: String,
    #[serde(default)]
    confirmed_body_hash: String,
    #[serde(default)]
    credential_storage: CredentialStorage,
    #[serde(default)]
    credential: String,
    #[serde(default)]
    replicate_request_id: String,
    #[serde(default)]
    cancel_replicate_request: bool,
    #[serde(default)]
    inspect_replicate_model: bool,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum CredentialStorage {
    #[default]
    None,
    EncryptedArchive,
    SystemKeychain,
}

impl Drop for AiTransportRequest {
    fn drop(&mut self) {
        self.credential.zeroize();
        self.request_body.zeroize();
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
    cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
}

#[tauri::command]
pub async fn send_ai_request(
    mut request: AiTransportRequest,
    on_chunk: Option<Channel<AiTransportEvent>>,
) -> Result<AiTransportResult, String> {
    if request.cancel_replicate_request {
        if request.provider_id != "replicate"
            || !valid_replicate_request_id(&request.replicate_request_id)
        {
            return Err("The Replicate cancellation request is invalid or expired.".to_owned());
        }
        cancel_replicate_request(&request.replicate_request_id);
        return Ok(AiTransportResult {
            status: 200,
            content_type: "application/json".to_owned(),
            response_bytes: 0,
            complete: true,
            cancelled: true,
            error_message: None,
        });
    }
    if request.inspect_replicate_model {
        validate_replicate_model_inspection(&request)?;
        let credential = match request.credential_storage {
            CredentialStorage::None => Zeroizing::new(String::new()),
            CredentialStorage::EncryptedArchive => {
                Zeroizing::new(std::mem::take(&mut request.credential))
            }
            CredentialStorage::SystemKeychain => {
                tauri::async_runtime::spawn_blocking(|| crate::credentials::load("replicate"))
                    .await
                    .map_err(|_| "The system credential store could not be read.".to_owned())??
            }
        };
        validate_credential(&credential)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "The Replicate connection could not be initialized.".to_owned())?;
        let on_chunk = on_chunk
            .ok_or_else(|| "The Replicate schema response channel is unavailable.".to_owned())?;
        return inspect_replicate_model(&client, &request, &credential, &on_chunk).await;
    }
    let body = request.request_body.as_bytes();
    let request_limit = if request.provider_id == "replicate" {
        MAX_REPLICATE_RESPONSE_BYTES
    } else {
        MAX_REQUEST_BYTES
    };
    if body.is_empty() || body.len() > request_limit {
        request.credential.zeroize();
        return Err(if request.provider_id == "replicate" {
            "The reviewed Replicate request is empty or exceeds the 8 MiB limit.".to_owned()
        } else {
            "The reviewed provider request is empty or exceeds the 16 MiB limit.".to_owned()
        });
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
    let on_chunk =
        on_chunk.ok_or_else(|| "The provider response channel is unavailable.".to_owned())?;

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
    let local = is_local_provider(provider_id);
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

    if provider_id == "replicate" {
        let result = send_replicate_prediction(&client, &request, &credential, &on_chunk).await;
        return result;
    }

    let mut builder = client
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, request.accept.as_str());
    if !credential.is_empty() {
        let opencode_protocol = open_code_zen_protocol_for_model(&request.model);
        let raw_api_key = provider_id == "anthropic"
            || provider_id == "google-gemini"
            || (provider_id == "opencode-zen"
                && matches!(opencode_protocol, "anthropic" | "gemini"));
        let auth_value = if raw_api_key {
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
            "azure-openai" => "api-key",
            "opencode-zen" => match opencode_protocol {
                "anthropic" => "x-api-key",
                "gemini" => "x-goog-api-key",
                _ => AUTHORIZATION.as_str(),
            },
            _ => AUTHORIZATION.as_str(),
        };
        let parsed_name = reqwest::header::HeaderName::from_bytes(auth_header.as_bytes())
            .map_err(|_| "The provider authentication header is invalid.".to_owned())?;
        builder = builder.header(parsed_name, auth_value);
    }
    if provider_id == "anthropic"
        || (provider_id == "opencode-zen"
            && open_code_zen_protocol_for_model(&request.model) == "anthropic")
    {
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
        cancelled: false,
        error_message: None,
    })
}

struct ReplicateHttpResponse {
    status: u16,
    content_type: String,
    bytes: Vec<u8>,
    complete: bool,
}

struct ActiveReplicateRequestGuard {
    id: String,
}

impl Drop for ActiveReplicateRequestGuard {
    fn drop(&mut self) {
        if let Some(state) = REPLICATE_CANCELLATIONS.get() {
            if let Ok(mut state) = state.lock() {
                state.active.remove(&self.id);
            }
        }
    }
}

async fn send_replicate_prediction(
    client: &Client,
    request: &AiTransportRequest,
    credential: &str,
    on_chunk: &Channel<AiTransportEvent>,
) -> Result<AiTransportResult, String> {
    if !valid_replicate_request_id(&request.replicate_request_id) {
        return Err("The Replicate request identifier is invalid.".to_owned());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let state =
        REPLICATE_CANCELLATIONS.get_or_init(|| Mutex::new(ReplicateCancellationState::default()));
    {
        let mut state = state
            .lock()
            .map_err(|_| "The Replicate request state is unavailable.".to_owned())?;
        let now = Instant::now();
        state.pending.retain(|_, expires_at| *expires_at > now);
        if state.active.contains_key(&request.replicate_request_id) {
            return Err("A Replicate request with this identifier is already active.".to_owned());
        }
        if state
            .pending
            .remove(&request.replicate_request_id)
            .is_some()
        {
            cancelled.store(true, Ordering::Release);
        }
        state
            .active
            .insert(request.replicate_request_id.clone(), Arc::clone(&cancelled));
    }
    let _guard = ActiveReplicateRequestGuard {
        id: request.replicate_request_id.clone(),
    };

    let creation = match request_replicate_http(
        client,
        "POST",
        &request.endpoint,
        credential,
        Some(&request.request_body),
        Duration::from_secs(65),
    )
    .await
    {
        Ok(response) => response,
        Err(message) => {
            return send_replicate_result(
                ReplicateHttpResponse {
                    status: 0,
                    content_type: "application/json".to_owned(),
                    bytes: Vec::new(),
                    complete: false,
                },
                on_chunk,
                false,
                Some(message),
                None,
            );
        }
    };
    if creation.status < 200 || creation.status >= 300 || !creation.complete {
        return send_replicate_result(creation, on_chunk, false, None, None);
    }
    let (prediction_id, status) = match replicate_prediction_status(&creation.bytes, None) {
        Ok(prediction) => prediction,
        Err(message) => {
            return send_replicate_result(creation, on_chunk, false, Some(message), None);
        }
    };
    if status == "succeeded" || status == "failed" {
        return send_replicate_result(creation, on_chunk, false, None, None);
    }
    if status == "canceled" || status == "cancelled" {
        return send_replicate_result(creation, on_chunk, true, None, None);
    }
    if cancelled.load(Ordering::Acquire) {
        return cancel_replicate_prediction_remote(
            client,
            on_chunk,
            &prediction_id,
            credential,
            &creation,
            None,
        )
        .await;
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(5 * 60);
    let mut delay = Duration::from_millis(500);
    let mut latest = creation;
    while std::time::Instant::now() < deadline {
        let sleep_until = std::time::Instant::now() + delay;
        while std::time::Instant::now() < sleep_until {
            if cancelled.load(Ordering::Acquire) {
                return cancel_replicate_prediction_remote(
                    client,
                    on_chunk,
                    &prediction_id,
                    credential,
                    &latest,
                    None,
                )
                .await;
            }
            let remaining = sleep_until.saturating_duration_since(std::time::Instant::now());
            let slice = remaining.min(Duration::from_millis(100));
            let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(slice)).await;
        }
        if cancelled.load(Ordering::Acquire) {
            return cancel_replicate_prediction_remote(
                client,
                on_chunk,
                &prediction_id,
                credential,
                &latest,
                None,
            )
            .await;
        }
        let poll_url = format!("{REPLICATE_API_ROOT}/predictions/{prediction_id}");
        let poll = match request_replicate_http(
            client,
            "GET",
            &poll_url,
            credential,
            None,
            Duration::from_secs(20),
        )
        .await
        {
            Ok(response) => response,
            Err(message) => {
                return send_replicate_result(latest, on_chunk, false, Some(message), Some(0));
            }
        };
        if poll.status < 200 || poll.status >= 300 || !poll.complete {
            return send_replicate_result(poll, on_chunk, false, None, None);
        }
        let (_, current_status) =
            match replicate_prediction_status(&poll.bytes, Some(&prediction_id)) {
                Ok(prediction) => prediction,
                Err(message) => {
                    return send_replicate_result(poll, on_chunk, false, Some(message), None)
                }
            };
        if current_status == "succeeded" || current_status == "failed" {
            return send_replicate_result(poll, on_chunk, false, None, None);
        }
        if current_status == "canceled" || current_status == "cancelled" {
            return send_replicate_result(poll, on_chunk, true, None, None);
        }
        latest = poll;
        delay = (delay + Duration::from_millis(500)).min(Duration::from_secs(5));
    }

    let mut result = cancel_replicate_prediction_remote(
        client,
        on_chunk,
        &prediction_id,
        credential,
        &latest,
        Some("Replicate prediction exceeded the five-minute wait limit.".to_owned()),
    )
    .await?;
    result.status = 408;
    Ok(result)
}

async fn inspect_replicate_model(
    client: &Client,
    request: &AiTransportRequest,
    credential: &str,
    on_chunk: &Channel<AiTransportEvent>,
) -> Result<AiTransportResult, String> {
    match request_replicate_http(
        client,
        "GET",
        &request.endpoint,
        credential,
        None,
        Duration::from_secs(30),
    )
    .await
    {
        Ok(response) => send_replicate_result(response, on_chunk, false, None, None),
        Err(message) => send_replicate_result(
            ReplicateHttpResponse {
                status: 0,
                content_type: "application/json".to_owned(),
                bytes: Vec::new(),
                complete: false,
            },
            on_chunk,
            false,
            Some(message),
            None,
        ),
    }
}

async fn cancel_replicate_prediction_remote(
    client: &Client,
    on_chunk: &Channel<AiTransportEvent>,
    prediction_id: &str,
    credential: &str,
    fallback: &ReplicateHttpResponse,
    error_message: Option<String>,
) -> Result<AiTransportResult, String> {
    let cancel_url = format!("{REPLICATE_API_ROOT}/predictions/{prediction_id}/cancel");
    match request_replicate_http(
        client,
        "POST",
        &cancel_url,
        credential,
        Some("{}"),
        Duration::from_secs(10),
    )
    .await
    {
        Ok(response) if response.status >= 200 && response.status < 300 && response.complete => {
            send_replicate_result(
                preserve_latest_response_body(response, fallback),
                on_chunk,
                error_message.is_none(),
                error_message,
                None,
            )
        }
        Ok(response) => send_replicate_result(
            preserve_latest_response_body(response, fallback),
            on_chunk,
            false,
            error_message
                .or_else(|| Some("Replicate did not confirm prediction cancellation.".to_owned())),
            None,
        ),
        Err(message) => send_replicate_result(
            ReplicateHttpResponse {
                status: fallback.status,
                content_type: fallback.content_type.clone(),
                bytes: fallback.bytes.clone(),
                complete: fallback.complete,
            },
            on_chunk,
            false,
            error_message.or(Some(message)),
            None,
        ),
    }
}

fn preserve_latest_response_body(
    response: ReplicateHttpResponse,
    fallback: &ReplicateHttpResponse,
) -> ReplicateHttpResponse {
    if !response.bytes.is_empty() || fallback.bytes.is_empty() {
        return response;
    }
    ReplicateHttpResponse {
        status: response.status,
        content_type: if response.content_type.is_empty() {
            fallback.content_type.clone()
        } else {
            response.content_type
        },
        bytes: fallback.bytes.clone(),
        complete: fallback.complete,
    }
}

async fn request_replicate_http(
    client: &Client,
    method: &str,
    endpoint: &str,
    credential: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<ReplicateHttpResponse, String> {
    let url =
        Url::parse(endpoint).map_err(|_| "The Replicate API endpoint is invalid.".to_owned())?;
    if url.scheme() != "https:"
        || url.host_str() != Some("api.replicate.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Replicate requests are limited to its official HTTPS API origin.".to_owned());
    }
    let mut bearer = Zeroizing::new(String::with_capacity(7 + credential.len()));
    bearer.push_str("Bearer ");
    bearer.push_str(credential);
    let authorization = HeaderValue::from_str(&bearer)
        .map_err(|_| "The saved Replicate API token is invalid.".to_owned())?;
    let mut builder = match method {
        "GET" => client.get(url),
        "POST" => client.post(url),
        _ => return Err("The Replicate request method is not supported.".to_owned()),
    }
    .header(ACCEPT, "application/json")
    .header(AUTHORIZATION, authorization)
    .timeout(timeout);
    if method == "POST" && url.path().ends_with("/predictions") {
        builder = builder.header("Prefer", "wait=60");
    }
    if let Some(body) = body {
        builder = builder
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_owned());
    }
    let mut response = builder.send().await.map_err(|_| {
        "The Replicate API request could not be completed. Check the connection and try again."
            .to_owned()
    })?;
    let status = response.status().as_u16();
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
    let mut bytes = Vec::with_capacity(16 * 1024);
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
        let allowed = MAX_REPLICATE_RESPONSE_BYTES.saturating_sub(bytes.len());
        let copied = allowed.min(chunk.len());
        bytes.extend_from_slice(&chunk[..copied]);
        if copied != chunk.len() {
            complete = false;
            break;
        }
    }
    Ok(ReplicateHttpResponse {
        status,
        content_type,
        bytes,
        complete,
    })
}

fn replicate_prediction_status(
    bytes: &[u8],
    expected_id: Option<&str>,
) -> Result<(String, String), String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| "Replicate returned an invalid prediction response.".to_owned())?;
    let id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Replicate returned a prediction without a valid ID.".to_owned())?;
    if !valid_prediction_id(id) || expected_id.is_some_and(|expected| expected != id) {
        return Err(
            "Replicate returned a prediction ID that did not match this request.".to_owned(),
        );
    }
    let status = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .filter(|status| status.len() <= 64 && !status.is_empty())
        .ok_or_else(|| "Replicate returned a prediction without a valid status.".to_owned())?;
    Ok((id.to_owned(), status.to_ascii_lowercase()))
}

fn send_replicate_result(
    response: ReplicateHttpResponse,
    on_chunk: &Channel<AiTransportEvent>,
    cancelled: bool,
    error_message: Option<String>,
    status_override: Option<u16>,
) -> Result<AiTransportResult, String> {
    for chunk in response.bytes.chunks(CHANNEL_BATCH_BYTES) {
        on_chunk
            .send(AiTransportEvent::Chunk {
                base64: BASE64.encode(chunk),
            })
            .map_err(|_| "The Replicate response could not be delivered to the app.".to_owned())?;
    }
    Ok(AiTransportResult {
        status: status_override.unwrap_or(response.status),
        content_type: if response.content_type.is_empty() {
            "application/json".to_owned()
        } else {
            response.content_type
        },
        response_bytes: response.bytes.len(),
        complete: response.complete,
        cancelled,
        error_message,
    })
}

fn cancel_replicate_request(request_id: &str) {
    let state =
        REPLICATE_CANCELLATIONS.get_or_init(|| Mutex::new(ReplicateCancellationState::default()));
    if let Ok(mut state) = state.lock() {
        let now = Instant::now();
        state.pending.retain(|_, expires_at| *expires_at > now);
        if let Some(cancelled) = state.active.get(request_id) {
            cancelled.store(true, Ordering::Release);
        } else if state.pending.contains_key(request_id) {
            state.pending.insert(
                request_id.to_owned(),
                now + PENDING_REPLICATE_CANCELLATION_TTL,
            );
        } else if state.pending.len() < MAX_PENDING_REPLICATE_CANCELLATIONS {
            state.pending.insert(
                request_id.to_owned(),
                now + PENDING_REPLICATE_CANCELLATION_TTL,
            );
        }
    }
}

fn valid_replicate_request_id(request_id: &str) -> bool {
    let segments = request_id.split('-').collect::<Vec<_>>();
    segments.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(segments)
            .all(|(expected, segment)| {
                segment.len() == *expected && segment.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
}

fn valid_prediction_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn validate_request(request: &AiTransportRequest) -> Result<(), String> {
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
    if local {
        if url.scheme() != "http" || !is_loopback_host(&url) || url.query().is_some() {
            return Err(
                "Local model requests are limited to an HTTP loopback endpoint.".to_owned(),
            );
        }
    } else if url.scheme() != "https" {
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
        ("application/json", is_replicate_route(&url, &request.model))
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

fn validate_replicate_model_inspection(request: &AiTransportRequest) -> Result<(), String> {
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

fn is_replicate_route(url: &Url, model: &str) -> bool {
    if split_replicate_model_id(model).is_none() {
        return false;
    }
    url.scheme() == "https:"
        && url.host_str() == Some("api.replicate.com")
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == "/v1/predictions"
}

fn is_replicate_model_route(url: &Url, model: &str) -> bool {
    let Some((owner, name)) = split_replicate_model_id(model) else {
        return false;
    };
    url.scheme() == "https:"
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

fn is_local_provider(provider_id: &str) -> bool {
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

fn open_code_zen_protocol_for_model(model: &str) -> &'static str {
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
            replicate_request_id: String::new(),
            cancel_replicate_request: false,
            inspect_replicate_model: false,
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
