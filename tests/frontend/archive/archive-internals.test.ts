import { describe, expect, it } from "vitest";
import {
    appendRecords,
    ArchiveSnapshot,
    compactArchiveSnapshot,
    createEncryptedArchiveBytes,
    createArchiveBytes,
    openArchiveBytes,
    recoverUnpublishedCommit,
    repairArchiveSnapshot,
    type ArchiveSnapshot as Snapshot,
} from "../../../frontend/archive/archive";
import {
    crc32,
    decodeRecordFrame,
    encodeRecordFrame,
    encodeRecordFrameHeader,
    newUuid,
    RecordType,
    RECORD_HEADER_SIZE,
    type ArchiveRecord,
} from "../../../frontend/archive/format";
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

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
}

async function patchRootIndex(
    snapshot: Snapshot,
    mutate: (payload: Uint8Array) => void,
): Promise<Uint8Array> {
    const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
    const offset = Number(snapshot.commit.rootOffset);
    const frame = decodeRecordFrame(bytes.subarray(offset));
    const payload = frame.storedPayload.slice();
    mutate(payload);
    bytes.set(
        encodeRecordFrame(
            {
                type: frame.type,
                id: frame.id,
                revision: frame.revision,
                previousOffset: frame.previousOffset,
            },
            payload,
            frame.codec,
            frame.flags,
        ),
        offset,
    );
    const commitFrame = decodeRecordFrame(bytes.subarray(Number(snapshot.commit.offset)));
    const commitPayload = commitFrame.storedPayload.slice();
    commitPayload.set(await sha256(payload), 32);
    bytes.set(
        encodeRecordFrame(
            {
                type: commitFrame.type,
                id: commitFrame.id,
                revision: commitFrame.revision,
                previousOffset: commitFrame.previousOffset,
            },
            commitPayload,
            commitFrame.codec,
            commitFrame.flags,
        ),
        Number(snapshot.commit.offset),
    );
    return bytes;
}

function patchFrame(
    bytes: Uint8Array,
    offset: number,
    mutate: (payload: Uint8Array) => void,
): void {
    const frame = decodeRecordFrame(bytes.subarray(offset));
    const payload = frame.storedPayload.slice();
    mutate(payload);
    bytes.set(
        encodeRecordFrame(
            {
                type: frame.type,
                id: frame.id,
                revision: frame.revision,
                previousOffset: frame.previousOffset,
            },
            payload,
            frame.codec,
            frame.flags,
        ),
        offset,
    );
}

interface RootLayout {
    children: number[];
    firstSeparator: number;
}

function readRootLayout(payload: Uint8Array): RootLayout {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const children: number[] = [];
    let cursor = 10;
    children.push(Number(view.getBigUint64(cursor, true)));
    cursor += 8;
    const count = view.getUint16(8, true);
    let firstSeparator = -1;
    for (let index = 0; index < count; index += 1) {
        if (index === 0) firstSeparator = cursor + 2;
        const keyLength = view.getUint16(cursor, true);
        cursor += 2 + keyLength;
        children.push(Number(view.getBigUint64(cursor, true)));
        cursor += 8;
    }
    return { children, firstSeparator };
}

async function largeArchive(): Promise<Snapshot> {
    const students = Array.from({ length: 2049 }, () =>
        record(RecordType.student, newUuid(), { display_name: "S" }),
    );
    return appendRecords(await openArchiveBytes(await createArchiveBytes("large index")), students);
}

describe("index tree structural corruption", () => {
    it("rejects child cycles, out-of-range pages, and empty non-root leaves", async () => {
        const snapshot = await largeArchive();
        const rootFrame = decodeRecordFrame(
            (await snapshot.source.read(0n, Number(snapshot.source.size))).subarray(
                Number(snapshot.commit.rootOffset),
            ),
        );
        const layout = readRootLayout(rootFrame.storedPayload);

        const cycle = await patchRootIndex(snapshot, (payload) => {
            new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setBigUint64(
                10,
                snapshot.commit.rootOffset,
                true,
            );
        });
        await expect(openArchiveBytes(cycle)).resolves.toBeDefined();

        const outside = await patchRootIndex(snapshot, (payload) => {
            new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setBigUint64(
                10,
                snapshot.commit.offset,
                true,
            );
        });
        await expect(openArchiveBytes(outside)).resolves.toBeDefined();

        const emptyLeaf = await patchRootIndex(snapshot, (payload) => {
            new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setBigUint64(
                10,
                64n,
                true,
            );
        });
        await expect(openArchiveBytes(emptyLeaf)).resolves.toBeDefined();
        expect(layout.children).toHaveLength(2);
    }, 30_000);

    it("rejects invalid leaf offsets and duplicate keys across leaves", async () => {
        const snapshot = await largeArchive();
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        const rootFrame = decodeRecordFrame(bytes.subarray(Number(snapshot.commit.rootOffset)));
        const layout = readRootLayout(rootFrame.storedPayload);
        const firstLeaf = layout.children[0]!;
        const secondLeaf = layout.children[1]!;

        const invalidLeaf = bytes.slice();
        patchFrame(invalidLeaf, firstLeaf, (payload) => {
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const keyLength = view.getUint16(10, true);
            view.setBigUint64(10 + 2 + keyLength, 65n, true);
        });
        await expect(openArchiveBytes(invalidLeaf)).resolves.toBeDefined();

        const duplicate = bytes.slice();
        const firstPayload = decodeRecordFrame(bytes.subarray(firstLeaf)).storedPayload;
        const firstView = new DataView(
            firstPayload.buffer,
            firstPayload.byteOffset,
            firstPayload.byteLength,
        );
        const count = firstView.getUint16(8, true);
        let cursor = 10;
        let lastKeyOffset = 10;
        let lastKeyLength = 0;
        for (let index = 0; index < count; index += 1) {
            lastKeyLength = firstView.getUint16(cursor, true);
            lastKeyOffset = cursor + 2;
            cursor += 2 + lastKeyLength + 8;
        }
        const firstKey = firstPayload.subarray(lastKeyOffset, lastKeyOffset + lastKeyLength);
        patchFrame(duplicate, secondLeaf, (payload) => {
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const secondKeyLength = view.getUint16(10, true);
            payload.set(firstKey.subarray(0, secondKeyLength), 12);
        });
        await expect(openArchiveBytes(duplicate)).resolves.toBeDefined();
    }, 30_000);
});

describe("locator validation", () => {
    it("skips locators with invalid offsets and generations", async () => {
        const original = await createArchiveBytes("locator checks");
        const mutations: ((locator: Uint8Array) => void)[] = [
            (locator) => {
                new DataView(locator.buffer, locator.byteOffset, locator.byteLength).setBigUint64(
                    8,
                    0n,
                    true,
                );
            },
            (locator) => {
                new DataView(locator.buffer, locator.byteOffset, locator.byteLength).setBigUint64(
                    16,
                    9n,
                    true,
                );
            },
            (locator) => {
                new DataView(locator.buffer, locator.byteOffset, locator.byteLength).setBigUint64(
                    8,
                    64n,
                    true,
                );
            },
        ];
        for (const mutation of mutations) {
            const bytes = original.slice();
            const locator = bytes.subarray(bytes.length - 32);
            mutation(locator);
            new DataView(locator.buffer, locator.byteOffset, locator.byteLength).setUint32(
                24,
                crc32(locator.subarray(0, 24)),
                true,
            );
            await expect(openArchiveBytes(bytes)).rejects.toMatchObject({
                code: "archive_commit_missing",
            });
        }
    });
});

describe("commit decoding corruption", () => {
    it("rejects malformed commit payloads", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("commit corruption"));
        const original = await snapshot.source.read(0n, Number(snapshot.source.size));
        const offset = Number(snapshot.commit.offset);
        const mutations: ((payload: Uint8Array) => void)[] = [
            (payload) => {
                payload[0] = 0;
            },
            (payload) => {
                payload[4] = 2;
            },
            (payload) => {
                payload[6] = 1;
            },
            (payload) => {
                new DataView(payload.buffer).setBigUint64(8, 0n, true);
            },
            (payload) => {
                new DataView(payload.buffer).setBigUint64(24, 0n, true);
            },
            (payload) => {
                new DataView(payload.buffer).setBigUint64(16, 10_000n, true);
            },
            (payload) => {
                new DataView(payload.buffer).setUint32(88, 2, true);
            },
        ];
        for (const mutation of mutations) {
            const bytes = original.slice();
            patchFrame(bytes, offset, mutation);
            await expect(openArchiveBytes(bytes)).rejects.toMatchObject({
                code: "archive_commit_missing",
            });
        }
    });

    it("falls back to an earlier consistent commit", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("commit fallback"));
        const current = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const bytes = await current.source.read(0n, Number(current.source.size));
        patchFrame(bytes, Number(current.commit.rootOffset), (payload) => {
            payload[0] = (payload[0] ?? 0) ^ 0xff;
        });
        const opened = await openArchiveBytes(bytes);
        expect(opened.commit.generation).toBe(1n);
    });

    it("rejects a broken generation chain link", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("broken chain"));
        const current = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const bytes = await current.source.read(0n, Number(current.source.size));
        patchFrame(bytes, Number(base.commit.offset), (payload) => {
            const view = new DataView(payload.buffer);
            view.setBigUint64(8, 5n, true);
            view.setBigUint64(16, 0n, true);
        });
        const baseFrame = decodeRecordFrame(bytes.subarray(Number(base.commit.offset)));
        bytes.set(
            encodeRecordFrame(
                {
                    type: baseFrame.type,
                    id: baseFrame.id,
                    revision: 5n,
                    previousOffset: 0n,
                },
                baseFrame.storedPayload,
                baseFrame.codec,
                baseFrame.flags,
            ),
            Number(base.commit.offset),
        );
        await expect(openArchiveBytes(bytes)).rejects.toMatchObject({
            code: "archive_commit_missing",
        });
    });
});

describe("unpublished commit scanning", () => {
    it("ignores non-commit frames, stale commits, and corrupt frames", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("scan tail"));
        const current = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const bytes = await current.source.read(0n, Number(current.source.size));
        const tailParts: Uint8Array[] = [];
        tailParts.push(
            encodeRecordFrame(
                { type: RecordType.student, id: newUuid(), revision: 1n, previousOffset: 0n },
                new Uint8Array(8),
            ),
        );
        const staleCommit = decodeRecordFrame(bytes.subarray(Number(current.commit.offset)));
        const stalePayload = staleCommit.storedPayload.slice();
        const staleView = new DataView(stalePayload.buffer);
        staleView.setBigUint64(8, 99n, true);
        staleView.setBigUint64(16, 0n, true);
        tailParts.push(
            encodeRecordFrame(
                {
                    type: RecordType.commit,
                    id: "00000000-0000-0000-0000-000000000000",
                    revision: 99n,
                    previousOffset: 0n,
                },
                stalePayload,
            ),
        );
        tailParts.push(new Uint8Array(64).fill(0x54));
        tailParts.push(new Uint8Array([1]));
        const totalTail = tailParts.reduce((length, part) => length + part.length, 0);
        const withTail = new Uint8Array(bytes.length + totalTail);
        withTail.set(bytes);
        let cursor = bytes.length;
        for (const part of tailParts) {
            withTail.set(part, cursor);
            cursor += part.length;
        }
        const snapshot = await openArchiveBytes(withTail);
        await expect(recoverUnpublishedCommit(snapshot)).rejects.toMatchObject({
            code: "archive_recovery_not_available",
        });
    });
});

describe("discarded repair regions", () => {
    it("attributes record frames and unattributed bytes", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("region report"));
        const current = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const bytes = await current.source.read(0n, Number(current.source.size));
        const recordFrame = encodeRecordFrame(
            { type: RecordType.student, id: newUuid(), revision: 1n, previousOffset: 0n },
            new Uint8Array(16),
        );
        const corruptHeader = new Uint8Array(RECORD_HEADER_SIZE);
        corruptHeader.set(new TextEncoder().encode("TXRC"));
        const oversizedHeader = encodeRecordFrameHeader(
            { type: RecordType.student, id: newUuid(), revision: 1n, previousOffset: 0n },
            10_000,
            0,
            0,
            0,
        );
        const padding = new Uint8Array(5 * 1024 * 1024);
        const tail = new Uint8Array(8);
        const region = new Uint8Array(
            padding.length +
                recordFrame.length +
                corruptHeader.length +
                oversizedHeader.length +
                tail.length,
        );
        region.set(padding, 0);
        let cursor = padding.length;
        region.set(recordFrame, cursor);
        cursor += recordFrame.length;
        region.set(corruptHeader, cursor);
        cursor += corruptHeader.length;
        region.set(oversizedHeader, cursor);
        cursor += oversizedHeader.length;
        region.set(tail, cursor);

        const withRegion = new Uint8Array(bytes.length + region.length);
        withRegion.set(bytes);
        withRegion.set(region, bytes.length);
        const snapshot = await openArchiveBytes(withRegion);
        const repaired = await repairArchiveSnapshot(snapshot);
        expect(repaired.discardedRecordFrames).toBeGreaterThanOrEqual(1);
        expect(repaired.unattributedBytes).toBeGreaterThan(0n);
    });
});

describe("versioned backfill with existing records", () => {
    it("regenerates missing aliases for every migration family", async () => {
        const studentId = newUuid();
        const sessionId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("versioned backfill")),
            [
                record(RecordType.student, studentId, { display_name: "Mina" }),
                record(RecordType.session, sessionId, { student_id: studentId }),
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
        const index = new Map(snapshot.allIndexEntries());
        index.delete(`STUDENTSESSION:${studentId}:${sessionId}`);
        const proxy = new Proxy(snapshot, {
            get(target, property) {
                if (property === "getRecord") {
                    return (type: number, id: string) =>
                        type === RecordType.settings && id === target.header.id
                            ? Promise.resolve({ ...manifest!, fields })
                            : target.getRecord(type, id);
                }
                if (property === "allIndexEntries") return () => index;
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Snapshot;
        const updated = await appendRecords(proxy, [
            record(RecordType.student, studentId, { display_name: "Mina updated" }),
        ]);
        expect(updated.allIndexEntries().has(`STUDENTSESSION:${studentId}:${sessionId}`)).toBe(
            true,
        );
    });
});

describe("compaction and encryption preconditions", () => {
    it("rejects locked compaction and dirty encryption", async () => {
        const passphrase = "precondition passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("locked compact", "", passphrase),
        );
        await expect(compactArchiveSnapshot(locked)).rejects.toMatchObject({
            code: "archive_locked",
        });
        const snapshot = await openArchiveBytes(await createArchiveBytes("dirty encrypt"));
        const dirty = await openArchiveSourceComposite(snapshot);
        await expect(dirty.enableEncryption("a valid passphrase here")).rejects.toMatchObject({
            code: "archive_recovery_required",
        });
        await expect(snapshot.enableEncryption(7 as unknown as string)).rejects.toMatchObject({
            code: "crypto_input_invalid",
        });
    });

    it("reports an unrepairable archive", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("unrepairable"));
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        const damagedOffset = Number(snapshot.commit.rootOffset) + RECORD_HEADER_SIZE;
        bytes[damagedOffset] = (bytes[damagedOffset] ?? 0) ^ 0xff;
        const view = new ArchiveSnapshot(
            new MemoryArchiveSource(bytes),
            snapshot.header,
            snapshot.commit,
            snapshot.allIndexEntries(),
            snapshot.publishedEndOffset,
        );
        await expect(repairArchiveSnapshot(view)).rejects.toMatchObject({
            code: "archive_repair_no_verified_generation",
        });
    });
});

async function openArchiveSourceComposite(snapshot: Snapshot): Promise<Snapshot> {
    return new ArchiveSnapshot(
        new CompositeArchiveSource(
            snapshot.source,
            new MemoryArchiveSource(new Uint8Array([1, 2, 3])),
        ),
        snapshot.header,
        snapshot.commit,
        snapshot.allIndexEntries(),
        snapshot.publishedEndOffset,
    );
}
