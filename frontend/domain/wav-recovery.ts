import { ArchiveFormatError, crc32, RecordType, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_EXPECTED_CHUNKS = 1_000_000n;
const BYTES_PER_SAMPLE: Readonly<Record<string, bigint>> = {
  pcm_u8: 1n,
  pcm_s16le: 2n,
  pcm_s24le: 3n,
  pcm_s32le: 4n,
  pcm_f32le: 4n,
};

export interface WavImportRecoveryResult {
  records: ArchiveRecord[];
  completed: boolean;
  state: "completed" | "interrupted";
  chunkCount: number;
  sampleCount: string;
  durationUs: string;
  byteCount: string;
  message: string;
}

/** Verify committed PCM chunks and reconcile legacy incremental WAV import state. */
export async function prepareWavImportRecovery(
  snapshot: ArchiveSnapshot,
  session: ArchiveRecord,
): Promise<WavImportRecoveryResult> {
  if (session.type !== RecordType.session || session.fields.get("_deleted") === "true") {
    throw new ArchiveFormatError("session_not_found", "Choose an active session to recover audio.");
  }
  const importState = session.fields.get("audio_import_state") ?? "";
  if (!["importing", "finalizing", "interrupted", "completed"].includes(importState)) {
    throw new ArchiveFormatError(
      "audio_recovery_unavailable",
      "This session has no recoverable WAV import metadata.",
    );
  }

  const fields = session.fields;
  const trackId = validUuid(fields.get("audio_import_track_id"));
  const takeId = validUuid(fields.get("audio_import_take_id"));
  const expectedChunks = unsignedField(fields.get("audio_import_expected_chunks"));
  const expectedSamples = unsignedField(fields.get("audio_import_expected_samples"));
  const expectedBytes = unsignedField(fields.get("audio_import_expected_bytes"));
  const sampleRate = unsignedField(fields.get("audio_import_sample_rate_hz"));
  const channelCount = unsignedField(fields.get("audio_import_channel_count"));
  const sampleFormat = fields.get("audio_import_sample_format") ?? "";
  const bytesPerSample = BYTES_PER_SAMPLE[sampleFormat];

  if (
    !trackId ||
    expectedChunks === undefined ||
    expectedSamples === undefined ||
    expectedBytes === undefined ||
    sampleRate === undefined ||
    channelCount === undefined ||
    expectedChunks === 0n ||
    expectedChunks > MAX_EXPECTED_CHUNKS ||
    expectedSamples === 0n ||
    expectedBytes === 0n ||
    sampleRate < 8_000n ||
    sampleRate > 384_000n ||
    channelCount === 0n ||
    channelCount > 8n ||
    !bytesPerSample
  ) {
    return persistRecovery(
      snapshot,
      session,
      takeId,
      { chunks: 0, samples: 0n, bytes: 0n, sampleRate: Number(sampleRate ?? 0n) },
      false,
      "Saved audio import metadata is incomplete or invalid.",
    );
  }

  const blockAlign = bytesPerSample * channelCount;
  if (
    expectedSamples > U64_MAX / blockAlign ||
    expectedSamples * blockAlign !== expectedBytes ||
    sampleRate > BigInt(Number.MAX_SAFE_INTEGER) ||
    channelCount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return persistRecovery(
      snapshot,
      session,
      takeId,
      { chunks: 0, samples: 0n, bytes: 0n, sampleRate: Number(sampleRate) },
      false,
      "Saved audio format does not match its expected byte count.",
    );
  }

  const rate = Number(sampleRate);
  const channels = Number(channelCount);
  const maximumTimestampSample = (U64_MAX / 1_000_000n) * sampleRate;
  const expectedMask = fields.get("audio_import_channel_mask") ?? "0";
  const metadata = await snapshot.listAudioChunkMetadata(session.id, trackId);
  let recoveredSamples = 0n;
  let recoveredBytes = 0n;
  let failureReason = "";
  let chunkCount = 0;

  for (const indexed of metadata) {
    let chunk: ArchiveRecord | null;
    try {
      chunk = await snapshot.getRecord(RecordType.audioChunk, indexed.id);
    } catch (error) {
      throw new ArchiveFormatError(
        "audio_recovery_chunk_read_failed",
        `Could not read audio chunk ${indexed.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!chunk) {
      failureReason = "A committed audio chunk is missing or corrupt.";
      break;
    }

    const sequence = unsignedField(chunk.fields.get("sequence_number"));
    const firstSample = unsignedField(chunk.fields.get("first_sample_index"));
    const sampleCount = unsignedField(chunk.fields.get("sample_count"));
    const checksum = unsignedField(chunk.fields.get("payload_checksum"));
    const startTime = unsignedField(chunk.fields.get("timeline_start_us"));
    const endTime = unsignedField(chunk.fields.get("timeline_end_us"));
    const chunkBytes = BigInt(chunk.blob.byteLength);
    if (
      sequence !== BigInt(chunkCount) ||
      firstSample !== recoveredSamples ||
      sampleCount === undefined ||
      sampleCount === 0n ||
      checksum === undefined ||
      startTime === undefined ||
      endTime === undefined ||
      chunk.fields.get("session_id")?.toLowerCase() !== session.id.toLowerCase() ||
      chunk.fields.get("track_id")?.toLowerCase() !== trackId ||
      chunk.fields.get("sample_format") !== sampleFormat ||
      chunk.fields.get("codec") !== "none" ||
      chunk.fields.get("sample_rate_hz") !== String(rate) ||
      chunk.fields.get("channel_count") !== String(channels) ||
      chunk.fields.get("channel_mask") !== expectedMask ||
      sampleCount > U64_MAX / blockAlign ||
      firstSample > U64_MAX - sampleCount ||
      firstSample + sampleCount > maximumTimestampSample ||
      sampleCount * blockAlign !== chunkBytes ||
      checksum > 0xffff_ffffn ||
      crc32(chunk.blob) !== Number(checksum) ||
      startTime !== samplesToMicroseconds(firstSample, rate) ||
      endTime !== samplesToMicroseconds(firstSample + sampleCount, rate) ||
      recoveredSamples > U64_MAX - sampleCount ||
      recoveredBytes > U64_MAX - chunkBytes
    ) {
      failureReason = "A committed audio chunk is missing, malformed, or corrupt.";
      break;
    }

    recoveredSamples += sampleCount;
    recoveredBytes += chunkBytes;
    chunkCount += 1;
  }

  const completed =
    !failureReason &&
    BigInt(chunkCount) === expectedChunks &&
    recoveredSamples === expectedSamples &&
    recoveredBytes === expectedBytes;
  if (!completed && !failureReason)
    failureReason = "Committed audio chunks do not reach the expected end of the WAV file.";

  return persistRecovery(
    snapshot,
    session,
    takeId,
    { chunks: chunkCount, samples: recoveredSamples, bytes: recoveredBytes, sampleRate: rate },
    completed,
    failureReason,
  );
}

async function persistRecovery(
  snapshot: ArchiveSnapshot,
  session: ArchiveRecord,
  takeId: string | undefined,
  summary: { chunks: number; samples: bigint; bytes: bigint; sampleRate: number },
  completed: boolean,
  failureReason: string,
): Promise<WavImportRecoveryResult> {
  const now = (BigInt(Date.now()) * 1_000n).toString();
  const state = completed ? "completed" : "interrupted";
  const sessionFields = new Map(session.fields);
  sessionFields.set("recording_state", state);
  sessionFields.set("audio_import_state", state);
  sessionFields.set("audio_chunks_imported", String(summary.chunks));
  sessionFields.set("audio_samples_imported", summary.samples.toString());
  sessionFields.set("audio_import_bytes", summary.bytes.toString());
  sessionFields.set("audio_import_error", failureReason);
  sessionFields.set("updated_at_us", now);
  if (completed) sessionFields.set("audio_imported_at_us", now);
  else sessionFields.delete("audio_imported_at_us");

  const records: ArchiveRecord[] = [{ ...session, fields: sessionFields }];
  if (takeId) {
    const take = await snapshot.getRecord(RecordType.assetMetadata, takeId);
    if (
      !take ||
      take.fields.get("record_role") !== "recording-take" ||
      take.fields.get("_deleted") === "true"
    ) {
      throw new ArchiveFormatError(
        "recording_take_not_found",
        "Audio recovery metadata has no active recording take.",
      );
    }
    const takeFields = new Map(take.fields);
    takeFields.set("state", completed ? "completed" : summary.chunks === 0 ? "failed" : "partial");
    takeFields.set(
      "duration_us",
      samplesToMicroseconds(summary.samples, summary.sampleRate).toString(),
    );
    takeFields.set("ended_at_us", now);
    takeFields.set("updated_at_us", now);
    records.push({ ...take, fields: takeFields });
  }

  const durationUs = samplesToMicroseconds(summary.samples, summary.sampleRate);
  const message = completed
    ? `Verified ${summary.chunks.toLocaleString()} audio chunks and marked the WAV import complete.`
    : `Preserved ${summary.chunks.toLocaleString()} verified audio chunks as an interrupted import${failureReason ? `: ${failureReason}` : "."}`;
  return {
    records,
    completed,
    state,
    chunkCount: summary.chunks,
    sampleCount: summary.samples.toString(),
    durationUs: durationUs.toString(),
    byteCount: summary.bytes.toString(),
    message,
  };
}

function validUuid(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase();
  return normalized && UUID_PATTERN.test(normalized) ? normalized : undefined;
}

function unsignedField(value: string | undefined): bigint | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed <= U64_MAX ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function samplesToMicroseconds(samples: bigint, sampleRateHz: number): bigint {
  if (!sampleRateHz) return 0n;
  const rate = BigInt(sampleRateHz);
  return (samples / rate) * 1_000_000n + ((samples % rate) * 1_000_000n) / rate;
}
