import { describe, expect, it } from "vitest";
import {
    appendRecords,
    ArchiveSnapshot,
    backfillArchiveSecondaryIndexes,
    createArchiveBytes,
    openArchiveBytes,
    verifyArchiveHistory,
    verifyArchiveSnapshot,
    type ArchiveSnapshot as Snapshot,
} from "../../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";

function record(
    type: number,
    id: string,
    fields: Record<string, string> = {},
    blob = new Uint8Array(),
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

function view(snapshot: Snapshot, index: Map<string, bigint>): Snapshot {
    return new ArchiveSnapshot(
        snapshot.source,
        snapshot.header,
        snapshot.commit,
        index,
        snapshot.publishedEndOffset,
    );
}

function primaryOnly(snapshot: Snapshot): Map<string, bigint> {
    return new Map(
        [...snapshot.allIndexEntries()].filter(
            ([key]) => key.split(":").length === 2 && !key.startsWith("BLOB:"),
        ),
    );
}

describe("secondary index backfill with legacy entries", () => {
    async function legacyArchive(): Promise<Snapshot> {
        const studentId = newUuid();
        const sessionId = newUuid();
        const annotationId = newUuid();
        const transcriptId = newUuid();
        const nodeA = newUuid();
        const nodeB = newUuid();
        return appendRecords(await openArchiveBytes(await createArchiveBytes("legacy")), [
            record(RecordType.student, studentId, { display_name: "Mina" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
            record(RecordType.annotation, annotationId, {
                session_id: sessionId,
                start_time_us: "10",
            }),
            record(RecordType.transcriptSegment, transcriptId, { session_id: sessionId }),
            record(RecordType.evidenceNode, nodeA, { session_id: sessionId }),
            record(RecordType.evidenceNode, nodeB, { session_id: sessionId }),
            record(RecordType.evidenceEdge, newUuid(), {
                session_id: sessionId,
                from_id: nodeA,
                to_id: nodeB,
            }),
        ]);
    }

    it("adds every missing secondary alias and schema version", async () => {
        const joined = await legacyArchive();
        const legacy = view(joined, primaryOnly(joined));
        const result = await backfillArchiveSecondaryIndexes(legacy);
        expect(result.addedEntries).toBeGreaterThan(0);
        expect(result.conflictingEntries).toBe(0);
        expect(result.schemaVersionsUpdated).toBe(false);
        await expect(verifyArchiveSnapshot(result.snapshot)).resolves.toBeDefined();
        const entries = result.snapshot.allIndexEntries();
        expect([...entries.keys()].some((key) => key.startsWith("STUDENTSESSION:"))).toBe(true);
        expect([...entries.keys()].some((key) => key.startsWith("ANNOTATIONSESSION:"))).toBe(true);
        expect([...entries.keys()].some((key) => key.startsWith("TRANSCRIPTSESSION:"))).toBe(true);
        expect([...entries.keys()].some((key) => key.startsWith("EVIDENCEADJ:"))).toBe(true);
    });

    it("records conflicting aliases without guessing", async () => {
        const joined = await legacyArchive();
        const studentId = [...joined.allIndexEntries().keys()]
            .find((key) => key.startsWith("STUDENT:"))!
            .slice("STUDENT:".length);
        const sessionId = [...joined.allIndexEntries().keys()]
            .find((key) => key.startsWith("SESSION:"))!
            .slice("SESSION:".length);
        const index = primaryOnly(joined);
        const studentOffset = index.get(`STUDENT:${studentId}`)!;
        index.set(`STUDENTSESSION:${studentId}:${sessionId}`, studentOffset);
        const result = await backfillArchiveSecondaryIndexes(view(joined, index));
        expect(result.conflictingEntries).toBe(1);
        const manifest = await result.snapshot.getRecord(
            RecordType.settings,
            result.snapshot.header.id,
        );
        expect(manifest?.fields.get("student_session_index_version")).toBe("0");
    });
});

describe("archive transaction policy", () => {
    it("rejects duplicate records in one transaction", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("duplicates"));
        const id = newUuid();
        await expect(
            appendRecords(snapshot, [
                record(RecordType.student, id, { display_name: "One" }),
                record(RecordType.student, id, { display_name: "Two" }),
            ]),
        ).rejects.toMatchObject({ code: "record_duplicate" });
    });

    it("rejects managed record types", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("managed"));
        await expect(
            appendRecords(snapshot, [record(RecordType.indexPage, newUuid(), {})]),
        ).rejects.toMatchObject({ code: "record_type_invalid" });
        await expect(
            appendRecords(snapshot, [record(RecordType.commit, newUuid(), {})]),
        ).rejects.toMatchObject({ code: "record_type_invalid" });
    });

    it("rejects duplicate audio sequence identifiers", async () => {
        const sessionId = newUuid();
        const trackId = newUuid();
        const snapshot = await openArchiveBytes(await createArchiveBytes("audio duplicate"));
        await expect(
            appendRecords(snapshot, [
                record(RecordType.audioChunk, newUuid(), {
                    session_id: sessionId,
                    track_id: trackId,
                    sequence_number: "1",
                }),
                record(RecordType.audioChunk, newUuid(), {
                    session_id: sessionId,
                    track_id: trackId,
                    sequence_number: "1",
                }),
            ]),
        ).rejects.toMatchObject({ code: "audio_chunk_sequence_duplicate" });
    });

    it("versions an existing session when audio chunks are appended later", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const first = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("audio version")),
            [
                record(RecordType.student, studentId, { display_name: "Mina" }),
                record(RecordType.session, sessionId, { student_id: studentId }),
            ],
        );
        const withAudio = await appendRecords(first, [
            record(RecordType.audioChunk, newUuid(), {
                session_id: sessionId,
                track_id: newUuid(),
                sequence_number: "0",
            }),
        ]);
        const session = await withAudio.getRecord(RecordType.session, sessionId);
        expect(session?.revision).toBe(2n);
        expect(session?.fields.get("audio_chunk_index_version")).toBe("1");
        const manifest = await withAudio.getRecord(RecordType.settings, withAudio.header.id);
        expect(manifest?.fields.get("audio_chunk_index_version")).toBe("1");
    });

    it("removes stale secondary aliases when a key component changes", async () => {
        const sessionId = newUuid();
        const annotationId = newUuid();
        const first = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("secondary removal")),
            [
                record(RecordType.session, sessionId, {}),
                record(RecordType.annotation, annotationId, {
                    session_id: sessionId,
                    start_time_us: "0",
                }),
            ],
        );
        const oldKey = `ANNOTATIONSESSION:${sessionId}:00000000000000000000:${annotationId}`;
        expect(first.allIndexEntries().has(oldKey)).toBe(true);
        const updated = await appendRecords(first, [
            record(RecordType.annotation, annotationId, {
                session_id: sessionId,
                start_time_us: "5",
            }),
        ]);
        expect(updated.allIndexEntries().has(oldKey)).toBe(false);
        expect(
            updated
                .allIndexEntries()
                .has(`ANNOTATIONSESSION:${sessionId}:00000000000000000005:${annotationId}`),
        ).toBe(true);
    });

    it("ignores deleted guides when marking citations stale", async () => {
        const studentId = newUuid();
        const guideId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("deleted guide")),
            [
                record(RecordType.student, studentId, { display_name: "Mina" }),
                record(RecordType.guide, guideId, {
                    session_count: "0",
                    section_count: "1",
                    "section.0.heading": "One",
                    "section.0.block_count": "1",
                    "section.0.block.0.kind": "paragraph",
                    "section.0.block.0.text": "Mina",
                    "section.0.block.0.source_ids": studentId,
                }),
            ],
        );
        const deletedGuide = await snapshot.getRecord(RecordType.guide, guideId);
        const updated = await appendRecords(snapshot, [
            record(RecordType.student, studentId, { display_name: "Mina updated" }),
            { ...deletedGuide!, fields: new Map([...deletedGuide!.fields, ["_deleted", "true"]]) },
        ]);
        expect(await updated.getRecord(RecordType.guide, guideId)).toMatchObject({
            fields: expect.any(Map),
        });
    });

    it("applies an explicit manifest update in the same transaction", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("manifest update"));
        const manifest = await snapshot.getRecord(RecordType.settings, snapshot.header.id);
        const fields = new Map(manifest!.fields);
        fields.set("display_name", "Renamed archive");
        const updated = await appendRecords(snapshot, [{ ...manifest!, fields }]);
        await expect(updated.getManifest()).resolves.toMatchObject({
            displayName: "Renamed archive",
        });
    });
});

describe("archive history verification", () => {
    it("verifies every committed generation and revision", async () => {
        const studentId = newUuid();
        const created = await openArchiveBytes(await createArchiveBytes("history"));
        const second = await appendRecords(created, [
            record(RecordType.student, studentId, { display_name: "First" }),
        ]);
        const third = await appendRecords(second, [
            record(RecordType.student, studentId, { display_name: "Second" }),
        ]);
        const result = await verifyArchiveHistory(third);
        expect(result).toMatchObject({
            generation: "3",
            currentRecords: 2,
            verifiedCommits: 3,
            historicalRevisions: 3,
        });
        expect(result.verifiedGenerationRecords).toBeGreaterThan(0);
        expect(result.liveRecords).toBe(2);
    });

    it("rejects a history whose full verification fails", async () => {
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("invalid history")),
            [
                record(RecordType.session, newUuid(), {
                    student_id: newUuid(),
                }),
            ],
        );
        await expect(verifyArchiveHistory(snapshot)).rejects.toMatchObject({
            code: "archive_verification_failed",
        });
    });
});
