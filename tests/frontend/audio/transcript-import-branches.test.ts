import { describe, expect, it } from "vitest";
import { transcriptCueBatches } from "../../../frontend/audio/transcript-import";

async function* chunksOf(value: string, size = 5): AsyncGenerator<Uint8Array> {
    const bytes = new TextEncoder().encode(value);
    for (let offset = 0; offset < bytes.length; offset += size) {
        yield bytes.slice(offset, offset + size);
    }
}

async function collect(
    source: AsyncIterable<Uint8Array | string>,
    format: "text" | "srt" | "vtt",
): Promise<string[]> {
    const texts: string[] = [];
    for await (const batch of transcriptCueBatches(source, format, 10)) {
        for (const cue of batch) texts.push(cue.text);
    }
    return texts;
}

describe("subtitle block flushing", () => {
    it("ignores a blank line that follows an already flushed cue", async () => {
        const cues = await collect(
            chunksOf(
                [
                    "1",
                    "00:00:01,000 --> 00:00:02,000",
                    "First",
                    "",
                    "",
                    "2",
                    "00:00:03,000 --> 00:00:04,000",
                    "Second",
                    "",
                ].join("\n"),
            ),
            "srt",
        );
        expect(cues).toEqual(["First", "Second"]);
    });

    it("skips extra header metadata lines before the first WebVTT cue", async () => {
        const cues = await collect(
            chunksOf(
                [
                    "WEBVTT",
                    "Kind: captions",
                    "Language: en",
                    "",
                    "00:00:01.000 --> 00:00:02.000",
                    "Hello",
                    "",
                ].join("\n"),
            ),
            "vtt",
        );
        expect(cues).toEqual(["Hello"]);
    });
});
