import { afterEach, describe, expect, it, vi } from "vitest";
import { listOllamaInstalledModels, testAiProviderConnection } from "../../../frontend/ai/ollama";

const OLLAMA_ENDPOINT = "http://127.0.0.1:11434";

function jsonResponse(
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json", ...init.headers },
    });
}

function stubFetch(response: Response | (() => Promise<Response>)) {
    const handler = typeof response === "function" ? response : () => Promise.resolve(response);
    const mock = vi.fn<typeof fetch>(handler);
    vi.stubGlobal("fetch", mock);
    return mock;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("listOllamaInstalledModels", () => {
    it("lists and sorts installed models while normalizing the endpoint", async () => {
        const fetchMock = stubFetch(
            jsonResponse({
                models: [
                    {
                        name: "zeta:7b",
                        size: 4_000,
                        details: {
                            family: "llama",
                            parameter_size: "7B",
                            quantization_level: "Q4_K_M",
                        },
                    },
                    {
                        model: "alpha:3b",
                        size: 1.5,
                        details: { family: "phi" },
                    },
                    { name: "  beta:1b  ", size: Number.MAX_SAFE_INTEGER },
                    { name: "   " },
                    { name: "bad\0name" },
                    "not-an-object",
                    { name: 42 },
                ],
            }),
        );

        const models = await listOllamaInstalledModels(`${OLLAMA_ENDPOINT}/v1/`);

        expect(fetchMock).toHaveBeenCalledWith(
            `${OLLAMA_ENDPOINT}/api/tags`,
            expect.objectContaining({
                method: "GET",
                credentials: "omit",
                cache: "no-store",
                redirect: "error",
                referrerPolicy: "no-referrer",
            }),
        );
        expect(models).toEqual([
            {
                name: "alpha:3b",
                sizeBytes: null,
                family: "phi",
                parameterSize: "",
                quantization: "",
            },
            {
                name: "beta:1b",
                sizeBytes: Number.MAX_SAFE_INTEGER,
                family: "",
                parameterSize: "",
                quantization: "",
            },
            {
                name: "zeta:7b",
                sizeBytes: 4_000,
                family: "llama",
                parameterSize: "7B",
                quantization: "Q4_K_M",
            },
        ]);
    });

    it("forwards a caller-supplied abort signal", async () => {
        const fetchMock = stubFetch(jsonResponse({ models: [] }));
        const controller = new AbortController();
        await listOllamaInstalledModels(OLLAMA_ENDPOINT, controller.signal);
        const init = fetchMock.mock.calls[0]?.[1];
        expect(init?.signal).toBe(controller.signal);
    });

    it("uses a timeout signal by default", async () => {
        const fetchMock = stubFetch(jsonResponse({ models: [] }));
        await listOllamaInstalledModels(OLLAMA_ENDPOINT);
        const init = fetchMock.mock.calls[0]?.[1];
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("rejects an invalid endpoint and a failed HTTP response", async () => {
        await expect(listOllamaInstalledModels("https://example.com")).rejects.toThrow();

        stubFetch(jsonResponse({}, { status: 503 }));
        await expect(listOllamaInstalledModels(OLLAMA_ENDPOINT)).rejects.toThrow(
            "Ollama returned HTTP 503 for its model list.",
        );
    });

    it("rejects declared and actual oversized model lists", async () => {
        stubFetch(
            jsonResponse(
                { models: [] },
                { headers: { "content-length": String(5 * 1024 * 1024) } },
            ),
        );
        await expect(listOllamaInstalledModels(OLLAMA_ENDPOINT)).rejects.toThrow(
            "Ollama returned an oversized model list.",
        );

        stubFetch(new Response("x".repeat(4 * 1024 * 1024 + 1)));
        await expect(listOllamaInstalledModels(OLLAMA_ENDPOINT)).rejects.toThrow(
            "Ollama returned an oversized model list.",
        );
    });

    it("ignores an unparseable content-length header", async () => {
        stubFetch(jsonResponse({ models: [] }, { headers: { "content-length": "not-a-number" } }));
        await expect(listOllamaInstalledModels(OLLAMA_ENDPOINT)).resolves.toEqual([]);
    });

    it("rejects invalid JSON and invalid shapes", async () => {
        stubFetch(jsonResponse("{not json"));
        await expect(listOllamaInstalledModels(OLLAMA_ENDPOINT)).rejects.toThrow(
            "Ollama returned an invalid model list.",
        );

        stubFetch(jsonResponse([]));
        await expect(listOllamaInstalledModels(OLLAMA_ENDPOINT)).rejects.toThrow(
            "Ollama returned an invalid model list.",
        );

        stubFetch(jsonResponse({ models: {} }));
        await expect(listOllamaInstalledModels(OLLAMA_ENDPOINT)).rejects.toThrow(
            "Ollama returned an invalid model list.",
        );
    });

    it("rejects a model list with too many entries", async () => {
        const models = Array.from({ length: 10_001 }, (_, index) => ({ name: `m${index}` }));
        stubFetch(jsonResponse({ models }));
        await expect(listOllamaInstalledModels(OLLAMA_ENDPOINT)).rejects.toThrow(
            "Ollama returned too many installed models.",
        );
    });
});

describe("testAiProviderConnection", () => {
    it("rejects unsupported provider ids", async () => {
        await expect(testAiProviderConnection("nope", OLLAMA_ENDPOINT)).rejects.toThrow(
            "Choose a supported AI provider.",
        );
    });

    it("short-circuits providers that never use a remote connection", async () => {
        await expect(testAiProviderConnection("embedded-gguf", "")).resolves.toEqual({
            status: "local-runtime",
            detail: "Embedded GGUF inference runs inside the desktop app; no provider connection is needed.",
            modelCount: null,
        });
        await expect(
            testAiProviderConnection("replicate", "https://api.replicate.com/v1"),
        ).resolves.toEqual({
            status: "not-tested",
            detail: "Replicate predictions need a saved token; this check does not send credentials.",
            modelCount: null,
        });
    });

    it("reports Ollama reachability with its installed model count", async () => {
        const fetchMock = stubFetch(jsonResponse({ models: [{ name: "a" }, { name: "b" }] }));
        await expect(testAiProviderConnection("ollama", OLLAMA_ENDPOINT)).resolves.toEqual({
            status: "connected",
            detail: "Ollama is reachable with 2 installed model(s).",
            modelCount: 2,
        });
        expect(fetchMock).toHaveBeenCalledWith(`${OLLAMA_ENDPOINT}/api/tags`, expect.anything());
    });

    it("queries the provider-specific model-list path", async () => {
        const cases = [
            ["anthropic", "https://api.anthropic.com", "/v1/models"],
            ["cohere", "https://api.cohere.com", "/v1/models"],
            ["google-gemini", "https://generativelanguage.googleapis.com/v1beta", "/models"],
            ["openai", "https://api.openai.com/v1", "/models"],
        ] as const;
        for (const [providerId, endpoint, path] of cases) {
            const fetchMock = stubFetch(jsonResponse({ data: [{ id: "m" }] }));
            await expect(testAiProviderConnection(providerId, endpoint)).resolves.toMatchObject({
                status: "connected",
                modelCount: 1,
            });
            expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}${path}`);
        }
    });

    it("reports a reachable endpoint that lists models in either format", async () => {
        stubFetch(jsonResponse({ models: [{}, {}, {}] }));
        await expect(
            testAiProviderConnection("openai", "https://api.openai.com/v1"),
        ).resolves.toMatchObject({
            status: "connected",
            detail: "Provider endpoint is reachable with 3 listed model(s).",
            modelCount: 3,
        });
    });

    it("reports reachability when the model list is unavailable or unreadable", async () => {
        stubFetch(jsonResponse({ ok: true }));
        await expect(
            testAiProviderConnection("openai", "https://api.openai.com/v1"),
        ).resolves.toMatchObject({
            status: "connected",
            detail: "Provider endpoint is reachable.",
            modelCount: null,
        });

        stubFetch(jsonResponse("{broken"));
        await expect(
            testAiProviderConnection("openai", "https://api.openai.com/v1"),
        ).resolves.toMatchObject({ status: "connected", modelCount: null });

        stubFetch(jsonResponse([1, 2]));
        await expect(
            testAiProviderConnection("openai", "https://api.openai.com/v1"),
        ).resolves.toMatchObject({ status: "connected", modelCount: null });
    });

    it("classifies authentication, missing-list, and other HTTP failures", async () => {
        for (const status of [401, 403]) {
            stubFetch(jsonResponse({}, { status }));
            await expect(
                testAiProviderConnection("openai", "https://api.openai.com/v1"),
            ).resolves.toMatchObject({
                status: "authentication-required",
                modelCount: null,
            });
        }

        stubFetch(jsonResponse({}, { status: 404 }));
        await expect(
            testAiProviderConnection("openai", "https://api.openai.com/v1"),
        ).resolves.toMatchObject({
            status: "reachable",
            modelCount: null,
        });

        stubFetch(jsonResponse({}, { status: 500 }));
        await expect(
            testAiProviderConnection("openai", "https://api.openai.com/v1"),
        ).rejects.toThrow("Provider connection check returned HTTP 500.");
    });
});
