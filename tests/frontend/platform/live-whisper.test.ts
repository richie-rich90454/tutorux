import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockState {
    tauri: boolean;
    calls: { command: string; args: unknown }[];
    handler: (command: string, args?: unknown) => Promise<unknown>;
}

const state = vi.hoisted((): MockState => ({
    tauri: false,
    calls: [],
    handler: async () => undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
    isTauri: () => state.tauri,
    invoke: (command: string, args?: unknown) => {
        state.calls.push({ command, args });
        return state.handler(command, args);
    },
}));

import {
    acknowledgeLiveWhisperCues,
    beginLiveWhisper,
    cancelLiveWhisper,
    endLiveWhisper,
    enqueueLiveWhisperAudio,
    finishLiveWhisper,
    pollLiveWhisper,
} from "../../../frontend/platform/live-whisper";

const settings = { language: "auto", windowSeconds: 12, threadCount: 4 };

beforeEach(() => {
    state.tauri = true;
    state.calls = [];
    state.handler = async () => undefined;
});

describe("live Whisper bridge", () => {
    it("rejects every call outside the desktop app", async () => {
        state.tauri = false;
        await expect(
            beginLiveWhisper({ settings, sampleRateHz: 16_000, firstSampleIndex: "0" }),
        ).rejects.toThrow(/desktop app/u);
    });

    it("validates the language code", async () => {
        await expect(
            beginLiveWhisper({
                settings: { ...settings, language: "12" },
                sampleRateHz: 16_000,
                firstSampleIndex: "0",
            }),
        ).rejects.toThrow(/language code/u);
        await expect(
            beginLiveWhisper({
                settings: { ...settings, language: "toolonglanguagecode" },
                sampleRateHz: 16_000,
                firstSampleIndex: "0",
            }),
        ).rejects.toThrow(/language code/u);
        expect(state.calls).toEqual([]);
    });

    it("validates the window duration", async () => {
        for (const windowSeconds of [1.5, 0, 28]) {
            await expect(
                beginLiveWhisper({
                    settings: { ...settings, windowSeconds },
                    sampleRateHz: 16_000,
                    firstSampleIndex: "0",
                }),
            ).rejects.toThrow(/1 and 27 seconds/u);
        }
        expect(state.calls).toEqual([]);
    });

    it("validates the thread count", async () => {
        for (const threadCount of [1.5, 0, 65]) {
            await expect(
                beginLiveWhisper({
                    settings: { ...settings, threadCount },
                    sampleRateHz: 16_000,
                    firstSampleIndex: "0",
                }),
            ).rejects.toThrow(/1 and 64/u);
        }
        expect(state.calls).toEqual([]);
    });

    it("starts a run with a trimmed language", async () => {
        state.handler = async () => ({
            runId: "run-1",
            modelName: "whisper",
            backendVersion: "1",
        });
        await expect(
            beginLiveWhisper({
                settings: { ...settings, language: "  EN  " },
                sampleRateHz: 16_000,
                firstSampleIndex: "42",
            }),
        ).resolves.toEqual({ runId: "run-1", modelName: "whisper", backendVersion: "1" });
        expect(state.calls).toEqual([
            {
                command: "begin_live_whisper",
                args: {
                    language: "EN",
                    windowSeconds: 12,
                    threadCount: 4,
                    sampleRateHz: 16_000,
                    firstSampleIndex: "42",
                    timelineBaseSampleIndex: "0",
                },
            },
        ]);
    });

    it("forwards PCM chunks as byte arrays", async () => {
        await enqueueLiveWhisperAudio("run-1", {
            sequence: 3,
            firstSampleIndex: "10",
            sampleRateHz: 16_000,
            samples: new Uint8Array([1, 2, 3]),
        });
        expect(state.calls).toEqual([
            {
                command: "enqueue_live_whisper_audio",
                args: {
                    runId: "run-1",
                    sequence: 3,
                    firstSampleIndex: "10",
                    sampleRateHz: 16_000,
                    samples: [1, 2, 3],
                },
            },
        ]);
    });

    it("polls, acknowledges, cancels, finishes, and ends a run", async () => {
        await pollLiveWhisper("run-1");
        await acknowledgeLiveWhisperCues("run-1", "9");
        await cancelLiveWhisper("run-1");
        await finishLiveWhisper("run-1");
        await endLiveWhisper("run-1");
        expect(state.calls).toEqual([
            { command: "poll_live_whisper", args: { runId: "run-1" } },
            {
                command: "acknowledge_live_whisper_cues",
                args: { runId: "run-1", throughSequence: "9" },
            },
            { command: "cancel_live_whisper", args: { runId: "run-1" } },
            { command: "finish_live_whisper", args: { runId: "run-1" } },
            { command: "end_live_whisper", args: { runId: "run-1" } },
        ]);
    });
});
