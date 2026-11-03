import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SynchronizedRecording } from "../../../frontend/domain/synchronized-recording";

class FakeNode {
    readonly connections: { target: unknown; output: number; input: number }[] = [];
    disconnected = false;

    connect(target: unknown, output = 0, input = 0): void {
        this.connections.push({ target, output, input });
    }

    disconnect(): void {
        this.disconnected = true;
    }
}

class FakeProcessor extends FakeNode {
    onaudioprocess: ((event: unknown) => void) | null = null;
}

class FakeGain extends FakeNode {
    readonly gain = { value: 1 };
}

class FakeTrack {
    enabled = true;
    stopCount = 0;
    private readonly listeners: (() => void)[] = [];

    constructor(readonly kind: "audio" | "video") {}

    addEventListener(_type: string, listener: () => void): void {
        this.listeners.push(listener);
    }

    stop(): void {
        this.stopCount++;
    }

    ended(): void {
        for (const listener of this.listeners) listener();
    }
}

class FakeStream {
    constructor(
        readonly audioTracks: FakeTrack[],
        readonly videoTracks: FakeTrack[] = [],
    ) {}

    getAudioTracks(): FakeTrack[] {
        return this.audioTracks;
    }

    getVideoTracks(): FakeTrack[] {
        return this.videoTracks;
    }

    getTracks(): FakeTrack[] {
        return [...this.audioTracks, ...this.videoTracks];
    }
}

class FakeAudioContext {
    static readonly instances: FakeAudioContext[] = [];

    sampleRate = 48_000;
    resumeImpl: () => Promise<void> = async () => undefined;
    suspendImpl: () => Promise<void> = async () => undefined;
    closeImpl: () => Promise<void> = async () => undefined;
    readonly destination = new FakeNode();
    readonly sources: FakeNode[] = [];
    readonly processors: FakeProcessor[] = [];
    readonly gains: FakeGain[] = [];
    readonly mergers: FakeNode[] = [];

    constructor() {
        FakeAudioContext.instances.push(this);
    }

    resume(): Promise<void> {
        return this.resumeImpl();
    }

    suspend(): Promise<void> {
        return this.suspendImpl();
    }

    close(): Promise<void> {
        return this.closeImpl();
    }

    createMediaStreamSource(): FakeNode {
        const node = new FakeNode();
        this.sources.push(node);
        return node;
    }

    createChannelMerger(): FakeNode {
        const node = new FakeNode();
        this.mergers.push(node);
        return node;
    }

    createScriptProcessor(): FakeProcessor {
        const processor = new FakeProcessor();
        this.processors.push(processor);
        return processor;
    }

    createGain(): FakeGain {
        const gain = new FakeGain();
        this.gains.push(gain);
        return gain;
    }
}

interface FakeMediaDevices {
    getUserMedia: (constraints: unknown) => Promise<FakeStream>;
    getDisplayMedia?: (constraints: unknown) => Promise<FakeStream>;
}

const realNavigator = globalThis.navigator;
const realAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
const realMediaStream = (globalThis as { MediaStream?: unknown }).MediaStream;

class FakeMediaStream {
    constructor(readonly tracks: FakeTrack[] = []) {}

    getAudioTracks(): FakeTrack[] {
        return this.tracks;
    }
}

function installBrowser(mediaDevices: Partial<FakeMediaDevices> | undefined): void {
    Object.defineProperty(globalThis, "navigator", {
        value: mediaDevices === undefined ? {} : { mediaDevices },
        configurable: true,
        writable: true,
    });
    Object.defineProperty(globalThis, "AudioContext", {
        value: FakeAudioContext,
        configurable: true,
        writable: true,
    });
    Object.defineProperty(globalThis, "MediaStream", {
        value: FakeMediaStream,
        configurable: true,
        writable: true,
    });
}

function restoreBrowser(): void {
    Object.defineProperty(globalThis, "navigator", {
        value: realNavigator,
        configurable: true,
        writable: true,
    });
    if (realAudioContext === undefined) {
        delete (globalThis as { AudioContext?: unknown }).AudioContext;
    } else {
        Object.defineProperty(globalThis, "AudioContext", {
            value: realAudioContext,
            configurable: true,
            writable: true,
        });
    }
    if (realMediaStream === undefined) {
        delete (globalThis as { MediaStream?: unknown }).MediaStream;
    } else {
        Object.defineProperty(globalThis, "MediaStream", {
            value: realMediaStream,
            configurable: true,
            writable: true,
        });
    }
}

function microphoneStream(audio = 1): FakeStream {
    return new FakeStream(Array.from({ length: audio }, () => new FakeTrack("audio")));
}

function sharedStream(audio = 1, video = 1): FakeStream {
    return new FakeStream(
        Array.from({ length: audio }, () => new FakeTrack("audio")),
        Array.from({ length: video }, () => new FakeTrack("video")),
    );
}

function audioEvent(
    length: number,
    channel0: Float32Array,
    channel1: Float32Array = channel0,
): unknown {
    return {
        inputBuffer: {
            length,
            getChannelData: (channel: number) => (channel === 0 ? channel0 : channel1),
        },
    };
}

function processEvent(context: FakeAudioContext, event: unknown): void {
    (context.processors[0]!.onaudioprocess as (value: unknown) => void)(event);
}

async function start(
    options: { deviceId?: string; mediaDevices?: Partial<FakeMediaDevices> } = {},
): Promise<{
    recording: SynchronizedRecording;
    context: FakeAudioContext;
    shared: FakeStream;
    microphone: FakeStream;
    ended: string[];
    limited: number;
}> {
    const shared = sharedStream();
    const microphone = microphoneStream();
    installBrowser({
        getDisplayMedia: async () => shared,
        getUserMedia: async () => microphone,
        ...options.mediaDevices,
    });
    FakeAudioContext.instances.length = 0;
    const ended: string[] = [];
    const state = { limited: 0 };
    const recording = await SynchronizedRecording.start(
        options.deviceId ?? "",
        () => state.limited++,
        (track) => ended.push(track),
    );
    return {
        recording,
        context: FakeAudioContext.instances[0]!,
        shared,
        microphone,
        ended,
        get limited() {
            return state.limited;
        },
    };
}

beforeEach(() => {
    FakeAudioContext.instances.length = 0;
});

afterEach(() => {
    restoreBrowser();
    vi.restoreAllMocks();
});

describe("SynchronizedRecording.start", () => {
    it.each([
        ["missing media devices", undefined],
        ["missing display capture", { getUserMedia: async () => microphoneStream() }],
        ["missing microphone capture", { getDisplayMedia: async () => sharedStream() }],
    ] as const)("rejects %s", async (_label, mediaDevices) => {
        installBrowser(mediaDevices);
        await expect(
            SynchronizedRecording.start(
                "",
                () => undefined,
                () => undefined,
            ),
        ).rejects.toThrow(/cannot capture microphone and shared audio/u);
    });

    it("rejects a window without Web Audio", async () => {
        installBrowser({ getUserMedia: async () => microphoneStream() });
        delete (globalThis as { AudioContext?: unknown }).AudioContext;
        await expect(
            SynchronizedRecording.start(
                "",
                () => undefined,
                () => undefined,
            ),
        ).rejects.toThrow(/cannot capture microphone and shared audio/u);
    });

    it("rejects a shared stream without audio and stops every track", async () => {
        const shared = sharedStream(0, 2);
        installBrowser({
            getDisplayMedia: async () => shared,
            getUserMedia: async () => microphoneStream(),
        });

        await expect(
            SynchronizedRecording.start(
                "",
                () => undefined,
                () => undefined,
            ),
        ).rejects.toThrow(/did not provide audio/u);
        expect(shared.getTracks().map((track) => track.stopCount)).toEqual([1, 1]);
    });

    it("stops the shared stream when microphone capture fails", async () => {
        const shared = sharedStream();
        installBrowser({
            getDisplayMedia: async () => shared,
            getUserMedia: async () => {
                throw new Error("microphone denied");
            },
        });

        await expect(
            SynchronizedRecording.start(
                "",
                () => undefined,
                () => undefined,
            ),
        ).rejects.toThrow("microphone denied");
        expect(shared.getTracks().every((track) => track.stopCount === 1)).toBe(true);
    });

    it("closes a created context when graph setup fails", async () => {
        const shared = sharedStream();
        const microphone = microphoneStream();
        installBrowser({
            getDisplayMedia: async () => shared,
            getUserMedia: async () => microphone,
        });
        FakeAudioContext.instances.length = 0;
        const failGain = vi
            .spyOn(FakeAudioContext.prototype, "createGain")
            .mockImplementation(() => {
                throw new Error("no gain");
            });
        const failClose = vi
            .spyOn(FakeAudioContext.prototype, "close")
            .mockRejectedValue(new Error("close failed"));

        try {
            await expect(
                SynchronizedRecording.start(
                    "",
                    () => undefined,
                    () => undefined,
                ),
            ).rejects.toThrow("no gain");
        } finally {
            failGain.mockRestore();
            failClose.mockRestore();
        }
        expect(shared.getTracks().every((track) => track.stopCount === 1)).toBe(true);
        expect(microphone.getTracks().every((track) => track.stopCount === 1)).toBe(true);
    });

    it("wires the graph and device selection", async () => {
        const fixture = await start({ deviceId: "mic-1" });
        const { context } = fixture;
        expect(context.gains[0]!.gain.value).toBe(0);
        expect(context.sources[0]!.connections[0]).toEqual({
            target: context.mergers[0],
            output: 0,
            input: 0,
        });
        expect(context.sources[1]!.connections[0]).toEqual({
            target: context.mergers[0],
            output: 0,
            input: 1,
        });
        expect(context.mergers[0]!.connections[0]!.target).toBe(context.processors[0]);
        expect(context.processors[0]!.connections[0]!.target).toBe(context.gains[0]);
        expect(context.gains[0]!.connections[0]!.target).toBe(context.destination);

        for (const track of [...fixture.microphone.getAudioTracks(), ...fixture.shared.getTracks()])
            track.ended();
        expect(fixture.ended).toEqual(["microphone", "system-audio", "system-audio"]);

        await fixture.recording.discard();
    });

    it("passes audio-only constraints when no device is selected", async () => {
        const calls: unknown[] = [];
        await start({
            mediaDevices: {
                getUserMedia: async (constraints) => {
                    calls.push(constraints);
                    return microphoneStream();
                },
            },
        });
        expect(calls[0]).toEqual({ audio: true });
    });
});

describe("SynchronizedRecording capture", () => {
    it("writes aligned stereo PCM files", async () => {
        const fixture = await start();
        processEvent(
            fixture.context,
            audioEvent(4, new Float32Array([0.5, -0.5, 2, -2]), new Float32Array([0.25])),
        );

        const result = await fixture.recording.stop();
        expect(result.pauseCount).toBe(0);
        expect(result.files.map((file) => file.name)).toEqual([
            "Microphone.wav",
            "Shared audio.wav",
        ]);
        const microphone = new DataView(await result.files[0].arrayBuffer());
        expect(microphone.getUint32(40, true)).toBe(8);
        expect([0, 1, 2, 3].map((index) => microphone.getInt16(44 + index * 2, true))).toEqual([
            16384, -16384, 32767, -32768,
        ]);
        const shared = new DataView(await result.files[1].arrayBuffer());
        expect([0, 1, 2, 3].map((index) => shared.getInt16(44 + index * 2, true))).toEqual([
            8192, 0, 0, 0,
        ]);
        expect(fixture.microphone.getTracks()[0]!.stopCount).toBe(1);
        expect(fixture.shared.getTracks().every((track) => track.stopCount === 1)).toBe(true);
        expect(fixture.context.processors[0]!.onaudioprocess).toBeNull();
        expect(fixture.context.processors[0]!.disconnected).toBe(true);
        expect(fixture.context.sources.every((node) => node.disconnected)).toBe(true);
    });

    it("ignores samples while paused and after stopping", async () => {
        const fixture = await start();
        const handler = fixture.context.processors[0]!.onaudioprocess!;
        processEvent(fixture.context, audioEvent(1, new Float32Array([1])));
        await fixture.recording.pause();
        (handler as (event: unknown) => void)(audioEvent(1, new Float32Array([1])));
        await fixture.recording.resume();
        (handler as (event: unknown) => void)(audioEvent(1, new Float32Array([1])));
        await expect(fixture.recording.stop()).resolves.toBeDefined();
        (handler as (event: unknown) => void)(audioEvent(1, new Float32Array([1])));
    });

    it("stops when the per-track byte limit is reached", async () => {
        const fixture = await start();
        const sample = {
            get index() {
                return 0;
            },
        };
        processEvent(fixture.context, {
            inputBuffer: {
                length: 33_554_432,
                getChannelData: () => sample,
            },
        });
        expect(fixture.limited).toBe(1);
        processEvent(fixture.context, {
            inputBuffer: { length: 1, getChannelData: () => new Float32Array([0]) },
        });
        expect(fixture.limited).toBe(2);
        await fixture.recording.discard();
    });
});

describe("SynchronizedRecording pause, resume, stop, discard", () => {
    it("pauses and resumes with a paused duration", async () => {
        const fixture = await start();
        processEvent(fixture.context, audioEvent(1, new Float32Array([0.5])));

        await fixture.recording.pause();
        expect(fixture.microphone.getAudioTracks()[0]!.enabled).toBe(false);
        expect(fixture.shared.getAudioTracks()[0]!.enabled).toBe(false);
        await expect(fixture.recording.pause()).rejects.toThrow(/cannot be paused/u);

        await fixture.recording.resume();
        expect(fixture.microphone.getAudioTracks()[0]!.enabled).toBe(true);
        await expect(fixture.recording.resume()).rejects.toThrow(/cannot be resumed/u);

        const result = await fixture.recording.stop();
        expect(result.pauseCount).toBe(1);
        expect(Number(result.pausedDurationUs)).toBeGreaterThanOrEqual(0);
        await expect(fixture.recording.stop()).rejects.toThrow(/already stopped/u);
        await expect(fixture.recording.pause()).rejects.toThrow(/cannot be paused/u);
        await expect(fixture.recording.resume()).rejects.toThrow(/cannot be resumed/u);
    });

    it("restores state when suspending fails", async () => {
        const fixture = await start();
        processEvent(fixture.context, audioEvent(1, new Float32Array([0.5])));
        fixture.context.suspendImpl = async () => {
            throw new Error("suspend failed");
        };
        await expect(fixture.recording.pause()).rejects.toThrow("suspend failed");
        expect(fixture.microphone.getAudioTracks()[0]!.enabled).toBe(true);
        expect(fixture.shared.getAudioTracks()[0]!.enabled).toBe(true);
        const result = await fixture.recording.stop();
        expect(result.pauseCount).toBe(0);
    });

    it("keeps paused state when stop wins the suspend race", async () => {
        const fixture = await start();
        processEvent(fixture.context, audioEvent(1, new Float32Array([0.5])));
        let rejectSuspend: ((error: Error) => void) | undefined;
        fixture.context.suspendImpl = () =>
            new Promise<void>((_resolve, reject) => {
                rejectSuspend = reject;
            });

        const pausing = fixture.recording.pause();
        await Promise.resolve();
        await fixture.recording.stop();
        rejectSuspend!(new Error("suspend failed after stop"));
        await expect(pausing).rejects.toThrow("suspend failed after stop");
        expect(fixture.microphone.getAudioTracks()[0]!.enabled).toBe(false);
    });

    it("returns from resume when the capture stops first", async () => {
        const fixture = await start();
        processEvent(fixture.context, audioEvent(1, new Float32Array([0.5])));
        let resolveResume: (() => void) | undefined;
        fixture.context.resumeImpl = () =>
            new Promise<void>((resolve) => {
                resolveResume = resolve;
            });

        await expect(fixture.recording.resume()).rejects.toThrow(/cannot be resumed/u);
        await fixture.recording.pause();
        fixture.context.resumeImpl = () =>
            new Promise<void>((resolve) => {
                resolveResume = resolve;
            });
        const resuming = fixture.recording.resume();
        await Promise.resolve();
        await fixture.recording.stop();
        resolveResume!();
        await expect(resuming).resolves.toBeUndefined();
    });

    it("rejects stop when no audio was captured", async () => {
        const fixture = await start();
        await expect(fixture.recording.stop()).rejects.toThrow(/did not provide audio/u);
        expect(fixture.microphone.getTracks()[0]!.stopCount).toBe(1);
    });

    it("discards cleanly, once", async () => {
        const fixture = await start();
        processEvent(fixture.context, audioEvent(1, new Float32Array([0.5])));
        await fixture.recording.discard();
        expect(fixture.context.processors[0]!.onaudioprocess).toBeNull();
        expect(fixture.context.sources.every((node) => node.disconnected)).toBe(true);
        await expect(fixture.recording.discard()).resolves.toBeUndefined();
    });

    it("swallows close failures while discarding", async () => {
        const fixture = await start();
        fixture.context.closeImpl = async () => {
            throw new Error("close failed");
        };
        await expect(fixture.recording.discard()).resolves.toBeUndefined();
    });
});
