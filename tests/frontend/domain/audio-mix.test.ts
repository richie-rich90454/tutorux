import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
} from "../../../frontend/archive/archive";
import { crc32, newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    mixRecordingTracks,
    mixRecordingTracksIncremental,
} from "../../../frontend/domain/audio-mix";

describe("incremental recording mix", () => {
    it("commits track metadata, chunks, and completion without holding the mix in memory", async () => {
        const fixture = await mixFixture();
        const commits: { generation: bigint; records: readonly ArchiveRecord[] }[] = [];
        const result = await mixRecordingTracksIncremental({
            snapshot: fixture.snapshot,
            sessionId: fixture.sessionId,
            takeId: fixture.takeId,
            trackIds: fixture.trackIds,
            expectedGeneration: 3n,
            chunksPerCommit: 1,
            commit: async (records, generation) => {
                commits.push({ generation, records });
                return [...records];
            },
        });

        expect(result.records).toEqual([]);
        expect(result.frameCount).toBe(2);
        expect(result.chunkCount).toBe(1);
        expect(commits).toHaveLength(3);
        expect(commits.map((entry) => entry.generation)).toEqual([3n, 4n, 5n]);
        const chunk = commits[1]!.records.find((record) => record.type === RecordType.audioChunk);
        expect(chunk?.fields.get("sequence_number")).toBe("0");
        expect(chunk?.fields.get("sample_count")).toBe("2");
        expect(chunk?.blob.byteLength).toBe(8);
        const completedTrack = commits[2]!.records.find(
            (record) => record.type === RecordType.assetMetadata,
        );
        expect(completedTrack?.fields.get("state")).toBe("completed");
        expect(completedTrack?.fields.get("chunk_count")).toBe("1");
    });

    it("still returns a complete record set for the in-memory mix path", async () => {
        const fixture = await mixFixture();
        const result = await mixRecordingTracks(
            fixture.snapshot,
            fixture.sessionId,
            fixture.takeId,
            fixture.trackIds,
        );

        expect(
            result.records.filter((record) => record.type === RecordType.audioChunk),
        ).toHaveLength(1);
        expect(result.records.some((record) => record.type === RecordType.waveformIndex)).toBe(
            true,
        );
        expect(
            result.records
                .find(
                    (record) =>
                        record.type === RecordType.assetMetadata &&
                        record.fields.get("track_id") === result.trackId,
                )
                ?.fields.get("state"),
        ).toBe("completed");
    });

    it("records only committed frames in partial and failed mix metadata", async () => {
        const fixture = await mixFixture(4096);
        const run = async (failAtGeneration: bigint) => {
            const commits: { generation: bigint; records: readonly ArchiveRecord[] }[] = [];
            let injected = false;
            await expect(
                mixRecordingTracksIncremental({
                    snapshot: fixture.snapshot,
                    sessionId: fixture.sessionId,
                    takeId: fixture.takeId,
                    trackIds: fixture.trackIds,
                    expectedGeneration: 0n,
                    chunksPerCommit: 1,
                    commit: async (records, generation) => {
                        commits.push({ generation, records });
                        if (
                            !injected &&
                            generation === failAtGeneration &&
                            records.some((record) => record.type === RecordType.audioChunk)
                        ) {
                            injected = true;
                            throw new Error("simulated mix commit failure");
                        }
                        return [...records];
                    },
                }),
            ).rejects.toThrow("simulated mix commit failure");
            return commits
                .at(-1)!
                .records.find((record) => record.type === RecordType.assetMetadata)!;
        };

        const partial = await run(2n);
        expect(partial.fields.get("state")).toBe("partial");
        expect(partial.fields.get("sample_count")).toBe("2048");
        expect(partial.fields.get("duration_us")).toBe("256000");
        expect(partial.fields.get("chunk_count")).toBe("1");

        const failed = await run(1n);
        expect(failed.fields.get("state")).toBe("failed");
        expect(failed.fields.get("sample_count")).toBe("0");
        expect(failed.fields.get("duration_us")).toBe("0");
        expect(failed.fields.get("chunk_count")).toBe("0");
    });
});

async function mixFixture(frameCount = 2): Promise<{
    snapshot: Awaited<ReturnType<typeof openArchiveBytes>>;
    sessionId: string;
    takeId: string;
    trackIds: string[];
}> {
    const sessionId = newUuid();
    const takeId = newUuid();
    const trackIds = [newUuid(), newUuid()];
    const session: ArchiveRecord = {
        type: RecordType.session,
        id: sessionId,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["title", "Mix session"],
            ["recording_track_ids", trackIds.join(",")],
        ]),
        blob: new Uint8Array(),
    };
    const take: ArchiveRecord = {
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
    };
    const records: ArchiveRecord[] = [session, take];
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
                ["sample_rate_hz", "8000"],
                ["channel_count", "1"],
                ["sample_format", "pcm_s16le"],
            ]),
            blob: new Uint8Array(),
        });
        const pcm = new Uint8Array(frameCount * 2);
        const pcmView = new DataView(pcm.buffer);
        for (let frame = 0; frame < frameCount; frame += 1) {
            pcmView.setInt16(frame * 2, (frame % 200) - 100, true);
        }
        records.push({
            type: RecordType.audioChunk,
            id: newUuid(),
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([
                ["session_id", sessionId],
                ["track_id", trackId],
                ["sequence_number", "0"],
                ["first_sample_index", "0"],
                ["sample_count", String(frameCount)],
                ["sample_rate_hz", "8000"],
                ["channel_count", "1"],
                ["sample_format", "pcm_s16le"],
                ["codec", "none"],
                ["payload_checksum", String(crc32(pcm))],
            ]),
            blob: pcm,
        });
    }
    const base = await openArchiveBytes(await createArchiveBytes("Mix fixture"));
    return { snapshot: await appendRecords(base, records), sessionId, takeId, trackIds };
}
