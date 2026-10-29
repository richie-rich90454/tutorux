import {
  ARCHIVE_HEADER_SIZE,
  CAPABILITY_ENCRYPTED,
  RECORD_HEADER_SIZE,
  decodeArchiveHeader,
  decodeRecordFrame,
  decodeRecordFrameHeader,
  decodeRecordPayload,
  decodeStoredPayload,
  compressRecordPayload,
  encodeRecordFrameHeader,
  encodeArchiveHeader,
  encodeRecordFrame,
  encodeRecordPayload,
  newUuid,
  RecordType,
  recordTypeName,
  type ArchiveHeader,
  type ArchiveRecord,
  type ArchiveRecordFrame,
  type ArchiveRecordFrameHeader,
  type RecordTypeValue,
  ArchiveFormatError,
  crc32,
  crc32Finalize,
  crc32Update,
} from "./format";
import { CompositeArchiveSource, MemoryArchiveSource, type ArchiveByteSource } from "./source";
import type { ArchiveDataKey } from "./crypto";

const LOCATOR_SIZE = 32;
const RECOVERY_WINDOW = 64 * 1024 * 1024;
const METADATA_READ_CHUNK_BYTES = 64 * 1024;
const MAX_INDEX_DEPTH = 32;
const MAX_INDEX_KEY_BYTES = 192;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export interface CommitInfo {
  generation: bigint;
  offset: bigint;
  previousOffset: bigint;
  rootOffset: bigint;
  rootHash: Uint8Array;
  transactionId: string;
  recordCount: bigint;
}

interface IndexEntry {
  key: string;
  valueOffset: bigint;
}

interface IndexPage {
  leaf: boolean;
  entries: IndexEntry[];
  separators: string[];
  children: bigint[];
}

interface CommitCandidate {
  commit: CommitInfo;
  indexEntries: Map<string, bigint>;
}

interface PublishedCommitCandidate extends CommitCandidate {
  publishedEndOffset: bigint;
}

type CompactionFrameInfo = Omit<ArchiveRecordFrame, "storedPayload">;

export interface ArchiveManifest {
  displayName: string;
  description: string;
  createdAtUs: string;
}

export class ArchiveSnapshot {
  readonly encrypted: boolean;
  #dataKey: ArchiveDataKey | undefined;

  get locked(): boolean {
    return this.encrypted && this.#dataKey === undefined;
  }

  get canMutate(): boolean {
    return !this.encrypted || this.#dataKey !== undefined;
  }

  constructor(
    readonly source: ArchiveByteSource,
    readonly header: ArchiveHeader,
    readonly commit: CommitInfo,
    private readonly index: ReadonlyMap<string, bigint>,
    readonly publishedEndOffset = source.size,
    dataKey?: ArchiveDataKey,
  ) {
    this.encrypted = (header.capabilities & CAPABILITY_ENCRYPTED) !== 0n;
    this.#dataKey = dataKey;
  }

  async unlock(passphrase: string): Promise<ArchiveSnapshot> {
    if (!this.encrypted) {
      throw new ArchiveFormatError("archive_not_encrypted", "This archive is not encrypted.");
    }
    if (!this.locked) return this;
    const { ArchiveDataKey, encryptionEnvelopeFromRecord } = await import("./crypto");
    const envelopeRecord = await this.getRecord(RecordType.encryption, this.header.id);
    if (!envelopeRecord) {
      throw new ArchiveFormatError(
        "archive_encryption_metadata_missing",
        "Encrypted archive is missing its key-wrapping metadata.",
      );
    }
    const envelope = encryptionEnvelopeFromRecord(envelopeRecord, this.header.id);
    const dataKey = await ArchiveDataKey.unwrap(passphrase, envelope, this.header.id);
    const unlocked = new ArchiveSnapshot(
      this.source,
      this.header,
      this.commit,
      this.index,
      this.publishedEndOffset,
      dataKey,
    );
    try {
      await unlocked.verifyEncryptionAuthentication();
      return unlocked;
    } catch (error) {
      unlocked.lock();
      throw error;
    }
  }

  /** Re-encrypt every retained revision with a fresh key so earlier envelopes cannot unlock it. */
  async changePassphrase(
    currentPassphrase: string,
    newPassphrase: string,
  ): Promise<ArchiveSnapshot> {
    if (!this.encrypted) {
      throw new ArchiveFormatError("archive_not_encrypted", "This archive is not encrypted.");
    }
    if (!this.#dataKey) {
      throw new ArchiveFormatError(
        "archive_locked",
        "Unlock this archive before changing its passphrase.",
      );
    }
    return rekeyEncryptedArchiveSnapshot(this, currentPassphrase, newPassphrase);
  }

  lock(): void {
    const dataKey = this.#dataKey;
    this.#dataKey = undefined;
    dataKey?.dispose();
  }

  async authenticateEncryptedPayload(label: string, payload: Uint8Array): Promise<Uint8Array> {
    const dataKey = this.#dataKey;
    if (!this.encrypted || !dataKey) {
      throw new ArchiveFormatError(
        "archive_locked",
        "Unlock this archive before authenticating encrypted data.",
      );
    }
    return dataKey.authenticateBytes(label, payload);
  }

  async encodeRecordFrameForAppend(record: ArchiveRecord): Promise<Uint8Array> {
    const dataKey = this.#dataKey;
    if (this.encrypted && !dataKey) {
      throw new ArchiveFormatError("archive_locked", "Unlock this archive before editing it.");
    }
    let recordToWrite = record;
    const isArchiveRecord = record.id.toLowerCase() === this.header.id.toLowerCase();
    const isManifest = record.type === RecordType.settings && isArchiveRecord;
    const isEncryptionMetadata = record.type === RecordType.encryption && isArchiveRecord;
    if (this.encrypted && isManifest) {
      const fields = new Map(record.fields);
      fields.delete("manifest_auth");
      const unsignedPayload = encodeRecordPayload({ ...record, fields });
      const authentication = await dataKey!.authenticateBytes(
        "TUTORUX-MANIFEST-V1",
        unsignedPayload,
      );
      fields.set(
        "manifest_auth",
        Array.from(authentication, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      );
      recordToWrite = { ...record, fields };
    }

    const payload = encodeRecordPayload(recordToWrite);
    const canCompress =
      recordToWrite.type !== RecordType.assetBlob &&
      (recordToWrite.type !== RecordType.audioChunk ||
        recordToWrite.fields.get("codec") === "none");
    const encodedPayload = canCompress
      ? compressRecordPayload(payload)
      : { codec: 0 as const, bytes: payload };
    const protectPayload = this.encrypted && !isManifest && !isEncryptionMetadata;
    const storedPayload = protectPayload
      ? await dataKey!.encryptRecordPayload(encodedPayload.bytes, {
          archiveId: this.header.id,
          type: recordToWrite.type,
          recordId: recordToWrite.id,
          revision: recordToWrite.revision,
          previousOffset: recordToWrite.previousOffset,
          codec: encodedPayload.codec,
        })
      : encodedPayload.bytes;
    return encodeRecordFrame(
      recordToWrite,
      storedPayload,
      encodedPayload.codec,
      protectPayload ? 1 : 0,
    );
  }

  /** Keep the unlocked key private while opening a verified view of another generation. */
  async openGeneration(
    source: ArchiveByteSource,
    commit: CommitInfo,
    index: ReadonlyMap<string, bigint>,
    publishedEndOffset: bigint,
  ): Promise<ArchiveSnapshot> {
    const next = new ArchiveSnapshot(
      source,
      this.header,
      commit,
      index,
      publishedEndOffset,
      this.#dataKey?.clone(),
    );
    try {
      await next.verifyEncryptionAuthentication();
      return next;
    } catch (error) {
      next.lock();
      throw error;
    }
  }

  /** Relocate a protected revision, whose previous offset is part of its authenticated data. */
  async relocateProtectedFrame(
    frame: ArchiveRecordFrame,
    previousOffset: bigint,
  ): Promise<Uint8Array> {
    const key = this.#dataKey;
    if (!key || !this.encrypted || (frame.flags & 1) === 0) {
      throw new ArchiveFormatError(
        "archive_locked",
        "Unlock this archive before relocating encrypted records.",
      );
    }
    const context = {
      archiveId: this.header.id,
      type: frame.type,
      recordId: frame.id,
      revision: frame.revision,
      previousOffset: frame.previousOffset,
      codec: frame.codec,
    };
    const plaintext = await key.decryptRecordPayload(frame.storedPayload, context);
    try {
      const payload = await key.encryptRecordPayload(plaintext, { ...context, previousOffset });
      return encodeRecordFrame(
        { type: frame.type, id: frame.id, revision: frame.revision, previousOffset },
        payload,
        frame.codec,
        frame.flags,
      );
    } finally {
      plaintext.fill(0);
    }
  }

  async openNextGeneration(source: ArchiveByteSource): Promise<ArchiveSnapshot> {
    const opened = await openArchiveSource(source);
    const dataKey = this.#dataKey?.clone();
    const next = new ArchiveSnapshot(
      opened.source,
      opened.header,
      opened.commit,
      new Map(opened.index),
      opened.publishedEndOffset,
      dataKey,
    );
    try {
      if (next.encrypted) await next.verifyEncryptionAuthentication();
      return next;
    } catch (error) {
      next.lock();
      throw error;
    }
  }

  async verifyEncryptionAuthentication(): Promise<void> {
    if (!this.encrypted) return;
    const dataKey = this.#dataKey;
    if (!dataKey) {
      throw new ArchiveFormatError(
        "archive_locked",
        "Unlock this archive before verifying its authentication data.",
      );
    }
    const commitFrame = await readFrameAt(this.source, this.commit.offset);
    const commitPayload = decodeStoredPayload(commitFrame);
    if (
      commitFrame.type !== RecordType.commit ||
      commitFrame.flags !== 0 ||
      commitPayload.byteLength !== 124 ||
      !(await dataKey.authenticationMatches(
        "TUTORUX-COMMIT-V1",
        commitPayload.subarray(0, 92),
        commitPayload.subarray(92),
      ))
    ) {
      throw new ArchiveFormatError(
        "archive_commit_authentication_failed",
        "Encrypted archive commit authentication failed.",
      );
    }
    const rootFrame = await readFrameAt(this.source, this.commit.rootOffset);
    if (
      rootFrame.type !== RecordType.indexPage ||
      !bytesEqual(await sha256(rootFrame.storedPayload), this.commit.rootHash)
    ) {
      throw new ArchiveFormatError(
        "archive_index_authentication_failed",
        "Encrypted archive root index does not match its committed hash.",
      );
    }
    const verifiedIndex = await readIndexTree(this.source, this.commit, rootFrame, true, dataKey);
    if (!indexEntriesMatch(verifiedIndex, this.index)) {
      throw new ArchiveFormatError(
        "archive_index_authentication_failed",
        "Authenticated index does not match the opened archive index.",
      );
    }
    const manifest = await this.getRecord(RecordType.settings, this.header.id);
    if (manifest?.fields.get("record_role") !== "archive-manifest") {
      throw new ArchiveFormatError(
        "archive_manifest_missing",
        "Encrypted archive manifest is missing or invalid.",
      );
    }
  }

  async getManifest(): Promise<ArchiveManifest> {
    const record = await this.getRecord(RecordType.settings, this.header.id);
    if (!isSupportedManifest(record)) {
      throw new ArchiveFormatError(
        "archive_manifest_missing",
        "Archive manifest is missing or invalid.",
      );
    }
    return {
      displayName: record.fields.get("display_name") ?? "Tutorux archive",
      description: record.fields.get("description") ?? "",
      createdAtUs: record.fields.get("created_at_us") ?? this.header.createdAtUs.toString(),
    };
  }

  async getRecord(type: RecordTypeValue, id: string): Promise<ArchiveRecord | null> {
    const canonicalId = id.toLowerCase();
    const offset = this.index.get(primaryIndexKey(type, canonicalId));
    if (offset === undefined) return null;
    const frame = await readFrameAt(this.source, offset);
    if (frame.type !== type || frame.id.toLowerCase() !== canonicalId) {
      throw new ArchiveFormatError(
        "record_index_mismatch",
        "Archive index points to a different record.",
      );
    }
    return this.decodeFrameRecord(frame);
  }

  async getRecordByIndexKey(key: string): Promise<ArchiveRecord | null> {
    const offset = this.index.get(key);
    if (offset === undefined) return null;
    const frame = await readFrameAt(this.source, offset);
    return this.decodeFrameRecord(frame);
  }

  /** Return the latest record revision first, following the on-disk previous-offset chain. */
  async getRecordHistory(type: RecordTypeValue, id: string, limit = 100): Promise<ArchiveRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new ArchiveFormatError(
        "history_limit_invalid",
        "History limit must be between 1 and 10000.",
      );
    }
    const history: ArchiveRecord[] = [];
    let record = await this.getRecord(type, id);
    while (record && history.length < limit) {
      history.push(record);
      if (record.previousOffset === 0n) break;
      record = await this.getRecordAt(record.previousOffset, type, id.toLowerCase());
    }
    return history;
  }

  async listRecords(type: RecordTypeValue, includeDeleted = false): Promise<ArchiveRecord[]> {
    const prefix = `${recordTypeName(type).toUpperCase()}:`;
    const records: ArchiveRecord[] = [];
    for (const [key, offset] of this.index) {
      if (!key.startsWith(prefix) || key.length !== prefix.length + 36) continue;
      const record = await this.getRecordAt(offset, type, key.slice(prefix.length));
      if (includeDeleted || record.fields.get("_deleted") !== "true") records.push(record);
    }
    return records;
  }

  /** Return current fields without retaining binary blobs; compressed records may require transient decoding. */
  async listRecordMetadata(
    type: RecordTypeValue,
    includeDeleted = false,
  ): Promise<ArchiveRecord[]> {
    const prefix = `${recordTypeName(type).toUpperCase()}:`;
    const records: ArchiveRecord[] = [];
    for (const [key, offset] of this.index) {
      if (!key.startsWith(prefix) || key.length !== prefix.length + 36) continue;
      const record = this.encrypted
        ? await this.getRecordAt(offset, type, key.slice(prefix.length))
        : await readRecordMetadataAt(this.source, offset);
      if (record.type !== type || record.id.toLowerCase() !== key.slice(prefix.length)) {
        throw new ArchiveFormatError(
          "record_index_mismatch",
          "Archive index points to a different record.",
        );
      }
      if (includeDeleted || record.fields.get("_deleted") !== "true") {
        records.push(this.encrypted ? { ...record, blob: new Uint8Array() } : record);
      }
    }
    return records;
  }

  /**
   * Read the small metadata portions of one recording track without retaining its PCM blobs.
   * New archives use the session/track index; older archives fall back to the primary audio index.
   */
  async listAudioChunkMetadata(
    sessionId: string,
    trackId: string,
    includeDeleted = false,
  ): Promise<ArchiveRecord[]> {
    const session = sessionId.toLowerCase();
    const track = trackId.toLowerCase();
    if (!validArchiveUuid(session) || !validArchiveUuid(track)) {
      throw new ArchiveFormatError(
        "audio_chunk_identity_invalid",
        "A recording needs a valid session and track identifier.",
      );
    }

    const sessionPrefix = `AUDIOSESSION:${session}:`;
    const trackPrefix = `${sessionPrefix}${track}:`;
    const sessionKeys = [...this.index.keys()].filter((key) => key.startsWith(sessionPrefix));
    const indexedKeys = sessionKeys.length
      ? sessionKeys.filter((key) => key.startsWith(trackPrefix))
      : [...this.index.keys()].filter((key) => key.startsWith("AUDIO:"));
    const chunks: ArchiveRecord[] = [];

    for (const key of indexedKeys.sort()) {
      const offset = this.index.get(key);
      if (offset === undefined) continue;
      const record = this.encrypted
        ? await this.decodeFrameRecord(await readFrameAt(this.source, offset))
        : await readRecordMetadataAt(this.source, offset);
      if (record.type !== RecordType.audioChunk) {
        throw new ArchiveFormatError(
          "audio_chunk_index_invalid",
          "The recording index points to a non-audio record.",
        );
      }
      if (
        record.fields.get("session_id")?.toLowerCase() !== session ||
        record.fields.get("track_id")?.toLowerCase() !== track
      ) {
        if (key.startsWith("AUDIOSESSION:")) {
          throw new ArchiveFormatError(
            "audio_chunk_index_invalid",
            "The recording index points to a different session or track.",
          );
        }
        continue;
      }
      const sequence = record.fields.get("sequence_number") ?? "";
      if (!/^\d+$/u.test(sequence)) {
        throw new ArchiveFormatError(
          "audio_chunk_metadata_invalid",
          "A recording chunk has an invalid sequence number.",
        );
      }
      if (
        key.startsWith("AUDIOSESSION:") &&
        key !== `${trackPrefix}${BigInt(sequence).toString().padStart(20, "0")}`
      ) {
        throw new ArchiveFormatError(
          "audio_chunk_index_invalid",
          "The recording index sequence does not match its chunk.",
        );
      }
      if (includeDeleted || record.fields.get("_deleted") !== "true") chunks.push(record);
    }

    chunks.sort((left, right) => {
      const leftSequence = left.fields.get("sequence_number") ?? "";
      const rightSequence = right.fields.get("sequence_number") ?? "";
      if (!/^\d+$/u.test(leftSequence) || !/^\d+$/u.test(rightSequence)) {
        throw new ArchiveFormatError(
          "audio_chunk_metadata_invalid",
          "A recording chunk has an invalid sequence number.",
        );
      }
      const a = BigInt(leftSequence);
      const b = BigInt(rightSequence);
      return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
    });
    return chunks;
  }

  indexEntryCount(): number {
    return this.index.size;
  }

  audioTrackIdsBySession(): ReadonlyMap<string, readonly string[]> {
    const tracks = new Map<string, Set<string>>();
    for (const key of this.index.keys()) {
      const match = /^AUDIOSESSION:([\da-f-]{36}):([\da-f-]{36}):\d{20}$/iu.exec(key);
      if (!match?.[1] || !match[2]) continue;
      const sessionId = match[1].toLowerCase();
      const trackId = match[2].toLowerCase();
      let sessionTracks = tracks.get(sessionId);
      if (!sessionTracks) {
        sessionTracks = new Set<string>();
        tracks.set(sessionId, sessionTracks);
      }
      sessionTracks.add(trackId);
    }
    return new Map(
      [...tracks.entries()].map(([sessionId, trackIds]) => [sessionId, [...trackIds]] as const),
    );
  }

  allIndexEntries(): ReadonlyMap<string, bigint> {
    return this.index;
  }

  private async getRecordAt(
    offset: bigint,
    expectedType: RecordTypeValue,
    expectedId: string,
  ): Promise<ArchiveRecord> {
    const frame = await readFrameAt(this.source, offset);
    if (frame.type !== expectedType || frame.id.toLowerCase() !== expectedId.toLowerCase()) {
      throw new ArchiveFormatError(
        "record_index_mismatch",
        "Archive index points to a different record.",
      );
    }
    return this.decodeFrameRecord(frame);
  }

  async decodeFramePayload(frame: ArchiveRecordFrame): Promise<Uint8Array> {
    const metadataRecord =
      (frame.type === RecordType.settings || frame.type === RecordType.encryption) &&
      frame.id.toLowerCase() === this.header.id.toLowerCase();
    if ((frame.flags & 1) !== 0) {
      if (!this.encrypted || metadataRecord) {
        throw new ArchiveFormatError(
          "archive_record_encryption_invalid",
          "Archive record encryption flags are inconsistent with its type or header.",
        );
      }
      const dataKey = this.#dataKey;
      if (!dataKey) {
        throw new ArchiveFormatError(
          "archive_locked",
          "Unlock this archive before reading its encrypted records.",
        );
      }
      const decryptedPayload = await dataKey.decryptRecordPayload(frame.storedPayload, {
        archiveId: this.header.id,
        type: frame.type,
        recordId: frame.id,
        revision: frame.revision,
        previousOffset: frame.previousOffset,
        codec: frame.codec,
      });
      return decodeStoredPayload({ ...frame, flags: 0, storedPayload: decryptedPayload });
    }
    if (this.encrypted && !metadataRecord) {
      throw new ArchiveFormatError(
        "archive_record_unencrypted",
        "Encrypted archive contains a plaintext data record.",
      );
    }
    return decodeStoredPayload(frame);
  }

  private async decodeFrameRecord(frame: ArchiveRecordFrame): Promise<ArchiveRecord> {
    const payload = await this.decodeFramePayload(frame);
    const record = decodeRecordPayload(
      frame.type,
      frame.id,
      frame.revision,
      frame.previousOffset,
      payload,
    );
    if (
      this.encrypted &&
      this.#dataKey &&
      frame.type === RecordType.settings &&
      frame.id.toLowerCase() === this.header.id.toLowerCase()
    ) {
      return verifyManifestAuthentication(record, this.#dataKey);
    }
    return record;
  }
}

export interface ArchiveVerificationResult {
  generation: string;
  currentRecords: number;
  liveRecords: number;
  deletedRecords: number;
  indexEntries: number;
}

/** Verify current primary records and framing without parsing opaque forward-compatible payloads. */
export async function verifyArchiveSnapshot(
  snapshot: ArchiveSnapshot,
): Promise<ArchiveVerificationResult> {
  if (snapshot.locked) {
    throw new ArchiveFormatError(
      "archive_locked",
      "Unlock this archive before verifying its records.",
    );
  }
  await snapshot.verifyEncryptionAuthentication();
  const typeNames = new Set(
    Object.values(RecordType).map((type) => recordTypeName(type).toUpperCase()),
  );
  typeNames.add("UNKNOWN");
  let currentRecords = 0;
  let liveRecords = 0;
  let deletedRecords = 0;
  for (const [key, offset] of snapshot.allIndexEntries()) {
    const separator = key.indexOf(":");
    if (separator < 1 || key.indexOf(":", separator + 1) !== -1) continue;
    const typeName = key.slice(0, separator);
    if (!typeNames.has(typeName)) continue;
    const id = key.slice(separator + 1).toLowerCase();
    if (!validArchiveUuid(id)) {
      throw new ArchiveFormatError(
        "record_index_key_invalid",
        "A primary record index key is invalid.",
      );
    }
    const frame = await readFrameAt(snapshot.source, offset);
    if (frame.id.toLowerCase() !== id || recordTypeName(frame.type).toUpperCase() !== typeName) {
      throw new ArchiveFormatError(
        "record_index_mismatch",
        "Archive index points to a different record.",
      );
    }
    currentRecords += 1;
    const payload = await snapshot.decodeFramePayload(frame);
    if (typeName === "UNKNOWN") {
      liveRecords += 1;
      continue;
    }
    const record = decodeRecordPayload(
      frame.type,
      frame.id,
      frame.revision,
      frame.previousOffset,
      payload,
    );
    if (record.fields.get("_deleted") === "true") deletedRecords += 1;
    else liveRecords += 1;
  }
  return {
    generation: snapshot.commit.generation.toString(),
    currentRecords,
    liveRecords,
    deletedRecords,
    indexEntries: snapshot.indexEntryCount(),
  };
}

export interface ArchiveRecoveryResult {
  snapshot: ArchiveSnapshot;
  recoveredGeneration: bigint;
  recoveredGenerations: number;
  discardedTrailingBytes: bigint;
}

/** Recover a consecutive chain of fully verified unpublished generations without changing the source. */
export async function recoverUnpublishedCommit(
  snapshot: ArchiveSnapshot,
): Promise<ArchiveRecoveryResult> {
  if (snapshot.locked) {
    throw new ArchiveFormatError(
      "archive_locked",
      "Unlock this archive before recovering an unpublished generation.",
    );
  }
  if (snapshot.source.size <= snapshot.publishedEndOffset) {
    throw new ArchiveFormatError(
      "archive_recovery_not_available",
      "No uncommitted trailing data follows the latest published generation.",
    );
  }

  let previous = snapshot;
  let recovered: CommitCandidate | null = null;
  let recoveredEnd = snapshot.publishedEndOffset;
  let recoveredGenerations = 0;
  const knownTypes = new Set(
    Object.values(RecordType).map((type) => recordTypeName(type).toUpperCase()),
  );
  knownTypes.add("UNKNOWN");
  try {
    // Limit work on a crafted archive without discarding a valid continuation.
    while (recoveredGenerations < 1024) {
      const candidate = await scanForUnpublishedCommit(previous);
      if (!candidate) break;
      const transactionRecords = new Set<bigint>();
      for (const [key, offset] of candidate.indexEntries) {
        const separator = key.indexOf(":");
        if (separator < 1 || key.indexOf(":", separator + 1) !== -1) continue;
        const typeName = key.slice(0, separator);
        const id = key.slice(separator + 1);
        if (
          knownTypes.has(typeName) &&
          validArchiveUuid(id) &&
          offset >= previous.publishedEndOffset &&
          offset < candidate.commit.offset
        ) {
          transactionRecords.add(offset);
        }
      }
      if (BigInt(transactionRecords.size) !== candidate.commit.recordCount) {
        if (recovered) break;
        throw new ArchiveFormatError(
          "archive_recovery_validation_failed",
          "The unpublished generation record count does not match its current primary index.",
        );
      }

      const commitFrame = await readFrameAt(snapshot.source, candidate.commit.offset);
      const candidateEnd = BigInt(commitFrame.endOffset);
      let next: ArchiveSnapshot | undefined;
      try {
        next = await snapshot.openGeneration(
          snapshot.source,
          candidate.commit,
          candidate.indexEntries,
          candidateEnd,
        );
        await next.getManifest();
        await verifyArchiveSnapshot(next);
      } catch (error) {
        next?.lock();
        if (recovered) break;
        throw error;
      }
      if (previous !== snapshot) previous.lock();
      previous = next;
      recovered = candidate;
      recoveredEnd = candidateEnd;
      recoveredGenerations += 1;
    }
    if (!recovered) {
      throw new ArchiveFormatError(
        "archive_recovery_not_available",
        "No complete unpublished generation follows the latest published generation.",
      );
    }
    // Never silently discard a valid continuation when the safety bound is reached.
    if (recoveredGenerations === 1024 && (await scanForUnpublishedCommit(previous))) {
      throw new ArchiveFormatError(
        "archive_recovery_generation_limit",
        "The unpublished generation chain exceeds the recovery limit.",
      );
    }
    const committedPrefix = new PrefixArchiveSource(snapshot.source, recoveredEnd);
    const recoveredSource = new CompositeArchiveSource(
      committedPrefix,
      new MemoryArchiveSource(encodeLocator(recovered.commit.offset, recovered.commit.generation)),
    );
    const recoveredSnapshot = await snapshot.openGeneration(
      recoveredSource,
      recovered.commit,
      recovered.indexEntries,
      recoveredSource.size,
    );
    return {
      snapshot: recoveredSnapshot,
      recoveredGeneration: recovered.commit.generation,
      recoveredGenerations,
      discardedTrailingBytes: snapshot.source.size - recoveredEnd,
    };
  } finally {
    if (previous !== snapshot) previous.lock();
  }
}

export interface ArchiveCompactionResult {
  snapshot: ArchiveSnapshot;
  originalBytes: bigint;
  compactedBytes: bigint;
  preservedRecords: number;
  prunedAssetRecords: number;
}

export interface ArchiveRepairResult extends ArchiveCompactionResult {
  selectedGeneration: bigint;
  discardedTrailingBytes: bigint;
}

/** Create a compacted copy from the newest generation that passes full record verification. */
export async function repairArchiveSnapshot(
  snapshot: ArchiveSnapshot,
): Promise<ArchiveRepairResult> {
  if (snapshot.locked) {
    throw new ArchiveFormatError("archive_locked", "Unlock this archive before repairing a copy.");
  }

  let commit = snapshot.commit;
  let lastError: unknown;
  const visitedCommits = new Set<bigint>();
  for (let attempt = 0; attempt < 1024 && !visitedCommits.has(commit.offset); attempt += 1) {
    visitedCommits.add(commit.offset);
    let selectedCommit = commit;
    let candidate: CommitCandidate | null = null;
    try {
      candidate = await findConsistentCommit(snapshot.source, snapshot.header, commit);
    } catch (error) {
      lastError = error;
    }
    if (candidate) {
      try {
        const publishedEndOffset = await commitPublishedEndOffset(
          snapshot.source,
          candidate.commit,
        );
        const selected = await snapshot.openGeneration(
          snapshot.source,
          candidate.commit,
          candidate.indexEntries,
          publishedEndOffset,
        );
        try {
          const compacted = await rebuildArchiveSnapshot(selected, true);
          return {
            ...compacted,
            selectedGeneration: candidate.commit.generation,
            discardedTrailingBytes: snapshot.source.size - publishedEndOffset,
          };
        } finally {
          selected.lock();
        }
      } catch (error) {
        lastError = error;
        selectedCommit = candidate.commit;
      }
    }

    if (selectedCommit.previousOffset === 0n) break;
    try {
      const previous = await decodeCommit(snapshot.source, selectedCommit.previousOffset);
      if (previous.generation + 1n !== selectedCommit.generation) {
        throw new ArchiveFormatError(
          "archive_repair_commit_chain_invalid",
          "Previous commit generation is not consecutive.",
        );
      }
      commit = previous;
    } catch (error) {
      lastError = error;
      break;
    }
  }

  throw new ArchiveFormatError(
    "archive_repair_no_verified_generation",
    lastError instanceof Error
      ? `No committed generation passed full verification: ${lastError.message}`
      : "No committed generation passed full verification.",
  );
}

/** Rewrite a verified archive generation while preserving every indexed revision and payload. */
export async function compactArchiveSnapshot(
  snapshot: ArchiveSnapshot,
  options: { pruneUnreferencedAssets?: boolean } = {},
): Promise<ArchiveCompactionResult> {
  return rebuildArchiveSnapshot(snapshot, false, options.pruneUnreferencedAssets ?? false);
}

async function rekeyEncryptedArchiveSnapshot(
  snapshot: ArchiveSnapshot,
  currentPassphrase: string,
  newPassphrase: string,
): Promise<ArchiveSnapshot> {
  if (!snapshot.encrypted || snapshot.locked) {
    throw new ArchiveFormatError(
      snapshot.encrypted ? "archive_locked" : "archive_not_encrypted",
      snapshot.encrypted
        ? "Unlock this archive before changing its passphrase."
        : "This archive is not encrypted.",
    );
  }
  if (snapshot.source.size !== snapshot.publishedEndOffset) {
    throw new ArchiveFormatError(
      "archive_recovery_required",
      "This archive has uncommitted trailing data. Review or recover it before changing its passphrase.",
    );
  }
  if (currentPassphrase === newPassphrase) {
    throw new ArchiveFormatError(
      "archive_passphrase_unchanged",
      "Choose a different new passphrase before changing this archive.",
    );
  }

  const { ArchiveDataKey, encryptionEnvelopeFromRecord, encryptionEnvelopeToRecord } =
    await import("./crypto");
  const archiveId = snapshot.header.id;
  const envelopeKey = primaryIndexKey(RecordType.encryption, archiveId);
  const manifestKey = primaryIndexKey(RecordType.settings, archiveId);
  const previousEnvelopeOffset = snapshot.allIndexEntries().get(envelopeKey);
  const previousManifestOffset = snapshot.allIndexEntries().get(manifestKey);
  if (previousEnvelopeOffset === undefined) {
    throw new ArchiveFormatError(
      "archive_encryption_metadata_missing",
      "Encrypted archive is missing its key-wrapping metadata.",
    );
  }
  if (previousManifestOffset === undefined) {
    throw new ArchiveFormatError(
      "archive_manifest_missing",
      "Encrypted archive manifest is missing.",
    );
  }

  const previousEnvelope = await snapshot.getRecord(RecordType.encryption, archiveId);
  const currentManifest = await snapshot.getRecord(RecordType.settings, archiveId);
  if (!previousEnvelope || !currentManifest) {
    throw new ArchiveFormatError(
      "archive_metadata_missing",
      "Encrypted archive is missing required metadata.",
    );
  }
  const currentEnvelope = encryptionEnvelopeFromRecord(previousEnvelope, archiveId);
  const currentKey = await ArchiveDataKey.unwrap(currentPassphrase, currentEnvelope, archiveId);
  const currentPassphraseSnapshot = new ArchiveSnapshot(
    snapshot.source,
    snapshot.header,
    snapshot.commit,
    new Map(snapshot.allIndexEntries()),
    snapshot.publishedEndOffset,
    currentKey,
  );
  try {
    await currentPassphraseSnapshot.verifyEncryptionAuthentication();
  } finally {
    currentPassphraseSnapshot.lock();
  }
  await verifyArchiveSnapshot(snapshot);
  if (currentManifest.fields.get("record_role") !== "archive-manifest") {
    throw new ArchiveFormatError(
      "archive_manifest_missing",
      "Encrypted archive manifest is invalid.",
    );
  }

  const dataKey = await ArchiveDataKey.createRandom();
  const writer = new ArchiveSnapshot(
    snapshot.source,
    snapshot.header,
    snapshot.commit,
    new Map(snapshot.allIndexEntries()),
    snapshot.publishedEndOffset,
    dataKey.clone(),
  );
  try {
    const envelope = await dataKey.wrap(newPassphrase, archiveId);
    const envelopeRecord = encryptionEnvelopeToRecord(envelope, archiveId);
    const segments: { offset: bigint; bytes: Uint8Array }[] = [];
    let cursor = 0n;
    const addSegment = (bytes: Uint8Array): bigint => {
      const offset = cursor;
      segments.push({ offset, bytes });
      cursor += BigInt(bytes.byteLength);
      return offset;
    };

    addSegment(encodeArchiveHeader(snapshot.header));
    const emptyIndexPayload = encodeIndexPage({
      leaf: true,
      entries: [],
      separators: [],
      children: [],
    });
    const emptyIndexAuthentication = await dataKey.authenticateBytes(
      "TUTORUX-INDEX-PAGE-V1",
      emptyIndexPayload,
    );
    addSegment(
      encodeRecordFrame(
        { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
        concatBytes([emptyIndexPayload, emptyIndexAuthentication]),
      ),
    );

    const newEnvelopeOffset = addSegment(
      await writer.encodeRecordFrameForAppend({
        ...envelopeRecord,
        revision: 1n,
        previousOffset: 0n,
      }),
    );
    const manifestFields = new Map(currentManifest.fields);
    manifestFields.delete("manifest_auth");
    manifestFields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
    const newManifestOffset = addSegment(
      await writer.encodeRecordFrameForAppend({
        ...currentManifest,
        revision: 1n,
        previousOffset: 0n,
        fields: manifestFields,
      }),
    );

    const relocatedOffsets = new Map<bigint, bigint>([
      [previousEnvelopeOffset, newEnvelopeOffset],
      [previousManifestOffset, newManifestOffset],
    ]);
    const primaryEntries: [string, bigint][] = [];
    for (const [key, offset] of snapshot.allIndexEntries()) {
      const separator = key.indexOf(":");
      if (
        separator < 1 ||
        key.indexOf(":", separator + 1) !== -1 ||
        !validArchiveUuid(key.slice(separator + 1))
      ) {
        continue;
      }
      const frame = await readFrameAt(snapshot.source, offset);
      if (key === primaryIndexKey(frame.type, frame.id)) primaryEntries.push([key, offset]);
    }
    primaryEntries.sort(([left], [right]) => compareKeys(left, right));
    let retainedRecordRevisions = 0;

    for (const [key, latestOffset] of primaryEntries) {
      if (key === envelopeKey || key === manifestKey) continue;
      const chain: { oldOffset: bigint; record: ArchiveRecord }[] = [];
      const visited = new Set<bigint>();
      let offset = latestOffset;
      let newer: ArchiveRecord | undefined;
      while (offset !== 0n) {
        if (visited.has(offset)) {
          throw new ArchiveFormatError("revision_cycle", "Record revision chain contains a cycle.");
        }
        visited.add(offset);
        const frame = await readFrameAt(snapshot.source, offset);
        if (key !== primaryIndexKey(frame.type, frame.id)) {
          throw new ArchiveFormatError(
            "record_index_mismatch",
            "Archive primary index points to a different record.",
          );
        }
        if (
          newer &&
          (frame.type !== newer.type ||
            frame.id !== newer.id ||
            frame.revision >= newer.revision ||
            (frame.previousOffset !== 0n && frame.previousOffset >= offset))
        ) {
          throw new ArchiveFormatError(
            "revision_lineage_invalid",
            "Record revision lineage is inconsistent.",
          );
        }
        const payload = await snapshot.decodeFramePayload(frame);
        const record = decodeRecordPayload(
          frame.type,
          frame.id,
          frame.revision,
          frame.previousOffset,
          payload,
        );
        chain.push({ oldOffset: offset, record });
        newer = record;
        offset = frame.previousOffset;
      }

      let previousOffset = 0n;
      for (const revision of chain.reverse()) {
        const newOffset = cursor;
        const frame = await writer.encodeRecordFrameForAppend({
          ...revision.record,
          previousOffset,
        });
        addSegment(frame);
        relocatedOffsets.set(revision.oldOffset, newOffset);
        previousOffset = newOffset;
        retainedRecordRevisions += 1;
      }
    }

    const relocatedIndex = new Map<string, bigint>();
    for (const [key, oldOffset] of snapshot.allIndexEntries()) {
      const newOffset = relocatedOffsets.get(oldOffset);
      if (newOffset === undefined) {
        throw new ArchiveFormatError(
          "archive_compaction_index_unreachable",
          "An index entry points to a revision that cannot be preserved during passphrase change.",
        );
      }
      relocatedIndex.set(key, newOffset);
    }
    const orderedEntries = [...relocatedIndex.entries()]
      .map(([key, valueOffset]) => ({ key, valueOffset }))
      .sort((left, right) => compareKeys(left.key, right.key));
    const tree = await buildIndexTree(orderedEntries, cursor, (payload) =>
      dataKey.authenticateBytes("TUTORUX-INDEX-PAGE-V1", payload),
    );
    for (const frame of tree.frames) addSegment(frame);
    const transactionId = newUuid();
    const commitBody = encodeCommitPayload({
      generation: 1n,
      previousOffset: 0n,
      rootOffset: tree.rootOffset,
      rootHash: await sha256(tree.rootPayload),
      transactionId,
      recordCount: BigInt(retainedRecordRevisions + 2),
    });
    const commitPayload = concatBytes([
      commitBody,
      await dataKey.authenticateBytes("TUTORUX-COMMIT-V1", commitBody),
    ]);
    const commitOffset = cursor;
    addSegment(
      encodeRecordFrame(
        { type: RecordType.commit, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
        commitPayload,
      ),
    );
    addSegment(encodeLocator(commitOffset, 1n));

    const source = new SegmentedArchiveSource(segments, cursor);
    const opened = await openArchiveSource(source);
    const rekeyed = new ArchiveSnapshot(
      source,
      opened.header,
      opened.commit,
      new Map(opened.allIndexEntries()),
      opened.publishedEndOffset,
      dataKey.clone(),
    );
    try {
      await rekeyed.verifyEncryptionAuthentication();
      await verifyArchiveSnapshot(rekeyed);
      for (const [oldOffset, newOffset] of relocatedOffsets) {
        const oldFrame = await readFrameAt(snapshot.source, oldOffset);
        if (
          (oldFrame.type === RecordType.settings || oldFrame.type === RecordType.encryption) &&
          oldFrame.id.toLowerCase() === archiveId.toLowerCase()
        ) {
          continue;
        }
        const newFrame = await readFrameAt(source, newOffset);
        const [oldPayload, newPayload] = await Promise.all([
          snapshot.decodeFramePayload(oldFrame),
          rekeyed.decodeFramePayload(newFrame),
        ]);
        const oldRecord = decodeRecordPayload(
          oldFrame.type,
          oldFrame.id,
          oldFrame.revision,
          oldFrame.previousOffset,
          oldPayload,
        );
        const newRecord = decodeRecordPayload(
          newFrame.type,
          newFrame.id,
          newFrame.revision,
          newFrame.previousOffset,
          newPayload,
        );
        const expectedPreviousOffset =
          oldFrame.previousOffset === 0n ? 0n : relocatedOffsets.get(oldFrame.previousOffset);
        const fieldsMatch =
          oldRecord.fields.size === newRecord.fields.size &&
          [...oldRecord.fields].every(([key, value]) => newRecord.fields.get(key) === value);
        if (
          expectedPreviousOffset === undefined ||
          oldRecord.type !== newRecord.type ||
          oldRecord.id !== newRecord.id ||
          oldRecord.revision !== newRecord.revision ||
          newRecord.previousOffset !== expectedPreviousOffset ||
          !fieldsMatch ||
          !bytesEqual(oldRecord.blob, newRecord.blob)
        ) {
          throw new ArchiveFormatError(
            "archive_rekey_verification_failed",
            "A record revision changed while the encrypted archive was being re-keyed.",
          );
        }
      }
      return rekeyed;
    } catch (error) {
      rekeyed.lock();
      throw error;
    }
  } finally {
    writer.lock();
    dataKey.dispose();
  }
}

async function rebuildArchiveSnapshot(
  snapshot: ArchiveSnapshot,
  allowUnpublishedTail: boolean,
  pruneUnreferencedAssets = false,
): Promise<ArchiveCompactionResult> {
  if (snapshot.locked) {
    throw new ArchiveFormatError("archive_locked", "Unlock this archive before compacting it.");
  }
  if (!allowUnpublishedTail && snapshot.source.size !== snapshot.publishedEndOffset) {
    throw new ArchiveFormatError(
      "archive_recovery_required",
      "This archive has uncommitted trailing data. Review or recover it before compacting it.",
    );
  }

  await snapshot.getManifest();
  await verifyArchiveSnapshot(snapshot);

  const indexed = snapshot.allIndexEntries();
  const primaryEntries: { key: string; offset: bigint }[] = [];
  for (const [key, offset] of indexed) {
    const separator = key.indexOf(":");
    if (separator < 1 || key.indexOf(":", separator + 1) !== -1) continue;
    const id = key.slice(separator + 1).toLowerCase();
    if (!validArchiveUuid(id)) continue;
    const frame = await readFrameAt(snapshot.source, offset);
    if (key === primaryIndexKey(frame.type, frame.id)) primaryEntries.push({ key, offset });
  }
  if (!primaryEntries.length) {
    throw new ArchiveFormatError(
      "archive_compaction_primary_index_missing",
      "The archive has no primary records to compact.",
    );
  }

  const retainedOffsets = new Map<bigint, CompactionFrameInfo>();
  const chains: { key: string; frames: { offset: bigint; frame: CompactionFrameInfo }[] }[] = [];
  for (const entry of primaryEntries.sort((left, right) => compareKeys(left.key, right.key))) {
    const chain: { offset: bigint; frame: CompactionFrameInfo }[] = [];
    let offset = entry.offset;
    let newer: CompactionFrameInfo | undefined;
    const visited = new Set<bigint>();
    while (offset !== 0n) {
      if (visited.has(offset)) {
        throw new ArchiveFormatError("revision_cycle", "Record revision chain contains a cycle.");
      }
      visited.add(offset);
      const existing = retainedOffsets.get(offset);
      let frame = existing;
      if (!frame) {
        const readFrame = await readFrameAt(snapshot.source, offset);
        const payload = await snapshot.decodeFramePayload(readFrame);
        if (recordTypeName(readFrame.type) !== "unknown") {
          decodeRecordPayload(
            readFrame.type,
            readFrame.id,
            readFrame.revision,
            readFrame.previousOffset,
            payload,
          );
        }
        frame = {
          type: readFrame.type,
          id: readFrame.id,
          revision: readFrame.revision,
          previousOffset: readFrame.previousOffset,
          codec: readFrame.codec,
          flags: readFrame.flags,
          payloadLength: readFrame.payloadLength,
          payloadChecksum: readFrame.payloadChecksum,
          endOffset: readFrame.endOffset,
        };
      }
      if (
        newer &&
        (frame.type !== newer.type || frame.id !== newer.id || frame.revision >= newer.revision)
      ) {
        throw new ArchiveFormatError(
          "revision_lineage_invalid",
          "Record revision lineage is inconsistent.",
        );
      }
      if (frame.previousOffset !== 0n && frame.previousOffset >= offset) {
        throw new ArchiveFormatError(
          "revision_lineage_invalid",
          "Record revision points forward in the archive.",
        );
      }
      if (existing && (existing.type !== frame.type || existing.id !== frame.id)) {
        throw new ArchiveFormatError(
          "revision_lineage_invalid",
          "Record revision offset is shared by different records.",
        );
      }
      retainedOffsets.set(offset, frame);
      chain.push({ offset, frame });
      newer = frame;
      offset = frame.previousOffset;
    }
    chains.push({ key: entry.key, frames: chain.reverse() });
  }

  // Unknown record schemas can hold asset references that this version cannot inspect.
  // Refuse pruning in that case; ordinary compaction remains available.
  const removedOffsets = new Set<bigint>();
  let prunedAssetRecords = 0;
  if (pruneUnreferencedAssets) {
    if (chains.some((chain) => recordTypeName(chain.frames[0]!.frame.type) === "unknown")) {
      throw new ArchiveFormatError(
        "archive_pruning_unknown_records",
        "This archive contains records from a newer version. Keep all material data when compacting it.",
      );
    }
    const blobChains = new Map(
      chains
        .filter((chain) => chain.frames[0]!.frame.type === RecordType.assetBlob)
        .map((chain) => [chain.frames[0]!.frame.id.toLowerCase(), chain]),
    );
    const pending: string[] = [];
    const addReference = (value: string, context: string): void => {
      const id = value.toLowerCase();
      if (!validArchiveUuid(id)) {
        throw new ArchiveFormatError(
          "archive_pruning_reference_invalid",
          `${context} contains an invalid material content reference.`,
        );
      }
      pending.push(id);
    };
    const readRevision = async (offset: bigint): Promise<ArchiveRecord> => {
      const frame = await readFrameAt(snapshot.source, offset);
      return decodeRecordPayload(
        frame.type,
        frame.id,
        frame.revision,
        frame.previousOffset,
        await snapshot.decodeFramePayload(frame),
      );
    };
    for (const chain of chains) {
      if (chain.frames[0]!.frame.type !== RecordType.assetMetadata) continue;
      const latest = await readRevision(chain.frames.at(-1)!.offset);
      const role = latest.fields.get("record_role");
      if (role === "audio-track" || role === "recording-take") continue;
      for (const revision of chain.frames) {
        const record = await readRevision(revision.offset);
        addReference(record.fields.get("blob_id") ?? "", "Material metadata");
      }
    }
    const retainedBlobs = new Set<string>();
    for (let index = 0; index < pending.length; index += 1) {
      const id = pending[index]!;
      if (retainedBlobs.has(id)) continue;
      const chain = blobChains.get(id);
      if (!chain)
        throw new ArchiveFormatError(
          "archive_pruning_blob_missing",
          "Material metadata refers to missing content.",
        );
      const latest = await readRevision(chain.frames.at(-1)!.offset);
      if (latest.fields.get("_deleted") === "true") {
        throw new ArchiveFormatError(
          "archive_pruning_blob_missing",
          "Material metadata refers to deleted content.",
        );
      }
      retainedBlobs.add(id);
      for (const revision of chain.frames) {
        const blob = await readRevision(revision.offset);
        if (blob.fields.get("record_role") !== "asset-blob-manifest") continue;
        const ids = blob.fields.get("chunk_ids") ?? "";
        if (ids) for (const chunkId of ids.split(",")) addReference(chunkId, "Material manifest");
      }
    }
    for (let index = chains.length - 1; index >= 0; index -= 1) {
      const chain = chains[index]!;
      const first = chain.frames[0]!.frame;
      if (first.type !== RecordType.assetBlob || retainedBlobs.has(first.id.toLowerCase()))
        continue;
      for (const revision of chain.frames) {
        removedOffsets.add(revision.offset);
        retainedOffsets.delete(revision.offset);
      }
      chains.splice(index, 1);
      prunedAssetRecords += 1;
    }
  }

  const header = encodeArchiveHeader(snapshot.header);
  const emptyRootBody = encodeIndexPage({ leaf: true, entries: [], separators: [], children: [] });
  const emptyRootPayload = snapshot.encrypted
    ? concatBytes([
        emptyRootBody,
        await snapshot.authenticateEncryptedPayload("TUTORUX-INDEX-PAGE-V1", emptyRootBody),
      ])
    : emptyRootBody;
  const emptyRoot = encodeRecordFrame(
    { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
    emptyRootPayload,
  );
  const outputSegments: CompactedArchiveSegment[] = [
    { kind: "static", offset: 0n, bytes: header },
    { kind: "static", offset: BigInt(header.byteLength), bytes: emptyRoot },
  ];
  let cursor = BigInt(header.byteLength + emptyRoot.byteLength);
  const relocatedOffsets = new Map<bigint, bigint>();
  for (const chain of chains) {
    let previousOffset = 0n;
    for (const { offset, frame } of chain.frames) {
      const frameHeader = encodeRecordFrameHeader(
        { ...frame, previousOffset },
        frame.payloadLength,
        frame.codec,
        frame.flags,
        frame.payloadChecksum,
      );
      const frameLength =
        RECORD_HEADER_SIZE + frame.payloadLength + ((8 - (frame.payloadLength % 8)) % 8);
      relocatedOffsets.set(offset, cursor);
      if ((frame.flags & 1) !== 0) {
        const original = await readFrameAt(snapshot.source, offset);
        const relocated = await snapshot.relocateProtectedFrame(original, previousOffset);
        if (relocated.byteLength !== frameLength) {
          throw new ArchiveFormatError(
            "archive_compaction_frame_size_changed",
            "Relocated encrypted record has an unexpected size.",
          );
        }
        outputSegments.push({ kind: "static", offset: cursor, bytes: relocated });
      } else {
        outputSegments.push({
          kind: "frame",
          offset: cursor,
          originalOffset: offset,
          frameLength,
          payloadLength: frame.payloadLength,
          header: frameHeader,
        });
      }
      previousOffset = cursor;
      cursor += BigInt(frameLength);
    }
  }

  const relocatedIndex = new Map<string, bigint>();
  for (const [key, oldOffset] of indexed) {
    if (removedOffsets.has(oldOffset)) continue;
    const newOffset = relocatedOffsets.get(oldOffset);
    if (newOffset === undefined) {
      throw new ArchiveFormatError(
        "archive_compaction_index_unreachable",
        "An index entry points to a record revision that cannot be retained.",
      );
    }
    relocatedIndex.set(key, newOffset);
  }

  const orderedEntries = [...relocatedIndex.entries()]
    .map(([key, valueOffset]) => ({ key, valueOffset }))
    .sort((left, right) => compareKeys(left.key, right.key));
  const tree = await buildIndexTree(
    orderedEntries,
    cursor,
    snapshot.encrypted
      ? (payload) => snapshot.authenticateEncryptedPayload("TUTORUX-INDEX-PAGE-V1", payload)
      : undefined,
  );
  for (const frame of tree.frames) {
    outputSegments.push({ kind: "static", offset: cursor, bytes: frame });
    cursor += BigInt(frame.byteLength);
  }
  const transactionId = newUuid();
  const commitOffset = tree.endOffset;
  const rootHash = await sha256(tree.rootPayload);
  const commitBody = encodeCommitPayload({
    generation: 1n,
    previousOffset: 0n,
    rootOffset: tree.rootOffset,
    rootHash,
    transactionId,
    recordCount: BigInt(retainedOffsets.size),
  });
  const commitPayload = snapshot.encrypted
    ? concatBytes([
        commitBody,
        await snapshot.authenticateEncryptedPayload("TUTORUX-COMMIT-V1", commitBody),
      ])
    : commitBody;
  const commitFrame = encodeRecordFrame(
    { type: RecordType.commit, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
    commitPayload,
  );
  outputSegments.push({ kind: "static", offset: cursor, bytes: commitFrame });
  cursor += BigInt(commitFrame.byteLength);
  const locator = encodeLocator(commitOffset, 1n);
  outputSegments.push({ kind: "static", offset: cursor, bytes: locator });
  cursor += BigInt(locator.byteLength);

  const compactedSource = new CompactedArchiveSource(snapshot.source, outputSegments, cursor);
  const opened = await openArchiveSource(compactedSource);
  const compacted = await snapshot.openGeneration(
    compactedSource,
    opened.commit,
    opened.allIndexEntries(),
    opened.publishedEndOffset,
  );
  try {
    await compacted.getManifest();
    await verifyArchiveSnapshot(compacted);
  } catch (error) {
    compacted.lock();
    throw error;
  }
  return {
    snapshot: compacted,
    originalBytes: snapshot.source.size,
    compactedBytes: compacted.source.size,
    preservedRecords: retainedOffsets.size,
    prunedAssetRecords,
  };
}

export interface ArchiveIndexMigrationResult {
  snapshot: ArchiveSnapshot;
  addedEntries: number;
  conflictingEntries: number;
}

/**
 * Backfill missing secondary indexes for understood records. Existing aliases,
 * including forward-compatible and historical aliases, are preserved.
 */
export async function backfillArchiveSecondaryIndexes(
  snapshot: ArchiveSnapshot,
): Promise<ArchiveIndexMigrationResult> {
  if (snapshot.locked) {
    throw new ArchiveFormatError(
      "archive_locked",
      "Unlock this archive before rebuilding indexes.",
    );
  }
  if (snapshot.source.size !== snapshot.publishedEndOffset) {
    throw new ArchiveFormatError(
      "archive_recovery_required",
      "Review or recover trailing data before rebuilding indexes.",
    );
  }
  await snapshot.getManifest();
  await verifyArchiveSnapshot(snapshot);
  const index = new Map(snapshot.allIndexEntries());
  let addedEntries = 0;
  let conflictingEntries = 0;
  for (const [key, offset] of snapshot.allIndexEntries()) {
    const separator = key.indexOf(":");
    if (
      separator < 1 ||
      key.indexOf(":", separator + 1) !== -1 ||
      !validArchiveUuid(key.slice(separator + 1))
    )
      continue;
    const frame = await readFrameAt(snapshot.source, offset);
    if (recordTypeName(frame.type) === "unknown" || key !== primaryIndexKey(frame.type, frame.id))
      continue;
    const record = await snapshot.getRecord(frame.type, frame.id);
    if (!record)
      throw new ArchiveFormatError(
        "record_index_mismatch",
        "Archive primary index points to a missing record.",
      );
    for (const alias of secondaryIndexKeys(record)) {
      const existing = index.get(alias);
      if (existing === undefined) {
        index.set(alias, offset);
        addedEntries += 1;
      } else if (existing !== offset) {
        // A historical alias or a duplicate may be intentional. Do not guess
        // which record owns it or change behavior for a newer schema.
        conflictingEntries += 1;
      }
    }
  }
  if (addedEntries === 0) return { snapshot, addedEntries, conflictingEntries };

  const entries = [...index.entries()]
    .map(([key, valueOffset]) => ({ key, valueOffset }))
    .sort((left, right) => compareKeys(left.key, right.key));
  const tree = await buildIndexTree(
    entries,
    snapshot.source.size,
    snapshot.encrypted
      ? (payload) => snapshot.authenticateEncryptedPayload("TUTORUX-INDEX-PAGE-V1", payload)
      : undefined,
  );
  const generation = snapshot.commit.generation + 1n;
  const commitBody = encodeCommitPayload({
    generation,
    previousOffset: snapshot.commit.offset,
    rootOffset: tree.rootOffset,
    rootHash: await sha256(tree.rootPayload),
    transactionId: newUuid(),
    recordCount: 0n,
  });
  const commitPayload = snapshot.encrypted
    ? concatBytes([
        commitBody,
        await snapshot.authenticateEncryptedPayload("TUTORUX-COMMIT-V1", commitBody),
      ])
    : commitBody;
  const commit = encodeRecordFrame(
    {
      type: RecordType.commit,
      id: ZERO_UUID,
      revision: generation,
      previousOffset: snapshot.commit.offset,
    },
    commitPayload,
  );
  const tail = concatBytes([...tree.frames, commit, encodeLocator(tree.endOffset, generation)]);
  const source = new CompositeArchiveSource(snapshot.source, new MemoryArchiveSource(tail));
  const migrated = await snapshot.openNextGeneration(source);
  try {
    await verifyArchiveSnapshot(migrated);
    return { snapshot: migrated, addedEntries, conflictingEntries };
  } catch (error) {
    migrated.lock();
    throw error;
  }
}

/** Append a new immutable generation while preserving the original archive bytes. */
export async function appendRecords(
  snapshot: ArchiveSnapshot,
  changes: readonly ArchiveRecord[],
): Promise<ArchiveSnapshot> {
  return appendRecordsCore(snapshot, changes);
}

async function appendRecordsCore(
  snapshot: ArchiveSnapshot,
  changes: readonly ArchiveRecord[],
): Promise<ArchiveSnapshot> {
  if (snapshot.locked) {
    throw new ArchiveFormatError("archive_locked", "Unlock this archive before editing it.");
  }
  if (changes.length === 0) return snapshot;
  if (
    snapshot.encrypted &&
    changes.some(
      (record) =>
        record.type === RecordType.encryption &&
        record.id.toLowerCase() === snapshot.header.id.toLowerCase(),
    )
  ) {
    throw new ArchiveFormatError(
      "archive_passphrase_change_unsupported",
      "Passphrase changes must use the archive re-keying operation so prior key envelopes are removed.",
    );
  }
  if (snapshot.source.size !== snapshot.publishedEndOffset) {
    throw new ArchiveFormatError(
      "archive_recovery_required",
      "This archive has uncommitted trailing data. Review or recover it before making changes.",
    );
  }

  const explicitManifest = changes.find(
    (record) =>
      record.type === RecordType.settings && record.id.toLowerCase() === snapshot.header.id,
  );
  const currentManifest =
    explicitManifest ?? (await snapshot.getRecord(RecordType.settings, snapshot.header.id));
  if (!isSupportedManifest(currentManifest)) {
    throw new ArchiveFormatError(
      "archive_manifest_missing",
      "Archive manifest is missing or invalid.",
    );
  }
  const [students, sessions] = await Promise.all([
    snapshot.listRecords(RecordType.student, true),
    snapshot.listRecords(RecordType.session, true),
  ]);
  const studentById = new Map(students.map((record) => [record.id.toLowerCase(), record]));
  const sessionById = new Map(sessions.map((record) => [record.id.toLowerCase(), record]));
  for (const change of changes) {
    if (change.type === RecordType.student) studentById.set(change.id.toLowerCase(), change);
    if (change.type === RecordType.session) sessionById.set(change.id.toLowerCase(), change);
  }
  const manifestFields = new Map(currentManifest.fields);
  manifestFields.set(
    "student_count",
    String(
      [...studentById.values()].filter((record) => record.fields.get("_deleted") !== "true").length,
    ),
  );
  manifestFields.set(
    "session_count",
    String(
      [...sessionById.values()].filter((record) => record.fields.get("_deleted") !== "true").length,
    ),
  );
  manifestFields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
  const index = new Map(snapshot.allIndexEntries());
  const hasGuideIndexChanges = changes.some(
    (record) => record.type === RecordType.guide || isGuideSourceRecord(record),
  );
  if (hasGuideIndexChanges && manifestFields.get("guide_source_index_version") !== "1") {
    for (const guide of await snapshot.listRecords(RecordType.guide, true)) {
      const guideOffset = index.get(primaryIndexKey(RecordType.guide, guide.id));
      if (guideOffset === undefined) continue;
      for (const alias of secondaryIndexKeys(guide)) {
        if (alias.startsWith("GUIDESOURCE:")) index.set(alias, guideOffset);
      }
    }
    manifestFields.set("guide_source_index_version", "1");
  }
  let writeChanges = changes.some(
    (record) =>
      record.type === RecordType.settings && record.id.toLowerCase() === snapshot.header.id,
  )
    ? changes.map((record) =>
        record.type === RecordType.settings && record.id.toLowerCase() === snapshot.header.id
          ? { ...record, fields: manifestFields }
          : record,
      )
    : [...changes, { ...currentManifest, fields: manifestFields }];

  const changesByKey = new Map<string, ArchiveRecord>();
  for (const record of writeChanges) {
    const key = primaryIndexKey(record.type, record.id);
    if (changesByKey.has(key)) {
      throw new ArchiveFormatError(
        "record_duplicate",
        "A single archive transaction cannot update one record twice.",
      );
    }
    changesByKey.set(key, record);
  }
  for (const [key, record] of changesByKey) {
    if (record.type !== RecordType.guide) continue;
    const previous = await snapshot.getRecord(RecordType.guide, record.id);
    if (!previous) continue;
    changesByKey.set(key, preserveGuideSourceHistory(previous, record, index));
  }

  const staleGuides = new Map<string, ArchiveRecord>();
  const changedGuideSourceIds = new Set(
    changes.filter(isGuideSourceRecord).map((record) => record.id.toLowerCase()),
  );
  for (const sourceId of changedGuideSourceIds) {
    const candidateIds = new Set<string>();
    const prefix = `GUIDESOURCE:${sourceId}:`;
    for (const alias of index.keys()) {
      if (alias.startsWith(prefix)) candidateIds.add(alias.slice(prefix.length));
    }
    for (const record of changesByKey.values()) {
      if (record.type === RecordType.guide && guideCitedSourceIds(record).has(sourceId)) {
        candidateIds.add(record.id.toLowerCase());
      }
    }
    for (const guideId of candidateIds) {
      const key = primaryIndexKey(RecordType.guide, guideId);
      const current =
        staleGuides.get(guideId) ??
        changesByKey.get(key) ??
        (await snapshot.getRecord(RecordType.guide, guideId));
      if (!current || current.fields.get("_deleted") === "true") continue;
      const updated = markGuideBlocksStale(current, sourceId);
      if (updated !== current) {
        staleGuides.set(guideId, preserveGuideSourceHistory(current, updated, index));
      }
    }
  }
  for (const [guideId, guide] of staleGuides) {
    changesByKey.set(primaryIndexKey(RecordType.guide, guideId), guide);
  }
  writeChanges = [...changesByKey.values()];

  const tail: Uint8Array[] = [];
  let cursor = snapshot.source.size;
  const changedKeys = new Set<string>();
  const recordsToVerify: ArchiveRecord[] = [];

  for (const change of writeChanges) {
    if (change.type === RecordType.indexPage || change.type === RecordType.commit) {
      throw new ArchiveFormatError(
        "record_type_invalid",
        "Index and commit records are managed by the archive writer.",
      );
    }
    const key = primaryIndexKey(change.type, change.id);
    if (changedKeys.has(key)) {
      throw new ArchiveFormatError(
        "record_duplicate",
        "A single archive transaction cannot update one record twice.",
      );
    }
    changedKeys.add(key);
    const previous = index.get(key);
    let revision = 1n;
    let previousSecondaryKeys: string[] = [];
    if (previous !== undefined) {
      const previousFrame = await readFrameAt(snapshot.source, previous);
      revision = previousFrame.revision + 1n;
      const previousRecord = await snapshot.getRecord(change.type, change.id);
      if (!previousRecord) {
        throw new ArchiveFormatError(
          "record_index_mismatch",
          "Archive index points to a different record.",
        );
      }
      previousSecondaryKeys = secondaryIndexKeys(previousRecord);
    }
    const record: ArchiveRecord = {
      ...change,
      id: change.id.toLowerCase(),
      revision,
      previousOffset: previous ?? 0n,
    };
    const frame = await snapshot.encodeRecordFrameForAppend(record);
    recordsToVerify.push(record);
    tail.push(frame);
    index.set(key, cursor);
    const nextSecondaryKeys = secondaryIndexKeys(record);
    const nextKeySet = new Set(nextSecondaryKeys);
    for (const previousKey of previousSecondaryKeys) {
      if (
        !nextKeySet.has(previousKey) &&
        !previousKey.startsWith("GUIDESOURCE:") &&
        !previousKey.startsWith("BLOB:") &&
        index.get(previousKey) === previous
      ) {
        index.delete(previousKey);
      }
    }
    const audioIndexKey = nextSecondaryKeys.find((secondaryKey) =>
      secondaryKey.startsWith("AUDIOSESSION:"),
    );
    if (audioIndexKey) {
      const indexedOffset = index.get(audioIndexKey);
      if (indexedOffset !== undefined && indexedOffset !== previous) {
        throw new ArchiveFormatError(
          "audio_chunk_sequence_duplicate",
          "A recording track already contains this chunk sequence number.",
        );
      }
    }
    for (const secondaryKey of nextSecondaryKeys) index.set(secondaryKey, cursor);
    cursor += BigInt(frame.byteLength);
  }

  const orderedEntries = [...index.entries()]
    .map(([key, valueOffset]) => ({ key, valueOffset }))
    .sort((left, right) => compareKeys(left.key, right.key));
  const tree = await buildIndexTree(
    orderedEntries,
    cursor,
    snapshot.encrypted
      ? (payload) => snapshot.authenticateEncryptedPayload("TUTORUX-INDEX-PAGE-V1", payload)
      : undefined,
  );
  tail.push(...tree.frames);
  cursor = tree.endOffset;
  const rootHash = await sha256(tree.rootPayload);
  const transactionId = newUuid();
  const commitOffset = cursor;
  const generation = snapshot.commit.generation + 1n;
  const commitBody = encodeCommitPayload({
    generation,
    previousOffset: snapshot.commit.offset,
    rootOffset: tree.rootOffset,
    rootHash,
    transactionId,
    recordCount: BigInt(writeChanges.length),
  });
  const commitPayload = snapshot.encrypted
    ? concatBytes([
        commitBody,
        await snapshot.authenticateEncryptedPayload("TUTORUX-COMMIT-V1", commitBody),
      ])
    : commitBody;
  const commitFrame = encodeRecordFrame(
    {
      type: RecordType.commit,
      id: ZERO_UUID,
      revision: generation,
      previousOffset: snapshot.commit.offset,
    },
    commitPayload,
  );
  const locator = encodeLocator(commitOffset, generation);
  tail.push(commitFrame, locator);

  const nextSource = new CompositeArchiveSource(
    snapshot.source,
    new MemoryArchiveSource(concatBytes(tail)),
  );
  const next = await snapshot.openNextGeneration(nextSource);
  if (snapshot.encrypted) {
    try {
      for (const record of recordsToVerify) {
        const verified = await next.getRecord(record.type, record.id);
        const isManifest =
          record.type === RecordType.settings && record.id.toLowerCase() === snapshot.header.id;
        const expectedFields = new Map(record.fields);
        if (isManifest) expectedFields.delete("manifest_auth");
        const fieldsMatch =
          verified !== null &&
          verified.fields.size === expectedFields.size &&
          [...expectedFields].every(([name, value]) => verified.fields.get(name) === value);
        if (!verified) {
          throw new ArchiveFormatError(
            "archive_write_verification_failed",
            "The encrypted record could not be read back after writing.",
          );
        }
        if (
          verified.type !== record.type ||
          verified.id !== record.id ||
          verified.revision !== record.revision ||
          verified.previousOffset !== record.previousOffset
        ) {
          throw new ArchiveFormatError(
            "archive_write_verification_failed",
            "Encrypted record metadata changed during write verification.",
          );
        }
        if (!fieldsMatch || !bytesEqual(verified.blob, record.blob)) {
          throw new ArchiveFormatError(
            "archive_write_verification_failed",
            "Encrypted record contents changed during write verification.",
          );
        }
      }
    } catch (error) {
      next.lock();
      throw error;
    }
  }
  return next;
}

export async function createArchiveBytes(
  displayName: string,
  description = "",
  createdAtUs = BigInt(Date.now()) * 1000n,
): Promise<Uint8Array> {
  if (displayName.trim().length === 0) {
    throw new ArchiveFormatError("archive_name_invalid", "Archive name must not be empty.");
  }
  const header: ArchiveHeader = {
    id: newUuid(),
    majorVersion: 1,
    minorVersion: 0,
    createdAtUs,
    capabilities: 0n,
  };
  const encodedHeader = encodeArchiveHeader(header);
  const emptyRootPayload = encodeIndexPage({
    leaf: true,
    entries: [],
    separators: [],
    children: [],
  });
  const emptyRoot = encodeRecordFrame(
    { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
    emptyRootPayload,
  );
  const manifest: ArchiveRecord = {
    type: RecordType.settings,
    id: header.id,
    revision: 1n,
    previousOffset: 0n,
    fields: new Map([
      ["record_role", "archive-manifest"],
      ["display_name", displayName],
      ["description", description],
      ["student_count", "0"],
      ["session_count", "0"],
      ["created_at_us", header.createdAtUs.toString()],
    ]),
    blob: new Uint8Array(),
  };
  const manifestOffset = BigInt(encodedHeader.length + emptyRoot.length);
  const manifestPayload = encodeRecordPayload(manifest);
  const manifestFrame = encodeRecordFrame(manifest, manifestPayload);
  const rootPayload = encodeIndexPage({
    leaf: true,
    entries: [
      { key: primaryIndexKey(RecordType.settings, header.id), valueOffset: manifestOffset },
    ],
    separators: [],
    children: [],
  });
  const rootOffset = manifestOffset + BigInt(manifestFrame.length);
  const rootFrame = encodeRecordFrame(
    { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
    rootPayload,
  );
  const rootHash = await sha256(rootPayload);
  const commitOffset = rootOffset + BigInt(rootFrame.length);
  const transactionId = newUuid();
  const commitPayload = encodeCommitPayload({
    generation: 1n,
    previousOffset: 0n,
    rootOffset,
    rootHash,
    transactionId,
    recordCount: 1n,
  });
  const commitFrame = encodeRecordFrame(
    { type: RecordType.commit, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
    commitPayload,
  );
  const locator = encodeLocator(commitOffset, 1n);
  return concatBytes([encodedHeader, emptyRoot, manifestFrame, rootFrame, commitFrame, locator]);
}

export async function createEncryptedArchiveBytes(
  displayName: string,
  description: string,
  passphrase: string,
  createdAtUs = BigInt(Date.now()) * 1000n,
): Promise<Uint8Array> {
  if (displayName.trim().length === 0) {
    throw new ArchiveFormatError("archive_name_invalid", "Archive name must not be empty.");
  }
  const { ArchiveDataKey, encryptionEnvelopeToRecord } = await import("./crypto");
  const header: ArchiveHeader = {
    id: newUuid(),
    majorVersion: 1,
    minorVersion: 0,
    createdAtUs,
    capabilities: CAPABILITY_ENCRYPTED,
  };
  const encodedHeader = encodeArchiveHeader(header);
  const dataKey = await ArchiveDataKey.createRandom();
  try {
    const envelope = await dataKey.wrap(passphrase, header.id);
    const emptyRootPayload = encodeIndexPage({
      leaf: true,
      entries: [],
      separators: [],
      children: [],
    });
    const emptyRootAuthentication = await dataKey.authenticateBytes(
      "TUTORUX-INDEX-PAGE-V1",
      emptyRootPayload,
    );
    const emptyRoot = encodeRecordFrame(
      { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
      concatBytes([emptyRootPayload, emptyRootAuthentication]),
    );
    const encryptionRecord = encryptionEnvelopeToRecord(envelope, header.id);
    const encryptionPayload = encodeRecordPayload(encryptionRecord);
    const encryptionFrame = encodeRecordFrame(encryptionRecord, encryptionPayload);
    const manifest: ArchiveRecord = {
      type: RecordType.settings,
      id: header.id,
      revision: 1n,
      previousOffset: 0n,
      fields: new Map([
        ["record_role", "archive-manifest"],
        ["display_name", displayName],
        ["description", description],
        ["student_count", "0"],
        ["session_count", "0"],
        ["created_at_us", header.createdAtUs.toString()],
      ]),
      blob: new Uint8Array(),
    };
    const manifestAuthentication = await dataKey.authenticateBytes(
      "TUTORUX-MANIFEST-V1",
      encodeRecordPayload(manifest),
    );
    const manifestFields = new Map(manifest.fields);
    manifestFields.set(
      "manifest_auth",
      Array.from(manifestAuthentication, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    const authenticatedManifest = { ...manifest, fields: manifestFields };
    const manifestFrame = encodeRecordFrame(
      authenticatedManifest,
      encodeRecordPayload(authenticatedManifest),
    );
    const encryptionOffset = BigInt(encodedHeader.length + emptyRoot.length);
    const manifestOffset = encryptionOffset + BigInt(encryptionFrame.length);
    const rootOffset = manifestOffset + BigInt(manifestFrame.length);
    const entries = [
      {
        key: primaryIndexKey(RecordType.encryption, header.id),
        valueOffset: encryptionOffset,
      },
      {
        key: primaryIndexKey(RecordType.settings, header.id),
        valueOffset: manifestOffset,
      },
    ].sort((left, right) => compareKeys(left.key, right.key));
    const tree = await buildIndexTree(entries, rootOffset, (payload) =>
      dataKey.authenticateBytes("TUTORUX-INDEX-PAGE-V1", payload),
    );
    const transactionId = newUuid();
    const commitBody = encodeCommitPayload({
      generation: 1n,
      previousOffset: 0n,
      rootOffset: tree.rootOffset,
      rootHash: await sha256(tree.rootPayload),
      transactionId,
      recordCount: 2n,
    });
    const commitPayload = concatBytes([
      commitBody,
      await dataKey.authenticateBytes("TUTORUX-COMMIT-V1", commitBody),
    ]);
    const commitOffset = tree.endOffset;
    const commitFrame = encodeRecordFrame(
      { type: RecordType.commit, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
      commitPayload,
    );
    return concatBytes([
      encodedHeader,
      emptyRoot,
      encryptionFrame,
      manifestFrame,
      ...tree.frames,
      commitFrame,
      encodeLocator(commitOffset, 1n),
    ]);
  } finally {
    dataKey.dispose();
  }
}

/**
 * Reconstruct only the header checksum in a read-only view. The source remains
 * untouched; callers must save a separate copy after reviewing the result.
 */
export async function recoverChecksumDamagedArchiveHeader(
  source: ArchiveByteSource,
  passphrase?: string,
): Promise<ArchiveSnapshot> {
  if (source.size < BigInt(ARCHIVE_HEADER_SIZE)) {
    throw new ArchiveFormatError(
      "archive_header_recovery_unavailable",
      "A complete archive header is required for checksum repair.",
    );
  }
  const original = await source.read(0n, ARCHIVE_HEADER_SIZE);
  if (original.byteLength !== ARCHIVE_HEADER_SIZE) {
    throw new ArchiveFormatError(
      "archive_header_recovery_unavailable",
      "The archive header could not be read completely.",
    );
  }
  const corrected = original.slice();
  const checksum = crc32(corrected.subarray(0, 60));
  const view = new DataView(corrected.buffer, corrected.byteOffset, corrected.byteLength);
  if (view.getUint32(60, true) === checksum) {
    throw new ArchiveFormatError(
      "archive_header_recovery_unavailable",
      "The header checksum is valid; checksum repair is not applicable.",
    );
  }
  view.setUint32(60, checksum, true);
  const header = decodeArchiveHeader(corrected);
  const repairedSource = new CompositeArchiveSource(
    new MemoryArchiveSource(corrected),
    new ArchiveSuffixSource(source, BigInt(ARCHIVE_HEADER_SIZE)),
  );
  let opened = await openArchiveSource(repairedSource);
  try {
    if (opened.encrypted) {
      if (passphrase === undefined) {
        throw new ArchiveFormatError(
          "archive_locked",
          "Provide the passphrase to verify a repaired encrypted header.",
        );
      }
      opened = await opened.unlock(passphrase);
    }
    await verifyArchiveSnapshot(opened);
    const manifest = await opened.getRecord(RecordType.settings, header.id);
    if (
      !manifest ||
      manifest.fields.get("_deleted") === "true" ||
      manifest.fields.get("record_role") !== "archive-manifest" ||
      manifest.fields.get("created_at_us") !== header.createdAtUs.toString()
    ) {
      throw new ArchiveFormatError(
        "archive_header_recovery_unverified",
        "The header identity and creation time do not match the verified archive manifest.",
      );
    }
    return opened;
  } catch (error) {
    opened.lock();
    throw error;
  }
}

/** A borrowed suffix view that does not take ownership of the source. */
class ArchiveSuffixSource implements ArchiveByteSource {
  readonly size: bigint;
  constructor(
    private readonly source: ArchiveByteSource,
    private readonly start: bigint,
  ) {
    this.size = source.size - start;
  }
  async read(offset: bigint, length: number): Promise<Uint8Array> {
    if (
      offset < 0n ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset + BigInt(length) > this.size
    ) {
      throw new RangeError("Archive read is outside the source bounds.");
    }
    return this.source.read(this.start + offset, length);
  }
}

export async function openArchiveBytes(bytes: Uint8Array): Promise<ArchiveSnapshot> {
  return openArchiveSource(new MemoryArchiveSource(bytes));
}

export async function openArchiveSource(source: ArchiveByteSource): Promise<ArchiveSnapshot> {
  if (source.size < BigInt(ARCHIVE_HEADER_SIZE)) {
    throw new ArchiveFormatError("archive_truncated", "Archive header is truncated.");
  }
  const headerBytes = await source.read(0n, ARCHIVE_HEADER_SIZE);
  const header = decodeArchiveHeader(headerBytes);
  const recentStart =
    source.size > BigInt(RECOVERY_WINDOW + ARCHIVE_HEADER_SIZE)
      ? source.size - BigInt(RECOVERY_WINDOW)
      : BigInt(ARCHIVE_HEADER_SIZE);
  let candidate = await scanForCommittedRoot(source, recentStart, header);
  if (!candidate && recentStart !== BigInt(ARCHIVE_HEADER_SIZE)) {
    candidate = await scanForCommittedRoot(source, BigInt(ARCHIVE_HEADER_SIZE), header);
  }
  if (!candidate) {
    throw new ArchiveFormatError(
      "archive_commit_missing",
      "No valid committed archive generation was found.",
    );
  }
  return new ArchiveSnapshot(
    source,
    header,
    candidate.commit,
    candidate.indexEntries,
    candidate.publishedEndOffset,
  );
}

function primaryIndexKey(type: RecordTypeValue, id: string): string {
  return `${recordTypeName(type).toUpperCase()}:${id.toLowerCase()}`;
}

function isGuideSourceType(type: RecordTypeValue): boolean {
  return (
    type === RecordType.student ||
    type === RecordType.session ||
    type === RecordType.transcriptSegment ||
    type === RecordType.annotation ||
    type === RecordType.assetMetadata ||
    type === RecordType.evidenceNode
  );
}

function isGuideSourceRecord(record: ArchiveRecord): boolean {
  return (
    isGuideSourceType(record.type) ||
    (record.type === RecordType.settings && record.fields.get("record_role") === "journal-notes")
  );
}

function guideSourceIds(record: ArchiveRecord): Set<string> {
  const ids = guideCitedSourceIds(record);
  for (const id of (record.fields.get("source_index_history") ?? "").split(",")) {
    const normalized = id.trim().toLowerCase();
    if (validArchiveUuid(normalized)) ids.add(normalized);
  }
  return ids;
}

function preserveGuideSourceHistory(
  previous: ArchiveRecord,
  current: ArchiveRecord,
  index: ReadonlyMap<string, bigint>,
): ArchiveRecord {
  const history = new Set([...guideSourceIds(previous), ...guideSourceIds(current)]);
  const suffix = `:${current.id.toLowerCase()}`;
  for (const alias of index.keys()) {
    if (!alias.startsWith("GUIDESOURCE:") || !alias.endsWith(suffix)) continue;
    const sourceId = alias.slice("GUIDESOURCE:".length, -suffix.length);
    if (validArchiveUuid(sourceId)) history.add(sourceId);
  }
  if (!history.size) return current;
  const value = [...history].sort().join(",");
  if (current.fields.get("source_index_history") === value) return current;
  const fields = new Map(current.fields);
  fields.set("source_index_history", value);
  return { ...current, fields };
}

function guideCitedSourceIds(record: ArchiveRecord): Set<string> {
  const ids = new Set<string>();
  for (const [key, value] of record.fields) {
    if (key.startsWith("section.") && key.endsWith(".source_ids")) {
      for (const id of value.split(",")) {
        const normalized = id.trim().toLowerCase();
        if (validArchiveUuid(normalized)) ids.add(normalized);
      }
    }
  }
  return ids;
}

function markGuideBlocksStale(record: ArchiveRecord, sourceId: string): ArchiveRecord {
  const fields = new Map(record.fields);
  let changed = false;
  for (const [key, value] of fields) {
    if (!key.startsWith("section.") || !key.endsWith(".source_ids")) continue;
    if (!value.split(",").some((id) => id.trim().toLowerCase() === sourceId)) continue;
    const staleKey = `${key.slice(0, -"source_ids".length)}stale`;
    if (fields.get(staleKey) === "true") continue;
    fields.set(staleKey, "true");
    changed = true;
  }
  if (!changed) return record;
  let staleBlockCount = 0;
  for (const [key, value] of fields) {
    if (key.startsWith("section.") && key.endsWith(".stale") && value === "true") {
      staleBlockCount += 1;
    }
  }
  const timestamp = (BigInt(Date.now()) * 1000n).toString();
  fields.set("stale_sources_updated_at_us", timestamp);
  fields.set("stale_source_id", sourceId);
  fields.set("stale_block_count", staleBlockCount.toString());
  return { ...record, fields };
}

function validArchiveUuid(value: string): boolean {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(value);
}

function isSupportedManifest(record: ArchiveRecord | null): record is ArchiveRecord {
  if (record?.fields.get("record_role") === "archive-manifest") return true;
  return (
    record?.fields.get("record_role") === "tutorux-session-package" &&
    record.fields.get("package_version") === "1" &&
    validArchiveUuid(record.fields.get("source_session_id") ?? "")
  );
}

function secondaryIndexKeys(record: ArchiveRecord): string[] {
  const fields = record.fields;
  const keys = new Set<string>();
  const sessionId = fields.get("session_id") ?? "";
  const validUuid = (value: string): boolean =>
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value);
  const add = (prefix: string, id: string): void => {
    if (validUuid(id)) keys.add(`${prefix}${id.toLowerCase()}:${record.id.toLowerCase()}`);
  };

  if (record.type === RecordType.assetBlob) {
    const contentHash = fields.get("content_hash");
    if (contentHash && !/^[\da-f]{64}$/iu.test(contentHash)) {
      throw new ArchiveFormatError("asset_hash_invalid", "Asset blob content hash is invalid.");
    }
    if (contentHash) keys.add(`BLOB:${contentHash.toLowerCase()}`);
  }
  if (record.type === RecordType.annotation && validUuid(sessionId)) {
    const startTime = fields.get("start_time_us") ?? "";
    if (/^\d+$/u.test(startTime)) {
      const timestamp = BigInt(startTime);
      if (timestamp <= 9_223_372_036_854_775_807n) {
        keys.add(
          `ANNOTATIONSESSION:${sessionId.toLowerCase()}:${startTime.padStart(20, "0")}:${record.id.toLowerCase()}`,
        );
      }
    }
  }
  if (record.type === RecordType.session) {
    const studentId = fields.get("student_id") ?? "";
    if (studentId && studentId !== "anonymous") add("STUDENTSESSION:", studentId);
  }
  if (record.type === RecordType.transcriptSegment) add("TRANSCRIPTSESSION:", sessionId);
  if (record.type === RecordType.evidenceEdge) {
    add("EVIDENCEADJ:", fields.get("from_id") ?? "");
    add("EVIDENCEADJ:", fields.get("to_id") ?? "");
  }
  if (record.type === RecordType.audioChunk) {
    const trackId = fields.get("track_id") ?? "";
    const sequence = fields.get("sequence_number") ?? "";
    if (!validUuid(sessionId) || !validUuid(trackId) || !/^\d+$/u.test(sequence)) {
      throw new ArchiveFormatError(
        "audio_chunk_metadata_invalid",
        "Audio chunks require valid session, track, and sequence identifiers.",
      );
    }
    const sequenceNumber = BigInt(sequence);
    if (sequenceNumber > 18_446_744_073_709_551_615n) {
      throw new ArchiveFormatError(
        "audio_chunk_metadata_invalid",
        "Audio chunk sequence exceeds the supported range.",
      );
    }
    keys.add(
      `AUDIOSESSION:${sessionId.toLowerCase()}:${trackId.toLowerCase()}:${sequenceNumber.toString().padStart(20, "0")}`,
    );
  }
  if (record.type === RecordType.guide) {
    const addSources = (value: string): void => {
      for (const sourceId of value.split(",")) {
        if (validUuid(sourceId))
          keys.add(`GUIDESOURCE:${sourceId.toLowerCase()}:${record.id.toLowerCase()}`);
      }
    };
    for (const [field, value] of fields) {
      if (field.startsWith("section.") && field.endsWith(".source_ids")) addSources(value);
    }
    addSources(fields.get("source_index_history") ?? "");
  }
  return [...keys];
}

async function scanForCommittedRoot(
  source: ArchiveByteSource,
  searchStart: bigint,
  header: ArchiveHeader,
): Promise<PublishedCommitCandidate | null> {
  const chunkSize = 64 * 1024;
  let chunkEnd = source.size;
  while (chunkEnd > searchStart) {
    const chunkStart =
      chunkEnd - searchStart > BigInt(chunkSize) ? chunkEnd - BigInt(chunkSize) : searchStart;
    const readStart =
      chunkStart - searchStart > BigInt(LOCATOR_SIZE - 1)
        ? chunkStart - BigInt(LOCATOR_SIZE - 1)
        : searchStart;
    const bytes = await source.read(readStart, Number(chunkEnd - readStart));
    for (let index = bytes.length - LOCATOR_SIZE; index >= 0; index -= 1) {
      const candidateOffset = readStart + BigInt(index);
      if (candidateOffset < chunkStart || !hasMagic(bytes, index, "TUXLOC1\0")) continue;
      const locator = bytes.subarray(index, index + LOCATOR_SIZE);
      if (!validLocator(locator)) continue;
      const commitOffset = readLittle(locator, 8, 8);
      const generation = readLittle(locator, 16, 8);
      if (commitOffset < BigInt(ARCHIVE_HEADER_SIZE) || commitOffset >= candidateOffset) continue;
      try {
        const commit = await decodeCommit(source, commitOffset);
        if (commit.generation !== generation) continue;
        const consistent = await findConsistentCommit(source, header, commit);
        if (consistent?.commit.offset === commit.offset) {
          return {
            ...consistent,
            publishedEndOffset: candidateOffset + BigInt(LOCATOR_SIZE),
          };
        }
      } catch {
        continue;
      }
    }
    chunkEnd = chunkStart;
  }
  return null;
}

async function scanForUnpublishedCommit(
  snapshot: ArchiveSnapshot,
): Promise<CommitCandidate | null> {
  const source = snapshot.source;
  const searchStart = snapshot.publishedEndOffset;
  const chunkSize = 64 * 1024;
  let chunkEnd = source.size;
  while (chunkEnd > searchStart) {
    const chunkStart =
      chunkEnd - searchStart > BigInt(chunkSize) ? chunkEnd - BigInt(chunkSize) : searchStart;
    const readStart =
      chunkStart - searchStart > BigInt(RECORD_HEADER_SIZE - 1)
        ? chunkStart - BigInt(RECORD_HEADER_SIZE - 1)
        : searchStart;
    const bytes = await source.read(readStart, Number(chunkEnd - readStart));
    let index = bytes.length - RECORD_HEADER_SIZE;
    while (index >= 0 && (readStart + BigInt(index)) % 8n !== 0n) index -= 1;
    for (; index >= 0; index -= 8) {
      const candidateOffset = readStart + BigInt(index);
      if (candidateOffset < chunkStart) break;
      if (!hasMagic(bytes, index, "TXRC")) continue;
      try {
        const frame = await readFrameAt(source, candidateOffset);
        if (frame.type !== RecordType.commit) continue;
        const commit = await decodeCommit(source, candidateOffset);
        if (
          commit.previousOffset !== snapshot.commit.offset ||
          commit.generation !== snapshot.commit.generation + 1n
        ) {
          continue;
        }
        const consistent = await findConsistentCommit(source, snapshot.header, commit);
        if (consistent?.commit.offset === commit.offset) return consistent;
      } catch {
        continue;
      }
    }
    chunkEnd = chunkStart;
  }
  return null;
}

async function findConsistentCommit(
  source: ArchiveByteSource,
  header: ArchiveHeader,
  first: CommitInfo,
): Promise<CommitCandidate | null> {
  let commit: CommitInfo | null = first;
  for (let attempt = 0; attempt < 1024 && commit; attempt += 1) {
    const current: CommitInfo = commit;
    try {
      const chainIsValid = await validCommitChainLink(source, current);
      if (!chainIsValid) {
        commit =
          current.previousOffset === 0n ? null : await decodeCommit(source, current.previousOffset);
        continue;
      }
      const root = await readFrameAt(source, current.rootOffset);
      if (
        root.type !== RecordType.indexPage ||
        !bytesEqual(await sha256(root.storedPayload), current.rootHash)
      ) {
        commit =
          current.previousOffset === 0n ? null : await decodeCommit(source, current.previousOffset);
        continue;
      }
      const encrypted = (header.capabilities & CAPABILITY_ENCRYPTED) !== 0n;
      const indexEntries = await readIndexTree(source, current, root, encrypted);
      return { commit: current, indexEntries };
    } catch {
      if (current.previousOffset === 0n) return null;
      try {
        commit = await decodeCommit(source, current.previousOffset);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function validCommitChainLink(
  source: ArchiveByteSource,
  commit: CommitInfo,
): Promise<boolean> {
  if (commit.previousOffset === 0n) return commit.generation === 1n;
  const previous = await decodeCommit(source, commit.previousOffset);
  return previous.generation + 1n === commit.generation;
}

async function decodeCommit(source: ArchiveByteSource, offset: bigint): Promise<CommitInfo> {
  const frame = await readFrameAt(source, offset);
  const payload = decodeStoredPayload(frame);
  if (
    frame.type !== RecordType.commit ||
    frame.id !== ZERO_UUID ||
    (payload.length !== 92 && payload.length !== 124) ||
    !hasMagic(payload, 0, "TXCM")
  ) {
    throw new ArchiveFormatError("commit_invalid", "Commit record has an invalid structure.");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint16(4, true);
  const reserved = view.getUint16(6, true);
  const generation = readLittle(payload, 8, 8);
  const previousOffset = readLittle(payload, 16, 8);
  const rootOffset = readLittle(payload, 24, 8);
  const rootHash = payload.slice(32, 64);
  const transactionId = bytesUuid(payload.subarray(64, 80));
  const recordCount = readLittle(payload, 80, 8);
  const archiveVersion = view.getUint32(88, true);
  if (
    version !== 1 ||
    reserved !== 0 ||
    generation === 0n ||
    archiveVersion !== 1 ||
    frame.revision !== generation ||
    frame.previousOffset !== previousOffset ||
    rootOffset < BigInt(ARCHIVE_HEADER_SIZE) ||
    rootOffset >= offset ||
    previousOffset >= offset
  ) {
    throw new ArchiveFormatError("commit_invalid", "Commit metadata is invalid.");
  }
  return {
    generation,
    offset,
    previousOffset,
    rootOffset,
    rootHash,
    transactionId,
    recordCount,
  };
}

async function readIndexTree(
  source: ArchiveByteSource,
  commit: CommitInfo,
  rootFrame: ArchiveRecordFrame,
  encrypted: boolean,
  dataKey?: ArchiveDataKey,
): Promise<Map<string, bigint>> {
  const entries = new Map<string, bigint>();
  const visited = new Set<string>();
  const visit = async (
    offset: bigint,
    frame: ArchiveRecordFrame,
    depth: number,
    isRoot: boolean,
  ): Promise<{ first: string | null; last: string | null }> => {
    if (depth > MAX_INDEX_DEPTH || visited.has(offset.toString())) {
      throw new ArchiveFormatError("index_cycle", "B+ tree contains a cycle or excessive depth.");
    }
    if (offset >= commit.offset) {
      throw new ArchiveFormatError(
        "index_page_invalid",
        "Index page is outside the committed archive region.",
      );
    }
    visited.add(offset.toString());
    let payload = decodeStoredPayload(frame);
    if (encrypted) {
      if (payload.length < 32) {
        throw new ArchiveFormatError(
          "archive_index_authentication_failed",
          "Encrypted index page is truncated.",
        );
      }
      const authenticatedLength = payload.length - 32;
      if (
        dataKey &&
        !(await dataKey.authenticationMatches(
          "TUTORUX-INDEX-PAGE-V1",
          payload.subarray(0, authenticatedLength),
          payload.subarray(authenticatedLength),
        ))
      ) {
        throw new ArchiveFormatError(
          "archive_index_authentication_failed",
          "Encrypted archive index authentication failed.",
        );
      }
      payload = payload.subarray(0, authenticatedLength);
    }
    const page = decodeIndexPage(payload);
    if (page.leaf) {
      if (!isRoot && page.entries.length === 0) {
        throw new ArchiveFormatError(
          "index_page_invalid",
          "A non-root leaf index page cannot be empty.",
        );
      }
      for (const entry of page.entries) {
        if (
          entry.valueOffset < BigInt(ARCHIVE_HEADER_SIZE) ||
          entry.valueOffset >= commit.offset ||
          entry.valueOffset % 8n !== 0n
        ) {
          throw new ArchiveFormatError("index_page_invalid", "Leaf record offset is invalid.");
        }
        if (entries.has(entry.key)) {
          throw new ArchiveFormatError("index_page_order", "Index keys are not globally unique.");
        }
        entries.set(entry.key, entry.valueOffset);
      }
      return {
        first: page.entries[0]?.key ?? null,
        last: page.entries.at(-1)?.key ?? null,
      };
    }
    if (page.children.length !== page.separators.length + 1 || page.separators.length === 0) {
      throw new ArchiveFormatError(
        "index_page_invalid",
        "Internal index page has invalid children.",
      );
    }
    let first: string | null = null;
    let previousLast: string | null = null;
    for (let index = 0; index < page.children.length; index += 1) {
      const childOffset = page.children[index]!;
      const childFrame = await readFrameAt(source, childOffset);
      if (childFrame.type !== RecordType.indexPage) {
        throw new ArchiveFormatError(
          "index_page_invalid",
          "Internal page points to a non-index record.",
        );
      }
      const range = await visit(childOffset, childFrame, depth + 1, false);
      if (index === 0) first = range.first;
      if (index > 0) {
        const separator = page.separators[index - 1]!;
        if (
          range.first !== separator ||
          previousLast === null ||
          compareKeys(previousLast, separator) >= 0
        ) {
          throw new ArchiveFormatError(
            "index_page_order",
            "Internal separators do not match child key ranges.",
          );
        }
      }
      if (range.last !== null) previousLast = range.last;
    }
    return { first, last: previousLast };
  };

  await visit(commit.rootOffset, rootFrame, 0, true);
  return entries;
}

function decodeIndexPage(payload: Uint8Array): IndexPage {
  if (payload.length < 10 || !hasMagic(payload, 0, "TXPG")) {
    throw new ArchiveFormatError("index_page_invalid", "Index page magic or length is invalid.");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint16(4, true);
  const kind = payload[6]!;
  const reserved = payload[7]!;
  const count = view.getUint16(8, true);
  if (version !== 1 || kind > 1 || reserved !== 0) {
    throw new ArchiveFormatError("index_page_invalid", "Index page fields are invalid.");
  }
  let cursor = 10;
  const page: IndexPage = { leaf: kind === 0, entries: [], separators: [], children: [] };
  const readKey = (): string => {
    if (cursor + 2 > payload.length) {
      throw new ArchiveFormatError("archive_truncated", "Index key length is truncated.");
    }
    const keyLength = view.getUint16(cursor, true);
    cursor += 2;
    if (keyLength === 0 || keyLength > MAX_INDEX_KEY_BYTES || cursor + keyLength > payload.length) {
      throw new ArchiveFormatError("index_page_invalid", "Index key is invalid.");
    }
    let key: string;
    try {
      key = decoder.decode(payload.subarray(cursor, cursor + keyLength));
    } catch {
      throw new ArchiveFormatError("index_page_invalid", "Index key is not valid UTF-8.");
    }
    cursor += keyLength;
    return key;
  };
  const readOffset = (): bigint => {
    const offset = readLittle(payload, cursor, 8);
    cursor += 8;
    if (offset < BigInt(ARCHIVE_HEADER_SIZE)) {
      throw new ArchiveFormatError("index_page_invalid", "Index page offset is invalid.");
    }
    return offset;
  };

  if (page.leaf) {
    for (let index = 0; index < count; index += 1) {
      const key = readKey();
      const valueOffset = readOffset();
      if (page.entries.length > 0 && compareKeys(page.entries.at(-1)!.key, key) >= 0) {
        throw new ArchiveFormatError("index_page_order", "Leaf keys are not strictly ordered.");
      }
      page.entries.push({ key, valueOffset });
    }
  } else {
    page.children.push(readOffset());
    for (let index = 0; index < count; index += 1) {
      const separator = readKey();
      const child = readOffset();
      if (page.separators.length > 0 && compareKeys(page.separators.at(-1)!, separator) >= 0) {
        throw new ArchiveFormatError(
          "index_page_order",
          "Internal separators are not strictly ordered.",
        );
      }
      page.separators.push(separator);
      page.children.push(child);
    }
  }
  if (cursor !== payload.length) {
    throw new ArchiveFormatError("index_page_trailing_data", "Index page has trailing bytes.");
  }
  return page;
}

function encodeIndexPage(page: IndexPage): Uint8Array {
  if (page.leaf && page.entries.length > 0xffff) {
    throw new ArchiveFormatError("index_page_full", "Index page has too many entries.");
  }
  const keyFields = page.leaf ? page.entries.map((entry) => entry.key) : page.separators;
  for (const key of keyFields) {
    const length = encoder.encode(key).length;
    if (length === 0 || length > MAX_INDEX_KEY_BYTES) {
      throw new ArchiveFormatError("index_key_invalid", "Index key exceeds the v1 key limit.");
    }
  }
  if (
    !page.leaf &&
    (page.children.length !== page.separators.length + 1 || page.children.length === 0)
  ) {
    throw new ArchiveFormatError("index_page_invalid", "Internal index page has invalid children.");
  }
  let size = 10;
  if (page.leaf) {
    for (const entry of page.entries) size += 2 + encoder.encode(entry.key).length + 8;
  } else {
    size += 8;
    for (const key of page.separators) size += 2 + encoder.encode(key).length + 8;
  }
  const payload = new Uint8Array(size);
  const view = new DataView(payload.buffer);
  payload.set(encoder.encode("TXPG"), 0);
  view.setUint16(4, 1, true);
  payload[6] = page.leaf ? 0 : 1;
  payload[7] = 0;
  view.setUint16(8, page.leaf ? page.entries.length : page.separators.length, true);
  let cursor = 10;
  const writeKey = (key: string): void => {
    const encoded = encoder.encode(key);
    view.setUint16(cursor, encoded.length, true);
    cursor += 2;
    payload.set(encoded, cursor);
    cursor += encoded.length;
  };
  const writeOffset = (offset: bigint): void => {
    view.setBigUint64(cursor, offset, true);
    cursor += 8;
  };
  if (page.leaf) {
    for (const entry of page.entries) {
      writeKey(entry.key);
      writeOffset(entry.valueOffset);
    }
  } else {
    writeOffset(page.children[0]!);
    for (let index = 0; index < page.separators.length; index += 1) {
      writeKey(page.separators[index]!);
      writeOffset(page.children[index + 1]!);
    }
  }
  return payload;
}

interface BuiltIndexTree {
  rootOffset: bigint;
  rootPayload: Uint8Array;
  endOffset: bigint;
  frames: Uint8Array[];
}

async function buildIndexTree(
  entries: readonly IndexEntry[],
  initialOffset: bigint,
  authenticate?: (payload: Uint8Array) => Promise<Uint8Array>,
): Promise<BuiltIndexTree> {
  const frames: Uint8Array[] = [];
  let offset = initialOffset;
  const appendPage = async (
    page: IndexPage,
  ): Promise<{ offset: bigint; firstKey: string | null; payload: Uint8Array }> => {
    const pagePayload = encodeIndexPage(page);
    const payload = authenticate
      ? concatBytes([pagePayload, await authenticate(pagePayload)])
      : pagePayload;
    const frame = encodeRecordFrame(
      { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
      payload,
    );
    const pageOffset = offset;
    offset += BigInt(frame.byteLength);
    frames.push(frame);
    return {
      offset: pageOffset,
      firstKey: page.leaf ? (page.entries[0]?.key ?? null) : null,
      payload,
    };
  };

  const pageCapacity = 2048;
  const firstLevel: { offset: bigint; firstKey: string | null; payload: Uint8Array }[] = [];
  if (entries.length === 0) {
    firstLevel.push(await appendPage({ leaf: true, entries: [], separators: [], children: [] }));
  } else {
    for (let start = 0; start < entries.length; start += pageCapacity) {
      const pageEntries = entries.slice(start, start + pageCapacity);
      firstLevel.push(
        await appendPage({ leaf: true, entries: [...pageEntries], separators: [], children: [] }),
      );
    }
  }

  let level = firstLevel;
  const fanout = 256;
  while (level.length > fanout) {
    const groupCount = Math.ceil(level.length / fanout);
    const baseSize = Math.floor(level.length / groupCount);
    const remainder = level.length % groupCount;
    const parentLevel: { offset: bigint; firstKey: string | null; payload: Uint8Array }[] = [];
    let cursor = 0;
    for (let group = 0; group < groupCount; group += 1) {
      const count = baseSize + (group < remainder ? 1 : 0);
      const children = level.slice(cursor, cursor + count);
      cursor += count;
      parentLevel.push(
        await appendPage({
          leaf: false,
          entries: [],
          separators: children.slice(1).map((child) => child.firstKey!),
          children: children.map((child) => child.offset),
        }),
      );
      parentLevel.at(-1)!.firstKey = children[0]?.firstKey ?? null;
    }
    level = parentLevel;
  }

  let root: { offset: bigint; firstKey: string | null; payload: Uint8Array };
  if (level.length === 1) {
    root = level[0]!;
    return { rootOffset: root.offset, rootPayload: root.payload, endOffset: offset, frames };
  }

  root = await appendPage({
    leaf: false,
    entries: [],
    separators: level.slice(1).map((child) => child.firstKey!),
    children: level.map((child) => child.offset),
  });
  return { rootOffset: root.offset, rootPayload: root.payload, endOffset: offset, frames };
}

function encodeCommitPayload(commit: Omit<CommitInfo, "offset">): Uint8Array {
  const payload = new Uint8Array(92);
  const view = new DataView(payload.buffer);
  payload.set(encoder.encode("TXCM"), 0);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setBigUint64(8, commit.generation, true);
  view.setBigUint64(16, commit.previousOffset, true);
  view.setBigUint64(24, commit.rootOffset, true);
  payload.set(commit.rootHash, 32);
  payload.set(uuidToBytes(commit.transactionId), 64);
  view.setBigUint64(80, commit.recordCount, true);
  view.setUint32(88, 1, true);
  return payload;
}

function encodeLocator(commitOffset: bigint, generation: bigint): Uint8Array {
  const locator = new Uint8Array(LOCATOR_SIZE);
  const view = new DataView(locator.buffer);
  locator.set(encoder.encode("TUXLOC1\0"), 0);
  view.setBigUint64(8, commitOffset, true);
  view.setBigUint64(16, generation, true);
  view.setUint32(24, crc32(locator.subarray(0, 24)), true);
  view.setUint32(28, 0, true);
  return locator;
}

async function commitPublishedEndOffset(
  source: ArchiveByteSource,
  commit: CommitInfo,
): Promise<bigint> {
  const frame = await readFrameAt(source, commit.offset);
  if (frame.type !== RecordType.commit) {
    throw new ArchiveFormatError(
      "archive_commit_invalid",
      "Commit offset points to a non-commit record.",
    );
  }
  const locatorOffset = BigInt(frame.endOffset);
  if (source.size - locatorOffset < BigInt(LOCATOR_SIZE)) {
    throw new ArchiveFormatError(
      "archive_locator_missing",
      "A commit publication locator is missing.",
    );
  }
  const locator = await source.read(locatorOffset, LOCATOR_SIZE);
  if (
    !validLocator(locator) ||
    readLittle(locator, 8, 8) !== commit.offset ||
    readLittle(locator, 16, 8) !== commit.generation
  ) {
    throw new ArchiveFormatError(
      "archive_locator_invalid",
      "A commit publication locator is invalid or points to a different generation.",
    );
  }
  return locatorOffset + BigInt(LOCATOR_SIZE);
}

function validLocator(locator: Uint8Array): boolean {
  if (locator.length !== LOCATOR_SIZE || !hasMagic(locator, 0, "TUXLOC1\0")) return false;
  const view = new DataView(locator.buffer, locator.byteOffset, locator.byteLength);
  return (
    view.getUint32(24, true) === crc32(locator.subarray(0, 24)) && view.getUint32(28, true) === 0
  );
}

type CompactedArchiveSegment =
  | { kind: "static"; offset: bigint; bytes: Uint8Array }
  | {
      kind: "frame";
      offset: bigint;
      originalOffset: bigint;
      frameLength: number;
      payloadLength: number;
      header: Uint8Array;
    };

interface MemoryArchiveSegment {
  offset: bigint;
  bytes: Uint8Array;
}

/** Presents newly encoded archive frames without copying the entire archive into one buffer. */
class SegmentedArchiveSource implements ArchiveByteSource {
  constructor(
    private readonly segments: readonly MemoryArchiveSegment[],
    readonly size: bigint,
  ) {}

  async read(offset: bigint, length: number): Promise<Uint8Array> {
    if (
      offset < 0n ||
      offset > this.size ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      BigInt(length) > this.size - offset
    ) {
      throw new RangeError("Archive read is outside the re-keyed source bounds.");
    }
    const output = new Uint8Array(length);
    if (length === 0) return output;
    const end = offset + BigInt(length);
    let low = 0;
    let high = this.segments.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const segment = this.segments[middle]!;
      if (segment.offset + BigInt(segment.bytes.byteLength) <= offset) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.segments.length; index += 1) {
      const segment = this.segments[index]!;
      const segmentEnd = segment.offset + BigInt(segment.bytes.byteLength);
      if (segment.offset >= end) break;
      const overlapStart = segment.offset > offset ? segment.offset : offset;
      const overlapEnd = segmentEnd < end ? segmentEnd : end;
      if (overlapEnd <= overlapStart) continue;
      const sourceStart = Number(overlapStart - segment.offset);
      const outputStart = Number(overlapStart - offset);
      const overlapLength = Number(overlapEnd - overlapStart);
      output.set(segment.bytes.subarray(sourceStart, sourceStart + overlapLength), outputStart);
    }
    return output;
  }
}

/** Reads a compacted archive as fixed metadata plus payload ranges from its verified source. */
class CompactedArchiveSource implements ArchiveByteSource {
  constructor(
    private readonly original: ArchiveByteSource,
    private readonly segments: readonly CompactedArchiveSegment[],
    readonly size: bigint,
  ) {}

  async read(offset: bigint, length: number): Promise<Uint8Array> {
    if (
      offset < 0n ||
      offset > BigInt(Number.MAX_SAFE_INTEGER) ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      BigInt(length) > this.size - offset
    ) {
      throw new RangeError("Compacted archive read is outside the source bounds.");
    }
    const output = new Uint8Array(length);
    const end = offset + BigInt(length);
    let low = 0;
    let high = this.segments.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const segment = this.segments[middle]!;
      const segmentLength =
        segment.kind === "static" ? segment.bytes.byteLength : segment.frameLength;
      if (segment.offset + BigInt(segmentLength) <= offset) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.segments.length; index += 1) {
      const segment = this.segments[index]!;
      const segmentLength =
        segment.kind === "static" ? segment.bytes.byteLength : segment.frameLength;
      const segmentEnd = segment.offset + BigInt(segmentLength);
      if (segment.offset >= end) break;
      const overlapStart = segment.offset > offset ? segment.offset : offset;
      const overlapEnd = segmentEnd < end ? segmentEnd : end;
      if (segment.kind === "static") {
        const sourceStart = Number(overlapStart - segment.offset);
        const outputStart = Number(overlapStart - offset);
        const overlapLength = Number(overlapEnd - overlapStart);
        output.set(segment.bytes.subarray(sourceStart, sourceStart + overlapLength), outputStart);
        continue;
      }

      const headerEnd = segment.offset + BigInt(RECORD_HEADER_SIZE);
      if (overlapStart < headerEnd) {
        const headerStart = Number(overlapStart - segment.offset);
        const headerCopyEnd = overlapEnd < headerEnd ? overlapEnd : headerEnd;
        const copyLength = Number(headerCopyEnd - overlapStart);
        output.set(
          segment.header.subarray(headerStart, headerStart + copyLength),
          Number(overlapStart - offset),
        );
      }
      const payloadStart = headerEnd;
      const payloadEnd = payloadStart + BigInt(segment.payloadLength);
      const payloadCopyStart = overlapStart > payloadStart ? overlapStart : payloadStart;
      const payloadCopyEnd = overlapEnd < payloadEnd ? overlapEnd : payloadEnd;
      if (payloadCopyEnd > payloadCopyStart) {
        const payloadLength = Number(payloadCopyEnd - payloadCopyStart);
        const payload = await this.original.read(
          segment.originalOffset + BigInt(RECORD_HEADER_SIZE) + payloadCopyStart - payloadStart,
          payloadLength,
        );
        if (payload.byteLength !== payloadLength) {
          throw new ArchiveFormatError(
            "archive_compaction_source_changed",
            "The source archive changed while compaction was reading record payloads.",
          );
        }
        output.set(payload, Number(payloadCopyStart - offset));
      }
    }
    return output;
  }
}

class PrefixArchiveSource implements ArchiveByteSource {
  constructor(
    private readonly source: ArchiveByteSource,
    readonly size: bigint,
  ) {
    if (size < 0n || size > source.size) {
      throw new RangeError("Archive prefix is outside the source bounds.");
    }
  }

  async read(offset: bigint, length: number): Promise<Uint8Array> {
    if (
      offset < 0n ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset > this.size ||
      BigInt(length) > this.size - offset
    ) {
      throw new RangeError("Archive read is outside the prefix bounds.");
    }
    return this.source.read(offset, length);
  }
}

function readLittle(bytes: Uint8Array, offset: number, size: 2 | 4 | 8): bigint {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) {
    throw new ArchiveFormatError("archive_truncated", "Archive structure is truncated.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (size === 2) return BigInt(view.getUint16(offset, true));
  if (size === 4) return BigInt(view.getUint32(offset, true));
  return view.getBigUint64(offset, true);
}

async function readFrameAt(source: ArchiveByteSource, offset: bigint): Promise<ArchiveRecordFrame> {
  if (
    offset < BigInt(ARCHIVE_HEADER_SIZE) ||
    offset >= source.size ||
    offset > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ArchiveFormatError(
      "record_offset_invalid",
      "Archive offset is outside the supported file range.",
    );
  }
  const frameHeaderBytes = await source.read(offset, 64);
  const frameHeader = decodeRecordFrameHeader(frameHeaderBytes, Number(offset));
  const paddingLength = (8 - (frameHeader.payloadLength % 8)) % 8;
  const frameLength = 64 + frameHeader.payloadLength + paddingLength;
  if (BigInt(frameLength) > source.size - offset) {
    throw new ArchiveFormatError(
      "record_offset_invalid",
      "Record frame extends beyond the archive.",
    );
  }
  const frameBytes = await source.read(offset, frameLength);
  const frame = decodeRecordFrame(frameBytes);
  return { ...frame, endOffset: Number(offset) + frame.endOffset };
}

async function readRecordMetadataAt(
  source: ArchiveByteSource,
  offset: bigint,
): Promise<ArchiveRecord> {
  const headerBytes = await source.read(offset, 64);
  const header = decodeRecordFrameHeader(headerBytes, Number(offset));
  if (header.flags & 1) {
    throw new ArchiveFormatError(
      "archive_locked",
      "Unlock this archive before reading recordings.",
    );
  }
  if (header.codec !== 0) {
    const frame = await readFrameAt(source, offset);
    const payload = decodeStoredPayload(frame);
    const record = decodeRecordPayload(
      frame.type,
      frame.id,
      frame.revision,
      frame.previousOffset,
      payload,
    );
    return { ...record, blob: new Uint8Array() };
  }
  const reader = new SequentialRecordPayloadReader(
    source,
    offset + BigInt(RECORD_HEADER_SIZE),
    header.payloadLength,
  );
  return readRecordMetadataPayload(reader, header);
}

async function readRecordMetadataPayload(
  reader: SequentialRecordPayloadReader,
  header: ArchiveRecordFrameHeader,
): Promise<ArchiveRecord> {
  if (header.payloadLength < 16) {
    throw new ArchiveFormatError("record_payload_invalid", "Domain record payload is malformed.");
  }
  const preamble = await reader.readBytes(16);
  if (
    preamble[0] !== 0x54 ||
    preamble[1] !== 0x58 ||
    preamble[2] !== 0x4d ||
    preamble[3] !== 0x44
  ) {
    throw new ArchiveFormatError("record_payload_invalid", "Domain record payload is malformed.");
  }
  const preambleView = new DataView(preamble.buffer, preamble.byteOffset, preamble.byteLength);
  const schema = preambleView.getUint16(4, true);
  const count = preambleView.getUint16(6, true);
  const blobLength = preambleView.getBigUint64(8, true);
  if (schema !== 1 || blobLength > BigInt(header.payloadLength - 16)) {
    throw new ArchiveFormatError("record_schema_unsupported", "Unsupported record schema.");
  }

  const metadataEnd = header.payloadLength - Number(blobLength);
  const fields = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    if (reader.position + 6 > metadataEnd) {
      throw new ArchiveFormatError("record_field_limit", "Record field exceeds its payload.");
    }
    const fieldHeader = await reader.readBytes(6);
    const fieldView = new DataView(
      fieldHeader.buffer,
      fieldHeader.byteOffset,
      fieldHeader.byteLength,
    );
    const keyLength = fieldView.getUint16(0, true);
    const valueLength = fieldView.getUint32(2, true);
    if (keyLength === 0 || reader.position + keyLength + valueLength > metadataEnd) {
      throw new ArchiveFormatError("record_field_limit", "Record field exceeds its payload.");
    }
    const key = await reader.readText(keyLength);
    const value = await reader.readText(valueLength);
    if (fields.has(key)) {
      throw new ArchiveFormatError("record_field_duplicate", "Record contains duplicate fields.");
    }
    fields.set(key, value);
  }
  if (BigInt(reader.position) + blobLength !== BigInt(header.payloadLength)) {
    throw new ArchiveFormatError("record_blob_invalid", "Record blob length is inconsistent.");
  }
  await reader.verify(header.payloadChecksum);
  return {
    type: header.type,
    id: header.id,
    revision: header.revision,
    previousOffset: header.previousOffset,
    fields,
    blob: new Uint8Array(),
  };
}

class SequentialRecordPayloadReader {
  private positionInPayload = 0;
  private pageStart = 0;
  private page: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private checksumState = 0xffffffff;

  constructor(
    private readonly source: ArchiveByteSource,
    private readonly payloadOffset: bigint,
    private readonly payloadLength: number,
  ) {}

  get position(): number {
    return this.positionInPayload;
  }

  async readBytes(length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > METADATA_READ_CHUNK_BYTES ||
      this.positionInPayload + length > this.payloadLength
    ) {
      throw new ArchiveFormatError("record_field_limit", "Record field exceeds its payload.");
    }
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const pageEnd = this.pageStart + this.page.byteLength;
      if (this.positionInPayload < this.pageStart || this.positionInPayload >= pageEnd) {
        this.pageStart = this.positionInPayload;
        const pageLength = Math.min(
          METADATA_READ_CHUNK_BYTES,
          this.payloadLength - this.positionInPayload,
        );
        this.page = await this.source.read(this.payloadOffset + BigInt(this.pageStart), pageLength);
        if (this.page.byteLength !== pageLength) {
          throw new ArchiveFormatError("archive_truncated", "Record payload is truncated.");
        }
      }
      const pageOffset = this.positionInPayload - this.pageStart;
      const copyLength = Math.min(length - written, this.page.byteLength - pageOffset);
      output.set(this.page.subarray(pageOffset, pageOffset + copyLength), written);
      this.positionInPayload += copyLength;
      written += copyLength;
    }
    this.checksumState = crc32Update(this.checksumState, output);
    return output;
  }

  async verify(expectedChecksum: number): Promise<void> {
    while (this.positionInPayload < this.payloadLength) {
      await this.readBytes(
        Math.min(METADATA_READ_CHUNK_BYTES, this.payloadLength - this.positionInPayload),
      );
    }
    if (crc32Finalize(this.checksumState) !== expectedChecksum) {
      throw new ArchiveFormatError(
        "record_payload_checksum",
        "Record payload checksum is invalid.",
      );
    }

    const paddingLength = (8 - (this.payloadLength % 8)) % 8;
    if (paddingLength > 0) {
      const padding = await this.source.read(
        this.payloadOffset + BigInt(this.payloadLength),
        paddingLength,
      );
      if (padding.byteLength !== paddingLength) {
        throw new ArchiveFormatError("archive_truncated", "Record alignment padding is truncated.");
      }
      if (padding.some((byte) => byte !== 0)) {
        throw new ArchiveFormatError(
          "record_padding_invalid",
          "Record alignment padding must be zero.",
        );
      }
    }
  }

  async readText(length: number): Promise<string> {
    const chunks: string[] = [];
    let remaining = length;
    while (remaining > 0) {
      const chunkLength = Math.min(METADATA_READ_CHUNK_BYTES, remaining);
      const bytes = await this.readBytes(chunkLength);
      remaining -= chunkLength;
      try {
        chunks.push(this.decoder.decode(bytes, { stream: remaining > 0 }));
      } catch {
        throw new ArchiveFormatError("record_text_invalid", "Record text is not valid UTF-8.");
      }
    }
    try {
      chunks.push(this.decoder.decode());
    } catch {
      throw new ArchiveFormatError("record_text_invalid", "Record text is not valid UTF-8.");
    }
    return chunks.join("");
  }
}

function hasMagic(bytes: Uint8Array, offset: number, magic: string): boolean {
  if (offset < 0 || offset + magic.length > bytes.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[offset + index] !== magic.charCodeAt(index)) return false;
  }
  return true;
}

function bytesUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (bytes.length !== 16)
    throw new ArchiveFormatError("commit_invalid", "Transaction UUID is invalid.");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidToBytes(value: string): Uint8Array {
  const compact = value.replaceAll("-", "");
  if (!/^[\da-f]{32}$/i.test(compact)) {
    throw new ArchiveFormatError("id_invalid", "Identifier must be a hexadecimal UUID.");
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return new Uint8Array(digest);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function indexEntriesMatch(
  left: ReadonlyMap<string, bigint>,
  right: ReadonlyMap<string, bigint>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, offset] of left) {
    if (right.get(key) !== offset) return false;
  }
  return true;
}

async function verifyManifestAuthentication(
  record: ArchiveRecord,
  dataKey: ArchiveDataKey,
): Promise<ArchiveRecord> {
  const authenticationHex = record.fields.get("manifest_auth") ?? "";
  if (!/^[\da-f]{64}$/iu.test(authenticationHex)) {
    throw new ArchiveFormatError(
      "archive_manifest_authentication_failed",
      "Encrypted archive manifest authentication data is missing or malformed.",
    );
  }
  const authentication = new Uint8Array(32);
  for (let index = 0; index < authentication.byteLength; index += 1) {
    authentication[index] = Number.parseInt(authenticationHex.slice(index * 2, index * 2 + 2), 16);
  }
  const fields = new Map(record.fields);
  fields.delete("manifest_auth");
  const unsignedPayload = encodeRecordPayload({ ...record, fields });
  if (
    !(await dataKey.authenticationMatches("TUTORUX-MANIFEST-V1", unsignedPayload, authentication))
  ) {
    throw new ArchiveFormatError(
      "archive_manifest_authentication_failed",
      "Encrypted archive manifest authentication failed.",
    );
  }
  return { ...record, fields };
}

function compareKeys(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const count = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < count; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const part of parts) {
    totalLength += part.byteLength;
    if (!Number.isSafeInteger(totalLength)) {
      throw new ArchiveFormatError(
        "archive_size_limit",
        "Archive exceeds the supported file size.",
      );
    }
  }
  const output = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  return output;
}
