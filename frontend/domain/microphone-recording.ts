import { crc32, newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import { makeWaveImportRecords, type WaveImportResult } from "./wav";

const MAX_PCM_BYTES = 128 * 1024 * 1024;
export const MAX_MICROPHONE_ARCHIVE_CHUNK_BYTES = 1024 * 1024;

export interface MicrophoneCaptureIdentity {
  trackId: string;
  takeId: string;
  startedAtUs: string;
  consentAtUs: string;
  sampleRateHz: number;
  captureSourceBackend?: string;
  consentConfirmedBy?: string;
}

export type CaptureSampleFormat =
  | "pcm_u8"
  | "pcm_s16le"
  | "pcm_s24le"
  | "pcm_s32le"
  | "pcm_f32le";

export interface MicrophoneCaptureChunk {
  sequence: number;
  firstSampleIndex: string;
  samples: Uint8Array<ArrayBuffer>;
  sampleFormat?: CaptureSampleFormat;
  channelCount?: number;
  gapBeforeSamples?: string;
  containsDeviceDiscontinuity?: boolean;
}

function captureBytesPerSample(format: CaptureSampleFormat): number {
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
  }
}

export type MicrophoneArchiveSource = "microphone" | "system-audio" | "application-audio";

/** Allocate stable archive IDs and create discoverable in-progress capture metadata. */
export function makeMicrophoneCaptureStartRecords(
  session: ArchiveRecord,
  identity: MicrophoneCaptureIdentity,
  knownTrackIds: readonly string[],
): ArchiveRecord[] {
  assertCaptureSession(session, identity.sampleRateHz);
  assertUuid(identity.trackId, "track");
  assertUuid(identity.takeId, "take");
  const timestamp = identity.startedAtUs;
  const captureSourceBackend = identity.captureSourceBackend ?? "web-audio";
  const consentConfirmedBy = identity.consentConfirmedBy ?? "";
  const linkedTrackIds = mergedTrackIds(session, knownTrackIds);
  if (!linkedTrackIds.includes(identity.trackId.toLowerCase()))
    linkedTrackIds.push(identity.trackId.toLowerCase());

  const track = makeRecord(
    RecordType.assetMetadata,
    identity.trackId,
    new Map([
      ["record_role", "audio-track"],
      ["session_id", session.id.toLowerCase()],
      ["track_id", identity.trackId.toLowerCase()],
      ["recording_take_id", identity.takeId.toLowerCase()],
      ["label", "Microphone recording"],
      ["source", "microphone"],
      ["capture_source_backend", captureSourceBackend],
      ["capture_consent_at_us", identity.consentAtUs],
      ["capture_consent_policy", "1"],
      ["consent_confirmed_by", consentConfirmedBy],
      ["state", "recording"],
      ["sample_format", "pcm_s16le"],
      ["sample_rate_hz", String(identity.sampleRateHz)],
      ["channel_count", "1"],
      ["channel_mask", "0"],
      ["sample_count", "0"],
      ["timeline_sample_count", "0"],
      ["duration_us", "0"],
      ["chunk_count", "0"],
      ["byte_count", "0"],
      ["started_at_us", timestamp],
      ["updated_at_us", timestamp],
    ]),
  );
  const take = makeRecord(
    RecordType.assetMetadata,
    identity.takeId,
    new Map([
      ["record_role", "recording-take"],
      ["session_id", session.id.toLowerCase()],
      ["label", "Microphone recording"],
      ["source", "microphone"],
      ["capture_source_backend", captureSourceBackend],
      ["capture_consent_at_us", identity.consentAtUs],
      ["capture_consent_policy", "1"],
      ["consent_confirmed_by", consentConfirmedBy],
      ["state", "recording"],
      ["track_ids", identity.trackId.toLowerCase()],
      ["started_at_us", timestamp],
      ["ended_at_us", ""],
      ["duration_us", "0"],
      ["created_at_us", timestamp],
      ["updated_at_us", timestamp],
    ]),
  );
  const fields = new Map(session.fields);
  fields.set("recording_track_ids", linkedTrackIds.join(","));
  fields.set("recording_track_count", String(linkedTrackIds.length));
  if (!fields.get("recording_track_id")) fields.set("recording_track_id", identity.trackId);
  fields.set("recording_source", "microphone");
  fields.set("recording_source_backend", captureSourceBackend);
  fields.set("recording_sample_format", "pcm_s16le");
  fields.set("recording_sample_rate_hz", String(identity.sampleRateHz));
  fields.set("recording_channel_count", "1");
  fields.set("recording_channel_mask", "0");
  fields.set("recording_started_at_us", timestamp);
  fields.set("recording_consent_at_us", identity.consentAtUs);
  fields.set("recording_consent_policy", "1");
  fields.set("recording_consent_confirmed_by", consentConfirmedBy);
  if (!fields.has("recording_audio_chunks")) fields.set("recording_audio_chunks", "0");
  if (!fields.has("recording_samples")) fields.set("recording_samples", "0");
  if (!fields.has("recording_timeline_samples")) fields.set("recording_timeline_samples", "0");
  if (!fields.has("recording_bytes")) fields.set("recording_bytes", "0");
  fields.set("recording_state", "recording");
  fields.set("recording_error", "");
  fields.set("updated_at_us", timestamp);
  return [track, take, { ...session, fields }];
}

/** Append one aligned, checksummed PCM block and keep recovery metadata current. */
export function makeMicrophoneCaptureChunkRecords(options: {
  session: ArchiveRecord;
  track: ArchiveRecord;
  chunk: MicrophoneCaptureChunk;
  sampleRateHz: number;
  source?: MicrophoneArchiveSource;
}): ArchiveRecord[] {
  const { session, track, chunk, sampleRateHz } = options;
  const source = options.source ?? "microphone";
  const sampleFormat = chunk.sampleFormat ?? "pcm_s16le";
  const channelCount = chunk.channelCount ?? 1;
  assertCaptureSession(session, sampleRateHz, true);
  if (
    track.type !== RecordType.assetMetadata ||
    track.fields.get("record_role") !== "audio-track" ||
    track.fields.get("session_id")?.toLowerCase() !== session.id.toLowerCase() ||
    track.fields.get("source") !== source ||
    track.fields.get("sample_rate_hz") !== String(sampleRateHz) ||
    track.fields.get("state") !== "recording"
  ) {
    throw new Error("The microphone recovery track is no longer active.");
  }
  if (
    (track.fields.get("sample_format") ?? "pcm_s16le") !== sampleFormat ||
    Number(track.fields.get("channel_count") ?? 1) !== channelCount
  ) {
    throw new Error("The audio source changed format while recording.");
  }
  const bytesPerFrame = captureBytesPerSample(sampleFormat) * channelCount;
  if (
    !Number.isSafeInteger(chunk.sequence) ||
    chunk.sequence < 0 ||
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > 8 ||
    chunk.samples.byteLength === 0 ||
    chunk.samples.byteLength > MAX_MICROPHONE_ARCHIVE_CHUNK_BYTES ||
    chunk.samples.byteLength % bytesPerFrame !== 0
  ) {
    throw new Error("A microphone archive chunk must contain aligned PCM below 1 MiB.");
  }

  const expectedSequence = parseCounter(track.fields.get("chunk_count"));
  const sampleCount = parseCounter(track.fields.get("sample_count"));
  const timelineSamples = parseCounter(track.fields.get("timeline_sample_count"));
  const byteCount = parseCounter(track.fields.get("byte_count"));
  if (
    expectedSequence !== BigInt(chunk.sequence) ||
    sampleCount === undefined ||
    timelineSamples === undefined ||
    byteCount === undefined ||
    !/^\d+$/u.test(chunk.firstSampleIndex) ||
    !/^\d+$/u.test(chunk.gapBeforeSamples ?? "0") ||
    BigInt(chunk.firstSampleIndex) < timelineSamples ||
    BigInt(chunk.firstSampleIndex) !== timelineSamples + BigInt(chunk.gapBeforeSamples ?? "0")
  ) {
    throw new Error("Microphone recovery chunks must be committed once in sequence.");
  }
  const firstSampleIndex = BigInt(chunk.firstSampleIndex);
  const frames = BigInt(chunk.samples.byteLength / bytesPerFrame);
  const nextSamples = sampleCount + frames;
  const nextTimeline = firstSampleIndex + frames;
  const nextBytes = byteCount + BigInt(chunk.samples.byteLength);
  const nextSequence = BigInt(chunk.sequence + 1);
  const startedAtUs = track.fields.get("started_at_us") ?? "";
  const timestamp = nowUs();
  const trackFields = new Map(track.fields);
  trackFields.set("sample_format", sampleFormat);
  trackFields.set("channel_count", String(channelCount));
  trackFields.set("chunk_count", nextSequence.toString());
  trackFields.set("sample_count", nextSamples.toString());
  trackFields.set("timeline_sample_count", nextTimeline.toString());
  trackFields.set("byte_count", nextBytes.toString());
  trackFields.set("duration_us", samplesToMicroseconds(nextTimeline, sampleRateHz).toString());
  trackFields.set("updated_at_us", timestamp);

  const chunkRecord = makeRecord(
    RecordType.audioChunk,
    newUuid(),
    new Map([
      ["session_id", session.id.toLowerCase()],
      ["track_id", track.id.toLowerCase()],
      ["sequence_number", String(chunk.sequence)],
      ["first_sample_index", chunk.firstSampleIndex],
      ["sample_count", frames.toString()],
      ["gap_before_samples", chunk.gapBeforeSamples ?? "0"],
      ["timeline_start_us", samplesToMicroseconds(firstSampleIndex, sampleRateHz).toString()],
      ["timeline_end_us", samplesToMicroseconds(nextTimeline, sampleRateHz).toString()],
      ["sample_format", sampleFormat],
      ["sample_rate_hz", String(sampleRateHz)],
      ["channel_count", String(channelCount)],
      ["channel_mask", track.fields.get("channel_mask") ?? "0"],
      ["codec", "none"],
      ["source", source],
      ["contains_device_discontinuity", String(chunk.containsDeviceDiscontinuity ?? false)],
      ["payload_checksum", String(crc32(chunk.samples))],
    ]),
    chunk.samples,
  );
  const sessionFields = new Map(session.fields);
  sessionFields.set(
    "recording_audio_chunks",
    ((parseCounter(session.fields.get("recording_audio_chunks")) ?? 0n) + 1n).toString(),
  );
  sessionFields.set(
    "recording_samples",
    ((parseCounter(session.fields.get("recording_samples")) ?? 0n) + frames).toString(),
  );
  const priorTimeline = parseCounter(session.fields.get("recording_timeline_samples")) ?? 0n;
  const timelineRate =
    parseCounter(session.fields.get("recording_sample_rate_hz")) ?? BigInt(sampleRateHz);
  const nextTimelineDurationUs = samplesToMicroseconds(nextTimeline, sampleRateHz);
  const nextSessionTimeline = (nextTimelineDurationUs * timelineRate) / 1_000_000n;
  sessionFields.set(
    "recording_timeline_samples",
    (priorTimeline > nextSessionTimeline ? priorTimeline : nextSessionTimeline).toString(),
  );
  const previousDuration = parseCounter(session.fields.get("recording_duration_us")) ?? 0n;
  sessionFields.set(
    "recording_duration_us",
    (previousDuration > nextTimelineDurationUs
      ? previousDuration
      : nextTimelineDurationUs
    ).toString(),
  );
  sessionFields.set(
    "recording_bytes",
    (
      (parseCounter(session.fields.get("recording_bytes")) ?? 0n) + BigInt(chunk.samples.byteLength)
    ).toString(),
  );
  sessionFields.set("recording_started_at_us", startedAtUs);
  sessionFields.set("recording_state", "recording");
  sessionFields.set("recording_error", "");
  sessionFields.set("updated_at_us", timestamp);
  return [chunkRecord, { ...track, fields: trackFields }, { ...session, fields: sessionFields }];
}

/** Mark a take complete after the last archive chunk has been committed. */
export function makeMicrophoneCaptureFinishRecords(options: {
  session: ArchiveRecord;
  track: ArchiveRecord;
  take: ArchiveRecord;
  pauseCount: number;
  pausedDurationUs: string;
  interruptedReason?: string;
}): ArchiveRecord[] {
  const { session, track, take } = options;
  const interrupted = Boolean(options.interruptedReason);
  const timestamp = nowUs();
  const trackFields = new Map(track.fields);
  trackFields.set("state", interrupted ? "interrupted" : "completed");
  trackFields.set(
    "capture_pause_count",
    addCounter(track.fields.get("capture_pause_count"), options.pauseCount),
  );
  trackFields.set(
    "capture_paused_duration_us",
    addCounter(track.fields.get("capture_paused_duration_us"), options.pausedDurationUs),
  );
  trackFields.set("ended_at_us", timestamp);
  trackFields.set("recovery_error", options.interruptedReason ?? "");
  trackFields.set("updated_at_us", timestamp);
  const takeFields = new Map(take.fields);
  takeFields.set("state", interrupted ? "partial" : "completed");
  takeFields.set(
    "capture_pause_count",
    addCounter(take.fields.get("capture_pause_count"), options.pauseCount),
  );
  takeFields.set(
    "capture_paused_duration_us",
    addCounter(take.fields.get("capture_paused_duration_us"), options.pausedDurationUs),
  );
  takeFields.set("ended_at_us", timestamp);
  takeFields.set("duration_us", trackFields.get("duration_us") ?? "0");
  takeFields.set("updated_at_us", timestamp);
  const sessionFields = new Map(session.fields);
  sessionFields.set("recording_state", interrupted ? "interrupted" : "completed");
  sessionFields.set("recording_ended_at_us", timestamp);
  sessionFields.set("recording_error", options.interruptedReason ?? "");
  sessionFields.set("recording_capture_pause_count", String(options.pauseCount));
  sessionFields.set("recording_capture_paused_duration_us", options.pausedDurationUs);
  sessionFields.set("updated_at_us", timestamp);
  return [
    { ...track, fields: trackFields },
    { ...take, fields: takeFields },
    { ...session, fields: sessionFields },
  ];
}

/** Keep the persisted take status aligned with a muted or resumed capture. */
export function makeMicrophoneCaptureStateRecords(
  session: ArchiveRecord,
  track: ArchiveRecord,
  take: ArchiveRecord,
  state: "recording" | "paused",
): ArchiveRecord[] {
  const timestamp = nowUs();
  const sessionFields = new Map(session.fields);
  sessionFields.set("recording_state", state);
  sessionFields.set("updated_at_us", timestamp);
  const trackFields = new Map(track.fields);
  trackFields.set("state", state);
  trackFields.set("updated_at_us", timestamp);
  const takeFields = new Map(take.fields);
  takeFields.set("state", state);
  takeFields.set("updated_at_us", timestamp);
  return [
    { ...track, fields: trackFields },
    { ...take, fields: takeFields },
    { ...session, fields: sessionFields },
  ];
}

/** Convert a consented microphone recording into the archive's normal take and PCM chunks. */
export async function makeMicrophoneRecordingRecords(options: {
  session: ArchiveRecord;
  file: File;
  knownTrackIds: readonly string[];
  startedAtUs: string;
  consentAtUs: string;
  pauseCount: number;
  pausedDurationUs: string;
  source?: MicrophoneArchiveSource;
  captureSourceBackend?: string;
  consentConfirmedBy?: string;
}): Promise<WaveImportResult> {
  const source = options.source ?? "microphone";
  const captureSourceBackend = options.captureSourceBackend ?? "web-audio";
  const result = await makeWaveImportRecords(
    options.session,
    options.file,
    true,
    options.knownTrackIds,
  );
  const endedAtUs = (BigInt(Date.now()) * 1000n).toString();
  const records = result.records.map((record) => {
    if (record.type === RecordType.audioChunk) {
      const fields = new Map(record.fields);
      fields.delete("source_filename");
      return { ...record, fields };
    }
    if (
      record.type === RecordType.assetMetadata &&
      (record.id === result.trackId || record.id === result.takeId)
    ) {
      const fields = new Map(record.fields);
      fields.set("source", source);
      fields.set("capture_source_backend", captureSourceBackend);
      fields.set("capture_consent_at_us", options.consentAtUs);
      fields.set("capture_consent_policy", "1");
      fields.set("consent_confirmed_by", options.consentConfirmedBy ?? "");
      fields.set("capture_pause_count", String(options.pauseCount));
      fields.set("capture_paused_duration_us", options.pausedDurationUs);
      fields.delete("source_filename");
      if (record.id === result.takeId) {
        fields.set("started_at_us", options.startedAtUs);
        fields.set("ended_at_us", endedAtUs);
      }
      return { ...record, fields };
    }
    if (record.type === RecordType.session && record.id === options.session.id) {
      const fields = new Map(record.fields);
      for (const key of [...fields.keys()]) {
        if (
          key.startsWith("audio_import_") ||
          key === "audio_chunks_imported" ||
          key === "audio_samples_imported"
        ) {
          const original = options.session.fields.get(key);
          if (original === undefined) fields.delete(key);
          else fields.set(key, original);
        }
      }
      if (fields.get("recording_track_id") === result.trackId) {
        fields.set("recording_source", source);
        fields.set("recording_source_backend", captureSourceBackend);
        fields.set("recording_started_at_us", options.startedAtUs);
      }
      fields.set("recording_ended_at_us", endedAtUs);
      fields.set("capture_consent_at_us", options.consentAtUs);
      fields.set("capture_consent_policy", "1");
      fields.set("recording_consent_confirmed_by", options.consentConfirmedBy ?? "");
      return { ...record, fields };
    }
    return record;
  });
  return { ...result, records };
}

function assertCaptureSession(
  session: ArchiveRecord,
  sampleRateHz: number,
  allowInProgress = false,
): void {
  if (session.type !== RecordType.session || session.fields.get("_deleted") === "true")
    throw new Error("Choose an active tutoring session before recording audio.");
  if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 384_000)
    throw new Error("The microphone returned an unsupported sample rate.");
  if (
    !allowInProgress &&
    ["initializing", "recording", "paused", "finalizing"].includes(
      session.fields.get("recording_state") ?? "",
    )
  )
    throw new Error("Stop or recover the active recording before starting another take.");
}

function mergedTrackIds(session: ArchiveRecord, knownTrackIds: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const value of [
    session.fields.get("recording_track_ids"),
    session.fields.get("recording_track_id"),
    session.fields.get("audio_import_track_id"),
  ]) {
    for (const id of (value ?? "").split(",")) {
      const normalized = id.trim().toLowerCase();
      if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(normalized))
        ids.add(normalized);
    }
  }
  for (const value of knownTrackIds) {
    const normalized = value.toLowerCase();
    if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(normalized))
      ids.add(normalized);
  }
  return [...ids];
}

function assertUuid(value: string, label: string): void {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value))
    throw new Error(`The microphone ${label} ID is invalid.`);
}

function makeRecord(
  type: number,
  id: string,
  fields: ReadonlyMap<string, string>,
  blob = new Uint8Array(),
): ArchiveRecord {
  return { type, id: id.toLowerCase(), revision: 0n, previousOffset: 0n, fields, blob };
}

function parseCounter(value: string | undefined): bigint | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  try {
    const result = BigInt(value);
    return result <= 18_446_744_073_709_551_615n ? result : undefined;
  } catch {
    return undefined;
  }
}

function addCounter(previous: string | undefined, next: number | string): string {
  const left = previous === undefined || previous === "" ? 0n : parseCounter(previous);
  const right = parseCounter(String(next));
  if (left === undefined || right === undefined || left + right > 18_446_744_073_709_551_615n) {
    throw new Error("Microphone capture totals exceed the supported archive range.");
  }
  return (left + right).toString();
}

function samplesToMicroseconds(samples: bigint, sampleRateHz: number): bigint {
  const rate = BigInt(sampleRateHz);
  return (samples / rate) * 1_000_000n + ((samples % rate) * 1_000_000n) / rate;
}

function nowUs(): string {
  return (BigInt(Date.now()) * 1_000n).toString();
}

/** Capture microphone PCM through Web Audio with a bounded in-memory buffer. */
export class MicrophoneRecording {
  private buffers: Uint8Array<ArrayBuffer>[] = [];
  private totalBytes = 0;
  private finished = false;
  private paused = false;
  private pauseStartedMs = 0;
  private pausedMs = 0;
  private pauseCount = 0;

  private constructor(
    private readonly context: AudioContext,
    private readonly stream: MediaStream,
    private readonly input: MediaStreamAudioSourceNode,
    private readonly processor: ScriptProcessorNode,
    private readonly silentOutput: GainNode,
    private readonly onLimit: () => void,
  ) {
    processor.onaudioprocess = (event) => {
      if (this.finished || this.paused) return;
      const samples = event.inputBuffer.getChannelData(0);
      const count = Math.min(samples.length, Math.floor((MAX_PCM_BYTES - this.totalBytes) / 2));
      if (count > 0) {
        const bytes = new Uint8Array(count * 2);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < count; index++) {
          const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
          view.setInt16(index * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
        }
        this.buffers.push(bytes);
        this.totalBytes += bytes.length;
      }
      if (this.totalBytes >= MAX_PCM_BYTES) this.onLimit();
    };
    input.connect(processor);
    processor.connect(silentOutput);
    silentOutput.gain.value = 0;
    silentOutput.connect(context.destination);
  }

  static async start(
    onLimit: () => void,
    onDeviceEnded: () => void,
    deviceId?: string,
  ): Promise<MicrophoneRecording> {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      throw new Error("Microphone recording is unavailable in this window.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      await context.resume();
      for (const track of stream.getAudioTracks())
        track.addEventListener("ended", onDeviceEnded, { once: true });
      return new MicrophoneRecording(
        context,
        stream,
        context.createMediaStreamSource(stream),
        context.createScriptProcessor(4096, 1, 1),
        context.createGain(),
        onLimit,
      );
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      await context?.close().catch(() => undefined);
      throw error;
    }
  }

  async pause(): Promise<void> {
    if (this.finished || this.paused) throw new Error("Recording cannot be paused now.");
    this.paused = true;
    this.pauseStartedMs = performance.now();
    this.pauseCount++;
    for (const track of this.stream.getAudioTracks()) track.enabled = false;
    try {
      await this.context.suspend();
    } catch (error) {
      if (!this.finished) {
        this.paused = false;
        this.pauseCount--;
        for (const track of this.stream.getAudioTracks()) track.enabled = true;
      }
      throw error;
    }
  }

  async resume(): Promise<void> {
    if (this.finished || !this.paused) throw new Error("Recording cannot be resumed now.");
    await this.context.resume();
    if (this.finished) return;
    this.pausedMs += performance.now() - this.pauseStartedMs;
    for (const track of this.stream.getAudioTracks()) track.enabled = true;
    this.paused = false;
  }

  async stop(): Promise<{ file: File; pauseCount: number; pausedDurationUs: string }> {
    if (this.finished) throw new Error("This recording has already stopped.");
    this.finished = true;
    if (this.paused) this.pausedMs += performance.now() - this.pauseStartedMs;
    this.processor.onaudioprocess = null;
    this.input.disconnect();
    this.processor.disconnect();
    this.silentOutput.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    await this.context.close();
    if (!this.totalBytes) throw new Error("The microphone did not provide any audio.");
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    const text = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) header[offset + i] = value.charCodeAt(i);
    };
    text(0, "RIFF");
    view.setUint32(4, this.totalBytes + 36, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, this.context.sampleRate, true);
    view.setUint32(28, this.context.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, this.totalBytes, true);
    const file = new File(
      [header, ...this.buffers],
      `Microphone ${new Date().toISOString().replace(/[:.]/g, "-")}.wav`,
      { type: "audio/wav" },
    );
    this.buffers = [];
    return {
      file,
      pauseCount: this.pauseCount,
      pausedDurationUs: String(Math.round(this.pausedMs * 1000)),
    };
  }

  async discard(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.processor.onaudioprocess = null;
    this.input.disconnect();
    this.processor.disconnect();
    this.silentOutput.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    this.buffers = [];
    await this.context.close().catch(() => undefined);
  }
}
