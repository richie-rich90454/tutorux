use keyring::{Entry, Error};
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "app.tutorux.desktop";
const MAX_CREDENTIAL_BYTES: usize = 4096;

const PROVIDERS: &[&str] = &[
    "openai",
    "anthropic",
    "google-gemini",
    "cohere",
    "perplexity",
    "openai-compatible",
];

pub fn store_available() -> bool {
    Entry::store_status().is_ok()
}

pub fn contains(provider_id: &str) -> Result<bool, String> {
    let entry = entry(provider_id)?;
    match entry.get_password() {
        Ok(mut value) => {
            let present = !value.is_empty();
            value.zeroize();
            Ok(present)
        }
        Err(Error::NoEntry) => Ok(false),
        Err(_) => Err(store_error()),
    }
}

pub fn save(provider_id: &str, value: String) -> Result<(), String> {
    let value = Zeroizing::new(value);
    validate_secret(&value)?;
    entry(provider_id)?
        .set_password(value.as_str())
        .map_err(|_| store_error())
}

pub fn load(provider_id: &str) -> Result<Zeroizing<String>, String> {
    match entry(provider_id)?.get_password() {
        Ok(value) => {
            let value = Zeroizing::new(value);
            validate_secret(&value)?;
            Ok(value)
        }
        Err(Error::NoEntry) => {
            Err("No system-keychain API key is saved for this provider.".to_owned())
        }
        Err(_) => Err(store_error()),
    }
}

pub fn remove(provider_id: &str) -> Result<(), String> {
    match entry(provider_id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(_) => Err(store_error()),
    }
}

fn entry(provider_id: &str) -> Result<Entry, String> {
    if !PROVIDERS.contains(&provider_id) {
        return Err("Choose a supported cloud AI provider.".to_owned());
    }
    Entry::new(SERVICE, provider_id).map_err(|_| store_error())
}

fn validate_secret(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_CREDENTIAL_BYTES
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("The provider API key is missing or invalid.".to_owned());
    }
    Ok(())
}

fn store_error() -> String {
    "The operating system credential store is unavailable or could not be accessed.".to_owned()
}

#[tauri::command]
pub async fn ai_credential_store_available() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(store_available)
        .await
        .map_err(|_| "The system credential store could not be checked.".to_owned())
}

#[tauri::command]
pub async fn has_ai_credential(provider_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || contains(&provider_id))
        .await
        .map_err(|_| "The system credential store could not be checked.".to_owned())?
}

#[tauri::command]
pub async fn save_ai_credential(provider_id: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save(&provider_id, value))
        .await
        .map_err(|_| "The system credential store could not save this API key.".to_owned())?
}

#[tauri::command]
pub async fn remove_ai_credential(provider_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove(&provider_id))
        .await
        .map_err(|_| "The system credential store could not remove this API key.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::{validate_secret, PROVIDERS};

    #[test]
    fn only_supported_cloud_providers_can_use_the_system_store() {
        assert!(PROVIDERS.contains(&"openai"));
        assert!(PROVIDERS.contains(&"openai-compatible"));
        assert!(!PROVIDERS.contains(&"ollama"));
    }

    #[test]
    fn provider_secrets_must_be_bounded_and_header_safe() {
        assert!(validate_secret("api-key").is_ok());
        assert!(validate_secret("").is_err());
        assert!(validate_secret("api key").is_err());
        assert!(validate_secret(&"x".repeat(4097)).is_err());
        assert!(validate_secret("api-key\nInjected: yes").is_err());
    }
}
