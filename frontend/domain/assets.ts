import { ArchiveFormatError, RecordType, newUuid, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";

export const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const ASSET_CHUNK_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

export type AssetFile =
  | {
      readonly name: string;
      readonly size: number;
      arrayBuffer(): Promise<ArrayBuffer>;
    }
  | {
      readonly name: string;
      readonly size: number;
      readBytes(): Promise<Uint8Array>;
    };

export interface AssetImport {
  readonly records: readonly ArchiveRecord[];
  readonly metadata: ArchiveRecord;
  readonly deduplicated: boolean;
  readonly chunkCount: number;
}

export async function makeAssetImport(
  snapshot: ArchiveSnapshot,
  file: AssetFile,
  sessionId = "",
): Promise<AssetImport> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ASSET_BYTES) {
    throw new Error("Materials are limited to 256 MiB per file in this version.");
  }
  const filename = cleanFilename(file.name);
  if (sessionId && !isUuid(sessionId)) throw new Error("Session ID must be a valid UUID.");
  const bytes =
    "readBytes" in file ? await file.readBytes() : new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw new Error("The selected file changed during import.");
  const contentHash = hex(await sha256(bytes));
  const mimeType = detectMimeType(filename, bytes);
  const existing = await currentBlob(snapshot, contentHash);

  let blobId: string;
  let chunkCount: number;
  let deduplicated = false;
  const records: ArchiveRecord[] = [];
  if (existing) {
    if (
      existing.type !== RecordType.assetBlob ||
      existing.fields.get("content_hash")?.toLowerCase() !== contentHash
    ) {
      throw new ArchiveFormatError(
        "asset_blob_index_invalid",
        "The archive content hash index points to an invalid asset blob.",
      );
    }
    const content = await readBlobRecord(snapshot, existing);
    if (content.byteLength !== bytes.byteLength || !(await matchesHash(content, contentHash))) {
      throw new ArchiveFormatError(
        "asset_blob_index_invalid",
        "The archive content hash index points to an invalid asset.",
      );
    }
    blobId = existing.id;
    chunkCount =
      existing.fields.get("record_role") === "asset-blob-manifest"
        ? parseCount(existing.fields.get("chunk_count"), "Asset chunk count")
        : 1;
    deduplicated = true;
  } else {
    blobId = newUuid();
    const chunkIds: string[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += ASSET_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + ASSET_CHUNK_BYTES, bytes.byteLength));
      const id = newUuid();
      chunkIds.push(id);
      records.push({
        type: RecordType.assetBlob,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
          ["record_role", "asset-blob-chunk"],
          ["manifest_id", blobId],
          ["chunk_index", String(chunkIds.length - 1)],
          ["byte_size", chunk.byteLength + ""],
        ]),
        blob: chunk,
      });
    }
    chunkCount = chunkIds.length;
    records.push({
      type: RecordType.assetBlob,
      id: blobId,
      revision: 0n,
      previousOffset: 0n,
      fields: new Map([
        ["record_role", "asset-blob-manifest"],
        ["content_hash", contentHash],
        ["byte_size", bytes.byteLength + ""],
        ["chunk_count", chunkCount + ""],
        ["chunk_ids", chunkIds.join(",")],
      ]),
      blob: new Uint8Array(),
    });
  }

  const fields = new Map<string, string>([
    ["filename", filename],
    ["mime_type", mimeType],
    ["byte_size", bytes.byteLength + ""],
    ["content_hash", contentHash],
    ["blob_id", blobId],
    ["blob_count", chunkCount + ""],
    ["origin", "user-import"],
    ["created_at_us", (BigInt(Date.now()) * 1000n).toString()],
  ]);
  if (sessionId) fields.set("session_id", sessionId.toLowerCase());
  const extraction = extractDocumentText(filename, mimeType, bytes);
  if (extraction.status) fields.set("text_extraction_status", extraction.status);
  if (extraction.text) fields.set("extracted_text", extraction.text);
  const metadata: ArchiveRecord = {
    type: RecordType.assetMetadata,
    id: newUuid(),
    revision: 0n,
    previousOffset: 0n,
    fields,
    blob: new Uint8Array(),
  };
  records.push(metadata);
  return { records, metadata, deduplicated, chunkCount };
}

export async function readAssetBytes(
  snapshot: ArchiveSnapshot,
  metadata: ArchiveRecord,
): Promise<Uint8Array> {
  if (metadata.type !== RecordType.assetMetadata) throw new Error("Select a material to export.");
  const blobId = metadata.fields.get("blob_id");
  const expectedHash = metadata.fields.get("content_hash");
  const expectedSize = parseCount(metadata.fields.get("byte_size"), "Asset byte size");
  if (
    !blobId ||
    !/^[\da-f-]{36}$/iu.test(blobId) ||
    !expectedHash ||
    !/^[\da-f]{64}$/iu.test(expectedHash)
  ) {
    throw new ArchiveFormatError("asset_metadata_invalid", "Material content metadata is invalid.");
  }
  const blob = await snapshot.getRecord(RecordType.assetBlob, blobId);
  if (!blob || blob.fields.get("_deleted") === "true") {
    throw new ArchiveFormatError(
      "asset_blob_missing",
      "Material content is missing from this archive.",
    );
  }
  if (
    blob.fields.get("record_role") === "asset-blob-manifest" &&
    blob.fields.get("content_hash")?.toLowerCase() !== expectedHash.toLowerCase()
  ) {
    throw new ArchiveFormatError(
      "asset_manifest_hash_mismatch",
      "Material manifest hash does not match its metadata.",
    );
  }
  const metadataChunkCount = metadata.fields.get("blob_count");
  const expectedChunkCount =
    blob.fields.get("record_role") === "asset-blob-manifest"
      ? parseCount(blob.fields.get("chunk_count"), "Asset chunk count")
      : 1;
  if (
    metadataChunkCount !== undefined &&
    parseCount(metadataChunkCount, "Asset chunk count") !== expectedChunkCount
  ) {
    throw new ArchiveFormatError(
      "asset_manifest_invalid",
      "Material chunk count does not match its metadata.",
    );
  }
  const content = await readBlobRecord(snapshot, blob);
  if (content.byteLength !== expectedSize || !(await matchesHash(content, expectedHash))) {
    throw new ArchiveFormatError(
      "asset_content_integrity_failed",
      "Material byte count or SHA-256 does not match its metadata.",
    );
  }
  return content;
}

async function currentBlob(
  snapshot: ArchiveSnapshot,
  contentHash: string,
): Promise<ArchiveRecord | null> {
  const record = await snapshot.getRecordByIndexKey(`BLOB:${contentHash.toLowerCase()}`);
  return record?.fields.get("_deleted") === "true" ? null : record;
}

async function readBlobRecord(
  snapshot: ArchiveSnapshot,
  record: ArchiveRecord,
): Promise<Uint8Array> {
  if (record.fields.get("record_role") !== "asset-blob-manifest") return record.blob;
  const ids = record.fields.get("chunk_ids") ?? "";
  const chunkIds = ids ? ids.split(",") : [];
  const count = parseCount(record.fields.get("chunk_count"), "Asset chunk count");
  const byteSize = parseCount(record.fields.get("byte_size"), "Asset byte size");
  if (count !== chunkIds.length || count > Math.ceil(MAX_ASSET_BYTES / ASSET_CHUNK_BYTES)) {
    throw new ArchiveFormatError(
      "asset_manifest_invalid",
      "Material chunk manifest is inconsistent.",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < chunkIds.length; index += 1) {
    const id = chunkIds[index]!;
    if (!isUuid(id))
      throw new ArchiveFormatError("asset_chunk_id_invalid", "Material chunk ID is invalid.");
    const chunk = await snapshot.getRecord(RecordType.assetBlob, id);
    if (
      !chunk ||
      chunk.fields.get("_deleted") === "true" ||
      chunk.fields.get("record_role") !== "asset-blob-chunk" ||
      chunk.fields.get("manifest_id")?.toLowerCase() !== record.id.toLowerCase() ||
      chunk.fields.get("chunk_index") !== index + "" ||
      chunk.blob.byteLength !== parseCount(chunk.fields.get("byte_size"), "Material chunk size")
    ) {
      throw new ArchiveFormatError(
        "asset_chunk_missing",
        "A material chunk is missing or out of sequence.",
      );
    }
    const expectedChunkSize = Math.min(ASSET_CHUNK_BYTES, byteSize - total);
    if (chunk.blob.byteLength !== expectedChunkSize) {
      throw new ArchiveFormatError(
        "asset_chunk_size_invalid",
        "Material chunks do not match the expected 8 MiB layout.",
      );
    }
    chunks.push(chunk.blob);
    total += chunk.blob.byteLength;
  }
  if (total !== byteSize)
    throw new ArchiveFormatError(
      "asset_size_invalid",
      "Material size does not match its manifest.",
    );
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function matchesHash(bytes: Uint8Array, expected: string): Promise<boolean> {
  return hex(await sha256(bytes)) === expected.toLowerCase();
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const input =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

function extractDocumentText(
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): { status: string; text: string } {
  const extension = filename.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  const isSupportedDocument = mimeType === "application/pdf" || extension === "docx";
  if (!isSupportedDocument) return { status: "", text: "" };
  if (bytes.byteLength > 16 * 1024 * 1024) return { status: "size-limit", text: "" };
  if (mimeType === "application/pdf" || extension === "pdf") {
    return { status: "extractor-unavailable", text: "" };
  }
  return { status: "extractor-unavailable", text: "" };
}

function detectMimeType(filename: string, bytes: Uint8Array): string {
  const starts = (...signature: number[]): boolean =>
    signature.every((value, index) => bytes[index] === value);
  const ascii = (offset: number, value: string): boolean =>
    [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  const extension = filename.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "BM")) return "image/bmp";
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return "image/tiff";
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "application/x-ole-storage";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "fLaC")) return "audio/flac";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (ascii(0, "ID3")) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  if (starts(0x1a, 0x45, 0xdf, 0xa3))
    return extension === "webm" ? "video/webm" : "video/x-matroska";
  if (ascii(0, "PK\x03\x04")) {
    if (extension === "docx")
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (extension === "xlsx")
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (extension === "pptx")
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return "application/zip";
  }
  if (bytes.length >= 8 && ascii(4, "ftyp")) {
    return extension === "m4a" || extension === "m4b" ? "audio/mp4" : "video/mp4";
  }
  if (extension === "txt") return bytes.includes(0) ? "application/octet-stream" : "text/plain";
  if (extension === "md" || extension === "markdown")
    return bytes.includes(0) ? "application/octet-stream" : "text/markdown";
  if (extension === "csv") return bytes.includes(0) ? "application/octet-stream" : "text/csv";
  if (extension === "json")
    return bytes.includes(0) ? "application/octet-stream" : "application/json";
  if (extension === "html" || extension === "htm")
    return bytes.includes(0) ? "application/octet-stream" : "text/html";
  if (extension === "xml")
    return bytes.includes(0) ? "application/octet-stream" : "application/xml";
  if (extension === "css") return bytes.includes(0) ? "application/octet-stream" : "text/css";
  if (extension === "js") return bytes.includes(0) ? "application/octet-stream" : "text/javascript";
  return "application/octet-stream";
}

function cleanFilename(value: string): string {
  const name = value.trim();
  let hasControlCharacter = false;
  for (const character of name) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f) hasControlCharacter = true;
  }
  if (!name || encoder.encode(name).byteLength > 1024 || hasControlCharacter) {
    throw new Error("Material file name is empty, too long, or contains control characters.");
  }
  return name;
}

function parseCount(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/u.test(value))
    throw new ArchiveFormatError("asset_metadata_invalid", `${label} is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_ASSET_BYTES) {
    throw new ArchiveFormatError(
      "asset_metadata_invalid",
      `${label} is outside the supported range.`,
    );
  }
  return parsed;
}

function isUuid(value: string): boolean {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
