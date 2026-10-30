import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";

const encoder = new TextEncoder();

export interface EvidenceUpdateInput {
  readonly title: string;
  readonly type: string;
  readonly content: string;
  readonly priority: string;
}

export type EvidenceCreateInput = EvidenceUpdateInput;

interface TranscriptCandidate {
  type: string;
  title: string;
  method: string;
  confidence: string;
}

const cueGroups: readonly {
  type: string;
  title: string;
  method: string;
  confidence: string;
  cues: readonly string[];
}[] = [
  {
    type: "explicit-instruction-candidate",
    title: "Possible spoken tutor instruction",
    method: "instruction-phrase-heuristic",
    confidence: "0.72",
    cues: [
      "remember to",
      "make sure",
      "you should",
      "you need to",
      "don't forget",
      "next time",
      "practice this",
      "try to",
    ],
  },
  {
    type: "important-concept-candidate",
    title: "Possible concept or definition",
    method: "concept-phrase-heuristic",
    confidence: "0.58",
    cues: [
      "means ",
      "is defined as",
      "is called",
      "the idea is",
      "the concept of",
      "in other words",
    ],
  },
  {
    type: "explanation-candidate",
    title: "Possible explanation",
    method: "explanation-phrase-heuristic",
    confidence: "0.54",
    cues: ["because ", "this works", "the reason is", "so that", "which means"],
  },
  {
    type: "tutor-correction-candidate",
    title: "Possible correction",
    method: "correction-phrase-heuristic",
    confidence: "0.62",
    cues: [
      "not quite",
      "actually,",
      "instead of",
      "the correct",
      "should be",
      "that should be",
      "you meant",
    ],
  },
  {
    type: "student-mistake-candidate",
    title: "Possible learner misconception",
    method: "first-person-error-phrase-heuristic",
    confidence: "0.56",
    cues: ["i thought", "i assumed", "i confused", "i forgot", "my mistake", "i mixed up"],
  },
  {
    type: "worked-example-candidate",
    title: "Possible worked example",
    method: "example-phrase-heuristic",
    confidence: "0.62",
    cues: ["for example", "let's solve", "suppose ", "consider ", "an example"],
  },
  {
    type: "learning-outcome-candidate",
    title: "Possible learning outcome",
    method: "learning-outcome-phrase-heuristic",
    confidence: "0.62",
    cues: ["now i understand", "i see now", "i learned", "i can now", "that makes sense"],
  },
  {
    type: "follow-up-priority-candidate",
    title: "Possible follow-up priority",
    method: "follow-up-phrase-heuristic",
    confidence: "0.65",
    cues: [
      "next session",
      "for next time",
      "practice this",
      "review this",
      "homework",
      "before next",
    ],
  },
];

const relationships = [
  "explains",
  "corrects",
  "demonstrates",
  "supports",
  "contradicts",
  "elaborates",
  "causes",
  "precedes",
  "exemplifies",
  "assesses",
  "references",
  "depends-on",
  "reinforces",
  "recommends",
  "derived-from",
] as const;

export type EvidenceRelationship = (typeof relationships)[number];

export function classifyTranscriptEvidence(text: string): TranscriptCandidate[] {
  const normalized = text.toLowerCase();
  if (!normalized) return [];
  const candidates = cueGroups
    .filter((group) => group.cues.some((cue) => normalized.includes(cue)))
    .map(({ type, title, method, confidence }) => ({ type, title, method, confidence }));
  if (normalized.includes("?")) {
    candidates.push({
      type: "student-question-candidate",
      title: "Possible question",
      method: "question-mark-heuristic",
      confidence: "0.5",
    });
  }
  return candidates;
}

export async function extractSessionEvidence(
  snapshot: ArchiveSnapshot,
  session: ArchiveRecord,
): Promise<ArchiveRecord[]> {
  if (session.type !== RecordType.session || session.fields.get("_deleted") === "true") {
    throw new Error("Choose an active session before extracting evidence.");
  }
  const sessionId = session.id.toLowerCase();
  const [annotations, transcripts, existing] = await Promise.all([
    snapshot.listRecords(RecordType.annotation),
    snapshot.listRecords(RecordType.transcriptSegment),
    snapshot.listRecords(RecordType.evidenceNode),
  ]);
  const existingSources = new Set<string>();
  const legacySources = new Set<string>();
  for (const node of existing) {
    const annotationId = node.fields.get("source_annotation_id") ?? "";
    const annotationRevision = node.fields.get("source_annotation_revision") ?? "";
    if (annotationId) {
      if (annotationRevision)
        existingSources.add(`annotation:${annotationId}:${annotationRevision}`);
      else legacySources.add(`annotation:${annotationId}:${node.fields.get("content") ?? ""}`);
    }
    const segmentIds = splitCommaList(node.fields.get("source_segment_ids") ?? "");
    const revision = node.fields.get("source_segment_revision") ?? "";
    for (const segmentId of segmentIds) {
      const nodeType = node.fields.get("type") ?? "";
      if (revision) existingSources.add(`segment:${segmentId}:${nodeType}:${revision}`);
      else
        legacySources.add(`segment:${segmentId}:${nodeType}:${node.fields.get("content") ?? ""}`);
    }
  }

  const records: ArchiveRecord[] = [];
  for (const annotation of annotations) {
    if (annotation.fields.get("session_id") !== sessionId) continue;
    const sourceKey = `annotation:${annotation.id}:${annotation.revision}`;
    const legacyKey = `annotation:${annotation.id}:${annotation.fields.get("content") ?? ""}`;
    if (existingSources.has(sourceKey) || legacySources.has(legacyKey)) continue;
    records.push({
      type: RecordType.evidenceNode,
      id: newUuid(),
      revision: 0n,
      previousOffset: 0n,
      blob: new Uint8Array(),
      fields: new Map([
        ["session_id", sessionId],
        ["student_id", session.fields.get("student_id") ?? ""],
        ["type", annotation.fields.get("type") ?? "general-note"],
        ["title", annotation.fields.get("title") ?? "Observation"],
        ["content", annotation.fields.get("content") ?? ""],
        ["priority", annotation.fields.get("priority") ?? "normal"],
        ["origin", "tutor-authored"],
        ["source_annotation_id", annotation.id],
        ["source_annotation_revision", annotation.revision.toString()],
        ["source_segment_ids", ""],
        ["source_asset_ids", ""],
        ["start_time_us", annotation.fields.get("start_time_us") ?? "0"],
        ["end_time_us", annotation.fields.get("end_time_us") ?? "0"],
        ["verification_state", "human-verified"],
        ["created_at_us", nowUs()],
      ]),
    });
    existingSources.add(sourceKey);
  }

  for (const segment of transcripts) {
    if (segment.fields.get("session_id") !== sessionId) continue;
    const text = segment.fields.get("text") ?? "";
    for (const candidate of classifyTranscriptEvidence(text)) {
      const sourceKey = `segment:${segment.id}:${candidate.type}:${segment.revision}`;
      const legacyKey = `segment:${segment.id}:${candidate.type}:${text}`;
      if (existingSources.has(sourceKey) || legacySources.has(legacyKey)) continue;
      records.push({
        type: RecordType.evidenceNode,
        id: newUuid(),
        revision: 0n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map([
          ["session_id", sessionId],
          ["student_id", session.fields.get("student_id") ?? ""],
          ["type", candidate.type],
          ["title", candidate.title],
          ["content", text],
          ["priority", "normal"],
          ["origin", "transcript-derived-candidate"],
          ["source_annotation_id", ""],
          ["source_segment_ids", segment.id],
          ["source_segment_revision", segment.revision.toString()],
          ["source_segment_revisions", `${segment.id}=${segment.revision}`],
          ["source_asset_ids", segment.fields.get("linked_asset_ids") ?? ""],
          ["source_speaker_label", segment.fields.get("speaker_label") ?? ""],
          ["start_time_us", segment.fields.get("start_time_us") ?? "0"],
          ["end_time_us", segment.fields.get("end_time_us") ?? "0"],
          ["verification_state", "needs-review"],
          ["detection_method", candidate.method],
          ["detection_confidence", candidate.confidence],
          ["created_at_us", nowUs()],
        ]),
      });
      existingSources.add(sourceKey);
    }
  }
  return records;
}

/** Create tutor-authored evidence from one current transcript revision. */
export async function makeEvidenceRecord(
  snapshot: ArchiveSnapshot,
  sessionId: string,
  segmentId: string,
  input: EvidenceCreateInput,
): Promise<ArchiveRecord> {
  if (!isUuid(sessionId) || !isUuid(segmentId)) {
    throw new Error("Choose a valid session and transcript segment.");
  }
  const [session, segment] = await Promise.all([
    snapshot.getRecord(RecordType.session, sessionId),
    snapshot.getRecord(RecordType.transcriptSegment, segmentId),
  ]);
  if (
    !session ||
    session.type !== RecordType.session ||
    session.fields.get("_deleted") === "true"
  ) {
    throw new Error("Choose an active session before creating evidence.");
  }
  if (
    !segment ||
    segment.type !== RecordType.transcriptSegment ||
    segment.fields.get("_deleted") === "true"
  ) {
    throw new Error("Choose an active transcript segment as the evidence source.");
  }
  if (segment.fields.get("session_id")?.toLowerCase() !== session.id.toLowerCase()) {
    throw new Error("Choose a transcript segment from the selected session.");
  }

  const title = cleanEvidenceText(input.title, "Evidence title", 512);
  const type = cleanEvidenceText(
    input.type.trim().toLowerCase().replace(/\s+/gu, "-"),
    "Evidence type",
    128,
  );
  const content = cleanEvidenceText(input.content, "Evidence content", 16 * 1024 * 1024);
  const priority = cleanEvidenceText(input.priority, "Evidence priority", 32);
  const normalizedSessionId = session.id.toLowerCase();
  const normalizedSegmentId = segment.id.toLowerCase();
  const revision = segment.revision.toString();
  return {
    type: RecordType.evidenceNode,
    id: newUuid(),
    revision: 0n,
    previousOffset: 0n,
    blob: new Uint8Array(),
    fields: new Map([
      ["session_id", normalizedSessionId],
      ["student_id", session.fields.get("student_id") ?? ""],
      ["type", type],
      ["title", title],
      ["content", content],
      ["priority", priority],
      ["origin", "tutor-authored"],
      ["source_annotation_id", ""],
      ["source_segment_ids", normalizedSegmentId],
      ["source_segment_revision", revision],
      ["source_segment_revisions", `${normalizedSegmentId}=${revision}`],
      ["source_asset_ids", segment.fields.get("linked_asset_ids") ?? ""],
      ["source_speaker_label", segment.fields.get("speaker_label") ?? ""],
      ["start_time_us", segment.fields.get("start_time_us") ?? "0"],
      ["end_time_us", segment.fields.get("end_time_us") ?? "0"],
      ["verification_state", "needs-review"],
      ["created_at_us", nowUs()],
    ]),
  };
}

export async function reviewEvidenceRecord(
  snapshot: ArchiveSnapshot,
  record: ArchiveRecord,
  outcome: "human-verified" | "rejected",
): Promise<ArchiveRecord> {
  if (record.type !== RecordType.evidenceNode || record.fields.get("_deleted") === "true") {
    throw new Error("Select an active evidence item to review.");
  }
  if (outcome === "human-verified" && !(await evidenceSourcesAreCurrent(snapshot, record))) {
    throw new Error(
      "Evidence cannot be approved because its sources are missing, stale, or from another session.",
    );
  }
  const fields = new Map(record.fields);
  fields.set("verification_state", outcome);
  fields.set("reviewed_at_us", nowUs());
  return { ...record, fields };
}

export function updateEvidenceRecord(
  current: ArchiveRecord,
  input: EvidenceUpdateInput,
): ArchiveRecord {
  if (current.type !== RecordType.evidenceNode || current.fields.get("_deleted") === "true") {
    throw new Error("Select an active evidence item to edit.");
  }
  const title = cleanEvidenceText(input.title, "Evidence title", 512);
  const type = cleanEvidenceText(
    input.type.trim().toLowerCase().replace(/\s+/gu, "-"),
    "Evidence type",
    128,
  );
  const content = cleanEvidenceText(input.content, "Evidence content", 16 * 1024 * 1024);
  const priority = cleanEvidenceText(input.priority, "Evidence priority", 32);
  const fields = new Map(current.fields);
  fields.set("title", title);
  fields.set("type", type);
  fields.set("content", content);
  fields.set("priority", priority);
  fields.set("verification_state", "needs-review");
  fields.set("reviewed_at_us", "");
  fields.set("updated_at_us", nowUs());
  return { ...current, fields };
}

/** Move an evidence node and its graph edges to recoverable Trash as one archive update. */
export async function trashEvidenceRecord(
  snapshot: ArchiveSnapshot,
  current: ArchiveRecord,
): Promise<ArchiveRecord[]> {
  if (current.type !== RecordType.evidenceNode || current.fields.get("_deleted") === "true") {
    throw new Error("Select an active evidence item to move to Trash.");
  }
  const timestamp = nowUs();
  const changes = [markEvidenceRecordDeleted(current, current.id, timestamp)];
  for (const edge of await snapshot.listRecords(RecordType.evidenceEdge, true)) {
    if (
      edge.fields.get("_deleted") === "true" ||
      (edge.fields.get("from_id")?.toLowerCase() !== current.id.toLowerCase() &&
        edge.fields.get("to_id")?.toLowerCase() !== current.id.toLowerCase())
    ) {
      continue;
    }
    changes.push(markEvidenceRecordDeleted(edge, current.id, timestamp));
  }
  return changes;
}

/** Restore an evidence node with every graph edge moved with it. */
export async function restoreEvidenceRecordGroup(
  snapshot: ArchiveSnapshot,
  current: ArchiveRecord,
): Promise<ArchiveRecord[]> {
  if (current.type !== RecordType.evidenceNode || current.fields.get("_deleted") !== "true") {
    throw new Error("Select an evidence item from Trash to restore it.");
  }
  const groupId = current.id.toLowerCase();
  const timestamp = nowUs();
  const changes = [restoreEvidenceRecord(current, timestamp)];
  for (const edge of await snapshot.listRecords(RecordType.evidenceEdge, true)) {
    if (
      edge.fields.get("_deleted") !== "true" ||
      edge.fields.get("_trash_group_id")?.toLowerCase() !== groupId
    ) {
      continue;
    }
    changes.push(restoreEvidenceRecord(edge, timestamp));
  }
  return changes;
}

export async function evidenceSourcesAreCurrent(
  snapshot: ArchiveSnapshot,
  record: ArchiveRecord,
): Promise<boolean> {
  const sessionId = record.fields.get("session_id") ?? "";
  let hasSources = false;
  const validate = async (
    type: number,
    ids: readonly string[],
    revisions: ReadonlyMap<string, bigint>,
  ): Promise<boolean> => {
    for (const id of ids) {
      hasSources = true;
      if (!isUuid(id)) return false;
      const source = await snapshot.getRecord(type, id);
      if (
        !source ||
        source.fields.get("_deleted") === "true" ||
        ((source.fields.get("session_id") ?? "") !== "" &&
          source.fields.get("session_id") !== sessionId)
      ) {
        return false;
      }
      const expected = revisions.get(id);
      if (expected !== undefined && source.revision !== expected) return false;
    }
    return true;
  };

  const annotationId = record.fields.get("source_annotation_id") ?? "";
  if (annotationId) {
    const revision = record.fields.get("source_annotation_revision");
    const expected = revision ? parseRevision(revision) : undefined;
    if (revision && expected === null) return false;
    if (
      !(await validate(
        RecordType.annotation,
        [annotationId],
        expected === undefined ? new Map() : new Map([[annotationId, expected]]),
      ))
    ) {
      return false;
    }
  }

  const segmentIds = splitCommaList(record.fields.get("source_segment_ids") ?? "");
  const segmentRevisionMap = new Map<string, bigint>();
  for (const entry of splitCommaList(record.fields.get("source_segment_revisions") ?? "")) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) return false;
    const revision = parseRevision(entry.slice(separator + 1));
    if (revision === null) return false;
    segmentRevisionMap.set(entry.slice(0, separator), revision);
  }
  if (!(await validate(RecordType.transcriptSegment, segmentIds, segmentRevisionMap))) return false;

  const assetIds = splitCommaList(record.fields.get("source_asset_ids") ?? "");
  if (!(await validate(RecordType.assetMetadata, assetIds, new Map()))) return false;
  return hasSources;
}

export async function makeEvidenceEdge(
  snapshot: ArchiveSnapshot,
  fromId: string,
  toId: string,
  relationship: string,
): Promise<ArchiveRecord> {
  if (!isUuid(fromId) || !isUuid(toId) || fromId.toLowerCase() === toId.toLowerCase()) {
    throw new Error("Choose two different evidence items.");
  }
  const normalizedRelationship = relationship.trim().toLowerCase();
  if (!(relationships as readonly string[]).includes(normalizedRelationship)) {
    throw new Error("Choose a supported evidence relationship.");
  }
  const [from, to, edges] = await Promise.all([
    snapshot.getRecord(RecordType.evidenceNode, fromId),
    snapshot.getRecord(RecordType.evidenceNode, toId),
    snapshot.listRecords(RecordType.evidenceEdge),
  ]);
  if (
    !from ||
    !to ||
    from.fields.get("_deleted") === "true" ||
    to.fields.get("_deleted") === "true"
  ) {
    throw new Error("Both evidence items must be active.");
  }
  const sessionId = from.fields.get("session_id") ?? "";
  if (!sessionId || sessionId !== to.fields.get("session_id")) {
    throw new Error("Evidence relationships must stay within one session.");
  }
  if (
    edges.some(
      (edge) =>
        edge.fields.get("from_id") === from.id &&
        edge.fields.get("to_id") === to.id &&
        edge.fields.get("relationship") === normalizedRelationship,
    )
  ) {
    throw new Error("That evidence relationship already exists.");
  }
  return {
    type: RecordType.evidenceEdge,
    id: newUuid(),
    revision: 0n,
    previousOffset: 0n,
    blob: new Uint8Array(),
    fields: new Map([
      ["session_id", sessionId],
      ["from_id", from.id],
      ["to_id", to.id],
      ["relationship", normalizedRelationship],
      ["created_at_us", nowUs()],
    ]),
  };
}

/** Remove one active relationship using the archive's recoverable soft-delete fields. */
export function trashEvidenceEdge(edge: ArchiveRecord): ArchiveRecord {
  if (edge.type !== RecordType.evidenceEdge || edge.fields.get("_deleted") === "true") {
    throw new Error("Select an active evidence relationship to remove.");
  }
  return markEvidenceRecordDeleted(edge, edge.id, nowUs());
}

export const EVIDENCE_RELATIONSHIPS = relationships;

function splitCommaList(value: string): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

function parseRevision(value: string): bigint | null {
  if (!/^\d+$/u.test(value)) return null;
  try {
    const revision = BigInt(value);
    return revision > 0n ? revision : null;
  } catch {
    return null;
  }
}

function isUuid(value: string): boolean {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value);
}

function nowUs(): string {
  return (BigInt(Date.now()) * 1000n).toString();
}

function cleanEvidenceText(value: string, label: string, maxBytes: number): string {
  if (!value.trim()) throw new Error(`${label} cannot be empty.`);
  if (encoder.encode(value).byteLength > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes.toLocaleString()}-byte limit.`);
  }
  return value;
}

function markEvidenceRecordDeleted(
  record: ArchiveRecord,
  groupId: string,
  timestamp: string,
): ArchiveRecord {
  const fields = new Map(record.fields);
  fields.set("_deleted", "true");
  fields.set("_trash_group_id", groupId);
  fields.set("deleted_at_us", timestamp);
  fields.set("updated_at_us", timestamp);
  return { ...record, fields };
}

function restoreEvidenceRecord(record: ArchiveRecord, timestamp: string): ArchiveRecord {
  const fields = new Map(record.fields);
  fields.delete("_deleted");
  fields.delete("_trash_group_id");
  fields.delete("deleted_at_us");
  fields.set("restored_at_us", timestamp);
  fields.set("updated_at_us", timestamp);
  return { ...record, fields };
}
