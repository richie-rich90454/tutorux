import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";
import { RecordType, type ArchiveRecord } from "../frontend/archive/format";
import {
  MAX_MICROPHONE_ARCHIVE_CHUNK_BYTES,
  type CaptureSampleFormat,
  type MicrophoneArchiveSource,
} from "../frontend/domain/microphone-recording";
import {
  makeSynchronizedCaptureChunkRecords,
  makeSynchronizedCaptureFinishRecords,
  makeSynchronizedCaptureStartRecords,
  makeSynchronizedCaptureStateRecords,
} from "../frontend/domain/synchronized-recording";
import { makeWhisperRecords } from "../frontend/domain/whisper";
import type { AudioPreview } from "../frontend/domain/audio";
import { LiveWhisperSession } from "./whisper";
import {
  resolveNativeAudioHelper,
  selectNativeCaptureDevice,
  type NativeApplicationAudioDevice,
  type NativeCaptureDevice,
  type NativeCaptureSource,
} from "./native-audio-helper";
import type { RecordingControlWorker } from "./recording-control";

const FFMPEG_SAMPLE_RATE_HZ = 16_000;
const APPLICATION_SAMPLE_RATE_HZ = 48_000;
const APPLICATION_CHANNELS = 2;
const MAX_QUEUED_PCM_BYTES = 96 * 1024 * 1024;
const MAX_QUEUED_TRANSCRIPTION_BYTES = 96 * 1024 * 1024;
const STDERR_CAPTURE_LIMIT = 32 * 1024;
const HELPER_FORMAT_PREFIX = "tutorux-audio-helper: capture-format ";

export interface LiveCaptureFormat {
  sampleFormat: CaptureSampleFormat;
  sampleRateHz: number;
  channelCount: number;
}

export const FFMPEG_CAPTURE_FORMAT: LiveCaptureFormat = {
  sampleFormat: "pcm_s16le",
  sampleRateHz: FFMPEG_SAMPLE_RATE_HZ,
  channelCount: 1,
};

export const APPLICATION_CAPTURE_FORMAT: LiveCaptureFormat = {
  sampleFormat: "pcm_f32le",
  sampleRateHz: APPLICATION_SAMPLE_RATE_HZ,
  channelCount: APPLICATION_CHANNELS,
};

export function captureBytesPerSample(format: CaptureSampleFormat): number {
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

export function captureFormatFromNativeDevice(
  device: Pick<NativeCaptureDevice, "sampleFormat" | "sampleRateHz" | "channelCount">,
): LiveCaptureFormat | undefined {
  const sampleFormat = normalizeCaptureSampleFormat(device.sampleFormat);
  if (
    sampleFormat === undefined ||
    device.sampleRateHz === undefined ||
    !Number.isSafeInteger(device.sampleRateHz) ||
    device.sampleRateHz < 8_000 ||
    device.sampleRateHz > 384_000 ||
    device.channelCount === undefined ||
    !Number.isSafeInteger(device.channelCount) ||
    device.channelCount < 1 ||
    device.channelCount > 8
  ) {
    return undefined;
  }
  return {
    sampleFormat,
    sampleRateHz: device.sampleRateHz,
    channelCount: device.channelCount,
  };
}

export function parseCaptureFormatLine(line: string): LiveCaptureFormat | undefined {
  const index = line.indexOf(HELPER_FORMAT_PREFIX);
  if (index < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(index + HELPER_FORMAT_PREFIX.length).trim());
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  const sampleFormat = normalizeCaptureSampleFormat(
    typeof value["sampleFormat"] === "string" ? value["sampleFormat"] : undefined,
  );
  const sampleRateHz = value["sampleRateHz"];
  const channelCount = value["channelCount"];
  if (
    sampleFormat === undefined ||
    typeof sampleRateHz !== "number" ||
    !Number.isSafeInteger(sampleRateHz) ||
    sampleRateHz < 8_000 ||
    sampleRateHz > 384_000 ||
    typeof channelCount !== "number" ||
    !Number.isSafeInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > 8
  ) {
    return undefined;
  }
  return { sampleFormat, sampleRateHz, channelCount };
}

export function sameCaptureFormat(left: LiveCaptureFormat, right: LiveCaptureFormat): boolean {
  return (
    left.sampleFormat === right.sampleFormat &&
    left.sampleRateHz === right.sampleRateHz &&
    left.channelCount === right.channelCount
  );
}

function normalizeCaptureSampleFormat(value: string | undefined): CaptureSampleFormat | undefined {
  switch (value?.trim().toLowerCase()) {
    case "u8":
    case "i8":
    case "pcm_u8":
      return "pcm_u8";
    case "i16":
    case "u16":
    case "s16":
    case "s16le":
    case "pcm_s16le":
      return "pcm_s16le";
    case "i24":
    case "u24":
    case "s24":
    case "s24le":
    case "pcm_s24le":
      return "pcm_s24le";
    case "i32":
    case "u32":
    case "i64":
    case "u64":
    case "s32":
    case "s32le":
    case "pcm_s32le":
      return "pcm_s32le";
    case "f32":
    case "f64":
    case "f32le":
    case "pcm_f32le":
      return "pcm_f32le";
    default:
      return undefined;
  }
}

export interface FfmpegAudioDevice {
  id: string;
  name: string;
  backend: string;
  processId?: number;
  bundleId?: string;
}

export type RecordingDurability = "default" | "maximum" | "reduced-write";

export interface LiveRecordingOptions {
  sessionId: string;
  session: ArchiveRecord;
  knownTrackIds: readonly string[];
  transcriptRecords: readonly ArchiveRecord[];
  expectedGeneration: bigint;
  ffmpeg: string;
  device?: string;
  source?: MicrophoneArchiveSource;
  applicationCapture?: {
    helper: string;
    device: NativeApplicationAudioDevice;
  };
  inputFormat?: "pulse" | "alsa";
  durationSeconds?: number;
  durability?: RecordingDurability;
  consentConfirmedBy: string;
  whisper?: {
    executable: string;
    model: string;
    language: string;
    windowSeconds: number;
    threads?: number;
    diarizeSpeakerTurns: boolean;
  };
  commit: (
    records: readonly ArchiveRecord[],
    expectedGeneration: bigint,
  ) => Promise<ArchiveRecord[]>;
  progress: (message: string) => void;
  signal?: AbortSignal;
  recordingControl?: RecordingControlWorker;
}

export interface LiveRecordingResult {
  sessionId: string;
  source: MicrophoneArchiveSource;
  trackId: string;
  takeId: string;
  deviceId: string;
  deviceName: string;
  inputBackend: string;
  sampleFormat: CaptureSampleFormat;
  sampleRateHz: number;
  channelCount: number;
  sampleCount: string;
  chunkCount: number;
  byteCount: number;
  durationUs: string;
  state: "completed" | "interrupted" | "failed";
  liveTranscriptSegmentCount: number;
  liveSpeakerTurnBoundaryCount: number;
  liveTranscriptionError: string;
  error: string;
}

export interface LiveSynchronizedRecordingOptions {
  sessionId: string;
  session: ArchiveRecord;
  knownTrackIds: readonly string[];
  expectedGeneration: bigint;
  ffmpeg: string;
  microphoneDevice?: string;
  systemAudioDevice?: string;
  applicationCapture?: {
    helper: string;
    device: NativeApplicationAudioDevice;
  };
  inputFormat?: "pulse" | "alsa";
  durationSeconds?: number;
  durability?: RecordingDurability;
  consentConfirmedBy: string;
  commit: LiveRecordingOptions["commit"];
  progress: (message: string) => void;
  signal?: AbortSignal;
  recordingControl?: RecordingControlWorker;
}

export interface LiveSynchronizedRecordingResult {
  sessionId: string;
  source: "both";
  trackMode: "synchronized-separate";
  tracks: Array<{
    source: MicrophoneArchiveSource;
    trackId: string;
    deviceId: string;
    deviceName: string;
    sampleFormat: CaptureSampleFormat;
    sampleRateHz: number;
    channelCount: number;
    sampleCount: string;
    chunkCount: number;
    byteCount: number;
    durationUs: string;
    state: "completed" | "interrupted" | "failed";
    error: string;
  }>;
  durationUs: string;
  sampleCount: string;
  chunkCount: number;
  byteCount: number;
  state: "completed" | "interrupted" | "failed";
  error: string;
  inputBackend: string;
}

/** List audio inputs exposed by the locally installed FFmpeg build. */
export async function enumerateFfmpegAudioDevices(
  ffmpegCommand = "ffmpeg",
  linuxBackend?: "pulse" | "alsa",
): Promise<FfmpegAudioDevice[]> {
  const executable = resolveCommand(ffmpegCommand);
  if (process.platform === "win32") {
    const result = await captureCommand(executable, [
      "-hide_banner",
      "-list_devices",
      "true",
      "-f",
      "dshow",
      "-i",
      "dummy",
    ]);
    assertFfmpegStarted(result);
    const audioHeader = result.stderr.toLowerCase().indexOf("directshow audio devices");
    const audioSection = audioHeader < 0 ? result.stderr : result.stderr.slice(audioHeader);
    const names = [
      ...audioSection.matchAll(/^\s*(?:\[[^\]]+\]\s*)?"([^"]+)"(?:\s+\(audio\))?\s*$/gimu),
    ]
      .map((match) => match[1]!)
      .filter((name) => !name.startsWith("@device_"));
    return uniqueDevices(names.map((name) => ({ id: name, name, backend: "dshow" })));
  }

  if (process.platform === "darwin") {
    const result = await captureCommand(executable, [
      "-hide_banner",
      "-f",
      "avfoundation",
      "-list_devices",
      "true",
      "-i",
      "",
    ]);
    assertFfmpegStarted(result);
    const audioHeader = result.stderr.indexOf("AVFoundation audio devices:");
    const videoHeader = result.stderr.indexOf("AVFoundation video devices:");
    const audioSection =
      audioHeader < 0
        ? ""
        : result.stderr.slice(audioHeader, videoHeader > audioHeader ? videoHeader : undefined);
    const devices = [...audioSection.matchAll(/\[(\d+)\]\s+(.+?)\s*$/gmu)].map((match) => ({
      id: match[1]!,
      name: match[2]!,
      backend: "avfoundation",
    }));
    return uniqueDevices(devices);
  }

  const backends = linuxBackend ? [linuxBackend] : (["pulse", "alsa"] as const);
  const results = await Promise.all(
    backends.map(async (backend) => {
      const result = await captureCommand(executable, ["-hide_banner", "-sources", backend]);
      assertFfmpegStarted(result);
      return parseNamedSources(result.stderr, backend);
    }),
  );
  return uniqueDevices(results.flat());
}

/** Open an FFmpeg input briefly and report measured signal levels without archiving audio. */
export async function probeFfmpegAudioDevice(options: {
  ffmpeg: string;
  device: FfmpegAudioDevice;
  source: "microphone" | "system-audio";
}): Promise<{
  id: string;
  name: string;
  backend: string;
  source: "microphone" | "system-audio";
  sampleFormat: string;
  sampleRateHz: number;
  channelCount: number;
  sampleCount: number;
  durationMs: number;
  rms: number;
  peak: number;
  dbfs: number;
  signalDetected: boolean;
  probe: string;
}> {
  const backend = { name: options.device.backend, format: options.device.backend };
  const args = ffmpegCaptureArguments(backend, options.device);
  const outputDuration = args.indexOf("-vn");
  args.splice(outputDuration, 0, "-t", "1.8");
  const child = spawn(resolveCommand(options.ffmpeg), args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  let byteCount = 0;
  let stderr = "";
  let overflow = false;
  let spawnError: Error | undefined;
  const timeout = setTimeout(() => {
    overflow = true;
    child.kill();
  }, 10_000);
  child.stdout.on("data", (chunk: Buffer) => {
    if (byteCount + chunk.length > 4 * 1024 * 1024) {
      overflow = true;
      child.kill();
      return;
    }
    chunks.push(chunk);
    byteCount += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < STDERR_CAPTURE_LIMIT)
      stderr += chunk.toString("utf8").slice(0, STDERR_CAPTURE_LIMIT - stderr.length);
  });
  child.once("error", (error: Error) => {
    spawnError = error;
  });
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  clearTimeout(timeout);
  if (spawnError)
    throw new Error("Could not start FFmpeg for the signal probe: " + spawnError.message);
  if (overflow) throw new Error("The FFmpeg signal probe exceeded its bounded capture limit.");
  if (exit.code !== 0) {
    throw new Error(
      stderr.trim() || `FFmpeg exited with code ${String(exit.code)} during the signal probe.`,
    );
  }
  if (byteCount < 2 || byteCount % 2 !== 0) {
    throw new Error("The FFmpeg input opened but returned no complete PCM samples.");
  }
  const pcm = Buffer.concat(chunks, byteCount);
  let sumSquares = 0;
  let peak = 0;
  const sampleCount = pcm.length / 2;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32768;
    const magnitude = Math.abs(sample);
    sumSquares += magnitude * magnitude;
    peak = Math.max(peak, magnitude);
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  return {
    id: options.device.id,
    name: options.device.name,
    backend: options.device.backend,
    source: options.source,
    sampleFormat: "S16LE",
    sampleRateHz: FFMPEG_CAPTURE_FORMAT.sampleRateHz,
    channelCount: FFMPEG_CAPTURE_FORMAT.channelCount,
    sampleCount,
    durationMs: Math.round((sampleCount / FFMPEG_CAPTURE_FORMAT.sampleRateHz) * 1_000),
    rms,
    peak,
    dbfs: rms > 0 ? 20 * Math.log10(rms) : -120,
    signalDetected: rms >= 0.001,
    probe: "ffmpeg-stream-opened-and-signal-measured",
  };
}

/** Record one consented FFmpeg input track, checkpointing PCM into the archive as it arrives. */
export async function recordLiveSource(
  options: LiveRecordingOptions,
): Promise<LiveRecordingResult> {
  const source = options.source ?? "microphone";
  const backend = inputBackend(options.inputFormat);
  if (
    !Number.isSafeInteger(options.durationSeconds ?? 0) &&
    options.durationSeconds !== undefined
  ) {
    throw new Error("Recording duration must be a positive whole number of seconds.");
  }
  if (
    options.durationSeconds !== undefined &&
    (options.durationSeconds < 1 || options.durationSeconds > 604_800)
  ) {
    throw new Error("Recording duration must be between 1 second and 7 days.");
  }
  if (options.whisper) {
    await validateWhisperConfiguration(options.whisper);
  }

  const applicationCapture =
    source === "application-audio" ? options.applicationCapture : undefined;
  if (source === "application-audio" && !applicationCapture) {
    throw new Error("Per-application capture needs an available native audio helper.");
  }
  const nativeCapture =
    source === "microphone" || source === "system-audio"
      ? await selectNativeCapture(source, options.inputFormat === undefined, options.device)
      : undefined;
  const device =
    source === "application-audio"
      ? {
          id: applicationCapture!.device.id,
          name: applicationCapture!.device.name,
          backend: applicationCapture!.device.backend,
          processId: applicationCapture!.device.processId,
          ...(applicationCapture!.device.bundleId === undefined
            ? {}
            : { bundleId: applicationCapture!.device.bundleId }),
        }
      : (nativeCapture?.device ??
        (source === "system-audio"
          ? await selectSystemAudioDevice(options.ffmpeg, backend, options.device)
          : await selectDevice(options.ffmpeg, backend, options.device)));
  const captureFormat = applicationCapture
    ? APPLICATION_CAPTURE_FORMAT
    : nativeCapture
      ? captureFormatFromNativeDevice(nativeCapture.device)
      : FFMPEG_CAPTURE_FORMAT;
  if (!captureFormat) {
    throw new Error(
      "The native audio helper did not report the selected input's sample format. Rebuild the audio helper and retry.",
    );
  }
  const frameBytes = captureBytesPerSample(captureFormat.sampleFormat) * captureFormat.channelCount;
  const checkpointBytes = recordingCheckpointBytes(
    options.durability,
    captureFormat.sampleFormat,
    captureFormat.sampleRateHz,
    captureFormat.channelCount,
  );
  const windowSeconds = options.whisper?.windowSeconds ?? 27;
  const windowBytes = windowSeconds * captureFormat.sampleRateHz * frameBytes;
  if (
    options.whisper &&
    (!Number.isSafeInteger(windowBytes) || windowBytes > MAX_QUEUED_PCM_BYTES)
  ) {
    throw new Error(
      "The live Whisper window exceeds the bounded capture queue; reduce --window-seconds.",
    );
  }

  let generation = options.expectedGeneration;
  let session = options.session;
  let track: ArchiveRecord;
  let take: ArchiveRecord;
  const startedAtUs = nowUs();
  const trackId = randomUUID();
  const takeId = randomUUID();
  const startRecords = makeSynchronizedCaptureStartRecords({
    session,
    takeId,
    tracks: [
      {
        source,
        trackId,
        sampleFormat: captureFormat.sampleFormat,
        sampleRateHz: captureFormat.sampleRateHz,
        channelCount: captureFormat.channelCount,
        ...(applicationCapture
          ? {
              sourceDeviceId: applicationCapture.device.id,
              sourceBackend: applicationCapture.device.backend,
              applicationName: applicationCapture.device.name.replace(/\s+· process \d+$/u, ""),
              applicationProcessId: applicationCapture.device.processId,
              ...(applicationCapture.device.bundleId
                ? { applicationBundleId: applicationCapture.device.bundleId }
                : {}),
            }
          : nativeCapture
            ? {
                sourceDeviceId: nativeCapture.device.id,
                sourceBackend: nativeCapture.device.backend,
              }
            : {}),
      },
    ],
    knownTrackIds: options.knownTrackIds,
    startedAtUs,
    consentAtUs: startedAtUs,
    ...(options.durability === undefined ? {} : { durability: options.durability }),
    captureSourceBackend:
      applicationCapture || nativeCapture ? "native-audio-helper" : "ffmpeg-cli",
    consentConfirmedBy: options.consentConfirmedBy,
  });
  const savedStart = await options.commit(startRecords, generation);
  generation += 1n;
  track = requiredSaved(savedStart, RecordType.assetMetadata, trackId);
  take = requiredSaved(savedStart, RecordType.assetMetadata, takeId);
  session = requiredSaved(savedStart, RecordType.session, options.sessionId);
  options.recordingControl?.stateChanged("initializing", "Preparing the selected audio input.");

  const helperCapture = applicationCapture ?? nativeCapture;
  const command = helperCapture ? helperCapture.helper : resolveCommand(options.ffmpeg);
  const child = spawn(
    command,
    applicationCapture
      ? ["capture", "--application", applicationCapture.device.id]
      : nativeCapture
        ? ["capture", "--source", nativeCapture.device.source, "--device", nativeCapture.device.id]
        : ffmpegCaptureArguments(backend, device),
    {
      stdio: [helperCapture ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: Boolean(helperCapture && process.platform !== "win32"),
    },
  );
  const processName = helperCapture ? "The native audio helper" : "FFmpeg";
  let stderr = "";
  let formatText = "";
  let formatChecked = !helperCapture;
  child.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (!formatChecked) {
      formatText = (formatText + text).slice(-8_192);
      const detected = parseCaptureFormatLine(formatText);
      if (detected) {
        formatChecked = true;
        if (!sameCaptureFormat(detected, captureFormat)) {
          requestStop(
            `The native audio helper opened a ${detected.sampleFormat} ${detected.sampleRateHz} Hz ${detected.channelCount}-channel stream instead of the saved ${captureFormat.sampleFormat} ${captureFormat.sampleRateHz} Hz ${captureFormat.channelCount}-channel format.`,
          );
        }
      }
    }
    if (stderr.length < STDERR_CAPTURE_LIMIT) {
      stderr += text.slice(0, STDERR_CAPTURE_LIMIT - stderr.length);
    }
  });

  let stopRequested = false;
  let stopError = "";
  let forceStop = false;
  let forceStopTimer: NodeJS.Timeout | undefined;
  const requestStop = (reason = "", force = false): void => {
    if (reason && !stopError) stopError = reason;
    if (stopRequested && !force) return;
    stopRequested = true;
    options.recordingControl?.stateChanged(
      "finalizing",
      reason || "Saving the recording and closing the capture process.",
    );
    forceStop ||= force;
    if (child.exitCode === null && child.signalCode === null) {
      if (helperCapture && !forceStop && child.stdin?.writable) {
        child.stdin.end("stop\n");
      } else {
        try {
          child.kill(forceStop ? "SIGKILL" : "SIGINT");
        } catch {
          child.kill();
        }
      }
      if (!forceStop && !forceStopTimer) {
        forceStopTimer = setTimeout(() => {
          stopError ||= helperCapture
            ? "The native audio helper did not stop cleanly after the stop request; the recording may be partial."
            : "FFmpeg did not stop cleanly after the stop request; the recording may be partial.";
          requestStop("", true);
        }, 5_000);
      }
    }
  };
  const onInterrupt = (): void => {
    if (stopRequested) {
      requestStop("Recording was force-stopped after a second interrupt.", true);
    } else {
      requestStop();
    }
  };
  const onTerminate = (): void => requestStop("Recording was interrupted by SIGTERM.");
  const onAbort = (): void => requestStop("Recording was interrupted by its caller.");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let durationRemainingMs =
    options.durationSeconds === undefined ? undefined : options.durationSeconds * 1000;
  let durationStartedAt = Date.now();
  let durationTimer: NodeJS.Timeout | undefined;
  const startDurationTimer = (): void => {
    if (durationRemainingMs === undefined || stopRequested) return;
    durationStartedAt = Date.now();
    durationTimer = setTimeout(() => requestStop(), durationRemainingMs);
  };
  const pauseDurationTimer = (): void => {
    if (!durationTimer || durationRemainingMs === undefined) return;
    clearTimeout(durationTimer);
    durationTimer = undefined;
    durationRemainingMs = Math.max(0, durationRemainingMs - (Date.now() - durationStartedAt));
  };
  startDurationTimer();
  let childExit: { code: number | null; signal: NodeJS.Signals | null; error?: Error } | undefined;
  const closePromise = new Promise<void>((resolveClose) => {
    child.once("error", (error: Error) => {
      childExit ??= { code: null, signal: null, error };
      if (forceStopTimer) clearTimeout(forceStopTimer);
      resolveClose();
    });
    child.once("close", (code, signal) => {
      childExit ??= { code, signal };
      if (forceStopTimer) clearTimeout(forceStopTimer);
      resolveClose();
    });
  });

  let sampleCount = 0n;
  let receivedSampleCount = 0n;
  let chunkCount = 0;
  let byteCount = 0;
  let queuedPcmBytes = 0;
  let archiveFailure = "";
  let liveTranscriptionError = "";
  let transcriptRecords = [...options.transcriptRecords];
  let transcriptSegmentCount = 0;
  let speakerTurnBoundaryCount = 0;
  let archiveQueue = Promise.resolve();
  let transcriptionQueue = Promise.resolve();
  let transcriptionWorkerRunning = false;
  let queuedTranscriptionBytes = 0;
  let activeTranscriptionBytes = 0;
  const transcriptionWindows: Array<{
    window: { pcm: Uint8Array; firstSampleIndex: bigint };
    audioWrite: Promise<void>;
  }> = [];
  let pendingArchiveParts: Uint8Array[] = [];
  let pendingInferenceWindows: Array<{ pcm: Uint8Array; firstSampleIndex: bigint }> = [];
  let inferenceParts: Uint8Array[] = [];
  let inferenceBytes = 0;
  let inferenceStart: bigint | undefined;
  let liveWhisperSession: LiveWhisperSession | undefined;
  let liveWhisperReuseWarningShown = false;
  let pendingArchiveBytes = 0;
  let pendingArchiveStart: bigint | undefined;
  let pauseCount = 0;
  let pausedDurationMs = 0;
  let pausedStartedAt = 0;
  let isPaused = false;
  let pauseTransition = Promise.resolve();
  let pending = Buffer.alloc(0);

  const queueArchiveMutation = (operation: () => Promise<void>): Promise<void> => {
    const task = archiveQueue.then(async () => {
      if (archiveFailure) throw new Error(archiveFailure);
      await operation();
    });
    archiveQueue = task.catch((error: unknown) => {
      archiveFailure = errorMessage(error);
      options.progress(`Archive checkpoint failed: ${archiveFailure}`);
      requestStop(`The recording could not be saved: ${archiveFailure}`);
    });
    return task;
  };

  const enqueuePcmWindow = (pcm: Uint8Array, firstSampleIndex: bigint): boolean => {
    if (queuedPcmBytes + pcm.byteLength > MAX_QUEUED_PCM_BYTES) {
      requestStop(
        "Audio arrived faster than the archive could commit it; the saved recording is partial.",
      );
      return false;
    }
    queuedPcmBytes += pcm.byteLength;
    if (pendingArchiveBytes && pendingArchiveBytes + pcm.byteLength > checkpointBytes) {
      flushArchiveCheckpoint();
    }
    const audio = new Uint8Array(pcm);
    if (pendingArchiveStart === undefined) pendingArchiveStart = firstSampleIndex;
    pendingArchiveParts.push(audio);
    pendingArchiveBytes += audio.byteLength;
    if (options.whisper && !liveTranscriptionError) enqueueInferencePcm(audio, firstSampleIndex);
    if (pendingArchiveBytes >= checkpointBytes) flushArchiveCheckpoint();
    return true;
  };

  const takeInferenceBytes = (length: number): Uint8Array => {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const part = inferenceParts[0]!;
      const count = Math.min(part.byteLength, length - offset);
      output.set(part.subarray(0, count), offset);
      offset += count;
      if (count === part.byteLength) inferenceParts.shift();
      else inferenceParts[0] = part.subarray(count);
    }
    inferenceBytes -= length;
    return output;
  };

  const enqueueInferencePcm = (audio: Uint8Array, firstSampleIndex: bigint): void => {
    if (inferenceStart === undefined) inferenceStart = firstSampleIndex;
    inferenceParts.push(audio);
    inferenceBytes += audio.byteLength;
    while (inferenceBytes >= windowBytes) {
      const window = takeInferenceBytes(windowBytes);
      pendingInferenceWindows.push({ pcm: window, firstSampleIndex: inferenceStart });
      inferenceStart += BigInt(window.byteLength / frameBytes);
    }
  };

  const flushInferenceWindow = (): void => {
    if (!inferenceBytes || inferenceStart === undefined) return;
    const window = takeInferenceBytes(inferenceBytes);
    pendingInferenceWindows.push({ pcm: window, firstSampleIndex: inferenceStart });
    inferenceParts = [];
    inferenceStart = undefined;
  };

  const enqueueTranscriptionWindow = (
    window: { pcm: Uint8Array; firstSampleIndex: bigint },
    audioWrite: Promise<void>,
  ): void => {
    if (!options.whisper || liveTranscriptionError) return;
    if (
      activeTranscriptionBytes + queuedTranscriptionBytes + window.pcm.byteLength >
      MAX_QUEUED_TRANSCRIPTION_BYTES
    ) {
      stopLiveTranscription(
        "The local Whisper backlog exceeded 8 MiB; recording continues without live transcription.",
      );
      return;
    }
    transcriptionWindows.push({ window, audioWrite });
    queuedTranscriptionBytes += window.pcm.byteLength;
    scheduleTranscriptionWorker();
  };

  const stopLiveTranscription = (reason: string): void => {
    liveTranscriptionError = reason;
    transcriptionWindows.length = 0;
    pendingInferenceWindows.length = 0;
    inferenceParts = [];
    inferenceBytes = 0;
    inferenceStart = undefined;
    queuedTranscriptionBytes = 0;
    options.progress(`Live Whisper stopped; recording continues: ${reason}`);
  };

  const scheduleTranscriptionWorker = (): void => {
    if (!options.whisper || transcriptionWorkerRunning || liveTranscriptionError) return;
    transcriptionWorkerRunning = true;
    transcriptionQueue = (async () => {
      while (transcriptionWindows.length && !liveTranscriptionError) {
        const queued = transcriptionWindows.shift()!;
        const { window, audioWrite } = queued;
        queuedTranscriptionBytes -= window.pcm.byteLength;
        activeTranscriptionBytes += window.pcm.byteLength;
        try {
          await audioWrite;
          if (liveTranscriptionError) continue;
          const preview = buildCapturePreview(window.pcm, window.firstSampleIndex, captureFormat);
          const whisper = options.whisper!;
          liveWhisperSession ??= await LiveWhisperSession.create({
            executable: whisper.executable,
            model: whisper.model,
            language: whisper.language,
            ...(whisper.threads === undefined ? {} : { threads: whisper.threads }),
            diarizeSpeakerTurns: whisper.diarizeSpeakerTurns,
          });
          if (!liveWhisperSession.reusedProcess && !liveWhisperReuseWarningShown) {
            liveWhisperReuseWarningShown = true;
            options.progress(`Live Whisper: ${liveWhisperSession.reuseWarning}`);
          }
          const json = await liveWhisperSession.transcribe(preview, options.signal);
          const result = makeWhisperRecords({
            json,
            sessionId: options.sessionId,
            trackId,
            modelName: basename(whisper.model),
            language: whisper.language,
            preview,
            existing: transcriptRecords,
            diarizeSpeakerTurns: whisper.diarizeSpeakerTurns,
          });
          if (result.records.length) {
            await queueArchiveMutation(async () => {
              const saved = await options.commit(result.records, generation);
              generation += 1n;
              transcriptRecords = replaceTranscriptRevisions(transcriptRecords, saved);
              transcriptSegmentCount += saved.filter(
                (record) => record.fields.get("_deleted") !== "true",
              ).length;
              speakerTurnBoundaryCount += saved.filter(
                (record) =>
                  record.fields.get("_deleted") !== "true" &&
                  record.fields.get("speaker_turn_next") === "true",
              ).length;
            });
          }
          options.progress(
            `Transcribed ${formatDuration(BigInt(preview.frameCount), preview.sampleRateHz)}; ${result.records.length} provisional cue change(s).`,
          );
        } catch (error) {
          stopLiveTranscription(errorMessage(error));
        } finally {
          activeTranscriptionBytes -= window.pcm.byteLength;
        }
      }
    })()
      .catch((error: unknown) => {
        stopLiveTranscription(errorMessage(error));
      })
      .finally(() => {
        transcriptionWorkerRunning = false;
        if (transcriptionWindows.length && !liveTranscriptionError) scheduleTranscriptionWorker();
      });
  };

  const flushArchiveCheckpoint = (): void => {
    if (!pendingArchiveBytes || pendingArchiveStart === undefined) {
      if (pendingInferenceWindows.length) {
        const inferenceWindows = pendingInferenceWindows;
        pendingInferenceWindows = [];
        for (const window of inferenceWindows)
          enqueueTranscriptionWindow(window, Promise.resolve());
      }
      return;
    }
    const pcm = new Uint8Array(pendingArchiveBytes);
    let offset = 0;
    for (const part of pendingArchiveParts) {
      pcm.set(part, offset);
      offset += part.byteLength;
    }
    const firstSampleIndex = pendingArchiveStart;
    const inferenceWindows = pendingInferenceWindows;
    pendingArchiveParts = [];
    pendingInferenceWindows = [];
    pendingArchiveBytes = 0;
    pendingArchiveStart = undefined;

    const audioWrite = queueArchiveMutation(async () => {
      const changes = makeSynchronizedCaptureChunkRecords({
        session,
        track,
        chunk: {
          sequence: chunkCount,
          firstSampleIndex: firstSampleIndex.toString(),
          samples: pcm,
          sampleFormat: captureFormat.sampleFormat,
          channelCount: captureFormat.channelCount,
        },
        source,
      });
      const saved = await options.commit(changes, generation);
      generation += 1n;
      track = requiredSaved(saved, RecordType.assetMetadata, trackId);
      session = requiredSaved(saved, RecordType.session, options.sessionId);
      sampleCount += BigInt(pcm.byteLength / frameBytes);
      chunkCount += 1;
      byteCount += pcm.byteLength;
      queuedPcmBytes -= pcm.byteLength;
      if (chunkCount === 1 || chunkCount % 12 === 0) {
        options.progress(
          `Saved ${chunkCount} ${sourceLabel(source)} checkpoint(s), ${formatDuration(sampleCount, captureFormat.sampleRateHz)} recorded.`,
        );
      }
    });
    for (const window of inferenceWindows) enqueueTranscriptionWindow(window, audioWrite);
  };

  const synchronizePauseState = (): Promise<void> => {
    if (!options.recordingControl || options.recordingControl.pauseRequested() === isPaused) {
      return pauseTransition;
    }
    pauseTransition = pauseTransition
      .catch(() => {})
      .then(async () => {
        const shouldPause = options.recordingControl!.pauseRequested();
        if (shouldPause === isPaused || stopRequested) return;
        if (shouldPause) {
          const alignedLength = pending.length - (pending.length % frameBytes);
          if (alignedLength) {
            const finalPcm = pending.subarray(0, alignedLength);
            const firstSampleIndex = receivedSampleCount;
            if (enqueuePcmWindow(new Uint8Array(finalPcm), firstSampleIndex)) {
              receivedSampleCount += BigInt(finalPcm.byteLength / frameBytes);
            }
          }
          pending = Buffer.alloc(0);
          flushInferenceWindow();
          flushArchiveCheckpoint();
          await archiveQueue;
          if (stopRequested) return;
          isPaused = true;
          pauseCount += 1;
          pausedStartedAt = Date.now();
          pauseDurationTimer();
          const stateRecords = makeSynchronizedCaptureStateRecords(
            session,
            [track],
            take,
            "paused",
            { pauseCount, pausedDurationUs: String(Math.round(pausedDurationMs * 1_000)) },
          );
          const savedState = await options.commit(stateRecords, generation);
          generation += 1n;
          track = requiredSaved(savedState, RecordType.assetMetadata, trackId);
          take = requiredSaved(savedState, RecordType.assetMetadata, takeId);
          session = requiredSaved(savedState, RecordType.session, options.sessionId);
          if (stopRequested) return;
          options.recordingControl!.stateChanged(
            "paused",
            "Audio capture is paused; committed checkpoints are durable.",
          );
        } else {
          pausedDurationMs += Date.now() - pausedStartedAt;
          isPaused = false;
          startDurationTimer();
          const stateRecords = makeSynchronizedCaptureStateRecords(
            session,
            [track],
            take,
            "recording",
            { pauseCount, pausedDurationUs: String(Math.round(pausedDurationMs * 1_000)) },
          );
          const savedState = await options.commit(stateRecords, generation);
          generation += 1n;
          track = requiredSaved(savedState, RecordType.assetMetadata, trackId);
          take = requiredSaved(savedState, RecordType.assetMetadata, takeId);
          session = requiredSaved(savedState, RecordType.session, options.sessionId);
          if (stopRequested) return;
          options.recordingControl!.stateChanged("recording", "Audio capture resumed.");
        }
      });
    return pauseTransition;
  };

  let firstSampleSeen = false;
  const startupTimer = setTimeout(() => {
    if (!firstSampleSeen)
      requestStop(`${processName} did not receive ${sourceLabel(source)} audio within 15 seconds.`);
  }, 15_000);
  const controlTimer = setInterval(() => {
    if (options.recordingControl?.stopRequested() && !stopRequested) requestStop();
    void synchronizePauseState().catch((error: unknown) => {
      requestStop(`The recording could not pause cleanly: ${errorMessage(error)}`);
    });
  }, 50);
  const streamTask = (async () => {
    try {
      for await (const bytes of child.stdout!) {
        if (forceStop) break;
        await synchronizePauseState();
        if (stopRequested || forceStop) break;
        if (isPaused) {
          pending = Buffer.alloc(0);
          continue;
        }
        if (bytes.byteLength) {
          firstSampleSeen = true;
          clearTimeout(startupTimer);
          if (options.recordingControl?.state() === "initializing") {
            options.recordingControl.stateChanged("recording", "Audio capture is active.");
          }
        }
        pending = pending.length ? Buffer.concat([pending, bytes]) : Buffer.from(bytes);
        while (pending.length >= checkpointBytes) {
          const window = pending.subarray(0, checkpointBytes);
          pending = pending.subarray(checkpointBytes);
          const firstSampleIndex = receivedSampleCount;
          if (enqueuePcmWindow(new Uint8Array(window), firstSampleIndex))
            receivedSampleCount += BigInt(window.byteLength / frameBytes);
          if (stopError) break;
        }
        if (stopError) break;
      }
    } catch (error) {
      if (!stopRequested) requestStop(`${processName} audio stream failed: ${errorMessage(error)}`);
    }
  })();

  options.progress(
    helperCapture
      ? `Recording ${sourceLabel(source)} from ${device.name} through ${device.backend}; press Ctrl+C to stop and save.`
      : `Recording ${sourceLabel(source)} from ${device.name} through FFmpeg (${backend.name}); press Ctrl+C to stop and save.`,
  );
  await streamTask;
  if (pending.length >= frameBytes && !forceStop) {
    const alignedLength = pending.length - (pending.length % frameBytes);
    const trailing = pending.subarray(0, alignedLength);
    if (trailing.length) {
      if (enqueuePcmWindow(new Uint8Array(trailing), receivedSampleCount))
        receivedSampleCount += BigInt(trailing.byteLength / frameBytes);
    }
  }
  flushInferenceWindow();
  flushArchiveCheckpoint();
  if (pending.length % frameBytes !== 0 && !stopError) {
    stopError = `${processName} returned an incomplete PCM frame; the recording is partial.`;
  }
  await closePromise;
  clearTimeout(startupTimer);
  clearInterval(controlTimer);
  if (durationTimer) clearTimeout(durationTimer);
  if (isPaused) {
    pausedDurationMs += Date.now() - pausedStartedAt;
    isPaused = false;
  }
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  options.signal?.removeEventListener("abort", onAbort);

  if (!stopRequested && !childExit?.error && childExit?.code === 0) {
    stopError ||= `${processName} stopped before the requested recording duration.`;
  }
  if (childExit?.error && !stopError)
    stopError = `Could not start ${helperCapture ? "the native audio helper" : "FFmpeg"}: ${childExit.error.message}`;
  if (childExit && childExit.code !== 0 && !stopRequested && !stopError) {
    stopError = `${processName} exited with code ${String(childExit.code)}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
  }

  await archiveQueue;
  await transcriptionQueue;
  await archiveQueue;
  if (liveWhisperSession) {
    await liveWhisperSession.close().catch(() => undefined);
    liveWhisperSession = undefined;
  }

  if (sampleCount === 0n)
    stopError ||= `The selected ${sourceLabel(source)} input did not provide any audio samples.`;
  if (archiveFailure) stopError ||= `The recording could not be saved: ${archiveFailure}`;
  const finish = makeSynchronizedCaptureFinishRecords({
    session,
    tracks: [track],
    take,
    pauseCount,
    pausedDurationUs: String(Math.round(pausedDurationMs * 1_000)),
    failures: stopError ? { [source]: stopError } : {},
  });
  if (options.whisper) {
    const finalSession = finish.find((record) => record.type === RecordType.session)!;
    const fields = new Map(finalSession.fields);
    fields.set("processing_state", "review-required");
    fields.set(
      "processing_detail",
      liveTranscriptionError
        ? `Recording saved with partial live transcription: ${liveTranscriptionError}`
        : "Live local Whisper cues are provisional and ready for tutor review.",
    );
    fields.set("processing_updated_at_us", nowUs());
    finish[finish.indexOf(finalSession)] = { ...finalSession, fields };
  }
  try {
    await options.commit(finish, generation);
    generation += 1n;
  } catch (error) {
    stopError ||= `Recording audio was checkpointed, but final session state could not be saved: ${errorMessage(error)}`;
  }

  const state = stopError ? (sampleCount > 0n ? "interrupted" : "failed") : "completed";
  options.recordingControl?.stateChanged(
    state,
    stopError ||
      (state === "completed" ? "Recording is durably saved." : "Recording could not be completed."),
  );
  return {
    sessionId: options.sessionId,
    source,
    trackId,
    takeId,
    deviceId: device.id,
    deviceName: device.name,
    inputBackend: helperCapture ? device.backend : backend.name,
    sampleFormat: captureFormat.sampleFormat,
    sampleRateHz: captureFormat.sampleRateHz,
    channelCount: captureFormat.channelCount,
    sampleCount: sampleCount.toString(),
    chunkCount,
    byteCount,
    durationUs: ((sampleCount * 1_000_000n) / BigInt(captureFormat.sampleRateHz)).toString(),
    state,
    liveTranscriptSegmentCount: transcriptSegmentCount,
    liveSpeakerTurnBoundaryCount: speakerTurnBoundaryCount,
    liveTranscriptionError,
    error: stopError,
  };
}

/** Capture microphone and system loopback together as separately checkpointed tracks. */
export async function recordLiveSynchronized(
  options: LiveSynchronizedRecordingOptions,
): Promise<LiveSynchronizedRecordingResult> {
  const backend = inputBackend(options.inputFormat);
  if (
    !Number.isSafeInteger(options.durationSeconds ?? 0) &&
    options.durationSeconds !== undefined
  ) {
    throw new Error("Recording duration must be a positive whole number of seconds.");
  }
  if (
    options.durationSeconds !== undefined &&
    (options.durationSeconds < 1 || options.durationSeconds > 604_800)
  ) {
    throw new Error("Recording duration must be between 1 second and 7 days.");
  }

  const microphoneCapture =
    options.inputFormat === undefined
      ? await selectNativeCapture("microphone", true, options.microphoneDevice)
      : undefined;
  const systemAudioCapture =
    !options.applicationCapture && options.inputFormat === undefined
      ? await selectNativeCapture("system-audio", true, options.systemAudioDevice)
      : undefined;
  const microphone =
    microphoneCapture?.device ??
    (await selectDevice(options.ffmpeg, backend, options.microphoneDevice));
  const applicationCapture = options.applicationCapture;
  const secondary = applicationCapture
    ? {
        id: applicationCapture.device.id,
        name: applicationCapture.device.name,
        backend: applicationCapture.device.backend,
        processId: applicationCapture.device.processId,
        ...(applicationCapture.device.bundleId === undefined
          ? {}
          : { bundleId: applicationCapture.device.bundleId }),
      }
    : (systemAudioCapture?.device ??
      (await selectSystemAudioDevice(options.ffmpeg, backend, options.systemAudioDevice)));
  const microphoneFormat = microphoneCapture
    ? captureFormatFromNativeDevice(microphoneCapture.device)
    : FFMPEG_CAPTURE_FORMAT;
  if (!microphoneFormat) {
    throw new Error(
      "The native audio helper did not report the microphone sample format. Rebuild the audio helper and retry.",
    );
  }
  const secondaryFormat = applicationCapture
    ? APPLICATION_CAPTURE_FORMAT
    : systemAudioCapture
      ? captureFormatFromNativeDevice(systemAudioCapture.device)
      : FFMPEG_CAPTURE_FORMAT;
  if (!secondaryFormat) {
    throw new Error(
      "The native audio helper did not report the system-audio sample format. Rebuild the audio helper and retry.",
    );
  }
  const sources: Array<{
    source: MicrophoneArchiveSource;
    device: FfmpegAudioDevice | NativeCaptureDevice | NativeApplicationAudioDevice;
    trackId: string;
    helperCapture: boolean;
    format: LiveCaptureFormat;
    sourceDeviceId?: string;
    sourceBackend?: string;
    applicationName?: string;
    applicationProcessId?: number;
    applicationBundleId?: string;
  }> = [
    {
      source: "microphone" as const,
      device: microphone,
      trackId: randomUUID(),
      helperCapture: Boolean(microphoneCapture),
      format: microphoneFormat,
      ...(microphoneCapture
        ? {
            sourceDeviceId: microphoneCapture.device.id,
            sourceBackend: microphoneCapture.device.backend,
          }
        : {}),
    },
    {
      source: applicationCapture ? ("application-audio" as const) : ("system-audio" as const),
      device: secondary,
      trackId: randomUUID(),
      helperCapture: Boolean(applicationCapture || systemAudioCapture),
      format: secondaryFormat,
      ...(applicationCapture
        ? {
            sourceBackend: applicationCapture.device.backend,
            applicationName: applicationCapture.device.name.replace(/\s+· process \d+$/u, ""),
            applicationProcessId: applicationCapture.device.processId,
            ...(applicationCapture.device.bundleId
              ? { applicationBundleId: applicationCapture.device.bundleId }
              : {}),
          }
        : systemAudioCapture
          ? {
              sourceDeviceId: systemAudioCapture.device.id,
              sourceBackend: systemAudioCapture.device.backend,
            }
          : {}),
    },
  ];
  const takeId = randomUUID();
  const nativeTrackCount =
    Number(Boolean(microphoneCapture)) + Number(Boolean(applicationCapture || systemAudioCapture));
  const captureSourceBackend =
    nativeTrackCount === 2
      ? "native-audio-helper"
      : nativeTrackCount === 1
        ? "ffmpeg-cli+native-audio-helper"
        : "ffmpeg-cli";
  const captureMethod =
    nativeTrackCount === 2
      ? "the native audio helper"
      : nativeTrackCount === 1
        ? "the native audio helper and FFmpeg"
        : `FFmpeg (${backend.name})`;
  let generation = options.expectedGeneration;
  let session = options.session;
  let take: ArchiveRecord;
  const startedAtUs = nowUs();
  const startRecords = makeSynchronizedCaptureStartRecords({
    session,
    takeId,
    tracks: sources.map(({ source, trackId, format, sourceDeviceId, sourceBackend }) => ({
      source,
      trackId,
      sampleFormat: format.sampleFormat,
      sampleRateHz: format.sampleRateHz,
      channelCount: format.channelCount,
      ...(sourceDeviceId === undefined ? {} : { sourceDeviceId }),
      ...(sourceBackend === undefined ? {} : { sourceBackend }),
      ...(applicationCapture && source === "application-audio"
        ? {
            sourceDeviceId: applicationCapture.device.id,
            sourceBackend: applicationCapture.device.backend,
            applicationName: applicationCapture.device.name.replace(/\s+· process \d+$/u, ""),
            applicationProcessId: applicationCapture.device.processId,
            ...(applicationCapture.device.bundleId
              ? { applicationBundleId: applicationCapture.device.bundleId }
              : {}),
          }
        : {}),
    })),
    knownTrackIds: options.knownTrackIds,
    startedAtUs,
    consentAtUs: startedAtUs,
    ...(options.durability === undefined ? {} : { durability: options.durability }),
    captureSourceBackend,
    consentConfirmedBy: options.consentConfirmedBy,
  });
  const savedStart = await options.commit(startRecords, generation);
  generation += 1n;
  const tracks = sources.map(({ trackId }) =>
    requiredSaved(savedStart, RecordType.assetMetadata, trackId),
  );
  take = requiredSaved(savedStart, RecordType.assetMetadata, takeId);
  session = requiredSaved(savedStart, RecordType.session, options.sessionId);
  options.recordingControl?.stateChanged("initializing", "Preparing synchronized audio inputs.");

  const captureChildren: ChildProcess[] = [];
  const helperCaptureChildren = new Set<ChildProcess>();
  let streams: Readable[];
  const spawnHelperCapture = (helper: string, args: string[]): ChildProcess => {
    const child = spawn(helper, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    helperCaptureChildren.add(child);
    return child;
  };
  const spawnFfmpegCapture = (device: FfmpegAudioDevice): ChildProcess =>
    spawn(resolveCommand(options.ffmpeg), ffmpegCaptureArguments(backend, device), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  const needsSeparateInputs = Boolean(
    applicationCapture || microphoneCapture || systemAudioCapture,
  );
  if (needsSeparateInputs) {
    const microphoneChild = microphoneCapture
      ? spawnHelperCapture(microphoneCapture.helper, [
          "capture",
          "--source",
          microphoneCapture.device.source,
          "--device",
          microphoneCapture.device.id,
        ])
      : spawnFfmpegCapture(microphone);
    const secondaryChild = applicationCapture
      ? spawnHelperCapture(applicationCapture.helper, [
          "capture",
          "--application",
          applicationCapture.device.id,
        ])
      : systemAudioCapture
        ? spawnHelperCapture(systemAudioCapture.helper, [
            "capture",
            "--source",
            systemAudioCapture.device.source,
            "--device",
            systemAudioCapture.device.id,
          ])
        : spawnFfmpegCapture(secondary);
    captureChildren.push(microphoneChild, secondaryChild);
    streams = [microphoneChild.stdout!, secondaryChild.stdout!];
  } else {
    const ffmpegChild = spawn(
      resolveCommand(options.ffmpeg),
      ffmpegSynchronizedCaptureArguments(backend, microphone, secondary),
      {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    captureChildren.push(ffmpegChild);
    streams = [ffmpegChild.stdout!, ffmpegChild.stdio[3] as Readable];
  }
  const captureTracks = sources.map((source, index) => ({
    ...source,
    stream: streams[index]!,
    track: tracks[index]!,
    frameBytes: captureBytesPerSample(source.format.sampleFormat) * source.format.channelCount,
    checkpointBytes: recordingCheckpointBytes(
      options.durability,
      source.format.sampleFormat,
      source.format.sampleRateHz,
      source.format.channelCount,
    ),
    pending: Buffer.alloc(0),
    pendingParts: [] as Uint8Array[],
    pendingBytes: 0,
    pendingStart: undefined as bigint | undefined,
    receivedSamples: 0n,
    sampleCount: 0n,
    chunkCount: 0,
    byteCount: 0,
    firstSampleSeen: false,
    failure: "",
  }));
  let stderr = "";
  for (const captureChild of captureChildren) {
    captureChild.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAPTURE_LIMIT) {
        stderr += chunk.toString("utf8").slice(0, STDERR_CAPTURE_LIMIT - stderr.length);
      }
    });
  }

  let stopRequested = false;
  let stopError = "";
  let forceStop = false;
  let forceStopTimer: NodeJS.Timeout | undefined;
  const requestStop = (reason = "", force = false): void => {
    if (reason && !stopError) stopError = reason;
    if (stopRequested && !force) return;
    stopRequested = true;
    options.recordingControl?.stateChanged(
      "finalizing",
      reason || "Saving synchronized tracks and closing capture processes.",
    );
    forceStop ||= force;
    for (const captureChild of captureChildren) {
      if (captureChild.exitCode !== null || captureChild.signalCode !== null) continue;
      if (helperCaptureChildren.has(captureChild) && !forceStop && captureChild.stdin?.writable) {
        captureChild.stdin.end("stop\n");
      } else {
        try {
          captureChild.kill(forceStop ? "SIGKILL" : "SIGINT");
        } catch {
          captureChild.kill();
        }
      }
    }
    if (!forceStop && !forceStopTimer) {
      forceStopTimer = setTimeout(() => {
        stopError ||= helperCaptureChildren.size
          ? "A native audio helper did not stop cleanly; the synchronized recording may be partial."
          : "FFmpeg did not stop cleanly after the stop request; the synchronized recording may be partial.";
        requestStop("", true);
      }, 5_000);
    }
  };
  const onInterrupt = (): void => {
    if (stopRequested) requestStop("Recording was force-stopped after a second interrupt.", true);
    else requestStop();
  };
  const onTerminate = (): void => requestStop("Recording was interrupted by SIGTERM.");
  const onAbort = (): void => requestStop("Recording was interrupted by its caller.");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let durationRemainingMs =
    options.durationSeconds === undefined ? undefined : options.durationSeconds * 1000;
  let durationStartedAt = Date.now();
  let durationTimer: NodeJS.Timeout | undefined;
  const startDurationTimer = (): void => {
    if (durationRemainingMs === undefined || stopRequested) return;
    durationStartedAt = Date.now();
    durationTimer = setTimeout(() => requestStop(), durationRemainingMs);
  };
  const pauseDurationTimer = (): void => {
    if (!durationTimer || durationRemainingMs === undefined) return;
    clearTimeout(durationTimer);
    durationTimer = undefined;
    durationRemainingMs = Math.max(0, durationRemainingMs - (Date.now() - durationStartedAt));
  };
  startDurationTimer();
  let childExit:
    | {
        code: number | null;
        signal: NodeJS.Signals | null;
        error?: Error;
      }
    | undefined;
  const closePromise = Promise.all(
    captureChildren.map(
      (captureChild) =>
        new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
          error?: Error;
        }>((resolveClose) => {
          let spawnError: Error | undefined;
          captureChild.once("error", (error: Error) => {
            spawnError = error;
          });
          captureChild.once("close", (code, signal) => {
            const exit = { code, signal, ...(spawnError ? { error: spawnError } : {}) };
            if (!stopRequested) {
              requestStop(
                "A capture process exited before the recording stop request; the synchronized take may be partial.",
              );
            }
            resolveClose(exit);
          });
        }),
    ),
  ).then((exits) => {
    childExit =
      exits.find((exit) => exit.error || (exit.code !== null && exit.code !== 0)) ?? exits[0];
    if (forceStopTimer) clearTimeout(forceStopTimer);
  });

  let queuedPcmBytes = 0;
  let archiveFailure = "";
  let archiveQueue = Promise.resolve();
  const queueArchiveMutation = (operation: () => Promise<void>): Promise<void> => {
    const task = archiveQueue.then(async () => {
      if (archiveFailure) throw new Error(archiveFailure);
      await operation();
    });
    archiveQueue = task.catch((error: unknown) => {
      archiveFailure = errorMessage(error);
      options.progress(`Archive checkpoint failed: ${archiveFailure}`);
      requestStop(`The synchronized recording could not be saved: ${archiveFailure}`);
    });
    return task;
  };

  const flushCheckpoint = (capture: (typeof captureTracks)[number]): void => {
    if (!capture.pendingBytes || capture.pendingStart === undefined) return;
    const pcm = new Uint8Array(capture.pendingBytes);
    let offset = 0;
    for (const part of capture.pendingParts) {
      pcm.set(part, offset);
      offset += part.byteLength;
    }
    const firstSampleIndex = capture.pendingStart;
    capture.pendingParts = [];
    capture.pendingBytes = 0;
    capture.pendingStart = undefined;
    void queueArchiveMutation(async () => {
      const changes = makeSynchronizedCaptureChunkRecords({
        session,
        track: capture.track,
        chunk: {
          sequence: capture.chunkCount,
          firstSampleIndex: firstSampleIndex.toString(),
          samples: pcm,
          sampleFormat: capture.format.sampleFormat,
          channelCount: capture.format.channelCount,
        },
        source: capture.source,
      });
      const saved = await options.commit(changes, generation);
      generation += 1n;
      capture.track = requiredSaved(saved, RecordType.assetMetadata, capture.trackId);
      session = requiredSaved(saved, RecordType.session, options.sessionId);
      capture.sampleCount += BigInt(pcm.byteLength / capture.frameBytes);
      capture.chunkCount += 1;
      capture.byteCount += pcm.byteLength;
      queuedPcmBytes -= pcm.byteLength;
      options.progress(
        `Saved ${sourceLabel(capture.source)} checkpoint ${capture.chunkCount} (${formatDuration(capture.sampleCount, capture.format.sampleRateHz)}).`,
      );
    });
  };

  const enqueuePcm = (capture: (typeof captureTracks)[number], pcm: Uint8Array): boolean => {
    if (queuedPcmBytes + pcm.byteLength > MAX_QUEUED_PCM_BYTES) {
      requestStop(
        "Audio arrived faster than the archive could commit it; the synchronized recording is partial.",
      );
      return false;
    }
    if (capture.pendingBytes && capture.pendingBytes + pcm.byteLength > capture.checkpointBytes) {
      flushCheckpoint(capture);
    }
    const audio = new Uint8Array(pcm);
    if (capture.pendingStart === undefined) capture.pendingStart = capture.receivedSamples;
    capture.pendingParts.push(audio);
    capture.pendingBytes += audio.byteLength;
    capture.receivedSamples += BigInt(audio.byteLength / capture.frameBytes);
    queuedPcmBytes += audio.byteLength;
    if (capture.pendingBytes >= capture.checkpointBytes) flushCheckpoint(capture);
    return true;
  };

  let pauseCount = 0;
  let pausedDurationMs = 0;
  let pausedStartedAt = 0;
  let isPaused = false;
  let pauseTransition = Promise.resolve();
  const synchronizePauseState = (): Promise<void> => {
    if (!options.recordingControl || options.recordingControl.pauseRequested() === isPaused) {
      return pauseTransition;
    }
    pauseTransition = pauseTransition
      .catch(() => {})
      .then(async () => {
        const shouldPause = options.recordingControl!.pauseRequested();
        if (shouldPause === isPaused || stopRequested) return;
        if (shouldPause) {
          for (const capture of captureTracks) {
            const alignedLength =
              capture.pending.length - (capture.pending.length % capture.frameBytes);
            if (alignedLength)
              enqueuePcm(capture, new Uint8Array(capture.pending.subarray(0, alignedLength)));
            capture.pending = Buffer.alloc(0);
            flushCheckpoint(capture);
          }
          await archiveQueue;
          if (stopRequested) return;
          isPaused = true;
          pauseCount += 1;
          pausedStartedAt = Date.now();
          pauseDurationTimer();
          const stateRecords = makeSynchronizedCaptureStateRecords(
            session,
            captureTracks.map((capture) => capture.track),
            take,
            "paused",
            { pauseCount, pausedDurationUs: String(Math.round(pausedDurationMs * 1_000)) },
          );
          const savedState = await options.commit(stateRecords, generation);
          generation += 1n;
          for (const capture of captureTracks) {
            capture.track = requiredSaved(savedState, RecordType.assetMetadata, capture.trackId);
          }
          take = requiredSaved(savedState, RecordType.assetMetadata, takeId);
          session = requiredSaved(savedState, RecordType.session, options.sessionId);
          if (stopRequested) return;
          options.recordingControl!.stateChanged(
            "paused",
            "Synchronized capture is paused; committed checkpoints are durable.",
          );
        } else {
          pausedDurationMs += Date.now() - pausedStartedAt;
          isPaused = false;
          startDurationTimer();
          const stateRecords = makeSynchronizedCaptureStateRecords(
            session,
            captureTracks.map((capture) => capture.track),
            take,
            "recording",
            { pauseCount, pausedDurationUs: String(Math.round(pausedDurationMs * 1_000)) },
          );
          const savedState = await options.commit(stateRecords, generation);
          generation += 1n;
          for (const capture of captureTracks) {
            capture.track = requiredSaved(savedState, RecordType.assetMetadata, capture.trackId);
          }
          take = requiredSaved(savedState, RecordType.assetMetadata, takeId);
          session = requiredSaved(savedState, RecordType.session, options.sessionId);
          if (stopRequested) return;
          options.recordingControl!.stateChanged(
            "recording",
            "Synchronized audio capture resumed.",
          );
        }
      });
    return pauseTransition;
  };

  const startupTimer = setTimeout(() => {
    const missing = captureTracks.filter((capture) => !capture.firstSampleSeen);
    if (missing.length) {
      const message = `${helperCaptureChildren.size ? "A capture process" : "FFmpeg"} received no audio from ${missing.map((capture) => sourceLabel(capture.source)).join(" and ")} within 15 seconds.`;
      for (const capture of missing) capture.failure = message;
      requestStop(message);
    }
  }, 15_000);
  const controlTimer = setInterval(() => {
    if (options.recordingControl?.stopRequested() && !stopRequested) requestStop();
    void synchronizePauseState().catch((error: unknown) => {
      requestStop(`The synchronized recording could not pause cleanly: ${errorMessage(error)}`);
    });
  }, 50);
  const streamTasks = captureTracks.map(async (capture) => {
    try {
      for await (const bytes of capture.stream) {
        if (forceStop || stopError) break;
        await synchronizePauseState();
        if (stopRequested || forceStop) break;
        if (isPaused) {
          capture.pending = Buffer.alloc(0);
          continue;
        }
        if (bytes.byteLength) {
          capture.firstSampleSeen = true;
          if (captureTracks.every((candidate) => candidate.firstSampleSeen))
            clearTimeout(startupTimer);
          if (options.recordingControl?.state() === "initializing") {
            options.recordingControl.stateChanged(
              "recording",
              "Synchronized audio capture is active.",
            );
          }
        }
        capture.pending = capture.pending.length
          ? Buffer.concat([capture.pending, Buffer.from(bytes)])
          : Buffer.from(bytes);
        while (capture.pending.length >= capture.checkpointBytes) {
          const pcm = capture.pending.subarray(0, capture.checkpointBytes);
          capture.pending = capture.pending.subarray(capture.checkpointBytes);
          if (!enqueuePcm(capture, pcm)) break;
        }
      }
    } catch (error) {
      const processName = capture.helperCapture ? "The native audio helper" : "FFmpeg";
      capture.failure ||= `${processName} ${sourceLabel(capture.source)} stream failed: ${errorMessage(error)}`;
      requestStop(capture.failure);
    }
    if (!forceStop && capture.pending.length) {
      const alignedLength = capture.pending.length - (capture.pending.length % capture.frameBytes);
      if (alignedLength) enqueuePcm(capture, capture.pending.subarray(0, alignedLength));
      if (capture.pending.length % capture.frameBytes) {
        capture.failure ||=
          "The capture process returned an incomplete PCM frame; this track is partial.";
        requestStop(capture.failure);
      }
    }
    flushCheckpoint(capture);
  });

  options.progress(
    `Recording synchronized microphone and ${applicationCapture ? `${applicationCapture.device.name} application-audio` : "system-audio"} tracks through ${captureMethod}; press Ctrl+C to stop and save.`,
  );
  await Promise.all(streamTasks);
  await closePromise;
  if (childExit?.error && !stopError) {
    stopError = "Could not start a capture process: " + childExit.error.message;
  } else if (childExit && childExit.code !== 0 && !stopError) {
    stopError =
      "A capture process exited with code " +
      String(childExit.code) +
      (stderr.trim() ? ": " + stderr.trim() : "");
  } else if (!stopRequested && childExit?.code === 0) {
    stopError ||= "A capture process stopped before the requested synchronized recording duration.";
  }
  clearTimeout(startupTimer);
  clearInterval(controlTimer);
  if (durationTimer) clearTimeout(durationTimer);
  if (isPaused) {
    pausedDurationMs += Date.now() - pausedStartedAt;
    isPaused = false;
  }
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  options.signal?.removeEventListener("abort", onAbort);
  for (const capture of captureTracks) {
    if (capture.sampleCount === 0n && !capture.failure) {
      capture.failure = `The selected ${sourceLabel(capture.source)} input did not provide any audio samples.`;
      stopError ||= capture.failure;
    }
  }
  if (archiveFailure) stopError ||= `The recording could not be saved: ${archiveFailure}`;
  if (stopError && captureTracks.every((capture) => !capture.failure)) {
    for (const capture of captureTracks) capture.failure = stopError;
  }
  await archiveQueue;
  if (archiveFailure) stopError ||= `The recording could not be saved: ${archiveFailure}`;
  if (stopError && captureTracks.every((capture) => !capture.failure)) {
    for (const capture of captureTracks) capture.failure = stopError;
  }

  const failures: Partial<Record<MicrophoneArchiveSource, string>> = {};
  for (const capture of captureTracks) {
    if (capture.failure) failures[capture.source] = capture.failure;
  }
  const finish = makeSynchronizedCaptureFinishRecords({
    session,
    tracks: captureTracks.map((capture) => capture.track),
    take,
    pauseCount,
    pausedDurationUs: String(Math.round(pausedDurationMs * 1_000)),
    failures,
  });
  try {
    await options.commit(finish, generation);
    generation += 1n;
  } catch (error) {
    stopError ||= `Recording audio was checkpointed, but final session state could not be saved: ${errorMessage(error)}`;
  }

  const state = stopError
    ? captureTracks.some((capture) => capture.sampleCount > 0n)
      ? "interrupted"
      : "failed"
    : "completed";
  options.recordingControl?.stateChanged(
    state,
    stopError ||
      (state === "completed" ? "Recording is durably saved." : "Recording could not be completed."),
  );
  const resultTracks: LiveSynchronizedRecordingResult["tracks"] = captureTracks.map((capture) => ({
    source: capture.source,
    trackId: capture.trackId,
    deviceId: capture.device.id,
    deviceName: capture.device.name,
    sampleFormat: capture.format.sampleFormat,
    sampleRateHz: capture.format.sampleRateHz,
    channelCount: capture.format.channelCount,
    sampleCount: capture.sampleCount.toString(),
    chunkCount: capture.chunkCount,
    byteCount: capture.byteCount,
    durationUs: (
      (capture.sampleCount * 1_000_000n) /
      BigInt(capture.format.sampleRateHz)
    ).toString(),
    state: capture.failure ? (capture.sampleCount > 0n ? "interrupted" : "failed") : "completed",
    error: capture.failure,
  }));
  const durationUs = resultTracks.reduce(
    (longest, capture) =>
      BigInt(capture.durationUs) > longest ? BigInt(capture.durationUs) : longest,
    0n,
  );
  return {
    sessionId: options.sessionId,
    source: "both",
    trackMode: "synchronized-separate",
    tracks: resultTracks,
    durationUs: durationUs.toString(),
    sampleCount: captureTracks
      .reduce((total, capture) => total + capture.sampleCount, 0n)
      .toString(),
    chunkCount: captureTracks.reduce((total, capture) => total + capture.chunkCount, 0),
    byteCount: captureTracks.reduce((total, capture) => total + capture.byteCount, 0),
    state,
    error:
      stopError ||
      resultTracks
        .map((capture) => capture.error)
        .filter(Boolean)
        .join(" "),
    inputBackend: captureSourceBackend,
  };
}

export function resolveFfmpegCommand(value: string | undefined): string {
  return resolveCommand(value?.trim() || "ffmpeg");
}

function inputBackend(requested?: "pulse" | "alsa"): {
  name: "dshow" | "avfoundation" | "pulse" | "alsa";
  format: string;
} {
  if (process.platform === "win32") {
    if (requested) throw new Error("--input-format is supported only on Linux.");
    return { name: "dshow", format: "dshow" };
  }
  if (process.platform === "darwin") {
    if (requested) throw new Error("--input-format is supported only on Linux.");
    return { name: "avfoundation", format: "avfoundation" };
  }
  return { name: requested ?? "pulse", format: requested ?? "pulse" };
}

async function selectDevice(
  ffmpeg: string,
  backend: { name: string; format: string },
  requested?: string,
): Promise<FfmpegAudioDevice> {
  const devices = await enumerateFfmpegAudioDevices(
    ffmpeg,
    backend.format === "pulse" || backend.format === "alsa" ? backend.format : undefined,
  );
  const matchingBackendDevices = devices.filter((device) => device.backend === backend.format);
  if (requested) {
    const match = matchingBackendDevices.find(
      (device) => device.id === requested || device.name === requested,
    );
    if (matchingBackendDevices.length && !match) {
      throw new Error(`The selected input device '${requested}' is not listed by FFmpeg.`);
    }
    return match ?? { id: requested, name: requested, backend: backend.format };
  }
  const matching = matchingBackendDevices[0];
  if (process.platform === "win32" || process.platform === "darwin") {
    if (!matching) {
      throw new Error(
        "FFmpeg did not list a microphone. Check device permissions or pass --device.",
      );
    }
    return matching;
  }
  return (
    matching ?? {
      id: "default",
      name: `default ${backend.format} microphone`,
      backend: backend.format,
    }
  );
}

async function selectSystemAudioDevice(
  ffmpeg: string,
  backend: { name: string; format: string },
  requested?: string,
): Promise<FfmpegAudioDevice> {
  if (process.platform === "darwin") {
    throw new Error(
      "FFmpeg AVFoundation does not expose system loopback capture. Use a ScreenCaptureKit-capable desktop recorder; microphone capture remains available in the CLI.",
    );
  }
  if (process.platform === "linux" && backend.format !== "pulse") {
    throw new Error(
      "CLI system-audio capture requires a PulseAudio/PipeWire Pulse monitor source; ALSA input does not identify system playback. Use --input-format pulse and select a listed monitor with --playback.",
    );
  }
  const devices = await enumerateFfmpegAudioDevices(
    ffmpeg,
    backend.format === "pulse" || backend.format === "alsa" ? backend.format : undefined,
  );
  const candidates = devices.filter(isSupportedFfmpegSystemAudioDevice);
  if (requested && requested !== "default") {
    const selected = devices.find(
      (device) =>
        device.backend === backend.format && (device.id === requested || device.name === requested),
    );
    if (!selected) {
      throw new Error(`FFmpeg did not list the selected system-audio input '${requested}'.`);
    }
    if (!isSupportedFfmpegSystemAudioDevice(selected)) {
      throw new Error(
        `The selected input '${requested}' is not identified as a loopback or monitor candidate. Choose a listed Stereo Mix/loopback input on Windows or a Pulse monitor source on Linux.`,
      );
    }
    return selected;
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new Error(
      `FFmpeg listed multiple system-audio loopback candidates. Select one with --playback or record configure --playback.`,
    );
  }
  if (process.platform === "win32") {
    throw new Error(
      "No DirectShow loopback input was listed. Enable Stereo Mix or install a virtual loopback input, route system playback to it, then select its listed name with --playback. Listing an input does not verify its routing.",
    );
  }
  throw new Error(
    "No PulseAudio/PipeWire Pulse monitor source was listed. Select a source ending in '.monitor' with --playback; endpoint enumeration does not verify that playback is routed to it.",
  );
}

async function selectNativeCapture(
  source: NativeCaptureSource,
  enabled: boolean,
  requested?: string,
): Promise<{ helper: string; device: NativeCaptureDevice } | undefined> {
  if (!enabled) return undefined;
  let helper: string;
  try {
    helper = await resolveNativeAudioHelper();
  } catch {
    return undefined;
  }
  try {
    const device = await selectNativeCaptureDevice(helper, source, requested);
    return { helper, device };
  } catch {
    return undefined;
  }
}

export function isSupportedFfmpegSystemAudioDevice(device: FfmpegAudioDevice): boolean {
  const label = `${device.id} ${device.name}`;
  if (process.platform === "win32") {
    return device.backend === "dshow" && /monitor|loopback|stereo\s*mix/iu.test(label);
  }
  if (process.platform === "linux") {
    return device.backend === "pulse" && /monitor|loopback/iu.test(label);
  }
  return false;
}

function sourceLabel(source: MicrophoneArchiveSource): string {
  if (source === "application-audio") return "application audio";
  return source === "microphone" ? "microphone" : "system audio";
}

function ffmpegCaptureArguments(
  backend: { name: string; format: string },
  device: Pick<FfmpegAudioDevice, "id" | "name" | "backend">,
): string[] {
  const input = ffmpegInputName(backend, device);
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-thread_queue_size",
    "512",
    "-f",
    backend.format,
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(FFMPEG_CAPTURE_FORMAT.sampleRateHz),
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1",
  ];
}

function ffmpegSynchronizedCaptureArguments(
  backend: { name: string; format: string },
  microphone: Pick<FfmpegAudioDevice, "id" | "name" | "backend">,
  systemAudio: Pick<FfmpegAudioDevice, "id" | "name" | "backend">,
): string[] {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  for (const device of [microphone, systemAudio]) {
    args.push(
      "-use_wallclock_as_timestamps",
      "1",
      "-thread_queue_size",
      "512",
      "-f",
      backend.format,
      "-i",
      ffmpegInputName(backend, device),
    );
  }
  args.push(
    "-copyts",
    "-start_at_zero",
    "-filter_complex",
    "[0:a:0]aresample=async=1:first_pts=0[microphone];[1:a:0]aresample=async=1:first_pts=0[system]",
  );
  for (const [label, pipe] of [
    ["microphone", "pipe:1"],
    ["system", "pipe:3"],
  ] as const) {
    args.push(
      "-map",
      `[${label}]`,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(FFMPEG_CAPTURE_FORMAT.sampleRateHz),
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      pipe!,
    );
  }
  return args;
}

function ffmpegInputName(
  backend: { name: string; format: string },
  device: Pick<FfmpegAudioDevice, "id" | "name" | "backend">,
): string {
  return backend.format === "dshow"
    ? `audio=${device.id}`
    : backend.format === "avfoundation"
      ? `:${device.id}`
      : device.id;
}

/** Legacy durability policy: maximum snapshots every 100 ms, reduced-write every 2 s. */
function recordingCheckpointBytes(
  policy: RecordingDurability | undefined,
  sampleFormat: CaptureSampleFormat,
  sampleRateHz: number,
  channelCount: number,
): number {
  const intervalMs = policy === "maximum" ? 100 : policy === "reduced-write" ? 2_000 : 500;
  const frameBytes = captureBytesPerSample(sampleFormat) * channelCount;
  const bytes = Math.floor((sampleRateHz * frameBytes * intervalMs) / 1_000);
  const aligned = bytes - (bytes % frameBytes);
  return Math.max(frameBytes, Math.min(MAX_MICROPHONE_ARCHIVE_CHUNK_BYTES, aligned));
}

async function validateWhisperConfiguration(
  options: NonNullable<LiveRecordingOptions["whisper"]>,
): Promise<void> {
  if (!/^[A-Za-z-]{1,16}$/u.test(options.language)) {
    throw new Error("--language must be auto or a language code.");
  }
  if (
    !Number.isSafeInteger(options.windowSeconds) ||
    options.windowSeconds < 1 ||
    options.windowSeconds > 27
  ) {
    throw new Error("--window-seconds must be an integer from 1 through 27.");
  }
  for (const path of [options.executable, options.model]) {
    const metadata = await lstat(resolve(path));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Whisper executable and model must be regular, non-symlink files.");
    }
  }
}

/**
 * Build a native-rate, native-channel preview for Whisper. `whisperAudio` then downmixes and
 * resamples the preview to 16 kHz mono without writing that converted audio to the archive.
 */
export function buildCapturePreview(
  pcm: Uint8Array,
  firstSampleIndex: bigint,
  format: LiveCaptureFormat,
): AudioPreview {
  const bytesPerSample = captureBytesPerSample(format.sampleFormat);
  const frameBytes = bytesPerSample * format.channelCount;
  if (!pcm.byteLength || pcm.byteLength % frameBytes)
    throw new Error("Live Whisper received unaligned PCM audio.");
  const frames = pcm.byteLength / frameBytes;
  const source = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const pcm16 = new Uint8Array(frames * format.channelCount * 2);
  const output = new DataView(pcm16.buffer);
  for (let offset = 0, target = 0; offset < pcm.byteLength; offset += bytesPerSample, target += 2) {
    output.setInt16(target, decodeCaptureSample(source, offset, format.sampleFormat), true);
  }

  const wav = new Uint8Array(44 + pcm16.byteLength);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, wav.length - 8, true);
  writeAscii(wav, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, format.channelCount, true);
  view.setUint32(24, format.sampleRateHz, true);
  view.setUint32(28, format.sampleRateHz * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, 16, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, pcm16.byteLength, true);
  wav.set(pcm16, 44);
  return {
    wav,
    sampleRateHz: format.sampleRateHz,
    channelCount: format.channelCount,
    frameCount: frames,
    startFrame: firstSampleIndex,
    durationUs: (BigInt(frames) * 1_000_000n) / BigInt(format.sampleRateHz),
  };
}

function decodeCaptureSample(
  source: DataView,
  offset: number,
  sampleFormat: CaptureSampleFormat,
): number {
  switch (sampleFormat) {
    case "pcm_u8":
      return (source.getUint8(offset) - 128) << 8;
    case "pcm_s16le":
      return source.getInt16(offset, true);
    case "pcm_s24le": {
      const raw =
        source.getUint8(offset) |
        (source.getUint8(offset + 1) << 8) |
        (source.getUint8(offset + 2) << 16);
      const signed = raw & 0x80_0000 ? raw | 0xff_000000 : raw;
      return signed >> 8;
    }
    case "pcm_s32le":
      return source.getInt32(offset, true) >> 16;
    case "pcm_f32le": {
      const value = source.getFloat32(offset, true);
      if (!Number.isFinite(value)) return 0;
      return Math.max(-32_768, Math.min(32_767, Math.round(value * 32_768)));
    }
  }
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1)
    bytes[offset + index] = value.charCodeAt(index);
}

function replaceTranscriptRevisions(
  existing: readonly ArchiveRecord[],
  changes: readonly ArchiveRecord[],
): ArchiveRecord[] {
  const next = new Map(existing.map((record) => [record.id.toLowerCase(), record] as const));
  for (const record of changes) next.set(record.id.toLowerCase(), record);
  return [...next.values()];
}

function requiredSaved(records: readonly ArchiveRecord[], type: number, id: string): ArchiveRecord {
  const record = records.find(
    (candidate) => candidate.type === type && candidate.id.toLowerCase() === id.toLowerCase(),
  );
  if (!record) throw new Error(`The archive did not return saved ${type}:${id} metadata.`);
  return record;
}

function parseNamedSources(text: string, backend: string): FfmpegAudioDevice[] {
  const devices: FfmpegAudioDevice[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:"([^"]+)"|([^\s()]+))(?:\s+\((.*)\))?\s*$/u.exec(line);
    const id = match?.[1] ?? match?.[2];
    if (
      !match ||
      !id ||
      /^(?:sources|devices|pulse|alsa|ffmpeg|built with|configuration)$/iu.test(id)
    )
      continue;
    devices.push({ id, name: match[3] || id, backend });
  }
  return uniqueDevices(devices);
}

function uniqueDevices(devices: FfmpegAudioDevice[]): FfmpegAudioDevice[] {
  const seen = new Set<string>();
  return devices.filter((device) => {
    const key = `${device.backend}:${device.id}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function captureCommand(
  command: string,
  arguments_: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolveResult) => {
    const child = spawn(command, [...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        child.kill();
      }
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 1024 * 1024)
        stdout += chunk.toString("utf8").slice(0, 1024 * 1024 - stdout.length);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 1024 * 1024)
        stderr += chunk.toString("utf8").slice(0, 1024 * 1024 - stderr.length);
    });
    child.once("error", (error: Error) => {
      clearTimeout(timeout);
      resolveResult({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ code, stdout, stderr, timedOut });
    });
  });
}

function assertFfmpegStarted(result: {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}): void {
  if (result.timedOut) {
    throw new Error("FFmpeg device enumeration timed out after 15 seconds.");
  }
  if (result.code !== null) return;
  const detail = result.stderr.trim();
  throw new Error(
    detail
      ? `Could not start FFmpeg: ${detail}`
      : "FFmpeg is required for CLI audio capture. Install FFmpeg or pass its path with --ffmpeg.",
  );
}

function resolveCommand(value: string): string {
  const command = value.trim();
  if (!command) return "ffmpeg";
  return command.includes("\\") || command.includes("/") || isAbsolute(command)
    ? resolve(command)
    : command;
}

function nowUs(): string {
  return (BigInt(Date.now()) * 1000n).toString();
}

function formatDuration(samples: bigint, sampleRateHz: number): string {
  const totalSeconds = samples / BigInt(sampleRateHz);
  const minutes = totalSeconds / 60n;
  const seconds = totalSeconds % 60n;
  return `${minutes}m ${seconds}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
