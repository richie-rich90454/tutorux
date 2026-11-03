import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
} from "../../../frontend/archive/archive";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { crc32, newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    mixRecordingTracks,
    mixRecordingTracksIncremental,
} from "../../../frontend/domain/audio-mix";

const RATE = 8_000;
const FRAMES = 2;

function chunkRecord(sessionId: string, trackId: string, pcm: Uint8Array): ArchiveRecord {
    return {
        type: RecordType.audioChunk,
        id: newUuid(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["session_id", sessionId],
            ["track_id", trackId],
            ["sequence_number", "0"],
            ["first_sample_index", "0"],
            ["sample_count", String(FRAMES)],
            ["gap_before_samples", "0"],
            ["sample_rate_hz", String(RATE)],
            ["channel_count", "1"],
            ["sample_format", "pcm_s16le"],
            ["codec", "none"],
            ["payload_checksum", String(crc32(pcm))],
        ]),
        blob: pcm,
    };
}

function pcmFrames(): Uint8Array {
    const pcm = new Uint8Array(FRAMES * 2);
    const view = new DataView(pcm.buffer);
    for (let frame = 0; frame < FRAMES; frame += 1) view.setInt16(frame * 2, 1000, true);
    return pcm;
}

interface MixFixture {
    readonly sessionId: string;
    readonly takeId: string;
    readonly trackIds: readonly string[];
    readonly records: ArchiveRecord[];
}

function mixFixture(): MixFixture {
    const sessionId = newUuid();
    const takeId = newUuid();
    const trackIds = [newUuid(), newUuid()];
    const records: ArchiveRecord[] = [
        {
            type: RecordType.session,
            id: sessionId,
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([["recording_track_ids", trackIds.join(",")]]),
            blob: new Uint8Array(),
        },
        {
            type: RecordType.assetMetadata,
            id: takeId,
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([
                ["record_role", "recording-take"],
                ["session_id", sessionId],
                ["track_ids", trackIds.join(",")],
            ]),
            blob: new Uint8Array(),
        },
    ];
    for (const trackId of trackIds) {
        records.push({
            type: RecordType.assetMetadata,
            id: trackId,
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([
                ["record_role", "audio-track"],
                ["session_id", sessionId],
                ["track_id", trackId],
                ["recording_take_id", takeId],
                ["sample_rate_hz", String(RATE)],
                ["channel_count", "1"],
                ["sample_format", "pcm_s16le"],
            ]),
            blob: new Uint8Array(),
        });
        records.push(chunkRecord(sessionId, trackId, pcmFrames()));
    }
    return { sessionId, takeId, trackIds, records };
}

async function snapshotFor(records: readonly ArchiveRecord[]) {
    const base = await openArchiveBytes(await createArchiveBytes("Mix branch fixture"));
    return appendRecords(base, records);
}

describe("incremental mix accounting", () => {
    it("counts a committed record that omits its sample count", async () => {
        const fixture = mixFixture();
        const snapshot = await snapshotFor(fixture.records);
        const commits: ArchiveRecord[][] = [];
        const result = await mixRecordingTracksIncremental({
            snapshot,
            sessionId: fixture.sessionId,
            takeId: fixture.takeId,
            trackIds: fixture.trackIds,
            expectedGeneration: 0n,
            chunksPerCommit: 1,
            commit: async (records) => {
                commits.push(records as ArchiveRecord[]);
                return (records as ArchiveRecord[]).map((record) => {
                    const fields = new Map(record.fields);
                    fields.delete("sample_count");
                    return { ...record, fields };
                });
            },
        });

        expect(result.frameCount).toBe(FRAMES);
        const finalTrack = commits
            .at(-1)!
            .find((record) => record.type === RecordType.assetMetadata)!;
        expect(finalTrack.fields.get("sample_count")).toBe(String(FRAMES));
        expect(finalTrack.fields.get("state")).toBe("completed");
    });

    it("counts staged records whose sample count the commit callback removed in place", async () => {
        const fixture = mixFixture();
        const snapshot = await snapshotFor(fixture.records);
        const commits: ArchiveRecord[][] = [];
        const result = await mixRecordingTracksIncremental({
            snapshot,
            sessionId: fixture.sessionId,
            takeId: fixture.takeId,
            trackIds: fixture.trackIds,
            expectedGeneration: 0n,
            chunksPerCommit: 1,
            commit: async (records) => {
                for (const record of records)
                    (record.fields as Map<string, string>).delete("sample_count");
                commits.push(records as ArchiveRecord[]);
                return records as ArchiveRecord[];
            },
        });

        expect(result.frameCount).toBe(FRAMES);
        expect(commits.length).toBeGreaterThan(1);
    });
});

describe("mix stream failures", () => {
    it("swallows a rejected stream cancellation after a chunk read fails", async () => {
        const fixture = mixFixture();
        const [firstTrack, secondTrack] = fixture.trackIds;
        const trackRecord = (trackId: string, index: number): ArchiveRecord => ({
            type: RecordType.assetMetadata,
            id: trackId!,
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([
                ["record_role", "audio-track"],
                ["session_id", fixture.sessionId],
                ["track_id", trackId!],
                ["recording_take_id", fixture.takeId],
                ["sample_rate_hz", String(RATE)],
                ["channel_count", "1"],
                ["sample_format", "pcm_s16le"],
                ["chunk_ids", `chunk-${index}`],
            ]),
            blob: new Uint8Array(),
        });
        const chunks = new Map<string, ArchiveRecord[]>([
            [firstTrack!, [chunkRecord(fixture.sessionId, firstTrack!, pcmFrames())]],
            [secondTrack!, [chunkRecord(fixture.sessionId, secondTrack!, pcmFrames())]],
        ]);
        const metadata = new Map<string, ArchiveRecord>([
            [fixture.sessionId, fixture.records[0]!],
            [fixture.takeId, fixture.records[1]!],
            [firstTrack!, trackRecord(firstTrack!, 0)],
            [secondTrack!, trackRecord(secondTrack!, 1)],
        ]);
        const snapshot = {
            locked: false,
            listAudioChunkMetadata: async (_sessionId: string, trackId: string) =>
                chunks.get(trackId) ?? [],
            getRecord: async (type: number, id: string) =>
                type === RecordType.audioChunk ? null : (metadata.get(id) ?? null),
        } as unknown as ArchiveSnapshot;

        await expect(
            mixRecordingTracks(snapshot, fixture.sessionId, fixture.takeId, fixture.trackIds),
        ).rejects.toMatchObject({ code: "audio_chunk_changed" });
    });
});
