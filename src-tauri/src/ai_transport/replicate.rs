use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::Client;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::ipc::Channel;

use super::{
    replicate_http::{
        preserve_latest_response_body, request_replicate_http, ReplicateHttpResponse,
    },
    validation::valid_replicate_request_id,
    AiTransportEvent, AiTransportRequest, AiTransportResult, CHANNEL_BATCH_BYTES,
};

const REPLICATE_API_ROOT: &str = "https://api.replicate.com/v1";
const MAX_PENDING_REPLICATE_CANCELLATIONS: usize = 128;
const PENDING_REPLICATE_CANCELLATION_TTL: Duration = Duration::from_secs(120);

static REPLICATE_CANCELLATIONS: OnceLock<Mutex<ReplicateCancellationState>> = OnceLock::new();

#[derive(Default)]
struct ReplicateCancellationState {
    active: HashMap<String, Arc<AtomicBool>>,
    pending: HashMap<String, Instant>,
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

pub(super) async fn send_replicate_prediction(
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

pub(super) async fn inspect_replicate_model(
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

pub(super) fn cancel_replicate_request(request_id: &str) {
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

fn valid_prediction_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
