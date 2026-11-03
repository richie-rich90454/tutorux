import { describe, expect, it, vi } from "vitest";
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

type FixtureRecord = ArchiveRecord & { fields: Map<string, string> };

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

type MixFormat = "pcm_u8" | "pcm_s16le" | "pcm_s24le" | "pcm_s32le" | "pcm_f32le";

interface TrackSpec {
    format: MixFormat;
    channels: number;
    rate: number;
    frames: number;
    gapBefore?: number;
    nanIndex?: number;
}

function encodeSamples(format: MixFormat, samples: readonly number[]): Uint8Array {
    const bytesPerSample =
        format === "pcm_u8" ? 1 : format === "pcm_s16le" ? 2 : format === "pcm_s24le" ? 3 : 4;
    const bytes = new Uint8Array(samples.length * bytesPerSample);
    const view = new DataView(bytes.buffer);
    samples.forEach((sample, index) => {
        const at = index * bytesPerSample;
        switch (format) {
            case "pcm_u8":
                bytes[at] = Math.round(sample / 256) + 128;
                break;
            case "pcm_s16le":
                view.setInt16(at, sample, true);
                break;
            case "pcm_s24le": {
                const raw = sample * 256;
                bytes[at] = raw & 0xff;
                bytes[at + 1] = (raw >> 8) & 0xff;
                bytes[at + 2] = (raw >> 16) & 0xff;
                break;
            }
            case "pcm_s32le":
                view.setInt32(at, sample * 65536, true);
                break;
            case "pcm_f32le":
                view.setFloat32(at, sample / 32768, true);
                break;
        }
    });
    return bytes;
}

function trackSpecRecords(
    sessionId: string,
    takeId: string,
    trackId: string,
    spec: TrackSpec,
    withChunk = true,
): FixtureRecord[] {
    const bytesPerSample =
        spec.format === "pcm_u8"
            ? 1
            : spec.format === "pcm_s16le"
              ? 2
              : spec.format === "pcm_s24le"
                ? 3
                : 4;
    const samples = Array.from(
        { length: spec.frames * spec.channels },
        (_, index) => ((index * 37) % 2000) - 1000,
    );
    if (spec.nanIndex !== undefined) samples[spec.nanIndex] = Number.NaN;
    const blob = encodeSamples(spec.format, samples);
    const gap = spec.gapBefore ?? 0;
    const records: FixtureRecord[] = [
        {
            type: RecordType.assetMetadata,
            id: trackId,
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([
                ["record_role", "audio-track"],
                ["session_id", sessionId],
                ["track_id", trackId],
                ["recording_take_id", takeId],
                ["sample_rate_hz", String(spec.rate)],
                ["channel_count", String(spec.channels)],
                ["sample_format", spec.format],
            ]),
            blob: new Uint8Array(),
        },
    ];
    if (withChunk) {
        records.push({
            type: RecordType.audioChunk,
            id: newUuid(),
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([
                ["session_id", sessionId],
                ["track_id", trackId],
                ["sequence_number", "0"],
                ["first_sample_index", String(gap)],
                ["sample_count", String(spec.frames)],
                ["gap_before_samples", String(gap)],
                ["sample_rate_hz", String(spec.rate)],
                ["channel_count", String(spec.channels)],
                ["sample_format", spec.format],
                ["codec", "none"],
                ["payload_checksum", String(crc32(blob))],
            ]),
            blob: blob.slice(0, spec.frames * spec.channels * bytesPerSample),
        });
    }
    return records;
}

function mixRecords(trackCount: number): {
    records: FixtureRecord[];
    sessionId: string;
    takeId: string;
    trackIds: string[];
} {
    const sessionId = newUuid();
    const takeId = newUuid();
    const trackIds = Array.from({ length: trackCount }, () => newUuid());
    const records: FixtureRecord[] = [
        {
            type: RecordType.session,
            id: sessionId,
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([
                ["title", "Mix session"],
                ["recording_track_ids", trackIds.join(",")],
            ]),
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
        ...trackIds.flatMap((id) =>
            trackSpecRecords(sessionId, takeId, id, {
                format: "pcm_s16le",
                channels: 1,
                rate: 8000,
                frames: 4,
            }),
        ),
    ];
    return { records, sessionId, takeId, trackIds };
}

async function snapshotFor(records: readonly ArchiveRecord[]) {
    const base = await openArchiveBytes(await createArchiveBytes("Mix edge fixture"));
    return appendRecords(base, records);
}

describe("mix validation and formats", () => {
    it("rejects invalid track selections and labels", async () => {
        const fixture = mixRecords(2);
        const snapshot = await snapshotFor(fixture.records);
        const base = {
            snapshot,
            sessionId: fixture.sessionId,
            takeId: fixture.takeId,
            expectedGeneration: 0n,
            commit: async (records: readonly ArchiveRecord[]) => [...records],
        };
        await expect(
            mixRecordingTracksIncremental({ ...base, trackIds: [fixture.trackIds[0]!] }),
        ).rejects.toThrow("between two and eight");
        await expect(
            mixRecordingTracksIncremental({
                ...base,
                trackIds: new Array(9).fill(fixture.trackIds[0]) as string[],
            }),
        ).rejects.toThrow("between two and eight");
        await expect(
            mixRecordingTracksIncremental({
                ...base,
                trackIds: [fixture.trackIds[0]!, fixture.trackIds[0]!],
            }),
        ).rejects.toThrow("between two and eight");
        await expect(
            mixRecordingTracksIncremental({ ...base, trackIds: fixture.trackIds, label: " " }),
        ).resolves.toBeTruthy();
        await expect(
            mixRecordingTracksIncremental({
                ...base,
                trackIds: fixture.trackIds,
                label: "a".repeat(121),
            }),
        ).rejects.toThrow("at most 120 bytes");
        await expect(
            mixRecordingTracksIncremental({
                ...base,
                trackIds: fixture.trackIds,
                label: "bad\nlabel",
            }),
        ).rejects.toThrow("one line");
    });

    it("rejects unavailable sessions and takes", async () => {
        const fixture = mixRecords(2);
        const snapshot = await snapshotFor(fixture.records);
        const base = {
            snapshot,
            sessionId: fixture.sessionId,
            takeId: fixture.takeId,
            trackIds: fixture.trackIds,
            expectedGeneration: 0n,
            commit: async (records: readonly ArchiveRecord[]) => [...records],
        };
        await expect(
            mixRecordingTracksIncremental({ ...base, sessionId: newUuid() }),
        ).rejects.toThrow("session is unavailable");
        const deletedSession = await snapshotFor(
            fixture.records.map((item) =>
                item.id === fixture.sessionId
                    ? { ...item, fields: new Map([...item.fields, ["_deleted", "true"]]) }
                    : item,
            ),
        );
        await expect(
            mixRecordingTracksIncremental({ ...base, snapshot: deletedSession }),
        ).rejects.toThrow("session is unavailable");

        await expect(mixRecordingTracksIncremental({ ...base, takeId: newUuid() })).rejects.toThrow(
            "saved take",
        );
        for (const patch of [
            ["_deleted", "true"],
            ["record_role", "other"],
            ["session_id", newUuid()],
        ] as const) {
            const mutated = await snapshotFor(
                fixture.records.map((item) =>
                    item.id === fixture.takeId
                        ? { ...item, fields: new Map([...item.fields, [patch[0], patch[1]]]) }
                        : item,
                ),
            );
            await expect(
                mixRecordingTracksIncremental({ ...base, snapshot: mutated }),
            ).rejects.toThrow("saved take");
        }
    });

    it("rejects tracks that do not belong to the take", async () => {
        const fixture = mixRecords(2);
        const cases: ((records: FixtureRecord[]) => void)[] = [
            (records) => {
                const take = records.find((item) => item.id === fixture.takeId)!;
                take.fields.set("track_ids", fixture.trackIds[1]!);
            },
            (records) => {
                const track = records.find((item) => item.id === fixture.trackIds[0])!;
                track.fields.set("_deleted", "true");
            },
            (records) => {
                const track = records.find((item) => item.id === fixture.trackIds[0])!;
                track.fields.set("record_role", "other");
            },
            (records) => {
                const track = records.find((item) => item.id === fixture.trackIds[0])!;
                track.fields.set("session_id", newUuid());
            },
            (records) => {
                const track = records.find((item) => item.id === fixture.trackIds[0])!;
                track.fields.set("recording_take_id", newUuid());
            },
        ];
        for (const mutate of cases) {
            const records: FixtureRecord[] = fixture.records.map((item) => ({
                ...item,
                fields: new Map(item.fields),
            }));
            mutate(records);
            const snapshot = await snapshotFor(records);
            await expect(
                mixRecordingTracksIncremental({
                    snapshot,
                    sessionId: fixture.sessionId,
                    takeId: fixture.takeId,
                    trackIds: fixture.trackIds,
                    expectedGeneration: 0n,
                    commit: async (items: readonly ArchiveRecord[]) => [...items],
                }),
            ).rejects.toThrow("chosen take");
        }
    });

    it("rejects tracks without saved audio or with an invalid timeline", async () => {
        const fixture = mixRecords(2);
        const noChunks = fixture.records.filter(
            (item) =>
                item.type !== RecordType.audioChunk ||
                item.fields.get("track_id") !== fixture.trackIds[0],
        );
        await expect(
            mixRecordingTracksIncremental({
                snapshot: await snapshotFor(noChunks),
                sessionId: fixture.sessionId,
                takeId: fixture.takeId,
                trackIds: fixture.trackIds,
                expectedGeneration: 0n,
                commit: async (items: readonly ArchiveRecord[]) => [...items],
            }),
        ).rejects.toThrow("no saved audio");

        const invalid = fixture.records.map((item) => {
            if (
                item.type !== RecordType.audioChunk ||
                item.fields.get("track_id") !== fixture.trackIds[0]
            ) {
                return item;
            }
            const fields = new Map(item.fields);
            fields.set("first_sample_index", "9007199254740993");
            return { ...item, fields };
        });
        await expect(
            mixRecordingTracksIncremental({
                snapshot: await snapshotFor(invalid),
                sessionId: fixture.sessionId,
                takeId: fixture.takeId,
                trackIds: fixture.trackIds,
                expectedGeneration: 0n,
                commit: async (items: readonly ArchiveRecord[]) => [...items],
            }),
        ).rejects.toThrow("invalid timeline");
    });

    it("mixes pcm_u8 and float sources with different rates", async () => {
        const sessionId = newUuid();
        const takeId = newUuid();
        const trackIds = [newUuid(), newUuid()];
        const records = [
            ...mixRecords(0).records.slice(0, 0),
            {
                type: RecordType.session,
                id: sessionId,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([["recording_track_ids", trackIds.join(",")]]) as Map<
                    string,
                    string
                >,
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
                ]) as Map<string, string>,
                blob: new Uint8Array(),
            },
            ...trackSpecRecords(sessionId, takeId, trackIds[0]!, {
                format: "pcm_u8",
                channels: 1,
                rate: 8000,
                frames: 4,
            }),
            ...trackSpecRecords(sessionId, takeId, trackIds[1]!, {
                format: "pcm_f32le",
                channels: 2,
                rate: 8000,
                frames: 8,
            }),
        ];
        const result = await mixRecordingTracks(
            await snapshotFor(records),
            sessionId,
            takeId,
            trackIds,
        );
        expect(result.sampleRateHz).toBe(8000);
        expect(result.frameCount).toBe(8);
        expect(result.chunkCount).toBe(1);
    });

    it("mixes 24-bit, 32-bit, and multi-channel sources", async () => {
        const sessionId = newUuid();
        const takeId = newUuid();
        const trackIds = [newUuid(), newUuid(), newUuid()];
        const records = [
            {
                type: RecordType.session,
                id: sessionId,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([["recording_track_ids", trackIds.join(",")]]) as Map<
                    string,
                    string
                >,
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
                ]) as Map<string, string>,
                blob: new Uint8Array(),
            },
            ...trackSpecRecords(sessionId, takeId, trackIds[0]!, {
                format: "pcm_s24le",
                channels: 3,
                rate: 8000,
                frames: 32,
            }),
            ...trackSpecRecords(sessionId, takeId, trackIds[1]!, {
                format: "pcm_s32le",
                channels: 2,
                rate: 8000,
                frames: 4,
            }),
            ...trackSpecRecords(sessionId, takeId, trackIds[2]!, {
                format: "pcm_s16le",
                channels: 1,
                rate: 8000,
                frames: 4,
            }),
        ];
        const result = await mixRecordingTracks(
            await snapshotFor(records),
            sessionId,
            takeId,
            trackIds,
        );
        expect(result.frameCount).toBe(32);
        const chunk = result.records.find((item) => item.type === RecordType.audioChunk)!;
        expect(chunk.fields.get("channel_count")).toBe("2");
    });

    it("pads leading gaps with silence and records the gap", async () => {
        vi.resetModules();
        vi.doMock("../../../frontend/domain/audio", () => ({
            buildAudioTrackWavStream: async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array(44));
                        controller.enqueue(new Uint8Array(8));
                        controller.enqueue(new Uint8Array(8));
                        controller.close();
                    },
                }),
        }));
        const mod = await import("../../../frontend/domain/audio-mix");
        const sessionId = newUuid();
        const takeId = newUuid();
        const trackIds = [newUuid(), newUuid()];
        const records = [
            {
                type: RecordType.session,
                id: sessionId,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([["recording_track_ids", trackIds.join(",")]]) as Map<
                    string,
                    string
                >,
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
                ]) as Map<string, string>,
                blob: new Uint8Array(),
            },
            ...trackSpecRecords(sessionId, takeId, trackIds[0]!, {
                format: "pcm_s16le",
                channels: 1,
                rate: 8000,
                frames: 4,
                gapBefore: 4,
            }),
            ...trackSpecRecords(sessionId, takeId, trackIds[1]!, {
                format: "pcm_s16le",
                channels: 1,
                rate: 8000,
                frames: 4,
                gapBefore: 4,
            }),
        ];
        try {
            const commits: ArchiveRecord[][] = [];
            const result = await mod.mixRecordingTracksIncremental({
                snapshot: await snapshotFor(records),
                sessionId,
                takeId,
                trackIds,
                expectedGeneration: 0n,
                commit: async (items: readonly ArchiveRecord[]) => {
                    commits.push([...items]);
                    return [...items];
                },
            });
            expect(result.chunkCount).toBe(1);
            const chunk = commits.flat().find((item) => item.type === RecordType.audioChunk)!;
            expect(chunk.fields.get("gap_before_samples")).toBe("4");
        } finally {
            vi.doUnmock("../../../frontend/domain/audio");
            vi.resetModules();
        }
    });

    it("reports partial and failed metadata when completion commit also fails", async () => {
        const fixture = mixRecords(2);
        const snapshot = await snapshotFor(fixture.records);
        const commits: ArchiveRecord[][] = [];
        await expect(
            mixRecordingTracksIncremental({
                snapshot,
                sessionId: fixture.sessionId,
                takeId: fixture.takeId,
                trackIds: fixture.trackIds,
                expectedGeneration: 0n,
                chunksPerCommit: 1,
                commit: async (records, generation) => {
                    commits.push([...records]);
                    if (generation >= 2n) throw new Error("final commit failed");
                    return [...records];
                },
            }),
        ).rejects.toThrow("final commit failed");
        expect(commits.length).toBeGreaterThan(1);
    });
    it("treats non-finite float samples as silence", async () => {
        const sessionId = newUuid();
        const takeId = newUuid();
        const trackIds = [newUuid(), newUuid()];
        const records = [
            {
                type: RecordType.session,
                id: sessionId,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([["recording_track_ids", trackIds.join(",")]]) as Map<
                    string,
                    string
                >,
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
                ]) as Map<string, string>,
                blob: new Uint8Array(),
            },
            ...trackSpecRecords(sessionId, takeId, trackIds[0]!, {
                format: "pcm_f32le",
                channels: 1,
                rate: 8000,
                frames: 4,
                nanIndex: 0,
            }),
            ...trackSpecRecords(sessionId, takeId, trackIds[1]!, {
                format: "pcm_s16le",
                channels: 1,
                rate: 8000,
                frames: 4,
            }),
        ];
        const result = await mixRecordingTracks(
            await snapshotFor(records),
            sessionId,
            takeId,
            trackIds,
        );
        expect(result.records.some((item) => item.type === RecordType.audioChunk)).toBe(true);
    });

    it("defaults missing chunk metadata when validating a track", async () => {
        vi.resetModules();
        vi.doMock("../../../frontend/domain/audio", () => ({
            buildAudioTrackWavStream: async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array(44));
                        controller.enqueue(new Uint8Array(64));
                        controller.close();
                    },
                }),
        }));
        const mod = await import("../../../frontend/domain/audio-mix");
        const sessionId = newUuid();
        const takeId = newUuid();
        const trackIds = [newUuid(), newUuid()];
        const records = [
            {
                type: RecordType.session,
                id: sessionId,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([["recording_track_ids", trackIds.join(",")]]) as Map<
                    string,
                    string
                >,
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
                ]) as Map<string, string>,
                blob: new Uint8Array(),
            },
            ...trackIds.map((id) => ({
                type: RecordType.assetMetadata,
                id,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([
                    ["record_role", "audio-track"],
                    ["session_id", sessionId],
                    ["recording_take_id", takeId],
                    ["track_id", id],
                ]) as Map<string, string>,
                blob: new Uint8Array(),
            })),
        ];
        const snapshot = {
            getRecord: async (type: number, id: string) =>
                records.find((item) => item.type === type && item.id === id) ?? null,
            listAudioChunkMetadata: async (_sessionId: string, trackId: string) => [
                {
                    type: RecordType.audioChunk,
                    id: `${trackId}-chunk`,
                    revision: 0n,
                    previousOffset: 0n,
                    fields: new Map([
                        ["sample_count", "4"],
                        ["sample_rate_hz", "8000"],
                        ["channel_count", "1"],
                    ]),
                    blob: new Uint8Array(),
                },
            ],
        };
        try {
            await expect(
                mod.mixRecordingTracks(snapshot as never, sessionId, takeId, trackIds),
            ).rejects.toThrow("Unsupported source audio format");
        } finally {
            vi.doUnmock("../../../frontend/domain/audio");
            vi.resetModules();
        }
    });

    it("rejects a track whose sample count is missing", async () => {
        const sessionId = newUuid();
        const takeId = newUuid();
        const trackIds = [newUuid(), newUuid()];
        const records = [
            {
                type: RecordType.session,
                id: sessionId,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([["recording_track_ids", trackIds.join(",")]]) as Map<
                    string,
                    string
                >,
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
                ]) as Map<string, string>,
                blob: new Uint8Array(),
            },
            ...trackIds.map((id) => ({
                type: RecordType.assetMetadata,
                id,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([
                    ["record_role", "audio-track"],
                    ["session_id", sessionId],
                    ["recording_take_id", takeId],
                    ["track_id", id],
                ]) as Map<string, string>,
                blob: new Uint8Array(),
            })),
        ];
        const snapshot = {
            getRecord: async (type: number, id: string) =>
                records.find((item) => item.type === type && item.id === id) ?? null,
            listAudioChunkMetadata: async (_sessionId: string, trackId: string) => [
                {
                    type: RecordType.audioChunk,
                    id: `${trackId}-chunk`,
                    revision: 0n,
                    previousOffset: 0n,
                    fields: new Map([["sample_format", "pcm_s16le"]]),
                    blob: new Uint8Array(),
                },
            ],
        };
        await expect(
            mixRecordingTracksIncremental({
                snapshot: snapshot as never,
                sessionId,
                takeId,
                trackIds,
                expectedGeneration: 0n,
                commit: async (items: readonly ArchiveRecord[]) => [...items],
            }),
        ).rejects.toThrow("invalid timeline");
    });

    it("requires the take to list its tracks", async () => {
        const fixture = mixRecords(2);
        const records = fixture.records.map((item) =>
            item.id === fixture.takeId
                ? {
                      ...item,
                      fields: new Map([...item.fields].filter(([key]) => key !== "track_ids")),
                  }
                : item,
        );
        await expect(
            mixRecordingTracksIncremental({
                snapshot: await snapshotFor(records),
                sessionId: fixture.sessionId,
                takeId: fixture.takeId,
                trackIds: fixture.trackIds,
                expectedGeneration: 0n,
                commit: async (items: readonly ArchiveRecord[]) => [...items],
            }),
        ).rejects.toThrow("chosen take");
    });

    it("rejects audio that is too short to produce a frame", async () => {
        vi.resetModules();
        vi.doMock("../../../frontend/domain/audio", () => ({
            buildAudioTrackWavStream: async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array(44));
                        controller.close();
                    },
                    cancel() {
                        return Promise.reject(new Error("cancel failed"));
                    },
                }),
        }));
        const mod = await import("../../../frontend/domain/audio-mix");
        const sessionId = newUuid();
        const takeId = newUuid();
        const trackIds = [newUuid(), newUuid()];
        const records = [
            {
                type: RecordType.session,
                id: sessionId,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([["recording_track_ids", trackIds.join(",")]]) as Map<
                    string,
                    string
                >,
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
                ]) as Map<string, string>,
                blob: new Uint8Array(),
            },
            ...trackIds.map((id) => ({
                type: RecordType.assetMetadata,
                id,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([
                    ["record_role", "audio-track"],
                    ["session_id", sessionId],
                    ["recording_take_id", takeId],
                    ["track_id", id],
                ]) as Map<string, string>,
                blob: new Uint8Array(),
            })),
        ];
        const snapshot = {
            getRecord: async (type: number, id: string) =>
                records.find((item) => item.type === type && item.id === id) ?? null,
            listAudioChunkMetadata: async (_sessionId: string, trackId: string) => [
                {
                    type: RecordType.audioChunk,
                    id: `${trackId}-chunk`,
                    revision: 0n,
                    previousOffset: 0n,
                    fields: new Map([
                        ["first_sample_index", "0"],
                        ["sample_count", "1"],
                        ["sample_rate_hz", "2000000"],
                        ["channel_count", "1"],
                        ["sample_format", "pcm_s16le"],
                    ]),
                    blob: new Uint8Array(2),
                },
            ],
        };
        try {
            await expect(
                mod.mixRecordingTracksIncremental({
                    snapshot: snapshot as never,
                    sessionId,
                    takeId,
                    trackIds,
                    expectedGeneration: 0n,
                    commit: async (items: readonly ArchiveRecord[]) => [...items],
                }),
            ).rejects.toThrow("too long to mix");
        } finally {
            vi.doUnmock("../../../frontend/domain/audio");
            vi.resetModules();
        }
    });

    it("rejects a source stream that ends before its timeline", async () => {
        vi.resetModules();
        vi.doMock("../../../frontend/domain/audio", () => ({
            buildAudioTrackWavStream: async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array(44));
                        controller.close();
                    },
                    cancel() {
                        return Promise.reject(new Error("cancel failed"));
                    },
                }),
        }));
        const mod = await import("../../../frontend/domain/audio-mix");
        const fixture = mixRecords(2);
        try {
            await expect(
                mod.mixRecordingTracksIncremental({
                    snapshot: await snapshotFor(fixture.records),
                    sessionId: fixture.sessionId,
                    takeId: fixture.takeId,
                    trackIds: fixture.trackIds,
                    expectedGeneration: 0n,
                    commit: async (items: readonly ArchiveRecord[]) => [...items],
                }),
            ).rejects.toThrow("ended unexpectedly");
        } finally {
            vi.doUnmock("../../../frontend/domain/audio");
            vi.resetModules();
        }
    });

    it("rejects an incomplete source frame", async () => {
        vi.resetModules();
        vi.doMock("../../../frontend/domain/audio", () => ({
            buildAudioTrackWavStream: async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array(44));
                        controller.enqueue(new Uint8Array(1));
                        controller.close();
                    },
                }),
        }));
        const mod = await import("../../../frontend/domain/audio-mix");
        const fixture = mixRecords(2);
        try {
            await expect(
                mod.mixRecordingTracksIncremental({
                    snapshot: await snapshotFor(fixture.records),
                    sessionId: fixture.sessionId,
                    takeId: fixture.takeId,
                    trackIds: fixture.trackIds,
                    expectedGeneration: 0n,
                    commit: async (items: readonly ArchiveRecord[]) => [...items],
                }),
            ).rejects.toThrow("frame is incomplete");
        } finally {
            vi.doUnmock("../../../frontend/domain/audio");
            vi.resetModules();
        }
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
