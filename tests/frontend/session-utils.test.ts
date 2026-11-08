import { describe, expect, it } from "vitest";
import type { TranscriptCue } from "../../frontend/api/types";
import { parseTranscript, toSrt, toVtt } from "../../frontend/features/sessions/session-utils";

const cue = (id: string, start: number, body: string): TranscriptCue => ({
    id,
    sessionId: "session-1",
    startUs: start,
    endUs: start + 1_000_000,
    speaker: "",
    body,
    verified: false,
    createdAt: 0,
    updatedAt: 0,
});

describe("session transcript utilities", () => {
    it("parses timestamped and plain transcript lines", () => {
        const parsed = parseTranscript(
            "0:05 Teacher: Fractions are parts of a whole.\n1:10 Student: One half.",
            "session-1",
        );
        expect(parsed).toHaveLength(2);
        expect(parsed[0]?.body).toBe("Fractions are parts of a whole.");
        expect(parsed[0]?.speaker).toBe("Teacher");
        expect(parsed[0]?.startUs).toBe(5_000_000);
        expect(parsed[1]?.startUs).toBe(70_000_000);
    });

    it("parses SRT and VTT blocks", () => {
        const parsed = parseTranscript(
            "1\n00:00:01,000 --> 00:00:03,000\nFractions\n\n2\n00:00:04,000 --> 00:00:06,000\nOne half",
            "session-1",
        );
        expect(parsed).toHaveLength(2);
        expect(parsed[0]?.startUs).toBe(1_000_000);
        expect(parsed[1]?.endUs).toBe(6_000_000);
    });

    it("exports SRT and VTT timestamps", () => {
        const cues = [cue("a", 65_000_000, "Hello")];
        expect(toSrt(cues)).toContain("00:01:05,000 --> 00:01:06,000");
        expect(toVtt(cues)).toContain("00:01:05.000 --> 00:01:06.000");
    });
});
