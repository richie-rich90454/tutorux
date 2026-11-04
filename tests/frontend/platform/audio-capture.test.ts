// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockState {
    tauri: boolean;
    calls: { command: string; args: Record<string, unknown> | undefined }[];
    handler: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    started: {
        captureId: string;
        startedAtUs: string;
        consentAtUs: string;
        maxBytes: number;
        sampleRateHz: number;
    };
    finishSampleCount: string;
}

const state = vi.hoisted((): MockState => ({
    tauri: false,
    calls: [],
    handler: async () => undefined,
    started: {
        captureId: "capture-1",
        startedAtUs: "1000",
        consentAtUs: "900",
        maxBytes: 128 * 1024 * 1024,
        sampleRateHz: 48_000,
    },
    finishSampleCount: "0",
}));

vi.mock("@tauri-apps/api/core", () => ({
    isTauri: () => state.tauri,
    invoke: (command: string, args?: Record<string, unknown>) => {
        state.calls.push({ command, args });
        return state.handler(command, args);
    },
}));

import {
    startMicrophoneCapture,
    type ArchiveCaptureCursor,
    type MicrophoneArchiveCaptureHooks,
} from "../../../frontend/platform/audio-capture";

class FakeProcessor {
    onaudioprocess: ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null =
        null;
    connect = vi.fn();
    disconnect = vi.fn();
}

class FakeGain {
    gain = { value: 1 };
    connect = vi.fn();
    disconnect = vi.fn();
}

class FakeSource {
    connect = vi.fn();
    disconnect = vi.fn();
}

class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    static options: (AudioContextOptions | undefined)[] = [];
    static failResume: Error | undefined;
    static failSuspend: Error | undefined;
    static failClose: Error | undefined;
    readonly sampleRate: number;
    readonly destination = {};
    readonly suspend = vi.fn(async () => {
        if (FakeAudioContext.failSuspend) {
            const failure = FakeAudioContext.failSuspend;
            FakeAudioContext.failSuspend = undefined;
            throw failure;
        }
        return undefined;
    });
    readonly resume = vi.fn(async () => {
        if (FakeAudioContext.failResume) {
            const failure = FakeAudioContext.failResume;
            FakeAudioContext.failResume = undefined;
            throw failure;
        }
        return undefined;
    });
    readonly close = vi.fn(async () => {
        if (FakeAudioContext.failClose) {
            const failure = FakeAudioContext.failClose;
            FakeAudioContext.failClose = undefined;
            throw failure;
        }
        return undefined;
    });
    processor: FakeProcessor | undefined;

    constructor(options?: AudioContextOptions) {
        FakeAudioContext.options.push(options);
        this.sampleRate = options?.sampleRate ?? 48_000;
        FakeAudioContext.instances.push(this);
    }

    createMediaStreamSource(): FakeSource {
        return new FakeSource();
    }

    createScriptProcessor(): FakeProcessor {
        this.processor = new FakeProcessor();
        return this.processor;
    }

    createGain(): FakeGain {
        return new FakeGain();
    }
}

interface FakeTrack {
    enabled: boolean;
    addEventListener: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
}

function makeStream(): { stream: MediaStream; tracks: FakeTrack[] } {
    const track: FakeTrack = {
        enabled: true,
        addEventListener: vi.fn(),
        stop: vi.fn(),
    };
    const tracks = [track];
    const stream = {
        getAudioTracks: () => tracks,
        getTracks: () => tracks,
    } as unknown as MediaStream;
    return { stream, tracks };
}

type StartOptions = Parameters<typeof startMicrophoneCapture>[0];

function makeHooks(
    overrides: Partial<MicrophoneArchiveCaptureHooks> = {},
): MicrophoneArchiveCaptureHooks {
    return {
        onStarted: vi.fn(async () => undefined),
        onChunk: vi.fn(async () => undefined),
        onPaused: vi.fn(async () => undefined),
        onResumed: vi.fn(async () => undefined),
        onFinished: vi.fn(async () => undefined),
        onDiscard: vi.fn(async () => undefined),
        ...overrides,
    };
}

let mediaStream: { stream: MediaStream; tracks: FakeTrack[] };

function installBrowser(): void {
    mediaStream = makeStream();
    const getUserMedia = vi.fn(async () => mediaStream.stream);
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia },
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);
}

function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function lastContext(): FakeAudioContext {
    return FakeAudioContext.instances.at(-1)!;
}

function emit(samples: ArrayLike<number>): void {
    const processor = lastContext().processor!;
    processor.onaudioprocess!({
        inputBuffer: { getChannelData: () => Float32Array.from(samples) },
    });
}

async function startTauri(
    overrides: Partial<StartOptions> = {},
    hookOverrides: Partial<MicrophoneArchiveCaptureHooks> = {},
): Promise<{
    capture: Awaited<ReturnType<typeof startMicrophoneCapture>>;
    hooks: MicrophoneArchiveCaptureHooks;
}> {
    const hooks = makeHooks(hookOverrides);
    const capture = await startMicrophoneCapture({
        consentConfirmed: true,
        consentAtUs: "900",
        onLimit: vi.fn(),
        onDeviceEnded: vi.fn(),
        archive: hooks,
        ...overrides,
    });
    return { capture, hooks };
}

beforeEach(() => {
    state.tauri = true;
    state.calls = [];
    state.finishSampleCount = "0";
    state.started = {
        captureId: "capture-1",
        startedAtUs: "1000",
        consentAtUs: "900",
        maxBytes: 128 * 1024 * 1024,
        sampleRateHz: 48_000,
    };
    FakeAudioContext.instances = [];
    FakeAudioContext.options = [];
    FakeAudioContext.failResume = undefined;
    FakeAudioContext.failSuspend = undefined;
    FakeAudioContext.failClose = undefined;
    installBrowser();
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    state.handler = async (command) => {
        if (command === "begin_audio_capture") return state.started;
        if (command === "finish_audio_capture")
            return { byteCount: 0, sampleCount: state.finishSampleCount };
        return undefined;
    };
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
});

describe("microphone capture consent and host selection", () => {
    it("requires consent before touching the host", async () => {
        await expect(
            startMicrophoneCapture({
                consentConfirmed: false,
                consentAtUs: "1",
                onLimit: () => undefined,
                onDeviceEnded: () => undefined,
            }),
        ).rejects.toThrow(/agreed before starting capture/u);
        expect(state.calls).toEqual([]);
    });

    it("requires an archive target on the desktop", async () => {
        await expect(
            startMicrophoneCapture({
                consentConfirmed: true,
                consentAtUs: "1",
                onLimit: () => undefined,
                onDeviceEnded: () => undefined,
            }),
        ).rejects.toThrow(/archive recovery target/u);
    });
});

describe("browser microphone capture", () => {
    beforeEach(() => {
        state.tauri = false;
    });

    it("reports an unavailable microphone", async () => {
        delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
        await expect(
            startMicrophoneCapture({
                consentConfirmed: true,
                consentAtUs: "1",
                onLimit: () => undefined,
                onDeviceEnded: () => undefined,
            }),
        ).rejects.toThrow(/unavailable in this window/u);
    });

    it("records, pauses, resumes, stops, and discards in memory", async () => {
        const capture = await startMicrophoneCapture({
            consentConfirmed: true,
            consentAtUs: "900",
            deviceId: "mic-1",
            onLimit: () => undefined,
            onDeviceEnded: () => undefined,
        });
        expect(capture.durability).toBe("memory");
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
            audio: { deviceId: { exact: "mic-1" } },
        });

        emit([1, -1, 0.5]);
        await capture.pause();
        expect(mediaStream.tracks[0]!.enabled).toBe(false);
        await capture.resume();
        expect(mediaStream.tracks[0]!.enabled).toBe(true);
        const result = await capture.stop();
        expect(result.file).toBeInstanceOf(File);
        expect(result.pauseCount).toBe(1);
        expect(result.startedAtUs).toBeDefined();
        expect(result.consentAtUs).toBe("900");
    });

    it("uses the default microphone input when no device is selected", async () => {
        const capture = await startMicrophoneCapture({
            consentConfirmed: true,
            consentAtUs: "1",
            onLimit: () => undefined,
            onDeviceEnded: () => undefined,
        });
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
        await capture.discard();
    });

    it("rejects stopping without any audio", async () => {
        const capture = await startMicrophoneCapture({
            consentConfirmed: true,
            consentAtUs: "1",
            onLimit: () => undefined,
            onDeviceEnded: () => undefined,
        });
        await expect(capture.stop()).rejects.toThrow(/did not provide any audio/u);
    });

    it("ignores a second discard", async () => {
        const capture = await startMicrophoneCapture({
            consentConfirmed: true,
            consentAtUs: "1",
            onLimit: () => undefined,
            onDeviceEnded: () => undefined,
        });
        await capture.discard();
        await expect(capture.discard()).resolves.toBeUndefined();
    });
});

describe("desktop microphone startup", () => {
    it("requires browser media support", async () => {
        delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
        await expect(startTauri()).rejects.toThrow(/unavailable in this window/u);

        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {},
        });
        await expect(startTauri()).rejects.toThrow(/unavailable in this window/u);

        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: { getUserMedia: async () => mediaStream.stream },
        });
        vi.stubGlobal("AudioContext", undefined);
        await expect(startTauri()).rejects.toThrow(/unavailable in this window/u);
    });

    it("maps microphone permission failures", async () => {
        const cases: [string, RegExp][] = [
            ["NotAllowedError", /access was denied/u],
            ["SecurityError", /access was denied/u],
            ["NotFoundError", /No microphone device/u],
            ["DevicesNotFoundError", /No microphone device/u],
            ["NotReadableError", /busy or unavailable/u],
            ["AbortError", /busy or unavailable/u],
            ["UnknownError", /boom/u],
        ];
        for (const [name, message] of cases) {
            navigator.mediaDevices.getUserMedia = vi.fn(async () => {
                throw new DOMException("boom", name);
            });
            await expect(startTauri()).rejects.toThrow(message);
        }
        navigator.mediaDevices.getUserMedia = vi.fn(async () => {
            throw "plain failure";
        });
        await expect(startTauri()).rejects.toThrow("plain failure");
    });

    it("starts the desktop capture with the required host arguments", async () => {
        const { capture, hooks } = await startTauri({ deviceId: "mic-9" });
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
            audio: { deviceId: { exact: "mic-9" } },
        });
        expect(state.calls[0]).toEqual({
            command: "begin_audio_capture",
            args: { consentConfirmed: true, consentAtUs: "900", sampleRateHz: 48_000 },
        });
        expect(hooks.onStarted).toHaveBeenCalledWith(state.started);
        expect(capture.durability).toBe("archive");
    });

    it("honors an explicit sample rate and default archive cursor", async () => {
        const { capture } = await startTauri({ sampleRateHz: 16_000 });
        expect(FakeAudioContext.options[0]).toEqual({ sampleRate: 16_000 });
        emit([0.25]);
        state.finishSampleCount = "1";
        await capture.stop();
        const chunk = vi.mocked(makeHooks().onChunk);
        expect(chunk).not.toHaveBeenCalled();
        expect(state.calls[0]!.args!["sampleRateHz"]).toBe(16_000);
    });

    it("resumes an archive cursor returned by the host", async () => {
        const cursor: ArchiveCaptureCursor = { sequence: 5, firstSampleIndex: "10" };
        const { capture, hooks } = await startTauri({}, { onStarted: async () => cursor });
        emit([0.5]);
        state.finishSampleCount = "1";
        await capture.pause();
        await capture.resume();
        await capture.stop();
        expect(hooks.onChunk).toHaveBeenCalledWith(
            expect.objectContaining({ sequence: 5, firstSampleIndex: "10" }),
        );
    });

    it("rejects an invalid archive sequence", async () => {
        await expect(
            startTauri({}, { onStarted: async () => ({ sequence: -1, firstSampleIndex: "0" }) }),
        ).rejects.toThrow(/recovery sequence is invalid/u);
        expect(state.calls.map((call) => call.command)).toContain("discard_audio_capture");
        expect(mediaStream.tracks[0]!.stop).toHaveBeenCalled();
    });

    it("rejects an invalid archive sample position", async () => {
        await expect(
            startTauri({}, { onStarted: async () => ({ sequence: 0, firstSampleIndex: "-1" }) }),
        ).rejects.toThrow(/sample position is invalid/u);
    });

    it("cleans up when archive startup fails", async () => {
        const failure = new Error("archive start failed");
        await expect(
            startTauri(
                {},
                {
                    onStarted: async () => {
                        throw failure;
                    },
                },
            ),
        ).rejects.toBe(failure);
        expect(mediaStream.tracks[0]!.stop).toHaveBeenCalled();
        expect(lastContext().close).toHaveBeenCalled();
        expect(state.calls.map((call) => call.command)).toContain("discard_audio_capture");
    });

    it("cleans up when the audio context cannot resume", async () => {
        const failure = new Error("resume failed");
        FakeAudioContext.failResume = failure;
        await expect(startTauri()).rejects.toBe(failure);
        expect(mediaStream.tracks[0]!.stop).toHaveBeenCalled();
    });

    it("cleans up when the audio context cannot be created", async () => {
        vi.stubGlobal(
            "AudioContext",
            class {
                constructor() {
                    throw new Error("no audio");
                }
            },
        );
        await expect(startTauri()).rejects.toThrow("no audio");
        expect(mediaStream.tracks[0]!.stop).toHaveBeenCalled();
    });

    it("surfaces a non-Error startup failure", async () => {
        await expect(
            startTauri(
                {},
                {
                    onStarted: async () => {
                        throw "archive unavailable";
                    },
                },
            ),
        ).rejects.toThrow("archive unavailable");
    });

    it("tolerates close and discard failures during startup cleanup", async () => {
        FakeAudioContext.failClose = new Error("close failed");
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "discard_audio_capture") throw new Error("discard failed");
            return undefined;
        };
        await expect(
            startTauri({}, { onStarted: async () => ({ sequence: -1, firstSampleIndex: "0" }) }),
        ).rejects.toThrow(/recovery sequence is invalid/u);
        expect(mediaStream.tracks[0]!.stop).toHaveBeenCalled();
    });
});

describe("desktop audio processing", () => {
    it("converts samples and commits archive chunks", async () => {
        let limits = 0;
        let captured: Uint8Array | undefined;
        const onChunk = vi.fn(async (chunk: { samples: Uint8Array }) => {
            captured = chunk.samples.slice();
        });
        const archive = makeHooks({ onChunk });
        const { capture } = await startTauri({
            onLimit: () => (limits += 1),
            archive,
        });
        emit([2, -2, 0.5, -0.5]);
        state.finishSampleCount = "4";

        const result = await capture.stop();
        expect(limits).toBe(0);
        const append = state.calls.find((call) => call.command === "append_audio_capture_chunk");
        expect(append!.args).toMatchObject({ captureId: "capture-1", sequence: 0 });
        expect(append!.args!["samples"]).toEqual(
            Array.from(new Uint8Array(new Int16Array([32767, -32768, 16384, -16384]).buffer)),
        );
        expect(onChunk).toHaveBeenCalledWith(
            expect.objectContaining({
                sequence: 0,
                firstSampleIndex: "0",
                sampleRateHz: 48_000,
            }),
        );
        expect(captured).toEqual(
            new Uint8Array(new Int16Array([32767, -32768, 16384, -16384]).buffer),
        );
        expect(archive.onFinished).toHaveBeenCalledWith(
            expect.objectContaining({ sampleRateHz: 48_000, sampleCount: "4", pauseCount: 0 }),
        );
        expect(result).toMatchObject({ archiveCommitted: true, sampleCount: "4" });
        expect(result.warning).toBeUndefined();
    });

    it("warns when the archive limit truncates a block", async () => {
        state.started = { ...state.started, maxBytes: 2 };
        let limits = 0;
        let captured: Uint8Array | undefined;
        const archive = makeHooks({
            onChunk: async (chunk) => {
                captured = chunk.samples.slice();
            },
        });
        const { capture } = await startTauri({
            onLimit: () => (limits += 1),
            archive,
        });
        emit([0.5, 0.5]);
        state.finishSampleCount = "1";
        await capture.stop();
        expect(limits).toBeGreaterThan(0);
        expect(captured).toEqual(new Uint8Array([0, 64]));
        expect(archive.onFinished).toHaveBeenCalledWith(
            expect.objectContaining({ interruptedReason: expect.stringMatching(/128 MiB/u) }),
        );
    });

    it("warns when no bytes remain", async () => {
        state.started = { ...state.started, maxBytes: 0 };
        let limits = 0;
        const { capture, hooks } = await startTauri({ onLimit: () => (limits += 1) });
        emit([0.5]);
        emit([0.5]);
        expect(limits).toBe(1);
        expect(hooks.onChunk).not.toHaveBeenCalled();
        await capture.discard();
        expect(hooks.onDiscard).toHaveBeenCalled();
    });

    it("stops transferring when the audio queue falls behind", async () => {
        const gate = deferred();
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "append_audio_capture_chunk") return gate.promise;
            if (command === "finish_audio_capture")
                return { byteCount: 0, sampleCount: state.finishSampleCount };
            return undefined;
        };
        state.finishSampleCount = "300000";
        let limits = 0;
        const { capture, hooks } = await startTauri({ onLimit: () => (limits += 1) });
        emit(new Float32Array(300_000));
        emit(new Float32Array(300_000));
        expect(limits).toBe(1);
        gate.resolve();
        await tick();
        await capture.stop();
        expect(hooks.onFinished).toHaveBeenCalledWith(
            expect.objectContaining({
                interruptedReason: expect.stringMatching(/transfer fell behind/u),
            }),
        );
    });

    it("stops when archive writes fall behind", async () => {
        const gate = deferred();
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "finish_audio_capture")
                return { byteCount: 0, sampleCount: state.finishSampleCount };
            return undefined;
        };
        state.finishSampleCount = "524288";
        let limits = 0;
        const archive = makeHooks({ onChunk: async () => gate.promise });
        const { capture } = await startTauri({
            onLimit: () => (limits += 1),
            archive,
        });
        emit(new Float32Array(524_288));
        await tick();
        await tick();
        emit(new Float32Array(524_288));
        await tick();
        expect(limits).toBe(1);
        gate.resolve();
        await capture.stop();
        expect(archive.onFinished).toHaveBeenCalledWith(
            expect.objectContaining({
                interruptedReason: expect.stringMatching(/Archive writing fell behind/u),
            }),
        );
    });

    it("records archive failures and keeps committed audio", async () => {
        let chunks = 0;
        state.finishSampleCount = "524288";
        const { capture, hooks } = await startTauri(
            {},
            {
                onChunk: async () => {
                    chunks += 1;
                    if (chunks === 2) throw new Error("archive offline");
                },
            },
        );
        emit(new Float32Array(524_288));
        await tick();
        await tick();
        emit(new Float32Array(524_288));
        await tick();
        await tick();
        const result = await capture.stop();
        expect(result.warning).toMatch(/Could not commit microphone audio/u);
        expect(hooks.onFinished).toHaveBeenCalledWith(
            expect.objectContaining({
                interruptedReason: expect.stringMatching(/Could not commit microphone audio/u),
            }),
        );
    });

    it("records host transfer failures with the original detail", async () => {
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "append_audio_capture_chunk") throw new Error("ipc closed");
            if (command === "finish_audio_capture")
                return { byteCount: 0, sampleCount: state.finishSampleCount };
            return undefined;
        };
        state.finishSampleCount = "1";
        const { capture } = await startTauri();
        emit([0.5]);
        await tick();
        await tick();
        const result = await capture.stop();
        expect(result.warning).toMatch(/desktop audio transfer stopped: ipc closed/u);
    });

    it("handles non-Error host transfer failures", async () => {
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "append_audio_capture_chunk") throw "socket lost";
            if (command === "finish_audio_capture")
                return { byteCount: 0, sampleCount: state.finishSampleCount };
            return undefined;
        };
        state.finishSampleCount = "1";
        const { capture } = await startTauri();
        emit([0.5]);
        await tick();
        await tick();
        const result = await capture.stop();
        expect(result.warning).toMatch(/socket lost/u);
    });

    it("skips queued audio transfers after the first upload failure", async () => {
        const gate = deferred();
        let transfers = 0;
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "append_audio_capture_chunk") {
                transfers += 1;
                return gate.promise;
            }
            if (command === "finish_audio_capture")
                return { byteCount: 0, sampleCount: state.finishSampleCount };
            return undefined;
        };
        state.finishSampleCount = "2";
        const { capture } = await startTauri();
        emit([0.5]);
        emit([0.5]);
        await tick();
        gate.reject(new Error("ipc closed"));
        await tick();
        await tick();
        await capture.stop();
        expect(transfers).toBe(1);
    });

    it("treats missing samples as silence", async () => {
        const { capture } = await startTauri();
        lastContext().processor!.onaudioprocess!({
            inputBuffer: {
                getChannelData: () => ({ length: 2, 0: 0.5 }) as unknown as Float32Array,
            },
        });
        state.finishSampleCount = "2";
        await capture.stop();
        const append = state.calls.find((call) => call.command === "append_audio_capture_chunk");
        expect(append!.args!["samples"]).toEqual(
            Array.from(new Uint8Array(new Int16Array([16384, 0]).buffer)),
        );
    });
});

describe("desktop live transcription", () => {
    it("skips live chunks when live transcription is disabled", async () => {
        const { capture, hooks } = await startTauri(
            {},
            { onLiveChunk: vi.fn(async () => undefined), isLiveEnabled: () => false },
        );
        emit(new Float32Array(16_384));
        state.finishSampleCount = "16384";
        await capture.stop();
        expect(hooks.onLiveChunk).not.toHaveBeenCalled();
    });

    it("joins buffered live chunks and flushes them on stop", async () => {
        const { capture, hooks } = await startTauri(
            {},
            { onLiveChunk: vi.fn(async () => undefined), isLiveEnabled: () => true },
        );
        emit(new Float32Array(8_192));
        emit(new Float32Array(8_192));
        state.finishSampleCount = "16384";
        await capture.stop();
        expect(hooks.onLiveChunk).toHaveBeenCalledWith(
            expect.objectContaining({ sequence: 0, firstSampleIndex: "0" }),
        );
        const chunk = vi.mocked(hooks.onLiveChunk!).mock.calls[0]![0];
        expect(chunk.samples.byteLength).toBe(32_768);
    });

    it("reports live transcription failures", async () => {
        const failure = vi.fn();
        const { capture } = await startTauri(
            {},
            {
                onLiveChunk: async () => {
                    throw new Error("whisper crashed");
                },
                onLiveFailure: failure,
            },
        );
        emit(new Float32Array(16_384));
        await tick();
        state.finishSampleCount = "16384";
        await capture.stop();
        expect(failure).toHaveBeenCalledWith(
            expect.stringMatching(/Live transcription stopped: whisper crashed/u),
        );
    });

    it("stops live transcription when it falls behind", async () => {
        const gate = deferred();
        void gate.promise.catch(() => undefined);
        const failure = vi.fn();
        const { capture } = await startTauri(
            {},
            {
                onLiveChunk: async () => gate.promise,
                onLiveFailure: failure,
            },
        );
        for (let index = 0; index < 128; index += 1) {
            emit(new Float32Array(16_384));
            if (index % 8 === 0) await tick();
        }
        await tick();
        emit(new Float32Array(16_384));
        expect(failure).toHaveBeenCalledWith(
            expect.stringMatching(/Live transcription fell behind/u),
        );
        gate.reject(new Error("late failure"));
        await tick();
        await tick();
        state.finishSampleCount = String(129 * 16_384);
        await capture.stop();
        expect(failure).toHaveBeenCalledTimes(1);
    });
});

describe("desktop pause, resume, and stop", () => {
    it("tracks pause duration across resume", async () => {
        const { capture, hooks } = await startTauri();
        emit([0.5]);
        vi.mocked(performance.now).mockReturnValueOnce(1_000).mockReturnValueOnce(4_000);
        await capture.pause();
        expect(hooks.onPaused).toHaveBeenCalled();
        expect(mediaStream.tracks[0]!.enabled).toBe(false);

        await capture.resume();
        expect(hooks.onResumed).toHaveBeenCalled();
        expect(mediaStream.tracks[0]!.enabled).toBe(true);

        state.finishSampleCount = "1";
        const result = await capture.stop();
        expect(result.pauseCount).toBe(1);
        expect(result.pausedDurationUs).toBe("3000000");
        expect(state.calls.some((call) => call.command === "pause_audio_capture")).toBe(true);
        expect(state.calls.some((call) => call.command === "resume_audio_capture")).toBe(true);
    });

    it("rejects invalid pause and resume transitions", async () => {
        const { capture } = await startTauri();
        await expect(capture.resume()).rejects.toThrow(/cannot be resumed/u);
        await capture.pause();
        await expect(capture.pause()).rejects.toThrow(/cannot be paused/u);
        await capture.discard();
        await expect(capture.pause()).rejects.toThrow(/cannot be paused/u);
        await expect(capture.resume()).rejects.toThrow(/cannot be resumed/u);
    });

    it("rolls back a failed pause", async () => {
        const failure = new Error("pause rejected");
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "pause_audio_capture") throw failure;
            return undefined;
        };
        const { capture } = await startTauri();
        await expect(capture.pause()).rejects.toBe(failure);
        expect(lastContext().resume).toHaveBeenCalled();
        expect(mediaStream.tracks[0]!.enabled).toBe(true);
        await capture.discard();
    });

    it("rolls back a failed resume", async () => {
        const failure = new Error("resume rejected");
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "resume_audio_capture") throw failure;
            return undefined;
        };
        const { capture } = await startTauri();
        await capture.pause();
        await expect(capture.resume()).rejects.toBe(failure);
        expect(lastContext().suspend).toHaveBeenCalled();
        expect(state.calls.some((call) => call.command === "pause_audio_capture")).toBe(true);
        await capture.discard();
    });

    it("tolerates every resume rollback failure", async () => {
        let pauseCalls = 0;
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "resume_audio_capture") throw new Error("resume rejected");
            if (command === "pause_audio_capture") {
                pauseCalls += 1;
                if (pauseCalls > 1) throw new Error("pause rejected");
                return undefined;
            }
            return undefined;
        };
        const { capture } = await startTauri(
            {},
            {
                onPaused: vi
                    .fn(async () => undefined)
                    .mockResolvedValueOnce(undefined)
                    .mockRejectedValueOnce(new Error("pause hook failed")),
            },
        );
        await capture.pause();
        FakeAudioContext.failSuspend = new Error("suspend failed");
        await expect(capture.resume()).rejects.toThrow(/resume rejected/u);
        await capture.discard();
    });

    it("tolerates a non-Error resume failure", async () => {
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "resume_audio_capture") throw "resume halted";
            return undefined;
        };
        const { capture } = await startTauri();
        await capture.pause();
        await expect(capture.resume()).rejects.toThrow("resume halted");
        await capture.discard();
    });

    it("tolerates every pause rollback failure", async () => {
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "pause_audio_capture") throw new Error("pause rejected");
            if (command === "resume_audio_capture") throw new Error("resume rejected");
            return undefined;
        };
        const { capture } = await startTauri();
        FakeAudioContext.failResume = new Error("context resume failed");
        await expect(capture.pause()).rejects.toThrow(/pause rejected/u);
        await capture.discard();
    });

    it("tolerates a non-Error pause failure", async () => {
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "pause_audio_capture") throw "pause halted";
            return undefined;
        };
        const { capture } = await startTauri();
        await expect(capture.pause()).rejects.toThrow("pause halted");
        await capture.discard();
    });

    it("skips rollback when stopping during a failed pause", async () => {
        const holder: { capture?: Awaited<ReturnType<typeof startMicrophoneCapture>> } = {};
        const { capture } = await startTauri(
            {},
            {
                onPaused: async () => {
                    state.finishSampleCount = "1";
                    await holder.capture!.stop();
                    throw new Error("pause failed after stop");
                },
            },
        );
        holder.capture = capture;
        emit([0.5]);
        await expect(capture.pause()).rejects.toThrow(/pause failed after stop/u);
    });

    it("flushes a chunk queued while waiting for the archive", async () => {
        const gate = deferred();
        let chunks = 0;
        const onChunk = vi.fn(async () => {
            chunks += 1;
            if (chunks === 1) await gate.promise;
        });
        const archive = makeHooks({ onChunk });
        const { capture } = await startTauri({ archive });
        emit(new Float32Array(524_288));
        await tick();
        emit(new Float32Array(262_144));
        const pausing = capture.pause();
        const stopping = capture.stop();
        gate.resolve();
        await pausing;
        await stopping;
        expect(onChunk).toHaveBeenCalledTimes(2);
    });

    it("rethrows an archive failure detected while flushing", async () => {
        const gate = deferred();
        let chunks = 0;
        const onChunk = vi.fn(async () => {
            chunks += 1;
            if (chunks === 1) await gate.promise;
        });
        const archive = makeHooks({ onChunk });
        const { capture } = await startTauri({ archive });
        emit(new Float32Array(524_288));
        await tick();
        emit(new Float32Array(262_144));
        const pausing = capture.pause();
        await tick();
        gate.reject(new Error("archive offline"));
        await expect(pausing).rejects.toThrow(/Could not commit microphone audio/u);
        await capture.discard();
    });

    it("returns early when stopped during resume", async () => {
        const holder: { capture?: Awaited<ReturnType<typeof startMicrophoneCapture>> } = {};
        const { capture } = await startTauri(
            {},
            {
                onResumed: async () => {
                    state.finishSampleCount = "1";
                    await holder.capture!.stop();
                },
            },
        );
        holder.capture = capture;
        emit([0.5]);
        vi.mocked(performance.now).mockReturnValue(2_000);
        await capture.pause();
        await expect(capture.resume()).resolves.toBeUndefined();
    });

    it("flushes a queued archive chunk during pause", async () => {
        const gate = deferred();
        let chunks = 0;
        const onChunk = vi.fn(async () => {
            chunks += 1;
            if (chunks === 1) await gate.promise;
        });
        const hooks = makeHooks({ onChunk });
        const { capture } = await startTauri({ archive: hooks });
        emit(new Float32Array(524_288));
        await tick();
        emit(new Float32Array(262_144));
        const pausing = capture.pause();
        await tick();
        gate.resolve();
        await pausing;
        expect(onChunk).toHaveBeenCalledTimes(2);
        await capture.discard();
    });

    it("rejects stop when the archive failed during pause", async () => {
        let chunks = 0;
        const { capture } = await startTauri(
            {},
            {
                onChunk: async () => {
                    chunks += 1;
                    if (chunks === 1) throw new Error("archive offline");
                },
            },
        );
        emit(new Float32Array(524_288));
        await tick();
        await tick();
        await expect(capture.pause()).rejects.toThrow(/Could not commit microphone audio/u);
        await expect(capture.stop()).rejects.toThrow(/did not provide any audio/u);
    });

    it("wraps an archive failure raised while stopping", async () => {
        const { capture } = await startTauri();
        const internals = capture as unknown as {
            flushArchiveChunk(): Promise<void>;
        };
        internals.flushArchiveChunk = async () => {
            throw new Error("flush failed");
        };
        await expect(capture.stop()).rejects.toThrow(/did not provide any audio/u);
    });

    it("guards empty and already-failed archive queues", async () => {
        const { capture, hooks } = await startTauri();
        const internals = capture as unknown as {
            archiveBufferedBytes: number;
            archiveBuffers: Uint8Array[];
            archiveError: string;
            archiveChain: Promise<void>;
            queueArchiveChunk(): void;
        };
        internals.archiveBufferedBytes = 0;
        internals.queueArchiveChunk();

        internals.archiveError = "archive failed";
        internals.archiveBufferedBytes = 2;
        internals.archiveBuffers = [new Uint8Array([1, 2])];
        internals.archiveChain = Promise.resolve();
        internals.queueArchiveChunk();
        await internals.archiveChain;

        expect(hooks.onChunk).not.toHaveBeenCalled();
        await capture.discard();
    });

    it("discards an empty capture", async () => {
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "discard_audio_capture") throw new Error("discard failed");
            return undefined;
        };
        const { capture, hooks } = await startTauri();
        await expect(capture.stop()).rejects.toThrow(/did not provide any audio/u);
        expect(hooks.onDiscard).toHaveBeenCalled();
        expect(state.calls.map((call) => call.command)).toContain("discard_audio_capture");
        await expect(capture.stop()).rejects.toThrow(/already stopped/u);
        await expect(capture.discard()).resolves.toBeUndefined();
    });

    it("warns when the host reports a different sample count", async () => {
        const { capture, hooks } = await startTauri();
        emit([0.5]);
        state.finishSampleCount = "99";
        const result = await capture.stop();
        expect(result.warning).toMatch(/different sample count/u);
        expect(hooks.onFinished).toHaveBeenCalledWith(
            expect.objectContaining({
                interruptedReason: expect.stringMatching(/different sample/u),
            }),
        );
    });

    it("warns when the host finish command fails", async () => {
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "finish_audio_capture") throw new Error("host gone");
            return undefined;
        };
        const { capture } = await startTauri();
        emit([0.5]);
        const result = await capture.stop();
        expect(result.warning).toMatch(/capture host ended early: host gone/u);
    });

    it("prefers an explicit interruption reason", async () => {
        const { capture, hooks } = await startTauri();
        emit([0.5]);
        state.finishSampleCount = "1";
        await capture.stop("device disconnected");
        expect(hooks.onFinished).toHaveBeenCalledWith(
            expect.objectContaining({ interruptedReason: "device disconnected" }),
        );
    });

    it("discards live and buffered audio", async () => {
        state.handler = async (command) => {
            if (command === "begin_audio_capture") return state.started;
            if (command === "discard_audio_capture") throw new Error("discard failed");
            return undefined;
        };
        const { capture, hooks } = await startTauri(
            {},
            { onLiveChunk: vi.fn(async () => undefined) },
        );
        emit(new Float32Array(4_096));
        await capture.discard();
        expect(hooks.onDiscard).toHaveBeenCalled();
        expect(lastContext().close).toHaveBeenCalled();
        expect(mediaStream.tracks[0]!.stop).toHaveBeenCalled();
        await expect(capture.discard()).resolves.toBeUndefined();
    });

    it("tolerates a close failure during shutdown", async () => {
        FakeAudioContext.failClose = new Error("already closed");
        const { capture } = await startTauri();
        await expect(capture.discard()).resolves.toBeUndefined();
    });
});
