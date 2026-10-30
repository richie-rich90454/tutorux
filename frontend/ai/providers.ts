import { RecordType, type ArchiveRecord } from "../archive/format";

export interface AiProviderDefinition {
    id: string;
    name: string;
    description: string;
    protocol: string;
    defaultEndpoint: string;
    endpointPlaceholder?: string;
    credentialKey: string | null;
    local: boolean;
    generationAvailable?: boolean;
    generationUnavailableReason?: string;
}

export interface AiProviderConfigurationInput {
    providerId: string;
    endpoint: string;
    model: string;
}

const CORE_AI_PROVIDERS: readonly AiProviderDefinition[] = [
    {
        id: "openai",
        name: "OpenAI",
        description: "OpenAI Chat Completions API",
        protocol: "OpenAI Chat Completions",
        defaultEndpoint: "https://api.openai.com/v1",
        credentialKey: "OPENAI_API_KEY",
        local: false,
    },
    {
        id: "anthropic",
        name: "Anthropic",
        description: "Claude Messages API",
        protocol: "Anthropic Messages",
        defaultEndpoint: "https://api.anthropic.com",
        credentialKey: "ANTHROPIC_API_KEY",
        local: false,
    },
    {
        id: "google-gemini",
        name: "Google Gemini",
        description: "Gemini generate content API",
        protocol: "Gemini Generate Content",
        defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta",
        credentialKey: "GEMINI_API_KEY",
        local: false,
    },
    {
        id: "cohere",
        name: "Cohere",
        description: "Cohere Chat v2 API",
        protocol: "Cohere Chat v2",
        defaultEndpoint: "https://api.cohere.com",
        credentialKey: "COHERE_API_KEY",
        local: false,
    },
    {
        id: "perplexity",
        name: "Perplexity",
        description: "Perplexity Agent API",
        protocol: "Perplexity Agent",
        defaultEndpoint: "https://api.perplexity.ai/v1",
        credentialKey: "PERPLEXITY_API_KEY",
        local: false,
    },
    {
        id: "ollama",
        name: "Ollama (local)",
        description: "Local Ollama service",
        protocol: "Ollama Chat",
        defaultEndpoint: "http://127.0.0.1:11434",
        credentialKey: null,
        local: true,
    },
    {
        id: "lm-studio",
        name: "LM Studio (local)",
        description: "Local OpenAI-compatible LM Studio service",
        protocol: "OpenAI Chat Completions",
        defaultEndpoint: "http://127.0.0.1:1234/v1",
        credentialKey: null,
        local: true,
    },
    {
        id: "llama.cpp-server",
        name: "llama.cpp server (local)",
        description: "Local OpenAI-compatible llama.cpp server",
        protocol: "OpenAI Chat Completions",
        defaultEndpoint: "http://127.0.0.1:8080/v1",
        credentialKey: null,
        local: true,
    },
    {
        id: "embedded-gguf",
        name: "Embedded GGUF (offline)",
        description: "In-process GGUF model · no network request",
        protocol: "Local llama.cpp runtime",
        defaultEndpoint: "tutorux://embedded/generate",
        credentialKey: null,
        local: true,
    },
    {
        id: "openai-compatible",
        name: "OpenAI-compatible endpoint",
        description: "Custom OpenAI-compatible service",
        protocol: "OpenAI-compatible Chat Completions",
        defaultEndpoint: "",
        credentialKey: "TUTORUX_OPENAI_COMPATIBLE_API_KEY",
        local: false,
    },
];

function compatibleCloudProvider(
    id: string,
    name: string,
    defaultEndpoint: string,
    credentialKey: string,
    description = `${name} OpenAI-compatible Chat Completions API`,
    endpointPlaceholder?: string,
): AiProviderDefinition {
    return {
        id,
        name,
        description,
        protocol: "OpenAI Chat Completions",
        defaultEndpoint,
        ...(endpointPlaceholder ? { endpointPlaceholder } : {}),
        credentialKey,
        local: false,
    };
}

const OPENAI_COMPATIBLE_CLOUD_PROVIDERS: readonly AiProviderDefinition[] = [
    compatibleCloudProvider("xai", "xAI", "https://api.x.ai/v1", "XAI_API_KEY"),
    compatibleCloudProvider(
        "openrouter",
        "OpenRouter",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
    ),
    compatibleCloudProvider(
        "together",
        "Together AI",
        "https://api.together.ai/v1",
        "TOGETHER_API_KEY",
    ),
    compatibleCloudProvider(
        "fireworks",
        "Fireworks AI",
        "https://api.fireworks.ai/inference/v1",
        "FIREWORKS_API_KEY",
    ),
    compatibleCloudProvider(
        "deepinfra",
        "DeepInfra",
        "https://api.deepinfra.com/v1/openai",
        "DEEPINFRA_API_KEY",
    ),
    compatibleCloudProvider(
        "novita",
        "Novita AI",
        "https://api.novita.ai/openai/v1",
        "NOVITA_API_KEY",
    ),
    compatibleCloudProvider(
        "nebius",
        "Nebius AI Studio",
        "https://api.studio.nebius.com/v1",
        "NEBIUS_API_KEY",
    ),
    compatibleCloudProvider("groq", "Groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    compatibleCloudProvider(
        "cerebras",
        "Cerebras",
        "https://api.cerebras.ai/v1",
        "CEREBRAS_API_KEY",
    ),
    compatibleCloudProvider(
        "sambanova",
        "SambaNova",
        "https://api.sambanova.ai/v1",
        "SAMBANOVA_API_KEY",
    ),
    compatibleCloudProvider(
        "nvidia",
        "NVIDIA NIM",
        "https://integrate.api.nvidia.com/v1",
        "NVIDIA_API_KEY",
    ),
    compatibleCloudProvider("deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY"),
    compatibleCloudProvider(
        "mistral",
        "Mistral AI",
        "https://api.mistral.ai/v1",
        "MISTRAL_API_KEY",
    ),
    compatibleCloudProvider(
        "huggingface",
        "Hugging Face Inference Providers",
        "https://router.huggingface.co/v1",
        "HF_TOKEN",
    ),
    compatibleCloudProvider(
        "moonshot",
        "Moonshot AI",
        "https://api.moonshot.ai/v1",
        "MOONSHOT_API_KEY",
    ),
    compatibleCloudProvider("zai", "Z.AI", "https://api.z.ai/api/paas/v4", "ZAI_API_KEY"),
    compatibleCloudProvider("minimax", "MiniMax", "https://api.minimax.io/v1", "MINIMAX_API_KEY"),
    compatibleCloudProvider(
        "siliconflow",
        "SiliconFlow",
        "https://api.siliconflow.cn/v1",
        "SILICONFLOW_API_KEY",
    ),
    compatibleCloudProvider(
        "alibaba-cloud",
        "Alibaba Cloud Model Studio",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "DASHSCOPE_API_KEY",
    ),
    compatibleCloudProvider(
        "baidu",
        "Baidu Qianfan",
        "https://qianfan.baidubce.com/v2",
        "BAIDU_API_KEY",
    ),
    compatibleCloudProvider(
        "tencent-cloud",
        "Tencent Cloud TokenHub",
        "https://tokenhub.tencentmaas.com/v1",
        "TOKENHUB_API_KEY",
    ),
    compatibleCloudProvider(
        "volcengine",
        "Volcengine Ark",
        "https://ark.cn-beijing.volces.com/api/v3",
        "ARK_API_KEY",
    ),
    compatibleCloudProvider(
        "bedrock",
        "Amazon Bedrock Mantle",
        "https://bedrock-mantle.us-east-1.api.aws/v1",
        "AWS_BEARER_TOKEN_BEDROCK",
    ),
    compatibleCloudProvider(
        "azure-openai",
        "Azure OpenAI",
        "",
        "AZURE_OPENAI_API_KEY",
        "Azure OpenAI v1 Chat Completions API",
        "https://my-resource.openai.azure.com/openai/v1",
    ),
    compatibleCloudProvider(
        "cloudflare-workers-ai",
        "Cloudflare Workers AI",
        "",
        "CLOUDFLARE_API_TOKEN",
        "Account-scoped Cloudflare Workers AI OpenAI-compatible API",
        "https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1",
    ),
    compatibleCloudProvider("ai21", "AI21 Labs", "https://api.ai21.com/studio/v1", "AI21_API_KEY"),
];

const ADDITIONAL_AI_PROVIDERS: readonly AiProviderDefinition[] = [
    {
        id: "replicate",
        name: "Replicate",
        description:
            "Run reviewed text generations through Replicate’s asynchronous prediction API.",
        protocol: "Replicate Prediction API",
        defaultEndpoint: "https://api.replicate.com/v1",
        credentialKey: "REPLICATE_API_TOKEN",
        local: false,
    },
    {
        id: "opencode-go",
        name: "OpenCode Go (models only)",
        description:
            "Public model discovery only; this provider is restricted to coding-agent traffic.",
        protocol: "OpenCode Go · tutoring use restricted",
        defaultEndpoint: "https://opencode.ai/zen/go/v1",
        credentialKey: null,
        local: false,
        generationAvailable: false,
        generationUnavailableReason:
            "OpenCode Go is restricted to coding-agent traffic. Tutorux will not send tutoring packages, notes, or transcripts to it.",
    },
    {
        id: "opencode-zen",
        name: "OpenCode Zen",
        description: "Model-routed OpenAI Chat, Responses, Anthropic Messages, and Gemini APIs",
        protocol: "OpenCode Zen model-routed protocols",
        defaultEndpoint: "https://opencode.ai/inference/v1",
        credentialKey: "OPENCODE_API_KEY",
        local: false,
    },
];

export const AI_PROVIDERS: readonly AiProviderDefinition[] = [
    ...CORE_AI_PROVIDERS.slice(0, 5),
    ...OPENAI_COMPATIBLE_CLOUD_PROVIDERS,
    ...CORE_AI_PROVIDERS.slice(5),
    ...ADDITIONAL_AI_PROVIDERS,
];

export type OpenCodeZenProtocol = "openai-chat" | "openai-responses" | "anthropic" | "gemini";

export function openCodeZenProtocolForModel(model: string): OpenCodeZenProtocol {
    if (model.startsWith("jev-")) {
        throw new Error(
            "OpenCode Zen Jev models return structured classifications, not tutoring guide text.",
        );
    }
    if (model.startsWith("gpt-") || model.startsWith("grok-") || model.startsWith("muse-spark-")) {
        return "openai-responses";
    }
    if (
        model.startsWith("claude-") ||
        model.startsWith("qwen3.5-") ||
        model.startsWith("qwen3.6-") ||
        model.startsWith("qwen3.7-") ||
        model.startsWith("qwen3.8-flash")
    ) {
        return "anthropic";
    }
    if (model.startsWith("gemini-")) return "gemini";
    return "openai-chat";
}

export function providerAuthenticationHeaderName(providerId: string, model = ""): string | null {
    if (providerId === "opencode-zen") {
        const protocol = openCodeZenProtocolForModel(model);
        if (protocol === "anthropic") return "x-api-key";
        if (protocol === "gemini") return "x-goog-api-key";
        return "Authorization";
    }
    switch (providerId) {
        case "anthropic":
            return "x-api-key";
        case "google-gemini":
            return "x-goog-api-key";
        case "azure-openai":
            return "api-key";
        case "ollama":
        case "lm-studio":
        case "llama.cpp-server":
        case "embedded-gguf":
        case "llama.cpp-embedded":
            return null;
        default:
            return "Authorization";
    }
}

export function usesAnthropicVersionHeader(providerId: string, model = ""): boolean {
    return (
        providerId === "anthropic" ||
        (providerId === "opencode-zen" && openCodeZenProtocolForModel(model) === "anthropic")
    );
}

/** `llama.cpp-embedded` is the legacy archive/CLI ID; `embedded-gguf` is its current UI ID. */
export function isEmbeddedGgufProvider(providerId: string): boolean {
    const normalized = providerId.trim().toLowerCase();
    return normalized === "embedded-gguf" || normalized === "llama.cpp-embedded";
}

export function providerById(providerId: string): AiProviderDefinition | undefined {
    let normalized = providerId.trim().toLowerCase();
    if (isEmbeddedGgufProvider(normalized)) {
        return AI_PROVIDERS.find((provider) => provider.id === "embedded-gguf");
    }
    if (normalized === "lm studio") normalized = "lm-studio";
    if (normalized === "llama.cpp server") normalized = "llama.cpp-server";
    if (normalized === "cloudflare" || normalized === "workers-ai") {
        normalized = "cloudflare-workers-ai";
    }
    if (normalized === "z.ai") normalized = "zai";
    return AI_PROVIDERS.find((provider) => provider.id === normalized);
}

export function isOpenAiCompatibleProvider(providerId: string): boolean {
    return providerById(providerId)?.protocol.includes("OpenAI") ?? false;
}

/** Legacy `ai providers` status values kept for CLI compatibility. */
export function aiProviderCatalogStatus(providerId: string): string {
    switch (providerId) {
        case "anthropic":
            return "anthropic-messages-protocol";
        case "google-gemini":
            return "gemini-generate-content-protocol";
        case "cohere":
            return "cohere-chat-v2-protocol";
        case "perplexity":
            return "perplexity-agent-api";
        case "replicate":
            return "replicate-prediction-api";
        case "ollama":
            return "native-ollama-api";
        case "lm-studio":
        case "llama.cpp-server":
            return "local-openai-compatible";
        case "llama.cpp-embedded":
        case "embedded-gguf":
            return "embedded-gguf-runtime";
        case "opencode-go":
            return "coding-agent-use-restricted";
        case "opencode-zen":
            return "multi-protocol-model-routes";
        case "ai21":
        case "zai":
            return "models-dev-chat-completions";
        default:
            return "openai-compatible-protocol";
    }
}

export async function createProviderConfigurationRecord(
    input: AiProviderConfigurationInput,
    now = Date.now(),
): Promise<ArchiveRecord> {
    const provider = providerById(input.providerId);
    if (!provider) throw new Error("Choose a supported AI provider.");
    const endpoint = validateProviderEndpoint(input.endpoint, provider);
    const model = cleanField(input.model, "Model", 1024, true);
    const id = await deterministicUuid(`ai-provider:${provider.id}`);
    return {
        type: RecordType.settings,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["record_role", "ai-provider"],
            ["provider_id", provider.id],
            ["endpoint", endpoint],
            ["selected_model", model],
            ["configured_at_us", (BigInt(now) * 1000n).toString()],
            ["credential_storage", "memory-only"],
        ]),
        blob: new Uint8Array(),
    };
}

export async function createProviderCredentialRecord(
    providerId: string,
    value: string,
    encryptedArchive: boolean,
    now = Date.now(),
): Promise<ArchiveRecord> {
    const provider = providerById(providerId);
    if (!provider) throw new Error("Choose a supported AI provider.");
    if (!provider.credentialKey) throw new Error("This local provider does not need an API key.");
    if (!encryptedArchive) {
        throw new Error("API keys can only be saved inside an encrypted archive.");
    }
    const secret = cleanField(value, "API key", 4096, false);
    if (/\s/u.test(secret)) throw new Error("API key cannot contain whitespace.");
    return {
        type: RecordType.settings,
        id: await deterministicUuid(`credential:${provider.credentialKey}`),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["record_role", "credential"],
            ["key", provider.credentialKey],
            ["provider_id", provider.id],
            ["value", secret],
            ["updated_at_us", (BigInt(now) * 1000n).toString()],
        ]),
        blob: new Uint8Array(),
    };
}

export function maskCredentialMetadata(record: ArchiveRecord): ArchiveRecord {
    const fields = new Map(record.fields);
    for (const name of fields.keys()) {
        if (
            ["value", "secret", "api_key", "token", "access_token", "refresh_token"].includes(
                name.toLowerCase(),
            )
        ) {
            fields.delete(name);
        }
    }
    return { ...record, fields, blob: new Uint8Array() };
}

export function validateProviderEndpoint(value: string, provider: AiProviderDefinition): string {
    const endpoint = cleanField(value, "Endpoint", 2048, false);
    if (isEmbeddedGgufProvider(provider.id)) {
        if (endpoint !== provider.defaultEndpoint) {
            throw new Error(
                "Embedded GGUF inference uses the in-process desktop runtime endpoint.",
            );
        }
        return endpoint;
    }
    let parsed: URL;
    try {
        parsed = new URL(endpoint);
    } catch {
        throw new Error("Enter a valid provider endpoint URL.");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(
            "Endpoint URLs cannot contain credentials, query parameters, or fragments.",
        );
    }
    if (provider.id === "replicate") {
        if (
            parsed.protocol !== "https:" ||
            parsed.hostname.toLowerCase() !== "api.replicate.com" ||
            parsed.port !== "" ||
            (parsed.pathname !== "/v1" && parsed.pathname !== "/v1/")
        ) {
            throw new Error(
                "Replicate requests must use the official https://api.replicate.com/v1 API.",
            );
        }
        return "https://api.replicate.com/v1";
    }
    if (provider.id === "cloudflare-workers-ai") {
        const match = /^\/client\/v4\/accounts\/([0-9a-f-]+)\/ai\/v1\/?$/u.exec(parsed.pathname);
        if (
            parsed.hostname.toLowerCase() !== "api.cloudflare.com" ||
            parsed.protocol !== "https:" ||
            parsed.port !== "" ||
            !match
        ) {
            throw new Error(
                "Cloudflare Workers AI requires an account-scoped endpoint ending in /client/v4/accounts/{account-id}/ai/v1.",
            );
        }
    }
    if (provider.local) {
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
            parsed.hostname.toLowerCase(),
        );
        if (parsed.protocol !== "http:" || !loopback) {
            throw new Error("Local model endpoints must use HTTP on localhost, 127.0.0.1, or ::1.");
        }
    } else if (parsed.protocol !== "https:") {
        throw new Error("Cloud provider endpoints must use HTTPS.");
    }
    return endpoint.replace(/\/$/u, "");
}

function cleanField(
    value: string,
    label: string,
    maximumBytes: number,
    allowEmpty: boolean,
): string {
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
    const cleaned = value.trim();
    if (!allowEmpty && !cleaned) throw new Error(`${label} is required.`);
    if (new TextEncoder().encode(cleaned).byteLength > maximumBytes) {
        throw new Error(`${label} must be ${maximumBytes.toLocaleString()} bytes or fewer.`);
    }
    return cleaned;
}

export async function deterministicUuid(seed: string): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
    );
    digest[6] = (digest[6]! & 0x0f) | 0x50;
    digest[8] = (digest[8]! & 0x3f) | 0x80;
    const hex = [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0"));
    const value = hex.join("");
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
