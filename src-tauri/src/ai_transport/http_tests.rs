use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, InvokeResponseBody};

use super::http_mock::{MockResponse, MockServer};
use super::replicate::{cancel_replicate_request, ReplicateLimits};
use super::validation::validate_request;
use super::{AiTransportEvent, AiTransportRequest, CredentialStorage, TransportPolicy};

const TEST_ID: &str = "12345678-1234-1234-1234-123456789005";

type Collected = Arc<Mutex<Vec<u8>>>;

fn test_channel() -> (Channel<AiTransportEvent>, Collected) {
    let collected = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);
    let channel = Channel::new(move |payload| {
        let InvokeResponseBody::Json(text) = payload else {
            return Ok(());
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| tauri::Error::AssetNotFound(error.to_string()))?;
        if value.get("kind").and_then(Value::as_str) != Some("chunk") {
            return Ok(());
        }
        let encoded = value
            .get("base64")
            .and_then(Value::as_str)
            .ok_or_else(|| tauri::Error::AssetNotFound("chunk".to_owned()))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| tauri::Error::AssetNotFound(error.to_string()))?;
        if let Ok(mut sink) = sink.lock() {
            sink.extend_from_slice(&bytes);
        }
        Ok(())
    });
    (channel, collected)
}

fn request(
    provider_id: &str,
    endpoint: &str,
    model: &str,
    accept: &str,
    body: &str,
    credential: &str,
    replicate_request_id: &str,
) -> AiTransportRequest {
    let hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    AiTransportRequest {
        provider_id: provider_id.to_owned(),
        endpoint: endpoint.to_owned(),
        confirmed_endpoint: endpoint.to_owned(),
        model: model.to_owned(),
        accept: accept.to_owned(),
        request_body: body.to_owned(),
        request_body_hash: hash.clone(),
        confirmed_body_hash: hash,
        credential_storage: if credential.is_empty() {
            CredentialStorage::None
        } else {
            CredentialStorage::EncryptedArchive
        },
        credential: credential.to_owned(),
        replicate_request_id: replicate_request_id.to_owned(),
        cancel_replicate_request: false,
        inspect_replicate_model: false,
    }
}

fn replicate_request(endpoint: &str, id: &str) -> AiTransportRequest {
    request(
        "replicate",
        endpoint,
        "owner/model",
        "application/json",
        r#"{"version":"v1","input":{"prompt":"hello"}}"#,
        "test-token",
        id,
    )
}

fn fast_limits() -> ReplicateLimits {
    ReplicateLimits {
        deadline: Duration::from_secs(2),
        initial_delay: Duration::from_millis(5),
        maximum_delay: Duration::from_millis(10),
    }
}

fn send(
    request: AiTransportRequest,
    limits: ReplicateLimits,
) -> Result<(super::AiTransportResult, Vec<u8>), String> {
    let (channel, collected) = test_channel();
    tauri::async_runtime::block_on(async move {
        let result =
            super::send_reviewed(request, channel, TransportPolicy::loopback(limits)).await?;
        let body = collected
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        Ok((result, body))
    })
}

#[test]
fn replicate_prediction_polls_until_success_and_returns_output() {
    let server = MockServer::start(|request, _| match request.path.as_str() {
        "/v1/predictions" => MockResponse::json(201, json!({"id": "pred-1", "status": "starting"})),
        "/v1/predictions/pred-1" => MockResponse::json(
            200,
            json!({"id": "pred-1", "status": "succeeded", "output": "guide text"}),
        ),
        _ => MockResponse::json(404, json!({"detail": "unexpected"})),
    });
    let endpoint = format!("{}/v1/predictions", server.origin());
    let (result, body) = send(
        replicate_request(&endpoint, "12345678-1234-1234-1234-123456789001"),
        fast_limits(),
    )
    .expect("transport");
    assert_eq!(result.status, 200);
    assert!(result.complete);
    assert!(!result.cancelled);
    assert_eq!(result.content_type, "application/json");
    let prediction: Value = serde_json::from_slice(&body).expect("prediction");
    assert_eq!(prediction["status"], "succeeded");
    assert_eq!(prediction["output"], "guide text");

    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(
        requests[0].header("authorization"),
        Some("Bearer test-token")
    );
    assert_eq!(requests[0].header("prefer"), Some("wait=60"));
    assert_eq!(requests[0].json()["input"]["prompt"], "hello");
}

#[test]
fn replicate_model_scoped_prediction_endpoint_is_reviewed() {
    let server = MockServer::start(|request, _| match request.path.as_str() {
        "/v1/models/owner/model/predictions" => MockResponse::json(
            201,
            json!({"id": "pred-2", "status": "succeeded", "output": "scoped"}),
        ),
        _ => MockResponse::json(404, json!({"detail": "unexpected"})),
    });
    let endpoint = format!("{}/v1/models/owner/model/predictions", server.origin());
    let (result, body) = send(
        replicate_request(&endpoint, "12345678-1234-1234-1234-123456789002"),
        fast_limits(),
    )
    .expect("transport");
    assert_eq!(result.status, 201);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("prediction")["output"],
        "scoped"
    );
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn replicate_failed_prediction_and_http_error_keep_raw_metadata() {
    let server = MockServer::start(|request, _| match request.path.as_str() {
        "/v1/predictions" => MockResponse::json(201, json!({"id": "pred-3", "status": "starting"})),
        "/v1/predictions/pred-3" => MockResponse::json(
            200,
            json!({"id": "pred-3", "status": "failed", "error": "model failed"}),
        ),
        _ => MockResponse::json(404, json!({"detail": "unexpected"})),
    });
    let endpoint = format!("{}/v1/predictions", server.origin());
    let (result, body) = send(
        replicate_request(&endpoint, "12345678-1234-1234-1234-123456789003"),
        fast_limits(),
    )
    .expect("transport");
    assert_eq!(result.status, 200);
    assert!(!result.cancelled);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("prediction")["error"],
        "model failed"
    );

    let error_server =
        MockServer::start(|_, _| MockResponse::json(422, json!({"detail": "invalid version"})));
    let endpoint = format!("{}/v1/predictions", error_server.origin());
    let (result, body) = send(
        replicate_request(&endpoint, "12345678-1234-1234-1234-123456789004"),
        fast_limits(),
    )
    .expect("transport");
    assert_eq!(result.status, 422);
    assert!(result.complete);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("error")["detail"],
        "invalid version"
    );
}

#[test]
fn replicate_timeout_cancels_remote_and_reports_408() {
    let server = MockServer::start(|request, _| match request.path.as_str() {
        "/v1/predictions" => MockResponse::json(201, json!({"id": "pred-4", "status": "starting"})),
        "/v1/predictions/pred-4" => {
            MockResponse::json(200, json!({"id": "pred-4", "status": "processing"}))
        }
        "/v1/predictions/pred-4/cancel" => MockResponse::json(
            200,
            json!({"id": "pred-4", "status": "canceled", "output": null}),
        ),
        _ => MockResponse::json(404, json!({"detail": "unexpected"})),
    });
    let endpoint = format!("{}/v1/predictions", server.origin());
    let limits = ReplicateLimits {
        deadline: Duration::from_millis(120),
        initial_delay: Duration::from_millis(5),
        maximum_delay: Duration::from_millis(10),
    };
    let (result, body) = send(
        replicate_request(&endpoint, "12345678-1234-1234-1234-123456789006"),
        limits,
    )
    .expect("transport");
    assert_eq!(result.status, 408);
    assert!(!result.cancelled);
    assert_eq!(
        result.error_message.as_deref(),
        Some("Replicate prediction timed out after five minutes.")
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("cancel")["status"],
        "canceled"
    );
    assert!(server
        .requests()
        .iter()
        .any(|request| request.path == "/v1/predictions/pred-4/cancel"));
}

#[test]
fn replicate_canceled_prediction_is_terminal_and_cancelled() {
    let server = MockServer::start(|request, _| match request.path.as_str() {
        "/v1/predictions" => MockResponse::json(201, json!({"id": "pred-6", "status": "starting"})),
        "/v1/predictions/pred-6" => {
            MockResponse::json(200, json!({"id": "pred-6", "status": "canceled"}))
        }
        _ => MockResponse::json(404, json!({"detail": "unexpected"})),
    });
    let endpoint = format!("{}/v1/predictions", server.origin());
    let (result, body) = send(
        replicate_request(&endpoint, "12345678-1234-1234-1234-123456789007"),
        fast_limits(),
    )
    .expect("transport");
    assert_eq!(result.status, 200);
    assert!(result.cancelled);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("prediction")["status"],
        "canceled"
    );
}

#[test]
fn opencode_zen_surfaces_a_terminal_provider_error() {
    let server = MockServer::start(|_, _| {
        MockResponse::json(
            429,
            json!({"error": {"message": "rate limited", "code": "rate_limit"}}),
        )
    });
    let endpoint = format!("{}/openai/v1/chat/completions", server.origin());
    let (result, body) = send(
        zen_request(
            &endpoint,
            "qwen3-coder",
            json!({"model": "qwen3-coder", "stream": true, "messages": []}),
        ),
        fast_limits(),
    )
    .expect("transport");
    assert_eq!(result.status, 429);
    assert!(result.complete);
    assert!(!result.cancelled);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("error")["error"]["code"],
        "rate_limit"
    );
}

#[test]
fn replicate_pending_cancellation_stops_after_creation() {
    let server = MockServer::start(|request, _| match request.path.as_str() {
        "/v1/predictions" => MockResponse::json(201, json!({"id": "pred-5", "status": "starting"})),
        "/v1/predictions/pred-5/cancel" => {
            MockResponse::json(200, json!({"id": "pred-5", "status": "canceled"}))
        }
        _ => MockResponse::json(404, json!({"detail": "unexpected"})),
    });
    cancel_replicate_request(TEST_ID);
    let endpoint = format!("{}/v1/predictions", server.origin());
    let (result, body) =
        send(replicate_request(&endpoint, TEST_ID), fast_limits()).expect("transport");
    assert_eq!(result.status, 200);
    assert!(result.cancelled);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("cancel")["status"],
        "canceled"
    );
}

fn zen_request(endpoint: &str, model: &str, body: Value) -> AiTransportRequest {
    request(
        "opencode-zen",
        endpoint,
        model,
        "text/event-stream",
        &serde_json::to_string(&body).expect("body"),
        "zen-key",
        "",
    )
}

#[test]
fn opencode_zen_all_route_families_send_reviewed_headers_and_stream_bytes() {
    let cases = [
        (
            "/openai/v1/chat/completions",
            "qwen3-coder",
            "authorization",
            "Bearer zen-key",
            json!({"model": "qwen3-coder", "stream": true, "messages": []}),
        ),
        (
            "/openai/v1/responses",
            "gpt-5",
            "authorization",
            "Bearer zen-key",
            json!({"model": "gpt-5", "stream": true, "input": []}),
        ),
        (
            "/anthropic/v1/messages",
            "claude-sonnet-4",
            "x-api-key",
            "zen-key",
            json!({"model": "claude-sonnet-4", "stream": true, "messages": []}),
        ),
        (
            "/google/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
            "gemini-2.5-pro",
            "x-goog-api-key",
            "zen-key",
            json!({"contents": []}),
        ),
    ];
    for (path, model, header, value, body) in cases {
        let stream = "event: message\ndata: {\"text\":\"hello\"}\n\n";
        let server = MockServer::start(move |_, _| MockResponse::sse(stream));
        let endpoint = format!("{}{path}", server.origin());
        let (result, received) =
            send(zen_request(&endpoint, model, body), fast_limits()).expect("transport");
        assert_eq!(result.status, 200, "{path}");
        assert!(result.complete, "{path}");
        assert_eq!(result.content_type, "text/event-stream", "{path}");
        assert_eq!(received, stream.as_bytes(), "{path}");
        let requests = server.requests();
        assert_eq!(requests.len(), 1, "{path}");
        let recorded = &requests[0];
        assert_eq!(recorded.method, "POST");
        assert_eq!(recorded.path, path);
        assert_eq!(recorded.header("content-type"), Some("application/json"));
        assert_eq!(recorded.header("accept"), Some("text/event-stream"));
        assert_eq!(recorded.header(header), Some(value), "{path}");
        assert_eq!(
            recorded.header("anthropic-version"),
            (header == "x-api-key").then_some("2023-06-01"),
            "{path}"
        );
    }
}

#[test]
fn opencode_zen_rejects_a_route_from_another_protocol_family() {
    let endpoint = "https://opencode.ai/inference/openai/v1/chat/completions";
    let request = zen_request(
        endpoint,
        "gpt-5",
        json!({"model": "gpt-5", "stream": true, "input": []}),
    );
    let error = validate_request(&request, TransportPolicy::STRICT).expect_err("route mismatch");
    assert_eq!(
        error,
        "The endpoint does not match the reviewed provider route."
    );
}
