import { Channel, invoke } from "@tauri-apps/api/core";
import { sendEmbeddedAiRequest } from "./embedded-ai";
import type { AiTransportRequest } from "./ai-types";

export interface AiProvider {
    id: string;
    name: string;
    protocol: "openai" | "anthropic" | "gemini" | "embedded";
    baseEndpoint: string;
    defaultModel: string;
    keyRequired: boolean;
}

export const AI_PROVIDERS: AiProvider[] = [
    {
        id: "embedded-gguf",
        name: "Local GGUF (offline)",
        protocol: "embedded",
        baseEndpoint: "",
        defaultModel: "",
        keyRequired: false,
    },
    {
        id: "openai",
        name: "OpenAI",
        protocol: "openai",
        baseEndpoint: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
        keyRequired: true,
    },
    {
        id: "anthropic",
        name: "Anthropic",
        protocol: "anthropic",
        baseEndpoint: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-4-20250514",
        keyRequired: true,
    },
    {
        id: "google-gemini",
        name: "Google Gemini",
        protocol: "gemini",
        baseEndpoint: "https://generativelanguage.googleapis.com/v1beta",
        defaultModel: "gemini-2.5-flash",
        keyRequired: true,
    },
    {
        id: "openrouter",
        name: "OpenRouter",
        protocol: "openai",
        baseEndpoint: "https://openrouter.ai/api/v1",
        defaultModel: "openai/gpt-4.1-mini",
        keyRequired: true,
    },
    {
        id: "deepseek",
        name: "DeepSeek",
        protocol: "openai",
        baseEndpoint: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
        keyRequired: true,
    },
    {
        id: "groq",
        name: "Groq",
        protocol: "openai",
        baseEndpoint: "https://api.groq.com/openai/v1",
        defaultModel: "llama-3.3-70b-versatile",
        keyRequired: true,
    },
    {
        id: "mistral",
        name: "Mistral",
        protocol: "openai",
        baseEndpoint: "https://api.mistral.ai/v1",
        defaultModel: "mistral-large-latest",
        keyRequired: true,
    },
    {
        id: "xai",
        name: "xAI",
        protocol: "openai",
        baseEndpoint: "https://api.x.ai/v1",
        defaultModel: "grok-4",
        keyRequired: true,
    },
    {
        id: "together",
        name: "Together",
        protocol: "openai",
        baseEndpoint: "https://api.together.xyz/v1",
        defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        keyRequired: true,
    },
    {
        id: "fireworks",
        name: "Fireworks",
        protocol: "openai",
        baseEndpoint: "https://api.fireworks.ai/inference/v1",
        defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
        keyRequired: true,
    },
    {
        id: "zai",
        name: "Z.AI",
        protocol: "openai",
        baseEndpoint: "https://api.z.ai/api/paas/v4",
        defaultModel: "glm-4.5",
        keyRequired: true,
    },
    {
        id: "minimax",
        name: "MiniMax",
        protocol: "openai",
        baseEndpoint: "https://api.minimax.io/v1",
        defaultModel: "MiniMax-M2",
        keyRequired: true,
    },
    {
        id: "alibaba-cloud",
        name: "Alibaba Qwen",
        protocol: "openai",
        baseEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        defaultModel: "qwen3-max",
        keyRequired: true,
    },
    {
        id: "moonshot",
        name: "Moonshot",
        protocol: "openai",
        baseEndpoint: "https://api.moonshot.ai/v1",
        defaultModel: "kimi-k2-0905-preview",
        keyRequired: true,
    },
    {
        id: "nvidia",
        name: "NVIDIA",
        protocol: "openai",
        baseEndpoint: "https://integrate.api.nvidia.com/v1",
        defaultModel: "meta/llama-3.3-70b-instruct",
        keyRequired: true,
    },
    {
        id: "cerebras",
        name: "Cerebras",
        protocol: "openai",
        baseEndpoint: "https://api.cerebras.ai/v1",
        defaultModel: "llama3.3-70b",
        keyRequired: true,
    },
    {
        id: "sambanova",
        name: "SambaNova",
        protocol: "openai",
        baseEndpoint: "https://api.sambanova.ai/v1",
        defaultModel: "Meta-Llama-3.3-70B-Instruct",
        keyRequired: true,
    },
    {
        id: "novita",
        name: "Novita",
        protocol: "openai",
        baseEndpoint: "https://api.novita.ai/v3/openai",
        defaultModel: "meta-llama/llama-3.3-70b-instruct",
        keyRequired: true,
    },
    {
        id: "nebius",
        name: "Nebius",
        protocol: "openai",
        baseEndpoint: "https://api.studio.nebius.com/v1",
        defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct",
        keyRequired: true,
    },
    {
        id: "deepinfra",
        name: "DeepInfra",
        protocol: "openai",
        baseEndpoint: "https://api.deepinfra.com/v1/openai",
        defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
        keyRequired: true,
    },
    {
        id: "siliconflow",
        name: "SiliconFlow",
        protocol: "openai",
        baseEndpoint: "https://api.siliconflow.cn/v1",
        defaultModel: "Qwen/Qwen3-235B-A22B-Instruct-2507",
        keyRequired: true,
    },
];

export function providerById(id: string): AiProvider {
    return AI_PROVIDERS.find((provider) => provider.id === id) ?? AI_PROVIDERS[0]!;
}

interface AiTransportEvent {
    kind: "chunk";
    base64: string;
}

interface AiRequest {
    providerId: string;
    endpoint: string;
    confirmedEndpoint: string;
    model: string;
    accept: string;
    requestBody: string;
    requestBodyHash: string;
    confirmedBodyHash: string;
    credentialStorage: "none" | "encrypted-archive" | "system-keychain";
    credential: string;
}

interface AiTransportResult {
    status: number;
    contentType: string;
    responseBytes: number;
    complete: boolean;
    cancelled: boolean;
    errorMessage?: string;
}

async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    );
}

function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function endpointFor(provider: AiProvider, model: string, base: string): string {
    const root = base.replace(/\/+$/u, "");
    if (provider.protocol === "openai") return `${root}/chat/completions`;
    if (provider.protocol === "anthropic") return `${root}/v1/messages`;
    return `${root}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

function bodyFor(provider: AiProvider, model: string, system: string, user: string): string {
    if (provider.protocol === "openai") {
        return JSON.stringify({
            model,
            stream: true,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
        });
    }
    if (provider.protocol === "anthropic") {
        return JSON.stringify({
            model,
            max_tokens: 4096,
            stream: true,
            system,
            messages: [{ role: "user", content: user }],
        });
    }
    return JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 4096 },
    });
}

function extractText(text: string, provider: AiProvider): string {
    let output = "";
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
            const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string }; text?: string }>;
                delta?: { text?: string };
                content_block?: { text?: string };
                candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            };
            if (provider.protocol === "openai" || provider.protocol === "embedded") {
                output += parsed.choices?.[0]?.delta?.content ?? "";
            } else if (provider.protocol === "anthropic") {
                output += parsed.delta?.text ?? parsed.content_block?.text ?? "";
            } else {
                output += parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
            }
        } catch {
            // Ignore keep-alive or non-JSON provider lines.
        }
    }
    return output;
}

export async function sendAiMessage(options: {
    providerId: string;
    endpoint?: string;
    model: string;
    system: string;
    user: string;
    onChunk?: (text: string) => void;
}): Promise<string> {
    const provider = providerById(options.providerId);
    const model = options.model.trim() || provider.defaultModel;
    if (provider.protocol === "embedded") {
        const requestBody = JSON.stringify({
            model,
            max_tokens: 4096,
            messages: [
                { role: "system", content: options.system },
                { role: "user", content: options.user },
            ],
        });
        const hash = await sha256Hex(requestBody);
        const request: AiTransportRequest = {
            providerId: "embedded-gguf",
            endpoint: "",
            confirmedEndpoint: "",
            model,
            accept: "text/event-stream",
            requestBody,
            requestBodyHash: hash,
            confirmedBodyHash: hash,
            credentialStorage: "none",
            credential: "",
        };
        let raw = "";
        await sendEmbeddedAiRequest(request, (chunk) => {
            const text = new TextDecoder().decode(chunk);
            raw += text;
            if (options.onChunk) {
                const parsed = extractText(text, provider);
                if (parsed) options.onChunk(parsed);
            }
        });
        return extractText(raw, provider);
    }
    const endpoint = endpointFor(provider, model, options.endpoint || provider.baseEndpoint);
    const requestBody = bodyFor(provider, model, options.system, options.user);
    const hash = await sha256Hex(requestBody);
    const request: AiRequest = {
        providerId: provider.id,
        endpoint,
        confirmedEndpoint: endpoint,
        model,
        accept: "text/event-stream",
        requestBody,
        requestBodyHash: hash,
        confirmedBodyHash: hash,
        credentialStorage: "system-keychain",
        credential: "",
    };
    let raw = "";
    const channel = new Channel<AiTransportEvent>();
    channel.onmessage = (event) => {
        if (event.kind !== "chunk") return;
        const chunk = new TextDecoder().decode(decodeBase64(event.base64));
        raw += chunk;
        if (options.onChunk) {
            const text = extractText(chunk, provider);
            if (text) options.onChunk(text);
        }
    };
    const result = await invoke<AiTransportResult>("send_ai_request", {
        request,
        onChunk: channel,
    });
    if (result.errorMessage) throw new Error(result.errorMessage);
    if (result.status < 200 || result.status >= 300) {
        throw new Error(`The provider returned HTTP ${result.status}.`);
    }
    return extractText(raw, provider);
}

export async function saveAiKey(providerId: string, key: string): Promise<void> {
    await invoke("save_ai_credential", { providerId, value: key });
}

export async function removeAiKey(providerId: string): Promise<void> {
    await invoke("remove_ai_credential", { providerId });
}

export async function hasAiKey(providerId: string): Promise<boolean> {
    return invoke<boolean>("has_ai_credential", { providerId });
}
