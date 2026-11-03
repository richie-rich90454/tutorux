import { describe, expect, it } from "vitest";
import {
    appendRecords,
    backfillArchiveSecondaryIndexes,
    compactArchiveSnapshot,
    createArchiveBytes,
    createEncryptedArchiveBytes,
    discardUncommittedTail,
    inspectArchiveRecovery,
    openArchiveBytes,
    openArchiveSourceForRecovery,
    recoverUnpublishedCommit,
    repairArchiveSnapshot,
    verifyArchiveFull,
    verifyArchiveHistory,
    verifyArchiveSnapshot,
    ArchiveSnapshot,
} from "../../../frontend/archive/archive";
import {
    ArchiveFormatError,
    crc32,
    decodeRecordFrame,
    decodeRecordPayload,
    encodeRecordFrame,
    encodeRecordPayload,
    newUuid,
    RecordType,
    type ArchiveRecord,
    type RecordTypeValue,
} from "../../../frontend/archive/format";
import { MemoryArchiveSource, type ArchiveByteSource } from "../../../frontend/archive/source";
import { ArchiveDataKey, encryptionEnvelopeFromRecord } from "../../../frontend/archive/crypto";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function record(
    type: RecordTypeValue,
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

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
}

async function bytesOf(snapshot: ArchiveSnapshot): Promise<Uint8Array> {
    return (await snapshot.source.read(0n, Number(snapshot.source.size))).slice();
}

function rewriteFrame(
    bytes: Uint8Array,
    offset: number,
    payload: Uint8Array,
    meta?: { previousOffset?: bigint; revision?: bigint },
): void {
    const frame = decodeRecordFrame(bytes.subarray(offset));
    const encoded = encodeRecordFrame(
        {
            type: frame.type,
            id: frame.id,
            revision: meta?.revision ?? frame.revision,
            previousOffset: meta?.previousOffset ?? frame.previousOffset,
        },
        payload,
        frame.codec,
        frame.flags,
    );
    bytes.set(encoded, offset);
}

function reopen(
    snapshot: ArchiveSnapshot,
    bytes: Uint8Array,
    index = snapshot.allIndexEntries(),
): ArchiveSnapshot {
    return new ArchiveSnapshot(
        new MemoryArchiveSource(bytes),
        snapshot.header,
        snapshot.commit,
        index,
        snapshot.publishedEndOffset,
    );
}

function primaryKey(type: RecordTypeValue, id: string): string {
    const names: Record<number, string> = {
        [RecordType.student]: "STUDENT",
        [RecordType.session]: "SESSION",
        [RecordType.audioChunk]: "AUDIO",
        [RecordType.transcriptSegment]: "TRANSCRIPT",
        [RecordType.annotation]: "ANNOTATION",
        [RecordType.assetMetadata]: "ASSET",
        [RecordType.assetBlob]: "ASSET-BLOB",
        [RecordType.evidenceNode]: "EVIDENCE",
        [RecordType.evidenceEdge]: "EVIDENCE-EDGE",
        [RecordType.guide]: "GUIDE",
        [RecordType.settings]: "SETTINGS",
        [RecordType.aiJob]: "AI-JOB",
        [RecordType.encryption]: "ENCRYPTION",
        [RecordType.waveformIndex]: "WAVEFORM-INDEX",
    };
    return `${names[type as number] ?? "UNKNOWN"}:${id.toLowerCase()}`;
}

function indexWith(
    snapshot: ArchiveSnapshot,
    mutate: (index: Map<string, bigint>) => void,
): Map<string, bigint> {
    const index = new Map(snapshot.allIndexEntries());
    mutate(index);
    return index;
}

function compareKeyBytes(left: string, right: string): number {
    const encoder = new TextEncoder();
    const a = encoder.encode(left);
    const b = encoder.encode(right);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) return a[index]! - b[index]!;
    }
    return a.length - b.length;
}

function encodeIndexLeaf(entries: readonly (readonly [string, bigint])[]): Uint8Array {
    const encoder = new TextEncoder();
    let size = 10;
    for (const [key] of entries) size += 2 + encoder.encode(key).length + 8;
    const payload = new Uint8Array(size);
    const view = new DataView(payload.buffer);
    payload.set(encoder.encode("TXPG"), 0);
    view.setUint16(4, 1, true);
    payload[6] = 0;
    payload[7] = 0;
    view.setUint16(8, entries.length, true);
    let cursor = 10;
    for (const [key, offset] of entries) {
        const encoded = encoder.encode(key);
        view.setUint16(cursor, encoded.length, true);
        cursor += 2;
        payload.set(encoded, cursor);
        cursor += encoded.length;
        view.setBigUint64(cursor, offset, true);
        cursor += 8;
    }
    return payload;
}

function encodeLocatorBytes(commitOffset: bigint, generation: bigint): Uint8Array {
    const locator = new Uint8Array(32);
    const view = new DataView(locator.buffer);
    locator.set(new TextEncoder().encode("TUXLOC1\0"), 0);
    view.setBigUint64(8, commitOffset, true);
    view.setBigUint64(16, generation, true);
    view.setUint32(24, crc32(locator.subarray(0, 24)), true);
    view.setUint32(28, 0, true);
    return locator;
}

/** Rewrite the root index page and commit so a modified index becomes authoritative. */
async function rebuildWithIndex(
    base: ArchiveSnapshot,
    index: ReadonlyMap<string, bigint>,
    bytes?: Uint8Array,
): Promise<Uint8Array> {
    const source = bytes ?? (await bytesOf(base));
    const rootOffset = Number(base.commit.rootOffset);
    const entries = [...index.entries()].sort(([left], [right]) => compareKeyBytes(left, right));
    const payload = encodeIndexLeaf(entries);
    const rootFrame = encodeRecordFrame(
        { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
        payload,
    );
    const commitFrameOrig = decodeRecordFrame(source.subarray(Number(base.commit.offset)));
    const commitPayload = commitFrameOrig.storedPayload.slice();
    new DataView(commitPayload.buffer).setBigUint64(24, BigInt(rootOffset), true);
    commitPayload.set(await sha256(payload), 32);
    const commitFrame = encodeRecordFrame(
        {
            type: RecordType.commit,
            id: ZERO_UUID,
            revision: commitFrameOrig.revision,
            previousOffset: commitFrameOrig.previousOffset,
        },
        commitPayload,
    );
    const locator = encodeLocatorBytes(
        BigInt(rootOffset + rootFrame.length),
        base.commit.generation,
    );
    const output = new Uint8Array(
        rootOffset + rootFrame.length + commitFrame.length + locator.length,
    );
    output.set(source.subarray(0, rootOffset));
    output.set(rootFrame, rootOffset);
    output.set(commitFrame, rootOffset + rootFrame.length);
    output.set(locator, rootOffset + rootFrame.length + commitFrame.length);
    return output;
}

async function deletedTail(
    snapshot: ArchiveSnapshot,
    type: RecordTypeValue,
    id: string,
    fields: Record<string, string>,
): Promise<ArchiveSnapshot> {
    return appendRecords(snapshot, [record(type, id, { ...fields, _deleted: "true" })]);
}

describe("snapshot index read guards", () => {
    it("rejects index keys that point at a different record", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("index guards"));
        const student = newUuid();
        const snapshot = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
        ]);
        const studentOffset = snapshot
            .allIndexEntries()
            .get(primaryKey(RecordType.student, student))!;
        const manifestOffset = snapshot
            .allIndexEntries()
            .get(primaryKey(RecordType.settings, snapshot.header.id))!;

        const metadataIndex = indexWith(snapshot, (index) => {
            index.set(primaryKey(RecordType.student, newUuid()), manifestOffset);
        });
        await expect(
            reopen(snapshot, await bytesOf(snapshot), metadataIndex).listRecordMetadata(
                RecordType.student,
            ),
        ).rejects.toMatchObject({ code: "record_index_mismatch" });

        const recordIndex = indexWith(snapshot, (index) => {
            index.set(primaryKey(RecordType.student, newUuid()), studentOffset);
        });
        await expect(
            reopen(snapshot, await bytesOf(snapshot), recordIndex).listRecords(RecordType.student),
        ).rejects.toMatchObject({ code: "record_index_mismatch" });
    });

    it("rejects audio index entries that are not audio records", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("audio type"));
        const manifoldOffset = base
            .allIndexEntries()
            .get(primaryKey(RecordType.settings, base.header.id))!;
        const snapshot = reopen(
            base,
            await bytesOf(base),
            indexWith(base, (index) => {
                index.set(`AUDIO:${newUuid()}`, manifoldOffset);
            }),
        );
        await expect(snapshot.listAudioChunkMetadata(newUuid(), newUuid())).rejects.toMatchObject({
            code: "audio_chunk_index_invalid",
        });
    });

    it("validates audio session index identities", async () => {
        const session = newUuid();
        const track = newUuid();
        const otherTrack = newUuid();
        const chunk = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("audio identity"));
        const snapshot = await appendRecords(base, [
            record(RecordType.session, session, { student_id: "anonymous" }),
            record(RecordType.audioChunk, chunk, {
                session_id: session,
                track_id: track,
                sequence_number: "10",
            }),
        ]);
        const chunkOffset = snapshot
            .allIndexEntries()
            .get(primaryKey(RecordType.audioChunk, chunk))!;
        const bytes = await bytesOf(snapshot);

        const wrongTrack = reopen(
            snapshot,
            bytes,
            indexWith(snapshot, (index) => {
                for (const key of [...index.keys()])
                    if (key.startsWith("AUDIOSESSION:")) index.delete(key);
                index.set(
                    `AUDIOSESSION:${session}:${otherTrack}:00000000000000000010`,
                    chunkOffset,
                );
            }),
        );
        await expect(wrongTrack.listAudioChunkMetadata(session, otherTrack)).rejects.toMatchObject({
            code: "audio_chunk_index_invalid",
        });

        const wrongSequence = reopen(
            snapshot,
            bytes,
            indexWith(snapshot, (index) => {
                for (const key of [...index.keys()])
                    if (key.startsWith("AUDIOSESSION:")) index.delete(key);
                index.set(`AUDIOSESSION:${session}:${track}:00000000000000000011`, chunkOffset);
            }),
        );
        await expect(wrongSequence.listAudioChunkMetadata(session, track)).rejects.toMatchObject({
            code: "audio_chunk_index_invalid",
        });
    });

    it("skips fallback audio entries for another session and rejects bad sequences", async () => {
        const session = newUuid();
        const otherSession = newUuid();
        const track = newUuid();
        const chunk = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("audio fallback"));
        const snapshot = await appendRecords(base, [
            record(RecordType.session, session, { student_id: "anonymous" }),
            record(RecordType.audioChunk, chunk, {
                session_id: session,
                track_id: track,
                sequence_number: "10",
            }),
        ]);
        const chunkOffset = Number(
            snapshot.allIndexEntries().get(primaryKey(RecordType.audioChunk, chunk))!,
        );

        function patchChunk(
            bytes: Uint8Array,
            mutate: (fields: Map<string, string>) => void,
        ): void {
            const frame = decodeRecordFrame(bytes.subarray(chunkOffset));
            const decoded = decodeRecordPayload(
                frame.type,
                frame.id,
                frame.revision,
                frame.previousOffset,
                frame.storedPayload,
            );
            const fields = new Map(decoded.fields);
            mutate(fields);
            rewriteFrame(bytes, chunkOffset, encodeRecordPayload({ fields, blob: decoded.blob }));
        }

        const foreignBytes = await bytesOf(snapshot);
        patchChunk(foreignBytes, (fields) => fields.set("session_id", otherSession));
        const foreignIndex = indexWith(snapshot, (index) => {
            for (const key of [...index.keys()]) {
                if (key.startsWith("AUDIOSESSION:")) index.delete(key);
            }
            index.set(`AUDIO:${chunk}`, BigInt(chunkOffset));
        });
        const foreign = reopen(snapshot, foreignBytes, foreignIndex);
        await expect(foreign.listAudioChunkMetadata(session, track)).resolves.toEqual([]);

        const badBytes = await bytesOf(snapshot);
        patchChunk(badBytes, (fields) => fields.set("sequence_number", "1x"));
        const badIndex = indexWith(snapshot, (index) => {
            for (const key of [...index.keys()]) {
                if (key.startsWith("AUDIOSESSION:")) index.delete(key);
            }
            index.set(`AUDIO:${chunk}`, BigInt(chunkOffset));
        });
        await expect(
            reopen(snapshot, badBytes, badIndex).listAudioChunkMetadata(session, track),
        ).rejects.toMatchObject({ code: "audio_chunk_metadata_invalid" });
    });
});

describe("verification entry branches", () => {
    it("supports full verification and rejects locked snapshots", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("verify modes"));
        const full = await verifyArchiveSnapshot(snapshot, { full: true });
        expect(full.valid).toBe(true);
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("locked verify", "", "correct horse battery"),
        );
        await expect(verifyArchiveSnapshot(locked)).rejects.toMatchObject({
            code: "archive_locked",
        });
    });

    it("rejects invalid and mismatched primary index keys", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("verify keys"));
        const invalid = reopen(
            snapshot,
            await bytesOf(snapshot),
            indexWith(snapshot, (index) => {
                index.set("STUDENT:not-a-uuid", snapshot.commit.offset);
            }),
        );
        await expect(verifyArchiveSnapshot(invalid)).rejects.toMatchObject({
            code: "record_index_key_invalid",
        });

        const mismatched = reopen(
            snapshot,
            await bytesOf(snapshot),
            indexWith(snapshot, (index) => {
                index.set(
                    primaryKey(RecordType.student, newUuid()),
                    snapshot
                        .allIndexEntries()
                        .get(primaryKey(RecordType.settings, snapshot.header.id))!,
                );
            }),
        );
        await expect(verifyArchiveSnapshot(mismatched)).rejects.toMatchObject({
            code: "record_index_mismatch",
        });
    });

    it("ignores non-primary aliases during history verification", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("history alias"));
        const index = indexWith(snapshot, (value) => {
            value.set(
                `settings:${snapshot.header.id}`,
                value.get(primaryKey(RecordType.settings, snapshot.header.id))!,
            );
        });
        const aliased = await openArchiveBytes(await rebuildWithIndex(snapshot, index));
        const result = await verifyArchiveHistory(aliased);
        expect(result.verifiedCommits).toBe(1);
        expect(result.historicalRevisions).toBe(0);
    });

    it("reports revision lineage and frame read failures as issues", async () => {
        const student = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("lineage"));
        const snapshot = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
        ]);
        const offset = Number(
            snapshot.allIndexEntries().get(primaryKey(RecordType.student, student))!,
        );

        const forward = await bytesOf(snapshot);
        const frame = decodeRecordFrame(forward.subarray(offset));
        rewriteFrame(forward, offset, frame.storedPayload, { previousOffset: BigInt(offset) });
        const forwardReport = await verifyArchiveFull(reopen(snapshot, forward));
        expect(forwardReport.valid).toBe(false);
        expect(forwardReport.issues.join(" ")).toContain("lineage is inconsistent");

        const unreadable = await bytesOf(snapshot);
        const unreadableFrame = decodeRecordFrame(unreadable.subarray(offset));
        rewriteFrame(unreadable, offset, unreadableFrame.storedPayload, { previousOffset: 8n });
        const unreadableReport = await verifyArchiveFull(reopen(snapshot, unreadable));
        expect(unreadableReport.valid).toBe(false);
        expect(unreadableReport.issues.join(" ")).toContain("outside the supported file range");
    });

    it("reports asset metadata whose blob content is invalid", async () => {
        const asset = newUuid();
        const blob = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("asset issue")),
            [
                record(RecordType.assetMetadata, asset, {
                    record_role: "material",
                    blob_id: blob,
                }),
                record(RecordType.assetBlob, blob, {
                    record_role: "asset-blob-manifest",
                    chunk_count: "not-a-number",
                }),
            ],
        );
        const report = await verifyArchiveFull(snapshot);
        expect(report.valid).toBe(false);
        expect(report.issues.join(" ")).toContain("manifest chunk count is invalid");
    });

    it("reports historical blob manifests with invalid content", async () => {
        const blob = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("historical blob"));
        const first = await appendRecords(base, [
            record(RecordType.assetBlob, blob, {
                record_role: "asset-blob-manifest",
                chunk_count: "oops",
            }),
        ]);
        const snapshot = await appendRecords(first, [
            record(RecordType.assetBlob, blob, {
                record_role: "asset-blob-manifest",
                chunk_count: "0",
            }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        expect(report.valid).toBe(false);
        expect(report.issues.join(" ")).toContain("Historical asset blob manifest");
    });

    it("reports stale audio and guide secondary index mappings", async () => {
        const student = newUuid();
        const session = newUuid();
        const track = newUuid();
        const chunk = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("stale aliases"));
        const withChunk = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
            record(RecordType.session, session, { student_id: student }),
            record(RecordType.audioChunk, chunk, {
                session_id: session,
                track_id: track,
                sequence_number: "1",
            }),
        ]);
        const chunkRevision = withChunk
            .allIndexEntries()
            .get(primaryKey(RecordType.audioChunk, chunk))!;
        const updated = await appendRecords(withChunk, [
            record(RecordType.audioChunk, chunk, {
                session_id: session,
                track_id: track,
                sequence_number: "1",
                codec: "none",
            }),
        ]);
        const audioIndex = indexWith(updated, (index) => {
            for (const key of [...index.keys()]) {
                if (key.startsWith("AUDIOSESSION:")) {
                    index.set(key, chunkRevision);
                }
            }
        });
        const audioReport = await verifyArchiveFull(
            reopen(updated, await bytesOf(updated), audioIndex),
        );
        expect(audioReport.issues.join(" ")).toContain(
            "Audio session index key does not match its record",
        );

        const guide = newUuid();
        const guideFields = {
            session_id: session,
            title: "Guide",
            section_count: "1",
            "section.0.heading": "H",
            "section.0.block_count": "1",
            "section.0.block.0.kind": "paragraph",
            "section.0.block.0.source_ids": student,
        };
        const withGuide = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
            record(RecordType.session, session, { student_id: student }),
            record(RecordType.guide, guide, guideFields),
        ]);
        const guideRevision = withGuide.allIndexEntries().get(primaryKey(RecordType.guide, guide))!;
        const guideUpdated = await appendRecords(withGuide, [
            record(RecordType.guide, guide, { ...guideFields, title: "Guide two" }),
        ]);
        const guideIndex = indexWith(guideUpdated, (index) => {
            for (const key of [...index.keys()]) {
                if (key.startsWith("GUIDESOURCE:")) index.set(key, guideRevision);
            }
        });
        const guideReport = await verifyArchiveFull(
            reopen(guideUpdated, await bytesOf(guideUpdated), guideIndex),
        );
        expect(guideReport.issues.join(" ")).toContain(
            "Guide source index does not reference the current guide revision",
        );
    });

    it("records inline guide source identifiers and overlapping record spans", async () => {
        const student = newUuid();
        const session = newUuid();
        const guide = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("inline guide verify")),
            [
                record(RecordType.student, student, { display_name: "A" }),
                record(RecordType.session, session, { student_id: student }),
                record(RecordType.guide, guide, {
                    session_id: session,
                    title: "Guide",
                    section_count: "1",
                    "section.0.heading": "H",
                    "section.0.block_count": "1",
                    "section.0.block.0.kind": "paragraph",
                    "section.0.block.0.text": `see [[source:${student}]]`,
                }),
            ],
        );
        const report = await verifyArchiveFull(snapshot);
        expect(report.valid).toBe(true);

        const innerId = newUuid();
        const outerId = newUuid();
        const innerFrame = encodeRecordFrame(
            { type: RecordType.student, id: innerId, revision: 1n, previousOffset: 0n },
            encodeRecordPayload(record(RecordType.student, innerId, { display_name: "inner" })),
        );
        const outer = record(RecordType.student, outerId, { aa: "bb", e: "7777777" }, innerFrame);
        const withOuter = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("overlap")),
            [outer],
        );
        const outerOffset = Number(
            withOuter.allIndexEntries().get(primaryKey(RecordType.student, outerId))!,
        );
        const innerOffset = BigInt(outerOffset + 64 + 16 + 24);
        const overlapIndex = indexWith(withOuter, (index) => {
            index.set(primaryKey(RecordType.student, innerId), innerOffset);
        });
        const overlap = await verifyArchiveFull(
            reopen(withOuter, await bytesOf(withOuter), overlapIndex),
        );
        expect(overlap.valid).toBe(false);
        expect(overlap.issues.join(" ")).toContain("spans overlap");
    });
});

describe("recovery branches", () => {
    it("requires an unlocked snapshot", async () => {
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("locked recovery", "", "correct horse battery"),
        );
        await expect(recoverUnpublishedCommit(locked)).rejects.toMatchObject({
            code: "archive_locked",
        });
    });

    it("recovers multiple unpublished generations with secondary indexes", async () => {
        const student = newUuid();
        const first = await openArchiveBytes(await createArchiveBytes("multi recover"));
        const second = await appendRecords(first, [
            record(RecordType.student, student, { display_name: "A" }),
        ]);
        const third = await appendRecords(second, [
            record(RecordType.session, newUuid(), { student_id: student }),
        ]);
        const bytes = (await bytesOf(third)).slice(0, -32);
        const secondEnd =
            Number(second.commit.offset) +
            decodeRecordFrame(bytes.subarray(Number(second.commit.offset))).endOffset;
        bytes.fill(0, secondEnd, secondEnd + 32);
        const reopened = await openArchiveBytes(bytes);
        const recovered = await recoverUnpublishedCommit(reopened);
        expect(recovered.recoveredGenerations).toBe(2);
        expect(recovered.recoveredGeneration).toBe(3n);
    });

    it("rejects an unpublished generation whose record count disagrees", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("bad count"));
        const second = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const bytes = (await bytesOf(second)).slice(0, -32);
        const commitFrame = decodeRecordFrame(bytes.subarray(Number(second.commit.offset)));
        const payload = commitFrame.storedPayload.slice();
        new DataView(payload.buffer).setBigUint64(80, 99n, true);
        rewriteFrame(bytes, Number(second.commit.offset), payload);
        const reopened = await openArchiveBytes(bytes);
        await expect(recoverUnpublishedCommit(reopened)).rejects.toMatchObject({
            code: "archive_recovery_validation_failed",
        });
    });

    it("keeps a verified generation when a later unpublished one fails", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("partial recover"));
        const second = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const third = await appendRecords(second, [
            record(RecordType.session, newUuid(), { student_id: newUuid() }),
        ]);
        const bytes = (await bytesOf(third)).slice(0, -32);
        const secondEnd =
            Number(second.commit.offset) +
            decodeRecordFrame(bytes.subarray(Number(second.commit.offset))).endOffset;
        bytes.fill(0, secondEnd, secondEnd + 32);
        const reopened = await openArchiveBytes(bytes);
        const recovered = await recoverUnpublishedCommit(reopened);
        expect(recovered.recoveredGenerations).toBe(1);
        expect(recovered.recoveredGeneration).toBe(2n);
    });

    it("publishes a complete commit that has no locator", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("no locator"));
        const dangling = await appendRecords(base, [
            record(RecordType.session, newUuid(), { student_id: newUuid() }),
        ]);
        const bytes = (await bytesOf(dangling)).slice(0, -32);
        const end =
            Number(dangling.commit.offset) +
            decodeRecordFrame(bytes.subarray(Number(dangling.commit.offset))).endOffset;
        const view = new ArchiveSnapshot(
            new MemoryArchiveSource(bytes),
            dangling.header,
            dangling.commit,
            dangling.allIndexEntries(),
            BigInt(end),
        );
        await expect(recoverUnpublishedCommit(view)).rejects.toMatchObject({
            code: "archive_recovery_validation_failed",
        });
    });

    it("rethrows non-locator commit errors", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("commit error"));
        const manifestOffset = base
            .allIndexEntries()
            .get(primaryKey(RecordType.settings, base.header.id))!;
        const broken = new ArchiveSnapshot(
            base.source,
            base.header,
            { ...base.commit, offset: manifestOffset },
            base.allIndexEntries(),
            base.publishedEndOffset,
        );
        await expect(recoverUnpublishedCommit(broken)).rejects.toMatchObject({
            code: "archive_commit_invalid",
        });
    });

    it("reports an invalid unpublished candidate during inspection", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("inspect bad tail"));
        const second = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const bytes = (await bytesOf(second)).slice(0, -32);
        const commitFrame = decodeRecordFrame(bytes.subarray(Number(second.commit.offset)));
        const payload = commitFrame.storedPayload.slice();
        new DataView(payload.buffer).setBigUint64(80, 99n, true);
        rewriteFrame(bytes, Number(second.commit.offset), payload);
        const inspection = await inspectArchiveRecovery(new MemoryArchiveSource(bytes));
        expect(inspection.issues.join(" ")).toContain("record count");
    });

    it("rejects discarding a tail when the committed prefix is invalid", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("dirty prefix"));
        const dangling = await appendRecords(base, [
            record(RecordType.session, newUuid(), { student_id: newUuid() }),
        ]);
        const bytes = await bytesOf(dangling);
        const withTail = new Uint8Array(bytes.length + 4);
        withTail.set(bytes);
        withTail.set([1, 2, 3, 4], bytes.length);
        const snapshot = await openArchiveBytes(withTail);
        await expect(discardUncommittedTail(snapshot)).rejects.toMatchObject({
            code: "archive_recovery_validation_failed",
        });
    });
});

describe("encryption preconditions", () => {
    const passphrase = "correct horse battery";

    async function unlockedKey(): Promise<{
        snapshot: ArchiveSnapshot;
        key: ArchiveDataKey;
    }> {
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("key source", "", passphrase),
        );
        const snapshot = await locked.unlock(passphrase);
        const envelopeRecord = await snapshot.getRecord(RecordType.encryption, snapshot.header.id);
        const envelope = encryptionEnvelopeFromRecord(envelopeRecord!, snapshot.header.id);
        const key = await ArchiveDataKey.unwrap(passphrase, envelope, snapshot.header.id);
        return { snapshot, key };
    }

    it("rejects re-keying when the envelope is missing", async () => {
        const { snapshot, key } = await unlockedKey();
        const index = indexWith(snapshot, (value) => {
            value.delete(primaryKey(RecordType.encryption, snapshot.header.id));
        });
        const broken = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            index,
            snapshot.publishedEndOffset,
            key,
        );
        await expect(
            broken.changePassphrase(passphrase, "another good passphrase"),
        ).rejects.toMatchObject({ code: "archive_encryption_metadata_missing" });
    });

    it("rejects enabling encryption without a manifest index entry", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("no manifest index"));
        const index = indexWith(base, (value) => {
            value.delete(primaryKey(RecordType.settings, base.header.id));
        });
        const broken = reopen(base, await bytesOf(base), index);
        await expect(broken.enableEncryption(passphrase)).rejects.toMatchObject({
            code: "archive_manifest_missing",
        });
    });

    it("retains opaque indexes during encryption", async () => {
        const firstId = "11111111-1111-1111-1111-111111111111";
        const secondId = "22222222-2222-2222-2222-222222222222";
        const base = await openArchiveBytes(await createArchiveBytes("opaque encrypt"));
        const snapshot = await appendRecords(base, [
            record(99, firstId, { label: "first" }, new Uint8Array(300).fill(0x61)),
            record(99, secondId, { label: "second" }),
        ]);
        const firstOffset = snapshot.allIndexEntries().get(`UNKNOWN:${firstId}`)!;
        const secondOffset = snapshot.allIndexEntries().get(`UNKNOWN:${secondId}`)!;

        const withPrimary = await openArchiveBytes(
            await rebuildWithIndex(
                snapshot,
                indexWith(snapshot, (index) => {
                    index.set(`FUTURE:${firstId}`, firstOffset);
                }),
            ),
        );
        const encrypted = await withPrimary.enableEncryption(passphrase);
        expect(encrypted.encrypted).toBe(true);

        const withoutPrimary = await openArchiveBytes(
            await rebuildWithIndex(
                snapshot,
                indexWith(snapshot, (index) => {
                    index.delete(`UNKNOWN:${firstId}`);
                    index.delete(`UNKNOWN:${secondId}`);
                    index.set(`FUTURE:${firstId}`, firstOffset);
                    index.set(`LATER:${firstId}`, firstOffset);
                    index.set(`FUTURE:${secondId}`, secondOffset);
                }),
            ),
        );
        const reencrypted = await withoutPrimary.enableEncryption(passphrase);
        expect(reencrypted.encrypted).toBe(true);
    });

    it("verifies an encrypted manifest role through the snapshot API", async () => {
        const { snapshot } = await unlockedKey();
        const original = snapshot.getRecord.bind(snapshot);
        (snapshot as unknown as { getRecord: typeof original }).getRecord = async (type, id) => {
            if (type === RecordType.settings && id.toLowerCase() === snapshot.header.id) {
                return {
                    type,
                    id,
                    revision: 1n,
                    previousOffset: 0n,
                    fields: new Map([["record_role", "wrong"]]),
                    blob: new Uint8Array(),
                };
            }
            return original(type, id);
        };
        await expect(snapshot.verifyEncryptionAuthentication()).rejects.toMatchObject({
            code: "archive_manifest_missing",
        });
    });
});

describe("compaction and pruning branches", () => {
    it("ignores unknown secondary-style keys that point at known records", async () => {
        const student = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("custom alias")),
            [record(RecordType.student, student, { display_name: "A" })],
        );
        const offset = snapshot.allIndexEntries().get(primaryKey(RecordType.student, student))!;
        const customized = await openArchiveBytes(
            await rebuildWithIndex(
                snapshot,
                indexWith(snapshot, (index) => {
                    index.set(`CUSTOM:${student}`, offset);
                }),
            ),
        );
        const compacted = await compactArchiveSnapshot(customized);
        expect(compacted.preservedRecords).toBeGreaterThan(0);
    });

    it("rejects shared opaque revision chains during compaction", async () => {
        const firstId = "11111111-1111-1111-1111-111111111111";
        const secondId = "22222222-2222-2222-2222-222222222222";
        const base = await openArchiveBytes(await createArchiveBytes("opaque shared"));
        const snapshot = await appendRecords(base, [
            record(99, firstId, { label: "first" }),
            record(99, secondId, { label: "second" }),
        ]);
        const firstOffset = snapshot.allIndexEntries().get(`UNKNOWN:${firstId}`)!;
        const secondOffset = Number(snapshot.allIndexEntries().get(`UNKNOWN:${secondId}`)!);
        const bytes = await bytesOf(snapshot);
        const frame = decodeRecordFrame(bytes.subarray(secondOffset));
        rewriteFrame(bytes, secondOffset, frame.storedPayload, { previousOffset: firstOffset });
        const index = indexWith(snapshot, (value) => {
            value.delete(`UNKNOWN:${firstId}`);
            value.delete(`UNKNOWN:${secondId}`);
            value.set(`FUTURE:${firstId}`, firstOffset);
            value.set(`FUTURE:${secondId}`, BigInt(secondOffset));
        });
        const broken = await openArchiveBytes(await rebuildWithIndex(snapshot, index, bytes));
        await expect(compactArchiveSnapshot(broken)).rejects.toMatchObject({
            code: "archive_compaction_index_unreachable",
        });
    });

    it("rejects opaque chains with inconsistent record identities", async () => {
        const firstId = "11111111-1111-1111-1111-111111111111";
        const secondId = "22222222-2222-2222-2222-222222222222";
        const base = await openArchiveBytes(await createArchiveBytes("opaque lineage"));
        const snapshot = await appendRecords(base, [
            record(99, firstId, { label: "first" }),
            record(99, secondId, { label: "second" }),
        ]);
        const firstOffset = snapshot.allIndexEntries().get(`UNKNOWN:${firstId}`)!;
        const secondOffset = Number(snapshot.allIndexEntries().get(`UNKNOWN:${secondId}`)!);
        const bytes = await bytesOf(snapshot);
        const frame = decodeRecordFrame(bytes.subarray(secondOffset));
        rewriteFrame(bytes, secondOffset, frame.storedPayload, { previousOffset: firstOffset });
        const index = indexWith(snapshot, (value) => {
            value.delete(`UNKNOWN:${firstId}`);
            value.delete(`UNKNOWN:${secondId}`);
            value.set(`FUTURE:${secondId}`, BigInt(secondOffset));
        });
        const broken = await openArchiveBytes(await rebuildWithIndex(snapshot, index, bytes));
        await expect(compactArchiveSnapshot(broken)).rejects.toMatchObject({
            code: "revision_lineage_invalid",
        });
    });

    it("rejects invalid, missing, and deleted pruning references", async () => {
        const asset = newUuid();
        const blob = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("prune refs"));

        const validBlob = record(RecordType.assetBlob, blob, {
            record_role: "asset-blob-manifest",
            chunk_count: "0",
        });
        const assetRecord = record(RecordType.assetMetadata, asset, {
            record_role: "material",
            blob_id: blob,
        });
        const withAsset = await appendRecords(base, [assetRecord, validBlob]);

        const invalid = await deletedTail(withAsset, RecordType.assetMetadata, asset, {
            record_role: "material",
            blob_id: "not-a-uuid",
        });
        await expect(
            compactArchiveSnapshot(invalid, { pruneUnreferencedAssets: true }),
        ).rejects.toMatchObject({ code: "archive_pruning_reference_invalid" });

        const missing = await deletedTail(withAsset, RecordType.assetMetadata, asset, {
            record_role: "material",
            blob_id: newUuid(),
        });
        await expect(
            compactArchiveSnapshot(missing, { pruneUnreferencedAssets: true }),
        ).rejects.toMatchObject({ code: "archive_pruning_blob_missing" });

        const deletedBlob = await deletedTail(withAsset, RecordType.assetBlob, blob, {
            record_role: "asset-blob-manifest",
            chunk_count: "0",
        });
        const orphaned = await deletedTail(deletedBlob, RecordType.assetMetadata, asset, {
            record_role: "material",
            blob_id: blob,
        });
        await expect(
            compactArchiveSnapshot(orphaned, { pruneUnreferencedAssets: true }),
        ).rejects.toMatchObject({ code: "archive_pruning_blob_missing" });
    });

    it("rejects invalid and equal-prefix index keys when rebuilding", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("key limits"));
        const manifestOffset = base
            .allIndexEntries()
            .get(primaryKey(RecordType.settings, base.header.id))!;

        const prefixKeys = await openArchiveBytes(
            await rebuildWithIndex(
                base,
                indexWith(base, (index) => {
                    index.set("X", manifestOffset);
                    index.set("XY", manifestOffset);
                }),
            ),
        );
        const compacted = await compactArchiveSnapshot(prefixKeys);
        expect(compacted.preservedRecords).toBeGreaterThan(0);
    });

    it("preserves guide source history when a guide cites nothing", async () => {
        const guide = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("guide history"));
        const first = await appendRecords(base, [
            record(RecordType.guide, guide, { title: "Empty" }),
        ]);
        const second = await appendRecords(first, [
            record(RecordType.guide, guide, { title: "Empty again" }),
        ]);
        const updated = await second.getRecord(RecordType.guide, guide);
        expect(updated?.fields.get("title")).toBe("Empty again");
    });
});

describe("backfill branches", () => {
    function proxySnapshot(
        snapshot: ArchiveSnapshot,
        overrides: {
            manifestFields?: Map<string, string>;
            index?: Map<string, bigint>;
            metadata?: (type: RecordTypeValue) => ArchiveRecord[] | undefined;
        },
    ): ArchiveSnapshot {
        const realGet = snapshot.getRecord.bind(snapshot);
        const realList = snapshot.listRecordMetadata.bind(snapshot);
        return new Proxy(snapshot, {
            get(target, property) {
                if (property === "getRecord") {
                    return async (type: RecordTypeValue, id: string) => {
                        if (overrides.manifestFields && type === RecordType.settings) {
                            return {
                                ...(await realGet(type, id))!,
                                fields: overrides.manifestFields,
                            };
                        }
                        return realGet(type, id);
                    };
                }
                if (property === "allIndexEntries") {
                    return () => overrides.index ?? target.allIndexEntries();
                }
                if (property === "listRecordMetadata") {
                    return async (type: RecordTypeValue, includeDeleted?: boolean) => {
                        const custom = overrides.metadata?.(type);
                        return custom ?? realList(type, includeDeleted);
                    };
                }
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as ArchiveSnapshot;
    }

    it("rejects a migration whose primary record disappeared", async () => {
        const student = newUuid();
        const session = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("lost migration record")),
            [
                record(RecordType.student, student, { display_name: "A" }),
                record(RecordType.session, session, { student_id: student }),
            ],
        );
        const manifest = await snapshot.getRecord(RecordType.settings, snapshot.header.id);
        const fields = new Map(manifest!.fields);
        for (const name of [
            "annotation_session_time_index_version",
            "student_session_index_version",
            "evidence_adjacency_index_version",
            "transcript_session_index_version",
            "audio_chunk_index_version",
        ]) {
            fields.set(name, "0");
        }
        const sessionRecord = (await snapshot.getRecord(RecordType.session, session))!;
        const index = indexWith(snapshot, (value) => {
            value.delete(primaryKey(RecordType.session, session));
        });
        const proxy = proxySnapshot(snapshot, {
            manifestFields: fields,
            index,
            metadata: (type) => (type === RecordType.session ? [sessionRecord] : undefined),
        });
        await expect(
            appendRecords(proxy, [record(RecordType.student, student, { display_name: "B" })]),
        ).rejects.toMatchObject({ code: "archive_secondary_index_migration_failed" });
    });

    it("records conflicting aliases and downgrades their version fields", async () => {
        const student = newUuid();
        const session = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("alias conflict")),
            [
                record(RecordType.student, student, { display_name: "A" }),
                record(RecordType.session, session, { student_id: student }),
            ],
        );
        const manifest = await snapshot.getRecord(RecordType.settings, snapshot.header.id);
        const fields = new Map(manifest!.fields);
        for (const name of [
            "annotation_session_time_index_version",
            "student_session_index_version",
            "evidence_adjacency_index_version",
            "transcript_session_index_version",
            "audio_chunk_index_version",
        ]) {
            fields.set(name, "0");
        }
        const manifestOffset = snapshot
            .allIndexEntries()
            .get(primaryKey(RecordType.settings, snapshot.header.id))!;
        const index = indexWith(snapshot, (value) => {
            value.set(`STUDENTSESSION:${student}:${session}`, manifestOffset);
        });
        const proxy = proxySnapshot(snapshot, { manifestFields: fields, index });
        const migrated = await appendRecords(proxy, [
            record(RecordType.student, student, { display_name: "B" }),
        ]);
        const updated = await migrated.getRecord(RecordType.settings, migrated.header.id);
        expect(updated?.fields.get("student_session_index_version")).toBe("0");
    });

    it("rejects backfill when the manifest is invalid", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("invalid manifest"));
        const bytes = await bytesOf(base);
        const offset = Number(
            base.allIndexEntries().get(primaryKey(RecordType.settings, base.header.id))!,
        );
        const frame = decodeRecordFrame(bytes.subarray(offset));
        const payload = frame.storedPayload.slice();
        const text = new TextEncoder().encode("archive-manifest");
        let found = -1;
        for (let cursor = 0; cursor <= payload.length - text.length; cursor += 1) {
            if (text.every((byte, index) => payload[cursor + index] === byte)) {
                found = cursor;
                break;
            }
        }
        expect(found).toBeGreaterThanOrEqual(0);
        payload.set(new TextEncoder().encode("invalid-manifest"), found);
        rewriteFrame(bytes, offset, payload);
        const patched = reopen(base, bytes);
        await expect(backfillArchiveSecondaryIndexes(patched)).rejects.toMatchObject({
            code: "archive_manifest_missing",
        });
    });
});

describe("index page decode limits", () => {
    async function withRootPayload(
        base: ArchiveSnapshot,
        payload: Uint8Array,
        rootOffset = Number(base.commit.rootOffset),
    ): Promise<{ snapshot: ArchiveSnapshot; commit: typeof base.commit }> {
        const bytes = await bytesOf(base);
        const frame = encodeRecordFrame(
            { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
            payload,
        );
        const required = rootOffset + frame.length;
        const grown = bytes.length >= required ? bytes : new Uint8Array(required);
        if (grown !== bytes) grown.set(bytes);
        grown.set(frame, rootOffset);
        const commit = {
            ...base.commit,
            rootOffset: BigInt(rootOffset),
            rootHash: await sha256(payload),
        };
        const snapshot = new ArchiveSnapshot(
            new MemoryArchiveSource(grown),
            base.header,
            commit,
            base.allIndexEntries(),
            base.publishedEndOffset,
        );
        return { snapshot, commit };
    }

    function pageHeader(
        kind: number,
        count: number,
        overrides: { version?: number } = {},
    ): number[] {
        return [
            0x54,
            0x58,
            0x50,
            0x47,
            (overrides.version ?? 1) & 0xff,
            Math.floor((overrides.version ?? 1) / 256) & 0xff,
            kind,
            0,
            count & 0xff,
            Math.floor(count / 256) & 0xff,
        ];
    }

    function keyBytes(value: string): number[] {
        const encoded = [...new TextEncoder().encode(value)];
        return [encoded.length & 0xff, Math.floor(encoded.length / 256) & 0xff, ...encoded];
    }

    function offsetBytes(value: bigint): number[] {
        const out: number[] = [];
        let remaining = value;
        for (let index = 0; index < 8; index += 1) {
            out.push(Number(remaining & 0xffn));
            remaining >>= 8n;
        }
        return out;
    }

    it("rejects invalid page fields and truncated offsets", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("page fields"));

        const badVersion = await withRootPayload(
            base,
            new Uint8Array(pageHeader(0, 0, { version: 2 })),
        );
        await expect(
            badVersion.snapshot.readVerifiedIndexTree(badVersion.commit),
        ).rejects.toMatchObject({ code: "index_page_invalid" });

        const truncatedOffset = await withRootPayload(
            base,
            new Uint8Array([...pageHeader(0, 1), ...keyBytes("abc")]),
        );
        await expect(
            truncatedOffset.snapshot.readVerifiedIndexTree(truncatedOffset.commit),
        ).rejects.toMatchObject({ code: "archive_truncated" });
    });

    it("rejects unordered internal separators and invalid child counts", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("page internal"));
        const child = Number(base.commit.rootOffset);
        const unordered = await withRootPayload(
            base,
            new Uint8Array([
                ...pageHeader(1, 2),
                ...offsetBytes(BigInt(child)),
                ...keyBytes("b"),
                ...offsetBytes(BigInt(child)),
                ...keyBytes("b"),
                ...offsetBytes(BigInt(child)),
            ]),
        );
        await expect(
            unordered.snapshot.readVerifiedIndexTree(unordered.commit),
        ).rejects.toMatchObject({ code: "index_page_order" });

        const noSeparators = await withRootPayload(
            base,
            new Uint8Array([...pageHeader(1, 0), ...offsetBytes(BigInt(child))]),
        );
        await expect(
            noSeparators.snapshot.readVerifiedIndexTree(noSeparators.commit),
        ).rejects.toMatchObject({ code: "index_page_invalid" });
    });

    it("rejects an index page at or beyond the commit offset", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("page outside"));
        const payload = new Uint8Array([...pageHeader(0, 0)]);
        const rootOffset = Number(base.commit.offset);
        const bytes = await bytesOf(base);
        const frame = encodeRecordFrame(
            { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
            payload,
        );
        const grown = new Uint8Array(Math.max(bytes.length, rootOffset + frame.length));
        grown.set(bytes);
        grown.set(frame, rootOffset);
        const commit = {
            ...base.commit,
            rootOffset: BigInt(rootOffset),
            rootHash: await sha256(payload),
        };
        const snapshot = new ArchiveSnapshot(
            new MemoryArchiveSource(grown),
            base.header,
            commit,
            base.allIndexEntries(),
            base.publishedEndOffset,
        );
        await expect(snapshot.readVerifiedIndexTree(commit)).rejects.toMatchObject({
            code: "index_page_invalid",
        });
    });

    it("validates encrypted index authentication", async () => {
        const passphrase = "correct horse battery";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("encrypted index", "", passphrase),
        );
        const snapshot = await locked.unlock(passphrase);
        const bytes = await bytesOf(snapshot);
        const rootOffset = Number(snapshot.commit.rootOffset);
        const frame = decodeRecordFrame(bytes.subarray(rootOffset));
        const realPayload = frame.storedPayload.slice();

        const truncatedPayload = new Uint8Array([1, 2, 3, 4]);
        const truncatedFrame = encodeRecordFrame(
            { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
            truncatedPayload,
        );
        const truncatedBytes = new Uint8Array(
            Math.max(bytes.length, rootOffset + truncatedFrame.length),
        );
        truncatedBytes.set(bytes);
        truncatedBytes.set(truncatedFrame, rootOffset);
        const truncatedCommit = {
            ...snapshot.commit,
            rootHash: await sha256(truncatedPayload),
        };
        const truncated = new ArchiveSnapshot(
            new MemoryArchiveSource(truncatedBytes),
            snapshot.header,
            truncatedCommit,
            snapshot.allIndexEntries(),
            snapshot.publishedEndOffset,
        );
        await expect(truncated.readVerifiedIndexTree(truncatedCommit)).rejects.toMatchObject({
            code: "archive_index_authentication_failed",
        });

        const tampered = realPayload.slice();
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
        const tamperedFrame = encodeRecordFrame(
            { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
            tampered,
        );
        const tamperedBytes = new Uint8Array(
            Math.max(bytes.length, rootOffset + tamperedFrame.length),
        );
        tamperedBytes.set(bytes);
        tamperedBytes.set(tamperedFrame, rootOffset);
        const tamperedCommit = { ...snapshot.commit, rootHash: await sha256(tampered) };
        const envelopeRecord = await snapshot.getRecord(RecordType.encryption, snapshot.header.id);
        const envelope = encryptionEnvelopeFromRecord(envelopeRecord!, snapshot.header.id);
        const key = await ArchiveDataKey.unwrap(passphrase, envelope, snapshot.header.id);
        const tamperedSnapshot = new ArchiveSnapshot(
            new MemoryArchiveSource(tamperedBytes),
            snapshot.header,
            tamperedCommit,
            snapshot.allIndexEntries(),
            snapshot.publishedEndOffset,
            key,
        );
        await expect(tamperedSnapshot.readVerifiedIndexTree(tamperedCommit)).rejects.toMatchObject({
            code: "archive_index_authentication_failed",
        });
    });
});

describe("streamed metadata and identifier guards", () => {
    it("rejects an inconsistent metadata blob length", async () => {
        const student = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("metadata blob"));
        const snapshot = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
        ]);
        const bytes = await bytesOf(snapshot);
        const offset = Number(
            snapshot.allIndexEntries().get(primaryKey(RecordType.student, student))!,
        );
        const frame = decodeRecordFrame(bytes.subarray(offset));
        const payload = new Uint8Array(frame.storedPayload.length + 4);
        payload.set(frame.storedPayload);
        rewriteFrame(bytes, offset, payload);
        const patched = reopen(snapshot, bytes);
        await expect(patched.listRecordMetadata(RecordType.student)).rejects.toMatchObject({
            code: "record_blob_invalid",
        });
    });

    it("rejects invalid record identifiers when encoding frames", () => {
        expect(() =>
            encodeRecordFrame(
                { type: RecordType.student, id: "not-a-uuid", revision: 1n, previousOffset: 0n },
                new Uint8Array(),
            ),
        ).toThrowError(ArchiveFormatError);
    });

    it("rejects mismatched digest lengths in index verification", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("digest length"));
        const commit = { ...base.commit, rootHash: new Uint8Array(16) };
        const snapshot = new ArchiveSnapshot(
            base.source,
            base.header,
            commit,
            base.allIndexEntries(),
            base.publishedEndOffset,
        );
        await expect(snapshot.readVerifiedIndexTree(commit)).rejects.toMatchObject({
            code: "archive_commit_root_invalid",
        });
    });
});

describe("wide scans and locator fallbacks", () => {
    it("scans trailing garbage for locators, commits, and chapter boundaries", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("large tail"));
        const bytes = await bytesOf(base);
        const garbage = new Uint8Array(70 * 1024 * 1024);
        garbage.set(new TextEncoder().encode("TXRC"), 8);
        const combined = new Uint8Array(bytes.length + garbage.length);
        combined.set(bytes);
        combined.set(garbage, bytes.length);
        const source: ArchiveByteSource = new MemoryArchiveSource(combined);
        const snapshot = await openArchiveBytes(combined);
        expect(snapshot.commit.generation).toBe(1n);

        await expect(recoverUnpublishedCommit(snapshot)).rejects.toMatchObject({
            code: "archive_recovery_not_available",
        });
        const inspection = await inspectArchiveRecovery(source);
        expect(inspection.trailingBytes).toBeGreaterThan(0n);
    }, 60_000);

    it("falls back to an earlier locator when a newer commit links to garbage", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("bad link"));
        const second = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const bytes = await bytesOf(second);
        const offset = Number(second.commit.offset);
        const frame = decodeRecordFrame(bytes.subarray(offset));
        const payload = frame.storedPayload.slice();
        new DataView(payload.buffer).setBigUint64(16, 8n, true);
        rewriteFrame(bytes, offset, payload, { previousOffset: 8n });
        const reopened = await openArchiveBytes(bytes);
        expect(reopened.commit.generation).toBe(1n);
    });

    it("skips a commit frame with a mismatched root when no locator exists", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("bad locator commit"));
        const bytes = (await bytesOf(base)).slice(0, -32);
        const commitFrame = decodeRecordFrame(bytes.subarray(Number(base.commit.offset)));
        const payload = commitFrame.storedPayload.slice();
        payload[32] = payload[32]! ^ 0xff;
        const bogus = encodeRecordFrame(
            { type: RecordType.commit, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
            payload,
        );
        const combined = new Uint8Array(bytes.length + bogus.length);
        combined.set(bytes);
        combined.set(bogus, bytes.length);
        const view = await openArchiveSourceForRecovery(new MemoryArchiveSource(combined));
        expect(view.commit.generation).toBe(1n);
    });

    it("advances across crash bytes before finding a publication locator", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("crash gap"));
        const bytes = await bytesOf(base);
        const locator = bytes.slice(-32);
        const commitEnd =
            Number(base.commit.offset) +
            decodeRecordFrame(bytes.subarray(Number(base.commit.offset))).endOffset;
        const gap = new Uint8Array(70_000);
        const combined = new Uint8Array(commitEnd + gap.length + locator.length);
        combined.set(bytes.subarray(0, commitEnd));
        combined.set(gap, commitEnd);
        combined.set(locator, commitEnd + gap.length);
        const snapshot = await openArchiveBytes(combined);
        const repaired = await repairArchiveSnapshot(snapshot);
        expect(repaired.selectedGeneration).toBe(1n);
    }, 30_000);
});
