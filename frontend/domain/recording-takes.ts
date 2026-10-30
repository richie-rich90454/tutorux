import type { ArchiveSnapshot } from "../archive/archive";
import { RecordType, type ArchiveRecord } from "../archive/format";

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** Rename one saved recording take without changing its track history. */
export async function renameRecordingTake(
  snapshot: ArchiveSnapshot,
  takeId: string,
  label: string,
): Promise<ArchiveRecord> {
  const take = await requiredTake(snapshot, takeId);
  if (take.fields.get("_deleted") === "true") {
    throw new Error("Restore this recording take before renaming it.");
  }
  const normalizedLabel = normalizeRecordingLabel(label, "Recording take");
  const fields = new Map(take.fields);
  fields.set("label", normalizedLabel);
  fields.set("updated_at_us", nowUs());
  return { ...take, fields };
}

/** Rename one saved audio track while preserving the rest of its metadata. */
export async function renameRecordingTrack(
  snapshot: ArchiveSnapshot,
  trackId: string,
  label: string,
): Promise<ArchiveRecord> {
  const track = await snapshot.getRecord(RecordType.assetMetadata, trackId.toLowerCase());
  if (!track || track.fields.get("record_role") !== "audio-track") {
    throw new Error("Choose a saved recording track.");
  }
  if (track.fields.get("_deleted") === "true") {
    throw new Error("Restore this recording track before renaming it.");
  }
  const normalizedLabel = normalizeRecordingLabel(label, "Recording track");
  const fields = new Map(track.fields);
  fields.set("label", normalizedLabel);
  fields.set("updated_at_us", nowUs());
  return { ...track, fields };
}

/** Move one track in an active recording take and its timeline data into or out of Trash. */
export async function setRecordingTrackDeleted(
  snapshot: ArchiveSnapshot,
  trackId: string,
  deleted: boolean,
): Promise<ArchiveRecord[]> {
  const track = await snapshot.getRecord(RecordType.assetMetadata, trackId.toLowerCase());
  if (!track || track.fields.get("record_role") !== "audio-track") {
    throw new Error("The recording track is unavailable.");
  }
  const currentlyDeleted = track.fields.get("_deleted") === "true";
  if (currentlyDeleted === deleted) {
    throw new Error(deleted ? "The track is already in Trash." : "The track is not in Trash.");
  }

  const sessionId = track.fields.get("session_id")?.toLowerCase() ?? "";
  const takeId = track.fields.get("recording_take_id")?.toLowerCase() ?? "";
  const trackRecordId = track.id.toLowerCase();
  if (!UUID_PATTERN.test(sessionId) || !UUID_PATTERN.test(takeId)) {
    throw new Error("This track is not linked to a restorable recording take.");
  }
  const take = await snapshot.getRecord(RecordType.assetMetadata, takeId);
  if (
    !take ||
    take.fields.get("_deleted") === "true" ||
    take.fields.get("record_role") !== "recording-take" ||
    take.fields.get("session_id")?.toLowerCase() !== sessionId
  ) {
    throw new Error("Restore the parent take before restoring or removing this track.");
  }

  const takeTrackIds = splitIds(take.fields.get("track_ids"));
  if (deleted && !takeTrackIds.includes(trackRecordId)) {
    throw new Error("The selected track is not linked to its recording take.");
  }
  const session = await snapshot.getRecord(RecordType.session, sessionId);
  if (!session || session.fields.get("_deleted") === "true") {
    throw new Error("The parent session is unavailable.");
  }

  const time = nowUs();
  const takeFields = new Map(take.fields);
  const sessionFields = new Map(session.fields);
  const trackFields = new Map(track.fields);
  const sessionTrackIds = splitIds(sessionFields.get("recording_track_ids"));

  if (deleted) {
    const takePosition = takeTrackIds.indexOf(trackRecordId);
    const sessionPosition = sessionTrackIds.indexOf(trackRecordId);
    trackFields.set("_trash_restore_take_track_index", String(takePosition));
    trackFields.set(
      "_trash_restore_session_track_index",
      String(sessionPosition < 0 ? sessionTrackIds.length : sessionPosition),
    );
    takeFields.set(
      "track_ids",
      takeTrackIds.filter((id) => id !== trackRecordId).join(","),
    );
    sessionTrackIds.splice(
      0,
      sessionTrackIds.length,
      ...sessionTrackIds.filter((id) => id !== trackRecordId),
    );

    if (sessionFields.get("recording_track_id")?.toLowerCase() === trackRecordId) {
      trackFields.set("_trash_restore_was_primary", "true");
      if (sessionTrackIds.length > 0) {
        sessionFields.set("recording_track_id", sessionTrackIds[0]!);
        trackFields.set("_trash_restore_fallback_primary_id", sessionTrackIds[0]!);
      } else {
        sessionFields.delete("recording_track_id");
        trackFields.delete("_trash_restore_fallback_primary_id");
      }
    }
    setDeletedFields(trackFields, true, trackRecordId, time);
  } else {
    if (takeTrackIds.includes(trackRecordId)) {
      throw new Error("This track is already linked to its take.");
    }
    const takePosition = restoredPosition(
      trackFields.get("_trash_restore_take_track_index"),
      takeTrackIds.length,
    );
    takeTrackIds.splice(takePosition, 0, trackRecordId);

    const remainingSessionIds = sessionTrackIds.filter((id) => id !== trackRecordId);
    sessionTrackIds.splice(0, sessionTrackIds.length, ...remainingSessionIds);
    const sessionPosition = restoredPosition(
      trackFields.get("_trash_restore_session_track_index"),
      sessionTrackIds.length,
    );
    sessionTrackIds.splice(sessionPosition, 0, trackRecordId);
    takeFields.set("track_ids", takeTrackIds.join(","));

    const currentPrimary = sessionFields.get("recording_track_id")?.toLowerCase() ?? "";
    const fallbackPrimary =
      trackFields.get("_trash_restore_fallback_primary_id")?.toLowerCase() ?? "";
    const wasPrimary = trackFields.get("_trash_restore_was_primary") === "true";
    if (wasPrimary && (!currentPrimary || (fallbackPrimary && currentPrimary === fallbackPrimary))) {
      sessionFields.set("recording_track_id", trackRecordId);
    }

    for (const key of [
      "_trash_restore_was_primary",
      "_trash_restore_fallback_primary_id",
      "_trash_restore_take_track_index",
      "_trash_restore_session_track_index",
    ]) {
      trackFields.delete(key);
    }
    setDeletedFields(trackFields, false, trackRecordId, time);
  }

  takeFields.set("updated_at_us", time);
  sessionFields.set("recording_track_ids", sessionTrackIds.join(","));
  sessionFields.set("updated_at_us", time);
  trackFields.set("updated_at_us", time);

  const records = new Map<string, ArchiveRecord>();
  records.set(recordKey(take), { ...take, fields: takeFields });
  records.set(recordKey(session), { ...session, fields: sessionFields });
  records.set(recordKey(track), { ...track, fields: trackFields });

  const waveformMetadata = await snapshot.listRecordMetadata(RecordType.waveformIndex, true);
  for (const metadata of waveformMetadata) {
    if (
      metadata.fields.get("session_id")?.toLowerCase() !== sessionId ||
      (metadata.fields.get("track_id") ?? "").toLowerCase() !== trackRecordId ||
      !shouldChangeTrashState(metadata, deleted, trackRecordId)
    ) {
      continue;
    }
    const record = await snapshot.getRecord(RecordType.waveformIndex, metadata.id);
    if (record) records.set(recordKey(record), changedTrashState(record, deleted, trackRecordId, time));
  }

  const chunks = await snapshot.listAudioChunkMetadata(sessionId, trackRecordId, true);
  for (const metadata of chunks) {
    if (!shouldChangeTrashState(metadata, deleted, trackRecordId)) continue;
    const record = await snapshot.getRecord(RecordType.audioChunk, metadata.id);
    if (record) records.set(recordKey(record), changedTrashState(record, deleted, trackRecordId, time));
  }

  return [...records.values()];
}

/** Move a take and its linked tracks and chunks into or out of Trash. */
export async function setRecordingTakeDeleted(
  snapshot: ArchiveSnapshot,
  takeId: string,
  deleted: boolean,
): Promise<ArchiveRecord[]> {
  const take = await requiredTake(snapshot, takeId);
  const currentlyDeleted = take.fields.get("_deleted") === "true";
  if (currentlyDeleted === deleted) {
    throw new Error(
      deleted ? "This recording take is already in Trash." : "This recording take is not in Trash.",
    );
  }

  const sessionId = take.fields.get("session_id")?.toLowerCase() ?? "";
  if (!UUID_PATTERN.test(sessionId)) {
    throw new Error("This recording take has an invalid session link.");
  }
  const session = await snapshot.getRecord(RecordType.session, sessionId);
  if (!session || session.fields.get("_deleted") === "true") {
    throw new Error("The recording session is unavailable.");
  }
  const trackIds = [
    ...new Set(
      (take.fields.get("track_ids") ?? "")
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter((id) => UUID_PATTERN.test(id)),
    ),
  ];
  if (trackIds.length === 0) {
    throw new Error("This recording take has no linked audio tracks.");
  }

  const time = nowUs();
  const takeFields = new Map(take.fields);
  const sessionFields = new Map(session.fields);
  const sessionTrackIds = splitIds(sessionFields.get("recording_track_ids"));
  const affectedSessionIds = trackIds.filter((id) => sessionTrackIds.includes(id));

  if (deleted) {
    if (affectedSessionIds.length > 0) {
      takeFields.set("_trash_restore_session_track_ids", affectedSessionIds.join(","));
      sessionFields.set(
        "recording_track_ids",
        sessionTrackIds.filter((id) => !trackIds.includes(id)).join(","),
      );
    }
    const primaryId = sessionFields.get("recording_track_id")?.toLowerCase() ?? "";
    if (trackIds.includes(primaryId)) {
      takeFields.set("_trash_restore_session_primary_track_id", primaryId);
      sessionFields.delete("recording_track_id");
    }
    const importedId = sessionFields.get("audio_import_track_id")?.toLowerCase() ?? "";
    if (trackIds.includes(importedId)) {
      takeFields.set("_trash_restore_audio_import_track_id", importedId);
      sessionFields.delete("audio_import_track_id");
    }
  } else {
    const restoreIds = splitIds(takeFields.get("_trash_restore_session_track_ids"));
    if (restoreIds.some((id) => !trackIds.includes(id))) {
      throw new Error("The saved recording take restore scope no longer matches its tracks.");
    }
    const restoredSessionIds = [...sessionTrackIds];
    for (const id of restoreIds) {
      if (!restoredSessionIds.includes(id)) restoredSessionIds.push(id);
    }
    if (restoreIds.length > 0) {
      sessionFields.set("recording_track_ids", restoredSessionIds.join(","));
    }
    const primaryId = takeFields.get("_trash_restore_session_primary_track_id")?.toLowerCase();
    if (primaryId && trackIds.includes(primaryId)) {
      sessionFields.set("recording_track_id", primaryId);
      takeFields.delete("_trash_restore_session_primary_track_id");
    }
    const importedId = takeFields.get("_trash_restore_audio_import_track_id")?.toLowerCase();
    if (importedId && trackIds.includes(importedId)) {
      sessionFields.set("audio_import_track_id", importedId);
      takeFields.delete("_trash_restore_audio_import_track_id");
    }
    takeFields.delete("_trash_restore_session_track_ids");
  }

  sessionFields.set(
    "recording_track_count",
    String(splitIds(sessionFields.get("recording_track_ids")).length),
  );
  sessionFields.set("updated_at_us", time);
  setDeletedFields(takeFields, deleted, take.id, time);
  takeFields.set("updated_at_us", time);

  const records = new Map<string, ArchiveRecord>();
  records.set(recordKey(session), { ...session, fields: sessionFields });
  records.set(recordKey(take), { ...take, fields: takeFields });

  const assetMetadata = await snapshot.listRecordMetadata(RecordType.assetMetadata, true);
  const trackMetadata = assetMetadata.filter(
    (record) =>
      record.fields.get("record_role") === "audio-track" &&
      record.fields.get("session_id")?.toLowerCase() === sessionId &&
      trackIds.includes((record.fields.get("track_id") ?? record.id).toLowerCase()),
  );
  for (const metadata of trackMetadata) {
    const isDeleted = metadata.fields.get("_deleted") === "true";
    if (deleted ? isDeleted : !isDeleted || metadata.fields.get("_trash_group_id") !== take.id) {
      continue;
    }
    const record = await snapshot.getRecord(RecordType.assetMetadata, metadata.id);
    if (!record) continue;
    const fields = new Map(record.fields);
    setDeletedFields(fields, deleted, take.id, time);
    fields.set("updated_at_us", time);
    records.set(recordKey(record), { ...record, fields });
  }

  const waveformMetadata = await snapshot.listRecordMetadata(RecordType.waveformIndex, true);
  const waveformChildren = waveformMetadata.filter(
    (record) =>
      record.fields.get("session_id")?.toLowerCase() === sessionId &&
      trackIds.includes((record.fields.get("track_id") ?? "").toLowerCase()),
  );
  for (const metadata of waveformChildren) {
    if (!shouldChangeTrashState(metadata, deleted, take.id)) continue;
    const record = await snapshot.getRecord(RecordType.waveformIndex, metadata.id);
    if (!record) continue;
    records.set(recordKey(record), changedTrashState(record, deleted, take.id, time));
  }

  for (const trackId of trackIds) {
    const chunks = await snapshot.listAudioChunkMetadata(sessionId, trackId, true);
    for (const metadata of chunks) {
      if (!shouldChangeTrashState(metadata, deleted, take.id)) continue;
      const record = await snapshot.getRecord(RecordType.audioChunk, metadata.id);
      if (!record) continue;
      records.set(recordKey(record), changedTrashState(record, deleted, take.id, time));
    }
  }

  return [...records.values()];
}

export function splitRecordingTrackIds(value: string | undefined): string[] {
  return splitIds(value);
}

function requiredTake(snapshot: ArchiveSnapshot, takeId: string): Promise<ArchiveRecord> {
  return snapshot.getRecord(RecordType.assetMetadata, takeId.toLowerCase()).then((record) => {
    if (!record || record.fields.get("record_role") !== "recording-take") {
      throw new Error("Recording take was not found.");
    }
    return record;
  });
}

function normalizeRecordingLabel(value: string, subject: string): string {
  const label = value.trim();
  if (!label || new TextEncoder().encode(label).byteLength > 120 || /[\r\n\0]/u.test(label)) {
    throw new Error(`${subject} names must contain 1–120 characters on one line.`);
  }
  return label;
}

function splitIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => UUID_PATTERN.test(id));
}

function restoredPosition(value: string | undefined, listLength: number): number {
  if (value === undefined || !/^\d+$/u.test(value)) return listLength;
  const position = Number(value);
  return Number.isSafeInteger(position) ? Math.min(position, listLength) : listLength;
}

function setDeletedFields(
  fields: Map<string, string>,
  deleted: boolean,
  groupId: string,
  time: string,
): void {
  if (deleted) {
    fields.set("_deleted", "true");
    fields.set("_trash_group_id", groupId);
    fields.set("deleted_at_us", time);
  } else {
    fields.delete("_deleted");
    fields.delete("_trash_group_id");
    fields.delete("deleted_at_us");
    fields.set("restored_at_us", time);
  }
}

function shouldChangeTrashState(record: ArchiveRecord, deleted: boolean, groupId: string): boolean {
  const isDeleted = record.fields.get("_deleted") === "true";
  return deleted ? !isDeleted : isDeleted && record.fields.get("_trash_group_id") === groupId;
}

function changedTrashState(
  record: ArchiveRecord,
  deleted: boolean,
  groupId: string,
  time: string,
): ArchiveRecord {
  const fields = new Map(record.fields);
  setDeletedFields(fields, deleted, groupId, time);
  fields.set("updated_at_us", time);
  return { ...record, fields };
}

function recordKey(record: ArchiveRecord): string {
  return `${record.type}:${record.id.toLowerCase()}`;
}

function nowUs(): string {
  return (BigInt(Date.now()) * 1000n).toString();
}
