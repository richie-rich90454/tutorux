import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isEmbeddedGgufProvider } from "../ai/providers";
import type { AiTransportRequest, AiTransportResult } from "./types";

const encoder = new TextEncoder();
let activeRequestId: string | null = null;

export interface EmbeddedModelInfo {
    authorizationToken: string;
    modelId: string;
    name: string;
    architecture: string;
    fileSizeBytes: number;
    tensorCount: number;
    estimatedMemoryBytes: number;
    contextTokens: number;
    maximumContextTokens: number;
    maximumCpuThreads: number;
}

export interface EmbeddedModelStatus {
    loaded: boolean;
    modelId: string | null;
    name: string | null;
    pathName: string | null;
    contextTokens: number | null;
    cpuThreads: number | null;
    memoryEstimateBytes: number | null;
}

interface EmbeddedChunk {
    text: string;
}

export function embeddedModelRuntimeAvailable(): boolean {
    return isTauri();
}

export async function selectAndInspectEmbeddedModel(): Promise<EmbeddedModelInfo | null> {
    if (!isTauri()) throw new Error("In-process GGUF inference is available in the desktop app.");
    const path = await open({
        title: "Choose a local GGUF model",
        multiple: false,
        directory: false,
        filters: [{ name: "GGUF model", extensions: ["gguf"] }],
    });
    if (!path || Array.isArray(path)) return null;
    return invoke<EmbeddedModelInfo>("authorize_embedded_model", { path });
}

export function loadEmbeddedModel(
    authorizationToken: string,
    contextTokens: number,
    cpuThreads: number,
): Promise<EmbeddedModelStatus> {
    return invoke<EmbeddedModelStatus>("load_embedded_model", {
        request: { authorizationToken, contextTokens, cpuThreads },
    });
}

export function unloadEmbeddedModel(): Promise<EmbeddedModelStatus> {
    return invoke<EmbeddedModelStatus>("unload_embedded_model");
}

export async function readEmbeddedModelStatus(): Promise<EmbeddedModelStatus> {
    return invoke<EmbeddedModelStatus>("embedded_model_status");
}

export async function cancelEmbeddedAiGeneration(): Promise<boolean> {
    const requestId = activeRequestId;
    if (!requestId || !isTauri()) return false;
    return invoke<boolean>("cancel_embedded_generation", { requestId });
}

/** Runs the reviewed prompt inside the selected desktop runtime and adapts it to OpenAI SSE. */
export async function sendEmbeddedAiRequest(
    request: AiTransportRequest,
    onChunk: (chunk: Uint8Array) => void,
): Promise<AiTransportResult> {
    if (!isTauri()) throw new Error("In-process GGUF inference is available in the desktop app.");
    if (!isEmbeddedGgufProvider(request.providerId) || request.credential) {
        throw new Error("The local inference request is not a valid credential-free GGUF request.");
    }
    const payload = parseGenerationPayload(request.requestBody);
    const requestId = crypto.randomUUID();
    activeRequestId = requestId;
    let responseBytes = 0;
    const push = (bytes: Uint8Array) => {
        responseBytes += bytes.byteLength;
        onChunk(bytes);
    };
    const channel = new Channel<EmbeddedChunk>();
    channel.onmessage = ({ text }) => {
        if (!text) return;
        const event = JSON.stringify({ choices: [{ delta: { content: text } }] });
        push(encoder.encode(`data: ${event}\n\n`));
    };
    try {
        await invoke("generate_embedded_text", {
            request: {
                requestId,
                modelId: payload.model,
                systemPrompt: payload.systemPrompt,
                userContent: payload.userContent,
                maximumOutputTokens: payload.maximumOutputTokens,
            },
            onChunk: channel,
        });
        push(encoder.encode("data: [DONE]\n\n"));
        return {
            status: 200,
            contentType: "text/event-stream",
            responseBytes,
            complete: true,
        };
    } finally {
        if (activeRequestId === requestId) activeRequestId = null;
    }
}

interface GenerationPayload {
    model: string;
    systemPrompt: string;
    userContent: string;
    maximumOutputTokens: number;
}

function parseGenerationPayload(raw: string): GenerationPayload {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error("The local generation request could not be decoded.");
    }
    if (!isObject(value) || !Array.isArray(value["messages"])) {
        throw new Error("The local generation request is missing its reviewed prompt.");
    }
    const model = value["model"];
    const systemMessage = value["messages"].find(
        (message) => isObject(message) && message["role"] === "system",
    );
    const userMessage = value["messages"].find(
        (message) => isObject(message) && message["role"] === "user",
    );
    if (
        typeof model !== "string" ||
        !isObject(systemMessage) ||
        !isObject(userMessage) ||
        typeof systemMessage["content"] !== "string" ||
        typeof userMessage["content"] !== "string" ||
        typeof value["max_tokens"] !== "number" ||
        !Number.isSafeInteger(value["max_tokens"])
    ) {
        throw new Error("The local generation request has an unsupported prompt format.");
    }
    return {
        model,
        systemPrompt: systemMessage["content"],
        userContent: userMessage["content"],
        maximumOutputTokens: value["max_tokens"],
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
