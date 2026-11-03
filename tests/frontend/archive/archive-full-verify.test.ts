import { describe, expect, it } from "vitest";
import {
    appendRecords,
    ArchiveSnapshot,
    createArchiveBytes,
    openArchiveBytes,
    verifyArchiveFull,
    type ArchiveSnapshot as Snapshot,
} from "../../../frontend/archive/archive";
import {
    compressRecordPayload,
    decodeRecordFrame,
    decodeRecordPayload,
    decodeStoredPayload,
    encodeRecordFrame,
    encodeRecordPayload,
    newUuid,
    RecordType,
    recordTypeName,
    type ArchiveRecord,
} from "../../../frontend/archive/format";

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

async function base(records: ArchiveRecord[] = []): Promise<Snapshot> {
    const empty = await openArchiveBytes(await createArchiveBytes("full verify"));
    return records.length ? appendRecords(empty, records) : empty;
}

async function patchRecord(
    snapshot: Snapshot,
    type: number,
    id: string,
    mutate: (fields: Map<string, string>) => void,
): Promise<Snapshot> {
    const key = `${recordTypeName(type).toUpperCase()}:${id.toLowerCase()}`;
    const offset = snapshot.allIndexEntries().get(key);
    if (offset === undefined) throw new Error(`missing ${key}`);
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
    const encoded =
        frame.codec === 1 ? compressRecordPayload(payload) : { codec: 0 as const, bytes: payload };
    const replacement = encodeRecordFrame(
        {
            type: frame.type,
            id: frame.id,
            revision: frame.revision,
            previousOffset: frame.previousOffset,
        },
        encoded.bytes,
        encoded.codec,
        frame.flags,
    );
    if (replacement.byteLength !== frame.endOffset) throw new Error("frame length changed");
    bytes.set(replacement, Number(offset));
    return openArchiveBytes(bytes);
}

describe("guide semantics verification", () => {
    it("reports strict structure and reference problems", async () => {
        const snapshot = await base([
            record(RecordType.guide, newUuid(), {
                approval_state: "nonsense",
                section_count: "1",
                "section.0.block_count": "2",
                "section.0.block.0.kind": "image",
                "section.0.block.0.text": "not an image",
                "section.0.block.1.kind": "",
                "section.0.block.1.text": "[[source:zzz]]",
                "section.0.block.1.source_ids": "bad,also-bad",
            }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        expect(report.valid).toBe(false);
        const issues = report.issues.join("\n");
        expect(issues).toContain("title is required");
        expect(issues).toContain("scope is required");
        expect(issues).toContain("approval state is invalid");
        expect(issues).toContain("needs a heading");
        expect(issues).toContain("invalid image reference");
        expect(issues).toContain("kind is required");
        expect(issues).toContain("invalid inline source reference");
        expect(issues).toContain("invalid source identifier");
    });

    it("reports invalid guide counts", async () => {
        const badSection = newUuid();
        const hugeSection = newUuid();
        const badBlock = newUuid();
        const hugeBlock = newUuid();
        const snapshot = await base([
            record(RecordType.guide, badSection, { section_count: "abc" }),
            record(RecordType.guide, hugeSection, { section_count: "10001" }),
            record(RecordType.guide, badBlock, {
                section_count: "1",
                "section.0.block_count": "abc",
            }),
            record(RecordType.guide, hugeBlock, {
                section_count: "1",
                "section.0.block_count": "10001",
            }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        const issues = report.issues.join("\n");
        expect(issues).toContain("guide section count is invalid");
        expect(issues).toContain("guide block count is invalid");
    });

    it("resolves guide scope through entries, sessions, students, and sources", async () => {
        const entryId = newUuid();
        const sessionId = newUuid();
        const studentId = newUuid();
        const annotationId = newUuid();
        const transcriptId = newUuid();
        const evidenceId = newUuid();
        const assetId = newUuid();
        const notesId = newUuid();
        const guideId = newUuid();
        const unresolved = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "Mina" }),
            record(RecordType.session, sessionId, {
                student_id: studentId,
                entry_id: entryId,
            }),
            record(RecordType.settings, entryId, {
                record_role: "journal-entry",
                session_ids: sessionId,
            }),
            record(RecordType.settings, notesId, {
                record_role: "journal-notes",
                entry_id: entryId,
                session_id: sessionId,
            }),
            record(RecordType.annotation, annotationId, { session_id: sessionId }),
            record(RecordType.transcriptSegment, transcriptId, { session_id: sessionId }),
            record(RecordType.evidenceNode, evidenceId, { session_id: sessionId }),
            record(RecordType.assetMetadata, assetId, {
                record_role: "material",
                session_id: sessionId,
            }),
            record(RecordType.guide, guideId, {
                title: "Complete guide",
                entry_id: entryId,
                session_id: sessionId,
                approval_state: "approved",
                section_count: "1",
                "section.0.heading": "Evidence",
                "section.0.block_count": "5",
                "section.0.block.0.kind": "paragraph",
                "section.0.block.0.text": "Session",
                "section.0.block.0.source_ids": sessionId,
                "section.0.block.1.kind": "paragraph",
                "section.0.block.1.text": "Student",
                "section.0.block.1.source_ids": studentId,
                "section.0.block.2.kind": "paragraph",
                "section.0.block.2.text": "Annotation",
                "section.0.block.2.source_ids": `${annotationId},${transcriptId},${evidenceId}`,
                "section.0.block.3.kind": "paragraph",
                "section.0.block.3.text": "Asset",
                "section.0.block.3.source_ids": assetId,
                "section.0.block.4.kind": "paragraph",
                "section.0.block.4.text": "Notes",
                "section.0.block.4.source_ids": `${notesId},${unresolved}`,
            }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        expect(report.valid).toBe(false);
        const issues = report.issues.join("\n");
        expect(issues).toContain(`source ${unresolved} does not resolve`);
    });

    it("reports missing and mismatched guide references", async () => {
        const entryId = newUuid();
        const otherEntry = newUuid();
        const sessionId = newUuid();
        const snapshot = await base([
            record(RecordType.settings, entryId, {
                record_role: "journal-entry",
                session_ids: "",
            }),
            record(RecordType.session, sessionId, { entry_id: otherEntry }),
            record(RecordType.guide, newUuid(), {
                title: "Missing entry",
                entry_id: newUuid(),
                section_count: "0",
            }),
            record(RecordType.guide, newUuid(), {
                title: "Missing session",
                session_id: newUuid(),
                section_count: "0",
            }),
            record(RecordType.guide, newUuid(), {
                title: "Mismatched session",
                session_id: sessionId,
                entry_id: entryId,
                section_count: "0",
            }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        const issues = report.issues.join("\n");
        expect(issues).toContain("journal entry reference does not resolve");
        expect(issues).toContain("session reference does not resolve");
        expect(issues).toContain("session does not belong to its journal entry");
    });

    it("checks historical guide revisions with the permissive rules", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const entryId = newUuid();
        const guideId = newUuid();
        const first = await base([
            record(RecordType.student, studentId, { display_name: "Mina" }),
            record(RecordType.session, sessionId, { student_id: studentId, entry_id: entryId }),
            record(RecordType.settings, entryId, {
                record_role: "journal-entry",
                session_ids: sessionId,
            }),
            record(RecordType.guide, guideId, {
                title: "Guide",
                session_id: sessionId,
                entry_id: entryId,
                section_count: "1",
                "section.0.heading": "One",
                "section.0.block_count": "1",
                "section.0.block.0.kind": "paragraph",
                "section.0.block.0.text": "Mina",
                "section.0.block.0.source_ids": studentId,
            }),
        ]);
        const updated = await appendRecords(first, [
            record(RecordType.guide, guideId, {
                title: "Guide",
                session_id: sessionId,
                entry_id: entryId,
                section_count: "1",
                "section.0.heading": "Two",
                "section.0.block_count": "1",
                "section.0.block.0.kind": "paragraph",
                "section.0.block.0.text": "Mina again",
                "section.0.block.0.source_ids": studentId,
            }),
        ]);
        const report = await verifyArchiveFull(updated);
        expect(report.valid).toBe(true);
    });
});

describe("credential verification policy", () => {
    it("flags plaintext credential records and sensitive settings", async () => {
        const credentialId = newUuid();
        const sensitiveId = newUuid();
        const snapshot = await base([
            record(RecordType.settings, credentialId, {
                record_role: "xxxxxxxxxx",
                value: "secret",
            }),
            record(RecordType.settings, sensitiveId, {
                record_role: "provider-settings",
                abcdefgh: "value",
            }),
        ]);
        const credential = await patchRecord(
            snapshot,
            RecordType.settings,
            credentialId,
            (fields) => fields.set("record_role", "credential"),
        );
        const sensitive = await patchRecord(
            credential,
            RecordType.settings,
            sensitiveId,
            (fields) => {
                const value = fields.get("abcdefgh") ?? "";
                fields.delete("abcdefgh");
                fields.set("password", value);
            },
        );
        const report = await verifyArchiveFull(sensitive);
        const issues = report.issues.join("\n");
        expect(issues).toContain("stored in an unencrypted archive");
        expect(issues).toContain("credential-looking data outside");
    });
});

describe("secondary index verification", () => {
    it("reports missing, wrong, opaque, and disabled secondary indexes", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const trackId = newUuid();
        const chunkId = newUuid();
        const guideId = newUuid();
        const first = await base([
            record(RecordType.student, studentId, { display_name: "Mina" }),
            record(RecordType.session, sessionId, { student_id: studentId }),
            record(RecordType.audioChunk, chunkId, {
                session_id: sessionId,
                track_id: trackId,
                sequence_number: "0",
            }),
            record(RecordType.guide, guideId, {
                title: "Guide",
                session_id: sessionId,
                source_index_history: sessionId,
                section_count: "0",
            }),
        ]);
        const manifest = await first.getRecord(RecordType.settings, first.header.id);
        const session = await first.getRecord(RecordType.session, sessionId);
        const patchVersion = (fields: Map<string, string>, name: string): void => {
            if (fields.get(name) === "1") fields.set(name, "0");
        };
        const withoutVersions = await patchRecord(
            first,
            RecordType.settings,
            first.header.id,
            (fields) => {
                patchVersion(fields, "student_session_index_version");
                patchVersion(fields, "audio_chunk_index_version");
                patchVersion(fields, "guide_source_index_version");
                patchVersion(fields, "annotation_session_time_index_version");
                patchVersion(fields, "evidence_adjacency_index_version");
                patchVersion(fields, "transcript_session_index_version");
            },
        );
        const plainSession = await patchRecord(
            withoutVersions,
            RecordType.session,
            sessionId,
            (fields) => patchVersion(fields, "audio_chunk_index_version"),
        );

        const entries = new Map(plainSession.allIndexEntries());
        const studentsession = `STUDENTSESSION:${studentId}:${sessionId}`;
        const guidesource = `GUIDESOURCE:${sessionId}:${guideId}`;
        const audiosession = `AUDIOSESSION:${sessionId}:${trackId}:00000000000000000000`;
        expect(entries.has(studentsession)).toBe(true);
        expect(entries.has(guidesource)).toBe(true);
        expect(entries.has(audiosession)).toBe(true);
        entries.delete(studentsession);
        entries.set(
            `STUDENTSESSION:${studentId}:${newUuid()}`,
            entries.get(`SESSION:${sessionId}`)!,
        );
        entries.set(
            `AUDIOSESSION:${newUuid()}:${newUuid()}:00000000000000000000`,
            entries.get(`AUDIO:${chunkId}`)!,
        );
        entries.set(
            `FUTURE:${newUuid()}`,
            entries.get(`UNKNOWN:${newUuid()}`) ?? entries.get(`AUDIO:${chunkId}`)!,
        );
        const view = new ArchiveSnapshot(
            plainSession.source,
            plainSession.header,
            plainSession.commit,
            entries,
            plainSession.publishedEndOffset,
        );
        const report = await verifyArchiveFull(view);
        const issues = report.issues.join("\n");
        expect(issues).toContain("does not match its record");
        expect(issues).toContain("is not enabled by its manifest");
        void manifest;
        void session;

        const enabledEntries = new Map(first.allIndexEntries());
        enabledEntries.delete(`STUDENTSESSION:${studentId}:${sessionId}`);
        const enabledView = new ArchiveSnapshot(
            first.source,
            first.header,
            first.commit,
            enabledEntries,
            first.publishedEndOffset,
        );
        const enabledReport = await verifyArchiveFull(enabledView);
        expect(enabledReport.issues.join("\n")).toContain("is missing its current record mapping");
    });

    it("reports secondary keys that point at non-records or opaque records", async () => {
        const studentId = newUuid();
        const snapshot = await base([
            record(RecordType.student, studentId, { display_name: "Mina" }),
        ]);
        const entries = new Map(snapshot.allIndexEntries());
        entries.set(`STUDENTSESSION:${studentId}:${newUuid()}`, 64n);
        const view = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            entries,
            snapshot.publishedEndOffset,
        );
        const report = await verifyArchiveFull(view);
        expect(report.valid).toBe(false);
    });
});

describe("commit and index verification branches", () => {
    it("reports commit chain inconsistencies", async () => {
        const studentId = newUuid();
        const first = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("commit branches")),
            [record(RecordType.student, studentId, { display_name: "One" })],
        );
        const second = await appendRecords(first, [
            record(RecordType.student, studentId, { display_name: "Two" }),
        ]);
        const disagreement = new ArchiveSnapshot(
            second.source,
            second.header,
            { ...second.commit, recordCount: second.commit.recordCount + 1n },
            second.allIndexEntries(),
            second.publishedEndOffset,
        );
        expect((await verifyArchiveFull(disagreement)).issues.join("\n")).toContain(
            "disagrees with the selected chain",
        );

        const nonConsecutive = new ArchiveSnapshot(
            second.source,
            second.header,
            { ...second.commit, previousOffset: first.commit.previousOffset },
            second.allIndexEntries(),
            second.publishedEndOffset,
        );
        expect((await verifyArchiveFull(nonConsecutive)).issues.join("\n")).toContain(
            "not consecutive",
        );

        const badGeneration = new ArchiveSnapshot(
            second.source,
            second.header,
            { ...second.commit, generation: 4n, previousOffset: 0n },
            second.allIndexEntries(),
            second.publishedEndOffset,
        );
        expect((await verifyArchiveFull(badGeneration)).issues.join("\n")).toContain(
            "ends before generation one",
        );

        const undecodable = new ArchiveSnapshot(
            second.source,
            second.header,
            { ...second.commit, offset: second.commit.rootOffset },
            second.allIndexEntries(),
            second.publishedEndOffset,
        );
        expect((await verifyArchiveFull(undecodable)).issues.join("\n")).toContain(
            "Commit record has an invalid structure",
        );
    });

    it("reports invalid and mismatched primary index keys", async () => {
        const studentId = newUuid();
        const otherId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("primary keys")),
            [record(RecordType.student, studentId, { display_name: "A" })],
        );
        const entries = new Map(snapshot.allIndexEntries());
        entries.set("STUDENT:not-a-uuid", entries.get(`STUDENT:${studentId}`)!);
        const invalidKey = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            entries,
            snapshot.publishedEndOffset,
        );
        expect((await verifyArchiveFull(invalidKey)).issues.join("\n")).toContain("is invalid");

        const mismatched = new Map(snapshot.allIndexEntries());
        mismatched.delete(`STUDENT:${studentId}`);
        mismatched.set(
            `STUDENT:${otherId}`,
            snapshot.allIndexEntries().get(`STUDENT:${studentId}`)!,
        );
        const wrongRecord = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            mismatched,
            snapshot.publishedEndOffset,
        );
        expect((await verifyArchiveFull(wrongRecord)).issues.join("\n")).toContain(
            "points at a different record",
        );
    });

    it("notes opaque secondary targets and stale primary mappings", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const extensionId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("opaque secondary")),
            [
                record(RecordType.student, studentId, { display_name: "A" }),
                record(RecordType.session, sessionId, { student_id: studentId }),
                record(99, extensionId, { extension: "future" }),
            ],
        );
        const entries = new Map(snapshot.allIndexEntries());
        entries.set(
            `STUDENTSESSION:${studentId}:${sessionId}`,
            entries.get(`UNKNOWN:${extensionId}`)!,
        );
        const opaque = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            entries,
            snapshot.publishedEndOffset,
        );
        expect((await verifyArchiveFull(opaque)).issues.join("\n")).toContain("opaque record");

        const stale = new Map(snapshot.allIndexEntries());
        stale.set(`SESSION:${sessionId}`, snapshot.allIndexEntries().get(`STUDENT:${studentId}`)!);
        const staleView = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            stale,
            snapshot.publishedEndOffset,
        );
        expect((await verifyArchiveFull(staleView)).issues.join("\n")).toContain(
            "does not reference the current record revision",
        );
    });

    it("reports historical revisions with missing references", async () => {
        const sessionId = newUuid();
        const assetId = newUuid();
        const edgeId = newUuid();
        const guideId = newUuid();
        const first = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("historical refs")),
            [
                record(RecordType.session, sessionId, { student_id: newUuid(), title: "One" }),
                record(RecordType.assetMetadata, assetId, {
                    record_role: "material",
                    blob_id: newUuid(),
                }),
                record(RecordType.evidenceEdge, edgeId, {
                    from_id: newUuid(),
                    to_id: newUuid(),
                }),
                record(RecordType.guide, guideId, {
                    title: "Guide",
                    section_count: "1",
                    "section.0.heading": "One",
                    "section.0.block_count": "1",
                    "section.0.block.0.kind": "paragraph",
                    "section.0.block.0.text": "Missing source",
                    "section.0.block.0.source_ids": newUuid(),
                }),
            ],
        );
        const second = await appendRecords(first, [
            record(RecordType.session, sessionId, { student_id: newUuid(), title: "Two" }),
            record(RecordType.assetMetadata, assetId, {
                record_role: "material",
                blob_id: newUuid(),
            }),
            record(RecordType.evidenceEdge, edgeId, {
                from_id: newUuid(),
                to_id: newUuid(),
            }),
            record(RecordType.guide, guideId, {
                title: "Guide",
                section_count: "1",
                "section.0.heading": "Two",
                "section.0.block_count": "1",
                "section.0.block.0.kind": "paragraph",
                "section.0.block.0.text": "Missing source",
                "section.0.block.0.source_ids": newUuid(),
            }),
        ]);
        const issues = (await verifyArchiveFull(second)).issues.join("\n");
        expect(issues).toContain("Historical revision");
    });

    it("reports invalid and missing session references", async () => {
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("session refs")),
            [
                record(RecordType.transcriptSegment, newUuid(), {
                    session_id: "z".repeat(36),
                }),
                record(RecordType.transcriptSegment, newUuid(), {
                    session_id: newUuid(),
                }),
            ],
        );
        const issues = (await verifyArchiveFull(snapshot)).issues.join("\n");
        expect(issues).toContain("Invalid session reference");
        expect(issues).toContain("references a missing session");
    });
});

describe("asset manifest verification", () => {
    it("validates manifest bytes, counts, and hashes", async () => {
        const chunkData = new Uint8Array([1, 2, 3, 4]);
        const digest = await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3, 4]));
        const digestHex = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
        ).join("");
        const manifestId = newUuid();
        const chunkId = newUuid();
        const snapshot = await base([
            record(
                RecordType.assetBlob,
                chunkId,
                {
                    record_role: "asset-blob-chunk",
                    manifest_id: manifestId,
                    chunk_index: "0",
                },
                chunkData,
            ),
            record(RecordType.assetBlob, manifestId, {
                record_role: "asset-blob-manifest",
                chunk_count: "1",
                chunk_ids: chunkId,
                byte_size: "4",
                content_hash: digestHex,
            }),
        ]);
        await expect(verifyArchiveFull(snapshot)).resolves.toMatchObject({ valid: true });
    });

    it("reports manifest content problems", async () => {
        const invalidCount = newUuid();
        const missingChunk = newUuid();
        const mismatchedChunk = newUuid();
        const chunkId = newUuid();
        const badChunkId = newUuid();
        const mismatchedManifest = newUuid();
        const snapshot = await base([
            record(RecordType.assetBlob, invalidCount, {
                record_role: "asset-blob-manifest",
                chunk_count: "nope",
            }),
            record(RecordType.assetBlob, missingChunk, {
                record_role: "asset-blob-manifest",
                chunk_count: "1",
                chunk_ids: newUuid(),
            }),
            record(RecordType.assetBlob, mismatchedChunk, {
                record_role: "asset-blob-manifest",
                chunk_count: "1",
                chunk_ids: chunkId,
            }),
            record(
                RecordType.assetBlob,
                chunkId,
                {
                    record_role: "asset-blob-chunk",
                    manifest_id: mismatchedManifest,
                    chunk_index: "0",
                },
                new Uint8Array([1]),
            ),
            record(RecordType.assetBlob, badChunkId, {
                record_role: "asset-blob-manifest",
                chunk_count: "1",
                chunk_ids: "not-a-uuid",
            }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        const issues = report.issues.join("\n");
        expect(issues).toContain("chunk count is invalid");
        expect(issues).toContain("missing or inconsistent chunks");
        expect(issues).toContain("invalid chunk identifier");
    });

    it("reports manifest hashes that do not match", async () => {
        const manifestId = newUuid();
        const chunkId = newUuid();
        const snapshot = await base([
            record(
                RecordType.assetBlob,
                chunkId,
                {
                    record_role: "asset-blob-chunk",
                    manifest_id: manifestId,
                    chunk_index: "0",
                },
                new Uint8Array([1, 2]),
            ),
            record(RecordType.assetBlob, manifestId, {
                record_role: "asset-blob-manifest",
                chunk_count: "1",
                chunk_ids: chunkId,
                byte_size: "3",
                content_hash: "0".repeat(64),
            }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        expect(report.issues.join("\n")).toContain("does not match its hash");
    });
});
