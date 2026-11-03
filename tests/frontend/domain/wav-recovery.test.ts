import { describe, expect, it, vi } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { crc32, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { prepareWavImportRecovery } from "../../../frontend/domain/wav-recovery";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const trackId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const takeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const chunkId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type FixtureRecord = ArchiveRecord & { fields: Map<string, string> };

function makeSession(fields: Record<string, string> = {}): FixtureRecord {
    return {
        type: RecordType.session,
        id: sessionId,
        revision: 0n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map(
            Object.entries({
                audio_import_state: "importing",
                audio_import_track_id: trackId,
                audio_import_expected_chunks: "1",
                audio_import_expected_samples: "2",
                audio_import_expected_bytes: "4",
                audio_import_sample_rate_hz: "8000",
                audio_import_channel_count: "1",
                audio_import_sample_format: "pcm_s16le",
                ...fields,
            }),
        ),
    };
}

function makeChunk(
    fields: Record<string, string> = {},
    blob: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3, 4]),
): ArchiveRecord {
    return {
        type: RecordType.audioChunk,
        id: chunkId,
        revision: 0n,
        previousOffset: 0n,
        blob,
        fields: new Map(
            Object.entries({
                sequence_number: "0",
                first_sample_index: "0",
                sample_count: "2",
                payload_checksum: String(crc32(blob)),
                timeline_start_us: "0",
                timeline_end_us: "250",
                session_id: sessionId,
                track_id: trackId,
                sample_format: "pcm_s16le",
                codec: "none",
                sample_rate_hz: "8000",
                channel_count: "1",
                channel_mask: "0",
                ...fields,
            }),
        ),
    };
}

function makeTake(fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type: RecordType.assetMetadata,
        id: takeId,
        revision: 0n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map(
            Object.entries({
                record_role: "recording-take",
                state: "recording",
                ...fields,
            }),
        ),
    };
}

function fakeSnapshot(
    options: {
        metadata?: ArchiveRecord[];
        records?: Record<string, ArchiveRecord | null>;
        metadataError?: Error;
        recordError?: Error;
    } = {},
): ArchiveSnapshot {
    const records = options.records ?? { [chunkId]: makeChunk() };
    return {
        listAudioChunkMetadata: vi.fn(async () => {
            if (options.metadataError) throw options.metadataError;
            return options.metadata ?? [{ id: chunkId } as ArchiveRecord];
        }),
        getRecord: vi.fn(async (_type: number, id: string) => {
            if (options.recordError) throw options.recordError;
            return records[id] ?? null;
        }),
    } as unknown as ArchiveSnapshot;
}

describe("WAV import recovery", () => {
    it("verifies committed chunks and marks a completed import", async () => {
        const result = await prepareWavImportRecovery(fakeSnapshot(), makeSession());

        expect(result.completed).toBe(true);
        expect(result.state).toBe("completed");
        expect(result.chunkCount).toBe(1);
        expect(result.sampleCount).toBe("2");
        expect(result.byteCount).toBe("4");
        expect(result.message).toContain("Verified 1 audio chunks");
        expect(result.records[0]!.fields.get("recording_state")).toBe("completed");
        expect(result.records[0]!.fields.has("audio_imported_at_us")).toBe(true);
    });

    it("updates an active recording take", async () => {
        const snapshot = fakeSnapshot({
            records: { [chunkId]: makeChunk(), [takeId]: makeTake() },
        });
        const result = await prepareWavImportRecovery(
            snapshot,
            makeSession({ audio_import_take_id: takeId }),
        );

        expect(result.records).toHaveLength(2);
        expect(result.records[1]!.fields.get("state")).toBe("completed");
        expect(result.records[1]!.fields.get("duration_us")).toBe("250");
    });

    it("rejects sessions that are not active sessions", async () => {
        await expect(
            prepareWavImportRecovery(fakeSnapshot(), {
                ...makeSession(),
                type: RecordType.settings,
            }),
        ).rejects.toMatchObject({ code: "session_not_found" });
        await expect(
            prepareWavImportRecovery(fakeSnapshot(), makeSession({ _deleted: "true" })),
        ).rejects.toMatchObject({ code: "session_not_found" });
    });

    it("rejects sessions without recoverable import metadata", async () => {
        await expect(
            prepareWavImportRecovery(fakeSnapshot(), makeSession({ audio_import_state: "idle" })),
        ).rejects.toMatchObject({ code: "audio_recovery_unavailable" });
        const noState = makeSession();
        noState.fields.delete("audio_import_state");
        await expect(prepareWavImportRecovery(fakeSnapshot(), noState)).rejects.toMatchObject({
            code: "audio_recovery_unavailable",
        });
    });

    it("reports incomplete or invalid import metadata", async () => {
        const cases: Record<string, string>[] = [
            { audio_import_track_id: "not-a-uuid" },
            { audio_import_expected_chunks: "" },
            { audio_import_expected_samples: "" },
            { audio_import_expected_bytes: "" },
            { audio_import_sample_rate_hz: "" },
            { audio_import_channel_count: "" },
            { audio_import_expected_chunks: "0" },
            { audio_import_expected_chunks: "1000001" },
            { audio_import_expected_samples: "0" },
            { audio_import_expected_bytes: "0" },
            { audio_import_sample_rate_hz: "7999" },
            { audio_import_sample_rate_hz: "384001" },
            { audio_import_channel_count: "0" },
            { audio_import_channel_count: "9" },
            { audio_import_sample_format: "unknown" },
        ];
        for (const fields of cases) {
            const result = await prepareWavImportRecovery(fakeSnapshot(), makeSession(fields));
            expect(result.completed).toBe(false);
            expect(result.state).toBe("interrupted");
            expect(result.message).toContain("incomplete or invalid");
            expect(result.chunkCount).toBe(0);
        }
    });

    it("reports a mismatch between samples and byte counts", async () => {
        const overflow = await prepareWavImportRecovery(
            fakeSnapshot(),
            makeSession({
                audio_import_expected_samples: (2n ** 63n).toString(),
                audio_import_expected_bytes: "1",
            }),
        );
        expect(overflow.message).toContain("does not match its expected byte count");

        const mismatch = await prepareWavImportRecovery(
            fakeSnapshot(),
            makeSession({ audio_import_expected_bytes: "5" }),
        );
        expect(mismatch.message).toContain("does not match its expected byte count");
    });

    it("wraps chunk read failures", async () => {
        await expect(
            prepareWavImportRecovery(
                fakeSnapshot({ recordError: new Error("disk gone") }),
                makeSession(),
            ),
        ).rejects.toMatchObject({ code: "audio_recovery_chunk_read_failed" });
        await expect(
            prepareWavImportRecovery(
                fakeSnapshot({ recordError: new Error("disk gone") }),
                makeSession(),
            ),
        ).rejects.toThrow("disk gone");
    });

    it("reports a missing committed chunk", async () => {
        const result = await prepareWavImportRecovery(
            fakeSnapshot({ records: { [chunkId]: null } }),
            makeSession(),
        );
        expect(result.completed).toBe(false);
        expect(result.message).toContain("missing or corrupt");
    });

    it("rejects every malformed chunk field", async () => {
        const corrupt = (fields: Record<string, string>, blob?: Uint8Array<ArrayBuffer>) =>
            prepareWavImportRecovery(
                fakeSnapshot({ records: { [chunkId]: makeChunk(fields, blob) } }),
                makeSession(),
            );

        const cases: Record<string, string>[] = [
            { sequence_number: "1" },
            { first_sample_index: "1" },
            { sample_count: "" },
            { sample_count: "0" },
            { payload_checksum: "" },
            { timeline_start_us: "" },
            { timeline_end_us: "" },
            { session_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
            { track_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
            { sample_format: "pcm_f32le" },
            { codec: "flac" },
            { sample_rate_hz: "16000" },
            { channel_count: "2" },
            { channel_mask: "3" },
            { sample_count: (2n ** 63n + 1n).toString() },
            { sample_count: (2n ** 60n).toString() },
            { first_sample_index: (2n ** 64n - 2n).toString() },
            { first_sample_index: (2n ** 60n).toString() },
            { payload_checksum: (2n ** 32n).toString() },
            { payload_checksum: "1" },
            { timeline_start_us: "1" },
            { timeline_end_us: "1" },
        ];
        for (const fields of cases) {
            const result = await corrupt(fields);
            expect(result.completed).toBe(false);
            expect(result.message).toContain("malformed, or corrupt");
        }

        const byteMismatch = await corrupt({}, new Uint8Array([1, 2]));
        expect(byteMismatch.message).toContain("malformed, or corrupt");
    });

    it("preserves partial progress when chunks stop early", async () => {
        const result = await prepareWavImportRecovery(
            fakeSnapshot(),
            makeSession({
                audio_import_expected_chunks: "2",
                audio_import_expected_samples: "4",
                audio_import_expected_bytes: "8",
            }),
        );
        expect(result.completed).toBe(false);
        expect(result.state).toBe("interrupted");
        expect(result.chunkCount).toBe(1);
        expect(result.message).toContain("do not reach the expected end");
    });

    it("marks a take failed when no chunks were recovered", async () => {
        const result = await prepareWavImportRecovery(
            fakeSnapshot({
                metadata: [{ id: chunkId } as ArchiveRecord],
                records: { [chunkId]: makeChunk({ payload_checksum: "1" }), [takeId]: makeTake() },
            }),
            makeSession({ audio_import_take_id: takeId }),
        );
        expect(result.records[1]!.fields.get("state")).toBe("failed");
    });

    it("marks a take partially complete when some chunks were recovered", async () => {
        const result = await prepareWavImportRecovery(
            fakeSnapshot({ records: { [chunkId]: makeChunk(), [takeId]: makeTake() } }),
            makeSession({
                audio_import_take_id: takeId,
                audio_import_expected_chunks: "2",
                audio_import_expected_samples: "4",
                audio_import_expected_bytes: "8",
            }),
        );
        expect(result.records[1]!.fields.get("state")).toBe("partial");
    });

    it("rejects a missing or inactive recording take", async () => {
        await expect(
            prepareWavImportRecovery(
                fakeSnapshot({ records: { [chunkId]: makeChunk() } }),
                makeSession({ audio_import_take_id: takeId }),
            ),
        ).rejects.toMatchObject({ code: "recording_take_not_found" });
        await expect(
            prepareWavImportRecovery(
                fakeSnapshot({
                    records: {
                        [chunkId]: makeChunk(),
                        [takeId]: makeTake({ record_role: "other" }),
                    },
                }),
                makeSession({ audio_import_take_id: takeId }),
            ),
        ).rejects.toMatchObject({ code: "recording_take_not_found" });
        await expect(
            prepareWavImportRecovery(
                fakeSnapshot({
                    records: { [chunkId]: makeChunk(), [takeId]: makeTake({ _deleted: "true" }) },
                }),
                makeSession({ audio_import_take_id: takeId }),
            ),
        ).rejects.toMatchObject({ code: "recording_take_not_found" });
    });

    it("treats a missing sample format as an empty format name", async () => {
        const session = makeSession();
        session.fields.delete("audio_import_sample_format");
        const result = await prepareWavImportRecovery(fakeSnapshot(), session);
        expect(result.state).toBe("interrupted");
        expect(result.message).toContain("incomplete or invalid");
    });

    it("reports a non-Error chunk read failure by message", async () => {
        await expect(
            prepareWavImportRecovery(
                fakeSnapshot({ recordError: "disk unavailable" as unknown as Error }),
                makeSession(),
            ),
        ).rejects.toThrow(/Could not read audio chunk .*: disk unavailable/u);
    });

    it("treats an unsigned field above the 64-bit range as absent", async () => {
        const result = await prepareWavImportRecovery(
            fakeSnapshot(),
            makeSession({ audio_import_expected_chunks: "18446744073709551616" }),
        );
        expect(result.state).toBe("interrupted");
        expect(result.message).toContain("incomplete or invalid");
    });
});
