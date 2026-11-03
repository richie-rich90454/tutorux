import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
    type ArchiveSnapshot,
} from "../../../frontend/archive/archive";
import { crc32, newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    renameRecordingTake,
    renameRecordingTrack,
    setRecordingTakeDeleted,
    setRecordingTrackDeleted,
    splitRecordingTrackIds,
} from "../../../frontend/domain/recording-takes";

type FixtureRecord = ArchiveRecord & { fields: Map<string, string> };

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

    it("recomputes the session track count when one track is trashed and restored", async () => {
        const fixture = await createRecordingFixture(2);
        const removed = await setRecordingTrackDeleted(
            fixture.snapshot,
            fixture.trackIds[1]!,
            true,
        );
        const trashed = await appendRecords(fixture.snapshot, removed);
        const trashedSession = await trashed.getRecord(RecordType.session, fixture.sessionId);
        expect(trashedSession?.fields.get("recording_track_ids")).toBe(fixture.trackIds[0]);
        expect(trashedSession?.fields.get("recording_track_count")).toBe("1");

        const restoredRecords = await setRecordingTrackDeleted(
            trashed,
            fixture.trackIds[1]!,
            false,
        );
        const restored = await appendRecords(trashed, restoredRecords);
        const restoredSession = await restored.getRecord(RecordType.session, fixture.sessionId);
        expect(restoredSession?.fields.get("recording_track_ids")).toBe(fixture.trackIds.join(","));
        expect(restoredSession?.fields.get("recording_track_count")).toBe("2");
    });
});

async function createRecordingFixture(trackCount = 1): Promise<{
    snapshot: Awaited<ReturnType<typeof openArchiveBytes>>;
    sessionId: string;
    takeId: string;
    trackId: string;
    trackIds: string[];
    chunkId: string;
}> {
    const sessionId = newUuid();
    const takeId = newUuid();
    const trackIds = Array.from({ length: trackCount }, () => newUuid());
    const trackId = trackIds[0]!;
    const chunkId = newUuid();
    const pcm = new Uint8Array([0x34, 0x12, 0xcc, 0xed]);
    const records: ArchiveRecord[] = [
        record(RecordType.session, sessionId, [
            ["title", "Audio session"],
            ["recording_track_ids", trackIds.join(",")],
            ["recording_track_id", trackId],
            ["recording_track_count", String(trackIds.length)],
        ]),
        ...trackIds.map((id) =>
            record(RecordType.assetMetadata, id, [
                ["record_role", "audio-track"],
                ["session_id", sessionId],
                ["track_id", id],
                ["recording_take_id", takeId],
                ["label", "Import"],
            ]),
        ),
        record(RecordType.assetMetadata, takeId, [
            ["record_role", "recording-take"],
            ["session_id", sessionId],
            ["track_ids", trackIds.join(",")],
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
        trackIds,
        chunkId,
    };
}

function record(
    type: ArchiveRecord["type"],
    id: string,
    fields: readonly (readonly [string, string])[],
): FixtureRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(fields),
        blob: new Uint8Array(),
    };
}

function fakeSnapshot(
    initial: readonly ArchiveRecord[],
    missing: readonly string[] = [],
): ArchiveSnapshot {
    const records = new Map(initial.map((item) => [item.id.toLowerCase(), item]));
    const absent = new Set(missing.map((id) => id.toLowerCase()));
    return {
        getRecord: async (type: number, id: string) => {
            const item = records.get(id.toLowerCase());
            if (absent.has(id.toLowerCase())) return null;
            return item && item.type === type ? item : null;
        },
        listRecordMetadata: async (type: number) =>
            [...records.values()].filter((item) => item.type === type),
        listAudioChunkMetadata: async (sessionId: string, trackId: string) =>
            [...records.values()].filter(
                (item) =>
                    item.type === RecordType.audioChunk &&
                    item.fields.get("session_id")?.toLowerCase() === sessionId.toLowerCase() &&
                    item.fields.get("track_id")?.toLowerCase() === trackId.toLowerCase(),
            ),
    } as unknown as ArchiveSnapshot;
}

const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TAKE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function sessionRecord(fields: Record<string, string> = {}): FixtureRecord {
    return record(RecordType.session, S, Object.entries(fields));
}

function takeRecord(fields: Record<string, string> = {}): FixtureRecord {
    return record(RecordType.assetMetadata, TAKE, [
        ["record_role", "recording-take"],
        ["session_id", S],
        ...Object.entries(fields),
    ]);
}

function trackRecord(id: string, fields: Record<string, string> = {}): FixtureRecord {
    return record(RecordType.assetMetadata, id, [
        ["record_role", "audio-track"],
        ["session_id", S],
        ["recording_take_id", TAKE],
        ["track_id", id],
        ...Object.entries(fields),
    ]);
}

describe("recording take tooling edges", () => {
    it("rejects missing, deleted, or mislabelled takes and tracks", async () => {
        await expect(renameRecordingTake(fakeSnapshot([]), TAKE, "Name")).rejects.toThrow(
            "not found",
        );
        await expect(
            renameRecordingTake(
                fakeSnapshot([record(RecordType.assetMetadata, TAKE, [["record_role", "x"]])]),
                TAKE,
                "Name",
            ),
        ).rejects.toThrow("not found");
        const deletedTake = {
            ...takeRecord(),
            fields: new Map([...takeRecord().fields, ["_deleted", "true"]]),
        };
        await expect(
            renameRecordingTake(fakeSnapshot([deletedTake]), TAKE, "Name"),
        ).rejects.toThrow("Restore this recording take");
        await expect(
            renameRecordingTake(fakeSnapshot([takeRecord()]), TAKE, "   "),
        ).rejects.toThrow("1–120 characters");

        await expect(renameRecordingTrack(fakeSnapshot([]), T, "Name")).rejects.toThrow(
            "Choose a saved recording track",
        );
        await expect(
            renameRecordingTrack(
                fakeSnapshot([record(RecordType.assetMetadata, T, [["record_role", "x"]])]),
                T,
                "Name",
            ),
        ).rejects.toThrow("Choose a saved recording track");
        const deletedTrack = {
            ...trackRecord(T),
            fields: new Map([...trackRecord(T).fields, ["_deleted", "true"]]),
        };
        await expect(renameRecordingTrack(fakeSnapshot([deletedTrack]), T, "Name")).rejects.toThrow(
            "Restore this recording track",
        );
    });

    it("rejects tracks that are missing or already in the requested trash state", async () => {
        await expect(setRecordingTrackDeleted(fakeSnapshot([]), T, true)).rejects.toThrow(
            "unavailable",
        );
        await expect(
            setRecordingTrackDeleted(
                fakeSnapshot([record(RecordType.assetMetadata, T, [["record_role", "x"]])]),
                T,
                true,
            ),
        ).rejects.toThrow("unavailable");
        await expect(
            setRecordingTrackDeleted(fakeSnapshot([trackRecord(T, { _deleted: "true" })]), T, true),
        ).rejects.toThrow("already in Trash");
        await expect(
            setRecordingTrackDeleted(fakeSnapshot([trackRecord(T)]), T, false),
        ).rejects.toThrow("not in Trash");
    });

    it("requires a valid take and session link before trashing a track", async () => {
        const broken = trackRecord(T, { session_id: "bad" });
        await expect(setRecordingTrackDeleted(fakeSnapshot([broken]), T, true)).rejects.toThrow(
            "not linked to a restorable",
        );
        const noTakeId = trackRecord(T, { recording_take_id: "bad" });
        await expect(setRecordingTrackDeleted(fakeSnapshot([noTakeId]), T, true)).rejects.toThrow(
            "not linked to a restorable",
        );
        const noSession = trackRecord(T);
        noSession.fields.delete("session_id");
        await expect(setRecordingTrackDeleted(fakeSnapshot([noSession]), T, true)).rejects.toThrow(
            "not linked to a restorable",
        );
        const noTake = trackRecord(T);
        noTake.fields.delete("recording_take_id");
        await expect(setRecordingTrackDeleted(fakeSnapshot([noTake]), T, true)).rejects.toThrow(
            "not linked to a restorable",
        );

        const track = trackRecord(T);
        await expect(setRecordingTrackDeleted(fakeSnapshot([track]), T, true)).rejects.toThrow(
            "Restore the parent take",
        );
        await expect(
            setRecordingTrackDeleted(
                fakeSnapshot([track, takeRecord({ _deleted: "true" })]),
                T,
                true,
            ),
        ).rejects.toThrow("Restore the parent take");
        await expect(
            setRecordingTrackDeleted(
                fakeSnapshot([
                    track,
                    record(RecordType.assetMetadata, TAKE, [["record_role", "x"]]),
                ]),
                T,
                true,
            ),
        ).rejects.toThrow("Restore the parent take");
        await expect(
            setRecordingTrackDeleted(
                fakeSnapshot([track, takeRecord({ session_id: OTHER })]),
                T,
                true,
            ),
        ).rejects.toThrow("Restore the parent take");
        await expect(
            setRecordingTrackDeleted(fakeSnapshot([track, takeRecord({ track_ids: T2 })]), T, true),
        ).rejects.toThrow("not linked to its recording take");
        await expect(
            setRecordingTrackDeleted(fakeSnapshot([track, takeRecord({ track_ids: T })]), T, true),
        ).rejects.toThrow("parent session is unavailable");
        await expect(
            setRecordingTrackDeleted(
                fakeSnapshot([
                    track,
                    takeRecord({ track_ids: T }),
                    sessionRecord({ _deleted: "true" }),
                ]),
                T,
                true,
            ),
        ).rejects.toThrow("parent session is unavailable");
    });

    it("trashes a primary track and promotes a fallback", async () => {
        const snapshot = fakeSnapshot([
            sessionRecord({ recording_track_ids: `${T},${T2}`, recording_track_id: T }),
            takeRecord({ track_ids: `${T},${T2}` }),
            trackRecord(T),
            trackRecord(T2),
        ]);
        const records = await setRecordingTrackDeleted(snapshot, T, true);
        const track = records.find((item) => item.id === T)!;
        const session = records.find((item) => item.id === S)!;

        expect(track.fields.get("_trash_restore_was_primary")).toBe("true");
        expect(track.fields.get("_trash_restore_fallback_primary_id")).toBe(T2);
        expect(session.fields.get("recording_track_id")).toBe(T2);
        expect(session.fields.get("recording_track_ids")).toBe(T2);
    });

    it("trashes a non-primary track and records a missing session position", async () => {
        const snapshot = fakeSnapshot([
            sessionRecord({ recording_track_ids: T2, recording_track_id: T2 }),
            takeRecord({ track_ids: `${T},${T2}` }),
            trackRecord(T),
            trackRecord(T2),
        ]);
        const records = await setRecordingTrackDeleted(snapshot, T, true);
        const track = records.find((item) => item.id === T)!;
        expect(track.fields.has("_trash_restore_was_primary")).toBe(false);
        expect(track.fields.get("_trash_restore_session_track_index")).toBe("1");
    });

    it("clears the primary track when the last track is trashed", async () => {
        const snapshot = fakeSnapshot([
            sessionRecord({ recording_track_ids: T, recording_track_id: T }),
            takeRecord({ track_ids: T }),
            trackRecord(T),
        ]);
        const records = await setRecordingTrackDeleted(snapshot, T, true);
        const session = records.find((item) => item.id === S)!;
        expect(session.fields.has("recording_track_id")).toBe(false);
    });

    it("restores a trashed track at its saved position and primary role", async () => {
        const snapshot = fakeSnapshot([
            sessionRecord({ recording_track_ids: T2, recording_track_id: T2 }),
            takeRecord({ track_ids: T2 }),
            trackRecord(T, {
                _deleted: "true",
                _trash_restore_was_primary: "true",
                _trash_restore_fallback_primary_id: T2,
                _trash_restore_take_track_index: "0",
                _trash_restore_session_track_index: "1",
            }),
            trackRecord(T2),
        ]);
        const records = await setRecordingTrackDeleted(snapshot, T, false);
        const session = records.find((item) => item.id === S)!;
        const track = records.find((item) => item.id === T)!;
        expect(session.fields.get("recording_track_ids")).toBe(`${T2},${T}`);
        expect(session.fields.get("recording_track_id")).toBe(T);
        expect(track.fields.has("_trash_restore_take_track_index")).toBe(false);
    });

    it("restores primary when the current primary is empty or differs", async () => {
        const base = [
            takeRecord({ track_ids: T2 }),
            trackRecord(T, {
                _deleted: "true",
                _trash_restore_was_primary: "true",
                _trash_restore_fallback_primary_id: T2,
                _trash_restore_take_track_index: "9",
                _trash_restore_session_track_index: "9",
            }),
            trackRecord(T2),
        ];
        const emptyPrimary = await setRecordingTrackDeleted(
            fakeSnapshot([sessionRecord({ recording_track_ids: T2 }), ...base]),
            T,
            false,
        );
        expect(emptyPrimary.find((item) => item.id === S)!.fields.get("recording_track_id")).toBe(
            T,
        );

        const differentPrimary = await setRecordingTrackDeleted(
            fakeSnapshot([
                sessionRecord({ recording_track_ids: `${T2},${OTHER}`, recording_track_id: OTHER }),
                ...base,
            ]),
            T,
            false,
        );
        expect(
            differentPrimary.find((item) => item.id === S)!.fields.has("recording_track_id"),
        ).toBe(true);
    });

    it("rejects restoring a track that is already linked", async () => {
        const snapshot = fakeSnapshot([
            sessionRecord({ recording_track_ids: T }),
            takeRecord({ track_ids: T }),
            trackRecord(T, { _deleted: "true" }),
        ]);
        await expect(setRecordingTrackDeleted(snapshot, T, false)).rejects.toThrow(
            "already linked to its take",
        );
    });

    it("defaults missing or invalid restore positions to the end", async () => {
        const missing = trackRecord(T, { _deleted: "true" });
        const first = await setRecordingTrackDeleted(
            fakeSnapshot([
                sessionRecord({ recording_track_ids: T2 }),
                takeRecord({ track_ids: T2 }),
                missing,
                trackRecord(T2),
            ]),
            T,
            false,
        );
        expect(first.find((item) => item.id === S)!.fields.get("recording_track_ids")).toBe(
            `${T2},${T}`,
        );

        const invalid = trackRecord(T, {
            _deleted: "true",
            _trash_restore_take_track_index: "abc",
            _trash_restore_session_track_index: "99999999999999999999",
        });
        const second = await setRecordingTrackDeleted(
            fakeSnapshot([
                sessionRecord({ recording_track_ids: T2 }),
                takeRecord({ track_ids: T2 }),
                invalid,
                trackRecord(T2),
            ]),
            T,
            false,
        );
        expect(second.find((item) => item.id === S)!.fields.get("recording_track_ids")).toBe(
            `${T2},${T}`,
        );
    });

    it("trashes and restores waveform and chunk children", async () => {
        const waveform = record(RecordType.waveformIndex, OTHER, [
            ["session_id", S],
            ["track_id", T],
        ]);
        const staleWaveform = record(
            RecordType.waveformIndex,
            "99999999-9999-4999-8999-999999999999",
            [
                ["session_id", S],
                ["track_id", T],
                ["_deleted", "true"],
            ],
        );
        const chunk = record(RecordType.audioChunk, "88888888-8888-4888-8888-888888888888", [
            ["session_id", S],
            ["track_id", T],
        ]);
        const deletedChunk = record(RecordType.audioChunk, "66666666-6666-4666-8666-666666666666", [
            ["session_id", S],
            ["track_id", T],
            ["_deleted", "true"],
        ]);
        const snapshot = fakeSnapshot([
            sessionRecord({ recording_track_ids: T, recording_track_id: T }),
            takeRecord({ track_ids: T }),
            trackRecord(T),
            waveform,
            staleWaveform,
            chunk,
            deletedChunk,
            record(RecordType.waveformIndex, "77777777-7777-4777-8777-777777777777", [
                ["session_id", OTHER],
                ["track_id", T],
            ]),
            record(RecordType.waveformIndex, "55555555-5555-4555-8555-555555555555", [
                ["session_id", S],
            ]),
        ]);
        const records = await setRecordingTrackDeleted(snapshot, T, true);
        expect(records.find((item) => item.id === waveform.id)!.fields.get("_deleted")).toBe(
            "true",
        );
        expect(records.find((item) => item.id === chunk.id)!.fields.get("_deleted")).toBe("true");
        expect(records.some((item) => item.id === staleWaveform.id)).toBe(false);

        const restored = await setRecordingTrackDeleted(
            fakeSnapshot(records, [waveform.id, chunk.id]),
            T,
            false,
        );
        expect(restored.find((item) => item.id === S)).toBeTruthy();
    });
});

describe("recording take trash edges", () => {
    it("validates the take and session before changing state", async () => {
        await expect(setRecordingTakeDeleted(fakeSnapshot([]), TAKE, true)).rejects.toThrow(
            "not found",
        );
        const deleted = {
            ...takeRecord({ track_ids: T }),
            fields: new Map([...takeRecord({ track_ids: T }).fields, ["_deleted", "true"]]),
        };
        await expect(setRecordingTakeDeleted(fakeSnapshot([deleted]), TAKE, true)).rejects.toThrow(
            "already in Trash",
        );
        const active = takeRecord({ track_ids: T });
        await expect(setRecordingTakeDeleted(fakeSnapshot([active]), TAKE, false)).rejects.toThrow(
            "not in Trash",
        );
        await expect(
            setRecordingTakeDeleted(
                fakeSnapshot([takeRecord({ session_id: "bad", track_ids: T })]),
                TAKE,
                true,
            ),
        ).rejects.toThrow("invalid session link");
        const noSession = takeRecord({ track_ids: T });
        noSession.fields.delete("session_id");
        await expect(
            setRecordingTakeDeleted(fakeSnapshot([noSession]), TAKE, true),
        ).rejects.toThrow("invalid session link");
        await expect(
            setRecordingTakeDeleted(fakeSnapshot([takeRecord({ track_ids: T })]), TAKE, true),
        ).rejects.toThrow("recording session is unavailable");
        await expect(
            setRecordingTakeDeleted(
                fakeSnapshot([takeRecord({ track_ids: T }), sessionRecord({ _deleted: "true" })]),
                TAKE,
                true,
            ),
        ).rejects.toThrow("recording session is unavailable");
        await expect(
            setRecordingTakeDeleted(
                fakeSnapshot([takeRecord({ track_ids: "bad" }), sessionRecord()]),
                TAKE,
                true,
            ),
        ).rejects.toThrow("no linked audio tracks");
        const noIds = takeRecord();
        noIds.fields.delete("track_ids");
        await expect(
            setRecordingTakeDeleted(fakeSnapshot([noIds, sessionRecord()]), TAKE, true),
        ).rejects.toThrow("no linked audio tracks");
    });

    it("trashes a take with tracks, chunks, and waveforms", async () => {
        const waveform = record(RecordType.waveformIndex, OTHER, [
            ["session_id", S],
            ["track_id", T],
        ]);
        const chunk = record(RecordType.audioChunk, "88888888-8888-4888-8888-888888888888", [
            ["session_id", S],
            ["track_id", T],
        ]);
        const deletedChunk = record(RecordType.audioChunk, "66666666-6666-4666-8666-666666666666", [
            ["session_id", S],
            ["track_id", T],
            ["_deleted", "true"],
        ]);
        const missingWaveform = record(
            RecordType.waveformIndex,
            "44444444-4444-4444-8444-444444444444",
            [
                ["session_id", S],
                ["track_id", T],
            ],
        );
        const missingChunk = record(RecordType.audioChunk, "33333333-3333-4333-8333-333333333333", [
            ["session_id", S],
            ["track_id", T],
        ]);
        const snapshot = fakeSnapshot(
            [
                sessionRecord({
                    recording_track_ids: `${T},${T2}`,
                    recording_track_id: T,
                    audio_import_track_id: T2,
                }),
                takeRecord({ track_ids: ` ${T} , ${T} ,bad,${T2}` }),
                (() => {
                    const value = trackRecord(T);
                    value.fields.delete("track_id");
                    return value;
                })(),
                trackRecord(T2),
                record(RecordType.assetMetadata, OTHER, [
                    ["record_role", "audio-track"],
                    ["session_id", S],
                ]),
                record(RecordType.assetMetadata, "12121212-1212-4212-8212-121212121212", [
                    ["record_role", "audio-track"],
                    ["session_id", S],
                    ["track_id", T],
                    ["_deleted", "true"],
                ]),
                record(RecordType.assetMetadata, "99999999-9999-4999-8999-999999999999", [
                    ["record_role", "other"],
                    ["session_id", S],
                ]),
                waveform,
                chunk,
                deletedChunk,
                missingWaveform,
                missingChunk,
                record(RecordType.waveformIndex, "55555555-5555-4555-8555-555555555555", [
                    ["session_id", S],
                ]),
            ],
            [missingWaveform.id, missingChunk.id],
        );
        const records = await setRecordingTakeDeleted(snapshot, TAKE, true);
        const session = records.find((item) => item.id === S)!;
        const take = records.find((item) => item.id === TAKE)!;
        expect(session.fields.get("recording_track_ids")).toBe("");
        expect(session.fields.has("recording_track_id")).toBe(false);
        expect(session.fields.has("audio_import_track_id")).toBe(false);
        expect(take.fields.get("_trash_restore_session_track_ids")).toBe(`${T},${T2}`);
        expect(take.fields.get("_trash_restore_session_primary_track_id")).toBe(T);
        expect(take.fields.get("_trash_restore_audio_import_track_id")).toBe(T2);
        expect(records.find((item) => item.id === waveform.id)!.fields.get("_deleted")).toBe(
            "true",
        );
        expect(records.find((item) => item.id === chunk.id)!.fields.get("_deleted")).toBe("true");
        expect(records.find((item) => item.id === OTHER)!.fields.get("_deleted")).toBe("true");
    });

    it("skips tracks that are not part of the session track list", async () => {
        const snapshot = fakeSnapshot([
            sessionRecord({ recording_track_ids: T2, recording_track_id: T2 }),
            takeRecord({ track_ids: T }),
            trackRecord(T),
        ]);
        const records = await setRecordingTakeDeleted(snapshot, TAKE, true);
        const take = records.find((item) => item.id === TAKE)!;
        expect(take.fields.has("_trash_restore_session_track_ids")).toBe(false);
        expect(take.fields.has("_trash_restore_session_primary_track_id")).toBe(false);
        expect(take.fields.has("_trash_restore_audio_import_track_id")).toBe(false);
    });

    it("restores a take, its tracks, and its saved session links", async () => {
        const snapshot = fakeSnapshot([
            sessionRecord({ recording_track_ids: T2 }),
            {
                ...takeRecord({ track_ids: `${T},${T2}` }),
                fields: new Map([
                    ...takeRecord({ track_ids: `${T},${T2}` }).fields,
                    ["_deleted", "true"],
                    ["_trash_restore_session_track_ids", `${T},${T2}`],
                    ["_trash_restore_session_primary_track_id", T],
                    ["_trash_restore_audio_import_track_id", T2],
                ]),
            },
            trackRecord(T, { _deleted: "true", _trash_group_id: TAKE }),
            trackRecord(T2, { _deleted: "true", _trash_group_id: TAKE }),
            trackRecord(OTHER, { track_id: T }),
            trackRecord("77777777-7777-4777-8777-777777777777", {
                track_id: T,
                _deleted: "true",
                _trash_group_id: "other",
            }),
        ]);
        const records = await setRecordingTakeDeleted(snapshot, TAKE, false);
        const session = records.find((item) => item.id === S)!;
        const take = records.find((item) => item.id === TAKE)!;
        expect(session.fields.get("recording_track_ids")).toBe(`${T2},${T}`);
        expect(session.fields.get("recording_track_id")).toBe(T);
        expect(session.fields.get("audio_import_track_id")).toBe(T2);
        expect(take.fields.has("_trash_restore_session_track_ids")).toBe(false);
        expect(records.find((item) => item.id === T)!.fields.has("_deleted")).toBe(false);
    });

    it("rejects a restore scope that no longer matches the take", async () => {
        const snapshot = fakeSnapshot([
            sessionRecord({ recording_track_ids: `${T},${T2}` }),
            {
                ...takeRecord({ track_ids: `${T},${T2}` }),
                fields: new Map([
                    ...takeRecord({ track_ids: `${T},${T2}` }).fields,
                    ["_deleted", "true"],
                    ["_trash_restore_session_track_ids", OTHER],
                ]),
            },
            trackRecord(T, { _deleted: "true", _trash_group_id: TAKE }),
            trackRecord(T2, { _deleted: "true", _trash_group_id: TAKE }),
        ]);
        await expect(setRecordingTakeDeleted(snapshot, TAKE, false)).rejects.toThrow(
            "restore scope no longer matches",
        );
    });

    it("skips records that are already in the target state or unfetchable", async () => {
        const missingTrack = record(RecordType.assetMetadata, OTHER, [
            ["record_role", "audio-track"],
            ["session_id", S],
            ["track_id", T],
        ]);
        const snapshot = fakeSnapshot(
            [
                sessionRecord({ recording_track_ids: T }),
                takeRecord({ track_ids: T }),
                trackRecord(T),
                missingTrack,
                record(RecordType.waveformIndex, "77777777-7777-4777-8777-777777777777", [
                    ["session_id", S],
                    ["track_id", T],
                    ["_deleted", "true"],
                ]),
            ],
            [OTHER, "77777777-7777-4777-8777-777777777777"],
        );
        const records = await setRecordingTakeDeleted(snapshot, TAKE, true);
        expect(records.some((item) => item.id === OTHER)).toBe(false);
        expect(records.some((item) => item.id === "77777777-7777-4777-8777-777777777777")).toBe(
            false,
        );
    });

    it("exposes the track id splitter", () => {
        expect(splitRecordingTrackIds(` ${T} ,bad,${T2} `)).toEqual([T, T2]);
        expect(splitRecordingTrackIds(undefined)).toEqual([]);
    });

    it("restores a take that has no saved session track scope", async () => {
        const snapshot = fakeSnapshot([
            sessionRecord({ recording_track_ids: T2 }),
            {
                ...takeRecord({ track_ids: T2 }),
                fields: new Map([...takeRecord({ track_ids: T2 }).fields, ["_deleted", "true"]]),
            },
        ]);
        const records = await setRecordingTakeDeleted(snapshot, TAKE, false);
        expect(records.find((item) => item.id === S)!.fields.get("recording_track_ids")).toBe(T2);
    });
});
