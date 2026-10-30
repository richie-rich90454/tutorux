import { ArchiveFormatError, crc32, RecordType, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";

const U64_MAX = 18_446_744_073_709_551_615n;
const U32_MAX = 4_294_967_295n;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const BYTES_PER_SAMPLE: Readonly<Record<string, bigint>> = {
  pcm_u8: 1n,
  pcm_s16le: 2n,
  pcm_s24le: 3n,
  pcm_s32le: 4n,
  pcm_f32le: 4n,
};

export interface NativeCaptureTrackRecovery {
  trackId: string;
  source: string;
  deviceId: string;
  state: "completed" | "interrupted" | "failed";
  sampleCount: string;
  timelineSamples: string;
  chunkCount: string;
  discontinuities: string;
  durationUs: string;
  byteCount: string;
  errorCode: string;
  errorMessage: string;
}

export interface NativeCaptureRecovery {
  records: ArchiveRecord[];
  tracks: NativeCaptureTrackRecovery[];
  completed: boolean;
  sampleCount: string;
  chunkCount: string;
  durationUs: string;
  byteCount: string;
  message: string;
}

interface TrackResult {
  report: NativeCaptureTrackRecovery;
  metadata?: ArchiveRecord;
  recovered: boolean;
}

interface TrackTotals {
  samples: bigint;
  timelineSamples: bigint;
  chunks: bigint;
  bytes: bigint;
  durationUs: bigint;
  discontinuities: bigint;
}

/** Verify committed native capture tracks and reconcile their session and take state. */
export async function prepareNativeCaptureRecovery(
  snapshot: ArchiveSnapshot,
  session: ArchiveRecord,
): Promise<NativeCaptureRecovery> {
  if (session.type !== RecordType.session || session.fields.get("_deleted") === "true") {
    throw new ArchiveFormatError("session_not_found", "Choose an active session to recover audio.");
  }

  const trackIds = await nativeTrackIds(snapshot, session);
  if (trackIds.length === 0) {
    throw new ArchiveFormatError(
      "audio_recording_not_found",
      "Session does not contain recoverable native audio tracks.",
    );
  }

  const changedAt = nowUs();
  const records = new Map<string, ArchiveRecord>();
  const outcomes: TrackResult[] = [];
  for (const trackId of trackIds) {
    let metadata: ArchiveRecord | null;
    try {
      metadata = await snapshot.getRecord(RecordType.assetMetadata, trackId);
    } catch (error) {
      outcomes.push(failedTrack(trackId, "", error));
      continue;
    }

    const isTrackMetadata = metadata?.fields.get("record_role") === "audio-track";
    if (
      isTrackMetadata &&
      (metadata!.fields.get("_deleted") === "true" ||
        metadata!.fields.get("session_id")?.toLowerCase() !== session.id.toLowerCase())
    ) {
      outcomes.push(
        failedTrack(
          trackId,
          sourceName(metadata!.fields.get("source")),
          new Error("The selected recording track has no matching active metadata."),
        ),
      );
      continue;
    }

    const legacySessionTrack =
      !isTrackMetadata && trackId === validUuid(session.fields.get("recording_track_id"));
    if (!isTrackMetadata && !legacySessionTrack) {
      outcomes.push(
        failedTrack(
          trackId,
          "",
          new Error("The selected recording track has no matching recovery metadata."),
        ),
      );
      continue;
    }

    const formatRecord = isTrackMetadata ? metadata! : session;
    const format = readFormat(formatRecord, isTrackMetadata);
    if (typeof format === "string") {
      outcomes.push(
        failedTrack(trackId, sourceName(metadata?.fields.get("source")), new Error(format)),
      );
      continue;
    }

    const previousState = value(formatRecord, isTrackMetadata ? "state" : "recording_state");
    const result = await recoverTrack(
      snapshot,
      session,
      trackId,
      format,
      previousState,
      metadata ?? undefined,
    );
    outcomes.push(result);
    if (result.metadata && result.recovered) {
      const fields = new Map(result.metadata.fields);
      const report = result.report;
      fields.set("state", report.state);
      fields.set("chunk_count", report.chunkCount);
      fields.set("sample_count", report.sampleCount);
      fields.set("timeline_sample_count", report.timelineSamples);
      fields.set("byte_count", report.byteCount);
      fields.set("duration_us", report.durationUs);
      fields.set("recovery_error", report.errorMessage);
      fields.set("recovered_at_us", changedAt);
      fields.set("updated_at_us", changedAt);
      records.set(recordKey(result.metadata), { ...result.metadata, fields });
    }
  }

  const totals: TrackTotals = {
    samples: 0n,
    timelineSamples: 0n,
    chunks: 0n,
    bytes: 0n,
    durationUs: 0n,
    discontinuities: 0n,
  };
  let completed = true;
  const errors: string[] = [];
  for (const outcome of outcomes) {
    const { report } = outcome;
    if (report.state !== "completed") completed = false;
    const sampleCount = BigInt(report.sampleCount);
    const timelineSamples = BigInt(report.timelineSamples);
    const chunkCount = BigInt(report.chunkCount);
    const byteCount = BigInt(report.byteCount);
    totals.samples = saturatedAdd(totals.samples, sampleCount);
    if (timelineSamples > totals.timelineSamples) totals.timelineSamples = timelineSamples;
    totals.chunks = saturatedAdd(totals.chunks, chunkCount);
    totals.bytes = saturatedAdd(totals.bytes, byteCount);
    totals.discontinuities = saturatedAdd(totals.discontinuities, BigInt(report.discontinuities));
    const duration = BigInt(report.durationUs);
    if (duration > totals.durationUs) totals.durationUs = duration;
    if (report.errorMessage) errors.push(`${report.source || "audio"}: ${report.errorMessage}`);
  }

  const sessionFields = new Map(session.fields);
  sessionFields.set("recording_track_count", String(trackIds.length));
  sessionFields.set("recording_audio_chunks", totals.chunks.toString());
  sessionFields.set("recording_samples", totals.samples.toString());
  sessionFields.set("recording_bytes", totals.bytes.toString());
  sessionFields.set("recording_duration_us", totals.durationUs.toString());
  sessionFields.set(
    "recording_state",
    completed ? "completed" : totals.chunks > 0n ? "partial" : "failed",
  );
  sessionFields.set("recording_error", errors.join("\n"));
  sessionFields.set("recording_recovered_at_us", changedAt);
  sessionFields.set("recording_discontinuities", totals.discontinuities.toString());
  sessionFields.set("recording_timeline_samples", totals.timelineSamples.toString());
  sessionFields.set("updated_at_us", changedAt);
  records.set(recordKey(session), { ...session, fields: sessionFields });

  const recoveredIds = new Set(trackIds);
  const takeMetadata = await snapshot.listRecordMetadata(RecordType.assetMetadata, true);
  for (const indexedTake of takeMetadata) {
    if (
      indexedTake.fields.get("_deleted") === "true" ||
      indexedTake.fields.get("record_role") !== "recording-take" ||
      indexedTake.fields.get("session_id")?.toLowerCase() !== session.id.toLowerCase()
    ) {
      continue;
    }
    const linkedIds = splitIds(indexedTake.fields.get("track_ids"));
    if (!linkedIds.some((id) => recoveredIds.has(id))) continue;
    const take = await snapshot.getRecord(RecordType.assetMetadata, indexedTake.id);
    if (!take) continue;
    const allTracksRecovered =
      linkedIds.length > 0 && linkedIds.every((id) => recoveredIds.has(id));
    const takeFields = new Map(take.fields);
    takeFields.set(
      "state",
      totals.chunks === 0n ? "failed" : completed && allTracksRecovered ? "completed" : "partial",
    );
    takeFields.set("duration_us", totals.durationUs.toString());
    takeFields.set("ended_at_us", changedAt);
    takeFields.set("updated_at_us", changedAt);
    records.set(recordKey(take), { ...take, fields: takeFields });
  }

  const message = completed
    ? `Verified and recovered all ${outcomes.length} native audio track${outcomes.length === 1 ? "" : "s"}.`
    : totals.chunks > 0n
      ? `Preserved ${totals.chunks.toLocaleString()} verified native audio chunks; one or more tracks remain partial or interrupted.`
      : "No valid committed native audio was available; the recording remains failed.";

  return {
    records: [...records.values()],
    tracks: outcomes.map((outcome) => outcome.report),
    completed,
    sampleCount: totals.samples.toString(),
    chunkCount: totals.chunks.toString(),
    durationUs: totals.durationUs.toString(),
    byteCount: totals.bytes.toString(),
    message: `${message}${errors.length ? ` ${errors.join(" ")}` : ""}`,
  };
}

async function nativeTrackIds(
  snapshot: ArchiveSnapshot,
  session: ArchiveRecord,
): Promise<string[]> {
  const encoded = session.fields.get("recording_track_ids") ?? "";
  const ids: string[] = [];
  if (encoded) {
    for (const item of encoded.split(",")) {
      const id = validUuid(item.trim());
      if (!id) {
        throw new ArchiveFormatError(
          "audio_track_metadata_invalid",
          "Session contains an invalid recording track ID.",
        );
      }
      if (!ids.includes(id)) ids.push(id);
    }
  }
  if (ids.length === 0) {
    const primary = validUuid(session.fields.get("recording_track_id"));
    if (primary) ids.push(primary);
  }
  if (ids.length === 0) {
    const assetMetadata = await snapshot.listRecordMetadata(RecordType.assetMetadata);
    for (const record of assetMetadata) {
      if (
        record.fields.get("record_role") === "audio-track" &&
        record.fields.get("session_id")?.toLowerCase() === session.id.toLowerCase() &&
        record.fields.get("_deleted") !== "true" &&
        UUID_PATTERN.test(record.id.toLowerCase()) &&
        !ids.includes(record.id.toLowerCase())
      ) {
        ids.push(record.id.toLowerCase());
      }
    }
  }
  return ids;
}

async function recoverTrack(
  snapshot: ArchiveSnapshot,
  session: ArchiveRecord,
  trackId: string,
  format: { sampleFormat: string; sampleRate: bigint; channels: bigint; channelMask: bigint },
  previousState: string,
  metadata?: ArchiveRecord,
): Promise<TrackResult> {
  const source = sourceName(metadata?.fields.get("source"));
  const deviceId = value(metadata ?? session, metadata ? "device_id" : "recording_device_id");
  const bytesPerSample = BYTES_PER_SAMPLE[format.sampleFormat];
  if (!bytesPerSample)
    return failedTrack(
      trackId,
      source,
      new Error("Recording sample format is unsupported."),
      metadata,
    );
  const blockAlign = bytesPerSample * format.channels;
  const sampleRate = Number(format.sampleRate);
  const maximumTimelineSample =
    (U64_MAX / 1_000_000n) * format.sampleRate +
    ((U64_MAX % 1_000_000n) * format.sampleRate) / 1_000_000n;
  const totals = { samples: 0n, timeline: 0n, chunks: 0n, bytes: 0n, discontinuities: 0n };
  let failure = "";
  let indexed: ArchiveRecord[];
  try {
    indexed = await snapshot.listAudioChunkMetadata(session.id, trackId);
  } catch (error) {
    return failedTrack(trackId, source, error, metadata, deviceId);
  }

  for (const item of indexed) {
    let chunk: ArchiveRecord | null;
    try {
      chunk = await snapshot.getRecord(RecordType.audioChunk, item.id);
    } catch (error) {
      return failedTrack(trackId, source, error, metadata, deviceId);
    }
    if (!chunk) {
      failure = "A committed native audio chunk is missing or corrupt.";
      break;
    }
    const sequence = unsignedField(chunk.fields.get("sequence_number"));
    const firstSample = unsignedField(chunk.fields.get("first_sample_index"));
    const frameCount = unsignedField(chunk.fields.get("sample_count"));
    const gapBefore = unsignedField(chunk.fields.get("gap_before_samples") ?? "0");
    const startUs = unsignedField(chunk.fields.get("timeline_start_us"));
    const endUs = unsignedField(chunk.fields.get("timeline_end_us"));
    const checksum = unsignedField(chunk.fields.get("payload_checksum"));
    const channelMask = chunk.fields.get("channel_mask");
    if (
      sequence !== totals.chunks ||
      firstSample === undefined ||
      frameCount === undefined ||
      frameCount === 0n ||
      gapBefore === undefined ||
      startUs === undefined ||
      endUs === undefined ||
      checksum === undefined ||
      channelMask !== format.channelMask.toString() ||
      chunk.fields.get("session_id")?.toLowerCase() !== session.id.toLowerCase() ||
      chunk.fields.get("track_id")?.toLowerCase() !== trackId ||
      firstSample < totals.timeline ||
      firstSample - totals.timeline !== gapBefore ||
      firstSample > U64_MAX - frameCount ||
      firstSample + frameCount > maximumTimelineSample ||
      frameCount > U64_MAX / blockAlign ||
      chunk.fields.get("sample_format") !== format.sampleFormat ||
      chunk.fields.get("codec") !== "none" ||
      chunk.fields.get("sample_rate_hz") !== format.sampleRate.toString() ||
      chunk.fields.get("channel_count") !== format.channels.toString() ||
      frameCount * blockAlign !== BigInt(chunk.blob.byteLength) ||
      checksum > U32_MAX ||
      crc32(chunk.blob) !== Number(checksum) ||
      startUs !== samplesToMicroseconds(firstSample, sampleRate) ||
      endUs !== samplesToMicroseconds(firstSample + frameCount, sampleRate) ||
      totals.samples > U64_MAX - frameCount ||
      totals.bytes > U64_MAX - BigInt(chunk.blob.byteLength)
    ) {
      failure = "A committed native audio chunk is missing, malformed, or corrupt.";
      break;
    }
    const discontinuity = chunk.fields.get("contains_device_discontinuity") ?? "false";
    if (discontinuity !== "true" && discontinuity !== "false") {
      failure = "A committed native audio chunk has invalid discontinuity metadata.";
      break;
    }
    totals.samples += frameCount;
    totals.bytes += BigInt(chunk.blob.byteLength);
    totals.chunks += 1n;
    totals.timeline = firstSample + frameCount;
    if (discontinuity === "true" || gapBefore > 0n) totals.discontinuities += 1n;
  }

  const countField = metadata
    ? metadata.fields.get("chunk_count")
    : session.fields.get("recording_audio_chunks");
  if (countField !== undefined) {
    const expectedCount = unsignedField(countField);
    if (expectedCount === undefined && !failure) {
      failure = "Saved native audio chunk count is invalid.";
    } else if (
      expectedCount !== undefined &&
      expectedCount !== totals.chunks &&
      !failure &&
      (!metadata || previousState === "completed")
    ) {
      failure = "The saved recording count does not match its committed chunks.";
    }
  }

  const durationUs = samplesToMicroseconds(totals.timeline, sampleRate);
  const completed = !failure && previousState === "completed";
  if (!completed && !failure) {
    failure =
      totals.chunks === 0n
        ? "No committed native audio chunk was available for recovery."
        : "Committed audio was verified; the capture did not reach completion.";
  }
  const state = completed ? "completed" : totals.chunks === 0n ? "failed" : "interrupted";
  const report: NativeCaptureTrackRecovery = {
    trackId,
    source,
    deviceId,
    state,
    sampleCount: totals.samples.toString(),
    timelineSamples: totals.timeline.toString(),
    chunkCount: totals.chunks.toString(),
    discontinuities: totals.discontinuities.toString(),
    durationUs: durationUs.toString(),
    byteCount: totals.bytes.toString(),
    errorCode: "",
    errorMessage: failure,
  };
  return { report, ...(metadata ? { metadata } : {}), recovered: true };
}

function readFormat(
  record: ArchiveRecord,
  trackMetadata: boolean,
): { sampleFormat: string; sampleRate: bigint; channels: bigint; channelMask: bigint } | string {
  const sampleRate = unsignedField(
    record.fields.get(trackMetadata ? "sample_rate_hz" : "recording_sample_rate_hz"),
  );
  const channels = unsignedField(
    record.fields.get(trackMetadata ? "channel_count" : "recording_channel_count"),
  );
  const channelMask = unsignedField(
    record.fields.get(trackMetadata ? "channel_mask" : "recording_channel_mask"),
  );
  if (
    sampleRate === undefined ||
    channels === undefined ||
    channelMask === undefined ||
    sampleRate < 8_000n ||
    sampleRate > 384_000n ||
    channels === 0n ||
    channels > 8n ||
    channelMask > U32_MAX
  ) {
    return "Recording format metadata is invalid.";
  }
  const sampleFormat = value(record, trackMetadata ? "sample_format" : "recording_sample_format");
  if (!BYTES_PER_SAMPLE[sampleFormat]) return "Recording sample format is unsupported.";
  return { sampleFormat, sampleRate, channels, channelMask };
}

function failedTrack(
  trackId: string,
  source: string,
  cause: unknown,
  metadata?: ArchiveRecord,
  deviceId = "",
): TrackResult {
  const errorMessage = cause instanceof Error ? cause.message : String(cause);
  return {
    ...(metadata ? { metadata } : {}),
    recovered: false,
    report: {
      trackId,
      source,
      deviceId,
      state: "failed",
      sampleCount: "0",
      timelineSamples: "0",
      chunkCount: "0",
      discontinuities: "0",
      durationUs: "0",
      byteCount: "0",
      errorCode: cause instanceof ArchiveFormatError ? cause.code : "audio_recovery_failed",
      errorMessage,
    },
  };
}

function sourceName(source: string | undefined): string {
  if (source === "microphone" || source === "application-audio" || source === "system-audio")
    return source;
  return "system-audio";
}

function validUuid(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && UUID_PATTERN.test(normalized) ? normalized : undefined;
}

function unsignedField(value: string | undefined): bigint | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
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

function saturatedAdd(left: bigint, right: bigint): bigint {
  return right > U64_MAX - left ? U64_MAX : left + right;
}

function recordKey(record: ArchiveRecord): string {
  return `${record.type}:${record.id.toLowerCase()}`;
}

function splitIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
}

function value(record: ArchiveRecord, key: string): string {
  return record.fields.get(key) ?? "";
}

function nowUs(): string {
  return (BigInt(Date.now()) * 1_000n).toString();
}
