import {
  ARCHIVE_HEADER_SIZE,
  CAPABILITY_ENCRYPTED,
  decodeArchiveHeader,
  decodeRecordFrame,
  decodeRecordFrameHeader,
  decodeRecordPayload,
  decodeStoredPayload,
  encodeArchiveHeader,
  encodeRecordFrame,
  encodeRecordPayload,
  newUuid,
  RecordType,
  recordTypeName,
  type ArchiveHeader,
  type ArchiveRecord,
  type ArchiveRecordFrame,
  type RecordTypeValue,
  ArchiveFormatError,
  crc32,
} from "./format";
import { CompositeArchiveSource, MemoryArchiveSource, type ArchiveByteSource } from "./source";

const LOCATOR_SIZE = 32;
const RECOVERY_WINDOW = 64 * 1024 * 1024;
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

export interface ArchiveManifest {
  displayName: string;
  description: string;
  createdAtUs: string;
}

export class ArchiveSnapshot {
  readonly encrypted: boolean;
  readonly locked: boolean;

  constructor(
    readonly source: ArchiveByteSource,
    readonly header: ArchiveHeader,
    readonly commit: CommitInfo,
    private readonly index: ReadonlyMap<string, bigint>,
  ) {
    this.encrypted = (header.capabilities & CAPABILITY_ENCRYPTED) !== 0n;
    this.locked = this.encrypted;
  }

  async getManifest(): Promise<ArchiveManifest> {
    const record = await this.getRecord(RecordType.settings, this.header.id);
    if (record?.fields.get("record_role") !== "archive-manifest") {
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
    const payload = decodeStoredPayload(frame);
    return decodeRecordPayload(frame.type, frame.id, frame.revision, frame.previousOffset, payload);
  }

  async getRecordByIndexKey(key: string): Promise<ArchiveRecord | null> {
    const offset = this.index.get(key);
    if (offset === undefined) return null;
    const frame = await readFrameAt(this.source, offset);
    const payload = decodeStoredPayload(frame);
    return decodeRecordPayload(frame.type, frame.id, frame.revision, frame.previousOffset, payload);
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
      const record = await readRecordMetadataAt(this.source, offset);
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
    const payload = decodeStoredPayload(frame);
    return decodeRecordPayload(frame.type, frame.id, frame.revision, frame.previousOffset, payload);
  }
}

export interface ArchiveVerificationResult {
  generation: string;
  currentRecords: number;
  liveRecords: number;
  deletedRecords: number;
  indexEntries: number;
}

/** Decode every current primary record, including trashed and forward-compatible record types. */
export async function verifyArchiveSnapshot(
  snapshot: ArchiveSnapshot,
): Promise<ArchiveVerificationResult> {
  if (snapshot.locked) {
    throw new ArchiveFormatError(
      "archive_locked",
      "Unlock this archive before verifying its records.",
    );
  }
  const typeNames = new Set(
    Object.values(RecordType).map((type) => recordTypeName(type).toUpperCase()),
  );
  typeNames.add("UNKNOWN");
  let currentRecords = 0;
  let liveRecords = 0;
  let deletedRecords = 0;
  for (const key of snapshot.allIndexEntries().keys()) {
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
    const record = await snapshot.getRecordByIndexKey(key);
    if (
      !record ||
      record.id.toLowerCase() !== id ||
      recordTypeName(record.type).toUpperCase() !== typeName
    ) {
      throw new ArchiveFormatError(
        "record_index_mismatch",
        "Archive index points to a different record.",
      );
    }
    currentRecords += 1;
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

/** Append a new immutable generation while preserving the original archive bytes. */
export async function appendRecords(
  snapshot: ArchiveSnapshot,
  changes: readonly ArchiveRecord[],
): Promise<ArchiveSnapshot> {
  if (snapshot.locked) {
    throw new ArchiveFormatError("archive_locked", "Unlock this archive before editing it.");
  }
  if (changes.length === 0) return snapshot;
  const previousCommitFrame = await readFrameAt(snapshot.source, snapshot.commit.offset);
  if (snapshot.source.size !== BigInt(previousCommitFrame.endOffset) + BigInt(LOCATOR_SIZE)) {
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
  if (!currentManifest || currentManifest.fields.get("record_role") !== "archive-manifest") {
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
      const previousPayload = decodeStoredPayload(previousFrame);
      const previousRecord = decodeRecordPayload(
        previousFrame.type,
        previousFrame.id,
        previousFrame.revision,
        previousFrame.previousOffset,
        previousPayload,
      );
      previousSecondaryKeys = secondaryIndexKeys(previousRecord);
    }
    const record: ArchiveRecord = {
      ...change,
      id: change.id.toLowerCase(),
      revision,
      previousOffset: previous ?? 0n,
    };
    const payload = encodeRecordPayload(record);
    const frame = encodeRecordFrame(record, payload);
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
  const tree = buildIndexTree(orderedEntries, cursor);
  tail.push(...tree.frames);
  cursor = tree.endOffset;
  const rootHash = await sha256(tree.rootPayload);
  const transactionId = newUuid();
  const commitOffset = cursor;
  const generation = snapshot.commit.generation + 1n;
  const commitPayload = encodeCommitPayload({
    generation,
    previousOffset: snapshot.commit.offset,
    rootOffset: tree.rootOffset,
    rootHash,
    transactionId,
    recordCount: BigInt(writeChanges.length),
  });
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
  return openArchiveSource(nextSource);
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
  return new ArchiveSnapshot(source, header, candidate.commit, candidate.indexEntries);
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
): Promise<CommitCandidate | null> {
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
        if (consistent) return consistent;
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
      payload = payload.subarray(0, payload.length - 32);
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

function buildIndexTree(entries: readonly IndexEntry[], initialOffset: bigint): BuiltIndexTree {
  const frames: Uint8Array[] = [];
  let offset = initialOffset;
  const appendPage = (
    page: IndexPage,
  ): { offset: bigint; firstKey: string | null; payload: Uint8Array } => {
    const payload = encodeIndexPage(page);
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
    firstLevel.push(appendPage({ leaf: true, entries: [], separators: [], children: [] }));
  } else {
    for (let start = 0; start < entries.length; start += pageCapacity) {
      const pageEntries = entries.slice(start, start + pageCapacity);
      firstLevel.push(
        appendPage({ leaf: true, entries: [...pageEntries], separators: [], children: [] }),
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
        appendPage({
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

  const rootPayload = encodeIndexPage({
    leaf: false,
    entries: [],
    separators: level.slice(1).map((child) => child.firstKey!),
    children: level.map((child) => child.offset),
  });
  const rootFrame = encodeRecordFrame(
    { type: RecordType.indexPage, id: ZERO_UUID, revision: 1n, previousOffset: 0n },
    rootPayload,
  );
  root = { offset, firstKey: level[0]?.firstKey ?? null, payload: rootPayload };
  frames.push(rootFrame);
  offset += BigInt(rootFrame.byteLength);
  return { rootOffset: root.offset, rootPayload, endOffset: offset, frames };
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

function validLocator(locator: Uint8Array): boolean {
  if (locator.length !== LOCATOR_SIZE || !hasMagic(locator, 0, "TUXLOC1\0")) return false;
  const view = new DataView(locator.buffer, locator.byteOffset, locator.byteLength);
  return (
    view.getUint32(24, true) === crc32(locator.subarray(0, 24)) && view.getUint32(28, true) === 0
  );
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
    throw new ArchiveFormatError(
      "audio_chunk_codec_unsupported",
      "Compressed audio chunks cannot be streamed by this playback path.",
    );
  }

  const prefixLength = Math.min(header.payloadLength, 64 * 1024);
  const prefix = await source.read(offset + 64n, prefixLength);
  if (
    prefix.length < 16 ||
    prefix[0] !== 0x54 ||
    prefix[1] !== 0x58 ||
    prefix[2] !== 0x4d ||
    prefix[3] !== 0x44
  ) {
    throw new ArchiveFormatError("record_payload_invalid", "Domain record payload is malformed.");
  }
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const schema = view.getUint16(4, true);
  const count = view.getUint16(6, true);
  const blobLength = view.getBigUint64(8, true);
  if (schema !== 1 || blobLength > BigInt(header.payloadLength - 16)) {
    throw new ArchiveFormatError("record_schema_unsupported", "Unsupported record schema.");
  }

  const fields = new Map<string, string>();
  let cursor = 16;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 6 > prefix.length) {
      throw new ArchiveFormatError(
        "record_field_limit",
        "Recording metadata exceeds the supported field size.",
      );
    }
    const keyLength = view.getUint16(cursor, true);
    const valueLength = view.getUint32(cursor + 2, true);
    cursor += 6;
    if (keyLength === 0 || cursor + keyLength + valueLength > prefix.length) {
      throw new ArchiveFormatError(
        "record_field_limit",
        "Recording metadata exceeds the supported field size.",
      );
    }
    let key: string;
    let value: string;
    try {
      key = decoder.decode(prefix.subarray(cursor, cursor + keyLength));
      cursor += keyLength;
      value = decoder.decode(prefix.subarray(cursor, cursor + valueLength));
      cursor += valueLength;
    } catch {
      throw new ArchiveFormatError("record_text_invalid", "Record text is not valid UTF-8.");
    }
    if (fields.has(key)) {
      throw new ArchiveFormatError("record_field_duplicate", "Record contains duplicate fields.");
    }
    fields.set(key, value);
  }
  if (BigInt(cursor) + blobLength !== BigInt(header.payloadLength)) {
    throw new ArchiveFormatError("record_blob_invalid", "Record blob length is inconsistent.");
  }
  return {
    type: header.type,
    id: header.id,
    revision: header.revision,
    previousOffset: header.previousOffset,
    fields,
    blob: new Uint8Array(),
  };
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
