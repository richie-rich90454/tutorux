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
const MIC_RATE = 16_000;

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

type OptionalStartedKey = {
    [
        K in keyof NativeSynchronizedAudioStarted
    ]-?: undefined extends NativeSynchronizedAudioStarted[K] ? K : never;
}[keyof NativeSynchronizedAudioStarted];

function started(
    overrides: Partial<NativeSynchronizedAudioStarted> = {},
    omit: readonly OptionalStartedKey[] = [],
): NativeSynchronizedAudioStarted {
    const value: NativeSynchronizedAudioStarted = {
        captureId: CAPTURE_ID,
        startedAtUs: TIMESTAMP,
        consentAtUs: TIMESTAMP,
        microphoneSampleRateHz: MIC_RATE,
        systemAudioSampleRateHz: 0,
        applicationAudioSampleRateHz: 0,
        microphoneChannelCount: 1,
        microphoneSampleFormat: "pcm_s16le",
        backend: "native-audio-helper",
        ...overrides,
    };
    for (const key of omit) delete value[key];
    return value;
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

interface TrackSummary {
    sampleRateHz: number;
    sampleCount: string;
    byteCount: string;
    chunkCount: number;
    channelCount?: number;
    sampleFormat?: string;
    failure?: string | null;
}

function trackSummary(overrides: Partial<TrackSummary> = {}): TrackSummary {
    return {
        sampleRateHz: MIC_RATE,
        sampleCount: "0",
        byteCount: "0",
        chunkCount: 0,
        channelCount: 1,
        sampleFormat: "pcm_s16le",
        ...overrides,
    };
}

function finishedSummary(
    overrides: Partial<{
        microphone: TrackSummary;
        systemAudio: TrackSummary;
        applicationAudio: TrackSummary;
    }> = {},
): unknown {
    return {
        microphone: trackSummary(),
        systemAudio: trackSummary(),
        applicationAudio: trackSummary(),
        ...overrides,
    };
}

function emit(name: string, payload: unknown): void {
    eventBus.listeners.get(name)?.({ payload });
}

function base64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

function chunkEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        captureId: CAPTURE_ID,
        track: "microphone",
        sequence: 0,
        firstSampleIndex: "0",
        sampleRateHz: MIC_RATE,
        frameCount: "1",
        channelCount: 1,
        sampleFormat: "pcm_s16le",
        gapBeforeSamples: "0",
        containsDeviceDiscontinuity: false,
        pcmBase64: base64(new Uint8Array([1, 0])),
        ...overrides,
    };
}

async function startCapture(
    options: {
        started?: Partial<NativeSynchronizedAudioStarted>;
        omit?: readonly OptionalStartedKey[];
        systemAudioDeviceId?: string | null;
        applicationAudioDeviceId?: string | null;
        archive?: NativeSynchronizedAudioArchiveHooks;
        records?: { failures: [string, string][] };
        finish?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        handlers?: Partial<Record<string, InvokeHandler>>;
    } = {},
): Promise<{
    capture: Awaited<ReturnType<typeof startNativeSynchronizedAudioCapture>>;
    archive: NativeSynchronizedAudioArchiveHooks;
    failures: [string, string][];
    stopCalls: () => number;
}> {
    const archive = options.archive ?? archiveHooks();
    const failures: [string, string][] = options.records?.failures ?? [];
    const native = started(options.started, options.omit);
    invokeHandler = async (command, args) => {
        const custom = options.handlers?.[command];
        if (custom) return custom(command, args);
        switch (command) {
            case "begin_synchronized_audio_capture":
                return native;
            case "activate_synchronized_audio_capture":
            case "pause_synchronized_audio_capture":
            case "resume_synchronized_audio_capture":
            case "stop_synchronized_audio_source":
            case "discard_synchronized_audio_capture":
                return undefined;
            case "finish_synchronized_audio_capture":
                return options.finish ? options.finish(command, args) : finishedSummary();
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
        archive,
        onSourceFailure: (track, message) => failures.push([track, message]),
    });

    return {
        capture,
        archive,
        failures,
        stopCalls: () =>
            calls.filter((call) => call.command === "stop_synchronized_audio_source").length,
    };
}

describe("synchronized audio start validation", () => {
    it("rejects an invalid capture identifier", async () => {
        await expect(
            startNativeSynchronizedAudioCapture({
                consentConfirmed: true,
                consentAtUs: TIMESTAMP,
                microphoneDeviceId: "mic-1",
                systemAudioDeviceId: null,
                applicationAudioDeviceId: null,
                captureId: "not-a-uuid",
                archive: archiveHooks(),
                onSourceFailure: () => undefined,
            }),
        ).rejects.toThrow(/capture identifier is invalid/u);
        expect(calls).toEqual([]);
    });

    it.each([
        ["capture", { captureId: "22222222-2222-4222-8222-222222222222" }],
        ["consent", { consentAtUs: "1700000000000001" }],
    ] as const)("rejects mismatched %s metadata", async (_label, override) => {
        await expect(startCapture({ started: override })).rejects.toThrow(
            /different consent or capture metadata/u,
        );
    });

    it.each([
        ["non-numeric", "not-a-timestamp"],
        ["before consent", "1600000000000000"],
    ] as const)("rejects a %s start timestamp", async (_label, startedAtUs) => {
        await expect(startCapture({ started: { startedAtUs } })).rejects.toThrow(
            /invalid start timestamp/u,
        );
        expect(calls.some((call) => call.command === "discard_synchronized_audio_capture")).toBe(
            true,
        );
    });

    it.each([4_000, 400_000, 16_000.5])("rejects sample rate %s", async (rate) => {
        await expect(startCapture({ started: { microphoneSampleRateHz: rate } })).rejects.toThrow(
            /unsupported sample rate/u,
        );
    });

    it.each([0, 9, 1.5])("rejects channel count %s", async (channels) => {
        await expect(
            startCapture({ started: { microphoneChannelCount: channels } }),
        ).rejects.toThrow(/unsupported channel count/u);
    });

    it("rejects a capture with no usable sample rate", async () => {
        await expect(
            startCapture({
                started: {
                    microphoneSampleRateHz: 0,
                    systemAudioSampleRateHz: 0,
                    applicationAudioSampleRateHz: 0,
                },
            }),
        ).rejects.toThrow(/usable sample rate/u);
    });

    it("rejects a missing sample format", async () => {
        await expect(startCapture({ omit: ["microphoneSampleFormat"] })).rejects.toThrow(
            /did not report a sample format/u,
        );
    });

    it("rejects an empty sample format", async () => {
        await expect(startCapture({ started: { microphoneSampleFormat: "" } })).rejects.toThrow(
            /did not report a sample format/u,
        );
    });

    it.each(["pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"] as const)(
        "accepts %s sample formats",
        async (format) => {
            const { capture } = await startCapture({
                started: { microphoneSampleFormat: format },
            });
            await capture.discard();
        },
    );

    it("configures every selected source queue", async () => {
        const { capture, failures } = await startCapture({
            started: {
                microphoneSampleRateHz: MIC_RATE,
                systemAudioSampleRateHz: 8_000,
                applicationAudioSampleRateHz: 24_000,
                systemAudioSampleFormat: "pcm_u8",
                applicationAudioSampleFormat: "pcm_f32le",
                applicationAudioChannelCount: 2,
            },
            systemAudioDeviceId: "system-1",
            applicationAudioDeviceId: "app-1",
        });
        expect(failures).toEqual([]);
        await capture.discard();
    });

    it("applies early failures once capture starts", async () => {
        const failures: [string, string][] = [];
        const archive = archiveHooks();
        const { capture } = await startCapture({
            archive,
            records: { failures },
            systemAudioDeviceId: "system-1",
            handlers: {
                begin_synchronized_audio_capture: async () => {
                    emit("synchronized-audio-source-failed", {
                        captureId: CAPTURE_ID,
                        track: "system-audio",
                        message: "  early failure  ",
                    });
                    emit("synchronized-audio-source-failed", {
                        captureId: CAPTURE_ID,
                        track: "system-audio",
                        message: "duplicate",
                    });
                    emit("synchronized-audio-source-failed", {
                        captureId: CAPTURE_ID,
                        track: "unknown",
                        message: "ignored",
                    });
                    emit("synchronized-audio-source-failed", {
                        captureId: CAPTURE_ID,
                        track: "application-audio",
                        message: "unexpected",
                    });
                    emit("synchronized-audio-source-failed", {
                        captureId: CAPTURE_ID,
                        track: "microphone",
                        message: "",
                    });
                    emit("synchronized-audio-source-failed", {
                        captureId: "other",
                        track: "microphone",
                        message: "wrong capture",
                    });
                    return started({
                        systemAudioSampleRateHz: 8_000,
                        systemAudioSampleFormat: "pcm_s16le",
                    });
                },
            },
        });

        expect(failures).toEqual([["system-audio", "early failure"]]);
        expect(archive.onStarted).toHaveBeenCalled();
        await capture.discard();
    });

    it("discards when start metadata cannot be committed", async () => {
        const archive = archiveHooks();
        (archive.onStarted as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error("archive offline"),
        );
        await expect(startCapture({ archive })).rejects.toThrow("archive offline");
        expect(calls.some((call) => call.command === "discard_synchronized_audio_capture")).toBe(
            true,
        );
        expect(eventBus.listeners.size).toBe(0);
    });

    it("finishes committed metadata when activation fails", async () => {
        const archive = archiveHooks();
        const failures: [string, string][] = [];
        await expect(
            startCapture({
                archive,
                records: { failures },
                systemAudioDeviceId: "system-1",
                handlers: {
                    activate_synchronized_audio_capture: async () => {
                        throw new Error("activation failed");
                    },
                },
                finish: async () => finishedSummary(),
            }),
        ).rejects.toThrow("activation failed");
        expect(archive.onFinished).toHaveBeenCalledWith({
            pauseCount: 0,
            pausedDurationUs: "0",
            failures: expect.objectContaining({
                microphone: "Capture startup failed after the archive metadata was committed.",
                "system-audio": "Capture startup failed after the archive metadata was committed.",
            }),
        });
        expect(calls.some((call) => call.command === "finish_synchronized_audio_capture")).toBe(
            true,
        );
    });

    it("skips onFinished when finishing the failed activation fails", async () => {
        const archive = archiveHooks();
        await expect(
            startCapture({
                archive,
                handlers: {
                    activate_synchronized_audio_capture: async () => {
                        throw new Error("activation failed");
                    },
                    finish_synchronized_audio_capture: async () => {
                        throw new Error("finish failed");
                    },
                },
            }),
        ).rejects.toThrow("activation failed");
        expect(archive.onFinished).not.toHaveBeenCalled();
    });

    it("swallows discard failures when the start itself fails", async () => {
        await expect(
            startCapture({
                handlers: {
                    begin_synchronized_audio_capture: async () => {
                        throw new Error("begin failed");
                    },
                    discard_synchronized_audio_capture: async () => {
                        throw new Error("discard failed");
                    },
                },
            }),
        ).rejects.toThrow("begin failed");
    });

    it("swallows onFinished failures after a partial start", async () => {
        const archive = archiveHooks();
        (archive.onFinished as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error("finished metadata failed"),
        );
        await expect(
            startCapture({
                archive,
                handlers: {
                    activate_synchronized_audio_capture: async () => {
                        throw new Error("activation failed");
                    },
                },
            }),
        ).rejects.toThrow("activation failed");
        expect(archive.onFinished).toHaveBeenCalled();
    });
});

describe("synchronized audio chunks", () => {
    it("ignores chunks before start, for other captures, and unknown tracks", async () => {
        const { capture, failures } = await startCapture({
            handlers: {
                begin_synchronized_audio_capture: async () => {
                    emit("synchronized-audio-chunk", chunkEvent());
                    emit("synchronized-audio-chunk", chunkEvent({ captureId: "other" }));
                    emit("synchronized-audio-chunk", chunkEvent({ track: "unknown" }));
                    return started();
                },
            },
        });
        expect(failures).toEqual([]);
        await capture.stop();
    });

    it("ignores chunks after the capture stops", async () => {
        const { capture } = await startCapture();
        const listener = eventBus.listeners.get("synchronized-audio-chunk")!;
        await capture.stop();
        listener({ payload: chunkEvent() });
    });

    it("ignores unknown tracks and failed queues after start", async () => {
        const { capture, failures } = await startCapture();
        emit("synchronized-audio-chunk", chunkEvent({ track: "unknown" }));
        emit("synchronized-audio-source-failed", {
            captureId: CAPTURE_ID,
            track: "microphone",
            message: "unplugged",
        });
        emit("synchronized-audio-chunk", chunkEvent({ sequence: 1 }));
        expect(failures).toEqual([["microphone", "unplugged"]]);
        await capture.stop();
    });

    it("accepts implied channel count, gap, and the legacy PCM field", async () => {
        const { capture, archive } = await startCapture({
            finish: async () =>
                finishedSummary({
                    microphone: trackSummary({ sampleCount: "1", chunkCount: 1 }),
                }),
        });
        emit(
            "synchronized-audio-chunk",
            chunkEvent({
                channelCount: undefined,
                gapBeforeSamples: undefined,
                pcmBase64: undefined,
                pcmS16leBase64: base64(new Uint8Array([1, 0])),
            }),
        );
        await capture.stop();
        expect(archive.onChunk).toHaveBeenCalledTimes(1);
    });

    it("rejects a chunk without any PCM payload", async () => {
        const { capture, failures } = await startCapture();
        emit(
            "synchronized-audio-chunk",
            chunkEvent({ pcmBase64: undefined, pcmS16leBase64: undefined }),
        );
        expect(failures[0]![1]).toMatch(/invalid PCM chunk/u);
        await capture.stop();
    });

    it("archives a valid chunk", async () => {
        const { capture, archive, failures } = await startCapture({
            finish: async () =>
                finishedSummary({
                    microphone: trackSummary({ sampleCount: "1", chunkCount: 1 }),
                }),
        });
        emit("synchronized-audio-chunk", chunkEvent());
        const result = await capture.stop();
        expect(failures).toEqual([]);
        expect(archive.onChunk).toHaveBeenCalledTimes(1);
        const chunk = (archive.onChunk as ReturnType<typeof vi.fn>).mock.calls[0]![1];
        expect(chunk.sequence).toBe(0);
        expect(chunk.firstSampleIndex).toBe("0");
        expect(chunk.sampleFormat).toBe("pcm_s16le");
        expect(chunk.channelCount).toBe(1);
        expect(chunk.gapBeforeSamples).toBe("0");
        expect(result.archiveCommitted).toBe(true);
        expect(result.warnings).toEqual([]);
    });

    it.each([
        ["out of sequence", { sequence: 1 }, /out of sequence/u],
        ["different rate", { sampleRateHz: 8_000 }, /changed sample rate/u],
        ["different format", { sampleFormat: "pcm_s24le" }, /changed format/u],
        ["different channel count", { channelCount: 2 }, /changed format/u],
        ["invalid timeline", { firstSampleIndex: "x" }, /invalid sample timeline/u],
        ["invalid gap", { gapBeforeSamples: "x" }, /invalid sample timeline/u],
        ["discontinuous timeline", { firstSampleIndex: "5" }, /discontinuous sample timeline/u],
        ["inconsistent frame count", { frameCount: "2" }, /inconsistent PCM frame count/u],
        [
            "oversized event",
            { pcmBase64: "A".repeat(699_052) },
            /exceeded the supported chunk size/u,
        ],
    ] as const)("stops the source for %s", async (_label, overrides, message) => {
        const { capture, failures, stopCalls } = await startCapture();
        emit("synchronized-audio-chunk", chunkEvent(overrides));
        expect(stopCalls()).toBe(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]![0]).toBe("microphone");
        expect(failures[0]![1]).toMatch(message);
        await capture.stop();
    });

    it("stops the source for empty and undecodable PCM", async () => {
        const empty = await startCapture();
        emit("synchronized-audio-chunk", chunkEvent({ pcmBase64: "" }));
        expect(empty.failures[0]![1]).toMatch(/invalid PCM chunk/u);
        await empty.capture.stop();

        const broken = await startCapture();
        emit("synchronized-audio-chunk", chunkEvent({ pcmBase64: "!!!" }));
        expect(broken.failures).toHaveLength(1);
        await broken.capture.stop();
    });

    it("stops when archive writing falls behind", async () => {
        const { capture, failures } = await startCapture();
        for (let sequence = 0; sequence < 11; sequence++) {
            emit(
                "synchronized-audio-chunk",
                chunkEvent({
                    sequence,
                    firstSampleIndex: String(sequence * 102_400),
                    frameCount: "102400",
                    pcmBase64: base64(new Uint8Array(204_800)),
                }),
            );
        }
        expect(failures[0]![0]).toBe("microphone");
        expect(failures[0]![1]).toMatch(/fell behind the bounded audio queue/u);
        await capture.stop();
    });

    it("flushes staged audio before a gapped chunk", async () => {
        const { capture, archive } = await startCapture({
            finish: async () =>
                finishedSummary({
                    microphone: trackSummary({ sampleCount: "3", chunkCount: 3 }),
                }),
        });
        emit("synchronized-audio-chunk", chunkEvent());
        emit("synchronized-audio-chunk", chunkEvent({ sequence: 1, firstSampleIndex: "1" }));
        emit(
            "synchronized-audio-chunk",
            chunkEvent({
                sequence: 2,
                firstSampleIndex: "4",
                gapBeforeSamples: "2",
            }),
        );
        await capture.stop();
        expect((archive.onChunk as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    });

    it("splits a flush that crosses the archive batch boundary", async () => {
        const { capture, archive, failures } = await startCapture({
            finish: async () =>
                finishedSummary({
                    microphone: trackSummary({
                        sampleCount: "204801",
                        chunkCount: 3,
                    }),
                }),
        });
        emit(
            "synchronized-audio-chunk",
            chunkEvent({
                firstSampleIndex: "0",
                frameCount: "102400",
                pcmBase64: base64(new Uint8Array(204_800)),
            }),
        );
        emit(
            "synchronized-audio-chunk",
            chunkEvent({
                sequence: 1,
                firstSampleIndex: "102400",
                frameCount: "102400",
                pcmBase64: base64(new Uint8Array(204_800)),
            }),
        );
        emit(
            "synchronized-audio-chunk",
            chunkEvent({
                sequence: 2,
                firstSampleIndex: "204800",
                frameCount: "1",
                pcmBase64: base64(new Uint8Array(2)),
            }),
        );
        await capture.stop();
        expect(failures).toEqual([]);
        expect((archive.onChunk as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    });

    it("records a non-error archive rejection", async () => {
        const archive = archiveHooks();
        (archive.onChunk as ReturnType<typeof vi.fn>).mockRejectedValue("disk full");
        const { capture, failures } = await startCapture({
            archive,
            finish: async () =>
                finishedSummary({
                    microphone: trackSummary({ sampleCount: "1", chunkCount: 1 }),
                }),
        });
        emit("synchronized-audio-chunk", chunkEvent());
        await capture.stop();
        expect(failures[0]![1]).toMatch(/Archive checkpoint failed: disk full/u);
    });

    it("skips queued archive operations after a persistence failure", async () => {
        const archive = archiveHooks();
        (archive.onChunk as ReturnType<typeof vi.fn>)
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue(undefined);
        const { capture, failures } = await startCapture({ archive });
        for (let sequence = 0; sequence < 3; sequence++) {
            emit(
                "synchronized-audio-chunk",
                chunkEvent({
                    sequence,
                    firstSampleIndex: String(sequence * 102_400),
                    frameCount: "102400",
                    pcmBase64: base64(new Uint8Array(204_800)),
                }),
            );
        }
        await capture.stop();
        expect(failures[0]![1]).toMatch(/Archive checkpoint failed: boom/u);
    });

    it("rebuilds the default failure message for blank source errors", async () => {
        const { capture, failures } = await startCapture();
        emit("synchronized-audio-source-failed", {
            captureId: CAPTURE_ID,
            track: "microphone",
            message: "   ",
        });
        expect(failures).toEqual([["microphone", "The audio source stopped unexpectedly."]]);
        await capture.stop();
    });

    it("survives a rejected source stop command", async () => {
        const { capture, failures } = await startCapture({
            handlers: {
                stop_synchronized_audio_source: async () => {
                    throw new Error("stop source failed");
                },
            },
        });
        emit("synchronized-audio-source-failed", {
            captureId: CAPTURE_ID,
            track: "microphone",
            message: "unplugged",
        });
        expect(failures).toEqual([["microphone", "unplugged"]]);
        await capture.stop();
    });
});

describe("synchronized audio pause and resume", () => {
    function pauseDrainingHandler(id: number) {
        return async (command: string) => {
            if (command === "pause_synchronized_audio_capture")
                queueMicrotask(() =>
                    emit("synchronized-audio-pause-drained", {
                        captureId: CAPTURE_ID,
                        pauseId: id,
                    }),
                );
            return undefined;
        };
    }

    it("pauses, resumes, and reports durations", async () => {
        const { capture, archive } = await startCapture({
            handlers: { pause_synchronized_audio_capture: pauseDrainingHandler(1) },
        });
        await capture.pause();
        expect(archive.onPaused).toHaveBeenCalledWith({
            pauseCount: 1,
            pausedDurationUs: expect.any(String),
        });
        await expect(capture.pause()).rejects.toThrow(/cannot be paused now/u);

        await capture.resume();
        expect(archive.onResumed).toHaveBeenCalledWith({
            pauseCount: 1,
            pausedDurationUs: expect.any(String),
        });
        await expect(capture.resume()).rejects.toThrow(/cannot be resumed now/u);

        const result = await capture.stop();
        expect(result.pauseCount).toBe(1);
        await expect(capture.pause()).rejects.toThrow(/cannot be paused now/u);
        await expect(capture.resume()).rejects.toThrow(/cannot be resumed now/u);
    });

    it("reports paused duration when stopping while paused", async () => {
        const { capture } = await startCapture({
            handlers: { pause_synchronized_audio_capture: pauseDrainingHandler(1) },
        });
        await capture.pause();
        const result = await capture.stop();
        expect(result.pauseCount).toBe(1);
        expect(Number(result.pausedDurationUs)).toBeGreaterThanOrEqual(0);
    });

    it("rolls back when the pause command fails", async () => {
        const { capture } = await startCapture({
            handlers: {
                pause_synchronized_audio_capture: async () => {
                    emit("synchronized-audio-pause-drained", {
                        captureId: CAPTURE_ID,
                        pauseId: 1,
                    });
                    throw new Error("pause failed");
                },
                resume_synchronized_audio_capture: async () => {
                    throw new Error("cleanup failed");
                },
            },
        });
        await expect(capture.pause()).rejects.toThrow("pause failed");
        expect(calls.some((call) => call.command === "resume_synchronized_audio_capture")).toBe(
            true,
        );
        await capture.stop();
    });

    it("turns a non-error pause failure into an Error", async () => {
        const { capture } = await startCapture({
            handlers: {
                pause_synchronized_audio_capture: async () => {
                    emit("synchronized-audio-pause-drained", {
                        captureId: CAPTURE_ID,
                        pauseId: 1,
                    });
                    throw "pause exploded";
                },
            },
        });
        await expect(capture.pause()).rejects.toThrow("pause exploded");
        await capture.stop();
    });

    it("rolls back metadata when onPaused fails", async () => {
        const archive = archiveHooks();
        const { capture } = await startCapture({
            archive,
            handlers: { pause_synchronized_audio_capture: pauseDrainingHandler(1) },
        });
        (archive.onPaused as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error("paused metadata failed"),
        );
        await expect(capture.pause()).rejects.toThrow("paused metadata failed");
        await capture.stop();
    });

    it("times out waiting for chunks to drain", async () => {
        vi.useFakeTimers();
        const { capture } = await startCapture();
        const expectation = expect(capture.pause()).rejects.toThrow(/did not drain before pause/u);
        await vi.advanceTimersByTimeAsync(5_000);
        await expectation;
        vi.useRealTimers();
        await capture.stop();
    });

    it("restores pause metadata when resuming fails", async () => {
        const archive = archiveHooks();
        const { capture } = await startCapture({
            archive,
            handlers: {
                pause_synchronized_audio_capture: pauseDrainingHandler(1),
                resume_synchronized_audio_capture: async () => {
                    throw new Error("resume failed");
                },
            },
        });
        await capture.pause();
        (archive.onPaused as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error("rollback failed"),
        );
        await expect(capture.resume()).rejects.toThrow("resume failed");
    });
});

describe("synchronized audio stop and discard", () => {
    it("reconciles every selected source", async () => {
        const { capture, failures } = await startCapture({
            started: {
                microphoneSampleRateHz: MIC_RATE,
                systemAudioSampleRateHz: 8_000,
                applicationAudioSampleRateHz: 24_000,
                systemAudioSampleFormat: "pcm_u8",
                systemAudioChannelCount: 1,
                applicationAudioSampleFormat: "pcm_f32le",
                applicationAudioChannelCount: 2,
            },
            systemAudioDeviceId: "system-1",
            applicationAudioDeviceId: "app-1",
            finish: async () =>
                finishedSummary({
                    microphone: trackSummary({ sampleCount: "1", chunkCount: 1 }),
                    systemAudio: trackSummary({
                        sampleRateHz: 8_000,
                        sampleCount: "1",
                        chunkCount: 1,
                        channelCount: 1,
                        sampleFormat: "pcm_u8",
                    }),
                    applicationAudio: trackSummary({
                        sampleRateHz: 24_000,
                        sampleCount: "1",
                        chunkCount: 1,
                        channelCount: 2,
                        sampleFormat: "pcm_f32le",
                    }),
                }),
        });
        emit("synchronized-audio-chunk", chunkEvent());
        emit(
            "synchronized-audio-chunk",
            chunkEvent({
                track: "system-audio",
                sampleRateHz: 8_000,
                sampleFormat: "pcm_u8",
                frameCount: "1",
                pcmBase64: base64(new Uint8Array(1)),
            }),
        );
        emit(
            "synchronized-audio-chunk",
            chunkEvent({
                track: "application-audio",
                sampleRateHz: 24_000,
                sampleFormat: "pcm_f32le",
                channelCount: 2,
                frameCount: "1",
                pcmBase64: base64(new Uint8Array(8)),
            }),
        );
        const result = await capture.stop();
        expect(failures).toEqual([]);
        expect(result.warnings).toEqual([]);
    });

    it("returns from delivery waiting when every source failed", async () => {
        const { capture, failures } = await startCapture({
            started: {
                microphoneSampleRateHz: MIC_RATE,
                systemAudioSampleRateHz: 8_000,
                applicationAudioSampleRateHz: 24_000,
                systemAudioSampleFormat: "pcm_s16le",
                applicationAudioSampleFormat: "pcm_s16le",
            },
            systemAudioDeviceId: "system-1",
            applicationAudioDeviceId: "app-1",
            finish: async () =>
                finishedSummary({
                    microphone: trackSummary({ chunkCount: 5 }),
                    systemAudio: trackSummary({ chunkCount: 5 }),
                    applicationAudio: trackSummary({ chunkCount: 5 }),
                }),
        });
        for (const track of ["microphone", "system-audio", "application-audio"]) {
            emit("synchronized-audio-source-failed", {
                captureId: CAPTURE_ID,
                track,
                message: `${track} failed`,
            });
        }
        const result = await capture.stop();
        expect(failures).toHaveLength(3);
        expect(result.warnings).toHaveLength(3);
    });

    it("waits for late delivery until the deadline", async () => {
        vi.useFakeTimers();
        const { capture, archive } = await startCapture({
            finish: async () =>
                finishedSummary({
                    microphone: trackSummary({ sampleCount: "5", chunkCount: 5 }),
                }),
        });
        emit(
            "synchronized-audio-chunk",
            chunkEvent({
                frameCount: "5",
                pcmBase64: base64(new Uint8Array(10)),
            }),
        );
        const stopping = capture.stop();
        await vi.advanceTimersByTimeAsync(3_001);
        const result = await stopping;
        expect(archive.onChunk).toHaveBeenCalled();
        expect(result.warnings[0]).toMatch(/delivery ended before every chunk/u);
        vi.useRealTimers();
    });

    it("reports a source without samples", async () => {
        const { capture, archive } = await startCapture();
        const result = await capture.stop();
        expect(result.warnings).toEqual([
            "microphone: The selected audio source did not provide any samples.",
        ]);
        expect(archive.onFinished).toHaveBeenCalled();
    });

    it("reconciles summary failures and format differences", async () => {
        const cases: { summary: TrackSummary; message: RegExp }[] = [
            { summary: trackSummary({ failure: "native failure" }), message: /native failure/u },
            {
                summary: trackSummary({ sampleCount: "1", chunkCount: 1, channelCount: 2 }),
                message: /different channel count/u,
            },
            {
                summary: trackSummary({
                    sampleCount: "1",
                    chunkCount: 1,
                    sampleFormat: "pcm_s24le",
                }),
                message: /different sample format/u,
            },
            {
                summary: trackSummary({ sampleCount: "abc", chunkCount: 0 }),
                message: /invalid sample count/u,
            },
            {
                summary: trackSummary({ sampleCount: "2", chunkCount: 0 }),
                message: /ended before every captured chunk/u,
            },
            {
                summary: trackSummary({ sampleCount: "1", chunkCount: 0 }),
                message: /delivery ended before every chunk/u,
            },
        ];
        for (const entry of cases) {
            const { capture } = await startCapture({
                finish: async () => finishedSummary({ microphone: entry.summary }),
                handlers: {
                    begin_synchronized_audio_capture: async () => started(),
                },
            });
            if (entry.summary.sampleCount === "1" || entry.summary.sampleCount === "2") {
                emit(
                    "synchronized-audio-chunk",
                    chunkEvent({ frameCount: "1", pcmBase64: base64(new Uint8Array(2)) }),
                );
            }
            const result = await capture.stop();
            expect(result.warnings[0]).toMatch(entry.message);
        }
    });

    it("rejects a second stop and lets discard become a no-op", async () => {
        const { capture } = await startCapture();
        await capture.stop();
        await expect(capture.stop()).rejects.toThrow(/already stopped/u);
        await expect(capture.discard()).resolves.toBeUndefined();
    });

    it("discards pending chunks and listeners", async () => {
        const { capture } = await startCapture();
        emit("synchronized-audio-chunk", chunkEvent());
        await capture.discard();
        expect(calls.some((call) => call.command === "discard_synchronized_audio_capture")).toBe(
            true,
        );
        expect(eventBus.listeners.size).toBe(0);
    });
});
