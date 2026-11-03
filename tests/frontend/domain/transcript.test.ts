import { describe, expect, it, vi } from "vitest";
import {
    correctTranscriptRecord,
    formatTranscriptExport,
    formatTranscriptTimestampUs,
    makeTranscriptRecords,
    mergeTranscriptRecords,
    parseTranscriptSource,
    parseTranscriptTimestamp,
    resolveTranscriptFormat,
    setTranscriptLinkedAssets,
    setTranscriptSpeaker,
    setTranscriptTimestamp,
    setTranscriptVerification,
    sortTranscriptRecords,
    splitTranscriptRecord,
} from "../../../frontend/domain/transcript";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";

describe("transcript source import", () => {
    it("imports nonempty text lines while retaining original line numbers", () => {
        const cues = parseTranscriptSource("\uFEFFFirst line\r\n\r\nSecond line\n", "text");
        expect(cues).toEqual([
            { text: "First line", sourceIndex: 0, sourceId: "1" },
            { text: "Second line", sourceIndex: 1, sourceId: "3" },
        ]);
    });

    it("parses SubRip and WebVTT cue identifiers, settings, and multiline text", () => {
        const srt = parseTranscriptSource(
            "1\r\n00:00:01,250 --> 00:00:03,500\r\nHello\r\nworld\r\n\r\n",
            "srt",
        );
        expect(srt).toEqual([
            {
                text: "Hello\nworld",
                startTimeUs: 1_250_000n,
                endTimeUs: 3_500_000n,
                sourceIndex: 0,
                sourceId: "1",
            },
        ]);

        const vtt = parseTranscriptSource(
            "WEBVTT - lesson\nKind: captions\n\nNOTE generated\nignored\n\nlesson-cue\n00:02.000 --> 00:03.000 align:start\n<Welcome & begin>\n",
            "vtt",
        );
        expect(vtt).toEqual([
            {
                text: "<Welcome & begin>",
                startTimeUs: 2_000_000n,
                endTimeUs: 3_000_000n,
                sourceIndex: 0,
                sourceId: "lesson-cue",
            },
        ]);
    });

    it("requires valid subtitle structure and timestamps", () => {
        expect(() => parseTranscriptSource("WEBVTT\nheader without blank", "vtt")).toThrow(
            "must end with a blank line",
        );
        expect(() => parseTranscriptSource("00:01,000 --> 00:00,999\nOops", "srt")).toThrow(
            "end before they start",
        );
        expect(() => parseTranscriptSource("00:61,000 --> 00:62,000\nOops", "srt")).toThrow(
            "end before they start",
        );
    });

    it("rejects invalid Unicode and unsupported control characters", () => {
        expect(() => parseTranscriptSource("bad\uD800", "text")).toThrow("valid Unicode");
        expect(() => parseTranscriptSource("bad\u0000text", "text")).toThrow("control characters");
        expect(() => parseTranscriptSource("a\uD800b", "text")).toThrow("valid Unicode");
        expect(() => parseTranscriptSource("a\uD800\uFFFF", "text")).toThrow("valid Unicode");
        expect(() => parseTranscriptSource("a\uDC00", "text")).toThrow("valid Unicode");
    });

    it("rejects sources beyond the 256 MiB limit", () => {
        const spy = vi
            .spyOn(TextEncoder.prototype, "encode")
            .mockReturnValueOnce({ byteLength: 256 * 1024 * 1024 + 1 } as Uint8Array<ArrayBuffer>);
        expect(() => parseTranscriptSource("small", "text")).toThrow("256 MiB");
        spy.mockRestore();
    });

    it("rejects surrogate text when correcting an existing cue", () => {
        expect(() => correctTranscriptRecord(transcriptCue(), "\uD800")).toThrow("valid Unicode");
    });

    it("resolves automatic format from file extensions", () => {
        expect(resolveTranscriptFormat("auto", "lesson.SRT")).toBe("srt");
        expect(resolveTranscriptFormat("auto", "lesson.vtt")).toBe("vtt");
        expect(resolveTranscriptFormat("auto", "lesson.txt")).toBe("text");
        expect(() => resolveTranscriptFormat("docx")).toThrow(
            "format must be text, srt, vtt, or auto",
        );
    });
});

describe("transcript archive records and export", () => {
    it("creates provisional archive records with source provenance", () => {
        const [record] = makeTranscriptRecords(
            "session-id",
            [
                {
                    text: "Tutor: Welcome",
                    startTimeUs: 1_000_000n,
                    endTimeUs: 2_000_000n,
                    sourceIndex: 3,
                    sourceId: "cue-a",
                },
            ],
            "vtt",
            "lesson.vtt",
            "1700000000000000",
        );
        expect(record?.fields.get("session_id")).toBe("session-id");
        expect(record?.fields.get("verification_state")).toBe("provisional");
        expect(record?.fields.get("timestamp_state")).toBe("timestamped");
        expect(record?.fields.get("source_cue_id")).toBe("cue-a");
        expect(record?.fields.get("source_index")).toBe("3");
    });

    it("sorts timed cues by timeline and protects subtitle output from missing times", () => {
        const records = makeTranscriptRecords(
            "session-id",
            [
                {
                    text: "Later",
                    startTimeUs: 2_000_000n,
                    endTimeUs: 3_000_000n,
                    sourceIndex: 0,
                    sourceId: "",
                },
                {
                    text: "Earlier",
                    startTimeUs: 1_000_000n,
                    endTimeUs: 1_500_000n,
                    sourceIndex: 1,
                    sourceId: "",
                },
                { text: "No time", sourceIndex: 2, sourceId: "2" },
            ],
            "text",
            "lesson.txt",
            "1700000000000000",
        );
        expect(sortTranscriptRecords(records).map((record) => record.fields.get("text"))).toEqual([
            "Earlier",
            "Later",
            "No time",
        ]);
        expect(() => formatTranscriptExport(records, "srt")).toThrow(
            "need valid start and end times",
        );
    });

    it("exports text, SRT, VTT-safe markup, and flat JSON", () => {
        const [record] = makeTranscriptRecords(
            "session-id",
            [
                {
                    text: "A < B & C\ncontinued",
                    startTimeUs: 3_000_000n,
                    endTimeUs: 4_200_000n,
                    sourceIndex: 0,
                    sourceId: "",
                },
            ],
            "srt",
            "lesson.srt",
            "1700000000000000",
        );
        const fields = new Map(record!.fields);
        fields.set("speaker_label", "Tutor");
        const segment = { ...record!, fields };
        expect(formatTranscriptExport([segment], "text")).toContain(
            "[00:00:03–00:00:04.2] Tutor: A < B & C\ncontinued",
        );
        expect(formatTranscriptExport([segment], "srt")).toContain(
            "00:00:03,000 --> 00:00:04,200\nTutor: A < B & C\ncontinued",
        );
        expect(formatTranscriptExport([segment], "vtt")).toContain(
            "Tutor: A &lt; B &amp; C\ncontinued",
        );
        expect(formatTranscriptExport([segment], "json")).toContain(
            '"verification_state": "provisional"',
        );
    });

    it("round-trips WebVTT cue identifiers from source_cue_id and legacy source_id", () => {
        const [record] = makeTranscriptRecords(
            "session-id",
            [
                {
                    text: "Welcome",
                    startTimeUs: 1_000_000n,
                    endTimeUs: 2_000_000n,
                    sourceIndex: 0,
                    sourceId: "lesson-cue",
                },
            ],
            "vtt",
            "lesson.vtt",
        );

        const output = formatTranscriptExport([record!], "vtt");
        expect(output).toContain("lesson-cue");
        expect(parseTranscriptSource(output, "vtt")[0]?.sourceId).toBe("lesson-cue");

        const legacyFields = new Map(record!.fields);
        legacyFields.delete("source_cue_id");
        legacyFields.set("source_id", "legacy-cue");
        const legacyOutput = formatTranscriptExport([{ ...record!, fields: legacyFields }], "vtt");
        expect(legacyOutput).toContain("legacy-cue");
        expect(parseTranscriptSource(legacyOutput, "vtt")[0]?.sourceId).toBe("legacy-cue");
    });
});

describe("transcript structure and material links", () => {
    it("splits a cue only when its text is preserved and its split time is internal", () => {
        const cue = transcriptCue({ text: "Read the whole question carefully." });
        const [first, second] = splitTranscriptRecord(
            cue,
            "Read the whole question ",
            "carefully.",
            "00:00:02",
        );

        expect((first.fields.get("text") ?? "") + (second.fields.get("text") ?? "")).toBe(
            "Read the whole question carefully.",
        );
        expect(first.fields.get("end_time_us")).toBe("2000000");
        expect(second.fields.get("start_time_us")).toBe("2000000");
        expect(second.fields.get("end_time_us")).toBe(cue.fields.get("end_time_us"));
        expect(second.id).not.toBe(first.id);
        expect(second.fields.get("linked_asset_ids")).toBe(cue.fields.get("linked_asset_ids"));
        expect(mergeTranscriptRecords([first, second])[0]?.fields.get("text")).toBe(
            "Read the whole question carefully.",
        );
    });

    it("rejects text loss, empty parts, and timestamp splits on the cue boundary", () => {
        const cue = transcriptCue();
        expect(() => splitTranscriptRecord(cue, "First", " changed", "00:00:02")).toThrow(
            "exactly preserve",
        );
        expect(() => splitTranscriptRecord(cue, "First cue", "", "00:00:02")).toThrow(
            "exactly preserve",
        );
        expect(() => splitTranscriptRecord(cue, "First ", "cue", "00:00:01")).toThrow(
            "strictly inside",
        );
    });

    it("merges chronological cues, unions material links, and trashes absorbed cues", () => {
        const sessionId = crypto.randomUUID();
        const first = transcriptCue({
            sessionId,
            text: "Balance",
            startTimeUs: 1_000_000n,
            endTimeUs: 2_000_000n,
            linkedAssetIds: ["asset-a"],
        });
        const second = transcriptCue({
            sessionId,
            text: "model",
            startTimeUs: 2_500_000n,
            endTimeUs: 4_000_000n,
            linkedAssetIds: ["asset-a", "asset-b"],
        });
        const [merged, absorbed] = mergeTranscriptRecords([first, second]);

        expect(merged?.id).toBe(first.id);
        expect(merged?.fields.get("text")).toBe("Balance model");
        expect(merged?.fields.get("start_time_us")).toBe("1000000");
        expect(merged?.fields.get("end_time_us")).toBe("4000000");
        expect(merged?.fields.get("linked_asset_ids")).toBe("asset-a,asset-b");
        expect(absorbed?.fields.get("_deleted")).toBe("true");
        expect(second.fields.has("_deleted")).toBe(false);
    });

    it("refuses merges across sessions, speakers, timestamp modes, or chronological order", () => {
        const sessionId = crypto.randomUUID();
        const first = transcriptCue({
            sessionId,
            text: "First",
            startTimeUs: 2_000_000n,
            endTimeUs: 3_000_000n,
        });
        const later = transcriptCue({
            sessionId,
            text: "Later",
            startTimeUs: 4_000_000n,
            endTimeUs: 5_000_000n,
        });
        const earlier = transcriptCue({
            sessionId,
            text: "Earlier",
            startTimeUs: 1_000_000n,
            endTimeUs: 2_000_000n,
        });
        const otherSession = transcriptCue({ sessionId: crypto.randomUUID(), text: "Other" });
        const otherSpeaker = transcriptCue({
            sessionId,
            text: "Other speaker",
            speaker: "Student",
        });
        const untimed = transcriptCue({ sessionId, text: "No time", timestamped: false });

        expect(() => mergeTranscriptRecords([first, later, earlier])).toThrow(
            "chronological order",
        );
        expect(() => mergeTranscriptRecords([first, otherSession])).toThrow("same session");
        expect(() => mergeTranscriptRecords([first, otherSpeaker])).toThrow("different speaker");
        expect(() => mergeTranscriptRecords([first, untimed])).toThrow(
            "Timestamped and untimestamped",
        );
    });

    it("links same-session and general-library materials but rejects cross-session links", () => {
        const sessionId = crypto.randomUUID();
        const cue = transcriptCue({ sessionId });
        const local = material({ session_id: sessionId });
        const general = material();
        const linked = setTranscriptLinkedAssets(cue, [local.id, general.id], [local, general]);
        const other = material({ session_id: crypto.randomUUID() });

        expect(linked.fields.get("linked_asset_ids")).toBe(`${local.id},${general.id}`);
        expect(() => setTranscriptLinkedAssets(cue, [other.id], [other])).toThrow(
            "different session",
        );
        expect(() => setTranscriptLinkedAssets(cue, [local.id], [])).toThrow(
            "exists in the open archive",
        );
    });
});

function transcriptCue(
    options: {
        sessionId?: string;
        text?: string;
        startTimeUs?: bigint;
        endTimeUs?: bigint;
        timestamped?: boolean;
        speaker?: string;
        linkedAssetIds?: readonly string[];
    } = {},
): ArchiveRecord {
    const sessionId = options.sessionId ?? crypto.randomUUID();
    const cue = makeTranscriptRecords(
        sessionId,
        [
            {
                text: options.text ?? "First cue",
                ...(options.timestamped === false
                    ? {}
                    : {
                          startTimeUs: options.startTimeUs ?? 1_000_000n,
                          endTimeUs: options.endTimeUs ?? 4_000_000n,
                      }),
                sourceIndex: 0,
                sourceId: "",
            },
        ],
        "srt",
        "lesson.srt",
    )[0]!;
    const fields = new Map(cue.fields);
    if (options.speaker) fields.set("speaker_label", options.speaker);
    if (options.linkedAssetIds) fields.set("linked_asset_ids", options.linkedAssetIds.join(","));
    return { ...cue, fields };
}

function material(fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type: RecordType.assetMetadata,
        id: crypto.randomUUID(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([["filename", "worksheet.pdf"], ...Object.entries(fields)]),
        blob: new Uint8Array(),
    };
}

describe("transcript format and parsing edges", () => {
    it("accepts explicit formats and unknown extensions", () => {
        expect(resolveTranscriptFormat("text")).toBe("text");
        expect(resolveTranscriptFormat("srt")).toBe("srt");
        expect(resolveTranscriptFormat("vtt")).toBe("vtt");
        expect(resolveTranscriptFormat("auto", "no-extension")).toBe("text");
        expect(resolveTranscriptFormat("auto", "UPPER.VTT")).toBe("vtt");
    });

    it("accepts WEBVTT headers and ignores metadata blocks", () => {
        const bare = parseTranscriptSource("WEBVTT\n\n00:01.000 --> 00:02.000\nHi", "vtt");
        expect(bare).toHaveLength(1);
        const tabbed = parseTranscriptSource(
            "WEBVTT\tcaptions\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:r\n\nNOTE\nnote text\n\n00:01.000 --> 00:02.000\nHi",
            "vtt",
        );
        expect(tabbed).toHaveLength(1);
        expect(() => parseTranscriptSource("NOPE\n\n00:01.000 --> 00:02.000\nHi", "vtt")).toThrow(
            "WEBVTT header",
        );
    });

    it("rejects subtitle blocks without a usable timing line", () => {
        expect(() => parseTranscriptSource("no timing here\n", "srt")).toThrow(
            "optional identifier",
        );
        expect(() => parseTranscriptSource("id\nline\n00:01.000 --> 00:02.000\nHi", "srt")).toThrow(
            "optional identifier",
        );
        expect(() => parseTranscriptSource("00:01.000 --> 00:02.000", "srt")).toThrow(
            "contains no text",
        );
        expect(() =>
            parseTranscriptSource("00:01.000 --> 00:02.000 --> 00:03.000\nHi", "srt"),
        ).toThrow("exactly one");
        expect(() => parseTranscriptSource("1 --> 2\nHi", "srt")).toThrow("invalid");
        expect(() => parseTranscriptSource("00:01.000 --> bad\nHi", "srt")).toThrow("invalid");
        expect(() =>
            parseTranscriptSource("9999999999:00:00.000 --> 9999999999:00:01.000\nHi", "srt"),
        ).toThrow("exceeds the supported range");
    });

    it("rejects oversized cues at line and cue level", () => {
        const huge = "a".repeat(16 * 1024 * 1024 + 1);
        expect(() => parseTranscriptSource(huge, "text")).toThrow("16 MiB");
        expect(() => parseTranscriptSource(`00:01.000 --> 00:02.000\n${huge}`, "srt")).toThrow(
            "16 MiB",
        );
    });

    it("normalizes timestamps for annotations and subtitles", () => {
        expect(parseTranscriptTimestamp("90")).toBe(90_000_000n);
        expect(parseTranscriptTimestamp("1:30")).toBe(90_000_000n);
        expect(parseTranscriptTimestamp("00:01:30.5")).toBe(90_500_000n);
        expect(parseTranscriptTimestamp("00:01:30,25")).toBe(90_250_000n);
        expect(() => parseTranscriptTimestamp("abc")).toThrow("whole seconds");
        expect(() => parseTranscriptTimestamp("9999999999999")).toThrow("supported range");
        expect(() => parseTranscriptTimestamp("00:61:00")).toThrow("invalid");
    });

    it("formats long timestamps for display", () => {
        expect(formatTranscriptTimestampUs(0n)).toBe("00:00:00");
        expect(formatTranscriptTimestampUs(3_600_000_000n)).toBe("01:00:00");
        expect(formatTranscriptTimestampUs(1_234_500n)).toBe("00:00:01.2345");
    });
});

describe("transcript record editing", () => {
    it("corrects text and tracks verification and timestamps", () => {
        const cue = transcriptCue();
        const corrected = correctTranscriptRecord(cue, "Corrected");
        expect(corrected.fields.get("verification_state")).toBe("human-corrected");
        expect(corrected.fields.get("text")).toBe("Corrected");

        const verified = setTranscriptVerification(corrected, "human-verified");
        expect(verified.fields.get("verification_state")).toBe("human-verified");

        const timestamped = setTranscriptTimestamp(cue, "00:00:01", "00:00:02");
        expect(timestamped.fields.get("start_time_us")).toBe("1000000");
        expect(timestamped.fields.get("end_time_us")).toBe("2000000");

        expect(() => setTranscriptTimestamp(cue, "00:00:02", "00:00:01")).toThrow(
            "precedes its start",
        );
        expect(() => correctTranscriptRecord(cue, "bad\u0001text")).toThrow("unsupported control");
        expect(() => correctTranscriptRecord({ ...cue, type: RecordType.guide }, "text")).toThrow(
            "Only transcript segments",
        );
    });

    it("assigns speaker labels with unknown fallbacks", () => {
        const cue = transcriptCue();
        const labeled = setTranscriptSpeaker(cue, "  Student  ");
        expect(labeled.fields.get("speaker_label")).toBe("Student");
        expect(labeled.fields.get("speaker_assignment_state")).toBe("tutor-labeled");

        const cleared = setTranscriptSpeaker(cue, null);
        expect(cleared.fields.get("speaker_label")).toBe("Unknown speaker");
        expect(cleared.fields.get("speaker_assignment_state")).toBe("unknown");
        expect(setTranscriptSpeaker(cue, "   ").fields.get("speaker_label")).toBe(
            "Unknown speaker",
        );
    });

    it("splits untimestamped cues without a split time", () => {
        const cue = transcriptCue({ text: "First cue", timestamped: false });
        const [first, second] = splitTranscriptRecord(cue, "First ", "cue");
        expect(first.fields.get("text")).toBe("First ");
        expect(second.fields.get("text")).toBe("cue");
        expect(first.fields.get("timestamp_state")).toBe("not-timestamped");
    });

    it("requires a split time within timestamped cues", () => {
        const cue = transcriptCue();
        expect(() => splitTranscriptRecord(cue, "First ", "cue")).toThrow("Choose a split time");
        expect(() => splitTranscriptRecord(cue, "First ", "cue", "00:00:04")).toThrow(
            "strictly inside",
        );
        const invalidStart = {
            ...cue,
            fields: new Map([...cue.fields, ["start_time_us", "invalid"]]),
        };
        expect(() => splitTranscriptRecord(invalidStart, "First ", "cue", "00:00:02")).toThrow(
            "strictly inside",
        );
    });
});

describe("transcript merge and export edges", () => {
    it("merges untimestamped cues and preserves separators", () => {
        const sessionId = crypto.randomUUID();
        const first = transcriptCue({ sessionId, text: "One", timestamped: false });
        const second = transcriptCue({ sessionId, text: " Two", timestamped: false });
        const third = transcriptCue({ sessionId, text: "Three", timestamped: false });
        const [merged, ...rest] = mergeTranscriptRecords([first, second, third], "");
        expect(merged!.fields.get("text")).toBe("One TwoThree");
        expect(rest).toHaveLength(2);
        expect(merged!.fields.get("start_time_us")).toBe(first.fields.get("start_time_us"));
    });

    it("rejects invalid merge inputs", () => {
        const cue = transcriptCue();
        expect(() => mergeTranscriptRecords([cue])).toThrow("at least two");
        expect(() => mergeTranscriptRecords([cue, cue])).toThrow("only appear once");
        const deleted = { ...cue, fields: new Map([...cue.fields, ["_deleted", "true"]]) };
        expect(() => mergeTranscriptRecords([cue, deleted])).toThrow("Restore a transcript cue");
        expect(() =>
            mergeTranscriptRecords([
                cue,
                { ...cue, type: RecordType.guide, id: crypto.randomUUID() },
            ]),
        ).toThrow("Only transcript segments");
        expect(() => mergeTranscriptRecords([cue, transcriptCue()], "\u0001")).toThrow(
            "unsupported control",
        );
    });

    it("trims linked asset identifiers while merging", () => {
        const sessionId = crypto.randomUUID();
        const first = transcriptCue({ sessionId, text: "A" });
        const second = transcriptCue({ sessionId, text: "B", startTimeUs: 2_000_000n });
        const fields = new Map(first.fields);
        fields.set("linked_asset_ids", " asset-a , ,asset-b ");
        const secondFields = new Map(second.fields);
        secondFields.set("linked_asset_ids", "asset-b");
        const [merged] = mergeTranscriptRecords([
            { ...first, fields },
            { ...second, fields: secondFields },
        ]);
        expect(merged!.fields.get("linked_asset_ids")).toBe("asset-a,asset-b");
    });

    it("rejects invalid material links", () => {
        const cue = transcriptCue();
        expect(() => setTranscriptLinkedAssets(cue, ["bad"], [])).toThrow("invalid asset ID");
        expect(() => setTranscriptLinkedAssets(cue, [crypto.randomUUID()], [material()])).toThrow(
            "exists in the open archive",
        );
        const wrongType = { ...material(), type: RecordType.guide };
        expect(() => setTranscriptLinkedAssets(cue, [wrongType.id], [wrongType])).toThrow(
            "exists in the open archive",
        );
        const deleted = material({ _deleted: "true" });
        expect(() => setTranscriptLinkedAssets(cue, [deleted.id], [deleted])).toThrow(
            "exists in the open archive",
        );
        const other = material({ session_id: crypto.randomUUID() });
        expect(() => setTranscriptLinkedAssets(cue, [other.id], [other])).toThrow(
            "different session",
        );
        expect(() => setTranscriptLinkedAssets({ ...cue, type: RecordType.guide }, [], [])).toThrow(
            "Only transcript segments",
        );
    });

    it("orders ties deterministically", () => {
        const fields = (values: Record<string, string>) => new Map(Object.entries(values));
        const base = {
            type: RecordType.transcriptSegment,
            revision: 0n,
            previousOffset: 0n,
            blob: new Uint8Array(),
        };
        const a = { ...base, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fields: fields({}) };
        const b = { ...base, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", fields: fields({}) };
        expect(sortTranscriptRecords([b, a])[0]!.id).toBe(a.id);

        const importA = {
            ...a,
            fields: fields({ source_import_id: "a", source_index: "0" }),
        };
        const importB = {
            ...b,
            fields: fields({ source_import_id: "b", source_index: "0" }),
        };
        expect(sortTranscriptRecords([importB, importA])[0]!.id).toBe(a.id);

        const indexA = { ...a, fields: fields({ source_import_id: "x", source_index: "1" }) };
        const indexB = { ...b, fields: fields({ source_import_id: "x", source_index: "2" }) };
        expect(sortTranscriptRecords([indexB, indexA])[0]!.id).toBe(a.id);

        const createdA = { ...a, fields: fields({ created_at_us: "1" }) };
        const createdB = { ...b, fields: fields({ created_at_us: "2" }) };
        expect(sortTranscriptRecords([createdB, createdA])[0]!.id).toBe(a.id);

        const endA = {
            ...a,
            fields: fields({
                timestamp_state: "timestamped",
                start_time_us: "0",
                end_time_us: "5",
            }),
        };
        const endB = {
            ...b,
            fields: fields({
                timestamp_state: "timestamped",
                start_time_us: "0",
                end_time_us: "6",
            }),
        };
        expect(sortTranscriptRecords([endB, endA])[0]!.id).toBe(a.id);

        const untimed = { ...a, fields: fields({ timestamp_state: "not-timestamped" }) };
        const timed = {
            ...b,
            fields: fields({
                timestamp_state: "timestamped",
                start_time_us: "1",
                end_time_us: "2",
            }),
        };
        expect(sortTranscriptRecords([timed, untimed])[0]!.id).toBe(b.id);
        expect(sortTranscriptRecords([untimed, timed])[0]!.id).toBe(b.id);

        const later = {
            ...a,
            fields: fields({
                timestamp_state: "timestamped",
                start_time_us: "10",
                end_time_us: "20",
            }),
        };
        const earlier = {
            ...b,
            fields: fields({
                timestamp_state: "timestamped",
                start_time_us: "1",
                end_time_us: "2",
            }),
        };
        expect(sortTranscriptRecords([later, earlier])[0]!.id).toBe(b.id);

        const mk = (id: string, start: string) => ({
            ...a,
            id,
            fields: fields({
                timestamp_state: "timestamped",
                start_time_us: start,
                end_time_us: String(Number(start) + 1),
            }),
        });
        const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const d = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        const mixed = sortTranscriptRecords([
            mk(a.id, "10"),
            mk(b.id, "1"),
            mk(c, "9"),
            mk(d, "2"),
        ]);
        expect(mixed.map((record) => record.id)).toEqual([b.id, d, c, a.id]);
    });

    it("exports text without speakers and untimed ranges", () => {
        const cue = transcriptCue({ text: "Hello", timestamped: false });
        const output = formatTranscriptExport([cue], "text");
        expect(output).toContain("[time not provided] Hello");

        const timed = transcriptCue({ text: "Hi", startTimeUs: 2_000_000n, endTimeUs: 2_000_000n });
        expect(formatTranscriptExport([timed], "text")).toContain("[00:00:02] Hi");

        const named = {
            ...timed,
            fields: new Map([...timed.fields, ["speaker_name", "Tutor"]]),
        };
        expect(formatTranscriptExport([named], "text")).toContain("Tutor: Hi");
    });

    it("rejects subtitle export when times are incomplete or zero-length", () => {
        const untimed = transcriptCue({ text: "Hi", timestamped: false });
        expect(() => formatTranscriptExport([untimed], "vtt")).toThrow("need valid start");
        const zero = transcriptCue({ startTimeUs: 1_000_000n, endTimeUs: 1_000_000n });
        expect(() => formatTranscriptExport([zero], "srt")).toThrow("need valid start");
    });

    it("omits unsafe WebVTT cue identifiers", () => {
        const cue = transcriptCue({ text: "Hi" });
        const unsafe = {
            ...cue,
            fields: new Map([...cue.fields, ["source_cue_id", "a-->b"]]),
        };
        const output = formatTranscriptExport([unsafe], "vtt");
        expect(output).not.toContain("a-->b");
        const multiline = {
            ...cue,
            fields: new Map([...cue.fields, ["source_cue_id", "a\nb"]]),
        };
        expect(formatTranscriptExport([multiline], "vtt")).not.toContain("a\nb");
    });
});

describe("transcript unicode and untimed ordering", () => {
    it("accepts a complete surrogate pair as transcript text", () => {
        expect(parseTranscriptSource("😀 maths", "text")).toEqual([
            expect.objectContaining({ text: "😀 maths" }),
        ]);
    });

    it("orders two untimed segments by their import metadata", () => {
        const base = {
            type: RecordType.transcriptSegment,
            revision: 0n,
            previousOffset: 0n,
            blob: new Uint8Array(),
            fields: new Map([
                ["timestamp_state", "not-timestamped"],
                ["source_import_id", "same-import"],
            ]),
        };
        const first = {
            ...base,
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            fields: new Map([...base.fields, ["source_index", "1"]]),
        };
        const second = {
            ...base,
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            fields: new Map([...base.fields, ["source_index", "2"]]),
        };
        expect(sortTranscriptRecords([second, first])[0]!.id).toBe(first.id);
    });
});
