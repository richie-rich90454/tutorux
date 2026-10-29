import { RecordType, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";
import { evidenceSourcesAreCurrent } from "../domain/evidence";

export const DEFAULT_AI_CONTEXT_TOKEN_BUDGET = 8192;
export const MAX_AI_CONTEXT_TOKEN_BUDGET = 10_000_000;
export const MAX_AI_CONTEXT_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_AI_CONTEXT_CANDIDATES = 100_000;

const encoder = new TextEncoder();
const INTERNAL_ASSET_ROLES = new Set([
  "audio-track",
  "waveform-pyramid",
  "sparse-timestamp-seek-index",
  "asset-blob-manifest",
  "asset-blob-chunk",
]);

export interface AiContextPackOptions {
  tokenBudget?: number;
  maximumItemTokens?: number;
  /** Supply the selected model's tokenizer when one is available. */
  countTokens?: (text: string) => number;
}

export interface PackedAiContextItem {
  source_id: string;
  source_kind: string;
  content: string;
  source_byte_start: number;
  source_byte_end: number;
  estimated_tokens: number;
  fragment_index: number;
  tutor_authored: boolean;
}

export interface OmittedAiContextItem {
  source_id: string;
  reason: "exceeds-item-token-limit" | "exceeds-remaining-context-budget";
  estimated_tokens: number;
  fragment_index: number;
}

export interface AiContextPack {
  session_id: string;
  token_budget: number;
  used_tokens: number;
  complete: boolean;
  included: PackedAiContextItem[];
  omitted: OmittedAiContextItem[];
}

interface Candidate {
  record: ArchiveRecord;
  sourceKind: string;
  content: string;
  priority: number;
  confidence: number;
  tutorAuthored: boolean;
  required: boolean;
  updatedAtUs: bigint;
  order: number;
}

/**
 * Estimate tokens using the same conservative UTF-8 byte/3 rule as the C++ context packer.
 * Callers can inject a model tokenizer through AiContextPackOptions.countTokens.
 */
export function estimateAiTokenCount(text: string): number {
  const bytes = encoder.encode(text).byteLength;
  return Math.ceil(bytes / 3);
}

/** Pack prioritized session sources into bounded, source-addressable fragments. */
export async function packAiContext(
  snapshot: ArchiveSnapshot,
  sessionId: string,
  options: AiContextPackOptions = {},
): Promise<AiContextPack> {
  const tokenBudget = options.tokenBudget ?? DEFAULT_AI_CONTEXT_TOKEN_BUDGET;
  const maximumItemTokens = options.maximumItemTokens ?? tokenBudget;
  validateLimits(tokenBudget, maximumItemTokens);
  const countTokens = options.countTokens ?? estimateAiTokenCount;
  const session = await snapshot.getRecord(RecordType.session, sessionId);
  if (!session || session.fields.get("_deleted") === "true") {
    throw new Error("Choose an active session before packing AI context.");
  }

  const [transcripts, annotations, evidence, assets] = await Promise.all([
    snapshot.listRecords(RecordType.transcriptSegment),
    snapshot.listRecords(RecordType.annotation),
    snapshot.listRecords(RecordType.evidenceNode),
    snapshot.listRecords(RecordType.assetMetadata),
  ]);
  const active = (record: ArchiveRecord) =>
    record.fields.get("session_id") === sessionId && record.fields.get("_deleted") !== "true";
  const candidates: Candidate[] = [];
  let totalSourceBytes = 0;
  const add = (
    record: ArchiveRecord,
    sourceKind: string,
    content: string,
    priority: number,
    confidence: number,
    tutorAuthored: boolean,
    required: boolean,
  ) => {
    if (candidates.length >= MAX_AI_CONTEXT_CANDIDATES) {
      throw new Error("AI context contains too many source records to pack safely.");
    }
    const contentBytes = encoder.encode(content).byteLength;
    if (contentBytes > MAX_AI_CONTEXT_SOURCE_BYTES) {
      throw new Error("An AI context source exceeds the 64 MiB per-record limit.");
    }
    if (totalSourceBytes > MAX_AI_CONTEXT_SOURCE_BYTES - contentBytes) {
      throw new Error("The selected AI context sources exceed the 64 MiB total limit.");
    }
    totalSourceBytes += contentBytes;
    candidates.push({
      record,
      sourceKind,
      content,
      priority,
      confidence,
      tutorAuthored,
      required,
      updatedAtUs: parseNonnegativeBigInt(record.fields.get("updated_at_us")),
      order: candidates.length,
    });
  };

  for (const record of transcripts.filter(active)) {
    add(
      record,
      "transcript",
      record.fields.get("text") ?? "",
      record.fields.get("verification_state") === "human-verified" ? 2 : 1,
      0.7,
      false,
      false,
    );
  }
  for (const record of annotations.filter(active)) {
    const title = record.fields.get("title") ?? "";
    const content = record.fields.get("content") ?? "";
    add(
      record,
      "tutor-annotation",
      title ? `${title}\n${content}` : content,
      priorityOf(record.fields.get("priority")),
      1,
      true,
      record.fields.get("type") === "explicit-instruction",
    );
  }
  for (const record of evidence.filter(active)) {
    const fields = record.fields;
    const hasSources =
      Boolean(fields.get("source_annotation_id")) ||
      Boolean(fields.get("source_segment_ids")) ||
      Boolean(fields.get("source_asset_ids"));
    if (
      (hasSources || fields.get("origin") === "transcript-derived-candidate") &&
      !(await evidenceSourcesAreCurrent(snapshot, record))
    ) {
      continue;
    }
    const verified = fields.get("verification_state") === "human-verified";
    const priority = priorityOf(fields.get("priority"));
    add(
      record,
      "evidence",
      fields.get("content") ?? "",
      verified || priority === 3 ? 3 : priority === 0 ? 1 : priority,
      verified ? 1 : 0.5,
      fields.get("origin") === "tutor-authored",
      false,
    );
  }
  for (const record of assets.filter(active)) {
    if (INTERNAL_ASSET_ROLES.has(record.fields.get("record_role") ?? "")) continue;
    const filename = record.fields.get("file_name") ?? record.fields.get("filename") ?? "";
    const extractedText = record.fields.get("extracted_text") ?? "";
    add(
      record,
      "asset",
      `Imported asset: ${filename}${extractedText ? `\n${extractedText}` : ""}`,
      0,
      0.4,
      false,
      false,
    );
  }

  candidates.sort(
    (left, right) =>
      Number(right.required) - Number(left.required) ||
      right.priority - left.priority ||
      Number(right.tutorAuthored) - Number(left.tutorAuthored) ||
      right.confidence - left.confidence ||
      compareBigInt(right.updatedAtUs, left.updatedAtUs) ||
      right.record.id.localeCompare(left.record.id) ||
      left.order - right.order,
  );

  const included: PackedAiContextItem[] = [];
  const omitted: OmittedAiContextItem[] = [];
  let usedTokens = 0;
  for (const candidate of candidates) {
    if (
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1
    ) {
      throw new Error("AI context confidence must be between zero and one.");
    }
    const characters = codePoints(candidate.content);
    const ranges = splitByTokenLimit(characters, maximumItemTokens, countTokens);
    for (let fragmentIndex = 0; fragmentIndex < ranges.length; fragmentIndex += 1) {
      const [start, end, sourceByteStart, sourceByteEnd] = ranges[fragmentIndex]!;
      const content = characters.slice(start, end).join("");
      const estimatedTokens = checkedTokenCount(countTokens, content);
      if (estimatedTokens > maximumItemTokens) {
        omitted.push({
          source_id: candidate.record.id,
          reason: "exceeds-item-token-limit",
          estimated_tokens: estimatedTokens,
          fragment_index: fragmentIndex,
        });
      } else if (estimatedTokens > tokenBudget - usedTokens) {
        omitted.push({
          source_id: candidate.record.id,
          reason: "exceeds-remaining-context-budget",
          estimated_tokens: estimatedTokens,
          fragment_index: fragmentIndex,
        });
      } else {
        included.push({
          source_id: candidate.record.id,
          source_kind: candidate.sourceKind,
          content,
          source_byte_start: sourceByteStart,
          source_byte_end: sourceByteEnd,
          estimated_tokens: estimatedTokens,
          fragment_index: fragmentIndex,
          tutor_authored: candidate.tutorAuthored,
        });
        usedTokens += estimatedTokens;
      }
    }
  }
  return {
    session_id: sessionId,
    token_budget: tokenBudget,
    used_tokens: usedTokens,
    complete: omitted.length === 0,
    included,
    omitted,
  };
}

function splitByTokenLimit(
  chars: readonly string[],
  maximumTokens: number,
  countTokens: (value: string) => number,
): Array<[start: number, end: number, byteStart: number, byteEnd: number]> {
  if (chars.length === 0) return [[0, 0, 0, 0]];
  const byteOffsets = [0];
  for (const character of chars) {
    byteOffsets.push(byteOffsets.at(-1)! + utf8CodePointBytes(character));
  }
  const fragments: Array<[number, number, number, number]> = [];
  let start = 0;
  while (start < chars.length) {
    let low = start;
    let high = chars.length + 1;
    while (low + 1 < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (checkedTokenCount(countTokens, chars.slice(start, middle).join("")) <= maximumTokens) {
        low = middle;
      } else {
        high = middle;
      }
    }
    let end = low;
    if (end === start) end = Math.min(start + 1, chars.length);
    if (end < chars.length) end = preferLineBoundary(chars, start, end);
    fragments.push([start, end, byteOffsets[start]!, byteOffsets[end]!]);
    start = end;
  }
  return fragments;
}

function preferLineBoundary(chars: readonly string[], start: number, end: number): number {
  const segment = chars.slice(start, end);
  const preferredMinimum = Math.floor(segment.length / 2);
  let paragraphBreak = -1;
  for (let index = segment.length - 2; index >= preferredMinimum; index -= 1) {
    if (segment[index] === "\n" && segment[index + 1] === "\n") {
      paragraphBreak = index;
      break;
    }
  }
  if (paragraphBreak >= 0) return start + paragraphBreak + 2;
  for (let index = segment.length - 1; index >= preferredMinimum; index -= 1) {
    if (segment[index] === "\n") return start + index + 1;
  }
  return end;
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function utf8CodePointBytes(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  return codePoint <= 0xffff ? 3 : 4;
}

function checkedTokenCount(countTokens: (value: string) => number, value: string): number {
  const count = countTokens(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("The AI tokenizer must return a nonnegative safe integer.");
  }
  return count;
}

function validateLimits(tokenBudget: number, maximumItemTokens: number): void {
  if (
    !Number.isSafeInteger(tokenBudget) ||
    tokenBudget < 1 ||
    tokenBudget > MAX_AI_CONTEXT_TOKEN_BUDGET
  ) {
    throw new Error("AI context token budget must be between 1 and 10,000,000.");
  }
  if (
    !Number.isSafeInteger(maximumItemTokens) ||
    maximumItemTokens < 1 ||
    maximumItemTokens > tokenBudget
  ) {
    throw new Error("Maximum AI context item tokens must be between 1 and its context budget.");
  }
}

function priorityOf(value: string | undefined): number {
  switch (value) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "low":
      return 0;
    default:
      return 1;
  }
}

function parseNonnegativeBigInt(value: string | undefined): bigint {
  if (!/^\d+$/u.test(value ?? "")) return 0n;
  try {
    return BigInt(value!);
  } catch {
    return 0n;
  }
}

function compareBigInt(left: bigint, right: bigint): number {
  return left > right ? 1 : left < right ? -1 : 0;
}
