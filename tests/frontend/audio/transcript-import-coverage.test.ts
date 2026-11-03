import { describe, expect, it } from "vitest";
import type { ArchiveRecord } from "../../../frontend/archive/format";
import {
    importTranscriptBatches,
    transcriptCueBatches,
} from "../../../frontend/audio/transcript-import";

async function* chunksOf(value: string, size = 7): AsyncGenerator<Uint8Array> {
    const bytes = new TextEncoder().encode(value);
    for (let offset = 0; offset < bytes.length; offset += size) {
        yield bytes.slice(offset, offset + size);
    }
}

async function* rawChunks(...chunks: (Uint8Array | string)[]): AsyncGenerator<Uint8Array | string> {
    for (const chunk of chunks) yield chunk;
}

async function collect(
    source: AsyncIterable<Uint8Array | string>,
    format: "text" | "srt" | "vtt",
): Promise<{ text: string; start: bigint | undefined; sourceId: string }[]> {
    const cues = [];
    for await (const batch of transcriptCueBatches(source, format, 10)) {
        for (const cue of batch) {
            cues.push({ text: cue.text, start: cue.startTimeUs, sourceId: cue.sourceId });
        }
    }
    return cues;
}

describe("text cue parsing", () => {
    it("skips blank lines, strips CRLF, and strips a leading BOM", async () => {
        const cues = await collect(rawChunks("\uFEFFfirst\r\n\r\nsecond\r\n"), "text");
        expect(cues.map((cue) => cue.text)).toEqual(["first", "second"]);
        expect(cues.map((cue) => cue.sourceId)).toEqual(["1", "3"]);
    });

    it("strips a BOM and trailing CR from a final unterminated line", async () => {
        expect((await collect(rawChunks("\uFEFFtail"), "text"))[0]!.text).toBe("tail");
        expect((await collect(rawChunks("tail\r"), "text"))[0]!.text).toBe("tail");
    });

    it("accepts plain string chunks", async () => {
        expect((await collect(rawChunks("one\ntwo\n"), "text")).map((cue) => cue.text)).toEqual([
            "one",
            "two",
        ]);
    });

    it("rejects invalid UTF-8 bytes", async () => {
        await expect(collect(rawChunks(new Uint8Array([0xff, 0xfe])), "text")).rejects.toThrow(
            "must be valid UTF-8",
        );
    });

    it("rejects control characters and unpaired surrogates", async () => {
        await expect(collect(rawChunks("bad\u0001line\n"), "text")).rejects.toThrow(
            "unsupported control characters",
        );
        await expect(collect(rawChunks("bad\ud800line\n"), "text")).rejects.toThrow(
            "valid Unicode",
        );
        await expect(collect(rawChunks("bad\udc00line\n"), "text")).rejects.toThrow(
            "valid Unicode",
        );
    });

    it("accepts tabs and valid surrogate pairs", async () => {
        expect((await collect(rawChunks("tab\there 😀\n"), "text"))[0]!.text).toBe("tab\there 😀");
    });

    it("rejects an oversized text cue", async () => {
        const line = "a".repeat(16 * 1024 * 1024 + 1);
        await expect(collect(chunksOf(line, 1 << 20), "text")).rejects.toThrow("exceeds 16 MiB");
    });
});

describe("subtitle parsing branches", () => {
    it("parses an identified cue and keeps the subtitle identifier", async () => {
        const cues = await collect(
            chunksOf("7\n00:00:01,000 --> 00:00:02,000\nHello\nThere\n"),
            "srt",
        );
        expect(cues).toEqual([{ text: "Hello\nThere", start: 1_000_000n, sourceId: "7" }]);
    });

    it("rejects a block without a timestamp", async () => {
        await expect(collect(chunksOf("1\njust text\n"), "srt")).rejects.toThrow(
            "optional identifier followed by a timestamp",
        );
        await expect(
            collect(chunksOf("a\nb\n00:00:01,000 --> 00:00:02,000\nText\n"), "srt"),
        ).rejects.toThrow("optional identifier followed by a timestamp");
    });

    it("rejects a cue without text", async () => {
        await expect(
            collect(chunksOf("1\n00:00:01,000 --> 00:00:02,000\n"), "srt"),
        ).rejects.toThrow("contains no text");
    });

    it("rejects duplicate timestamp separators and reversed ranges", async () => {
        await expect(
            collect(chunksOf("00:00:01,000 --> 00:00:02,000 --> 00:00:03,000\nText\n"), "srt"),
        ).rejects.toThrow("exactly one '-->'");
        await expect(
            collect(chunksOf("00:00:02,000 --> 00:00:01,000\nText\n"), "srt"),
        ).rejects.toThrow("end before they start");
    });

    it("ignores cue settings after the end timestamp", async () => {
        const cues = await collect(
            chunksOf("00:00:01,000 --> 00:00:02,000 align:start\nText\n"),
            "srt",
        );
        expect(cues[0]!.start).toBe(1_000_000n);
    });

    it("rejects an oversized subtitle line", async () => {
        const line = "a".repeat(16 * 1024 * 1024 + 1);
        await expect(collect(chunksOf(line, 1 << 20), "srt")).rejects.toThrow("exceeds 16 MiB");
    });
});

describe("WebVTT parsing branches", () => {
    it("requires a WEBVTT header", async () => {
        await expect(collect(chunksOf("not vtt\n"), "vtt")).rejects.toThrow(
            "must begin with a valid WEBVTT header",
        );
        await expect(collect(rawChunks(""), "vtt")).rejects.toThrow("missing its header");
    });

    it("requires header metadata to end with a blank line", async () => {
        await expect(collect(rawChunks("WEBVTT"), "vtt")).rejects.toThrow(
            "header metadata must end with a blank line",
        );
    });

    it("accepts a tab-delimited header and every metadata block kind", async () => {
        const source = [
            "WEBVTT\tversion",
            "",
            "NOTE",
            "note body",
            "",
            "NOTE spaced",
            "",
            "NOTE\ttabbed",
            "",
            "STYLE",
            "",
            "REGION",
            "",
            "00:00:01.000 --> 00:00:02.000",
            "Hello",
            "",
        ].join("\n");
        const cues = await collect(chunksOf(source), "vtt");
        expect(cues).toEqual([{ text: "Hello", start: 1_000_000n, sourceId: "" }]);
    });

    it("keeps a metadata block that contains a timestamp as a cue", async () => {
        const source = ["WEBVTT", "", "NOTE", "00:00:01.000 --> 00:00:02.000", "Body", ""].join(
            "\n",
        );
        const cues = await collect(chunksOf(source), "vtt");
        expect(cues).toHaveLength(1);
    });
});

describe("batch commit handling", () => {
    const options = (commit: (records: readonly ArchiveRecord[]) => Promise<ArchiveRecord[]>) => ({
        sessionId: crypto.randomUUID(),
        filename: "import.txt",
        expectedGeneration: 1n,
        batchSize: 1,
        commit: (records: readonly ArchiveRecord[]) => commit(records),
    });

    it("returns imported records and the next generation", async () => {
        const result = await importTranscriptBatches({
            source: chunksOf("one\ntwo\n"),
            format: "text",
            ...options(async (records) => [...records]),
        });
        expect(result.imported).toBe(2);
        expect(result.records).toHaveLength(2);
        expect(result.generation).toBe(3n);
        expect(result.error).toBeUndefined();
    });

    it("propagates a commit failure without marking a partial import", async () => {
        await expect(
            importTranscriptBatches({
                source: chunksOf("one\n"),
                format: "text",
                ...options(async () => {
                    throw new Error("commit failed");
                }),
            }),
        ).rejects.toThrow("commit failed");
    });

    it("wraps a non-Error thrown after an earlier committed batch", async () => {
        async function* source(): AsyncGenerator<string> {
            yield "one\n";
            throw "plain failure";
        }
        const result = await importTranscriptBatches({
            source: source(),
            format: "text",
            ...options(async (records) => [...records]),
        });
        expect(result.imported).toBe(1);
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error?.message).toBe("plain failure");
    });
});
