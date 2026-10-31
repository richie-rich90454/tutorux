use serde_json::Value;

use crate::core::cli::{CliError, CliResult};

use super::models::block_http;
use super::AI_GENERATION_SYSTEM_PROMPT;

const MAX_SCHEMA_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 8 * 1024 * 1024;
const TOKEN_INPUTS: [&str; 3] = ["max_new_tokens", "max_tokens", "max_output_tokens"];

pub(super) struct ReplicateSchema {
    pub(super) version: String,
    pub(super) has_system_prompt: bool,
    pub(super) token_input: Option<&'static str>,
}

pub(super) fn split_model(model: &str) -> CliResult<(&str, &str)> {
    let mut parts = model.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(CliError(
            "Replicate models must use the owner/model form from the public catalog.".to_owned(),
        )
        .into());
    };
    let valid = |part: &str| {
        !part.is_empty()
            && part.len() <= 128
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    };
    if !valid(owner) || !valid(name) {
        return Err(CliError(
            "Replicate models must use the owner/model form from the public catalog.".to_owned(),
        )
        .into());
    }
    Ok((owner, name))
}

pub(super) fn inspect_schema(endpoint: &str, credential: &str) -> CliResult<ReplicateSchema> {
    let value = block_http(
        |client| {
            let mut request = client
                .get(endpoint)
                .header(reqwest::header::ACCEPT, "application/json")
                .timeout(std::time::Duration::from_secs(30));
            if !credential.is_empty() {
                request = request.header(
                    reqwest::header::AUTHORIZATION,
                    format!("Bearer {credential}"),
                );
            }
            request
        },
        MAX_SCHEMA_BYTES,
    )?;
    parse_schema(&value)
}

pub(super) fn build_prompt(package: &Value, has_system_prompt: bool) -> CliResult<String> {
    let package_text = serde_json::to_string(package).unwrap_or_default();
    let prompt = if has_system_prompt {
        package_text
    } else {
        format!("{AI_GENERATION_SYSTEM_PROMPT}\n\n{package_text}")
    };
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(
            CliError("The Replicate prompt exceeds the 8 MiB send limit.".to_owned()).into(),
        );
    }
    Ok(prompt)
}

fn parse_schema(root: &Value) -> CliResult<ReplicateSchema> {
    let latest = root
        .get("latest_version")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_schema())?;
    let version = latest
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| invalid_schema())?;
    let input = latest
        .get("openapi_schema")
        .and_then(|value| value.get("components"))
        .and_then(|value| value.get("schemas"))
        .and_then(|value| value.get("Input"))
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_schema())?;
    let properties = input
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_schema())?;
    let prompt = properties
        .get("prompt")
        .and_then(Value::as_object)
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("string"))
        .ok_or_else(|| {
            CliError(
                "This Replicate model does not expose a versioned string prompt input Tutorux can use."
                    .to_owned(),
            )
        })?;
    if prompt.get("x-cog-secret").and_then(Value::as_bool) == Some(true) {
        return Err(CliError(
            "This Replicate model marks its prompt as an author-defined secret input that Tutorux cannot collect safely."
                .to_owned(),
        )
        .into());
    }
    let has_system_prompt = properties
        .get("system_prompt")
        .and_then(Value::as_object)
        .is_some_and(|value| {
            value.get("type").and_then(Value::as_str) == Some("string")
                && value.get("x-cog-secret").and_then(Value::as_bool) != Some(true)
        });
    let required: Vec<&str> = match input.get("required") {
        None => Vec::new(),
        Some(Value::Array(names)) => names
            .iter()
            .map(|name| {
                name.as_str()
                    .filter(|value| !value.is_empty() && value.len() <= 128)
                    .ok_or_else(|| invalid_schema())
            })
            .collect::<Result<Vec<_>, CliError>>()?,
        Some(_) => return Err(invalid_schema().into()),
    };
    let supported_integer = |name: &str| {
        properties
            .get(name)
            .and_then(Value::as_object)
            .is_some_and(|value| {
                value.get("type").and_then(Value::as_str) == Some("integer")
                    && value.get("x-cog-secret").and_then(Value::as_bool) != Some(true)
            })
    };
    let token_input = TOKEN_INPUTS
        .iter()
        .find(|name| required.contains(*name) && supported_integer(name))
        .or_else(|| TOKEN_INPUTS.iter().find(|name| supported_integer(name)))
        .copied();
    for name in &required {
        let property = properties.get(*name).and_then(Value::as_object);
        if property
            .and_then(|value| value.get("x-cog-secret"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            return Err(CliError(format!(
                "This Replicate model requires an author-defined secret input ({name}) that Tutorux cannot collect safely."
            ))
            .into());
        }
        let supported = *name == "prompt"
            || (*name == "system_prompt" && has_system_prompt)
            || token_input == Some(*name);
        if !supported {
            return Err(CliError(format!(
                "This Replicate model requires an unsupported input ({name}). Choose a model with only prompt, system_prompt, and an optional supported token limit."
            ))
            .into());
        }
    }
    Ok(ReplicateSchema {
        version: version.to_owned(),
        has_system_prompt,
        token_input,
    })
}

fn invalid_schema() -> CliError {
    CliError("Replicate returned an invalid model schema.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::parse_schema;

    fn schema(properties: serde_json::Value, required: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "latest_version": {
                "id": "v1",
                "openapi_schema": {
                    "components": {
                        "schemas": {
                            "Input": {"properties": properties, "required": required}
                        }
                    }
                }
            }
        })
    }

    #[test]
    fn schema_reads_prompt_system_prompt_and_token_input() {
        let value = schema(
            serde_json::json!({
                "prompt": {"type": "string"},
                "system_prompt": {"type": "string"},
                "max_new_tokens": {"type": "integer"}
            }),
            serde_json::json!(["prompt"]),
        );
        let parsed = parse_schema(&value).map_err(|_| ()).expect("schema");
        assert_eq!(parsed.version, "v1");
        assert!(parsed.has_system_prompt);
        assert_eq!(parsed.token_input, Some("max_new_tokens"));
    }

    #[test]
    fn schema_rejects_required_secret_inputs() {
        let value = schema(
            serde_json::json!({
                "prompt": {"type": "string"},
                "api_key": {"type": "string", "x-cog-secret": true}
            }),
            serde_json::json!(["prompt", "api_key"]),
        );
        assert!(parse_schema(&value).is_err());
    }
}
