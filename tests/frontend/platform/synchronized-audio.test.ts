import { beforeEach, describe, expect, it, vi } from "vitest";

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
    listNativeSynchronizedAudioDevices,
    preflightNativeMicrophone,
    startNativeSynchronizedAudioCapture,
    type MicrophonePreflightLevel,
    type NativeSynchronizedAudioArchiveHooks,
    type NativeSynchronizedAudioDevices,
    type NativeSynchronizedAudioStarted,
} from "../../../frontend/platform/synchronized-audio";

const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = "1700000000000000";

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
    invokeHandler = async () => {
        throw new Error("unexpected invoke");
    };
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

describe("synchronized audio device bridge", () => {
    it("lists devices through the native command", async () => {
        const devices: NativeSynchronizedAudioDevices = {
            microphones: [
                {
                    deviceId: "mic-1",
                    label: "Built-in microphone",
                    backend: "coreaudio",
                    source: "microphone",
                    isDefault: true,
                },
            ],
            systemAudio: [],
            applicationAudio: [],
            microphoneAvailable: true,
            systemAudioAvailable: false,
            applicationAudioAvailable: false,
            systemAudioUnavailableReason: "Not supported on this platform.",
        };
        invokeHandler = async () => devices;

        await expect(listNativeSynchronizedAudioDevices()).resolves.toEqual(devices);
        expect(calls).toEqual([{ command: "list_synchronized_audio_devices" }]);
    });

    it("propagates native device listing errors", async () => {
        invokeHandler = async () => {
            throw new Error("The audio helper is offline.");
        };

        await expect(listNativeSynchronizedAudioDevices()).rejects.toThrow(
            "The audio helper is offline.",
        );
    });

    it("forwards only levels for the active preflight probe", async () => {
        const level: MicrophonePreflightLevel = {
            probeId: "probe-level",
            elapsedMs: 250,
            framesInInterval: 1024,
            framesMeasured: 2048,
            peakLevel: 0.4,
            rmsLevel: 0.2,
            peakDbfs: -8,
            rmsDbfs: -14,
        };
        invokeHandler = async (command, args) => {
            if (command !== "preflight_microphone") throw new Error(`unexpected ${command}`);
            const probeId = String((args as { probeId: string }).probeId);
            eventBus.listeners.get("microphone-preflight-level")?.({
                payload: { ...level, probeId: "someone-else" },
            });
            eventBus.listeners.get("microphone-preflight-level")?.({
                payload: { ...level, probeId },
            });
            return {
                deviceId: "mic-1",
                measuredDurationMs: 250,
                framesMeasured: 2048,
                peakLevel: 0.4,
                rmsLevel: 0.2,
                peakDbfs: -8,
                rmsDbfs: -14,
                signalDetected: true,
            };
        };

        const received: MicrophonePreflightLevel[] = [];
        const summary = await preflightNativeMicrophone("mic-1", (value) => received.push(value));

        expect(calls[0]).toEqual({
            command: "preflight_microphone",
            args: { deviceId: "mic-1", probeId: expect.any(String) },
        });
        expect(received).toEqual([
            { ...level, probeId: (calls[0]!.args as { probeId: string }).probeId },
        ]);
        expect(summary.signalDetected).toBe(true);
        expect(eventBus.listeners.has("microphone-preflight-level")).toBe(false);
    });
});

describe("synchronized audio capture bridge", () => {
    it("requires explicit consent before invoking native capture", async () => {
        await expect(
            startNativeSynchronizedAudioCapture({
                consentConfirmed: false,
                consentAtUs: TIMESTAMP,
                microphoneDeviceId: "mic-1",
                systemAudioDeviceId: null,
                applicationAudioDeviceId: null,
                captureId: CAPTURE_ID,
                archive: archiveHooks(),
                onSourceFailure: () => undefined,
            }),
        ).rejects.toThrow(/agreed before starting capture/u);
        expect(calls).toEqual([]);
    });

    it("maps a native start failure and discards the capture", async () => {
        invokeHandler = async (command) => {
            if (command === "begin_synchronized_audio_capture")
                throw new Error("The native capture helper crashed.");
            if (command === "discard_synchronized_audio_capture") return undefined;
            throw new Error(`unexpected ${command}`);
        };

        await expect(
            startNativeSynchronizedAudioCapture({
                consentConfirmed: true,
                consentAtUs: TIMESTAMP,
                microphoneDeviceId: "mic-1",
                systemAudioDeviceId: null,
                applicationAudioDeviceId: null,
                captureId: CAPTURE_ID,
                archive: archiveHooks(),
                onSourceFailure: () => undefined,
            }),
        ).rejects.toThrow("The native capture helper crashed.");
        expect(calls.map((call) => call.command)).toEqual([
            "begin_synchronized_audio_capture",
            "discard_synchronized_audio_capture",
        ]);
    });

    it("rejects an out-of-range native sample rate", async () => {
        invokeHandler = async (command) => {
            if (command === "begin_synchronized_audio_capture")
                return started({ microphoneSampleRateHz: 4_000 });
            if (command === "discard_synchronized_audio_capture") return undefined;
            throw new Error(`unexpected ${command}`);
        };

        await expect(
            startNativeSynchronizedAudioCapture({
                consentConfirmed: true,
                consentAtUs: TIMESTAMP,
                microphoneDeviceId: "mic-1",
                systemAudioDeviceId: null,
                applicationAudioDeviceId: null,
                captureId: CAPTURE_ID,
                archive: archiveHooks(),
                onSourceFailure: () => undefined,
            }),
        ).rejects.toThrow(/unsupported sample rate/u);
    });

    it("rejects an unsupported native sample format with a clear message", async () => {
        invokeHandler = async (command) => {
            if (command === "begin_synchronized_audio_capture")
                return started({ microphoneSampleFormat: "pcm_f64le" });
            if (command === "discard_synchronized_audio_capture") return undefined;
            if (command === "activate_synchronized_audio_capture") return undefined;
            throw new Error(`unexpected ${command}`);
        };

        await expect(
            startNativeSynchronizedAudioCapture({
                consentConfirmed: true,
                consentAtUs: TIMESTAMP,
                microphoneDeviceId: "mic-1",
                systemAudioDeviceId: null,
                applicationAudioDeviceId: null,
                captureId: CAPTURE_ID,
                archive: archiveHooks(),
                onSourceFailure: () => undefined,
            }),
        ).rejects.toThrow(/unsupported sample format/iu);
    });

    it("starts capture and maps native source failures to the selected track", async () => {
        const startedCapture = started({ systemAudioSampleRateHz: 16_000 });
        invokeHandler = async (command) => {
            switch (command) {
                case "begin_synchronized_audio_capture":
                    return startedCapture;
                case "activate_synchronized_audio_capture":
                    return undefined;
                case "stop_synchronized_audio_source":
                    return undefined;
                case "discard_synchronized_audio_capture":
                    return undefined;
                default:
                    throw new Error(`unexpected ${command}`);
            }
        };
        const archive = archiveHooks();
        const failures: [string, string][] = [];

        const capture = await startNativeSynchronizedAudioCapture({
            consentConfirmed: true,
            consentAtUs: TIMESTAMP,
            microphoneDeviceId: "mic-1",
            systemAudioDeviceId: "system-1",
            applicationAudioDeviceId: null,
            captureId: CAPTURE_ID,
            archive,
            onSourceFailure: (track, message) => failures.push([track, message]),
        });

        expect(capture.started).toEqual(startedCapture);
        expect(archive.onStarted).toHaveBeenCalledWith(startedCapture);

        eventBus.listeners.get("synchronized-audio-source-failed")?.({
            payload: {
                captureId: CAPTURE_ID,
                track: "system-audio",
                message: "  Cable unplugged  ",
            },
        });

        expect(failures).toEqual([["system-audio", "Cable unplugged"]]);
        expect(calls.some((call) => call.command === "stop_synchronized_audio_source")).toBe(true);

        await capture.discard();
        expect(calls.some((call) => call.command === "discard_synchronized_audio_capture")).toBe(
            true,
        );
    });
});
