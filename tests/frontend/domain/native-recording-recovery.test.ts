import { describe, expect, it } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import {
    ArchiveFormatError,
    crc32,
    RecordType,
    type ArchiveRecord,
} from "../../../frontend/archive/format";
import { prepareNativeCaptureRecovery } from "../../../frontend/domain/native-recording-recovery";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TRACK_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TRACK_ID = "33333333-3333-4333-8333-333333333333";
const SAMPLE_RATE = 48000;
const U64_MAX = 18_446_744_073_709_551_615n;

function record(
    type: number,
    id: string,
    fields: Record<string, string> = {},
    blob: Uint8Array = new Uint8Array(),
): ArchiveRecord {
    return {
        type,
        id,
        revision: 1n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob,
    };
}

function microseconds(samples: bigint): bigint {
    const rate = BigInt(SAMPLE_RATE);
    return (samples / rate) * 1_000_000n + ((samples % rate) * 1_000_000n) / rate;
}

function chunkId(index: number, track = TRACK_ID): string {
    return `${track.slice(0, 24)}${index.toString(16).padStart(12, "0")}`;
}

function makeChunk(
    options: {
        index?: number;
        first?: number | bigint;
        frames?: number;
        gap?: number | bigint;
        blob?: Uint8Array;
        track?: string;
        fields?: Record<string, string>;
    } = {},
): ArchiveRecord {
    const index = options.index ?? 0;
    const first = BigInt(options.first ?? 0);
    const frames = options.frames ?? 4;
    const gap = BigInt(options.gap ?? 0);
    const blob = options.blob ?? new Uint8Array(frames * 2).fill(1);
    const trackId = options.track ?? TRACK_ID;
    return record(
        RecordType.audioChunk,
        chunkId(index, trackId),
        {
            sequence_number: String(index),
            first_sample_index: first.toString(),
            sample_count: String(frames),
            gap_before_samples: gap.toString(),
            timeline_start_us: microseconds(first).toString(),
            timeline_end_us: microseconds(first + BigInt(frames)).toString(),
            payload_checksum: String(crc32(blob)),
            channel_mask: "1",
            session_id: SESSION_ID,
            track_id: trackId,
            sample_format: "pcm_s16le",
            codec: "none",
            sample_rate_hz: String(SAMPLE_RATE),
            channel_count: "1",
            contains_device_discontinuity: "false",
            ...options.fields,
        },
        blob,
    );
}

function track(id = TRACK_ID, overrides: Record<string, string> = {}): ArchiveRecord {
    return record(RecordType.assetMetadata, id, {
        record_role: "audio-track",
        session_id: SESSION_ID,
        source: "microphone",
        sample_format: "pcm_s16le",
        sample_rate_hz: String(SAMPLE_RATE),
        channel_count: "1",
        channel_mask: "1",
        chunk_count: "1",
        state: "completed",
        device_id: "device-1",
        ...overrides,
    });
}

function session(overrides: Record<string, string> = {}): ArchiveRecord {
    return record(RecordType.session, SESSION_ID, {
        recording_track_ids: TRACK_ID,
        recording_track_id: TRACK_ID,
        recording_state: "completed",
        recording_audio_chunks: "1",
        ...overrides,
    });
}

function trackWithoutChunkCount(overrides: Record<string, string> = {}): ArchiveRecord {
    const base = track(TRACK_ID, overrides);
    const fields = new Map(base.fields);
    fields.delete("chunk_count");
    return { ...base, fields };
}

function withoutFields(record: ArchiveRecord, keys: readonly string[]): ArchiveRecord {
    const fields = new Map(record.fields);
    for (const key of keys) fields.delete(key);
    return { ...record, fields };
}

function environment(
    options: {
        session?: ArchiveRecord;
        metadata?: ArchiveRecord[];
        chunks?: Map<string, readonly ArchiveRecord[]>;
        chunkMetadataThrows?: boolean;
        recordThrows?: readonly string[];
        missingRecords?: readonly string[];
    } = {},
) {
    const metadata = options.metadata ?? [track()];
    const chunks = options.chunks ?? new Map([[TRACK_ID, [makeChunk()]]]);
    const records = new Map<string, ArchiveRecord>();
    for (const item of metadata)
        if (!options.missingRecords?.includes(item.id))
            records.set(`${item.type}:${item.id.toLowerCase()}`, item);
    for (const items of chunks.values())
        for (const item of items)
            if (!options.missingRecords?.includes(item.id))
                records.set(`${item.type}:${item.id.toLowerCase()}`, item);

    const archive = {
        getRecord: async (type: number, id: string) => {
            if (options.recordThrows?.includes(id.toLowerCase()))
                throw new Error("archive read failed");
            return records.get(`${type}:${id.toLowerCase()}`) ?? null;
        },
        listRecordMetadata: async (type: number) =>
            type === RecordType.assetMetadata ? metadata : [],
        listAudioChunkMetadata: async (_sessionId: string, trackId: string) => {
            if (options.chunkMetadataThrows) throw new Error("chunk index failed");
            return chunks.get(trackId) ?? [];
        },
    } as unknown as ArchiveSnapshot;
    return { archive, session: options.session ?? session(), records };
}

describe("native capture recovery session selection", () => {
    it("requires an active session record", async () => {
        const wrongType = record(RecordType.student, SESSION_ID);
        await expect(
            prepareNativeCaptureRecovery(environment().archive, wrongType),
        ).rejects.toMatchObject({ code: "session_not_found" });
        await expect(
            prepareNativeCaptureRecovery(environment().archive, session({ _deleted: "true" })),
        ).rejects.toMatchObject({ code: "session_not_found" });
    });

    it("requires at least one recoverable track", async () => {
        const { archive } = environment({
            session: session({
                recording_track_ids: "",
                recording_track_id: "",
            }),
            metadata: [],
        });
        await expect(
            prepareNativeCaptureRecovery(
                archive,
                session({ recording_track_ids: "", recording_track_id: "" }),
            ),
        ).rejects.toMatchObject({ code: "audio_recording_not_found" });
    });

    it("rejects invalid recording track identifiers", async () => {
        const { archive } = environment();
        await expect(
            prepareNativeCaptureRecovery(
                archive,
                session({ recording_track_ids: `${TRACK_ID}, not-a-uuid` }),
            ),
        ).rejects.toMatchObject({ code: "audio_track_metadata_invalid" });
    });

    it("deduplicates and lowercases explicit track identifiers", async () => {
        const { archive } = environment();
        const result = await prepareNativeCaptureRecovery(
            archive,
            session({
                recording_track_ids: `${TRACK_ID.toUpperCase()}, ${TRACK_ID}`,
                recording_track_id: "",
            }),
        );
        expect(result.tracks).toHaveLength(1);
        expect(result.tracks[0]!.trackId).toBe(TRACK_ID);
    });

    it("falls back to the legacy primary track identifier", async () => {
        const { archive } = environment();
        const result = await prepareNativeCaptureRecovery(
            archive,
            session({ recording_track_ids: "", recording_track_id: TRACK_ID.toUpperCase() }),
        );
        expect(result.tracks).toHaveLength(1);
    });

    it("discovers audio tracks from archive metadata", async () => {
        const metadata = [
            track(TRACK_ID),
            track(TRACK_ID),
            track(OTHER_TRACK_ID, { session_id: "other" }),
            track("44444444-4444-4444-8444-444444444444", { _deleted: "true" }),
            record(RecordType.assetMetadata, "55555555-5555-4555-8555-555555555555", {
                session_id: SESSION_ID,
            }),
        ];
        const chunks = new Map([
            [TRACK_ID, [makeChunk()]],
            [OTHER_TRACK_ID, [makeChunk()]],
        ]);
        const { archive } = environment({ metadata, chunks });
        const result = await prepareNativeCaptureRecovery(
            archive,
            session({ recording_track_ids: "", recording_track_id: "" }),
        );
        expect(result.tracks.map((item) => item.trackId)).toEqual([TRACK_ID]);
    });
});

describe("native capture recovery outcomes", () => {
    it("recovers a completed track and reconciles session and take state", async () => {
        const take = record(RecordType.assetMetadata, "66666666-6666-4666-8666-666666666666", {
            record_role: "recording-take",
            session_id: SESSION_ID,
            track_ids: TRACK_ID,
            state: "partial",
        });
        const chunks = [
            makeChunk({ index: 0, first: 0, frames: 4 }),
            makeChunk({ index: 1, first: 4, frames: 4 }),
        ];
        const { archive } = environment({
            metadata: [track(TRACK_ID, { chunk_count: "2" }), take],
            chunks: new Map([[TRACK_ID, chunks]]),
            session: session({ recording_audio_chunks: "2" }),
        });
        const result = await prepareNativeCaptureRecovery(
            archive,
            session({ recording_audio_chunks: "2" }),
        );

        expect(result.completed).toBe(true);
        expect(result.tracks).toHaveLength(1);
        expect(result.tracks[0]).toMatchObject({
            trackId: TRACK_ID,
            source: "microphone",
            deviceId: "device-1",
            state: "completed",
            sampleCount: "8",
            chunkCount: "2",
            byteCount: "16",
            durationUs: microseconds(8n).toString(),
            errorMessage: "",
        });
        expect(result.sampleCount).toBe("8");
        expect(result.chunkCount).toBe("2");
        expect(result.message).toBe("Verified and recovered all 1 native audio track.");

        const sessionUpdate = result.records.find((item) => item.id === SESSION_ID)!;
        expect(sessionUpdate.fields.get("recording_state")).toBe("completed");
        expect(sessionUpdate.fields.get("recording_track_count")).toBe("1");
        expect(sessionUpdate.fields.get("recording_samples")).toBe("8");
        expect(sessionUpdate.fields.get("recording_bytes")).toBe("16");
        expect(sessionUpdate.fields.get("recording_audio_chunks")).toBe("2");
        expect(sessionUpdate.fields.get("recording_error")).toBe("");
        expect(sessionUpdate.fields.get("recording_recovered_at_us")).toMatch(/^\d+$/);
        const trackUpdate = result.records.find((item) => item.id === TRACK_ID)!;
        expect(trackUpdate.fields.get("state")).toBe("completed");
        expect(trackUpdate.fields.get("recovered_at_us")).toMatch(/^\d+$/);
        const takeUpdate = result.records.find((item) => item.id === take.id)!;
        expect(takeUpdate.fields.get("state")).toBe("completed");
        expect(takeUpdate.fields.get("duration_us")).toBe(microseconds(8n).toString());
        expect(takeUpdate.fields.get("ended_at_us")).toMatch(/^\d+$/);
    });

    it("preserves partial audio with an explanatory message", async () => {
        const { archive } = environment({
            metadata: [track(TRACK_ID, { state: "interrupted" })],
        });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.completed).toBe(false);
        expect(result.tracks[0]!.state).toBe("interrupted");
        expect(result.tracks[0]!.errorMessage).toBe(
            "Committed audio was verified; the capture did not reach completion.",
        );
        expect(result.message).toContain("Preserved 1 verified native audio chunks");
        expect(result.message).toContain("microphone: Committed audio was verified");
        const sessionUpdate = result.records.find((item) => item.id === SESSION_ID)!;
        expect(sessionUpdate.fields.get("recording_state")).toBe("partial");
        expect(sessionUpdate.fields.get("recording_error")).toContain("microphone:");
    });

    it("marks a recording failed when no chunks were committed", async () => {
        const { archive } = environment({
            metadata: [trackWithoutChunkCount({ state: "failed", source: "system-audio" })],
            chunks: new Map([[TRACK_ID, []]]),
        });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.completed).toBe(false);
        expect(result.tracks[0]!.state).toBe("failed");
        expect(result.tracks[0]!.errorMessage).toBe(
            "No committed native audio chunk was available for recovery.",
        );
        expect(result.message).toContain("No valid committed native audio was available");
        const sessionUpdate = result.records.find((item) => item.id === SESSION_ID)!;
        expect(sessionUpdate.fields.get("recording_state")).toBe("failed");
    });

    it("recovers legacy session-owned tracks without metadata", async () => {
        const legacySession = session({
            recording_track_ids: "",
            recording_sample_rate_hz: String(SAMPLE_RATE),
            recording_channel_count: "1",
            recording_channel_mask: "1",
            recording_sample_format: "pcm_s16le",
            recording_device_id: "legacy-device",
            recording_state: "completed",
        });
        const { archive } = environment({
            metadata: [],
            session: legacySession,
        });
        const result = await prepareNativeCaptureRecovery(archive, legacySession);
        expect(result.completed).toBe(true);
        expect(result.tracks[0]).toMatchObject({
            source: "system-audio",
            deviceId: "legacy-device",
            state: "completed",
        });
        expect(result.records.some((item) => item.id === TRACK_ID)).toBe(false);
    });

    it("recovers when optional session and chunk fields are absent", async () => {
        const bareSession = withoutFields(session(), ["recording_track_ids"]);
        const bareChunk = withoutFields(makeChunk(), [
            "gap_before_samples",
            "contains_device_discontinuity",
        ]);
        const { archive } = environment({
            metadata: [withoutFields(track(), ["device_id"])],
            chunks: new Map([[TRACK_ID, [bareChunk]]]),
        });
        const result = await prepareNativeCaptureRecovery(archive, bareSession);
        expect(result.completed).toBe(true);
        expect(result.tracks[0]!.deviceId).toBe("");
        expect(result.tracks[0]!.discontinuities).toBe("0");
    });

    it("stringifies non-error failures", async () => {
        const archive = {
            getRecord: async () => {
                throw "plain failure";
            },
            listRecordMetadata: async () => [track()],
            listAudioChunkMetadata: async () => [],
        } as unknown as ArchiveSnapshot;
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]).toMatchObject({
            errorCode: "audio_recovery_failed",
            errorMessage: "plain failure",
        });
    });

    it("rejects a track without recovery metadata", async () => {
        const { archive } = environment({
            metadata: [record(RecordType.assetMetadata, TRACK_ID, { record_role: "other" })],
        });
        const result = await prepareNativeCaptureRecovery(
            archive,
            session({ recording_track_id: "" }),
        );
        expect(result.tracks[0]).toMatchObject({
            state: "failed",
            errorMessage: "The selected recording track has no matching recovery metadata.",
        });
    });

    it("reports failures for unavailable metadata and unsupported formats", async () => {
        const cases: Array<{
            name: string;
            metadata: ArchiveRecord[];
            recordThrows?: string[];
            chunkMetadataThrows?: boolean;
        }> = [
            {
                name: "read error",
                metadata: [track()],
                recordThrows: [TRACK_ID],
            },
            {
                name: "no recovery metadata",
                metadata: [record(RecordType.assetMetadata, TRACK_ID, { record_role: "other" })],
            },
            {
                name: "deleted metadata",
                metadata: [track(TRACK_ID, { _deleted: "true" })],
            },
            {
                name: "other session",
                metadata: [track(TRACK_ID, { session_id: "99999999-9999-4999-8999-999999999999" })],
            },
            {
                name: "missing sample rate",
                metadata: [track(TRACK_ID, { sample_rate_hz: "" })],
            },
            {
                name: "sample rate too low",
                metadata: [track(TRACK_ID, { sample_rate_hz: "7999" })],
            },
            {
                name: "sample rate too high",
                metadata: [track(TRACK_ID, { sample_rate_hz: "384001" })],
            },
            {
                name: "no channels",
                metadata: [track(TRACK_ID, { channel_count: "0" })],
            },
            {
                name: "too many channels",
                metadata: [track(TRACK_ID, { channel_count: "9" })],
            },
            {
                name: "channel mask too large",
                metadata: [track(TRACK_ID, { channel_mask: "4294967296" })],
            },
            {
                name: "unsupported sample format",
                metadata: [track(TRACK_ID, { sample_format: "pcm_s64le" })],
            },
            {
                name: "chunk index failure",
                metadata: [track()],
                chunkMetadataThrows: true,
            },
        ];

        for (const testCase of cases) {
            const { archive } = environment({
                metadata: testCase.metadata,
                ...(testCase.recordThrows ? { recordThrows: testCase.recordThrows } : {}),
                ...(testCase.chunkMetadataThrows ? { chunkMetadataThrows: true } : {}),
            });
            const result = await prepareNativeCaptureRecovery(archive, session());
            expect(result.completed, testCase.name).toBe(false);
            expect(result.tracks[0]!.state, testCase.name).toBe("failed");
            expect(result.tracks[0]!.errorMessage, testCase.name).not.toBe("");
        }
    });

    it("uses archive format error codes for format failures", async () => {
        const { archive } = environment({
            metadata: [track()],
            recordThrows: [TRACK_ID],
        });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]!.errorCode).toBe("audio_recovery_failed");
    });

    it("reports ArchiveFormatError causes with their own code", async () => {
        const metadata = [track()];
        const archive = {
            getRecord: async () => {
                throw new ArchiveFormatError("custom_code", "custom failure");
            },
            listRecordMetadata: async () => metadata,
            listAudioChunkMetadata: async () => [],
        } as unknown as ArchiveSnapshot;
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]).toMatchObject({
            errorCode: "custom_code",
            errorMessage: "custom failure",
            source: "",
            deviceId: "",
        });
    });

    it("reports a missing committed chunk", async () => {
        const { archive } = environment({ missingRecords: [chunkId(0)] });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]!.errorMessage).toBe(
            "A committed native audio chunk is missing or corrupt.",
        );
    });

    it("reports chunk read failures", async () => {
        const { archive } = environment({ recordThrows: [chunkId(0)] });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]!.errorMessage).toBe("archive read failed");
    });

    it("rejects invalid saved chunk counts", async () => {
        const invalid = environment({
            metadata: [track(TRACK_ID, { chunk_count: "many" })],
        });
        const invalidResult = await prepareNativeCaptureRecovery(invalid.archive, session());
        expect(invalidResult.tracks[0]!.errorMessage).toBe(
            "Saved native audio chunk count is invalid.",
        );

        const mismatch = environment({
            metadata: [track(TRACK_ID, { chunk_count: "2" })],
        });
        const mismatchResult = await prepareNativeCaptureRecovery(mismatch.archive, session());
        expect(mismatchResult.tracks[0]!.errorMessage).toBe(
            "The saved recording count does not match its committed chunks.",
        );

        const overflow = environment({
            metadata: [track(TRACK_ID, { chunk_count: "18446744073709551616" })],
        });
        const overflowResult = await prepareNativeCaptureRecovery(overflow.archive, session());
        expect(overflowResult.tracks[0]!.errorMessage).toBe(
            "Saved native audio chunk count is invalid.",
        );
    });

    it("does not flag a count mismatch for an interrupted saved track", async () => {
        const { archive } = environment({
            metadata: [track(TRACK_ID, { chunk_count: "9", state: "interrupted" })],
        });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]!.errorMessage).toBe(
            "Committed audio was verified; the capture did not reach completion.",
        );
    });

    it("counts discontinuities from gaps and device markers", async () => {
        const chunks = [
            makeChunk({
                index: 0,
                first: 5,
                gap: 5,
                fields: { contains_device_discontinuity: "true" },
            }),
            makeChunk({ index: 1, first: 10, gap: 1 }),
        ];
        const { archive } = environment({
            metadata: [track(TRACK_ID, { chunk_count: "2" })],
            chunks: new Map([[TRACK_ID, chunks]]),
        });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]!.discontinuities).toBe("2");
        expect(
            result.records
                .find((item) => item.id === SESSION_ID)!
                .fields.get("recording_discontinuities"),
        ).toBe("2");
    });

    it("rejects invalid discontinuity metadata", async () => {
        const { archive } = environment({
            chunks: new Map([
                [TRACK_ID, [makeChunk({ fields: { contains_device_discontinuity: "maybe" } })]],
            ]),
        });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]!.errorMessage).toBe(
            "A committed native audio chunk has invalid discontinuity metadata.",
        );
    });

    it("uses the largest timeline and duration across tracks and pluralizes the message", async () => {
        const secondTrack = track(OTHER_TRACK_ID, { chunk_count: "1" });
        const chunks = new Map([
            [TRACK_ID, [makeChunk({ index: 0, first: 0, frames: 2 })]],
            [
                OTHER_TRACK_ID,
                [makeChunk({ index: 0, first: 0, frames: 10, track: OTHER_TRACK_ID })],
            ],
        ]);
        const { archive } = environment({
            metadata: [track(TRACK_ID, { chunk_count: "1" }), secondTrack],
            chunks,
            session: session({ recording_track_ids: `${TRACK_ID},${OTHER_TRACK_ID}` }),
        });
        const result = await prepareNativeCaptureRecovery(
            archive,
            session({ recording_track_ids: `${TRACK_ID},${OTHER_TRACK_ID}` }),
        );
        expect(result.completed).toBe(true);
        expect(result.message).toBe("Verified and recovered all 2 native audio tracks.");
        expect(result.durationUs).toBe(microseconds(10n).toString());
        expect(result.sampleCount).toBe("12");
        expect(result.chunkCount).toBe("2");
    });

    it("marks takes partial or failed based on recovered tracks", async () => {
        const partialTake = record(
            RecordType.assetMetadata,
            "77777777-7777-4777-8777-777777777777",
            {
                record_role: "recording-take",
                session_id: SESSION_ID.toUpperCase(),
                track_ids: `${TRACK_ID},${OTHER_TRACK_ID}`,
            },
        );
        const completedTake = record(
            RecordType.assetMetadata,
            "88888888-8888-4888-8888-888888888888",
            {
                record_role: "recording-take",
                session_id: SESSION_ID,
                track_ids: TRACK_ID,
            },
        );
        const { archive } = environment({
            metadata: [track(), partialTake, completedTake],
        });
        const completed = await prepareNativeCaptureRecovery(archive, session());
        expect(
            completed.records.find((item) => item.id === partialTake.id)!.fields.get("state"),
        ).toBe("partial");
        expect(
            completed.records.find((item) => item.id === completedTake.id)!.fields.get("state"),
        ).toBe("completed");

        const failed = environment({
            metadata: [track(), partialTake, completedTake],
            chunks: new Map([[TRACK_ID, []]]),
            session: session({ recording_state: "failed" }),
        });
        const failedResult = await prepareNativeCaptureRecovery(
            failed.archive,
            session({ recording_state: "failed" }),
        );
        expect(
            failedResult.records.find((item) => item.id === partialTake.id)!.fields.get("state"),
        ).toBe("failed");
        expect(
            failedResult.records.find((item) => item.id === completedTake.id)!.fields.get("state"),
        ).toBe("failed");
    });

    it("skips unrelated take metadata", async () => {
        const linkedMissing = record(
            RecordType.assetMetadata,
            "99999999-9999-4999-8999-999999999999",
            { record_role: "recording-take", session_id: SESSION_ID, track_ids: TRACK_ID },
        );
        const unrelated = record(RecordType.assetMetadata, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
            record_role: "recording-take",
            session_id: SESSION_ID,
            track_ids: "",
        });
        const otherSession = record(
            RecordType.assetMetadata,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            { record_role: "recording-take", session_id: "other", track_ids: TRACK_ID },
        );
        const deleted = record(RecordType.assetMetadata, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
            record_role: "recording-take",
            session_id: SESSION_ID,
            track_ids: TRACK_ID,
            _deleted: "true",
        });
        const noTracks = record(RecordType.assetMetadata, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
            record_role: "recording-take",
            session_id: SESSION_ID,
        });
        const { archive } = environment({
            metadata: [track(), linkedMissing, unrelated, otherSession, deleted, noTracks],
            missingRecords: [linkedMissing.id],
        });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.records.some((item) => item.id === linkedMissing.id)).toBe(false);
        expect(result.records.some((item) => item.id === unrelated.id)).toBe(false);
        expect(result.records.some((item) => item.id === otherSession.id)).toBe(false);
        expect(result.records.some((item) => item.id === deleted.id)).toBe(false);
        expect(result.records.some((item) => item.id === noTracks.id)).toBe(false);
    });
});

describe("native capture chunk validation", () => {
    const invalidChunks: Array<[string, Record<string, string>, ArchiveRecord?]> = [
        ["non-sequential chunk", { sequence_number: "9" }],
        ["missing first sample", { first_sample_index: "x" }],
        ["missing frame count", { sample_count: "x" }],
        ["zero frames", { sample_count: "0" }, makeChunk({ frames: 0 })],
        ["missing gap", { gap_before_samples: "x" }],
        ["missing start time", { timeline_start_us: "x" }],
        ["missing end time", { timeline_end_us: "x" }],
        ["missing checksum", { payload_checksum: "x" }],
        ["wrong channel mask", { channel_mask: "2" }],
        ["wrong session", { session_id: "99999999-9999-4999-8999-999999999999" }],
        ["wrong track", { track_id: OTHER_TRACK_ID }],
        ["wrong sample format", { sample_format: "pcm_f32le" }],
        ["wrong codec", { codec: "opus" }],
        ["wrong sample rate", { sample_rate_hz: "44100" }],
        ["wrong channel count", { channel_count: "2" }],
        ["wrong start time", { timeline_start_us: "1" }],
        ["wrong end time", { timeline_end_us: "1" }],
        ["checksum beyond uint32", { payload_checksum: "4294967296" }],
        ["checksum mismatch", { payload_checksum: "0" }],
        ["wrong gap", { gap_before_samples: "5" }],
        ["blob size mismatch", {}, makeChunk({ frames: 4, blob: new Uint8Array(6) })],
        [
            "first sample beyond uint64",
            {
                first_sample_index: (U64_MAX - 10n).toString(),
                gap_before_samples: (U64_MAX - 10n).toString(),
            },
            makeChunk({ first: U64_MAX - 10n, frames: 4 }),
        ],
        [
            "timeline beyond maximum",
            {
                first_sample_index: (
                    (U64_MAX / 1_000_000n) * BigInt(SAMPLE_RATE) +
                    ((U64_MAX % 1_000_000n) * BigInt(SAMPLE_RATE)) / 1_000_000n
                ).toString(),
                gap_before_samples: (
                    (U64_MAX / 1_000_000n) * BigInt(SAMPLE_RATE) +
                    ((U64_MAX % 1_000_000n) * BigInt(SAMPLE_RATE)) / 1_000_000n
                ).toString(),
                sample_count: "1",
            },
            makeChunk({
                first:
                    (U64_MAX / 1_000_000n) * BigInt(SAMPLE_RATE) +
                    ((U64_MAX % 1_000_000n) * BigInt(SAMPLE_RATE)) / 1_000_000n,
                frames: 1,
            }),
        ],
    ];

    it.each(invalidChunks)("rejects a chunk with %s", async (_label, fields, base) => {
        const chunk = base
            ? record(RecordType.audioChunk, base.id, Object.fromEntries(base.fields), base.blob)
            : makeChunk();
        const broken = {
            ...chunk,
            fields: new Map([...chunk.fields, ...Object.entries(fields)]),
        };
        const { archive } = environment({
            metadata: [track()],
            chunks: new Map([[TRACK_ID, [broken]]]),
        });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]!.errorMessage).toBe(
            "A committed native audio chunk is missing, malformed, or corrupt.",
        );
    });

    it("rejects chunks that move backwards in the timeline", async () => {
        const chunks = [
            makeChunk({ index: 0, first: 0, frames: 4 }),
            makeChunk({
                index: 1,
                first: 2,
                frames: 2,
                fields: { gap_before_samples: "0" },
            }),
        ];
        const { archive } = environment({
            metadata: [track(TRACK_ID, { chunk_count: "2" })],
            chunks: new Map([[TRACK_ID, chunks]]),
        });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]!.errorMessage).toBe(
            "A committed native audio chunk is missing, malformed, or corrupt.",
        );
    });

    it("marks an incomplete track interrupted when a later chunk fails", async () => {
        const chunks = [
            makeChunk({ index: 0, first: 0, frames: 4 }),
            makeChunk({ index: 1, first: 4, frames: 2, fields: { codec: "opus" } }),
        ];
        const { archive } = environment({
            metadata: [track(TRACK_ID, { chunk_count: "2" })],
            chunks: new Map([[TRACK_ID, chunks]]),
        });
        const result = await prepareNativeCaptureRecovery(archive, session());
        expect(result.tracks[0]!.state).toBe("interrupted");
        expect(result.tracks[0]!.sampleCount).toBe("4");
        expect(result.chunkCount).toBe("1");
    });
});
