import { describe, expect, it } from "vitest";
import {
  appendRecords,
  createArchiveBytes,
  openArchiveBytes,
  verifyArchiveSnapshot,
} from "./archive";
import { createSanitizedCopy, previewSanitizedCopy } from "./sanitized-copy";
import { newUuid, RecordType, type ArchiveRecord, type RecordTypeValue } from "./format";

function record(
  type: RecordTypeValue,
  id: string,
  fields: Record<string, string> = {},
  blob = new Uint8Array(),
): ArchiveRecord {
  return {
    type,
    id,
    revision: 1n,
    previousOffset: 0n,
    fields: new Map(Object.entries(fields)),
    blob,
  };
}

async function createSource() {
  const ids = {
    studentA: newUuid(),
    studentB: newUuid(),
    sessionA: newUuid(),
    sessionB: newUuid(),
    publicAnnotation: newUuid(),
    privateAnnotation: newUuid(),
    transcript: newUuid(),
    assetA: newUuid(),
    assetB: newUuid(),
    manifestA: newUuid(),
    chunkA: newUuid(),
    evidenceA: newUuid(),
    evidenceB: newUuid(),
    edge: newUuid(),
    guide: newUuid(),
    entryA: newUuid(),
    notesA: newUuid(),
    entryB: newUuid(),
    notesB: newUuid(),
    plainSettings: newUuid(),
    credential: newUuid(),
    job: newUuid(),
    trackA: newUuid(),
    trackB: newUuid(),
    trackAssetA: newUuid(),
    trackAssetB: newUuid(),
    recordingTake: newUuid(),
    audioA: newUuid(),
    audioB: newUuid(),
  };
  let snapshot = await openArchiveBytes(await createArchiveBytes("Sanitize source"));
  snapshot = await appendRecords(snapshot, [
    record(RecordType.student, ids.studentA, { display_name: "Amina" }),
    record(RecordType.student, ids.studentB, { display_name: "Ben" }),
    record(RecordType.session, ids.sessionA, {
      title: "Algebra",
      student_id: ids.studentA,
      session_type: "recorded",
      recording_state: "complete",
      recording_track_ids: `${ids.trackA},${ids.trackB}`,
      recording_track_id: ids.trackA,
      recording_track_count: "2",
      recording_audio_chunks: "2",
      recording_device_id: "private-device-name",
      audio_import_track_id: ids.trackB,
      audio_import_source: "private-import-path",
      entry_id: ids.entryA,
      notes_document_id: ids.notesA,
    }),
    record(RecordType.session, ids.sessionB, {
      title: "Writing",
      student_id: ids.studentB,
      session_type: "notes-only",
      recording_state: "not-started",
    }),
    record(RecordType.annotation, ids.publicAnnotation, {
      session_id: ids.sessionA,
      content: "Public observation",
      linked_asset_ids: ids.assetA,
      linked_evidence_ids: ids.evidenceA,
    }),
    record(RecordType.annotation, ids.privateAnnotation, {
      session_id: ids.sessionA,
      content: "Private observation",
      private: "true",
    }),
    record(RecordType.transcriptSegment, ids.transcript, {
      session_id: ids.sessionA,
      text: "A supported explanation",
      linked_asset_ids: ids.assetA,
    }),
    record(RecordType.assetMetadata, ids.assetA, {
      record_role: "material",
      session_id: ids.sessionA,
      display_name: "worksheet.pdf",
      blob_id: ids.manifestA,
    }),
    record(RecordType.assetMetadata, ids.assetB, {
      record_role: "material",
      session_id: ids.sessionB,
      display_name: "essay.pdf",
    }),
    record(RecordType.assetBlob, ids.manifestA, {
      record_role: "asset-blob-manifest",
      chunk_ids: ids.chunkA,
    }),
    record(
      RecordType.assetBlob,
      ids.chunkA,
      {
        record_role: "asset-blob-chunk",
        manifest_id: ids.manifestA,
      },
      new Uint8Array([11, 22, 33, 44]),
    ),
    record(RecordType.evidenceNode, ids.evidenceA, {
      session_id: ids.sessionA,
      student_id: ids.studentA,
      source_annotation_id: ids.publicAnnotation,
      source_asset_ids: ids.assetA,
    }),
    record(RecordType.evidenceNode, ids.evidenceB, {
      session_id: ids.sessionA,
      student_id: ids.studentA,
      source_segment_ids: ids.transcript,
    }),
    record(RecordType.evidenceEdge, ids.edge, {
      session_id: ids.sessionA,
      from_id: ids.evidenceA,
      to_id: ids.evidenceB,
      relationship: "supports",
    }),
    record(RecordType.guide, ids.guide, {
      session_id: ids.sessionA,
      entry_id: ids.entryA,
      title: "Algebra guide",
      section_count: "1",
      "section.0.id": newUuid(),
      "section.0.heading": "Evidence",
      "section.0.block_count": "1",
      "section.0.block.0.id": newUuid(),
      "section.0.block.0.kind": "paragraph",
      "section.0.block.0.text": "Use the observation.",
      "section.0.block.0.source_ids": ids.evidenceA,
      "section.0.block.0.stale": "false",
      "section.0.block.0.origin": "tutor-authored",
      source_index_history: ids.studentA,
      stale_source_id: ids.studentB,
    }),
    record(RecordType.settings, ids.entryA, {
      record_role: "journal-entry",
      session_ids: ids.sessionA,
      notes_document_id: ids.notesA,
      study_guide_ids: ids.guide,
      attachment_ids: ids.assetA,
    }),
    record(RecordType.settings, ids.notesA, {
      record_role: "journal-notes",
      session_id: ids.sessionA,
      entry_id: ids.entryA,
      content: "Retained notes",
    }),
    record(RecordType.settings, ids.entryB, {
      record_role: "journal-entry",
      session_ids: ids.sessionB,
      notes_document_id: ids.notesB,
      attachment_ids: ids.assetB,
    }),
    record(RecordType.settings, ids.notesB, {
      record_role: "journal-notes",
      session_id: ids.sessionB,
      entry_id: ids.entryB,
      content: "Excluded notes",
    }),
    record(RecordType.settings, ids.plainSettings, {
      record_role: "provider-settings",
      provider: "local",
      api_key: "must-not-copy",
    }),
    record(RecordType.settings, ids.credential, {
      RecordRole: "credential",
      provider: "openai",
      value: "legacy credential payload must not copy",
    }),
    record(RecordType.aiJob, ids.job, {
      session_id: ids.sessionA,
      prompt: "private generation log",
    }),
    record(RecordType.assetMetadata, ids.trackAssetA, {
      record_role: "audio-track",
      session_id: ids.sessionA,
      track_id: ids.trackA,
      mime_type: "audio/wav",
    }),
    record(RecordType.assetMetadata, ids.trackAssetB, {
      record_role: "audio-track",
      session_id: ids.sessionA,
      track_id: ids.trackB,
      mime_type: "audio/wav",
    }),
    record(RecordType.assetMetadata, ids.recordingTake, {
      record_role: "recording-take",
      session_id: ids.sessionA,
      track_ids: `${ids.trackA},${ids.trackB}`,
      mime_type: "audio/wav",
    }),
    record(
      RecordType.audioChunk,
      ids.audioA,
      {
        session_id: ids.sessionA,
        track_id: ids.trackA,
        sequence_number: "0",
        codec: "aac",
      },
      new Uint8Array([1, 2, 3]),
    ),
    record(
      RecordType.audioChunk,
      ids.audioB,
      {
        session_id: ids.sessionA,
        track_id: ids.trackB,
        sequence_number: "0",
        codec: "aac",
      },
      new Uint8Array([4, 5, 6]),
    ),
  ]);
  return { snapshot, ids };
}

describe("sanitized archive copies", () => {
  it("previews and creates a student-scoped copy with private and dangling data removed", async () => {
    const { snapshot, ids } = await createSource();
    const options = { includeStudents: new Set([ids.studentA]) };
    const preview = await previewSanitizedCopy(snapshot, options);
    expect(preview).toMatchObject({
      students: 1,
      sessions: 1,
      annotations: 1,
      assets: 1,
      evidenceItems: 2,
      guides: 1,
      recordingTracks: 0,
      recordings: 0,
      generationLogs: 0,
      credentials: 0,
    });

    const expandedPreview = await previewSanitizedCopy(snapshot, {
      ...options,
      includePrivateAnnotations: true,
      includeGenerationLogs: true,
    });
    expect(expandedPreview.annotations).toBe(2);
    expect(expandedPreview.generationLogs).toBe(1);

    const copy = await createSanitizedCopy(snapshot, options, preview);
    const verification = await verifyArchiveSnapshot(copy.snapshot);
    expect(verification.liveRecords).toBeGreaterThan(0);
    expect(await copy.snapshot.listRecords(RecordType.student)).toHaveLength(1);
    expect(await copy.snapshot.listRecords(RecordType.session)).toHaveLength(1);
    expect(await copy.snapshot.listRecords(RecordType.annotation)).toHaveLength(1);
    expect(await copy.snapshot.listRecords(RecordType.transcriptSegment)).toHaveLength(1);
    expect(await copy.snapshot.listRecords(RecordType.assetMetadata)).toHaveLength(1);
    expect(await copy.snapshot.listRecords(RecordType.assetBlob)).toHaveLength(2);
    expect(await copy.snapshot.listRecords(RecordType.evidenceNode)).toHaveLength(2);
    expect(await copy.snapshot.listRecords(RecordType.evidenceEdge)).toHaveLength(1);
    expect(await copy.snapshot.listRecords(RecordType.guide)).toHaveLength(1);
    const settings = await copy.snapshot.listRecords(RecordType.settings);
    expect(settings.map((item) => item.fields.get("record_role"))).toContain("journal-entry");
    expect(settings.map((item) => item.fields.get("record_role"))).toContain("journal-notes");
    expect(settings.some((item) => item.fields.get("api_key") === "must-not-copy")).toBe(false);
    expect(settings.some((item) => item.fields.get("secret") === "must-not-copy")).toBe(false);
    expect(
      settings.some(
        (item) => item.fields.get("value") === "legacy credential payload must not copy",
      ),
    ).toBe(false);
    expect(await copy.snapshot.listRecords(RecordType.aiJob)).toHaveLength(0);
    const expandedCopy = await createSanitizedCopy(
      snapshot,
      { ...options, includePrivateAnnotations: true, includeGenerationLogs: true },
      expandedPreview,
    );
    expect(await expandedCopy.snapshot.listRecords(RecordType.annotation)).toHaveLength(2);
    expect(await expandedCopy.snapshot.listRecords(RecordType.aiJob)).toHaveLength(1);
    const session = (await copy.snapshot.listRecords(RecordType.session))[0]!;
    expect(session.fields.get("session_type")).toBe("notes-only");
    expect(session.fields.has("recording_device_id")).toBe(false);
    expect(session.fields.has("audio_import_source")).toBe(false);
    expect(
      (await snapshot.getRecord(RecordType.student, ids.studentB))?.fields.get("display_name"),
    ).toBe("Ben");
  });

  it("retains only explicitly selected recordings and rewrites track metadata", async () => {
    const { snapshot, ids } = await createSource();
    const options = {
      includeStudents: new Set([ids.studentA]),
      includeRecordingTracks: new Set([ids.trackA]),
    };
    const preview = await previewSanitizedCopy(snapshot, options);
    expect(preview.recordings).toBe(1);
    expect(preview.recordingTracks).toBe(1);
    expect(preview.assets).toBe(3);

    const copy = await createSanitizedCopy(snapshot, options, preview);
    expect(await copy.snapshot.listRecords(RecordType.audioChunk)).toHaveLength(1);
    const session = (await copy.snapshot.listRecords(RecordType.session))[0]!;
    expect(session.fields.get("recording_track_ids")).toBe(ids.trackA);
    expect(session.fields.get("recording_track_id")).toBe(ids.trackA);
    expect(session.fields.get("recording_track_count")).toBe("1");
    expect(session.fields.get("recording_audio_chunks")).toBe("1");
    expect(session.fields.has("recording_device_id")).toBe(false);
    const trackAssets = (await copy.snapshot.listRecords(RecordType.assetMetadata)).filter(
      (item) => item.fields.get("record_role") === "audio-track",
    );
    expect(trackAssets).toHaveLength(1);
    expect(trackAssets[0]!.fields.get("track_id")).toBe(ids.trackA);
    const take = (await copy.snapshot.listRecords(RecordType.assetMetadata)).find(
      (item) => item.fields.get("record_role") === "recording-take",
    );
    expect(take?.fields.get("track_ids")).toBe(ids.trackA);
  });

  it("rejects a stale selection preview and unsupported credential inclusion", async () => {
    const { snapshot, ids } = await createSource();
    const options = { includeStudents: new Set([ids.studentA]) };
    const preview = await previewSanitizedCopy(snapshot, options);
    await expect(
      createSanitizedCopy(snapshot, { ...options, includePrivateAnnotations: true }, preview),
    ).rejects.toMatchObject({ code: "sanitized_copy_selection_changed" });
    await expect(
      previewSanitizedCopy(snapshot, { includeCredentials: true }),
    ).rejects.toMatchObject({ code: "sanitized_copy_encryption_unavailable" });
    await expect(
      previewSanitizedCopy(snapshot, { includeStudents: new Set([newUuid()]) }),
    ).rejects.toMatchObject({ code: "sanitized_copy_student_missing" });
  });
});
