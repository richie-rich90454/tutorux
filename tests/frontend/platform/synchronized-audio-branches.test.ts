import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const eventBus = vi.hoisted(() => ({
    listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: (command: string, args?: unknown) =>
        (
            globalThis as unknown as {
                window: {
                    __TAURI__: {
                        core: {
                            invoke: (command: string, args?: unknown) => Promise<unknown>;
                        };
                    };
                };
            }
        ).window.__TAURI__.core.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: async (
        name: string,
        handler: (event: { payload: unknown }) => void,
    ): Promise<() => void> => {
        eventBus.listeners.set(name, handler);
        return () => {
            eventBus.listeners.delete(name);
        };
    },
}));

import {
    startNativeSynchronizedAudioCapture,
    type NativeSynchronizedAudioArchiveHooks,
    type NativeSynchronizedAudioStarted,
} from "../../../frontend/platform/synchronized-audio";

const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = "1700000000000000";
const CHUNK_EVENT = "synchronized-audio-chunk";
const FAILURE_EVENT = "synchronized-audio-source-failed";

type InvokeHandler = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let invokeHandler: InvokeHandler;
let calls: { command: string; args: Record<string, unknown> | undefined }[];

const tauriWindow = globalThis as unknown as {
    window: {
        __TAURI__: {
            core: {
                invoke: (command: string, args?: unknown) => Promise<unknown>;
            };
        };
    };
};

beforeEach(() => {
    eventBus.listeners.clear();
    calls = [];
    invokeHandler = async () => undefined;
    tauriWindow.window = {
        __TAURI__: {
            core: {
                invoke: (command, args) => {
                    calls.push({ command, args: args as Record<string, unknown> | undefined });
                    return invokeHandler(command, args as Record<string, unknown> | undefined);
                },
            },
        },
    };
});

afterEach(() => {
    vi.useRealTimers();
});

function started(
    overrides: Partial<NativeSynchronizedAudioStarted> = {},
): NativeSynchronizedAudioStarted {
    return {
        captureId: CAPTURE_ID,
        startedAtUs: TIMESTAMP,
        consentAtUs: TIMESTAMP,
        microphoneSampleRateHz: 16_000,
        systemAudioSampleRateHz: 0,
        applicationAudioSampleRateHz: 0,
        microphoneChannelCount: 1,
        microphoneSampleFormat: "pcm_s16le",
        backend: "native-audio-helper",
        ...overrides,
    };
}

function archiveHooks(): NativeSynchronizedAudioArchiveHooks {
    return {
        onStarted: vi.fn(async () => undefined),
        onChunk: vi.fn(async () => undefined),
        onPaused: vi.fn(async () => undefined),
        onResumed: vi.fn(async () => undefined),
        onFinished: vi.fn(async () => undefined),
    };
}

function base64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

function emit(name: string, payload: unknown): void {
    eventBus.listeners.get(name)?.({ payload });
}

function chunkEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        captureId: CAPTURE_ID,
        track: "microphone",
        sequence: 0,
        firstSampleIndex: "0",
        sampleRateHz: 16_000,
        frameCount: "1",
        channelCount: 1,
        sampleFormat: "pcm_s16le",
        gapBeforeSamples: "0",
        containsDeviceDiscontinuity: false,
        pcmBase64: base64(new Uint8Array([1, 0])),
        ...overrides,
    };
}

function trackSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        sampleRateHz: 16_000,
        sampleCount: "0",
        byteCount: "0",
        chunkCount: 0,
        channelCount: 1,
        sampleFormat: "pcm_s16le",
        ...overrides,
    };
}

async function startCapture(
    options: {
        started?: Partial<NativeSynchronizedAudioStarted>;
        systemAudioDeviceId?: string | null;
        applicationAudioDeviceId?: string | null;
        archive?: NativeSynchronizedAudioArchiveHooks;
        finish?: () => unknown;
        onSourceFailure?: (track: string, message: string) => void;
        handlers?: Partial<Record<string, InvokeHandler>>;
    } = {},
): Promise<{
    capture: Awaited<ReturnType<typeof startNativeSynchronizedAudioCapture>>;
    failures: [string, string][];
}> {
    const failures: [string, string][] = [];
    const native = started(options.started);
    invokeHandler = async (command) => {
        const custom = options.handlers?.[command];
        if (custom) return custom(command, undefined);
        switch (command) {
            case "begin_synchronized_audio_capture":
                return native;
            case "finish_synchronized_audio_capture":
                return options.finish ? options.finish() : finishedSummary();
            case "activate_synchronized_audio_capture":
            case "pause_synchronized_audio_capture":
            case "resume_synchronized_audio_capture":
            case "stop_synchronized_audio_source":
            case "discard_synchronized_audio_capture":
                return undefined;
            default:
                throw new Error(`unexpected ${command}`);
        }
    };
    const capture = await startNativeSynchronizedAudioCapture({
        consentConfirmed: true,
        consentAtUs: TIMESTAMP,
        microphoneDeviceId: "mic-1",
        systemAudioDeviceId: options.systemAudioDeviceId ?? null,
        applicationAudioDeviceId: options.applicationAudioDeviceId ?? null,
        captureId: CAPTURE_ID,
        archive: options.archive ?? archiveHooks(),
        onSourceFailure: (track, message) => {
            failures.push([track, message]);
            options.onSourceFailure?.(track, message);
        },
    });
    return { capture, failures };
}

function finishedSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        microphone: trackSummary(),
        systemAudio: trackSummary(),
        applicationAudio: trackSummary(),
        ...overrides,
    };
}

describe("synchronized audio failure aggregation", () => {
    it("keeps the first failure for a source that fails twice", async () => {
        const { capture, failures } = await startCapture();
        emit(FAILURE_EVENT, { captureId: CAPTURE_ID, track: "microphone", message: "unplugged" });
        emit(FAILURE_EVENT, { captureId: CAPTURE_ID, track: "microphone", message: "again" });
        expect(failures).toEqual([
            ["microphone", "unplugged"],
            ["microphone", "again"],
        ]);
        const result = await capture.stop();
        expect(result.warnings).toEqual(["microphone: unplugged"]);
    });

    it("records a queued archive failure that lands after the capture was discarded", async () => {
        let rejectChunk: ((error: unknown) => void) | undefined;
        const archive = archiveHooks();
        (archive.onChunk as ReturnType<typeof vi.fn>).mockImplementation(
            () =>
                new Promise<void>((_, reject) => {
                    rejectChunk = reject;
                }),
        );
        const { capture, failures } = await startCapture({ archive });
        emit(
            CHUNK_EVENT,
            chunkEvent({
                frameCount: "131072",
                pcmBase64: base64(new Uint8Array(262_144)),
            }),
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(rejectChunk).toBeTypeOf("function");
        await capture.discard();
        rejectChunk!(new Error("late checkpoint failure"));
        await Promise.resolve();
        await Promise.resolve();

        expect(failures).toEqual([
            ["microphone", "Archive checkpoint failed: late checkpoint failure"],
        ]);
        expect(
            calls.filter((call) => call.command === "stop_synchronized_audio_source"),
        ).toHaveLength(0);
    });
});

describe("synchronized audio batching", () => {
    it("splits audio at an exact 24-bit frame boundary and keeps the remainder staged", async () => {
        const archive = archiveHooks();
        const { capture, failures } = await startCapture({
            archive,
            started: {
                microphoneSampleRateHz: 48_000,
                microphoneSampleFormat: "pcm_s24le",
            },
            finish: () =>
                finishedSummary({
                    microphone: trackSummary({
                        sampleRateHz: 48_000,
                        sampleFormat: "pcm_s24le",
                        sampleCount: "87382",
                        chunkCount: 3,
                    }),
                }),
        });
        const emitChunk = (sequence: number, firstSampleIndex: string, frames: number) =>
            emit(
                CHUNK_EVENT,
                chunkEvent({
                    sequence,
                    firstSampleIndex,
                    sampleRateHz: 48_000,
                    sampleFormat: "pcm_s24le",
                    frameCount: String(frames),
                    pcmBase64: base64(new Uint8Array(frames * 3)),
                }),
            );
        emitChunk(0, "0", 43_691);
        emitChunk(1, "43691", 43_690);
        emitChunk(2, "87381", 1);

        const result = await capture.stop();

        expect(failures).toEqual([]);
        expect(result.warnings).toEqual([]);
        const chunks = (archive.onChunk as ReturnType<typeof vi.fn>).mock.calls;
        expect(chunks).toHaveLength(2);
        expect((chunks[0]![1] as { samples: Uint8Array }).samples.byteLength).toBe(262_143);
        expect((chunks[1]![1] as { samples: Uint8Array }).samples.byteLength).toBe(3);
    });

    it("reports every source whose samples were not checkpointed", async () => {
        const archive = archiveHooks();
        let emitted = false;
        (archive.onChunk as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            if (emitted) return;
            emitted = true;
            emit(CHUNK_EVENT, chunkEvent({ sequence: 1, firstSampleIndex: "1" }));
            emit(
                CHUNK_EVENT,
                chunkEvent({
                    track: "system-audio",
                    sequence: 1,
                    firstSampleIndex: "1",
                    sampleRateHz: 8_000,
                    sampleFormat: "pcm_u8",
                    frameCount: "1",
                    pcmBase64: base64(new Uint8Array(1)),
                }),
            );
            emit(
                CHUNK_EVENT,
                chunkEvent({
                    track: "application-audio",
                    sequence: 1,
                    firstSampleIndex: "1",
                    sampleRateHz: 24_000,
                    sampleFormat: "pcm_f32le",
                    channelCount: 2,
                    frameCount: "1",
                    pcmBase64: base64(new Uint8Array(8)),
                }),
            );
        });
        const { capture } = await startCapture({
            archive,
            started: {
                systemAudioSampleRateHz: 8_000,
                applicationAudioSampleRateHz: 24_000,
                systemAudioSampleFormat: "pcm_u8",
                applicationAudioSampleFormat: "pcm_f32le",
                applicationAudioChannelCount: 2,
            },
            systemAudioDeviceId: "system-1",
            applicationAudioDeviceId: "app-1",
            finish: () =>
                finishedSummary({
                    microphone: trackSummary({ sampleCount: "1", chunkCount: 1 }),
                    systemAudio: trackSummary({
                        sampleRateHz: 8_000,
                        sampleFormat: "pcm_u8",
                        sampleCount: "1",
                        chunkCount: 1,
                    }),
                    applicationAudio: trackSummary({
                        sampleRateHz: 24_000,
                        sampleFormat: "pcm_f32le",
                        channelCount: 2,
                        sampleCount: "1",
                        chunkCount: 1,
                    }),
                }),
        });
        emit(CHUNK_EVENT, chunkEvent());
        emit(
            CHUNK_EVENT,
            chunkEvent({
                track: "system-audio",
                sampleRateHz: 8_000,
                sampleFormat: "pcm_u8",
                pcmBase64: base64(new Uint8Array(1)),
            }),
        );
        emit(
            CHUNK_EVENT,
            chunkEvent({
                track: "application-audio",
                sampleRateHz: 24_000,
                sampleFormat: "pcm_f32le",
                channelCount: 2,
                pcmBase64: base64(new Uint8Array(8)),
            }),
        );

        const result = await capture.stop();

        expect(result.warnings).toEqual([
            "microphone: One or more microphone samples were not durably checkpointed.",
            "system-audio: One or more shared-audio samples were not durably checkpointed.",
            "application-audio: One or more application-audio samples were not durably checkpointed.",
        ]);
    });
});

describe("synchronized audio ignored native events", () => {
    it("ignores failure events for unknown or unselected sources", async () => {
        const { capture, failures } = await startCapture();
        emit(FAILURE_EVENT, { captureId: CAPTURE_ID, track: "unknown", message: "ignored" });
        emit(FAILURE_EVENT, {
            captureId: CAPTURE_ID,
            track: "application-audio",
            message: "not selected",
        });
        expect(failures).toEqual([]);
        await capture.discard();
    });

    it("ignores pause-drained events for another capture or pause cycle", async () => {
        const { capture } = await startCapture();
        emit("synchronized-audio-pause-drained", { captureId: "other", pauseId: 1 });
        emit("synchronized-audio-pause-drained", { captureId: CAPTURE_ID, pauseId: 7 });
        await capture.discard();
    });

    it("starts without a microphone rate when another source is available", async () => {
        const { capture, failures } = await startCapture({
            started: {
                microphoneSampleRateHz: 0,
                systemAudioSampleRateHz: 8_000,
                systemAudioSampleFormat: "pcm_s16le",
            },
            systemAudioDeviceId: "system-1",
        });
        expect(failures).toEqual([]);
        await capture.discard();
    });

    it("rejects the queued checkpoint when the failure callback throws", async () => {
        const archive = archiveHooks();
        (archive.onChunk as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk full"));
        const thrown: string[] = [];
        const { capture } = await startCapture({
            archive,
            onSourceFailure: (_track, message) => {
                thrown.push(message);
                throw new Error(`callback failed: ${message}`);
            },
        });
        emit(
            CHUNK_EVENT,
            chunkEvent({
                frameCount: "131072",
                pcmBase64: base64(new Uint8Array(262_144)),
            }),
        );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(thrown).toEqual(["Archive checkpoint failed: disk full"]);
        const result = await capture.stop();
        expect(result.warnings).toEqual(["microphone: Archive checkpoint failed: disk full"]);
    });
});

describe("synchronized audio pause errors", () => {
    it("wraps a non-Error pause failure in an Error for the draining pause", async () => {
        let rejectPause: ((error: unknown) => void) | undefined;
        let pauseCalls = 0;
        const { capture } = await startCapture({
            handlers: {
                pause_synchronized_audio_capture: () => {
                    pauseCalls += 1;
                    if (pauseCalls > 1) return Promise.resolve(undefined);
                    return new Promise((_, reject) => {
                        rejectPause = reject;
                    });
                },
            },
        });
        const first = capture.pause();
        const second = capture.pause();
        await Promise.resolve();
        await Promise.resolve();
        rejectPause!("pause exploded");
        await expect(first).rejects.toBe("pause exploded");
        await expect(second).rejects.toThrow("pause exploded");
        await capture.stop();
    });
});
