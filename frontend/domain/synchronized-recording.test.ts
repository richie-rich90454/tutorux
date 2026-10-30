import { describe, expect, it } from "vitest";
import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import { makeSynchronizedCaptureStartRecords } from "./synchronized-recording";

describe("synchronized capture durability", () => {
    it("persists the saved recording.durability policy on the session and take", () => {
        const session: ArchiveRecord = {
            type: RecordType.session,
            id: newUuid(),
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([["recording_state", "completed"]]),
            blob: new Uint8Array(),
        };
        const trackId = newUuid();
        const records = makeSynchronizedCaptureStartRecords({
            session,
            takeId: newUuid(),
            tracks: [{ source: "microphone", trackId, sampleRateHz: 16_000 }],
            knownTrackIds: [],
            startedAtUs: "1700000000000000",
            consentAtUs: "1700000000000000",
            durability: "reduced-write",
            captureSourceBackend: "native-audio-helper",
            consentConfirmedBy: "Tutor",
        });
        const updatedSession = records.find((record) => record.type === RecordType.session)!;
        const track = records.find(
            (record) => record.type === RecordType.assetMetadata && record.id === trackId,
        )!;
        const take = records.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "recording-take",
        )!;

        expect(updatedSession.fields.get("recording_durability")).toBe("reduced-write");
        expect(track.fields.get("durability")).toBe("reduced-write");
        expect(take.fields.get("durability")).toBe("reduced-write");
    });
});
