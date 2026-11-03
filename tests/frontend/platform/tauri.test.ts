import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type InvokeHandler = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

interface RecordedCall {
    command: string;
    args: Record<string, unknown> | undefined;
}

interface SaveOptions {
    title: string;
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
}

interface OpenOptions {
    title: string;
    multiple: boolean;
    filters: { name: string; extensions: string[] }[];
}

interface RecordedWrite {
    path: string;
    payload: unknown;
    options: Record<string, unknown> | undefined;
}

interface RecordedFileOpen {
    path: string;
    options: Record<string, unknown> | undefined;
}

interface ListenerEntry {
    event: string;
    handler: (event: { payload: unknown }) => void;
    unlisten: Mock<() => Promise<void>>;
}

const harness = vi.hoisted(() => ({
    calls: [] as RecordedCall[],
    handler: (async () => undefined) as InvokeHandler,
    openCalls: [] as OpenOptions[],
    openResult: null as string | string[] | null,
    saveCalls: [] as SaveOptions[],
    saveResult: null as string | null,
    listeners: [] as ListenerEntry[],
    channels: [] as { onmessage: ((message: unknown) => void) | null }[],
    writes: [] as RecordedWrite[],
    writeHandler: undefined as undefined | ((write: RecordedWrite) => Promise<void>),
    opens: [] as RecordedFileOpen[],
    openFileHandler: undefined as undefined | ((open: RecordedFileOpen) => unknown),
    replicateHandler: null as null | (() => Promise<void>),
    embeddedRequests: [] as { request: unknown; onChunk: (chunk: Uint8Array) => void }[],
    embeddedResult: undefined as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({
    Channel: class {
        onmessage: ((message: unknown) => void) | null = null;

        constructor() {
            harness.channels.push(this);
        }
    },
    invoke: (command: string, args?: Record<string, unknown>) => {
        harness.calls.push({ command, args });
        return harness.handler(command, args);
    },
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
        const unlisten = vi.fn(async () => undefined);
        harness.listeners.push({ event, handler, unlisten });
        return unlisten;
    },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: async (options: OpenOptions) => {
        harness.openCalls.push(options);
        return harness.openResult;
    },
    save: async (options: SaveOptions) => {
        harness.saveCalls.push(options);
        return harness.saveResult;
    },
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
    open: async (path: string, options?: Record<string, unknown>) => {
        const entry: RecordedFileOpen = { path, options };
        harness.opens.push(entry);
        if (harness.openFileHandler) return await harness.openFileHandler(entry);
        return {
            write: async (bytes: Uint8Array) => bytes.byteLength,
            close: async () => undefined,
        };
    },
    writeFile: async (path: string, payload: unknown, options?: Record<string, unknown>) => {
        const entry: RecordedWrite = { path, payload, options };
        harness.writes.push(entry);
        if (harness.writeHandler) await harness.writeHandler(entry);
    },
}));

vi.mock("../../../frontend/ai/replicate", () => ({
    registerReplicateCancellationHandler: (handler: () => Promise<void>) => {
        harness.replicateHandler = handler;
        return () => {
            harness.replicateHandler = null;
        };
    },
    replicateModelMetadataEndpoint: (model: string) => `https://api.replicate.com/models/${model}`,
}));

vi.mock("../../../frontend/ai/providers", () => ({
    isEmbeddedGgufProvider: (providerId: string) =>
        providerId === "embedded-gguf" || providerId === "llama.cpp-embedded",
}));

vi.mock("../../../frontend/platform/embedded-ai", () => ({
    sendEmbeddedAiRequest: async (request: unknown, onChunk: (chunk: Uint8Array) => void) => {
        harness.embeddedRequests.push({ request, onChunk });
        return (
            harness.embeddedResult ?? {
                status: 200,
                contentType: "text/event-stream",
                responseBytes: 0,
                complete: true,
            }
        );
    },
}));

import { MemoryArchiveSource, type ArchiveByteSource } from "../../../frontend/archive/source";
import {
    hasDesktopArchiveCapability,
    persistMicrophoneArchiveGeneration,
    platform,
} from "../../../frontend/platform/tauri";
import type {
    AiModelInspectionRequest,
    AiTransportRequest,
    AiTransportResult,
    DesktopDiagnostics,
    OpenedArchive,
} from "../../../frontend/platform/types";

const UUID_ONE = "11111111-1111-4111-8111-111111111111";
const UUID_TWO = "22222222-2222-4222-8222-222222222222";

function invokeCalls(command: string): RecordedCall[] {
    return harness.calls.filter((call) => call.command === command);
}

function lastCall(command: string): RecordedCall {
    const calls = invokeCalls(command);
    const call = calls[calls.length - 1];
    if (!call) throw new Error(`No invoke call for ${command}`);
    return call;
}

function setRoutes(
    routes: Record<string, (args: Record<string, unknown> | undefined) => unknown>,
): void {
    harness.handler = async (command, args) => {
        const route = routes[command];
        return route ? await route(args) : undefined;
    };
}

async function openDesktopArchive(
    token: string,
    size: bigint,
    name = "a.tux",
): Promise<OpenedArchive> {
    harness.openResult = "C:/a.tux";
    setRoutes({ authorize_archive_path: () => ({ token, size: size.toString(), name }) });
    const opened = await platform.openArchive();
    if (!opened) throw new Error("Expected an opened archive");
    return opened;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64(bytes: readonly number[]): string {
    return Buffer.from(bytes).toString("base64");
}

function makeFileHandle(closeFails = false): {
    writes: Uint8Array[];
    write: Mock<(bytes: Uint8Array) => Promise<number>>;
    close: Mock<() => Promise<void>>;
} {
    const writes: Uint8Array[] = [];
    return {
        writes,
        write: vi.fn(async (bytes: Uint8Array) => {
            writes.push(bytes);
            return bytes.byteLength;
        }),
        close: vi.fn(async () => {
            if (closeFails) throw new Error("close failed");
        }),
    };
}

const transportRequest: AiTransportRequest = {
    providerId: "openai",
    endpoint: "https://api.openai.com/v1/chat/completions",
    confirmedEndpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt",
    accept: "text/event-stream",
    requestBody: "{}",
    requestBodyHash: "hash",
    confirmedBodyHash: "hash",
    credentialStorage: "system-keychain",
    credential: "secret",
};

const replicateRequest: AiTransportRequest = {
    ...transportRequest,
    providerId: "replicate",
    endpoint: "https://api.replicate.com/v1/predictions",
    confirmedEndpoint: "https://api.replicate.com/v1/predictions",
    model: "owner/name",
};

const transportResult: AiTransportResult = {
    status: 200,
    contentType: "text/event-stream",
    responseBytes: 3,
    complete: true,
};

beforeEach(() => {
    harness.calls.length = 0;
    harness.handler = async () => undefined;
    harness.openCalls.length = 0;
    harness.openResult = null;
    harness.saveCalls.length = 0;
    harness.saveResult = null;
    harness.listeners.length = 0;
    harness.channels.length = 0;
    harness.writes.length = 0;
    harness.writeHandler = undefined;
    harness.opens.length = 0;
    harness.openFileHandler = undefined;
    harness.embeddedRequests.length = 0;
    harness.embeddedResult = undefined;
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("desktop archive capability", () => {
    it("opens, chunks, reads and closes the authorized file", async () => {
        const total = 4 * 1024 * 1024 + 8;
        const opened = await openDesktopArchive("tok-read", BigInt(total));
        const reads: { archiveToken: string; offset: string; length: number }[] = [];
        setRoutes({
            read_archive_range: (args) => {
                const { archiveToken, offset, length } = args as {
                    archiveToken: string;
                    offset: string;
                    length: number;
                };
                reads.push({ archiveToken, offset, length });
                return new ArrayBuffer(length);
            },
        });

        const bytes = await opened.source.read(0n, total);

        expect(bytes.byteLength).toBe(total);
        expect(reads).toEqual([
            { archiveToken: "tok-read", offset: "0", length: 4194304 },
            { archiveToken: "tok-read", offset: "4194304", length: 8 },
        ]);

        const empty = await opened.source.read(0n, 0);
        expect(empty.byteLength).toBe(0);

        harness.handler = async () => undefined;
        await opened.source.close?.();
        expect(lastCall("close_archive").args).toEqual({ archiveToken: "tok-read" });
    });

    it("rejects every out-of-bounds read and short adapter reads", async () => {
        const opened = await openDesktopArchive("tok-bounds", 100n);
        harness.handler = async () => {
            throw new Error("read must not reach the adapter");
        };

        await expect(opened.source.read(-1n, 1)).rejects.toThrow(
            new RangeError("Archive read is outside the selected file."),
        );
        await expect(opened.source.read(0n, 1.5)).rejects.toThrow(
            new RangeError("Archive read is outside the selected file."),
        );
        await expect(opened.source.read(0n, -1)).rejects.toThrow(
            new RangeError("Archive read is outside the selected file."),
        );
        await expect(opened.source.read(95n, 10)).rejects.toThrow(
            new RangeError("Archive read is outside the selected file."),
        );

        setRoutes({ read_archive_range: () => new ArrayBuffer(2) });
        await expect(opened.source.read(0n, 3)).rejects.toThrow(
            "The desktop file adapter returned a short read.",
        );
    });

    it("reports capability only for sources authorized by the desktop", async () => {
        const opened = await openDesktopArchive("tok-capable", 10n);
        expect(hasDesktopArchiveCapability(opened.source)).toBe(true);
        expect(hasDesktopArchiveCapability(new MemoryArchiveSource(new Uint8Array(4)))).toBe(false);
    });

    it("walks cyclic and malformed composite graphs without finding a token", async () => {
        const cycle: {
            size: bigint;
            read: () => Promise<Uint8Array>;
            base?: unknown;
            appended?: unknown;
        } = { size: 0n, read: async () => new Uint8Array() };
        const sibling = {
            size: 0n,
            read: async () => new Uint8Array(),
            base: cycle,
            appended: "not-an-object",
        };
        cycle.base = "not-an-object";
        cycle.appended = sibling;

        expect(hasDesktopArchiveCapability(cycle as unknown as ArchiveByteSource)).toBe(false);
    });

    it("persists microphone generations and advances the recorded size", async () => {
        const opened = await openDesktopArchive("tok-persist", 100n);
        const generation = new Uint8Array(32).fill(7);
        setRoutes({
            append_audio_archive_generation: (args) => {
                const { expectedSize, bytes } = args as { expectedSize: string; bytes: number[] };
                return { size: (BigInt(expectedSize) + BigInt(bytes.length)).toString() };
            },
        });

        await persistMicrophoneArchiveGeneration(opened.source, generation, 5n);

        expect(lastCall("append_audio_archive_generation").args).toEqual({
            archiveToken: "tok-persist",
            expectedSize: "100",
            generation: "5",
            bytes: Array.from(generation),
        });

        await persistMicrophoneArchiveGeneration(opened.source, generation, 6n);
        expect(lastCall("append_audio_archive_generation").args).toEqual({
            archiveToken: "tok-persist",
            expectedSize: "132",
            generation: "6",
            bytes: Array.from(generation),
        });
    });

    it("rejects generations from unauthorized, expired or oversized handles", async () => {
        const generation = new Uint8Array(32);

        await expect(
            persistMicrophoneArchiveGeneration(
                new MemoryArchiveSource(new Uint8Array(1)),
                generation,
                1n,
            ),
        ).rejects.toThrow(
            "The microphone archive no longer has an authorized desktop file handle.",
        );

        const opened = await openDesktopArchive("tok-expired", 100n);
        await opened.source.close?.();
        await expect(
            persistMicrophoneArchiveGeneration(opened.source, generation, 1n),
        ).rejects.toThrow(
            "The microphone archive capability has expired. Reopen the archive to continue.",
        );

        const small = await openDesktopArchive("tok-small", 100n);
        await expect(
            persistMicrophoneArchiveGeneration(small.source, new Uint8Array(31), 1n),
        ).rejects.toThrow("A microphone archive checkpoint has an unsupported generation size.");
        await expect(
            persistMicrophoneArchiveGeneration(
                small.source,
                new Uint8Array(8 * 1024 * 1024 + 1),
                1n,
            ),
        ).rejects.toThrow("A microphone archive checkpoint has an unsupported generation size.");
    });

    it("rejects a published checkpoint size that does not match the generation", async () => {
        const opened = await openDesktopArchive("tok-size", 100n);
        setRoutes({ append_audio_archive_generation: () => ({ size: "999" }) });

        await expect(
            persistMicrophoneArchiveGeneration(opened.source, new Uint8Array(32), 1n),
        ).rejects.toThrow("The desktop archive writer published an unexpected checkpoint size.");
    });

    it("compacts a published composite chain onto the new disk handle", async () => {
        const opened = await openDesktopArchive("tok-compact", 100n);
        const originalBase = opened.source;
        const composite = {
            base: originalBase,
            appended: new MemoryArchiveSource(new Uint8Array([1, 2, 3])),
            size: 103n,
            read: async () => new Uint8Array(),
            close: async () => undefined,
        };
        setRoutes({
            append_audio_archive_generation: (args) => {
                const { expectedSize, bytes } = args as { expectedSize: string; bytes: number[] };
                return { size: (BigInt(expectedSize) + BigInt(bytes.length)).toString() };
            },
        });

        await persistMicrophoneArchiveGeneration(composite, new Uint8Array(32), 1n);

        expect(composite.base).not.toBe(originalBase);
        expect(composite.base.size).toBe(132n);
        expect(composite.appended.size).toBe(0n);
        expect(composite.size).toBe(132n);

        setRoutes({ read_archive_range: () => new ArrayBuffer(2) });
        await composite.base.read(0n, 2);
        expect(lastCall("read_archive_range").args).toEqual({
            archiveToken: "tok-compact",
            offset: "0",
            length: 2,
        });
    });

    it("leaves non-composite sources and incomplete composites untouched", async () => {
        const opened = await openDesktopArchive("tok-plain", 100n);
        setRoutes({
            append_audio_archive_generation: (args) => {
                const { expectedSize, bytes } = args as { expectedSize: string; bytes: number[] };
                return { size: (BigInt(expectedSize) + BigInt(bytes.length)).toString() };
            },
        });

        await persistMicrophoneArchiveGeneration(opened.source, new Uint8Array(32), 1n);

        const missingAppended = {
            base: opened.source,
            size: 132n,
            read: async () => new Uint8Array(),
        };
        await persistMicrophoneArchiveGeneration(
            missingAppended as unknown as ArchiveByteSource,
            new Uint8Array(32),
            2n,
        );
        expect(missingAppended.base).toBe(opened.source);

        const missingSize = {
            base: opened.source,
            appended: new MemoryArchiveSource(new Uint8Array()),
            read: async () => new Uint8Array(),
        };
        await persistMicrophoneArchiveGeneration(
            missingSize as unknown as ArchiveByteSource,
            new Uint8Array(32),
            3n,
        );
        expect(missingSize.base).toBe(opened.source);
    });

    it("reports a composite that refuses to release its checkpoint chain", async () => {
        const opened = await openDesktopArchive("tok-locked", 100n);
        setRoutes({
            append_audio_archive_generation: (args) => {
                const { expectedSize, bytes } = args as { expectedSize: string; bytes: number[] };
                return { size: (BigInt(expectedSize) + BigInt(bytes.length)).toString() };
            },
        });

        const locked = (field: "base" | "appended" | "size", size: bigint) => {
            const composite = {
                base: opened.source,
                appended: new MemoryArchiveSource(new Uint8Array()),
                size: 103n,
                read: async () => new Uint8Array(),
            };
            const value =
                field === "base"
                    ? opened.source
                    : field === "appended"
                      ? new MemoryArchiveSource(new Uint8Array())
                      : size;
            Object.defineProperty(composite, field, {
                value,
                writable: false,
                configurable: true,
                enumerable: true,
            });
            return composite;
        };

        for (const field of ["base", "appended", "size"] as const) {
            const composite = locked(field, 1n);
            await expect(
                persistMicrophoneArchiveGeneration(
                    composite as unknown as ArchiveByteSource,
                    new Uint8Array(32),
                    1n,
                ),
            ).rejects.toThrow(
                "The saved archive snapshot could not release its in-memory checkpoint chain.",
            );
        }
    });
});

describe("command console", () => {
    it("streams matching output, completes, unlistens and cancels", async () => {
        const opened = await openDesktopArchive("tok-console", 10n);
        vi.spyOn(crypto, "randomUUID").mockReturnValue(UUID_ONE);
        const result = { exitCode: 0, cancelled: false, archiveChanged: true };
        setRoutes({ run_command_console: () => result });

        const output: string[] = [];
        const run = await platform.startCommandConsole!(
            opened.source,
            "create",
            "pass",
            "next",
            (text) => output.push(text),
        );

        expect(lastCall("run_command_console").args).toEqual({
            runId: UUID_ONE,
            archiveToken: "tok-console",
            input: "create",
            passphrase: "pass",
            newPassphrase: "next",
        });

        const listener = harness.listeners.find(
            (entry) => entry.event === "tutorux:console-output",
        );
        if (!listener) throw new Error("Missing console listener");
        listener.handler({ payload: { runId: "other", text: "ignored" } });
        listener.handler({ payload: { runId: UUID_ONE, text: "line one" } });
        expect(output).toEqual(["line one"]);

        await expect(run.completion).resolves.toEqual(result);
        expect(listener.unlisten).toHaveBeenCalledTimes(1);

        await run.cancel();
        expect(lastCall("cancel_command_console").args).toEqual({ runId: UUID_ONE });
    });

    it("unlistens when the console run fails", async () => {
        const opened = await openDesktopArchive("tok-console-fail", 10n);
        vi.spyOn(crypto, "randomUUID").mockReturnValue(UUID_ONE);
        setRoutes({
            run_command_console: () => {
                throw new Error("console crashed");
            },
        });

        const run = await platform.startCommandConsole!(opened.source, "", "", "", () => undefined);
        await expect(run.completion).rejects.toThrow("console crashed");
        expect(harness.listeners[0]?.unlisten).toHaveBeenCalledTimes(1);
    });

    it("refuses to run against a source without a desktop handle", async () => {
        await expect(
            platform.startCommandConsole!(
                new MemoryArchiveSource(new Uint8Array(1)),
                "",
                "",
                "",
                () => undefined,
            ),
        ).rejects.toThrow("The selected archive no longer has an authorized desktop file handle.");
        expect(invokeCalls("run_command_console")).toHaveLength(0);
    });

    it("reports console availability", async () => {
        const availability = { available: false, message: "unsupported" };
        setRoutes({ command_console_availability: () => availability });

        await expect(platform.commandConsoleAvailability!()).resolves.toEqual(availability);
        expect(lastCall("command_console_availability").args).toBeUndefined();
    });
});

describe("openArchive", () => {
    it("authorizes the selected path with the desktop", async () => {
        harness.openResult = "C:/archive.tux";
        setRoutes({
            authorize_archive_path: () => ({ token: "tok-open", size: "7", name: "archive.tux" }),
        });

        const opened = await platform.openArchive();

        expect(opened?.name).toBe("archive.tux");
        expect(opened?.location).toBe("C:/archive.tux");
        expect(opened?.source.size).toBe(7n);
        expect(harness.openCalls[0]).toEqual({
            title: "Open Tutorux archive",
            multiple: false,
            filters: [{ name: "Tutorux archive", extensions: ["tux"] }],
        });
        expect(lastCall("authorize_archive_path").args).toEqual({ path: "C:/archive.tux" });
    });

    it("returns null when the picker is dismissed or multi-select is impossible", async () => {
        harness.openResult = null;
        await expect(platform.openArchive()).resolves.toBeNull();
        expect(invokeCalls("authorize_archive_path")).toHaveLength(0);

        harness.openResult = [];
        await expect(platform.openArchive()).resolves.toBeNull();
        expect(invokeCalls("authorize_archive_path")).toHaveLength(0);
    });
});

describe("saveArchive", () => {
    it("writes the chosen location and publishes it", async () => {
        const source = new MemoryArchiveSource(new Uint8Array([1, 2, 3, 4, 5]));
        setRoutes({
            prepare_archive_save: () => ({ token: "save-token", temporaryPath: "C:/tmp/out" }),
        });

        const result = await platform.saveArchive(source, "notes.tux", "C:/chosen.tux");

        expect(result).toBe("C:/chosen.tux");
        expect(harness.saveCalls).toHaveLength(0);
        expect(lastCall("prepare_archive_save").args).toEqual({
            targetPath: "C:/chosen.tux",
            archiveToken: null,
            createOnly: false,
            kind: "archive",
        });
        expect(harness.writes[0]?.path).toBe("C:/tmp/out");
        expect(harness.writes[0]?.options).toEqual({ create: true });
        await expect(
            drain(harness.writes[0]?.payload as ReadableStream<Uint8Array>),
        ).resolves.toEqual(new Uint8Array([1, 2, 3, 4, 5]));
        expect(lastCall("publish_archive_save").args).toEqual({ token: "save-token" });
    });

    it("asks for a destination and returns null when the picker is dismissed", async () => {
        harness.saveResult = null;
        await expect(
            platform.saveArchive(new MemoryArchiveSource(new Uint8Array(1)), "a.tux"),
        ).resolves.toBeNull();

        expect(harness.saveCalls[0]).toEqual({
            title: "Save Tutorux archive",
            defaultPath: "a.tux",
            filters: [{ name: "Tutorux archive", extensions: ["tux"] }],
        });
        expect(invokeCalls("prepare_archive_save")).toHaveLength(0);
    });

    it("re-authorizes a rebuilt archive and attaches the cleanup hook", async () => {
        const closeSource = vi.fn(async () => undefined);
        const source = {
            size: 2n,
            read: async () => new Uint8Array(2),
            close: closeSource,
        };
        harness.saveResult = "C:/out/rebuilt.tux";
        setRoutes({
            prepare_archive_save: () => ({ token: "tmp-token", temporaryPath: "C:/tmp/rebuilt" }),
            authorize_archive_path: () => ({ token: "reopened", size: "2", name: "rebuilt.tux" }),
        });

        const result = await platform.saveArchive(source, "rebuilt.tux");

        expect(result).toBe("C:/out/rebuilt.tux");
        expect(lastCall("prepare_archive_save").args).toMatchObject({ archiveToken: null });
        expect(lastCall("authorize_archive_path").args).toEqual({ path: "C:/out/rebuilt.tux" });
        expect(hasDesktopArchiveCapability(source)).toBe(true);

        await source.close();
        expect(closeSource).toHaveBeenCalledTimes(1);
        expect(lastCall("close_archive").args).toEqual({ archiveToken: "reopened" });
    });

    it("attaches cleanup for a rebuilt archive without an original close hook", async () => {
        const source: ArchiveByteSource = { size: 2n, read: async () => new Uint8Array(2) };
        harness.saveResult = "C:/out/plain.tux";
        setRoutes({
            prepare_archive_save: () => ({ token: "tmp-token", temporaryPath: "C:/tmp/plain" }),
            authorize_archive_path: () => ({
                token: "plain-reopened",
                size: "2",
                name: "plain.tux",
            }),
        });

        await platform.saveArchive(source, "plain.tux");

        await source.close?.();
        expect(lastCall("close_archive").args).toEqual({ archiveToken: "plain-reopened" });
    });

    it("keeps the saved result when re-authorization fails", async () => {
        const source = new MemoryArchiveSource(new Uint8Array([1, 2]));
        harness.saveResult = "C:/out/kept.tux";
        setRoutes({
            prepare_archive_save: () => ({ token: "tmp-token", temporaryPath: "C:/tmp/kept" }),
            authorize_archive_path: () => {
                throw new Error("reopen failed");
            },
        });

        await expect(platform.saveArchive(source, "kept.tux")).resolves.toBe("C:/out/kept.tux");
        expect(hasDesktopArchiveCapability(source)).toBe(false);
    });

    it("keeps the saved result when the cleanup hook cannot be attached", async () => {
        const source = { size: 1n, read: async () => new Uint8Array(1) };
        Object.defineProperty(source, "close", {
            value: async () => undefined,
            writable: false,
            configurable: true,
            enumerable: true,
        });
        harness.saveResult = "C:/out/locked.tux";
        setRoutes({
            prepare_archive_save: () => ({ token: "tmp-token", temporaryPath: "C:/tmp/locked" }),
            authorize_archive_path: () => ({
                token: "locked-reopened",
                size: "1",
                name: "locked.tux",
            }),
        });

        await expect(platform.saveArchive(source, "locked.tux")).resolves.toBe("C:/out/locked.tux");
    });

    it("updates the recorded size when saving an authorized source", async () => {
        const opened = await openDesktopArchive("tok-authorized-save", 3n);
        setRoutes({
            prepare_archive_save: () => ({
                token: "save-token",
                temporaryPath: "C:/tmp/authorized",
            }),
            append_audio_archive_generation: (args) => {
                const { expectedSize, bytes } = args as { expectedSize: string; bytes: number[] };
                return { size: (BigInt(expectedSize) + BigInt(bytes.length)).toString() };
            },
        });

        await expect(
            platform.saveArchive(opened.source, "notes.tux", "C:/saved.tux"),
        ).resolves.toBe("C:/saved.tux");
        expect(lastCall("prepare_archive_save").args).toEqual({
            targetPath: "C:/saved.tux",
            archiveToken: "tok-authorized-save",
            createOnly: false,
            kind: "archive",
        });

        await persistMicrophoneArchiveGeneration(opened.source, new Uint8Array(32), 1n);
        expect(lastCall("append_audio_archive_generation").args).toMatchObject({
            archiveToken: "tok-authorized-save",
            expectedSize: "3",
        });
    });

    it("cancels the staged save when writing fails", async () => {
        const source = new MemoryArchiveSource(new Uint8Array([1]));
        harness.saveResult = "C:/out/fail.tux";
        harness.writeHandler = async () => {
            throw new Error("disk full");
        };
        setRoutes({
            prepare_archive_save: () => ({ token: "cancel-token", temporaryPath: "C:/tmp/fail" }),
        });

        await expect(platform.saveArchive(source, "fail.tux")).rejects.toThrow("disk full");
        expect(lastCall("cancel_archive_save").args).toEqual({ token: "cancel-token" });
        expect(invokeCalls("publish_archive_save")).toHaveLength(0);
    });

    it("reports the original failure even when cancellation also fails", async () => {
        const source = new MemoryArchiveSource(new Uint8Array([1]));
        harness.saveResult = "C:/out/fail2.tux";
        harness.writeHandler = async () => {
            throw new Error("disk full");
        };
        setRoutes({
            prepare_archive_save: () => ({ token: "cancel-token", temporaryPath: "C:/tmp/fail2" }),
            cancel_archive_save: () => {
                throw new Error("cancel failed");
            },
        });

        await expect(platform.saveArchive(source, "fail2.tux")).rejects.toThrow("disk full");
    });
});

describe("exportTextFile", () => {
    it("exports JSON with the JSON filter", async () => {
        harness.saveResult = "C:/out/data.json";
        await platform.exportTextFile("data.json", '{"a":1}', "application/json; charset=utf-8");

        expect(harness.saveCalls[0]).toEqual({
            title: "Export JSON file",
            defaultPath: "data.json",
            filters: [{ name: "JSON file", extensions: ["json"] }],
        });
        expect(lastCall("write_export_file").args).toEqual({
            path: "C:/out/data.json",
            contents: '{"a":1}',
        });
    });

    it("exports HTML with the HTML filter", async () => {
        harness.saveResult = "C:/out/guide.html";
        await platform.exportTextFile("guide.html", "<p>hi</p>", "text/html; charset=utf-8");

        expect(harness.saveCalls[0]).toEqual({
            title: "Export study guide as HTML",
            defaultPath: "guide.html",
            filters: [{ name: "HTML document", extensions: ["html"] }],
        });
    });

    it("falls back to a text export and keeps a dotless extension", async () => {
        harness.saveResult = "C:/out/notes";
        await platform.exportTextFile("notes", "hello", "text/plain");

        expect(harness.saveCalls[0]).toEqual({
            title: "Export text file",
            defaultPath: "notes",
            filters: [{ name: "Text file", extensions: ["notes"] }],
        });
    });

    it("returns null without writing when the picker is dismissed", async () => {
        harness.saveResult = null;
        await expect(platform.exportTextFile("x.txt", "x", "text/plain")).resolves.toBeNull();
        expect(invokeCalls("write_export_file")).toHaveLength(0);
    });
});

describe("exportBinaryFile", () => {
    it("streams a WAV payload from its supplier", async () => {
        const payload = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([9, 9]));
                controller.close();
            },
        });
        const supplier = vi.fn(async () => payload);
        harness.saveResult = "C:/out/track.wav";
        setRoutes({
            prepare_archive_save: () => ({ token: "wav-token", temporaryPath: "C:/tmp/wav" }),
        });

        await expect(platform.exportBinaryFile("track.wav", supplier, "audio/wav")).resolves.toBe(
            "C:/out/track.wav",
        );

        expect(supplier).toHaveBeenCalledTimes(1);
        expect(harness.saveCalls[0]).toEqual({
            title: "Export audio track",
            defaultPath: "track.wav",
            filters: [{ name: "WAV audio", extensions: ["wav"] }],
        });
        expect(lastCall("prepare_archive_save").args).toEqual({
            targetPath: "C:/out/track.wav",
            archiveToken: null,
            createOnly: false,
            kind: "export",
        });
        expect(harness.writes[0]?.payload).toBe(payload);
        expect(lastCall("publish_archive_save").args).toEqual({ token: "wav-token" });
    });

    it("writes a DOCX payload supplied directly", async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        harness.saveResult = "C:/out/guide.docx";
        setRoutes({
            prepare_archive_save: () => ({ token: "docx-token", temporaryPath: "C:/tmp/docx" }),
        });

        await platform.exportBinaryFile(
            "guide.docx",
            bytes,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );

        expect(harness.saveCalls[0]).toEqual({
            title: "Export study guide as Word",
            defaultPath: "guide.docx",
            filters: [{ name: "Word document", extensions: ["docx"] }],
        });
        expect(harness.writes[0]?.payload).toBe(bytes);
    });

    it("uses the generic material filter and dotless extension", async () => {
        harness.saveResult = "C:/out/material";
        setRoutes({
            prepare_archive_save: () => ({ token: "bin-token", temporaryPath: "C:/tmp/bin" }),
        });

        await platform.exportBinaryFile("material", new Uint8Array([1]), "application/pdf");

        expect(harness.saveCalls[0]).toEqual({
            title: "Export material",
            defaultPath: "material",
            filters: [{ name: "Material", extensions: ["material"] }],
        });
    });

    it("returns null without staging when the picker is dismissed", async () => {
        harness.saveResult = null;
        await expect(
            platform.exportBinaryFile("x.wav", new Uint8Array(1), "audio/wav"),
        ).resolves.toBeNull();
        expect(invokeCalls("prepare_archive_save")).toHaveLength(0);
    });

    it("cancels the staged export when writing fails", async () => {
        harness.saveResult = "C:/out/fail.wav";
        harness.writeHandler = async () => {
            throw new Error("write failed");
        };
        setRoutes({
            prepare_archive_save: () => ({ token: "fail-token", temporaryPath: "C:/tmp/fail" }),
            cancel_archive_save: () => {
                throw new Error("cancel failed");
            },
        });

        await expect(
            platform.exportBinaryFile("fail.wav", new Uint8Array(1), "audio/wav"),
        ).rejects.toThrow("write failed");
        expect(lastCall("cancel_archive_save").args).toEqual({ token: "fail-token" });
    });
});

describe("chooseSanitizedCopyDestination", () => {
    it("stages, appends and publishes the sanitized archive", async () => {
        const handle = makeFileHandle();
        harness.saveResult = "C:/out/copy.tux";
        harness.openFileHandler = () => handle;
        setRoutes({
            prepare_archive_save: () => ({ token: "copy-token", temporaryPath: "C:/tmp/copy" }),
        });

        const destination = await platform.chooseSanitizedCopyDestination("copy.tux");
        if (!destination) throw new Error("Expected a destination");
        const source = new MemoryArchiveSource(new Uint8Array(1024 * 1024 + 10));

        expect(destination.label).toBe("C:/out/copy.tux");
        expect(harness.saveCalls[0]).toEqual({
            title: "Create sanitized Tutorux archive",
            defaultPath: "copy.tux",
            filters: [{ name: "Tutorux archive", extensions: ["tux"] }],
        });

        await destination.checkpoint(source, 0n);

        expect(lastCall("prepare_archive_save").args).toEqual({
            targetPath: "C:/out/copy.tux",
            archiveToken: null,
            createOnly: true,
            kind: "archive",
        });
        expect(harness.opens[0]).toEqual({
            path: "C:/tmp/copy",
            options: { append: true, create: true },
        });
        expect(handle.writes.map((bytes) => bytes.byteLength)).toEqual([1024 * 1024, 10]);

        await destination.checkpoint(source, source.size);
        expect(invokeCalls("prepare_archive_save")).toHaveLength(1);
        expect(handle.writes).toHaveLength(2);

        await expect(destination.publish(source)).resolves.toBe("C:/out/copy.tux");
        expect(handle.close).toHaveBeenCalledTimes(1);
        expect(lastCall("publish_archive_save").args).toEqual({ token: "copy-token" });

        await expect(destination.checkpoint(source, source.size)).rejects.toThrow(
            "This copy destination is no longer available.",
        );
        await expect(destination.publish(source)).rejects.toThrow(
            "This copy destination is no longer available.",
        );
        await destination.cancel();
        expect(invokeCalls("cancel_archive_save")).toHaveLength(0);
    });

    it("returns null when the destination picker is dismissed", async () => {
        harness.saveResult = null;
        await expect(platform.chooseSanitizedCopyDestination("copy.tux")).resolves.toBeNull();
    });

    it("rejects out-of-order and impossible checkpoints", async () => {
        harness.saveResult = "C:/out/order.tux";
        harness.openFileHandler = () => makeFileHandle();
        setRoutes({
            prepare_archive_save: () => ({ token: "order-token", temporaryPath: "C:/tmp/order" }),
        });
        const destination = await platform.chooseSanitizedCopyDestination("order.tux");
        if (!destination) throw new Error("Expected a destination");

        await expect(
            destination.checkpoint(new MemoryArchiveSource(new Uint8Array(4)), 1n),
        ).rejects.toThrow("Sanitized archive checkpoints arrived out of order.");

        const negative = { size: -1n, read: async () => new Uint8Array() };
        await expect(destination.checkpoint(negative, 0n)).rejects.toThrow(
            "Sanitized archive checkpoints arrived out of order.",
        );
    });

    it("rejects short checkpoint reads and truncated writes", async () => {
        harness.saveResult = "C:/out/short.tux";
        harness.openFileHandler = () => makeFileHandle();
        setRoutes({
            prepare_archive_save: () => ({ token: "short-token", temporaryPath: "C:/tmp/short" }),
        });

        const shortRead = await platform.chooseSanitizedCopyDestination("short.tux");
        if (!shortRead) throw new Error("Expected a destination");
        const incomplete = { size: 5n, read: async () => new Uint8Array(4) };
        await expect(shortRead.checkpoint(incomplete, 0n)).rejects.toThrow(
            "The sanitized archive returned an incomplete checkpoint range.",
        );

        const shortWrite = await platform.chooseSanitizedCopyDestination("short.tux");
        if (!shortWrite) throw new Error("Expected a destination");
        harness.openFileHandler = () => ({
            write: async () => 1,
            close: async () => undefined,
        });
        await expect(
            shortWrite.checkpoint(new MemoryArchiveSource(new Uint8Array(2)), 0n),
        ).rejects.toThrow("The sanitized archive checkpoint was truncated.");
    });

    it("refuses to publish without complete staging", async () => {
        harness.saveResult = "C:/out/publish.tux";
        harness.openFileHandler = () => makeFileHandle();
        setRoutes({
            prepare_archive_save: () => ({ token: "publish-token", temporaryPath: "C:/tmp/pub" }),
        });

        const empty = await platform.chooseSanitizedCopyDestination("publish.tux");
        if (!empty) throw new Error("Expected a destination");
        await expect(empty.publish(new MemoryArchiveSource(new Uint8Array(1)))).rejects.toThrow(
            "The sanitized archive has not been completely staged.",
        );

        const partial = await platform.chooseSanitizedCopyDestination("publish.tux");
        if (!partial) throw new Error("Expected a destination");
        await partial.checkpoint(new MemoryArchiveSource(new Uint8Array(3)), 0n);
        await expect(partial.publish(new MemoryArchiveSource(new Uint8Array(4)))).rejects.toThrow(
            "The sanitized archive has not been completely staged.",
        );
    });

    it("reports staged-but-unopened destinations and closes tolerantly when canceled", async () => {
        harness.saveResult = "C:/out/openfail.tux";
        setRoutes({
            prepare_archive_save: () => ({ token: "openfail-token", temporaryPath: "C:/tmp/of" }),
        });
        let attempts = 0;
        harness.openFileHandler = () => {
            attempts += 1;
            if (attempts === 1) throw new Error("open failed");
            return makeFileHandle(true);
        };

        const destination = await platform.chooseSanitizedCopyDestination("openfail.tux");
        if (!destination) throw new Error("Expected a destination");
        const source = new MemoryArchiveSource(new Uint8Array(2));
        await expect(destination.checkpoint(source, 0n)).rejects.toThrow("open failed");
        await expect(destination.publish(source)).rejects.toThrow(
            "The sanitized archive has not been completely staged.",
        );
        await destination.cancel();
        expect(lastCall("cancel_archive_save").args).toEqual({ token: "openfail-token" });
    });

    it("swallows a failing close while canceling a staged destination", async () => {
        harness.saveResult = "C:/out/cancel.tux";
        harness.openFileHandler = () => makeFileHandle(true);
        setRoutes({
            prepare_archive_save: () => ({ token: "cancel-token", temporaryPath: "C:/tmp/cancel" }),
        });

        const destination = await platform.chooseSanitizedCopyDestination("cancel.tux");
        if (!destination) throw new Error("Expected a destination");
        await destination.checkpoint(new MemoryArchiveSource(new Uint8Array(2)), 0n);
        setRoutes({
            cancel_archive_save: () => {
                throw new Error("cancel rejected");
            },
        });

        await destination.cancel();
        expect(lastCall("cancel_archive_save").args).toEqual({ token: "cancel-token" });
    });

    it("cancels a destination that never staged anything", async () => {
        harness.saveResult = "C:/out/empty.tux";
        const destination = await platform.chooseSanitizedCopyDestination("empty.tux");
        if (!destination) throw new Error("Expected a destination");

        await destination.cancel();
        expect(invokeCalls("cancel_archive_save")).toHaveLength(0);
    });
});

describe("AI transport", () => {
    it("sends Replicate requests, decodes chunks, then clears the cancellation target", async () => {
        const requestId = UUID_ONE;
        vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
        setRoutes({ send_ai_request: () => transportResult });
        const chunks: Uint8Array[] = [];

        const result = await platform.sendAiRequest(replicateRequest, (chunk) =>
            chunks.push(chunk),
        );

        expect(result).toEqual(transportResult);
        expect(invokeCalls("send_ai_request")).toHaveLength(1);
        expect(lastCall("send_ai_request").args).toEqual({
            request: { ...replicateRequest, replicateRequestId: requestId },
            onChunk: harness.channels.at(-1),
        });

        const channel = harness.channels.at(-1);
        channel?.onmessage?.({ kind: "chunk", base64: base64([1, 2, 3]) });
        expect(Array.from(chunks[0] ?? [])).toEqual([1, 2, 3]);

        if (!harness.replicateHandler) throw new Error("Missing cancellation handler");
        await harness.replicateHandler();
        expect(invokeCalls("send_ai_request")).toHaveLength(1);
    });

    it("cancels the active Replicate prediction", async () => {
        vi.spyOn(crypto, "randomUUID").mockReturnValue(UUID_ONE);
        let resolveSend: (value: unknown) => void = () => undefined;
        harness.handler = async (command, args) => {
            if (command !== "send_ai_request") return undefined;
            const request = (args as { request: { cancelReplicateRequest?: boolean } }).request;
            if (request.cancelReplicateRequest) return undefined;
            return new Promise((resolve) => {
                resolveSend = resolve;
            });
        };

        const pending = platform.sendAiRequest(replicateRequest, () => undefined);
        if (!harness.replicateHandler) throw new Error("Missing cancellation handler");
        await harness.replicateHandler();

        const calls = invokeCalls("send_ai_request");
        expect(calls).toHaveLength(2);
        expect(calls[1]?.args).toEqual({
            request: {
                providerId: "replicate",
                replicateRequestId: UUID_ONE,
                cancelReplicateRequest: true,
            },
            onChunk: harness.channels.at(-1),
        });

        resolveSend(transportResult);
        await expect(pending).resolves.toEqual(transportResult);

        await harness.replicateHandler();
        expect(invokeCalls("send_ai_request")).toHaveLength(2);
    });

    it("keeps a newer Replicate request active when an older one settles", async () => {
        vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(UUID_ONE).mockReturnValueOnce(UUID_TWO);
        const resolvers: ((value: unknown) => void)[] = [];
        harness.handler = async (command, args) => {
            if (command !== "send_ai_request") return undefined;
            const request = (args as { request: { cancelReplicateRequest?: boolean } }).request;
            if (request.cancelReplicateRequest) return undefined;
            return new Promise((resolve) => resolvers.push(resolve));
        };

        const first = platform.sendAiRequest(replicateRequest, () => undefined);
        const second = platform.sendAiRequest(replicateRequest, () => undefined);
        resolvers[0]?.(transportResult);
        await expect(first).resolves.toEqual(transportResult);

        if (!harness.replicateHandler) throw new Error("Missing cancellation handler");
        await harness.replicateHandler();
        expect(invokeCalls("send_ai_request")[2]?.args).toMatchObject({
            request: { replicateRequestId: UUID_TWO, cancelReplicateRequest: true },
        });

        resolvers[1]?.(transportResult);
        await expect(second).resolves.toEqual(transportResult);
        const settledCalls = invokeCalls("send_ai_request").length;
        await harness.replicateHandler();
        expect(invokeCalls("send_ai_request")).toHaveLength(settledCalls);
    });

    it("surfaces Replicate failures and still clears the cancellation target", async () => {
        vi.spyOn(crypto, "randomUUID").mockReturnValue(UUID_ONE);
        setRoutes({
            send_ai_request: () => {
                throw new Error("transport down");
            },
        });

        await expect(platform.sendAiRequest(replicateRequest, () => undefined)).rejects.toThrow(
            "transport down",
        );
        if (!harness.replicateHandler) throw new Error("Missing cancellation handler");
        await harness.replicateHandler();
        expect(invokeCalls("send_ai_request")).toHaveLength(1);
    });

    it("routes embedded GGUF requests to the in-process runtime", async () => {
        const request: AiTransportRequest = { ...transportRequest, providerId: "embedded-gguf" };
        const expected = { ...transportResult, responseBytes: 0 };
        harness.embeddedResult = expected;
        const onChunk = vi.fn();

        await expect(platform.sendAiRequest(request, onChunk)).resolves.toEqual(expected);

        expect(harness.embeddedRequests).toHaveLength(1);
        expect(harness.embeddedRequests[0]?.request).toBe(request);
        expect(harness.embeddedRequests[0]?.onChunk).toBe(onChunk);
        expect(invokeCalls("send_ai_request")).toHaveLength(0);
    });

    it("sends other providers through the desktop transport", async () => {
        setRoutes({ send_ai_request: () => transportResult });
        const chunks: Uint8Array[] = [];

        await platform.sendAiRequest(transportRequest, (chunk) => chunks.push(chunk));

        expect(lastCall("send_ai_request").args).toEqual({
            request: transportRequest,
            onChunk: harness.channels.at(-1),
        });
        harness.channels.at(-1)?.onmessage?.({
            kind: "chunk",
            base64: base64([255, 0]),
        });
        expect(Array.from(chunks[0] ?? [])).toEqual([255, 0]);
    });

    it("inspects Replicate models with an empty confirmed body", async () => {
        setRoutes({ send_ai_request: () => transportResult });
        const request: AiModelInspectionRequest = {
            model: "owner/name",
            credentialStorage: "system-keychain",
            credential: "secret",
        };
        const chunks: Uint8Array[] = [];

        await expect(
            platform.inspectReplicateModel(request, (chunk) => chunks.push(chunk)),
        ).resolves.toEqual(transportResult);

        expect(lastCall("send_ai_request").args).toEqual({
            request: {
                providerId: "replicate",
                endpoint: "https://api.replicate.com/models/owner/name",
                confirmedEndpoint: "https://api.replicate.com/models/owner/name",
                model: "owner/name",
                accept: "application/json",
                requestBody: "",
                requestBodyHash: "",
                confirmedBodyHash: "",
                credentialStorage: "system-keychain",
                credential: "secret",
                inspectReplicateModel: true,
            },
            onChunk: harness.channels.at(-1),
        });
        harness.channels.at(-1)?.onmessage?.({
            kind: "chunk",
            base64: base64([4, 5]),
        });
        expect(Array.from(chunks[0] ?? [])).toEqual([4, 5]);
    });
});

describe("desktop commands", () => {
    it("forwards credential, diagnostics and launch commands", async () => {
        const diagnostics = { os: "windows", architecture: "x64" } as unknown as DesktopDiagnostics;
        harness.saveResult = "C:/out/new.tux";
        setRoutes({
            ai_credential_store_available: () => true,
            get_desktop_diagnostics: () => diagnostics,
            has_ai_credential: () => true,
            take_pending_open_archive: () => "C:/launch.tux",
            authorize_archive_path: () => ({ token: "tok-launch", size: "3", name: "launch.tux" }),
        });

        expect(platform.kind).toBe("desktop");
        await expect(platform.aiCredentialStoreAvailable()).resolves.toBe(true);
        expect(lastCall("ai_credential_store_available").args).toBeUndefined();

        await expect(platform.desktopDiagnostics?.(true)).resolves.toBe(diagnostics);
        expect(lastCall("get_desktop_diagnostics").args).toEqual({ probeAudioEndpoints: true });

        await expect(platform.hasAiCredential("openai")).resolves.toBe(true);
        expect(lastCall("has_ai_credential").args).toEqual({ providerId: "openai" });

        await platform.saveAiCredential("openai", "key");
        expect(lastCall("save_ai_credential").args).toEqual({ providerId: "openai", value: "key" });

        await platform.removeAiCredential("openai");
        expect(lastCall("remove_ai_credential").args).toEqual({ providerId: "openai" });

        await expect(platform.createArchiveLocation("new.tux")).resolves.toBe("C:/out/new.tux");
        expect(harness.saveCalls[0]).toEqual({
            title: "Create Tutorux archive",
            defaultPath: "new.tux",
            filters: [{ name: "Tutorux archive", extensions: ["tux"] }],
        });

        const opened = await platform.openLaunchArchive?.();
        expect(lastCall("take_pending_open_archive").args).toBeUndefined();
        expect(opened?.source.size).toBe(3n);
        expect(lastCall("authorize_archive_path").args).toEqual({ path: "C:/launch.tux" });
    });

    it("returns null when no launch archive is pending and reopens explicit paths", async () => {
        setRoutes({
            take_pending_open_archive: () => null,
            authorize_archive_path: () => ({ token: "tok-path", size: "4", name: "path.tux" }),
        });

        await expect(platform.openLaunchArchive?.()).resolves.toBeNull();
        expect(invokeCalls("authorize_archive_path")).toHaveLength(0);

        const reopened = await platform.reopenArchiveAtPath?.("C:/path.tux");
        expect(reopened?.name).toBe("path.tux");
        expect(lastCall("authorize_archive_path").args).toEqual({ path: "C:/path.tux" });
    });
});

describe("notifications and native commands", () => {
    it("dispatches notices with the default and explicit tone", () => {
        const dispatch = vi.fn();
        vi.stubGlobal("window", { dispatchEvent: dispatch });

        platform.notify("Saved");
        platform.notify("Failed", "error");

        expect(dispatch).toHaveBeenCalledTimes(2);
        const first = dispatch.mock.calls[0]?.[0] as CustomEvent;
        const second = dispatch.mock.calls[1]?.[0] as CustomEvent;
        expect(first.type).toBe("tutorux:notice");
        expect(first.detail).toEqual({ message: "Saved", tone: "info" });
        expect(second.detail).toEqual({ message: "Failed", tone: "error" });
    });

    it("registers native command listeners", async () => {
        const handler = vi.fn();
        const unlisten = await platform.onNativeCommand?.(handler);

        expect(harness.listeners[0]?.event).toBe("tutorux:native-command");
        harness.listeners[0]?.handler({ payload: "save" });
        expect(handler).toHaveBeenCalledWith("save");
        expect(unlisten).toBeTypeOf("function");
    });
});
