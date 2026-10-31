import { describe, expect, it } from "vitest";
import type { ArchiveRecord } from "../../../frontend/archive/format";
import {
    importTranscriptBatches,
    transcriptCueBatches,
} from "../../../frontend/audio/transcript-import";

async function* chunksOf(value: string): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < value.length; offset += 7) {
        yield new TextEncoder().encode(value.slice(offset, offset + 7));
    }
}

function srtCue(index: number): string {
    return `${index + 1}\n00:00:${String(index % 59).padStart(2, "0")},000 --> 00:00:${String((index % 59) + 1).padStart(2, "0")},000\nCue ${index}\n\n`;
}

describe("bounded transcript import", () => {
    it("parses plain text cues in bounded batches", async () => {
        const source = Array.from({ length: 300 }, (_, index) => `Line ${index}`).join("\n");
        const batches: number[] = [];
        for await (const batch of transcriptCueBatches(chunksOf(source), "text", 128)) {
            batches.push(batch.length);
        }
        expect(batches).toEqual([128, 128, 44]);
    });

    it("keeps earlier committed cues when a later subtitle is malformed", async () => {
        const valid = Array.from({ length: 129 }, (_, index) => srtCue(index)).join("");
        const malformed = "130\nnot a timestamp --> later\nBroken cue\n";
        const commits: ArchiveRecord[][] = [];
        await expect(
            importTranscriptBatches({
                source: chunksOf(valid + malformed),
                format: "srt",
                sessionId: crypto.randomUUID(),
                filename: "late-failure.srt",
                expectedGeneration: 1n,
                batchSize: 128,
                commit: async (records) => {
                    commits.push([...records]);
                    return [...records];
                },
            }),
        ).rejects.toThrow();

        expect(commits).toHaveLength(1);
        expect(commits[0]).toHaveLength(128);
        expect(commits[0]![0]!.fields.get("text")).toBe("Cue 0");
        expect(commits[0]!.at(-1)!.fields.get("text")).toBe("Cue 127");
    });

    it("accepts WebVTT metadata blocks without counting them as cues", async () => {
        const source = [
            "WEBVTT",
            "",
            "NOTE ignored metadata",
            "still metadata",
            "",
            "00:01.000 --> 00:02.000",
            "Hello",
            "",
        ].join("\n");
        const cues = [];
        for await (const batch of transcriptCueBatches(chunksOf(source), "vtt", 10)) {
            cues.push(...batch);
        }
        expect(cues).toHaveLength(1);
        expect(cues[0]!.text).toBe("Hello");
        expect(cues[0]!.startTimeUs).toBe(1_000_000n);
    });
});
