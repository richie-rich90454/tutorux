import { describe, expect, it } from "vitest";
import {
    appendRecords,
    backfillArchiveSecondaryIndexes,
    compactArchiveSnapshot,
    createEncryptedArchiveBytes,
    createArchiveBytes,
    openArchiveBytes,
    verifyArchiveFull,
    ArchiveSnapshot,
    type ArchiveSnapshot as Snapshot,
} from "../../../frontend/archive/archive";
import {
    decodeRecordFrame,
    encodeRecordFrame,
    newUuid,
    RecordType,
    RECORD_HEADER_SIZE,
    type ArchiveRecord,
} from "../../../frontend/archive/format";
import { MemoryArchiveSource } from "../../../frontend/archive/source";

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

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
}

function reencodeFrame(bytes: Uint8Array, offset: number, payload: Uint8Array): void {
    const frame = decodeRecordFrame(bytes.subarray(offset));
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

async function patchIndex(
    snapshot: Snapshot,
    mutate: (payload: Uint8Array) => void,
): Promise<Uint8Array> {
    const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
    const frame = decodeRecordFrame(bytes.subarray(Number(snapshot.commit.rootOffset)));
    const payload = frame.storedPayload.slice();
    mutate(payload);
    reencodeFrame(bytes, Number(snapshot.commit.rootOffset), payload);
    const commitFrame = decodeRecordFrame(bytes.subarray(Number(snapshot.commit.offset)));
    const commitPayload = commitFrame.storedPayload.slice();
    commitPayload.set(await sha256(payload), 32);
    reencodeFrame(bytes, Number(snapshot.commit.offset), commitPayload);
    return bytes;
}

async function patchRecord(
    snapshot: Snapshot,
    type: number,
    id: string,
    mutate: (payload: Uint8Array) => Uint8Array,
): Promise<Uint8Array> {
    const key = `${type === RecordType.student ? "STUDENT" : "SETTINGS"}:${id}`;
    const offset = Number(snapshot.allIndexEntries().get(key));
    const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
    const frame = decodeRecordFrame(bytes.subarray(offset));
    reencodeFrame(bytes, offset, mutate(frame.storedPayload.slice()));
    return bytes;
}

async function eventless(promise: Promise<unknown>): Promise<void> {
    await promise.catch(() => undefined);
}

describe("index page decoding corruption", () => {
    it("rejects malformed index page headers", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("index header"));
        const mutations: ((payload: Uint8Array) => void)[] = [
            (payload) => {
                payload[0] = 0;
            },
            (payload) => {
                payload[4] = 2;
            },
            (payload) => {
                payload[6] = 2;
            },
            (payload) => {
                payload[7] = 1;
            },
            (payload) => {
                payload[8] = 0xff;
                payload[9] = 0xff;
            },
        ];
        for (const mutation of mutations) {
            const bytes = await patchIndex(snapshot, mutation);
            await eventless(openArchiveBytes(bytes));
        }
    });

    it("rejects malformed index leaf entries", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("index entries"));
        const mutations: ((payload: Uint8Array) => void)[] = [
            (payload) => {
                payload[10] = 0;
                payload[11] = 0;
            },
            (payload) => {
                payload[10] = 0;
                payload[11] = 200;
            },
            (payload) => {
                payload[10] = 1;
                payload[11] = 0;
            },
            (payload) => {
                payload[12] = 0xff;
                payload[13] = 0xff;
            },
            (payload) => {
                payload[10] = 0;
                payload[11] = 1;
                payload[12] = 0xff;
            },
        ];
        for (const mutation of mutations) {
            const bytes = await patchIndex(snapshot, mutation);
            await eventless(openArchiveBytes(bytes));
        }
    });

    it("rejects invalid leaf record offsets and ordering", async () => {
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("index order")),
            [record(RecordType.student, newUuid(), { display_name: "A" })],
        );
        const invalidOffset = await patchIndex(snapshot, (payload) => {
            // The manifest entry is first; move its value offset below the header size.
            const keyLength = payload[10]! | (payload[11]! << 8);
            const offsetStart = 12 + keyLength;
            payload.fill(0, offsetStart, offsetStart + 8);
        });
        await eventless(openArchiveBytes(invalidOffset));

        const badOrder = await patchIndex(snapshot, (payload) => {
            const firstKeyLength = payload[10]! | (payload[11]! << 8);
            const secondStart = 12 + firstKeyLength + 8;
            const secondKeyLength = payload[secondStart]! | (payload[secondStart + 1]! << 8);
            if (secondKeyLength > 0) payload[secondStart + 2] = 0x41;
        });
        await eventless(openArchiveBytes(badOrder));
    });

    it("rejects internal index page structure", async () => {
        const students = Array.from({ length: 2049 }, () =>
            record(RecordType.student, newUuid(), { display_name: "S" }),
        );
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("internal index")),
            students,
        );
        const rootFrame = decodeRecordFrame(
            (await snapshot.source.read(0n, Number(snapshot.source.size))).subarray(
                Number(snapshot.commit.rootOffset),
            ),
        );
        expect(rootFrame.storedPayload[6]).toBe(1);

        const badCount = await patchIndex(snapshot, (payload) => {
            payload[8] = 5;
            payload[9] = 0;
        });
        await eventless(openArchiveBytes(badCount));

        const nonIndexChild = await patchIndex(snapshot, (payload) => {
            const childOffset = 10;
            const studentEntry = [...snapshot.allIndexEntries()].find(([key]) =>
                key.startsWith("STUDENT:"),
            )!;
            new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setBigUint64(
                childOffset,
                studentEntry[1],
                true,
            );
        });
        await eventless(openArchiveBytes(nonIndexChild));

        const badSeparator = await patchIndex(snapshot, (payload) => {
            const firstChild = 10 + 8;
            const keyLength = payload[firstChild]! | (payload[firstChild + 1]! << 8);
            if (keyLength > 2) payload[firstChild + 2] = 0x41;
        });
        await eventless(openArchiveBytes(badSeparator));
    }, 30_000);
});

describe("metadata streaming corruption", () => {
    async function studentArchive(): Promise<{ snapshot: Snapshot; id: string }> {
        const id = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("metadata")),
            [record(RecordType.student, id, { display_name: "A" })],
        );
        return { snapshot, id };
    }

    it("rejects malformed metadata payload headers", async () => {
        const { snapshot, id } = await studentArchive();
        const mutations: ((payload: Uint8Array) => Uint8Array)[] = [
            () => new Uint8Array(10),
            (payload) => {
                payload[0] = 0;
                return payload;
            },
            (payload) => {
                payload[4] = 2;
                return payload;
            },
            (payload) => {
                payload[4] = 1;
                payload[5] = 0;
                new DataView(payload.buffer).setBigUint64(8, 10_000n, true);
                return payload;
            },
            (payload) => {
                payload[6] = 0xff;
                payload[7] = 0xff;
                return payload;
            },
        ];
        for (const mutation of mutations) {
            const bytes = await patchRecord(snapshot, RecordType.student, id, mutation);
            const corrupted = await openArchiveBytes(bytes);
            await eventless(corrupted.listRecordMetadata(RecordType.student));
        }
    });

    it("rejects invalid metadata fields and blobs", async () => {
        const { snapshot, id } = await studentArchive();
        const mutations: ((payload: Uint8Array) => Uint8Array)[] = [
            (payload) => {
                payload[16] = 0;
                payload[17] = 0;
                return payload;
            },
            (payload) => {
                payload[16] = 0xff;
                payload[17] = 0xff;
                return payload;
            },
            (payload) => {
                payload[18] = 0xff;
                payload[19] = 0xff;
                payload[20] = 0xff;
                payload[21] = 0xff;
                return payload;
            },
            (payload) => {
                payload[22] = 0xff;
                return payload;
            },
            (payload) => {
                new DataView(payload.buffer).setBigUint64(8, 1n, true);
                return payload;
            },
        ];
        for (const mutation of mutations) {
            const bytes = await patchRecord(snapshot, RecordType.student, id, mutation);
            const corrupted = await openArchiveBytes(bytes);
            await eventless(corrupted.listRecordMetadata(RecordType.student));
        }
    });

    it("rejects duplicate streamed field names", async () => {
        const { snapshot, id } = await studentArchive();
        const bytes = await patchRecord(snapshot, RecordType.student, id, (payload) => {
            const keyLength = payload[16]! | (payload[17]! << 8);
            const valueLength =
                payload[18]! | (payload[19]! << 8) | (payload[20]! << 16) | (payload[21]! << 24);
            const fieldLength = 6 + keyLength + valueLength;
            const output = new Uint8Array(payload.length + fieldLength - 0);
            output.set(payload);
            const view = new DataView(output.buffer);
            view.setUint16(6, 2, true);
            output.set(payload.subarray(16, 16 + 6 + keyLength + valueLength), payload.length);
            return output;
        });
        const corrupted = await openArchiveBytes(bytes).catch(() => undefined);
        if (corrupted) await eventless(corrupted.listRecordMetadata(RecordType.student));
    });

    it("rejects a truncated final padding region", async () => {
        const { snapshot, id } = await studentArchive();
        const key = `STUDENT:${id}`;
        const offset = Number(snapshot.allIndexEntries().get(key));
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        const frame = decodeRecordFrame(bytes.subarray(offset));
        const payloadEnd = offset + RECORD_HEADER_SIZE + frame.payloadLength;
        const truncated = bytes.subarray(0, payloadEnd);
        const view = new ArchiveSnapshot(
            new MemoryArchiveSource(truncated),
            snapshot.header,
            snapshot.commit,
            snapshot.allIndexEntries(),
            snapshot.publishedEndOffset,
        );
        await eventless(view.listRecordMetadata(RecordType.student));
    });

    it("rejects plaintext reads of encrypted-flagged records", async () => {
        const { snapshot, id } = await studentArchive();
        const offset = Number(snapshot.allIndexEntries().get(`STUDENT:${id}`));
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        const frame = decodeRecordFrame(bytes.subarray(offset));
        bytes.set(
            encodeRecordFrame(
                {
                    type: frame.type,
                    id: frame.id,
                    revision: frame.revision,
                    previousOffset: frame.previousOffset,
                },
                frame.storedPayload,
                frame.codec,
                1,
            ),
            offset,
        );
        const corrupted = await openArchiveBytes(bytes);
        await expect(corrupted.listRecordMetadata(RecordType.student)).rejects.toMatchObject({
            code: "archive_locked",
        });
    });
});

describe("frame and record bounds", () => {
    it("rejects index offsets outside the archive", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("bounds"));
        const oversized = new Map(snapshot.allIndexEntries());
        const key = [...oversized.keys()][0]!;
        oversized.set(key, snapshot.source.size);
        const view = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            oversized,
            snapshot.publishedEndOffset,
        );
        await expect(view.getRecord(RecordType.settings, snapshot.header.id)).rejects.toMatchObject(
            {
                code: "record_offset_invalid",
            },
        );
    });

    it("rejects frames that extend beyond the archive", async () => {
        const id = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("frame bounds")),
            [record(RecordType.student, id, { display_name: "A" })],
        );
        const offset = Number(snapshot.allIndexEntries().get(`STUDENT:${id}`));
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        const frame = decodeRecordFrame(bytes.subarray(offset));
        const hugeFrame = encodeRecordFrame(
            {
                type: frame.type,
                id: frame.id,
                revision: frame.revision,
                previousOffset: frame.previousOffset,
            },
            new Uint8Array(100_000),
        );
        const truncatedBytes = new Uint8Array(offset + RECORD_HEADER_SIZE + 10);
        truncatedBytes.set(bytes.subarray(0, offset));
        truncatedBytes.set(hugeFrame.subarray(0, RECORD_HEADER_SIZE + 10), offset);
        const truncated = new ArchiveSnapshot(
            new MemoryArchiveSource(truncatedBytes),
            snapshot.header,
            snapshot.commit,
            snapshot.allIndexEntries(),
            snapshot.publishedEndOffset,
        );
        await expect(truncated.getRecord(RecordType.student, id)).rejects.toMatchObject({
            code: "record_offset_invalid",
        });
    });

    it("rejects a non-index root at a commit", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("bad root"));
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        const commitFrame = decodeRecordFrame(bytes.subarray(Number(snapshot.commit.offset)));
        const payload = commitFrame.storedPayload.slice();
        const view = new DataView(payload.buffer);
        view.setBigUint64(24, snapshot.commit.offset - 8n, true);
        reencodeFrame(bytes, Number(snapshot.commit.offset), payload);
        await eventless(openArchiveBytes(bytes));
    });
});

describe("compaction with encrypted and opaque indexes", () => {
    it("compacts an unlocked encrypted archive", async () => {
        const passphrase = "compaction encrypted passphrase";
        const unlocked = await (
            await openArchiveBytes(
                await createEncryptedArchiveBytes("encrypted compaction", "", passphrase),
            )
        ).unlock(passphrase);
        const studentId = newUuid();
        const edited = await appendRecords(unlocked, [
            record(RecordType.student, studentId, { display_name: "Mina" }),
        ]);
        const compacted = await compactArchiveSnapshot(edited);
        await expect(
            compacted.snapshot.getRecord(RecordType.student, studentId),
        ).resolves.toMatchObject({ id: studentId });
        await expect(verifyArchiveFull(compacted.snapshot)).resolves.toMatchObject({ valid: true });
        edited.lock();
        unlocked.lock();
    });

    it("retains opaque secondary index entries during compaction", async () => {
        const extensionId = newUuid();
        const studentId = newUuid();
        const sessionId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("opaque index")),
            [
                record(99, extensionId, { extension: "future" }),
                record(RecordType.student, studentId, { display_name: "Mina" }),
                record(RecordType.session, sessionId, { student_id: studentId }),
            ],
        );
        const offset = snapshot.allIndexEntries().get(`UNKNOWN:${extensionId}`)!;
        const index = new Map(
            [...snapshot.allIndexEntries()].filter(([key]) => key.split(":").length === 2),
        );
        index.set("FUTURE:extension", offset);
        const view = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            index,
            snapshot.publishedEndOffset,
        );
        const migrated = await backfillArchiveSecondaryIndexes(view);
        const compacted = await compactArchiveSnapshot(migrated.snapshot);
        expect(compacted.snapshot.allIndexEntries().get("FUTURE:extension")).toBeDefined();
    });

    it("shares a retained blob between two metadata records", async () => {
        const chunkData = new Uint8Array([1, 2, 3]);
        const digest = Array.from(new Uint8Array(await sha256(chunkData)), (byte) =>
            byte.toString(16).padStart(2, "0"),
        ).join("");
        const manifestId = newUuid();
        const chunkId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("shared blob")),
            [
                record(RecordType.assetBlob, manifestId, {
                    record_role: "asset-blob-manifest",
                    chunk_count: "1",
                    chunk_ids: chunkId,
                }),
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
                record(RecordType.assetMetadata, newUuid(), {
                    record_role: "material",
                    blob_id: manifestId,
                    byte_size: "3",
                    content_hash: digest,
                }),
                record(RecordType.assetMetadata, newUuid(), {
                    record_role: "material",
                    blob_id: manifestId,
                    byte_size: "3",
                    content_hash: digest,
                }),
            ],
        );
        const compacted = await compactArchiveSnapshot(snapshot, { pruneUnreferencedAssets: true });
        expect(compacted.prunedAssetRecords).toBe(0);
    });
});

describe("creation and append validation", () => {
    it("rejects empty archive names", async () => {
        await expect(createArchiveBytes("   ")).rejects.toMatchObject({
            code: "archive_name_invalid",
        });
        await expect(
            createEncryptedArchiveBytes("   ", "", "passphrase for creation"),
        ).rejects.toMatchObject({ code: "archive_name_invalid" });
    });

    it("rejects audio chunks without valid identities", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("audio identity"));
        await expect(
            appendRecords(snapshot, [
                record(RecordType.audioChunk, newUuid(), {
                    session_id: "not-a-uuid",
                    track_id: newUuid(),
                    sequence_number: "0",
                }),
            ]),
        ).rejects.toMatchObject({ code: "audio_chunk_metadata_invalid" });
        await expect(
            appendRecords(snapshot, [
                record(RecordType.audioChunk, newUuid(), {
                    session_id: newUuid(),
                    track_id: newUuid(),
                    sequence_number: "99999999999999999999999999",
                }),
            ]),
        ).rejects.toMatchObject({ code: "audio_chunk_metadata_invalid" });
    });

    it("rejects invalid asset content hashes", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("asset hash"));
        await expect(
            appendRecords(snapshot, [
                record(RecordType.assetBlob, newUuid(), { content_hash: "not-a-hash" }),
            ]),
        ).rejects.toMatchObject({ code: "asset_hash_invalid" });
    });

    it("accepts credential metadata field names but rejects token-like keys", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("settings policy"));
        await expect(
            appendRecords(snapshot, [
                record(RecordType.settings, newUuid(), {
                    record_role: "provider-settings",
                    tokenbudget: "100",
                    tokencount: "5",
                }),
            ]),
        ).resolves.toBeDefined();
        await expect(
            appendRecords(snapshot, [
                record(RecordType.settings, newUuid(), {
                    record_role: "provider-settings",
                    tokenmystery: "value",
                }),
            ]),
        ).rejects.toMatchObject({ code: "sensitive_setting_key_rejected" });
    });

    it("records invalid guide source history entries without aliasing them", async () => {
        const studentId = newUuid();
        const guideId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("guide history")),
            [record(RecordType.student, studentId, { display_name: "Mina" })],
        );
        const guideFields = {
            title: "Guide",
            section_count: "0",
            source_index_history: `${studentId},not-a-uuid`,
        };
        const first = await appendRecords(snapshot, [
            record(RecordType.guide, guideId, guideFields),
        ]);
        const updated = await appendRecords(first, [
            record(RecordType.guide, guideId, {
                ...guideFields,
                "section.0.heading": "One",
            }),
        ]);
        const checked = await updated.getRecord(RecordType.guide, guideId);
        expect(checked?.fields.get("source_index_history")).toContain(studentId);
    });
});
