import { RecordType, type ArchiveRecord } from "../archive/format";

let lastTimestampUs = 0n;

const nowUs = (): string => {
  const wallClock = BigInt(Date.now()) * 1000n;
  lastTimestampUs = wallClock > lastTimestampUs ? wallClock : lastTimestampUs + 1n;
  return lastTimestampUs.toString();
};

export interface StudentInput {
  name: string;
  grade: string;
  subjects: string;
  objectives: string;
  tutorNotes: string;
  difficulties?: string;
  demonstratedImprovements?: string;
  preferredGuideTemplate?: string;
}

export interface SessionInput {
  studentId: string;
  subject: string;
  title: string;
  objectives: string;
  notes: string;
}

export type SessionTransitionAction = "start" | "complete" | "review" | "resume";

export interface JournalInput {
  title: string;
  date: string;
  notes: string;
  collectionIds?: readonly string[];
  tagIds?: readonly string[];
}

export interface JournalCollectionInput {
  name: string;
  description: string;
  color: string;
}

export interface JournalTagInput {
  name: string;
  color: string;
}

export interface NotesEditState {
  text: string;
  editable: boolean;
}

export function makeStudentRecord(input: StudentInput): ArchiveRecord {
  const name = requiredText(input.name, "Student name", 256);
  const timestamp = nowUs();
  return record(RecordType.student, crypto.randomUUID(), {
    display_name: name,
    grade: cleanText(input.grade, "Grade", 128),
    subjects: cleanText(input.subjects, "Subjects", 2_048),
    learning_objectives: cleanText(input.objectives, "Learning objectives", 4_096, true),
    known_difficulties: cleanText(input.difficulties ?? "", "Known difficulties", 4_096, true),
    demonstrated_improvements: cleanText(
      input.demonstratedImprovements ?? "",
      "Demonstrated improvements",
      4_096,
      true,
    ),
    preferred_guide_template: cleanText(
      input.preferredGuideTemplate ?? "",
      "Preferred study-guide template",
      128,
    ),
    progress_classifications: "",
    tutor_notes: cleanText(input.tutorNotes, "Private tutor notes", 16_384, true),
    created_at_us: timestamp,
    updated_at_us: timestamp,
  });
}

/** Update the editable student profile while retaining its ID and unknown legacy fields. */
export function updateStudentRecord(current: ArchiveRecord, input: StudentInput): ArchiveRecord {
  if (current.type !== RecordType.student) {
    throw new Error("Only a student profile can be updated with student details.");
  }
  const fields = new Map(current.fields);
  fields.set("display_name", requiredText(input.name, "Student name", 256));
  fields.set("grade", cleanText(input.grade, "Grade", 128));
  fields.set("subjects", cleanText(input.subjects, "Subjects", 2_048));
  fields.set(
    "learning_objectives",
    cleanText(input.objectives, "Learning objectives", 4_096, true),
  );
  if (input.difficulties !== undefined) {
    fields.set(
      "known_difficulties",
      cleanText(input.difficulties, "Known difficulties", 4_096, true),
    );
  }
  if (input.demonstratedImprovements !== undefined) {
    fields.set(
      "demonstrated_improvements",
      cleanText(input.demonstratedImprovements, "Demonstrated improvements", 4_096, true),
    );
  }
  if (input.preferredGuideTemplate !== undefined) {
    fields.set(
      "preferred_guide_template",
      cleanText(input.preferredGuideTemplate, "Preferred study-guide template", 128),
    );
  }
  fields.set("tutor_notes", cleanText(input.tutorNotes, "Private tutor notes", 16_384, true));
  fields.set("updated_at_us", nowUs());
  return { ...current, fields };
}

/** Move a record to recoverable Trash without mutating the current archive snapshot. */
export function moveRecordToTrash(current: ArchiveRecord): ArchiveRecord {
  if (current.fields.get("_deleted") === "true") {
    throw new Error("This record is already in Trash.");
  }
  const fields = new Map(current.fields);
  const timestamp = nowUs();
  fields.set("_deleted", "true");
  fields.set("deleted_at_us", timestamp);
  fields.set("updated_at_us", timestamp);
  if (current.type === RecordType.session) fields.set("_trash_group_id", current.id);
  return { ...current, fields };
}

/** Restore a soft-deleted record while keeping all unrelated archive fields intact. */
export function restoreRecordFromTrash(current: ArchiveRecord): ArchiveRecord {
  if (current.fields.get("_deleted") !== "true") {
    throw new Error("This record is not in Trash.");
  }
  const fields = new Map(current.fields);
  const timestamp = nowUs();
  fields.delete("_deleted");
  fields.delete("deleted_at_us");
  fields.delete("_trash_group_id");
  fields.set("restored_at_us", timestamp);
  fields.set("updated_at_us", timestamp);
  return { ...current, fields };
}

/** Apply a valid session state transition while preserving unrelated archive fields. */
export function transitionSessionRecord(
  current: ArchiveRecord,
  action: SessionTransitionAction,
): ArchiveRecord {
  if (current.type !== RecordType.session) {
    throw new Error("Only a session can change lifecycle state.");
  }
  if (current.fields.get("_deleted") === "true") {
    throw new Error("Restore this session before changing its lifecycle state.");
  }

  const fields = new Map(current.fields);
  const state = fields.get("session_state") ?? "active";
  const timestamp = nowUs();
  if (action === "start") {
    if (state !== "created" && state !== "active" && state !== "in-progress") {
      throw new Error(
        "A completed session must use resume; starting does not restart audio capture.",
      );
    }
    const startedAt = fields.get("started_at_us") ?? "0";
    if (!/^-?\d+$/u.test(startedAt) || BigInt(startedAt) <= 0n) {
      fields.set("started_at_us", timestamp);
    }
    fields.set("session_state", "active");
    fields.set("ended_at_us", "0");
  } else if (action === "complete") {
    if (state !== "active" && state !== "in-progress") {
      throw new Error("Only an active session can be completed.");
    }
    if (fields.get("recording_state") === "recording") {
      throw new Error("Stop the active recording before completing the session.");
    }
    fields.set("session_state", "completed");
    fields.set("ended_at_us", timestamp);
    fields.set("last_completed_at_us", timestamp);
  } else if (action === "review") {
    if (state !== "completed" && state !== "reviewed") {
      throw new Error("Complete the session before marking it reviewed.");
    }
    fields.set("session_state", "reviewed");
    fields.set("reviewed_at_us", timestamp);
  } else {
    if (state !== "completed" && state !== "reviewed") {
      throw new Error("Only a completed or reviewed session can be resumed.");
    }
    fields.set("session_state", "active");
    fields.set("resumed_at_us", timestamp);
    fields.set("ended_at_us", "0");
  }
  fields.set("updated_at_us", timestamp);
  return { ...current, fields };
}

export function makeSessionRecords(input: SessionInput): ArchiveRecord[] {
  const timestamp = nowUs();
  const sessionId = crypto.randomUUID();
  const notesId = crypto.randomUUID();
  const note = cleanText(input.notes, "Session notes", 100_000, true);
  return [
    record(RecordType.session, sessionId, {
      student_id: input.studentId || "anonymous",
      entry_id: "",
      notes_document_id: notesId,
      subject: cleanText(input.subject, "Subject", 200),
      title: requiredText(input.title, "Session title", 240),
      learning_objectives: cleanText(input.objectives, "Learning objectives", 4_000),
      session_type: "notes-only",
      session_state: "completed",
      transcription_language: "auto",
      guide_template_id: "",
      recording_source: "none",
      started_at_us: timestamp,
      ended_at_us: timestamp,
      reviewed_at_us: "0",
      recording_state: "not-started",
      processing_state: "not-processed",
      archived: "false",
      created_at_us: timestamp,
      updated_at_us: timestamp,
    }),
    makeNotesDocument(notesId, sessionId, "", note, timestamp),
  ];
}

export function makeJournalRecords(input: JournalInput): ArchiveRecord[] {
  const timestamp = nowUs();
  const entryId = crypto.randomUUID();
  const notesId = crypto.randomUUID();
  const note = cleanText(input.notes, "Journal note", 100_000, true);
  validateJournalDate(input.date);
  return [
    record(RecordType.settings, entryId, {
      record_role: "journal-entry",
      title: requiredText(input.title, "Entry title", 240),
      entry_date: input.date,
      collection_ids: encodeJournalIds(input.collectionIds ?? [], "Collection"),
      tag_ids: encodeJournalIds(input.tagIds ?? [], "Tag"),
      notes_document_id: notesId,
      session_ids: "",
      study_guide_ids: "",
      attachment_ids: "",
      created_at_us: timestamp,
      updated_at_us: timestamp,
    }),
    makeNotesDocument(notesId, entryId, "", note, timestamp),
  ];
}

/** Create a C++/Slint-compatible journal collection settings record. */
export function makeJournalCollectionRecord(input: JournalCollectionInput): ArchiveRecord {
  const timestamp = nowUs();
  return record(RecordType.settings, crypto.randomUUID(), {
    record_role: "journal-collection",
    name: requiredText(input.name, "Collection name", 256),
    description: cleanText(input.description, "Collection description", 4_096, true),
    color: cleanColor(input.color),
    created_at_us: timestamp,
    updated_at_us: timestamp,
  });
}

/** Create a C++/Slint-compatible journal tag settings record. */
export function makeJournalTagRecord(input: JournalTagInput): ArchiveRecord {
  const timestamp = nowUs();
  return record(RecordType.settings, crypto.randomUUID(), {
    record_role: "journal-tag",
    name: requiredText(input.name, "Tag name", 128),
    color: cleanColor(input.color),
    created_at_us: timestamp,
    updated_at_us: timestamp,
  });
}

/** Rename or recolor an organizer record while retaining unknown legacy fields. */
export function updateJournalOrganizerRecord(
  current: ArchiveRecord,
  input: JournalCollectionInput | JournalTagInput,
): ArchiveRecord {
  if (current.type !== RecordType.settings) {
    throw new Error("Only a journal collection or tag can be updated here.");
  }
  const role = current.fields.get("record_role");
  if (role !== "journal-collection" && role !== "journal-tag") {
    throw new Error("Only a journal collection or tag can be updated here.");
  }
  const fields = new Map(current.fields);
  fields.set(
    "name",
    requiredText(
      input.name,
      role === "journal-collection" ? "Collection name" : "Tag name",
      role === "journal-collection" ? 256 : 128,
    ),
  );
  fields.set("color", cleanColor(input.color));
  if (role === "journal-collection") {
    fields.set(
      "description",
      cleanText(
        (input as JournalCollectionInput).description,
        "Collection description",
        4_096,
        true,
      ),
    );
  }
  fields.set("updated_at_us", nowUs());
  return { ...current, fields };
}

/** Soft-delete a collection or tag and detach it from entries with reversible link markers. */
export function archiveJournalOrganizerRecord(
  current: ArchiveRecord,
  entries: readonly ArchiveRecord[],
): ArchiveRecord[] {
  const role = current.fields.get("record_role");
  if (
    current.type !== RecordType.settings ||
    (role !== "journal-collection" && role !== "journal-tag") ||
    current.fields.get("_deleted") === "true"
  ) {
    throw new Error("Select an active journal collection or tag to archive.");
  }
  const isCollection = role === "journal-collection";
  const linkField = isCollection ? "collection_ids" : "tag_ids";
  const restoreField = isCollection ? "_trash_restore_collection_refs" : "_trash_restore_tag_refs";
  const timestamp = nowUs();
  const changes = entries.flatMap((entry) => {
    if (
      entry.type !== RecordType.settings ||
      entry.fields.get("record_role") !== "journal-entry" ||
      entry.fields.get("_deleted") === "true"
    )
      return [];
    const fields = new Map(entry.fields);
    const ids = splitIds(fields.get(linkField) ?? "");
    if (!ids.includes(current.id)) return [];
    fields.set(linkField, ids.filter((id) => id !== current.id).join(","));
    fields.set(restoreField, mergeIds(fields.get(restoreField) ?? "", current.id));
    fields.set("updated_at_us", timestamp);
    return [{ ...entry, fields }];
  });
  const fields = new Map(current.fields);
  fields.set("_deleted", "true");
  fields.set("deleted_at_us", timestamp);
  fields.set("updated_at_us", timestamp);
  return [...changes, { ...current, fields }];
}

/** Restore an archived collection or tag and put its prior links back on live entries. */
export function restoreJournalOrganizerRecord(
  current: ArchiveRecord,
  entries: readonly ArchiveRecord[],
): ArchiveRecord[] {
  const role = current.fields.get("record_role");
  if (
    current.type !== RecordType.settings ||
    (role !== "journal-collection" && role !== "journal-tag") ||
    current.fields.get("_deleted") !== "true"
  ) {
    throw new Error("Select an archived journal collection or tag to restore.");
  }
  const isCollection = role === "journal-collection";
  const linkField = isCollection ? "collection_ids" : "tag_ids";
  const restoreField = isCollection ? "_trash_restore_collection_refs" : "_trash_restore_tag_refs";
  const timestamp = nowUs();
  const changes = entries.flatMap((entry) => {
    if (entry.type !== RecordType.settings || entry.fields.get("record_role") !== "journal-entry")
      return [];
    const fields = new Map(entry.fields);
    const pending = splitIds(fields.get(restoreField) ?? "");
    if (!pending.includes(current.id)) return [];
    fields.set(linkField, mergeIds(fields.get(linkField) ?? "", current.id));
    const remaining = pending.filter((id) => id !== current.id);
    if (remaining.length) fields.set(restoreField, remaining.join(","));
    else fields.delete(restoreField);
    fields.set("updated_at_us", timestamp);
    return [{ ...entry, fields }];
  });
  const fields = new Map(current.fields);
  fields.delete("_deleted");
  fields.delete("deleted_at_us");
  fields.set("restored_at_us", timestamp);
  fields.set("updated_at_us", timestamp);
  return [...changes, { ...current, fields }];
}

/** Return editable text only for the simple paragraph representation used by the current form. */
export function notesEditState(document: ArchiveRecord | null | undefined): NotesEditState {
  if (!document) return { text: "", editable: true };
  if (
    document.type !== RecordType.settings ||
    document.fields.get("record_role") !== "journal-notes" ||
    document.fields.get("_deleted") === "true"
  ) {
    return { text: "", editable: false };
  }
  const count = document.fields.get("block_count");
  if (count === "0") return { text: "", editable: true };
  if (count !== "1" || !document.fields.get("block.0.id")) {
    return { text: "", editable: false };
  }
  if (document.fields.get("block.0.kind") !== "paragraph") {
    return { text: "", editable: false };
  }
  return { text: document.fields.get("block.0.text") ?? "", editable: true };
}

/** Update a session while preserving its recording, transcript, timing, and extension fields. */
export function updateSessionRecords(
  current: ArchiveRecord,
  input: SessionInput,
  notesDocument: ArchiveRecord | null,
  updateNotes: boolean,
): ArchiveRecord[] {
  if (current.type !== RecordType.session) {
    throw new Error("Only a session can be updated with session details.");
  }
  const timestamp = nowUs();
  const fields = new Map(current.fields);
  fields.set("student_id", input.studentId || "anonymous");
  fields.set("subject", cleanText(input.subject, "Subject", 200));
  fields.set("title", requiredText(input.title, "Session title", 240));
  fields.set("learning_objectives", cleanText(input.objectives, "Learning objectives", 4_000));
  fields.set("updated_at_us", timestamp);
  const updatedSession = { ...current, fields };
  if (!updateNotes) return [updatedSession];
  const sessionId = current.id;
  const existingId = fields.get("notes_document_id") ?? "";
  const noteDocument = updateNotesDocument(
    notesDocument,
    existingId,
    input.notes,
    sessionId,
    "",
    timestamp,
  );
  fields.set("notes_document_id", noteDocument.id);
  return [updatedSession, noteDocument];
}

/** Update a journal entry and, when safe, its single-paragraph notes document. */
export function updateJournalRecords(
  current: ArchiveRecord,
  input: JournalInput,
  notesDocument: ArchiveRecord | null,
  updateNotes: boolean,
): ArchiveRecord[] {
  if (
    current.type !== RecordType.settings ||
    current.fields.get("record_role") !== "journal-entry"
  ) {
    throw new Error("Only a journal entry can be updated with journal details.");
  }
  validateJournalDate(input.date);
  const timestamp = nowUs();
  const fields = new Map(current.fields);
  fields.set("title", requiredText(input.title, "Entry title", 240));
  fields.set("entry_date", input.date);
  if (input.collectionIds !== undefined) {
    fields.set("collection_ids", encodeJournalIds(input.collectionIds, "Collection"));
  }
  if (input.tagIds !== undefined) fields.set("tag_ids", encodeJournalIds(input.tagIds, "Tag"));
  fields.set("updated_at_us", timestamp);
  const updatedEntry = { ...current, fields };
  if (!updateNotes) return [updatedEntry];
  const entryId = current.id;
  const existingId = fields.get("notes_document_id") ?? "";
  const noteDocument = updateNotesDocument(
    notesDocument,
    existingId,
    input.notes,
    entryId,
    "",
    timestamp,
  );
  fields.set("notes_document_id", noteDocument.id);
  return [updatedEntry, noteDocument];
}

function encodeJournalIds(ids: readonly string[], label: string): string {
  if (ids.length > 10_000) throw new Error(`${label} links exceed the archive limit.`);
  const unique = new Set<string>();
  for (const rawId of ids) {
    const id = rawId.trim().toLowerCase();
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(id)) {
      throw new Error(`${label} links must use valid archive IDs.`);
    }
    unique.add(id);
  }
  return [...unique].join(",");
}

function splitIds(value: string): string[] {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function mergeIds(value: string, id: string): string {
  const ids = splitIds(value);
  if (!ids.some((item) => item.toLowerCase() === id.toLowerCase())) ids.push(id);
  return ids.join(",");
}

function cleanColor(value: string): string {
  const color = value.trim();
  if (color && !/^#[\da-f]{6}$/iu.test(color)) {
    throw new Error("Choose a color in #RRGGBB format.");
  }
  return color.toLowerCase();
}

function record(type: number, id: string, fields: Record<string, string>): ArchiveRecord {
  return {
    type,
    id,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map(Object.entries(fields)),
    blob: new Uint8Array(),
  };
}

function makeNotesDocument(
  id: string,
  entryId: string,
  sessionId: string,
  text: string,
  timestamp: string,
): ArchiveRecord {
  return record(RecordType.settings, id, {
    record_role: "journal-notes",
    entry_id: entryId,
    session_id: sessionId,
    created_at_us: timestamp,
    updated_at_us: timestamp,
    block_count: text ? "1" : "0",
    ...(text
      ? {
          "block.0.id": crypto.randomUUID(),
          "block.0.kind": "paragraph",
          "block.0.text": text,
        }
      : {}),
  });
}

function updateNotesDocument(
  current: ArchiveRecord | null,
  expectedId: string,
  value: string,
  entryId: string,
  sessionId: string,
  timestamp: string,
): ArchiveRecord {
  const text = cleanText(value, "Notes", 100_000, true);
  if (!current) {
    if (expectedId) {
      throw new Error(
        "The linked notes document is missing. The archive needs review before editing.",
      );
    }
    const id = crypto.randomUUID();
    return makeNotesDocument(id, entryId, sessionId, text, timestamp);
  }
  const state = notesEditState(current);
  if (!state.editable || current.id !== expectedId) {
    throw new Error(
      "These notes use a structured format and cannot be replaced by the simple editor.",
    );
  }
  const fields = new Map(current.fields);
  for (const key of fields.keys()) {
    if (/^block\.\d+\.(?:id|kind|text)$/u.test(key)) fields.delete(key);
  }
  fields.set("entry_id", entryId);
  fields.set("session_id", sessionId);
  fields.set("updated_at_us", timestamp);
  fields.set("block_count", text ? "1" : "0");
  if (text) {
    fields.set("block.0.id", current.fields.get("block.0.id") ?? crypto.randomUUID());
    fields.set("block.0.kind", "paragraph");
    fields.set("block.0.text", text);
  }
  return { ...current, fields };
}

function validateJournalDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new Error("Choose a valid journal date.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]!) {
    throw new Error("Choose a valid journal date.");
  }
}

function requiredText(value: string, label: string, maximum: number): string {
  const cleaned = cleanText(value, label, maximum).trim();
  if (!cleaned) throw new Error(`${label} is required.`);
  return cleaned;
}

function cleanText(
  value: string,
  label: string,
  maximumBytes: number,
  allowLineBreaks = false,
): string {
  if (!isWellFormedUnicode(value)) {
    throw new Error(`${label} contains invalid Unicode text.`);
  }
  if (new TextEncoder().encode(value).byteLength > maximumBytes)
    throw new Error(`${label} must be ${maximumBytes.toLocaleString()} UTF-8 bytes or fewer.`);
  if (containsUnsupportedControl(value, allowLineBreaks)) {
    throw new Error(`${label} contains unsupported control characters.`);
  }
  return allowLineBreaks ? value : value.trim();
}

function containsUnsupportedControl(value: string, allowLineBreaks: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 0x7f || (code < 0x20 && !(allowLineBreaks && (code === 0x09 || code === 0x0a)))) {
      return true;
    }
  }
  return false;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
