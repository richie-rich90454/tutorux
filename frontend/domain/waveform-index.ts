import type { ArchiveSnapshot } from "../archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import { buildAudioTrackWavStream } from "./audio";

export interface WaveformBucket {
  startFrame: bigint;
  endFrame: bigint;
  minimum: number;
  maximum: number;
  containsGap: boolean;
}

const MAX_BUCKETS = 8192;
const MAGIC = new TextEncoder().encode("TUXWFP2\0");

function sampleWidth(format: string): number {
  switch (format) {
    case "pcm_u8":
      return 1;
    case "pcm_s16le":
      return 2;
    case "pcm_s24le":
      return 3;
    case "pcm_s32le":
    case "pcm_f32le":
      return 4;
    default:
      throw new Error("The recording sample format cannot be indexed.");
  }
}

/** Convert source samples with the same scaling as audio preview playback. */
function sampleToPcm16(view: DataView, offset: number, format: string): number {
  let value: number;
  switch (format) {
    case "pcm_u8":
      value = (view.getUint8(offset) - 128) / 128;
      break;
    case "pcm_s16le":
      value = view.getInt16(offset, true) / 32768;
      break;
    case "pcm_s24le": {
      let sample =
        view.getUint8(offset) |
        (view.getUint8(offset + 1) << 8) |
        (view.getUint8(offset + 2) << 16);
      if (sample & 0x800000) sample |= 0xff000000;
      value = sample / 8_388_608;
      break;
    }
    case "pcm_s32le":
      value = view.getInt32(offset, true) / 2_147_483_648;
      break;
    case "pcm_f32le": {
      const sample = view.getFloat32(offset, true);
      value = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      break;
    }
    default:
      throw new Error("The recording sample format cannot be indexed.");
  }
  if (value <= -1) return -32768;
  if (value >= 1) return 32767;
  return Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
}

function integer(record: ArchiveRecord, name: string, optional = false): bigint {
  const value = record.fields.get(name) ?? (optional ? "0" : "");
  if (!/^\d+$/u.test(value)) throw new Error(`Invalid waveform source metadata: ${name}.`);
  return BigInt(value);
}

/** Generate a version-2 waveform pyramid compatible with the legacy C++ reader. */
export async function buildWaveformIndex(
  snapshot: ArchiveSnapshot,
  sessionId: string,
  trackId: string,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<ArchiveRecord> {
  const check = () => {
    if (options.signal?.aborted) throw new Error("Waveform generation cancelled.");
  };
  check();
  const metadata = await snapshot.listAudioChunkMetadata(sessionId, trackId);
  if (!metadata.length) throw new Error("The selected track has no audio chunks.");
  const stream = await buildAudioTrackWavStream(snapshot, sessionId, trackId);
  const previous = (await snapshot.listRecords(RecordType.waveformIndex)).find(
    (record) =>
      record.fields.get("record_role") === "waveform-pyramid" &&
      record.fields.get("session_id")?.toLowerCase() === sessionId.toLowerCase() &&
      record.fields.get("track_id")?.toLowerCase() === trackId.toLowerCase(),
  );
  return buildWaveformIndexFromStream(
    metadata,
    sessionId,
    trackId,
    stream,
    true,
    previous,
    options,
  );
}

/** Build a waveform pyramid for newly generated PCM chunks before they are saved. */
export async function buildWaveformIndexFromChunks(
  chunks: readonly ArchiveRecord[],
  sessionId: string,
  trackId: string,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<ArchiveRecord> {
  if (!chunks.length) throw new Error("The selected track has no audio chunks.");
  let nextChunk = 0;
  let pendingGapBytes = 0;
  let pendingChunk: ArchiveRecord | undefined;
  const silenceBlock = new Uint8Array(64 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pendingGapBytes > 0) {
        const length = Math.min(pendingGapBytes, silenceBlock.length);
        pendingGapBytes -= length;
        controller.enqueue(
          length === silenceBlock.length ? silenceBlock : silenceBlock.slice(0, length),
        );
        return;
      }
      if (pendingChunk) {
        controller.enqueue(pendingChunk.blob);
        pendingChunk = undefined;
        return;
      }
      if (nextChunk >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[nextChunk++]!;
      if (
        chunk.type !== RecordType.audioChunk ||
        chunk.fields.get("sample_format") !== "pcm_s16le" ||
        chunk.fields.get("channel_count") !== "2"
      ) {
        controller.error(new Error("The mixed audio chunks have an unsupported format."));
        return;
      }
      const gapBytes = integer(chunk, "gap_before_samples", true) * 4n;
      if (gapBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
        controller.error(new Error("The mixed audio gap is too large to index."));
        return;
      }
      pendingChunk = chunk;
      pendingGapBytes = Number(gapBytes);
      if (pendingGapBytes === 0) {
        controller.enqueue(chunk.blob);
        pendingChunk = undefined;
      }
    },
  });
  return buildWaveformIndexFromStream(
    chunks,
    sessionId,
    trackId,
    stream,
    false,
    undefined,
    options,
  );
}

async function buildWaveformIndexFromStream(
  metadata: readonly ArchiveRecord[],
  sessionId: string,
  trackId: string,
  stream: ReadableStream<Uint8Array>,
  skipHeader: boolean,
  previous: ArchiveRecord | undefined,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<ArchiveRecord> {
  const check = () => {
    if (options.signal?.aborted) throw new Error("Waveform generation cancelled.");
  };
  check();
  const first = metadata[0]!;
  const format = first.fields.get("sample_format") ?? "";
  const bytesPerSample = sampleWidth(format);
  const rate = integer(first, "sample_rate_hz");
  const channels = integer(first, "channel_count");
  let storedFrames = 0n;
  let timelineFrames = 0n;
  let signatures = "";
  const gaps: { start: bigint; end: bigint }[] = [];
  for (let index = 0; index < metadata.length; index++) {
    const record = metadata[index]!;
    const sequence = integer(record, "sequence_number");
    const start = integer(record, "first_sample_index");
    const count = integer(record, "sample_count");
    const gap = integer(record, "gap_before_samples", true);
    if (
      sequence !== BigInt(index) ||
      start !== timelineFrames + gap ||
      !count ||
      integer(record, "sample_rate_hz") !== rate ||
      integer(record, "channel_count") !== channels ||
      record.fields.get("sample_format") !== format
    ) {
      throw new Error("The audio track has inconsistent timeline metadata.");
    }
    if (gap) gaps.push({ start: timelineFrames, end: start });
    timelineFrames = start + count;
    storedFrames += count;
    const persistedRevision = record.revision === 0n ? 1n : record.revision;
    signatures += `${record.id.toLowerCase()}:${persistedRevision}:${sequence}:${start}:${count}:${gap}\n`;
  }
  if (timelineFrames > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("The audio timeline is too large to index.");
  const frameCount = Number(timelineFrames);
  const count = Math.min(frameCount, MAX_BUCKETS);
  if (!count) throw new Error("The audio track is empty.");
  const base: WaveformBucket[] = [];
  let gapIndex = 0;
  for (let index = 0; index < count; index++) {
    const startFrame = (timelineFrames * BigInt(index)) / BigInt(count);
    const endFrame = (timelineFrames * BigInt(index + 1)) / BigInt(count);
    while (gapIndex < gaps.length && gaps[gapIndex]!.end <= startFrame) gapIndex++;
    base.push({
      startFrame,
      endFrame,
      minimum: 32767,
      maximum: -32768,
      containsGap: gapIndex < gaps.length && gaps[gapIndex]!.start < endFrame,
    });
  }
  const reader = stream.getReader();
  let frame = 0;
  let bucketIndex = 0;
  let firstChunk = skipHeader;
  try {
    while (true) {
      check();
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunk) {
        firstChunk = false;
        continue;
      }
      const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
      const stride = Number(channels) * bytesPerSample;
      if (value.length % stride) throw new Error("The audio stream contains an incomplete frame.");
      for (let offset = 0; offset < value.length; offset += stride, frame++) {
        while (bucketIndex + 1 < count && frame >= Number(base[bucketIndex]!.endFrame))
          bucketIndex++;
        const bucket = base[bucketIndex]!;
        for (let channel = 0; channel < Number(channels); channel++) {
          const sample = sampleToPcm16(view, offset + channel * bytesPerSample, format);
          bucket.minimum = Math.min(bucket.minimum, sample);
          bucket.maximum = Math.max(bucket.maximum, sample);
        }
      }
      options.onProgress?.(frame / frameCount);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  check();
  if (frame !== frameCount)
    throw new Error("The audio stream ended before the complete waveform was read.");
  const levels: WaveformBucket[][] = [base];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!;
    const next: WaveformBucket[] = [];
    for (let index = 0; index < previous.length; index += 2) {
      const a = previous[index]!;
      const b = previous[index + 1];
      next.push(
        b
          ? {
              startFrame: a.startFrame,
              endFrame: b.endFrame,
              minimum: Math.min(a.minimum, b.minimum),
              maximum: Math.max(a.maximum, b.maximum),
              containsGap: a.containsGap || b.containsGap,
            }
          : { ...a },
      );
    }
    levels.push(next);
  }
  const size = 12 + levels.reduce((sum, level) => sum + 4 + level.length * 21, 0);
  const blob = new Uint8Array(size);
  blob.set(MAGIC);
  const view = new DataView(blob.buffer);
  view.setUint32(8, levels.length, true);
  let offset = 12;
  for (const level of levels) {
    view.setUint32(offset, level.length, true);
    offset += 4;
    for (const bucket of level) {
      view.setBigUint64(offset, bucket.startFrame, true);
      view.setBigUint64(offset + 8, bucket.endFrame, true);
      view.setInt16(offset + 16, bucket.minimum, true);
      view.setInt16(offset + 18, bucket.maximum, true);
      view.setUint8(offset + 20, bucket.containsGap ? 1 : 0);
      offset += 21;
    }
  }
  const fingerprint = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signatures)),
  );
  const sourceFingerprint = Array.from(fingerprint, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  check();
  return {
    type: RecordType.waveformIndex,
    id: previous?.id ?? newUuid(),
    revision: previous?.revision ?? 0n,
    previousOffset: previous?.previousOffset ?? 0n,
    blob,
    fields: new Map([
      ["record_role", "waveform-pyramid"],
      ["format_version", "2"],
      ["source_fingerprint", sourceFingerprint],
      ["session_id", sessionId.toLowerCase()],
      ["track_id", trackId.toLowerCase()],
      ["sample_rate_hz", rate.toString()],
      ["channel_count", channels.toString()],
      ["source_sample_format", format],
      ["stored_frame_count", storedFrames.toString()],
      ["timeline_frame_count", timelineFrames.toString()],
      ["chunk_count", String(metadata.length)],
      ["level_count", String(levels.length)],
      ["base_bucket_count", String(base.length)],
    ]),
  };
}

/** Check whether a saved index still describes the current revisions of its source chunks. */
export async function waveformIndexIsCurrent(
  snapshot: ArchiveSnapshot,
  record: ArchiveRecord,
): Promise<boolean> {
  if (
    record.type !== RecordType.waveformIndex ||
    record.fields.get("_deleted") === "true" ||
    record.fields.get("record_role") !== "waveform-pyramid" ||
    record.fields.get("format_version") !== "2"
  )
    return false;
  const sessionId = record.fields.get("session_id") ?? "";
  const trackId = record.fields.get("track_id") ?? "";
  const chunks = await snapshot.listAudioChunkMetadata(sessionId, trackId);
  if (!chunks.length || String(chunks.length) !== record.fields.get("chunk_count")) return false;
  const format = record.fields.get("source_sample_format") ?? "pcm_s16le";
  if (!["pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"].includes(format))
    return false;
  let expected = 0n;
  let stored = 0n;
  let signature = "";
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    const sequence = integer(chunk, "sequence_number");
    const start = integer(chunk, "first_sample_index");
    const count = integer(chunk, "sample_count");
    const gap = integer(chunk, "gap_before_samples", true);
    if (
      chunk.fields.get("sample_format") !== format ||
      sequence !== BigInt(index) ||
      !count ||
      start !== expected + gap ||
      chunk.fields.get("sample_rate_hz") !== record.fields.get("sample_rate_hz") ||
      chunk.fields.get("channel_count") !== record.fields.get("channel_count")
    )
      return false;
    signature += `${chunk.id.toLowerCase()}:${chunk.revision}:${sequence}:${start}:${count}:${gap}\n`;
    expected = start + count;
    stored += count;
  }
  if (
    expected.toString() !== record.fields.get("timeline_frame_count") ||
    stored.toString() !== record.fields.get("stored_frame_count")
  )
    return false;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature)),
  );
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hash === record.fields.get("source_fingerprint");
}

/** Read and validate an archived waveform pyramid for display. */
export function readWaveformIndex(record: ArchiveRecord): WaveformBucket[][] {
  if (
    record.type !== RecordType.waveformIndex ||
    record.fields.get("record_role") !== "waveform-pyramid" ||
    record.fields.get("format_version") !== "2"
  )
    throw new Error("Unsupported waveform index.");
  const bytes = record.blob;
  if (bytes.length < 12 || MAGIC.some((value, index) => bytes[index] !== value))
    throw new Error("Invalid waveform index header.");
  const total = integer(record, "timeline_frame_count");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const levelCount = view.getUint32(8, true);
  if (!levelCount || levelCount > 14) throw new Error("Invalid waveform level count.");
  const levels: WaveformBucket[][] = [];
  let offset = 12;
  for (let level = 0; level < levelCount; level++) {
    if (offset + 4 > bytes.length) throw new Error("Truncated waveform index.");
    const count = view.getUint32(offset, true);
    offset += 4;
    if (
      !count ||
      count > MAX_BUCKETS ||
      offset + count * 21 > bytes.length ||
      (level > 0 && count >= levels[level - 1]!.length)
    )
      throw new Error("Invalid waveform bucket count.");
    const buckets: WaveformBucket[] = [];
    for (let index = 0; index < count; index++) {
      const startFrame = view.getBigUint64(offset, true);
      const endFrame = view.getBigUint64(offset + 8, true);
      const minimum = view.getInt16(offset + 16, true);
      const maximum = view.getInt16(offset + 18, true);
      const gap = view.getUint8(offset + 20);
      offset += 21;
      if (
        endFrame <= startFrame ||
        minimum > maximum ||
        gap > 1 ||
        startFrame !== (buckets.at(-1)?.endFrame ?? 0n)
      ) {
        throw new Error("Invalid waveform bucket.");
      }
      buckets.push({ startFrame, endFrame, minimum, maximum, containsGap: gap === 1 });
    }
    if (buckets.at(-1)!.endFrame !== total)
      throw new Error("Waveform does not cover the complete recording.");
    levels.push(buckets);
  }
  if (offset !== bytes.length) throw new Error("Unexpected waveform data.");
  return levels;
}
