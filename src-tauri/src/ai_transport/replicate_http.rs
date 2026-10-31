use reqwest::{
    header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    Client, Url,
};
use std::time::Duration;
use zeroize::Zeroizing;

use super::MAX_REPLICATE_RESPONSE_BYTES;

pub(super) struct ReplicateHttpResponse {
    pub(super) status: u16,
    pub(super) content_type: String,
    pub(super) bytes: Vec<u8>,
    pub(super) complete: bool,
}

pub(super) async fn request_replicate_http(
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
        "GET" => client.get(url.clone()),
        "POST" => client.post(url.clone()),
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

pub(super) fn preserve_latest_response_body(
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
