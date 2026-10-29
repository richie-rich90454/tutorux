import sodium from "libsodium-wrappers-sumo";
import { ArchiveFormatError, RecordType, newUuid, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";
import {
  cleanFilename,
  detectMimeType,
  iterateVerifiedAssetChunks,
  MAX_ASSET_BYTES,
} from "./assets";
import { extractDocumentText } from "./document-text";

const CHUNK_BYTES = 8 * 1024 * 1024;
const EXTRACT_LIMIT = 16 * 1024 * 1024;

/** A stable, repeatably readable material source. */
export interface AssetReadSource {
  readonly name: string;
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function browserAssetReadSource(file: File): AssetReadSource {
  return {
    name: file.name,
    size: file.size,
    async read(offset, length) {
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    },
  };
}

export interface StreamingAssetImport {
  readonly metadata: ArchiveRecord;
  readonly deduplicated: boolean;
  readonly chunkCount: number;
  /** Stage these records privately; publish only after this iterator completes successfully. */
  records(): AsyncGenerator<ArchiveRecord>;
}

/** Prepare a material without retaining its full content; reading must be repeatable. */
export async function prepareStreamingAssetImport(
  snapshot: ArchiveSnapshot,
  source: AssetReadSource,
  sessionId = "",
): Promise<StreamingAssetImport> {
  if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > MAX_ASSET_BYTES) {
    throw new Error("Materials are limited to 256 MiB per file in this version.");
  }
  if (sessionId && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(sessionId)) {
    throw new Error("Session ID must be a valid UUID.");
  }
  const filename = cleanFilename(source.name);
  await sodium.ready;
  const firstHash = sodium.crypto_hash_sha256_init();
  let firstFinalized = false;
  let prefix = new Uint8Array();
  let containsZero = false;
  try {
    for (let offset = 0; offset < source.size; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, source.size - offset);
      const bytes = await source.read(offset, length);
      if (bytes.byteLength !== length) throw new Error("The selected file changed during import.");
      if (offset === 0) prefix = bytes.slice(0, 4096);
      containsZero ||= bytes.includes(0);
      sodium.crypto_hash_sha256_update(firstHash, bytes);
    }
    const contentHash = sodium.to_hex(sodium.crypto_hash_sha256_final(firstHash));
    firstFinalized = true;
    let mimeType = detectMimeType(filename, prefix);
    if (
      containsZero &&
      (mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "application/xml")
    )
      mimeType = "application/octet-stream";
    const existing = await snapshot.getRecordByIndexKey(`BLOB:${contentHash}`);
    const deduplicated = Boolean(existing && existing.fields.get("_deleted") !== "true");
    if (
      deduplicated &&
      (existing!.type !== RecordType.assetBlob ||
        existing!.fields.get("content_hash")?.toLowerCase() !== contentHash)
    ) {
      throw new ArchiveFormatError(
        "asset_blob_index_invalid",
        "The archive content hash index points to an invalid asset blob.",
      );
    }
    const blobId = deduplicated ? existing!.id : newUuid();
    const chunkCount = deduplicated
      ? existing!.fields.get("record_role") === "asset-blob-manifest"
        ? Number(existing!.fields.get("chunk_count"))
        : 1
      : Math.ceil(source.size / CHUNK_BYTES);
    if (
      !Number.isSafeInteger(chunkCount) ||
      chunkCount < 0 ||
      chunkCount > Math.ceil(MAX_ASSET_BYTES / CHUNK_BYTES)
    ) {
      throw new ArchiveFormatError("asset_manifest_invalid", "Material chunk count is invalid.");
    }
    const ids = deduplicated ? [] : Array.from({ length: chunkCount }, () => newUuid());
    const fields = new Map<string, string>([
      ["filename", filename],
      ["mime_type", mimeType],
      ["byte_size", String(source.size)],
      ["content_hash", contentHash],
      ["blob_id", blobId],
      ["blob_count", String(chunkCount)],
      ["origin", "user-import"],
      ["created_at_us", (BigInt(Date.now()) * 1000n).toString()],
    ]);
    if (sessionId) fields.set("session_id", sessionId.toLowerCase());
    if (
      mimeType === "application/pdf" ||
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      if (source.size > EXTRACT_LIMIT) fields.set("text_extraction_status", "size-limit");
      else {
        const document = await source.read(0, source.size);
        if (
          document.length !== source.size ||
          sodium.to_hex(sodium.crypto_hash_sha256(document)) !== contentHash
        )
          throw new Error("The selected file changed during import.");
        const extraction = await extractDocumentText(filename, mimeType, document);
        if (extraction) {
          fields.set("text_extraction_status", extraction.status);
          if (extraction.text) fields.set("extracted_text", extraction.text);
        }
      }
    }
    const metadata: ArchiveRecord = {
      type: RecordType.assetMetadata,
      id: newUuid(),
      revision: 0n,
      previousOffset: 0n,
      fields,
      blob: new Uint8Array(),
    };
    if (deduplicated) {
      const verification = iterateVerifiedAssetChunks(snapshot, metadata);
      while (!(await verification.next()).done) {
        // Read the full existing blob to verify its digest before reuse.
      }
    }
    return {
      metadata,
      deduplicated,
      chunkCount,
      async *records() {
        const check = sodium.crypto_hash_sha256_init();
        let finalized = false;
        try {
          for (let offset = 0, index = 0; offset < source.size; offset += CHUNK_BYTES, index += 1) {
            const length = Math.min(CHUNK_BYTES, source.size - offset);
            const bytes = await source.read(offset, length);
            if (bytes.length !== length)
              throw new Error("The selected file changed during import.");
            sodium.crypto_hash_sha256_update(check, bytes);
            if (!deduplicated)
              yield {
                type: RecordType.assetBlob,
                id: ids[index]!,
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([
                  ["record_role", "asset-blob-chunk"],
                  ["manifest_id", blobId],
                  ["chunk_index", String(index)],
                  ["byte_size", String(bytes.length)],
                ]),
                blob: bytes,
              };
          }
          const verified = sodium.to_hex(sodium.crypto_hash_sha256_final(check));
          finalized = true;
          if (verified !== contentHash) throw new Error("The selected file changed during import.");
          if (!deduplicated)
            yield {
              type: RecordType.assetBlob,
              id: blobId,
              revision: 0n,
              previousOffset: 0n,
              fields: new Map([
                ["record_role", "asset-blob-manifest"],
                ["content_hash", contentHash],
                ["byte_size", String(source.size)],
                ["chunk_count", String(chunkCount)],
                ["chunk_ids", ids.join(",")],
              ]),
              blob: new Uint8Array(),
            };
          yield metadata;
        } finally {
          if (!finalized) sodium.crypto_hash_sha256_final(check);
        }
      },
    };
  } finally {
    if (!firstFinalized) sodium.crypto_hash_sha256_final(firstHash);
  }
}
