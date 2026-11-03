import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    createEncryptedArchiveBytes,
    openArchiveBytes,
    openArchiveSource,
    planTrashPurge,
    purgeTrashedArchiveSnapshot,
    type ArchiveSnapshot,
} from "../../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { CompositeArchiveSource, MemoryArchiveSource } from "../../../frontend/archive/source";

function record(type: number, id: string, fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type,
        id,
        revision: 1n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

async function base(records: ArchiveRecord[] = []): Promise<ArchiveSnapshot> {
    const empty = await openArchiveBytes(await createArchiveBytes("trash purge"));
    return records.length ? appendRecords(empty, records) : empty;
}

describe("archive trash purge planning", () => {
    it("reports blockers for deleted records that are still referenced", async () => {
        const deletedStudent = newUuid();
        const deletedNote = newUuid();
        const activeSession = newUuid();
        const activeEntry = newUuid();
        const snapshot = await base([
            record(RecordType.student, deletedStudent, {
                display_name: "Deleted learner",
                _deleted: "true",
            }),
            record(RecordType.settings, deletedNote, {
                record_role: "journal-notes",
                _deleted: "true",
            }),
            record(RecordType.session, activeSession, {
                student_id: deletedStudent,
                title: "Active session",
            }),
            record(RecordType.settings, activeEntry, {
                record_role: "journal-entry",
                session_ids: `${activeSession},${deletedStudent}`,
                note_id: deletedNote,
                other_id: deletedStudent,
            }),
        ]);
        const plan = await planTrashPurge(snapshot);
        expect(plan.generation).toBe(snapshot.commit.generation.toString());
        expect(plan.deletedRecords).toBe(2);
        expect(plan.opaqueRecords).toBe(0);
        expect(plan.blockers).toHaveLength(2);
        expect(plan.blockers[0]!.label).toBe("Deleted learner");
        expect(plan.blockers[1]!.label).toBe("journal-notes");
        expect(plan.blockers[1]!.references[0]!.fields).toEqual(["note_id"]);
        const sessionBlocker = plan.blockers.find((blocker) => blocker.recordId === deletedStudent);
        expect(sessionBlocker?.references.map((reference) => reference.label)).toEqual([
            "Active session",
            "journal-entry",
        ]);
    });

    it("covers every trash record label fallback", async () => {
        const fields: Record<string, string>[] = [
            { display_name: "display" },
            { title: "title" },
            { label: "label" },
            { original_name: "original" },
            { name: "name" },
            { content: "content" },
            { text: "text" },
            { record_role: "role" },
            {},
        ];
        const records: ArchiveRecord[] = [];
        for (const labelFields of fields) {
            const id = newUuid();
            records.push(record(RecordType.student, id, { ...labelFields, _deleted: "true" }));
            records.push(
                record(RecordType.session, newUuid(), {
                    student_id: id,
                    title: "active",
                }),
            );
        }
        const snapshot = await base(records);
        const plan = await planTrashPurge(snapshot);
        expect(plan.deletedRecords).toBe(fields.length);
        expect(plan.blockers.map((blocker) => blocker.label)).toEqual(
            fields
                .map(
                    (labelFields) =>
                        labelFields["display_name"] ??
                        labelFields["title"] ??
                        labelFields["label"] ??
                        labelFields["original_name"] ??
                        labelFields["name"] ??
                        labelFields["content"] ??
                        labelFields["text"] ??
                        labelFields["record_role"] ??
                        "student record",
                )
                .sort((left, right) => left.localeCompare(right)),
        );
    });

    it("counts opaque records", async () => {
        const snapshot = await base([record(99, newUuid(), { extension: "future" })]);
        await expect(planTrashPurge(snapshot)).resolves.toMatchObject({
            deletedRecords: 0,
            blockers: [],
            opaqueRecords: 1,
        });
    });

    it("requires an unlocked, committed archive", async () => {
        const snapshot = await base();
        const dirty = await openArchiveSource(
            new CompositeArchiveSource(
                snapshot.source,
                new MemoryArchiveSource(new Uint8Array([1, 2, 3])),
            ),
        );
        await expect(planTrashPurge(dirty)).resolves.toMatchObject({ deletedRecords: 0 });

        const passphrase = "trash purge passphrase";
        const lockedSnapshot = await openArchiveBytes(
            await createEncryptedArchiveBytes("locked trash", "", passphrase),
        );
        await expect(planTrashPurge(lockedSnapshot)).rejects.toMatchObject({
            code: "archive_locked",
        });
        await expect(purgeTrashedArchiveSnapshot(lockedSnapshot)).rejects.toMatchObject({
            code: "archive_locked",
        });
    });
});

describe("archive trash purging", () => {
    it("refuses to purge while referenced by active records", async () => {
        const studentId = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, {
                display_name: "Linked learner",
                _deleted: "true",
            }),
            record(RecordType.session, newUuid(), { student_id: studentId }),
        ]);
        await expect(purgeTrashedArchiveSnapshot(snapshot)).rejects.toMatchObject({
            code: "trash_purge_reference_blocked",
        });
    });

    it("refuses to purge with opaque records or trailing data", async () => {
        const opaque = await base([record(99, newUuid(), { extension: "future" })]);
        await expect(purgeTrashedArchiveSnapshot(opaque)).rejects.toMatchObject({
            code: "trash_purge_opaque_records",
        });

        const snapshot = await base([record(RecordType.student, newUuid(), { _deleted: "true" })]);
        const dirty = await openArchiveSource(
            new CompositeArchiveSource(
                snapshot.source,
                new MemoryArchiveSource(new Uint8Array([1, 2, 3])),
            ),
        );
        await expect(purgeTrashedArchiveSnapshot(dirty)).rejects.toMatchObject({
            code: "archive_recovery_required",
        });
    });

    it("removes deleted chains and trims trash cleanup fields", async () => {
        const deletedStudent = newUuid();
        const activeSession = newUuid();
        const notesId = newUuid();
        const snapshot = await base([
            record(RecordType.student, deletedStudent, {
                display_name: "Gone",
                _deleted: "true",
            }),
            record(RecordType.session, activeSession, {
                title: "Active",
                _trash_session_group_id: "group",
                _trash_restore_session_id: "restore",
            }),
            record(RecordType.settings, notesId, {
                record_role: "journal-notes",
                _trash_guide_group_id: "guide",
                removed_block_count: "2",
                removed_block_0: "one",
                last_removed_block_id: "block",
                last_removed_block_kind: "paragraph",
                last_removed_block_text: "text",
                last_removed_block_index: "1",
            }),
        ]);
        const purged = await purgeTrashedArchiveSnapshot(snapshot);
        expect(purged.snapshot.commit.generation).toBe(1n);
        const session = await purged.snapshot.getRecord(RecordType.session, activeSession);
        expect(session?.fields.has("_trash_session_group_id")).toBe(false);
        expect(session?.fields.has("_trash_restore_session_id")).toBe(false);
        const notes = await purged.snapshot.getRecord(RecordType.settings, notesId);
        expect(notes?.fields.has("removed_block_0")).toBe(false);
        expect(notes?.fields.has("last_removed_block_id")).toBe(false);
        expect(notes?.fields.has("removed_block_count")).toBe(false);
        expect(notes?.fields.get("updated_at_us")).toBeTruthy();
        expect(await purged.snapshot.getRecord(RecordType.student, deletedStudent)).toBeNull();
    });

    it("leaves a clean archive without trash unchanged in content", async () => {
        const studentId = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "Kept" }),
        ]);
        const purged = await purgeTrashedArchiveSnapshot(snapshot);
        await expect(
            purged.snapshot.getRecord(RecordType.student, studentId),
        ).resolves.toMatchObject({ id: studentId });
    });
});
