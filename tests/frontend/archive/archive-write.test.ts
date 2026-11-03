import { describe, expect, it } from "vitest";
import {
    appendRecords,
    appendStagedAssetRecords,
    backfillArchiveSecondaryIndexes,
    compactArchiveSnapshot,
    createArchiveBytes,
    createEncryptedArchiveBytes,
    openArchiveBytes,
    openArchiveSource,
    verifyArchiveSnapshot,
    type ArchiveSnapshot,
} from "../../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    CompositeArchiveSource,
    MemoryArchiveSource,
    type ArchiveByteSource,
} from "../../../frontend/archive/source";
import type { ArchiveStaging } from "../../../frontend/archive/staging";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    );
}

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

class RecordingStaging implements ArchiveStaging {
    readonly chunks: Uint8Array[] = [];
    aborted = false;
    sealed = false;
    failAfter: number | undefined;

    async append(bytes: Uint8Array): Promise<void> {
        if (this.failAfter !== undefined && this.chunks.length >= this.failAfter) {
            throw new Error("staging failed");
        }
        this.chunks.push(bytes.slice());
    }

    async seal(): Promise<ArchiveByteSource> {
        this.sealed = true;
        const total = this.chunks.reduce((length, chunk) => length + chunk.length, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of this.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return new MemoryArchiveSource(bytes);
    }

    async abort(): Promise<void> {
        this.aborted = true;
    }
}

async function* iterate(records: readonly ArchiveRecord[]): AsyncGenerator<ArchiveRecord> {
    for (const item of records) yield item;
}

function assetRecords(blobId: string, bytes = new Uint8Array([1, 2, 3])): ArchiveRecord[] {
    return [
        record(RecordType.assetBlob, blobId, { record_role: "asset-blob-manifest" }, bytes),
        record(RecordType.assetMetadata, newUuid(), {
            record_role: "material",
            blob_id: blobId,
        }),
    ];
}

describe("staged asset imports", () => {
    it("imports asset records through staging", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("staged import"));
        const blobId = newUuid();
        const staging = new RecordingStaging();
        const imported = await appendStagedAssetRecords(
            snapshot,
            iterate(assetRecords(blobId)),
            staging,
        );
        expect(staging.sealed).toBe(true);
        expect(staging.aborted).toBe(false);
        expect(imported.commit.generation).toBe(2n);
        expect(await imported.getRecord(RecordType.assetBlob, blobId)).toMatchObject({
            fields: new Map([["record_role", "asset-blob-manifest"]]),
        });
        await expect(verifyArchiveSnapshot(imported)).resolves.toMatchObject({
            generation: "2",
        });
    });

    it("imports into an encrypted archive", async () => {
        const passphrase = "staged import passphrase";
        const unlocked = await (
            await openArchiveBytes(
                await createEncryptedArchiveBytes("encrypted import", "", passphrase),
            )
        ).unlock(passphrase);
        const blobId = newUuid();
        const staging = new RecordingStaging();
        const imported = await appendStagedAssetRecords(
            unlocked,
            iterate(assetRecords(blobId)),
            staging,
        );
        expect(imported.encrypted).toBe(true);
        expect(imported.locked).toBe(false);
        await expect(verifyArchiveSnapshot(imported)).resolves.toMatchObject({ currentRecords: 4 });
        imported.lock();
        unlocked.lock();
    });

    it("backfills legacy secondary indexes during the first import", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("legacy import"));
        const manifest = await snapshot.getRecord(RecordType.settings, snapshot.header.id);
        expect(manifest?.fields.has("annotation_session_time_index_version")).toBe(false);
        const staging = new RecordingStaging();
        const imported = await appendStagedAssetRecords(
            snapshot,
            iterate(assetRecords(newUuid())),
            staging,
        );
        const updated = await imported.getRecord(RecordType.settings, imported.header.id);
        expect(updated?.fields.get("annotation_session_time_index_version")).toBe("1");
        expect(updated?.fields.get("audio_chunk_index_version")).toBe("1");
    });

    it("rejects invalid, duplicate, and incomplete imports", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("invalid import"));
        const staging = new RecordingStaging();
        await expect(
            appendStagedAssetRecords(
                snapshot,
                iterate([record(RecordType.student, newUuid(), {})]),
                staging,
            ),
        ).rejects.toMatchObject({ code: "asset_import_record_invalid" });

        const blobId = newUuid();
        const first = assetRecords(blobId);
        const imported = await appendStagedAssetRecords(snapshot, iterate(first), staging);
        await expect(
            appendStagedAssetRecords(imported, iterate(first), staging),
        ).rejects.toMatchObject({ code: "record_duplicate" });

        const duplicateKey = [
            record(RecordType.assetBlob, blobId, { record_role: "asset-blob-manifest" }),
            record(RecordType.assetBlob, blobId, { record_role: "asset-blob-manifest" }),
            record(RecordType.assetMetadata, newUuid(), { record_role: "material" }),
        ];
        await expect(
            appendStagedAssetRecords(snapshot, iterate(duplicateKey), staging),
        ).rejects.toMatchObject({ code: "record_duplicate" });

        await expect(
            appendStagedAssetRecords(
                snapshot,
                iterate([record(RecordType.assetBlob, newUuid(), {})]),
                staging,
            ),
        ).rejects.toMatchObject({ code: "asset_import_record_invalid" });
    });

    it("rejects alias conflicts and aborts staging on failure", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("alias import"));
        const contentHash = "a".repeat(64);
        const records = [
            record(RecordType.assetBlob, newUuid(), { content_hash: contentHash }),
            record(RecordType.assetBlob, newUuid(), { content_hash: contentHash }),
            record(RecordType.assetMetadata, newUuid(), { record_role: "material" }),
        ];
        const staging = new RecordingStaging();
        await expect(
            appendStagedAssetRecords(snapshot, iterate(records), staging),
        ).rejects.toMatchObject({ code: "asset_blob_index_invalid" });
        expect(staging.aborted).toBe(true);

        const failing = new RecordingStaging();
        failing.failAfter = 1;
        await expect(
            appendStagedAssetRecords(snapshot, iterate(assetRecords(newUuid())), failing),
        ).rejects.toThrowError("staging failed");
        expect(failing.aborted).toBe(true);
    });

    it("rejects locked, dirty, and manifest-less imports", async () => {
        const passphrase = "locked import passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("locked import", "", passphrase),
        );
        await expect(
            appendStagedAssetRecords(locked, iterate([]), new RecordingStaging()),
        ).rejects.toMatchObject({ code: "archive_locked" });

        const snapshot = await openArchiveBytes(await createArchiveBytes("dirty import"));
        const dirty = await openArchiveSource(
            new CompositeArchiveSource(
                snapshot.source,
                new MemoryArchiveSource(new Uint8Array([1, 2, 3])),
            ),
        );
        await expect(
            appendStagedAssetRecords(dirty, iterate([]), new RecordingStaging()),
        ).rejects.toMatchObject({ code: "archive_recovery_required" });

        const missing = await openArchiveBytes(await createArchiveBytes("missing manifest"));
        const index = new Map(missing.allIndexEntries());
        index.delete(`SETTINGS:${missing.header.id}`);
        const withoutManifest = new Proxy(missing, {
            get(target, property) {
                if (property === "allIndexEntries") return () => index;
                if (property === "getRecord") {
                    return (type: number, id: string) =>
                        type === RecordType.settings && id === target.header.id
                            ? Promise.resolve(null)
                            : target.getRecord(type, id);
                }
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as ArchiveSnapshot;
        await expect(
            appendStagedAssetRecords(withoutManifest, iterate([]), new RecordingStaging()),
        ).rejects.toMatchObject({ code: "archive_manifest_missing" });
    });
});

describe("secondary index backfill", () => {
    it("adds schema versions to a fresh archive", async () => {
        const snapshot = await openArchiveBytes(await createArchiveBytes("backfill"));
        const result = await backfillArchiveSecondaryIndexes(snapshot);
        expect(result.schemaVersionsUpdated).toBe(true);
        expect(result.addedEntries).toBe(0);
        expect(result.conflictingEntries).toBe(0);
        expect(result.snapshot.commit.generation).toBe(2n);
        const manifest = await result.snapshot.getRecord(
            RecordType.settings,
            result.snapshot.header.id,
        );
        expect(manifest?.fields.get("guide_source_index_version")).toBeUndefined();
        expect(manifest?.fields.get("student_session_index_version")).toBe("1");
    });

    it("does nothing when every index is current", async () => {
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("current")),
            [record(RecordType.student, newUuid(), { display_name: "A" })],
        );
        const result = await backfillArchiveSecondaryIndexes(snapshot);
        expect(result.schemaVersionsUpdated).toBe(false);
        expect(result.snapshot).toBe(snapshot);
    });

    it("rejects locked, dirty, and invalid sources", async () => {
        const passphrase = "backfill passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("locked backfill", "", passphrase),
        );
        await expect(backfillArchiveSecondaryIndexes(locked)).rejects.toMatchObject({
            code: "archive_locked",
        });
        const snapshot = await openArchiveBytes(await createArchiveBytes("dirty backfill"));
        const dirty = await openArchiveSource(
            new CompositeArchiveSource(
                snapshot.source,
                new MemoryArchiveSource(new Uint8Array([1, 2, 3])),
            ),
        );
        await expect(backfillArchiveSecondaryIndexes(dirty)).rejects.toMatchObject({
            code: "archive_recovery_required",
        });
    });
});

describe("asset pruning during compaction", () => {
    it("keeps referenced material and prunes unreferenced blobs", async () => {
        const chunkData = new Uint8Array([1, 2, 3, 4]);
        const contentHash = await sha256Hex(chunkData);
        const manifestId = newUuid();
        const chunkId = newUuid();
        const metadataId = newUuid();
        const unreferenced = newUuid();
        const audioTrack = newUuid();
        const sessionId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("pruning")),
            [
                record(RecordType.session, sessionId, {}),
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
                record(RecordType.assetMetadata, metadataId, {
                    record_role: "material",
                    blob_id: manifestId,
                    byte_size: String(chunkData.length),
                    content_hash: contentHash,
                }),
                record(RecordType.assetBlob, unreferenced, { record_role: "asset-blob" }),
                record(RecordType.assetMetadata, audioTrack, {
                    record_role: "audio-track",
                    track_id: newUuid(),
                    session_id: sessionId,
                }),
            ],
        );
        const result = await compactArchiveSnapshot(snapshot, { pruneUnreferencedAssets: true });
        expect(result.prunedAssetRecords).toBe(1);
        expect(await result.snapshot.getRecord(RecordType.assetBlob, unreferenced)).toBeNull();
        expect(await result.snapshot.getRecord(RecordType.assetBlob, manifestId)).not.toBeNull();
        expect(await result.snapshot.getRecord(RecordType.assetBlob, chunkId)).not.toBeNull();
        expect(
            await result.snapshot.getRecord(RecordType.assetMetadata, audioTrack),
        ).not.toBeNull();
    });

    it("refuses to prune when the archive contains unknown records", async () => {
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("unknown pruning")),
            [record(99, newUuid(), { extension: "future" })],
        );
        await expect(
            compactArchiveSnapshot(snapshot, { pruneUnreferencedAssets: true }),
        ).rejects.toMatchObject({ code: "archive_pruning_unknown_records" });
    });
});
