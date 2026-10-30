import { crc32, newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";
import { buildAudioTrackWavStream } from "./audio";
import { buildWaveformIndexFromChunks } from "./waveform-index";

const BLOCK_FRAMES = 2048;
const MAX_MIX_BYTES = 256 * 1024 * 1024;

interface Source {
  rate: number;
  channels: number;
  format: string;
  bytesPerSample: number;
  totalFrames: number;
  gaps: { start: number; end: number }[];
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: Uint8Array;
  position: number;
  frame: number;
  current: number[];
}

export interface AudioMixResult {
  records: ArchiveRecord[];
  trackId: string;
  sampleRateHz: number;
  frameCount: number;
  durationUs: string;
  chunkCount: number;
}

/** Mix two to eight tracks from one take into a stereo, archive-backed track. */
export async function mixRecordingTracks(
  snapshot: ArchiveSnapshot,
  sessionId: string,
  takeId: string,
  trackIds: readonly string[],
  label = "Mixdown",
): Promise<AudioMixResult> {
  sessionId = sessionId.toLowerCase();
  takeId = takeId.toLowerCase();
  const ids = trackIds.map((id) => id.toLowerCase());
  if (ids.length < 2 || ids.length > 8 || new Set(ids).size !== ids.length)
    throw new Error("Select between two and eight distinct tracks.");
  label = label.trim() || "Mixdown";
  if (new TextEncoder().encode(label).length > 120 || /[\r\n\0]/u.test(label))
    throw new Error("Mix name must fit on one line and contain at most 120 bytes.");
  const session = await snapshot.getRecord(RecordType.session, sessionId);
  const take = await snapshot.getRecord(RecordType.assetMetadata, takeId);
  if (!session || session.fields.get("_deleted") === "true")
    throw new Error("The session is unavailable.");
  if (
    !take ||
    take.fields.get("_deleted") === "true" ||
    take.fields.get("record_role") !== "recording-take" ||
    take.fields.get("session_id")?.toLowerCase() !== sessionId
  )
    throw new Error("Choose a saved take in this session.");
  const linked = (take.fields.get("track_ids") ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  const sources: Source[] = [];
  try {
    for (const id of ids) {
      const track = await snapshot.getRecord(RecordType.assetMetadata, id);
      if (
        !linked.includes(id) ||
        !track ||
        track.fields.get("_deleted") === "true" ||
        track.fields.get("record_role") !== "audio-track" ||
        track.fields.get("session_id")?.toLowerCase() !== sessionId ||
        track.fields.get("recording_take_id")?.toLowerCase() !== takeId
      )
        throw new Error("Every selected track must belong to the chosen take.");
      const chunks = await snapshot.listAudioChunkMetadata(sessionId, id);
      if (!chunks.length) throw new Error("A selected track has no saved audio.");
      const first = chunks[0]!;
      const last = chunks.at(-1)!;
      const rate = Number(first.fields.get("sample_rate_hz"));
      const channels = Number(first.fields.get("channel_count"));
      const format = first.fields.get("sample_format") ?? "";
      const bytesPerSample =
        format === "pcm_u8" ? 1 : format === "pcm_s16le" ? 2 : format === "pcm_s24le" ? 3 : 4;
      const totalFrames = Number(
        BigInt(last.fields.get("first_sample_index") ?? "0") +
          BigInt(last.fields.get("sample_count") ?? "0"),
      );
      if (!Number.isSafeInteger(totalFrames) || totalFrames < 1)
        throw new Error("A selected track has an invalid timeline.");
      const gaps = chunks.flatMap((chunk) => {
        const end = Number(chunk.fields.get("first_sample_index") ?? "0");
        const gap = Number(chunk.fields.get("gap_before_samples") ?? "0");
        return gap > 0 ? [{ start: end - gap, end }] : [];
      });
      const reader = (await buildAudioTrackWavStream(snapshot, sessionId, id)).getReader();
      await reader.read(); // WAV header; subsequent blocks are aligned PCM samples.
      sources.push({
        rate,
        channels,
        format,
        bytesPerSample,
        totalFrames,
        gaps,
        reader,
        buffer: new Uint8Array(),
        position: 0,
        frame: -1,
        current: [],
      });
    }
    const targetRate = Math.max(...sources.map((source) => source.rate));
    const durationUs = Math.max(
      ...sources.map((source) => Math.floor((source.totalFrames * 1_000_000) / source.rate)),
    );
    const frames = Math.floor((durationUs * targetRate) / 1_000_000);
    if (!Number.isSafeInteger(frames) || frames < 1 || frames * 4 > MAX_MIX_BYTES)
      throw new Error("Mix output must be no larger than 256 MiB.");
    const trackId = newUuid();
    const now = (BigInt(Date.now()) * 1000n).toString();
    const records: ArchiveRecord[] = [];
    let active: number[] = [];
    let activeStart = 0;
    let activeGap = 0;
    let pendingGap = 0;
    let sequence = 0;
    const flush = () => {
      if (!active.length) return;
      const bytes = new Uint8Array(active.length * 2);
      const view = new DataView(bytes.buffer);
      active.forEach((sample, index) => view.setInt16(index * 2, sample, true));
      const count = active.length / 2;
      records.push({
        type: RecordType.audioChunk,
        id: newUuid(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
          ["session_id", sessionId],
          ["track_id", trackId],
          ["sequence_number", String(sequence++)],
          ["first_sample_index", String(activeStart)],
          ["sample_count", String(count)],
          ["gap_before_samples", String(activeGap)],
          ["timeline_start_us", String(Math.floor((activeStart * 1_000_000) / targetRate))],
          ["timeline_end_us", String(Math.floor(((activeStart + count) * 1_000_000) / targetRate))],
          ["sample_format", "pcm_s16le"],
          ["sample_rate_hz", String(targetRate)],
          ["channel_count", "2"],
          ["channel_mask", "3"],
          ["codec", "none"],
          ["source", "mixdown"],
          ["payload_checksum", String(crc32(bytes))],
        ]),
        blob: bytes,
      });
      active = [];
      activeGap = 0;
    };
    for (let frame = 0; frame < frames; frame++) {
      let left = 0;
      let right = 0;
      let contributors = 0;
      for (const source of sources) {
        const sourceFrame = Math.floor((frame * source.rate) / targetRate);
        if (sourceFrame >= source.totalFrames) continue;
        while (source.frame < sourceFrame) await advance(source);
        if (source.gaps.some((gap) => sourceFrame >= gap.start && sourceFrame < gap.end)) continue;
        let l = source.current[0]!;
        let r = source.channels === 1 ? l : source.current[1]!;
        if (source.channels > 2) {
          const extra = Math.trunc(
            source.current.slice(2).reduce((sum, sample) => sum + sample, 0) /
              (source.channels - 2),
          );
          l = Math.trunc((l + extra) / 2);
          r = Math.trunc((r + extra) / 2);
        }
        left += l;
        right += r;
        contributors++;
      }
      if (!contributors) {
        flush();
        pendingGap++;
        continue;
      }
      if (!active.length) {
        activeStart = frame;
        activeGap = pendingGap;
        pendingGap = 0;
      }
      active.push(Math.trunc(left / contributors), Math.trunc(right / contributors));
      if (active.length >= BLOCK_FRAMES * 2) flush();
    }
    flush();
    if (!sequence) throw new Error("The chosen tracks have no overlapping saved audio.");
    const track: ArchiveRecord = {
      type: RecordType.assetMetadata,
      id: trackId,
      revision: 0n,
      previousOffset: 0n,
      fields: new Map([
        ["record_role", "audio-track"],
        ["session_id", sessionId],
        ["track_id", trackId],
        ["recording_take_id", takeId],
        ["source", "mixdown"],
        ["source_track_ids", ids.join(",")],
        ["label", label],
        ["state", "completed"],
        ["sample_rate_hz", String(targetRate)],
        ["sample_format", "pcm_s16le"],
        ["channel_count", "2"],
        ["channel_mask", "3"],
        ["sample_count", String(frames)],
        ["timeline_sample_count", String(frames)],
        ["chunk_count", String(sequence)],
        ["duration_us", String(durationUs)],
        ["updated_at_us", now],
      ]),
      blob: new Uint8Array(),
    };
    const waveform = await buildWaveformIndexFromChunks(
      records.filter((record) => record.type === RecordType.audioChunk),
      sessionId,
      trackId,
    );
    const sessionTracks = [
      ...new Set(
        ["recording_track_ids", "recording_track_id", "audio_import_track_id"].flatMap((key) =>
          (session.fields.get(key) ?? "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ),
    ];
    const sessionFields = new Map(session.fields)
      .set("recording_track_ids", [...sessionTracks, trackId].join(","))
      .set("recording_track_count", String(sessionTracks.length + 1))
      .set("updated_at_us", now);
    const takeFields = new Map(take.fields)
      .set("track_ids", [...linked, trackId].join(","))
      .set("updated_at_us", now);
    records.push(
      waveform,
      track,
      { ...take, fields: takeFields },
      { ...session, fields: sessionFields },
    );
    return {
      records,
      trackId,
      sampleRateHz: targetRate,
      frameCount: frames,
      durationUs: String(durationUs),
      chunkCount: sequence,
    };
  } finally {
    for (const source of sources) {
      await source.reader.cancel().catch(() => {});
      source.reader.releaseLock();
    }
  }
}

async function advance(source: Source): Promise<void> {
  const stride = source.channels * source.bytesPerSample;
  if (source.position >= source.buffer.length) {
    const next = await source.reader.read();
    if (next.done) throw new Error("The source audio ended unexpectedly.");
    source.buffer = next.value;
    source.position = 0;
  }
  if (source.position + stride > source.buffer.length)
    throw new Error("The source audio frame is incomplete.");
  const view = new DataView(
    source.buffer.buffer,
    source.buffer.byteOffset,
    source.buffer.byteLength,
  );
  const samples: number[] = [];
  for (let channel = 0; channel < source.channels; channel++) {
    const at = source.position + channel * source.bytesPerSample;
    let value: number;
    switch (source.format) {
      case "pcm_u8":
        value = (source.buffer[at]! - 128) * 256;
        break;
      case "pcm_s16le":
        value = view.getInt16(at, true);
        break;
      case "pcm_s24le": {
        let sample =
          source.buffer[at]! | (source.buffer[at + 1]! << 8) | (source.buffer[at + 2]! << 16);
        if (sample & 0x800000) sample |= 0xff000000;
        value = Math.round(sample / 256);
        break;
      }
      case "pcm_s32le":
        value = Math.round(view.getInt32(at, true) / 65536);
        break;
      case "pcm_f32le": {
        const sample = view.getFloat32(at, true);
        value = Number.isFinite(sample) ? Math.round(sample * 32768) : 0;
        break;
      }
      default:
        throw new Error("Unsupported source audio format.");
    }
    samples.push(Math.max(-32768, Math.min(32767, value)));
  }
  source.current = samples;
  source.position += stride;
  source.frame++;
}
