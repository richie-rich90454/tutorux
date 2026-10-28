import {
  appendRecords,
  createArchiveBytes,
  openArchiveBytes,
  type ArchiveSnapshot,
  verifyArchiveSnapshot,
} from "../archive/archive";
import { RecordType, newUuid, type ArchiveRecord } from "../archive/format";

const PACKAGE_ROLE = "tutorux-session-package";
const PACKAGE_VERSION = "1";
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const INTERNAL_ASSET_ROLES = new Set([
  "audio-track",
  "recording-take",
  "waveform-pyramid",
  "sparse-timestamp-seek-index",
  "asset-blob-manifest",
  "asset-blob-chunk",
]);
const PACKAGE_RECORD_TYPES = [
  RecordType.session,
  RecordType.audioChunk,
  RecordType.transcriptSegment,
  RecordType.annotation,
  RecordType.assetMetadata,
  RecordType.assetBlob,
  RecordType.evidenceNode,
  RecordType.evidenceEdge,
  RecordType.guide,
  RecordType.aiJob,
] as const;

export interface ImportedSessionPackage {
  readonly sessionId: string;
  readonly records: readonly ArchiveRecord[];
}

/** Create a portable, unencrypted package containing one session and its linked records. */
export async function createSessionPackage(
  source: ArchiveSnapshot,
  sessionId: string,
): Promise<ArchiveSnapshot> {
  const canonicalSessionId = requireUuid(sessionId, "Session ID");
  const session = await requiredLiveRecord(
    source,
    RecordType.session,
    canonicalSessionId,
    "Session",
  );
  const sourceStudentId = field(session, "student_id");
  const records = await collectSessionRecords(source, canonicalSessionId);
  const initial = await openArchiveBytes(
    await createArchiveBytes(
      "Tutorux session transfer",
      `Portable transfer package for session ${canonicalSessionId}`,
    ),
  );
  const manifest = await initial.getRecord(RecordType.settings, initial.header.id);
  if (!manifest) throw new Error("The new package archive is missing its manifest.");
  const fields = new Map(manifest.fields);
  fields.set("record_role", PACKAGE_ROLE);
  fields.set("package_version", PACKAGE_VERSION);
  fields.set("source_session_id", canonicalSessionId);
  if (sourceStudentId && sourceStudentId !== "anonymous") {
    fields.set("source_student_id", sourceStudentId);
  }
  const packaged = await appendRecords(initial, [{ ...manifest, fields }, ...records]);
  await verifyArchiveSnapshot(packaged);
  return packaged;
}

/** Validate a portable package, assign fresh record identifiers, and link it to a destination student. */
export async function importSessionPackage(
  packageSnapshot: ArchiveSnapshot,
  destination: ArchiveSnapshot,
  studentId?: string,
): Promise<ImportedSessionPackage> {
  await verifyArchiveSnapshot(packageSnapshot);
  const packageManifest = await packageSnapshot.getRecord(
    RecordType.settings,
    packageSnapshot.header.id,
  );
  if (
    !packageManifest ||
    field(packageManifest, "record_role") !== PACKAGE_ROLE ||
    field(packageManifest, "package_version") !== PACKAGE_VERSION
  ) {
    throw new Error("Input archive is not a supported Tutorux session transfer package.");
  }

  const records = await readPackageRecords(packageSnapshot);
  const sessionRecords = records.filter((record) => record.type === RecordType.session);
  if (sessionRecords.length !== 1 || isDeleted(sessionRecords[0]!)) {
    throw new Error("A session transfer package must contain exactly one active session.");
  }
  const sourceSession = sessionRecords[0]!;
  const sourceSessionId = sourceSession.id.toLowerCase();
  if (field(packageManifest, "source_session_id").toLowerCase() !== sourceSessionId) {
    throw new Error("The package manifest does not match its contained session.");
  }

  const mappedStudentId = await resolveDestinationStudent(
    destination,
    studentId,
    field(packageManifest, "source_student_id") || field(sourceSession, "student_id"),
  );
  const idMap = makeIdentifierMap(
    records,
    sourceSessionId,
    field(packageManifest, "source_student_id") || field(sourceSession, "student_id"),
    mappedStudentId,
  );
  const importedAt = nowUs();
  const imported = records.map((record) => {
    const oldId = record.id.toLowerCase();
    const fields = new Map(record.fields);
    for (const [key, value] of fields) {
      if (key === "session_id" && record.type === RecordType.assetMetadata) {
        fields.set(key, idMap.get(sourceSessionId)!);
      } else if (key === "student_id" && record.type === RecordType.session) {
        fields.set(key, mappedStudentId ?? "anonymous");
      } else if (key === "student_id" && idMap.has(value.toLowerCase())) {
        fields.set(key, idMap.get(value.toLowerCase()) || "anonymous");
      } else if (key.endsWith("_id") || key.endsWith("_ids")) {
        fields.set(key, remapReferences(value, idMap));
      }
    }
    if (record.type === RecordType.session && oldId === sourceSessionId) {
      fields.set("imported_at_us", importedAt);
      fields.delete("_deleted");
    }
    return {
      ...record,
      id: idMap.get(oldId)!,
      revision: 0n,
      previousOffset: 0n,
      fields,
    };
  });

  const importedSessionId = idMap.get(sourceSessionId);
  if (!importedSessionId) throw new Error("The package session identifier could not be remapped.");
  const withJournalLinks = await ensureJournalLinks(destination, imported, importedSessionId);
  return { sessionId: importedSessionId, records: withJournalLinks };
}

async function collectSessionRecords(
  source: ArchiveSnapshot,
  sessionId: string,
): Promise<ArchiveRecord[]> {
  const records = new Map<string, ArchiveRecord>();
  const evidenceIds = new Set<string>();
  const assetIds = new Set<string>();
  const add = (record: ArchiveRecord): void => {
    records.set(recordKey(record), record);
  };

  const session = await requiredLiveRecord(source, RecordType.session, sessionId, "Session");
  add(session);
  for (const type of PACKAGE_RECORD_TYPES.filter((item) => item !== RecordType.session)) {
    const related = (await source.listRecords(type, true)).filter(
      (record) => field(record, "session_id").toLowerCase() === sessionId,
    );
    for (const record of related) {
      add(record);
      if (record.type === RecordType.evidenceNode) evidenceIds.add(record.id.toLowerCase());
      if (
        record.type === RecordType.assetMetadata &&
        !INTERNAL_ASSET_ROLES.has(field(record, "record_role"))
      ) {
        assetIds.add(record.id.toLowerCase());
      }
      collectIdList(record, "linked_asset_ids", assetIds);
      collectIdList(record, "source_asset_ids", assetIds);
    }
  }

  for (const edge of await source.listRecords(RecordType.evidenceEdge, true)) {
    const belongsToSession = field(edge, "session_id").toLowerCase() === sessionId;
    const connectsSessionEvidence =
      evidenceIds.has(field(edge, "from_id").toLowerCase()) &&
      evidenceIds.has(field(edge, "to_id").toLowerCase());
    if (belongsToSession || connectsSessionEvidence) add(edge);
  }

  for (const record of records.values()) {
    for (const revision of await getCompleteRecordHistory(source, record)) {
      collectIdList(revision, "linked_asset_ids", assetIds);
      collectIdList(revision, "source_asset_ids", assetIds);
    }
  }

  const assetMetadata = await source.listRecords(RecordType.assetMetadata, true);
  const foundAssets = new Set<string>();
  const pendingBlobIds = new Set<string>();
  for (const asset of assetMetadata) {
    if (!assetIds.has(asset.id.toLowerCase())) continue;
    foundAssets.add(asset.id.toLowerCase());
    for (const revision of await getCompleteRecordHistory(source, asset)) {
      const blobId = requireUuid(field(revision, "blob_id"), "Asset content reference");
      pendingBlobIds.add(blobId);
    }
    add(asset);
  }
  if (foundAssets.size !== assetIds.size) {
    throw new Error("A session reference points to asset metadata that is not available.");
  }

  const resolvedBlobIds = new Set<string>();
  const allAssetMetadata = await source.listRecords(RecordType.assetBlob, true);
  const assetBlobs = new Map(allAssetMetadata.map((record) => [record.id.toLowerCase(), record]));
  while (pendingBlobIds.size > 0) {
    const blobId = pendingBlobIds.values().next().value as string;
    pendingBlobIds.delete(blobId);
    if (resolvedBlobIds.has(blobId)) continue;
    resolvedBlobIds.add(blobId);
    const blob = assetBlobs.get(blobId);
    if (!blob || isDeleted(blob))
      throw new Error("Session material content is missing from the archive.");
    add(blob);
    if (field(blob, "record_role") === "asset-blob-manifest") {
      for (const revision of await getCompleteRecordHistory(source, blob)) {
        for (const chunkId of parseIdList(field(revision, "chunk_ids"), "Asset manifest chunk")) {
          pendingBlobIds.add(chunkId);
        }
      }
    }
  }

  const includeSettings = async (id: string, label: string): Promise<void> => {
    if (!id) return;
    const canonicalId = requireUuid(id, label);
    const record = await requiredLiveRecord(source, RecordType.settings, canonicalId, label);
    add(record);
  };
  await includeSettings(field(session, "entry_id"), "Session journal entry");
  await includeSettings(field(session, "notes_document_id"), "Session notes document");
  for (const record of records.values()) {
    if (record.type === RecordType.guide) {
      await includeSettings(field(record, "entry_id"), "Guide journal entry");
    }
  }
  const entryDocumentIds = [...records.values()]
    .filter(
      (record) =>
        record.type === RecordType.settings && field(record, "record_role") === "journal-entry",
    )
    .map((record) => field(record, "notes_document_id"))
    .filter(Boolean);
  for (const id of entryDocumentIds) await includeSettings(id, "Journal notes document");

  const output = [...records.values()].map((record) => ({
    ...record,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map(record.fields),
  }));
  const packagedSession = output.find((record) => record.type === RecordType.session);
  if (!packagedSession) throw new Error("Session package assembly lost its session record.");
  packagedSession.fields.set("student_id", "anonymous");
  validateSessionRecords(output, sessionId);
  return output;
}

async function readPackageRecords(snapshot: ArchiveSnapshot): Promise<ArchiveRecord[]> {
  if ((await snapshot.listRecords(RecordType.student, true)).length > 0) {
    throw new Error("Session packages cannot contain student profiles.");
  }
  const records: ArchiveRecord[] = [];
  for (const settings of await snapshot.listRecords(RecordType.settings, true)) {
    if (settings.id.toLowerCase() === snapshot.header.id.toLowerCase()) continue;
    const role = field(settings, "record_role");
    if (role !== "journal-entry" && role !== "journal-notes") {
      throw new Error("Session packages cannot contain unrelated settings.");
    }
    records.push(settings);
  }
  for (const type of PACKAGE_RECORD_TYPES) {
    records.push(...(await snapshot.listRecords(type, true)));
  }
  const sessionId = records.find((record) => record.type === RecordType.session)?.id ?? "";
  validateSessionRecords(records, sessionId);
  return records;
}

async function ensureJournalLinks(
  destination: ArchiveSnapshot,
  records: ArchiveRecord[],
  sessionId: string,
): Promise<ArchiveRecord[]> {
  const output = new Map(records.map((record) => [recordKey(record), record]));
  const session = output.get(recordKey({ type: RecordType.session, id: sessionId }));
  if (!session) throw new Error("Imported session is missing from its package.");
  const sessionFields = new Map(session.fields);
  const timestamp = nowUs();
  const settings = new Map(
    (await destination.listRecords(RecordType.settings, true)).map((record) => [
      record.id.toLowerCase(),
      record,
    ]),
  );
  for (const record of output.values()) {
    if (record.type === RecordType.settings) settings.set(record.id.toLowerCase(), record);
  }
  const getSettings = async (id: string): Promise<ArchiveRecord | null> => {
    const existing = settings.get(id.toLowerCase());
    if (existing) return existing;
    return destination.getRecord(RecordType.settings, id);
  };

  let entryId = field(session, "entry_id").toLowerCase();
  let entry = entryId ? await getSettings(entryId) : null;
  if (!entry || isDeleted(entry) || field(entry, "record_role") !== "journal-entry") {
    entryId = newUuid();
    const entryNotesId = newUuid();
    entry = makeJournalEntry(session, entryId, entryNotesId, sessionId, timestamp);
    const entryNotes = makeJournalNotes(entryNotesId, entryId, "", timestamp);
    output.set(recordKey(entry), entry);
    output.set(recordKey(entryNotes), entryNotes);
    settings.set(entryId, entry);
    settings.set(entryNotesId, entryNotes);
    sessionFields.set("entry_id", entryId);
  } else {
    entry = { ...entry, fields: new Map(entry.fields) };
    const linkedSessions = parseIdList(field(entry, "session_ids"), "Journal session link");
    if (!linkedSessions.includes(sessionId)) linkedSessions.push(sessionId);
    const entryFields = new Map(entry.fields);
    entryFields.set("session_ids", linkedSessions.join(","));
    entryFields.set("updated_at_us", timestamp);
    entry = { ...entry, fields: entryFields };
    output.set(recordKey(entry), entry);
  }

  const entryNotesId = field(entry, "notes_document_id").toLowerCase();
  const entryNotes = entryNotesId ? await getSettings(entryNotesId) : null;
  if (
    !entryNotes ||
    isDeleted(entryNotes) ||
    field(entryNotes, "record_role") !== "journal-notes"
  ) {
    const notesId = newUuid();
    const notes = makeJournalNotes(notesId, entryId, "", timestamp);
    output.set(recordKey(notes), notes);
    const entryFields = new Map(entry.fields);
    entryFields.set("notes_document_id", notesId);
    entry = { ...entry, fields: entryFields };
    output.set(recordKey(entry), entry);
  }

  let sessionNotesId = field(session, "notes_document_id").toLowerCase();
  let sessionNotes = sessionNotesId ? await getSettings(sessionNotesId) : null;
  if (
    !sessionNotes ||
    isDeleted(sessionNotes) ||
    field(sessionNotes, "record_role") !== "journal-notes" ||
    field(sessionNotes, "entry_id").toLowerCase() !== entryId ||
    field(sessionNotes, "session_id").toLowerCase() !== sessionId
  ) {
    sessionNotesId = newUuid();
    sessionNotes = makeJournalNotes(sessionNotesId, entryId, sessionId, timestamp);
    output.set(recordKey(sessionNotes), sessionNotes);
    sessionFields.set("notes_document_id", sessionNotesId);
  }

  output.set(recordKey(session), { ...session, fields: sessionFields });

  const hasJournalRoot = [...settings.values()].some(
    (record) => field(record, "record_role") === "journal" && !isDeleted(record),
  );
  if (!hasJournalRoot) {
    const root = makeJournalRoot(timestamp);
    output.set(recordKey(root), root);
  }
  return [...output.values()];
}

function makeIdentifierMap(
  records: readonly ArchiveRecord[],
  sourceSessionId: string,
  sourceStudentId: string,
  mappedStudentId: string | undefined,
): Map<string, string> {
  const types = new Map<string, number>();
  const identifiers = new Map<string, string>();
  const generated = new Set<string>();
  for (const record of records) {
    const oldId = record.id.toLowerCase();
    const existingType = types.get(oldId);
    if (existingType !== undefined && existingType !== record.type) {
      throw new Error("The package reuses a record UUID across different record types.");
    }
    types.set(oldId, record.type);
    if (!identifiers.has(oldId)) {
      const nextId = newUuid();
      if (generated.has(nextId))
        throw new Error("Unable to assign unique imported record identifiers.");
      identifiers.set(oldId, nextId);
      generated.add(nextId);
    }
  }
  const historicalStudentIds = new Set(
    records
      .filter((record) => record.type === RecordType.session)
      .map((record) => field(record, "student_id"))
      .filter((id) => id && id !== "anonymous")
      .map((id) => id.toLowerCase()),
  );
  if (sourceStudentId && sourceStudentId !== "anonymous") {
    historicalStudentIds.add(sourceStudentId.toLowerCase());
  }
  const sourceSession = records.find(
    (record) => record.type === RecordType.session && record.id.toLowerCase() === sourceSessionId,
  );
  if (!sourceSession) throw new Error("The package session record is missing.");
  const sessionStudentId = field(sourceSession, "student_id").toLowerCase();
  if (sessionStudentId && sessionStudentId !== "anonymous") {
    historicalStudentIds.add(sessionStudentId);
  }
  for (const student of historicalStudentIds) {
    if (!student || student === "anonymous") continue;
    if (identifiers.has(student)) {
      throw new Error("A source student UUID conflicts with a session package record UUID.");
    }
    if (mappedStudentId && generated.has(mappedStudentId.toLowerCase())) {
      throw new Error("The destination student UUID conflicts with an imported record UUID.");
    }
    identifiers.set(student, mappedStudentId?.toLowerCase() ?? "");
  }
  return identifiers;
}

async function getCompleteRecordHistory(
  snapshot: ArchiveSnapshot,
  record: ArchiveRecord,
): Promise<ArchiveRecord[]> {
  const history = await snapshot.getRecordHistory(record.type, record.id, 10_000);
  if (history.at(-1)?.previousOffset !== 0n) {
    throw new Error("A session package cannot include more than 10,000 revisions of one record.");
  }
  return history;
}

async function resolveDestinationStudent(
  destination: ArchiveSnapshot,
  requestedStudentId: string | undefined,
  sourceStudentId: string,
): Promise<string | undefined> {
  const candidate = requestedStudentId || sourceStudentId;
  if (!UUID_PATTERN.test(candidate)) {
    if (requestedStudentId) throw new Error("The selected destination student ID is invalid.");
    return undefined;
  }
  const student = await destination.getRecord(RecordType.student, candidate.toLowerCase());
  if (!student || isDeleted(student)) {
    if (requestedStudentId) throw new Error("The selected destination student does not exist.");
    return undefined;
  }
  return student.id.toLowerCase();
}

function validateSessionRecords(records: readonly ArchiveRecord[], sessionId: string): void {
  const recordIds = new Map<number, Set<string>>();
  for (const record of records) {
    const ids = recordIds.get(record.type) ?? new Set<string>();
    ids.add(record.id.toLowerCase());
    recordIds.set(record.type, ids);
  }
  const hasReference = (type: number, id: string): boolean =>
    recordIds.get(type)?.has(id.toLowerCase()) ?? false;
  const validateList = (value: string, type: number, label: string): void => {
    for (const id of parseIdList(value, label)) {
      if (!hasReference(type, id))
        throw new Error(`A session package ${label} points to a record that is not included.`);
    }
  };

  for (const record of records) {
    const relatedSession = field(record, "session_id").toLowerCase();
    if (
      relatedSession &&
      record.type !== RecordType.assetMetadata &&
      relatedSession !== sessionId.toLowerCase()
    ) {
      throw new Error("Package contains a record associated with another session.");
    }
    if (
      record.type === RecordType.settings &&
      !["journal-entry", "journal-notes"].includes(field(record, "record_role"))
    ) {
      throw new Error("Session packages cannot contain unrelated settings.");
    }
    if (
      record.type === RecordType.assetMetadata &&
      !INTERNAL_ASSET_ROLES.has(field(record, "record_role")) &&
      !hasReference(RecordType.assetBlob, field(record, "blob_id").toLowerCase())
    ) {
      throw new Error("A session asset revision references a missing content blob.");
    }
    if (
      record.type === RecordType.assetBlob &&
      field(record, "record_role") === "asset-blob-manifest"
    ) {
      validateList(field(record, "chunk_ids"), RecordType.assetBlob, "asset manifest chunk");
    }
    if (record.type === RecordType.annotation || record.type === RecordType.transcriptSegment) {
      validateList(field(record, "linked_asset_ids"), RecordType.assetMetadata, "asset link");
    }
    if (record.type === RecordType.evidenceNode) {
      const annotationId = field(record, "source_annotation_id");
      if (annotationId && !hasReference(RecordType.annotation, annotationId)) {
        throw new Error("Evidence refers to an annotation that is not included.");
      }
      validateList(
        field(record, "source_segment_ids"),
        RecordType.transcriptSegment,
        "transcript source",
      );
      validateList(
        field(record, "source_asset_ids"),
        RecordType.assetMetadata,
        "evidence asset source",
      );
    }
    if (
      record.type === RecordType.evidenceEdge &&
      (!hasReference(RecordType.evidenceNode, field(record, "from_id")) ||
        !hasReference(RecordType.evidenceNode, field(record, "to_id")))
    ) {
      throw new Error("An evidence relationship points to a missing evidence node.");
    }
  }
}

function remapReferences(value: string, identifiers: ReadonlyMap<string, string>): string {
  if (!value) return value;
  const trimmed = value.trim().toLowerCase();
  const exact = identifiers.get(trimmed);
  if (exact !== undefined) return exact;
  return value
    .split(",")
    .map((part) => {
      const id = part.trim().toLowerCase();
      return identifiers.get(id) ?? part.trim();
    })
    .join(",");
}

function collectIdList(record: ArchiveRecord, key: string, ids: Set<string>): void {
  for (const id of parseIdList(field(record, key), key)) ids.add(id);
}

function parseIdList(value: string, label: string): string[] {
  if (!value) return [];
  const parts = value.split(",");
  if (parts.some((part) => !part.trim())) throw new Error(`${label} contains an empty identifier.`);
  return parts.map((part) => requireUuid(part.trim(), label));
}

function makeJournalEntry(
  session: ArchiveRecord,
  id: string,
  notesId: string,
  sessionId: string,
  timestamp: string,
): ArchiveRecord {
  return makeSettingsRecord(id, {
    record_role: "journal-entry",
    title: field(session, "title", "Imported tutoring session"),
    entry_date: new Date().toISOString().slice(0, 10),
    collection_ids: "",
    tag_ids: "",
    notes_document_id: notesId,
    session_ids: sessionId,
    study_guide_ids: "",
    attachment_ids: "",
    created_at_us: timestamp,
    updated_at_us: timestamp,
  });
}

function makeJournalNotes(
  id: string,
  entryId: string,
  sessionId: string,
  timestamp: string,
): ArchiveRecord {
  return makeSettingsRecord(id, {
    record_role: "journal-notes",
    entry_id: entryId,
    session_id: sessionId,
    created_at_us: timestamp,
    updated_at_us: timestamp,
    block_count: "0",
  });
}

function makeJournalRoot(timestamp: string): ArchiveRecord {
  return makeSettingsRecord(newUuid(), {
    record_role: "journal",
    title: "Tutorux journal",
    created_at_us: timestamp,
    updated_at_us: timestamp,
  });
}

function makeSettingsRecord(id: string, values: Record<string, string>): ArchiveRecord {
  return {
    type: RecordType.settings,
    id,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map(Object.entries(values)),
    blob: new Uint8Array(),
  };
}

function requiredLiveRecord(
  snapshot: ArchiveSnapshot,
  type: number,
  id: string,
  label: string,
): Promise<ArchiveRecord> {
  return snapshot.getRecord(type, id).then((record) => {
    if (!record || isDeleted(record))
      throw new Error(`${label} is missing from the selected archive.`);
    return record;
  });
}

function requireUuid(value: string, label: string): string {
  const id = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new Error(`${label} has an invalid identifier.`);
  return id;
}

function recordKey(record: Pick<ArchiveRecord, "type" | "id">): string {
  return `${record.type}:${record.id.toLowerCase()}`;
}

function field(record: ArchiveRecord, key: string, fallback = ""): string {
  return record.fields.get(key) || fallback;
}

function isDeleted(record: ArchiveRecord): boolean {
  return field(record, "_deleted") === "true";
}

function nowUs(): string {
  return (BigInt(Date.now()) * 1000n).toString();
}
