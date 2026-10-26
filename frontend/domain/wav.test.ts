import { describe, expect, it } from "vitest";
import { appendRecords, createArchiveBytes, openArchiveBytes } from "../archive/archive";
import { RecordType, type ArchiveRecord } from "../archive/format";
import { buildAudioPreview } from "./audio";
import { makeWaveImportRecords } from "./wav";

describe("legacy-compatible WAV import", () => {
  it("imports multiple data chunks and plays them in their original order", async () => {
    const session = makeSession();
    const file = makeWaveFile(
      [pcm16([1_000, -1_000]), pcm16([2_000, -2_000])],
      { sampleFormat: "pcm_s16le" },
      "split-data.wav",
    );
    const initial = await openArchiveBytes(await createArchiveBytes("WAV import test"));
    const withSession = await appendRecords(initial, [session]);
    const imported = await makeWaveImportRecords(session, file);
    const snapshot = await appendRecords(withSession, imported.records);

    const chunks = imported.records.filter((record) => record.type === RecordType.audioChunk);
    const preview = await buildAudioPreview(snapshot, session.id, imported.trackId, 0n, 500n);
    const view = new DataView(preview.wav.buffer, preview.wav.byteOffset, preview.wav.byteLength);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.fields.get("sequence_number"))).toEqual(["0", "1"]);
    expect(chunks.map((chunk) => chunk.fields.get("first_sample_index"))).toEqual(["0", "2"]);
    expect(imported.sampleCount).toBe(4n);
    expect(imported.chunkCount).toBe(2);
    expect(imported.durationUs).toBe(500n);
    expect([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      1_000, -1_000, 2_000, -2_000,
    ]);
    expect(snapshot.audioTrackIdsBySession().get(session.id)).toEqual([imported.trackId]);
  });

  it("imports extensible IEEE float audio using the legacy PCM format label", async () => {
    const session = makeSession();
    const file = makeWaveFile(
      [float32([-1, 0.5, 1])],
      { sampleFormat: "pcm_f32le", extensible: true },
      "float-lesson.wav",
    );
    const imported = await makeWaveImportRecords(session, file);
    const initial = await openArchiveBytes(await createArchiveBytes("Float WAV"));
    const withSession = await appendRecords(initial, [session]);
    const snapshot = await appendRecords(withSession, imported.records);
    const preview = await buildAudioPreview(snapshot, session.id, imported.trackId, 0n, 375n);
    const view = new DataView(preview.wav.buffer, preview.wav.byteOffset, preview.wav.byteLength);

    expect(imported.sampleFormat).toBe("pcm_f32le");
    expect(
      imported.records
        .find((record) => record.type === RecordType.audioChunk)
        ?.fields.get("source_codec"),
    ).toBe("wav-ieee-float");
    expect([0, 1, 2].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      -32_768, 16_384, 32_767,
    ]);
  });

  it("requires explicit confirmation before adding audio beside an existing track", async () => {
    const existingTrackId = crypto.randomUUID();
    const session = makeSession(
      new Map([
        ["recording_track_id", existingTrackId],
        ["recording_track_ids", existingTrackId],
      ]),
    );
    const file = makeWaveFile([pcm16([200, 400])], { sampleFormat: "pcm_s16le" }, "add.wav");

    await expect(makeWaveImportRecords(session, file)).rejects.toThrow(/separate audio track/u);
    const imported = await makeWaveImportRecords(session, file, true, [existingTrackId]);
    const updatedSession = imported.records.find((record) => record.type === RecordType.session)!;

    expect(updatedSession.fields.get("recording_track_id")).toBe(existingTrackId);
    expect(updatedSession.fields.get("recording_track_ids")).toBe(
      `${existingTrackId},${imported.trackId}`,
    );
    expect(updatedSession.fields.get("recording_track_count")).toBe("2");
  });

  it("rejects compressed WAV encoding and malformed RIFF boundaries", async () => {
    const session = makeSession();
    const compressed = makeWaveFile(
      [pcm16([100, 200])],
      { sampleFormat: "pcm_s16le", formatTag: 2 },
      "compressed.wav",
    );
    const malformedBytes = new Uint8Array(20);
    malformedBytes.set(asciiBytes("RIFF"), 0);
    const malformedView = new DataView(malformedBytes.buffer);
    malformedView.setUint32(4, 12, true);
    malformedBytes.set(asciiBytes("WAVEfmt "), 8);
    malformedView.setUint32(16, 32, true);
    const malformed = new File([malformedBytes.buffer], "broken.wav");

    await expect(makeWaveImportRecords(session, compressed)).rejects.toThrow(
      /Supported WAV audio/u,
    );
    await expect(makeWaveImportRecords(session, malformed)).rejects.toThrow(/extends beyond/u);
  });
});

function makeSession(fields: ReadonlyMap<string, string> = new Map()): ArchiveRecord {
  return {
    type: RecordType.session,
    id: crypto.randomUUID(),
    revision: 0n,
    previousOffset: 0n,
    fields: new Map([
      ["student_id", "anonymous"],
      ["title", "WAV import session"],
      ["session_state", "completed"],
      ["recording_state", "not-started"],
      ...fields,
    ]),
    blob: new Uint8Array(),
  };
}

function makeWaveFile(
  dataChunks: readonly Uint8Array[],
  options: { sampleFormat: string; extensible?: boolean; formatTag?: number },
  name: string,
): File {
  const channelCount = 1;
  const sampleRate = 8_000;
  const bitsPerSample = options.sampleFormat === "pcm_f32le" ? 32 : 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channelCount * bytesPerSample;
  const fmt = new Uint8Array(options.extensible ? 40 : 16);
  const view = new DataView(fmt.buffer);
  view.setUint16(0, options.extensible ? 0xfffe : (options.formatTag ?? 1), true);
  view.setUint16(2, channelCount, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * blockAlign, true);
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bitsPerSample, true);
  if (options.extensible) {
    view.setUint16(16, 22, true);
    view.setUint16(18, bitsPerSample, true);
    view.setUint32(20, 4, true);
    view.setUint32(24, options.sampleFormat === "pcm_f32le" ? 3 : 1, true);
    fmt.set([0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 28);
  }
  const chunks = [riffChunk("fmt ", fmt), ...dataChunks.map((data) => riffChunk("data", data))];
  const body = joinBytes([asciiBytes("WAVE"), ...chunks]);
  const header = new Uint8Array(8);
  header.set(asciiBytes("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, body.byteLength, true);
  return new File([header.buffer as ArrayBuffer, body.buffer as ArrayBuffer], name, {
    type: "audio/wav",
  });
}

function riffChunk(name: string, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  header.set(asciiBytes(name), 0);
  new DataView(header.buffer).setUint32(4, payload.byteLength, true);
  return joinBytes(
    payload.byteLength % 2 ? [header, payload, new Uint8Array(1)] : [header, payload],
  );
}

function pcm16(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function float32(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setFloat32(index * 4, sample, true));
  return bytes;
}

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function joinBytes(values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}
