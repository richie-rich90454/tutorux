import { afterEach, describe, expect, it, vi } from "vitest";
import {
    appendRecords,
    appendStagedAssetRecords,
    ArchiveSnapshot,
    backfillArchiveSecondaryIndexes,
    compactArchiveSnapshot,
    createArchiveBytes,
    createEncryptedArchiveBytes,
    inspectArchiveRecovery,
    openArchiveBytes,
    recoverUnpublishedCommit,
    repairArchiveSnapshot,
    verifyArchiveFull,
    type ArchiveSnapshot as Snapshot,
} from "../../../frontend/archive/archive";
import {
    compressRecordPayload,
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
import {
    createSanitizedCopy,
    previewSanitizedCopy,
} from "../../../frontend/archive/sanitized-copy";
import type { ArchiveStaging } from "../../../frontend/archive/staging";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

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

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function bytesOf(snapshot: Snapshot): Promise<Uint8Array> {
    return (await snapshot.source.read(0n, Number(snapshot.source.size))).slice();
}

async function emptyArchive(name: string): Promise<Snapshot> {
    return openArchiveBytes(await createArchiveBytes(name));
}

function rewriteFrame(
    bytes: Uint8Array,
    offset: number,
    payload: Uint8Array,
    meta: { previousOffset?: bigint; revision?: bigint } = {},
): void {
    const frame = decodeRecordFrame(bytes.subarray(offset));
    bytes.set(
        encodeRecordFrame(
            {
                type: frame.type,
                id: frame.id,
                revision: meta.revision ?? frame.revision,
                previousOffset: meta.previousOffset ?? frame.previousOffset,
            },
            payload,
            frame.codec,
            frame.flags,
        ),
        offset,
    );
}

function patchFieldKeys(
    bytes: Uint8Array,
    offset: number,
    rename: (payload: Uint8Array, payloadOffset: number) => void,
): void {
    const frame = decodeRecordFrame(bytes.subarray(offset));
    const payload = frame.storedPayload.slice();
    rename(payload, offset);
    rewriteFrame(bytes, offset, payload);
}

/** Reopen immutable bytes with a chosen index view (and optional ordered iteration). */
function reopen(
    template: Snapshot,
    bytes: Uint8Array,
    index: ReadonlyMap<string, bigint> = template.allIndexEntries(),
    header = template.header,
    commit = template.commit,
    publishedEndOffset = template.publishedEndOffset,
): Snapshot {
    return new ArchiveSnapshot(
        new MemoryArchiveSource(bytes),
        header,
        commit,
        index,
        publishedEndOffset,
    );
}

function orderedIndex(snapshot: Snapshot, keys: readonly string[]): Map<string, bigint> {
    const index = new Map<string, bigint>();
    for (const key of keys) {
        const offset = snapshot.allIndexEntries().get(key);
        if (offset !== undefined) index.set(key, offset);
    }
    return index;
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
    view.setUint32(24, crc32Local(locator.subarray(0, 24)), true);
    view.setUint32(28, 0, true);
    return locator;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let byte = 0; byte < table.length; byte += 1) {
        let value = byte;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
        }
        table[byte] = value >>> 0;
    }
    return table;
})();

function crc32Local(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
    return ~crc >>> 0;
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

/** Replace the root index page and keep the commit hash in sync. */
async function rebuildWithIndex(
    base: Snapshot,
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
    const commitFrame = decodeRecordFrame(source.subarray(Number(base.commit.offset)));
    const commitPayload = commitFrame.storedPayload.slice();
    new DataView(commitPayload.buffer).setBigUint64(24, BigInt(rootOffset), true);
    commitPayload.set(await sha256(payload), 32);
    const replacement = encodeRecordFrame(
        {
            type: commitFrame.type,
            id: commitFrame.id,
            revision: commitFrame.revision,
            previousOffset: commitFrame.previousOffset,
        },
        commitPayload,
        commitFrame.codec,
        commitFrame.flags,
    );
    const locator = encodeLocatorBytes(
        BigInt(rootOffset + rootFrame.length),
        base.commit.generation,
    );
    const output = new Uint8Array(
        rootOffset + rootFrame.length + replacement.length + locator.length,
    );
    output.set(source.subarray(0, rootOffset));
    output.set(rootFrame, rootOffset);
    output.set(replacement, rootOffset + rootFrame.length);
    output.set(locator, rootOffset + rootFrame.length + replacement.length);
    return output;
}

function encodeCommitPayloadForTest(input: {
    generation: bigint;
    previousOffset: bigint;
    rootOffset: bigint;
    rootHash?: Uint8Array;
    recordCount?: bigint;
}): Uint8Array {
    const payload = new Uint8Array(92);
    const view = new DataView(payload.buffer);
    payload.set(new TextEncoder().encode("TXCM"), 0);
    view.setUint16(4, 1, true);
    view.setBigUint64(8, input.generation, true);
    view.setBigUint64(16, input.previousOffset, true);
    view.setBigUint64(24, input.rootOffset, true);
    payload.set(input.rootHash ?? new Uint8Array(32), 32);
    payload.set(uuidBytes(newUuid()), 64);
    view.setBigUint64(80, input.recordCount ?? 0n, true);
    view.setUint32(88, 1, true);
    return payload;
}

function uuidBytes(value: string): Uint8Array {
    const compact = value.replaceAll("-", "");
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) {
        bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("manifest fallbacks", () => {
    it("defaults missing description and creation time", async () => {
        const base = await emptyArchive("manifest fallback");
        const updated = await appendRecords(base, [
            record(RecordType.settings, base.header.id, { record_role: "archive-manifest" }),
        ]);
        const manifest = await updated.getManifest();
        expect(manifest.description).toBe("");
        expect(manifest.createdAtUs).toBe(base.header.createdAtUs.toString());
    });
});

describe("audio chunk metadata branches", () => {
    it("reads encrypted chunk metadata and orders numeric sequences", async () => {
        const passphrase = "encrypted audio metadata passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("encrypted audio", "", passphrase),
        );
        const unlocked = await locked.unlock(passphrase);
        const session = newUuid();
        const track = newUuid();
        const first = newUuid();
        const second = newUuid();
        const snapshot = await appendRecords(unlocked, [
            record(RecordType.session, session, { student_id: "anonymous" }),
            record(RecordType.audioChunk, first, {
                session_id: session,
                track_id: track,
                sequence_number: "1",
            }),
            record(RecordType.audioChunk, second, {
                session_id: session,
                track_id: track,
                sequence_number: "2",
            }),
        ]);
        const chunks = await snapshot.listAudioChunkMetadata(session, track);
        expect(chunks.map((chunk) => chunk.id)).toEqual([first, second]);
        snapshot.lock();
        unlocked.lock();
    });

    it("skips audio index keys with no target and rejects a missing sequence", async () => {
        const session = newUuid();
        const track = newUuid();
        const chunk = newUuid();
        const base = await emptyArchive("audio index gaps");
        const snapshot = await appendRecords(base, [
            record(RecordType.session, session, { student_id: "anonymous" }),
            record(RecordType.audioChunk, chunk, {
                session_id: session,
                track_id: track,
                sequence_number: "1",
            }),
        ]);
        const ghost = `AUDIOSESSION:${session}:${track}:00000000000000000002`;
        const backing = new Map(snapshot.allIndexEntries());
        const sparse = {
            get size() {
                return backing.size + 1;
            },
            get(key: string) {
                return key === ghost ? undefined : backing.get(key);
            },
            has(key: string) {
                return key === ghost || backing.has(key);
            },
            keys() {
                return [...backing.keys(), ghost][Symbol.iterator]();
            },
            values() {
                return backing.values();
            },
            entries() {
                return backing.entries();
            },
            forEach(callback: (value: bigint, key: string) => void) {
                backing.forEach(callback);
            },
            [Symbol.iterator]() {
                return backing[Symbol.iterator]();
            },
        } as ReadonlyMap<string, bigint>;
        const view = reopen(snapshot, await bytesOf(snapshot), sparse);
        expect(await view.listAudioChunkMetadata(session, track)).toHaveLength(1);

        const bytes = await bytesOf(snapshot);
        const offset = Number(
            snapshot.allIndexEntries().get(primaryKey(RecordType.audioChunk, chunk)),
        );
        patchFieldKeys(bytes, offset, (payload) => {
            const text = new TextEncoder().encode("sequence_number");
            for (let index = 0; index + text.length <= payload.length; index += 1) {
                if (text.every((byte, i) => payload[index + i] === byte)) {
                    payload.set(new TextEncoder().encode("sequence_numbex"), index);
                    return;
                }
            }
            throw new Error("sequence field not found");
        });
        const broken = await openArchiveBytes(bytes);
        await expect(broken.listAudioChunkMetadata(session, track)).rejects.toMatchObject({
            code: "audio_chunk_metadata_invalid",
        });
    });
});

describe("verification field fallbacks", () => {
    it("reports live and historical records with missing optional fields", async () => {
        const blobPlain = newUuid();
        const blobHashOnly = newUuid();
        const blobSizeOnly = newUuid();
        const asset = newUuid();
        const edge = newUuid();
        const transcript = newUuid();
        const assetHistory = newUuid();
        const blobHistory = newUuid();
        const blobNoRole = newUuid();
        const edgeHistory = newUuid();
        const blobNoCount = newUuid();
        const manifestMissingId = newUuid();
        const chunkMissingId = newUuid();
        const manifestMissingIndex = newUuid();
        const chunkMissingIndex = newUuid();
        const contentHash = hex(new Uint8Array(32).fill(0x11));

        const base = await emptyArchive("field fallbacks");
        const first = await appendRecords(base, [
            record(RecordType.transcriptSegment, transcript, {
                session_id: newUuid(),
            }),
            record(RecordType.assetMetadata, assetHistory, { record_role: "material" }),
            record(RecordType.assetBlob, blobHistory, {
                record_role: "asset-blob-manifest",
                chunk_count: "not-a-count",
            }),
            record(RecordType.assetBlob, blobNoRole, {}),
            record(RecordType.evidenceEdge, edgeHistory, { to_id: newUuid() }),
        ]);
        const snapshot = await appendRecords(first, [
            record(RecordType.transcriptSegment, transcript, {}),
            record(RecordType.assetMetadata, assetHistory, {
                record_role: "material",
                blob_id: blobPlain,
            }),
            record(RecordType.assetBlob, blobHistory, { record_role: "asset-blob" }),
            record(RecordType.assetBlob, blobNoRole, { record_role: "asset-blob" }),
            record(RecordType.evidenceEdge, edgeHistory, {
                from_id: newUuid(),
                to_id: newUuid(),
            }),
            record(RecordType.assetBlob, blobNoCount, {
                record_role: "asset-blob-manifest",
                chunk_ids: "",
            }),
            record(RecordType.assetBlob, chunkMissingId, {
                record_role: "asset-blob-chunk",
                chunk_index: "0",
            }),
            record(RecordType.assetBlob, manifestMissingId, {
                record_role: "asset-blob-manifest",
                chunk_count: "1",
                chunk_ids: chunkMissingId,
            }),
            record(RecordType.assetBlob, chunkMissingIndex, {
                record_role: "asset-blob-chunk",
                manifest_id: manifestMissingIndex,
            }),
            record(RecordType.assetBlob, manifestMissingIndex, {
                record_role: "asset-blob-manifest",
                chunk_count: "1",
                chunk_ids: chunkMissingIndex,
            }),
            record(RecordType.assetBlob, blobPlain, {}),
            record(RecordType.assetBlob, blobHashOnly, {
                record_role: "asset-blob-manifest",
                chunk_count: "0",
                content_hash: contentHash,
            }),
            record(RecordType.assetBlob, blobSizeOnly, {
                record_role: "asset-blob-manifest",
                chunk_count: "0",
                byte_size: "5",
            }),
            record(RecordType.assetMetadata, asset, { blob_id: blobPlain }),
            record(RecordType.assetMetadata, newUuid(), { blob_id: newUuid() }),
            record(RecordType.evidenceEdge, edge, { to_id: newUuid() }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        const issues = report.issues.join("\n");
        expect(issues).toContain("Historical revision");
        expect(issues).toContain("Historical asset blob manifest");
        expect(issues).toContain("references a missing evidence node");
        expect(issues).toContain("content does not match its hash");
        expect(issues).toContain("references a missing blob");
        expect(issues).toContain("manifest chunk count is invalid");
        expect(issues).toContain("manifest references missing or inconsistent chunks");
    });
});

describe("guide semantics branches", () => {
    it("covers guide scope, missing fields, and source resolution shapes", async () => {
        const student = newUuid();
        const sessionA = newUuid();
        const sessionB = newUuid();
        const entry = newUuid();
        const notesByEntry = newUuid();
        const notesBySession = newUuid();
        const notesUnscoped = newUuid();
        const annotationA = newUuid();
        const annotationB = newUuid();
        const transcript = newUuid();
        const assetSessionOnly = newUuid();
        const assetStudentOnly = newUuid();
        const assetNeither = newUuid();
        const guideA = newUuid();
        const guideB = newUuid();
        const guideCount = newUuid();
        const guideKind = newUuid();

        const snapshot = await appendRecords(await emptyArchive("guide semantics"), [
            record(RecordType.student, student, { display_name: "Mina" }),
            record(RecordType.session, sessionA, { student_id: student, entry_id: entry }),
            record(RecordType.session, sessionB, { student_id: student }),
            record(RecordType.settings, entry, {
                record_role: "journal-entry",
                session_ids: sessionA,
            }),
            record(RecordType.settings, notesByEntry, {
                record_role: "journal-notes",
                entry_id: entry,
            }),
            record(RecordType.settings, notesBySession, {
                record_role: "journal-notes",
                session_id: sessionA,
            }),
            record(RecordType.settings, notesUnscoped, { record_role: "journal-notes" }),
            record(RecordType.annotation, annotationA, { session_id: sessionA }),
            record(RecordType.annotation, annotationB, { session_id: sessionB }),
            record(RecordType.transcriptSegment, transcript, {}),
            record(RecordType.assetMetadata, assetSessionOnly, { session_id: sessionA }),
            record(RecordType.assetMetadata, assetStudentOnly, { student_id: student }),
            record(RecordType.assetMetadata, assetNeither, {}),
            record(RecordType.guide, guideA, {
                title: "A",
                entry_id: entry,
                session_id: sessionB,
                section_count: "1",
                "section.0.heading": "Scope",
                "section.0.block_count": "1",
                "section.0.block.0.source_ids":
                    `${annotationB},${notesByEntry},${notesBySession},${notesUnscoped},` +
                    `${assetSessionOnly},${assetStudentOnly},${transcript},${assetNeither}`,
            }),
            record(RecordType.guide, guideB, {
                title: "B",
                entry_id: entry,
                section_count: "1",
                "section.0.heading": "Notes",
                "section.0.block_count": "1",
                "section.0.block.0.source_ids": notesBySession,
            }),
            record(RecordType.guide, guideCount, { title: "Count" }),
            record(RecordType.guide, guideKind, {
                title: "Kind",
                session_id: sessionA,
                section_count: "1",
                "section.0.heading": "No kind",
                "section.0.block_count": "1",
            }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        const issues = report.issues.join("\n");
        expect(issues).toContain("guide section count is invalid");
        expect(issues).toContain("kind is required");
        expect(issues).toContain("does not resolve to a live archive record");
    });
});

describe("shared revision frames and duplicate index iteration", () => {
    it("notes a shared revision frame during full verification", async () => {
        const first = newUuid();
        const second = newUuid();
        const base = await emptyArchive("shared frames");
        const one = await appendRecords(base, [
            record(RecordType.student, first, { display_name: "A" }),
        ]);
        const two = await appendRecords(one, [
            record(RecordType.student, first, { display_name: "A2" }),
            record(RecordType.student, second, { display_name: "B" }),
        ]);
        const firstOffset = two.allIndexEntries().get(primaryKey(RecordType.student, first))!;
        const firstRevision = (await two.getRecord(RecordType.student, first))!.previousOffset;
        const secondOffset = Number(
            two.allIndexEntries().get(primaryKey(RecordType.student, second)),
        );
        const bytes = await bytesOf(two);
        const secondFrame = decodeRecordFrame(bytes.subarray(secondOffset));
        rewriteFrame(bytes, secondOffset, secondFrame.storedPayload, {
            previousOffset: firstRevision,
        });
        const index = orderedIndex(two, [
            primaryKey(RecordType.student, first),
            primaryKey(RecordType.student, second),
            primaryKey(RecordType.settings, two.header.id),
        ]);
        const report = await verifyArchiveFull(reopen(two, bytes, index));
        expect(report.valid).toBe(false);
        expect(report.issues.join(" ")).toContain("cycle or shared frame");
        expect(firstOffset).toBeGreaterThan(0n);
    });

    it("ignores a repeated primary index key during full verification", async () => {
        const id = newUuid();
        const snapshot = await appendRecords(await emptyArchive("duplicate index keys"), [
            record(RecordType.student, id, { display_name: "A" }),
        ]);
        const backing = snapshot.allIndexEntries();
        const key = primaryKey(RecordType.student, id);
        const offset = backing.get(key)!;
        const duplicated = {
            get size() {
                return backing.size + 1;
            },
            get(name: string) {
                return backing.get(name);
            },
            has(name: string) {
                return backing.has(name);
            },
            keys() {
                return backing.keys();
            },
            values() {
                return backing.values();
            },
            entries() {
                return backing.entries();
            },
            forEach(callback: (value: bigint, name: string) => void) {
                backing.forEach(callback);
            },
            *[Symbol.iterator]() {
                yield* backing;
                yield [key, offset] as [string, bigint];
            },
        } as ReadonlyMap<string, bigint>;
        const report = await verifyArchiveFull(
            reopen(snapshot, await bytesOf(snapshot), duplicated),
        );
        expect(report.issues.join(" ")).toContain("Authenticated index does not match");
    });
});

describe("recovery branch edges", () => {
    function commitEnd(snapshot: Snapshot, bytes: Uint8Array): number {
        return (
            Number(snapshot.commit.offset) +
            decodeRecordFrame(bytes.subarray(Number(snapshot.commit.offset))).endOffset
        );
    }

    it("stops at a later unpublished generation with a wrong record count", async () => {
        const base = await emptyArchive("recovery count stop");
        const second = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const third = await appendRecords(second, [
            record(RecordType.session, newUuid(), { student_id: newUuid() }),
        ]);
        const bytes = await bytesOf(third);
        bytes.fill(0, commitEnd(second, bytes), commitEnd(second, bytes) + 32);
        const thirdCommit = decodeRecordFrame(bytes.subarray(Number(third.commit.offset)));
        const payload = thirdCommit.storedPayload.slice();
        new DataView(payload.buffer).setBigUint64(80, 99n, true);
        rewriteFrame(bytes, Number(third.commit.offset), payload);
        bytes.fill(0, commitEnd(third, bytes), commitEnd(third, bytes) + 32);
        const reopened = await openArchiveBytes(bytes);
        const recovered = await recoverUnpublishedCommit(reopened);
        expect(recovered.recoveredGenerations).toBe(1);
        expect(recovered.recoveredGeneration).toBe(2n);
    });

    it("rethrows a verification failure from the first unpublished generation", async () => {
        const base = await emptyArchive("recovery first failure");
        const second = await appendRecords(base, [
            record(RecordType.session, newUuid(), { student_id: newUuid() }),
        ]);
        const bytes = await bytesOf(second);
        bytes.fill(0, commitEnd(second, bytes), commitEnd(second, bytes) + 32);
        const reopened = await openArchiveBytes(bytes.subarray(0, commitEnd(second, bytes)));
        await expect(recoverUnpublishedCommit(reopened)).rejects.toMatchObject({
            code: "archive_recovery_validation_failed",
        });
    });

    it("stringifies non-Error recovery header failures and inspects commit frames", async () => {
        const base = await emptyArchive("recovery non-error");
        const bytes = await bytesOf(base);
        const damaged = bytes.slice();
        damaged[60] = (damaged[60] ?? 0) ^ 0xff;
        vi.spyOn(ArchiveSnapshot.prototype, "verifyEncryptionAuthentication").mockRejectedValueOnce(
            "suffix failure",
        );
        const suffixInspection = await inspectArchiveRecovery(new MemoryArchiveSource(damaged));
        expect(suffixInspection.issues.join(" ")).toContain("suffix failure");

        let headerCalls = 0;
        const throwingHeader: ArchiveByteSource = {
            size: BigInt(bytes.length),
            read: async (offset, length) => {
                headerCalls += 1;
                if (headerCalls === 1) throw "header failure";
                return bytes.subarray(Number(offset), Number(offset) + length);
            },
        };
        const headerInspection = await inspectArchiveRecovery(throwingHeader);
        expect(headerInspection.issues).toContain("header failure");

        const tail: Uint8Array[] = [];
        const rootOffset = base.commit.rootOffset;
        for (const generation of [2n, 1n]) {
            const payload = encodeCommitPayloadForTest({
                generation,
                previousOffset: 0n,
                rootOffset,
            });
            tail.push(
                encodeRecordFrame(
                    {
                        type: RecordType.commit,
                        id: ZERO_UUID,
                        revision: generation,
                        previousOffset: 0n,
                    },
                    payload,
                ),
            );
        }
        const withTail = new Uint8Array(bytes.length + tail.reduce((n, p) => n + p.length, 0));
        withTail.set(bytes);
        let cursor = bytes.length;
        for (const part of tail) {
            withTail.set(part, cursor);
            cursor += part.length;
        }
        const inspection = await inspectArchiveRecovery(new MemoryArchiveSource(withTail));
        expect(inspection.candidateGeneration).toBe(2n);
    });

    it("refuses a recovery chain longer than the safety limit", async () => {
        const base = await emptyArchive("recovery limit");
        const bytes = await bytesOf(base);
        const frames: Uint8Array[] = [];
        let previousOffset = base.commit.offset;
        for (let generation = 2n; generation <= 1026n; generation += 1n) {
            const payload = encodeCommitPayloadForTest({
                generation,
                previousOffset,
                rootOffset: base.commit.rootOffset,
                rootHash: base.commit.rootHash,
                recordCount: 0n,
            });
            const frame = encodeRecordFrame(
                {
                    type: RecordType.commit,
                    id: ZERO_UUID,
                    revision: generation,
                    previousOffset,
                },
                payload,
            );
            frames.push(frame);
            previousOffset = BigInt(
                bytes.length + frames.reduce((n, f) => n + f.length, 0) - frame.length,
            );
        }
        const total = frames.reduce((length, frame) => length + frame.length, 0);
        const extended = new Uint8Array(bytes.length + total);
        extended.set(bytes);
        let cursor = bytes.length;
        for (const frame of frames) {
            extended.set(frame, cursor);
            cursor += frame.length;
        }
        const snapshot = await openArchiveBytes(extended);
        const realDigest = crypto.subtle.digest.bind(crypto.subtle);
        const cache = new Map<string, ArrayBuffer>();
        vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
            const bytes =
                data instanceof ArrayBuffer
                    ? new Uint8Array(data)
                    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const key = hex(bytes);
            const cached = cache.get(key);
            if (cached) return cached;
            const digest = await realDigest(algorithm, data);
            cache.set(key, digest);
            return digest;
        });
        await expect(recoverUnpublishedCommit(snapshot)).rejects.toMatchObject({
            code: "archive_recovery_generation_limit",
        });
    }, 600_000);

    it("stringifies a non-Error thrown while recovering an unpublished generation", async () => {
        const base = await emptyArchive("recovery non-error candidate");
        const second = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const bytes = await bytesOf(second);
        bytes.fill(0, commitEnd(second, bytes), commitEnd(second, bytes) + 32);
        vi.spyOn(ArchiveSnapshot.prototype, "openGeneration").mockRejectedValueOnce(
            "generation failure",
        );
        const inspection = await inspectArchiveRecovery(new MemoryArchiveSource(bytes));
        expect(inspection.issues).toContain("generation failure");
    });
});

describe("repair commit chain edges", () => {
    it("reports a non-consecutive previous generation", async () => {
        const base = await emptyArchive("repair non-consecutive");
        const bytes = await bytesOf(base);
        const aOffset = Number(base.commit.offset);
        const aFrame = decodeRecordFrame(bytes.subarray(aOffset));
        const aPayload = aFrame.storedPayload.slice();
        new DataView(aPayload.buffer).setBigUint64(8, 5n, true);
        rewriteFrame(bytes, aOffset, aPayload, { revision: 5n });
        const bOffset = bytes.length;
        const bPayload = encodeCommitPayloadForTest({
            generation: 7n,
            previousOffset: BigInt(aOffset),
            rootOffset: base.commit.rootOffset,
            rootHash: base.commit.rootHash,
        });
        const bFrame = encodeRecordFrame(
            {
                type: RecordType.commit,
                id: ZERO_UUID,
                revision: 7n,
                previousOffset: BigInt(aOffset),
            },
            bPayload,
        );
        const extended = new Uint8Array(bytes.length + bFrame.length);
        extended.set(bytes);
        extended.set(bFrame, bytes.length);
        const snapshot = new ArchiveSnapshot(
            new MemoryArchiveSource(extended),
            base.header,
            {
                generation: 7n,
                offset: BigInt(bOffset),
                previousOffset: BigInt(aOffset),
                rootOffset: base.commit.rootOffset,
                rootHash: base.commit.rootHash,
                transactionId: base.commit.transactionId,
                recordCount: base.commit.recordCount,
            },
            base.allIndexEntries(),
        );
        await expect(repairArchiveSnapshot(snapshot)).rejects.toMatchObject({
            code: "archive_repair_no_verified_generation",
            message: expect.stringContaining("consecutive"),
        });
    });

    it("reports an unreadable previous commit", async () => {
        const base = await emptyArchive("repair unreadable");
        const bytes = await bytesOf(base);
        const bOffset = bytes.length;
        const bPayload = encodeCommitPayloadForTest({
            generation: 2n,
            previousOffset: 64n,
            rootOffset: base.commit.rootOffset,
            rootHash: base.commit.rootHash,
        });
        const bFrame = encodeRecordFrame(
            {
                type: RecordType.commit,
                id: ZERO_UUID,
                revision: 2n,
                previousOffset: 64n,
            },
            bPayload,
        );
        const extended = new Uint8Array(bytes.length + bFrame.length);
        extended.set(bytes);
        extended.set(bFrame, bytes.length);
        const snapshot = new ArchiveSnapshot(
            new MemoryArchiveSource(extended),
            base.header,
            {
                generation: 2n,
                offset: BigInt(bOffset),
                previousOffset: 64n,
                rootOffset: base.commit.rootOffset,
                rootHash: base.commit.rootHash,
                transactionId: base.commit.transactionId,
                recordCount: base.commit.recordCount,
            },
            base.allIndexEntries(),
        );
        await expect(repairArchiveSnapshot(snapshot)).rejects.toMatchObject({
            code: "archive_repair_no_verified_generation",
        });
    });
});

describe("encryption branch edges", () => {
    it("rejects re-keying with trailing data using the re-key message", async () => {
        const passphrase = "trailing encrypted passphrase";
        const base = await openArchiveBytes(
            await createEncryptedArchiveBytes("trailing rekey", "", passphrase),
        );
        const unlocked = await base.unlock(passphrase);
        const bytes = await bytesOf(unlocked);
        const withTail = new Uint8Array(bytes.length + 8);
        withTail.set(bytes);
        const dirty = await openArchiveBytes(withTail);
        const dirtyUnlocked = await dirty.unlock(passphrase);
        await expect(
            dirtyUnlocked.changePassphrase(passphrase, "another strong passphrase"),
        ).rejects.toMatchObject({
            code: "archive_recovery_required",
            message: expect.stringContaining("passphrase"),
        });
        dirtyUnlocked.lock();
        unlocked.lock();
    });

    it("rejects missing manifest and envelope records mid-operation", async () => {
        const passphrase = "missing records passphrase";
        const plain = await emptyArchive("missing manifest mid");
        const realGet = plain.getRecord.bind(plain);
        plain.getRecord = async (type: number, id: string) =>
            type === RecordType.settings && id.toLowerCase() === plain.header.id
                ? null
                : realGet(type, id);
        await expect(plain.enableEncryption(passphrase)).rejects.toMatchObject({
            code: "archive_metadata_missing",
        });

        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("missing envelope mid", "", passphrase),
        );
        const unlocked = await locked.unlock(passphrase);
        const realUnlockedGet = unlocked.getRecord.bind(unlocked);
        unlocked.getRecord = async (type: number, id: string) =>
            type === RecordType.encryption && id.toLowerCase() === unlocked.header.id
                ? null
                : realUnlockedGet(type, id);
        await expect(
            unlocked.changePassphrase(passphrase, "another strong passphrase"),
        ).rejects.toMatchObject({ code: "archive_encryption_metadata_missing" });
        unlocked.lock();
    });

    it("rejects an unsupported manifest after full verification", async () => {
        const plain = await emptyArchive("invalid manifest mid");
        const realGet = plain.getRecord.bind(plain);
        let settingsCalls = 0;
        plain.getRecord = async (type: number, id: string) => {
            if (type === RecordType.settings && id.toLowerCase() === plain.header.id) {
                settingsCalls += 1;
                if (settingsCalls === 1) {
                    return {
                        type,
                        id,
                        revision: 1n,
                        previousOffset: 0n,
                        fields: new Map([["record_role", "bogus"]]),
                        blob: new Uint8Array(),
                    };
                }
            }
            return realGet(type, id);
        };
        await expect(plain.enableEncryption("valid manifest passphrase")).rejects.toMatchObject({
            code: "archive_manifest_missing",
        });
    });
});

describe("compaction branch edges", () => {
    it("rejects conflicting BLOB aliases", async () => {
        const contentHash = "a".repeat(64);
        const snapshot = await appendRecords(await emptyArchive("blob alias conflict"), [
            record(RecordType.assetBlob, newUuid(), { content_hash: contentHash }),
            record(RecordType.assetBlob, newUuid(), { content_hash: contentHash }),
        ]);
        await expect(compactArchiveSnapshot(snapshot)).rejects.toMatchObject({
            code: "archive_compaction_index_conflict",
        });
    });

    it("rejects custom index keys whose target is not retained", async () => {
        const base = await emptyArchive("custom index target");
        const index = new Map(base.allIndexEntries());
        index.set(`CUSTOM:${newUuid()}`, base.commit.rootOffset);
        const withCustom = await openArchiveBytes(await rebuildWithIndex(base, index));
        await expect(compactArchiveSnapshot(withCustom)).rejects.toMatchObject({
            code: "archive_compaction_index_unreachable",
        });
    });

    it("rejects opaque chains whose revisions go backwards", async () => {
        const id = newUuid();
        const base = await emptyArchive("opaque revision order");
        const first = await appendRecords(base, [record(99, id, { label: "first" })]);
        const snapshot = await appendRecords(first, [record(99, id, { label: "second" })]);
        const firstOffset = Number(first.allIndexEntries().get(`UNKNOWN:${id}`));
        const secondOffset = Number(snapshot.allIndexEntries().get(`UNKNOWN:${id}`));
        const bytes = await bytesOf(snapshot);
        const firstFrame = decodeRecordFrame(bytes.subarray(firstOffset));
        rewriteFrame(bytes, firstOffset, firstFrame.storedPayload, { revision: 2n });
        const secondFrame = decodeRecordFrame(bytes.subarray(secondOffset));
        rewriteFrame(bytes, secondOffset, secondFrame.storedPayload, {
            revision: 1n,
            previousOffset: BigInt(firstOffset),
        });
        const index = new Map(snapshot.allIndexEntries());
        index.delete(`UNKNOWN:${id}`);
        index.set(`FUTURE:${id}`, BigInt(secondOffset));
        const crafted = await openArchiveBytes(await rebuildWithIndex(snapshot, index, bytes));
        await expect(compactArchiveSnapshot(crafted)).rejects.toMatchObject({
            code: "revision_lineage_invalid",
        });
    });

    it("rejects historical material revisions without a blob reference", async () => {
        const materialId = newUuid();
        const blobId = newUuid();
        const digest = hex(await sha256(new Uint8Array()));
        const base = await emptyArchive("pruning historical blob");
        const first = await appendRecords(base, [
            record(RecordType.assetMetadata, materialId, {
                _deleted: "true",
                record_role: "audio-track",
            }),
        ]);
        const snapshot = await appendRecords(first, [
            record(RecordType.assetBlob, blobId, { record_role: "asset-blob" }),
            record(RecordType.assetMetadata, materialId, {
                record_role: "material",
                blob_id: blobId,
                byte_size: "0",
                content_hash: digest,
            }),
        ]);
        await expect(
            compactArchiveSnapshot(snapshot, { pruneUnreferencedAssets: true }),
        ).rejects.toMatchObject({ code: "archive_pruning_reference_invalid" });
    });

    it("reports a source that changes while compaction reads record payloads", async () => {
        const id = newUuid();
        const snapshot = await appendRecords(await emptyArchive("changing compaction"), [
            record(RecordType.student, id, { display_name: "A" }),
        ]);
        const offset = Number(snapshot.allIndexEntries().get(primaryKey(RecordType.student, id)));
        const bytes = await bytesOf(snapshot);
        const frame = decodeRecordFrame(bytes.subarray(offset));
        const payloadOffset = offset + 64;
        const original = snapshot.source;
        let payloadReads = 0;
        const changing: ArchiveByteSource = {
            size: original.size,
            async read(readOffset, length) {
                const value = await original.read(readOffset, length);
                if (readOffset === BigInt(payloadOffset) && length === frame.payloadLength) {
                    payloadReads += 1;
                    if (payloadReads > 1) return value.subarray(0, value.byteLength - 1);
                }
                return value;
            },
        };
        const view = new ArchiveSnapshot(
            changing,
            snapshot.header,
            snapshot.commit,
            snapshot.allIndexEntries(),
            snapshot.publishedEndOffset,
        );
        await expect(compactArchiveSnapshot(view)).rejects.toMatchObject({
            code: "archive_compaction_verification_failed",
            message: expect.stringContaining("source archive changed"),
        });
    });
});

describe("backfill branch edges", () => {
    it("rejects a primary index entry whose record cannot be read", async () => {
        const student = newUuid();
        const snapshot = await appendRecords(await emptyArchive("backfill missing record"), [
            record(RecordType.student, student, { display_name: "A" }),
        ]);
        const realGet = snapshot.getRecord.bind(snapshot);
        snapshot.getRecord = async (type: number, id: string) =>
            type === RecordType.student && id.toLowerCase() === student ? null : realGet(type, id);
        await expect(backfillArchiveSecondaryIndexes(snapshot)).rejects.toMatchObject({
            code: "record_index_mismatch",
        });
    });

    it("rejects an invalid manifest discovered after the verification scan", async () => {
        const snapshot = await emptyArchive("backfill invalid manifest");
        const realGet = snapshot.getRecord.bind(snapshot);
        const realManifest = await realGet(RecordType.settings, snapshot.header.id);
        let settingsCalls = 0;
        snapshot.getRecord = async (type: number, id: string) => {
            if (type === RecordType.settings && id.toLowerCase() === snapshot.header.id) {
                settingsCalls += 1;
                if (settingsCalls > 1) return { ...realManifest!, fields: new Map() };
            }
            return realGet(type, id);
        };
        await expect(backfillArchiveSecondaryIndexes(snapshot)).rejects.toMatchObject({
            code: "archive_manifest_missing",
        });
    });
});

describe("append branch edges", () => {
    it("reads missing audio identity fields and rejects identity changes", async () => {
        const id = newUuid();
        const base = await emptyArchive("audio identity change");
        const session = newUuid();
        const track = newUuid();
        const snapshot = await appendRecords(base, [
            record(RecordType.session, session, { student_id: "anonymous" }),
            record(RecordType.audioChunk, id, {
                session_id: session,
                track_id: track,
                sequence_number: "1",
            }),
        ]);
        await expect(
            appendRecords(snapshot, [record(RecordType.audioChunk, id, {})]),
        ).rejects.toMatchObject({ code: "audio_chunk_identity_immutable" });
    });

    it("rejects indexes with invalid key lengths during tree building", async () => {
        const snapshot = await emptyArchive("long index key");
        const index = new Map(snapshot.allIndexEntries());
        index.set("x".repeat(193), snapshot.commit.offset);
        const proxy = new Proxy(snapshot, {
            get(target, property) {
                if (property === "allIndexEntries") return () => index;
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Snapshot;
        await expect(
            appendRecords(proxy, [record(RecordType.student, newUuid(), {})]),
        ).rejects.toMatchObject({ code: "index_key_invalid" });
    });

    it("downgrades conflicting staged import version fields", async () => {
        const student = newUuid();
        const session = newUuid();
        const base = await emptyArchive("staged conflict");
        const snapshot = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
            record(RecordType.session, session, { student_id: student }),
        ]);
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
        const index = new Map(snapshot.allIndexEntries());
        index.set(`STUDENTSESSION:${student}:${session}`, manifestOffset);
        const proxy = new Proxy(snapshot, {
            get(target, property) {
                if (property === "getRecord") {
                    return (type: number, id: string) =>
                        type === RecordType.settings && id.toLowerCase() === target.header.id
                            ? Promise.resolve({ ...manifest!, fields })
                            : target.getRecord(type, id);
                }
                if (property === "allIndexEntries") return () => index;
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Snapshot;
        const staging: ArchiveStaging = {
            async append() {
                return Promise.resolve();
            },
            async seal() {
                return new MemoryArchiveSource(new Uint8Array());
            },
            async abort() {
                return Promise.resolve();
            },
        };
        async function* assets(): AsyncGenerator<ArchiveRecord> {
            yield record(RecordType.assetBlob, newUuid(), { record_role: "asset-blob" });
            yield record(RecordType.assetMetadata, newUuid(), { record_role: "material" });
        }
        await expect(appendStagedAssetRecords(proxy, assets(), staging)).rejects.toBeInstanceOf(
            Error,
        );
    });
});

describe("multi-level index construction", () => {
    it("groups leaf pages into multiple parent levels", async () => {
        const snapshot = await emptyArchive("multi level index");
        const index = new Map(snapshot.allIndexEntries());
        const total = 524_300;
        for (let position = 0; position < total; position += 1) {
            index.set(`k${position.toString().padStart(7, "0")}`, 64n);
        }
        const proxy = new Proxy(snapshot, {
            get(target, property) {
                if (property === "allIndexEntries") return () => index;
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Snapshot;
        const next = await appendRecords(proxy, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        expect(next.indexEntryCount()).toBeGreaterThan(524_288);
    }, 240_000);
});

describe("manifest authentication fallbacks", () => {
    it("rejects an encrypted manifest without authentication data", async () => {
        const passphrase = "manifest auth fallback passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("manifest fallback auth", "", passphrase),
        );
        const unlocked = await locked.unlock(passphrase);
        const bytes = await bytesOf(unlocked);
        const offset = Number(
            unlocked.allIndexEntries().get(primaryKey(RecordType.settings, unlocked.header.id)),
        );
        patchFieldKeys(bytes, offset, (payload) => {
            const text = new TextEncoder().encode("manifest_auth");
            for (let index = 0; index + text.length <= payload.length; index += 1) {
                if (text.every((byte, i) => payload[index + i] === byte)) {
                    payload.set(new TextEncoder().encode("manifest_autX"), index);
                    return;
                }
            }
            throw new Error("manifest_auth field not found");
        });
        const envelope = await unlocked.getRecord(RecordType.encryption, unlocked.header.id);
        const key = await ArchiveDataKey.unwrap(
            passphrase,
            encryptionEnvelopeFromRecord(envelope!, unlocked.header.id),
            unlocked.header.id,
        );
        const view = new ArchiveSnapshot(
            new MemoryArchiveSource(bytes),
            unlocked.header,
            unlocked.commit,
            unlocked.allIndexEntries(),
            unlocked.publishedEndOffset,
            key,
        );
        await expect(view.getRecord(RecordType.settings, unlocked.header.id)).rejects.toMatchObject(
            { code: "archive_manifest_authentication_failed" },
        );
        view.lock();
        unlocked.lock();
    });
});

describe("sanitized copy credential pruning", () => {
    it("removes sensitive setting keys from a copied journal entry", async () => {
        const entry = newUuid();
        const base = await emptyArchive("sanitized secrets");
        const snapshot = await appendRecords(base, [
            record(RecordType.settings, entry, {
                record_role: "journal-entry",
                aaaaaaaa: "value",
            }),
        ]);
        const bytes = await bytesOf(snapshot);
        const offset = Number(
            snapshot.allIndexEntries().get(primaryKey(RecordType.settings, entry)),
        );
        patchFieldKeys(bytes, offset, (payload) => {
            const text = new TextEncoder().encode("aaaaaaaa");
            for (let index = 0; index + text.length <= payload.length; index += 1) {
                if (text.every((byte, i) => payload[index + i] === byte)) {
                    payload.set(new TextEncoder().encode("secretxx"), index);
                    return;
                }
            }
            throw new Error("custom setting field not found");
        });
        const patched = await openArchiveBytes(bytes);
        const preview = await previewSanitizedCopy(patched, {});
        const result = await createSanitizedCopy(patched, {}, preview);
        const copied = await result.snapshot.getRecord(RecordType.settings, entry);
        expect(copied?.fields.has("secretxx")).toBe(false);
        result.snapshot.lock();
    });
});

describe("listing and evidence visibility", () => {
    it("hides deleted records unless requested", async () => {
        const student = newUuid();
        const base = await emptyArchive("deleted listing");
        const first = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
        ]);
        const deleted = await appendRecords(first, [
            record(RecordType.student, student, { _deleted: "true" }),
        ]);
        expect(await deleted.listRecords(RecordType.student)).toEqual([]);
        expect(await deleted.listRecordMetadata(RecordType.student)).toEqual([]);
        expect(await deleted.listRecords(RecordType.student, true)).toHaveLength(1);
        expect(await deleted.listRecordMetadata(RecordType.student, true)).toHaveLength(1);
    });

    it("accepts evidence edges whose endpoints resolve", async () => {
        const from = newUuid();
        const to = newUuid();
        const edge = newUuid();
        const snapshot = await appendRecords(await emptyArchive("resolved evidence"), [
            record(RecordType.evidenceNode, from, { label: "from" }),
            record(RecordType.evidenceNode, to, { label: "to" }),
            record(RecordType.evidenceEdge, edge, { from_id: from, to_id: to }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        expect(report.issues.join(" ")).not.toContain("references a missing node");
    });
});

describe("verification error and ordering branches", () => {
    it("reports a later commit generation that is not fully valid", async () => {
        const base = await emptyArchive("history generation invalid");
        const session = newUuid();
        const second = await appendRecords(base, [
            record(RecordType.session, session, { student_id: newUuid() }),
        ]);
        const third = await appendRecords(second, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const index = new Map(third.allIndexEntries());
        for (const key of [...index.keys()]) {
            if (key.toLowerCase().includes(session)) index.delete(key);
        }
        const rewritten = await openArchiveBytes(await rebuildWithIndex(third, index));
        const { verifyArchiveHistory } = await import("../../../frontend/archive/archive");
        await expect(verifyArchiveHistory(rewritten)).rejects.toMatchObject({
            code: "archive_commit_chain_invalid",
            message: expect.stringContaining("not fully valid"),
        });
    });

    it("stringifies non-Error reads for primary and revision frames", async () => {
        const id = newUuid();
        const first = await emptyArchive("non error frames");
        const base = await appendRecords(first, [
            record(RecordType.student, id, { display_name: "A" }),
        ]);
        const snapshot = await appendRecords(base, [
            record(RecordType.student, id, { display_name: "B" }),
        ]);
        const bytes = await bytesOf(snapshot);
        const latestOffset = snapshot.allIndexEntries().get(primaryKey(RecordType.student, id))!;
        const previous = (await snapshot.getRecord(RecordType.student, id))!.previousOffset;
        const throwingAt = (target: bigint): ArchiveByteSource => ({
            size: BigInt(bytes.length),
            async read(offset, length) {
                if (offset === target) throw "frame failure";
                return bytes.subarray(Number(offset), Number(offset) + length);
            },
        });
        const primary = await verifyArchiveFull(
            new ArchiveSnapshot(
                throwingAt(latestOffset),
                snapshot.header,
                snapshot.commit,
                snapshot.allIndexEntries(),
                snapshot.publishedEndOffset,
            ),
        );
        expect(primary.issues.join(" ")).toContain("frame failure");
        const revision = await verifyArchiveFull(
            new ArchiveSnapshot(
                throwingAt(previous),
                snapshot.header,
                snapshot.commit,
                snapshot.allIndexEntries(),
                snapshot.publishedEndOffset,
            ),
        );
        expect(revision.issues.join(" ")).toContain("frame failure");
    });

    it("stringifies a non-Error read for a secondary index target", async () => {
        const id = newUuid();
        const snapshot = await appendRecords(await emptyArchive("non error secondary"), [
            record(RecordType.student, id, { display_name: "A" }),
        ]);
        const bytes = await bytesOf(snapshot);
        const offset = snapshot.allIndexEntries().get(primaryKey(RecordType.student, id))!;
        const limit = 65_535;
        const hot = `ANNOTATIONSESSION:${newUuid()}:${String(limit).padStart(20, "0")}:${id}`;
        const index = new Map(snapshot.allIndexEntries());
        index.delete(primaryKey(RecordType.student, id));
        index.set(hot, offset);
        let reads = 0;
        const source: ArchiveByteSource = {
            size: BigInt(bytes.length),
            async read(readOffset, length) {
                if (readOffset === offset) {
                    reads += 1;
                    if (reads > 1) throw "secondary failure";
                }
                return bytes.subarray(Number(readOffset), Number(readOffset) + length);
            },
        };
        const report = await verifyArchiveFull(
            new ArchiveSnapshot(
                source,
                snapshot.header,
                snapshot.commit,
                index,
                snapshot.publishedEndOffset,
            ),
        );
        expect(report.issues.join(" ")).toContain("secondary failure");
    });

    it("orders audio chunks and rejects a sequence discovered during sorting", async () => {
        const session = newUuid();
        const track = newUuid();
        const ids = [newUuid(), newUuid(), newUuid()];
        const snapshot = await appendRecords(await emptyArchive("audio ordering"), [
            record(RecordType.session, session, { student_id: "anonymous" }),
            record(RecordType.audioChunk, ids[0]!, {
                session_id: session,
                track_id: track,
                sequence_number: "2",
            }),
            record(RecordType.audioChunk, ids[1]!, {
                session_id: session,
                track_id: track,
                sequence_number: "1",
            }),
            record(RecordType.audioChunk, ids[2]!, {
                session_id: session,
                track_id: track,
                sequence_number: "3",
            }),
        ]);
        const chunks = await snapshot.listAudioChunkMetadata(session, track);
        expect(chunks.map((chunk) => chunk.fields.get("sequence_number"))).toEqual(["1", "2", "3"]);
    });

    it("sorts fallback audio chunks from an unsorted index view", async () => {
        const session = newUuid();
        const track = newUuid();
        const ids = [newUuid(), newUuid(), newUuid()];
        const snapshot = await appendRecords(await emptyArchive("audio unsorted"), [
            record(RecordType.session, session, { student_id: "anonymous" }),
            record(RecordType.audioChunk, ids[0]!, {
                session_id: session,
                track_id: track,
                sequence_number: "3",
            }),
            record(RecordType.audioChunk, ids[1]!, {
                session_id: session,
                track_id: track,
                sequence_number: "2",
            }),
            record(RecordType.audioChunk, ids[2]!, {
                session_id: session,
                track_id: track,
                sequence_number: "1",
            }),
        ]);
        const index = new Map<string, bigint>();
        for (const id of ids) {
            const key = primaryKey(RecordType.audioChunk, id);
            index.set(key, snapshot.allIndexEntries().get(key)!);
        }
        index.set(
            primaryKey(RecordType.settings, snapshot.header.id),
            snapshot.allIndexEntries().get(primaryKey(RecordType.settings, snapshot.header.id))!,
        );
        const chunks = await reopen(
            snapshot,
            await bytesOf(snapshot),
            index,
        ).listAudioChunkMetadata(session, track);
        expect(chunks.map((chunk) => chunk.fields.get("sequence_number"))).toEqual(["1", "2", "3"]);

        const patched = await bytesOf(snapshot);
        const secondOffset = Number(
            snapshot.allIndexEntries().get(primaryKey(RecordType.audioChunk, ids[1]!)),
        );
        const secondFrame = decodeRecordFrame(patched.subarray(secondOffset));
        const secondRecord = decodeRecordPayload(
            secondFrame.type,
            secondFrame.id,
            secondFrame.revision,
            secondFrame.previousOffset,
            secondFrame.storedPayload,
        );
        const equalFields = new Map(secondRecord.fields);
        equalFields.set("sequence_number", "1");
        rewriteFrame(
            patched,
            secondOffset,
            encodeRecordPayload({ ...secondRecord, fields: equalFields }),
        );
        const equalIndex = new Map<string, bigint>();
        for (const id of [ids[1]!, ids[2]!]) {
            const key = primaryKey(RecordType.audioChunk, id);
            equalIndex.set(key, snapshot.allIndexEntries().get(key)!);
        }
        equalIndex.set(
            primaryKey(RecordType.settings, snapshot.header.id),
            snapshot.allIndexEntries().get(primaryKey(RecordType.settings, snapshot.header.id))!,
        );
        const equal = await reopen(snapshot, patched, equalIndex).listAudioChunkMetadata(
            session,
            track,
        );
        expect(equal.map((chunk) => chunk.fields.get("sequence_number"))).toEqual(["1", "1"]);
        expect(equal.map((chunk) => chunk.id).sort()).toEqual([ids[1]!, ids[2]!].sort());
    });
});

describe("manifest role branches", () => {
    it("accepts a supported session-package manifest shape", async () => {
        const base = await emptyArchive("package manifest");
        const updated = await appendRecords(base, [
            record(RecordType.settings, base.header.id, {
                record_role: "tutorux-session-package",
                package_version: "1",
                source_session_id: newUuid(),
            }),
        ]);
        expect(updated.commit.generation).toBe(2n);
    });

    it("rejects a session-package manifest with a missing version or source", async () => {
        const base = await emptyArchive("package manifest invalid");
        for (const fields of [
            {
                record_role: "tutorux-session-package",
                source_session_id: newUuid(),
            },
            {
                record_role: "tutorux-session-package",
                package_version: "1",
                source_session_id: "not-a-uuid",
            },
            {
                record_role: "tutorux-session-package",
                package_version: "1",
            },
        ]) {
            await expect(
                appendRecords(base, [record(RecordType.settings, base.header.id, fields)]),
            ).rejects.toMatchObject({ code: "archive_manifest_missing" });
        }
    });
});

describe("append verification branches", () => {
    it("applies an explicit manifest update alongside another record", async () => {
        const base = await emptyArchive("explicit manifest transaction");
        const student = newUuid();
        const updated = await appendRecords(base, [
            record(RecordType.settings, base.header.id, {
                record_role: "archive-manifest",
                display_name: "Renamed",
            }),
            record(RecordType.student, student, { display_name: "A" }),
        ]);
        const manifest = await updated.getManifest();
        expect(manifest.displayName).toBe("Renamed");
        expect(await updated.getRecord(RecordType.student, student)).not.toBeNull();
    });

    it("reads missing audio identity fields while indexing a new chunk", async () => {
        const snapshot = await appendRecords(await emptyArchive("audio identity sparse"), [
            record(RecordType.audioChunk, newUuid(), {}),
        ]).catch((error: unknown) => error);
        expect(snapshot).toMatchObject({ code: "audio_chunk_metadata_invalid" });
    });

    it("indexes evidence edges without one endpoint", async () => {
        const snapshot = await appendRecords(await emptyArchive("edge endpoint"), [
            record(RecordType.evidenceEdge, newUuid(), { from_id: newUuid() }),
        ]);
        expect(
            [...snapshot.allIndexEntries().keys()].some((key) => key.startsWith("EVIDENCEADJ:")),
        ).toBe(true);
    });

    it("reports a previous index record that cannot be reread", async () => {
        const student = newUuid();
        const base = await emptyArchive("previous record missing");
        const snapshot = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
        ]);
        const realGet = snapshot.getRecord.bind(snapshot);
        snapshot.getRecord = async (type: number, id: string) =>
            type === RecordType.student && id.toLowerCase() === student ? null : realGet(type, id);
        await expect(
            appendRecords(snapshot, [record(RecordType.student, student, { display_name: "B" })]),
        ).rejects.toMatchObject({ code: "record_index_mismatch" });
    });

    it("rejects a backfill manifest index entry that disappeared", async () => {
        const student = newUuid();
        const snapshot = await appendRecords(await emptyArchive("backfill manifest key"), [
            record(RecordType.student, student, { display_name: "A" }),
        ]);
        const manifest = (await snapshot.getRecord(RecordType.settings, snapshot.header.id))!;
        const index = new Map(snapshot.allIndexEntries());
        index.delete(primaryKey(RecordType.settings, snapshot.header.id));
        const view = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            index,
            snapshot.publishedEndOffset,
        );
        const realGet = view.getRecord.bind(view);
        view.getRecord = async (type: number, id: string) =>
            type === RecordType.settings && id.toLowerCase() === view.header.id
                ? manifest
                : realGet(type, id);
        await expect(backfillArchiveSecondaryIndexes(view)).rejects.toMatchObject({
            code: "archive_manifest_missing",
        });
    });

    it("verifies encrypted writes and reports altered read-back records", async () => {
        const passphrase = "write verification passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("write verification", "", passphrase),
        );
        const unlocked = await locked.unlock(passphrase);

        async function appendWithReadBack(
            mutate: (recordValue: ArchiveRecord) => ArchiveRecord | null,
        ): Promise<ArchiveSnapshot> {
            const original = unlocked.openNextGeneration.bind(unlocked);
            unlocked.openNextGeneration = async (source) => {
                const next = await original(source);
                const realGet = next.getRecord.bind(next);
                next.getRecord = async (type, id) => {
                    const value = await realGet(type, id);
                    return value ? mutate(value) : value;
                };
                return next;
            };
            try {
                return await appendRecords(unlocked, [
                    record(RecordType.student, newUuid(), { display_name: "A" }),
                ]);
            } finally {
                unlocked.openNextGeneration = original;
            }
        }

        await expect(appendWithReadBack(() => null)).rejects.toMatchObject({
            code: "archive_write_verification_failed",
            message: expect.stringContaining("could not be read back"),
        });
        await expect(
            appendWithReadBack((value) => ({ ...value, revision: 99n })),
        ).rejects.toMatchObject({
            code: "archive_write_verification_failed",
            message: expect.stringContaining("metadata changed"),
        });
        await expect(
            appendWithReadBack((value) => ({ ...value, fields: new Map() })),
        ).rejects.toMatchObject({
            code: "archive_write_verification_failed",
            message: expect.stringContaining("contents changed"),
        });
        await expect(
            appendWithReadBack(() => {
                throw new Error("read back failed");
            }),
        ).rejects.toThrow("read back failed");
        unlocked.lock();
    });
});

describe("index tree and commit scan edges", () => {
    it("reads an empty root leaf index", async () => {
        const base = await emptyArchive("empty root");
        const bytes = await bytesOf(base);
        const emptyRoot = decodeRecordFrame(bytes.subarray(64));
        const commitOffset = Number(base.commit.offset);
        const commit = decodeRecordFrame(bytes.subarray(commitOffset));
        const payload = commit.storedPayload.slice();
        new DataView(payload.buffer).setBigUint64(24, 64n, true);
        payload.set(await sha256(emptyRoot.storedPayload), 32);
        rewriteFrame(bytes, commitOffset, payload);
        const reopened = await openArchiveBytes(bytes);
        expect(reopened.indexEntryCount()).toBe(0);
    });

    it("sorts many commit frames from inspection", async () => {
        const base = await emptyArchive("many commit frames");
        const bytes = await bytesOf(base);
        const tail: Uint8Array[] = [];
        for (let generation = 2; generation <= 40; generation += 1) {
            const payload = encodeCommitPayloadForTest({
                generation: BigInt(generation),
                previousOffset: 0n,
                rootOffset: base.commit.rootOffset,
            });
            tail.push(
                encodeRecordFrame(
                    {
                        type: RecordType.commit,
                        id: ZERO_UUID,
                        revision: BigInt(generation),
                        previousOffset: 0n,
                    },
                    payload,
                ),
            );
        }
        const total = tail.reduce((length, part) => length + part.length, 0);
        const withTail = new Uint8Array(bytes.length + total);
        withTail.set(bytes);
        let cursor = bytes.length;
        for (const part of tail) {
            withTail.set(part, cursor);
            cursor += part.length;
        }
        const inspection = await inspectArchiveRecovery(new MemoryArchiveSource(withTail));
        expect(inspection.candidateGeneration).toBe(40n);
    });
});

describe("format branch edges", () => {
    it("rejects duplicate iterated field names", () => {
        const fields = {
            *[Symbol.iterator]() {
                yield ["duplicate", "one"] as const;
                yield ["duplicate", "two"] as const;
            },
        };
        expect(() =>
            encodeRecordPayload({
                fields: fields as unknown as ReadonlyMap<string, string>,
                blob: new Uint8Array(),
            }),
        ).toThrowError(expect.objectContaining({ code: "record_field_duplicate" }));
    });

    function compressionTrap(options: {
        length: number;
        firstMatch: number;
        secondMatch: number;
    }): Uint8Array {
        const patternA = [0x51, 0x7a, 0x3c, 0xd4];
        const patternB = [0x27, 0x88, 0xf1, 0x0b];
        const builder = (state: number): Uint8Array => {
            const bytes = new Uint8Array(options.length);
            let value = state;
            for (let index = 0; index < bytes.length; index += 1) {
                value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
                bytes[index] = (value >>> 16) & 0xff;
            }
            const anchorA = options.firstMatch - 1000;
            const anchorB = options.secondMatch - 1000;
            bytes.set(patternA, anchorA);
            bytes.set(patternA, options.firstMatch);
            bytes.set(patternB, anchorB);
            bytes.set(patternB, options.secondMatch);
            bytes[options.firstMatch + 4] = (bytes[anchorA + 4] ?? 0) ^ 0xff;
            bytes[options.secondMatch + 4] = (bytes[anchorB + 4] ?? 0) ^ 0xff;
            return bytes;
        };
        const hash = (bytes: Uint8Array, offset: number): number => {
            const value =
                bytes[offset]! |
                (bytes[offset + 1]! << 8) |
                (bytes[offset + 2]! << 16) |
                (bytes[offset + 3]! << 24);
            return (Math.imul(value, 2_654_435_761) >>> 16) & 0xffff;
        };
        const matches = (
            bytes: Uint8Array,
        ): { cursor: number; literal: number; length: number }[] => {
            const table = new Map<number, number>();
            let cursor = 0;
            let anchor = 0;
            const found: { cursor: number; literal: number; length: number }[] = [];
            while (cursor + 12 <= bytes.length) {
                const bucket = hash(bytes, cursor);
                const previous = table.get(bucket) ?? -1;
                table.set(bucket, cursor);
                if (
                    previous < 0 ||
                    cursor - previous > 65_535 ||
                    bytes[previous] !== bytes[cursor] ||
                    bytes[previous + 1] !== bytes[cursor + 1] ||
                    bytes[previous + 2] !== bytes[cursor + 2] ||
                    bytes[previous + 3] !== bytes[cursor + 3]
                ) {
                    cursor += 1;
                    continue;
                }
                let matchLength = 4;
                while (
                    cursor + matchLength < bytes.length - 5 &&
                    bytes[previous + matchLength] === bytes[cursor + matchLength]
                ) {
                    matchLength += 1;
                }
                found.push({ cursor, literal: cursor - anchor, length: matchLength });
                cursor += matchLength;
                anchor = cursor;
                const updateStart = cursor > 3 ? cursor - 3 : 0;
                for (
                    let position = updateStart;
                    position < cursor && position + 4 <= bytes.length;
                ) {
                    table.set(hash(bytes, position), position);
                    position += 1;
                }
            }
            return found;
        };
        for (let seed = 1; seed < 4096; seed += 1) {
            const bytes = builder(seed);
            const found = matches(bytes);
            if (
                found.length === 2 &&
                found[0]!.cursor === options.firstMatch &&
                found[0]!.literal === options.firstMatch &&
                found[0]!.length === 4 &&
                found[1]!.cursor === options.secondMatch &&
                found[1]!.length === 4
            ) {
                return bytes;
            }
        }
        throw new Error("no deterministic compression trap found");
    }

    it("returns null when the literal run itself exhausts the budget", () => {
        const pattern = [0x51, 0x7a, 0x3c, 0xd4];
        const builder = (state: number): Uint8Array => {
            const bytes = new Uint8Array(300);
            let value = state;
            for (let index = 0; index < bytes.length; index += 1) {
                value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
                bytes[index] = (value >>> 16) & 0xff;
            }
            bytes.set(pattern, 0);
            bytes.set(pattern, 288);
            bytes[292] = (bytes[4] ?? 0) ^ 0xff;
            return bytes;
        };
        const hash = (bytes: Uint8Array, offset: number): number => {
            const value =
                bytes[offset]! |
                (bytes[offset + 1]! << 8) |
                (bytes[offset + 2]! << 16) |
                (bytes[offset + 3]! << 24);
            return (Math.imul(value, 2_654_435_761) >>> 16) & 0xffff;
        };
        const findMatches = (
            bytes: Uint8Array,
        ): { cursor: number; literal: number; length: number }[] => {
            const table = new Map<number, number>();
            let cursor = 0;
            let anchor = 0;
            const found: { cursor: number; literal: number; length: number }[] = [];
            while (cursor + 12 <= bytes.length) {
                const bucket = hash(bytes, cursor);
                const previous = table.get(bucket) ?? -1;
                table.set(bucket, cursor);
                if (
                    previous < 0 ||
                    cursor - previous > 65_535 ||
                    bytes[previous] !== bytes[cursor] ||
                    bytes[previous + 1] !== bytes[cursor + 1] ||
                    bytes[previous + 2] !== bytes[cursor + 2] ||
                    bytes[previous + 3] !== bytes[cursor + 3]
                ) {
                    cursor += 1;
                    continue;
                }
                let matchLength = 4;
                while (
                    cursor + matchLength < bytes.length - 5 &&
                    bytes[previous + matchLength] === bytes[cursor + matchLength]
                ) {
                    matchLength += 1;
                }
                found.push({ cursor, literal: cursor - anchor, length: matchLength });
                cursor += matchLength;
                anchor = cursor;
                for (
                    let position = cursor > 3 ? cursor - 3 : 0;
                    position < cursor && position + 4 <= bytes.length;
                ) {
                    table.set(hash(bytes, position), position);
                    position += 1;
                }
            }
            return found;
        };
        let payload: Uint8Array | undefined;
        for (let seed = 1; seed < 4096; seed += 1) {
            const bytes = builder(seed);
            const found = findMatches(bytes);
            if (
                found.length === 1 &&
                found[0]!.cursor === 288 &&
                found[0]!.literal === 288 &&
                found[0]!.length === 4
            ) {
                payload = bytes;
                break;
            }
        }
        expect(payload).toBeDefined();
        expect(compressRecordPayload(payload!)).toEqual({ codec: 0, bytes: payload });
    });

    it("returns null when a match literal run exhausts the budget", () => {
        // 64000-byte literal, 4-byte match, 255-byte literal match extension overflow.
        const bytes = compressionTrap({
            length: 66_287,
            firstMatch: 66_000,
            secondMatch: 66_274,
        });
        const result = compressRecordPayload(bytes);
        expect(result.codec).toBe(0);
    }, 60_000);

    it("returns null when a final literal extension exhausts the budget", () => {
        const bytes = compressionTrap({
            length: 3_947,
            firstMatch: 3_000,
            secondMatch: 3_904,
        });
        const result = compressRecordPayload(bytes);
        expect(result.codec).toBe(0);
    }, 60_000);
});
