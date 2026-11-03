import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { makeAssetImport, streamAssetBytes } from "../../../frontend/domain/assets";

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

function blobRecord(id: string, fields: Record<string, string>): ArchiveRecord {
    return {
        type: RecordType.assetBlob,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

describe("material stream failures", () => {
    it("surfaces invalid metadata through the stream controller", async () => {
        const metadata = metadataRecord({ byte_size: "4", content_hash: "bad", blob_id: "bad" });
        const reader = streamAssetBytes({} as ArchiveSnapshot, metadata).getReader();
        await expect(reader.read()).rejects.toMatchObject({ code: "asset_metadata_invalid" });
    });
});

describe("material import edge metadata", () => {
    it("records a document that produced no extractable text", async () => {
        const bytes = zipSync({
            "word/document.xml": strToU8(
                "<w:document><w:body><w:p><w:r><w:t>   </w:t></w:r></w:p></w:body></w:document>",
            ),
        });
        const imported = await makeAssetImport(
            { getRecordByIndexKey: async () => null } as unknown as ArchiveSnapshot,
            { name: "blank.docx", size: bytes.byteLength, readBytes: async () => bytes },
        );
        expect(imported.metadata.fields.get("text_extraction_status")).toBe("no-text");
        expect(imported.metadata.fields.has("extracted_text")).toBe(false);
        expect(imported.deduplicated).toBe(false);
    });

    it("treats a trashed content-hash index entry as a new blob", async () => {
        const content = new TextEncoder().encode("recycled material");
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", content))]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        const trashed = blobRecord(newUuid(), {
            record_role: "asset-blob",
            content_hash: hash,
            _deleted: "true",
        });
        const imported = await makeAssetImport(
            { getRecordByIndexKey: async () => trashed } as unknown as ArchiveSnapshot,
            { name: "recycled.txt", size: content.byteLength, readBytes: async () => content },
        );
        expect(imported.deduplicated).toBe(false);
        expect(imported.chunkCount).toBe(1);
        expect(imported.metadata.id).not.toBe(trashed.id);
    });
});
