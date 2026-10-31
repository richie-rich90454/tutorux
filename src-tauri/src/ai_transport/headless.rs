//! Window-free AI transport entry point for the Rust CLI.
//!
//! Reuses the exact reviewed-request transport, validation, credential unwrapping, Replicate
//! polling, and response caps as the Tauri command by feeding it an in-process channel.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use zeroize::Zeroizing;

use super::{AiTransportRequest, AiTransportResult, CredentialStorage};

pub struct HeadlessAiRequest {
    pub provider_id: String,
    pub endpoint: String,
    pub model: String,
    pub accept: String,
    pub body: String,
    pub credential: Zeroizing<String>,
    pub replicate_request_id: String,
    pub cancel_replicate_request: bool,
    pub inspect_replicate_model: bool,
}

#[derive(Debug, Clone)]
pub struct HeadlessAiResponse {
    pub status: u16,
    pub content_type: String,
    pub response_bytes: usize,
    pub complete: bool,
    pub cancelled: bool,
    pub error_message: Option<String>,
    pub body: Vec<u8>,
}

pub async fn send(request: HeadlessAiRequest) -> Result<HeadlessAiResponse, String> {
    let HeadlessAiRequest {
        provider_id,
        endpoint,
        model,
        accept,
        body,
        credential,
        replicate_request_id,
        cancel_replicate_request,
        inspect_replicate_model,
    } = request;
    let body_hash = format!("{:x}", Sha256::digest(body.as_bytes()));
    let storage = if credential.is_empty() {
        CredentialStorage::None
    } else {
        CredentialStorage::EncryptedArchive
    };
    let inner = AiTransportRequest {
        provider_id,
        confirmed_endpoint: endpoint.clone(),
        endpoint,
        model,
        accept,
        request_body: body,
        confirmed_body_hash: body_hash.clone(),
        request_body_hash: body_hash,
        credential_storage: storage,
        credential: credential.to_string(),
        replicate_request_id,
        cancel_replicate_request,
        inspect_replicate_model,
    };
    let collected = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);
    let channel = Channel::new(move |payload| {
        let InvokeResponseBody::Json(text) = payload else {
            return Ok(());
        };
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|error| tauri::Error::AssetNotFound(error.to_string()))?;
        if value.get("kind").and_then(serde_json::Value::as_str) != Some("chunk") {
            return Ok(());
        }
        let encoded = value
            .get("base64")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| tauri::Error::AssetNotFound("AI transport chunk".to_owned()))?;
        let bytes = BASE64
            .decode(encoded)
            .map_err(|error| tauri::Error::AssetNotFound(error.to_string()))?;
        if let Ok(mut collected) = sink.lock() {
            collected.extend_from_slice(&bytes);
        }
        Ok(())
    });
    let result = super::send_ai_request(inner, channel).await?;
    let AiTransportResult {
        status,
        content_type,
        response_bytes,
        complete,
        cancelled,
        error_message,
    } = result;
    let body = collected.lock().map(|value| value.clone()).unwrap_or_default();
    Ok(HeadlessAiResponse {
        status,
        content_type,
        response_bytes,
        complete,
        cancelled,
        error_message,
        body,
    })
}
