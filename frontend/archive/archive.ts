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
import type { ArchiveStaging } from "./staging";

const LOCATOR_SIZE = 32;
const RECOVERY_WINDOW = 64 * 1024 * 1024;
const METADATA_READ_CHUNK_BYTES = 64 * 1024;
const MAX_INDEX_DEPTH = 32;
const MAX_INDEX_KEY_BYTES = 192;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const SECONDARY_INDEX_MIGRATIONS = [
  {
    recordType: RecordType.annotation,
    indexPrefix: "ANNOTATIONSESSION:",
    versionField: "annotation_session_time_index_version",
  },
  {
    recordType: RecordType.session,
    indexPrefix: "STUDENTSESSION:",
    versionField: "student_session_index_version",
  },
  {
    recordType: RecordType.evidenceEdge,
    indexPrefix: "EVIDENCEADJ:",
    versionField: "evidence_adjacency_index_version",
  },
  {
    recordType: RecordType.transcriptSegment,
    indexPrefix: "TRANSCRIPTSESSION:",
    versionField: "transcript_session_index_version",
  },
  {
    recordType: RecordType.audioChunk,
    indexPrefix: "AUDIOSESSION:",
    versionField: "audio_chunk_index_version",
  },
] as const;
const SECONDARY_INDEX_PREFIXES = [
  "ANNOTATIONSESSION:",
  "STUDENTSESSION:",
  "EVIDENCEADJ:",
  "TRANSCRIPTSESSION:",
  "GUIDESOURCE:",
  "AUDIOSESSION:",
  "BLOB:",
] as const;
const CREDENTIAL_METADATA_FIELDS = new Set([
  "credentialstorage",
  "apikeyenv",
  "tokenbudget",
  "tokensbudget",
  "tokencount",
  "tokenscount",
  "tokenlimit",
  "tokenslimit",
  "tokenusage",
  "tokensusage",
  "maxoutputtokens",
  "maximumoutputtokens",
  "tokenizerinformation",
  "contexttokens",
  "trainingcontexttokens",
  "usedtokens",
  "estimatedtokens",
  "requestedoutputtokens",
  "inputtokenupperbound",
]);
const CREDENTIAL_MARKERS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "credential",
  "apikey",
  "authorization",
  "privatekey",
  "accesskey",
  "authkey",
  "bearertoken",
  "refreshtoken",
];
const NON_SECRET_TOKEN_SUFFIXES = [
  "tokenbudget",
  "tokensbudget",
  "tokencount",
  "tokenscount",
  "tokenlimit",
  "tokenslimit",
  "tokenusage",
  "tokensusage",
];
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

  /** Encrypt a verified plaintext archive without changing its identity or record history. */
  async enableEncryption(newPassphrase: string): Promise<ArchiveSnapshot> {
    if (this.encrypted) {
      throw new ArchiveFormatError(
        "archive_already_encrypted",
        "This archive is already encrypted.",
      );
    }
    return encryptArchiveSnapshotWithFreshKey(this, newPassphrase);
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

  /** Re-read and authenticate one generation's index tree, returning its page count. */
  async readVerifiedIndexTree(
    commit: CommitInfo,
  ): Promise<{ entries: Map<string, bigint>; pageOffsets: bigint[] }> {
    const rootFrame = await readFrameAt(this.source, commit.rootOffset);
    if (
      rootFrame.type !== RecordType.indexPage ||
      !bytesEqual(await sha256(rootFrame.storedPayload), commit.rootHash)
    ) {
      throw new ArchiveFormatError(
        "archive_commit_root_invalid",
        "Commit root hash does not match its index page.",
      );
    }
    const stats = { pageOffsets: [] as bigint[] };
    const entries = await readIndexTree(
      this.source,
      commit,
      rootFrame,
      this.encrypted,
      this.#dataKey,
      stats,
    );
    return { entries, pageOffsets: stats.pageOffsets };
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

  /** Verify a retained revision, including opaque payload and manifest authentication. */
  async verifyRevisionFrame(frame: ArchiveRecordFrame): Promise<void> {
    if (recordTypeName(frame.type) === "unknown") await this.decodeFramePayload(frame);
    else await this.decodeFrameRecord(frame);
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
  options: { full: true },
): Promise<ArchiveFullVerificationResult>;
export async function verifyArchiveSnapshot(
  snapshot: ArchiveSnapshot,
  options?: { full?: false },
): Promise<ArchiveVerificationResult>;
export async function verifyArchiveSnapshot(
  snapshot: ArchiveSnapshot,
  options?: { full?: boolean },
): Promise<ArchiveVerificationResult | ArchiveFullVerificationResult> {
  if (options?.full) return verifyArchiveFull(snapshot);
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

export interface ArchiveHistoryVerificationResult extends ArchiveVerificationResult {
  historicalRevisions: number;
  verifiedCommits: number;
  /** Sum of indexed primary records across generations; a record may occur more than once. */
  verifiedGenerationRecords: number;
}

/** Verify the complete committed chain and every indexed record revision. */
export async function verifyArchiveHistory(
  snapshot: ArchiveSnapshot,
): Promise<ArchiveHistoryVerificationResult> {
  const current = await verifyArchiveFull(snapshot);
  if (!current.valid) {
    throw new ArchiveFormatError(
      "archive_verification_failed",
      `Archive is not fully valid: ${current.issues.join("; ")}`,
    );
  }
  const visitedFrames = new Set<bigint>();
  let historicalRevisions = 0;
  for (const [key, latestOffset] of snapshot.allIndexEntries()) {
    const separator = key.indexOf(":");
    if (
      separator < 1 ||
      key.indexOf(":", separator + 1) !== -1 ||
      !validArchiveUuid(key.slice(separator + 1))
    )
      continue;
    const latest = await readFrameAt(snapshot.source, latestOffset);
    if (key !== primaryIndexKey(latest.type, latest.id)) continue;
    let offset = latestOffset;
    let newer: ArchiveRecordFrame | undefined;
    while (offset !== 0n) {
      if (visitedFrames.has(offset))
        throw new ArchiveFormatError(
          "revision_cycle",
          "Archive revision history contains a cycle or shared record frame.",
        );
      visitedFrames.add(offset);
      const frame = await readFrameAt(snapshot.source, offset);
      if (
        BigInt(frame.endOffset) > snapshot.commit.offset ||
        frame.type !== latest.type ||
        frame.id !== latest.id ||
        (newer && frame.revision >= newer.revision) ||
        (frame.previousOffset !== 0n && frame.previousOffset >= offset)
      ) {
        throw new ArchiveFormatError(
          "revision_lineage_invalid",
          "Archive revision history contains an invalid or out-of-order link.",
        );
      }
      await snapshot.verifyRevisionFrame(frame);
      if (newer) historicalRevisions += 1;
      newer = frame;
      offset = frame.previousOffset;
    }
  }
  let commit = snapshot.commit;
  let verifiedCommits = 0;
  let verifiedGenerationRecords = 0;
  const commits = new Set<bigint>();
  while (true) {
    if (commits.size >= 1_000_000 || commits.has(commit.offset)) {
      throw new ArchiveFormatError(
        "archive_commit_chain_invalid",
        "Archive commit history contains a cycle or exceeds the verification limit.",
      );
    }
    commits.add(commit.offset);
    const consistent = await findConsistentCommit(snapshot.source, snapshot.header, commit);
    if (!consistent || consistent.commit.offset !== commit.offset) {
      throw new ArchiveFormatError(
        "archive_commit_chain_invalid",
        "A historical commit or index tree is invalid.",
      );
    }
    const view = await snapshot.openGeneration(
      snapshot.source,
      commit,
      consistent.indexEntries,
      snapshot.source.size,
    );
    try {
      await view.getManifest();
      const verified = await verifyArchiveFull(view);
      if (!verified.valid) {
        throw new ArchiveFormatError(
          "archive_commit_chain_invalid",
          `Generation ${commit.generation} is not fully valid: ${verified.issues.join("; ")}`,
        );
      }
      verifiedGenerationRecords += verified.currentRecords;
    } finally {
      view.lock();
    }
    verifiedCommits += 1;
    if (commit.previousOffset === 0n) {
      if (commit.generation !== 1n)
        throw new ArchiveFormatError(
          "archive_commit_chain_invalid",
          "The initial commit generation is invalid.",
        );
      break;
    }
    if (commit.previousOffset >= commit.offset)
      throw new ArchiveFormatError(
        "archive_commit_chain_invalid",
        "A commit points forward in the archive.",
      );
    const previous = await decodeCommit(snapshot.source, commit.previousOffset);
    if (previous.generation + 1n !== commit.generation)
      throw new ArchiveFormatError(
        "archive_commit_chain_invalid",
        "Archive commit generations are not consecutive.",
      );
    commit = previous;
  }
  return { ...current, historicalRevisions, verifiedCommits, verifiedGenerationRecords };
}

export interface ArchiveFullVerificationResult extends ArchiveVerificationResult {
  valid: boolean;
  recordsChecked: number;
  indexPagesChecked: number;
  issues: string[];
}

/** Fully verify semantics, revision lineage, secondary indexes, and physical frame layout. */
export async function verifyArchiveFull(
  snapshot: ArchiveSnapshot,
): Promise<ArchiveFullVerificationResult> {
  const base = {
    generation: snapshot.commit.generation.toString(),
    currentRecords: 0,
    liveRecords: 0,
    deletedRecords: 0,
    indexEntries: snapshot.indexEntryCount(),
    recordsChecked: 0,
    indexPagesChecked: 0,
  };
  if (snapshot.locked) {
    return {
      ...base,
      valid: false,
      issues: ["Unlock the archive before verifying its contents."],
    };
  }
  const issues: string[] = [];
  const note = (message: string): void => {
    issues.push(message);
  };
  const noteError = (error: unknown): void => {
    note(error instanceof Error ? error.message : String(error));
  };
  try {
    await snapshot.getManifest();
    await snapshot.verifyEncryptionAuthentication();
  } catch (error) {
    noteError(error);
    return { ...base, valid: false, issues };
  }

  const spans = new Map<bigint, { end: bigint; label: string }>();
  const addSpan = (offset: bigint, end: number, label: string): void => {
    const value = { end: BigInt(end), label };
    const existing = spans.get(offset);
    if (!existing) spans.set(offset, value);
    else if (existing.end !== value.end) {
      note(
        `One archive offset resolves to inconsistent frame spans: ${existing.label} and ${label}.`,
      );
    }
  };

  let indexPagesChecked = 0;
  let commit = snapshot.commit;
  const visitedCommits = new Set<bigint>();
  try {
    while (true) {
      if (visitedCommits.size >= 1_000_000 || visitedCommits.has(commit.offset)) {
        note("Commit history contains a cycle or exceeds the verification limit.");
        break;
      }
      visitedCommits.add(commit.offset);
      const decoded = await decodeCommit(snapshot.source, commit.offset);
      const commitFrame = await readFrameAt(snapshot.source, commit.offset);
      addSpan(commit.offset, commitFrame.endOffset, `commit at ${commit.offset}`);
      if (
        decoded.generation !== commit.generation ||
        decoded.previousOffset !== commit.previousOffset ||
        decoded.rootOffset !== commit.rootOffset ||
        !bytesEqual(decoded.rootHash, commit.rootHash) ||
        decoded.transactionId !== commit.transactionId ||
        decoded.recordCount !== commit.recordCount
      ) {
        note(`Commit at offset ${commit.offset} disagrees with the selected chain.`);
      }
      const tree = await snapshot.readVerifiedIndexTree(commit);
      for (const pageOffset of tree.pageOffsets) {
        const page = await readFrameAt(snapshot.source, pageOffset);
        addSpan(pageOffset, page.endOffset, `index page at ${pageOffset}`);
      }
      if (commit.offset === snapshot.commit.offset) {
        indexPagesChecked = tree.pageOffsets.length;
        if (!indexEntriesMatch(tree.entries, snapshot.allIndexEntries())) {
          note("Authenticated index does not match the opened archive index.");
        }
      }
      if (commit.previousOffset === 0n) {
        if (commit.generation !== 1n) note("Commit chain ends before generation one.");
        break;
      }
      const previous = await decodeCommit(snapshot.source, commit.previousOffset);
      if (previous.generation + 1n !== commit.generation) {
        note("Commit generations are not consecutive.");
        break;
      }
      commit = previous;
    }
  } catch (error) {
    noteError(error);
  }

  const entries = snapshot.allIndexEntries();
  const knownTypeNames = new Set(
    Object.values(RecordType).map((type) => recordTypeName(type).toUpperCase()),
  );
  knownTypeNames.add("UNKNOWN");
  const currentRecords = new Map<string, ArchiveRecord>();
  const revisionsByKey = new Map<string, ArchiveRecord[]>();
  const recordByOffset = new Map<bigint, ArchiveRecord>();
  const latestOffsets = new Map<string, bigint>();
  const visitedFrames = new Set<bigint>();
  let recordsChecked = 0;
  for (const [key, latestOffset] of entries) {
    const separator = key.indexOf(":");
    if (
      separator > 0 &&
      key.indexOf(":", separator + 1) === -1 &&
      knownTypeNames.has(key.slice(0, separator)) &&
      !validArchiveUuid(key.slice(separator + 1))
    ) {
      note(`Primary record index key '${key}' is invalid.`);
      continue;
    }
    let latestFrame: ArchiveRecordFrame;
    try {
      latestFrame = await readFrameAt(snapshot.source, latestOffset);
    } catch (error) {
      note(`Index key '${key}': ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (key !== primaryIndexKey(latestFrame.type, latestFrame.id)) continue;
    if (currentRecords.has(key)) continue;
    const chain: ArchiveRecord[] = [];
    let offset = latestOffset;
    let newer: ArchiveRecordFrame | undefined;
    try {
      while (offset !== 0n) {
        if (visitedFrames.has(offset)) {
          note(`Record revision chain for '${key}' contains a cycle or shared frame.`);
          break;
        }
        visitedFrames.add(offset);
        const frame = await readFrameAt(snapshot.source, offset);
        addSpan(offset, frame.endOffset, `record at ${offset}`);
        if (
          BigInt(frame.endOffset) > snapshot.commit.offset ||
          frame.type !== latestFrame.type ||
          frame.id !== latestFrame.id ||
          (newer !== undefined && frame.revision >= newer.revision) ||
          (frame.previousOffset !== 0n && frame.previousOffset >= offset)
        ) {
          note(`Record revision lineage is inconsistent for ${latestFrame.id}.`);
          break;
        }
        const payload = await snapshot.decodeFramePayload(frame);
        recordsChecked += 1;
        if (recordTypeName(frame.type) !== "unknown") {
          if (
            frame.type === RecordType.settings &&
            frame.id.toLowerCase() === snapshot.header.id.toLowerCase()
          ) {
            await snapshot.verifyRevisionFrame(frame);
          }
          const record = decodeRecordPayload(
            frame.type,
            frame.id,
            frame.revision,
            frame.previousOffset,
            payload,
          );
          chain.push(record);
          recordByOffset.set(offset, record);
        }
        newer = frame;
        offset = frame.previousOffset;
      }
    } catch (error) {
      note(`Index key '${key}': ${error instanceof Error ? error.message : String(error)}`);
    }
    if (chain.length === 0) continue;
    currentRecords.set(key, chain[0]!);
    revisionsByKey.set(key, chain);
    latestOffsets.set(key, latestOffset);
  }

  const latestByKey = new Map<string, ArchiveRecord>();
  const hasLiveRevision = new Set<string>();
  for (const [key, records] of revisionsByKey) {
    latestByKey.set(key, records[0]!);
    for (const record of records) {
      if (record.fields.get("_deleted") !== "true") hasLiveRevision.add(key);
    }
  }
  const liveByKey = new Map<string, ArchiveRecord>();
  for (const [key, record] of latestByKey) {
    if (record.fields.get("_deleted") !== "true") liveByKey.set(key, record);
  }
  const lookupLive = (type: RecordTypeValue, id: string): ArchiveRecord | undefined =>
    liveByKey.get(primaryIndexKey(type, id));
  const lookupAnyLive = (type: RecordTypeValue, id: string): ArchiveRecord | undefined => {
    const key = primaryIndexKey(type, id);
    if (!hasLiveRevision.has(key)) return undefined;
    return revisionsByKey.get(key)?.find((record) => record.fields.get("_deleted") !== "true");
  };

  const liveRecords = [...liveByKey.values()];
  const deletedRecords = [...latestByKey.values()].filter(
    (record) => record.fields.get("_deleted") === "true",
  ).length;

  const checkSessionReference = (
    record: ArchiveRecord,
    lookup: (type: RecordTypeValue, id: string) => ArchiveRecord | undefined,
    historical: boolean,
  ): void => {
    const sessionId = record.fields.get("session_id") ?? "";
    if (!sessionId) return;
    if (!validArchiveUuid(sessionId.toLowerCase())) {
      note(`Invalid session reference in ${record.id}.`);
      return;
    }
    if (!lookup(RecordType.session, sessionId)) {
      note(
        `${historical ? "Historical revision" : "Record"} ${record.id} references a missing session ${sessionId}.`,
      );
    }
  };
  const checkGuideSources = (
    record: ArchiveRecord,
    lookup: (type: RecordTypeValue, id: string) => ArchiveRecord | undefined,
    strict: boolean,
  ): void => {
    const guideIssues = validateGuideSemantics(record, lookup, liveByKey, strict);
    for (const issue of guideIssues) note(`Guide ${record.id}: ${issue}`);
  };

  const manifests = new Set<RecordTypeValue>([
    RecordType.transcriptSegment,
    RecordType.annotation,
    RecordType.audioChunk,
    RecordType.assetMetadata,
    RecordType.evidenceNode,
    RecordType.guide,
  ]);
  for (const record of liveRecords) {
    try {
      if (record.type === RecordType.session) {
        const studentId = record.fields.get("student_id") ?? "";
        if (studentId && studentId !== "anonymous") {
          if (
            !validArchiveUuid(studentId.toLowerCase()) ||
            !lookupLive(RecordType.student, studentId)
          ) {
            note(`Session ${record.id} references a missing student.`);
          }
        }
      } else if (manifests.has(record.type)) {
        checkSessionReference(record, lookupLive, false);
      }
      if (record.type === RecordType.assetBlob) {
        const role = record.fields.get("record_role") ?? "";
        if (role === "asset-blob-manifest") {
          const content = await collectAssetContent(record, lookupLive);
          if (content.issue) note(`Asset blob manifest ${record.id}: ${content.issue}`);
          else if (record.fields.has("content_hash") || record.fields.has("byte_size")) {
            const expectedBytes = record.fields.get("byte_size") ?? "";
            const expectedHash = (record.fields.get("content_hash") ?? "").toLowerCase();
            const digest = bytesToHex(await sha256(content.bytes));
            if (
              !/^\d+$/u.test(expectedBytes) ||
              BigInt(expectedBytes) !== BigInt(content.bytes.byteLength) ||
              !/^[\da-f]{64}$/u.test(expectedHash) ||
              digest !== expectedHash
            ) {
              note(`Asset blob manifest ${record.id} content does not match its hash.`);
            }
          }
        }
      }
      if (record.type === RecordType.assetMetadata) {
        const role = record.fields.get("record_role") ?? "";
        if (role !== "audio-track" && role !== "recording-take") {
          const blobId = record.fields.get("blob_id") ?? "";
          const blob = validArchiveUuid(blobId.toLowerCase())
            ? lookupLive(RecordType.assetBlob, blobId)
            : undefined;
          if (!blob) {
            note(`Asset ${record.id} references a missing blob.`);
          } else {
            const content = await collectAssetContent(blob, lookupLive);
            if (content.issue) note(`Asset ${record.id}: ${content.issue}`);
            else {
              const expectedBytes = record.fields.get("byte_size") ?? "";
              const expectedHash = (record.fields.get("content_hash") ?? "").toLowerCase();
              const digest = bytesToHex(await sha256(content.bytes));
              if (
                !/^\d+$/u.test(expectedBytes) ||
                BigInt(expectedBytes) !== BigInt(content.bytes.byteLength) ||
                !/^[\da-f]{64}$/u.test(expectedHash) ||
                digest !== expectedHash
              ) {
                note(`Asset ${record.id} content is missing or does not match its hash.`);
              }
            }
          }
        }
      }
      if (record.type === RecordType.evidenceEdge) {
        for (const field of ["from_id", "to_id"] as const) {
          const id = record.fields.get(field) ?? "";
          if (!validArchiveUuid(id.toLowerCase()) || !lookupLive(RecordType.evidenceNode, id)) {
            note(`Evidence edge ${record.id} references a missing node.`);
          }
        }
      }
      if (record.type === RecordType.guide) {
        checkGuideSources(record, lookupLive, true);
      }
    } catch (error) {
      note(`Record ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Historical live revisions must resolve their references to a live archive record.
  const latestRevision = new Map<string, bigint>();
  for (const [key, record] of latestByKey) latestRevision.set(key, record.revision);
  for (const [key, records] of revisionsByKey) {
    for (const record of records) {
      if (record.fields.get("_deleted") === "true") continue;
      if (latestRevision.get(key) === record.revision) continue;
      try {
        if (record.type === RecordType.session) {
          const studentId = record.fields.get("student_id") ?? "";
          if (
            studentId &&
            studentId !== "anonymous" &&
            (!validArchiveUuid(studentId.toLowerCase()) ||
              !lookupAnyLive(RecordType.student, studentId))
          ) {
            note(`Historical revision ${record.id} references a missing student.`);
          }
        } else if (manifests.has(record.type)) {
          checkSessionReference(record, lookupAnyLive, true);
        }
        if (record.type === RecordType.assetMetadata) {
          const blobId = record.fields.get("blob_id") ?? "";
          if (
            !validArchiveUuid(blobId.toLowerCase()) ||
            !lookupAnyLive(RecordType.assetBlob, blobId)
          ) {
            note(`Historical revision ${record.id} references a missing asset blob.`);
          }
        }
        if (record.type === RecordType.assetBlob) {
          const role = record.fields.get("record_role") ?? "";
          if (role === "asset-blob-manifest") {
            const content = await collectAssetContent(record, lookupAnyLive);
            if (content.issue) {
              note(`Historical asset blob manifest ${record.id}: ${content.issue}`);
            }
          }
        }
        if (record.type === RecordType.evidenceEdge) {
          for (const field of ["from_id", "to_id"] as const) {
            const id = record.fields.get(field) ?? "";
            if (
              !validArchiveUuid(id.toLowerCase()) ||
              !lookupAnyLive(RecordType.evidenceNode, id)
            ) {
              note(`Historical revision ${record.id} references a missing evidence node.`);
            }
          }
        }
        if (record.type === RecordType.guide) {
          checkGuideSources(record, lookupAnyLive, false);
        }
      } catch (error) {
        note(
          `Historical revision ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Credential policy applies to every retained revision, not only the current one.
  for (const records of revisionsByKey.values()) {
    for (const record of records) {
      if (record.type !== RecordType.settings) continue;
      if (isCredentialSettingsRecord(record) && !snapshot.encrypted) {
        note(`Credential record ${record.id} is stored in an unencrypted archive.`);
      }
      if (hasSensitiveCredentialMaterial(record) && !isCredentialSettingsRecord(record)) {
        note(
          `Settings record ${record.id} contains credential-looking data outside the credential representation.`,
        );
      }
    }
  }

  const manifest = lookupLive(RecordType.settings, snapshot.header.id);
  const versionEnabled = (field: string): boolean => manifest?.fields.get(field) === "1";
  const enabledPrefixes = new Set<string>(
    SECONDARY_INDEX_MIGRATIONS.filter(({ versionField }) => versionEnabled(versionField)).map(
      ({ indexPrefix }) => indexPrefix,
    ),
  );
  const audioEnabled =
    versionEnabled("audio_chunk_index_version") ||
    [...liveByKey.values()].some(
      (record) =>
        record.type === RecordType.session &&
        record.fields.get("audio_chunk_index_version") === "1",
    );
  const guideEnabled = versionEnabled("guide_source_index_version");

  for (const [key, offset] of entries) {
    const prefix = SECONDARY_INDEX_PREFIXES.find((candidate) => key.startsWith(candidate));
    if (!prefix) {
      try {
        const frame = await readFrameAt(snapshot.source, offset);
        addSpan(offset, frame.endOffset, `indexed record at ${offset}`);
      } catch {
        // Unknown future index keys are opaque; their targets are not required here.
      }
      continue;
    }
    if (!visitedFrames.has(offset)) {
      note(`Secondary index key '${key}' references a record outside its primary revision chain.`);
    }
    let record = recordByOffset.get(offset);
    if (!record) {
      try {
        const frame = await readFrameAt(snapshot.source, offset);
        if (recordTypeName(frame.type) !== "unknown") {
          record = decodeRecordPayload(
            frame.type,
            frame.id,
            frame.revision,
            frame.previousOffset,
            await snapshot.decodeFramePayload(frame),
          );
        }
      } catch (error) {
        note(
          `Secondary index key '${key}': ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }
    if (!record) {
      note(`Secondary index key '${key}' points to an opaque record.`);
      continue;
    }
    const primaryOffset = entries.get(primaryIndexKey(record.type, record.id));
    const primaryMatches = primaryOffset !== undefined && primaryOffset === offset;
    let expected: boolean;
    try {
      expected = secondaryIndexKeys(record).includes(key);
    } catch (error) {
      note(
        `Secondary index key '${key}': ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const migration = SECONDARY_INDEX_MIGRATIONS.find(({ indexPrefix }) => indexPrefix === prefix);
    const versionField = migration?.versionField;
    if (prefix === "AUDIOSESSION:") {
      if (!audioEnabled) note(`Audio session index '${key}' is not enabled by its manifest.`);
      if (expected && (!primaryMatches || !audioSessionIndexKey(record))) {
        note("Audio session index key does not match its record.");
      }
    } else if (prefix === "GUIDESOURCE:") {
      if (!guideEnabled) note(`Guide source index '${key}' is not enabled by its manifest.`);
      if (expected && !primaryMatches) {
        note("Guide source index does not reference the current guide revision.");
      }
    } else if (versionField) {
      if (!enabledPrefixes.has(prefix)) {
        note(`Secondary index '${key}' is not enabled by its manifest.`);
      }
      if (expected && !primaryMatches) {
        note(`Secondary index key '${key}' does not reference the current record revision.`);
      }
    }
    if (!expected && prefix !== "BLOB:") {
      note(`Secondary index key '${key}' does not match its record.`);
    }
  }

  for (const record of latestByKey.values()) {
    const offset = latestOffsets.get(primaryIndexKey(record.type, record.id));
    if (offset === undefined) continue;
    let expectedKeys: string[];
    try {
      expectedKeys = secondaryIndexKeys(record);
    } catch (error) {
      note(`Record ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const key of expectedKeys) {
      const prefix = SECONDARY_INDEX_PREFIXES.find((candidate) => key.startsWith(candidate));
      if (!prefix) continue;
      const migration = SECONDARY_INDEX_MIGRATIONS.find(
        ({ indexPrefix }) => indexPrefix === prefix,
      );
      const required =
        prefix === "AUDIOSESSION:"
          ? audioEnabled
          : prefix === "GUIDESOURCE:"
            ? guideEnabled
            : migration !== undefined && enabledPrefixes.has(prefix);
      if (!required) continue;
      if (entries.get(key) !== offset) {
        note(`Secondary index '${key}' is missing its current record mapping.`);
      }
    }
  }

  const orderedSpans = [...spans.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
  let previousEnd = 0n;
  let previousLabel = "";
  for (const [offset, span] of orderedSpans) {
    if (offset < previousEnd) {
      note(`Physical archive record spans overlap: ${previousLabel} and ${span.label}.`);
    }
    if (span.end > previousEnd) {
      previousEnd = span.end;
      previousLabel = span.label;
    }
  }

  return {
    ...base,
    currentRecords: currentRecords.size,
    liveRecords: liveRecords.length,
    deletedRecords,
    recordsChecked,
    indexPagesChecked,
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Validate guide structure and source references. The strict form mirrors the
 * editor's scope rules; the historical form only requires a live source record.
 */
function validateGuideSemantics(
  record: ArchiveRecord,
  lookup: (type: RecordTypeValue, id: string) => ArchiveRecord | undefined,
  liveByKey: ReadonlyMap<string, ArchiveRecord>,
  strict: boolean,
): string[] {
  const issues: string[] = [];
  const count = (name: string, label: string): number | null => {
    const raw = record.fields.get(name) ?? "";
    if (!/^\d+$/u.test(raw) || Number(raw) > 10_000) {
      issues.push(`${label} count is invalid.`);
      return null;
    }
    return Number(raw);
  };
  if (strict) {
    if (!(record.fields.get("title") ?? "")) issues.push("title is required.");
    if (!(record.fields.get("session_id") ?? "") && !(record.fields.get("entry_id") ?? "")) {
      issues.push("a journal entry or session scope is required.");
    }
    const approval = record.fields.get("approval_state") ?? "draft";
    if (!["draft", "proposed", "approved"].includes(approval)) {
      issues.push("approval state is invalid.");
    }
  }
  const sessionId = (record.fields.get("session_id") ?? "").toLowerCase();
  const entryId = (record.fields.get("entry_id") ?? "").toLowerCase();
  const scopeSessionIds = new Set<string>();
  const scopeStudentIds = new Set<string>();
  if (strict) {
    if (entryId) {
      const entry = lookup(RecordType.settings, entryId);
      if (!entry || entry.fields.get("record_role") !== "journal-entry") {
        issues.push("journal entry reference does not resolve.");
      }
    }
    for (const candidate of liveByKey.values()) {
      if (candidate.type !== RecordType.session) continue;
      if (entryId && (candidate.fields.get("entry_id") ?? "").toLowerCase() === entryId) {
        if (!sessionId) scopeSessionIds.add(candidate.id.toLowerCase());
        if (candidate.fields.get("student_id")) {
          scopeStudentIds.add((candidate.fields.get("student_id") ?? "").toLowerCase());
        }
      }
    }
    if (sessionId) {
      const session = lookup(RecordType.session, sessionId);
      if (!session) issues.push("session reference does not resolve.");
      else {
        if (entryId && (session.fields.get("entry_id") ?? "").toLowerCase() !== entryId) {
          issues.push("session does not belong to its journal entry.");
        }
        scopeSessionIds.add(sessionId);
        const studentId = (session.fields.get("student_id") ?? "").toLowerCase();
        if (studentId && studentId !== "anonymous") scopeStudentIds.add(studentId);
      }
    }
  }
  const sectionCount = count("section_count", "guide section");
  if (sectionCount === null) return issues;
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const prefix = `section.${sectionIndex}.`;
    if (strict && !(record.fields.get(`${prefix}heading`) ?? "")) {
      issues.push(`section ${sectionIndex + 1} needs a heading.`);
    }
    const blockCount = count(`${prefix}block_count`, "guide block");
    if (blockCount === null) continue;
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const blockPrefix = `${prefix}block.${blockIndex}.`;
      const kind = record.fields.get(`${blockPrefix}kind`) ?? "";
      const text = record.fields.get(`${blockPrefix}text`) ?? "";
      if (strict && !kind) issues.push(`block ${blockIndex + 1} kind is required.`);
      const sourceIds = new Set(
        (record.fields.get(`${blockPrefix}source_ids`) ?? "")
          .split(",")
          .map((id) => id.trim().toLowerCase())
          .filter(Boolean),
      );
      let validInline = true;
      for (const match of text.matchAll(/\[\[source:([^\]]+)\]\]/giu)) {
        const id = match[1]!.trim().toLowerCase();
        if (!validArchiveUuid(id)) {
          validInline = false;
          break;
        }
        sourceIds.add(id);
      }
      if (!validInline)
        issues.push(`block ${blockIndex + 1} has an invalid inline source reference.`);
      if (kind === "image" || kind === "figure" || text.startsWith("![")) {
        const match =
          /^!\[((?:\\.|[^\]])*)\]\(asset:([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\)$/iu.exec(
            text,
          );
        if (!match) issues.push(`block ${blockIndex + 1} has an invalid image reference.`);
        else sourceIds.add(match[2]!.toLowerCase());
      }
      for (const sourceId of sourceIds) {
        if (!validArchiveUuid(sourceId)) {
          issues.push(`block ${blockIndex + 1} has an invalid source identifier.`);
          continue;
        }
        let found = false;
        for (const type of [
          RecordType.transcriptSegment,
          RecordType.annotation,
          RecordType.evidenceNode,
          RecordType.assetMetadata,
          RecordType.session,
          RecordType.student,
        ]) {
          const source = lookup(type, sourceId);
          if (!source) continue;
          if (!strict) {
            found = true;
            break;
          }
          if (type === RecordType.session) found = scopeSessionIds.has(sourceId);
          else if (type === RecordType.student) found = scopeStudentIds.has(sourceId);
          else if (type === RecordType.assetMetadata) {
            found =
              scopeSessionIds.has((source.fields.get("session_id") ?? "").toLowerCase()) ||
              scopeStudentIds.has((source.fields.get("student_id") ?? "").toLowerCase());
          } else {
            found = scopeSessionIds.has((source.fields.get("session_id") ?? "").toLowerCase());
          }
          if (found) break;
        }
        if (!found) {
          const notes = lookup(RecordType.settings, sourceId);
          if (notes && notes.fields.get("record_role") === "journal-notes") {
            found =
              Boolean(entryId && (notes.fields.get("entry_id") ?? "").toLowerCase() === entryId) ||
              Boolean(
                sessionId && (notes.fields.get("session_id") ?? "").toLowerCase() === sessionId,
              );
          }
        }
        if (!found) issues.push(`source ${sourceId} does not resolve to a live archive record.`);
      }
    }
  }
  return issues;
}

async function collectAssetContent(
  blob: ArchiveRecord,
  lookup: (type: RecordTypeValue, id: string) => ArchiveRecord | undefined,
): Promise<{ bytes: Uint8Array; issue?: string }> {
  if (blob.fields.get("record_role") !== "asset-blob-manifest") {
    return { bytes: blob.blob };
  }
  const chunkCount = blob.fields.get("chunk_count") ?? "";
  const chunkIds = blob.fields.get("chunk_ids") ?? "";
  if (!/^\d+$/u.test(chunkCount))
    return { bytes: new Uint8Array(), issue: "manifest chunk count is invalid." };
  const expected = BigInt(chunkCount);
  const parts: Uint8Array[] = [];
  let index = 0n;
  if (chunkIds.length > 0) {
    for (const rawId of chunkIds.split(",")) {
      const id = rawId.trim().toLowerCase();
      if (!validArchiveUuid(id)) {
        return { bytes: new Uint8Array(), issue: "manifest contains an invalid chunk identifier." };
      }
      const chunk = lookup(RecordType.assetBlob, id);
      if (
        !chunk ||
        chunk.fields.get("record_role") !== "asset-blob-chunk" ||
        (chunk.fields.get("manifest_id") ?? "").toLowerCase() !== blob.id.toLowerCase() ||
        (chunk.fields.get("chunk_index") ?? "") !== index.toString()
      ) {
        return {
          bytes: new Uint8Array(),
          issue: "manifest references missing or inconsistent chunks.",
        };
      }
      parts.push(chunk.blob);
      index += 1n;
    }
  }
  if (index !== expected) {
    return { bytes: new Uint8Array(), issue: "manifest chunk count is inconsistent." };
  }
  return { bytes: concatBytes(parts) };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireFullVerification(snapshot: ArchiveSnapshot, code: string): Promise<void> {
  const report = await verifyArchiveFull(snapshot);
  if (!report.valid) {
    throw new ArchiveFormatError(code, report.issues.join("; "));
  }
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
  const baseLocatorEnd = await commitLocatorEnd(snapshot.source, snapshot.commit);

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
        await requireFullVerification(next, "archive_recovery_validation_failed");
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
      if (baseLocatorEnd !== null) {
        throw new ArchiveFormatError(
          "archive_recovery_not_available",
          "No complete unpublished generation follows the latest published generation.",
        );
      }
      // A complete commit without a locator is recoverable by publishing it.
      const frame = await readFrameAt(snapshot.source, snapshot.commit.offset);
      const publicationSource = new CompositeArchiveSource(
        new PrefixArchiveSource(snapshot.source, BigInt(frame.endOffset)),
        new MemoryArchiveSource(encodeLocator(snapshot.commit.offset, snapshot.commit.generation)),
      );
      const published = await snapshot.openGeneration(
        publicationSource,
        snapshot.commit,
        new Map(snapshot.allIndexEntries()),
        publicationSource.size,
      );
      try {
        await requireFullVerification(published, "archive_recovery_validation_failed");
      } catch (error) {
        published.lock();
        throw error;
      }
      return {
        snapshot: published,
        recoveredGeneration: snapshot.commit.generation,
        recoveredGenerations: 0,
        discardedTrailingBytes: snapshot.source.size - BigInt(frame.endOffset),
      };
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

async function commitLocatorEnd(
  source: ArchiveByteSource,
  commit: CommitInfo,
): Promise<bigint | null> {
  try {
    return await commitPublishedEndOffset(source, commit);
  } catch (error) {
    if (error instanceof ArchiveFormatError && error.code === "archive_locator_invalid") {
      return null;
    }
    throw error;
  }
}

export interface ArchiveRecoveryInspection {
  archiveHeaderValid: boolean;
  recoveryAssessmentComplete: boolean;
  headerRepairCandidate: boolean;
  headerRepairAvailable: boolean;
  headerRepairGeneration: bigint;
  committedGeneration: bigint;
  candidateGeneration: bigint;
  recoverableGeneration: bigint;
  trailingBytes: bigint;
  hasUnpublishedCommit: boolean;
  encrypted: boolean;
  requiresPassphrase: boolean;
  recoverable: boolean;
  recoveredGenerations: number;
  discardedTrailingBytes: bigint;
  issues: string[];
}

/** Inspect recovery state without modifying the source. */
export async function inspectArchiveRecovery(
  source: ArchiveByteSource,
  passphrase?: string,
): Promise<ArchiveRecoveryInspection> {
  const issues: string[] = [];
  let snapshot: ArchiveSnapshot | undefined;
  let archiveHeaderValid = true;
  let headerRepairCandidate = false;
  let headerRepairAvailable = false;
  let headerRepairGeneration = 0n;
  let requiresPassphrase = false;
  let encrypted: boolean;
  try {
    snapshot = await openArchiveSourceForRecovery(source);
  } catch (error) {
    if (
      error instanceof ArchiveFormatError &&
      (error.code === "archive_header_checksum" || error.code === "archive_magic_invalid")
    ) {
      archiveHeaderValid = false;
      headerRepairCandidate = true;
      try {
        snapshot =
          error.code === "archive_header_checksum"
            ? await recoverChecksumDamagedArchiveHeader(source, passphrase)
            : await recoverMagicDamagedArchiveHeader(source, passphrase);
        try {
          await requireFullVerification(snapshot, "archive_header_recovery_unverified");
          headerRepairAvailable = true;
          headerRepairGeneration = snapshot.commit.generation;
          issues.push(
            "The header is damaged, but the reconstructed identity and complete archive passed full verification. Create a separate repaired copy with 'archive repair FILE --output COPY.tux --confirm-sensitive'.",
          );
        } catch (verificationError) {
          issues.push(
            `Header reconstruction passed only partial verification: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
          );
          snapshot.lock();
          snapshot = undefined;
        }
      } catch (recoveryError) {
        if (
          recoveryError instanceof ArchiveFormatError &&
          recoveryError.code === "archive_locked"
        ) {
          requiresPassphrase = true;
          issues.push(
            "A checksum-only header repair candidate was found. Supply the archive passphrase to complete verification, then create a separate repaired copy with 'archive repair'.",
          );
        } else {
          issues.push(
            `The archive header is damaged and could not be reconstructed safely: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          );
        }
        issues.push(
          "Restore the fixed header from a known-good backup before in-place recovery; no archive bytes were changed.",
        );
      }
    } else {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  const frames = await scanForCommitFrames(source);
  const base = snapshot?.commit;
  if (snapshot) encrypted = snapshot.encrypted;
  else {
    try {
      const headerBytes = await source.read(0n, ARCHIVE_HEADER_SIZE);
      encrypted = (readLittle(headerBytes, 40, 8) & CAPABILITY_ENCRYPTED) !== 0n;
    } catch {
      encrypted = false;
    }
  }
  const afterBase = base ? frames.filter((frame) => frame.offset > base.offset) : frames;
  const candidateGeneration = afterBase.reduce(
    (maximum, frame) => (frame.generation > maximum ? frame.generation : maximum),
    0n,
  );

  let recoverable = false;
  let recoverableGeneration = 0n;
  let recoveredGenerations = 0;
  let discardedTrailingBytes = 0n;
  if (snapshot) {
    if (snapshot.locked) {
      requiresPassphrase = true;
      issues.push(
        "A passphrase is required to authenticate and verify the unpublished generation.",
      );
    } else {
      try {
        const recovery = await recoverUnpublishedCommit(snapshot);
        recoverable = true;
        recoverableGeneration = recovery.recoveredGeneration;
        recoveredGenerations = recovery.recoveredGenerations;
        discardedTrailingBytes = recovery.discardedTrailingBytes;
        recovery.snapshot.lock();
      } catch (error) {
        if (
          !(error instanceof ArchiveFormatError) ||
          error.code !== "archive_recovery_not_available"
        ) {
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  const trailingBytes = snapshot ? source.size - snapshot.publishedEndOffset : 0n;
  if (snapshot && trailingBytes > 0n && afterBase.length === 0) {
    issues.push(
      "Trailing archive bytes do not contain a complete unpublished commit; they were left untouched.",
    );
  }
  if (snapshot && afterBase.length > 0 && !recoverable) {
    issues.push(
      "Complete commit frames were found after the selected generation, but none passed full verification.",
    );
  }
  const result: ArchiveRecoveryInspection = {
    archiveHeaderValid,
    recoveryAssessmentComplete: archiveHeaderValid || headerRepairAvailable,
    headerRepairCandidate,
    headerRepairAvailable,
    headerRepairGeneration,
    committedGeneration: base?.generation ?? 0n,
    candidateGeneration,
    recoverableGeneration,
    trailingBytes,
    hasUnpublishedCommit: afterBase.length > 0,
    encrypted,
    requiresPassphrase,
    recoverable,
    recoveredGenerations,
    discardedTrailingBytes,
    issues,
  };
  snapshot?.lock();
  return result;
}

/** Return a view truncated to the last published generation without touching the source. */
export async function discardUncommittedTail(
  snapshot: ArchiveSnapshot,
): Promise<{ snapshot: ArchiveSnapshot; discardedBytes: bigint }> {
  if (snapshot.locked) {
    throw new ArchiveFormatError(
      "archive_locked",
      "Unlock this archive before discarding uncommitted data.",
    );
  }
  if (snapshot.source.size <= snapshot.publishedEndOffset) {
    return { snapshot, discardedBytes: 0n };
  }
  const prefix = new PrefixArchiveSource(snapshot.source, snapshot.publishedEndOffset);
  const truncated = await openArchiveSourceForRecovery(prefix);
  try {
    await requireFullVerification(truncated, "archive_recovery_validation_failed");
  } catch (error) {
    truncated.lock();
    throw error;
  }
  return {
    snapshot: truncated,
    discardedBytes: snapshot.source.size - snapshot.publishedEndOffset,
  };
}

export interface ArchiveCompactionResult {
  snapshot: ArchiveSnapshot;
  originalBytes: bigint;
  compactedBytes: bigint;
  preservedRecords: number;
  prunedAssetRecords: number;
}

export interface ArchiveTrashPurgeReference {
  recordId: string;
  recordType: string;
  label: string;
  fields: string[];
}

export interface ArchiveTrashPurgeBlocker {
  recordId: string;
  recordType: string;
  label: string;
  references: ArchiveTrashPurgeReference[];
}

export interface ArchiveTrashPurgePlan {
  generation: string;
  deletedRecords: number;
  blockers: ArchiveTrashPurgeBlocker[];
  opaqueRecords: number;
}

export interface ArchiveRepairResult extends ArchiveCompactionResult {
  selectedGeneration: bigint;
  discardedTrailingBytes: bigint;
  discardedRegionStart: bigint;
  discardedRegionEnd: bigint;
  discardedRecordFrames: number;
  discardedRecordFrameBytes: bigint;
  unattributedBytes: bigint;
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
          const discarded = await summarizeDiscardedRegion(
            snapshot.source,
            publishedEndOffset,
            snapshot.source.size,
          );
          return {
            ...compacted,
            selectedGeneration: candidate.commit.generation,
            discardedTrailingBytes: snapshot.source.size - publishedEndOffset,
            discardedRegionStart: publishedEndOffset,
            discardedRegionEnd: snapshot.source.size,
            discardedRecordFrames: discarded.recordFrames,
            discardedRecordFrameBytes: discarded.recordFrameBytes,
            unattributedBytes: discarded.unattributedBytes,
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

const trashPurgeRecordTypes = [
  RecordType.student,
  RecordType.session,
  RecordType.audioChunk,
  RecordType.transcriptSegment,
  RecordType.annotation,
  RecordType.assetMetadata,
  RecordType.assetBlob,
  RecordType.evidenceNode,
  RecordType.evidenceEdge,
  RecordType.guide,
  RecordType.settings,
  RecordType.aiJob,
  RecordType.encryption,
  RecordType.waveformIndex,
] as const;

const trashPurgeReferenceTypes = new Set<number>([
  RecordType.student,
  RecordType.session,
  RecordType.audioChunk,
  RecordType.transcriptSegment,
  RecordType.annotation,
  RecordType.assetMetadata,
  RecordType.assetBlob,
  RecordType.evidenceNode,
  RecordType.evidenceEdge,
  RecordType.guide,
  RecordType.settings,
  RecordType.aiJob,
  RecordType.waveformIndex,
]);

function trashPurgeRecordLabel(record: ArchiveRecord): string {
  const fields = record.fields;
  return (
    fields.get("display_name") ??
    fields.get("title") ??
    fields.get("label") ??
    fields.get("original_name") ??
    fields.get("name") ??
    fields.get("content") ??
    fields.get("text") ??
    fields.get("record_role") ??
    `${recordTypeName(record.type)} record`
  ).slice(0, 120);
}

/** Inspect Trash before publishing a destructive purge. */
export async function planTrashPurge(snapshot: ArchiveSnapshot): Promise<ArchiveTrashPurgePlan> {
  if (snapshot.locked) {
    throw new ArchiveFormatError("archive_locked", "Unlock this archive before purging Trash.");
  }
  const records = (
    await Promise.all(trashPurgeRecordTypes.map((type) => snapshot.listRecordMetadata(type, true)))
  ).flat();
  const deleted = records.filter((record) => record.fields.get("_deleted") === "true");
  const deletedIds = new Set(deleted.map((record) => record.id.toLowerCase()));
  const referencesByTarget = new Map<string, Map<string, ArchiveTrashPurgeReference>>();

  for (const record of records) {
    if (!trashPurgeReferenceTypes.has(record.type) || record.fields.get("_deleted") === "true") {
      continue;
    }
    for (const [name, value] of record.fields) {
      if (!name.endsWith("_id") && !name.endsWith("_ids")) continue;
      if (name.startsWith("_trash_") || !value) continue;
      const ids = name.endsWith("_ids") ? value.split(",") : [value];
      for (const rawId of ids) {
        const targetId = rawId.trim().toLowerCase();
        if (!deletedIds.has(targetId)) continue;
        let references = referencesByTarget.get(targetId);
        if (!references) {
          references = new Map();
          referencesByTarget.set(targetId, references);
        }
        const referenceKey = `${record.type}:${record.id.toLowerCase()}`;
        const existing = references.get(referenceKey);
        const fields = existing ? [...existing.fields, name] : [name];
        references.set(referenceKey, {
          recordId: record.id,
          recordType: recordTypeName(record.type),
          label: trashPurgeRecordLabel(record),
          fields: [...new Set(fields)],
        });
      }
    }
  }

  const byId = new Map(deleted.map((record) => [record.id.toLowerCase(), record]));
  const blockers = [...referencesByTarget.entries()]
    .map(([recordId, references]) => {
      const record = byId.get(recordId)!;
      return {
        recordId: record.id,
        recordType: recordTypeName(record.type),
        label: trashPurgeRecordLabel(record),
        references: [...references.values()].sort((left, right) =>
          left.label.localeCompare(right.label),
        ),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  const opaqueRecords = [...snapshot.allIndexEntries().keys()].filter((key) =>
    key.startsWith("UNKNOWN:"),
  ).length;

  return {
    generation: snapshot.commit.generation.toString(),
    deletedRecords: deleted.length,
    blockers,
    opaqueRecords,
  };
}

/** Build a compacted snapshot that permanently removes deleted records and their revisions. */
export async function purgeTrashedArchiveSnapshot(
  snapshot: ArchiveSnapshot,
): Promise<ArchiveCompactionResult> {
  const plan = await planTrashPurge(snapshot);
  if (plan.blockers.length > 0) {
    const blocker = plan.blockers[0]!;
    throw new ArchiveFormatError(
      "trash_purge_reference_blocked",
      `“${blocker.label}” is still linked from an active record. Restore it or remove the active link before purging Trash.`,
    );
  }
  if (plan.opaqueRecords > 0) {
    throw new ArchiveFormatError(
      "trash_purge_opaque_records",
      `${plan.opaqueRecords} record(s) from a newer archive version cannot be checked for active links. Open this archive in a compatible version before purging Trash.`,
    );
  }
  if (snapshot.source.size !== snapshot.publishedEndOffset) {
    throw new ArchiveFormatError(
      "archive_recovery_required",
      "This archive has uncommitted trailing data. Review or recover it before purging Trash.",
    );
  }

  const cleanupRecords: ArchiveRecord[] = [];
  for (const record of (
    await Promise.all(trashPurgeRecordTypes.map((type) => snapshot.listRecordMetadata(type, true)))
  ).flat()) {
    if (record.fields.get("_deleted") === "true") continue;
    const fields = new Map(record.fields);
    let changed = false;
    const isJournalNotes = fields.get("record_role") === "journal-notes";
    for (const key of fields.keys()) {
      if (
        key.startsWith("_trash_restore_") ||
        key === "_trash_session_group_id" ||
        key === "_trash_guide_group_id" ||
        (isJournalNotes &&
          (key.startsWith("removed_block_") ||
            key === "last_removed_block_id" ||
            key === "last_removed_block_kind" ||
            key === "last_removed_block_text" ||
            key === "last_removed_block_index"))
      ) {
        fields.delete(key);
        changed = true;
      }
    }
    if (isJournalNotes && fields.has("removed_block_count")) {
      if (fields.get("removed_block_count") !== "0") changed = true;
      fields.set("removed_block_count", "0");
    }
    if (changed) {
      fields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
      cleanupRecords.push({ ...record, fields });
    }
  }

  const cleaned = await appendRecords(snapshot, cleanupRecords);
  try {
    return await rebuildArchiveSnapshot(cleaned, false, false, true);
  } finally {
    if (cleaned !== snapshot) cleaned.lock();
  }
}

function validateEncryptionPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string") {
    throw new ArchiveFormatError(
      "crypto_input_invalid",
      "Passphrase must contain valid Unicode text.",
    );
  }
  const bytes = encoder.encode(passphrase);
  try {
    let validUnicode = false;
    try {
      validUnicode = decoder.decode(bytes) === passphrase;
    } catch {
      // TextEncoder replaces unpaired surrogates, which do not round-trip as valid Unicode.
    }
    if (!validUnicode) {
      throw new ArchiveFormatError(
        "crypto_input_invalid",
        "Passphrase must contain valid Unicode text.",
      );
    }
    if (bytes.byteLength === 0 || bytes.byteLength > 4096) {
      throw new ArchiveFormatError(
        "crypto_input_invalid",
        "Passphrase must contain between 1 and 4096 UTF-8 bytes.",
      );
    }
    if (bytes.byteLength < 12) {
      throw new ArchiveFormatError(
        "archive_passphrase_too_short",
        "Archive passphrases must contain at least 12 UTF-8 bytes.",
      );
    }
  } finally {
    bytes.fill(0);
  }
}

async function rekeyEncryptedArchiveSnapshot(
  snapshot: ArchiveSnapshot,
  currentPassphrase: string,
  newPassphrase: string,
): Promise<ArchiveSnapshot> {
  return encryptArchiveSnapshotWithFreshKey(snapshot, newPassphrase, currentPassphrase);
}

async function encryptArchiveSnapshotWithFreshKey(
  snapshot: ArchiveSnapshot,
  newPassphrase: string,
  currentPassphrase?: string,
): Promise<ArchiveSnapshot> {
  const isRekey = currentPassphrase !== undefined;
  if (isRekey && !snapshot.encrypted) {
    throw new ArchiveFormatError("archive_not_encrypted", "This archive is not encrypted.");
  }
  if (snapshot.encrypted && snapshot.locked) {
    throw new ArchiveFormatError(
      "archive_locked",
      isRekey
        ? "Unlock this archive before changing its passphrase."
        : "Unlock this archive before changing its encryption.",
    );
  }
  if (!isRekey && snapshot.encrypted) {
    throw new ArchiveFormatError("archive_already_encrypted", "This archive is already encrypted.");
  }
  if (snapshot.source.size !== snapshot.publishedEndOffset) {
    throw new ArchiveFormatError(
      "archive_recovery_required",
      isRekey
        ? "This archive has uncommitted trailing data. Review or recover it before changing its passphrase."
        : "This archive has uncommitted trailing data. Review or recover it before changing its encryption.",
    );
  }
  validateEncryptionPassphrase(newPassphrase);
  if (isRekey && currentPassphrase === newPassphrase) {
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
  if (isRekey && previousEnvelopeOffset === undefined) {
    throw new ArchiveFormatError(
      "archive_encryption_metadata_missing",
      "Encrypted archive is missing its key-wrapping metadata.",
    );
  }
  if (!isRekey && previousEnvelopeOffset !== undefined) {
    throw new ArchiveFormatError(
      "archive_encryption_metadata_invalid",
      "Plaintext archive contains encryption metadata that cannot be safely replaced.",
    );
  }
  if (!snapshot.allIndexEntries().has(manifestKey)) {
    throw new ArchiveFormatError("archive_manifest_missing", "Archive manifest is missing.");
  }

  const currentManifest = await snapshot.getRecord(RecordType.settings, archiveId);
  if (!currentManifest) {
    throw new ArchiveFormatError(
      "archive_metadata_missing",
      "Archive is missing required metadata.",
    );
  }
  if (currentPassphrase !== undefined) {
    const previousEnvelope = await snapshot.getRecord(RecordType.encryption, archiveId);
    if (!previousEnvelope) {
      throw new ArchiveFormatError(
        "archive_encryption_metadata_missing",
        "Encrypted archive is missing its key-wrapping metadata.",
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
  }
  await requireFullVerification(snapshot, "archive_encryption_source_invalid");
  if (!isSupportedManifest(currentManifest)) {
    throw new ArchiveFormatError("archive_manifest_missing", "Archive manifest is invalid.");
  }

  const dataKey = await ArchiveDataKey.createRandom();
  const encryptedHeader: ArchiveHeader = {
    ...snapshot.header,
    capabilities: snapshot.header.capabilities | CAPABILITY_ENCRYPTED,
  };
  const writer = new ArchiveSnapshot(
    snapshot.source,
    encryptedHeader,
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

    addSegment(encodeArchiveHeader(encryptedHeader));
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
    const relocatedOffsets = new Map<bigint, bigint>();
    if (previousEnvelopeOffset !== undefined) {
      relocatedOffsets.set(previousEnvelopeOffset, newEnvelopeOffset);
    }
    const primaryEntries: [string, bigint][] = [];
    const opaqueEntries: [string, bigint][] = [];
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
      else if (
        recordTypeName(frame.type) === "unknown" &&
        !SECONDARY_INDEX_PREFIXES.some((prefix) => key.startsWith(prefix))
      ) {
        opaqueEntries.push([key, offset]);
      }
    }
    const opaqueKeys = new Set(opaqueEntries.map(([key]) => key));
    primaryEntries.push(...opaqueEntries);
    primaryEntries.sort(([left], [right]) => compareKeys(left, right));
    let retainedRecordRevisions = 0;

    for (const [key, latestOffset] of primaryEntries) {
      const isOpaqueIndex = opaqueKeys.has(key);
      if (!isOpaqueIndex && key === envelopeKey) continue;
      if (isOpaqueIndex) {
        const frame = await readFrameAt(snapshot.source, latestOffset);
        if (snapshot.allIndexEntries().has(primaryIndexKey(frame.type, frame.id))) continue;
        if (relocatedOffsets.has(latestOffset)) continue;
      }
      const chain: {
        oldOffset: bigint;
        frame: ArchiveRecordFrame;
        record?: ArchiveRecord;
        opaquePayload?: Uint8Array;
      }[] = [];
      const visited = new Set<bigint>();
      let offset = latestOffset;
      let newer: ArchiveRecordFrame | undefined;
      while (offset !== 0n) {
        if (visited.has(offset)) {
          throw new ArchiveFormatError("revision_cycle", "Record revision chain contains a cycle.");
        }
        visited.add(offset);
        const frame = await readFrameAt(snapshot.source, offset);
        if (!isOpaqueIndex && key !== primaryIndexKey(frame.type, frame.id)) {
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
        const isOpaque = recordTypeName(frame.type) === "unknown";
        if (
          !isOpaque &&
          frame.type === RecordType.settings &&
          frame.id.toLowerCase() === archiveId.toLowerCase()
        ) {
          await snapshot.verifyRevisionFrame(frame);
        }
        const record = isOpaque
          ? undefined
          : decodeRecordPayload(
              frame.type,
              frame.id,
              frame.revision,
              frame.previousOffset,
              payload,
            );
        chain.push({
          oldOffset: offset,
          frame,
          ...(record ? { record } : { opaquePayload: payload.slice() }),
        });
        newer = frame;
        offset = frame.previousOffset;
      }

      let previousOffset = 0n;
      for (const revision of chain.reverse()) {
        const newOffset = cursor;
        if (revision.record) {
          const frame = await writer.encodeRecordFrameForAppend({
            ...revision.record,
            previousOffset,
          });
          addSegment(frame);
        } else if (revision.opaquePayload) {
          const opaquePayload = revision.opaquePayload;
          try {
            const encodedPayload = compressRecordPayload(opaquePayload);
            try {
              const protectedPayload = await dataKey.encryptRecordPayload(encodedPayload.bytes, {
                archiveId,
                type: revision.frame.type,
                recordId: revision.frame.id,
                revision: revision.frame.revision,
                previousOffset,
                codec: encodedPayload.codec,
              });
              addSegment(
                encodeRecordFrame(
                  {
                    type: revision.frame.type,
                    id: revision.frame.id,
                    revision: revision.frame.revision,
                    previousOffset,
                  },
                  protectedPayload,
                  encodedPayload.codec,
                  1,
                ),
              );
            } finally {
              if (encodedPayload.bytes !== opaquePayload) encodedPayload.bytes.fill(0);
            }
          } finally {
            opaquePayload.fill(0);
          }
        } else {
          throw new ArchiveFormatError(
            "archive_encryption_verification_failed",
            "An opaque record payload could not be retained during encryption.",
          );
        }
        relocatedOffsets.set(revision.oldOffset, newOffset);
        previousOffset = newOffset;
        retainedRecordRevisions += 1;
      }
    }

    const retainedPrimary: { key: string; latestOffset: bigint }[] = [];
    for (const [key, offset] of primaryEntries) {
      if (key === envelopeKey) continue;
      if (opaqueKeys.has(key)) {
        const frame = await readFrameAt(snapshot.source, offset);
        const primaryOffset = snapshot.allIndexEntries().get(primaryIndexKey(frame.type, frame.id));
        retainedPrimary.push({ key, latestOffset: primaryOffset ?? offset });
        continue;
      }
      retainedPrimary.push({ key, latestOffset: offset });
    }
    const relocatedIndex = await rebuildRetainedIndex(
      snapshot,
      snapshot.allIndexEntries(),
      retainedPrimary,
      relocatedOffsets,
      new Set(),
      new Set([envelopeKey]),
    );
    relocatedIndex.set(envelopeKey, newEnvelopeOffset);
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
      recordCount: BigInt(retainedRecordRevisions + 1),
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
    const encrypted = new ArchiveSnapshot(
      source,
      opened.header,
      opened.commit,
      new Map(opened.allIndexEntries()),
      opened.publishedEndOffset,
      dataKey.clone(),
    );
    try {
      await encrypted.verifyEncryptionAuthentication();
      await verifyArchiveSnapshot(encrypted);
      for (const [oldOffset, newOffset] of relocatedOffsets) {
        const oldFrame = await readFrameAt(snapshot.source, oldOffset);
        if (
          oldFrame.type === RecordType.encryption &&
          oldFrame.id.toLowerCase() === archiveId.toLowerCase()
        ) {
          continue;
        }
        const newFrame = await readFrameAt(source, newOffset);
        if (
          newFrame.type === RecordType.settings &&
          newFrame.id.toLowerCase() === archiveId.toLowerCase()
        ) {
          await encrypted.verifyRevisionFrame(newFrame);
        }
        const [oldPayload, newPayload] = await Promise.all([
          snapshot.decodeFramePayload(oldFrame),
          encrypted.decodeFramePayload(newFrame),
        ]);
        const expectedPreviousOffset =
          oldFrame.previousOffset === 0n ? 0n : relocatedOffsets.get(oldFrame.previousOffset);
        let contentMatches: boolean;
        if (recordTypeName(oldFrame.type) === "unknown") {
          contentMatches = bytesEqual(oldPayload, newPayload);
        } else {
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
          const oldFields = new Map(oldRecord.fields);
          const newFields = new Map(newRecord.fields);
          if (
            oldFrame.type === RecordType.settings &&
            oldFrame.id.toLowerCase() === archiveId.toLowerCase()
          ) {
            oldFields.delete("manifest_auth");
            newFields.delete("manifest_auth");
          }
          contentMatches =
            oldFields.size === newFields.size &&
            [...oldFields].every(([key, value]) => newFields.get(key) === value) &&
            bytesEqual(oldRecord.blob, newRecord.blob);
        }
        if (
          expectedPreviousOffset === undefined ||
          oldFrame.type !== newFrame.type ||
          oldFrame.id !== newFrame.id ||
          oldFrame.revision !== newFrame.revision ||
          newFrame.previousOffset !== expectedPreviousOffset ||
          !contentMatches
        ) {
          throw new ArchiveFormatError(
            isRekey
              ? "archive_rekey_verification_failed"
              : "archive_encryption_verification_failed",
            isRekey
              ? "A record revision changed while the encrypted archive was being re-keyed."
              : "A record revision changed while the archive was being encrypted.",
          );
        }
      }
      return encrypted;
    } catch (error) {
      encrypted.lock();
      throw error;
    }
  } finally {
    writer.lock();
    dataKey.dispose();
  }
}

/**
 * Rebuild indexes from the retained revisions. Known secondary aliases are
 * regenerated, while forward-compatible index keys are kept as opaque entries.
 */
async function rebuildRetainedIndex(
  snapshot: ArchiveSnapshot,
  originalIndex: ReadonlyMap<string, bigint>,
  retainedPrimary: readonly { key: string; latestOffset: bigint }[],
  relocatedOffsets: ReadonlyMap<bigint, bigint>,
  removedOffsets: ReadonlySet<bigint>,
  ignoredKeys: ReadonlySet<string> = new Set(),
): Promise<Map<string, bigint>> {
  const index = new Map<string, bigint>();
  const primaryKeys = new Set(retainedPrimary.map(({ key }) => key));
  for (const { key, latestOffset } of retainedPrimary) {
    const newOffset = relocatedOffsets.get(latestOffset);
    if (newOffset === undefined) {
      throw new ArchiveFormatError(
        "archive_compaction_index_unreachable",
        "A primary record revision cannot be retained during rewrite.",
      );
    }
    index.set(key, newOffset);
    const frame = await readFrameAt(snapshot.source, latestOffset);
    if (recordTypeName(frame.type) === "unknown") continue;
    const record = decodeRecordPayload(
      frame.type,
      frame.id,
      frame.revision,
      frame.previousOffset,
      await snapshot.decodeFramePayload(frame),
    );
    for (const alias of secondaryIndexKeys(record)) {
      const existing = index.get(alias);
      if (existing !== undefined && existing !== newOffset) {
        throw new ArchiveFormatError(
          "archive_compaction_index_conflict",
          `Secondary index '${alias}' would reference more than one record.`,
        );
      }
      index.set(alias, newOffset);
    }
  }
  for (const [key, oldOffset] of originalIndex) {
    if (primaryKeys.has(key) || ignoredKeys.has(key)) continue;
    if (SECONDARY_INDEX_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (removedOffsets.has(oldOffset)) continue;
    const newOffset = relocatedOffsets.get(oldOffset);
    if (newOffset === undefined) {
      throw new ArchiveFormatError(
        "archive_compaction_index_unreachable",
        "An index entry points to a revision that cannot be retained.",
      );
    }
    index.set(key, newOffset);
  }
  return index;
}

async function rebuildArchiveSnapshot(
  snapshot: ArchiveSnapshot,
  allowUnpublishedTail: boolean,
  pruneUnreferencedAssets = false,
  purgeDeletedRecords = false,
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
  await requireFullVerification(snapshot, "archive_compaction_source_invalid");

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
  const removedOffsets = new Set<bigint>();
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
    const orderedChain = chain.reverse();
    if (purgeDeletedRecords && recordTypeName(orderedChain.at(-1)!.frame.type) !== "unknown") {
      const latestFrame = await readFrameAt(snapshot.source, orderedChain.at(-1)!.offset);
      const latest = decodeRecordPayload(
        latestFrame.type,
        latestFrame.id,
        latestFrame.revision,
        latestFrame.previousOffset,
        await snapshot.decodeFramePayload(latestFrame),
      );
      if (latest.fields.get("_deleted") === "true") {
        for (const revision of orderedChain) {
          removedOffsets.add(revision.offset);
          retainedOffsets.delete(revision.offset);
        }
        continue;
      }
    }
    chains.push({ key: entry.key, frames: orderedChain });
  }

  // Future secondary keys may index opaque records without a primary UNKNOWN entry.
  const primaryKeys = new Set(primaryEntries.map(({ key }) => key));
  for (const [key, offset] of indexed) {
    if (primaryKeys.has(key)) continue;
    if (SECONDARY_INDEX_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    const latestFrame = await readFrameAt(snapshot.source, offset);
    if (recordTypeName(latestFrame.type) !== "unknown") continue;
    if (retainedOffsets.has(offset)) continue;
    const frames: { offset: bigint; frame: CompactionFrameInfo }[] = [];
    let cursor = offset;
    let newer: ArchiveRecordFrame | undefined;
    const visited = new Set<bigint>();
    while (cursor !== 0n) {
      if (visited.has(cursor) || retainedOffsets.has(cursor)) {
        throw new ArchiveFormatError(
          "archive_compaction_index_unreachable",
          "An opaque index entry shares a revision that cannot be retained safely.",
        );
      }
      visited.add(cursor);
      const frame = await readFrameAt(snapshot.source, cursor);
      await snapshot.decodeFramePayload(frame);
      if (
        recordTypeName(frame.type) !== "unknown" ||
        (newer !== undefined &&
          (frame.type !== newer.type ||
            frame.id !== newer.id ||
            frame.revision >= newer.revision)) ||
        (frame.previousOffset !== 0n && frame.previousOffset >= cursor)
      ) {
        throw new ArchiveFormatError(
          "revision_lineage_invalid",
          "An opaque secondary index points to an invalid revision chain.",
        );
      }
      const info: CompactionFrameInfo = {
        type: frame.type,
        id: frame.id,
        revision: frame.revision,
        previousOffset: frame.previousOffset,
        codec: frame.codec,
        flags: frame.flags,
        payloadLength: frame.payloadLength,
        payloadChecksum: frame.payloadChecksum,
        endOffset: frame.endOffset,
      };
      retainedOffsets.set(cursor, info);
      frames.push({ offset: cursor, frame: info });
      newer = frame;
      cursor = frame.previousOffset;
    }
    chains.push({ key, frames: frames.reverse() });
  }

  // Unknown record schemas can hold asset references that this version cannot inspect.
  // Refuse pruning in that case; ordinary compaction remains available.
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

  const relocatedIndex = await rebuildRetainedIndex(
    snapshot,
    indexed,
    chains.map((chain) => ({ key: chain.key, latestOffset: chain.frames.at(-1)!.offset })),
    relocatedOffsets,
    removedOffsets,
  );

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
    await requireFullVerification(compacted, "archive_compaction_verification_failed");
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

export interface ArchivePrimaryIndexRepairResult {
  snapshot: ArchiveSnapshot;
  sourceGeneration: bigint;
  recoveredRecords: number;
  recoveredRevisions: number;
}

/**
 * Recover a separate copy from a strictly contiguous, fully published v1 log
 * when index page payloads are damaged. The caller must save to a new path.
 * Encrypted and opaque formats are rejected because missing index state cannot
 * be authenticated or reconstructed without making assumptions about its schema.
 */
export async function rebuildDamagedPrimaryIndex(
  source: ArchiveByteSource,
): Promise<ArchivePrimaryIndexRepairResult> {
  if (source.size < BigInt(ARCHIVE_HEADER_SIZE) || source.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveFormatError(
      "archive_index_repair_unavailable",
      "The archive is truncated or too large to inspect safely.",
    );
  }
  const header = decodeArchiveHeader(await source.read(0n, ARCHIVE_HEADER_SIZE));
  if ((header.capabilities & CAPABILITY_ENCRYPTED) !== 0n) {
    throw new ArchiveFormatError(
      "archive_index_repair_encrypted",
      "Rebuilding a damaged encrypted index is not supported.",
    );
  }
  type Revision = { offset: bigint; frame: ArchiveRecordFrameHeader; record: ArchiveRecord };
  const revisions: Revision[] = [];
  const current = new Map<string, Revision>();
  let position = BigInt(ARCHIVE_HEADER_SIZE);
  let committedOffset = 0n;
  let publishedEnd = 0n;
  let generation = 0n;
  let pendingCount = 0n;
  while (position < source.size) {
    if (source.size - position < BigInt(RECORD_HEADER_SIZE)) {
      throw new ArchiveFormatError(
        "archive_index_repair_unpublished",
        "Archive has an incomplete frame or unpublished tail.",
      );
    }
    const rawHeader = await source.read(position, RECORD_HEADER_SIZE);
    const frameHeader = decodeRecordFrameHeader(rawHeader, Number(position));
    const frameLength =
      RECORD_HEADER_SIZE + frameHeader.payloadLength + ((8 - (frameHeader.payloadLength % 8)) % 8);
    const frameEnd = position + BigInt(frameLength);
    if (frameEnd > source.size)
      throw new ArchiveFormatError(
        "archive_index_repair_unpublished",
        "A frame extends past the archive boundary.",
      );
    if (frameHeader.type === RecordType.indexPage) {
      if (frameHeader.id !== ZERO_UUID || frameHeader.flags !== 0 || frameHeader.codec !== 0) {
        throw new ArchiveFormatError(
          "archive_index_repair_structure",
          "An index page has unsupported framing.",
        );
      }
      // Index payloads are the damaged portion; their validated frame header
      // gives the only boundary we are willing to skip.
      position = frameEnd;
      continue;
    }
    if (frameHeader.type === RecordType.commit) {
      const commit = await decodeCommit(source, position);
      if (
        commit.generation !== generation + 1n ||
        commit.previousOffset !== committedOffset ||
        commit.recordCount !== pendingCount
      ) {
        throw new ArchiveFormatError(
          "archive_index_repair_transaction",
          "Published transaction counts or commit links are inconsistent.",
        );
      }
      const locatorEnd = await commitPublishedEndOffset(source, commit);
      committedOffset = position;
      publishedEnd = locatorEnd;
      generation = commit.generation;
      pendingCount = 0n;
      position = locatorEnd;
      continue;
    }
    if (recordTypeName(frameHeader.type) === "unknown" || frameHeader.flags !== 0) {
      throw new ArchiveFormatError(
        "archive_index_repair_unknown",
        "Archive contains encrypted or unknown records whose indexes cannot be reconstructed safely.",
      );
    }
    const frame = await readFrameAt(source, position);
    const record = decodeRecordPayload(
      frame.type,
      frame.id,
      frame.revision,
      frame.previousOffset,
      decodeStoredPayload(frame),
    );
    const key = primaryIndexKey(frame.type, frame.id);
    const previous = current.get(key);
    if (
      (!previous && (frame.previousOffset !== 0n || frame.revision !== 1n)) ||
      (previous &&
        (frame.previousOffset !== previous.offset ||
          frame.revision !== previous.frame.revision + 1n))
    ) {
      throw new ArchiveFormatError(
        "archive_index_repair_lineage",
        "Record revisions are not a complete consecutive chain.",
      );
    }
    const revision = {
      offset: position,
      frame: frameHeader,
      record: { ...record, blob: new Uint8Array() },
    };
    revisions.push(revision);
    current.set(key, revision);
    pendingCount += 1n;
    position = frameEnd;
  }
  if (generation === 0n || pendingCount !== 0n || publishedEnd !== source.size) {
    throw new ArchiveFormatError(
      "archive_index_repair_unpublished",
      "No complete published transaction chain was found.",
    );
  }
  const manifest = current.get(primaryIndexKey(RecordType.settings, header.id))?.record;
  if (
    !manifest ||
    manifest.fields.get("record_role") !== "archive-manifest" ||
    manifest.fields.get("_deleted") === "true" ||
    manifest.fields.get("created_at_us") !== header.createdAtUs.toString()
  ) {
    throw new ArchiveFormatError(
      "archive_index_repair_manifest",
      "The archive identity does not match its retained manifest.",
    );
  }

  const headerBytes = encodeArchiveHeader(header);
  const emptyRoot = encodeRecordFrame(
    { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
    encodeIndexPage({ leaf: true, entries: [], separators: [], children: [] }),
  );
  const segments: CompactedArchiveSegment[] = [
    { kind: "static", offset: 0n, bytes: headerBytes },
    { kind: "static", offset: BigInt(headerBytes.length), bytes: emptyRoot },
  ];
  let cursor = BigInt(headerBytes.length + emptyRoot.length);
  const relocated = new Map<bigint, bigint>();
  for (const revision of revisions) {
    const frame = revision.frame;
    const previousOffset = frame.previousOffset === 0n ? 0n : relocated.get(frame.previousOffset);
    if (previousOffset === undefined)
      throw new ArchiveFormatError(
        "archive_index_repair_lineage",
        "A predecessor cannot be relocated.",
      );
    const frameLength =
      RECORD_HEADER_SIZE + frame.payloadLength + ((8 - (frame.payloadLength % 8)) % 8);
    const frameHeader = encodeRecordFrameHeader(
      { ...frame, previousOffset },
      frame.payloadLength,
      frame.codec,
      frame.flags,
      frame.payloadChecksum,
    );
    relocated.set(revision.offset, cursor);
    segments.push({
      kind: "frame",
      offset: cursor,
      originalOffset: revision.offset,
      frameLength,
      payloadLength: frame.payloadLength,
      header: frameHeader,
    });
    cursor += BigInt(frameLength);
  }
  const index = new Map<string, bigint>();
  for (const [key, revision] of current) index.set(key, relocated.get(revision.offset)!);
  for (const revision of revisions) {
    const key = primaryIndexKey(revision.frame.type, revision.frame.id);
    const latest = current.get(key)!;
    if (revision !== latest && revision.frame.type !== RecordType.guide) continue;
    const target = relocated.get(latest.offset)!;
    for (const alias of secondaryIndexKeys(revision.record)) {
      const existing = index.get(alias);
      if (existing !== undefined && existing !== target) {
        throw new ArchiveFormatError(
          "archive_index_repair_conflict",
          "Reconstructed secondary indexes conflict; no copy was created.",
        );
      }
      index.set(alias, target);
    }
  }
  const entries = [...index]
    .map(([key, valueOffset]) => ({ key, valueOffset }))
    .sort((left, right) => compareKeys(left.key, right.key));
  const tree = await buildIndexTree(entries, cursor);
  for (const frame of tree.frames) {
    segments.push({ kind: "static", offset: cursor, bytes: frame });
    cursor += BigInt(frame.length);
  }
  const commitOffset = cursor;
  const commitPayload = encodeCommitPayload({
    generation: 1n,
    previousOffset: 0n,
    rootOffset: tree.rootOffset,
    rootHash: await sha256(tree.rootPayload),
    transactionId: newUuid(),
    recordCount: BigInt(revisions.length),
  });
  const commit = encodeRecordFrame(
    { type: RecordType.commit, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
    commitPayload,
  );
  segments.push({ kind: "static", offset: cursor, bytes: commit });
  cursor += BigInt(commit.length);
  const locator = encodeLocator(commitOffset, 1n);
  segments.push({ kind: "static", offset: cursor, bytes: locator });
  cursor += BigInt(locator.length);
  const rebuilt = await openArchiveSource(new CompactedArchiveSource(source, segments, cursor));
  await verifyArchiveHistory(rebuilt);
  return {
    snapshot: rebuilt,
    sourceGeneration: generation,
    recoveredRecords: current.size,
    recoveredRevisions: revisions.length,
  };
}

export interface ArchiveIndexMigrationResult {
  snapshot: ArchiveSnapshot;
  addedEntries: number;
  conflictingEntries: number;
  schemaVersionsUpdated: boolean;
}

/** Recreate only the versioned legacy aliases whose manifests still request migration. */
async function backfillVersionedSecondaryIndexEntries(
  snapshot: ArchiveSnapshot,
  index: Map<string, bigint>,
  migrationFields?: ReadonlySet<string>,
): Promise<Set<string>> {
  const conflicts = new Set<string>();
  const migrations = migrationFields
    ? SECONDARY_INDEX_MIGRATIONS.filter(({ versionField }) => migrationFields.has(versionField))
    : SECONDARY_INDEX_MIGRATIONS;
  for (const migration of migrations) {
    for (const record of await snapshot.listRecordMetadata(migration.recordType, true)) {
      const primaryKey = primaryIndexKey(migration.recordType, record.id);
      const offset = index.get(primaryKey);
      if (offset === undefined) {
        throw new ArchiveFormatError(
          "archive_secondary_index_migration_failed",
          `A ${recordTypeName(migration.recordType)} record disappeared while its secondary index was being initialized.`,
        );
      }
      for (const alias of secondaryIndexKeys(record)) {
        if (!alias.startsWith(migration.indexPrefix)) continue;
        const existing = index.get(alias);
        if (existing === undefined) index.set(alias, offset);
        else if (existing !== offset) conflicts.add(migration.versionField);
      }
    }
  }
  return conflicts;
}

/**
 * Backfill missing secondary indexes for understood records. Existing aliases,
 * including forward-compatible and historical aliases, are preserved. A
 * conflicting versioned alias leaves its index family on the verified scan path.
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
  const conflictingVersionFields = new Set<string>();
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
        const migration = SECONDARY_INDEX_MIGRATIONS.find(({ indexPrefix }) =>
          alias.startsWith(indexPrefix),
        );
        if (migration) conflictingVersionFields.add(migration.versionField);
      }
    }
  }
  const manifest = await snapshot.getRecord(RecordType.settings, snapshot.header.id);
  if (!isSupportedManifest(manifest)) {
    throw new ArchiveFormatError(
      "archive_manifest_missing",
      "Archive manifest is missing or invalid.",
    );
  }
  const manifestKey = primaryIndexKey(RecordType.settings, snapshot.header.id);
  const manifestOffset = index.get(manifestKey);
  if (manifestOffset === undefined) {
    throw new ArchiveFormatError(
      "archive_manifest_missing",
      "Archive manifest index entry is missing.",
    );
  }
  const manifestFields = new Map(manifest.fields);
  for (const migration of SECONDARY_INDEX_MIGRATIONS) {
    manifestFields.set(
      migration.versionField,
      conflictingVersionFields.has(migration.versionField) ? "0" : "1",
    );
  }
  const versionFieldsChanged = SECONDARY_INDEX_MIGRATIONS.some(
    ({ versionField }) => manifest.fields.get(versionField) !== manifestFields.get(versionField),
  );
  if (addedEntries === 0 && !versionFieldsChanged) {
    return { snapshot, addedEntries, conflictingEntries, schemaVersionsUpdated: false };
  }

  const appendedFrames: Uint8Array[] = [];
  let cursor = snapshot.source.size;
  let recordCount = 0n;
  if (versionFieldsChanged) {
    const manifestFrame = await snapshot.encodeRecordFrameForAppend({
      ...manifest,
      fields: manifestFields,
      revision: manifest.revision + 1n,
      previousOffset: manifestOffset,
    });
    appendedFrames.push(manifestFrame);
    index.set(manifestKey, cursor);
    cursor += BigInt(manifestFrame.byteLength);
    recordCount += 1n;
  }
  const entries = [...index.entries()]
    .map(([key, valueOffset]) => ({ key, valueOffset }))
    .sort((left, right) => compareKeys(left.key, right.key));
  const tree = await buildIndexTree(
    entries,
    cursor,
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
    recordCount,
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
  const tail = concatBytes([
    ...appendedFrames,
    ...tree.frames,
    commit,
    encodeLocator(tree.endOffset, generation),
  ]);
  const source = new CompositeArchiveSource(snapshot.source, new MemoryArchiveSource(tail));
  const migrated = await snapshot.openNextGeneration(source);
  try {
    await verifyArchiveSnapshot(migrated);
    return {
      snapshot: migrated,
      addedEntries,
      conflictingEntries,
      schemaVersionsUpdated: versionFieldsChanged,
    };
  } catch (error) {
    migrated.lock();
    throw error;
  }
}

/** Stage and verify an asset transaction before exposing the resulting snapshot. */
export async function appendStagedAssetRecords(
  snapshot: ArchiveSnapshot,
  records: AsyncIterable<ArchiveRecord>,
  staging: ArchiveStaging,
): Promise<ArchiveSnapshot> {
  if (snapshot.locked)
    throw new ArchiveFormatError(
      "archive_locked",
      "Unlock the archive before importing materials.",
    );
  if (snapshot.source.size !== snapshot.publishedEndOffset)
    throw new ArchiveFormatError(
      "archive_recovery_required",
      "Review or recover trailing data before importing materials.",
    );
  const manifest = await snapshot.getRecord(RecordType.settings, snapshot.header.id);
  if (!isSupportedManifest(manifest))
    throw new ArchiveFormatError(
      "archive_manifest_missing",
      "Archive manifest is missing or invalid.",
    );
  const index = new Map(snapshot.allIndexEntries());
  const manifestFields = new Map(manifest.fields);
  for (const migration of SECONDARY_INDEX_MIGRATIONS) {
    manifestFields.set(migration.versionField, "1");
  }
  const legacySecondaryIndexFields = new Set(
    SECONDARY_INDEX_MIGRATIONS.filter(
      ({ versionField }) => manifest.fields.get(versionField) !== "1",
    ).map(({ versionField }) => versionField),
  );
  if (legacySecondaryIndexFields.size > 0) {
    const conflictingVersionFields = await backfillVersionedSecondaryIndexEntries(
      snapshot,
      index,
      legacySecondaryIndexFields,
    );
    for (const migration of SECONDARY_INDEX_MIGRATIONS) {
      manifestFields.set(
        migration.versionField,
        conflictingVersionFields.has(migration.versionField) ? "0" : "1",
      );
    }
  }
  const written = new Set<string>();
  let cursor = snapshot.source.size;
  let recordCount = 0n;
  let metadataCount = 0;
  let stageSource: ArchiveByteSource | undefined;
  let next: ArchiveSnapshot | undefined;
  try {
    for await (const input of records) {
      if (input.type !== RecordType.assetBlob && input.type !== RecordType.assetMetadata) {
        throw new ArchiveFormatError(
          "asset_import_record_invalid",
          "The material import contains an unsupported record type.",
        );
      }
      const key = primaryIndexKey(input.type, input.id);
      if (index.has(key) || written.has(key))
        throw new ArchiveFormatError(
          "record_duplicate",
          "The material import would overwrite an existing record.",
        );
      if (input.type === RecordType.assetMetadata) metadataCount += 1;
      const record = { ...input, id: input.id.toLowerCase(), revision: 1n, previousOffset: 0n };
      const frame = await snapshot.encodeRecordFrameForAppend(record);
      await staging.append(frame);
      index.set(key, cursor);
      written.add(key);
      for (const alias of secondaryIndexKeys(record)) {
        if (index.has(alias))
          throw new ArchiveFormatError(
            "asset_blob_index_invalid",
            "A material content index already exists.",
          );
        index.set(alias, cursor);
      }
      cursor += BigInt(frame.length);
      recordCount += 1n;
    }
    if (metadataCount === 0)
      throw new ArchiveFormatError(
        "asset_import_record_invalid",
        "A material import must contain at least one material record.",
      );
    const fields = new Map(manifestFields);
    fields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
    const manifestKey = primaryIndexKey(RecordType.settings, snapshot.header.id);
    const previousOffset = index.get(manifestKey);
    if (previousOffset === undefined)
      throw new ArchiveFormatError("archive_manifest_missing", "Archive manifest is missing.");
    const manifestFrame = await snapshot.encodeRecordFrameForAppend({
      ...manifest,
      fields,
      revision: manifest.revision + 1n,
      previousOffset,
    });
    await staging.append(manifestFrame);
    index.set(manifestKey, cursor);
    cursor += BigInt(manifestFrame.length);
    recordCount += 1n;
    const entries = [...index]
      .map(([key, valueOffset]) => ({ key, valueOffset }))
      .sort((left, right) => compareKeys(left.key, right.key));
    const tree = await buildIndexTree(
      entries,
      cursor,
      snapshot.encrypted
        ? (payload) => snapshot.authenticateEncryptedPayload("TUTORUX-INDEX-PAGE-V1", payload)
        : undefined,
    );
    for (const frame of tree.frames) await staging.append(frame);
    const generation = snapshot.commit.generation + 1n;
    const commitBody = encodeCommitPayload({
      generation,
      previousOffset: snapshot.commit.offset,
      rootOffset: tree.rootOffset,
      rootHash: await sha256(tree.rootPayload),
      transactionId: newUuid(),
      recordCount,
    });
    const payload = snapshot.encrypted
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
      payload,
    );
    await staging.append(commit);
    await staging.append(encodeLocator(tree.endOffset, generation));
    stageSource = await staging.seal();
    const source = new CompositeArchiveSource(snapshot.source, stageSource);
    next = await snapshot.openNextGeneration(source);
    await verifyArchiveSnapshot(next);
    for (const key of written) {
      const oldOffset = index.get(key);
      if (oldOffset === undefined || next.allIndexEntries().get(key) !== oldOffset)
        throw new ArchiveFormatError(
          "archive_write_verification_failed",
          "A staged material index could not be verified.",
        );
    }
    return next;
  } catch (error) {
    next?.lock();
    await stageSource?.close?.().catch(() => undefined);
    await staging.abort().catch(() => undefined);
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
  const storedManifest = await snapshot.getRecord(RecordType.settings, snapshot.header.id);
  const currentManifest = explicitManifest ?? storedManifest;
  if (!isSupportedManifest(currentManifest)) {
    throw new ArchiveFormatError(
      "archive_manifest_missing",
      "Archive manifest is missing or invalid.",
    );
  }
  for (const change of changes) {
    if (change.type !== RecordType.settings) continue;
    const credentialRecord = isCredentialSettingsRecord(change);
    const sensitiveMaterial = hasSensitiveCredentialMaterial(change);
    if (credentialRecord && !snapshot.encrypted) {
      throw new ArchiveFormatError(
        "credential_encryption_required",
        "Credential records can be stored only in an encrypted archive.",
      );
    }
    if (sensitiveMaterial && !credentialRecord) {
      throw new ArchiveFormatError(
        "sensitive_setting_key_rejected",
        "Credential-bearing settings must use the encrypted credential representation.",
      );
    }
  }
  const audioSessionIds = new Set<string>();
  for (const change of changes) {
    if (change.type !== RecordType.audioChunk) continue;
    const sessionId = change.fields.get("session_id")?.toLowerCase() ?? "";
    if (validArchiveUuid(sessionId)) audioSessionIds.add(sessionId);
    const previous = await snapshot.getRecord(RecordType.audioChunk, change.id);
    const identity = (record: ArchiveRecord): string =>
      `${record.fields.get("session_id")?.toLowerCase() ?? ""}\u0000${record.fields.get("track_id")?.toLowerCase() ?? ""}\u0000${record.fields.get("sequence_number") ?? ""}`;
    if (previous && identity(previous) !== identity(change)) {
      throw new ArchiveFormatError(
        "audio_chunk_identity_immutable",
        "An audio chunk's session, track, and sequence identity cannot change.",
      );
    }
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
  for (const migration of SECONDARY_INDEX_MIGRATIONS) {
    manifestFields.set(migration.versionField, "1");
  }
  const legacySecondaryIndexFields = new Set(
    SECONDARY_INDEX_MIGRATIONS.filter(
      ({ versionField }) => storedManifest?.fields.get(versionField) !== "1",
    ).map(({ versionField }) => versionField),
  );
  if (legacySecondaryIndexFields.size > 0) {
    const conflictingVersionFields = await backfillVersionedSecondaryIndexEntries(
      snapshot,
      index,
      legacySecondaryIndexFields,
    );
    for (const migration of SECONDARY_INDEX_MIGRATIONS) {
      manifestFields.set(
        migration.versionField,
        conflictingVersionFields.has(migration.versionField) ? "0" : "1",
      );
    }
  }
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
  if (audioSessionIds.size > 0) {
    manifestFields.set("audio_chunk_index_version", "1");
    for (const sessionId of audioSessionIds) {
      const key = primaryIndexKey(RecordType.session, sessionId);
      const changedSession = changesByKey.get(key);
      if (changedSession) {
        if (changedSession.fields.get("audio_chunk_index_version") !== "1") {
          const fields = new Map(changedSession.fields);
          fields.set("audio_chunk_index_version", "1");
          changesByKey.set(key, { ...changedSession, fields });
        }
        continue;
      }
      const storedSession = await snapshot.getRecord(RecordType.session, sessionId);
      if (!storedSession || storedSession.fields.get("audio_chunk_index_version") === "1") {
        continue;
      }
      const fields = new Map(storedSession.fields);
      fields.set("audio_chunk_index_version", "1");
      changesByKey.set(key, { ...storedSession, fields });
    }
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
  return verifyRecoveredArchiveHeader(source, corrected, passphrase);
}

/**
 * Recover a damaged magic value only when the stored header checksum matches
 * the header after restoring the specified v1 magic. The source is unchanged.
 */
export async function recoverMagicDamagedArchiveHeader(
  source: ArchiveByteSource,
  passphrase?: string,
): Promise<ArchiveSnapshot> {
  if (source.size < BigInt(ARCHIVE_HEADER_SIZE)) {
    throw new ArchiveFormatError(
      "archive_header_recovery_unavailable",
      "A complete archive header is required for magic repair.",
    );
  }
  const original = await source.read(0n, ARCHIVE_HEADER_SIZE);
  if (original.byteLength !== ARCHIVE_HEADER_SIZE) {
    throw new ArchiveFormatError(
      "archive_header_recovery_unavailable",
      "The archive header could not be read completely.",
    );
  }
  const expectedMagic = new TextEncoder().encode("TUTORUX\0");
  if (expectedMagic.every((byte, index) => original[index] === byte)) {
    throw new ArchiveFormatError(
      "archive_header_recovery_unavailable",
      "The archive magic is intact; magic repair is not applicable.",
    );
  }
  const corrected = original.slice();
  corrected.set(expectedMagic, 0);
  const view = new DataView(corrected.buffer, corrected.byteOffset, corrected.byteLength);
  if (view.getUint32(60, true) !== crc32(corrected.subarray(0, 60))) {
    throw new ArchiveFormatError(
      "archive_header_recovery_unavailable",
      "The stored checksum does not confirm the reconstructed archive magic.",
    );
  }
  return verifyRecoveredArchiveHeader(source, corrected, passphrase);
}

async function verifyRecoveredArchiveHeader(
  source: ArchiveByteSource,
  corrected: Uint8Array,
  passphrase?: string,
): Promise<ArchiveSnapshot> {
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

/** Open a recovery view that also accepts a complete commit frame without a locator. */
export async function openArchiveSourceForRecovery(
  source: ArchiveByteSource,
): Promise<ArchiveSnapshot> {
  try {
    return await openArchiveSource(source);
  } catch (error) {
    if (!(error instanceof ArchiveFormatError) || error.code !== "archive_commit_missing") {
      throw error;
    }
    if (source.size < BigInt(ARCHIVE_HEADER_SIZE)) throw error;
    const header = decodeArchiveHeader(await source.read(0n, ARCHIVE_HEADER_SIZE));
    const candidate = await findCommitCandidateWithoutLocator(source, header);
    if (!candidate) throw error;
    return new ArchiveSnapshot(
      source,
      header,
      candidate.commit,
      candidate.indexEntries,
      candidate.publishedEndOffset,
    );
  }
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

function canonicalSettingKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z\d]/gu, "");
}

function isSensitiveSettingKey(value: string): boolean {
  const normalized = canonicalSettingKey(value);
  if (CREDENTIAL_METADATA_FIELDS.has(normalized)) return false;
  if (CREDENTIAL_MARKERS.some((marker) => normalized.includes(marker))) return true;
  if (!normalized.includes("token")) return false;
  return !NON_SECRET_TOKEN_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isCredentialSettingsRecord(record: ArchiveRecord): boolean {
  if (record.type !== RecordType.settings) return false;
  let foundRole = false;
  for (const [name, value] of record.fields) {
    if (canonicalSettingKey(name) !== "recordrole") continue;
    foundRole = true;
    if (value.toLowerCase() !== "credential") return false;
  }
  return foundRole;
}

function hasSensitiveCredentialMaterial(record: ArchiveRecord): boolean {
  if (record.type !== RecordType.settings) return false;
  for (const [name, value] of record.fields) {
    if (isSensitiveSettingKey(name)) return true;
    if (canonicalSettingKey(name) === "key" && isSensitiveSettingKey(value)) return true;
  }
  return false;
}

function isSupportedManifest(record: ArchiveRecord | null): record is ArchiveRecord {
  if (record?.fields.get("record_role") === "archive-manifest") return true;
  return (
    record?.fields.get("record_role") === "tutorux-session-package" &&
    record.fields.get("package_version") === "1" &&
    validArchiveUuid(record.fields.get("source_session_id") ?? "")
  );
}

function audioSessionIndexKey(record: ArchiveRecord): string | null {
  if (record.type !== RecordType.audioChunk) return null;
  const sessionId = record.fields.get("session_id") ?? "";
  const trackId = record.fields.get("track_id") ?? "";
  const sequence = record.fields.get("sequence_number") ?? "";
  if (!validArchiveUuid(sessionId) || !validArchiveUuid(trackId) || !/^\d+$/u.test(sequence)) {
    return null;
  }
  const sequenceNumber = BigInt(sequence);
  if (sequenceNumber > 18_446_744_073_709_551_615n) return null;
  return `AUDIOSESSION:${sessionId.toLowerCase()}:${trackId.toLowerCase()}:${sequenceNumber.toString().padStart(20, "0")}`;
}

function guideSourceIndexKeys(record: ArchiveRecord): string[] {
  if (record.type !== RecordType.guide) return [];
  const keys = new Set<string>();
  const addSources = (value: string): void => {
    for (const sourceId of value.split(",")) {
      const normalized = sourceId.trim().toLowerCase();
      if (validArchiveUuid(normalized)) {
        keys.add(`GUIDESOURCE:${normalized}:${record.id.toLowerCase()}`);
      }
    }
  };
  for (const [field, value] of record.fields) {
    if (field.startsWith("section.") && field.endsWith(".source_ids")) addSources(value);
  }
  addSources(record.fields.get("source_index_history") ?? "");
  return [...keys];
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
    const key = audioSessionIndexKey(record);
    if (!key) {
      throw new ArchiveFormatError(
        "audio_chunk_metadata_invalid",
        "Audio chunks require valid session, track, and sequence identifiers.",
      );
    }
    keys.add(key);
  }
  if (record.type === RecordType.guide) {
    for (const key of guideSourceIndexKeys(record)) keys.add(key);
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

async function scanForCommitFrames(source: ArchiveByteSource): Promise<CommitInfo[]> {
  const frames: CommitInfo[] = [];
  const chunkSize = 64 * 1024;
  let chunkStart = BigInt(ARCHIVE_HEADER_SIZE);
  while (chunkStart < source.size) {
    const chunkEnd =
      source.size - chunkStart > BigInt(chunkSize) ? chunkStart + BigInt(chunkSize) : source.size;
    const bytes = await source.read(chunkStart, Number(chunkEnd - chunkStart));
    for (let local = 0; local + RECORD_HEADER_SIZE <= bytes.length; local += 8) {
      const absolute = chunkStart + BigInt(local);
      if (absolute >= chunkEnd) break;
      if (!hasMagic(bytes, local, "TXRC")) continue;
      try {
        const frame = await readFrameAt(source, absolute);
        if (frame.type !== RecordType.commit) continue;
        const commit = await decodeCommit(source, absolute);
        if (!frames.some((candidate) => candidate.offset === commit.offset)) {
          frames.push(commit);
        }
      } catch {
        continue;
      }
    }
    chunkStart = chunkEnd;
  }
  return frames.sort((left, right) => (left.offset < right.offset ? -1 : 1));
}

async function findCommitCandidateWithoutLocator(
  source: ArchiveByteSource,
  header: ArchiveHeader,
): Promise<PublishedCommitCandidate | null> {
  const frames = await scanForCommitFrames(source);
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const candidate = await findConsistentCommit(source, header, frames[index]!);
    if (candidate?.commit.offset !== frames[index]!.offset) continue;
    let publishedEndOffset: bigint;
    try {
      publishedEndOffset = await commitPublishedEndOffset(source, candidate.commit);
    } catch {
      const frame = await readFrameAt(source, candidate.commit.offset);
      publishedEndOffset = BigInt(frame.endOffset);
    }
    return { ...candidate, publishedEndOffset };
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
  stats?: { pageOffsets: bigint[] },
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
    stats?.pageOffsets.push(offset);
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
  const matches = (locator: Uint8Array): boolean =>
    validLocator(locator) &&
    readLittle(locator, 8, 8) === commit.offset &&
    readLittle(locator, 16, 8) === commit.generation;
  if (source.size - locatorOffset >= BigInt(LOCATOR_SIZE)) {
    const locator = await source.read(locatorOffset, LOCATOR_SIZE);
    if (matches(locator)) return locatorOffset + BigInt(LOCATOR_SIZE);
  }
  // Repair tolerates crash bytes between a complete commit and its locator.
  const chunkSize = 64 * 1024;
  let position = locatorOffset;
  while (position + BigInt(LOCATOR_SIZE) <= source.size) {
    const remaining = source.size - position;
    const length = Number(remaining > BigInt(chunkSize) ? BigInt(chunkSize) : remaining);
    const bytes = await source.read(position, length);
    for (let index = 0; index + LOCATOR_SIZE <= bytes.length; index += 1) {
      if (!hasMagic(bytes, index, "TUXLOC1\0")) continue;
      const locator = bytes.subarray(index, index + LOCATOR_SIZE);
      if (matches(locator)) {
        return position + BigInt(index) + BigInt(LOCATOR_SIZE);
      }
    }
    position += BigInt(length);
  }
  throw new ArchiveFormatError(
    "archive_locator_invalid",
    "A commit publication locator is invalid or points to a different generation.",
  );
}

interface DiscardedRegionSummary {
  recordFrames: number;
  recordFrameBytes: bigint;
  unattributedBytes: bigint;
}

async function summarizeDiscardedRegion(
  source: ArchiveByteSource,
  start: bigint,
  end: bigint,
): Promise<DiscardedRegionSummary> {
  if (start > end) {
    throw new ArchiveFormatError(
      "archive_repair_range_invalid",
      "The selected repair boundary exceeds the source archive size.",
    );
  }
  const summary: DiscardedRegionSummary = {
    recordFrames: 0,
    recordFrameBytes: 0n,
    unattributedBytes: 0n,
  };
  const chunkSize = 4 * 1024 * 1024;
  let offset = start;
  while (offset < end) {
    const remaining = end - offset;
    if (remaining < BigInt(RECORD_HEADER_SIZE)) {
      summary.unattributedBytes += remaining;
      break;
    }
    const scanLength = Number(remaining < BigInt(chunkSize) ? remaining : BigInt(chunkSize));
    const readLength = Number(
      remaining < BigInt(scanLength + RECORD_HEADER_SIZE - 8)
        ? remaining
        : BigInt(scanLength + RECORD_HEADER_SIZE - 8),
    );
    const bytes = await source.read(offset, readLength);
    let found = false;
    for (
      let index = 0;
      index < scanLength && index + RECORD_HEADER_SIZE <= bytes.length;
      index += 8
    ) {
      if (!hasMagic(bytes, index, "TXRC")) continue;
      let header;
      try {
        header = decodeRecordFrameHeader(
          bytes.subarray(index, index + RECORD_HEADER_SIZE),
          Number(offset) + index,
        );
      } catch {
        continue;
      }
      const padding = (8 - (header.payloadLength % 8)) % 8;
      const frameBytes = RECORD_HEADER_SIZE + header.payloadLength + padding;
      if (BigInt(frameBytes) > remaining - BigInt(index)) continue;
      summary.unattributedBytes += BigInt(index);
      summary.recordFrames += 1;
      summary.recordFrameBytes += BigInt(frameBytes);
      offset += BigInt(index + frameBytes);
      found = true;
      break;
    }
    if (found) continue;
    if (remaining <= BigInt(chunkSize)) {
      summary.unattributedBytes += remaining;
      break;
    }
    summary.unattributedBytes += BigInt(chunkSize);
    offset += BigInt(chunkSize);
  }
  return summary;
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
