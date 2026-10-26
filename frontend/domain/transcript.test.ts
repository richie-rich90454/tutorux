import { describe, expect, it } from "vitest";
import {
  parseTranscriptSource,
  formatTranscriptExport,
  makeTranscriptRecords,
  resolveTranscriptFormat,
  sortTranscriptRecords,
  mergeTranscriptRecords,
  setTranscriptLinkedAssets,
  splitTranscriptRecord,
} from "./transcript";
import { RecordType, type ArchiveRecord } from "../archive/format";

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
  });

  it("resolves automatic format from file extensions", () => {
    expect(resolveTranscriptFormat("auto", "lesson.SRT")).toBe("srt");
    expect(resolveTranscriptFormat("auto", "lesson.vtt")).toBe("vtt");
    expect(resolveTranscriptFormat("auto", "lesson.txt")).toBe("text");
    expect(() => resolveTranscriptFormat("docx")).toThrow("format must be text, srt, vtt, or auto");
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
    expect(() => formatTranscriptExport(records, "srt")).toThrow("need valid start and end times");
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
    const otherSpeaker = transcriptCue({ sessionId, text: "Other speaker", speaker: "Student" });
    const untimed = transcriptCue({ sessionId, text: "No time", timestamped: false });

    expect(() => mergeTranscriptRecords([first, later, earlier])).toThrow("chronological order");
    expect(() => mergeTranscriptRecords([first, otherSession])).toThrow("same session");
    expect(() => mergeTranscriptRecords([first, otherSpeaker])).toThrow("different speaker");
    expect(() => mergeTranscriptRecords([first, untimed])).toThrow("Timestamped and untimestamped");
  });

  it("links same-session and general-library materials but rejects cross-session links", () => {
    const sessionId = crypto.randomUUID();
    const cue = transcriptCue({ sessionId });
    const local = material({ session_id: sessionId });
    const general = material();
    const linked = setTranscriptLinkedAssets(cue, [local.id, general.id], [local, general]);
    const other = material({ session_id: crypto.randomUUID() });

    expect(linked.fields.get("linked_asset_ids")).toBe(`${local.id},${general.id}`);
    expect(() => setTranscriptLinkedAssets(cue, [other.id], [other])).toThrow("different session");
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
