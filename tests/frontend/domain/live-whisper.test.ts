import { describe, expect, it } from "vitest";
import { RecordType } from "../../../frontend/archive/format";
import { makeLiveWhisperRecords } from "../../../frontend/domain/live-whisper";
import type { LiveWhisperCue } from "../../../frontend/platform/live-whisper";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TRACK_ID = "22222222-2222-4222-8222-222222222222";

function cue(overrides: Partial<LiveWhisperCue> = {}): LiveWhisperCue {
    return {
        sequence: "0",
        startTimeUs: "1000000",
        endTimeUs: "2000000",
        windowStartUs: "0",
        text: "hello",
        language: "en",
        modelName: "small",
        backendVersion: "1.7.0",
        diarizationEnabled: false,
        speakerTurnNext: false,
        ...overrides,
    };
}

function make(cues: LiveWhisperCue[]) {
    return makeLiveWhisperRecords({
        cues,
        sessionId: SESSION_ID.toUpperCase(),
        trackId: TRACK_ID.toUpperCase(),
        runId: "run-1",
    });
}

describe("live Whisper provisional records", () => {
    it("returns no records for no cues", () => {
        expect(make([])).toEqual([]);
    });

    it("maps a provisional cue into a transcript segment", () => {
        const [record] = make([cue()]);
        expect(record).toMatchObject({ type: RecordType.transcriptSegment, revision: 0n });
        expect(record!.fields.get("session_id")).toBe(SESSION_ID);
        expect(record!.fields.get("source_audio_track_id")).toBe(TRACK_ID);
        expect(record!.fields.get("start_time_us")).toBe("1000000");
        expect(record!.fields.get("end_time_us")).toBe("2000000");
        expect(record!.fields.get("text")).toBe("hello");
        expect(record!.fields.get("verification_state")).toBe("provisional");
        expect(record!.fields.get("timestamp_state")).toBe("timestamped");
        expect(record!.fields.get("origin")).toBe("local-whisper");
        expect(record!.fields.get("source_model")).toBe("small");
        expect(record!.fields.get("source_backend_version")).toBe("1.7.0");
        expect(record!.fields.get("source_run_id")).toBe("run-1");
        expect(record!.fields.get("source_window_start_us")).toBe("0");
        expect(record!.fields.get("source_mode")).toBe("live");
        expect(record!.fields.get("language")).toBe("en");
        expect(record!.fields.get("live_cue_sequence")).toBe("0");
        expect(record!.fields.get("created_at_us")).toMatch(/^\d+$/u);
        expect(record!.fields.has("diarization_enabled")).toBe(false);
    });

    it("records diarization metadata when enabled", () => {
        const [record] = make([cue({ diarizationEnabled: true, speakerTurnNext: true })]);
        expect(record!.fields.get("speaker_turn_next")).toBe("true");
        expect(record!.fields.get("speaker_identity_state")).toBe("unassigned");
        expect(record!.fields.get("diarization_enabled")).toBe("true");
        expect(record!.fields.get("diarization_scope")).toBe(
            "experimental-speaker-turn-boundaries-only",
        );
        expect(record!.fields.get("diarization_method")).toBe("whisper.cpp-tinydiarize");
        expect(record!.fields.get("diarization_model_requirement")).toBe(
            "TDRZ-compatible Whisper model required",
        );
    });

    it("keeps sequential cues and compares against the previous cue", () => {
        const records = make([
            cue({ sequence: "0", startTimeUs: "0", endTimeUs: "1000", windowStartUs: "0" }),
            cue({ sequence: "1", startTimeUs: "1000", endTimeUs: "2000", windowStartUs: "0" }),
        ]);
        expect(records).toHaveLength(2);
        expect(records[1]!.fields.get("start_time_us")).toBe("1000");
    });

    it.each([
        ["sequence not numeric", { sequence: "one" }],
        ["start not numeric", { startTimeUs: "1.5" }],
        ["end not numeric", { endTimeUs: "-1" }],
        ["window not numeric", { windowStartUs: "x" }],
        ["blank text", { text: "   " }],
        ["NUL text", { text: "a\0b" }],
        ["oversized text", { text: "x".repeat(1_000_001) }],
    ] as const)("rejects an invalid cue: %s", (_label, overrides) => {
        expect(() => make([cue(overrides)])).toThrow("invalid provisional cue");
    });

    it.each([
        ["duplicate sequence", { sequence: "0" }],
        ["earlier start", { startTimeUs: "900000" }],
        ["start before window", { windowStartUs: "3000000" }],
        ["empty duration", { endTimeUs: "1000000" }],
        ["missing language", { language: "" }],
        ["missing model", { modelName: "" }],
        ["missing backend", { backendVersion: "" }],
    ] as const)("rejects out of order cues: %s", (_label, overrides) => {
        expect(() =>
            make([
                cue(),
                cue({ sequence: "1", startTimeUs: "2000000", endTimeUs: "3000000", ...overrides }),
            ]),
        ).toThrow("out of order or with invalid timestamps");
    });
});
