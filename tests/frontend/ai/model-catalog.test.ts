import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CatalogModule = typeof import("../../../frontend/ai/model-catalog");

const encoder = new TextEncoder();
const CATALOG_URL = "https://models.dev/api.json";

let module: CatalogModule;

beforeEach(async () => {
    vi.resetModules();
    module = await import("../../../frontend/ai/model-catalog");
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function catalogBody(models: Record<string, unknown>, name = "OpenAI"): string {
    return JSON.stringify({ openai: { name, models } });
}

function jsonResponse(
    body: string,
    init: { status?: number; headers?: Record<string, string> } = {},
): Response {
    return new Response(body, {
        status: init.status ?? 200,
        headers: { "content-type": "application/json", ...init.headers },
    });
}

function stubFetch(response: Response | (() => Promise<Response>)) {
    const mock = vi.fn(typeof response === "function" ? response : () => Promise.resolve(response));
    vi.stubGlobal("fetch", mock);
    return mock;
}

function abortingFetch(): ReturnType<typeof vi.fn> {
    const mock = vi.fn(
        (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () =>
                    reject(new DOMException("aborted", "AbortError")),
                );
            }),
    );
    vi.stubGlobal("fetch", mock);
    return mock;
}

describe("hasAiModelCatalog", () => {
    it("only reports providers listed by models.dev", () => {
        expect(module.hasAiModelCatalog("openai")).toBe(true);
        expect(module.hasAiModelCatalog("opencode-zen")).toBe(true);
        expect(module.hasAiModelCatalog("ollama")).toBe(false);
        expect(module.hasAiModelCatalog("openai-compatible")).toBe(false);
        expect(module.hasAiModelCatalog("unknown-provider")).toBe(false);
    });
});

describe("loadAiModelCatalog", () => {
    it("loads, parses, and sorts public model metadata", async () => {
        const fetchMock = stubFetch(
            jsonResponse(
                catalogBody({
                    "b-model": {
                        id: "b-model",
                        status: "beta",
                        limit: { context: "200000", output: 4096 },
                        modalities: { input: ["Text", "IMAGE", "text"], output: "text" },
                        tool_call: true,
                        tokenizer: " cl100k ",
                        cost: { input: "2", output: 8 },
                    },
                    "a-model": {
                        id: "a-model",
                        limit: { context: -1, output: 10_000_001 },
                        tool_call: "yes",
                        cost: { input: -1, output: 1_000_001 },
                    },
                    "c-model": { name: "ignored" },
                }),
            ),
        );

        const result = await module.loadAiModelCatalog("openai");

        expect(fetchMock).toHaveBeenCalledWith(
            CATALOG_URL,
            expect.objectContaining({
                method: "GET",
                credentials: "omit",
                cache: "no-store",
                redirect: "error",
                referrerPolicy: "no-referrer",
            }),
        );
        expect(result.freshness).toBe("fresh");
        expect(result.models.map((model) => model.id)).toEqual(["a-model", "b-model", "c-model"]);
        expect(result.models.find((model) => model.id === "b-model")).toEqual({
            id: "b-model",
            owner: "OpenAI",
            status: "beta",
            contextWindow: 200_000,
            maximumOutputTokens: 4096,
            inputModalities: ["text", "image"],
            outputModalities: [],
            toolSupport: true,
            tokenizer: "cl100k",
            inputCost: 2,
            outputCost: 8,
            metadataSource: "models.dev",
        });
        expect(result.models[0]).toMatchObject({
            contextWindow: null,
            maximumOutputTokens: null,
            toolSupport: null,
            tokenizer: null,
            inputCost: null,
            outputCost: null,
            status: "unknown",
        });
    });

    it("skips malformed and duplicate model entries", async () => {
        stubFetch(
            jsonResponse(
                JSON.stringify({
                    openai: {
                        name: "x".repeat(257),
                        models: {
                            "not-an-object": "x",
                            "": {},
                            first: { id: "same" },
                            second: { id: "same" },
                            third: {
                                id: "  ok  ",
                                status: "s".repeat(65),
                                limit: { context: "abc", output: 1.5 },
                                modalities: {
                                    input: ["Text", 5, "bad\0value", "y".repeat(49), "text"],
                                    output: new Array<string>(33).fill("text"),
                                },
                                tool_call: "true",
                                tokenizer: "",
                                cost: { input: "free", output: null },
                            },
                        },
                    },
                }),
            ),
        );

        const result = await module.loadAiModelCatalog("openai");

        expect(result.models.map((model) => model.id)).toEqual(["ok", "same"]);
        expect(result.models[0]).toMatchObject({
            owner: "openai",
            status: "unknown",
            contextWindow: null,
            maximumOutputTokens: null,
            inputModalities: ["text"],
            outputModalities: [],
            toolSupport: null,
            tokenizer: null,
            inputCost: null,
            outputCost: null,
        });
    });

    it("serves a fresh cached catalog without another request", async () => {
        const fetchMock = stubFetch(jsonResponse(catalogBody({ m: { id: "m" } })));

        const first = await module.loadAiModelCatalog("openai");
        const second = await module.loadAiModelCatalog("openai");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(second.models).toEqual(first.models);
        expect(second.freshness).toBe("fresh");
    });

    it("bypasses the cache when a refresh is requested and evicts old providers", async () => {
        const bodies: Record<string, string> = {
            openai: JSON.stringify({ openai: { name: "OpenAI", models: { m: { id: "m" } } } }),
            anthropic: JSON.stringify({
                anthropic: { name: "Anthropic", models: { m: { id: "m" } } },
            }),
            cohere: JSON.stringify({ cohere: { name: "Cohere", models: { m: { id: "m" } } } }),
        };
        const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(bodies["openai"]!)));
        vi.stubGlobal("fetch", fetchMock);

        await module.loadAiModelCatalog("openai");
        await module.loadAiModelCatalog("openai", { refresh: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(bodies["anthropic"]!)));
        await module.loadAiModelCatalog("anthropic");
        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(bodies["cohere"]!)));
        await module.loadAiModelCatalog("cohere");
        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(bodies["openai"]!)));
        await module.loadAiModelCatalog("openai");
        expect(fetchMock).toHaveBeenCalledTimes(5);

        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(bodies["anthropic"]!)));
        await module.loadAiModelCatalog("anthropic");
        expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it("rejects providers without a public catalog", async () => {
        await expect(module.loadAiModelCatalog("unknown-provider")).rejects.toThrow(
            "This provider does not have a public models.dev catalog.",
        );
        await expect(module.loadAiModelCatalog("ollama")).rejects.toThrow(
            "This provider does not have a public models.dev catalog.",
        );
        await expect(module.loadAiModelCatalog("openai-compatible")).rejects.toThrow(
            "This provider does not have a public models.dev catalog.",
        );
    });

    it("rejects HTTP, content-type, and content-length failures", async () => {
        stubFetch(jsonResponse("{}", { status: 500 }));
        await expect(module.loadAiModelCatalog("openai")).rejects.toThrow(
            "The public model catalog returned HTTP 500.",
        );

        stubFetch(new Response("{}", { headers: { "content-type": "text/plain" } }));
        await expect(module.loadAiModelCatalog("openai")).rejects.toThrow(
            "The public model catalog returned an unexpected content type.",
        );

        stubFetch(new Response(null));
        await expect(module.loadAiModelCatalog("openai")).rejects.toThrow(
            "The public model catalog returned an unexpected content type.",
        );

        for (const contentLength of ["not-a-number", "-1", String(32 * 1024 * 1024 + 1)]) {
            stubFetch(
                new Response("{}", {
                    headers: {
                        "content-type": "application/json",
                        "content-length": contentLength,
                    },
                }),
            );
            await expect(module.loadAiModelCatalog("openai")).rejects.toThrow(
                "The public model catalog exceeded the 32 MiB response limit.",
            );
        }
    });

    it("accepts JSON API content types and a valid content-length", async () => {
        stubFetch(
            new Response(catalogBody({ m: { id: "m" } }), {
                headers: {
                    "content-type": "application/vnd.api+json; charset=utf-8",
                    "content-length": "100",
                },
            }),
        );
        await expect(module.loadAiModelCatalog("openai")).resolves.toMatchObject({
            freshness: "fresh",
        });
    });

    it("rejects responses without a readable body", async () => {
        stubFetch(
            new Response(null, { status: 200, headers: { "content-type": "application/json" } }),
        );
        await expect(module.loadAiModelCatalog("openai")).rejects.toThrow(
            "This desktop webview cannot safely stream the public model catalog.",
        );
    });

    it("assembles chunked responses and rejects oversized streams", async () => {
        const chunks = [encoder.encode('{"openai":{"name":"O","models":{'), encoder.encode("}}}")];
        stubFetch(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        for (const chunk of chunks) controller.enqueue(chunk);
                        controller.close();
                    },
                }),
                { headers: { "content-type": "application/json" } },
            ),
        );
        await expect(module.loadAiModelCatalog("openai")).resolves.toMatchObject({
            models: [],
        });
    });

    it("cancels an oversized response stream", async () => {
        const cancel = vi.fn();
        const oversized = new Uint8Array(32 * 1024 * 1024 + 1);
        stubFetch(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(oversized);
                    },
                    cancel,
                }),
                { headers: { "content-type": "application/json" } },
            ),
        );
        await expect(module.loadAiModelCatalog("openai")).rejects.toThrow(
            "The public model catalog exceeded the 32 MiB response limit.",
        );
        expect(cancel).toHaveBeenCalled();
    });

    it("rejects invalid UTF-8 and invalid catalog shapes", async () => {
        stubFetch(
            new Response(new Uint8Array([0xff, 0xfe]), {
                headers: { "content-type": "application/json" },
            }),
        );
        await expect(module.loadAiModelCatalog("openai")).rejects.toThrow(
            "The public model catalog was not valid UTF-8.",
        );

        for (const body of ["not json", "[]", "{}", '{"openai":5}', '{"openai":{"models":[]}}']) {
            stubFetch(jsonResponse(body));
            await expect(module.loadAiModelCatalog("openai")).rejects.toThrow();
        }
    });

    it("rejects a catalog that exceeds the model safety limit", async () => {
        const models = Object.fromEntries(
            Array.from({ length: 50_001 }, (_, index) => [`m${index}`, { id: `m${index}` }]),
        );
        stubFetch(jsonResponse(JSON.stringify({ openai: { name: "OpenAI", models } })));
        await expect(module.loadAiModelCatalog("openai")).rejects.toThrow(
            "The provider model catalog exceeded the 50,000 model safety limit.",
        );
    });

    it("returns a stale cached catalog when a refresh fails", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        stubFetch(jsonResponse(catalogBody({ m: { id: "m" } })));
        const first = await module.loadAiModelCatalog("openai");

        vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.reject(new Error("offline"))),
        );
        const fallback = await module.loadAiModelCatalog("openai");

        expect(fallback.freshness).toBe("stale-cache-fallback");
        expect(fallback.models).toEqual(first.models);
    });

    it("reports a timeout when the catalog request never settles", async () => {
        vi.useFakeTimers();
        abortingFetch();
        const pending = module.loadAiModelCatalog("openai");
        const assertion = expect(pending).rejects.toThrow(
            "The public model catalog timed out. Try again when you are online.",
        );
        await vi.advanceTimersByTimeAsync(30_000);
        await assertion;
    });

    it("throws AbortError when the caller cancels the request", async () => {
        abortingFetch();
        const controller = new AbortController();
        const pending = module.loadAiModelCatalog("openai", { signal: controller.signal });
        const assertion = expect(pending).rejects.toThrow("Catalog loading was canceled.");
        controller.abort();
        await assertion;
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });

    it("honours an already-aborted signal before requesting", async () => {
        const fetchMock = stubFetch(jsonResponse("{}"));
        const controller = new AbortController();
        controller.abort();
        await expect(
            module.loadAiModelCatalog("openai", { signal: controller.signal }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("removes abort listeners after a successful load", async () => {
        stubFetch(jsonResponse(catalogBody({ m: { id: "m" } })));
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        await module.loadAiModelCatalog("openai", { signal: controller.signal });
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("wraps non-Error failures with a connection message", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.reject("boom")),
        );
        await expect(module.loadAiModelCatalog("openai")).rejects.toThrow(
            "The public model catalog could not be loaded. Check your connection and try again.",
        );
    });

    it("aborts when a caller signal reports aborted without throwing", async () => {
        const fetchMock = stubFetch(jsonResponse(catalogBody({ m: { id: "m" } })));
        const signal = {
            aborted: true,
            reason: undefined,
            throwIfAborted() {},
            addEventListener() {},
            removeEventListener() {},
        } as unknown as AbortSignal;

        await expect(module.loadAiModelCatalog("openai", { signal })).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
