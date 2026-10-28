import { RecordType, type ArchiveRecord } from "../frontend/archive/format";
import type { ArchiveSnapshot } from "../frontend/archive/archive";
import { evidenceSourcesAreCurrent } from "../frontend/domain/evidence";

interface Candidate {
  record: ArchiveRecord;
  kind: string;
  content: string;
  priority: number;
  confidence: number;
  tutor: boolean;
  required: boolean;
}

/** Produce a bounded, provenance-preserving preview of session material. */
export async function packAiContext(
  snapshot: ArchiveSnapshot,
  sessionId: string,
  budget: number,
  itemLimit: number,
) {
  const session = await snapshot.getRecord(RecordType.session, sessionId);
  if (!session || session.fields.get("_deleted") === "true") throw new Error("Session not found.");
  const [transcripts, annotations, evidence, assets] = await Promise.all([
    snapshot.listRecords(RecordType.transcriptSegment),
    snapshot.listRecords(RecordType.annotation),
    snapshot.listRecords(RecordType.evidenceNode),
    snapshot.listRecords(RecordType.assetMetadata),
  ]);
  const active = (r: ArchiveRecord) =>
    r.fields.get("session_id") === sessionId && r.fields.get("_deleted") !== "true";
  const priority = (value: string | undefined) =>
    value === "critical" ? 3 : value === "high" ? 2 : value === "low" ? 0 : 1;
  const candidates: Candidate[] = [];
  for (const record of transcripts.filter(active))
    candidates.push({
      record,
      kind: "transcript",
      content: record.fields.get("text") ?? "",
      priority: record.fields.get("verification_state") === "human-verified" ? 2 : 1,
      confidence: 0.7,
      tutor: false,
      required: false,
    });
  for (const record of annotations.filter(active))
    candidates.push({
      record,
      kind: "tutor-annotation",
      content: [record.fields.get("title"), record.fields.get("content")]
        .filter(Boolean)
        .join("\n"),
      priority: priority(record.fields.get("priority")),
      confidence: 1,
      tutor: true,
      required: record.fields.get("type") === "explicit-instruction",
    });
  for (const record of evidence.filter(active)) {
    const hasSources = ["source_annotation_id", "source_segment_ids", "source_asset_ids"].some(
      (key) => Boolean(record.fields.get(key)),
    );
    if (
      (hasSources || record.fields.get("origin") === "transcript-derived-candidate") &&
      !(await evidenceSourcesAreCurrent(snapshot, record))
    )
      continue;
    const verified = record.fields.get("verification_state") === "human-verified";
    candidates.push({
      record,
      kind: "evidence",
      content: record.fields.get("content") ?? "",
      priority: verified ? 3 : priority(record.fields.get("priority")),
      confidence: verified ? 1 : 0.5,
      tutor: record.fields.get("origin") === "tutor-authored",
      required: false,
    });
  }
  const internal = new Set([
    "audio-track",
    "waveform-pyramid",
    "sparse-timestamp-seek-index",
    "asset-blob-manifest",
    "asset-blob-chunk",
  ]);
  for (const record of assets.filter(active)) {
    if (internal.has(record.fields.get("record_role") ?? "")) continue;
    candidates.push({
      record,
      kind: "asset",
      content: `Imported asset: ${record.fields.get("file_name") ?? ""}${record.fields.get("extracted_text") ? `\n${record.fields.get("extracted_text")}` : ""}`,
      priority: 0,
      confidence: 0.4,
      tutor: false,
      required: false,
    });
  }
  candidates.sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      b.priority - a.priority ||
      Number(b.tutor) - Number(a.tutor) ||
      b.confidence - a.confidence ||
      compareTimestamp(
        b.record.fields.get("updated_at_us"),
        a.record.fields.get("updated_at_us"),
      ) ||
      b.record.id.localeCompare(a.record.id),
  );
  const encoder = new TextEncoder();
  const included: object[] = [];
  const omitted: object[] = [];
  let used = 0;
  for (const candidate of candidates) {
    // Split on Unicode character boundaries and prefer a nearby paragraph or line break.
    const characters = Array.from(candidate.content);
    let offset = 0;
    let byteOffset = 0;
    let index = 0;
    do {
      let end = offset;
      let bytes = 0;
      while (end < characters.length) {
        const length = encoder.encode(characters[end]!).length;
        if (bytes + length > itemLimit * 3 && end > offset) break;
        bytes += length;
        end++;
        if (bytes > itemLimit * 3) break;
      }
      if (end < characters.length) {
        const segment = characters.slice(offset, end).join("");
        const paragraph = segment.lastIndexOf("\n\n");
        const line = segment.lastIndexOf("\n");
        const boundary =
          paragraph >= segment.length / 2
            ? paragraph + 2
            : line >= segment.length / 2
              ? line + 1
              : 0;
        if (boundary) end = offset + Array.from(segment.slice(0, boundary)).length;
      }
      const content = characters.slice(offset, end).join("");
      bytes = encoder.encode(content).length;
      const tokens = Math.ceil(bytes / 3);
      if (tokens > itemLimit || tokens > budget - used)
        omitted.push({
          source_id: candidate.record.id,
          reason:
            tokens > itemLimit ? "exceeds-item-token-limit" : "exceeds-remaining-context-budget",
          estimated_tokens: tokens,
          fragment_index: index,
        });
      else {
        included.push({
          source_id: candidate.record.id,
          source_kind: candidate.kind,
          content,
          source_byte_start: byteOffset,
          source_byte_end: byteOffset + bytes,
          estimated_tokens: tokens,
          fragment_index: index,
          tutor_authored: candidate.tutor,
        });
        used += tokens;
      }
      offset = end;
      byteOffset += bytes;
      index++;
    } while (offset < characters.length);
  }
  return {
    session_id: sessionId,
    token_budget: budget,
    used_tokens: used,
    complete: omitted.length === 0,
    included,
    omitted,
  };
}

function compareTimestamp(a: string | undefined, b: string | undefined): number {
  const parse = (value: string | undefined) => (/^\d+$/u.test(value ?? "") ? BigInt(value!) : 0n);
  const left = parse(a);
  const right = parse(b);
  return left > right ? 1 : left < right ? -1 : 0;
}
