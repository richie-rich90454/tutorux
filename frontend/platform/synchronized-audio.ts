import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SynchronizedAudioTrack = "microphone" | "system-audio" | "application-audio";

const CHUNK_EVENT = "synchronized-audio-chunk";
const FAILURE_EVENT = "synchronized-audio-source-failed";
const PAUSE_DRAINED_EVENT = "synchronized-audio-pause-drained";
const ARCHIVE_BATCH_BYTES = 256 * 1024;
const MAX_PENDING_BYTES_PER_TRACK = 2 * 1024 * 1024;
const MAX_NATIVE_EVENT_BYTES = 512 * 1024;

export interface NativeSynchronizedAudioDevice {
  deviceId: string;
  label: string;
  backend: string;
  source: string;
  isDefault: boolean;
  processId?: number | null;
  applicationName?: string | null;
  bundleId?: string | null;
}

export interface NativeSynchronizedAudioDevices {
  microphones: NativeSynchronizedAudioDevice[];
  systemAudio: NativeSynchronizedAudioDevice[];
  applicationAudio: NativeSynchronizedAudioDevice[];
  microphoneAvailable: boolean;
  systemAudioAvailable: boolean;
  applicationAudioAvailable: boolean;
  systemAudioUnavailableReason?: string | null;
  applicationAudioUnavailableReason?: string | null;
}

export interface MicrophonePreflightLevel {
  probeId: string;
  elapsedMs: number;
  framesInInterval: number;
  framesMeasured: number;
  peakLevel: number;
  rmsLevel: number;
  peakDbfs: number;
  rmsDbfs: number;
}

export interface MicrophonePreflightSummary {
  deviceId: string;
  measuredDurationMs: number;
  framesMeasured: number;
  peakLevel: number;
  rmsLevel: number;
  peakDbfs: number;
  rmsDbfs: number;
  signalDetected: boolean;
}

export interface NativeSynchronizedAudioStarted {
  captureId: string;
  startedAtUs: string;
  consentAtUs: string;
  microphoneSampleRateHz: number;
  systemAudioSampleRateHz: number;
  applicationAudioSampleRateHz: number;
  microphoneChannelCount?: number;
  microphoneSampleFormat?: string;
  systemAudioChannelCount?: number;
  systemAudioSampleFormat?: string;
  applicationAudioChannelCount?: number;
  applicationAudioSampleFormat?: string;
  applicationAudioDeviceId?: string | null;
  applicationAudioName?: string | null;
  applicationAudioProcessId?: number | null;
  applicationAudioBundleId?: string | null;
  applicationAudioBackend?: string | null;
  backend: string;
}

export type NativeAudioSampleFormat =
  | "pcm_u8"
  | "pcm_s16le"
  | "pcm_s24le"
  | "pcm_s32le"
  | "pcm_f32le";

export interface NativeSynchronizedAudioArchiveChunk {
  sequence: number;
  firstSampleIndex: string;
  samples: Uint8Array<ArrayBuffer>;
  sampleFormat: NativeAudioSampleFormat;
  channelCount: number;
  gapBeforeSamples: string;
  containsDeviceDiscontinuity: boolean;
}

export interface NativeSynchronizedAudioArchiveHooks {
  /** Commit the take and source-track metadata before native capture accepts samples. */
  onStarted(started: NativeSynchronizedAudioStarted): Promise<void>;
  /** Resolve only after this batch has been appended as a durable archive generation. */
  onChunk(track: SynchronizedAudioTrack, chunk: NativeSynchronizedAudioArchiveChunk): Promise<void>;
  onPaused(pause: { pauseCount: number; pausedDurationUs: string }): Promise<void>;
  onResumed(pause: { pauseCount: number; pausedDurationUs: string }): Promise<void>;
  onFinished(result: {
    pauseCount: number;
    pausedDurationUs: string;
    failures: Partial<Record<SynchronizedAudioTrack, string>>;
  }): Promise<void>;
}

export interface ActiveNativeSynchronizedAudioCapture {
  readonly started: NativeSynchronizedAudioStarted;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<{
    archiveCommitted: true;
    pauseCount: number;
    pausedDurationUs: string;
    warnings: string[];
  }>;
  discard(): Promise<void>;
}

interface NativeChunkEvent {
  captureId: string;
  track: string;
  sequence: number;
  firstSampleIndex: string;
  sampleRateHz: number;
  frameCount?: string;
  channelCount?: number;
  sampleFormat?: string;
  gapBeforeSamples?: string;
  containsDeviceDiscontinuity?: boolean;
  pcmBase64?: string;
  pcmS16leBase64?: string;
}

interface NativeFailureEvent {
  captureId: string;
  track: string;
  message: string;
}

interface NativePauseDrainedEvent {
  captureId: string;
  pauseId: number;
}

interface NativeFinishedTrack {
  sampleRateHz: number;
  sampleCount: string;
  byteCount: string;
  chunkCount: number;
  channelCount?: number;
  sampleFormat?: string;
  discontinuityCount?: number;
  failure?: string | null;
}

interface NativeFinished {
  microphone: NativeFinishedTrack;
  systemAudio: NativeFinishedTrack;
  applicationAudio: NativeFinishedTrack;
}

interface TrackQueue {
  sampleRateHz: number;
  sampleFormat: NativeAudioSampleFormat;
  channelCount: number;
  frameBytes: number;
  expectedNativeSequence: number;
  expectedNativeSampleIndex: bigint;
  archiveSequence: number;
  archiveSampleIndex: bigint;
  pendingBytes: number;
  staged: Uint8Array<ArrayBuffer>[];
  stagedBytes: number;
  stagedFirstSampleIndex: bigint | undefined;
  stagedGapBeforeSamples: string;
  stagedDiscontinuity: boolean;
  chain: Promise<void>;
  failure: string | undefined;
  persistenceFailed: boolean;
  receivedSamples: bigint;
  committedSamples: bigint;
  receivedNativeChunks: number;
}

export async function listNativeSynchronizedAudioDevices(): Promise<NativeSynchronizedAudioDevices> {
  return invoke<NativeSynchronizedAudioDevices>("list_synchronized_audio_devices");
}

/** Probe the selected microphone and forward bounded, periodic meter readings. */
export async function preflightNativeMicrophone(
  deviceId: string,
  onLevel: (level: MicrophonePreflightLevel) => void,
): Promise<MicrophonePreflightSummary> {
  const probeId = crypto.randomUUID();
  const unlisten = await listen<MicrophonePreflightLevel>("microphone-preflight-level", (event) => {
    if (event.payload.probeId === probeId) onLevel(event.payload);
  });
  try {
    return await invoke<MicrophonePreflightSummary>("preflight_microphone", { deviceId, probeId });
  } finally {
    unlisten();
  }
}

/** Start native capture only after listeners and durable start metadata are ready. */
export async function startNativeSynchronizedAudioCapture(options: {
  consentConfirmed: boolean;
  consentAtUs: string;
  microphoneDeviceId: string;
  systemAudioDeviceId: string | null;
  applicationAudioDeviceId: string | null;
  captureId: string;
  archive: NativeSynchronizedAudioArchiveHooks;
  onSourceFailure: (track: SynchronizedAudioTrack, message: string) => void;
}): Promise<ActiveNativeSynchronizedAudioCapture> {
  if (!options.consentConfirmed) {
    throw new Error("Confirm that everyone being recorded has agreed before starting capture.");
  }
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(options.captureId)) {
    throw new Error("The synchronized capture identifier is invalid.");
  }

  const queues: Record<SynchronizedAudioTrack, TrackQueue> = {
    microphone: createTrackQueue(),
    "system-audio": createTrackQueue(),
    "application-audio": createTrackQueue(),
  };
  const failures: Partial<Record<SynchronizedAudioTrack, string>> = {};
  const earlyFailures: Partial<Record<SynchronizedAudioTrack, string>> = {};
  const unlisten: UnlistenFn[] = [];
  let started: NativeSynchronizedAudioStarted | undefined;
  let active = false;
  let stopped = false;
  let finishing = false;
  let startMetadataCommitted = false;
  let pauseCount = 0;
  let pausedDurationMs = 0;
  let pausedAt: number | undefined;
  let nextPauseId = 0;
  let pendingPause: { id: number; resolve(): void; reject(error: Error): void } | undefined;

  const addFailure = (track: SynchronizedAudioTrack, message: string) => {
    const normalized = message.trim() || "The audio source stopped unexpectedly.";
    if (!failures[track]) failures[track] = normalized;
    const queue = queues[track];
    if (!queue.failure) queue.failure = normalized;
    options.onSourceFailure(track, normalized);
  };

  const stopSource = (track: SynchronizedAudioTrack, message: string) => {
    addFailure(track, message);
    if (started && !stopped) {
      void invoke("stop_synchronized_audio_source", {
        captureId: started.captureId,
        track,
        message,
      }).catch(() => undefined);
    }
  };

  const flushTrack = (track: SynchronizedAudioTrack, requestedBytes = Number.POSITIVE_INFINITY) => {
    const queue = queues[track];
    if (queue.stagedBytes === 0 || queue.stagedFirstSampleIndex === undefined) return;
    const frameAligned = Math.floor(Math.min(queue.stagedBytes, requestedBytes) / queue.frameBytes);
    const size = frameAligned * queue.frameBytes;
    if (size <= 0) return;
    const bytes = new Uint8Array(size);
    let offset = 0;
    let remaining = size;
    const rest: Uint8Array<ArrayBuffer>[] = [];
    for (const part of queue.staged) {
      if (remaining === 0) {
        rest.push(part);
      } else if (part.byteLength <= remaining) {
        bytes.set(part, offset);
        offset += part.byteLength;
        remaining -= part.byteLength;
      } else {
        bytes.set(part.subarray(0, remaining), offset);
        rest.push(part.slice(remaining));
        remaining = 0;
      }
    }
    const firstSampleIndex = queue.stagedFirstSampleIndex.toString();
    const gapBeforeSamples = queue.stagedGapBeforeSamples;
    const containsDeviceDiscontinuity = queue.stagedDiscontinuity;
    queue.staged = rest;
    queue.stagedBytes -= size;
    queue.stagedFirstSampleIndex = queue.stagedBytes > 0 ? BigInt(firstSampleIndex) + BigInt(frameAligned) : undefined;
    queue.stagedGapBeforeSamples = "0";
    queue.stagedDiscontinuity = rest.length > 0 ? false : queue.stagedDiscontinuity;
    const sequence = queue.archiveSequence++;
    const operation = queue.chain.then(async () => {
      if (queue.persistenceFailed) return;
      try {
        await options.archive.onChunk(track, {
          sequence,
          firstSampleIndex,
          samples: bytes,
          sampleFormat: queue.sampleFormat,
          channelCount: queue.channelCount,
          gapBeforeSamples,
          containsDeviceDiscontinuity,
        });
        queue.committedSamples += BigInt(frameAligned);
      } catch (cause) {
        queue.persistenceFailed = true;
        stopSource(track, `Archive checkpoint failed: ${errorMessage(cause)}`);
        releaseQueuedChunks(queue);
      } finally {
        queue.pendingBytes = Math.max(0, queue.pendingBytes - size);
      }
    });
    queue.chain = operation.catch(() => undefined);
  };

  const receiveChunk = (event: NativeChunkEvent) => {
    if (!started || event.captureId !== started.captureId || stopped) return;
    const track = parseTrack(event.track);
    if (!track) return;
    const queue = queues[track];
    if (queue.failure || queue.persistenceFailed) return;
    try {
      if (
        !Number.isSafeInteger(event.sequence) ||
        event.sequence !== queue.expectedNativeSequence
      ) {
        throw new Error("Native audio chunks arrived out of sequence.");
      }
      if (event.sampleRateHz !== queue.sampleRateHz) {
        throw new Error("The audio source changed sample rate while recording.");
      }
      const sampleFormat = parseSampleFormat(event.sampleFormat);
      const channelCount = event.channelCount ?? 1;
      if (sampleFormat !== queue.sampleFormat || channelCount !== queue.channelCount) {
        throw new Error("The audio source changed format while recording.");
      }
      const gapBeforeSamples = event.gapBeforeSamples ?? "0";
      if (!/^\d+$/u.test(event.firstSampleIndex) || !/^\d+$/u.test(gapBeforeSamples)) {
        throw new Error("The audio source returned an invalid sample timeline.");
      }
      const firstSampleIndex = BigInt(event.firstSampleIndex);
      if (firstSampleIndex !== queue.expectedNativeSampleIndex + BigInt(gapBeforeSamples)) {
        throw new Error("The audio source returned a discontinuous sample timeline.");
      }
      const bytes = decodePcm(event.pcmBase64 ?? event.pcmS16leBase64 ?? "");
      if (bytes.byteLength === 0 || bytes.byteLength % queue.frameBytes !== 0) {
        throw new Error("The audio source returned an invalid PCM chunk.");
      }
      const frames = BigInt(bytes.byteLength / queue.frameBytes);
      if (event.frameCount !== undefined && BigInt(event.frameCount) !== frames) {
        throw new Error("The audio source returned an inconsistent PCM frame count.");
      }
      if (queue.pendingBytes + bytes.byteLength > MAX_PENDING_BYTES_PER_TRACK) {
        throw new Error("Archive writing fell behind the bounded audio queue.");
      }
      if (gapBeforeSamples !== "0" && queue.stagedBytes > 0) flushTrack(track);
      queue.expectedNativeSequence++;
      queue.expectedNativeSampleIndex = firstSampleIndex + frames;
      queue.receivedSamples += frames;
      queue.receivedNativeChunks++;
      queue.pendingBytes += bytes.byteLength;
      if (queue.stagedFirstSampleIndex === undefined) {
        queue.stagedFirstSampleIndex = firstSampleIndex;
        queue.stagedGapBeforeSamples = gapBeforeSamples;
        queue.stagedDiscontinuity = event.containsDeviceDiscontinuity === true;
      }
      queue.archiveSampleIndex = firstSampleIndex + frames;
      queue.staged.push(bytes);
      queue.stagedBytes += bytes.byteLength;
      while (queue.stagedBytes >= ARCHIVE_BATCH_BYTES) flushTrack(track, ARCHIVE_BATCH_BYTES);
    } catch (cause) {
      stopSource(track, errorMessage(cause));
      flushTrack(track);
    }
  };

  try {
    unlisten.push(
      await listen<NativeChunkEvent>(CHUNK_EVENT, ({ payload }) => receiveChunk(payload)),
    );
    unlisten.push(
      await listen<NativeFailureEvent>(FAILURE_EVENT, ({ payload }) => {
        if (!started && payload.captureId === options.captureId) {
          const track = parseTrack(payload.track);
          if (track && isExpectedSource(track) && !earlyFailures[track])
            earlyFailures[track] = payload.message;
        } else if (started && payload.captureId === started.captureId) {
          const track = parseTrack(payload.track);
          if (track && isExpectedSource(track)) {
            stopSource(track, payload.message);
            flushTrack(track);
          }
        }
      }),
    );
    unlisten.push(
      await listen<NativePauseDrainedEvent>(PAUSE_DRAINED_EVENT, ({ payload }) => {
        if (
          started &&
          payload.captureId === started.captureId &&
          pendingPause?.id === payload.pauseId
        ) {
          pendingPause.resolve();
          pendingPause = undefined;
        }
      }),
    );

    const nativeStarted = await invoke<NativeSynchronizedAudioStarted>(
      "begin_synchronized_audio_capture",
      {
        captureId: options.captureId,
        consentConfirmed: options.consentConfirmed,
        consentAtUs: options.consentAtUs,
        microphoneDeviceId: options.microphoneDeviceId,
        systemAudioDeviceId: options.systemAudioDeviceId,
        applicationAudioDeviceId: options.applicationAudioDeviceId,
      },
    );
    started = nativeStarted;
    validateStarted(nativeStarted, options.captureId, options.consentAtUs);
    for (const [track, message] of Object.entries(earlyFailures)) {
      const source = parseTrack(track);
      if (source && message) addFailure(source, message);
    }
    configureQueue(
      queues.microphone,
      nativeStarted.microphoneSampleRateHz,
      nativeStarted.microphoneSampleFormat,
      nativeStarted.microphoneChannelCount,
    );
    configureQueue(
      queues["system-audio"],
      nativeStarted.systemAudioSampleRateHz,
      nativeStarted.systemAudioSampleFormat,
      nativeStarted.systemAudioChannelCount,
    );
    configureQueue(
      queues["application-audio"],
      nativeStarted.applicationAudioSampleRateHz,
      nativeStarted.applicationAudioSampleFormat,
      nativeStarted.applicationAudioChannelCount,
    );
    await options.archive.onStarted(nativeStarted);
    startMetadataCommitted = true;
    await invoke("activate_synchronized_audio_capture", { captureId: nativeStarted.captureId });
    active = true;

    const capture: ActiveNativeSynchronizedAudioCapture = {
      started: nativeStarted,
      async pause() {
        if (!active || stopped || pausedAt !== undefined) {
          throw new Error("The synchronized capture cannot be paused now.");
        }
        if (nextPauseId >= Number.MAX_SAFE_INTEGER) throw new Error("Too many pause cycles.");
        const id = ++nextPauseId;
        const drained = new Promise<void>((resolve, reject) => {
          pendingPause = { id, resolve, reject };
        });
        try {
          await invoke("pause_synchronized_audio_capture", {
            captureId: nativeStarted.captureId,
            pauseId: id,
          });
          await withTimeout(drained, 5000, "Native audio chunks did not drain before pause.");
          pauseCount++;
          pausedAt = performance.now();
          flushTrack("microphone");
          flushTrack("system-audio");
          flushTrack("application-audio");
          await Promise.all([
            queues.microphone.chain,
            queues["system-audio"].chain,
            queues["application-audio"].chain,
          ]);
          await options.archive.onPaused({
            pauseCount,
            pausedDurationUs: String(Math.round(pausedDurationMs * 1000)),
          });
        } catch (cause) {
          await invoke("resume_synchronized_audio_capture", {
            captureId: nativeStarted.captureId,
          }).catch(() => undefined);
          if (pausedAt !== undefined) {
            pausedAt = undefined;
            pauseCount--;
          }
          pendingPause?.reject(asError(cause));
          pendingPause = undefined;
          throw cause;
        }
      },
      async resume() {
        if (!active || stopped || pausedAt === undefined) {
          throw new Error("The synchronized capture cannot be resumed now.");
        }
        const resumedAt = performance.now();
        const nextPausedDurationMs = pausedDurationMs + resumedAt - pausedAt;
        await options.archive.onResumed({
          pauseCount,
          pausedDurationUs: String(Math.round(nextPausedDurationMs * 1000)),
        });
        try {
          await invoke("resume_synchronized_audio_capture", { captureId: nativeStarted.captureId });
        } catch (cause) {
          await options.archive
            .onPaused({
              pauseCount,
              pausedDurationUs: String(Math.round(pausedDurationMs * 1000)),
            })
            .catch(() => undefined);
          throw cause;
        }
        pausedDurationMs = nextPausedDurationMs;
        pausedAt = undefined;
      },
      async stop() {
        if (stopped || finishing) throw new Error("This capture has already stopped.");
        finishing = true;
        active = false;
        if (pausedAt !== undefined) {
          pausedDurationMs += performance.now() - pausedAt;
          pausedAt = undefined;
        }
        try {
          const summary = await invoke<NativeFinished>("finish_synchronized_audio_capture", {
            captureId: nativeStarted.captureId,
          });
          await waitForNativeDelivery(summary, queues);
          reconcileSummary("microphone", summary.microphone, queues.microphone, failures);
          if (isExpectedSource("system-audio")) {
            reconcileSummary("system-audio", summary.systemAudio, queues["system-audio"], failures);
          }
          if (isExpectedSource("application-audio")) {
            reconcileSummary(
              "application-audio",
              summary.applicationAudio,
              queues["application-audio"],
              failures,
            );
          }
          flushTrack("microphone");
          flushTrack("system-audio");
          flushTrack("application-audio");
          await Promise.all([
            queues.microphone.chain,
            queues["system-audio"].chain,
            queues["application-audio"].chain,
          ]);
          if (
            queues.microphone.committedSamples !== queues.microphone.receivedSamples &&
            !failures.microphone
          ) {
            failures.microphone = "One or more microphone samples were not durably checkpointed.";
          }
          if (
            isExpectedSource("system-audio") &&
            queues["system-audio"].committedSamples !== queues["system-audio"].receivedSamples &&
            !failures["system-audio"]
          ) {
            failures["system-audio"] =
              "One or more shared-audio samples were not durably checkpointed.";
          }
          if (
            isExpectedSource("application-audio") &&
            queues["application-audio"].committedSamples !==
              queues["application-audio"].receivedSamples &&
            !failures["application-audio"]
          ) {
            failures["application-audio"] =
              "One or more application-audio samples were not durably checkpointed.";
          }
          const pausedDurationUs = String(Math.round(pausedDurationMs * 1000));
          await options.archive.onFinished({ pauseCount, pausedDurationUs, failures });
          stopped = true;
          return {
            archiveCommitted: true as const,
            pauseCount,
            pausedDurationUs,
            warnings: Object.entries(failures).map(([track, message]) => `${track}: ${message}`),
          };
        } finally {
          stopped = true;
          finishing = false;
          await cleanup();
        }
      },
      async discard() {
        if (stopped || finishing) return;
        stopped = true;
        active = false;
        await invoke("discard_synchronized_audio_capture", { captureId: nativeStarted.captureId });
        await cleanup();
        releaseQueuedChunks(queues.microphone);
        releaseQueuedChunks(queues["system-audio"]);
        releaseQueuedChunks(queues["application-audio"]);
      },
    };
    return capture;
  } catch (cause) {
    if (!startMetadataCommitted || !started) {
      await invoke("discard_synchronized_audio_capture", { captureId: options.captureId }).catch(
        () => undefined,
      );
    } else {
      const summary = await invoke<NativeFinished>("finish_synchronized_audio_capture", {
        captureId: started.captureId,
      }).catch(() => undefined);
      if (summary && startMetadataCommitted) {
        for (const track of ["microphone", "system-audio", "application-audio"] as const) {
          if (isExpectedSource(track) && !failures[track]) {
            failures[track] = "Capture startup failed after the archive metadata was committed.";
          }
        }
        await options.archive
          .onFinished({
            pauseCount,
            pausedDurationUs: "0",
            failures,
          })
          .catch(() => undefined);
      }
    }
    await cleanup();
    throw cause;
  }

  async function cleanup() {
    for (const stopListening of unlisten.splice(0)) stopListening();
    pendingPause?.reject(new Error("The synchronized capture stopped."));
    pendingPause = undefined;
  }

  function isExpectedSource(track: SynchronizedAudioTrack): boolean {
    return (
      track === "microphone" ||
      (track === "system-audio" && Boolean(options.systemAudioDeviceId)) ||
      (track === "application-audio" && Boolean(options.applicationAudioDeviceId))
    );
  }
}

function createTrackQueue(): TrackQueue {
  return {
    sampleRateHz: 0,
    sampleFormat: "pcm_s16le",
    channelCount: 1,
    frameBytes: 2,
    expectedNativeSequence: 0,
    expectedNativeSampleIndex: 0n,
    archiveSequence: 0,
    archiveSampleIndex: 0n,
    pendingBytes: 0,
    staged: [],
    stagedBytes: 0,
    stagedFirstSampleIndex: undefined,
    stagedGapBeforeSamples: "0",
    stagedDiscontinuity: false,
    chain: Promise.resolve(),
    failure: undefined,
    persistenceFailed: false,
    receivedSamples: 0n,
    committedSamples: 0n,
    receivedNativeChunks: 0,
  };
}

function configureQueue(
  queue: TrackQueue,
  sampleRateHz: number,
  sampleFormatValue: string | undefined,
  channelCountValue: number | undefined,
): void {
  queue.sampleRateHz = sampleRateHz;
  queue.sampleFormat = parseSampleFormat(sampleFormatValue);
  queue.channelCount = channelCountValue ?? 1;
  queue.frameBytes = bytesPerSample(queue.sampleFormat) * queue.channelCount;
}

function parseSampleFormat(value: string | undefined): NativeAudioSampleFormat {
  switch (value) {
    case "pcm_u8":
    case "pcm_s16le":
    case "pcm_s24le":
    case "pcm_s32le":
    case "pcm_f32le":
      return value;
    default:
      return "pcm_s16le";
  }
}

function bytesPerSample(format: NativeAudioSampleFormat): number {
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

function releaseQueuedChunks(queue: TrackQueue): void {
  queue.pendingBytes = Math.max(0, queue.pendingBytes - queue.stagedBytes);
  queue.staged = [];
  queue.stagedBytes = 0;
  queue.stagedFirstSampleIndex = undefined;
}

function decodePcm(base64: string): Uint8Array<ArrayBuffer> {
  if (typeof base64 !== "string" || base64.length > Math.ceil((MAX_NATIVE_EVENT_BYTES * 4) / 3)) {
    throw new Error("The native audio event exceeded the supported chunk size.");
  }
  const decoded = atob(base64);
  if (decoded.length > MAX_NATIVE_EVENT_BYTES) {
    throw new Error("The native audio event exceeded the supported chunk size.");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function parseTrack(value: string): SynchronizedAudioTrack | undefined {
  if (value === "microphone" || value === "system-audio" || value === "application-audio")
    return value;
  return undefined;
}

function validateStarted(
  started: NativeSynchronizedAudioStarted,
  captureId: string,
  consentAtUs: string,
): void {
  if (started.captureId !== captureId || started.consentAtUs !== consentAtUs) {
    throw new Error("The native capture returned different consent or capture metadata.");
  }
  if (!/^\d+$/u.test(started.startedAtUs) || BigInt(started.startedAtUs) < BigInt(consentAtUs)) {
    throw new Error("The native capture returned an invalid start timestamp.");
  }
  for (const rate of [
    started.microphoneSampleRateHz,
    started.systemAudioSampleRateHz,
    started.applicationAudioSampleRateHz,
  ]) {
    if (rate !== 0 && (!Number.isSafeInteger(rate) || rate < 8_000 || rate > 384_000)) {
      throw new Error("A native audio source returned an unsupported sample rate.");
    }
  }
  for (const channels of [
    started.microphoneChannelCount,
    started.systemAudioChannelCount,
    started.applicationAudioChannelCount,
  ]) {
    if (channels !== undefined && (!Number.isInteger(channels) || channels < 1 || channels > 8)) {
      throw new Error("A native audio source returned an unsupported channel count.");
    }
  }
  if (
    started.microphoneSampleRateHz === 0 &&
    started.systemAudioSampleRateHz === 0 &&
    started.applicationAudioSampleRateHz === 0
  ) {
    throw new Error("Neither native audio source returned a usable sample rate.");
  }
}

async function waitForNativeDelivery(
  summary: NativeFinished,
  queues: Record<SynchronizedAudioTrack, TrackQueue>,
): Promise<void> {
  const expected = {
    microphone: summary.microphone.chunkCount,
    "system-audio": summary.systemAudio.chunkCount,
    "application-audio": summary.applicationAudio.chunkCount,
  };
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (
      (queues.microphone.receivedNativeChunks >= expected.microphone ||
        queues.microphone.failure) &&
      (queues["system-audio"].receivedNativeChunks >= expected["system-audio"] ||
        queues["system-audio"].failure) &&
      (queues["application-audio"].receivedNativeChunks >= expected["application-audio"] ||
        queues["application-audio"].failure)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function reconcileSummary(
  track: SynchronizedAudioTrack,
  summary: NativeFinishedTrack,
  queue: TrackQueue,
  failures: Partial<Record<SynchronizedAudioTrack, string>>,
): void {
  if (summary.failure && !failures[track]) failures[track] = summary.failure;
  if (
    summary.channelCount !== undefined &&
    summary.channelCount !== queue.channelCount &&
    !failures[track]
  ) {
    failures[track] = "The native audio summary reported a different channel count.";
  }
  if (
    summary.sampleFormat !== undefined &&
    parseSampleFormat(summary.sampleFormat) !== queue.sampleFormat &&
    !failures[track]
  ) {
    failures[track] = "The native audio summary reported a different sample format.";
  }
  if (summary.sampleCount === "0" && !failures[track]) {
    failures[track] = "The selected audio source did not provide any samples.";
  }
  if (!/^\d+$/u.test(summary.sampleCount) && !failures[track]) {
    failures[track] = "The native audio summary contained an invalid sample count.";
  } else if (BigInt(summary.sampleCount) !== queue.receivedSamples && !failures[track]) {
    failures[track] =
      "The audio stream ended before every captured chunk reached the archive writer.";
  }
  if (summary.chunkCount !== queue.receivedNativeChunks && !failures[track]) {
    failures[track] =
      "The native audio delivery ended before every chunk reached the archive writer.";
  }
  if (queue.persistenceFailed && !failures[track]) {
    failures[track] = "Audio stopped because an archive checkpoint could not be committed.";
  }
}

async function withTimeout(
  promise: Promise<void>,
  milliseconds: number,
  message: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
