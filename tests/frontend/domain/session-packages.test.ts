import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
    verifyArchiveSnapshot,
} from "../../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    createSessionPackage,
    importSessionPackage,
} from "../../../frontend/domain/session-packages";

describe("portable session packages", () => {
    it("exports linked records without student profile data and imports with fresh references", async () => {
        const fixture = await createFixture();
        const packaged = await createSessionPackage(fixture.source, fixture.sessionId);
        const packageManifest = await packaged.getRecord(RecordType.settings, packaged.header.id);
        const packageSession = await packaged.getRecord(RecordType.session, fixture.sessionId);

        expect(packageManifest?.fields.get("record_role")).toBe("tutorux-session-package");
        expect(packageManifest?.fields.get("source_session_id")).toBe(fixture.sessionId);
        expect(packageManifest?.fields.get("source_student_id")).toBe(fixture.studentId);
        expect(packageSession?.fields.get("student_id")).toBe("anonymous");
        expect(await packaged.listRecords(RecordType.student, true)).toEqual([]);
        expect(await verifyArchiveSnapshot(packaged)).toMatchObject({
            currentRecords: expect.any(Number),
        });

        const destinationStudentId = newUuid();
        const destinationBase = await openArchiveBytes(
            await createArchiveBytes("Destination workspace"),
        );
        const destination = await appendRecords(destinationBase, [
            record(RecordType.student, destinationStudentId, { display_name: "Learner" }),
        ]);
        const imported = await importSessionPackage(packaged, destination, destinationStudentId);
        const importedSnapshot = await appendRecords(destination, imported.records);
        const importedSession = await importedSnapshot.getRecord(
            RecordType.session,
            imported.sessionId,
        );
        const importedTrackId = importedSession?.fields.get("recording_track_id");
        const importedTrack = importedTrackId
            ? await importedSnapshot.getRecord(RecordType.assetMetadata, importedTrackId)
            : null;
        const importedTranscript = (
            await importedSnapshot.listRecords(RecordType.transcriptSegment)
        )[0];
        const importedAssetId = importedTranscript?.fields.get("linked_asset_ids");
        const importedAsset = importedAssetId
            ? await importedSnapshot.getRecord(RecordType.assetMetadata, importedAssetId)
            : null;
        const importedManifestId = importedAsset?.fields.get("blob_id");
        const importedManifest = importedManifestId
            ? await importedSnapshot.getRecord(RecordType.assetBlob, importedManifestId)
            : null;
        const importedEntryId = importedSession?.fields.get("entry_id");
        const importedEntry = importedEntryId
            ? await importedSnapshot.getRecord(RecordType.settings, importedEntryId)
            : null;

        expect(imported.sessionId).not.toBe(fixture.sessionId);
        expect(importedSession?.fields.get("student_id")).toBe(destinationStudentId);
        expect(importedTrackId).not.toBe(fixture.trackId);
        expect(importedTrack?.fields.get("recording_take_id")).not.toBe(fixture.takeId);
        expect(importedTrack?.fields.get("session_id")).toBe(imported.sessionId);
        expect(importedAssetId).not.toBe(fixture.assetId);
        expect(importedAsset?.fields.get("session_id")).toBe(imported.sessionId);
        expect(importedManifest?.fields.get("chunk_ids")).not.toContain(fixture.chunkId);
        expect(importedEntry?.fields.get("session_ids")).toBe(imported.sessionId);
        expect(importedEntry?.fields.get("record_role")).toBe("journal-entry");
        expect(
            await importedSnapshot.getRecord(RecordType.student, fixture.sourceStudentId),
        ).toBeNull();
        expect(await verifyArchiveSnapshot(importedSnapshot)).toMatchObject({
            currentRecords: expect.any(Number),
        });
    });

    it("rejects ordinary archives and packages with missing linked records", async () => {
        const fixture = await createFixture();
        const ordinary = await openArchiveBytes(await createArchiveBytes("Ordinary archive"));
        await expect(importSessionPackage(ordinary, fixture.source)).rejects.toThrow(
            /not a supported Tutorux session transfer package/u,
        );

        const packageArchive = await createSessionPackage(fixture.source, fixture.sessionId);
        const packageSession = await packageArchive.getRecord(
            RecordType.session,
            fixture.sessionId,
        );
        expect(packageSession).not.toBeNull();

        const badPackageBase = await openArchiveBytes(
            await createArchiveBytes("Malformed session transfer"),
        );
        const badManifest = await badPackageBase.getRecord(
            RecordType.settings,
            badPackageBase.header.id,
        );
        expect(badManifest).not.toBeNull();
        const badFields = new Map(badManifest!.fields);
        badFields.set("record_role", "tutorux-session-package");
        badFields.set("package_version", "1");
        badFields.set("source_session_id", fixture.sessionId);
        const missingAssetId = newUuid();
        const malformed = await appendRecords(badPackageBase, [
            { ...badManifest!, fields: badFields },
            { ...packageSession!, fields: new Map(packageSession!.fields) },
            record(RecordType.transcriptSegment, newUuid(), {
                session_id: fixture.sessionId,
                linked_asset_ids: missingAssetId,
            }),
        ]);
        await expect(importSessionPackage(malformed, fixture.source)).rejects.toThrow(
            /missing|not included/u,
        );
    });

    it("includes material blobs referenced by earlier transcript revisions", async () => {
        const fixture = await createFixture();
        const transcript = await fixture.source.getRecord(
            RecordType.transcriptSegment,
            fixture.transcriptId,
        );
        expect(transcript).not.toBeNull();
        const fields = new Map(transcript!.fields);
        fields.set("linked_asset_ids", "");
        const revised = await appendRecords(fixture.source, [{ ...transcript!, fields }]);

        const packaged = await createSessionPackage(revised, fixture.sessionId);
        expect(await packaged.getRecord(RecordType.assetMetadata, fixture.assetId)).not.toBeNull();
        expect(await packaged.getRecord(RecordType.assetBlob, fixture.chunkId)).not.toBeNull();
    });

    it("matches an existing destination profile when the source learner UUID is present", async () => {
        const fixture = await createFixture();
        const packaged = await createSessionPackage(fixture.source, fixture.sessionId);
        const destinationBase = await openArchiveBytes(
            await createArchiveBytes("Matched destination workspace"),
        );
        const destination = await appendRecords(destinationBase, [
            record(RecordType.student, fixture.sourceStudentId, {
                display_name: "Matched learner",
            }),
        ]);

        const imported = await importSessionPackage(packaged, destination);
        const importedSession = imported.records.find(
            (item) => item.type === RecordType.session && item.id === imported.sessionId,
        );
        expect(importedSession?.fields.get("student_id")).toBe(fixture.sourceStudentId);
    });
});

async function createFixture(): Promise<{
    source: Awaited<ReturnType<typeof openArchiveBytes>>;
    studentId: string;
    sourceStudentId: string;
    sessionId: string;
    takeId: string;
    trackId: string;
    chunkId: string;
    assetId: string;
    transcriptId: string;
}> {
    const sourceStudentId = newUuid();
    const sessionId = newUuid();
    const entryId = newUuid();
    const entryNotesId = newUuid();
    const sessionNotesId = newUuid();
    const takeId = newUuid();
    const trackId = newUuid();
    const audioChunkId = newUuid();
    const assetId = newUuid();
    const blobId = newUuid();
    const chunkId = newUuid();
    const transcriptId = newUuid();
    const evidenceId = newUuid();
    const evidenceOtherId = newUuid();
    const edgeId = newUuid();
    const pcm = new Uint8Array([0x34, 0x12, 0xcc, 0xed]);
    const content = new Uint8Array([0x61, 0x72, 0x63, 0x68, 0x69, 0x76, 0x65]);
    const contentDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
    const contentHash = Array.from(contentDigest, (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
    const initial = await openArchiveBytes(await createArchiveBytes("Source workspace"));
    const source = await appendRecords(initial, [
        record(RecordType.student, sourceStudentId, { display_name: "Private learner name" }),
        record(RecordType.session, sessionId, {
            student_id: sourceStudentId,
            entry_id: entryId,
            notes_document_id: sessionNotesId,
            title: "Reading practice",
            session_type: "record-audio",
            session_state: "completed",
            recording_track_id: trackId,
            recording_track_ids: trackId,
            recording_track_count: "1",
        }),
        record(RecordType.settings, entryId, {
            record_role: "journal-entry",
            title: "Reading practice",
            entry_date: "2026-10-28",
            notes_document_id: entryNotesId,
            session_ids: sessionId,
            study_guide_ids: "",
            attachment_ids: "",
        }),
        record(RecordType.settings, entryNotesId, {
            record_role: "journal-notes",
            entry_id: entryId,
            session_id: "",
            block_count: "0",
        }),
        record(RecordType.settings, sessionNotesId, {
            record_role: "journal-notes",
            entry_id: entryId,
            session_id: sessionId,
            block_count: "1",
            "block.0.id": newUuid(),
            "block.0.kind": "paragraph",
            "block.0.text": "Read a short story together.",
        }),
        record(RecordType.assetMetadata, takeId, {
            record_role: "recording-take",
            session_id: sessionId,
            track_ids: trackId,
            label: "Microphone take",
        }),
        record(RecordType.assetMetadata, trackId, {
            record_role: "audio-track",
            session_id: sessionId,
            track_id: trackId,
            recording_take_id: takeId,
            label: "Microphone",
        }),
        {
            ...record(RecordType.audioChunk, audioChunkId, {
                session_id: sessionId,
                track_id: trackId,
                sequence_number: "0",
                sample_count: "2",
                sample_rate_hz: "8000",
                channel_count: "1",
                sample_format: "pcm_s16le",
                codec: "none",
            }),
            blob: pcm,
        },
        record(RecordType.assetBlob, blobId, {
            record_role: "asset-blob-manifest",
            content_hash: contentHash,
            byte_size: String(content.byteLength),
            chunk_count: "1",
            chunk_ids: chunkId,
        }),
        {
            ...record(RecordType.assetBlob, chunkId, {
                record_role: "asset-blob-chunk",
                manifest_id: blobId,
                chunk_index: "0",
                byte_size: String(content.byteLength),
            }),
            blob: content,
        },
        record(RecordType.assetMetadata, assetId, {
            filename: "story.txt",
            mime_type: "text/plain",
            byte_size: String(content.byteLength),
            content_hash: contentHash,
            blob_id: blobId,
            session_id: "",
        }),
        record(RecordType.transcriptSegment, transcriptId, {
            session_id: sessionId,
            linked_asset_ids: assetId,
            text: "Read together.",
        }),
        record(RecordType.evidenceNode, evidenceId, {
            session_id: sessionId,
            source_segment_ids: transcriptId,
            source_asset_ids: assetId,
            title: "Uses story details",
        }),
        record(RecordType.evidenceNode, evidenceOtherId, {
            session_id: sessionId,
            title: "Explains a character choice",
        }),
        record(RecordType.evidenceEdge, edgeId, {
            session_id: sessionId,
            from_id: evidenceId,
            to_id: evidenceOtherId,
            relation: "supports",
        }),
    ]);
    return {
        source,
        studentId: sourceStudentId,
        sourceStudentId,
        sessionId,
        takeId,
        trackId,
        chunkId,
        assetId,
        transcriptId,
    };
}

function record(type: number, id: string, values: Record<string, string>): ArchiveRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(values)),
        blob: new Uint8Array(),
    };
}
