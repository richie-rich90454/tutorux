mod replicate;
mod replicate_http;
mod validation;

pub mod headless;

#[cfg(test)]
mod tests;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{
    header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    redirect::Policy,
    Client, Url,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::ipc::Channel;
use zeroize::{Zeroize, Zeroizing};

use replicate::{cancel_replicate_request, inspect_replicate_model, send_replicate_prediction};
use validation::{
    constant_time_equal, is_local_provider, open_code_zen_protocol_for_model, validate_credential,
    validate_replicate_model_inspection, validate_request,
};

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPLICATE_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const CHANNEL_BATCH_BYTES: usize = 32 * 1024;

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
pub(crate) enum CredentialStorage {
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
    pub(crate) status: u16,
    pub(crate) content_type: String,
    pub(crate) response_bytes: usize,
    pub(crate) complete: bool,
    pub(crate) cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_message: Option<String>,
}

#[tauri::command]
pub async fn send_ai_request(
    mut request: AiTransportRequest,
    on_chunk: Channel<AiTransportEvent>,
) -> Result<AiTransportResult, String> {
    if request.cancel_replicate_request {
        if request.provider_id != "replicate"
            || !validation::valid_replicate_request_id(&request.replicate_request_id)
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

fn send_batch(channel: &Channel<AiTransportEvent>, batch: &mut Vec<u8>) -> Result<(), String> {
    channel
        .send(AiTransportEvent::Chunk {
            base64: BASE64.encode(batch.as_slice()),
        })
        .map_err(|_| "The provider response could not be delivered to the app.".to_owned())?;
    batch.clear();
    Ok(())
}
