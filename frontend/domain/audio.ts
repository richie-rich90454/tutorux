import { ArchiveFormatError, crc32, RecordType, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";

const MAX_PREVIEW_DURATION_US = 30_000_000n;
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024;
const WAV_U32_MAX = 4_294_967_295n;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

export interface AudioTrackDescriptor {
  sessionId: string;
  id: string;
  label: string;
  source: string;
  state: string;
  sampleFormat: string;
  sampleRateHz: number;
  channelCount: number;
}

export interface AudioPreview {
  wav: Uint8Array;
  sampleRateHz: number;
  channelCount: number;
  frameCount: number;
  startFrame: bigint;
  durationUs: bigint;
}

interface ChunkMetadata {
  record: ArchiveRecord;
  sequence: bigint;
  firstFrame: bigint;
  frameCount: bigint;
  gapBeforeFrames: bigint;
  sampleFormat: string;
  sampleRateHz: number;
  channelCount: number;
  bytesPerSample: number;
}

/** Find audio tracks without loading their PCM data into memory. */
export function listSessionAudioTracks(
  session: ArchiveRecord,
  assetMetadata: readonly ArchiveRecord[],
  indexedTrackIds: readonly string[] = [],
): AudioTrackDescriptor[] {
  const sessionId = session.id.toLowerCase();
  const trackIds = new Set<string>();
  const add = (value: string): void => {
    const id = value.trim().toLowerCase();
    if (UUID_PATTERN.test(id)) trackIds.add(id);
  };

  for (const field of ["recording_track_ids", "recording_track_id", "audio_import_track_id"]) {
    for (const value of (session.fields.get(field) ?? "").split(",")) add(value);
  }
  for (const trackId of indexedTrackIds) add(trackId);
  for (const metadata of assetMetadata) {
    if (
      metadata.fields.get("record_role") === "audio-track" &&
      metadata.fields.get("session_id")?.toLowerCase() === sessionId &&
      metadata.fields.get("_deleted") !== "true"
    ) {
      add(metadata.fields.get("track_id") || metadata.id);
    }
  }

  const metadataById = new Map(
    assetMetadata.map((record) => [record.id.toLowerCase(), record] as const),
  );
  return [...trackIds]
    .filter((id) => metadataById.get(id)?.fields.get("_deleted") !== "true")
    .map((id, index) => {
      const metadata = metadataById.get(id);
      const source = metadata?.fields.get("source") || session.fields.get("recording_source") || "";
      return {
        sessionId,
        id,
        label:
          metadata?.fields.get("label") || (source ? sourceLabel(source) : `Track ${index + 1}`),
        source,
        state: metadata?.fields.get("state") || session.fields.get("recording_state") || "stored",
        sampleFormat:
          metadata?.fields.get("sample_format") ||
          session.fields.get("recording_sample_format") ||
          session.fields.get("audio_import_sample_format") ||
          "",
        sampleRateHz: safeNumber(
          metadata?.fields.get("sample_rate_hz") ||
            session.fields.get("recording_sample_rate_hz") ||
            session.fields.get("audio_import_sample_rate_hz"),
        ),
        channelCount: safeNumber(
          metadata?.fields.get("channel_count") ||
            session.fields.get("recording_channel_count") ||
            session.fields.get("audio_import_channel_count"),
        ),
      };
    });
}

/** Build a bounded WAV preview from one archive track and timeline range. */
export async function buildAudioPreview(
  snapshot: ArchiveSnapshot,
  sessionId: string,
  trackId: string,
  startTimeUs: string | bigint,
  endTimeUs?: string | bigint,
): Promise<AudioPreview> {
  if (snapshot.locked) {
    throw new ArchiveFormatError(
      "archive_locked",
      "Unlock this archive before playing recordings.",
    );
  }
  const chunks = await snapshot.listAudioChunkMetadata(sessionId, trackId);
  if (!chunks.length) {
    throw new ArchiveFormatError(
      "audio_track_empty",
      "This session has no saved audio for that track.",
    );
  }

  const metadata = chunks.map(parseChunkMetadata);
  const first = metadata[0]!;
  let expectedSequence = 0n;
  let expectedFrame = 0n;
  for (const chunk of metadata) {
    if (
      chunk.sequence !== expectedSequence ||
      chunk.sampleRateHz !== first.sampleRateHz ||
      chunk.channelCount !== first.channelCount ||
      chunk.sampleFormat !== first.sampleFormat ||
      chunk.gapBeforeFrames > U64_MAX - expectedFrame ||
      chunk.firstFrame !== expectedFrame + chunk.gapBeforeFrames ||
      chunk.frameCount > U64_MAX - chunk.firstFrame
    ) {
      throw new ArchiveFormatError(
        "audio_timeline_invalid",
        "This recording has inconsistent chunk order or timeline metadata.",
      );
    }
    expectedFrame = chunk.firstFrame + chunk.frameCount;
    expectedSequence += 1n;
  }

  const startUs = parseNonNegativeInteger(startTimeUs, "Playback start time");
  const requestedEndUs =
    endTimeUs === undefined
      ? startUs + MAX_PREVIEW_DURATION_US
      : parseNonNegativeInteger(endTimeUs, "Playback end time");
  if (requestedEndUs <= startUs) {
    throw new ArchiveFormatError("audio_range_invalid", "The playback range is empty.");
  }
  const endUs =
    requestedEndUs - startUs > MAX_PREVIEW_DURATION_US
      ? startUs + MAX_PREVIEW_DURATION_US
      : requestedEndUs;
  const rate = BigInt(first.sampleRateHz);
  const startFrame = (startUs * rate) / 1_000_000n;
  const requestedEndFrame = (endUs * rate + 999_999n) / 1_000_000n;
  const trackEndFrame = expectedFrame;
  const finalFrame = requestedEndFrame < trackEndFrame ? requestedEndFrame : trackEndFrame;
  if (startFrame >= finalFrame) {
    throw new ArchiveFormatError(
      "audio_range_outside_track",
      "There is no audio at this timestamp.",
    );
  }
  const outputFrameCount = finalFrame - startFrame;
  const outputBytes = outputFrameCount * BigInt(first.channelCount) * 2n;
  if (
    outputFrameCount > BigInt(Number.MAX_SAFE_INTEGER) ||
    outputBytes > BigInt(MAX_PREVIEW_BYTES)
  ) {
    throw new ArchiveFormatError(
      "audio_preview_limit",
      "This audio preview is larger than the 32 MiB playback limit.",
    );
  }

  const frameCount = Number(outputFrameCount);
  const pcm = new Uint8Array(Number(outputBytes));
  for (const chunk of metadata) {
    const chunkEnd = chunk.firstFrame + chunk.frameCount;
    const rangeStart = chunk.firstFrame > startFrame ? chunk.firstFrame : startFrame;
    const rangeEnd = chunkEnd < finalFrame ? chunkEnd : finalFrame;
    if (rangeStart >= rangeEnd) continue;

    const stored = await snapshot.getRecord(RecordType.audioChunk, chunk.record.id);
    if (!stored || stored.revision !== chunk.record.revision) {
      throw new ArchiveFormatError(
        "audio_chunk_changed",
        "A recording chunk changed while Tutorux was preparing playback.",
      );
    }
    validateAudioChunk(stored, chunk);
    const sourceFrameOffset = Number(rangeStart - chunk.firstFrame);
    const copyFrames = Number(rangeEnd - rangeStart);
    const targetFrameOffset = Number(rangeStart - startFrame);
    const sourceOffset = sourceFrameOffset * first.channelCount * chunk.bytesPerSample;
    const targetOffset = targetFrameOffset * first.channelCount * 2;
    const outputView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let frame = 0; frame < copyFrames; frame += 1) {
      for (let channel = 0; channel < first.channelCount; channel += 1) {
        const sampleOffset =
          sourceOffset + (frame * first.channelCount + channel) * chunk.bytesPerSample;
        const targetSampleOffset = targetOffset + (frame * first.channelCount + channel) * 2;
        outputView.setInt16(
          targetSampleOffset,
          toPcm16(readSample(stored.blob, sampleOffset, chunk.sampleFormat)),
          true,
        );
      }
    }
  }

  const durationUs = (outputFrameCount * 1_000_000n) / rate;
  return {
    wav: wrapPcm16Wav(pcm, first.sampleRateHz, first.channelCount),
    sampleRateHz: first.sampleRateHz,
    channelCount: first.channelCount,
    frameCount,
    startFrame,
    durationUs,
  };
}

/** Stream a complete archive track into a standards-compliant PCM/float WAV file. */
export async function buildAudioTrackWavStream(
  snapshot: ArchiveSnapshot,
  sessionId: string,
  trackId: string,
): Promise<ReadableStream<Uint8Array>> {
  if (snapshot.locked) {
    throw new ArchiveFormatError(
      "archive_locked",
      "Unlock this archive before exporting recordings.",
    );
  }
  const records = await snapshot.listAudioChunkMetadata(sessionId, trackId);
  if (records.length === 0) {
    throw new ArchiveFormatError("audio_track_empty", "This track has no saved audio to export.");
  }

  const chunks = records.map(parseChunkMetadata);
  const first = chunks[0]!;
  let expectedSequence = 0n;
  let expectedFrame = 0n;
  for (const chunk of chunks) {
    if (
      chunk.sequence !== expectedSequence ||
      chunk.sampleRateHz !== first.sampleRateHz ||
      chunk.channelCount !== first.channelCount ||
      chunk.sampleFormat !== first.sampleFormat ||
      chunk.gapBeforeFrames > U64_MAX - expectedFrame ||
      chunk.firstFrame !== expectedFrame + chunk.gapBeforeFrames ||
      chunk.frameCount > U64_MAX - chunk.firstFrame
    ) {
      throw new ArchiveFormatError(
        "audio_timeline_invalid",
        "This recording has inconsistent chunk order or timeline metadata.",
      );
    }
    expectedFrame = chunk.firstFrame + chunk.frameCount;
    expectedSequence += 1n;
  }

  const blockAlign = first.channelCount * first.bytesPerSample;
  const dataBytes = expectedFrame * BigInt(blockAlign);
  if (dataBytes + 36n > WAV_U32_MAX || dataBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveFormatError(
      "audio_wav_size_limit",
      "A WAV file cannot contain more than 4 GiB of audio data. Export a shorter track.",
    );
  }
  const header = makeTrackWavHeader(
    first.sampleRateHz,
    first.channelCount,
    first.bytesPerSample,
    first.sampleFormat,
    Number(dataBytes),
  );

  async function* chunksToWav(): AsyncGenerator<Uint8Array> {
    yield header;
    let timelineFrame = 0n;
    for (const metadata of chunks) {
      let silenceFrames = metadata.gapBeforeFrames;
      while (silenceFrames > 0n) {
        const maxFrames = BigInt(Math.floor(MAX_AUDIO_CHUNK_BYTES / blockAlign));
        const frames = silenceFrames < maxFrames ? silenceFrames : maxFrames;
        yield makeSilence(Number(frames) * blockAlign, first.sampleFormat);
        silenceFrames -= frames;
        timelineFrame += frames;
      }

      const stored = await snapshot.getRecord(RecordType.audioChunk, metadata.record.id);
      if (!stored || stored.revision !== metadata.record.revision) {
        throw new ArchiveFormatError(
          "audio_chunk_changed",
          "A recording chunk changed while Tutorux was preparing the WAV export.",
        );
      }
      validateAudioChunk(stored, metadata);
      if (metadata.firstFrame !== timelineFrame) {
        throw new ArchiveFormatError(
          "audio_timeline_invalid",
          "This recording has inconsistent chunk order or timeline metadata.",
        );
      }
      yield stored.blob;
      timelineFrame += metadata.frameCount;
    }
  }

  const iterator = chunksToWav();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await iterator.next();
        if (item.done) controller.close();
        else controller.enqueue(item.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

function makeTrackWavHeader(
  sampleRateHz: number,
  channelCount: number,
  bytesPerSample: number,
  sampleFormat: string,
  dataBytes: number,
): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + dataBytes, true);
  header.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, sampleFormat === "pcm_f32le" ? 3 : 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRateHz, true);
  const blockAlign = channelCount * bytesPerSample;
  view.setUint32(28, sampleRateHz * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  header.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, dataBytes, true);
  return header;
}

function makeSilence(length: number, sampleFormat: string): Uint8Array {
  const silence = new Uint8Array(length);
  if (sampleFormat === "pcm_u8") silence.fill(128);
  return silence;
}

function parseChunkMetadata(record: ArchiveRecord): ChunkMetadata {
  const sequence = fieldInteger(record, "sequence_number");
  const firstFrame = fieldInteger(record, "first_sample_index");
  const frameCount = fieldInteger(record, "sample_count");
  const gapBeforeFrames = fieldInteger(record, "gap_before_samples", true);
  const sampleRateValue = fieldInteger(record, "sample_rate_hz");
  const channelCountValue = fieldInteger(record, "channel_count");
  const sampleFormat = record.fields.get("sample_format") ?? "";
  const bytesPerSample = sampleBytes(sampleFormat);
  if (
    sampleRateValue < 8_000n ||
    sampleRateValue > 384_000n ||
    channelCountValue < 1n ||
    channelCountValue > 8n ||
    frameCount === 0n ||
    sampleRateValue > BigInt(Number.MAX_SAFE_INTEGER) ||
    channelCountValue > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ArchiveFormatError(
      "audio_chunk_metadata_invalid",
      "Recording format metadata is invalid.",
    );
  }
  return {
    record,
    sequence,
    firstFrame,
    frameCount,
    gapBeforeFrames,
    sampleFormat,
    sampleRateHz: Number(sampleRateValue),
    channelCount: Number(channelCountValue),
    bytesPerSample,
  };
}

function validateAudioChunk(record: ArchiveRecord, metadata: ChunkMetadata): void {
  if (
    record.type !== RecordType.audioChunk ||
    record.fields.get("session_id")?.toLowerCase() !==
      metadata.record.fields.get("session_id")?.toLowerCase() ||
    record.fields.get("track_id")?.toLowerCase() !==
      metadata.record.fields.get("track_id")?.toLowerCase() ||
    fieldInteger(record, "sequence_number") !== metadata.sequence ||
    fieldInteger(record, "first_sample_index") !== metadata.firstFrame ||
    fieldInteger(record, "sample_count") !== metadata.frameCount ||
    record.fields.get("sample_format") !== metadata.sampleFormat ||
    record.fields.get("codec") !== "none"
  ) {
    throw new ArchiveFormatError(
      "audio_chunk_invalid",
      "A recording chunk does not match its index.",
    );
  }
  const expectedLength =
    metadata.frameCount * BigInt(metadata.channelCount * metadata.bytesPerSample);
  if (record.blob.byteLength > MAX_AUDIO_CHUNK_BYTES) {
    throw new ArchiveFormatError(
      "audio_chunk_size_limit",
      "A recording chunk is larger than the supported 1 MiB chunk size.",
    );
  }
  if (expectedLength !== BigInt(record.blob.byteLength)) {
    throw new ArchiveFormatError(
      "audio_chunk_length_invalid",
      "A recording chunk has an invalid byte length.",
    );
  }
  const checksum = record.fields.get("payload_checksum");
  if (checksum !== undefined) {
    if (!/^\d+$/u.test(checksum) || Number(checksum) !== crc32(record.blob)) {
      throw new ArchiveFormatError(
        "audio_chunk_checksum",
        "A recording chunk failed its audio checksum.",
      );
    }
  }
}

function sampleBytes(format: string): number {
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
      throw new ArchiveFormatError(
        "audio_format_unsupported",
        `Tutorux cannot play the ${format || "unknown"} recording format yet.`,
      );
  }
}

function readSample(bytes: Uint8Array, offset: number, format: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (format) {
    case "pcm_u8":
      return (bytes[offset]! - 128) / 128;
    case "pcm_s16le":
      return view.getInt16(offset, true) / 32768;
    case "pcm_s24le": {
      let value = bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
      if (value & 0x800000) value |= 0xff000000;
      return value / 8_388_608;
    }
    case "pcm_s32le":
      return view.getInt32(offset, true) / 2_147_483_648;
    case "pcm_f32le": {
      const value = view.getFloat32(offset, true);
      return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }
    default:
      throw new ArchiveFormatError(
        "audio_format_unsupported",
        "This audio format is not supported.",
      );
  }
}

function toPcm16(value: number): number {
  if (value <= -1) return -32_768;
  if (value >= 1) return 32_767;
  return Math.max(-32_768, Math.min(32_767, Math.round(value * 32_768)));
}

function wrapPcm16Wav(pcm: Uint8Array, sampleRateHz: number, channelCount: number): Uint8Array {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  wav.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, wav.byteLength - 8, true);
  wav.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  wav.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

function fieldInteger(record: ArchiveRecord, name: string, optional = false): bigint {
  const value = record.fields.get(name);
  if (value === undefined && optional) return 0n;
  if (!value || !/^\d+$/u.test(value)) {
    throw new ArchiveFormatError(
      "audio_chunk_metadata_invalid",
      `A recording chunk has an invalid ${name} value.`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) {
    throw new ArchiveFormatError(
      "audio_chunk_metadata_invalid",
      `Recording ${name} exceeds its limit.`,
    );
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | bigint, label: string): bigint {
  const parsed = typeof value === "bigint" ? value : /^\d+$/u.test(value) ? BigInt(value) : -1n;
  if (parsed < 0n || parsed > U64_MAX) {
    throw new ArchiveFormatError("audio_range_invalid", `${label} must be a nonnegative integer.`);
  }
  return parsed;
}

function safeNumber(value: string | undefined): number {
  if (!value || !/^\d+$/u.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "microphone":
      return "Microphone";
    case "system-audio-loopback":
      return "System audio";
    case "application-audio":
      return "Application audio";
    case "wav-import":
      return "Imported recording";
    default:
      return source.replaceAll("-", " ");
  }
}

const U64_MAX = 18_446_744_073_709_551_615n;
