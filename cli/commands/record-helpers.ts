import { randomUUID } from "node:crypto";
import { RecordType, recordTypeName, type ArchiveRecord } from "../../frontend/archive/format";
import { type ArchiveSnapshot } from "../../frontend/archive/archive";
import { type SanitizedCopySummary } from "../../frontend/archive/sanitized-copy";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { CliError, field, parseIntegerField, timestampNow } from "./shared";
import type { ParsedArguments } from "./shared";

export function parseSessionDateBound(
  value: string | undefined,
  inclusiveEnd: boolean,
): bigint | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new CliError("Use a valid calendar date in YYYY-MM-DD format.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]!) {
    throw new CliError("Use a valid calendar date in YYYY-MM-DD format.");
  }
  const start = new Date(0);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCFullYear(year, month - 1, day);
  if (!inclusiveEnd) return BigInt(start.getTime()) * 1000n;
  start.setUTCDate(start.getUTCDate() + 1);
  return BigInt(start.getTime()) * 1000n - 1n;
}

export function sessionStartedAt(record: ArchiveRecord): bigint {
  const startedAt = field(record, "started_at_us");
  if (/^-?\d+$/u.test(startedAt)) return BigInt(startedAt);
  return parseIntegerField(field(record, "created_at_us"));
}

export function toPlainRecord(record: ArchiveRecord): Record<string, string> {
  return {
    id: record.id,
    type: recordTypeName(record.type),
    revision: record.revision.toString(),
    ...Object.fromEntries(record.fields),
  };
}

export function toFlatTranscriptRecord(record: ArchiveRecord): Record<string, string> {
  return {
    id: record.id,
    type: "transcript",
    revision: record.revision.toString(),
    ...Object.fromEntries(record.fields),
  };
}

export function transcriptTimeRange(record: ArchiveRecord): string {
  if (field(record, "timestamp_state") === "not-timestamped") return "time not provided";
  const parse = (name: string): bigint => {
    const raw = field(record, name);
    return /^-?\d+$/u.test(raw) ? BigInt(raw) : 0n;
  };
  const start = parse("start_time_us");
  const end = parse("end_time_us");
  const format = (value: bigint): string => {
    const seconds = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
    const hours = seconds / 3600n;
    const minutes = (seconds / 60n) % 60n;
    const remainder = seconds % 60n;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
  };
  return `${format(start)}${end > start ? `–${format(end)}` : ""}`;
}

export function readableStudentRecord(record: ArchiveRecord): string {
  return [
    `student ${record.id} (revision ${record.revision})`,
    ...[...record.fields]
      .filter(([key]) => key !== "progress_classifications")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `  ${key}: ${value}`),
  ].join("\n");
}

export function readableSessionRecord(record: ArchiveRecord): string {
  return [
    `session ${record.id} (revision ${record.revision})`,
    ...[...record.fields]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `  ${key}: ${value}`),
  ].join("\n");
}

export function studentProfileObject(record: ArchiveRecord): Record<string, unknown> {
  const fields = Object.fromEntries(record.fields);
  delete fields["progress_classifications"];
  return {
    id: record.id.toLowerCase(),
    type: "student",
    revision: record.revision.toString(),
    ...fields,
  };
}

export function validateEvidenceText(value: string, label: string, maximumBytes: number): string {
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new CliError(`${label} must be ${maximumBytes} UTF-8 bytes or fewer.`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x7f ||
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    ) {
      throw new CliError(`${label} contains unsupported control characters.`);
    }
  }
  return value;
}

export function validateUpdatedField(fieldName: string, rawValue: string): string {
  const limits: Readonly<Record<string, number>> = {
    display_name: 200,
    grade: 80,
    subjects: 1_000,
    learning_objectives: 4_000,
    tutor_notes: 20_000,
    title: 240,
    subject: 200,
    student_id: 36,
    entry_date: 10,
  };
  const value = rawValue.trim();
  const maximum = limits[fieldName] ?? 100_000;
  if (value.length > maximum)
    throw new CliError(
      `${fieldName.replaceAll("_", " ")} must be ${maximum.toLocaleString()} characters or fewer.`,
    );
  // eslint-disable-next-line no-control-regex -- Prevent control bytes from entering the archive.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new CliError(
      `${fieldName.replaceAll("_", " ")} contains unsupported control characters.`,
    );
  }
  if ((fieldName === "display_name" || fieldName === "title") && !value) {
    throw new CliError(`${fieldName.replaceAll("_", " ")} is required.`);
  }
  if (
    fieldName === "entry_date" &&
    (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
  ) {
    throw new CliError("Choose a valid journal date.");
  }
  return value;
}

export function validateStudentProfileField(fieldName: string, value: string): string {
  const limits: Readonly<Record<string, number>> = {
    display_name: 256,
    grade: 128,
    subjects: 2_048,
    learning_objectives: 4_096,
    known_difficulties: 4_096,
    demonstrated_improvements: 4_096,
    preferred_guide_template: 128,
    tutor_notes: 16_384,
  };
  const maximumBytes = limits[fieldName];
  if (maximumBytes === undefined) throw new CliError("Unsupported student profile field.");
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new CliError(`Student profile fields must be ${maximumBytes} UTF-8 bytes or fewer.`);
  }
  const multilineFields: ReadonlySet<string> = new Set([
    "learning_objectives",
    "known_difficulties",
    "demonstrated_improvements",
    "tutor_notes",
  ]);
  const allowLineBreaks = multilineFields.has(fieldName);
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x7f ||
      (codePoint < 0x20 && !(allowLineBreaks && (codePoint === 0x09 || codePoint === 0x0a)))
    ) {
      throw new CliError("Student profile fields contain unsupported control characters.");
    }
  }
  return value;
}

export async function updateRecord(
  path: string,
  type: number,
  id: string,
  allowedOptions: Readonly<Record<string, string>>,
  args: ParsedArguments,
  fixedFields: Readonly<Record<string, string>> = {},
): Promise<ArchiveRecord> {
  const current = await getLiveRecordAtPath(path, type, id);
  const updated = updateFields(current, allowedOptions, args, fixedFields);
  const [saved] = await mutateArchive(path, [updated]);
  return saved ?? updated;
}

export function updateFields(
  current: ArchiveRecord,
  allowedOptions: Readonly<Record<string, string>>,
  args: ParsedArguments,
  fixedFields: Readonly<Record<string, string>> = {},
): ArchiveRecord {
  const fields = new Map(current.fields);
  let changed = false;
  for (const [option, fieldName] of Object.entries(allowedOptions)) {
    const value = args.options.get(option);
    if (value === undefined) continue;
    fields.set(fieldName, validateUpdatedField(fieldName, value));
    changed = true;
  }
  for (const [fieldName, value] of Object.entries(fixedFields)) {
    fields.set(fieldName, value);
    changed = true;
  }
  if (!changed) throw new CliError("Provide at least one supported field to update.");
  if (fields.has("updated_at_us") && !Object.hasOwn(fixedFields, "updated_at_us")) {
    fields.set("updated_at_us", timestampNow());
  }
  return { ...current, revision: 0n, previousOffset: 0n, fields };
}

export async function getLiveRecordAtPath(
  path: string,
  type: number,
  id: string,
): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    return await requireLiveRecord(snapshot, type, id);
  } finally {
    await closeSnapshot(snapshot);
  }
}

export async function getRecordAtPath(
  path: string,
  type: number,
  id: string,
): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    const record = await snapshot.getRecord(type, id);
    if (!record) throw new CliError(`Record ${id} was not found in this archive.`);
    return record;
  } finally {
    await closeSnapshot(snapshot);
  }
}

export async function requireLiveRecord(
  snapshot: ArchiveSnapshot,
  type: number,
  id: string,
): Promise<ArchiveRecord> {
  const record = await snapshot.getRecord(type, id);
  if (!record || field(record, "_deleted") === "true")
    throw new CliError(`Record ${id} was not found in this archive.`);
  return record;
}

export async function getJournalEntry(
  snapshot: ArchiveSnapshot,
  id: string,
): Promise<ArchiveRecord> {
  const record = await requireLiveRecord(snapshot, RecordType.settings, id);
  if (field(record, "record_role") !== "journal-entry")
    throw new CliError(`Journal entry ${id} was not found in this archive.`);
  return record;
}

export async function getJournalEntryAtPath(path: string, id: string): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    return await getJournalEntry(snapshot, id);
  } finally {
    await closeSnapshot(snapshot);
  }
}

export function updateJournalNote(current: ArchiveRecord, text: string): ArchiveRecord {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in imported note content.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new CliError("Journal notes contain unsupported control characters.");
  }
  if (text.length > 100_000)
    throw new CliError("Journal notes must be 100,000 characters or fewer.");
  const fields = new Map(
    [...current.fields].filter(([key]) => !/^block\.\d+\.(id|kind|text)$/u.test(key)),
  );
  const note = text.trim();
  fields.set("block_count", note ? "1" : "0");
  if (note) {
    fields.set("block.0.id", randomUUID());
    fields.set("block.0.kind", "paragraph");
    fields.set("block.0.text", note);
  }
  fields.set("updated_at_us", timestampNow());
  return { ...current, revision: 0n, previousOffset: 0n, fields };
}

export function sanitizedCopySummaryObject(
  summary: SanitizedCopySummary,
  output: string,
  status: string,
  encryptedOutput = false,
): Record<string, string | number | boolean> {
  return {
    status,
    output,
    encrypted_output: encryptedOutput,
    source_generation: summary.sourceGeneration.toString(),
    selection_fingerprint: summary.selectionFingerprint,
    students: summary.students,
    sessions: summary.sessions,
    annotations: summary.annotations,
    assets: summary.assets,
    evidence_items: summary.evidenceItems,
    guides: summary.guides,
    recording_tracks: summary.recordingTracks,
    recording_chunks: summary.recordings,
    generation_logs: summary.generationLogs,
    credentials: summary.credentials,
    warning:
      "Review included records and destination before confirming; excluded data is omitted from the new archive.",
  };
}

export function formatSanitizedCopySummary(summary: SanitizedCopySummary): string {
  return [
    `  Students: ${summary.students}`,
    `  Sessions: ${summary.sessions}`,
    `  Annotations: ${summary.annotations}`,
    `  Assets: ${summary.assets}`,
    `  Evidence items: ${summary.evidenceItems}`,
    `  Guides: ${summary.guides}`,
    `  Recording tracks: ${summary.recordingTracks}`,
    `  Recording chunks: ${summary.recordings}`,
    `  Generation logs: ${summary.generationLogs}`,
    `  Credentials: ${summary.credentials}`,
  ].join("\n");
}
