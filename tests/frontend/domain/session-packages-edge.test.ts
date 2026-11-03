import { afterEach, describe, expect, it, vi } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
    type ArchiveSnapshot,
} from "../../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    createSessionPackage,
    importSessionPackage,
} from "../../../frontend/domain/session-packages";

type Uuid = `${string}-${string}-${string}-${string}-${string}`;

function nextUuid(): Uuid {
    return newUuid() as Uuid;
}

function record(type: number, id: string, values: Record<string, string> = {}): ArchiveRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(values)),
        blob: new Uint8Array(),
    };
}

async function emptyArchive(name = "Package fixture"): Promise<ArchiveSnapshot> {
    return openArchiveBytes(await createArchiveBytes(name));
}

async function sourceArchive(records: readonly ArchiveRecord[]): Promise<ArchiveSnapshot> {
    return appendRecords(await emptyArchive("Source workspace"), records);
}

async function packageWith(
    records: readonly ArchiveRecord[],
    sessionId: string,
    manifestFields: Record<string, string> = {},
): Promise<ArchiveSnapshot> {
    const base = await emptyArchive("Transfer package");
    const manifest = await base.getRecord(RecordType.settings, base.header.id);
    const fields = new Map(manifest!.fields);
    fields.set("record_role", "tutorux-session-package");
    fields.set("package_version", "1");
    fields.set("source_session_id", sessionId);
    for (const [key, value] of Object.entries(manifestFields)) fields.set(key, value);
    return appendRecords(base, [{ ...manifest!, fields }, ...records]);
}

function makeSession(id: string, fields: Record<string, string> = {}): ArchiveRecord {
    return record(RecordType.session, id, {
        student_id: "anonymous",
        session_state: "completed",
        ...fields,
    });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("session package export edge cases", () => {
    it("validates the session identifier and existence", async () => {
        const source = await sourceArchive([]);
        await expect(createSessionPackage(source, "not-a-uuid")).rejects.toThrow(
            /Session ID has an invalid identifier/u,
        );
        await expect(createSessionPackage(source, newUuid())).rejects.toThrow(
            /Session is missing from the selected archive/u,
        );

        const sessionId = newUuid();
        const deleted = await sourceArchive([makeSession(sessionId, { _deleted: "true" })]);
        await expect(createSessionPackage(deleted, sessionId)).rejects.toThrow(
            /Session is missing from the selected archive/u,
        );
    });

    it("rejects references to missing asset metadata", async () => {
        const sessionId = newUuid();
        const missingAsset = newUuid();
        const source = await sourceArchive([
            makeSession(sessionId),
            record(RecordType.transcriptSegment, newUuid(), {
                session_id: sessionId,
                linked_asset_ids: missingAsset,
            }),
        ]);
        await expect(createSessionPackage(source, sessionId)).rejects.toThrow(
            /asset metadata that is not available/u,
        );
    });

    it("rejects missing and deleted asset blobs", async () => {
        const sessionId = newUuid();
        const assetId = newUuid();
        const blobId = newUuid();
        const missing = await sourceArchive([
            makeSession(sessionId),
            record(RecordType.transcriptSegment, newUuid(), {
                session_id: sessionId,
                linked_asset_ids: assetId,
            }),
            record(RecordType.assetMetadata, assetId, { blob_id: blobId }),
        ]);
        await expect(createSessionPackage(missing, sessionId)).rejects.toThrow(
            /material content is missing from the archive/u,
        );

        const deleted = await sourceArchive([
            makeSession(sessionId),
            record(RecordType.transcriptSegment, newUuid(), {
                session_id: sessionId,
                linked_asset_ids: assetId,
            }),
            record(RecordType.assetMetadata, assetId, { blob_id: blobId }),
            record(RecordType.assetBlob, blobId, { _deleted: "true" }),
        ]);
        await expect(createSessionPackage(deleted, sessionId)).rejects.toThrow(
            /material content is missing from the archive/u,
        );
    });

    it("includes session assets and self-referential blob manifests", async () => {
        const sessionId = newUuid();
        const assetId = newUuid();
        const manifestId = newUuid();
        const source = await sourceArchive([
            makeSession(sessionId),
            record(RecordType.assetMetadata, assetId, {
                session_id: sessionId,
                record_role: "material",
                blob_id: manifestId,
            }),
            record(RecordType.assetBlob, manifestId, {
                record_role: "asset-blob-manifest",
                chunk_ids: manifestId,
            }),
        ]);
        const packaged = await createSessionPackage(source, sessionId);
        expect(await packaged.getRecord(RecordType.assetMetadata, assetId)).not.toBeNull();
        expect(await packaged.getRecord(RecordType.assetBlob, manifestId)).not.toBeNull();
    });

    it("includes evidence edges that connect session evidence without a session id", async () => {
        const sessionId = newUuid();
        const fromId = newUuid();
        const toId = newUuid();
        const edgeId = newUuid();
        const source = await sourceArchive([
            makeSession(sessionId),
            record(RecordType.evidenceNode, fromId, { session_id: sessionId }),
            record(RecordType.evidenceNode, toId, { session_id: sessionId }),
            record(RecordType.evidenceEdge, edgeId, {
                from_id: fromId,
                to_id: toId,
            }),
        ]);
        const packaged = await createSessionPackage(source, sessionId);
        expect(await packaged.getRecord(RecordType.evidenceEdge, edgeId)).not.toBeNull();
    });

    it("includes guide journal entries and their notes documents", async () => {
        const sessionId = newUuid();
        const entryId = newUuid();
        const notesId = newUuid();
        const guideId = newUuid();
        const source = await sourceArchive([
            makeSession(sessionId),
            record(RecordType.guide, guideId, {
                session_id: sessionId,
                entry_id: entryId,
                section_count: "0",
            }),
            record(RecordType.settings, entryId, {
                record_role: "journal-entry",
                notes_document_id: notesId,
                session_ids: sessionId,
            }),
            record(RecordType.settings, notesId, {
                record_role: "journal-notes",
                entry_id: entryId,
                session_id: "",
            }),
        ]);
        const packaged = await createSessionPackage(source, sessionId);
        expect(await packaged.getRecord(RecordType.settings, entryId)).not.toBeNull();
        expect(await packaged.getRecord(RecordType.settings, notesId)).not.toBeNull();
    });

    it("rejects records whose revision history exceeds the package limit", async () => {
        const sessionId = newUuid();
        const transcriptId = newUuid();
        const session = makeSession(sessionId);
        const transcript = record(RecordType.transcriptSegment, transcriptId, {
            session_id: sessionId,
        });
        const history = Array.from({ length: 10_001 }, (_, index) => ({
            ...transcript,
            previousOffset: index === 0 ? 0n : 1n,
        }));
        const source = {
            getRecord: async (type: number, id: string) =>
                type === RecordType.session && id.toLowerCase() === sessionId ? session : null,
            listRecords: async (type: number) =>
                type === RecordType.transcriptSegment ? [transcript] : [],
            getRecordHistory: async (type: number) =>
                type === RecordType.transcriptSegment ? history : [session],
        } as unknown as ArchiveSnapshot;

        await expect(createSessionPackage(source, sessionId)).rejects.toThrow(
            /more than 10,000 revisions/u,
        );
    });
});

describe("session package import edge cases", () => {
    it("rejects packages with zero, multiple, or deleted sessions", async () => {
        const sessionId = newUuid();
        const empty = await packageWith([], sessionId);
        await expect(importSessionPackage(empty, await emptyArchive())).rejects.toThrow(
            /exactly one active session/u,
        );

        const secondId = newUuid();
        const multiple = await packageWith(
            [makeSession(sessionId), makeSession(secondId)],
            sessionId,
        );
        await expect(importSessionPackage(multiple, await emptyArchive())).rejects.toThrow(
            /exactly one active session/u,
        );

        const deleted = await packageWith(
            [makeSession(sessionId, { _deleted: "true" })],
            sessionId,
        );
        await expect(importSessionPackage(deleted, await emptyArchive())).rejects.toThrow(
            /exactly one active session/u,
        );
    });

    it("rejects a manifest that names a different session", async () => {
        const sessionId = newUuid();
        const packaged = await packageWith([makeSession(sessionId)], newUuid());
        await expect(importSessionPackage(packaged, await emptyArchive())).rejects.toThrow(
            /manifest does not match/u,
        );
    });

    it("rejects student profiles and unrelated settings inside packages", async () => {
        const sessionId = newUuid();
        const withStudent = await packageWith(
            [makeSession(sessionId), record(RecordType.student, newUuid())],
            sessionId,
        );
        await expect(importSessionPackage(withStudent, await emptyArchive())).rejects.toThrow(
            /cannot contain student profiles/u,
        );

        const withSettings = await packageWith(
            [
                makeSession(sessionId),
                record(RecordType.settings, newUuid(), { record_role: "preferences" }),
            ],
            sessionId,
        );
        await expect(importSessionPackage(withSettings, await emptyArchive())).rejects.toThrow(
            /cannot contain unrelated settings/u,
        );
    });

    it("creates a journal entry, notes, and root for a session without journal links", async () => {
        const sessionId = newUuid();
        const packaged = await createSessionPackage(
            await sourceArchive([makeSession(sessionId)]),
            sessionId,
        );
        const imported = await importSessionPackage(packaged, await emptyArchive("Destination"));

        const importedSession = imported.records.find(
            (item) => item.type === RecordType.session && item.id === imported.sessionId,
        )!;
        const settings = imported.records.filter((item) => item.type === RecordType.settings);
        const entry = settings.find((item) => item.fields.get("record_role") === "journal-entry")!;
        const notes = settings.filter((item) => item.fields.get("record_role") === "journal-notes");
        const root = settings.filter((item) => item.fields.get("record_role") === "journal");

        expect(entry).toBeDefined();
        expect(entry.fields.get("session_ids")).toBe(imported.sessionId);
        expect(importedSession.fields.get("entry_id")).toBe(entry.id);
        expect(notes.length).toBeGreaterThanOrEqual(2);
        expect(importedSession.fields.get("notes_document_id")).toBeTruthy();
        expect(root).toHaveLength(1);
        expect(importedSession.fields.get("student_id")).toBe("anonymous");
    });

    it("does not create a journal root when the destination already has a live one", async () => {
        const sessionId = newUuid();
        const packaged = await createSessionPackage(
            await sourceArchive([makeSession(sessionId)]),
            sessionId,
        );
        const destination = await appendRecords(await emptyArchive("With journal"), [
            record(RecordType.settings, newUuid(), {
                record_role: "journal",
                title: "Existing journal",
            }),
        ]);
        const imported = await importSessionPackage(packaged, destination);
        expect(
            imported.records.filter(
                (item) =>
                    item.type === RecordType.settings &&
                    item.fields.get("record_role") === "journal",
            ),
        ).toHaveLength(0);
    });

    it("treats a deleted journal root as missing", async () => {
        const sessionId = newUuid();
        const packaged = await createSessionPackage(
            await sourceArchive([makeSession(sessionId)]),
            sessionId,
        );
        const destination = await appendRecords(await emptyArchive("Deleted journal"), [
            record(RecordType.settings, newUuid(), {
                record_role: "journal",
                _deleted: "true",
            }),
        ]);
        const imported = await importSessionPackage(packaged, destination);
        expect(
            imported.records.filter(
                (item) =>
                    item.type === RecordType.settings &&
                    item.fields.get("record_role") === "journal",
            ),
        ).toHaveLength(1);
    });

    it("creates missing notes for an existing journal entry and session", async () => {
        const sessionId = newUuid();
        const entryId = newUuid();
        const notesId = newUuid();
        const sessionNotesId = newUuid();
        const packaged = await packageWith(
            [
                makeSession(sessionId, {
                    entry_id: entryId,
                    notes_document_id: sessionNotesId,
                }),
                record(RecordType.settings, entryId, {
                    record_role: "journal-entry",
                    session_ids: "",
                    notes_document_id: notesId,
                }),
                record(RecordType.settings, notesId, {
                    record_role: "journal-notes",
                    entry_id: entryId,
                    _deleted: "true",
                }),
                record(RecordType.settings, sessionNotesId, {
                    record_role: "journal-notes",
                    entry_id: entryId,
                    session_id: sessionId,
                    _deleted: "true",
                }),
            ],
            sessionId,
        );
        const imported = await importSessionPackage(packaged, await emptyArchive());
        const settings = imported.records.filter((item) => item.type === RecordType.settings);
        const entry = settings.find(
            (item) => item.fields.get("record_role") === "journal-entry" && item.id !== entryId,
        )!;
        const importedSession = imported.records.find(
            (item) => item.type === RecordType.session && item.id === imported.sessionId,
        )!;

        expect(entry).toBeDefined();
        expect(entry.fields.get("notes_document_id")).not.toBe(notesId);
        expect(importedSession.fields.get("notes_document_id")).not.toBe(sessionNotesId);
        expect(
            settings.filter((item) => item.fields.get("record_role") === "journal-notes").length,
        ).toBeGreaterThanOrEqual(2);
    });

    it("creates a missing journal entry when the referenced entry is absent", async () => {
        const sessionId = newUuid();
        const packaged = await packageWith(
            [makeSession(sessionId, { entry_id: newUuid() })],
            sessionId,
        );
        const imported = await importSessionPackage(packaged, await emptyArchive());
        const entry = imported.records.find(
            (item) =>
                item.type === RecordType.settings &&
                item.fields.get("record_role") === "journal-entry",
        );
        expect(entry).toBeDefined();
        expect(entry?.fields.get("session_ids")).toBe(imported.sessionId);
    });

    it("validates the requested destination student", async () => {
        const sessionId = newUuid();
        const sourceStudentId = newUuid();
        const source = await sourceArchive([
            record(RecordType.student, sourceStudentId),
            makeSession(sessionId, { student_id: sourceStudentId }),
        ]);
        const packaged = await createSessionPackage(source, sessionId);
        const destination = await emptyArchive("Destination");

        await expect(importSessionPackage(packaged, destination, "bad")).rejects.toThrow(
            /selected destination student ID is invalid/u,
        );
        await expect(importSessionPackage(packaged, destination, newUuid())).rejects.toThrow(
            /selected destination student does not exist/u,
        );

        const deletedStudent = newUuid();
        const withDeleted = await appendRecords(await emptyArchive("Deleted student"), [
            record(RecordType.student, deletedStudent, { _deleted: "true" }),
        ]);
        await expect(importSessionPackage(packaged, withDeleted, deletedStudent)).rejects.toThrow(
            /selected destination student does not exist/u,
        );
    });

    it("maps historical student references to the destination or anonymous", async () => {
        const sessionId = newUuid();
        const sourceStudentId = newUuid();
        const unknownStudentId = newUuid();
        const annotationId = newUuid();
        const source = await sourceArchive([
            record(RecordType.student, sourceStudentId),
            makeSession(sessionId, { student_id: sourceStudentId }),
            record(RecordType.annotation, annotationId, {
                session_id: sessionId,
                student_id: sourceStudentId,
                other_student_id: unknownStudentId,
            }),
        ]);
        const packaged = await createSessionPackage(source, sessionId);
        const imported = await importSessionPackage(packaged, await emptyArchive());
        const annotation = imported.records.find((item) => item.type === RecordType.annotation)!;
        expect(annotation.fields.get("student_id")).toBe("anonymous");
        expect(annotation.fields.get("other_student_id")).toBe(unknownStudentId);

        const destinationStudentId = newUuid();
        const destination = await appendRecords(await emptyArchive("Matched"), [
            record(RecordType.student, destinationStudentId),
        ]);
        const matched = await importSessionPackage(packaged, destination, destinationStudentId);
        const matchedAnnotation = matched.records.find(
            (item) => item.type === RecordType.annotation,
        )!;
        expect(matchedAnnotation.fields.get("student_id")).toBe(destinationStudentId);
    });

    it("remaps comma-separated references and keeps unknown identifiers", async () => {
        const sessionId = newUuid();
        const entryId = newUuid();
        const annotationId = newUuid();
        const unknownId = newUuid();
        const packaged = await packageWith(
            [
                makeSession(sessionId, { entry_id: entryId }),
                record(RecordType.settings, entryId, {
                    record_role: "journal-entry",
                    session_ids: sessionId,
                    linked_asset_ids: `${annotationId},${unknownId}`,
                }),
                record(RecordType.annotation, annotationId, {
                    session_id: sessionId,
                }),
            ],
            sessionId,
        );
        const imported = await importSessionPackage(packaged, await emptyArchive());
        const entry = imported.records.find(
            (item) =>
                item.type === RecordType.settings &&
                item.fields.get("record_role") === "journal-entry",
        )!;
        const annotation = imported.records.find((item) => item.type === RecordType.annotation)!;
        expect(entry.fields.get("linked_asset_ids")).toBe(`${annotation.id},${unknownId}`);
    });

    it("rejects reused UUIDs across types and conflicting student identifiers", async () => {
        const sessionId = newUuid();
        const reused = await packageWith(
            [
                makeSession(sessionId),
                record(RecordType.annotation, sessionId, { session_id: sessionId }),
            ],
            sessionId,
        );
        await expect(importSessionPackage(reused, await emptyArchive())).rejects.toThrow(
            /reuses a record UUID across different record types/u,
        );

        const annotationId = newUuid();
        const conflict = await packageWith(
            [
                makeSession(sessionId, { student_id: annotationId }),
                record(RecordType.annotation, annotationId, { session_id: sessionId }),
            ],
            sessionId,
        );
        await expect(importSessionPackage(conflict, await emptyArchive())).rejects.toThrow(
            /source student UUID conflicts with a session package record UUID/u,
        );
    });

    it("rejects colliding generated and destination identifiers", async () => {
        const sessionId = newUuid();
        const annotationId = newUuid();
        const sourceStudentId = newUuid();
        const packaged = await packageWith(
            [
                makeSession(sessionId, { student_id: sourceStudentId }),
                record(RecordType.annotation, annotationId, { session_id: sessionId }),
            ],
            sessionId,
        );
        const original = crypto.randomUUID.bind(crypto);

        vi.spyOn(crypto, "randomUUID").mockReturnValue(nextUuid());
        await expect(importSessionPackage(packaged, await emptyArchive())).rejects.toThrow(
            /Unable to assign unique imported record identifiers/u,
        );

        vi.restoreAllMocks();
        const destinationStudentId = nextUuid();
        const destination = await appendRecords(await emptyArchive("Collision"), [
            record(RecordType.student, destinationStudentId),
        ]);
        vi.spyOn(crypto, "randomUUID")
            .mockReturnValueOnce(destinationStudentId)
            .mockImplementation(() => original());
        await expect(
            importSessionPackage(packaged, destination, destinationStudentId),
        ).rejects.toThrow(/destination student UUID conflicts with an imported record UUID/u);
    });

    it("rejects records that belong to another session", async () => {
        const sessionId = newUuid();
        const packaged = await packageWith(
            [
                makeSession(sessionId),
                record(RecordType.annotation, newUuid(), {
                    session_id: newUuid(),
                }),
            ],
            sessionId,
        );
        await expect(importSessionPackage(packaged, await emptyArchive())).rejects.toThrow(
            /associated with another session/u,
        );
    });

    it("rejects assets that reference missing blobs", async () => {
        const sessionId = newUuid();
        const packaged = await packageWith(
            [
                makeSession(sessionId),
                record(RecordType.assetMetadata, newUuid(), {
                    record_role: "material",
                    blob_id: newUuid(),
                }),
            ],
            sessionId,
        );
        await expect(importSessionPackage(packaged, await emptyArchive())).rejects.toThrow(
            /references a missing content blob/u,
        );
    });

    it("rejects manifests with missing or empty chunk identifiers", async () => {
        const sessionId = newUuid();
        const missingChunk = await packageWith(
            [
                makeSession(sessionId),
                record(RecordType.assetBlob, newUuid(), {
                    record_role: "asset-blob-manifest",
                    chunk_ids: newUuid(),
                }),
            ],
            sessionId,
        );
        await expect(importSessionPackage(missingChunk, await emptyArchive())).rejects.toThrow(
            /asset manifest chunk points to a record that is not included/u,
        );

        const emptyChunk = await packageWith(
            [
                makeSession(sessionId),
                record(RecordType.assetBlob, newUuid(), {
                    record_role: "asset-blob-manifest",
                    chunk_ids: `${newUuid()},`,
                }),
            ],
            sessionId,
        );
        await expect(importSessionPackage(emptyChunk, await emptyArchive())).rejects.toThrow(
            /contains an empty identifier/u,
        );
    });

    it("rejects evidence nodes that refer to missing annotations", async () => {
        const sessionId = newUuid();
        const packaged = await packageWith(
            [
                makeSession(sessionId),
                record(RecordType.evidenceNode, newUuid(), {
                    session_id: sessionId,
                    source_annotation_id: newUuid(),
                }),
            ],
            sessionId,
        );
        await expect(importSessionPackage(packaged, await emptyArchive())).rejects.toThrow(
            /Evidence refers to an annotation that is not included/u,
        );
    });

    it("rejects evidence edges with a missing endpoint", async () => {
        const sessionId = newUuid();
        const nodeId = newUuid();
        const missingFrom = await packageWith(
            [
                makeSession(sessionId),
                record(RecordType.evidenceNode, nodeId, { session_id: sessionId }),
                record(RecordType.evidenceEdge, newUuid(), {
                    session_id: sessionId,
                    from_id: newUuid(),
                    to_id: nodeId,
                }),
            ],
            sessionId,
        );
        await expect(importSessionPackage(missingFrom, await emptyArchive())).rejects.toThrow(
            /evidence relationship points to a missing evidence node/u,
        );

        const missingTo = await packageWith(
            [
                makeSession(sessionId),
                record(RecordType.evidenceNode, nodeId, { session_id: sessionId }),
                record(RecordType.evidenceEdge, newUuid(), {
                    session_id: sessionId,
                    from_id: nodeId,
                    to_id: newUuid(),
                }),
            ],
            sessionId,
        );
        await expect(importSessionPackage(missingTo, await emptyArchive())).rejects.toThrow(
            /evidence relationship points to a missing evidence node/u,
        );
    });
});

describe("session package scope and student edge cases", () => {
    it("excludes evidence edges unrelated to the exported session", async () => {
        const sessionId = newUuid();
        const edgeId = newUuid();
        const source = await sourceArchive([
            makeSession(sessionId),
            record(RecordType.evidenceEdge, edgeId, {
                from_id: newUuid(),
                to_id: newUuid(),
            }),
        ]);
        const packaged = await createSessionPackage(source, sessionId);
        expect(await packaged.getRecord(RecordType.evidenceEdge, edgeId)).toBeNull();
    });

    it("treats an upper-case anonymous student as anonymous during import", async () => {
        const sessionId = newUuid();
        const packaged = await packageWith(
            [makeSession(sessionId, { student_id: "ANONYMOUS" })],
            sessionId,
        );
        const imported = await importSessionPackage(packaged, await emptyArchive());
        const session = imported.records.find(
            (item) => item.type === RecordType.session && item.id === imported.sessionId,
        );
        expect(session?.fields.get("student_id")).toBe("anonymous");
    });

    it("rejects a session journal entry with an unrelated settings role", async () => {
        const sessionId = newUuid();
        const entryId = newUuid();
        const source = await sourceArchive([
            makeSession(sessionId, { entry_id: entryId }),
            record(RecordType.settings, entryId, { record_role: "preferences" }),
        ]);
        await expect(createSessionPackage(source, sessionId)).rejects.toThrow(
            /cannot contain unrelated settings/u,
        );
    });

    it("keeps one identifier when a package lists a record twice", async () => {
        const sessionId = newUuid();
        const transcriptId = newUuid();
        const packaged = await packageWith(
            [
                makeSession(sessionId),
                record(RecordType.transcriptSegment, transcriptId, { session_id: sessionId }),
            ],
            sessionId,
        );
        const duplicated = new Proxy(packaged, {
            get(target, property, receiver) {
                if (property === "listRecords") {
                    return async (type: number, includeDeleted?: boolean) => {
                        const rows = await target.listRecords(type, includeDeleted);
                        return type === RecordType.transcriptSegment ? [...rows, ...rows] : rows;
                    };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        const imported = await importSessionPackage(duplicated, await emptyArchive());
        expect(
            imported.records.filter((item) => item.type === RecordType.transcriptSegment),
        ).toHaveLength(1);
    });
});
