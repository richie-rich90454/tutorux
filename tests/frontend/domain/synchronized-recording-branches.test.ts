import { describe, expect, it } from "vitest";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    makeSynchronizedCaptureStartRecords,
    type SynchronizedCaptureTrackIdentity,
} from "../../../frontend/domain/synchronized-recording";

const TIMESTAMP = "1700000000000000";

function session(fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type: RecordType.session,
        id: newUuid(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([["recording_state", "completed"], ...Object.entries(fields)]),
        blob: new Uint8Array(),
    };
}

describe("synchronized capture start session fields", () => {
    it("keeps existing counters and adopts the take track as the primary track", () => {
        const track: SynchronizedCaptureTrackIdentity = {
            source: "microphone",
            trackId: newUuid(),
            sampleRateHz: 16_000,
        };
        const records = makeSynchronizedCaptureStartRecords({
            session: session({ recording_duration_us: "5000" }),
            takeId: newUuid(),
            tracks: [track],
            knownTrackIds: [],
            startedAtUs: TIMESTAMP,
            consentAtUs: TIMESTAMP,
            captureSourceBackend: "web-audio",
            consentConfirmedBy: "Tutor",
        });
        const updated = records.find((record) => record.type === RecordType.session)!;

        expect(updated.fields.get("recording_duration_us")).toBe("5000");
        expect(updated.fields.get("recording_track_id")).toBe(track.trackId.toLowerCase());
        expect(updated.fields.get("recording_track_ids")).toBe(track.trackId.toLowerCase());
    });
});
