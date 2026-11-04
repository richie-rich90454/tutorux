// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replicate = vi.hoisted(() => ({
    register: vi.fn(),
    send: vi.fn(),
    inspect: vi.fn(),
    cancel: vi.fn(),
}));

vi.mock("../../../frontend/ai/replicate", () => ({
    registerReplicateCancellationHandler: replicate.register,
    sendReplicateAiRequest: replicate.send,
    inspectReplicateModel: replicate.inspect,
    cancelBrowserReplicatePrediction: replicate.cancel,
}));

import { BrowserFileArchiveSource, MemoryArchiveSource } from "../../../frontend/archive/source";
import { platform } from "../../../frontend/platform/browser";
import type {
    AiTransportRequest,
    AiTransportResult,
    BinaryExportPayload,
    SanitizedCopyDestination,
} from "../../../frontend/platform/types";

interface LocalHandle {
    name: string;
    getFile(): Promise<File>;
    queryPermission?(): Promise<PermissionState>;
    requestPermission?(): Promise<PermissionState>;
    createWritable(): Promise<{
        write(data: BufferSource | Blob | string): Promise<void>;
        close(): Promise<void>;
        abort(reason?: unknown): Promise<void>;
    }>;
}

interface HandleOptions {
    getFile?: (current: File) => Promise<File>;
    queryPermission?: () => Promise<PermissionState>;
    requestPermission?: () => Promise<PermissionState>;
    writableError?: Error;
    write?: (data: unknown) => Promise<void>;
    close?: () => Promise<void>;
    abort?: (reason?: unknown) => Promise<void>;
}

const access = window as unknown as Record<string, unknown>;

function makeFile(bytes: readonly number[], name = "guide.tux", lastModified = 1_000): File {
    return new File([new Uint8Array(bytes)], name, { lastModified });
}

function makeHandle(file: File, options: HandleOptions = {}): LocalHandle {
    let current = file;
    const handle: LocalHandle = {
        name: file.name,
        getFile: async () => (options.getFile ? options.getFile(current) : current),
        queryPermission: options.queryPermission ?? (async () => "granted"),
        requestPermission: options.requestPermission ?? (async () => "granted"),
        createWritable: async () => {
            if (options.writableError) throw options.writableError;
            const writes: Uint8Array<ArrayBuffer>[] = [];
            return {
                write:
                    options.write ??
                    (async (data: unknown) => {
                        if (data instanceof Uint8Array) writes.push(data.slice());
                        else if (data instanceof Blob)
                            writes.push(new Uint8Array(await data.arrayBuffer()));
                        else if (typeof data === "string")
                            writes.push(new TextEncoder().encode(data));
                    }),
                close:
                    options.close ??
                    (async () => {
                        const bytes = new Uint8Array(await new Blob(writes).arrayBuffer());
                        current = new File([bytes], file.name, {
                            lastModified: file.lastModified,
                        });
                    }),
                abort: options.abort ?? (async () => undefined),
            };
        },
    };
    return handle;
}

function captureAnchors(): HTMLAnchorElement[] {
    const anchors: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
    ) {
        anchors.push(this);
    });
    return anchors;
}

let createdUrls: Blob[];
let revokedUrls: string[];

function stubUrl(): void {
    createdUrls = [];
    revokedUrls = [];
    Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: (blob: Blob) => {
            createdUrls.push(blob);
            return `blob:${createdUrls.length}`;
        },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: (url: string) => revokedUrls.push(url),
    });
}

function emptyResult(overrides: Partial<AiTransportResult> = {}): AiTransportResult {
    return {
        status: 200,
        contentType: "application/json",
        responseBytes: 0,
        complete: true,
        ...overrides,
    };
}

const request: AiTransportRequest = {
    providerId: "openai",
    endpoint: "https://example.test/v1/chat",
    confirmedEndpoint: "https://example.test/v1/chat",
    model: "gpt",
    accept: "text/event-stream",
    requestBody: "{}",
    requestBodyHash: "hash",
    confirmedBodyHash: "hash",
    credentialStorage: "encrypted-archive",
    credential: "secret",
};

beforeEach(() => {
    delete access["showOpenFilePicker"];
    delete access["showSaveFilePicker"];
    if (typeof Blob.prototype.stream !== "function") {
        Object.defineProperty(Blob.prototype, "stream", {
            configurable: true,
            value: function stream(this: Blob) {
                // eslint-disable-next-line @typescript-eslint/no-this-alias
                const blob = this;
                return new ReadableStream<Uint8Array>({
                    async start(controller) {
                        controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
                        controller.close();
                    },
                });
            },
        });
    }
    replicate.send.mockReset().mockResolvedValue(emptyResult());
    replicate.inspect.mockReset().mockResolvedValue(emptyResult());
    stubUrl();
    vi.spyOn(window, "setTimeout").mockImplementation(((callback: unknown) => {
        if (typeof callback === "function") (callback as () => void)();
        return 1;
    }) as unknown as typeof window.setTimeout);
    vi.spyOn(window, "clearTimeout").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete access["showOpenFilePicker"];
    delete access["showSaveFilePicker"];
});

describe("browser archive opening", () => {
    it("opens through the file picker with autosave when permissions are available", async () => {
        const file = makeFile([1, 2, 3]);
        const handle = makeHandle(file);
        access["showOpenFilePicker"] = vi.fn(async () => [handle]);

        const opened = await platform.openArchive();
        expect(opened).toMatchObject({ name: "guide.tux", location: null });
        expect(opened!.autosave).toBeDefined();
        await expect(opened!.source.read(0n, 3)).resolves.toEqual(new Uint8Array([1, 2, 3]));
        await expect(opened!.autosave!.requestPermission()).resolves.toBe(true);
    });

    it("omits autosave when the picker cannot request write access", async () => {
        const file = makeFile([7]);
        const handle = makeHandle(file);
        delete handle.queryPermission;
        delete handle.requestPermission;
        access["showOpenFilePicker"] = vi.fn(async () => [handle]);

        const opened = await platform.openArchive();
        expect(opened!.autosave).toBeUndefined();
    });

    it("returns null when the picker selects nothing", async () => {
        access["showOpenFilePicker"] = vi.fn(async () => []);
        await expect(platform.openArchive()).resolves.toBeNull();
    });

    it("falls back to an input picker and resolves the selected file", async () => {
        const file = makeFile([4, 5]);
        const click = vi
            .spyOn(HTMLInputElement.prototype, "click")
            .mockImplementation(() => undefined);

        const pending = platform.openArchive();
        const input = click.mock.contexts[0] as HTMLInputElement;
        Object.defineProperty(input!, "files", { configurable: true, value: [file] });
        input!.dispatchEvent(new Event("change"));

        const opened = await pending;
        expect(opened).toMatchObject({ name: "guide.tux", location: null });
        expect(opened!.autosave).toBeUndefined();
        await expect(opened!.source.read(0n, 2)).resolves.toEqual(new Uint8Array([4, 5]));
    });

    it("returns null when the input picker has no file", async () => {
        const click = vi
            .spyOn(HTMLInputElement.prototype, "click")
            .mockImplementation(() => undefined);

        const pending = platform.openArchive();
        const input = click.mock.contexts[0] as HTMLInputElement;
        input!.dispatchEvent(new Event("change"));
        await expect(pending).resolves.toBeNull();
    });

    it("returns null when the input picker is canceled", async () => {
        const click = vi
            .spyOn(HTMLInputElement.prototype, "click")
            .mockImplementation(() => undefined);

        const pending = platform.openArchive();
        const input = click.mock.contexts[0] as HTMLInputElement;
        input!.dispatchEvent(new Event("cancel"));
        await expect(pending).resolves.toBeNull();
    });
});

describe("browser autosave", () => {
    async function openAutosave(handle: LocalHandle) {
        access["showOpenFilePicker"] = vi.fn(async () => [handle]);
        const opened = await platform.openArchive();
        return opened!.autosave!;
    }

    it("reports permission refusal", async () => {
        const handle = makeHandle(makeFile([1]), {
            requestPermission: async () => "denied",
        });
        const autosave = await openAutosave(handle);
        await expect(autosave.requestPermission()).resolves.toBe(false);
        delete handle.queryPermission;
        await expect(autosave.requestPermission()).resolves.toBe(false);
    });

    it("saves the complete archive and refreshes the baseline", async () => {
        const handle = makeHandle(makeFile([1, 2, 3]));
        const autosave = await openAutosave(handle);
        const bytes = new Uint8Array([9, 8, 7, 6]);

        const saved = await autosave.save(new MemoryArchiveSource(bytes));
        await expect(saved.read(0n, 4)).resolves.toEqual(bytes);

        const again = await autosave.save(new MemoryArchiveSource(new Uint8Array([5])));
        await expect(again.read(0n, 1)).resolves.toEqual(new Uint8Array([5]));
    });

    it("compares multi-chunk archives byte for byte", async () => {
        const large = new Uint8Array(1_500_000).fill(3);
        const autosave = await openAutosave(
            makeHandle(new File([large], "large.tux", { lastModified: 1_000 })),
        );
        const saved = await autosave.save(new MemoryArchiveSource(large));
        expect((await saved.read(0n, 4)).byteLength).toBe(4);
    });

    it("refuses to save without write permission", async () => {
        const autosave = await openAutosave(
            makeHandle(makeFile([1]), { queryPermission: async () => "denied" }),
        );
        await expect(autosave.save(new MemoryArchiveSource(new Uint8Array([1])))).rejects.toThrow(
            /write permission is not available/u,
        );
    });

    it("refuses to overwrite an archive changed outside the app", async () => {
        const baseline = makeFile([1, 2, 3], "guide.tux", 1_000);
        const changed = makeFile([1, 2, 3, 4], "guide.tux", 1_000);
        let calls = 0;
        const autosave = await openAutosave(
            makeHandle(baseline, {
                getFile: async () => {
                    calls += 1;
                    return calls === 1 ? baseline : changed;
                },
            }),
        );
        await expect(autosave.save(new MemoryArchiveSource(new Uint8Array([1])))).rejects.toThrow(
            /changed outside Tutorux/u,
        );
    });

    it("detects changed bytes even when size and timestamp match", async () => {
        const baseline = makeFile([1, 2, 3], "guide.tux", 1_000);
        const changed = makeFile([1, 2, 4], "guide.tux", 1_000);
        let calls = 0;
        const autosave = await openAutosave(
            makeHandle(baseline, {
                getFile: async () => {
                    calls += 1;
                    return calls === 1 ? baseline : changed;
                },
            }),
        );
        await expect(autosave.save(new MemoryArchiveSource(new Uint8Array([1])))).rejects.toThrow(
            /changed outside Tutorux/u,
        );
    });

    it("wraps failures to re-read the current archive", async () => {
        let calls = 0;
        const autosave = await openAutosave(
            makeHandle(makeFile([1]), {
                getFile: async () => {
                    calls += 1;
                    if (calls === 1) return makeFile([1]);
                    throw new Error("disk removed");
                },
            }),
        );
        await expect(autosave.save(new MemoryArchiveSource(new Uint8Array([1])))).rejects.toThrow(
            /could not be checked/u,
        );
    });

    it("reports a writable failure and aborts", async () => {
        const abort = vi.fn(async () => {
            throw new Error("abort failed");
        });
        const autosave = await openAutosave(
            makeHandle(makeFile([1]), {
                write: async () => {
                    throw new Error("disk full");
                },
                abort,
            }),
        );
        await expect(autosave.save(new MemoryArchiveSource(new Uint8Array([1])))).rejects.toThrow(
            "disk full",
        );
        expect(abort).toHaveBeenCalled();
    });

    it("rejects a concurrent save and recovers afterwards", async () => {
        let releasePermission: (value: PermissionState) => void = () => undefined;
        const permission = new Promise<PermissionState>((resolve) => {
            releasePermission = resolve;
        });
        let calls = 0;
        const autosave = await openAutosave(
            makeHandle(makeFile([1]), {
                queryPermission: () => {
                    calls += 1;
                    return calls === 1 ? permission : Promise.resolve("granted");
                },
            }),
        );

        const first = autosave.save(new MemoryArchiveSource(new Uint8Array([1])));
        await expect(autosave.save(new MemoryArchiveSource(new Uint8Array([2])))).rejects.toThrow(
            /already in progress/u,
        );
        releasePermission("granted");
        await first;
        await expect(
            autosave.save(new MemoryArchiveSource(new Uint8Array([3]))),
        ).resolves.toBeDefined();
    });

    it("reports a writable creation failure", async () => {
        const autosave = await openAutosave(
            makeHandle(makeFile([1]), { writableError: new Error("no handle") }),
        );
        await expect(autosave.save(new MemoryArchiveSource(new Uint8Array([1])))).rejects.toThrow(
            "no handle",
        );
    });
});

describe("browser archive saving", () => {
    it("saves through the save picker", async () => {
        const file = makeFile([], "export.tux");
        const handle = makeHandle(file);
        access["showSaveFilePicker"] = vi.fn(async () => handle);

        await expect(
            platform.saveArchive(new MemoryArchiveSource(new Uint8Array([1, 2])), "export.tux"),
        ).resolves.toBe("export.tux");
        expect(createdUrls).toHaveLength(0);
    });

    it("aborts and rethrows when the save picker write fails", async () => {
        const abort = vi.fn(async () => {
            throw new Error("abort failed");
        });
        const handle = makeHandle(makeFile([], "export.tux"), {
            write: async () => {
                throw new Error("write failed");
            },
            abort,
        });
        access["showSaveFilePicker"] = vi.fn(async () => handle);

        await expect(
            platform.saveArchive(new MemoryArchiveSource(new Uint8Array([1])), "export.tux"),
        ).rejects.toThrow("write failed");
        expect(abort).toHaveBeenCalled();
    });

    it("refuses archives over 512 MiB without the file picker", async () => {
        const huge = {
            size: 512n * 1024n * 1024n + 1n,
            read: async () => new Uint8Array(),
        };
        await expect(platform.saveArchive(huge, "huge.tux")).rejects.toThrow(/512 MiB/u);
    });

    it("downloads through an anchor when the file picker is unavailable", async () => {
        const anchors = captureAnchors();
        await expect(
            platform.saveArchive(new MemoryArchiveSource(new Uint8Array([1, 2, 3])), "small.tux"),
        ).resolves.toBe("small.tux");
        expect(anchors[0]!.download).toBe("small.tux");
        expect(anchors[0]!.href).toBe("blob:1");
        expect(createdUrls[0]!.type).toBe("application/x-tutorux");
        expect(revokedUrls).toEqual(["blob:1"]);
    });
});

describe("browser text and binary export", () => {
    it("exports text through an anchor", async () => {
        const anchors = captureAnchors();
        await expect(
            platform.exportTextFile("transcript.txt", "hello", "text/plain"),
        ).resolves.toBe("transcript.txt");
        expect(anchors[0]!.download).toBe("transcript.txt");
        expect(createdUrls[0]!.type).toBe("text/plain");
        await expect(createdUrls[0]!.text()).resolves.toBe("hello");
        expect(revokedUrls).toHaveLength(1);
    });

    it("exports a byte payload through an anchor", async () => {
        const anchors = captureAnchors();
        await expect(
            platform.exportBinaryFile("report.pdf", new Uint8Array([1, 2]), "application/pdf"),
        ).resolves.toBe("report.pdf");
        expect(anchors[0]!.download).toBe("report.pdf");
        expect(createdUrls[0]!.type).toBe("application/pdf");
    });

    it("exports a streamed payload through an anchor", async () => {
        captureAnchors();
        const payload = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([5]));
                controller.close();
            },
        });
        await platform.exportBinaryFile("audio.wav", async () => payload, "audio/wav");
        expect(new Uint8Array(await createdUrls[0]!.arrayBuffer())).toEqual(new Uint8Array([5]));
    });

    it("labels picker types for audio, Word, and generic files", async () => {
        const descriptions: string[] = [];
        access["showSaveFilePicker"] = vi.fn(
            async (options: { types: { description: string }[] }) => {
                descriptions.push(options.types[0]!.description);
                return makeHandle(makeFile([], "out"));
            },
        );
        await platform.exportBinaryFile("take.wav", new Uint8Array([1]), "audio/wav");
        await platform.exportBinaryFile(
            "report.docx",
            new Uint8Array([1]),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
        await platform.exportBinaryFile("image.png", new Uint8Array([1]), "image/png");
        expect(descriptions).toEqual(["WAV audio", "Word document", "Exported file"]);
    });

    it("falls back to a bin extension for names without parts", async () => {
        access["showSaveFilePicker"] = vi.fn(async () => makeHandle(makeFile([], "out")));
        await expect(
            platform.exportBinaryFile(
                { split: () => [] } as unknown as string,
                new Uint8Array([1]),
                "application/octet-stream",
            ),
        ).resolves.toBe("out");
    });

    it("writes a streamed export through the save picker", async () => {
        access["showSaveFilePicker"] = vi.fn(async () => makeHandle(makeFile([], "out.bin")));
        const payload = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                controller.close();
            },
        });
        await expect(
            platform.exportBinaryFile("out.bin", async () => payload, "application/octet-stream"),
        ).resolves.toBe("out.bin");
    });

    it("aborts a failed binary export", async () => {
        const abort = vi.fn(async () => {
            throw new Error("abort failed");
        });
        access["showSaveFilePicker"] = vi.fn(async () =>
            makeHandle(makeFile([], "out.bin"), {
                write: async () => {
                    throw new Error("write failed");
                },
                abort,
            }),
        );
        await expect(
            platform.exportBinaryFile("out.bin", new Uint8Array([1]), "application/octet-stream"),
        ).rejects.toThrow("write failed");
        expect(abort).toHaveBeenCalled();
    });
});

describe("browser AI transport", () => {
    function stubFetch(
        implementation: (url: string, init: RequestInit) => Promise<Response>,
    ): ReturnType<typeof vi.fn> {
        const mock = vi.fn(implementation);
        vi.stubGlobal("fetch", mock);
        return mock;
    }

    it("delegates Replicate requests", async () => {
        const result = await platform.sendAiRequest(
            { ...request, providerId: "replicate" },
            () => {},
        );
        expect(result).toEqual(emptyResult());
        expect(replicate.send).toHaveBeenCalledWith(
            { ...request, providerId: "replicate" },
            expect.any(Function),
        );
    });

    it("rejects embedded inference in the browser", async () => {
        await expect(
            platform.sendAiRequest({ ...request, providerId: "embedded-gguf" }, () => {}),
        ).rejects.toThrow(/desktop app/u);
    });

    it("sets the bearer token and accepts an empty response body", async () => {
        const fetchMock = stubFetch(
            async () =>
                new Response(null, {
                    status: 204,
                    headers: { "content-type": "text/plain" },
                }),
        );
        const result = await platform.sendAiRequest(request, () => {});
        const init = fetchMock.mock.calls[0]![1] as RequestInit;
        const headers = new Headers(init.headers);
        expect(headers.get("Authorization")).toBe("Bearer secret");
        expect(result).toEqual({
            status: 204,
            contentType: "text/plain",
            responseBytes: 0,
            complete: true,
        });
    });

    it("uses provider-specific headers", async () => {
        const fetchMock = stubFetch(async () => new Response(null, { status: 200 }));
        await platform.sendAiRequest(
            { ...request, providerId: "anthropic", model: "claude-3" },
            () => {},
        );
        let headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
        expect(headers.get("x-api-key")).toBe("secret");
        expect(headers.get("Authorization")).toBeNull();
        expect(headers.get("anthropic-version")).toBe("2023-06-01");

        await platform.sendAiRequest(
            { ...request, providerId: "opencode-zen", model: "claude-sonnet" },
            () => {},
        );
        headers = new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers);
        expect(headers.get("x-api-key")).toBe("secret");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");

        await platform.sendAiRequest(
            { ...request, providerId: "ollama", credential: "ignored" },
            () => {},
        );
        headers = new Headers((fetchMock.mock.calls[2]![1] as RequestInit).headers);
        expect(headers.get("Authorization")).toBeNull();
    });

    it("maps transport failures to a browser CORS hint", async () => {
        stubFetch(async () => {
            throw new Error("network down");
        });
        await expect(platform.sendAiRequest(request, () => {})).rejects.toThrow(/browser CORS/u);
    });

    it("reports an aborted provider request as a timeout", async () => {
        stubFetch(async () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
        });
        await expect(platform.sendAiRequest(request, () => {})).rejects.toThrow(/timed out/u);
    });

    it("reports an offline device separately from a CORS failure", async () => {
        vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
        stubFetch(async () => {
            throw new Error("network down");
        });
        await expect(platform.sendAiRequest(request, () => {})).rejects.toThrow(/offline/u);
    });

    it("streams response chunks", async () => {
        stubFetch(
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new Uint8Array([1, 2]));
                            controller.enqueue(new Uint8Array([3]));
                            controller.close();
                        },
                    }),
                    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
                ),
        );
        const chunks: Uint8Array[] = [];
        const result = await platform.sendAiRequest(request, (chunk) => chunks.push(chunk));
        expect(chunks).toEqual([new Uint8Array([1, 2]), new Uint8Array([3])]);
        expect(result).toEqual({
            status: 200,
            contentType: "text/event-stream",
            responseBytes: 3,
            complete: true,
        });
    });

    it("marks a stream incomplete when the reader fails", async () => {
        const releaseLock = vi.fn();
        const response = {
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            body: {
                getReader: () => ({
                    read: async () => {
                        throw new Error("connection reset");
                    },
                    releaseLock,
                }),
            },
        } as unknown as Response;
        stubFetch(async () => response);

        const result = await platform.sendAiRequest(request, () => {});
        expect(result.complete).toBe(false);
        expect(releaseLock).toHaveBeenCalled();
    });

    it("truncates a response that crosses the byte limit", async () => {
        const limit = 16 * 1024 * 1024;
        const cancel = vi.fn(async () => {
            throw new Error("cancel failed");
        });
        const values = [
            { done: false, value: { byteLength: limit - 1, subarray: () => new Uint8Array([9]) } },
            { done: false, value: { byteLength: 2, subarray: () => new Uint8Array([8]) } },
        ];
        const response = {
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            body: {
                getReader: () => ({
                    read: async () => values.shift(),
                    releaseLock: vi.fn(),
                    cancel,
                }),
            },
        } as unknown as Response;
        stubFetch(async () => response);

        const chunks: Uint8Array[] = [];
        const result = await platform.sendAiRequest(request, (chunk) => chunks.push(chunk));
        expect(result.complete).toBe(false);
        expect(result.responseBytes).toBe(limit);
        expect(cancel).toHaveBeenCalled();
        expect(chunks.at(-1)).toEqual(new Uint8Array([8]));
    });

    it("stops at the byte limit when no room remains", async () => {
        const limit = 16 * 1024 * 1024;
        const cancel = vi.fn(async () => undefined);
        const values = [
            { done: false, value: { byteLength: limit, subarray: () => new Uint8Array([9]) } },
            { done: false, value: { byteLength: 1, subarray: () => new Uint8Array([8]) } },
        ];
        const response = {
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            body: {
                getReader: () => ({
                    read: async () => values.shift(),
                    releaseLock: vi.fn(),
                    cancel,
                }),
            },
        } as unknown as Response;
        stubFetch(async () => response);

        const result = await platform.sendAiRequest(request, () => {});
        expect(result.complete).toBe(false);
        expect(result.responseBytes).toBe(limit);
        expect(cancel).toHaveBeenCalled();
    });

    it("normalizes an unparseable content type", async () => {
        const response = {
            status: 200,
            headers: { get: () => ({ split: () => [] }) },
            body: null,
        } as unknown as Response;
        stubFetch(async () => response);
        const result = await platform.sendAiRequest(request, () => {});
        expect(result.contentType).toBe("");
    });

    it("delegates model inspection", async () => {
        await platform.inspectReplicateModel(
            { model: "owner/model", credentialStorage: "encrypted-archive", credential: "token" },
            () => {},
        );
        expect(replicate.inspect).toHaveBeenCalledWith(
            { model: "owner/model", credentialStorage: "encrypted-archive", credential: "token" },
            expect.any(Function),
        );
    });

    it("reports unavailable keychain credentials", async () => {
        await expect(platform.aiCredentialStoreAvailable()).resolves.toBe(false);
        await expect(platform.hasAiCredential("openai")).resolves.toBe(false);
        await expect(platform.saveAiCredential("openai", "secret")).rejects.toThrow(/desktop app/u);
        await expect(platform.removeAiCredential("openai")).rejects.toThrow(/desktop app/u);
        await expect(platform.createArchiveLocation("name.tux")).resolves.toBe("name.tux");
    });
});

describe("browser sanitized copy destination", () => {
    async function chooseDestination(name: string): Promise<SanitizedCopyDestination> {
        const destination = await platform.chooseSanitizedCopyDestination(name);
        if (!destination) throw new Error("expected a sanitized copy destination");
        return destination;
    }

    it("checkpoints until canceled", async () => {
        const destination = await chooseDestination("copy.tux");
        expect(destination.label).toBe("copy.tux · browser download");
        await expect(
            destination.checkpoint(new MemoryArchiveSource(new Uint8Array()), 0n),
        ).resolves.toBeUndefined();
        await destination.cancel();
        await expect(
            destination.checkpoint(new MemoryArchiveSource(new Uint8Array()), 0n),
        ).rejects.toThrow(/no longer available/u);
        await expect(
            destination.publish(new MemoryArchiveSource(new Uint8Array())),
        ).rejects.toThrow(/no longer available/u);
    });

    it("publishes one download and refuses a second", async () => {
        const anchors = captureAnchors();
        const destination = await chooseDestination("copy.tux");
        await expect(
            destination.publish(new MemoryArchiveSource(new Uint8Array([1, 2]))),
        ).resolves.toBe("copy.tux");
        expect(anchors[0]!.download).toBe("copy.tux");
        await expect(
            destination.publish(new MemoryArchiveSource(new Uint8Array([1]))),
        ).rejects.toThrow(/no longer available/u);
        await expect(
            destination.checkpoint(new MemoryArchiveSource(new Uint8Array()), 0n),
        ).rejects.toThrow(/no longer available/u);
    });

    it("refuses sanitized copies over 512 MiB", async () => {
        const destination = await chooseDestination("copy.tux");
        const huge = {
            size: 512n * 1024n * 1024n + 1n,
            read: async () => new Uint8Array(),
        };
        await expect(destination.publish(huge)).rejects.toThrow(/512 MiB/u);
    });

    it("cancels while the copy is being assembled", async () => {
        const destination = await chooseDestination("copy.tux");
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const source = {
            size: 1n,
            read: async () => {
                await gate;
                return new Uint8Array([1]);
            },
        };
        const publishing = destination.publish(source);
        await Promise.resolve();
        await destination.cancel();
        release();
        await expect(publishing).rejects.toThrow(/canceled/u);
    });

    it("dispatches notices with a default tone", async () => {
        const notices: unknown[] = [];
        const listener = (event: Event) => notices.push((event as CustomEvent).detail);
        window.addEventListener("tutorux:notice", listener);
        platform.notify("Saved");
        platform.notify("Careful", "error");
        window.removeEventListener("tutorux:notice", listener);
        expect(notices).toEqual([
            { message: "Saved", tone: "info" },
            { message: "Careful", tone: "error" },
        ]);
    });
});

describe("browser export payload helpers", () => {
    it("accepts a direct payload and a payload function", async () => {
        captureAnchors();
        const direct: BinaryExportPayload = new Uint8Array([1]);
        await platform.exportBinaryFile("a.bin", direct, "application/octet-stream");
        await platform.exportBinaryFile(
            "b.bin",
            async () => new Uint8Array([2]),
            "application/octet-stream",
        );
        expect(createdUrls).toHaveLength(2);
    });

    it("wraps plain archive sources as file sources", async () => {
        const source = new BrowserFileArchiveSource(makeFile([1, 2, 3]));
        await expect(source.read(1n, 2)).resolves.toEqual(new Uint8Array([2, 3]));
    });
});
