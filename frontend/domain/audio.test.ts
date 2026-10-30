import { describe, expect, it } from "vitest";
import {
  appendRecords,
  createArchiveBytes,
  openArchiveBytes,
  openArchiveSource,
} from "../archive/archive";
import { crc32, RecordType, type ArchiveRecord } from "../archive/format";
import type { ArchiveByteSource } from "../archive/source";
import {
  buildAudioPreview,
  buildAudioTrackWavExport,
  buildAudioTrackWavStream,
  listSessionAudioTracks,
} from "./audio";

describe("archive audio playback", () => {
  it("does not expose audio tracks whose metadata is in Trash", () => {
    const sessionId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const session = {
      type: RecordType.session,
      id: sessionId,
      revision: 0n,
      previousOffset: 0n,
      fields: new Map([
        ["recording_track_ids", trackId],
        ["recording_track_id", trackId],
      ]),
      blob: new Uint8Array(),
    };
    const track = {
      type: RecordType.assetMetadata,
      id: trackId,
      revision: 0n,
      previousOffset: 0n,
      fields: new Map([
        ["record_role", "audio-track"],
        ["session_id", sessionId],
        ["track_id", trackId],
        ["_deleted", "true"],
      ]),
      blob: new Uint8Array(),
    };

    expect(listSessionAudioTracks(session, [track], [trackId])).toEqual([]);
  });

  it("plays a bounded range and renders missing timeline frames as silence", async () => {
    const sessionId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const first = audioChunk(sessionId, trackId, 0, 0, [-32768, -20000, 0, 16000]);
    const second = audioChunk(sessionId, trackId, 1, 6, [32767, 1000, -1000, 32767], 2);
    const snapshot = await archiveWithAudio([first, second]);

    const preview = await buildAudioPreview(snapshot, sessionId, trackId, "0", "1000");
    const view = new DataView(preview.wav.buffer, preview.wav.byteOffset, preview.wav.byteLength);

    expect(preview.frameCount).toBe(8);
    expect(preview.sampleRateHz).toBe(8_000);
    expect(view.getUint32(40, true)).toBe(16);
    expect(Array.from({ length: 8 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([
      -32768, -20000, 0, 16000, 0, 0, 32767, 1000,
    ]);
  });

  it("converts legacy 24-bit PCM to a standard 16-bit WAV preview", async () => {
    const sessionId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const blob = new Uint8Array([0, 0, 128, 0, 0, 0, 255, 255, 127]);
    const chunk = audioChunk(sessionId, trackId, 0, 0, [], 0, "pcm_s24le", blob, 3);
    const snapshot = await archiveWithAudio([chunk]);

    const preview = await buildAudioPreview(snapshot, sessionId, trackId, 0n, 375n);
    const view = new DataView(preview.wav.buffer, preview.wav.byteOffset, preview.wav.byteLength);

    expect(preview.frameCount).toBe(3);
    expect([0, 1, 2].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      -32768, 0, 32767,
    ]);
  });

  it("loads playback from a cue through the end of the track without a 30 second stop", async () => {
    const sessionId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const first = audioChunk(
      sessionId,
      trackId,
      0,
      0,
      Array.from({ length: 16 }, () => 1),
    );
    const second = audioChunk(
      sessionId,
      trackId,
      1,
      16,
      Array.from({ length: 16 }, () => 2),
    );
    const snapshot = await archiveWithAudio([first, second]);

    const preview = await buildAudioPreview(snapshot, sessionId, trackId, 0n);

    expect(preview.frameCount).toBe(32);
    expect(preview.durationUs).toBe(4_000n);
  });

  it("exports an entire track as streamed WAV and preserves timeline gaps", async () => {
    const sessionId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const first = audioChunk(sessionId, trackId, 0, 0, [-1, 2]);
    const second = audioChunk(sessionId, trackId, 1, 4, [3], 2);
    const snapshot = await archiveWithAudio([first, second]);

    const wav = await collect(await buildAudioTrackWavStream(snapshot, sessionId, trackId));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(10);
    expect(Array.from({ length: 5 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([
      -1, 2, 0, 0, 3,
    ]);
  });

  it("exports unsigned 8-bit silence with the WAV midpoint value", async () => {
    const sessionId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const chunk = audioChunk(
      sessionId,
      trackId,
      0,
      0,
      [],
      0,
      "pcm_u8",
      new Uint8Array([0, 255]),
      2,
    );
    const next = audioChunk(sessionId, trackId, 1, 3, [], 1, "pcm_u8", new Uint8Array([255]), 1);
    const snapshot = await archiveWithAudio([chunk, next]);

    const wav = await collect(await buildAudioTrackWavStream(snapshot, sessionId, trackId));

    expect(Array.from(wav.subarray(44))).toEqual([0, 255, 128, 255]);
    expect(new DataView(wav.buffer).getUint16(34, true)).toBe(8);
  });

  it("uses RF64 for WAV exports larger than the RIFF size limit", async () => {
    const sessionId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const chunk = audioChunk(sessionId, trackId, 0, 0, [1]);
    const fields = new Map(chunk.fields);
    fields.set("sample_count", "3000000000");
    const snapshot = await archiveWithAudio([{ ...chunk, fields }]);

    const exported = await buildAudioTrackWavExport(snapshot, sessionId, trackId);
    expect(exported.rf64).toBe(true);
    expect(exported.dataBytes).toBe(6_000_000_000n);
  });

  it("rejects audio whose independent PCM checksum is invalid", async () => {
    const sessionId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const validChunk = audioChunk(sessionId, trackId, 0, 0, [1, 2, 3, 4]);
    const fields = new Map(validChunk.fields);
    fields.set("payload_checksum", "0");
    const chunk = { ...validChunk, fields };
    const snapshot = await archiveWithAudio([chunk]);

    await expect(buildAudioPreview(snapshot, sessionId, trackId, 0n)).rejects.toMatchObject({
      code: "audio_chunk_checksum",
    });
  });

  it("reads indexed chunk metadata without loading a large PCM blob", async () => {
    const sessionId = crypto.randomUUID();
    const trackId = crypto.randomUUID();
    const blob = new Uint8Array(512 * 1024);
    const chunk = audioChunk(sessionId, trackId, 0, 0, [], 0, "pcm_s16le", blob, 1);
    const sourceArchive = await archiveWithAudio([chunk]);
    const counting = new CountingSource(sourceArchive.source);
    const snapshot = await openArchiveSource(counting);
    counting.reset();

    const [metadata] = await snapshot.listAudioChunkMetadata(sessionId, trackId);

    expect(snapshot.audioTrackIdsBySession().get(sessionId)).toEqual([trackId]);
    expect(metadata?.blob.byteLength).toBe(0);
    expect(counting.largestRead).toBeLessThanOrEqual(64 * 1024);
    expect(counting.totalRead).toBeLessThan(64 * 1024 + 128);
  });
});

async function archiveWithAudio(chunks: readonly ArchiveRecord[]) {
  const created = await openArchiveBytes(await createArchiveBytes("Audio playback fixture"));
  return appendRecords(created, chunks);
}

function audioChunk(
  sessionId: string,
  trackId: string,
  sequence: number,
  firstFrame: number,
  samples: readonly number[],
  gapBefore = 0,
  sampleFormat = "pcm_s16le",
  suppliedBlob?: Uint8Array,
  explicitFrameCount?: number,
): ArchiveRecord {
  const blob = suppliedBlob ?? pcm16(samples);
  const frameCount = explicitFrameCount ?? samples.length;
  return {
    type: RecordType.audioChunk,
    id: crypto.randomUUID(),
    revision: 0n,
    previousOffset: 0n,
    fields: new Map([
      ["session_id", sessionId],
      ["track_id", trackId],
      ["sequence_number", String(sequence)],
      ["first_sample_index", String(firstFrame)],
      ["sample_count", String(frameCount)],
      ["gap_before_samples", String(gapBefore)],
      ["sample_rate_hz", "8000"],
      ["channel_count", "1"],
      ["sample_format", sampleFormat],
      ["codec", "none"],
      ["payload_checksum", String(crc32(blob))],
    ]),
    blob,
  };
}

function pcm16(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class CountingSource implements ArchiveByteSource {
  totalRead = 0;
  largestRead = 0;

  constructor(private readonly source: ArchiveByteSource) {}

  get size(): bigint {
    return this.source.size;
  }

  async read(offset: bigint, length: number): Promise<Uint8Array> {
    this.totalRead += length;
    this.largestRead = Math.max(this.largestRead, length);
    return this.source.read(offset, length);
  }

  reset(): void {
    this.totalRead = 0;
    this.largestRead = 0;
  }
}
