import { describe, expect, it } from "vitest";
import {
  appendRecords,
  compactArchiveSnapshot,
  createArchiveBytes,
  createEncryptedArchiveBytes,
  discardUncommittedTail,
  inspectArchiveRecovery,
  openArchiveBytes,
  openArchiveSourceForRecovery,
  recoverUnpublishedCommit,
  repairArchiveSnapshot,
  verifyArchiveFull,
} from "./archive";
import { MemoryArchiveSource } from "./source";
import { newUuid, RecordType, type ArchiveRecord } from "./format";

function record(
  type: number,
  id: string,
  fields: Record<string, string>,
  blob = new Uint8Array(),
): ArchiveRecord {
  return {
    type,
    id,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map(Object.entries(fields)),
    blob,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("full archive verification", () => {
  it("reports dangling references without throwing", async () => {
    const studentId = newUuid();
    const sessionId = newUuid();
    const archive = await appendRecords(
      await openArchiveBytes(await createArchiveBytes("Dangling references")),
      [
        record(RecordType.session, sessionId, {
          student_id: studentId,
          title: "Missing student",
        }),
        record(RecordType.evidenceEdge, newUuid(), {
          from_id: newUuid(),
          to_id: newUuid(),
        }),
        record(RecordType.assetMetadata, newUuid(), {
          record_role: "material",
          blob_id: newUuid(),
          byte_size: "0",
          content_hash: "0".repeat(64),
        }),
      ],
    );

    const report = await verifyArchiveFull(archive);
    expect(report.valid).toBe(false);
    expect(report.issues.join("\n")).toContain("missing student");
    expect(report.issues.join("\n")).toContain("missing node");
    expect(report.issues.join("\n")).toContain("missing blob");
    expect(report.recordsChecked).toBeGreaterThan(0);
    expect(report.indexPagesChecked).toBeGreaterThan(0);
  });

  it("verifies asset chunk manifests, byte counts, and SHA-256 content", async () => {
    const archive = await openArchiveBytes(await createArchiveBytes("Asset integrity"));
    const immediate = new Uint8Array([1, 2, 3, 4]);
    const manifestId = newUuid();
    const chunkOneId = newUuid();
    const chunkTwoId = newUuid();
    const metadataId = newUuid();
    const content = new Uint8Array([...immediate, 5, 6, 7]);
    const digest = await sha256Hex(content);
    const valid = await appendRecords(archive, [
      record(
        RecordType.assetBlob,
        chunkOneId,
        {
          record_role: "asset-blob-chunk",
          manifest_id: manifestId,
          chunk_index: "0",
        },
        immediate,
      ),
      record(
        RecordType.assetBlob,
        chunkTwoId,
        {
          record_role: "asset-blob-chunk",
          manifest_id: manifestId,
          chunk_index: "1",
        },
        new Uint8Array([5, 6, 7]),
      ),
      record(RecordType.assetBlob, manifestId, {
        record_role: "asset-blob-manifest",
        chunk_count: "2",
        chunk_ids: `${chunkOneId},${chunkTwoId}`,
      }),
      record(RecordType.assetMetadata, metadataId, {
        record_role: "material",
        blob_id: manifestId,
        byte_size: String(content.length),
        content_hash: digest,
      }),
    ]);

    await expect(verifyArchiveFull(valid)).resolves.toMatchObject({ valid: true, issues: [] });

    const tampered = await appendRecords(valid, [
      record(RecordType.assetMetadata, metadataId, {
        record_role: "material",
        blob_id: manifestId,
        byte_size: String(content.length),
        content_hash: "0".repeat(64),
      }),
    ]);
    const report = await verifyArchiveFull(tampered);
    expect(report.valid).toBe(false);
    expect(report.issues.join("\n")).toContain("does not match its hash");
  });

  it("checks guide source validity and secondary indexes", async () => {
    const studentId = newUuid();
    const sessionId = newUuid();
    const guideId = newUuid();
    const archive = await appendRecords(
      await openArchiveBytes(await createArchiveBytes("Guide verification")),
      [
        record(RecordType.student, studentId, { display_name: "Mina" }),
        record(RecordType.session, sessionId, {
          student_id: studentId,
          title: "Algebra",
        }),
        record(RecordType.guide, guideId, {
          title: "Algebra guide",
          session_id: sessionId,
          section_count: "1",
          "section.0.heading": "Evidence",
          "section.0.block_count": "1",
          "section.0.block.0.kind": "paragraph",
          "section.0.block.0.origin": "tutor-authored",
          "section.0.block.0.text": "Mina compared fractions.",
          "section.0.block.0.source_ids": sessionId,
        }),
      ],
    );

    const report = await verifyArchiveFull(archive);
    expect(report).toMatchObject({ valid: true });
    expect(archive.allIndexEntries().has(`GUIDESOURCE:${sessionId}:${guideId}`)).toBe(true);
    expect(archive.allIndexEntries().has(`STUDENTSESSION:${studentId}:${sessionId}`)).toBe(true);
  });

  it("returns a locked report instead of throwing", async () => {
    const locked = await openArchiveBytes(
      await createEncryptedArchiveBytes("Locked verification", "", "correct horse battery staple"),
    );
    await expect(verifyArchiveFull(locked)).resolves.toMatchObject({
      valid: false,
      issues: [expect.stringContaining("Unlock")],
    });
  });
});

describe("archive writer policy", () => {
  it("rejects credentials and credential-looking settings in plaintext archives", async () => {
    const archive = await openArchiveBytes(await createArchiveBytes("Plaintext policy"));
    await expect(
      appendRecords(archive, [
        record(RecordType.settings, newUuid(), {
          record_role: "credential",
          provider: "openai",
          value: "secret",
        }),
      ]),
    ).rejects.toMatchObject({ code: "credential_encryption_required" });
    await expect(
      appendRecords(archive, [
        record(RecordType.settings, newUuid(), {
          record_role: "provider-settings",
          api_key: "secret",
        }),
      ]),
    ).rejects.toMatchObject({ code: "sensitive_setting_key_rejected" });
    await expect(
      appendRecords(archive, [
        record(RecordType.settings, newUuid(), {
          record_role: "provider-settings",
          key: "refresh_token",
          value: "secret",
        }),
      ]),
    ).rejects.toMatchObject({ code: "sensitive_setting_key_rejected" });
  });

  it("stores credential records only in encrypted archives", async () => {
    const passphrase = "archive credential passphrase";
    const locked = await openArchiveBytes(
      await createEncryptedArchiveBytes("Encrypted policy", "", passphrase),
    );
    const archive = await locked.unlock(passphrase);
    const credentialId = newUuid();
    const updated = await appendRecords(archive, [
      record(RecordType.settings, credentialId, {
        record_role: "credential",
        provider: "openai",
        value: "secret",
      }),
    ]);
    expect(await updated.getRecord(RecordType.settings, credentialId)).not.toBeNull();
    await expect(verifyArchiveFull(updated)).resolves.toMatchObject({ valid: true });
  });

  it("keeps audio chunk identity immutable and versions the audio index", async () => {
    const studentId = newUuid();
    const sessionId = newUuid();
    const trackId = newUuid();
    const chunkId = newUuid();
    const archive = await appendRecords(
      await openArchiveBytes(await createArchiveBytes("Audio identity")),
      [
        record(RecordType.student, studentId, { display_name: "Mina" }),
        record(RecordType.session, sessionId, {
          student_id: studentId,
          title: "Recording",
        }),
        record(RecordType.audioChunk, chunkId, {
          session_id: sessionId,
          track_id: trackId,
          sequence_number: "0",
          codec: "aac",
        }),
      ],
    );

    const session = await archive.getRecord(RecordType.session, sessionId);
    const manifest = await archive.getRecord(RecordType.settings, archive.header.id);
    expect(session?.fields.get("audio_chunk_index_version")).toBe("1");
    expect(manifest?.fields.get("audio_chunk_index_version")).toBe("1");
    expect(
      archive.allIndexEntries().has(`AUDIOSESSION:${sessionId}:${trackId}:00000000000000000000`),
    ).toBe(true);
    await expect(verifyArchiveFull(archive)).resolves.toMatchObject({ valid: true });

    await expect(
      appendRecords(archive, [
        record(RecordType.audioChunk, chunkId, {
          session_id: sessionId,
          track_id: trackId,
          sequence_number: "1",
          codec: "aac",
        }),
      ]),
    ).rejects.toMatchObject({ code: "audio_chunk_identity_immutable" });
  });
});

describe("archive repair and recovery edge cases", () => {
  it("recovers a complete commit that has no publication locator at all", async () => {
    const original = await createArchiveBytes("Missing locator");
    const withoutLocator = original.subarray(0, original.length - 32);
    await expect(openArchiveBytes(withoutLocator)).rejects.toMatchObject({
      code: "archive_commit_missing",
    });

    const source = new MemoryArchiveSource(withoutLocator);
    const recoveredView = await openArchiveSourceForRecovery(source);
    expect(recoveredView.commit.generation).toBe(1n);
    const inspection = await inspectArchiveRecovery(source);
    expect(inspection).toMatchObject({
      archiveHeaderValid: true,
      committedGeneration: 1n,
      recoverable: true,
      recoverableGeneration: 1n,
      trailingBytes: 0n,
    });
    const recovered = await recoverUnpublishedCommit(recoveredView);
    expect(recovered.recoveredGeneration).toBe(1n);
    expect(recovered.recoveredGenerations).toBe(0);
    const reopened = await openArchiveBytes(
      await recovered.snapshot.source.read(0n, Number(recovered.snapshot.source.size)),
    );
    expect((await reopened.getManifest()).displayName).toBe("Missing locator");
  });

  it("recovers a published transaction whose newest locator was lost", async () => {
    const studentId = newUuid();
    const created = await openArchiveBytes(await createArchiveBytes("Missing newest locator"));
    const complete = await appendRecords(created, [
      record(RecordType.student, studentId, { display_name: "Mina" }),
    ]);
    const bytes = await complete.source.read(0n, Number(complete.source.size));
    const withoutLatestLocator = bytes.subarray(0, bytes.length - 32);
    const prior = await openArchiveBytes(withoutLatestLocator);
    expect(prior.commit.generation).toBe(1n);

    const source = new MemoryArchiveSource(withoutLatestLocator);
    const inspection = await inspectArchiveRecovery(source);
    expect(inspection).toMatchObject({
      committedGeneration: 1n,
      candidateGeneration: 2n,
      recoverable: true,
      recoverableGeneration: 2n,
      hasUnpublishedCommit: true,
    });
    const recovered = await recoverUnpublishedCommit(prior);
    expect(recovered.recoveredGeneration).toBe(2n);
    expect(recovered.recoveredGenerations).toBe(1);
    const reopened = await openArchiveBytes(
      await recovered.snapshot.source.read(0n, Number(recovered.snapshot.source.size)),
    );
    expect((await reopened.getRecord(RecordType.student, studentId))?.revision).toBe(1n);
  });

  it("finds the locator after crash bytes and reports the discarded region", async () => {
    const studentId = newUuid();
    const created = await openArchiveBytes(await createArchiveBytes("Locator scan"));
    const complete = await appendRecords(created, [
      record(RecordType.student, studentId, { display_name: "Mina" }),
    ]);
    const bytes = await complete.source.read(0n, Number(complete.source.size));
    const locator = bytes.subarray(bytes.length - 32);
    const commitEnd = bytes.length - 32;
    const damaged = new Uint8Array(bytes.length + 24);
    damaged.set(bytes.subarray(0, commitEnd));
    damaged.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], commitEnd);
    damaged.set(locator, commitEnd + 16);
    damaged.set([21, 22, 23, 24, 25, 26, 27, 28], commitEnd + 16 + 32);

    const snapshot = await openArchiveBytes(damaged);
    expect(snapshot.commit.generation).toBe(2n);
    expect(snapshot.source.size - snapshot.publishedEndOffset).toBe(8n);
    const repaired = await repairArchiveSnapshot(snapshot);
    expect(repaired.selectedGeneration).toBe(2n);
    expect(repaired.discardedRegionStart).toBe(snapshot.publishedEndOffset);
    expect(repaired.discardedRegionEnd).toBe(snapshot.source.size);
    expect(repaired.discardedTrailingBytes).toBe(8n);
    expect(repaired.unattributedBytes).toBe(8n);
    expect(repaired.discardedRecordFrames).toBe(0);
    const reopened = await openArchiveBytes(
      await repaired.snapshot.source.read(0n, Number(repaired.snapshot.source.size)),
    );
    expect(
      (await reopened.getRecord(RecordType.student, studentId))?.fields.get("display_name"),
    ).toBe("Mina");
  });

  it("discards uncommitted trailing bytes without changing the source", async () => {
    const created = await createArchiveBytes("Discard tail");
    const dirty = new Uint8Array(created.length + 16);
    dirty.set(created);
    dirty.set(new Uint8Array(16).fill(9), created.length);
    const archive = await openArchiveBytes(dirty);
    const discarded = await discardUncommittedTail(archive);
    expect(discarded.discardedBytes).toBe(16n);
    expect(discarded.snapshot.source.size).toBe(archive.publishedEndOffset);
    expect(archive.source.size).toBe(BigInt(dirty.length));
    await expect(verifyArchiveFull(discarded.snapshot)).resolves.toMatchObject({ valid: true });
  });

  it("rebuilds audio and guide secondary indexes during compaction", async () => {
    const studentId = newUuid();
    const sessionId = newUuid();
    const trackId = newUuid();
    const chunkId = newUuid();
    const guideId = newUuid();
    const archive = await appendRecords(
      await openArchiveBytes(await createArchiveBytes("Compaction indexes")),
      [
        record(RecordType.student, studentId, { display_name: "Mina" }),
        record(RecordType.session, sessionId, {
          student_id: studentId,
          title: "Recording",
        }),
        record(RecordType.audioChunk, chunkId, {
          session_id: sessionId,
          track_id: trackId,
          sequence_number: "0",
          codec: "aac",
        }),
        record(RecordType.guide, guideId, {
          title: "Guide",
          session_id: sessionId,
          section_count: "1",
          "section.0.heading": "Evidence",
          "section.0.block_count": "1",
          "section.0.block.0.kind": "paragraph",
          "section.0.block.0.origin": "tutor-authored",
          "section.0.block.0.text": "Mina recorded a session.",
          "section.0.block.0.source_ids": sessionId,
        }),
        record(99, newUuid(), { extension: "preserved" }),
      ],
    );

    const compacted = await compactArchiveSnapshot(archive);
    const entries = compacted.snapshot.allIndexEntries();
    expect(entries.get(`AUDIOSESSION:${sessionId}:${trackId}:00000000000000000000`)).toBe(
      entries.get(`AUDIO:${chunkId}`),
    );
    expect(entries.get(`GUIDESOURCE:${sessionId}:${guideId}`)).toBe(
      entries.get(`GUIDE:${guideId}`),
    );
    expect(entries.get(`STUDENTSESSION:${studentId}:${sessionId}`)).toBe(
      entries.get(`SESSION:${sessionId}`),
    );
    await expect(verifyArchiveFull(compacted.snapshot)).resolves.toMatchObject({ valid: true });
  });
});
