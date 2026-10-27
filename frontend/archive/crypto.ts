import sodium from "libsodium-wrappers-sumo";
import {
  ArchiveFormatError,
  MAX_RECORD_PAYLOAD,
  RecordType,
  uuidToBytes,
  type ArchiveRecord,
  type RecordTypeValue,
} from "./format";

export interface ArchiveEncryptionEnvelope {
  salt: Uint8Array;
  nonce: Uint8Array;
  wrappedKey: Uint8Array;
  opsLimit: number;
  memoryLimit: number;
}

export interface RecordEncryptionContext {
  archiveId: string;
  type: RecordTypeValue;
  recordId: string;
  revision: bigint;
  previousOffset: bigint;
  codec?: 0 | 1;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const PASSPHRASE_MAX_BYTES = 4096;
const ENVELOPE_SALT_BYTES = 16;
const ENVELOPE_NONCE_BYTES = 24;
const DATA_KEY_BYTES = 32;
const WRAPPED_KEY_BYTES = DATA_KEY_BYTES + 16;
const RECORD_NONCE_BYTES = 24;
const RECORD_TAG_BYTES = 16;
const HMAC_BYTES = 32;
// Matches libsodium's interactive-to-moderate profile bounds used by the C++ archive reader.
const MINIMUM_OPS_LIMIT = 2;
const MAXIMUM_OPS_LIMIT = 3;
const MINIMUM_MEMORY_LIMIT = 64 * 1024 * 1024;
const MAXIMUM_MEMORY_LIMIT = 256 * 1024 * 1024;
const ready = sodium.ready;

function formatError(code: string, message: string): ArchiveFormatError {
  return new ArchiveFormatError(code, message);
}

function ensureBytes(value: Uint8Array, expected: number, field: string): void {
  if (value.byteLength !== expected) {
    throw formatError(
      "archive_encryption_metadata_invalid",
      `Archive encryption metadata contains an invalid ${field} value.`,
    );
  }
}

function encodePassphrase(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  try {
    if (decoder.decode(bytes) !== value) throw new Error("Invalid Unicode");
  } catch {
    sodium.memzero(bytes);
    throw formatError("crypto_input_invalid", "Passphrase must contain valid Unicode text.");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > PASSPHRASE_MAX_BYTES) {
    sodium.memzero(bytes);
    throw formatError(
      "crypto_input_invalid",
      "Passphrase must contain between 1 and 4096 UTF-8 bytes.",
    );
  }
  return bytes;
}

function validateKdfLimits(opsLimit: number, memoryLimit: number): void {
  if (
    !Number.isSafeInteger(opsLimit) ||
    !Number.isSafeInteger(memoryLimit) ||
    opsLimit < MINIMUM_OPS_LIMIT ||
    opsLimit > MAXIMUM_OPS_LIMIT ||
    memoryLimit < MINIMUM_MEMORY_LIMIT ||
    memoryLimit > MAXIMUM_MEMORY_LIMIT
  ) {
    throw formatError(
      "archive_encryption_parameters_invalid",
      "Archive encryption parameters are outside the supported safe range.",
    );
  }
}

function ascii(value: string): Uint8Array {
  return encoder.encode(value);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function putLittleEndian(view: DataView, offset: number, value: bigint, byteLength: 2 | 8): void {
  const maxValue = (1n << BigInt(byteLength * 8)) - 1n;
  if (value < 0n || value > maxValue) {
    throw formatError(
      "record_integer_invalid",
      "Encrypted record metadata is outside the v1 range.",
    );
  }
  if (byteLength === 2) view.setUint16(offset, Number(value), true);
  else view.setBigUint64(offset, value, true);
}

function recordAssociatedData(context: RecordEncryptionContext): Uint8Array {
  const codec = context.codec ?? 0;
  if (!Number.isInteger(context.type) || context.type < 0 || context.type > 0xffff) {
    throw formatError("record_type_invalid", "Record type is outside the v1 range.");
  }
  if (codec !== 0 && codec !== 1) {
    throw formatError("record_codec_invalid", "Record codec is outside the v1 range.");
  }
  const codecLength = codec === 0 ? 0 : 1;
  const associatedData = new Uint8Array(17 + 16 + 2 + 16 + 8 + 8 + codecLength);
  const view = new DataView(associatedData.buffer);
  let offset = 0;
  const label = ascii("TUTORUX-RECORD-V1");
  associatedData.set(label, offset);
  offset += label.byteLength;
  associatedData.set(uuidToBytes(context.archiveId), offset);
  offset += 16;
  putLittleEndian(view, offset, BigInt(context.type), 2);
  offset += 2;
  associatedData.set(uuidToBytes(context.recordId), offset);
  offset += 16;
  putLittleEndian(view, offset, context.revision, 8);
  offset += 8;
  putLittleEndian(view, offset, context.previousOffset, 8);
  offset += 8;
  if (codecLength > 0) associatedData[offset] = codec;
  return associatedData;
}

function keyWrapAssociatedData(archiveId: string): Uint8Array {
  return concatenate([ascii("TUTORUX-ARCHIVE-KEY-V1"), uuidToBytes(archiveId)]);
}

/** Internal worker entry point; callers should use ArchiveDataKey.unwrap instead. */
export async function unwrapArchiveDataKeyBytes(
  passphrase: string,
  envelope: ArchiveEncryptionEnvelope,
  archiveId: string,
): Promise<Uint8Array> {
  await ready;
  ensureBytes(envelope.salt, ENVELOPE_SALT_BYTES, "salt");
  ensureBytes(envelope.nonce, ENVELOPE_NONCE_BYTES, "nonce");
  ensureBytes(envelope.wrappedKey, WRAPPED_KEY_BYTES, "wrapped_key");
  validateKdfLimits(envelope.opsLimit, envelope.memoryLimit);
  const associatedData = keyWrapAssociatedData(archiveId);
  const password = encodePassphrase(passphrase);
  let wrappingKey: Uint8Array | undefined;
  try {
    try {
      wrappingKey = sodium.crypto_pwhash(
        DATA_KEY_BYTES,
        password,
        envelope.salt,
        envelope.opsLimit,
        envelope.memoryLimit,
        sodium.crypto_pwhash_ALG_ARGON2ID13,
      );
    } catch {
      throw formatError(
        "crypto_memory_unavailable",
        "Unable to derive the archive key with the available memory.",
      );
    }
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        envelope.wrappedKey,
        associatedData,
        envelope.nonce,
        wrappingKey,
      );
    } catch {
      throw formatError(
        "archive_passphrase_invalid",
        "Passphrase is incorrect or the key envelope is damaged.",
      );
    }
  } finally {
    sodium.memzero(password);
    if (wrappingKey) sodium.memzero(wrappingKey);
  }
}

async function unwrapArchiveDataKeyInWorker(
  passphrase: string,
  envelope: ArchiveEncryptionEnvelope,
  archiveId: string,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./crypto-worker.ts", import.meta.url), {
      type: "module",
      name: "tutorux-archive-unlock",
    });
    const fail = (error: ArchiveFormatError): void => {
      worker.terminate();
      reject(error);
    };
    worker.onmessage = (event: MessageEvent<CryptoWorkerResponse>): void => {
      const response = event.data;
      worker.terminate();
      if (!response || typeof response !== "object") {
        reject(
          formatError("crypto_worker_failed", "Archive key worker returned an invalid result."),
        );
      } else if (response.success) {
        if (!(response.key instanceof ArrayBuffer) || response.key.byteLength !== DATA_KEY_BYTES) {
          reject(
            formatError("crypto_worker_failed", "Archive key worker returned an invalid key."),
          );
        } else {
          resolve(new Uint8Array(response.key));
        }
      } else {
        reject(formatError(response.code, response.message));
      }
    };
    worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      fail(formatError("crypto_worker_failed", "Unable to derive the archive key in a worker."));
    };
    try {
      worker.postMessage({ passphrase, envelope, archiveId } satisfies CryptoWorkerRequest);
    } catch {
      fail(formatError("crypto_worker_failed", "Unable to start archive key derivation."));
    }
  });
}

interface CryptoWorkerRequest {
  passphrase: string;
  envelope: ArchiveEncryptionEnvelope;
  archiveId: string;
}

type CryptoWorkerResponse =
  { success: true; key: ArrayBuffer } | { success: false; code: string; message: string };

function decodeHex(value: string, field: string, expectedBytes: number): Uint8Array {
  if (!/^(?:[\da-f]{2})*$/iu.test(value) || value.length !== expectedBytes * 2) {
    throw formatError(
      "archive_encryption_metadata_invalid",
      `Archive encryption metadata contains an invalid ${field} value.`,
    );
  }
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseLimit(record: ArchiveRecord, name: string): number {
  const value = record.fields.get(name) ?? "";
  if (value.length > 20 || !/^\d+$/u.test(value)) {
    throw formatError(
      "archive_encryption_metadata_invalid",
      `Archive encryption metadata contains an invalid ${name} value.`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw formatError(
      "archive_encryption_parameters_invalid",
      "Archive encryption parameters are outside the supported safe range.",
    );
  }
  return Number(parsed);
}

export function encryptionEnvelopeFromRecord(
  record: ArchiveRecord,
  archiveId: string,
): ArchiveEncryptionEnvelope {
  if (
    record.type !== RecordType.encryption ||
    record.id.toLowerCase() !== archiveId.toLowerCase() ||
    record.fields.get("encryption_version") !== "1" ||
    record.fields.get("kdf") !== "argon2id13" ||
    record.fields.get("aead") !== "xchacha20-poly1305-ietf"
  ) {
    throw formatError(
      "archive_encryption_metadata_invalid",
      "Archive encryption metadata version or algorithm is unsupported.",
    );
  }
  const envelope: ArchiveEncryptionEnvelope = {
    salt: decodeHex(record.fields.get("salt") ?? "", "salt", ENVELOPE_SALT_BYTES),
    nonce: decodeHex(record.fields.get("nonce") ?? "", "nonce", ENVELOPE_NONCE_BYTES),
    wrappedKey: decodeHex(record.fields.get("wrapped_key") ?? "", "wrapped_key", WRAPPED_KEY_BYTES),
    opsLimit: parseLimit(record, "opslimit"),
    memoryLimit: parseLimit(record, "memlimit"),
  };
  validateKdfLimits(envelope.opsLimit, envelope.memoryLimit);
  return envelope;
}

export function encryptionEnvelopeToRecord(
  envelope: ArchiveEncryptionEnvelope,
  archiveId: string,
): ArchiveRecord {
  ensureBytes(envelope.salt, ENVELOPE_SALT_BYTES, "salt");
  ensureBytes(envelope.nonce, ENVELOPE_NONCE_BYTES, "nonce");
  ensureBytes(envelope.wrappedKey, WRAPPED_KEY_BYTES, "wrapped_key");
  uuidToBytes(archiveId);
  validateKdfLimits(envelope.opsLimit, envelope.memoryLimit);
  return {
    type: RecordType.encryption,
    id: archiveId,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map([
      ["encryption_version", "1"],
      ["kdf", "argon2id13"],
      ["aead", "xchacha20-poly1305-ietf"],
      ["salt", encodeHex(envelope.salt)],
      ["nonce", encodeHex(envelope.nonce)],
      ["wrapped_key", encodeHex(envelope.wrappedKey)],
      ["opslimit", String(envelope.opsLimit)],
      ["memlimit", String(envelope.memoryLimit)],
    ]),
    blob: new Uint8Array(),
  };
}

/** Holds an archive data key and exposes only the operations needed by the v1 format. */
export class ArchiveDataKey {
  #bytes: Uint8Array;
  #disposed = false;

  private constructor(bytes: Uint8Array) {
    ensureBytes(bytes, DATA_KEY_BYTES, "archive data key");
    this.#bytes = bytes;
  }

  static async createRandom(): Promise<ArchiveDataKey> {
    await ready;
    return new ArchiveDataKey(sodium.randombytes_buf(DATA_KEY_BYTES));
  }

  static async unwrap(
    passphrase: string,
    envelope: ArchiveEncryptionEnvelope,
    archiveId: string,
  ): Promise<ArchiveDataKey> {
    const bytes =
      typeof window === "undefined"
        ? await unwrapArchiveDataKeyBytes(passphrase, envelope, archiveId)
        : typeof Worker === "undefined"
          ? (() => {
              throw formatError(
                "crypto_worker_unavailable",
                "Archive key derivation requires Web Worker support in this environment.",
              );
            })()
          : await unwrapArchiveDataKeyInWorker(passphrase, envelope, archiveId);
    return new ArchiveDataKey(bytes);
  }

  async wrap(passphrase: string, archiveId: string): Promise<ArchiveEncryptionEnvelope> {
    await ready;
    this.assertUsable();
    const associatedData = keyWrapAssociatedData(archiveId);
    const password = encodePassphrase(passphrase);
    let wrappingKey: Uint8Array | undefined;
    try {
      if (password.byteLength < 12) {
        throw formatError(
          "archive_passphrase_too_short",
          "Archive passphrases must contain at least 12 bytes.",
        );
      }
      const envelope: ArchiveEncryptionEnvelope = {
        salt: sodium.randombytes_buf(ENVELOPE_SALT_BYTES),
        nonce: sodium.randombytes_buf(ENVELOPE_NONCE_BYTES),
        wrappedKey: new Uint8Array(WRAPPED_KEY_BYTES),
        opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
        memoryLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      };
      try {
        wrappingKey = sodium.crypto_pwhash(
          DATA_KEY_BYTES,
          password,
          envelope.salt,
          envelope.opsLimit,
          envelope.memoryLimit,
          sodium.crypto_pwhash_ALG_ARGON2ID13,
        );
      } catch {
        throw formatError(
          "crypto_memory_unavailable",
          "Unable to derive the archive key with the available memory.",
        );
      }
      try {
        envelope.wrappedKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          this.#bytes,
          associatedData,
          null,
          envelope.nonce,
          wrappingKey,
        );
        if (envelope.wrappedKey.byteLength !== WRAPPED_KEY_BYTES) {
          throw formatError("crypto_key_wrap_failed", "Unable to wrap the archive data key.");
        }
      } catch {
        throw formatError("crypto_key_wrap_failed", "Unable to wrap the archive data key.");
      }
      return envelope;
    } catch (error) {
      if (error instanceof ArchiveFormatError) throw error;
      throw formatError("crypto_key_wrap_failed", "Unable to wrap the archive data key.");
    } finally {
      sodium.memzero(password);
      if (wrappingKey) sodium.memzero(wrappingKey);
    }
  }

  async encryptRecordPayload(
    plaintext: Uint8Array,
    context: RecordEncryptionContext,
  ): Promise<Uint8Array> {
    await ready;
    this.assertUsable();
    if (
      BigInt(plaintext.byteLength) >
      MAX_RECORD_PAYLOAD - BigInt(RECORD_NONCE_BYTES + RECORD_TAG_BYTES)
    ) {
      throw formatError("record_payload_limit", "Encrypted record exceeds the v1 payload limit.");
    }
    const nonce = sodium.randombytes_buf(RECORD_NONCE_BYTES);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      recordAssociatedData(context),
      null,
      nonce,
      this.#bytes,
    );
    return concatenate([nonce, ciphertext]);
  }

  async decryptRecordPayload(
    ciphertext: Uint8Array,
    context: RecordEncryptionContext,
  ): Promise<Uint8Array> {
    await ready;
    this.assertUsable();
    if (BigInt(ciphertext.byteLength) > MAX_RECORD_PAYLOAD) {
      throw formatError("record_payload_limit", "Encrypted record exceeds the v1 payload limit.");
    }
    if (ciphertext.byteLength < RECORD_NONCE_BYTES + RECORD_TAG_BYTES) {
      throw formatError(
        "archive_record_encrypted",
        "Encrypted record is truncated or the archive is locked.",
      );
    }
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        ciphertext.subarray(RECORD_NONCE_BYTES),
        recordAssociatedData(context),
        ciphertext.subarray(0, RECORD_NONCE_BYTES),
        this.#bytes,
      );
    } catch {
      throw formatError(
        "archive_record_authentication_failed",
        "Encrypted record authentication failed; archive metadata may be damaged.",
      );
    }
  }

  async authenticateBytes(label: string, payload: Uint8Array): Promise<Uint8Array> {
    await ready;
    this.assertUsable();
    return sodium.crypto_auth_hmacsha256(concatenate([ascii(label), payload]), this.#bytes);
  }

  async authenticationMatches(
    label: string,
    payload: Uint8Array,
    authentication: Uint8Array,
  ): Promise<boolean> {
    await ready;
    this.assertUsable();
    if (authentication.byteLength !== HMAC_BYTES) return false;
    return sodium.crypto_auth_hmacsha256_verify(
      authentication,
      concatenate([ascii(label), payload]),
      this.#bytes,
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#bytes.fill(0);
    this.#disposed = true;
  }

  private assertUsable(): void {
    if (this.#disposed) {
      throw formatError("archive_key_disposed", "The archive data key has been cleared.");
    }
  }
}
