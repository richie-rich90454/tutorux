import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockState {
    tauri: boolean;
    calls: { command: string; args: Record<string, unknown> | undefined }[];
    handler: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    openResult: string | string[] | null;
}

const state = vi.hoisted((): MockState => ({
    tauri: true,
    calls: [],
    handler: async () => undefined,
    openResult: null,
}));

type FakeChannel<T> = { onmessage: ((message: T) => void) | null };

vi.mock("@tauri-apps/api/core", () => ({
    Channel: class {
        onmessage: ((message: unknown) => void) | null = null;
    },
    isTauri: () => state.tauri,
    invoke: (command: string, args?: Record<string, unknown>) => {
        state.calls.push({ command, args });
        return state.handler(command, args);
    },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: async () => state.openResult,
}));

import {
    cancelEmbeddedAiGeneration,
    embeddedModelRuntimeAvailable,
    loadEmbeddedModel,
    readEmbeddedModelStatus,
    selectAndInspectEmbeddedModel,
    sendEmbeddedAiRequest,
    unloadEmbeddedModel,
    type EmbeddedModelInfo,
    type EmbeddedModelStatus,
} from "../../../frontend/platform/embedded-ai";
import type { AiTransportRequest } from "../../../frontend/platform/types";

const encoder = new TextEncoder();

const validRequest: AiTransportRequest = {
    providerId: "embedded-gguf",
    endpoint: "embedded://local",
    confirmedEndpoint: "embedded://local",
    model: "tiny",
    accept: "text/event-stream",
    requestBody: JSON.stringify({
        model: "tiny",
        messages: [
            { role: "system", content: "Be concise." },
            { role: "user", content: "Explain ratios." },
        ],
        max_tokens: 64,
    }),
    requestBodyHash: "hash",
    confirmedBodyHash: "hash",
    credentialStorage: "none",
    credential: "",
};

const modelInfo: EmbeddedModelInfo = {
    authorizationToken: "token",
    modelId: "tiny",
    name: "Tiny",
    architecture: "llama",
    fileSizeBytes: 1,
    tensorCount: 1,
    estimatedMemoryBytes: 1,
    contextTokens: 512,
    maximumContextTokens: 4096,
    maximumCpuThreads: 4,
};

const status: EmbeddedModelStatus = {
    loaded: true,
    modelId: "tiny",
    name: "Tiny",
    pathName: "tiny.gguf",
    contextTokens: 512,
    cpuThreads: 4,
    memoryEstimateBytes: 1,
};

beforeEach(() => {
    state.tauri = true;
    state.calls = [];
    state.openResult = null;
    state.handler = async () => undefined;
});

describe("embedded model selection and lifecycle", () => {
    it("reports runtime availability from the host", () => {
        state.tauri = false;
        expect(embeddedModelRuntimeAvailable()).toBe(false);
        state.tauri = true;
        expect(embeddedModelRuntimeAvailable()).toBe(true);
    });

    it("requires the desktop app to choose a model", async () => {
        state.tauri = false;
        await expect(selectAndInspectEmbeddedModel()).rejects.toThrow(/desktop app/u);
    });

    it("returns null when the picker is cancelled", async () => {
        state.openResult = null;
        await expect(selectAndInspectEmbeddedModel()).resolves.toBeNull();
        state.openResult = ["a.gguf", "b.gguf"];
        await expect(selectAndInspectEmbeddedModel()).resolves.toBeNull();
        expect(state.calls).toEqual([]);
    });

    it("authorizes the chosen model", async () => {
        state.openResult = "C:/models/tiny.gguf";
        state.handler = async () => modelInfo;
        await expect(selectAndInspectEmbeddedModel()).resolves.toEqual(modelInfo);
        expect(state.calls).toEqual([
            {
                command: "authorize_embedded_model",
                args: { path: "C:/models/tiny.gguf" },
            },
        ]);
    });

    it("loads, unloads, and reads the model status", async () => {
        state.handler = async () => status;
        await expect(loadEmbeddedModel("token", 512, 4)).resolves.toEqual(status);
        await expect(unloadEmbeddedModel()).resolves.toEqual(status);
        await expect(readEmbeddedModelStatus()).resolves.toEqual(status);
        expect(state.calls).toEqual([
            {
                command: "load_embedded_model",
                args: {
                    request: { authorizationToken: "token", contextTokens: 512, cpuThreads: 4 },
                },
            },
            { command: "unload_embedded_model", args: undefined },
            { command: "embedded_model_status", args: undefined },
        ]);
    });

    it("does not cancel when no generation is active", async () => {
        await expect(cancelEmbeddedAiGeneration()).resolves.toBe(false);
        expect(state.calls).toEqual([]);
    });
});

describe("embedded generation requests", () => {
    it("requires the desktop runtime", async () => {
        state.tauri = false;
        await expect(sendEmbeddedAiRequest(validRequest, () => undefined)).rejects.toThrow(
            /desktop app/u,
        );
    });

    it("rejects a request that is not a credential-free GGUF request", async () => {
        await expect(
            sendEmbeddedAiRequest({ ...validRequest, providerId: "openai" }, () => undefined),
        ).rejects.toThrow(/credential-free GGUF/u);
        await expect(
            sendEmbeddedAiRequest({ ...validRequest, credential: "secret" }, () => undefined),
        ).rejects.toThrow(/credential-free GGUF/u);
    });

    it("streams OpenAI-compatible deltas and completion", async () => {
        state.handler = async (command, args) => {
            if (command === "generate_embedded_text") {
                const channel = args!["onChunk"] as FakeChannel<{ text: string }>;
                channel.onmessage!({ text: "" });
                channel.onmessage!({ text: "Hello" });
                channel.onmessage!({ text: " world" });
                return undefined;
            }
            throw new Error(`unexpected ${command}`);
        };
        const chunks: Uint8Array[] = [];
        const result = await sendEmbeddedAiRequest(validRequest, (chunk) => chunks.push(chunk));

        expect(result).toEqual({
            status: 200,
            contentType: "text/event-stream",
            responseBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
            complete: true,
        });
        const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
        expect(text).toContain('data: {"choices":[{"delta":{"content":"Hello"}}]}');
        expect(text).toContain('data: {"choices":[{"delta":{"content":" world"}}]}');
        expect(text.endsWith("data: [DONE]\n\n")).toBe(true);

        const generate = state.calls.find((call) => call.command === "generate_embedded_text");
        expect(generate!.args!["request"]).toEqual({
            requestId: expect.any(String),
            modelId: "tiny",
            systemPrompt: "Be concise.",
            userContent: "Explain ratios.",
            maximumOutputTokens: 64,
        });
    });

    it("cancels an active generation", async () => {
        let cancelled: boolean | undefined;
        state.handler = async (command, args) => {
            if (command === "generate_embedded_text") {
                const channel = args!["onChunk"] as FakeChannel<{ text: string }>;
                channel.onmessage!({ text: "working" });
                cancelled = await cancelEmbeddedAiGeneration();
                return undefined;
            }
            if (command === "cancel_embedded_generation") return true;
            throw new Error(`unexpected ${command}`);
        };

        await sendEmbeddedAiRequest(validRequest, () => undefined);
        expect(cancelled).toBe(true);
        expect(state.calls.map((call) => call.command)).toContain("cancel_embedded_generation");
    });

    it("does not cancel outside the desktop runtime", async () => {
        let cancelled: boolean | undefined;
        state.handler = async (command, args) => {
            if (command === "generate_embedded_text") {
                state.tauri = false;
                cancelled = await cancelEmbeddedAiGeneration();
                state.tauri = true;
                const channel = args!["onChunk"] as FakeChannel<{ text: string }>;
                channel.onmessage!({ text: "working" });
                return undefined;
            }
            throw new Error(`unexpected ${command}`);
        };

        await sendEmbeddedAiRequest(validRequest, () => undefined);
        expect(cancelled).toBe(false);
    });

    it("clears only its own active request", async () => {
        let invocations = 0;
        state.handler = async (command, args) => {
            if (command !== "generate_embedded_text") throw new Error(`unexpected ${command}`);
            invocations += 1;
            const channel = args!["onChunk"] as FakeChannel<{ text: string }>;
            channel.onmessage!({ text: `call ${invocations}` });
            if (invocations === 1) {
                await sendEmbeddedAiRequest(validRequest, () => undefined);
            }
            return undefined;
        };

        const chunks: Uint8Array[] = [];
        await sendEmbeddedAiRequest(validRequest, (chunk) => chunks.push(chunk));
        expect(invocations).toBe(2);
        expect(chunks.length).toBeGreaterThan(0);
    });

    it("rejects malformed generation payloads", async () => {
        const bodies = [
            "{",
            "null",
            "[]",
            JSON.stringify({ messages: {} }),
            JSON.stringify({ messages: [] }),
            JSON.stringify({ model: 1, messages: [] }),
            JSON.stringify({ model: "m", messages: [{ role: "user", content: "u" }] }),
            JSON.stringify({ model: "m", messages: [{ role: "system", content: "s" }] }),
            JSON.stringify({
                model: "m",
                messages: [
                    { role: "system", content: 1 },
                    { role: "user", content: "u" },
                ],
                max_tokens: 1,
            }),
            JSON.stringify({
                model: "m",
                messages: [
                    { role: "system", content: "s" },
                    { role: "user", content: 1 },
                ],
                max_tokens: 1,
            }),
            JSON.stringify({
                model: "m",
                messages: [
                    { role: "system", content: "s" },
                    { role: "user", content: "u" },
                ],
                max_tokens: "1",
            }),
            JSON.stringify({
                model: "m",
                messages: [
                    { role: "system", content: "s" },
                    { role: "user", content: "u" },
                ],
                max_tokens: 1.5,
            }),
        ];
        for (const requestBody of bodies) {
            await expect(
                sendEmbeddedAiRequest({ ...validRequest, requestBody }, () => undefined),
            ).rejects.toThrow();
        }
        expect(state.calls).toEqual([]);
    });

    it("skips messages that are not prompt objects", async () => {
        const requestBody = JSON.stringify({
            model: "m",
            messages: [
                null,
                "x",
                { role: "assistant", content: "ignored" },
                { role: "system", content: "s" },
                { role: "user", content: "u" },
            ],
            max_tokens: 1,
        });
        await expect(
            sendEmbeddedAiRequest({ ...validRequest, requestBody }, () => undefined),
        ).resolves.toMatchObject({ status: 200 });
    });

    it("reports a decoded payload to the channel encoder", async () => {
        state.handler = async () => undefined;
        const chunks: Uint8Array[] = [];
        await sendEmbeddedAiRequest(validRequest, (chunk) => chunks.push(chunk));
        expect(chunks).toEqual([encoder.encode("data: [DONE]\n\n")]);
    });
});
