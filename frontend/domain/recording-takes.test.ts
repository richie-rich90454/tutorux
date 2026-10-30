import { describe, expect, it } from "vitest";
import { appendRecords, createArchiveBytes, openArchiveBytes } from "../archive/archive";
import { crc32, newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import {
    renameRecordingTake,
    renameRecordingTrack,
    setRecordingTakeDeleted,
} from "./recording-takes";

describe("recording take management", () => {
    it("renames takes and tracks with C++-compatible single-line bounds", async () => {
        const fixture = await createRecordingFixture();

        const take = await renameRecordingTake(fixture.snapshot, fixture.takeId, "  Review  ");
        const track = await renameRecordingTrack(
            fixture.snapshot,
            fixture.trackId,
            "  Microphone  ",
        );

        expect(take.fields.get("label")).toBe("Review");
        expect(track.fields.get("label")).toBe("Microphone");
        await expect(
            renameRecordingTake(fixture.snapshot, fixture.takeId, "bad\nlabel"),
        ).rejects.toThrow(/one line/u);
        await expect(
            renameRecordingTrack(fixture.snapshot, fixture.trackId, "é".repeat(61)),
        ).rejects.toThrow(/120 characters/u);
    });

    it("moves a take, its track, and its audio chunks into Trash and restores them", async () => {
        const fixture = await createRecordingFixture();
        const originalChunk = await fixture.snapshot.getRecord(
            RecordType.audioChunk,
            fixture.chunkId,
        );
        expect(originalChunk).not.toBeNull();

        const removed = await setRecordingTakeDeleted(fixture.snapshot, fixture.takeId, true);
        const trashed = await appendRecords(fixture.snapshot, removed);
        const trashedTake = await trashed.getRecord(RecordType.assetMetadata, fixture.takeId);
        const trashedTrack = await trashed.getRecord(RecordType.assetMetadata, fixture.trackId);
        const trashedSession = await trashed.getRecord(RecordType.session, fixture.sessionId);
        const trashedChunk = await trashed.getRecord(RecordType.audioChunk, fixture.chunkId);

        expect(trashedTake?.fields.get("_deleted")).toBe("true");
        expect(trashedTrack?.fields.get("_trash_group_id")).toBe(fixture.takeId);
        expect(trashedChunk?.fields.get("_trash_group_id")).toBe(fixture.takeId);
        expect(trashedChunk?.blob).toEqual(originalChunk?.blob);
        expect(trashedSession?.fields.get("recording_track_ids")).toBe("");
        expect(trashedSession?.fields.has("recording_track_id")).toBe(false);
        await expect(setRecordingTakeDeleted(trashed, fixture.takeId, true)).rejects.toThrow(
            /already in Trash/u,
        );

        const restoredRecords = await setRecordingTakeDeleted(trashed, fixture.takeId, false);
        const restored = await appendRecords(trashed, restoredRecords);
        const restoredTake = await restored.getRecord(RecordType.assetMetadata, fixture.takeId);
        const restoredTrack = await restored.getRecord(RecordType.assetMetadata, fixture.trackId);
        const restoredSession = await restored.getRecord(RecordType.session, fixture.sessionId);
        const restoredChunk = await restored.getRecord(RecordType.audioChunk, fixture.chunkId);

        expect(restoredTake?.fields.has("_deleted")).toBe(false);
        expect(restoredTrack?.fields.has("_deleted")).toBe(false);
        expect(restoredChunk?.fields.has("_deleted")).toBe(false);
        expect(restoredSession?.fields.get("recording_track_ids")).toBe(fixture.trackId);
        expect(restoredSession?.fields.get("recording_track_id")).toBe(fixture.trackId);
        expect(restoredChunk?.blob).toEqual(originalChunk?.blob);
    });
});

async function createRecordingFixture(): Promise<{
    snapshot: Awaited<ReturnType<typeof openArchiveBytes>>;
    sessionId: string;
    takeId: string;
    trackId: string;
    chunkId: string;
}> {
    const sessionId = newUuid();
    const takeId = newUuid();
    const trackId = newUuid();
    const chunkId = newUuid();
    const pcm = new Uint8Array([0x34, 0x12, 0xcc, 0xed]);
    const records: ArchiveRecord[] = [
        record(RecordType.session, sessionId, [
            ["title", "Audio session"],
            ["recording_track_ids", trackId],
            ["recording_track_id", trackId],
            ["recording_track_count", "1"],
        ]),
        record(RecordType.assetMetadata, trackId, [
            ["record_role", "audio-track"],
            ["session_id", sessionId],
            ["track_id", trackId],
            ["recording_take_id", takeId],
            ["label", "Import"],
        ]),
        record(RecordType.assetMetadata, takeId, [
            ["record_role", "recording-take"],
            ["session_id", sessionId],
            ["track_ids", trackId],
            ["label", "Original take"],
        ]),
        {
            ...record(RecordType.audioChunk, chunkId, [
                ["session_id", sessionId],
                ["track_id", trackId],
                ["sequence_number", "0"],
                ["first_sample_index", "0"],
                ["sample_count", "2"],
                ["sample_rate_hz", "8000"],
                ["channel_count", "1"],
                ["sample_format", "pcm_s16le"],
                ["codec", "none"],
                ["payload_checksum", String(crc32(pcm))],
            ]),
            blob: pcm,
        },
    ];
    const created = await openArchiveBytes(await createArchiveBytes("Recording take fixture"));
    return {
        snapshot: await appendRecords(created, records),
        sessionId,
        takeId,
        trackId,
        chunkId,
    };
}

function record(
    type: ArchiveRecord["type"],
    id: string,
    fields: readonly (readonly [string, string])[],
): ArchiveRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(fields),
        blob: new Uint8Array(),
    };
}
