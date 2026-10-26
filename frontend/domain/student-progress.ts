import { RecordType, type ArchiveRecord } from "../archive/format";

export const STUDENT_PROGRESS_CLASSIFICATIONS = [
  "newly-observed",
  "recurring",
  "partial-improvement",
  "demonstrated-mastery",
  "unverified-improvement",
  "not-revisited",
] as const;

export type StudentProgressClassification = (typeof STUDENT_PROGRESS_CLASSIFICATIONS)[number];

export interface StudentProgressItem {
  skill: string;
  classification: StudentProgressClassification;
  note: string;
  reviewedBy: string;
  reviewedAtUs: string;
  evidenceSourceIds: string[];
}

export interface StudentProgressReviewInput {
  skill: string;
  classification: StudentProgressClassification;
  note: string;
  reviewedBy: string;
  evidenceSourceIds: string[];
}

const MAX_PROGRESS_BYTES = 4 * 1024 * 1024;
const MAX_TIMESTAMP = 9_223_372_036_854_775_807n;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

class ProgressReader {
  private position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  consumeHeader(): boolean {
    if (decoder.decode(this.bytes.subarray(0, 4)) !== "TP1;") return false;
    this.position = 4;
    return true;
  }

  readCount(maximum: number): number | undefined {
    const delimiter = this.bytes.indexOf(0x3b, this.position);
    if (delimiter <= this.position) return undefined;
    const raw = new TextDecoder().decode(this.bytes.subarray(this.position, delimiter));
    if (!/^\d+$/u.test(raw)) return undefined;
    const count = Number(raw);
    if (!Number.isSafeInteger(count) || count > maximum) return undefined;
    this.position = delimiter + 1;
    return count;
  }

  readString(maximumBytes: number): string | undefined {
    const delimiter = this.bytes.indexOf(0x3a, this.position);
    if (delimiter <= this.position) return undefined;
    const raw = new TextDecoder().decode(this.bytes.subarray(this.position, delimiter));
    if (!/^\d+$/u.test(raw)) return undefined;
    const length = Number(raw);
    if (
      !Number.isSafeInteger(length) ||
      length > maximumBytes ||
      length > this.bytes.length - delimiter - 1
    ) {
      return undefined;
    }
    this.position = delimiter + 1;
    try {
      const value = decoder.decode(this.bytes.subarray(this.position, this.position + length));
      this.position += length;
      return value;
    } catch {
      return undefined;
    }
  }

  finished(): boolean {
    return this.position === this.bytes.length;
  }
}

export function decodeStudentProgress(value: string): StudentProgressItem[] {
  if (!value) return [];
  const bytes = encoder.encode(value);
  if (bytes.length > MAX_PROGRESS_BYTES) {
    throw new Error("Student progress data exceeds the 4 MiB limit.");
  }
  const reader = new ProgressReader(bytes);
  const invalid = (): never => {
    throw new Error("Student progress data is malformed.");
  };
  if (!reader.consumeHeader()) return invalid();
  const count = reader.readCount(512);
  if (count === undefined) return invalid();

  const items: StudentProgressItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const skill = reader.readString(256);
    const classification = reader.readString(64);
    const note = reader.readString(4_096);
    const reviewedBy = reader.readString(128);
    const reviewedAtUs = reader.readString(32);
    const sourceCount = reader.readCount(64);
    if (
      skill === undefined ||
      skill.length === 0 ||
      classification === undefined ||
      !isStudentProgressClassification(classification) ||
      note === undefined ||
      reviewedBy === undefined ||
      reviewedBy.length === 0 ||
      reviewedAtUs === undefined ||
      !/^\d+$/u.test(reviewedAtUs) ||
      BigInt(reviewedAtUs) <= 0n ||
      BigInt(reviewedAtUs) > MAX_TIMESTAMP ||
      sourceCount === undefined ||
      sourceCount === 0 ||
      hasInvalidControls(skill, false) ||
      hasInvalidControls(reviewedBy, false) ||
      hasInvalidControls(note, true)
    ) {
      return invalid();
    }
    const evidenceSourceIds: string[] = [];
    const unique = new Set<string>();
    for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
      const sourceId = canonicalizeProgressUuid(reader.readString(36) ?? "");
      if (!sourceId || unique.has(sourceId)) return invalid();
      unique.add(sourceId);
      evidenceSourceIds.push(sourceId);
    }
    items.push({ skill, classification, note, reviewedBy, reviewedAtUs, evidenceSourceIds });
  }
  if (!reader.finished()) return invalid();
  return items;
}

export function encodeStudentProgress(items: readonly StudentProgressItem[]): string {
  if (items.length > 512) throw new Error("A student may have at most 512 progress items.");
  let output = `TP1;${items.length};`;
  for (const item of items) {
    const skill = validateText(item.skill, "Skill", 256, false, false);
    const note = validateText(item.note, "Review note", 4_096, true, false);
    const reviewedBy = validateText(item.reviewedBy, "Reviewer", 128, false, false);
    if (!normalizeStudentProgressSkill(skill)) throw new Error("Skill is required.");
    if (!normalizeStudentProgressSkill(reviewedBy)) throw new Error("Reviewer is required.");
    if (!isStudentProgressClassification(item.classification)) {
      throw new Error("Choose a valid progress classification.");
    }
    if (
      !/^\d+$/u.test(item.reviewedAtUs) ||
      BigInt(item.reviewedAtUs) <= 0n ||
      BigInt(item.reviewedAtUs) > MAX_TIMESTAMP
    ) {
      throw new Error("Review time must be a positive timestamp.");
    }
    if (item.evidenceSourceIds.length === 0 || item.evidenceSourceIds.length > 64) {
      throw new Error("Each review must cite between 1 and 64 evidence items.");
    }
    appendString(skill);
    appendString(item.classification);
    appendString(note);
    appendString(reviewedBy);
    appendString(item.reviewedAtUs);
    output += `${item.evidenceSourceIds.length};`;
    const unique = new Set<string>();
    for (const rawId of item.evidenceSourceIds) {
      const id = canonicalizeProgressUuid(rawId);
      if (!id || unique.has(id)) {
        throw new Error("Evidence IDs must be unique, valid UUIDs.");
      }
      unique.add(id);
      appendString(id);
    }
  }
  if (encoder.encode(output).length > MAX_PROGRESS_BYTES) {
    throw new Error("Student progress data exceeds the 4 MiB limit.");
  }
  return output;

  function appendString(value: string): void {
    output += `${encoder.encode(value).length}:${value}`;
  }
}

export function isStudentProgressClassification(
  value: string,
): value is StudentProgressClassification {
  return STUDENT_PROGRESS_CLASSIFICATIONS.some((item) => item === value);
}

export function validateProgressEvidence(
  studentId: string,
  evidenceSourceIds: readonly string[],
  sessions: readonly ArchiveRecord[],
  evidence: readonly ArchiveRecord[],
  classification?: StudentProgressClassification,
): ArchiveRecord[] {
  if (evidenceSourceIds.length === 0) {
    throw new Error("Choose at least one evidence item for this review.");
  }
  if (evidenceSourceIds.length > 64) {
    throw new Error("A review can cite at most 64 evidence items.");
  }

  const canonicalStudentId = canonicalizeProgressUuid(studentId);
  if (!canonicalStudentId) throw new Error("Student ID is not a valid UUID.");
  const sessionsById = new Map<string, ArchiveRecord>();
  for (const session of sessions) {
    const id = canonicalizeProgressUuid(session.id);
    if (id && session.fields.get("_deleted") !== "true") sessionsById.set(id, session);
  }
  const evidenceById = new Map<string, ArchiveRecord>();
  for (const item of evidence) {
    const id = canonicalizeProgressUuid(item.id);
    if (id && item.type === RecordType.evidenceNode && item.fields.get("_deleted") !== "true") {
      evidenceById.set(id, item);
    }
  }
  const selected: ArchiveRecord[] = [];
  const sourceSessions = new Set<string>();
  const unique = new Set<string>();

  for (const rawId of evidenceSourceIds) {
    const id = canonicalizeProgressUuid(rawId);
    if (!id) throw new Error("An evidence item has an invalid ID.");
    if (unique.has(id)) throw new Error("Evidence items must not be selected more than once.");
    unique.add(id);
    const item = evidenceById.get(id);
    if (!item) throw new Error("Every cited evidence item must be active in this archive.");
    const sessionId = canonicalizeProgressUuid(item.fields.get("session_id") ?? "");
    if (!sessionId) {
      throw new Error("Cited evidence must refer to a valid session in this archive.");
    }
    const session = sessionsById.get(sessionId);
    if (
      !session ||
      canonicalizeProgressUuid(session.fields.get("student_id") ?? "") !== canonicalStudentId
    ) {
      throw new Error("Cited evidence must come from a session belonging to this student.");
    }
    const evidenceStudentId = item.fields.get("student_id") ?? "";
    if (evidenceStudentId && canonicalizeProgressUuid(evidenceStudentId) !== canonicalStudentId) {
      throw new Error("Cited evidence is assigned to a different student.");
    }
    sourceSessions.add(sessionId);
    selected.push(item);
  }

  if (
    classification === "recurring" ||
    classification === "partial-improvement" ||
    classification === "demonstrated-mastery"
  ) {
    if (sourceSessions.size < 2) {
      throw new Error(
        `${classificationLabel(classification)} requires evidence from at least two sessions.`,
      );
    }
  }
  if (
    classification === "demonstrated-mastery" &&
    selected.some((item) => item.fields.get("verification_state") !== "human-verified")
  ) {
    throw new Error(
      "Demonstrated mastery requires human-verified evidence from every cited source.",
    );
  }
  return selected;
}

export function reviewStudentProgressRecord(
  student: ArchiveRecord,
  input: StudentProgressReviewInput,
  sessions: readonly ArchiveRecord[],
  evidence: readonly ArchiveRecord[],
): ArchiveRecord {
  if (student.type !== RecordType.student || student.fields.get("_deleted") === "true") {
    throw new Error("Choose an active student before saving a progress review.");
  }
  const skill = validateText(input.skill, "Skill", 256, false, false);
  const reviewer = validateText(input.reviewedBy, "Reviewer", 128, false, false);
  if (!normalizeStudentProgressSkill(skill)) throw new Error("Skill is required.");
  if (!normalizeStudentProgressSkill(reviewer)) throw new Error("Reviewer is required.");
  const note = validateText(input.note, "Review note", 4_096, true, false);
  const sources = validateProgressEvidence(
    student.id,
    input.evidenceSourceIds,
    sessions,
    evidence,
    input.classification,
  );
  const items = decodeStudentProgress(student.fields.get("progress_classifications") ?? "");
  const newItem: StudentProgressItem = {
    skill,
    classification: input.classification,
    note,
    reviewedBy: reviewer,
    reviewedAtUs: (BigInt(Date.now()) * 1000n).toString(),
    evidenceSourceIds: sources.map((item) => item.id.toLocaleLowerCase()),
  };
  const normalizeSkill = normalizeStudentProgressSkill;
  const existingIndex = items.findIndex(
    (item) => normalizeSkill(item.skill) === normalizeSkill(skill),
  );
  if (existingIndex < 0) items.push(newItem);
  else items[existingIndex] = newItem;

  const fields = new Map(student.fields);
  fields.set("progress_classifications", encodeStudentProgress(items));
  fields.set("updated_at_us", newItem.reviewedAtUs);
  return { ...student, fields };
}

export function classificationLabel(value: StudentProgressClassification): string {
  const labels: Record<StudentProgressClassification, string> = {
    "newly-observed": "Newly observed",
    recurring: "Recurring",
    "partial-improvement": "Partial improvement",
    "demonstrated-mastery": "Demonstrated mastery",
    "unverified-improvement": "Unverified improvement",
    "not-revisited": "Not revisited",
  };
  return labels[value];
}

export function normalizeStudentProgressSkill(value: string): string {
  return value
    .replace(/^[ \t]+|[ \t]+$/gu, "")
    .replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function validateText(
  raw: string,
  label: string,
  maximumBytes: number,
  allowLineBreaks: boolean,
  required: boolean,
): string {
  const value = required ? raw.trim() : raw;
  if (required && !value) throw new Error(`${label} is required.`);
  if (encoder.encode(value).length > maximumBytes || hasInvalidControls(value, allowLineBreaks)) {
    throw new Error(`${label} is too long or contains unsupported control characters.`);
  }
  return value;
}

function hasInvalidControls(value: string, allowLineBreaks: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f || (code < 0x20 && !(allowLineBreaks && (code === 0x0a || code === 0x09)))) {
      return true;
    }
  }
  return false;
}

export function canonicalizeProgressUuid(value: string): string | undefined {
  const hexadecimal = value.replace(/-/gu, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(hexadecimal)) return undefined;
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}
