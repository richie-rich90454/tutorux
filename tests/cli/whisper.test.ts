import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultWhisperThreads, transcriptionWindowSeconds } from "../../cli/whisper";

describe("Whisper thread defaults", () => {
    it("uses the hardware thread count capped at eight", () => {
        const threads = defaultWhisperThreads();
        expect(threads).toBe(Math.min(8, Math.max(1, availableParallelism())));
        expect(threads).toBeGreaterThanOrEqual(1);
        expect(threads).toBeLessThanOrEqual(8);
    });
});

describe("Whisper transcription windows", () => {
    it("fits both stored PCM and the 16-bit preview to their byte limits", () => {
        for (const [rate, channels, bytesPerSample] of [
            [16_000, 1, 2],
            [48_000, 2, 2],
            [48_000, 2, 4],
            [192_000, 8, 1],
            [384_000, 8, 4],
        ] as const) {
            const seconds = transcriptionWindowSeconds(rate, channels, bytesPerSample);
            expect(seconds).toBeGreaterThanOrEqual(1n);
            expect(seconds * BigInt(rate * channels * bytesPerSample)).toBeLessThanOrEqual(
                28n * 1024n * 1024n,
            );
            expect(seconds * BigInt(rate * channels * 2)).toBeLessThanOrEqual(32n * 1024n * 1024n);
        }
    });

    it("rejects invalid recording metadata", () => {
        expect(() => transcriptionWindowSeconds(0, 1, 2)).toThrow();
        expect(() => transcriptionWindowSeconds(48_000, 0, 2)).toThrow();
        expect(() => transcriptionWindowSeconds(48_000, 2, 0)).toThrow();
    });
});
