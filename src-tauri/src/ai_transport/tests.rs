use super::validation::{
    constant_time_equal, encode_path_segment, is_loopback_host, validate_request,
};
use super::{AiTransportRequest, CredentialStorage};
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
