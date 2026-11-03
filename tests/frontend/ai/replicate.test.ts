import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiTransportRequest } from "../../../frontend/platform/types";
import {
    REPLICATE_API_ROOT,
    assertReviewedReplicateRequest,
    cancelBrowserReplicatePrediction,
    cancelReplicatePrediction,
    inspectReplicateModel,
    registerReplicateCancellationHandler,
    replicateModelMetadataEndpoint,
    replicatePredictionEndpoint,
    sendReplicateAiRequest,
} from "../../../frontend/ai/replicate";

const PREDICTIONS = `${REPLICATE_API_ROOT}/predictions`;

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function request(
    overrides: Partial<AiTransportRequest> = {},
    input: Record<string, unknown> = { prompt: "hello" },
    version = "version-1",
): AiTransportRequest {
    const body = JSON.stringify({ version, input });
    return {
        providerId: "replicate",
        endpoint: PREDICTIONS,
        confirmedEndpoint: PREDICTIONS,
        model: "owner/model",
        accept: "application/json",
        requestBody: body,
        requestBodyHash: sha256(body),
        confirmedBodyHash: sha256(body),
        credentialStorage: "encrypted-archive",
        credential: "replicate-token",
        ...overrides,
    };
}

function prediction(id: string, status: string): Response {
    return new Response(JSON.stringify({ id, status }), {
        headers: { "content-type": "application/json" },
    });
}

type FetchStep = Response | ((init: RequestInit) => Promise<Response>);

function stubFetch(steps: FetchStep[]) {
    const calls: Array<[string, RequestInit]> = [];
    const mock = vi.fn((url: string, init: RequestInit) => {
        calls.push([String(url), init]);
        const step = steps.shift();
        if (!step) throw new Error(`Unexpected fetch ${String(url)}`);
        return typeof step === "function" ? step(init) : Promise.resolve(step);
    });
    vi.stubGlobal("fetch", mock);
    return calls;
}

function withTimers() {
    vi.useFakeTimers();
}

beforeEach(() => {
    vi.stubGlobal("window", {
        setTimeout: (callback: () => void, delay?: number) => setTimeout(callback, delay),
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    });
    vi.stubGlobal("crypto", {
        subtle: {
            digest: (_algorithm: string, data: ArrayBuffer) =>
                Promise.resolve(
                    new Uint8Array(createHash("sha256").update(new Uint8Array(data)).digest()),
                ),
        },
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("model endpoints", () => {
    it("builds prediction and metadata endpoints", () => {
        expect(replicatePredictionEndpoint("owner/model")).toBe(PREDICTIONS);
        expect(replicateModelMetadataEndpoint("owner/model")).toBe(
            `${REPLICATE_API_ROOT}/models/owner/model`,
        );
    });

    it("rejects malformed model ids", () => {
        for (const model of [
            "owner",
            "owner/",
            "/model",
            "owner/model/extra",
            "../model",
            "./model",
            "owner/.",
            "owner/..",
            "own er/model",
            `${"a".repeat(129)}/model`,
        ]) {
            expect(() => replicateModelMetadataEndpoint(model)).toThrow(
                "Replicate models must use the owner/model form from the public catalog.",
            );
        }
    });
});

describe("assertReviewedReplicateRequest", () => {
    it("accepts a minimal reviewed request", async () => {
        await expect(assertReviewedReplicateRequest(request())).resolves.toBeUndefined();
        await expect(
            assertReviewedReplicateRequest(
                request({}, { prompt: "hello", system_prompt: "", max_tokens: 1 }),
            ),
        ).resolves.toBeUndefined();
    });

    it("rejects transport fields that changed after review", async () => {
        const cases: Array<Partial<AiTransportRequest>> = [
            { providerId: "openai" },
            { confirmedEndpoint: "https://example.com/predictions" },
            {
                endpoint: "https://example.com/predictions",
                confirmedEndpoint: "https://example.com/predictions",
            },
            { accept: "text/event-stream" },
        ];
        for (const overrides of cases) {
            await expect(assertReviewedReplicateRequest(request(overrides))).rejects.toThrow(
                "The Replicate request changed after review. Prepare it again.",
            );
        }
    });

    it("rejects empty and oversized request bodies", async () => {
        await expect(assertReviewedReplicateRequest(request({ requestBody: "" }))).rejects.toThrow(
            "The reviewed Replicate request is empty or exceeds the 8 MiB limit.",
        );
        await expect(
            assertReviewedReplicateRequest(
                request({ requestBody: "x".repeat(8 * 1024 * 1024 + 1) }),
            ),
        ).rejects.toThrow("The reviewed Replicate request is empty or exceeds the 8 MiB limit.");
    });

    it("rejects invalid or mismatched request hashes", async () => {
        await expect(
            assertReviewedReplicateRequest(request({ requestBodyHash: "not-a-hash" })),
        ).rejects.toThrow("The Replicate request hash changed after review.");
        await expect(
            assertReviewedReplicateRequest(request({ confirmedBodyHash: "0".repeat(64) })),
        ).rejects.toThrow("The Replicate request hash changed after review.");

        const mismatch = request();
        await expect(
            assertReviewedReplicateRequest({
                ...mismatch,
                requestBodyHash: "a".repeat(64),
                confirmedBodyHash: "a".repeat(64),
            }),
        ).rejects.toThrow("The Replicate request body changed after review.");
    });

    it("rejects invalid JSON and unsupported request shapes", async () => {
        const body = "not json";
        await expect(
            assertReviewedReplicateRequest(
                request({
                    requestBody: body,
                    requestBodyHash: sha256(body),
                    confirmedBodyHash: sha256(body),
                }),
            ),
        ).rejects.toThrow("The reviewed Replicate request is not valid JSON.");

        const shapes = [
            { version: "v", input: 5 },
            { version: "v", input: {}, extra: 1 },
            { input: {} },
            { version: 5, input: {} },
            { version: "   ", input: {} },
            { version: "v".repeat(257), input: {} },
            { version: "v\u0001", input: {} },
        ];
        for (const value of shapes) {
            const requestBody = JSON.stringify(value);
            await expect(
                assertReviewedReplicateRequest(
                    request({
                        requestBody,
                        requestBodyHash: sha256(requestBody),
                        confirmedBodyHash: sha256(requestBody),
                    }),
                ),
            ).rejects.toThrow("The reviewed Replicate request has an unsupported input shape.");
        }

        const arrayBody = JSON.stringify([1, 2]);
        await expect(
            assertReviewedReplicateRequest(
                request({
                    requestBody: arrayBody,
                    requestBodyHash: sha256(arrayBody),
                    confirmedBodyHash: sha256(arrayBody),
                }),
            ),
        ).rejects.toThrow("The reviewed Replicate request has an unsupported input shape.");
    });

    it("rejects unsupported or ambiguous model inputs", async () => {
        await expect(
            assertReviewedReplicateRequest(request({}, { prompt: "hi", seed: 1 })),
        ).rejects.toThrow("The reviewed Replicate request includes an unsupported model input.");

        for (const input of [
            { prompt: "hi", max_tokens: 10, max_new_tokens: 10 },
            { prompt: "hi", max_tokens: 0 },
            { prompt: "hi", max_tokens: 1.5 },
            { prompt: "hi", max_tokens: 1_000_001 },
            { prompt: "hi", max_new_tokens: "10" },
        ]) {
            await expect(assertReviewedReplicateRequest(request({}, input))).rejects.toThrow(
                "The reviewed Replicate output-token input is invalid.",
            );
        }
    });

    it("rejects invalid prompts and system prompts", async () => {
        for (const input of [{}, { prompt: 5 }, { prompt: "   " }]) {
            await expect(assertReviewedReplicateRequest(request({}, input))).rejects.toThrow(
                "The reviewed Replicate prompt is empty or exceeds the 8 MiB limit.",
            );
        }
        for (const input of [
            { prompt: "hi", system_prompt: 5 },
            { prompt: "hi", system_prompt: null },
        ]) {
            await expect(assertReviewedReplicateRequest(request({}, input))).rejects.toThrow(
                "The reviewed Replicate system prompt is invalid or exceeds the 8 MiB limit.",
            );
        }
    });
});

describe("sendReplicateAiRequest", () => {
    it("returns a prediction that already finished, forwarding body chunks", async () => {
        const calls = stubFetch([prediction("pred-1", "succeeded")]);
        const chunks: Uint8Array[] = [];

        const result = await sendReplicateAiRequest(request(), (chunk) => chunks.push(chunk));

        expect(result).toMatchObject({
            status: 200,
            contentType: "application/json",
            complete: true,
            cancelled: false,
        });
        expect(result.errorMessage).toBeUndefined();
        expect(result.responseBytes).toBeGreaterThan(0);
        expect(chunks).toHaveLength(1);
        const init = calls[0]?.[1];
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(request().requestBody);
        expect((init?.headers as Record<string, string>)["Prefer"]).toBe("wait=60");
        expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
        expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
            "Bearer replicate-token",
        );
    });

    it("reports failed and canceled creation responses", async () => {
        stubFetch([prediction("pred-1", "failed")]);
        await expect(sendReplicateAiRequest(request(), () => undefined)).resolves.toMatchObject({
            cancelled: false,
        });

        stubFetch([prediction("pred-1", "canceled")]);
        await expect(sendReplicateAiRequest(request(), () => undefined)).resolves.toMatchObject({
            cancelled: true,
        });
    });

    it("polls until the prediction succeeds", async () => {
        withTimers();
        const calls = stubFetch([
            prediction("pred-1", "starting"),
            prediction("pred-1", "starting"),
            prediction("pred-1", "succeeded"),
        ]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result).toMatchObject({ status: 200, cancelled: false, complete: true });
        expect(calls.map(([url]) => url)).toEqual([
            PREDICTIONS,
            `${PREDICTIONS}/pred-1`,
            `${PREDICTIONS}/pred-1`,
        ]);
        expect(calls[1]?.[1].method).toBe("GET");
        expect(calls[1]?.[1].body).toBeUndefined();
        expect((calls[1]?.[1].headers as Record<string, string>)["Prefer"]).toBeUndefined();
    });

    it("reports failed and canceled poll statuses", async () => {
        withTimers();
        stubFetch([prediction("pred-1", "starting"), prediction("pred-1", "failed")]);
        const failed = sendReplicateAiRequest(request(), () => undefined);
        await vi.runAllTimersAsync();
        await expect(failed).resolves.toMatchObject({ cancelled: false });

        stubFetch([prediction("pred-1", "starting"), prediction("pred-1", "cancelled")]);
        const cancelled = sendReplicateAiRequest(request(), () => undefined);
        await vi.runAllTimersAsync();
        await expect(cancelled).resolves.toMatchObject({ cancelled: true });
    });

    it("stops polling when the response is not successful or incomplete", async () => {
        withTimers();
        stubFetch([prediction("pred-1", "starting"), new Response("nope", { status: 500 })]);
        const failed = sendReplicateAiRequest(request(), () => undefined);
        await vi.runAllTimersAsync();
        await expect(failed).resolves.toMatchObject({ status: 500, cancelled: false });
    });

    it("surfaces invalid prediction payloads", async () => {
        stubFetch([new Response("not json")]);
        await expect(sendReplicateAiRequest(request(), () => undefined)).resolves.toMatchObject({
            errorMessage: "Replicate returned an invalid prediction response.",
            status: 200,
        });

        stubFetch([new Response(JSON.stringify({ id: "", status: "starting" }))]);
        await expect(sendReplicateAiRequest(request(), () => undefined)).resolves.toMatchObject({
            errorMessage: "Replicate returned an invalid prediction response.",
        });
    });

    it("rejects a prediction payload that does not match the polled id", async () => {
        withTimers();
        stubFetch([prediction("pred-1", "starting"), prediction("pred-2", "succeeded")]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({
            errorMessage: "Replicate returned a prediction that did not match this request.",
        });
    });

    it("cancels once the prediction id is known", async () => {
        withTimers();
        const calls = stubFetch([
            prediction("pred-1", "starting"),
            prediction("pred-1", "canceled"),
        ]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        const cancelAt = () => void cancelBrowserReplicatePrediction();
        setTimeout(cancelAt, 100);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toMatchObject({ cancelled: true });
        expect(calls.map(([url]) => url)).toEqual([PREDICTIONS, `${PREDICTIONS}/pred-1/cancel`]);
        expect(calls[1]?.[1].method).toBe("POST");
        expect(calls[1]?.[1].body).toBe("{}");
    });

    it("cancels when cancellation lands after a poll body has been read", async () => {
        withTimers();
        const pendingPoll = (init: RequestInit) => {
            void init;
            const bytes = new TextEncoder().encode(
                JSON.stringify({ id: "pred-1", status: "starting" }),
            );
            let reads = 0;
            const stream = new ReadableStream<Uint8Array>({
                pull(controller) {
                    reads += 1;
                    if (reads === 1) {
                        controller.enqueue(bytes);
                        return;
                    }
                    queueMicrotask(() => void cancelBrowserReplicatePrediction());
                    controller.close();
                },
            });
            return Promise.resolve(
                new Response(stream, { headers: { "content-type": "application/json" } }),
            );
        };
        const calls = stubFetch([
            prediction("pred-1", "starting"),
            pendingPoll,
            new Response(null, { status: 200 }),
        ]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toMatchObject({
            status: 200,
            cancelled: true,
            complete: true,
        });
        expect(calls.at(-1)?.[0]).toBe(`${PREDICTIONS}/pred-1/cancel`);
    });

    it("cancels a prediction that completes creating after cancellation", async () => {
        withTimers();
        stubFetch([
            () =>
                new Promise<Response>((resolve) => {
                    setTimeout(() => resolve(prediction("pred-1", "starting")), 2_000);
                }),
            prediction("pred-1", "canceled"),
        ]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        setTimeout(() => void cancelBrowserReplicatePrediction(), 1_000);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toMatchObject({ cancelled: true });
    });

    it("times out a request that never settles", async () => {
        withTimers();
        stubFetch([
            (init) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError")),
                    );
                }),
        ]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toMatchObject({
            status: 0,
            errorMessage: "Replicate request timed out.",
        });
    });

    it("aborts an in-flight poll when canceled", async () => {
        withTimers();
        const calls = stubFetch([
            prediction("pred-1", "starting"),
            (init) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError")),
                    );
                }),
            prediction("pred-1", "canceled"),
        ]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        setTimeout(() => void cancelBrowserReplicatePrediction(), 550);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toMatchObject({ cancelled: true });
        expect(calls.at(-1)?.[0]).toBe(`${PREDICTIONS}/pred-1/cancel`);
    });

    it("keeps polling when cancellation is not confirmed", async () => {
        withTimers();
        stubFetch([prediction("pred-1", "starting"), new Response("{}", { status: 500 })]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        setTimeout(() => void cancelBrowserReplicatePrediction(), 100);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toMatchObject({
            status: 500,
            cancelled: false,
            errorMessage:
                "Replicate did not confirm prediction cancellation. The latest response was saved for review.",
        });
    });

    it("reuses the latest bytes when a confirmed cancellation has no body", async () => {
        withTimers();
        stubFetch([prediction("pred-1", "starting"), new Response(null, { status: 200 })]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        setTimeout(() => void cancelBrowserReplicatePrediction(), 100);
        await vi.runAllTimersAsync();

        const result = await pending;
        expect(result).toMatchObject({ status: 200, cancelled: true, complete: true });
        expect(result.responseBytes).toBeGreaterThan(0);
        expect(result.contentType).toBe("application/json");
    });

    it("reports a transport error from the cancellation request", async () => {
        withTimers();
        stubFetch([
            prediction("pred-1", "starting"),
            () => Promise.reject(new TypeError("offline")),
        ]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        setTimeout(() => void cancelBrowserReplicatePrediction(), 100);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toMatchObject({
            cancelled: false,
            errorMessage:
                "The Replicate request could not be completed. Check the connection and browser CORS settings, or use Tutorux for desktop.",
        });
    });

    it("reports unconfirmed cancellation after a poll transport failure", async () => {
        withTimers();
        stubFetch([
            prediction("pred-1", "starting"),
            () =>
                new Promise<Response>((resolve) => {
                    setTimeout(() => resolve(new Response("not json")), 1_000);
                }),
            new Response("{}", { status: 500 }),
        ]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        setTimeout(() => void cancelBrowserReplicatePrediction(), 600);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toMatchObject({
            cancelled: false,
            errorMessage:
                "Replicate did not confirm prediction cancellation. The latest response was saved for review.",
        });
    });

    it("times out after five minutes and saves the best available response", async () => {
        withTimers();
        const create = prediction("pred-1", "starting");
        const calls: string[] = [];
        const mock = vi.fn((url: string) => {
            calls.push(String(url));
            if (url === PREDICTIONS) return Promise.resolve(create);
            if (url.endsWith("/cancel"))
                return Promise.resolve(new Response(null, { status: 200 }));
            return Promise.resolve(prediction("pred-1", "starting"));
        });
        vi.stubGlobal("fetch", mock);

        const pending = sendReplicateAiRequest(request(), () => undefined);
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result).toMatchObject({
            status: 408,
            cancelled: false,
            errorMessage: "Replicate prediction timed out after five minutes.",
        });
        expect(result.responseBytes).toBeGreaterThan(0);
        expect(calls.some((url) => url.endsWith("/cancel"))).toBe(true);
    });

    it("uses the cancellation response bytes on timeout when present", async () => {
        withTimers();
        const create = prediction("pred-1", "starting");
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) => {
                if (url === PREDICTIONS) return Promise.resolve(create);
                if (url.endsWith("/cancel")) {
                    return Promise.resolve(prediction("pred-1", "canceled"));
                }
                return Promise.resolve(prediction("pred-1", "starting"));
            }),
        );

        const pending = sendReplicateAiRequest(request(), () => undefined);
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.status).toBe(408);
        expect(result.responseBytes).toBe(
            new TextEncoder().encode(JSON.stringify({ id: "pred-1", status: "canceled" }))
                .byteLength,
        );
    });

    it("reports transport failures during creation", async () => {
        stubFetch([() => Promise.reject(new TypeError("offline"))]);
        await expect(sendReplicateAiRequest(request(), () => undefined)).resolves.toMatchObject({
            status: 0,
            responseBytes: 0,
            errorMessage:
                "The Replicate request could not be completed. Check the connection and browser CORS settings, or use Tutorux for desktop.",
        });

        stubFetch([() => Promise.reject(new DOMException("aborted", "AbortError"))]);
        await expect(sendReplicateAiRequest(request(), () => undefined)).resolves.toMatchObject({
            errorMessage: "Replicate request timed out.",
        });

        stubFetch([() => Promise.reject("boom")]);
        await expect(sendReplicateAiRequest(request(), () => undefined)).resolves.toMatchObject({
            errorMessage:
                "The Replicate request could not be completed. Check the connection and browser CORS settings, or use Tutorux for desktop.",
        });
    });

    it("reports non-2xx and truncated creation responses", async () => {
        stubFetch([new Response("{}", { status: 503 })]);
        await expect(sendReplicateAiRequest(request(), () => undefined)).resolves.toMatchObject({
            status: 503,
            complete: true,
            cancelled: false,
        });

        const oversized = new Uint8Array(8 * 1024 * 1024);
        stubFetch([
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(oversized);
                        controller.enqueue(new Uint8Array([1]));
                    },
                    cancel() {
                        return Promise.reject(new Error("cancel failed"));
                    },
                }),
                { headers: { "content-type": "application/json" } },
            ),
        ]);
        const result = await sendReplicateAiRequest(request(), () => undefined);
        expect(result).toMatchObject({ status: 200, complete: false, cancelled: false });
        expect(result.responseBytes).toBe(8 * 1024 * 1024);
    });

    it("treats a bodyless creation response as an invalid prediction", async () => {
        stubFetch([new Response(null, { status: 200 })]);
        await expect(sendReplicateAiRequest(request(), () => undefined)).resolves.toMatchObject({
            status: 200,
            responseBytes: 0,
            contentType: "application/json",
            errorMessage: "Replicate returned an invalid prediction response.",
        });
    });

    it("rejects a concurrent prediction", async () => {
        let resolveCreate: (value: Response) => void = () => undefined;
        const creation = new Promise<Response>((resolve) => {
            resolveCreate = resolve;
        });
        stubFetch([() => creation]);
        const first = sendReplicateAiRequest(request(), () => undefined);
        await expect(sendReplicateAiRequest(request(), () => undefined)).rejects.toThrow(
            "A Replicate prediction is already active.",
        );
        resolveCreate(prediction("pred-1", "succeeded"));
        await expect(first).resolves.toMatchObject({ status: 200 });
    });

    it("rejects an invalid credential", async () => {
        for (const credential of ["", "two words", "x".repeat(4097)]) {
            await expect(
                sendReplicateAiRequest(request({ credential }), () => undefined),
            ).resolves.toMatchObject({
                errorMessage: "The saved Replicate API token is missing or invalid.",
            });
        }
    });

    it("reports rejected reviewed requests", async () => {
        await expect(
            sendReplicateAiRequest(request({ providerId: "openai" }), () => undefined),
        ).resolves.toMatchObject({
            errorMessage: "The Replicate request changed after review. Prepare it again.",
        });
    });

    it("surfaces callback failures and still releases the active prediction", async () => {
        stubFetch([prediction("pred-1", "succeeded")]);
        await expect(
            sendReplicateAiRequest(request(), () => {
                throw new Error("callback failed");
            }),
        ).resolves.toMatchObject({ errorMessage: "callback failed" });

        stubFetch([prediction("pred-1", "succeeded")]);
        await expect(sendReplicateAiRequest(request(), () => undefined)).resolves.toMatchObject({
            status: 200,
        });
    });

    it("falls back to a generic message for non-Error callback failures", async () => {
        stubFetch([prediction("pred-1", "succeeded")]);
        await expect(
            sendReplicateAiRequest(request(), () => {
                throw "boom";
            }),
        ).resolves.toMatchObject({
            errorMessage: "The Replicate request could not be completed.",
        });
    });

    it("cancels a prediction when the callback fails after cancellation", async () => {
        stubFetch([prediction("pred-1", "canceled"), new Response(null, { status: 200 })]);
        const pending = sendReplicateAiRequest(request(), () => {
            throw new Error("callback failed");
        });
        await cancelBrowserReplicatePrediction();
        await expect(pending).resolves.toMatchObject({ cancelled: true });
    });

    it("cancels and keeps the latest bytes when a canceled poll returns no prediction", async () => {
        withTimers();
        const calls = stubFetch([
            prediction("pred-1", "starting"),
            () =>
                new Promise<Response>((resolve) => {
                    setTimeout(() => resolve(new Response(null, { status: 200 })), 500);
                }),
            new Response(null, { status: 200 }),
        ]);
        const pending = sendReplicateAiRequest(request(), () => undefined);
        setTimeout(() => void cancelBrowserReplicatePrediction(), 550);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toMatchObject({
            status: 200,
            cancelled: true,
            complete: true,
        });
        expect(calls.map(([url]) => url)).toEqual([
            PREDICTIONS,
            `${PREDICTIONS}/pred-1`,
            `${PREDICTIONS}/pred-1/cancel`,
        ]);
    });

    it("reports cancellation while the reviewed body hash is still resolving", async () => {
        const originalCrypto = globalThis.crypto;
        vi.stubGlobal("crypto", {
            subtle: {
                digest: () => Promise.reject(new DOMException("aborted", "AbortError")),
            },
        });
        try {
            const pending = sendReplicateAiRequest(request(), () => undefined);
            await cancelBrowserReplicatePrediction();
            await expect(pending).resolves.toMatchObject({ cancelled: true });
        } finally {
            vi.stubGlobal("crypto", originalCrypto);
        }
    });
});

describe("cancelBrowserReplicatePrediction", () => {
    it("does nothing when no prediction is active", async () => {
        await expect(cancelBrowserReplicatePrediction()).resolves.toBeUndefined();
    });
});

describe("registerReplicateCancellationHandler", () => {
    it("invokes the registered handler and respects unsubscription", async () => {
        const first = vi.fn(() => Promise.resolve());
        const second = vi.fn(() => Promise.resolve());
        const unsubscribeFirst = registerReplicateCancellationHandler(first);
        await cancelReplicatePrediction();
        expect(first).toHaveBeenCalledTimes(1);

        const unsubscribeSecond = registerReplicateCancellationHandler(second);
        unsubscribeFirst();
        await cancelReplicatePrediction();
        expect(second).toHaveBeenCalledTimes(1);

        unsubscribeSecond();
        await expect(cancelReplicatePrediction()).rejects.toThrow(
            "Replicate cancellation is unavailable on this platform.",
        );
    });
});

describe("inspectReplicateModel", () => {
    it("requires an encrypted-archive credential and a valid token", async () => {
        await expect(
            inspectReplicateModel(
                { model: "owner/model", credentialStorage: "none", credential: "token" },
                () => undefined,
            ),
        ).rejects.toThrow(
            "Static browser model inspection requires a key saved in the encrypted archive.",
        );
        await expect(
            inspectReplicateModel(
                { model: "owner/model", credentialStorage: "encrypted-archive", credential: "" },
                () => undefined,
            ),
        ).rejects.toThrow("The saved Replicate API token is missing or invalid.");
    });

    it("rejects malformed model ids before requesting", async () => {
        await expect(
            inspectReplicateModel(
                { model: "owner", credentialStorage: "encrypted-archive", credential: "token" },
                () => undefined,
            ),
        ).rejects.toThrow(
            "Replicate models must use the owner/model form from the public catalog.",
        );
    });

    it("returns model metadata or a transport error", async () => {
        const calls = stubFetch([
            new Response('{"id":"owner/model"}', {
                headers: { "content-type": "application/json" },
            }),
        ]);
        const chunks: Uint8Array[] = [];
        await expect(
            inspectReplicateModel(
                {
                    model: "owner/model",
                    credentialStorage: "encrypted-archive",
                    credential: "token",
                },
                (chunk) => chunks.push(chunk),
            ),
        ).resolves.toMatchObject({ status: 200, complete: true });
        expect(calls[0]?.[0]).toBe(`${REPLICATE_API_ROOT}/models/owner/model`);
        expect(calls[0]?.[1].method).toBe("GET");
        expect(chunks).toHaveLength(1);

        stubFetch([() => Promise.reject(new TypeError("offline"))]);
        await expect(
            inspectReplicateModel(
                {
                    model: "owner/model",
                    credentialStorage: "encrypted-archive",
                    credential: "token",
                },
                () => undefined,
            ),
        ).resolves.toMatchObject({
            status: 0,
            errorMessage:
                "The Replicate request could not be completed. Check the connection and browser CORS settings, or use Tutorux for desktop.",
        });
    });
});
