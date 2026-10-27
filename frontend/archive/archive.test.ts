import { describe, expect, it } from "vitest";
import {
  appendRecords,
  createArchiveBytes,
  openArchiveBytes,
  openArchiveSource,
  verifyArchiveSnapshot,
} from "./archive";
import { decodeRecordFrame, recordTypeName, RecordType } from "./format";
import { CompositeArchiveSource, MemoryArchiveSource, type ArchiveByteSource } from "./source";

describe("Tutorux archive snapshots", () => {
  it("creates and reopens a committed v1 archive with its manifest", async () => {
    const createdAtUs = 1_782_930_000_123_456n;
    const bytes = await createArchiveBytes(
      "Algebra lessons",
      "Maya's weekly sessions",
      createdAtUs,
    );
    const archive = await openArchiveBytes(bytes);

    expect(archive.header.majorVersion).toBe(1);
    expect(archive.header.minorVersion).toBe(0);
    expect(archive.header.createdAtUs).toBe(createdAtUs);
    expect(archive.commit.generation).toBe(1n);
    expect(archive.commit.recordCount).toBe(1n);
    expect(await archive.getManifest()).toEqual({
      displayName: "Algebra lessons",
      description: "Maya's weekly sessions",
      createdAtUs: createdAtUs.toString(),
    });
    expect(archive.indexEntryCount()).toBe(1);
  });

  it("does not accept a changed commit locator", async () => {
    const bytes = await createArchiveBytes("Integrity check");
    bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 1;
    await expect(openArchiveBytes(bytes)).rejects.toMatchObject({ code: "archive_commit_missing" });
  });

  it("opens large archive sources with bounded locator reads", async () => {
    const compact = await createArchiveBytes("Range reader");
    const padding = new Uint8Array(2 * 1024 * 1024);
    const expanded = new Uint8Array(compact.length + padding.length);
    expanded.set(compact.subarray(0, compact.length - 32));
    expanded.set(padding, compact.length - 32);
    expanded.set(compact.subarray(compact.length - 32), expanded.length - 32);

    const source = new CountingSource(expanded);
    const archive = await openArchiveSource(source);
    expect(await archive.getManifest()).toMatchObject({ displayName: "Range reader" });
    expect(source.largestRead).toBeLessThanOrEqual(64 * 1024 + 31);
    expect(source.totalRead).toBeLessThan(256 * 1024);
  });

  it("appends a new generation without rewriting the original archive", async () => {
    const originalBytes = await createArchiveBytes("Studio");
    const original = await openArchiveBytes(originalBytes);
    const studentId = crypto.randomUUID();
    const changed = await appendRecords(original, [
      {
        type: RecordType.student,
        id: studentId,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
          ["display_name", "Mina Chen"],
          ["grade", "Year 8"],
        ]),
        blob: new Uint8Array(),
      },
    ]);

    expect(changed.commit.generation).toBe(2n);
    expect(changed.source).toBeInstanceOf(CompositeArchiveSource);
    expect(await changed.getRecord(RecordType.student, studentId)).toMatchObject({
      revision: 1n,
      fields: new Map([
        ["display_name", "Mina Chen"],
        ["grade", "Year 8"],
      ]),
    });

    const roundTrip = await openArchiveSource(changed.source);
    expect(roundTrip.indexEntryCount()).toBe(2);
    expect((await roundTrip.getRecord(RecordType.student, studentId))?.revision).toBe(1n);
  });

  it("compresses eligible records while preserving asset and encoded-audio payloads", async () => {
    const archive = await openArchiveBytes(await createArchiveBytes("Record compression"));
    const studentId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const encodedAudioId = crypto.randomUUID();
    const pcmAudioId = crypto.randomUUID();
    const repeated = "Tutorux archive compression. ".repeat(100);
    const changed = await appendRecords(archive, [
      {
        type: RecordType.student,
        id: studentId,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([["notes", repeated]]),
        blob: new Uint8Array(),
      },
      {
        type: RecordType.assetBlob,
        id: assetId,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(),
        blob: new Uint8Array(4096).fill(0x61),
      },
      {
        type: RecordType.audioChunk,
        id: encodedAudioId,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
          ["codec", "opus"],
          ["session_id", sessionId],
          ["track_id", trackId],
          ["sequence_number", "1"],
        ]),
        blob: new Uint8Array(4096).fill(0x61),
      },
      {
        type: RecordType.audioChunk,
        id: pcmAudioId,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
          ["codec", "none"],
          ["session_id", sessionId],
          ["track_id", trackId],
          ["sequence_number", "2"],
        ]),
        blob: new Uint8Array(4096).fill(0x61),
      },
    ]);

    const codecFor = async (type: number, id: string): Promise<number> => {
      const offset = changed.allIndexEntries().get(`${recordTypeName(type).toUpperCase()}:${id}`)!;
      const bytes = await changed.source.read(offset, Number(changed.source.size - offset));
      return decodeRecordFrame(bytes).codec;
    };

    expect(await codecFor(RecordType.student, studentId)).toBe(1);
    expect(await codecFor(RecordType.assetBlob, assetId)).toBe(0);
    expect(await codecFor(RecordType.audioChunk, encodedAudioId)).toBe(0);
    expect(await codecFor(RecordType.audioChunk, pcmAudioId)).toBe(1);
    expect((await changed.getRecord(RecordType.student, studentId))?.fields.get("notes")).toBe(
      repeated,
    );
  });

  it("verifies current records, including trashed and forward-compatible record types", async () => {
    const archive = await openArchiveBytes(await createArchiveBytes("Full record verification"));
    const studentId = crypto.randomUUID();
    const legacyId = crypto.randomUUID();
    const deletedId = crypto.randomUUID();
    const updated = await appendRecords(archive, [
      {
        type: RecordType.student,
        id: studentId,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([["display_name", "Mina Chen"]]),
        blob: new Uint8Array(),
      },
      {
        type: 99,
        id: legacyId,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([["extension", "preserved"]]),
        blob: new Uint8Array(),
      },
      {
        type: RecordType.settings,
        id: deletedId,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
          ["record_role", "extension-record"],
          ["_deleted", "true"],
        ]),
        blob: new Uint8Array(),
      },
    ]);

    await expect(verifyArchiveSnapshot(updated)).resolves.toMatchObject({
      generation: "2",
      currentRecords: 4,
      liveRecords: 3,
      deletedRecords: 1,
    });
  });

  it("marks cited guide blocks stale when a source record changes", async () => {
    const archive = await openArchiveBytes(await createArchiveBytes("Guide source freshness"));
    const sourceId = crypto.randomUUID();
    const guideId = crypto.randomUUID();
    const source = {
      type: RecordType.student,
      id: sourceId,
      revision: 0n,
      previousOffset: 0n,
      fields: new Map([["display_name", "Mina Chen"]]),
      blob: new Uint8Array(),
    };
    const guide = {
      type: RecordType.guide,
      id: guideId,
      revision: 0n,
      previousOffset: 0n,
      fields: new Map([
        ["section_count", "1"],
        ["section.0.heading", "Observed progress"],
        ["section.0.block_count", "1"],
        ["section.0.block.0.kind", "paragraph"],
        ["section.0.block.0.text", "Mina explained the scale factor."],
        ["section.0.block.0.source_ids", sourceId],
        ["section.0.block.0.stale", "false"],
        ["stale_block_count", "0"],
      ]),
      blob: new Uint8Array(),
    };
    const sourceArchive = await appendRecords(archive, [source]);
    const created = await appendRecords(sourceArchive, [guide]);
    const firstGuide = await created.getRecord(RecordType.guide, guideId);
    expect(firstGuide?.revision).toBe(1n);

    const changedSource = await appendRecords(created, [
      { ...source, fields: new Map([["display_name", "Mina Chen · updated"]]) },
    ]);
    const staleGuide = await changedSource.getRecord(RecordType.guide, guideId);
    expect(staleGuide?.revision).toBe(2n);
    expect(staleGuide?.fields.get("section.0.block.0.stale")).toBe("true");
    expect(staleGuide?.fields.get("stale_block_count")).toBe("1");
    expect(staleGuide?.fields.get("stale_source_id")).toBe(sourceId.toLowerCase());
    expect(staleGuide?.fields.get("stale_sources_updated_at_us")).toBeTruthy();

    const reviewedFields = new Map(staleGuide!.fields);
    reviewedFields.set("section.0.block.0.source_ids", "");
    reviewedFields.set("section.0.block.0.stale", "false");
    reviewedFields.set("stale_block_count", "0");
    const reviewedArchive = await appendRecords(changedSource, [
      { ...staleGuide!, fields: reviewedFields },
    ]);
    const reviewedGuide = await reviewedArchive.getRecord(RecordType.guide, guideId);
    const changedAgain = await appendRecords(reviewedArchive, [
      { ...source, fields: new Map([["display_name", "Mina Chen · updated again"]]) },
    ]);
    const stillReviewed = await changedAgain.getRecord(RecordType.guide, guideId);
    expect(stillReviewed?.revision).toBe(reviewedGuide?.revision);
    expect(stillReviewed?.fields.get("stale_block_count")).toBe("0");
  });

  it("marks guide blocks stale when a cited journal notes document changes", async () => {
    const archive = await openArchiveBytes(await createArchiveBytes("Journal note freshness"));
    const noteId = crypto.randomUUID();
    const guideId = crypto.randomUUID();
    const notes = {
      type: RecordType.settings,
      id: noteId,
      revision: 0n,
      previousOffset: 0n,
      fields: new Map([
        ["record_role", "journal-notes"],
        ["entry_id", crypto.randomUUID()],
        ["block_count", "1"],
        ["block.0.id", crypto.randomUUID()],
        ["block.0.kind", "paragraph"],
        ["block.0.text", "Mina used a number line to compare fractions."],
      ]),
      blob: new Uint8Array(),
    };
    const guide = {
      type: RecordType.guide,
      id: guideId,
      revision: 0n,
      previousOffset: 0n,
      fields: new Map([
        ["section_count", "1"],
        ["section.0.heading", "Evidence"],
        ["section.0.block_count", "1"],
        ["section.0.block.0.kind", "paragraph"],
        ["section.0.block.0.text", "Mina compared fractions on a number line."],
        ["section.0.block.0.source_ids", noteId],
        ["section.0.block.0.stale", "false"],
        ["stale_block_count", "0"],
      ]),
      blob: new Uint8Array(),
    };
    const withNotes = await appendRecords(archive, [notes]);
    const withGuide = await appendRecords(withNotes, [guide]);
    const changedFields = new Map(notes.fields);
    changedFields.set("block.0.text", "Mina compared fractions using a number line independently.");
    const changed = await appendRecords(withGuide, [{ ...notes, fields: changedFields }]);

    const staleGuide = await changed.getRecord(RecordType.guide, guideId);
    expect(staleGuide?.revision).toBe(2n);
    expect(staleGuide?.fields.get("section.0.block.0.stale")).toBe("true");
    expect(staleGuide?.fields.get("stale_source_id")).toBe(noteId.toLowerCase());
  });

  it("requires a clean committed tail before editing", async () => {
    const archive = await openArchiveBytes(await createArchiveBytes("Studio"));
    const dirty = await openArchiveSource(
      new CompositeArchiveSource(
        archive.source,
        new MemoryArchiveSource(new Uint8Array([1, 2, 3])),
      ),
    );
    await expect(
      appendRecords(dirty, [
        {
          type: RecordType.student,
          id: crypto.randomUUID(),
          revision: 0n,
          previousOffset: 0n,
          fields: new Map([["display_name", "Mina Chen"]]),
          blob: new Uint8Array(),
        },
      ]),
    ).rejects.toMatchObject({ code: "archive_recovery_required" });
  });
});

class CountingSource implements ArchiveByteSource {
  readonly size: bigint;
  largestRead = 0;
  totalRead = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.size = BigInt(bytes.length);
  }

  async read(offset: bigint, length: number): Promise<Uint8Array> {
    this.largestRead = Math.max(this.largestRead, length);
    this.totalRead += length;
    const start = Number(offset);
    return this.bytes.subarray(start, start + length);
  }
}
