import { describe, expect, it, vi } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    browserAssetReadSource,
    MAX_ASSET_BATCH_FILES,
    prepareStreamingAssetBatchImport,
    prepareStreamingAssetImport,
    type AssetReadSource,
} from "../../../frontend/domain/assets-stream";
import { loadSodium } from "../../../frontend/domain/sodium";

const mocks = vi.hoisted(() => ({ extract: vi.fn() }));

vi.mock("../../../frontend/domain/document-text", () => ({
    extractDocumentText: mocks.extract,
}));

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function record(
    type: number,
    id: string,
    fields: Record<string, string> = {},
    blob: Uint8Array = new Uint8Array(),
): ArchiveRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob,
    };
}

function snapshot(options: {
    indexed?: Map<string, ArchiveRecord | null>;
    records?: Map<string, ArchiveRecord>;
}): ArchiveSnapshot {
    return {
        getRecordByIndexKey: async (key: string) => options.indexed?.get(key) ?? null,
        getRecord: async (type: number, id: string) =>
            options.records?.get(`${type}:${id}`) ?? null,
    } as unknown as ArchiveSnapshot;
}

function source(name: string, bytes: Uint8Array): AssetReadSource {
    return {
        name,
        size: bytes.length,
        read: async (offset, length) => bytes.slice(offset, offset + length),
    };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const sodium = await loadSodium();
    return sodium.to_hex(sodium.crypto_hash_sha256(bytes));
}

function textBytes(value: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(value);
}

async function collect(generator: AsyncGenerator<ArchiveRecord>): Promise<ArchiveRecord[]> {
    const records: ArchiveRecord[] = [];
    for await (const item of generator) records.push(item);
    return records;
}

describe("browser material read sources", () => {
    it("reads stable slices of a browser file", async () => {
        const file = {
            name: "notes.txt",
            size: 5,
            slice: (start: number, end: number) => ({
                arrayBuffer: async () => textBytes("hello").slice(start, end).buffer,
            }),
        };
        const read = browserAssetReadSource(file as unknown as File);
        expect(read.name).toBe("notes.txt");
        expect(read.size).toBe(5);
        expect(await read.read(1, 3)).toEqual(textBytes("ell"));
    });
});

describe("streaming material preparation", () => {
    it.each([
        ["negative", -1],
        ["fractional", 1.5],
        ["too large", MAX_ASSET_BYTES + 1],
    ])("rejects %s sizes", async (_label, size) => {
        const read = { name: "a.txt", size, read: async () => new Uint8Array(0) };
        await expect(prepareStreamingAssetImport(snapshot({}), read)).rejects.toThrow(
            "Materials are limited to 256 MiB per file in this version.",
        );
    });

    it("rejects invalid session identifiers", async () => {
        await expect(
            prepareStreamingAssetImport(snapshot({}), source("a.txt", textBytes("a")), "bad"),
        ).rejects.toThrow("Session ID must be a valid UUID.");
    });

    it("prepares a small text material and streams chunk, manifest, and metadata", async () => {
        const bytes = textBytes("hello");
        const result = await prepareStreamingAssetImport(
            snapshot({}),
            source("notes.txt", bytes),
            SESSION_ID.toUpperCase(),
        );
        expect(result.deduplicated).toBe(false);
        expect(result.chunkCount).toBe(1);
        expect(result.metadata.fields.get("filename")).toBe("notes.txt");
        expect(result.metadata.fields.get("mime_type")).toBe("text/plain");
        expect(result.metadata.fields.get("byte_size")).toBe("5");
        expect(result.metadata.fields.get("blob_count")).toBe("1");
        expect(result.metadata.fields.get("origin")).toBe("user-import");
        expect(result.metadata.fields.get("session_id")).toBe(SESSION_ID);
        expect(result.metadata.fields.get("content_hash")).toBe(await sha256Hex(bytes));

        const records = await collect(result.records());
        expect(records).toHaveLength(3);
        expect(records[0]).toMatchObject({ type: RecordType.assetBlob });
        expect(records[0]!.fields.get("record_role")).toBe("asset-blob-chunk");
        expect(records[0]!.fields.get("chunk_index")).toBe("0");
        expect(records[0]!.blob).toEqual(bytes);
        expect(records[1]!.fields.get("record_role")).toBe("asset-blob-manifest");
        expect(records[1]!.fields.get("chunk_ids")).toBe(records[0]!.id);
        expect(records[2]).toBe(result.metadata);
    });

    it("splits larger materials into sequential chunks", async () => {
        const bytes = new Uint8Array(8 * 1024 * 1024 + 1);
        bytes[0] = 1;
        const result = await prepareStreamingAssetImport(snapshot({}), source("big.bin", bytes));
        expect(result.chunkCount).toBe(2);
        const records = await collect(result.records());
        expect(records).toHaveLength(4);
        expect(records[0]!.fields.get("chunk_index")).toBe("0");
        expect(records[0]!.blob.byteLength).toBe(8 * 1024 * 1024);
        expect(records[1]!.fields.get("chunk_index")).toBe("1");
        expect(records[1]!.blob.byteLength).toBe(1);
        expect(records[2]!.fields.get("record_role")).toBe("asset-blob-manifest");
        expect(records[3]).toBe(result.metadata);
    });

    it("omits the session field when no session is selected", async () => {
        const result = await prepareStreamingAssetImport(
            snapshot({}),
            source("notes.txt", textBytes("a")),
        );
        expect(result.metadata.fields.has("session_id")).toBe(false);
    });

    it("prepares an empty material", async () => {
        const result = await prepareStreamingAssetImport(
            snapshot({}),
            source("empty.txt", new Uint8Array()),
        );
        expect(result.chunkCount).toBe(0);
        const records = await collect(result.records());
        expect(records).toHaveLength(2);
        expect(records[0]!.fields.get("chunk_count")).toBe("0");
    });

    it("rejects a file that changes during the hashing pass", async () => {
        const bytes = textBytes("hello");
        const changing: AssetReadSource = {
            name: "a.txt",
            size: bytes.length,
            read: async () => bytes.slice(0, 2),
        };
        await expect(prepareStreamingAssetImport(snapshot({}), changing)).rejects.toThrow(
            "The selected file changed during import.",
        );
    });

    it.each([
        ["text", "a.txt", "text/plain"],
        ["markdown", "a.md", "text/markdown"],
        ["json", "a.json", "application/json"],
        ["xml", "a.xml", "application/xml"],
    ])("downgrades %s materials containing NUL beyond the prefix", async (_label, name, mime) => {
        const bytes = new Uint8Array(5000).fill(0x61);
        bytes[4500] = 0;
        const normal = await prepareStreamingAssetImport(snapshot({}), source(name, bytes));
        expect(normal.metadata.fields.get("mime_type")).toBe("application/octet-stream");
        const withoutNul = new Uint8Array(5000).fill(0x61);
        const plain = await prepareStreamingAssetImport(snapshot({}), source(name, withoutNul));
        expect(plain.metadata.fields.get("mime_type")).toBe(mime);
    });

    it("keeps binary mime types when NUL bytes are present", async () => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
        const result = await prepareStreamingAssetImport(snapshot({}), source("image.png", bytes));
        expect(result.metadata.fields.get("mime_type")).toBe("image/png");
    });

    it("reuses a batch blob without querying the archive", async () => {
        const bytes = textBytes("shared");
        const reused = new Map<string, { id: string; chunkCount: number }>();
        const first = await prepareStreamingAssetImport(
            snapshot({}),
            source("a.txt", bytes),
            "",
            reused,
        );
        const second = await prepareStreamingAssetImport(
            snapshot({}),
            source("b.txt", bytes),
            "",
            reused,
        );
        expect(first.deduplicated).toBe(false);
        expect(second.deduplicated).toBe(true);
        expect(second.metadata.fields.get("blob_id")).toBe(first.metadata.fields.get("blob_id"));
        expect(second.chunkCount).toBe(1);
        expect(await collect(second.records())).toEqual([second.metadata]);
    });

    it("reuses a plain archive blob and verifies it", async () => {
        const bytes = textBytes("hello");
        const hash = await sha256Hex(bytes);
        const blobId = "22222222-2222-4222-8222-222222222222";
        const existing = record(
            RecordType.assetBlob,
            blobId,
            { record_role: "asset-blob", content_hash: hash },
            bytes,
        );
        const index = new Map<string, ArchiveRecord | null>([[`BLOB:${hash}`, existing]]);
        const result = await prepareStreamingAssetImport(
            snapshot({
                indexed: index,
                records: new Map([[`${RecordType.assetBlob}:${blobId}`, existing]]),
            }),
            source("a.txt", bytes),
        );
        expect(result.deduplicated).toBe(true);
        expect(result.chunkCount).toBe(1);
        expect(result.metadata.fields.get("blob_id")).toBe(blobId);
        expect(await collect(result.records())).toEqual([result.metadata]);
    });

    it("reuses an archive manifest blob", async () => {
        const bytes = textBytes("hello");
        const hash = await sha256Hex(bytes);
        const blobId = "22222222-2222-4222-8222-222222222222";
        const chunkId = "33333333-3333-4333-8333-333333333333";
        const manifest = record(RecordType.assetBlob, blobId, {
            record_role: "asset-blob-manifest",
            content_hash: hash,
            byte_size: "5",
            chunk_count: "1",
            chunk_ids: chunkId,
        });
        const chunkRecord = record(
            RecordType.assetBlob,
            chunkId,
            {
                record_role: "asset-blob-chunk",
                manifest_id: blobId,
                chunk_index: "0",
                byte_size: "5",
            },
            bytes,
        );
        const index = new Map<string, ArchiveRecord | null>([[`BLOB:${hash}`, manifest]]);
        const archive = new Map<string, ArchiveRecord>([
            [`${RecordType.assetBlob}:${blobId}`, manifest],
            [`${RecordType.assetBlob}:${chunkId}`, chunkRecord],
        ]);
        const result = await prepareStreamingAssetImport(
            snapshot({ indexed: index, records: archive }),
            source("a.txt", bytes),
        );
        expect(result.deduplicated).toBe(true);
        expect(result.chunkCount).toBe(1);
        expect(result.metadata.fields.get("blob_id")).toBe(blobId);
    });

    it("imports again when the indexed blob is deleted", async () => {
        const bytes = textBytes("hello");
        const hash = await sha256Hex(bytes);
        const deleted = record(RecordType.assetBlob, "22222222-2222-4222-8222-222222222222", {
            record_role: "asset-blob",
            _deleted: "true",
        });
        const index = new Map<string, ArchiveRecord | null>([[`BLOB:${hash}`, deleted]]);
        const result = await prepareStreamingAssetImport(
            snapshot({ indexed: index }),
            source("a.txt", bytes),
        );
        expect(result.deduplicated).toBe(false);
        expect(result.metadata.fields.get("blob_id")).not.toBe(deleted.id);
    });

    it.each([
        ["record type", { type: RecordType.session, fields: { content_hash: "hash" } }],
        ["content hash", { type: RecordType.assetBlob, fields: { content_hash: "other" } }],
    ] as const)("rejects an invalid archive blob index by %s", async (_label, override) => {
        const bytes = textBytes("hello");
        const hash = await sha256Hex(bytes);
        const existing = record(override.type, "22222222-2222-4222-8222-222222222222", {
            ...override.fields,
        });
        const index = new Map<string, ArchiveRecord | null>([[`BLOB:${hash}`, existing]]);
        await expect(
            prepareStreamingAssetImport(snapshot({ indexed: index }), source("a.txt", bytes)),
        ).rejects.toMatchObject({ code: "asset_blob_index_invalid" });
    });

    it.each([
        ["not a number", "many"],
        ["negative", "-1"],
        ["too large", "999999"],
    ])("rejects invalid archive manifest counts: %s", async (_label, count) => {
        const bytes = textBytes("hello");
        const hash = await sha256Hex(bytes);
        const manifest = record(RecordType.assetBlob, "22222222-2222-4222-8222-222222222222", {
            record_role: "asset-blob-manifest",
            content_hash: hash,
            chunk_count: count,
        });
        const index = new Map<string, ArchiveRecord | null>([[`BLOB:${hash}`, manifest]]);
        await expect(
            prepareStreamingAssetImport(snapshot({ indexed: index }), source("a.txt", bytes)),
        ).rejects.toMatchObject({ code: "asset_manifest_invalid" });
    });

    it("stores document text extraction results", async () => {
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        mocks.extract.mockResolvedValueOnce({ status: "extracted", text: "document text" });
        const result = await prepareStreamingAssetImport(snapshot({}), source("a.docx", bytes));
        expect(result.metadata.fields.get("mime_type")).toBe(DOCX_MIME);
        expect(result.metadata.fields.get("text_extraction_status")).toBe("extracted");
        expect(result.metadata.fields.get("extracted_text")).toBe("document text");
    });

    it("records extractions without text and null extractions", async () => {
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
        mocks.extract.mockResolvedValueOnce({ status: "no-text", text: "" });
        const empty = await prepareStreamingAssetImport(snapshot({}), source("a.pdf", bytes));
        expect(empty.metadata.fields.get("text_extraction_status")).toBe("no-text");
        expect(empty.metadata.fields.has("extracted_text")).toBe(false);
        mocks.extract.mockResolvedValueOnce(null);
        const none = await prepareStreamingAssetImport(snapshot({}), source("b.pdf", bytes));
        expect(none.metadata.fields.has("text_extraction_status")).toBe(false);
    });

    it("marks oversized documents instead of extracting them", async () => {
        mocks.extract.mockClear();
        const bytes = new Uint8Array(16 * 1024 * 1024 + 1);
        bytes.set([0x50, 0x4b, 0x03, 0x04]);
        const result = await prepareStreamingAssetImport(snapshot({}), source("a.docx", bytes));
        expect(result.metadata.fields.get("text_extraction_status")).toBe("size-limit");
        expect(mocks.extract).not.toHaveBeenCalled();
    });

    it("rejects documents that change before extraction", async () => {
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        let reads = 0;
        const changing: AssetReadSource = {
            name: "a.docx",
            size: bytes.length,
            read: async (offset, length) => {
                reads += 1;
                return reads === 1 ? bytes.slice(offset, offset + length) : new Uint8Array(length);
            },
        };
        await expect(prepareStreamingAssetImport(snapshot({}), changing)).rejects.toThrow(
            "The selected file changed during import.",
        );
        mocks.extract.mockClear();
    });

    it("rejects a file that changes while streaming records", async () => {
        const bytes = textBytes("hello");
        let content = bytes;
        const changing: AssetReadSource = {
            name: "a.txt",
            size: bytes.length,
            read: async (offset, length) => content.slice(offset, offset + length),
        };
        const result = await prepareStreamingAssetImport(snapshot({}), changing);
        content = textBytes("world");
        await expect(collect(result.records())).rejects.toThrow(
            "The selected file changed during import.",
        );
        content = bytes;
        const short = await prepareStreamingAssetImport(snapshot({}), changing);
        content = bytes.slice(0, 2);
        await expect(collect(short.records())).rejects.toThrow(
            "The selected file changed during import.",
        );
    });
});

describe("streaming material batch preparation", () => {
    it("rejects empty selections", async () => {
        await expect(prepareStreamingAssetBatchImport(snapshot({}), [])).rejects.toThrow(
            "Choose at least one material to import.",
        );
    });

    it("rejects oversized selections", async () => {
        const sources = Array.from({ length: MAX_ASSET_BATCH_FILES + 1 }, () => ({
            name: "a.txt",
            size: 0,
            read: async () => new Uint8Array(),
        }));
        await expect(prepareStreamingAssetBatchImport(snapshot({}), sources)).rejects.toThrow(
            "Folder imports are limited to 10,000 files.",
        );
    });

    it("rejects individual files over the per-file limit", async () => {
        await expect(
            prepareStreamingAssetBatchImport(snapshot({}), [
                {
                    name: "huge file.bin",
                    size: MAX_ASSET_BYTES + 1,
                    read: async () => new Uint8Array(),
                },
            ]),
        ).rejects.toThrow("huge file.bin exceeds the 256 MiB per-file limit.");
    });

    it("deduplicates within a batch and reports progress", async () => {
        const bytes = textBytes("same");
        const progress = vi.fn();
        const batch = await prepareStreamingAssetBatchImport(
            snapshot({}),
            [source("a.txt", bytes), source("b.txt", bytes)],
            SESSION_ID,
            progress,
        );
        expect(batch.items).toHaveLength(2);
        expect(batch.metadata).toHaveLength(2);
        expect(batch.totalBytes).toBe(8);
        expect(batch.deduplicatedCount).toBe(1);
        expect(progress.mock.calls).toEqual([
            ["checking", 1, 2],
            ["checking", 2, 2],
        ]);
        expect(await collect(batch.records())).toHaveLength(4);
        expect(progress.mock.calls.slice(-2)).toEqual([
            ["staging", 1, 2],
            ["staging", 2, 2],
        ]);
    });

    it("works without a progress callback", async () => {
        const batch = await prepareStreamingAssetBatchImport(snapshot({}), [
            source("a.txt", textBytes("one")),
        ]);
        expect(await collect(batch.records())).toHaveLength(3);
    });
});
