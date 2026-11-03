import { describe, expect, it } from "vitest";
import {
    appendRecords,
    ArchiveSnapshot,
    createArchiveBytes,
    openArchiveBytes,
    openArchiveSource,
    type ArchiveSnapshot as Snapshot,
} from "../../../frontend/archive/archive";
import {
    createSanitizedCopy,
    hasSensitiveCredentialMaterial,
    previewSanitizedCopy,
    sensitiveSettingKey,
} from "../../../frontend/archive/sanitized-copy";
import {
    decodeRecordFrame,
    decodeRecordPayload,
    decodeStoredPayload,
    encodeRecordFrame,
    encodeRecordPayload,
    newUuid,
    RecordType,
    recordTypeName,
    type ArchiveRecord,
    type RecordTypeValue,
} from "../../../frontend/archive/format";
import { CompositeArchiveSource, MemoryArchiveSource } from "../../../frontend/archive/source";

function record(
    type: RecordTypeValue,
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

async function base(records: ArchiveRecord[] = []): Promise<Snapshot> {
    const empty = await openArchiveBytes(await createArchiveBytes("sanitized edges"));
    return records.length ? appendRecords(empty, records) : empty;
}

async function rewriteFields(
    snapshot: Snapshot,
    type: RecordTypeValue,
    id: string,
    updates: Record<string, string>,
): Promise<Snapshot> {
    return patchRecord(snapshot, type, id, (fields) => {
        for (const [name, value] of Object.entries(updates)) fields.set(name, value);
    });
}

async function renameField(
    snapshot: Snapshot,
    type: RecordTypeValue,
    id: string,
    from: string,
    to: string,
): Promise<Snapshot> {
    return patchRecord(snapshot, type, id, (fields) => {
        const value = fields.get(from) ?? "";
        fields.delete(from);
        fields.set(to, value);
    });
}

async function patchRecord(
    snapshot: Snapshot,
    type: RecordTypeValue,
    id: string,
    mutate: (fields: Map<string, string>) => void,
): Promise<Snapshot> {
    const key = `${recordTypeName(type).toUpperCase()}:${id.toLowerCase()}`;
    const offset = snapshot.allIndexEntries().get(key);
    if (offset === undefined) throw new Error(`missing index entry ${key}`);
    const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
    const frame = decodeRecordFrame(bytes.subarray(Number(offset)));
    const decoded = decodeRecordPayload(
        frame.type,
        frame.id,
        frame.revision,
        frame.previousOffset,
        decodeStoredPayload(frame),
    );
    const fields = new Map(decoded.fields);
    mutate(fields);
    const payload = encodeRecordPayload({ ...decoded, fields });
    const replacement = encodeRecordFrame(
        {
            type: frame.type,
            id: frame.id,
            revision: frame.revision,
            previousOffset: frame.previousOffset,
        },
        payload,
        frame.codec,
        frame.flags,
    );
    if (replacement.byteLength !== frame.endOffset) {
        throw new Error("rewritten frame length changed");
    }
    bytes.set(replacement, Number(offset));
    return openArchiveBytes(bytes);
}

function proxyWithoutRecord(snapshot: Snapshot, type: RecordTypeValue, id: string): Snapshot {
    const getRecord = snapshot.getRecord.bind(snapshot);
    return new Proxy(snapshot, {
        get(target, property) {
            if (property === "getRecord") {
                return (requestedType: RecordTypeValue, requestedId: string) =>
                    requestedType === type && requestedId.toLowerCase() === id.toLowerCase()
                        ? Promise.resolve(null)
                        : getRecord(requestedType, requestedId);
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

describe("sanitized copy selection validation", () => {
    it("rejects invalid selection identifiers", async () => {
        const snapshot = await base();
        await expect(
            previewSanitizedCopy(snapshot, { includeStudents: new Set(["not-a-uuid"]) }),
        ).rejects.toMatchObject({ code: "sanitized_copy_id_invalid" });
        await expect(
            previewSanitizedCopy(snapshot, { excludeStudents: new Set(["not-a-uuid"]) }),
        ).rejects.toMatchObject({ code: "sanitized_copy_id_invalid" });
        await expect(
            previewSanitizedCopy(snapshot, { includeSessions: new Set(["nope"]) }),
        ).rejects.toMatchObject({ code: "sanitized_copy_id_invalid" });
        await expect(
            previewSanitizedCopy(snapshot, { excludeSessions: new Set(["nope"]) }),
        ).rejects.toMatchObject({ code: "sanitized_copy_id_invalid" });
        await expect(
            previewSanitizedCopy(snapshot, { includeRecordingTracks: new Set(["nope"]) }),
        ).rejects.toMatchObject({ code: "sanitized_copy_id_invalid" });
        await expect(
            previewSanitizedCopy(snapshot, { excludeRecordingTracks: new Set(["nope"]) }),
        ).rejects.toMatchObject({ code: "sanitized_copy_id_invalid" });
    });

    it("rejects selections that reference missing students, sessions, or tracks", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "Mina" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
        ]);
        await expect(
            previewSanitizedCopy(snapshot, { excludeStudents: new Set([newUuid()]) }),
        ).rejects.toMatchObject({ code: "sanitized_copy_student_missing" });
        await expect(
            previewSanitizedCopy(snapshot, { includeSessions: new Set([newUuid()]) }),
        ).rejects.toMatchObject({ code: "sanitized_copy_session_missing" });
        await expect(
            previewSanitizedCopy(snapshot, { excludeSessions: new Set([newUuid()]) }),
        ).rejects.toMatchObject({ code: "sanitized_copy_session_missing" });
        await expect(
            previewSanitizedCopy(snapshot, {
                includeRecordings: true,
                includeRecordingTracks: new Set([newUuid()]),
            }),
        ).rejects.toMatchObject({ code: "sanitized_copy_recording_track_missing" });
        await expect(
            previewSanitizedCopy(snapshot, {
                includeRecordings: true,
                excludeRecordingTracks: new Set([newUuid()]),
            }),
        ).rejects.toMatchObject({ code: "sanitized_copy_recording_track_missing" });
    });

    it("requires a clean published tail and unlocked source", async () => {
        const snapshot = await base();
        const dirty = await openArchiveSource(
            new CompositeArchiveSource(
                snapshot.source,
                new MemoryArchiveSource(new Uint8Array([1, 2, 3])),
            ),
        );
        await expect(previewSanitizedCopy(dirty)).rejects.toMatchObject({
            code: "archive_recovery_required",
        });
    });
});

describe("sanitized copy selection rules", () => {
    it("skips deleted and unselected sessions and unretained students", async () => {
        const studentA = newUuid();
        const studentB = newUuid();
        const deletedSession = newUuid();
        const otherSession = newUuid();
        const unscopedSession = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentA, { display_name: "A" }),
            record(RecordType.student, studentB, { display_name: "B" }),
            record(RecordType.student, newUuid(), { _deleted: "true" }),
            record(RecordType.session, deletedSession, { _deleted: "true" }),
            record(RecordType.session, otherSession, { student_id: studentB }),
            record(RecordType.session, unscopedSession, { title: "No student" }),
        ]);

        const unselected = await previewSanitizedCopy(snapshot, {
            excludeSessions: new Set([otherSession]),
        });
        expect(unselected.sessions).toBe(1);

        const scoped = await previewSanitizedCopy(snapshot, {
            includeStudents: new Set([studentA]),
        });
        expect(scoped.sessions).toBe(0);
    });

    it("keeps a session whose student record is absent and anonymizes it", async () => {
        const missingStudent = newUuid();
        const sessionId = newUuid();
        const snapshot = await base([
            record(RecordType.session, sessionId, {
                student_id: missingStudent,
                title: "Orphan session",
            }),
        ]);
        const preview = await previewSanitizedCopy(snapshot);
        expect(preview.sessions).toBe(1);
        const copy = await createSanitizedCopy(snapshot, {}, preview);
        const session = await copy.snapshot.getRecord(RecordType.session, sessionId);
        expect(session?.fields.get("student_id")).toBe("anonymous");
    });

    it("validates audio chunk identities and retained recording tracks", async () => {
        const studentId = newUuid();
        const sessionA = newUuid();
        const sessionB = newUuid();
        const trackA = newUuid();
        const trackB = newUuid();
        const chunkA = newUuid();
        const chunkB = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "A" }),
            record(RecordType.session, sessionA, { student_id: studentId }),
            record(RecordType.session, sessionB, { student_id: studentId }),
            record(RecordType.audioChunk, chunkA, {
                session_id: sessionA,
                track_id: trackA,
                sequence_number: "0",
            }),
            record(RecordType.audioChunk, chunkB, {
                session_id: sessionB,
                track_id: trackB,
                sequence_number: "0",
            }),
            record(RecordType.waveformIndex, newUuid(), {
                session_id: sessionA,
                track_id: trackA,
            }),
            record(RecordType.waveformIndex, newUuid(), {
                session_id: sessionA,
                track_id: trackB,
            }),
            record(RecordType.waveformIndex, newUuid(), { session_id: sessionB }),
            record(RecordType.waveformIndex, newUuid(), { _deleted: "true" }),
        ]);

        const selected = await previewSanitizedCopy(snapshot, {
            includeRecordingTracks: new Set([trackA]),
        });
        expect(selected.recordings).toBe(1);
        expect(selected.recordingTracks).toBe(1);

        const all = await previewSanitizedCopy(snapshot, { includeRecordings: true });
        expect(all.recordings).toBe(2);

        const unscoped = await previewSanitizedCopy(snapshot);
        expect(unscoped.recordings).toBe(0);
        expect(unscoped.recordingTracks).toBe(0);
    });

    it("rejects audio chunks whose session or track identity is invalid", async () => {
        const sessionId = newUuid();
        const trackId = newUuid();
        const chunkId = newUuid();
        const snapshot = await base([
            record(RecordType.session, sessionId, {}),
            record(RecordType.audioChunk, chunkId, {
                session_id: sessionId,
                track_id: trackId,
                sequence_number: "0",
            }),
        ]);
        const brokenSession = await rewriteFields(snapshot, RecordType.audioChunk, chunkId, {
            session_id: "z".repeat(36),
        });
        await expect(
            previewSanitizedCopy(brokenSession, { includeRecordings: true }),
        ).rejects.toMatchObject({ code: "sanitized_copy_audio_chunk_invalid" });

        const missingTrack = await rewriteFields(snapshot, RecordType.audioChunk, chunkId, {
            track_id: "z".repeat(36),
        });
        await expect(
            previewSanitizedCopy(missingTrack, { includeRecordings: true }),
        ).rejects.toMatchObject({ code: "sanitized_copy_audio_chunk_invalid" });
    });
});

describe("sanitized copy guide and asset rules", () => {
    it("handles guide image and malformed source references", async () => {
        const sessionId = newUuid();
        const assetId = newUuid();
        const guideId = newUuid();
        const imageGuide = newUuid();
        const brokenGuide = newUuid();
        const inlineGuide = newUuid();
        const snapshot = await base([
            record(RecordType.session, sessionId, {}),
            record(RecordType.assetMetadata, assetId, {
                record_role: "material",
                session_id: sessionId,
            }),
            record(RecordType.guide, guideId, {
                session_id: sessionId,
                title: "Image",
                section_count: "1",
                "section.0.heading": "One",
                "section.0.block_count": "1",
                "section.0.block.0.kind": "image",
                "section.0.block.0.text": `![diagram](asset:${assetId})`,
            }),
            record(RecordType.guide, imageGuide, {
                session_id: sessionId,
                title: "Missing image",
                section_count: "1",
                "section.0.heading": "One",
                "section.0.block_count": "1",
                "section.0.block.0.kind": "figure",
                "section.0.block.0.text": `![diagram](asset:${newUuid()})`,
            }),
            record(RecordType.guide, brokenGuide, {
                title: "Broken",
                section_count: "not-a-number",
            }),
            record(RecordType.guide, inlineGuide, {
                title: "Inline",
                section_count: "1",
                "section.0.heading": "One",
                "section.0.block_count": "1",
                "section.0.block.0.kind": "paragraph",
                "section.0.block.0.text": "[[source:not-a-uuid]]",
            }),
        ]);

        const preview = await previewSanitizedCopy(snapshot);
        expect(preview.guides).toBe(1);
        const copy = await createSanitizedCopy(snapshot, {}, preview);
        const copied = await copy.snapshot.getRecord(RecordType.guide, guideId);
        expect(copied?.fields.get("section.0.block.0.text")).toContain("asset:");
    });

    it("skips scoped guides without retained scope and clears stale entry references", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const scopedGuide = newUuid();
        const entryGuide = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "A" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
            record(RecordType.guide, scopedGuide, {
                title: "Unscoped guide",
                section_count: "0",
            }),
            record(RecordType.guide, entryGuide, {
                session_id: sessionId,
                entry_id: newUuid(),
                title: "Entry guide",
                section_count: "0",
            }),
        ]);
        const scoped = await previewSanitizedCopy(snapshot, {
            includeStudents: new Set([studentId]),
        });
        expect(scoped.guides).toBe(1);

        const copy = await createSanitizedCopy(
            snapshot,
            { includeStudents: new Set([studentId]) },
            scoped,
        );
        const guide = await copy.snapshot.getRecord(RecordType.guide, entryGuide);
        expect(guide?.fields.get("entry_id")).toBe("");
        expect(await copy.snapshot.getRecord(RecordType.guide, scopedGuide)).toBeNull();
    });

    it("skips recording assets when recordings are not requested", async () => {
        const sessionId = newUuid();
        const trackId = newUuid();
        const otherTrack = newUuid();
        const audioAsset = newUuid();
        const takeAsset = newUuid();
        const noteAsset = newUuid();
        const snapshot = await base([
            record(RecordType.session, sessionId, {}),
            record(RecordType.audioChunk, newUuid(), {
                session_id: sessionId,
                track_id: trackId,
                sequence_number: "0",
            }),
            record(RecordType.assetMetadata, audioAsset, {
                record_role: "audio-track",
                session_id: sessionId,
                track_id: otherTrack,
            }),
            record(RecordType.assetMetadata, takeAsset, {
                record_role: "recording-take",
                session_id: sessionId,
                track_ids: otherTrack,
            }),
            record(RecordType.assetMetadata, noteAsset, {
                record_role: "audio-note",
                session_id: sessionId,
                track_id: otherTrack,
            }),
        ]);
        const none = await previewSanitizedCopy(snapshot);
        expect(none.recordings).toBe(0);
        expect(none.assets).toBe(0);

        const requested = await previewSanitizedCopy(snapshot, { includeRecordings: true });
        expect(requested.recordings).toBe(1);
        expect(requested.assets).toBe(0);
    });

    it("skips assets tied to unselected students or loose scoped records", async () => {
        const studentId = newUuid();
        const studentB = newUuid();
        const sessionId = newUuid();
        const studentAsset = newUuid();
        const looseAsset = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "A" }),
            record(RecordType.student, studentB, { display_name: "B" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
            record(RecordType.assetMetadata, studentAsset, {
                record_role: "material",
                session_id: sessionId,
                student_id: studentB,
            }),
            record(RecordType.assetMetadata, looseAsset, {
                record_role: "material",
            }),
        ]);
        const scoped = await previewSanitizedCopy(snapshot, {
            includeStudents: new Set([studentId]),
        });
        expect(scoped.assets).toBe(0);

        const unscoped = await previewSanitizedCopy(snapshot);
        expect(unscoped.assets).toBe(2);
    });

    it("skips evidence records with missing references", async () => {
        const studentId = newUuid();
        const studentB = newUuid();
        const sessionId = newUuid();
        const annotationId = newUuid();
        const transcriptId = newUuid();
        const assetId = newUuid();
        const nodeA = newUuid();
        const nodeB = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "A" }),
            record(RecordType.student, studentB, { display_name: "B" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
            record(RecordType.annotation, annotationId, { session_id: sessionId }),
            record(RecordType.transcriptSegment, transcriptId, { session_id: sessionId }),
            record(RecordType.assetMetadata, assetId, {
                record_role: "material",
                session_id: sessionId,
            }),
            record(RecordType.evidenceNode, nodeA, {
                session_id: sessionId,
                student_id: studentB,
            }),
            record(RecordType.evidenceNode, nodeB, {
                session_id: sessionId,
                source_annotation_id: newUuid(),
            }),
            record(RecordType.evidenceNode, newUuid(), {
                session_id: sessionId,
                source_segment_ids: newUuid(),
            }),
            record(RecordType.evidenceNode, newUuid(), {
                session_id: sessionId,
                source_asset_ids: newUuid(),
            }),
            record(RecordType.evidenceNode, newUuid(), {
                student_id: studentId,
            }),
            record(RecordType.evidenceNode, newUuid(), {}),
            record(RecordType.evidenceEdge, newUuid(), {
                session_id: sessionId,
                from_id: nodeA,
                to_id: nodeB,
            }),
        ]);
        const scoped = await previewSanitizedCopy(snapshot, {
            includeStudents: new Set([studentId]),
        });
        expect(scoped.evidenceItems).toBeGreaterThanOrEqual(1);
        const unscoped = await previewSanitizedCopy(snapshot);
        expect(unscoped.evidenceItems).toBeGreaterThan(scoped.evidenceItems);
    });

    it("skips scoped journal entries and notes that are out of scope", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const emptyEntry = newUuid();
        const otherEntry = newUuid();
        const notesId = newUuid();
        const inScopeNotes = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "A" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
            record(RecordType.settings, emptyEntry, {
                record_role: "journal-entry",
                session_ids: "",
            }),
            record(RecordType.settings, otherEntry, {
                record_role: "journal-entry",
                session_ids: newUuid(),
            }),
            record(RecordType.settings, notesId, {
                record_role: "journal-notes",
                session_id: newUuid(),
            }),
            record(RecordType.settings, inScopeNotes, {
                record_role: "journal-notes",
                session_id: sessionId,
            }),
        ]);
        const scoped = await previewSanitizedCopy(snapshot, {
            includeStudents: new Set([studentId]),
        });
        expect(scoped.sessions).toBe(1);
        const unscoped = await previewSanitizedCopy(snapshot);
        expect(unscoped.sessions).toBe(1);
        expect(unscoped.generationLogs).toBe(0);
    });

    it("clears journal entry note references that are not retained", async () => {
        const sessionId = newUuid();
        const entryId = newUuid();
        const snapshot = await base([
            record(RecordType.session, sessionId, {}),
            record(RecordType.settings, entryId, {
                record_role: "journal-entry",
                session_ids: sessionId,
                notes_document_id: newUuid(),
            }),
        ]);
        const preview = await previewSanitizedCopy(snapshot);
        const copy = await createSanitizedCopy(snapshot, {}, preview);
        const entry = await copy.snapshot.getRecord(RecordType.settings, entryId);
        expect(entry?.fields.get("notes_document_id")).toBe("");
    });
});

describe("sanitized copy credential policy", () => {
    it("classifies sensitive settings and credential records", async () => {
        expect(sensitiveSettingKey("api_key")).toBe(true);
        expect(sensitiveSettingKey("token")).toBe(true);
        expect(sensitiveSettingKey("token_budget")).toBe(false);
        expect(sensitiveSettingKey("some_other_setting")).toBe(false);
        expect(hasSensitiveCredentialMaterial(record(RecordType.student, newUuid(), {}))).toBe(
            false,
        );
        expect(
            hasSensitiveCredentialMaterial(
                record(RecordType.settings, newUuid(), { abcdefgh: "value" }),
            ),
        ).toBe(false);
    });

    it("rejects plaintext credentials and credential-looking settings", async () => {
        const credentialId = newUuid();
        const source = await base([
            record(RecordType.settings, credentialId, {
                record_role: "xxxxxxxxxx",
                key: "provider",
                value: "secret",
            }),
        ]);
        const credential = await rewriteFields(source, RecordType.settings, credentialId, {
            record_role: "credential",
        });
        await expect(
            previewSanitizedCopy(credential, { includeCredentials: true }),
        ).rejects.toMatchObject({ code: "sanitized_copy_plaintext_credential" });
        const withoutCredentials = await previewSanitizedCopy(credential);
        expect(withoutCredentials.credentials).toBe(0);

        const sensitiveId = newUuid();
        const sensitiveSource = await base([
            record(RecordType.settings, sensitiveId, {
                record_role: "provider-settings",
                abcdefgh: "value",
            }),
        ]);
        const sensitive = await renameField(
            sensitiveSource,
            RecordType.settings,
            sensitiveId,
            "abcdefgh",
            "password",
        );
        await expect(
            previewSanitizedCopy(sensitive, { includeCredentials: true }),
        ).rejects.toMatchObject({ code: "sanitized_copy_plaintext_credential" });
        expect((await previewSanitizedCopy(sensitive)).credentials).toBe(0);
    });
});

describe("sanitized copy asset blob validation", () => {
    async function assetWithBlob(
        blobFields: Record<string, string>,
        metadataBlobId: string,
        extra: ArchiveRecord[] = [],
    ): Promise<Snapshot> {
        return base([
            record(RecordType.assetBlob, metadataBlobId, blobFields),
            ...extra,
            record(RecordType.assetMetadata, newUuid(), {
                record_role: "material",
                blob_id: metadataBlobId,
            }),
        ]);
    }

    it("rejects invalid blob identifiers", async () => {
        const snapshot = await base([
            record(RecordType.assetMetadata, newUuid(), {
                record_role: "material",
                blob_id: "z".repeat(36),
            }),
        ]);
        await expect(previewSanitizedCopy(snapshot)).rejects.toMatchObject({
            code: "sanitized_copy_asset_blob_id_invalid",
        });
    });

    it("rejects missing and deleted blobs", async () => {
        const missing = await base([
            record(RecordType.assetMetadata, newUuid(), {
                record_role: "material",
                blob_id: newUuid(),
            }),
        ]);
        await expect(previewSanitizedCopy(missing)).rejects.toMatchObject({
            code: "sanitized_copy_asset_blob_missing",
        });

        const blobId = newUuid();
        const deleted = await assetWithBlob({ _deleted: "true" }, blobId);
        await expect(previewSanitizedCopy(deleted)).rejects.toMatchObject({
            code: "sanitized_copy_asset_blob_missing",
        });
    });

    it("rejects chunks used as direct asset blobs", async () => {
        const blobId = newUuid();
        const snapshot = await assetWithBlob(
            { record_role: "asset-blob-chunk", manifest_id: newUuid() },
            blobId,
        );
        await expect(previewSanitizedCopy(snapshot)).rejects.toMatchObject({
            code: "sanitized_copy_asset_blob_invalid",
        });
    });

    it("rejects manifests with invalid, missing, or mismatched chunks", async () => {
        const invalidManifestId = newUuid();
        const invalid = await assetWithBlob(
            { record_role: "asset-blob-manifest", chunk_ids: "bogus" },
            invalidManifestId,
        );
        await expect(previewSanitizedCopy(invalid)).rejects.toMatchObject({
            code: "sanitized_copy_asset_manifest_invalid",
        });

        const missingManifestId = newUuid();
        const missing = await assetWithBlob(
            { record_role: "asset-blob-manifest", chunk_ids: newUuid() },
            missingManifestId,
        );
        await expect(previewSanitizedCopy(missing)).rejects.toMatchObject({
            code: "sanitized_copy_asset_chunk_missing",
        });

        const manifestId = newUuid();
        const chunkId = newUuid();
        const mismatched = await base([
            record(RecordType.assetBlob, manifestId, {
                record_role: "asset-blob-manifest",
                chunk_ids: chunkId,
            }),
            record(RecordType.assetBlob, chunkId, {
                record_role: "asset-blob-chunk",
                manifest_id: newUuid(),
            }),
            record(RecordType.assetMetadata, newUuid(), {
                record_role: "material",
                blob_id: manifestId,
            }),
        ]);
        await expect(previewSanitizedCopy(mismatched)).rejects.toMatchObject({
            code: "sanitized_copy_asset_chunk_invalid",
        });
    });

    it("rejects a chunk shared by two selected manifests", async () => {
        const manifestA = newUuid();
        const manifestB = newUuid();
        const chunkId = newUuid();
        const snapshot = await base([
            record(RecordType.assetBlob, manifestA, {
                record_role: "asset-blob-manifest",
                chunk_ids: chunkId,
            }),
            record(RecordType.assetBlob, manifestB, {
                record_role: "asset-blob-manifest",
                chunk_ids: chunkId,
            }),
            record(RecordType.assetBlob, chunkId, {
                record_role: "asset-blob-chunk",
                manifest_id: manifestA,
            }),
            record(RecordType.assetMetadata, newUuid(), {
                record_role: "material",
                blob_id: manifestA,
            }),
            record(RecordType.assetMetadata, newUuid(), {
                record_role: "material",
                blob_id: manifestB,
            }),
        ]);
        await expect(previewSanitizedCopy(snapshot)).rejects.toMatchObject({
            code: "sanitized_copy_asset_chunk_shared",
        });
    });
});

describe("sanitized copy branch edges", () => {
    it("includes annotations with non-private markers and skips inactive records", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const missingSession = newUuid();
        const annotationId = newUuid();
        const transcriptId = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "A" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
            record(RecordType.annotation, annotationId, {
                session_id: sessionId,
                private: "false",
            }),
            record(RecordType.annotation, newUuid(), {
                session_id: sessionId,
                _deleted: "true",
            }),
            record(RecordType.annotation, newUuid(), {
                session_id: missingSession,
            }),
            record(RecordType.transcriptSegment, transcriptId, {
                session_id: sessionId,
                linked_asset_ids: "not-a-uuid",
            }),
            record(RecordType.transcriptSegment, newUuid(), {
                session_id: sessionId,
                _deleted: "true",
            }),
            record(RecordType.transcriptSegment, newUuid(), {
                session_id: missingSession,
            }),
        ]);
        const preview = await previewSanitizedCopy(snapshot, {
            includeStudents: new Set([studentId]),
        });
        expect(preview.annotations).toBe(1);
        const copy = await createSanitizedCopy(
            snapshot,
            { includeStudents: new Set([studentId]) },
            preview,
        );
        const transcript = await copy.snapshot.getRecord(
            RecordType.transcriptSegment,
            transcriptId,
        );
        expect(transcript?.fields.get("linked_asset_ids")).toBe("");
    });

    it("ignores invalid journal attachment identifiers", async () => {
        const sessionId = newUuid();
        const entryId = newUuid();
        const snapshot = await base([
            record(RecordType.session, sessionId, {}),
            record(RecordType.settings, entryId, {
                record_role: "journal-entry",
                session_ids: sessionId,
                attachment_ids: "not-a-uuid",
            }),
        ]);
        const preview = await previewSanitizedCopy(snapshot);
        expect(preview.sessions).toBe(1);
        const copy = await createSanitizedCopy(snapshot, {}, preview);
        const entry = await copy.snapshot.getRecord(RecordType.settings, entryId);
        expect(entry?.fields.get("attachment_ids")).toBe("");
    });

    it("evaluates guide scope, inactive, and image edge cases", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const noSessionGuide = newUuid();
        const entryOnlyGuide = newUuid();
        const deadSessionGuide = newUuid();
        const deletedGuide = newUuid();
        const badSourceGuide = newUuid();
        const badImageGuide = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "A" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
            record(RecordType.guide, noSessionGuide, {
                title: "No scope",
                section_count: "0",
            }),
            record(RecordType.guide, entryOnlyGuide, {
                entry_id: newUuid(),
                title: "Entry only",
                section_count: "0",
            }),
            record(RecordType.guide, deadSessionGuide, {
                session_id: newUuid(),
                title: "Missing session",
                section_count: "0",
            }),
            record(RecordType.guide, deletedGuide, {
                title: "Deleted",
                section_count: "0",
                _deleted: "true",
            }),
            record(RecordType.guide, badSourceGuide, {
                title: "Bad source",
                section_count: "1",
                "section.0.heading": "One",
                "section.0.block_count": "1",
                "section.0.block.0.kind": "paragraph",
                "section.0.block.0.text": "No inline references.",
                "section.0.block.0.source_ids": "not-a-uuid",
            }),
            record(RecordType.guide, badImageGuide, {
                title: "Bad image",
                section_count: "1",
                "section.0.heading": "One",
                "section.0.block_count": "1",
                "section.0.block.0.kind": "image",
                "section.0.block.0.text": "not an image reference",
            }),
        ]);
        const unscoped = await previewSanitizedCopy(snapshot);
        expect(unscoped.guides).toBe(2);
        const scoped = await previewSanitizedCopy(snapshot, {
            includeStudents: new Set([studentId]),
        });
        expect(scoped.guides).toBe(0);
    });

    it("handles recording assets with missing identities and retained tracks", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const trackA = newUuid();
        const trackB = newUuid();
        const missingSession = newUuid();
        const noteAsset = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "A" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
            record(RecordType.audioChunk, newUuid(), {
                session_id: sessionId,
                track_id: trackA,
                sequence_number: "0",
            }),
            record(RecordType.audioChunk, newUuid(), {
                session_id: sessionId,
                track_id: trackB,
                sequence_number: "0",
                _deleted: "true",
            }),
            record(RecordType.audioChunk, newUuid(), {
                session_id: missingSession,
                track_id: trackA,
                sequence_number: "0",
            }),
            record(RecordType.assetMetadata, newUuid(), {
                record_role: "audio-track",
                track_id: trackA,
            }),
            record(RecordType.assetMetadata, newUuid(), {
                record_role: "recording-take",
                track_ids: trackA,
            }),
            record(RecordType.assetMetadata, noteAsset, {
                record_role: "audio-note",
                session_id: sessionId,
                track_id: trackA,
            }),
        ]);
        const preview = await previewSanitizedCopy(snapshot, { includeRecordings: true });
        expect(preview.recordings).toBe(1);
        for (const asset of await (
            await createSanitizedCopy(snapshot, { includeRecordings: true }, preview)
        ).snapshot.listRecords(RecordType.assetMetadata)) {
            expect(asset.fields.get("record_role")).not.toBe("audio-track");
        }
    });

    it("purges inactive evidence, settings, and waveform records during selection", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const trackId = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "A" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
            record(RecordType.audioChunk, newUuid(), {
                session_id: sessionId,
                track_id: trackId,
                sequence_number: "0",
            }),
            record(RecordType.evidenceNode, newUuid(), {
                session_id: sessionId,
                _deleted: "true",
            }),
            record(RecordType.evidenceNode, newUuid(), { session_id: newUuid() }),
            record(RecordType.settings, newUuid(), {
                record_role: "other",
                _deleted: "true",
            }),
            record(RecordType.waveformIndex, newUuid(), {}),
        ]);
        const preview = await previewSanitizedCopy(snapshot, {
            includeStudents: new Set([studentId]),
            includeRecordingTracks: new Set([trackId]),
        });
        expect(preview.sessions).toBe(1);
    });

    it("skips referenced blobs that are not manifests", async () => {
        const blobId = newUuid();
        const snapshot = await base([
            record(RecordType.assetBlob, blobId, { record_role: "asset-blob-other" }),
            record(RecordType.assetMetadata, newUuid(), {
                record_role: "material",
                blob_id: blobId,
            }),
        ]);
        await expect(previewSanitizedCopy(snapshot)).resolves.toMatchObject({ assets: 1 });
    });

    it("rewrites session recording fields when only some tracks are retained", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const trackA = newUuid();
        const trackB = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "A" }),
            record(RecordType.session, sessionId, {
                student_id: studentId,
                entry_id: newUuid(),
                recording_track_ids: `${trackA},${trackB}`,
                recording_track_id: trackB,
                audio_import_track_id: trackA,
                recording_device_id: "device",
            }),
            record(RecordType.audioChunk, newUuid(), {
                session_id: sessionId,
                track_id: trackA,
                sequence_number: "0",
            }),
            record(RecordType.audioChunk, newUuid(), {
                session_id: sessionId,
                track_id: trackB,
                sequence_number: "0",
            }),
        ]);
        const options = { includeRecordingTracks: new Set([trackA]) };
        const preview = await previewSanitizedCopy(snapshot, options);
        const copy = await createSanitizedCopy(snapshot, options, preview);
        const session = await copy.snapshot.getRecord(RecordType.session, sessionId);
        expect(session?.fields.get("recording_track_id")).toBe("");
        expect(session?.fields.get("audio_import_track_id")).toBe(trackA);
        expect(session?.fields.get("entry_id")).toBe("");

        const allOptions = { includeRecordings: true };
        const allPreview = await previewSanitizedCopy(snapshot, allOptions);
        const allCopy = await createSanitizedCopy(snapshot, allOptions, allPreview);
        const allSession = await allCopy.snapshot.getRecord(RecordType.session, sessionId);
        expect(allSession?.fields.get("recording_track_count")).toBe("2");
    });

    it("flushes batches after 32 records", async () => {
        const students = Array.from({ length: 33 }, () => ({
            id: newUuid(),
        }));
        const snapshot = await base(
            students.map(({ id }) => record(RecordType.student, id, { display_name: id })),
        );
        const preview = await previewSanitizedCopy(snapshot);
        expect(preview.students).toBe(33);
        const copy = await createSanitizedCopy(snapshot, {}, preview);
        expect(await copy.snapshot.listRecords(RecordType.student)).toHaveLength(33);
    });
});

describe("sanitized copy generation and persistence", () => {
    function studentRecord(id: string): ArchiveRecord {
        return record(RecordType.student, id, { display_name: "Mina" });
    }

    it("rejects a preview from a different source generation", async () => {
        const studentId = newUuid();
        const snapshot = await base([studentRecord(studentId)]);
        const preview = await previewSanitizedCopy(snapshot, {
            includeStudents: new Set([studentId]),
        });
        const changed = await appendRecords(snapshot, [studentRecord(newUuid())]);
        await expect(
            createSanitizedCopy(changed, { includeStudents: new Set([studentId]) }, preview),
        ).rejects.toMatchObject({ code: "sanitized_copy_source_changed" });
    });

    it("rejects a record that disappears after preview", async () => {
        const studentId = newUuid();
        const snapshot = await base([studentRecord(studentId)]);
        const options = { includeStudents: new Set([studentId]) };
        const preview = await previewSanitizedCopy(snapshot, options);
        await expect(
            createSanitizedCopy(
                proxyWithoutRecord(snapshot, RecordType.student, studentId),
                options,
                preview,
            ),
        ).rejects.toMatchObject({ code: "sanitized_copy_record_missing" });
    });

    it("accepts checkpoints that preserve the generated archive", async () => {
        const studentId = newUuid();
        const snapshot = await base([studentRecord(studentId)]);
        const options = { includeStudents: new Set([studentId]) };
        const preview = await previewSanitizedCopy(snapshot, options);
        const sizes: bigint[] = [];
        const result = await createSanitizedCopy(snapshot, options, preview, {
            checkpoint: async (next, previousSize) => {
                sizes.push(previousSize);
                return next;
            },
        });
        expect(sizes.length).toBeGreaterThan(0);
        expect(result.summary.students).toBe(1);
    });

    it("rejects a checkpoint that changes the generated archive", async () => {
        const studentId = newUuid();
        const snapshot = await base([studentRecord(studentId)]);
        const options = { includeStudents: new Set([studentId]) };
        const preview = await previewSanitizedCopy(snapshot, options);
        await expect(
            createSanitizedCopy(snapshot, options, preview, {
                checkpoint: async (next) =>
                    ({
                        source: { size: next.source.size + 1n, close: async () => undefined },
                        commit: next.commit,
                        header: next.header,
                        lock: () => undefined,
                    }) as unknown as Snapshot,
            }),
        ).rejects.toMatchObject({ code: "sanitized_copy_checkpoint_invalid" });
    });

    it("closes replaced snapshots and reports checkpoint failures", async () => {
        const studentId = newUuid();
        const snapshot = await base([studentRecord(studentId)]);
        const options = { includeStudents: new Set([studentId]) };
        const preview = await previewSanitizedCopy(snapshot, options);
        let calls = 0;
        let closes = 0;
        await expect(
            createSanitizedCopy(snapshot, options, preview, {
                checkpoint: async (next) => {
                    calls += 1;
                    if (calls > 1) throw new Error("checkpoint failed");
                    const failingSource = {
                        size: next.source.size,
                        read: (offset: bigint, length: number) => next.source.read(offset, length),
                        close: async () => {
                            closes += 1;
                            if (closes > 1) throw new Error("close failed");
                        },
                    };
                    return new ArchiveSnapshot(
                        failingSource,
                        next.header,
                        next.commit,
                        next.allIndexEntries(),
                        next.publishedEndOffset,
                    );
                },
            }),
        ).rejects.toThrowError("checkpoint failed");
    });
});
