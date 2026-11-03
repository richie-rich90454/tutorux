import { describe, expect, it } from "vitest";
import {
    appendRecords,
    ArchiveSnapshot,
    backfillArchiveSecondaryIndexes,
    compactArchiveSnapshot,
    createArchiveBytes,
    createEncryptedArchiveBytes,
    discardUncommittedTail,
    openArchiveBytes,
    openArchiveSource,
    purgeTrashedArchiveSnapshot,
    repairArchiveSnapshot,
    recoverUnpublishedCommit,
    verifyArchiveFull,
} from "../../../frontend/archive/archive";
import {
    compressRecordPayload,
    decodeLz4Block,
    decodeRecordFrame,
    encodeRecordFrame,
    encodeRecordPayload,
    newUuid,
    RecordType,
    type ArchiveRecord,
} from "../../../frontend/archive/format";
import { type ArchiveByteSource } from "../../../frontend/archive/source";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function record(
    type: number,
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

async function bytesOf(source: { source: ArchiveByteSource }): Promise<Uint8Array> {
    return (await source.source.read(0n, Number(source.source.size))).slice();
}

function primaryKey(type: number, id: string): string {
    const names: Record<number, string> = {
        [RecordType.student]: "STUDENT",
        [RecordType.session]: "SESSION",
        [RecordType.settings]: "SETTINGS",
        [RecordType.audioChunk]: "AUDIO",
    };
    return `${names[type] ?? "UNKNOWN"}:${id.toLowerCase()}`;
}

function indexWith(
    snapshot: { allIndexEntries(): ReadonlyMap<string, bigint> },
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

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
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

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
    }
    return ~crc >>> 0;
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

/** Rebuild the root index page and commit so a modified index becomes authoritative. */
async function rebuildWithIndex(
    base: {
        source: ArchiveByteSource;
        header: unknown;
        commit: { rootOffset: bigint; offset: bigint; generation: bigint };
        allIndexEntries(): ReadonlyMap<string, bigint>;
    },
    index: ReadonlyMap<string, bigint>,
): Promise<Uint8Array> {
    const source = await bytesOf(base);
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

/** Serves a rewritten version of one frame once its full-frame read count is reached. */
class RewriteAfterReadsSource implements ArchiveByteSource {
    readonly size: bigint;
    fullReads = 0;

    constructor(
        private readonly bytes: Uint8Array,
        private readonly target: { offset: number; replacement: Uint8Array },
        private readonly rewriteAfter: number,
    ) {
        this.size = BigInt(bytes.byteLength);
    }

    async read(offset: bigint, length: number): Promise<Uint8Array> {
        if (
            Number(offset) === this.target.offset &&
            length === this.target.replacement.byteLength
        ) {
            this.fullReads += 1;
            if (this.fullReads === this.rewriteAfter) return this.target.replacement.slice();
        }
        const start = Number(offset);
        return this.bytes.subarray(start, start + length);
    }
}

describe("lz4 compressor match placement", () => {
    it("compresses runs whose first match starts inside the first four bytes", () => {
        const payload = new Uint8Array(1024).fill(0x61);
        const encoded = compressRecordPayload(payload);
        expect(encoded.codec).toBe(1);
        expect(decodeLz4Block(encoded.bytes)).toEqual(payload);
    });

    it("compresses repeats that start after the first four bytes", () => {
        const payload = new Uint8Array(512);
        for (let index = 0; index < payload.length; index += 1) {
            payload[index] = index % 251;
        }
        const encoded = compressRecordPayload(payload);
        expect(encoded.codec).toBe(1);
        expect(decodeLz4Block(encoded.bytes)).toEqual(payload);
    });
});

describe("encryption reachable states", () => {
    it("keeps secondary aliases when encrypting a plaintext archive", async () => {
        const student = newUuid();
        const session = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("secondary encrypt")),
            [
                record(RecordType.student, student, { display_name: "A" }),
                record(RecordType.session, session, { student_id: student }),
            ],
        );
        expect(snapshot.allIndexEntries().has(`STUDENTSESSION:${student}:${session}`)).toBe(true);
        const encrypted = await snapshot.enableEncryption("correct horse battery");
        expect(encrypted.encrypted).toBe(true);
        expect((await encrypted.getRecord(RecordType.session, session))?.id).toBe(session);
    });

    it("ignores opaque aliases that point at a known record while encrypting", async () => {
        const student = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("opaque known alias"));
        const snapshot = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
        ]);
        const offset = snapshot.allIndexEntries().get(primaryKey(RecordType.student, student))!;
        const index = indexWith(snapshot, (value) => {
            value.set(`FUTURE:${student}`, offset);
        });
        const crafted = await openArchiveBytes(await rebuildWithIndex(snapshot, index));
        const encrypted = await crafted.enableEncryption("correct horse battery");
        expect(encrypted.encrypted).toBe(true);
    });

    it("rejects passphrase changes for plaintext and locked archives", async () => {
        const plaintext = await openArchiveBytes(await createArchiveBytes("plaintext rekey"));
        await expect(
            plaintext.changePassphrase("correct horse battery", "another horse battery"),
        ).rejects.toMatchObject({ code: "archive_not_encrypted" });

        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("locked rekey", "", "correct horse battery"),
        );
        await expect(
            locked.changePassphrase("correct horse battery", "another horse battery"),
        ).rejects.toMatchObject({ code: "archive_locked" });
    });

    it("rejects enabling encryption on an already encrypted archive", async () => {
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("double encrypt", "", "correct horse battery"),
        );
        await expect(locked.enableEncryption("another horse battery")).rejects.toMatchObject({
            code: "archive_already_encrypted",
        });
    });
});

describe("opaque chains during encryption", () => {
    const firstId = "11111111-1111-1111-1111-111111111111";
    const secondId = "22222222-2222-2222-2222-222222222222";

    it("rejects an opaque revision that points forward", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("opaque cycle encrypt"));
        const withFirst = await appendRecords(base, [record(99, firstId, { label: "first" })]);
        const snapshot = await appendRecords(withFirst, [record(99, firstId, { label: "second" })]);
        const secondOffset = Number(snapshot.allIndexEntries().get(`UNKNOWN:${firstId}`)!);
        const bytes = await bytesOf(snapshot);
        const firstOffset = Number(decodeRecordFrame(bytes.subarray(secondOffset)).previousOffset);
        const index = indexWith(snapshot, (value) => {
            value.delete(`UNKNOWN:${firstId}`);
            value.set(`FUTURE:${firstId}`, BigInt(secondOffset));
        });
        const rebuilt = await rebuildWithIndex(snapshot, index);
        const firstFrame = decodeRecordFrame(rebuilt.subarray(firstOffset));
        rewriteFrame(rebuilt, firstOffset, firstFrame.storedPayload, {
            previousOffset: BigInt(secondOffset),
        });
        const crafted = await openArchiveBytes(rebuilt);
        await expect(crafted.enableEncryption("correct horse battery")).rejects.toMatchObject({
            code: "revision_lineage_invalid",
        });
    });

    it("rejects an opaque chain that links into another record", async () => {
        const student = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("opaque lineage encrypt"));
        const snapshot = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
            record(99, secondId, { label: "second" }),
        ]);
        const studentOffset = snapshot
            .allIndexEntries()
            .get(primaryKey(RecordType.student, student))!;
        const secondOffset = Number(snapshot.allIndexEntries().get(`UNKNOWN:${secondId}`)!);
        const index = indexWith(snapshot, (value) => {
            value.delete(`UNKNOWN:${secondId}`);
            value.set(`FUTURE:${secondId}`, BigInt(secondOffset));
        });
        const rebuilt = await rebuildWithIndex(snapshot, index);
        const second = decodeRecordFrame(rebuilt.subarray(secondOffset));
        rewriteFrame(rebuilt, secondOffset, second.storedPayload, {
            previousOffset: studentOffset,
        });
        const crafted = await openArchiveBytes(rebuilt);
        await expect(crafted.enableEncryption("correct horse battery")).rejects.toMatchObject({
            code: "revision_lineage_invalid",
        });
    });
});

describe("historical reference checks", () => {
    it("reports historical evidence edges with missing nodes", async () => {
        const edge = newUuid();
        const node = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("historical edge"));
        const first = await appendRecords(base, [
            record(RecordType.evidenceNode, node, { kind: "note", text: "node" }),
            record(RecordType.evidenceEdge, edge, {
                from_id: node,
                to_id: newUuid(),
            }),
        ]);
        const snapshot = await appendRecords(first, [
            record(RecordType.evidenceEdge, edge, {
                from_id: node,
                to_id: newUuid(),
                note: "revised",
            }),
        ]);
        const report = await verifyArchiveFull(snapshot);
        expect(report.issues.join(" ")).toContain("references a missing evidence node.");
    });
});

describe("trash purge journal cleanup", () => {
    it("clears removed-block fields from a journal-notes record", async () => {
        const notes = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("journal notes purge")),
            [
                record(RecordType.settings, notes, {
                    record_role: "journal-notes",
                    removed_block_count: "2",
                    removed_block_0_kind: "paragraph",
                    removed_block_1_kind: "paragraph",
                    last_removed_block_id: newUuid(),
                }),
            ],
        );
        const purged = await purgeTrashedArchiveSnapshot(snapshot);
        const cleaned = await purged.snapshot.getRecord(RecordType.settings, notes);
        expect(cleaned?.fields.has("removed_block_count")).toBe(false);
        expect(cleaned?.fields.has("removed_block_0_kind")).toBe(false);
        expect(cleaned?.fields.has("last_removed_block_id")).toBe(false);
    });
});

describe("append branches", () => {
    it("stamps the audio index version onto a session changed with its chunk", async () => {
        const student = newUuid();
        const session = newUuid();
        const track = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("audio version stamp")),
            [
                record(RecordType.student, student, { display_name: "A" }),
                record(RecordType.session, session, { student_id: student }),
            ],
        );
        const updated = await appendRecords(snapshot, [
            record(RecordType.session, session, {
                student_id: student,
                title: "Renamed",
                audio_chunk_index_version: "1",
            }),
            record(RecordType.audioChunk, newUuid(), {
                session_id: session,
                track_id: track,
                sequence_number: "1",
                codec: "none",
            }),
        ]);
        const sessionRecord = await updated.getRecord(RecordType.session, session);
        expect(sessionRecord?.fields.get("audio_chunk_index_version")).toBe("1");
        const manifest = await updated.getRecord(RecordType.settings, updated.header.id);
        expect(manifest?.fields.get("audio_chunk_index_version")).toBe("1");
    });

    it("ignores malformed guide source aliases while preserving history", async () => {
        const student = newUuid();
        const session = newUuid();
        const guide = newUuid();
        const fields = {
            session_id: session,
            title: "Guide",
            section_count: "1",
            "section.0.heading": "H",
            "section.0.block_count": "1",
            "section.0.block.0.kind": "paragraph",
            "section.0.block.0.source_ids": student,
        };
        const base = await openArchiveBytes(await createArchiveBytes("guide alias history"));
        const snapshot = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
            record(RecordType.session, session, { student_id: student }),
            record(RecordType.guide, guide, fields),
        ]);
        const index = indexWith(snapshot, (value) => {
            value.set(`GUIDESOURCE:not-a-uuid:${guide}`, snapshot.commit.offset);
        });
        const crafted = await openArchiveBytes(await rebuildWithIndex(snapshot, index));
        const updated = await appendRecords(crafted, [
            record(RecordType.guide, guide, { ...fields, title: "Guide two" }),
        ]);
        const stored = await updated.getRecord(RecordType.guide, guide);
        expect(stored?.fields.get("source_index_history")).toBe(student);
    });

    it("skips annotations whose start time cannot be an index offset", async () => {
        const session = newUuid();
        const annotation = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("annotation time")),
            [
                record(RecordType.session, session, { student_id: "anonymous" }),
                record(RecordType.annotation, annotation, {
                    session_id: session,
                    start_time_us: "9223372036854775808",
                }),
            ],
        );
        const keys = [...snapshot.allIndexEntries().keys()];
        expect(keys.some((key) => key.startsWith("ANNOTATIONSESSION:"))).toBe(false);
        expect((await snapshot.getRecord(RecordType.annotation, annotation))?.id).toBe(annotation);
    });
});

describe("audio chunk ordering", () => {
    it("sorts fallback-indexed chunks by sequence number", async () => {
        const session = newUuid();
        const track = newUuid();
        const high = "11111111-1111-1111-1111-111111111111";
        const low = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("fallback ordering")),
            [
                record(RecordType.session, session, { student_id: "anonymous" }),
                record(RecordType.audioChunk, high, {
                    session_id: session,
                    track_id: track,
                    sequence_number: "2",
                    codec: "none",
                }),
                record(RecordType.audioChunk, low, {
                    session_id: session,
                    track_id: track,
                    sequence_number: "1",
                    codec: "none",
                }),
            ],
        );
        const index = indexWith(snapshot, (value) => {
            for (const key of [...value.keys()]) {
                if (key.startsWith("AUDIOSESSION:")) value.delete(key);
            }
        });
        const crafted = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            index,
            snapshot.publishedEndOffset,
        );
        const chunks = await crafted.listAudioChunkMetadata(session, track);
        expect(chunks.map((chunk) => chunk.fields.get("sequence_number"))).toEqual(["1", "2"]);
    });
});

describe("secondary index backfill conflicts", () => {
    it("keeps a conflicting alias on the verified scan path", async () => {
        const student = newUuid();
        const session = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("backfill conflict")),
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
        const proxy = new Proxy(snapshot, {
            get(target, property) {
                if (property === "getRecord") {
                    return async (type: number, id: string) => {
                        if (type === RecordType.settings && id.toLowerCase() === target.header.id) {
                            return { ...(await target.getRecord(type, id))!, fields };
                        }
                        return target.getRecord(type, id);
                    };
                }
                if (property === "allIndexEntries") {
                    return () => index;
                }
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        const migrated = await backfillArchiveSecondaryIndexes(proxy);
        expect(migrated.conflictingEntries).toBeGreaterThan(0);
        expect(migrated.schemaVersionsUpdated).toBe(true);
        const updated = await migrated.snapshot.getRecord(
            RecordType.settings,
            migrated.snapshot.header.id,
        );
        expect(updated?.fields.get("student_session_index_version")).toBe("0");
    });

    it("accepts aliases that already point at their own record", async () => {
        const student = newUuid();
        const session = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("backfill duplicate alias")),
            [
                record(RecordType.student, student, { display_name: "A" }),
                record(RecordType.session, session, { student_id: student }),
            ],
        );
        const migrated = await backfillArchiveSecondaryIndexes(snapshot);
        expect(migrated.conflictingEntries).toBe(0);
        const again = await backfillArchiveSecondaryIndexes(migrated.snapshot);
        expect(again.addedEntries).toBe(0);
        expect(again.conflictingEntries).toBe(0);
        expect(again.schemaVersionsUpdated).toBe(false);
    });

    it("counts conflicting non-versioned aliases without downgrading versions", async () => {
        const student = newUuid();
        const guide = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("backfill guide alias"));
        const snapshot = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "A" }),
            record(RecordType.guide, guide, {
                session_id: "00000000-0000-0000-0000-000000000000",
                title: "Guide",
                section_count: "1",
                "section.0.heading": "H",
                "section.0.block_count": "1",
                "section.0.block.0.kind": "paragraph",
                "section.0.block.0.source_ids": student,
            }),
        ]);
        const manifestOffset = snapshot
            .allIndexEntries()
            .get(primaryKey(RecordType.settings, snapshot.header.id))!;
        const index = indexWith(snapshot, (value) => {
            value.set(`GUIDESOURCE:${student}:${guide}`, manifestOffset);
        });
        const crafted = await openArchiveBytes(await rebuildWithIndex(snapshot, index));
        const migrated = await backfillArchiveSecondaryIndexes(crafted);
        expect(migrated.conflictingEntries).toBeGreaterThan(0);
        const updated = await migrated.snapshot.getRecord(
            RecordType.settings,
            migrated.snapshot.header.id,
        );
        expect(updated?.fields.get("student_session_index_version")).toBe("1");
    });
});

describe("recovery scanning fallbacks", () => {
    it("ignores an unpublished commit whose root cannot be verified", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("bad tail root"));
        const second = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const bytes = (await bytesOf(second)).slice(0, -32);
        const commitFrame = decodeRecordFrame(bytes.subarray(Number(second.commit.offset)));
        const payload = commitFrame.storedPayload.slice();
        payload[32] = payload[32]! ^ 0xff;
        rewriteFrame(bytes, Number(second.commit.offset), payload);
        const reopened = await openArchiveBytes(bytes);
        await expect(recoverUnpublishedCommit(reopened)).rejects.toMatchObject({
            code: "archive_recovery_not_available",
        });
    });

    it("passes over crash bytes that contain locator magic", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("fake locator gap"));
        const bytes = await bytesOf(base);
        const locator = bytes.slice(-32);
        const commitEnd =
            Number(base.commit.offset) +
            decodeRecordFrame(bytes.subarray(Number(base.commit.offset))).endOffset;
        const gap = new Uint8Array(70_000);
        gap.set(new TextEncoder().encode("TUXLOC1\0"), 0);
        const combined = new Uint8Array(commitEnd + gap.length + locator.length);
        combined.set(bytes.subarray(0, commitEnd));
        combined.set(gap, commitEnd);
        combined.set(locator, commitEnd + gap.length);
        const snapshot = await openArchiveBytes(combined);
        const repaired = await repairArchiveSnapshot(snapshot);
        expect(repaired.selectedGeneration).toBe(1n);
    }, 30_000);
});

describe("source bounds", () => {
    it("bounds the segmented source used by encrypted archives", async () => {
        const plaintext = await openArchiveBytes(await createArchiveBytes("segmented bounds"));
        const snapshot = await plaintext.enableEncryption("correct horse battery");
        await expect(snapshot.source.read(snapshot.source.size + 1n, 1)).rejects.toThrow(
            RangeError,
        );
        expect((await snapshot.source.read(0n, 0)).byteLength).toBe(0);
    });

    it("bounds and stitches the compacted source", async () => {
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("compacted bounds")),
            [record(RecordType.student, newUuid(), { display_name: "A" })],
        );
        const compacted = await compactArchiveSnapshot(snapshot);
        const source = compacted.snapshot.source;
        await expect(source.read(source.size + 1n, 1)).rejects.toThrow(RangeError);
        const frameOffset = Number(
            compacted.snapshot
                .allIndexEntries()
                .get(primaryKey(RecordType.settings, compacted.snapshot.header.id))!,
        );
        const headerPart = await source.read(BigInt(frameOffset), 10);
        expect(headerPart.byteLength).toBe(10);
        const payloadPart = await source.read(BigInt(frameOffset + 80), 4);
        expect(payloadPart.byteLength).toBe(4);
    });

    it("bounds the prefix source returned with a discarded tail", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("prefix bounds"));
        const bytes = await bytesOf(base);
        const withTail = new Uint8Array(bytes.length + 8);
        withTail.set(bytes);
        withTail.set([1, 2, 3, 4, 5, 6, 7, 8], bytes.length);
        const snapshot = await openArchiveBytes(withTail);
        const discarded = await discardUncommittedTail(snapshot);
        await expect(
            discarded.snapshot.source.read(discarded.snapshot.source.size + 1n, 1),
        ).rejects.toThrow(RangeError);
    });
});

describe("encryption content verification", () => {
    it("rejects a record that changes while the archive is being encrypted", async () => {
        const student = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("drift encrypt"));
        const snapshot = await appendRecords(base, [
            record(RecordType.student, student, { display_name: "aaaa" }),
        ]);
        const bytes = await bytesOf(snapshot);
        const offset = Number(
            snapshot.allIndexEntries().get(primaryKey(RecordType.student, student))!,
        );
        const frame = decodeRecordFrame(bytes.subarray(offset));
        const frameLength = frame.endOffset;
        const replacement = encodeRecordFrame(
            {
                type: frame.type,
                id: frame.id,
                revision: frame.revision,
                previousOffset: frame.previousOffset,
            },
            encodeRecordPayload(record(RecordType.student, student, { display_name: "bbbb" })),
        );
        expect(replacement.byteLength).toBe(frameLength);
        const rewrite = new RewriteAfterReadsSource(bytes, { offset, replacement }, 7);
        const drifting = await openArchiveSource(rewrite);
        await expect(drifting.enableEncryption("correct horse battery")).rejects.toMatchObject({
            code: "archive_encryption_verification_failed",
        });
        expect(rewrite.fullReads).toBe(7);
    });
});

describe("legacy secondary index backfill", () => {
    it("keeps an existing alias that already matches its record", async () => {
        const student = newUuid();
        const session = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("legacy alias match")),
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
        const proxy = new Proxy(snapshot, {
            get(target, property) {
                if (property === "getRecord") {
                    return async (type: number, id: string) => {
                        if (type === RecordType.settings && id.toLowerCase() === target.header.id) {
                            return { ...(await target.getRecord(type, id))!, fields };
                        }
                        return target.getRecord(type, id);
                    };
                }
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        const updated = await appendRecords(proxy, [
            record(RecordType.student, student, { display_name: "B" }),
        ]);
        const stored = await updated.getRecord(RecordType.settings, updated.header.id);
        expect(stored?.fields.get("student_session_index_version")).toBe("1");
    });
});

describe("re-key content verification", () => {
    it("rejects a record that changes while the passphrase is rotated", async () => {
        const passphrase = "correct horse battery";
        const nextPassphrase = "another horse battery";
        const opened = await openArchiveBytes(
            await createEncryptedArchiveBytes("drift rekey", "", passphrase),
        );
        const unlocked = await opened.unlock(passphrase);
        const student = newUuid();
        const first = await appendRecords(unlocked, [
            record(RecordType.student, student, { display_name: "aaaa" }),
        ]);
        const second = await appendRecords(first, [
            record(RecordType.student, student, { display_name: "bbbb" }),
        ]);
        const bytes = await bytesOf(second);
        const rev2Offset = Number(
            second.allIndexEntries().get(primaryKey(RecordType.student, student))!,
        );
        const rev2Frame = decodeRecordFrame(bytes.subarray(rev2Offset));
        const rev1Offset = Number(rev2Frame.previousOffset);
        const rev1Frame = decodeRecordFrame(bytes.subarray(rev1Offset));
        expect(rev1Frame.endOffset).toBe(rev2Frame.endOffset);
        const replacement = bytes.slice(rev1Offset, rev1Offset + rev1Frame.endOffset);
        const rewrite = new RewriteAfterReadsSource(bytes, { offset: rev2Offset, replacement }, 7);
        const drifting = await (await openArchiveSource(rewrite)).unlock(passphrase);
        await expect(drifting.changePassphrase(passphrase, nextPassphrase)).rejects.toMatchObject({
            code: "archive_rekey_verification_failed",
        });
        expect(rewrite.fullReads).toBe(7);
    });
});
