import { crc32, newUuid, RecordType, type ArchiveRecord } from "../archive/format";

export const MAX_WAVE_IMPORT_BYTES = 256 * 1024 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024;
const MAX_FORMAT_CHUNK_BYTES = 1024 * 1024;
const U64_MAX = 18_446_744_073_709_551_615n;
const encoder = new TextEncoder();

export interface WaveFile {
  readonly name: string;
  readonly size: number;
  slice(start?: number, end?: number): Blob;
}

export interface WaveImportResult {
  records: ArchiveRecord[];
  trackId: string;
  takeId: string;
  sampleRateHz: number;
  channelCount: number;
  sampleFormat: string;
  sampleCount: bigint;
  chunkCount: number;
  durationUs: bigint;
  byteCount: number;
}

interface DataRange {
  offset: number;
  length: number;
}

interface WaveFormat {
  sampleRateHz: number;
  channelCount: number;
  channelMask: number;
  blockAlign: number;
  sampleFormat: string;
  sourceCodec: string;
  bytesPerSample: number;
  dataRanges: DataRange[];
  dataBytes: number;
}

/** Import PCM WAV bytes as legacy-compatible, independently checksummed archive audio chunks. */
export async function makeWaveImportRecords(
  session: ArchiveRecord,
  file: WaveFile,
  allowAdditionalTrack = false,
  knownTrackIds: readonly string[] = [],
): Promise<WaveImportResult> {
  if (session.type !== RecordType.session || session.fields.get("_deleted") === "true") {
    throw new Error("Choose an active tutoring session before importing audio.");
  }
  if (!Number.isSafeInteger(file.size) || file.size < 12 || file.size > MAX_WAVE_IMPORT_BYTES) {
    throw new Error("WAV files must be between 12 bytes and 256 MiB in this version.");
  }
  const state = session.fields.get("recording_state") ?? "";
  if (["initializing", "recording", "paused", "finalizing"].includes(state)) {
    throw new Error("Stop the active recording before importing a WAV track.");
  }
  const sessionAlreadyHasAudio =
    knownTrackIds.length > 0 ||
    ["recording_track_id", "recording_track_ids", "audio_import_track_id"].some((key) =>
      Boolean(session.fields.get(key)?.trim()),
    );
  if (sessionAlreadyHasAudio && !allowAdditionalTrack) {
    throw new Error("Choose ‘keep existing tracks’ to add this WAV as a separate audio track.");
  }

  const format = await inspectWave(file);
  const sampleCount = BigInt(format.dataBytes / format.blockAlign);
  const durationUs = (sampleCount * 1_000_000n) / BigInt(format.sampleRateHz);
  const filename = cleanFilename(file.name);
  const timestamp = (BigInt(Date.now()) * 1_000n).toString();
  const trackId = newUuid();
  const takeId = newUuid();
  const alignedChunkBytes =
    Math.floor(MAX_AUDIO_CHUNK_BYTES / format.blockAlign) * format.blockAlign;
  const records: ArchiveRecord[] = [];
  let sequence = 0;
  let firstSample = 0n;

  for (const range of format.dataRanges) {
    for (let rangeOffset = 0; rangeOffset < range.length;) {
      const chunkLength = Math.min(alignedChunkBytes, range.length - rangeOffset);
      const raw = new Uint8Array(
        await file
          .slice(range.offset + rangeOffset, range.offset + rangeOffset + chunkLength)
          .arrayBuffer(),
      );
      if (
        raw.byteLength !== chunkLength ||
        raw.byteLength === 0 ||
        raw.byteLength % format.blockAlign
      ) {
        throw new Error("The WAV source changed or contains an incomplete sample frame.");
      }
      const frameCount = BigInt(raw.byteLength / format.blockAlign);
      const nextSample = firstSample + frameCount;
      if (nextSample > U64_MAX) throw new Error("The WAV sample timeline exceeds archive limits.");
      const chunkFields = new Map<string, string>([
        ["session_id", session.id.toLowerCase()],
        ["track_id", trackId],
        ["sequence_number", String(sequence)],
        ["first_sample_index", firstSample.toString()],
        ["sample_count", frameCount.toString()],
        ["timeline_start_us", samplesToMicroseconds(firstSample, format.sampleRateHz).toString()],
        ["timeline_end_us", samplesToMicroseconds(nextSample, format.sampleRateHz).toString()],
        ["sample_format", format.sampleFormat],
        ["sample_rate_hz", String(format.sampleRateHz)],
        ["channel_count", String(format.channelCount)],
        ["channel_mask", String(format.channelMask)],
        ["codec", "none"],
        ["source_codec", format.sourceCodec],
        ["payload_checksum", String(crc32(raw))],
        ["source_filename", filename],
      ]);
      records.push(makeRecord(RecordType.audioChunk, newUuid(), chunkFields, raw));
      sequence += 1;
      firstSample = nextSample;
      rangeOffset += chunkLength;
    }
  }

  if (firstSample !== sampleCount || sequence === 0) {
    throw new Error("The WAV sample count changed during import.");
  }

  const priorTrackIds = new Set<string>();
  for (const value of [
    session.fields.get("recording_track_ids"),
    session.fields.get("recording_track_id"),
    session.fields.get("audio_import_track_id"),
  ]) {
    for (const id of (value ?? "").split(",")) {
      const normalized = id.trim().toLowerCase();
      if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(normalized)) {
        priorTrackIds.add(normalized);
      }
    }
  }
  for (const id of knownTrackIds) {
    const normalized = id.trim().toLowerCase();
    if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(normalized)) {
      priorTrackIds.add(normalized);
    }
  }
  const linkedTrackIds = [...priorTrackIds];
  if (!linkedTrackIds.includes(trackId)) linkedTrackIds.push(trackId);
  const startedAtUs = timestamp;
  const trackFields = new Map<string, string>([
    ["record_role", "audio-track"],
    ["session_id", session.id.toLowerCase()],
    ["track_id", trackId],
    ["recording_take_id", takeId],
    ["label", filename],
    ["source", "imported-file"],
    ["state", "completed"],
    ["message", ""],
    ["sample_format", format.sampleFormat],
    ["sample_rate_hz", String(format.sampleRateHz)],
    ["channel_count", String(format.channelCount)],
    ["channel_mask", String(format.channelMask)],
    ["sample_count", sampleCount.toString()],
    ["timeline_sample_count", sampleCount.toString()],
    ["duration_us", durationUs.toString()],
    ["chunk_count", String(sequence)],
    ["byte_count", String(format.dataBytes)],
    ["source_filename", filename],
    ["updated_at_us", timestamp],
  ]);
  records.push(makeRecord(RecordType.assetMetadata, trackId, trackFields));
  records.push(
    makeRecord(
      RecordType.assetMetadata,
      takeId,
      new Map([
        ["record_role", "recording-take"],
        ["session_id", session.id.toLowerCase()],
        ["label", filename],
        ["source", "imported-file"],
        ["state", "completed"],
        ["track_ids", trackId],
        ["started_at_us", startedAtUs],
        ["ended_at_us", timestamp],
        ["duration_us", durationUs.toString()],
        ["created_at_us", timestamp],
        ["updated_at_us", timestamp],
      ]),
    ),
  );

  const sessionFields = new Map(session.fields);
  sessionFields.set("recording_track_ids", linkedTrackIds.join(","));
  sessionFields.set("recording_track_count", String(linkedTrackIds.length));
  if (!sessionFields.get("recording_track_id")) sessionFields.set("recording_track_id", trackId);
  if (priorTrackIds.size === 0) {
    sessionFields.set("recording_source", "imported-file");
    sessionFields.set("recording_sample_format", format.sampleFormat);
    sessionFields.set("recording_sample_rate_hz", String(format.sampleRateHz));
    sessionFields.set("recording_channel_count", String(format.channelCount));
    sessionFields.set("recording_channel_mask", String(format.channelMask));
    sessionFields.set("recording_started_at_us", timestamp);
    sessionFields.set("recording_samples", sampleCount.toString());
    sessionFields.set("recording_timeline_samples", sampleCount.toString());
    sessionFields.set("recording_bytes", String(format.dataBytes));
    sessionFields.set("recording_audio_chunks", String(sequence));
  } else {
    sessionFields.set(
      "recording_audio_chunks",
      (safeCount(sessionFields.get("recording_audio_chunks")) + sequence).toString(),
    );
    sessionFields.set(
      "recording_bytes",
      (safeCount(sessionFields.get("recording_bytes")) + format.dataBytes).toString(),
    );
  }
  const priorDuration = safeBigInt(sessionFields.get("recording_duration_us"));
  if (durationUs > priorDuration) sessionFields.set("recording_duration_us", durationUs.toString());
  sessionFields.set("recording_state", "completed");
  sessionFields.set("recording_ended_at_us", timestamp);
  sessionFields.set("audio_import_track_id", trackId);
  sessionFields.set("audio_import_take_id", takeId);
  sessionFields.set("audio_import_expected_chunks", String(sequence));
  sessionFields.set("audio_import_expected_samples", sampleCount.toString());
  sessionFields.set("audio_import_expected_bytes", String(format.dataBytes));
  sessionFields.set("audio_import_sample_rate_hz", String(format.sampleRateHz));
  sessionFields.set("audio_import_channel_count", String(format.channelCount));
  sessionFields.set("audio_import_channel_mask", String(format.channelMask));
  sessionFields.set("audio_import_sample_format", format.sampleFormat);
  sessionFields.set("audio_import_source_codec", format.sourceCodec);
  sessionFields.set("audio_import_bytes", String(format.dataBytes));
  sessionFields.set("audio_chunks_imported", String(sequence));
  sessionFields.set("audio_samples_imported", sampleCount.toString());
  sessionFields.set("audio_import_state", "completed");
  sessionFields.set("audio_imported_at_us", timestamp);
  sessionFields.set("updated_at_us", timestamp);
  records.push({ ...session, fields: sessionFields });

  return {
    records,
    trackId,
    takeId,
    sampleRateHz: format.sampleRateHz,
    channelCount: format.channelCount,
    sampleFormat: format.sampleFormat,
    sampleCount,
    chunkCount: sequence,
    durationUs,
    byteCount: format.dataBytes,
  };
}

async function inspectWave(file: WaveFile): Promise<WaveFormat> {
  const header = await readRange(file, 0, 12);
  if (ascii(header.subarray(0, 4)) !== "RIFF" || ascii(header.subarray(8, 12)) !== "WAVE") {
    throw new Error("Choose a little-endian RIFF/WAVE audio file.");
  }
  const riffEnd = 8 + readU32(header, 4);
  if (riffEnd < 12 || riffEnd > file.size) {
    throw new Error("The WAV RIFF length exceeds the selected file.");
  }

  let format: Omit<WaveFormat, "dataRanges" | "dataBytes"> | null = null;
  const dataRanges: DataRange[] = [];
  let dataBytes = 0;
  let cursor = 12;
  while (cursor < riffEnd) {
    if (riffEnd - cursor < 8) throw new Error("The WAV file ends with an incomplete chunk header.");
    const chunkHeader = await readRange(file, cursor, 8);
    const chunkName = ascii(chunkHeader.subarray(0, 4));
    const chunkLength = readU32(chunkHeader, 4);
    const payloadOffset = cursor + 8;
    const paddedLength = chunkLength + (chunkLength & 1);
    if (paddedLength > riffEnd - payloadOffset) {
      throw new Error("A WAV chunk extends beyond the declared RIFF file.");
    }

    if (chunkName === "fmt ") {
      if (format || chunkLength < 16 || chunkLength > MAX_FORMAT_CHUNK_BYTES) {
        throw new Error("The WAV format chunk is duplicated or invalid.");
      }
      const bytes = await readRange(file, payloadOffset, Math.min(chunkLength, 40));
      const tag = readU16(bytes, 0);
      const channelCount = readU16(bytes, 2);
      const sampleRateHz = readU32(bytes, 4);
      const byteRate = readU32(bytes, 8);
      const blockAlign = readU16(bytes, 12);
      const bitsPerSample = readU16(bytes, 14);
      let formatTag = tag;
      let channelMask = 0;
      if (tag === 0xfffe) {
        const guidTail = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
        if (
          chunkLength < 40 ||
          bytes.byteLength < 40 ||
          readU16(bytes, 16) < 22 ||
          readU16(bytes, 18) !== bitsPerSample ||
          guidTail.some((value, index) => bytes[28 + index] !== value)
        ) {
          throw new Error("Only PCM or IEEE-float WAVE extensible formats are supported.");
        }
        channelMask = readU32(bytes, 20);
        formatTag = readU32(bytes, 24);
      }
      if (
        (formatTag !== 1 && formatTag !== 3) ||
        (formatTag === 1 && ![8, 16, 24, 32].includes(bitsPerSample)) ||
        (formatTag === 3 && bitsPerSample !== 32)
      ) {
        throw new Error("Supported WAV audio is PCM 8/16/24/32-bit or IEEE-float 32-bit.");
      }
      if (channelCount < 1 || channelCount > 8 || sampleRateHz < 8_000 || sampleRateHz > 384_000) {
        throw new Error("WAV channel count or sample rate is outside supported limits.");
      }
      const bytesPerSample = bitsPerSample / 8;
      const expectedAlign = channelCount * bytesPerSample;
      if (blockAlign !== expectedAlign || byteRate !== sampleRateHz * expectedAlign) {
        throw new Error("WAV block alignment or byte rate is inconsistent.");
      }
      const sampleFormat =
        formatTag === 3 ? "pcm_f32le" : bitsPerSample === 8 ? "pcm_u8" : `pcm_s${bitsPerSample}le`;
      format = {
        sampleRateHz,
        channelCount,
        channelMask,
        blockAlign,
        sampleFormat,
        sourceCodec: formatTag === 3 ? "wav-ieee-float" : "wav-pcm",
        bytesPerSample,
      };
    } else if (chunkName === "data" && chunkLength > 0) {
      dataRanges.push({ offset: payloadOffset, length: chunkLength });
      dataBytes += chunkLength;
      if (dataBytes > MAX_WAVE_IMPORT_BYTES) {
        throw new Error("WAV audio data is larger than the 256 MiB import limit.");
      }
    }
    cursor = payloadOffset + paddedLength;
  }

  if (!format || !dataRanges.length || dataBytes === 0) {
    throw new Error("The WAV file must contain one format chunk and nonempty audio data.");
  }
  if (
    dataBytes % format.blockAlign !== 0 ||
    dataRanges.some((range) => range.length % format!.blockAlign !== 0)
  ) {
    throw new Error("WAV sample data contains an incomplete audio frame.");
  }
  return { ...format, dataRanges, dataBytes };
}

async function readRange(file: WaveFile, offset: number, length: number): Promise<Uint8Array> {
  const end = offset + length;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    end > file.size
  ) {
    throw new Error("The WAV file ended before the requested data could be read.");
  }
  const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
  if (bytes.byteLength !== length) throw new Error("The WAV file changed during import.");
  return bytes;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function samplesToMicroseconds(samples: bigint, sampleRateHz: number): bigint {
  const rate = BigInt(sampleRateHz);
  return (samples / rate) * 1_000_000n + ((samples % rate) * 1_000_000n) / rate;
}

function makeRecord(
  type: number,
  id: string,
  fields: ReadonlyMap<string, string>,
  blob = new Uint8Array(),
): ArchiveRecord {
  return { type, id, revision: 0n, previousOffset: 0n, fields, blob };
}

function cleanFilename(value: string): string {
  const filename = value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const normalized = [...filename]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 256);
  if (!normalized || encoder.encode(normalized).byteLength > 1024) {
    throw new Error("WAV filename must contain between 1 and 256 characters.");
  }
  return normalized;
}

function safeCount(value: string | undefined): number {
  if (!value || !/^\d+$/u.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function safeBigInt(value: string | undefined): bigint {
  return value && /^\d+$/u.test(value) ? BigInt(value) : 0n;
}
