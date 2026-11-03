import { describe, expect, it, vi } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
} from "../../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    cleanFilename,
    detectMimeType,
    filterAssetsBySession,
    iterateVerifiedAssetChunks,
    makeAssetImport,
    MAX_ASSET_BYTES,
    readAssetBytes,
    streamAssetBytes,
} from "../../../frontend/domain/assets";

async function emptySnapshot() {
    const base = await openArchiveBytes(await createArchiveBytes("assets fixture"));
    return base;
}

function fileOf(name: string, bytes: Uint8Array) {
    return {
        name,
        size: bytes.byteLength,
        readBytes: async () => bytes,
    };
}

function ascii(value: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array([...value].map((character) => character.charCodeAt(0)));
}

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
    return new Uint8Array(values);
}

async function drain<T>(iterator: AsyncGenerator<T>): Promise<void> {
    for (;;) {
        const next = await iterator.next();
        if (next.done) return;
    }
}

function snapshotOf(
    records: readonly ArchiveRecord[],
    index: Record<string, ArchiveRecord> = {},
): never {
    return {
        getRecord: async (type: number, id: string) =>
            records.find((item) => item.type === type && item.id === id) ?? null,
        getRecordByIndexKey: async (key: string) => index[key] ?? null,
    } as never;
}

function blobRecord(
    id: string,
    fields: Record<string, string>,
    blob = new Uint8Array(),
): ArchiveRecord {
    return {
        type: RecordType.assetBlob,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob,
    };
}

function metadataRecord(fields: Record<string, string>): ArchiveRecord {
    return {
        type: RecordType.assetMetadata,
        id: newUuid(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

async function digest(bytesValue: Uint8Array<ArrayBuffer>): Promise<string> {
    const value = new Uint8Array(await crypto.subtle.digest("SHA-256", bytesValue));
    return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("asset filtering", () => {
    it("filters metadata by session and returns everything for null", () => {
        const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const records = [
            metadataRecord({ session_id: ` ${session} ` }),
            metadataRecord({ session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
            metadataRecord({}),
            blobRecord(newUuid(), { record_role: "asset-blob-manifest" }),
        ];
        expect(filterAssetsBySession(records, null)).toHaveLength(4);
        expect(filterAssetsBySession(records, session)).toHaveLength(1);
        expect(filterAssetsBySession(records, "missing")).toHaveLength(0);
    });
});

describe("asset import", () => {
    it("imports, deduplicates, and reads material bytes", async () => {
        const snapshot = await emptySnapshot();
        const content = ascii("hello materials");
        const imported = await makeAssetImport(snapshot, fileOf("notes.txt", content));
        expect(imported.deduplicated).toBe(false);
        expect(imported.chunkCount).toBe(1);
        expect(imported.metadata.fields.get("mime_type")).toBe("text/plain");

        const saved = await appendRecords(snapshot, imported.records);
        const again = await makeAssetImport(saved, fileOf("copy.txt", content));
        expect(again.deduplicated).toBe(true);
        expect(again.chunkCount).toBe(1);

        expect([...(await readAssetBytes(saved, imported.metadata))]).toEqual([...content]);
        const stream = streamAssetBytes(saved, imported.metadata);
        const chunks: number[] = [];
        const reader = stream.getReader();
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            chunks.push(...next.value);
        }
        expect(chunks).toEqual([...content]);
    });

    it("imports files through arrayBuffer and explicit sessions", async () => {
        const snapshot = await emptySnapshot();
        const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const content = ascii("session material");
        const imported = await makeAssetImport(
            snapshot,
            {
                name: "notes.md",
                size: content.byteLength,
                arrayBuffer: async () => content.buffer as ArrayBuffer,
            },
            sessionId,
        );
        expect(imported.metadata.fields.get("session_id")).toBe(sessionId);
    });

    it("splits large files into multiple verified chunks", async () => {
        const snapshot = await emptySnapshot();
        const content = new Uint8Array(8 * 1024 * 1024 + 16);
        content.fill(7);
        const imported = await makeAssetImport(snapshot, fileOf("large.bin", content));
        expect(imported.chunkCount).toBe(2);
        const saved = await appendRecords(snapshot, imported.records);
        expect((await readAssetBytes(saved, imported.metadata)).byteLength).toBe(
            content.byteLength,
        );
    });

    it("validates file size, names, and session ids", async () => {
        const snapshot = await emptySnapshot();
        await expect(
            makeAssetImport(snapshot, {
                name: "x",
                size: -1,
                readBytes: async () => new Uint8Array(),
            }),
        ).rejects.toThrow("256 MiB");
        await expect(
            makeAssetImport(snapshot, {
                name: "x",
                size: 1.5,
                readBytes: async () => new Uint8Array(1),
            }),
        ).rejects.toThrow("256 MiB");
        await expect(makeAssetImport(snapshot, fileOf("  ", new Uint8Array()))).rejects.toThrow(
            "file name is empty",
        );
        await expect(
            makeAssetImport(snapshot, fileOf("bad\u0001name", new Uint8Array())),
        ).rejects.toThrow("control characters");
        await expect(
            makeAssetImport(snapshot, fileOf("ok.txt", new Uint8Array()), "bad-session"),
        ).rejects.toThrow("valid UUID");
        await expect(
            makeAssetImport(snapshot, {
                name: "ok.txt",
                size: 5,
                readBytes: async () => new Uint8Array(4),
            }),
        ).rejects.toThrow("changed during import");
    });

    it("hashes non-zero-offset views", async () => {
        const snapshot = await emptySnapshot();
        const backing = new Uint8Array(20);
        backing.set(ascii("material"), 5);
        const view = backing.subarray(5, 13);
        const imported = await makeAssetImport(snapshot, fileOf("view.txt", view));
        expect(imported.metadata.fields.get("byte_size")).toBe("8");
    });

    it("rejects an invalid blob index entry", async () => {
        const content = ascii("dedup");
        const hash = await digest(content);
        const metadata = metadataRecord({
            filename: "x",
            byte_size: String(content.byteLength),
            blob_count: "1",
        });
        const bad = blobRecord(
            newUuid(),
            { content_hash: "c".repeat(64), record_role: "asset-blob-chunk" },
            content,
        );
        const snapshot = snapshotOf([metadata], { [`BLOB:${hash}`]: bad });
        await expect(makeAssetImport(snapshot, fileOf("x.txt", content))).rejects.toMatchObject({
            code: "asset_blob_index_invalid",
        });
    });

    it("rejects a deduplicated blob whose content does not match its hash", async () => {
        const content = ascii("dedup");
        const hash = await digest(content);
        const existing = blobRecord(
            newUuid(),
            {
                content_hash: hash,
                record_role: "asset-blob-manifest",
                chunk_count: "0",
                byte_size: "0",
            },
            content,
        );
        const snapshot = snapshotOf([], { [`BLOB:${hash}`]: existing });
        await expect(makeAssetImport(snapshot, fileOf("x.txt", content))).rejects.toMatchObject({
            code: "asset_blob_index_invalid",
        });
    });

    it("rejects a legacy blob whose content was tampered with", async () => {
        const content = ascii("dedup");
        const hash = await digest(content);
        const existing = blobRecord(
            newUuid(),
            { content_hash: hash, record_role: "asset-blob" },
            ascii("other"),
        );
        const snapshot = snapshotOf([], { [`BLOB:${hash}`]: existing });
        await expect(makeAssetImport(snapshot, fileOf("x.txt", content))).rejects.toMatchObject({
            code: "asset_blob_index_invalid",
        });
    });

    it("rejects a deduplicated manifest with an invalid chunk count", async () => {
        const content = ascii("dedup");
        const hash = await digest(content);
        const existing = blobRecord(
            newUuid(),
            { content_hash: hash, record_role: "asset-blob-manifest", chunk_count: "bad" },
            content,
        );
        const snapshot = snapshotOf([], { [`BLOB:${hash}`]: existing });
        await expect(makeAssetImport(snapshot, fileOf("x.txt", content))).rejects.toMatchObject({
            code: "asset_metadata_invalid",
        });
    });

    it("includes extraction results when available", async () => {
        vi.resetModules();
        vi.doMock("../../../frontend/domain/document-text", () => ({
            extractDocumentText: async () => ({ status: "extracted", text: "parsed" }),
        }));
        const mod = await import("../../../frontend/domain/assets");
        try {
            const imported = await mod.makeAssetImport(
                await emptySnapshot(),
                fileOf("notes.txt", ascii("readable text")),
            );
            expect(imported.metadata.fields.get("text_extraction_status")).toBe("extracted");
            expect(imported.metadata.fields.get("extracted_text")).toBe("parsed");
        } finally {
            vi.doUnmock("../../../frontend/domain/document-text");
            vi.resetModules();
        }
    });

    it("rejects manifest chunk manifests that do not add up", async () => {
        const content = ascii("manifest");
        const hash = await digest(content);
        const manifestId = newUuid();
        const chunkId = newUuid();
        const countMismatch = blobRecord(manifestId, {
            record_role: "asset-blob-manifest",
            content_hash: hash,
            byte_size: String(content.byteLength),
            chunk_count: "2",
            chunk_ids: chunkId,
        });
        await expect(
            makeAssetImport(
                snapshotOf([], { [`BLOB:${hash}`]: countMismatch }),
                fileOf("x.bin", content),
            ),
        ).rejects.toMatchObject({ code: "asset_manifest_invalid" });

        const invalidId = blobRecord(manifestId, {
            record_role: "asset-blob-manifest",
            content_hash: hash,
            byte_size: String(content.byteLength),
            chunk_count: "1",
            chunk_ids: "not-a-uuid",
        });
        await expect(
            makeAssetImport(
                snapshotOf([], { [`BLOB:${hash}`]: invalidId }),
                fileOf("x.bin", content),
            ),
        ).rejects.toMatchObject({ code: "asset_chunk_id_invalid" });

        const missingChunk = blobRecord(manifestId, {
            record_role: "asset-blob-manifest",
            content_hash: hash,
            byte_size: String(content.byteLength),
            chunk_count: "1",
            chunk_ids: chunkId,
        });
        await expect(
            makeAssetImport(
                snapshotOf([], { [`BLOB:${hash}`]: missingChunk }),
                fileOf("x.bin", content),
            ),
        ).rejects.toMatchObject({ code: "asset_chunk_missing" });

        const shortChunk = blobRecord(
            chunkId,
            {
                record_role: "asset-blob-chunk",
                manifest_id: manifestId,
                chunk_index: "0",
                byte_size: "3",
            },
            ascii("abc"),
        );
        await expect(
            makeAssetImport(
                snapshotOf([shortChunk], { [`BLOB:${hash}`]: missingChunk }),
                fileOf("x.bin", content),
            ),
        ).rejects.toMatchObject({ code: "asset_chunk_size_invalid" });
    });

    it("rejects metadata byte sizes outside the supported range", async () => {
        const content = ascii("x");
        const hash = await digest(content);
        const blobId = newUuid();
        const blob = blobRecord(blobId, { record_role: "asset-blob" }, content);
        const metadata = metadataRecord({
            byte_size: String(MAX_ASSET_BYTES + 1),
            content_hash: hash,
            blob_id: blobId,
        });
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([blob]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_metadata_invalid" });
    });

    it("deduplicates legacy single-blob assets", async () => {
        const content = ascii("legacy dedup");
        const hash = await digest(content);
        const existing = blobRecord(
            newUuid(),
            { record_role: "asset-blob", content_hash: hash },
            content,
        );
        const snapshot = snapshotOf([], { [`BLOB:${hash}`]: existing });
        const imported = await makeAssetImport(snapshot, fileOf("x.bin", content));
        expect(imported.deduplicated).toBe(true);
        expect(imported.chunkCount).toBe(1);
    });
});

describe("verified asset iteration", () => {
    async function manifestFixture(content: Uint8Array<ArrayBuffer>) {
        const hash = await digest(content);
        const manifestId = newUuid();
        const chunkId = newUuid();
        const chunk = blobRecord(
            chunkId,
            {
                record_role: "asset-blob-chunk",
                manifest_id: manifestId,
                chunk_index: "0",
                byte_size: String(content.byteLength),
            },
            content,
        );
        const manifest = blobRecord(manifestId, {
            record_role: "asset-blob-manifest",
            content_hash: hash,
            byte_size: String(content.byteLength),
            chunk_count: "1",
            chunk_ids: chunkId,
        });
        const metadata = metadataRecord({
            byte_size: String(content.byteLength),
            content_hash: hash,
            blob_id: manifestId,
            blob_count: "1",
        });
        return { metadata, manifest, chunk, hash };
    }

    it("iterates an empty manifest", async () => {
        const emptyHash = await digest(new Uint8Array());
        const manifestId = newUuid();
        const manifest = blobRecord(manifestId, {
            record_role: "asset-blob-manifest",
            content_hash: emptyHash,
            byte_size: "0",
            chunk_count: "0",
        });
        const metadata = metadataRecord({
            byte_size: "0",
            content_hash: emptyHash,
            blob_id: manifestId,
        });
        await drain(iterateVerifiedAssetChunks(snapshotOf([manifest]), metadata));
    });

    it("cancels a material stream cleanly", async () => {
        const { metadata, manifest, chunk } = await manifestFixture(ascii("payload"));
        const reader = streamAssetBytes(snapshotOf([manifest, chunk]), metadata).getReader();
        await reader.read();
        await reader.cancel();
    });

    it("iterates manifest chunks and validates the digest", async () => {
        const { metadata, manifest, chunk } = await manifestFixture(ascii("payload"));
        const snapshot = snapshotOf([manifest, chunk]);
        const output: number[] = [];
        for await (const part of iterateVerifiedAssetChunks(snapshot, metadata))
            output.push(...part);
        expect(output).toEqual([...ascii("payload")]);
    });

    it("reads legacy single-blob assets", async () => {
        const content = ascii("legacy");
        const hash = await digest(content);
        const blobId = newUuid();
        const blob = blobRecord(blobId, { record_role: "asset-blob" }, content);
        const metadata = metadataRecord({
            byte_size: String(content.byteLength),
            content_hash: hash,
            blob_id: blobId,
        });
        expect([...(await readAssetBytes(snapshotOf([blob]), metadata))]).toEqual([...content]);
    });

    it("rejects metadata and blob integrity problems", async () => {
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([]), {
                ...metadataRecord({}),
                type: RecordType.guide,
            }).next(),
        ).rejects.toThrow("Select a material");

        const valid = metadataRecord({
            byte_size: "1",
            content_hash: "a".repeat(64),
            blob_id: newUuid(),
        });
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([]), valid).next(),
        ).rejects.toMatchObject({ code: "asset_blob_missing" });

        const badHash = metadataRecord({
            byte_size: "1",
            content_hash: "bad",
            blob_id: newUuid(),
        });
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([]), badHash).next(),
        ).rejects.toMatchObject({ code: "asset_metadata_invalid" });

        const blobId = newUuid();
        const deleted = blobRecord(blobId, { _deleted: "true", record_role: "asset-blob" });
        const deletedMeta = metadataRecord({
            byte_size: "1",
            content_hash: "a".repeat(64),
            blob_id: blobId,
        });
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([deleted]), deletedMeta).next(),
        ).rejects.toMatchObject({ code: "asset_blob_missing" });
    });

    it("rejects manifest hash, size, and count mismatches", async () => {
        const { metadata, manifest, chunk } = await manifestFixture(ascii("payload"));
        const wrongHash = blobRecord(manifest.id, {
            record_role: "asset-blob-manifest",
            content_hash: "b".repeat(64),
            byte_size: String(manifest.fields.get("byte_size")),
            chunk_count: "1",
            chunk_ids: chunk.id,
        });
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([wrongHash, chunk]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_manifest_hash_mismatch" });

        const wrongSize = { ...manifest, fields: new Map(manifest.fields) };
        wrongSize.fields.set("byte_size", "99");
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([wrongSize, chunk]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_manifest_invalid" });

        const wrongCount = { ...manifest, fields: new Map(manifest.fields) };
        wrongCount.fields.set("chunk_count", "2");
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([wrongCount, chunk]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_manifest_invalid" });

        const mismatchedMetadata = { ...metadata, fields: new Map(metadata.fields) };
        mismatchedMetadata.fields.set("blob_count", "2");
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([manifest, chunk]), mismatchedMetadata).next(),
        ).rejects.toMatchObject({ code: "asset_manifest_invalid" });
    });

    it("rejects invalid and missing chunks", async () => {
        const { metadata, manifest, chunk } = await manifestFixture(ascii("payload"));
        const badId = { ...manifest, fields: new Map(manifest.fields) };
        badId.fields.set("chunk_ids", "not-a-uuid");
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([badId]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_chunk_id_invalid" });

        await expect(
            iterateVerifiedAssetChunks(snapshotOf([manifest]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_chunk_missing" });

        const deletedChunk = { ...chunk, fields: new Map([...chunk.fields, ["_deleted", "true"]]) };
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([manifest, deletedChunk]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_chunk_missing" });

        const wrongRole = { ...chunk, fields: new Map([...chunk.fields, ["record_role", "x"]]) };
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([manifest, wrongRole]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_chunk_missing" });

        const wrongManifest = {
            ...chunk,
            fields: new Map([...chunk.fields, ["manifest_id", newUuid()]]),
        };
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([manifest, wrongManifest]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_chunk_missing" });

        const wrongIndex = { ...chunk, fields: new Map([...chunk.fields, ["chunk_index", "1"]]) };
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([manifest, wrongIndex]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_chunk_missing" });

        const wrongByteSize = {
            ...chunk,
            fields: new Map([...chunk.fields, ["byte_size", "1"]]),
        };
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([manifest, wrongByteSize]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_chunk_missing" });
    });

    it("rejects chunk layout and integrity failures", async () => {
        const content = ascii("payload");
        const hash = await digest(content);
        const manifestId = newUuid();
        const chunkId = newUuid();
        const shortChunk = blobRecord(
            chunkId,
            {
                record_role: "asset-blob-chunk",
                manifest_id: manifestId,
                chunk_index: "0",
                byte_size: "3",
            },
            ascii("abc"),
        );
        const manifest = blobRecord(manifestId, {
            record_role: "asset-blob-manifest",
            content_hash: hash,
            byte_size: String(content.byteLength),
            chunk_count: "1",
            chunk_ids: chunkId,
        });
        const metadata = metadataRecord({
            byte_size: String(content.byteLength),
            content_hash: hash,
            blob_id: manifestId,
        });
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([manifest, shortChunk]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_chunk_size_invalid" });

        const tampered = blobRecord(
            chunkId,
            {
                record_role: "asset-blob-chunk",
                manifest_id: manifestId,
                chunk_index: "0",
                byte_size: String(content.byteLength),
            },
            ascii("tamper!"),
        );
        await expect(
            drain(iterateVerifiedAssetChunks(snapshotOf([manifest, tampered]), metadata)),
        ).rejects.toMatchObject({ code: "asset_content_integrity_failed" });
    });

    it("cleans up the digest when the consumer stops early", async () => {
        const { metadata, manifest, chunk } = await manifestFixture(ascii("payload"));
        const iterator = iterateVerifiedAssetChunks(snapshotOf([manifest, chunk]), metadata);
        await iterator.next();
        await iterator.return(undefined);
    });

    it("rejects legacy blobs that exceed the declared size", async () => {
        const content = ascii("too long");
        const hash = await digest(content);
        const blobId = newUuid();
        const blob = blobRecord(blobId, { record_role: "asset-blob" }, content);
        const metadata = metadataRecord({
            byte_size: "2",
            content_hash: hash,
            blob_id: blobId,
        });
        await expect(
            iterateVerifiedAssetChunks(snapshotOf([blob]), metadata).next(),
        ).rejects.toMatchObject({ code: "asset_manifest_invalid" });
    });
});

describe("asset type detection", () => {
    it("detects every supported signature", () => {
        expect(detectMimeType("x", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
            "image/png",
        );
        expect(detectMimeType("x", bytes(0xff, 0xd8, 0xff))).toBe("image/jpeg");
        expect(detectMimeType("x", ascii("GIF87a"))).toBe("image/gif");
        expect(detectMimeType("x", ascii("GIF89a"))).toBe("image/gif");
        expect(detectMimeType("x", ascii("BM"))).toBe("image/bmp");
        expect(detectMimeType("x", bytes(0x49, 0x49, 0x2a, 0x00))).toBe("image/tiff");
        expect(detectMimeType("x", bytes(0x4d, 0x4d, 0x00, 0x2a))).toBe("image/tiff");
        expect(detectMimeType("x", ascii("%PDF-"))).toBe("application/pdf");
        expect(detectMimeType("x", bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe(
            "application/x-ole-storage",
        );
        expect(detectMimeType("x", ascii("RIFFxxxxWEBP"))).toBe("image/webp");
        expect(detectMimeType("x", ascii("RIFFxxxxWAVE"))).toBe("audio/wav");
        expect(detectMimeType("x", ascii("fLaC"))).toBe("audio/flac");
        expect(detectMimeType("x", ascii("OggS"))).toBe("audio/ogg");
        expect(detectMimeType("x", ascii("ID3"))).toBe("audio/mpeg");
        expect(detectMimeType("x", bytes(0xff, 0xe0))).toBe("audio/mpeg");
        expect(detectMimeType("clip.webm", bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("video/webm");
        expect(detectMimeType("clip.mkv", bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("video/x-matroska");
        expect(detectMimeType("a.docx", ascii("PK\u0003\u0004"))).toBe(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
        expect(detectMimeType("a.xlsx", ascii("PK\u0003\u0004"))).toBe(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        expect(detectMimeType("a.pptx", ascii("PK\u0003\u0004"))).toBe(
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        );
        expect(detectMimeType("a.zip", ascii("PK\u0003\u0004"))).toBe("application/zip");
        expect(detectMimeType("a.m4a", ascii("xxxxftyp"))).toBe("audio/mp4");
        expect(detectMimeType("a.mp4", ascii("xxxxftyp"))).toBe("video/mp4");
    });

    it("detects text formats and binary fallbacks", () => {
        const text = ascii("hello");
        expect(detectMimeType("a.txt", text)).toBe("text/plain");
        expect(detectMimeType("a.md", text)).toBe("text/markdown");
        expect(detectMimeType("a.markdown", text)).toBe("text/markdown");
        expect(detectMimeType("a.csv", text)).toBe("text/csv");
        expect(detectMimeType("a.json", text)).toBe("application/json");
        expect(detectMimeType("a.html", text)).toBe("text/html");
        expect(detectMimeType("a.htm", text)).toBe("text/html");
        expect(detectMimeType("a.xml", text)).toBe("application/xml");
        expect(detectMimeType("a.css", text)).toBe("text/css");
        expect(detectMimeType("a.js", text)).toBe("text/javascript");
        expect(detectMimeType("a.txt", bytes(1, 0, 2))).toBe("application/octet-stream");
        expect(detectMimeType("a.md", bytes(1, 0, 2))).toBe("application/octet-stream");
        expect(detectMimeType("a.csv", bytes(1, 0, 2))).toBe("application/octet-stream");
        expect(detectMimeType("a.json", bytes(1, 0, 2))).toBe("application/octet-stream");
        expect(detectMimeType("a.html", bytes(1, 0, 2))).toBe("application/octet-stream");
        expect(detectMimeType("a.xml", bytes(1, 0, 2))).toBe("application/octet-stream");
        expect(detectMimeType("a.css", bytes(1, 0, 2))).toBe("application/octet-stream");
        expect(detectMimeType("a.js", bytes(1, 0, 2))).toBe("application/octet-stream");
        expect(detectMimeType("a.unknown", text)).toBe("application/octet-stream");
        expect(detectMimeType("noext", new Uint8Array())).toBe("application/octet-stream");
    });
});

describe("asset filenames", () => {
    it("trims valid names and rejects unsafe names", () => {
        expect(cleanFilename("  lesson.pdf  ")).toBe("lesson.pdf");
        expect(() => cleanFilename("   ")).toThrow("file name is empty");
        expect(() => cleanFilename("bad\u007fname")).toThrow("control characters");
        expect(() => cleanFilename("a".repeat(1025))).toThrow("too long");
    });
});
