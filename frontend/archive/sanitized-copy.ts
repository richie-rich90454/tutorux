import {
  appendRecords,
  createArchiveBytes,
  openArchiveBytes,
  verifyArchiveSnapshot,
  type ArchiveSnapshot,
} from "./archive";
import { ArchiveFormatError, RecordType, type ArchiveRecord, type RecordTypeValue } from "./format";
import { guideDraftFromRecord } from "../domain/guides";

const encoder = new TextEncoder();
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const COPY_TYPES = [
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
] as const;
const METADATA_TYPES = COPY_TYPES.filter((type) => type !== RecordType.audioChunk);

export interface SanitizedCopyOptions {
  includeStudents?: ReadonlySet<string>;
  excludeStudents?: ReadonlySet<string>;
  includeSessions?: ReadonlySet<string>;
  excludeSessions?: ReadonlySet<string>;
  includeRecordingTracks?: ReadonlySet<string>;
  excludeRecordingTracks?: ReadonlySet<string>;
  includeRecordings?: boolean;
  includePrivateAnnotations?: boolean;
  includeGenerationLogs?: boolean;
  includeCredentials?: boolean;
}

export interface SanitizedCopySummary {
  sourceGeneration: bigint;
  selectionFingerprint: string;
  students: number;
  sessions: number;
  annotations: number;
  assets: number;
  evidenceItems: number;
  guides: number;
  recordingTracks: number;
  recordings: number;
  generationLogs: number;
  credentials: number;
}

export interface SanitizedCopyResult {
  snapshot: ArchiveSnapshot;
  summary: SanitizedCopySummary;
}

/** Persist the byte range added since `previousSize` and reopen it for the next copy batch. */
export type SanitizedCopyCheckpoint = (
  snapshot: ArchiveSnapshot,
  previousSize: bigint,
) => Promise<ArchiveSnapshot>;

type RecordSet = Set<string>;
type RecordMap = Map<RecordTypeValue, ArchiveRecord[]>;

interface NormalizedOptions {
  includeStudents: RecordSet;
  excludeStudents: RecordSet;
  includeSessions: RecordSet;
  excludeSessions: RecordSet;
  includeRecordingTracks: RecordSet;
  excludeRecordingTracks: RecordSet;
  includeRecordings: boolean;
  includePrivateAnnotations: boolean;
  includeGenerationLogs: boolean;
  includeCredentials: boolean;
}

interface CopyPlan {
  metadata: RecordMap;
  keep: Map<RecordTypeValue, RecordSet>;
  metadataUpdates: Map<string, ArchiveRecord>;
  sourceRecordingTracksBySession: Map<string, RecordSet>;
  recordingTracksBySession: Map<string, RecordSet>;
  recordingChunksBySession: Map<string, number>;
  summary: SanitizedCopySummary;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function field(record: ArchiveRecord, name: string): string {
  return record.fields.get(name) ?? "";
}

function active(record: ArchiveRecord): boolean {
  return field(record, "_deleted") !== "true";
}

function splitIds(value: string): string[] {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function parseUuid(value: string): string | null {
  const id = value.toLowerCase();
  return UUID_PATTERN.test(id) ? id : null;
}

function normalizedSet(value: ReadonlySet<string> | undefined, name: string): RecordSet {
  const result = new Set<string>();
  for (const raw of value ?? []) {
    const id = parseUuid(raw);
    if (!id) {
      throw new ArchiveFormatError(
        "sanitized_copy_id_invalid",
        `The ${name} selection contains an invalid archive ID.`,
      );
    }
    result.add(id);
  }
  return result;
}

function normalizeOptions(options: SanitizedCopyOptions): NormalizedOptions {
  return {
    includeStudents: normalizedSet(options.includeStudents, "included student"),
    excludeStudents: normalizedSet(options.excludeStudents, "excluded student"),
    includeSessions: normalizedSet(options.includeSessions, "included session"),
    excludeSessions: normalizedSet(options.excludeSessions, "excluded session"),
    includeRecordingTracks: normalizedSet(
      options.includeRecordingTracks,
      "included recording track",
    ),
    excludeRecordingTracks: normalizedSet(
      options.excludeRecordingTracks,
      "excluded recording track",
    ),
    includeRecordings: options.includeRecordings ?? false,
    includePrivateAnnotations: options.includePrivateAnnotations ?? false,
    includeGenerationLogs: options.includeGenerationLogs ?? false,
    includeCredentials: options.includeCredentials ?? false,
  };
}

function selectedBy(id: string, include: RecordSet, exclude: RecordSet): boolean {
  return (include.size === 0 || include.has(id)) && !exclude.has(id);
}

function recordingsRequested(options: NormalizedOptions): boolean {
  return (
    options.includeRecordings ||
    options.includeRecordingTracks.size > 0 ||
    options.excludeRecordingTracks.size > 0
  );
}

function scoped(options: NormalizedOptions): boolean {
  return (
    options.includeStudents.size > 0 ||
    options.excludeStudents.size > 0 ||
    options.includeSessions.size > 0 ||
    options.excludeSessions.size > 0
  );
}

function keepSet(plan: CopyPlan, type: RecordTypeValue): RecordSet {
  let records = plan.keep.get(type);
  if (!records) {
    records = new Set();
    plan.keep.set(type, records);
  }
  return records;
}

function kept(plan: CopyPlan, type: RecordTypeValue): RecordSet {
  return plan.keep.get(type) ?? EMPTY_SET;
}

const EMPTY_SET: RecordSet = new Set();

function hasKeptRecord(plan: CopyPlan, type: RecordTypeValue, id: string): boolean {
  const parsed = parseUuid(id);
  return parsed !== null && kept(plan, type).has(parsed);
}

function sessionIsKept(plan: CopyPlan, record: ArchiveRecord): boolean {
  const sessionId = field(record, "session_id");
  return sessionId.length === 0 || hasKeptRecord(plan, RecordType.session, sessionId);
}

function hasKeptSession(plan: CopyPlan, record: ArchiveRecord): boolean {
  const sessionId = field(record, "session_id");
  return sessionId.length > 0 && hasKeptRecord(plan, RecordType.session, sessionId);
}

function privateAnnotation(record: ArchiveRecord): boolean {
  for (const [name, rawValue] of record.fields) {
    const fieldName = lower(name);
    if (
      !fieldName.includes("private") &&
      !fieldName.includes("privacy") &&
      !fieldName.includes("visibility")
    ) {
      continue;
    }
    const value = lower(rawValue);
    if (["true", "yes", "1", "private", "restricted"].includes(value)) return true;
  }
  return false;
}

function recordingAsset(record: ArchiveRecord): boolean {
  const role = lower(field(record, "record_role"));
  const mime = lower(field(record, "mime_type"));
  return (
    role === "recording-take" ||
    role.includes("audio") ||
    role.includes("waveform") ||
    role.includes("seek-index") ||
    field(record, "capture_source").length > 0 ||
    mime.startsWith("audio/")
  );
}

function canonicalSettingKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z\d]/gu, "");
}

const NON_SECRET_SETTING_KEYS = new Set([
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
const SENSITIVE_SETTING_MARKERS = [
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
const NON_SECRET_TOKEN_SETTINGS = [
  "tokenbudget",
  "tokensbudget",
  "tokencount",
  "tokenscount",
  "tokenlimit",
  "tokenslimit",
  "tokenusage",
  "tokensusage",
];

function sensitiveSettingKey(key: string): boolean {
  const normalized = canonicalSettingKey(key);
  if (NON_SECRET_SETTING_KEYS.has(normalized)) return false;
  if (SENSITIVE_SETTING_MARKERS.some((marker) => normalized.includes(marker))) return true;
  if (!normalized.includes("token")) return false;
  return !NON_SECRET_TOKEN_SETTINGS.some((suffix) => normalized.endsWith(suffix));
}

function hasSensitiveCredentialMaterial(record: ArchiveRecord): boolean {
  if (record.type !== RecordType.settings) return false;
  for (const [name, value] of record.fields) {
    if (sensitiveSettingKey(name)) return true;
    if (canonicalSettingKey(name) === "key" && sensitiveSettingKey(value)) return true;
  }
  return false;
}

function isCredential(record: ArchiveRecord): boolean {
  if (record.type !== RecordType.settings) return false;
  let foundRole = false;
  for (const [name, value] of record.fields) {
    if (canonicalSettingKey(name) !== "recordrole") continue;
    foundRole = true;
    if (lower(value) !== "credential") return false;
  }
  return foundRole;
}

function guideReferences(record: ArchiveRecord): {
  sources: string[];
  imageAssets: string[];
} | null {
  try {
    const guide = guideDraftFromRecord(record);
    const sources: string[] = [];
    const imageAssets: string[] = [];
    for (const section of guide.sections) {
      for (const block of section.blocks) {
        const text = block.text;
        const rawSources = block.sourceIds
          .split(/[\s,;]+/u)
          .map((id) => id.trim())
          .filter(Boolean);
        const inlinePattern = /\[\[source:([\da-f-]{36})\]\]/giu;
        for (const match of text.matchAll(inlinePattern)) rawSources.push(match[1]!);
        if (text.replace(inlinePattern, "").includes("[[source:")) return null;
        for (const id of rawSources) {
          const parsed = parseUuid(id);
          if (!parsed) return null;
          sources.push(parsed);
        }
        if (block.kind === "image" || block.kind === "figure" || text.startsWith("![")) {
          const image =
            /^!\[(?:\\.|[^\]])*\]\(asset:([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\)$/iu.exec(
              text,
            );
          const assetId = image ? parseUuid(image[1]!) : null;
          if (!assetId) return null;
          imageAssets.push(assetId);
          sources.push(assetId);
        }
      }
    }
    return { sources: [...new Set(sources)], imageAssets: [...new Set(imageAssets)] };
  } catch {
    return null;
  }
}

function selectionFingerprint(
  snapshot: ArchiveSnapshot,
  options: NormalizedOptions,
): Promise<string> {
  const canonical = [
    `archive=${snapshot.header.id.toLowerCase()}`,
    `recordings=${Number(options.includeRecordings)}`,
    `private=${Number(options.includePrivateAnnotations)}`,
    `generation=${Number(options.includeGenerationLogs)}`,
    `credentials=${Number(options.includeCredentials)}`,
    ...[
      ["include-students", options.includeStudents],
      ["exclude-students", options.excludeStudents],
      ["include-sessions", options.includeSessions],
      ["exclude-sessions", options.excludeSessions],
      ["include-recording-tracks", options.includeRecordingTracks],
      ["exclude-recording-tracks", options.excludeRecordingTracks],
    ].map(
      ([name, ids]) =>
        `${name as string}=${[...(ids as RecordSet)].sort().join(",")}${(ids as RecordSet).size ? "," : ""}`,
    ),
  ].join(";");
  return crypto.subtle
    .digest("SHA-256", encoder.encode(canonical))
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

async function makePlan(snapshot: ArchiveSnapshot, options: NormalizedOptions): Promise<CopyPlan> {
  if (snapshot.locked) {
    throw new ArchiveFormatError(
      "archive_locked",
      "Encrypted archives must be unlocked before making a sanitized copy.",
    );
  }
  if (snapshot.source.size !== snapshot.publishedEndOffset) {
    throw new ArchiveFormatError(
      "archive_recovery_required",
      "Recover or repair unpublished archive data before making a sanitized copy.",
    );
  }
  if (options.includeCredentials) {
    throw new ArchiveFormatError(
      "sanitized_copy_encryption_unavailable",
      "Including credentials requires a wire-compatible encrypted output archive, which is not available yet.",
    );
  }
  await verifyArchiveSnapshot(snapshot);
  const metadata: RecordMap = new Map();
  for (const type of METADATA_TYPES) {
    metadata.set(type, await snapshot.listRecordMetadata(type, true));
  }
  const summary: SanitizedCopySummary = {
    sourceGeneration: snapshot.commit.generation,
    selectionFingerprint: await selectionFingerprint(snapshot, options),
    students: 0,
    sessions: 0,
    annotations: 0,
    assets: 0,
    evidenceItems: 0,
    guides: 0,
    recordingTracks: 0,
    recordings: 0,
    generationLogs: 0,
    credentials: 0,
  };
  const plan: CopyPlan = {
    metadata,
    keep: new Map(),
    metadataUpdates: new Map(),
    sourceRecordingTracksBySession: new Map(),
    recordingTracksBySession: new Map(),
    recordingChunksBySession: new Map(),
    summary,
  };
  const records = (type: RecordTypeValue): ArchiveRecord[] => metadata.get(type) ?? [];

  const availableStudents = new Set(
    records(RecordType.student)
      .filter(active)
      .map((record) => record.id.toLowerCase()),
  );
  const availableSessions = new Set(
    records(RecordType.session)
      .filter(active)
      .map((record) => record.id.toLowerCase()),
  );
  for (const id of [...options.includeStudents, ...options.excludeStudents]) {
    if (!availableStudents.has(id)) {
      throw new ArchiveFormatError(
        "sanitized_copy_student_missing",
        "A selected or excluded student does not exist in the source archive.",
      );
    }
  }
  for (const id of [...options.includeSessions, ...options.excludeSessions]) {
    if (!availableSessions.has(id)) {
      throw new ArchiveFormatError(
        "sanitized_copy_session_missing",
        "A selected or excluded session does not exist in the source archive.",
      );
    }
  }
  for (const record of records(RecordType.student)) {
    const id = record.id.toLowerCase();
    if (active(record) && selectedBy(id, options.includeStudents, options.excludeStudents)) {
      keepSet(plan, RecordType.student).add(id);
    }
  }
  for (const record of records(RecordType.session)) {
    const id = record.id.toLowerCase();
    if (!active(record) || !selectedBy(id, options.includeSessions, options.excludeSessions))
      continue;
    const studentId = parseUuid(field(record, "student_id"));
    if (
      studentId &&
      availableStudents.has(studentId) &&
      !kept(plan, RecordType.student).has(studentId)
    ) {
      continue;
    }
    if (
      options.includeStudents.size > 0 &&
      (!studentId || !kept(plan, RecordType.student).has(studentId))
    ) {
      continue;
    }
    keepSet(plan, RecordType.session).add(id);
  }

  const isScoped = scoped(options);
  if (recordingsRequested(options)) {
    const chunks = await snapshot.listRecordMetadata(RecordType.audioChunk, true);
    const availableTracks = new Set<string>();
    for (const record of chunks) {
      if (!active(record)) continue;
      const trackId = parseUuid(field(record, "track_id"));
      const sessionId = parseUuid(field(record, "session_id"));
      if (!trackId || !sessionId) {
        throw new ArchiveFormatError(
          "sanitized_copy_audio_chunk_invalid",
          "A recording chunk has an invalid session or track reference.",
        );
      }
      if (!sessionIsKept(plan, record)) continue;
      availableTracks.add(trackId);
      const sourceTracks = plan.sourceRecordingTracksBySession.get(sessionId) ?? new Set<string>();
      sourceTracks.add(trackId);
      plan.sourceRecordingTracksBySession.set(sessionId, sourceTracks);
      if (!selectedBy(trackId, options.includeRecordingTracks, options.excludeRecordingTracks))
        continue;
      keepSet(plan, RecordType.audioChunk).add(record.id.toLowerCase());
      plan.recordingChunksBySession.set(
        sessionId,
        (plan.recordingChunksBySession.get(sessionId) ?? 0) + 1,
      );
      const tracks = plan.recordingTracksBySession.get(sessionId) ?? new Set<string>();
      tracks.add(trackId);
      plan.recordingTracksBySession.set(sessionId, tracks);
    }
    for (const id of [...options.includeRecordingTracks, ...options.excludeRecordingTracks]) {
      if (!availableTracks.has(id)) {
        throw new ArchiveFormatError(
          "sanitized_copy_recording_track_missing",
          "A selected or excluded recording track does not exist in the retained sessions.",
        );
      }
    }
  }

  for (const record of records(RecordType.annotation)) {
    if (
      active(record) &&
      sessionIsKept(plan, record) &&
      (!isScoped || hasKeptSession(plan, record)) &&
      (options.includePrivateAnnotations || !privateAnnotation(record))
    ) {
      keepSet(plan, RecordType.annotation).add(record.id.toLowerCase());
    }
  }
  for (const record of records(RecordType.transcriptSegment)) {
    if (
      active(record) &&
      sessionIsKept(plan, record) &&
      (!isScoped || hasKeptSession(plan, record))
    ) {
      keepSet(plan, RecordType.transcriptSegment).add(record.id.toLowerCase());
    }
  }

  const requestedAssets = new Set<string>();
  for (const type of [RecordType.annotation, RecordType.transcriptSegment]) {
    for (const record of records(type)) {
      if (!kept(plan, type).has(record.id.toLowerCase())) continue;
      for (const id of splitIds(field(record, "linked_asset_ids"))) {
        const parsed = parseUuid(id);
        if (parsed) requestedAssets.add(parsed);
      }
    }
  }
  for (const record of records(RecordType.settings)) {
    if (!active(record) || lower(field(record, "record_role")) !== "journal-entry") continue;
    const sessions = splitIds(field(record, "session_ids"));
    const inScope =
      !isScoped ||
      (sessions.length > 0 && sessions.some((id) => hasKeptRecord(plan, RecordType.session, id)));
    if (!inScope) continue;
    keepSet(plan, RecordType.settings).add(record.id.toLowerCase());
    for (const id of splitIds(field(record, "attachment_ids"))) {
      const parsed = parseUuid(id);
      if (parsed) requestedAssets.add(parsed);
    }
  }

  const retainedNotes = new Set<string>();
  for (const record of records(RecordType.session)) {
    if (!kept(plan, RecordType.session).has(record.id.toLowerCase())) continue;
    const notesId = parseUuid(field(record, "notes_document_id"));
    if (notesId) retainedNotes.add(notesId);
  }
  for (const record of records(RecordType.settings)) {
    if (
      kept(plan, RecordType.settings).has(record.id.toLowerCase()) &&
      lower(field(record, "record_role")) === "journal-entry"
    ) {
      const notesId = parseUuid(field(record, "notes_document_id"));
      if (notesId) retainedNotes.add(notesId);
    }
  }
  for (const record of records(RecordType.guide)) {
    if (!active(record)) continue;
    const refs = guideReferences(record);
    if (!refs) continue;
    const entryId = field(record, "entry_id");
    const sessionId = field(record, "session_id");
    if (
      isScoped &&
      sessionId.length === 0 &&
      (entryId.length === 0 || !hasKeptRecord(plan, RecordType.settings, entryId))
    ) {
      continue;
    }
    if (sessionId.length > 0 && !hasKeptRecord(plan, RecordType.session, sessionId)) continue;
    for (const id of refs.imageAssets) requestedAssets.add(id);
  }

  for (const record of records(RecordType.assetMetadata)) {
    if (!active(record) || !sessionIsKept(plan, record)) continue;
    if (recordingAsset(record)) {
      if (!recordingsRequested(options)) continue;
      const role = lower(field(record, "record_role"));
      if (role === "audio-track") {
        const sessionId = parseUuid(field(record, "session_id"));
        const trackId = parseUuid(field(record, "track_id"));
        const tracks = sessionId ? plan.recordingTracksBySession.get(sessionId) : undefined;
        if (!sessionId || !trackId || !tracks?.has(trackId)) continue;
      } else if (role === "recording-take") {
        const sessionId = parseUuid(field(record, "session_id"));
        const tracks = sessionId ? plan.recordingTracksBySession.get(sessionId) : undefined;
        if (!sessionId || !tracks) continue;
        const retainedTrackIds = splitIds(field(record, "track_ids")).filter((rawId) => {
          const id = parseUuid(rawId);
          return id !== null && tracks.has(id);
        });
        if (retainedTrackIds.length === 0) continue;
        const fields = new Map(record.fields);
        fields.set("track_ids", retainedTrackIds.join(","));
        plan.metadataUpdates.set(`${record.type}:${record.id.toLowerCase()}`, {
          ...record,
          fields,
        });
      } else {
        const trackId = parseUuid(field(record, "track_id"));
        const sessionId = parseUuid(field(record, "session_id"));
        if (trackId && sessionId && !plan.recordingTracksBySession.get(sessionId)?.has(trackId)) {
          continue;
        }
      }
    }
    const studentId = parseUuid(field(record, "student_id"));
    if (
      studentId &&
      availableStudents.has(studentId) &&
      !kept(plan, RecordType.student).has(studentId)
    ) {
      continue;
    }
    const associatedStudent = studentId !== null && kept(plan, RecordType.student).has(studentId);
    if (
      isScoped &&
      field(record, "session_id").length === 0 &&
      !associatedStudent &&
      !requestedAssets.has(record.id.toLowerCase())
    ) {
      continue;
    }
    keepSet(plan, RecordType.assetMetadata).add(record.id.toLowerCase());
  }

  for (const record of records(RecordType.evidenceNode)) {
    if (!active(record) || !sessionIsKept(plan, record)) continue;
    const studentId = parseUuid(field(record, "student_id"));
    if (
      studentId &&
      availableStudents.has(studentId) &&
      !kept(plan, RecordType.student).has(studentId)
    ) {
      continue;
    }
    if (isScoped && field(record, "session_id").length === 0) {
      if (!studentId || !kept(plan, RecordType.student).has(studentId)) continue;
    }
    const sourceAnnotation = field(record, "source_annotation_id");
    if (sourceAnnotation && !hasKeptRecord(plan, RecordType.annotation, sourceAnnotation)) continue;
    const segmentRefs = splitIds(field(record, "source_segment_ids"));
    const assetRefs = splitIds(field(record, "source_asset_ids"));
    if (
      segmentRefs.some((id) => !hasKeptRecord(plan, RecordType.transcriptSegment, id)) ||
      assetRefs.some((id) => !hasKeptRecord(plan, RecordType.assetMetadata, id))
    ) {
      continue;
    }
    keepSet(plan, RecordType.evidenceNode).add(record.id.toLowerCase());
  }
  for (const record of records(RecordType.evidenceEdge)) {
    if (
      active(record) &&
      sessionIsKept(plan, record) &&
      (!isScoped || hasKeptSession(plan, record)) &&
      hasKeptRecord(plan, RecordType.evidenceNode, field(record, "from_id")) &&
      hasKeptRecord(plan, RecordType.evidenceNode, field(record, "to_id"))
    ) {
      keepSet(plan, RecordType.evidenceEdge).add(record.id.toLowerCase());
    }
  }

  for (const record of records(RecordType.guide)) {
    if (!active(record) || !sessionIsKept(plan, record)) continue;
    const refs = guideReferences(record);
    if (!refs) continue;
    const entryId = field(record, "entry_id");
    const sessionId = field(record, "session_id");
    if (
      isScoped &&
      sessionId.length === 0 &&
      (entryId.length === 0 || !hasKeptRecord(plan, RecordType.settings, entryId))
    ) {
      continue;
    }
    let refsValid = refs.sources.every(
      (id) =>
        hasKeptRecord(plan, RecordType.evidenceNode, id) ||
        hasKeptRecord(plan, RecordType.annotation, id) ||
        hasKeptRecord(plan, RecordType.transcriptSegment, id) ||
        hasKeptRecord(plan, RecordType.assetMetadata, id),
    );
    refsValid &&= refs.imageAssets.every((id) => hasKeptRecord(plan, RecordType.assetMetadata, id));
    if (sessionId.length > 0) refsValid &&= hasKeptRecord(plan, RecordType.session, sessionId);
    if (refsValid) keepSet(plan, RecordType.guide).add(record.id.toLowerCase());
  }

  for (const record of records(RecordType.settings)) {
    if (!active(record)) continue;
    const role = lower(field(record, "record_role"));
    if (
      role === "archive-manifest" ||
      record.id.toLowerCase() === snapshot.header.id.toLowerCase()
    ) {
      continue;
    }
    if (isCredential(record)) continue;
    if (hasSensitiveCredentialMaterial(record)) continue;
    if (role === "journal-entry") {
      const sessions = splitIds(field(record, "session_ids"));
      if (isScoped && sessions.length === 0) continue;
      if (
        sessions.length > 0 &&
        !sessions.some((id) => hasKeptRecord(plan, RecordType.session, id))
      ) {
        continue;
      }
    }
    if (role === "journal-notes") {
      const sessionId = field(record, "session_id");
      if (sessionId.length > 0 && !hasKeptRecord(plan, RecordType.session, sessionId)) continue;
      if (isScoped && !retainedNotes.has(record.id.toLowerCase())) continue;
    }
    keepSet(plan, RecordType.settings).add(record.id.toLowerCase());
  }
  for (const record of records(RecordType.aiJob)) {
    if (
      active(record) &&
      sessionIsKept(plan, record) &&
      (!isScoped || hasKeptSession(plan, record)) &&
      options.includeGenerationLogs
    ) {
      keepSet(plan, RecordType.aiJob).add(record.id.toLowerCase());
    }
  }
  for (const record of records(RecordType.waveformIndex)) {
    if (
      !active(record) ||
      !recordingsRequested(options) ||
      !sessionIsKept(plan, record) ||
      (isScoped && !hasKeptSession(plan, record))
    ) {
      continue;
    }
    const sessionId = parseUuid(field(record, "session_id"));
    const trackId = parseUuid(field(record, "track_id"));
    if (sessionId && trackId && plan.recordingTracksBySession.get(sessionId)?.has(trackId)) {
      keepSet(plan, RecordType.waveformIndex).add(record.id.toLowerCase());
    }
  }

  const blobsById = new Map(
    records(RecordType.assetBlob).map((record) => [record.id.toLowerCase(), record]),
  );
  const referencedBlobs = new Set<string>();
  for (const record of records(RecordType.assetMetadata)) {
    if (!kept(plan, RecordType.assetMetadata).has(record.id.toLowerCase())) continue;
    const blobText = field(record, "blob_id");
    if (!blobText) continue;
    const blobId = parseUuid(blobText);
    if (!blobId) {
      throw new ArchiveFormatError(
        "sanitized_copy_asset_blob_id_invalid",
        "A selected asset has an invalid blob reference.",
      );
    }
    referencedBlobs.add(blobId);
  }
  const referencedChunks = new Set<string>();
  const chunkOwners = new Map<string, string>();
  for (const blobId of referencedBlobs) {
    const blob = blobsById.get(blobId);
    if (!blob || !active(blob)) {
      throw new ArchiveFormatError(
        "sanitized_copy_asset_blob_missing",
        "A selected asset refers to a missing blob record.",
      );
    }
    const role = field(blob, "record_role");
    if (role === "asset-blob-chunk") {
      throw new ArchiveFormatError(
        "sanitized_copy_asset_blob_invalid",
        "An asset points directly to a chunk instead of a blob manifest.",
      );
    }
    if (role !== "asset-blob-manifest") continue;
    for (const rawId of splitIds(field(blob, "chunk_ids"))) {
      const chunkId = parseUuid(rawId);
      if (!chunkId) {
        throw new ArchiveFormatError(
          "sanitized_copy_asset_manifest_invalid",
          "A selected asset manifest contains an invalid chunk reference.",
        );
      }
      referencedChunks.add(chunkId);
      const owner = chunkOwners.get(chunkId);
      if (owner && owner !== blobId) {
        throw new ArchiveFormatError(
          "sanitized_copy_asset_chunk_shared",
          "A chunk is assigned to multiple asset manifests.",
        );
      }
      chunkOwners.set(chunkId, blobId);
    }
  }
  for (const chunkId of referencedChunks) {
    const chunk = blobsById.get(chunkId);
    if (!chunk || !active(chunk)) {
      throw new ArchiveFormatError(
        "sanitized_copy_asset_chunk_missing",
        "A selected asset manifest refers to a missing chunk record.",
      );
    }
    if (
      field(chunk, "record_role") !== "asset-blob-chunk" ||
      field(chunk, "manifest_id").toLowerCase() !== chunkOwners.get(chunkId)
    ) {
      throw new ArchiveFormatError(
        "sanitized_copy_asset_chunk_invalid",
        "An asset chunk does not match its selected manifest.",
      );
    }
  }
  plan.keep.set(RecordType.assetBlob, new Set([...referencedBlobs, ...referencedChunks]));
  summary.students = kept(plan, RecordType.student).size;
  summary.sessions = kept(plan, RecordType.session).size;
  summary.annotations = kept(plan, RecordType.annotation).size;
  summary.assets = kept(plan, RecordType.assetMetadata).size;
  summary.evidenceItems = kept(plan, RecordType.evidenceNode).size;
  summary.guides = kept(plan, RecordType.guide).size;
  summary.recordings = kept(plan, RecordType.audioChunk).size;
  for (const tracks of plan.recordingTracksBySession.values())
    summary.recordingTracks += tracks.size;
  summary.generationLogs = kept(plan, RecordType.aiJob).size;
  summary.credentials = 0;
  return plan;
}

function pruneListField(
  record: ArchiveRecord,
  fields: Map<string, string>,
  name: string,
  valid: RecordSet,
): void {
  if (!fields.has(name)) return;
  fields.set(
    name,
    splitIds(field(record, name))
      .filter((id) => {
        const parsed = parseUuid(id);
        return parsed !== null && valid.has(parsed);
      })
      .join(","),
  );
}

function sanitizeRecord(
  source: ArchiveRecord,
  plan: CopyPlan,
  options: NormalizedOptions,
  sourceManifestId: string,
): ArchiveRecord {
  const record = { ...source, fields: new Map(source.fields), revision: 1n, previousOffset: 0n };
  const fields = record.fields as Map<string, string>;
  if (record.type === RecordType.settings && record.id.toLowerCase() === sourceManifestId)
    return record;

  if (record.type === RecordType.session) {
    const tracks = plan.recordingTracksBySession.get(record.id.toLowerCase());
    if (!tracks?.size) {
      fields.set("session_type", "notes-only");
      fields.set("recording_state", "not-started");
      for (const name of fields.keys()) {
        if (name.startsWith("recording_") || name.startsWith("audio_import_")) fields.delete(name);
      }
    } else {
      pruneListField(record, fields, "recording_track_ids", tracks);
      const primaryTrack = field(record, "recording_track_id");
      if (primaryTrack && !hasId(tracks, primaryTrack)) fields.set("recording_track_id", "");
      const importedTrack = field(record, "audio_import_track_id");
      if (importedTrack && !hasId(tracks, importedTrack)) {
        for (const name of fields.keys()) if (name.startsWith("audio_import_")) fields.delete(name);
      }
      fields.set("recording_track_count", tracks.size.toString());
      fields.set(
        "recording_audio_chunks",
        (plan.recordingChunksBySession.get(record.id.toLowerCase()) ?? 0).toString(),
      );
      const sourceTracks = plan.sourceRecordingTracksBySession.get(record.id.toLowerCase());
      if (sourceTracks && sourceTracks.size > tracks.size) {
        for (const name of [
          "recording_source",
          "recording_device_id",
          "recording_durability",
          "recording_sample_format",
          "recording_sample_rate_hz",
          "recording_channel_count",
          "recording_channel_mask",
          "recording_samples",
          "recording_timeline_samples",
          "recording_bytes",
          "recording_discontinuities",
          "recording_duration_us",
        ]) {
          fields.delete(name);
        }
      }
    }
    const student = field(record, "student_id");
    const studentId = parseUuid(student);
    if (studentId && !kept(plan, RecordType.student).has(studentId))
      fields.set("student_id", "anonymous");
    for (const name of ["entry_id", "notes_document_id"]) {
      const id = field(record, name);
      if (id && !hasKeptRecord(plan, RecordType.settings, id)) fields.set(name, "");
    }
  }
  if (record.type === RecordType.transcriptSegment) {
    pruneListField(record, fields, "linked_asset_ids", kept(plan, RecordType.assetMetadata));
  }
  if (record.type === RecordType.annotation) {
    pruneListField(record, fields, "linked_asset_ids", kept(plan, RecordType.assetMetadata));
    pruneListField(record, fields, "linked_evidence_ids", kept(plan, RecordType.evidenceNode));
  }
  if (record.type === RecordType.evidenceNode) {
    pruneListField(record, fields, "source_segment_ids", kept(plan, RecordType.transcriptSegment));
    pruneListField(record, fields, "source_asset_ids", kept(plan, RecordType.assetMetadata));
  }
  if (
    record.type === RecordType.settings &&
    lower(field(record, "record_role")) === "journal-entry"
  ) {
    pruneListField(record, fields, "session_ids", kept(plan, RecordType.session));
    pruneListField(record, fields, "study_guide_ids", kept(plan, RecordType.guide));
    pruneListField(record, fields, "attachment_ids", kept(plan, RecordType.assetMetadata));
    const notesId = field(record, "notes_document_id");
    if (notesId && !hasKeptRecord(plan, RecordType.settings, notesId))
      fields.set("notes_document_id", "");
  }
  if (record.type === RecordType.guide) {
    fields.delete("source_index_history");
    fields.delete("stale_source_id");
    fields.delete("stale_source_ids");
    const entryId = field(record, "entry_id");
    if (entryId && !hasKeptRecord(plan, RecordType.settings, entryId)) fields.set("entry_id", "");
  }
  if (record.type === RecordType.settings && !options.includeCredentials) {
    for (const name of fields.keys()) if (sensitiveSettingKey(name)) fields.delete(name);
  }
  return record;
}

function hasId(ids: RecordSet, rawId: string): boolean {
  const id = parseUuid(rawId);
  return id !== null && ids.has(id);
}

export async function previewSanitizedCopy(
  snapshot: ArchiveSnapshot,
  options: SanitizedCopyOptions = {},
): Promise<SanitizedCopySummary> {
  const plan = await makePlan(snapshot, normalizeOptions(options));
  return plan.summary;
}

/** Build and fully verify a new archive from a reviewed privacy selection. */
export async function createSanitizedCopy(
  snapshot: ArchiveSnapshot,
  options: SanitizedCopyOptions,
  expected: Pick<SanitizedCopySummary, "sourceGeneration" | "selectionFingerprint">,
  checkpoint?: SanitizedCopyCheckpoint,
): Promise<SanitizedCopyResult> {
  const normalized = normalizeOptions(options);
  const plan = await makePlan(snapshot, normalized);
  if (plan.summary.sourceGeneration !== expected.sourceGeneration) {
    throw new ArchiveFormatError(
      "sanitized_copy_source_changed",
      "The source archive changed after preview; review a new preview.",
    );
  }
  if (plan.summary.selectionFingerprint !== expected.selectionFingerprint) {
    throw new ArchiveFormatError(
      "sanitized_copy_selection_changed",
      "The selection differs from the reviewed preview; review it again.",
    );
  }

  const manifest = await snapshot.getManifest();
  let output = await openArchiveBytes(
    await createArchiveBytes(
      `Sanitized copy of ${manifest.displayName}`,
      "Created from an explicitly reviewed privacy selection.",
    ),
  );
  const persist = async (next: ArchiveSnapshot, previousSize: bigint): Promise<ArchiveSnapshot> => {
    if (!checkpoint) return next;
    const saved = await checkpoint(next, previousSize);
    if (
      saved.source.size !== next.source.size ||
      saved.commit.generation !== next.commit.generation ||
      saved.header.id !== next.header.id
    ) {
      await saved.source.close?.();
      throw new ArchiveFormatError(
        "sanitized_copy_checkpoint_invalid",
        "The sanitized-copy checkpoint did not preserve the generated archive.",
      );
    }
    await next.source.close?.();
    return saved;
  };
  try {
    output = await persist(output, 0n);
    let batch: ArchiveRecord[] = [];
    let batchBytes = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const previousSize = output.source.size;
      output = await persist(await appendRecords(output, batch), previousSize);
      batch = [];
      batchBytes = 0;
    };
    for (const type of COPY_TYPES) {
      for (const id of kept(plan, type)) {
        const current = await snapshot.getRecord(type, id);
        if (!current || !active(current)) {
          throw new ArchiveFormatError(
            "sanitized_copy_record_missing",
            "A selected record disappeared after preview.",
          );
        }
        const updated = plan.metadataUpdates.get(`${type}:${id}`);
        const record = sanitizeRecord(
          updated ? { ...current, fields: updated.fields } : current,
          plan,
          normalized,
          snapshot.header.id.toLowerCase(),
        );
        batch.push(record);
        batchBytes += record.blob.byteLength;
        if (batch.length >= 32 || batchBytes >= 16 * 1024 * 1024) await flush();
      }
      await flush();
    }
    await verifyArchiveSnapshot(output);
    return { snapshot: output, summary: plan.summary };
  } catch (error) {
    await output.source.close?.().catch(() => undefined);
    throw error;
  }
}
