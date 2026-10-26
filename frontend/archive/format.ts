export const ARCHIVE_HEADER_SIZE = 64;
export const RECORD_HEADER_SIZE = 64;
export const MAX_RECORD_PAYLOAD = 256n * 1024n * 1024n;
export const SUPPORTED_ARCHIVE_MAJOR = 1;
export const SUPPORTED_ARCHIVE_MINOR = 0;
export const CAPABILITY_ENCRYPTED = 1n;
const KNOWN_CAPABILITIES = CAPABILITY_ENCRYPTED;

export const RecordType = {
  student: 1,
  session: 2,
  audioChunk: 3,
  transcriptSegment: 4,
  annotation: 5,
  assetMetadata: 6,
  assetBlob: 7,
  evidenceNode: 8,
  evidenceEdge: 9,
  guide: 10,
  settings: 11,
  aiJob: 12,
  encryption: 13,
  waveformIndex: 14,
  indexPage: 250,
  commit: 251,
} as const;

export type RecordTypeValue = (typeof RecordType)[keyof typeof RecordType] | number;

export interface ArchiveHeader {
  id: string;
  majorVersion: number;
  minorVersion: number;
  createdAtUs: bigint;
  capabilities: bigint;
}

export interface ArchiveVersion {
  major: number;
  minor: number;
}

export interface ArchiveRecord {
  type: RecordTypeValue;
  id: string;
  revision: bigint;
  previousOffset: bigint;
  fields: ReadonlyMap<string, string>;
  blob: Uint8Array;
}

export interface ArchiveRecordFrame {
  type: RecordTypeValue;
  id: string;
  revision: bigint;
  previousOffset: bigint;
  codec: 0 | 1;
  flags: number;
  payloadLength: number;
  payloadChecksum: number;
  storedPayload: Uint8Array;
  endOffset: number;
}

export interface ArchiveRecordFrameHeader {
  type: RecordTypeValue;
  id: string;
  revision: bigint;
  previousOffset: bigint;
  codec: 0 | 1;
  flags: number;
  payloadLength: number;
  payloadChecksum: number;
}

export class ArchiveFormatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveFormatError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let byte = 0; byte < table.length; byte += 1) {
    let value = byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[byte] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[index]!) & 0xff]!;
  }
  return ~crc >>> 0;
}

function readLittle(bytes: Uint8Array, offset: number, size: 2 | 4 | 8): bigint {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) {
    throw new ArchiveFormatError("archive_truncated", "Archive field is truncated.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (size === 2) return BigInt(view.getUint16(offset, true));
  if (size === 4) return BigInt(view.getUint32(offset, true));
  return view.getBigUint64(offset, true);
}

function writeLittle(view: DataView, offset: number, size: 2 | 4 | 8, value: bigint): void {
  if (size === 2) view.setUint16(offset, Number(value), true);
  else if (size === 4) view.setUint32(offset, Number(value), true);
  else view.setBigUint64(offset, value, true);
}

function writeMagic(target: Uint8Array, offset: number, magic: string): void {
  for (let index = 0; index < magic.length; index += 1) {
    target[offset + index] = magic.charCodeAt(index);
  }
}

function hasMagic(bytes: Uint8Array, offset: number, magic: string): boolean {
  if (offset + magic.length > bytes.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[offset + index] !== magic.charCodeAt(index)) return false;
  }
  return true;
}

function encodeUtf8(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  if (decoder.decode(bytes) !== value) {
    throw new ArchiveFormatError("record_text_invalid", "Record text must contain valid Unicode.");
  }
  return bytes;
}

export function uuidToBytes(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  if (!/^[\da-f]{32}$/i.test(hex)) {
    throw new ArchiveFormatError("id_invalid", "Identifier must be a 128-bit hexadecimal UUID.");
  }
  const result = new Uint8Array(16);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function uuidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new ArchiveFormatError("id_invalid", "Identifier must be a 128-bit UUID.");
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newUuid(): string {
  return crypto.randomUUID();
}

export function inspectArchiveVersion(bytes: Uint8Array): ArchiveVersion {
  if (bytes.length < ARCHIVE_HEADER_SIZE || !hasMagic(bytes, 0, "TUTORUX\0")) {
    throw new ArchiveFormatError("archive_magic_invalid", "File is not a Tutorux archive.");
  }
  const expected = Number(readLittle(bytes, 60, 4));
  if (crc32(bytes.subarray(0, 60)) !== expected) {
    throw new ArchiveFormatError("archive_header_checksum", "Archive header checksum is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = view.getUint16(8, true);
  const minor = view.getUint16(10, true);
  if (view.getUint32(12, true) !== ARCHIVE_HEADER_SIZE) {
    throw new ArchiveFormatError("archive_header_invalid", "Archive header fields are invalid.");
  }
  return { major, minor };
}

export function encodeArchiveHeader(header: ArchiveHeader): Uint8Array {
  const bytes = new Uint8Array(ARCHIVE_HEADER_SIZE);
  const view = new DataView(bytes.buffer);
  writeMagic(bytes, 0, "TUTORUX\0");
  writeLittle(view, 8, 2, BigInt(header.majorVersion));
  writeLittle(view, 10, 2, BigInt(header.minorVersion));
  writeLittle(view, 12, 4, BigInt(ARCHIVE_HEADER_SIZE));
  bytes.set(uuidToBytes(header.id), 16);
  writeLittle(view, 32, 8, header.createdAtUs);
  writeLittle(view, 40, 8, header.capabilities);
  writeLittle(view, 60, 4, BigInt(crc32(bytes.subarray(0, 60))));
  return bytes;
}

export function decodeArchiveHeader(bytes: Uint8Array): ArchiveHeader {
  const version = inspectArchiveVersion(bytes);
  if (bytes.subarray(48, 60).some((byte) => byte !== 0)) {
    throw new ArchiveFormatError(
      "archive_header_reserved",
      "Reserved archive header bytes must be zero.",
    );
  }
  if (version.major !== SUPPORTED_ARCHIVE_MAJOR || version.minor > SUPPORTED_ARCHIVE_MINOR) {
    throw new ArchiveFormatError(
      "archive_version_unsupported",
      "This archive format version is not supported.",
    );
  }
  const capabilities = readLittle(bytes, 40, 8);
  if ((capabilities & ~KNOWN_CAPABILITIES) !== 0n) {
    throw new ArchiveFormatError(
      "archive_capability_unsupported",
      "This archive requires capabilities that this application does not understand.",
    );
  }
  return {
    id: uuidFromBytes(bytes.subarray(16, 32)),
    majorVersion: version.major,
    minorVersion: version.minor,
    createdAtUs: readLittle(bytes, 32, 8),
    capabilities,
  };
}

export function encodeRecordPayload(record: Pick<ArchiveRecord, "fields" | "blob">): Uint8Array {
  const fields = Array.from(record.fields, ([key, value]) => ({
    key: encodeUtf8(key),
    value: encodeUtf8(value),
  }));
  if (fields.length > 0xffff) {
    throw new ArchiveFormatError("record_field_limit", "Record contains too many fields.");
  }
  fields.sort((left, right) => compareBytes(left.key, right.key));
  let total = 16 + record.blob.byteLength;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.key.length === 0 || field.key.length > 0xffff || field.value.length > 0xffffffff) {
      throw new ArchiveFormatError("record_field_limit", "Record field exceeds format limits.");
    }
    if (index > 0 && compareBytes(fields[index - 1]!.key, field.key) === 0) {
      throw new ArchiveFormatError(
        "record_field_duplicate",
        "Record contains duplicate field names.",
      );
    }
    total += 6 + field.key.length + field.value.length;
  }
  if (BigInt(total) > MAX_RECORD_PAYLOAD) {
    throw new ArchiveFormatError("record_payload_limit", "Record payload exceeds the v1 limit.");
  }
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  writeMagic(output, 0, "TXMD");
  writeLittle(view, 4, 2, 1n);
  writeLittle(view, 6, 2, BigInt(fields.length));
  writeLittle(view, 8, 8, BigInt(record.blob.byteLength));
  let cursor = 16;
  for (const field of fields) {
    writeLittle(view, cursor, 2, BigInt(field.key.length));
    writeLittle(view, cursor + 2, 4, BigInt(field.value.length));
    cursor += 6;
    output.set(field.key, cursor);
    cursor += field.key.length;
    output.set(field.value, cursor);
    cursor += field.value.length;
  }
  output.set(record.blob, cursor);
  return output;
}

export function decodeRecordPayload(
  type: RecordTypeValue,
  id: string,
  revision: bigint,
  previousOffset: bigint,
  payload: Uint8Array,
): ArchiveRecord {
  if (payload.length < 16 || !hasMagic(payload, 0, "TXMD")) {
    throw new ArchiveFormatError("record_payload_invalid", "Domain record payload is malformed.");
  }
  const schema = Number(readLittle(payload, 4, 2));
  if (schema !== 1) {
    throw new ArchiveFormatError("record_schema_unsupported", "Unsupported record schema.");
  }
  const count = Number(readLittle(payload, 6, 2));
  const blobLength = readLittle(payload, 8, 8);
  const fields = new Map<string, string>();
  let cursor = 16;
  for (let index = 0; index < count; index += 1) {
    const keyLength = Number(readLittle(payload, cursor, 2));
    const valueLength = Number(readLittle(payload, cursor + 2, 4));
    cursor += 6;
    if (keyLength === 0 || cursor + keyLength + valueLength > payload.length) {
      throw new ArchiveFormatError("record_field_invalid", "Record field exceeds its payload.");
    }
    let key: string;
    let value: string;
    try {
      key = decoder.decode(payload.subarray(cursor, cursor + keyLength));
      cursor += keyLength;
      value = decoder.decode(payload.subarray(cursor, cursor + valueLength));
      cursor += valueLength;
    } catch {
      throw new ArchiveFormatError("record_text_invalid", "Record text is not valid UTF-8.");
    }
    if (fields.has(key)) {
      throw new ArchiveFormatError(
        "record_field_duplicate",
        "Record contains duplicate field names.",
      );
    }
    fields.set(key, value);
  }
  if (blobLength !== BigInt(payload.length - cursor)) {
    throw new ArchiveFormatError("record_blob_invalid", "Record blob length is inconsistent.");
  }
  return { type, id, revision, previousOffset, fields, blob: payload.slice(cursor) };
}

export function encodeRecordFrame(
  record: Pick<ArchiveRecord, "type" | "id" | "revision" | "previousOffset">,
  storedPayload: Uint8Array,
  codec: 0 | 1 = 0,
  flags = 0,
): Uint8Array {
  if (!Number.isInteger(record.type) || record.type < 0 || record.type > 0xffff) {
    throw new ArchiveFormatError("record_type_invalid", "Record type is outside the v1 range.");
  }
  if (storedPayload.byteLength > Number(MAX_RECORD_PAYLOAD)) {
    throw new ArchiveFormatError("record_payload_limit", "Record exceeds the v1 payload limit.");
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff || (flags & ~1) !== 0) {
    throw new ArchiveFormatError("record_flags_invalid", "Record framing flags are invalid.");
  }
  const paddingLength = (8 - (storedPayload.byteLength % 8)) % 8;
  const output = new Uint8Array(RECORD_HEADER_SIZE + storedPayload.byteLength + paddingLength);
  const view = new DataView(output.buffer);
  writeMagic(output, 0, "TXRC");
  writeLittle(view, 4, 2, BigInt(record.type));
  writeLittle(view, 6, 2, 1n);
  writeLittle(view, 8, 4, BigInt(RECORD_HEADER_SIZE));
  writeLittle(view, 12, 8, BigInt(storedPayload.byteLength));
  output.set(uuidToBytes(record.id), 20);
  writeLittle(view, 36, 8, record.revision);
  writeLittle(view, 44, 8, record.previousOffset);
  output[52] = codec;
  output[53] = flags;
  writeLittle(view, 54, 2, 0n);
  writeLittle(view, 56, 4, BigInt(crc32(storedPayload)));
  writeLittle(view, 60, 4, BigInt(crc32(output.subarray(0, 60))));
  output.set(storedPayload, RECORD_HEADER_SIZE);
  return output;
}

export function decodeRecordFrame(bytes: Uint8Array, offset = 0): ArchiveRecordFrame {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 8 !== 0 || offset > bytes.length) {
    throw new ArchiveFormatError(
      "record_offset_invalid",
      "Record offset is unaligned or outside the archive.",
    );
  }
  if (bytes.length - offset < RECORD_HEADER_SIZE) {
    throw new ArchiveFormatError(
      "record_header_invalid",
      "Record header magic or length is invalid.",
    );
  }
  const frameHeader = decodeRecordFrameHeader(
    bytes.subarray(offset, offset + RECORD_HEADER_SIZE),
    offset,
  );
  const payloadStart = offset + RECORD_HEADER_SIZE;
  if (frameHeader.payloadLength > bytes.length - payloadStart) {
    throw new ArchiveFormatError(
      "record_offset_invalid",
      "Record payload extends beyond the archive.",
    );
  }
  const payloadEnd = payloadStart + frameHeader.payloadLength;
  const paddingLength = (8 - (frameHeader.payloadLength % 8)) % 8;
  if (paddingLength > bytes.length - payloadEnd) {
    throw new ArchiveFormatError("record_offset_invalid", "Record alignment padding is truncated.");
  }
  const storedPayload = bytes.subarray(payloadStart, payloadEnd);
  if (crc32(storedPayload) !== frameHeader.payloadChecksum) {
    throw new ArchiveFormatError("record_payload_checksum", "Record payload checksum is invalid.");
  }
  for (let index = payloadEnd; index < payloadEnd + paddingLength; index += 1) {
    if (bytes[index] !== 0) {
      throw new ArchiveFormatError(
        "record_padding_invalid",
        "Record alignment padding must be zero.",
      );
    }
  }
  return { ...frameHeader, storedPayload, endOffset: payloadEnd + paddingLength };
}

export function decodeRecordFrameHeader(
  header: Uint8Array,
  absoluteOffset = 0,
): ArchiveRecordFrameHeader {
  if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0 || absoluteOffset % 8 !== 0) {
    throw new ArchiveFormatError(
      "record_offset_invalid",
      "Record offset is unaligned or outside the archive.",
    );
  }
  if (header.length < RECORD_HEADER_SIZE || !hasMagic(header, 0, "TXRC")) {
    throw new ArchiveFormatError(
      "record_header_invalid",
      "Record header magic or length is invalid.",
    );
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const type = view.getUint16(4, true);
  const version = view.getUint16(6, true);
  const headerLength = view.getUint32(8, true);
  const payloadLength64 = readLittle(header, 12, 8);
  if (
    version !== 1 ||
    headerLength !== RECORD_HEADER_SIZE ||
    payloadLength64 > MAX_RECORD_PAYLOAD
  ) {
    throw new ArchiveFormatError("record_header_invalid", "Record framing fields are invalid.");
  }
  const payloadLength = Number(payloadLength64);
  const codec = header[52];
  const flags = header[53]!;
  const reserved = view.getUint16(54, true);
  const payloadChecksum = view.getUint32(56, true);
  const headerChecksum = view.getUint32(60, true);
  if (
    reserved !== 0 ||
    (flags & ~1) !== 0 ||
    (codec !== 0 && codec !== 1) ||
    crc32(header.subarray(0, 60)) !== headerChecksum
  ) {
    throw new ArchiveFormatError(
      "record_header_checksum",
      "Record header checksum or codec is invalid.",
    );
  }
  return {
    type,
    id: uuidFromBytes(header.subarray(20, 36)),
    revision: readLittle(header, 36, 8),
    previousOffset: readLittle(header, 44, 8),
    codec: codec as 0 | 1,
    flags,
    payloadLength,
    payloadChecksum,
  };
}

export function decodeStoredPayload(
  frame: Pick<ArchiveRecordFrame, "codec" | "flags" | "storedPayload">,
): Uint8Array {
  if ((frame.flags & 1) !== 0) {
    throw new ArchiveFormatError(
      "archive_locked",
      "This record is encrypted and must be unlocked first.",
    );
  }
  if (frame.codec === 0) return frame.storedPayload;
  return decodeLz4Block(frame.storedPayload);
}

export function decodeLz4Block(storedPayload: Uint8Array): Uint8Array {
  if (storedPayload.length < 8) {
    throw new ArchiveFormatError(
      "record_compression_invalid",
      "Compressed record is missing its decoded length.",
    );
  }
  const decodedLength64 = readLittle(storedPayload, 0, 8);
  if (decodedLength64 > MAX_RECORD_PAYLOAD) {
    throw new ArchiveFormatError(
      "record_payload_limit",
      "Decoded record exceeds the v1 payload limit.",
    );
  }
  const decodedLength = Number(decodedLength64);
  const output = new Uint8Array(decodedLength);
  let sourceOffset = 8;
  let targetOffset = 0;

  const readExtendedLength = (initial: number): number => {
    let length = initial;
    if (initial !== 15) return length;
    for (;;) {
      if (sourceOffset >= storedPayload.length) {
        throw new ArchiveFormatError("record_compression_invalid", "LZ4 length is truncated.");
      }
      const extra = storedPayload[sourceOffset++]!;
      length += extra;
      if (extra !== 255) return length;
    }
  };

  while (sourceOffset < storedPayload.length) {
    const token = storedPayload[sourceOffset++]!;
    const literalLength = readExtendedLength(token >>> 4);
    if (
      literalLength > storedPayload.length - sourceOffset ||
      literalLength > decodedLength - targetOffset
    ) {
      throw new ArchiveFormatError(
        "record_compression_invalid",
        "LZ4 literal run exceeds its block.",
      );
    }
    output.set(storedPayload.subarray(sourceOffset, sourceOffset + literalLength), targetOffset);
    sourceOffset += literalLength;
    targetOffset += literalLength;
    if (sourceOffset === storedPayload.length) break;
    if (sourceOffset + 2 > storedPayload.length) {
      throw new ArchiveFormatError("record_compression_invalid", "LZ4 match offset is truncated.");
    }
    const matchOffset = storedPayload[sourceOffset]! | (storedPayload[sourceOffset + 1]! << 8);
    sourceOffset += 2;
    if (matchOffset === 0 || matchOffset > targetOffset) {
      throw new ArchiveFormatError("record_compression_invalid", "LZ4 match offset is invalid.");
    }
    const matchLength = readExtendedLength(token & 0x0f) + 4;
    if (matchLength > decodedLength - targetOffset) {
      throw new ArchiveFormatError(
        "record_compression_invalid",
        "LZ4 match exceeds its decoded length.",
      );
    }
    for (let index = 0; index < matchLength; index += 1) {
      output[targetOffset + index] = output[targetOffset + index - matchOffset]!;
    }
    targetOffset += matchLength;
  }

  if (targetOffset !== decodedLength) {
    throw new ArchiveFormatError(
      "record_compression_invalid",
      "LZ4 decoded length does not match its header.",
    );
  }
  return output;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

export function recordTypeName(type: RecordTypeValue): string {
  switch (type) {
    case RecordType.student:
      return "student";
    case RecordType.session:
      return "session";
    case RecordType.audioChunk:
      return "audio";
    case RecordType.transcriptSegment:
      return "transcript";
    case RecordType.annotation:
      return "annotation";
    case RecordType.assetMetadata:
      return "asset";
    case RecordType.assetBlob:
      return "asset-blob";
    case RecordType.evidenceNode:
      return "evidence";
    case RecordType.evidenceEdge:
      return "evidence-edge";
    case RecordType.guide:
      return "guide";
    case RecordType.settings:
      return "settings";
    case RecordType.aiJob:
      return "ai-job";
    case RecordType.encryption:
      return "encryption";
    case RecordType.waveformIndex:
      return "waveform-index";
    case RecordType.indexPage:
      return "index";
    case RecordType.commit:
      return "commit";
    default:
      return "unknown";
  }
}
