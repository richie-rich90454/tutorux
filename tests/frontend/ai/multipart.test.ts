import { describe, expect, it } from "vitest";
import { createAiMultipartHandoff } from "../../../frontend/ai/multipart";

const REQUIRED_FIELDS = [
    "manifest",
    "session",
    "annotations",
    "evidence",
    "assets_manifest",
    "generation_instructions",
    "verification_instructions",
    "guide_response_schema",
] as const;

function packageText(transcript: unknown[], overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        manifest: { format: "tutorux-ai-package-v1" },
        session: { id: "session" },
        annotations: [],
        evidence: [],
        assets_manifest: [],
        generation_instructions: "instructions",
        verification_instructions: "verification",
        guide_response_schema: {},
        transcript,
        ...overrides,
    });
}

function jsonBlocks(markdown: string): unknown[] {
    return [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
        JSON.parse(match[1]!),
    );
}

function transcriptParts(markdown: string): Record<string, unknown>[][] {
    return jsonBlocks(markdown).slice(1) as Record<string, unknown>[][];
}

const lengthTokenizer = (value: string) => value.length;

describe("createAiMultipartHandoff", () => {
    it("creates the shared context and three prompts for an empty transcript", () => {
        const handoff = createAiMultipartHandoff(packageText([]));

        expect(handoff.transcriptPartCount).toBe(1);
        expect(handoff.promptCount).toBe(3);
        expect(handoff.transcriptPartTokenCounts).toEqual([1]);
        expect(handoff.inputBytes).toBeGreaterThan(0);
        expect(handoff.outputBytes).toBe(new TextEncoder().encode(handoff.markdown).byteLength);

        const blocks = jsonBlocks(handoff.markdown);
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).not.toHaveProperty("transcript");
        expect(blocks[1]).toEqual([]);
        expect(handoff.markdown).toContain("## Prompt 1 of 3 — Analyze transcript section 1");
        expect(handoff.markdown).toContain("## Prompt 2 of 3 — Consolidate evidence");
        expect(handoff.markdown).toContain("## Prompt 3 of 3 — Generate the final guide");
        expect(handoff.markdown).toContain("## Shared session context");
    });

    it("keeps forward-compatible package extensions in the shared context", () => {
        const handoff = createAiMultipartHandoff(
            packageText([], { future_field: { nested: true } }),
        );
        expect(jsonBlocks(handoff.markdown)[0]).toMatchObject({
            future_field: { nested: true },
        });
    });

    it("rejects invalid package JSON and shapes", () => {
        expect(() => createAiMultipartHandoff("not json")).toThrow(
            "The canonical AI package is not valid JSON.",
        );
        for (const value of ["null", "[]", "42"]) {
            expect(() => createAiMultipartHandoff(value)).toThrow(
                "The canonical AI package is invalid.",
            );
        }
    });

    it("requires the transcript array and every context field", () => {
        expect(() =>
            createAiMultipartHandoff(packageText([] as never, { transcript: {} })),
        ).toThrow("The canonical package is missing its transcript array.");
        for (const field of REQUIRED_FIELDS) {
            const value = JSON.parse(packageText([])) as Record<string, unknown>;
            delete value[field];
            expect(() => createAiMultipartHandoff(JSON.stringify(value))).toThrow(
                "The canonical package is missing multipart context.",
            );
        }
    });

    it("requires the Tutorux AI manifest format", () => {
        expect(() => createAiMultipartHandoff(packageText([], { manifest: {} }))).toThrow(
            "The canonical package does not use the supported Tutorux AI format.",
        );
        expect(() => createAiMultipartHandoff(packageText([], { manifest: "manifest" }))).toThrow(
            "The canonical package does not use the supported Tutorux AI format.",
        );
    });

    it("rejects non-object transcript records", () => {
        expect(() => createAiMultipartHandoff(packageText([5]))).toThrow(
            "A multipart transcript record is not an object.",
        );
    });

    it("validates input, part-byte, and part-token limits", () => {
        for (const maximumInputBytes of [0, 1.5, 64 * 1024 * 1024 + 1]) {
            expect(() => createAiMultipartHandoff(packageText([]), { maximumInputBytes })).toThrow(
                "The multipart input limit must be between 1 byte and 64 MiB.",
            );
        }
        for (const maximumTranscriptPartBytes of [0, 1.5, 2 * 1024 * 1024 + 1]) {
            expect(() =>
                createAiMultipartHandoff(packageText([]), { maximumTranscriptPartBytes }),
            ).toThrow("Transcript parts must be between 1 byte and 2 MiB.");
        }
        for (const maximumTranscriptPartTokens of [0, 1.5, 10_000_001]) {
            expect(() =>
                createAiMultipartHandoff(packageText([]), { maximumTranscriptPartTokens }),
            ).toThrow("Transcript part token limits must be between 1 and 10,000,000.");
        }
    });

    it("enforces the configured input size", () => {
        expect(() => createAiMultipartHandoff("")).toThrow(
            "The multipart handoff input exceeds the configured 64 MiB export limit.",
        );
        expect(() => createAiMultipartHandoff(packageText([]), { maximumInputBytes: 5 })).toThrow(
            "The multipart handoff input exceeds the configured 0 MiB export limit.",
        );
    });

    it("orders transcript rows by timestamp with stable fallbacks", () => {
        const handoff = createAiMultipartHandoff(
            packageText([
                { id: "b", start_time_us: "200", text: "B" },
                { id: "null-two" },
                { id: "a", start_time_us: "100", text: "A" },
                { id: "nested", fields: { start_time_us: "50", text: "D" } },
                { id: "c", start_time_us: "100", text: "C" },
                { id: "null-one" },
            ]),
        );

        expect(transcriptParts(handoff.markdown)[0]?.map((row) => row["id"])).toEqual([
            "nested",
            "a",
            "c",
            "b",
            "null-two",
            "null-one",
        ]);
    });

    it("starts a new part after a long time gap and tracks the latest end time", () => {
        const handoff = createAiMultipartHandoff(
            packageText([
                { id: "x", start_time_us: "0", end_time_us: "5000" },
                { id: "y", start_time_us: "1000", end_time_us: "1" },
                { id: "z", start_time_us: "5000" },
                { id: "w", start_time_us: "180006000" },
                { id: "no-time" },
            ]),
        );

        expect(handoff.transcriptPartCount).toBe(2);
        expect(
            transcriptParts(handoff.markdown).map((part) => part.map((row) => row["id"])),
        ).toEqual([
            ["x", "y", "z"],
            ["w", "no-time"],
        ]);
    });

    it("splits a single oversized record into contiguous fragments", () => {
        const text = "Hi there. Big rest of content. More here and there? Final sentence!".repeat(
            8,
        );
        const handoff = createAiMultipartHandoff(packageText([{ id: "long", text }]), {
            maximumTranscriptPartTokens: 300,
            countTokens: lengthTokenizer,
        });
        const rows = transcriptParts(handoff.markdown).flat();

        expect(rows.length).toBeGreaterThan(1);
        expect(rows.map((row) => row["text"]).join("")).toBe(text);
        expect(rows.map((row) => row["fragment_index"])).toEqual(rows.map((_, index) => index + 1));
        expect(rows.every((row) => row["fragment_count"] === rows.length)).toBe(true);
        expect(rows[0]).toMatchObject({
            id: "long",
            fragment_source_byte_start: 0,
        });
        expect(rows.at(-1)?.["fragment_source_byte_end"]).toBe(
            new TextEncoder().encode(text).byteLength,
        );
    });

    it("splits nested field text and prefers sentence and whitespace boundaries", () => {
        const text =
            "First sentence.  Second sentence follows here, with more words to split. Third one! Fourth? Fifth. Sixth. Seventh. Eighth. Ninth. Tenth.".repeat(
                2,
            );
        const handoff = createAiMultipartHandoff(
            packageText([{ id: "nested", fields: { text } }]),
            { maximumTranscriptPartTokens: 300, countTokens: lengthTokenizer },
        );
        const rows = transcriptParts(handoff.markdown).flat();

        expect(rows.length).toBeGreaterThan(1);
        expect(rows.map((row) => (row["fields"] as Record<string, unknown>)["text"]).join("")).toBe(
            text,
        );
        expect(rows.every((row) => typeof row["text"] === "undefined")).toBe(true);
    });

    it("splits text at whitespace when no sentence boundary is available", () => {
        const text =
            "abcdefghij klmnopqrst uvwxyz abcdefghij klmnopqrst uvwxyz abcdefghij klmnopqrst uvwxyz abcdefghij klmnopqrst".repeat(
                4,
            );
        const handoff = createAiMultipartHandoff(packageText([{ id: "words", text }]), {
            maximumTranscriptPartTokens: 300,
            countTokens: lengthTokenizer,
        });
        const rows = transcriptParts(handoff.markdown).flat();
        expect(rows.map((row) => row["text"]).join("")).toBe(text);
        expect(rows.length).toBeGreaterThan(1);
    });

    it("splits a record with no convenient boundaries", () => {
        const text = "abcdefghijklmnopqrstuvwxyz".repeat(16);
        const handoff = createAiMultipartHandoff(packageText([{ id: "solid", text }]), {
            maximumTranscriptPartTokens: 300,
            countTokens: lengthTokenizer,
        });
        const rows = transcriptParts(handoff.markdown).flat();
        expect(rows.map((row) => row["text"]).join("")).toBe(text);
        expect(rows.length).toBeGreaterThan(1);
    });

    it("rejects a row without text that cannot fit a part", () => {
        expect(() =>
            createAiMultipartHandoff(
                packageText([{ id: "small", text: "ok" }, { id: "x".repeat(500) }]),
                { maximumTranscriptPartBytes: 100 },
            ),
        ).toThrow("A transcript record exceeds the configured per-part bounds.");
    });

    it("counts UTF-8 bytes when splitting multibyte text", () => {
        const text = "aé€😀".repeat(200);
        const handoff = createAiMultipartHandoff(packageText([{ id: "unicode", text }]), {
            maximumTranscriptPartTokens: 300,
            countTokens: lengthTokenizer,
        });
        const rows = transcriptParts(handoff.markdown).flat();
        expect(rows.length).toBeGreaterThan(1);
        expect(rows.map((row) => row["text"]).join("")).toBe(text);
        expect(rows.at(-1)?.["fragment_source_byte_end"]).toBe(
            new TextEncoder().encode(text).byteLength,
        );
    });

    it("rejects a record whose smallest fragment cannot fit", () => {
        expect(() =>
            createAiMultipartHandoff(packageText([{ id: "x", text: "abc" }]), {
                maximumTranscriptPartBytes: 1,
            }),
        ).toThrow(
            "A single transcript character plus its citation metadata exceeds the per-part bounds.",
        );
    });

    it("rejects invalid custom tokenizer results", () => {
        expect(() =>
            createAiMultipartHandoff(packageText([{ id: "x", text: "abc" }]), {
                countTokens: () => -1,
            }),
        ).toThrow("The AI tokenizer must return a nonnegative safe integer.");
        expect(() =>
            createAiMultipartHandoff(packageText([{ id: "x", text: "abc" }]), {
                countTokens: () => 1.5,
            }),
        ).toThrow("The AI tokenizer must return a nonnegative safe integer.");
    });

    it("uses a custom tokenizer for transcript budgets", () => {
        const handoff = createAiMultipartHandoff(
            packageText([
                { id: "a", text: "one" },
                { id: "b", text: "two" },
            ]),
            { maximumTranscriptPartTokens: 1_000, countTokens: lengthTokenizer },
        );
        expect(handoff.transcriptPartCount).toBe(1);
    });

    it("enforces the output size limit", () => {
        for (const maximumOutputBytes of [0, 1.5, 64 * 1024 * 1024 + 2 * 1024 * 1024 + 1]) {
            expect(() => createAiMultipartHandoff(packageText([]), { maximumOutputBytes })).toThrow(
                "Multipart prompt overhead exceeds the safe 66 MiB export limit.",
            );
        }
        expect(() => createAiMultipartHandoff(packageText([]), { maximumOutputBytes: 10 })).toThrow(
            "Multipart prompt overhead exceeds the safe 66 MiB export limit.",
        );
        expect(() =>
            createAiMultipartHandoff(packageText([]), { maximumOutputBytes: 1_000_000 }),
        ).not.toThrow();
    });
});
