import { describe, expect, it } from "vitest";
import {
    appendRecords,
    appendStagedAssetRecords,
    ArchiveSnapshot,
    backfillArchiveSecondaryIndexes,
    compactArchiveSnapshot,
    createArchiveBytes,
    createEncryptedArchiveBytes,
    openArchiveBytes,
    openArchiveSourceForRecovery,
    rebuildDamagedPrimaryIndex,
    recoverChecksumDamagedArchiveHeader,
    recoverMagicDamagedArchiveHeader,
    verifyArchiveFull,
    type ArchiveSnapshot as Snapshot,
} from "../../../frontend/archive/archive";
import {
    decodeRecordFrame,
    decodeRecordPayload,
    decodeStoredPayload,
    encodeRecordFrame,
    encodeRecordFrameHeader,
    encodeRecordPayload,
    newUuid,
    RecordType,
    RECORD_HEADER_SIZE,
    type ArchiveRecord,
} from "../../../frontend/archive/format";
import { MemoryArchiveSource, type ArchiveByteSource } from "../../../frontend/archive/source";
import type { ArchiveStaging } from "../../../frontend/archive/staging";
import { ArchiveDataKey, encryptionEnvelopeFromRecord } from "../../../frontend/archive/crypto";

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

function proxySnapshot(snapshot: Snapshot, overrides: Record<string, unknown>): Snapshot {
    return new Proxy(snapshot, {
        get(target, property) {
            if (typeof property === "string" && property in overrides) return overrides[property];
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

function primaryKeyOnly(snapshot: Snapshot): Map<string, bigint> {
    return new Map([...snapshot.allIndexEntries()].filter(([key]) => key.split(":").length === 2));
}

function reencodeAt(bytes: Uint8Array, offset: number, payload: Uint8Array): void {
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

describe("audio metadata fallback", () => {
    it("falls back to primary audio indexes when session indexes are absent", async () => {
        const sessionId = newUuid();
        const trackId = newUuid();
        const chunkA = newUuid();
        const chunkB = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("audio fallback")),
            [
                record(RecordType.session, sessionId, {}),
                record(RecordType.audioChunk, chunkA, {
                    session_id: sessionId,
                    track_id: trackId,
                    sequence_number: "1",
                }),
                record(RecordType.audioChunk, chunkB, {
                    session_id: sessionId,
                    track_id: trackId,
                    sequence_number: "2",
                }),
            ],
        );
        const index = new Map(
            [...snapshot.allIndexEntries()].filter(([key]) => !key.startsWith("AUDIOSESSION:")),
        );
        const view = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            index,
            snapshot.publishedEndOffset,
        );
        const metadata = await view.listAudioChunkMetadata(sessionId, trackId);
        expect(metadata.map((item) => item.id)).toEqual([chunkA, chunkB]);
        const deletedView = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            index,
            snapshot.publishedEndOffset,
        );
        expect(await deletedView.listAudioChunkMetadata(sessionId, trackId, true)).toHaveLength(2);
    });
});

describe("non-error verification failures", () => {
    it("stringifies thrown non-errors", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("non-error"));
        const proxy = proxySnapshot(snapshot, {
            getManifest: () => {
                throw "plain failure";
            },
        });
        const report = await verifyArchiveFull(proxy);
        expect(report.valid).toBe(false);
        expect(report.issues).toContain("plain failure");
    });
});

describe("encryption of opaque records", () => {
    it("retains and encrypts opaque secondary index targets", async () => {
        const extensionId = newUuid();
        const studentId = newUuid();
        const sessionId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("opaque encrypt")),
            [
                record(99, extensionId, { extension: "future payload" }),
                record(RecordType.student, studentId, { display_name: "Mina" }),
                record(RecordType.session, sessionId, { student_id: studentId }),
            ],
        );
        const extensionOffset = snapshot.allIndexEntries().get(`UNKNOWN:${extensionId}`)!;
        const index = primaryKeyOnly(snapshot);
        index.delete(`UNKNOWN:${extensionId}`);
        index.set(`FUTURE:${extensionId}`, extensionOffset);
        const view = proxySnapshot(snapshot, { allIndexEntries: () => index });
        const migrated = await backfillArchiveSecondaryIndexes(view);
        const opaqueKey = `FUTURE:${extensionId}`;
        const encrypted = await migrated.snapshot.enableEncryption("opaque encryption passphrase");
        expect(encrypted.encrypted).toBe(true);
        expect(encrypted.allIndexEntries().has(opaqueKey)).toBe(true);
        const opaque = await encrypted.getRecordByIndexKey(opaqueKey);
        expect(opaque?.fields.get("extension")).toBe("future payload");
        await expect(verifyArchiveFull(encrypted)).resolves.toMatchObject({ valid: true });
        encrypted.lock();
        migrated.snapshot.lock();
    });
});

describe("encrypted index migration", () => {
    it("backfills indexes on an unlocked encrypted archive", async () => {
        const passphrase = "encrypted backfill passphrase";
        const unlocked = await (
            await openArchiveBytes(
                await createEncryptedArchiveBytes("encrypted backfill", "", passphrase),
            )
        ).unlock(passphrase);
        const result = await backfillArchiveSecondaryIndexes(unlocked);
        expect(result.schemaVersionsUpdated).toBe(true);
        expect(result.snapshot.commit.generation).toBe(2n);
        expect(result.snapshot.encrypted).toBe(true);
        await expect(verifyArchiveFull(result.snapshot)).resolves.toMatchObject({ valid: true });
        result.snapshot.lock();
        unlocked.lock();
    });
});

describe("staged import close failures", () => {
    it("closes the failed staging source and abort failures are ignored", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("stage failure"));
        let closed = 0;
        const staging: ArchiveStaging = {
            async append() {
                return Promise.resolve();
            },
            async seal(): Promise<ArchiveByteSource> {
                return {
                    size: 0n,
                    read: async () => new Uint8Array(),
                    close: async () => {
                        closed += 1;
                        throw new Error("close failed");
                    },
                };
            },
            async abort(): Promise<void> {
                throw new Error("abort failed");
            },
        };
        await expect(
            appendStagedAssetRecords(snapshot, iterateAssets(newUuid()), staging),
        ).rejects.toMatchObject({ code: "archive_write_verification_failed" });
        expect(closed).toBe(1);
    });
});

async function* iterateAssets(blobId: string): AsyncGenerator<ArchiveRecord> {
    yield record(RecordType.assetBlob, blobId, { record_role: "asset-blob-manifest" });
    yield record(RecordType.assetMetadata, newUuid(), { record_role: "material" });
}

describe("index repair structural failures", () => {
    it("rejects frames beyond the archive boundary", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("beyond boundary"));
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        const header = encodeRecordFrameHeader(
            { type: RecordType.student, id: newUuid(), revision: 1n, previousOffset: 0n },
            10_000,
            0,
            0,
            0,
        );
        const extended = new Uint8Array(bytes.length + header.length);
        extended.set(bytes);
        extended.set(header, bytes.length);
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(extended)),
        ).rejects.toMatchObject({ code: "archive_index_repair_unpublished" });
    });

    it("rejects inconsistent commit transaction counts", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("bad counts"));
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        const commitFrame = decodeRecordFrame(bytes.subarray(Number(snapshot.commit.offset)));
        const payload = commitFrame.storedPayload.slice();
        new DataView(payload.buffer).setBigUint64(80, 5n, true);
        reencodeAt(bytes, Number(snapshot.commit.offset), payload);
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(bytes)),
        ).rejects.toMatchObject({ code: "archive_index_repair_transaction" });
    });

    it("rejects pageless archives", async () => {
        const bytes = await createArchiveBytes("no commit");
        const firstFrame = decodeRecordFrame(bytes.subarray(64));
        const truncated = bytes.subarray(0, 64 + firstFrame.endOffset);
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(truncated)),
        ).rejects.toMatchObject({ code: "archive_index_repair_unpublished" });
    });
});

describe("header reads that return too little data", () => {
    it("reports incomplete checksum and magic reads", async () => {
        const short: ArchiveByteSource = {
            size: 64n,
            read: async () => new Uint8Array(0),
        };
        await expect(recoverChecksumDamagedArchiveHeader(short)).rejects.toMatchObject({
            code: "archive_header_recovery_unavailable",
        });
        await expect(recoverMagicDamagedArchiveHeader(short)).rejects.toMatchObject({
            code: "archive_header_recovery_unavailable",
        });
    });
});

describe("recovery fallbacks", () => {
    it("rethrows when no commit frame exists without a locator", async () => {
        const bytes = await createArchiveBytes("header only");
        const headerOnly = bytes.subarray(0, 64);
        await expect(
            openArchiveSourceForRecovery(new MemoryArchiveSource(headerOnly)),
        ).rejects.toMatchObject({ code: "archive_commit_missing" });
    });

    it("skips malformed locator records", async () => {
        const original = await createArchiveBytes("locator mutations");
        const mutations: ((locator: Uint8Array) => void)[] = [
            (locator) => {
                locator[0] = 0;
            },
            (locator) => {
                locator[24] = (locator[24] ?? 0) ^ 1;
            },
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
            mutation(bytes.subarray(bytes.length - 32));
            await expect(openArchiveBytes(bytes)).rejects.toMatchObject({
                code: "archive_commit_missing",
            });
        }
    });
});

describe("encrypted generation index mismatches", () => {
    it("rejects extra or altered authenticated index entries", async () => {
        const passphrase = "generation index passphrase";
        const unlocked = await (
            await openArchiveBytes(
                await createEncryptedArchiveBytes("index mismatch", "", passphrase),
            )
        ).unlock(passphrase);
        const entries = new Map(unlocked.allIndexEntries());
        const [key, offset] = [...entries.entries()][0]!;
        const extra = new Map(entries);
        extra.set("FUTURE:extension", offset);
        await expect(
            unlocked.openGeneration(
                unlocked.source,
                unlocked.commit,
                extra,
                unlocked.publishedEndOffset,
            ),
        ).rejects.toMatchObject({ code: "archive_index_authentication_failed" });

        const altered = new Map(entries);
        altered.set(key, offset + 8n);
        await expect(
            unlocked.openGeneration(
                unlocked.source,
                unlocked.commit,
                altered,
                unlocked.publishedEndOffset,
            ),
        ).rejects.toMatchObject({ code: "archive_index_authentication_failed" });
        unlocked.lock();
    });
});

describe("append and import manifest edge cases", () => {
    it("rejects appends when the manifest record is missing", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("append manifest"));
        const missingManifest = proxySnapshot(snapshot, {
            getRecord: (type: number, id: string) =>
                type === RecordType.settings && id === snapshot.header.id
                    ? Promise.resolve(null)
                    : snapshot.getRecord(type, id),
        });
        await expect(
            appendRecords(missingManifest, [record(RecordType.student, newUuid(), {})]),
        ).rejects.toMatchObject({ code: "archive_manifest_missing" });
    });

    it("rejects staged imports when the manifest index entry is missing", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("staged manifest"));
        const index = new Map(snapshot.allIndexEntries());
        index.delete(`SETTINGS:${snapshot.header.id}`);
        const missingIndex = proxySnapshot(snapshot, { allIndexEntries: () => index });
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
        await expect(
            appendStagedAssetRecords(missingIndex, iterateAssets(newUuid()), staging),
        ).rejects.toMatchObject({ code: "archive_manifest_missing" });
    });

    it("backfills guide source indexes when the manifest forgot its version", async () => {
        const studentId = newUuid();
        const guideId = newUuid();
        const first = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("guide version")),
            [
                record(RecordType.student, studentId, { display_name: "Mina" }),
                record(RecordType.guide, guideId, {
                    title: "Guide",
                    section_count: "1",
                    "section.0.heading": "One",
                    "section.0.block_count": "1",
                    "section.0.block.0.kind": "paragraph",
                    "section.0.block.0.text": "Mina",
                    "section.0.block.0.source_ids": studentId,
                }),
            ],
        );
        const manifest = await first.getRecord(RecordType.settings, first.header.id);
        const fields = new Map(manifest!.fields);
        fields.delete("guide_source_index_version");
        const staleManifest = proxySnapshot(first, {
            getRecord: (type: number, id: string) =>
                type === RecordType.settings && id === first.header.id
                    ? Promise.resolve({ ...manifest!, fields })
                    : first.getRecord(type, id),
        });
        const guide = await first.getRecord(RecordType.guide, guideId);
        const updated = await appendRecords(staleManifest, [
            { ...guide!, fields: new Map([...guide!.fields, ["title", "Renamed"]]) },
        ]);
        const stored = await updated.getRecord(RecordType.settings, updated.header.id);
        expect(stored?.fields.get("guide_source_index_version")).toBe("1");
        expect(updated.allIndexEntries().has(`GUIDESOURCE:${studentId}:${guideId}`)).toBe(true);
    });
});

describe("streaming source short reads", () => {
    it("reports truncated metadata pages and padding", async () => {
        const id = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("short reads")),
            [record(RecordType.student, id, { display_name: "A" })],
        );
        const offset = Number(snapshot.allIndexEntries().get(`STUDENT:${id}`));
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        const frame = decodeRecordFrame(bytes.subarray(offset));
        const payloadOffset = offset + RECORD_HEADER_SIZE;

        const shortPage: ArchiveByteSource = {
            size: BigInt(bytes.length),
            read: async (readOffset, length) => {
                if (Number(readOffset) >= payloadOffset) return new Uint8Array();
                return bytes.subarray(Number(readOffset), Number(readOffset) + length);
            },
        };
        const pageView = new ArchiveSnapshot(
            shortPage,
            snapshot.header,
            snapshot.commit,
            snapshot.allIndexEntries(),
            snapshot.publishedEndOffset,
        );
        await expect(pageView.listRecordMetadata(RecordType.student)).rejects.toMatchObject({
            code: "archive_truncated",
        });

        const payloadEnd = payloadOffset + frame.payloadLength;
        const shortPadding: ArchiveByteSource = {
            size: BigInt(payloadEnd),
            read: async (readOffset, length) => {
                const start = Number(readOffset);
                return bytes.subarray(start, Math.min(start + length, payloadEnd));
            },
        };
        const paddingView = new ArchiveSnapshot(
            shortPadding,
            snapshot.header,
            snapshot.commit,
            snapshot.allIndexEntries(),
            snapshot.publishedEndOffset,
        );
        await expect(paddingView.listRecordMetadata(RecordType.student)).rejects.toMatchObject({
            code: "archive_truncated",
        });
    });
});

describe("snapshot metadata error branches", () => {
    it("rejects missing encryption envelopes and manifest records", async () => {
        const passphrase = "metadata branches passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("metadata branches", "", passphrase),
        );
        const withoutEnvelope = new Map(locked.allIndexEntries());
        withoutEnvelope.delete(`ENCRYPTION:${locked.header.id}`);
        const envelopeView = new ArchiveSnapshot(
            locked.source,
            locked.header,
            locked.commit,
            withoutEnvelope,
            locked.publishedEndOffset,
        );
        await expect(envelopeView.unlock(passphrase)).rejects.toMatchObject({
            code: "archive_encryption_metadata_missing",
        });

        const withoutManifest = new Map(locked.allIndexEntries());
        withoutManifest.delete(`SETTINGS:${locked.header.id}`);
        const manifestView = new ArchiveSnapshot(
            locked.source,
            locked.header,
            locked.commit,
            withoutManifest,
            locked.publishedEndOffset,
        );
        await expect(manifestView.getManifest()).rejects.toMatchObject({
            code: "archive_manifest_missing",
        });
    });

    it("rejects authenticated metadata problems", async () => {
        const passphrase = "auth branches passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("auth branches", "", passphrase),
        );
        const envelopeRecord = await locked.getRecord(RecordType.encryption, locked.header.id);
        const envelope = encryptionEnvelopeFromRecord(envelopeRecord!, locked.header.id);
        const key = await ArchiveDataKey.unwrap(passphrase, envelope, locked.header.id);

        const rootMismatch = new ArchiveSnapshot(
            locked.source,
            locked.header,
            { ...locked.commit, rootOffset: locked.commit.offset },
            locked.allIndexEntries(),
            locked.publishedEndOffset,
            key.clone(),
        );
        await expect(rootMismatch.verifyEncryptionAuthentication()).rejects.toMatchObject({
            code: "archive_index_authentication_failed",
        });
        rootMismatch.lock();
        key.dispose();
        locked.lock();
    });

    it("rejects index entries that point at the wrong record", async () => {
        const studentId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("wrong record")),
            [record(RecordType.student, studentId, { display_name: "A" })],
        );
        const index = new Map(snapshot.allIndexEntries());
        index.set(`STUDENT:${studentId}`, index.get(`SETTINGS:${snapshot.header.id}`)!);
        const view = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            index,
            snapshot.publishedEndOffset,
        );
        await expect(view.getRecord(RecordType.student, studentId)).rejects.toMatchObject({
            code: "record_index_mismatch",
        });
        const noManifest = new ArchiveSnapshot(
            snapshot.source,
            snapshot.header,
            snapshot.commit,
            new Map(
                [...snapshot.allIndexEntries()].filter(([name]) => !name.startsWith("SETTINGS:")),
            ),
            snapshot.publishedEndOffset,
        );
        await expect(noManifest.getManifest()).rejects.toMatchObject({
            code: "archive_manifest_missing",
        });
    });
});

describe("guide and asset verification branches", () => {
    it("resolves entry-scoped sources and valid images", async () => {
        const entryId = newUuid();
        const sessionId = newUuid();
        const assetId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("guide branch")),
            [
                record(RecordType.settings, entryId, {
                    record_role: "journal-entry",
                    session_ids: sessionId,
                }),
                record(RecordType.session, sessionId, { entry_id: entryId }),
                record(RecordType.assetMetadata, assetId, {
                    record_role: "recording-take",
                    session_id: sessionId,
                }),
                record(RecordType.guide, newUuid(), {
                    title: "Entry guide",
                    entry_id: entryId,
                    section_count: "1",
                    "section.0.heading": "One",
                    "section.0.block_count": "1",
                    "section.0.block.0.kind": "paragraph",
                    "section.0.block.0.text": "Session",
                    "section.0.block.0.source_ids": sessionId,
                }),
                record(RecordType.guide, newUuid(), {
                    title: "Image guide",
                    session_id: sessionId,
                    section_count: "1",
                    "section.0.heading": "One",
                    "section.0.block_count": "1",
                    "section.0.block.0.kind": "image",
                    "section.0.block.0.text": `![diagram](asset:${assetId})`,
                }),
            ],
        );
        await expect(verifyArchiveFull(snapshot)).resolves.toMatchObject({ valid: true });
    });

    it("rejects invalid inline source identifiers and inconsistent manifests", async () => {
        const chunkId = newUuid();
        const manifestId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("inline branch")),
            [
                record(RecordType.guide, newUuid(), {
                    title: "Inline",
                    session_count: "0",
                    section_count: "1",
                    "section.0.heading": "One",
                    "section.0.block_count": "1",
                    "section.0.block.0.kind": "paragraph",
                    "section.0.block.0.text": "[[source:000000000000000000000000000000000000]]",
                }),
                record(
                    RecordType.assetBlob,
                    chunkId,
                    {
                        record_role: "asset-blob-chunk",
                        manifest_id: manifestId,
                        chunk_index: "0",
                    },
                    new Uint8Array([1]),
                ),
                record(RecordType.assetBlob, manifestId, {
                    record_role: "asset-blob-manifest",
                    chunk_count: "2",
                    chunk_ids: chunkId,
                }),
            ],
        );
        const report = await verifyArchiveFull(snapshot);
        const issues = report.issues.join("\n");
        expect(issues).toContain("invalid inline source reference");
        expect(issues).toContain("manifest chunk count is inconsistent");
    });

    it("validates metadata backed by a non-manifest blob", async () => {
        const blobId = newUuid();
        const content = new Uint8Array([9, 8, 7]);
        const digest = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(content).buffer)),
            (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("blob branch")),
            [
                record(RecordType.assetBlob, blobId, { record_role: "asset-blob" }, content),
                record(RecordType.assetMetadata, newUuid(), {
                    record_role: "material",
                    blob_id: blobId,
                    byte_size: String(content.length),
                    content_hash: digest,
                }),
            ],
        );
        await expect(verifyArchiveFull(snapshot)).resolves.toMatchObject({ valid: true });
    });

    it("reports audio records whose secondary index cannot be computed", async () => {
        const sessionId = newUuid();
        const trackId = newUuid();
        const chunkId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("audio invalid")),
            [
                record(RecordType.session, sessionId, {}),
                record(RecordType.audioChunk, chunkId, {
                    session_id: sessionId,
                    track_id: trackId,
                    sequence_number: "0",
                }),
            ],
        );
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        const offset = Number(snapshot.allIndexEntries().get(`AUDIO:${chunkId}`));
        const frame = decodeRecordFrame(bytes.subarray(offset));
        const payload = decodeRecordPayload(
            frame.type,
            frame.id,
            frame.revision,
            frame.previousOffset,
            decodeStoredPayload(frame),
        );
        const fields = new Map(payload.fields);
        fields.set("session_id", "z".repeat(36));
        const encoded = encodeRecordPayload({ ...payload, fields });
        if (encoded.byteLength === frame.payloadLength) {
            bytes.set(
                encodeRecordFrame(
                    {
                        type: frame.type,
                        id: frame.id,
                        revision: frame.revision,
                        previousOffset: frame.previousOffset,
                    },
                    encoded,
                    frame.codec,
                    frame.flags,
                ),
                offset,
            );
            const corrupted = await openArchiveBytes(bytes);
            const report = await verifyArchiveFull(corrupted);
            expect(report.valid).toBe(false);
        }
    });
});

describe("discard and repair preconditions", () => {
    it("rejects locked discard and accepts a clean tail", async () => {
        const passphrase = "discard passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("discard locked", "", passphrase),
        );
        const { discardUncommittedTail, repairArchiveSnapshot } =
            await import("../../../frontend/archive/archive");
        await expect(discardUncommittedTail(locked)).rejects.toMatchObject({
            code: "archive_locked",
        });
        const clean = await openArchiveBytes(await createArchiveBytes("discard clean"));
        await expect(discardUncommittedTail(clean)).resolves.toMatchObject({
            discardedBytes: 0n,
        });
        await expect(repairArchiveSnapshot(locked)).rejects.toMatchObject({
            code: "archive_locked",
        });
    });
});

describe("opaque compaction chains", () => {
    it("retains opaque chains that have no primary index entry", async () => {
        const extensionId = newUuid();
        const studentId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("opaque chain")),
            [
                record(99, extensionId, { extension: "future" }),
                record(RecordType.student, studentId, { display_name: "A" }),
                record(RecordType.session, newUuid(), { student_id: studentId }),
            ],
        );
        const extensionOffset = snapshot.allIndexEntries().get(`UNKNOWN:${extensionId}`)!;
        const index = primaryKeyOnly(snapshot);
        index.delete(`UNKNOWN:${extensionId}`);
        index.set(`FUTURE:${extensionId}`, extensionOffset);
        const migrated = await backfillArchiveSecondaryIndexes(
            proxySnapshot(snapshot, { allIndexEntries: () => index }),
        );
        const encrypted = await migrated.snapshot.enableEncryption("opaque chain passphrase");
        const compacted = await compactArchiveSnapshot(encrypted);
        expect(compacted.snapshot.allIndexEntries().has(`FUTURE:${extensionId}`)).toBe(true);
        const opaque = await compacted.snapshot.getRecordByIndexKey(`FUTURE:${extensionId}`);
        expect(opaque?.fields.get("extension")).toBe("future");
        compacted.snapshot.lock();
        encrypted.lock();
    });
});

describe("encrypted manifest authentication corruption", () => {
    async function encryptedWithManifestAuth(
        mutate: (fields: Map<string, string>) => void,
    ): Promise<Snapshot> {
        const passphrase = "manifest auth passphrase";
        const bytes = await createEncryptedArchiveBytes("manifest auth", "", passphrase);
        const snapshot = await openArchiveBytes(bytes);
        const offset = Number(snapshot.allIndexEntries().get(`SETTINGS:${snapshot.header.id}`));
        const source = await snapshot.source.read(0n, Number(snapshot.source.size));
        const frame = decodeRecordFrame(source.subarray(offset));
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
        if (payload.byteLength !== frame.payloadLength) throw new Error("length changed");
        source.set(
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
        return openArchiveBytes(source);
    }

    it("rejects malformed and mismatched manifest authentication", async () => {
        const malformed = await encryptedWithManifestAuth((fields) => {
            fields.set("manifest_auth", "g".repeat(64));
        });
        await expect(malformed.unlock("manifest auth passphrase")).rejects.toMatchObject({
            code: "archive_manifest_authentication_failed",
        });

        const mismatched = await encryptedWithManifestAuth((fields) => {
            fields.set("manifest_auth", "0".repeat(64));
        });
        await expect(mismatched.unlock("manifest auth passphrase")).rejects.toMatchObject({
            code: "archive_manifest_authentication_failed",
        });
    });
});
