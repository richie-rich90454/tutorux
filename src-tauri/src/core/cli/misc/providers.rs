use serde_json::{json, Value};

use crate::core::cli::{emit, CliOutput, CliResult, ParsedArguments};

pub(super) struct ProviderDef {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub protocol: &'static str,
    pub default_endpoint: &'static str,
    pub endpoint_placeholder: &'static str,
    pub credential_key: Option<&'static str>,
    pub local: bool,
    pub generation_available: bool,
    pub generation_unavailable_reason: &'static str,
}

const fn provider(
    id: &'static str,
    name: &'static str,
    description: &'static str,
    protocol: &'static str,
    default_endpoint: &'static str,
    credential_key: Option<&'static str>,
    local: bool,
) -> ProviderDef {
    ProviderDef {
        id,
        name,
        description,
        protocol,
        default_endpoint,
        endpoint_placeholder: "",
        credential_key,
        local,
        generation_available: true,
        generation_unavailable_reason: "",
    }
}

const fn provider_with_placeholder(
    id: &'static str,
    name: &'static str,
    description: &'static str,
    protocol: &'static str,
    default_endpoint: &'static str,
    endpoint_placeholder: &'static str,
    credential_key: Option<&'static str>,
    local: bool,
) -> ProviderDef {
    ProviderDef {
        id,
        name,
        description,
        protocol,
        default_endpoint,
        endpoint_placeholder,
        credential_key,
        local,
        generation_available: true,
        generation_unavailable_reason: "",
    }
}

pub(super) const PROVIDERS: &[ProviderDef] = &[
    provider("openai", "OpenAI", "OpenAI Chat Completions API", "OpenAI Chat Completions", "https://api.openai.com/v1", Some("OPENAI_API_KEY"), false),
    provider("anthropic", "Anthropic", "Claude Messages API", "Anthropic Messages", "https://api.anthropic.com", Some("ANTHROPIC_API_KEY"), false),
    provider("google-gemini", "Google Gemini", "Gemini generate content API", "Gemini Generate Content", "https://generativelanguage.googleapis.com/v1beta", Some("GEMINI_API_KEY"), false),
    provider("cohere", "Cohere", "Cohere Chat v2 API", "Cohere Chat v2", "https://api.cohere.com", Some("COHERE_API_KEY"), false),
    provider("perplexity", "Perplexity", "Perplexity Agent API", "Perplexity Agent", "https://api.perplexity.ai/v1", Some("PERPLEXITY_API_KEY"), false),
    provider("xai", "xAI", "xAI OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.x.ai/v1", Some("XAI_API_KEY"), false),
    provider("openrouter", "OpenRouter", "OpenRouter OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://openrouter.ai/api/v1", Some("OPENROUTER_API_KEY"), false),
    provider("together", "Together AI", "Together AI OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.together.ai/v1", Some("TOGETHER_API_KEY"), false),
    provider("fireworks", "Fireworks AI", "Fireworks AI OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.fireworks.ai/inference/v1", Some("FIREWORKS_API_KEY"), false),
    provider("deepinfra", "DeepInfra", "DeepInfra OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.deepinfra.com/v1/openai", Some("DEEPINFRA_API_KEY"), false),
    provider("novita", "Novita AI", "Novita AI OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.novita.ai/openai/v1", Some("NOVITA_API_KEY"), false),
    provider("nebius", "Nebius AI Studio", "Nebius AI Studio OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.studio.nebius.com/v1", Some("NEBIUS_API_KEY"), false),
    provider("groq", "Groq", "Groq OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.groq.com/openai/v1", Some("GROQ_API_KEY"), false),
    provider("cerebras", "Cerebras", "Cerebras OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.cerebras.ai/v1", Some("CEREBRAS_API_KEY"), false),
    provider("sambanova", "SambaNova", "SambaNova OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.sambanova.ai/v1", Some("SAMBANOVA_API_KEY"), false),
    provider("nvidia", "NVIDIA NIM", "NVIDIA NIM OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://integrate.api.nvidia.com/v1", Some("NVIDIA_API_KEY"), false),
    provider("deepseek", "DeepSeek", "DeepSeek OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.deepseek.com", Some("DEEPSEEK_API_KEY"), false),
    provider("mistral", "Mistral AI", "Mistral AI OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.mistral.ai/v1", Some("MISTRAL_API_KEY"), false),
    provider("huggingface", "Hugging Face Inference Providers", "Hugging Face Inference Providers OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://router.huggingface.co/v1", Some("HF_TOKEN"), false),
    provider("moonshot", "Moonshot AI", "Moonshot AI OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.moonshot.ai/v1", Some("MOONSHOT_API_KEY"), false),
    provider("zai", "Z.AI", "Z.AI OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.z.ai/api/paas/v4", Some("ZAI_API_KEY"), false),
    provider("minimax", "MiniMax", "MiniMax OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.minimax.io/v1", Some("MINIMAX_API_KEY"), false),
    provider("siliconflow", "SiliconFlow", "SiliconFlow OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.siliconflow.cn/v1", Some("SILICONFLOW_API_KEY"), false),
    provider("alibaba-cloud", "Alibaba Cloud Model Studio", "Alibaba Cloud Model Studio OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://dashscope.aliyuncs.com/compatible-mode/v1", Some("DASHSCOPE_API_KEY"), false),
    provider("baidu", "Baidu Qianfan", "Baidu Qianfan OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://qianfan.baidubce.com/v2", Some("BAIDU_API_KEY"), false),
    provider("tencent-cloud", "Tencent Cloud TokenHub", "Tencent Cloud TokenHub OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://tokenhub.tencentmaas.com/v1", Some("TOKENHUB_API_KEY"), false),
    provider("volcengine", "Volcengine Ark", "Volcengine Ark OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://ark.cn-beijing.volces.com/api/v3", Some("ARK_API_KEY"), false),
    provider("bedrock", "Amazon Bedrock Mantle", "Amazon Bedrock Mantle OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://bedrock-mantle.us-east-1.api.aws/v1", Some("AWS_BEARER_TOKEN_BEDROCK"), false),
    provider_with_placeholder("azure-openai", "Azure OpenAI", "Azure OpenAI v1 Chat Completions API", "OpenAI Chat Completions", "", "https://my-resource.openai.azure.com/openai/v1", Some("AZURE_OPENAI_API_KEY"), false),
    provider_with_placeholder("cloudflare-workers-ai", "Cloudflare Workers AI", "Account-scoped Cloudflare Workers AI OpenAI-compatible API", "OpenAI Chat Completions", "", "https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1", Some("CLOUDFLARE_API_TOKEN"), false),
    provider("ai21", "AI21 Labs", "AI21 Labs OpenAI-compatible Chat Completions API", "OpenAI Chat Completions", "https://api.ai21.com/studio/v1", Some("AI21_API_KEY"), false),
    provider("ollama", "Ollama (local)", "Local Ollama service", "Ollama Chat", "http://127.0.0.1:11434", None, true),
    provider("lm-studio", "LM Studio (local)", "Local OpenAI-compatible LM Studio service", "OpenAI Chat Completions", "http://127.0.0.1:1234/v1", None, true),
    provider("llama.cpp-server", "llama.cpp server (local)", "Local OpenAI-compatible llama.cpp server", "OpenAI Chat Completions", "http://127.0.0.1:8080/v1", None, true),
    provider("embedded-gguf", "Embedded GGUF (offline)", "In-process GGUF model · no network request", "Local llama.cpp runtime", "tutorux://embedded/generate", None, true),
    provider("openai-compatible", "OpenAI-compatible endpoint", "Custom OpenAI-compatible service", "OpenAI-compatible Chat Completions", "", Some("TUTORUX_OPENAI_COMPATIBLE_API_KEY"), false),
    provider("replicate", "Replicate", "Run reviewed text generations through Replicate’s asynchronous prediction API.", "Replicate Prediction API", "https://api.replicate.com/v1", Some("REPLICATE_API_TOKEN"), false),
    ProviderDef {
        id: "opencode-go",
        name: "OpenCode Go (models only)",
        description: "Public model discovery only; this provider is restricted to coding-agent traffic.",
        protocol: "OpenCode Go · tutoring use restricted",
        default_endpoint: "https://opencode.ai/zen/go/v1",
        endpoint_placeholder: "",
        credential_key: None,
        local: false,
        generation_available: false,
        generation_unavailable_reason:
            "OpenCode Go is restricted to coding-agent traffic. Tutorux will not send tutoring packages, notes, or transcripts to it.",
    },
    provider("opencode-zen", "OpenCode Zen", "Model-routed OpenAI Chat, Responses, Anthropic Messages, and Gemini APIs", "OpenCode Zen model-routed protocols", "https://opencode.ai/inference/v1", Some("OPENCODE_API_KEY"), false),
];

pub(super) fn provider_by_id(value: &str) -> Option<&'static ProviderDef> {
    let normalized = value.trim().to_ascii_lowercase();
    let normalized = match normalized.as_str() {
        "llama.cpp-embedded" | "embedded_gguf" => "embedded-gguf",
        "lm studio" => "lm-studio",
        "llama.cpp server" => "llama.cpp-server",
        "cloudflare" | "workers-ai" => "cloudflare-workers-ai",
        "z.ai" => "zai",
        _ => return PROVIDERS.iter().find(|provider| provider.id == normalized),
    };
    PROVIDERS.iter().find(|provider| provider.id == normalized)
}

pub(super) fn catalog_status(id: &str) -> &'static str {
    match id {
        "anthropic" => "anthropic-messages-protocol",
        "google-gemini" => "gemini-generate-content-protocol",
        "cohere" => "cohere-chat-v2-protocol",
        "perplexity" => "perplexity-agent-api",
        "replicate" => "replicate-prediction-api",
        "ollama" => "native-ollama-api",
        "lm-studio" | "llama.cpp-server" => "local-openai-compatible",
        "llama.cpp-embedded" | "embedded-gguf" => "embedded-gguf-runtime",
        "opencode-go" => "coding-agent-use-restricted",
        "opencode-zen" => "multi-protocol-model-routes",
        "ai21" | "zai" => "models-dev-chat-completions",
        _ => "openai-compatible-protocol",
    }
}

pub(super) fn is_openai_compatible(provider: &ProviderDef) -> bool {
    provider.protocol.contains("OpenAI")
}

pub(super) fn open_code_zen_protocol(model: &str) -> &'static str {
    if model.starts_with("gpt-") || model.starts_with("grok-") || model.starts_with("muse-spark-") {
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
    } else if model.starts_with("jev-") {
        "restricted"
    } else {
        "openai-chat"
    }
}

pub(super) fn authentication(
    provider: &ProviderDef,
    model: &str,
) -> Option<(&'static str, bool)> {
    match provider.id {
        "anthropic" => Some(("x-api-key", true)),
        "google-gemini" => Some(("x-goog-api-key", true)),
        "azure-openai" => Some(("api-key", true)),
        "opencode-zen" => Some(match open_code_zen_protocol(model) {
            "anthropic" => ("x-api-key", true),
            "gemini" => ("x-goog-api-key", true),
            _ => ("Authorization", false),
        }),
        "ollama" | "lm-studio" | "llama.cpp-server" | "embedded-gguf" => None,
        _ => Some(("Authorization", false)),
    }
}

pub(super) fn validate_endpoint(value: &str, provider: &ProviderDef) -> Result<String, String> {
    let endpoint = value.trim();
    if endpoint.is_empty() {
        return Err("Endpoint is required.".to_owned());
    }
    if endpoint.len() > 2048 || endpoint.contains('\0') {
        return Err("Endpoint is invalid.".to_owned());
    }
    if provider.id == "embedded-gguf" {
        if endpoint != provider.default_endpoint {
            return Err(
                "Embedded GGUF inference uses the in-process desktop runtime endpoint.".to_owned(),
            );
        }
        return Ok(endpoint.to_owned());
    }
    let url = reqwest::Url::parse(endpoint)
        .map_err(|_| "Enter a valid provider endpoint URL.".to_owned())?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(
            "Endpoint URLs cannot contain credentials, query parameters, or fragments.".to_owned(),
        );
    }
    if provider.id == "replicate" {
        if url.scheme() != "https"
            || url.host_str().map(str::to_ascii_lowercase).as_deref() != Some("api.replicate.com")
            || url.port().is_some()
            || !matches!(url.path(), "/v1" | "/v1/")
        {
            return Err(
                "Replicate requests must use the official https://api.replicate.com/v1 API.".to_owned(),
            );
        }
        return Ok("https://api.replicate.com/v1".to_owned());
    }
    if provider.id == "cloudflare-workers-ai" {
        let path = url.path().trim_end_matches('/');
        let valid = path.starts_with("/client/v4/accounts/")
            && path.ends_with("/ai/v1")
            && path
                .trim_start_matches("/client/v4/accounts/")
                .trim_end_matches("/ai/v1")
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
        if url.host_str().map(str::to_ascii_lowercase).as_deref() != Some("api.cloudflare.com")
            || url.scheme() != "https"
            || url.port().is_some()
            || !valid
        {
            return Err(
                "Cloudflare Workers AI requires an account-scoped endpoint ending in /client/v4/accounts/{account-id}/ai/v1."
                    .to_owned(),
            );
        }
    }
    if provider.local {
        let loopback = matches!(
            url.host_str().map(str::to_ascii_lowercase).as_deref(),
            Some("localhost") | Some("127.0.0.1") | Some("[::1]")
        );
        if url.scheme() != "http" || !loopback {
            return Err(
                "Local model endpoints must use HTTP on localhost, 127.0.0.1, or ::1.".to_owned(),
            );
        }
    } else if url.scheme() != "https" {
        return Err("Cloud provider endpoints must use HTTPS.".to_owned());
    }
    Ok(endpoint.trim_end_matches('/').to_owned())
}

pub(crate) fn run_diagnostics_providers(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
) -> CliResult<i32> {
    let rows: Vec<Value> = PROVIDERS
        .iter()
        .map(|provider| {
            let mut row = serde_json::Map::new();
            row.insert("id".to_owned(), json!(provider.id));
            row.insert("name".to_owned(), json!(provider.name));
            row.insert("description".to_owned(), json!(provider.description));
            row.insert("protocol".to_owned(), json!(provider.protocol));
            row.insert("defaultEndpoint".to_owned(), json!(provider.default_endpoint));
            if !provider.endpoint_placeholder.is_empty() {
                row.insert(
                    "endpointPlaceholder".to_owned(),
                    json!(provider.endpoint_placeholder),
                );
            }
            row.insert("credentialKey".to_owned(), json!(provider.credential_key));
            row.insert("local".to_owned(), json!(provider.local));
            if !provider.generation_available {
                row.insert("generationAvailable".to_owned(), json!(false));
                row.insert(
                    "generationUnavailableReason".to_owned(),
                    json!(provider.generation_unavailable_reason),
                );
            }
            Value::Object(row)
        })
        .collect();
    let summary = PROVIDERS
        .iter()
        .map(|provider| format!("{}  {}", provider.id, provider.name))
        .collect::<Vec<_>>()
        .join("\n");
    emit(output, Value::Array(rows), &summary, args.json());
    Ok(0)
}

pub fn run_ai_providers(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    let rows: Vec<Value> = PROVIDERS
        .iter()
        .map(|provider| {
            let mut catalog = serde_json::Map::new();
            catalog.insert("id".to_owned(), json!(provider.id));
            catalog.insert("name".to_owned(), json!(provider.name));
            catalog.insert("description".to_owned(), json!(provider.description));
            catalog.insert("protocol".to_owned(), json!(provider.protocol));
            catalog.insert("defaultEndpoint".to_owned(), json!(provider.default_endpoint));
            if !provider.endpoint_placeholder.is_empty() {
                catalog.insert(
                    "endpointPlaceholder".to_owned(),
                    json!(provider.endpoint_placeholder),
                );
            }
            catalog.insert("credentialKey".to_owned(), json!(provider.credential_key));
            catalog.insert("local".to_owned(), json!(provider.local));
            if !provider.generation_available {
                catalog.insert("generationAvailable".to_owned(), json!(false));
                catalog.insert(
                    "generationUnavailableReason".to_owned(),
                    json!(provider.generation_unavailable_reason),
                );
            }
            json!({
                "provider_id": provider.id,
                "provider": provider.name,
                "status": catalog_status(provider.id),
                "catalog": Value::Object(catalog),
            })
        })
        .collect();
    let summary = rows
        .iter()
        .map(|row| {
            format!(
                "{}  {}  {}",
                row["provider_id"].as_str().unwrap_or(""),
                row["provider"].as_str().unwrap_or(""),
                row["status"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    emit(output, Value::Array(rows), &summary, args.json());
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::{provider_by_id, validate_endpoint, PROVIDERS};

    #[test]
    fn catalog_matches_the_desktop_provider_surface() {
        assert_eq!(PROVIDERS.len(), 39);
        assert!(PROVIDERS.iter().any(|provider| provider.id == "embedded-gguf" && provider.local));
        assert!(PROVIDERS.iter().any(|provider| provider.id == "replicate"));
        assert!(PROVIDERS.iter().any(|provider| provider.id == "opencode-go" && !provider.generation_available));
    }

    #[test]
    fn provider_aliases_resolve_to_catalog_entries() {
        assert_eq!(provider_by_id("llama.cpp-embedded").map(|provider| provider.id), Some("embedded-gguf"));
        assert_eq!(provider_by_id("LM Studio").map(|provider| provider.id), Some("lm-studio"));
        assert_eq!(provider_by_id("cloudflare").map(|provider| provider.id), Some("cloudflare-workers-ai"));
        assert!(provider_by_id("not-a-provider").is_none());
    }

    #[test]
    fn local_endpoints_must_be_loopback_http() {
        let ollama = provider_by_id("ollama").expect("ollama provider");
        assert!(validate_endpoint("http://127.0.0.1:11434", ollama).is_ok());
        assert!(validate_endpoint("https://example.com", ollama).is_err());
        assert!(validate_endpoint("http://192.168.1.2:11434", ollama).is_err());
    }

    #[test]
    fn embedded_endpoints_are_fixed() {
        let embedded = provider_by_id("embedded-gguf").expect("embedded provider");
        assert!(validate_endpoint("tutorux://embedded/generate", embedded).is_ok());
        assert!(validate_endpoint("https://example.com", embedded).is_err());
    }
}
