import { RecordType, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";
import { guideDraftFromRecord } from "./guides";

export interface SessionTrashCounts {
  audioChunks: number;
  sessionNotes: number;
  transcriptSegments: number;
  annotations: number;
  guides: number;
  assets: number;
  entriesUpdated: number;
  evidenceNodes: number;
  totalRecords: number;
}

export interface SessionTrashPlan {
  changes: ArchiveRecord[];
  scopeRecords: ArchiveRecord[];
  audioChunkRecords: ArchiveRecord[];
  counts: SessionTrashCounts;
}

const SESSION_DEPENDENCY_TYPES = [
  RecordType.transcriptSegment,
  RecordType.annotation,
  RecordType.assetMetadata,
  RecordType.evidenceNode,
  RecordType.guide,
  RecordType.waveformIndex,
] as const;

const SESSION_RESTORE_TYPES = [
  ...SESSION_DEPENDENCY_TYPES,
  RecordType.evidenceEdge,
  RecordType.settings,
] as const;

/** Build the complete, revision-bound set of records affected by session deletion. */
export async function planSessionTrash(
  snapshot: ArchiveSnapshot,
  session: ArchiveRecord,
): Promise<SessionTrashPlan> {
  if (session.type !== RecordType.session || session.fields.get("_deleted") === "true") {
    throw new Error("Choose an active session to move to Trash.");
  }

  const sessionId = session.id.toLowerCase();
  const timestamp = currentTimestampUs();
  const deletionRecords: ArchiveRecord[] = [];
  const deletedGuides: ArchiveRecord[] = [];
  const deletedAssets: ArchiveRecord[] = [];
  const deletedEvidenceNodes: ArchiveRecord[] = [];
  const deletedSessionNotes: ArchiveRecord[] = [];
  const updatedEntries: ArchiveRecord[] = [];
  const audioChunkRecords = await getSessionAudioChunks(snapshot, session, false, true);

  for (const type of SESSION_DEPENDENCY_TYPES) {
    const records = await snapshot.listRecords(type);
    for (const record of records) {
      if (field(record, "session_id").toLowerCase() !== sessionId) continue;
      const trashed = markRecordTrashed(record, sessionId, timestamp);
      if (type === RecordType.guide) deletedGuides.push(trashed);
      else if (type === RecordType.assetMetadata) deletedAssets.push(trashed);
      else if (type === RecordType.evidenceNode) deletedEvidenceNodes.push(trashed);
      else deletionRecords.push(trashed);
    }
  }

  const settings = await snapshot.listRecords(RecordType.settings);
  for (const record of settings) {
    if (
      field(record, "record_role") === "journal-notes" &&
      field(record, "session_id").toLowerCase() === sessionId
    ) {
      deletedSessionNotes.push(markRecordTrashed(record, sessionId, timestamp));
    }
  }

  const removedRecordIds = new Set<string>([sessionId]);
  for (const record of [
    ...deletionRecords,
    ...deletedGuides,
    ...deletedAssets,
    ...deletedEvidenceNodes,
    ...deletedSessionNotes,
    ...audioChunkRecords,
  ]) {
    removedRecordIds.add(record.id.toLowerCase());
  }

  const evidenceEdges = await snapshot.listRecords(RecordType.evidenceEdge);
  for (const edge of evidenceEdges) {
    if (
      field(edge, "session_id").toLowerCase() === sessionId ||
      removedRecordIds.has(field(edge, "from_id").toLowerCase()) ||
      removedRecordIds.has(field(edge, "to_id").toLowerCase())
    ) {
      deletionRecords.push(markRecordTrashed(edge, sessionId, timestamp));
    }
  }

  assertNoExternalGuideReferences(
    await snapshot.listRecords(RecordType.guide),
    sessionId,
    removedRecordIds,
  );
  assertNoExternalAnnotationReferences(
    await snapshot.listRecords(RecordType.annotation),
    sessionId,
    removedRecordIds,
  );
  assertNoExternalEvidenceReferences(
    await snapshot.listRecords(RecordType.evidenceNode),
    sessionId,
    removedRecordIds,
  );

  const removedGuideIds = new Set(deletedGuides.map((record) => record.id.toLowerCase()));
  const removedAssetIds = new Set(deletedAssets.map((record) => record.id.toLowerCase()));
  for (const record of settings) {
    if (field(record, "record_role") !== "journal-entry") continue;
    const fields = new Map(record.fields);
    const restoreSessionIds: string[] = [];
    const restoreGuideIds: string[] = [];
    const restoreAssetIds: string[] = [];
    let changed = false;
    changed =
      removeReferences(fields, "session_ids", new Set([sessionId]), restoreSessionIds) || changed;
    changed =
      removeReferences(fields, "study_guide_ids", removedGuideIds, restoreGuideIds) || changed;
    changed =
      removeReferences(fields, "attachment_ids", removedAssetIds, restoreAssetIds) || changed;
    if (!changed) continue;
    fields.set("_trash_session_group_id", sessionId);
    if (restoreSessionIds.length)
      fields.set("_trash_restore_session_refs", restoreSessionIds.join(","));
    if (restoreGuideIds.length) fields.set("_trash_restore_guide_refs", restoreGuideIds.join(","));
    if (restoreAssetIds.length) fields.set("_trash_restore_asset_refs", restoreAssetIds.join(","));
    fields.set("updated_at_us", timestamp);
    updatedEntries.push({ ...record, fields });
  }

  const trashedSession = markRecordTrashed(session, sessionId, timestamp);
  const scopeRecords = [
    ...audioChunkRecords,
    ...deletionRecords,
    ...deletedGuides,
    ...deletedAssets,
    ...deletedEvidenceNodes,
    ...deletedSessionNotes,
    ...updatedEntries,
    trashedSession,
  ];
  const changes = scopeRecords.filter((record) => record.type !== RecordType.audioChunk);
  const counts: SessionTrashCounts = {
    audioChunks: audioChunkRecords.length,
    sessionNotes: deletedSessionNotes.length,
    transcriptSegments: deletionRecords.filter(
      (record) => record.type === RecordType.transcriptSegment,
    ).length,
    annotations: deletionRecords.filter((record) => record.type === RecordType.annotation).length,
    guides: deletedGuides.length,
    assets: deletedAssets.length,
    entriesUpdated: updatedEntries.length,
    evidenceNodes: deletedEvidenceNodes.length,
    totalRecords: scopeRecords.length,
  };
  return { changes, scopeRecords, audioChunkRecords, counts };
}

/** Load and mark PCM chunks only after the reviewed deletion scope is confirmed. */
export async function loadSessionAudioTrashChanges(
  snapshot: ArchiveSnapshot,
  sessionId: string,
  metadataRecords: readonly ArchiveRecord[],
): Promise<ArchiveRecord[]> {
  const timestamp = currentTimestampUs();
  const changes: ArchiveRecord[] = [];
  for (const metadata of metadataRecords) {
    const record = await snapshot.getRecord(RecordType.audioChunk, metadata.id);
    if (!record || record.revision !== metadata.revision) {
      throw new Error("The recording changed after the deletion scope was reviewed.");
    }
    if (field(record, "_deleted") === "true") {
      throw new Error(
        "A recording chunk is already in Trash. Review the session deletion scope again.",
      );
    }
    changes.push(markRecordTrashed(record, sessionId.toLowerCase(), timestamp));
  }
  return changes;
}

/** Restore a session and all surviving records marked as part of its Trash group. */
export async function planSessionRestore(
  snapshot: ArchiveSnapshot,
  session: ArchiveRecord,
): Promise<ArchiveRecord[]> {
  if (session.type !== RecordType.session || session.fields.get("_deleted") !== "true") {
    throw new Error("This session is not in Trash.");
  }
  const sessionId = session.id.toLowerCase();
  const timestamp = currentTimestampUs();
  const changes: ArchiveRecord[] = [];

  for (const type of SESSION_RESTORE_TYPES) {
    const records = await snapshot.listRecords(type, true);
    for (const record of records) {
      if (
        field(record, "_deleted") === "true" &&
        field(record, "_trash_group_id").toLowerCase() === sessionId
      ) {
        changes.push(restoreGroupedRecord(record, timestamp));
      }
    }
  }

  for (const record of await getSessionAudioChunks(snapshot, session, true)) {
    if (
      field(record, "_deleted") === "true" &&
      field(record, "_trash_group_id").toLowerCase() === sessionId
    ) {
      changes.push(restoreGroupedRecord(record, timestamp));
    }
  }

  const settings = await snapshot.listRecords(RecordType.settings, true);
  for (const entry of settings) {
    if (field(entry, "_trash_session_group_id").toLowerCase() !== sessionId) continue;
    const fields = new Map(entry.fields);
    restoreReferences(fields, "session_ids", "_trash_restore_session_refs");
    restoreReferences(fields, "study_guide_ids", "_trash_restore_guide_refs");
    restoreReferences(fields, "attachment_ids", "_trash_restore_asset_refs");
    fields.delete("_trash_session_group_id");
    fields.delete("_trash_restore_session_refs");
    fields.delete("_trash_restore_guide_refs");
    fields.delete("_trash_restore_asset_refs");
    fields.set("updated_at_us", timestamp);
    changes.push({ ...entry, fields });
  }

  changes.push(restoreGroupedRecord(session, timestamp));
  return deduplicateRecords(changes);
}

async function getSessionAudioChunks(
  snapshot: ArchiveSnapshot,
  session: ArchiveRecord,
  includeDeleted: boolean,
  metadataOnly = false,
): Promise<ArchiveRecord[]> {
  const sessionId = session.id.toLowerCase();
  const trackIds = new Set(snapshot.audioTrackIdsBySession().get(sessionId) ?? []);
  for (const key of ["recording_track_ids", "recording_track_id", "audio_import_track_id"]) {
    for (const id of (session.fields.get(key) ?? "").split(",")) {
      const normalized = id.trim().toLowerCase();
      if (normalized) trackIds.add(normalized);
    }
  }

  const chunks = new Map<string, ArchiveRecord>();
  for (const trackId of trackIds) {
    const metadata = await snapshot.listAudioChunkMetadata(sessionId, trackId, includeDeleted);
    for (const item of metadata) {
      if (metadataOnly) {
        chunks.set(item.id.toLowerCase(), item);
        continue;
      }
      const record = await snapshot.getRecord(RecordType.audioChunk, item.id);
      if (!record) throw new Error(`Recording chunk ${item.id} disappeared from the archive.`);
      if (includeDeleted || field(record, "_deleted") !== "true")
        chunks.set(record.id.toLowerCase(), record);
    }
  }
  return [...chunks.values()];
}

function assertNoExternalGuideReferences(
  guides: readonly ArchiveRecord[],
  sessionId: string,
  removedIds: ReadonlySet<string>,
): void {
  for (const record of guides) {
    if (field(record, "session_id").toLowerCase() === sessionId) continue;
    const draft = guideDraftFromRecord(record);
    for (const section of draft.sections) {
      for (const block of section.blocks) {
        const sources = new Set(
          block.sourceIds
            .split(/[\s,;]+/u)
            .filter(Boolean)
            .map((id) => id.toLowerCase()),
        );
        for (const match of block.text.matchAll(/\[\[source:([^\]]+)\]\]/gu)) {
          const sourceId = match[1]!.trim().toLowerCase();
          if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(sourceId)) {
            throw new Error(
              "A study guide contains an invalid inline source; repair it before deleting this session.",
            );
          }
          sources.add(sourceId);
        }
        const unmatchedInlineSource = block.text.replace(/\[\[source:[^\]]+\]\]/gu, "");
        if (unmatchedInlineSource.includes("[[source:")) {
          throw new Error(
            "A study guide contains an incomplete inline source; repair it before deleting this session.",
          );
        }
        if (block.kind === "image" || block.kind === "figure" || block.text.startsWith("![")) {
          const image =
            /^!\[(?:\\.|[^\]])*\]\(asset:([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\)$/iu.exec(
              block.text,
            );
          if (!image?.[1]) {
            throw new Error(
              "A study guide contains an invalid image source; repair it before deleting this session.",
            );
          }
          sources.add(image[1].toLowerCase());
        }
        if ([...sources].some((sourceId) => removedIds.has(sourceId))) {
          throw new Error(
            "Another study guide references this session. Remove or replace its source links before deleting the session.",
          );
        }
      }
    }
  }
}

function assertNoExternalAnnotationReferences(
  annotations: readonly ArchiveRecord[],
  sessionId: string,
  removedIds: ReadonlySet<string>,
): void {
  for (const annotation of annotations) {
    if (field(annotation, "session_id").toLowerCase() === sessionId) continue;
    if (
      ["linked_asset_ids", "linked_evidence_ids", "source_segment_ids"].some((key) =>
        splitIds(field(annotation, key)).some((id) => removedIds.has(id)),
      )
    ) {
      throw new Error(
        "Another session annotation references this session. Remove or replace its links before deleting the session.",
      );
    }
  }
}

function assertNoExternalEvidenceReferences(
  nodes: readonly ArchiveRecord[],
  sessionId: string,
  removedIds: ReadonlySet<string>,
): void {
  for (const node of nodes) {
    if (field(node, "session_id").toLowerCase() === sessionId) continue;
    const sourceAnnotation = field(node, "source_annotation_id").toLowerCase();
    if (
      (sourceAnnotation && removedIds.has(sourceAnnotation)) ||
      ["source_segment_ids", "source_asset_ids"].some((key) =>
        splitIds(field(node, key)).some((id) => removedIds.has(id)),
      )
    ) {
      throw new Error(
        "Another session evidence node references this session. Remove or replace its source links before deleting the session.",
      );
    }
  }
}

function markRecordTrashed(
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

function restoreGroupedRecord(record: ArchiveRecord, timestamp: string): ArchiveRecord {
  const fields = new Map(record.fields);
  fields.delete("_deleted");
  fields.delete("deleted_at_us");
  fields.delete("_trash_group_id");
  fields.set("restored_at_us", timestamp);
  fields.set("updated_at_us", timestamp);
  return { ...record, fields };
}

function removeReferences(
  fields: Map<string, string>,
  key: string,
  removed: ReadonlySet<string>,
  restore: string[],
): boolean {
  const references = splitReferenceValues(fields.get(key) ?? "");
  const removedIds = new Set([...removed].map((id) => id.toLowerCase()));
  const retained = references.filter((id) => {
    if (!removedIds.has(id.toLowerCase())) return true;
    restore.push(id);
    return false;
  });
  if (retained.length === references.length) return false;
  fields.set(key, retained.join(","));
  return true;
}

function restoreReferences(fields: Map<string, string>, key: string, marker: string): void {
  const current = splitReferenceValues(fields.get(key) ?? "");
  const restored = splitReferenceValues(fields.get(marker) ?? "");
  const seen = new Set(current.map((id) => id.toLowerCase()));
  for (const id of restored) {
    const normalized = id.toLowerCase();
    if (!seen.has(normalized)) {
      current.push(id);
      seen.add(normalized);
    }
  }
  if (restored.length) fields.set(key, current.join(","));
}

function splitIds(value: string): string[] {
  return splitReferenceValues(value).map((id) => id.toLowerCase());
}

function splitReferenceValues(value: string): string[] {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function deduplicateRecords(records: readonly ArchiveRecord[]): ArchiveRecord[] {
  const unique = new Map<string, ArchiveRecord>();
  for (const record of records) unique.set(`${record.type}:${record.id.toLowerCase()}`, record);
  return [...unique.values()];
}

function field(record: ArchiveRecord, key: string): string {
  return record.fields.get(key) ?? "";
}

function currentTimestampUs(): string {
  return (BigInt(Date.now()) * 1000n).toString();
}
