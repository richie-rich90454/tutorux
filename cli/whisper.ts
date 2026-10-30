import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { RecordType, type ArchiveRecord } from "../frontend/archive/format";
import type { ArchiveSnapshot } from "../frontend/archive/archive";
import { buildAudioPreview } from "../frontend/domain/audio";
import { makeWhisperRecords, whisperAudio } from "../frontend/domain/whisper";
import type { AudioPreview } from "../frontend/domain/audio";

const MAX_WHISPER_OUTPUT_BYTES = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_WINDOW_BYTES = 28n * 1024n * 1024n;
const MAX_PREVIEW_BYTES = 32n * 1024n * 1024n;

function captureBytesPerSample(sampleFormat: string): number {
  switch (sampleFormat) {
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
      throw new Error("Recording audio metadata is invalid.");
  }
}

/** Choose a window that fits both the stored PCM and the 16-bit preview limits. */
export function transcriptionWindowSeconds(
  sampleRateHz: number,
  channelCount: number,
  bytesPerSample: number,
): bigint {
  if (
    !Number.isSafeInteger(sampleRateHz) ||
    !Number.isSafeInteger(channelCount) ||
    !Number.isSafeInteger(bytesPerSample) ||
    sampleRateHz < 1 ||
    channelCount < 1 ||
    bytesPerSample < 1
  ) {
    throw new Error("Recording audio metadata is invalid.");
  }
  const rate = BigInt(sampleRateHz);
  const rawSeconds = MAX_ARCHIVE_WINDOW_BYTES / (rate * BigInt(channelCount * bytesPerSample));
  const previewSeconds = MAX_PREVIEW_BYTES / (rate * BigInt(channelCount * 2));
  return rawSeconds < previewSeconds ? rawSeconds : previewSeconds;
}

/** Default to every hardware thread up to a conservative cap of eight. */
export function defaultWhisperThreads(): number {
  return Math.min(8, Math.max(1, availableParallelism()));
}

function validateWhisperThreads(threads: number | undefined): number {
  const value = threads ?? defaultWhisperThreads();
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new Error("The Whisper thread count must be an integer from 1 through 64.");
  }
  return value;
}

function validateWhisperLanguage(language: string): void {
  if (!/^[A-Za-z-]{1,16}$/u.test(language)) {
    throw new Error("The Whisper language must be a language code or auto.");
  }
}

/** Run one bounded, already prepared audio window through the local whisper.cpp CLI. */
export async function transcribeWhisperPreview(options: {
  preview: AudioPreview;
  executable: string;
  model: string;
  language: string;
  diarizeSpeakerTurns?: boolean;
  threads?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const executable = resolve(options.executable);
  const model = resolve(options.model);
  if (!(await stat(executable)).isFile() || !(await stat(model)).isFile()) {
    throw new Error("Whisper executable and model must be regular files.");
  }
  validateWhisperLanguage(options.language);
  const threads = validateWhisperThreads(options.threads);

  const directory = await mkdtemp(join(tmpdir(), "tutorux-live-whisper-"));
  const audioPath = join(directory, "audio.wav");
  const outputBase = join(directory, "transcript");
  const outputPath = `${outputBase}.json`;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let childProcess: ReturnType<typeof spawn> | undefined;
  let forceStopTimer: NodeJS.Timeout | undefined;
  const timeout = setTimeout(
    () => {
      controller.abort();
      forceStopTimer = setTimeout(() => {
        if (childProcess && childProcess.exitCode === null && childProcess.signalCode === null) {
          try {
            childProcess.kill("SIGKILL");
          } catch {
            childProcess.kill();
          }
        }
      }, 5_000);
    },
    10 * 60 * 1000,
  );
  try {
    await writeFile(audioPath, whisperAudio(options.preview), { mode: 0o600 });
    await new Promise<void>((accept, reject) => {
      const child = spawn(
        executable,
        [
          "-m",
          model,
          "-f",
          audioPath,
          "-l",
          options.language,
          "-oj",
          "-of",
          outputBase,
          "-np",
          "-t",
          String(threads),
          ...(options.diarizeSpeakerTurns ? ["-tdrz"] : []),
        ],
        { stdio: "ignore", windowsHide: true, signal: controller.signal },
      );
      childProcess = child;
      let failedToStart = false;
      child.once("error", () => {
        failedToStart = true;
      });
      child.once("close", (code) => {
        if (forceStopTimer) clearTimeout(forceStopTimer);
        if (code === 0 && !failedToStart) {
          accept();
        } else {
          reject(
            new Error(
              controller.signal.aborted
                ? "Whisper exceeded the ten-minute window limit."
                : failedToStart
                  ? "Could not start Whisper."
                  : "Whisper could not transcribe this audio. Check the executable and model.",
            ),
          );
        }
      });
    });
    const metadata = await stat(outputPath);
    if (!metadata.isFile() || metadata.size > MAX_WHISPER_OUTPUT_BYTES) {
      throw new Error("Whisper output is invalid or too large.");
    }
    return await readFile(outputPath, "utf8");
  } finally {
    clearTimeout(timeout);
    if (forceStopTimer) clearTimeout(forceStopTimer);
    options.signal?.removeEventListener("abort", abortFromCaller);
    await rm(directory, { recursive: true, force: true });
  }
}

export interface LiveWhisperOptions {
  executable: string;
  model: string;
  language: string;
  diarizeSpeakerTurns?: boolean;
  threads?: number;
}

/**
 * Live transcription keeps one whisper.cpp server process (and therefore one loaded
 * model) alive for every audio window. When whisper-server is not installed the
 * session falls back to one CLI run per window and reports that it was not reused.
 */
export class LiveWhisperSession {
  private constructor(
    private readonly options: LiveWhisperOptions,
    private readonly server?: {
      url: string;
      child: ReturnType<typeof spawn>;
    },
    private readonly fallbackReason = "",
  ) {}

  get reusedProcess(): boolean {
    return this.server !== undefined;
  }

  get reuseWarning(): string {
    return this.fallbackReason;
  }

  static async create(options: LiveWhisperOptions): Promise<LiveWhisperSession> {
    const executable = resolve(options.executable);
    const model = resolve(options.model);
    if (!(await stat(executable)).isFile() || !(await stat(model)).isFile()) {
      throw new Error("Whisper executable and model must be regular files.");
    }
    validateWhisperLanguage(options.language);
    const threads = validateWhisperThreads(options.threads);
    const serverExecutable = await resolveWhisperServerExecutable(executable);
    if (!serverExecutable) {
      return new LiveWhisperSession(
        { ...options, threads },
        undefined,
        "whisper-server was not found; live windows reload the model through whisper-cli.",
      );
    }
    const port = await findFreePort();
    const args = [
      "-m",
      model,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-t",
      String(threads),
      ...(options.diarizeSpeakerTurns ? ["-tdrz"] : []),
    ];
    const child = spawn(serverExecutable, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    let startupError = "";
    child.once("error", (error: Error) => {
      startupError = error.message;
    });
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (startupError) {
        child.kill();
        throw new Error(`Could not start whisper-server: ${startupError}`);
      }
      if (child.exitCode !== null) {
        throw new Error("whisper-server stopped before it accepted transcription requests.");
      }
      try {
        await fetch(`${url}/`, { signal: AbortSignal.timeout(1_000) });
        return new LiveWhisperSession({ ...options, threads }, { url, child });
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      }
    }
    child.kill();
    throw new Error("whisper-server did not become ready within 30 seconds.");
  }

  async transcribe(preview: AudioPreview, signal?: AbortSignal): Promise<string> {
    if (!this.server) {
      return transcribeWhisperPreview({
        preview,
        executable: this.options.executable,
        model: this.options.model,
        language: this.options.language,
        ...(this.options.threads === undefined ? {} : { threads: this.options.threads }),
        ...(this.options.diarizeSpeakerTurns === undefined
          ? {}
          : { diarizeSpeakerTurns: this.options.diarizeSpeakerTurns }),
        ...(signal === undefined ? {} : { signal }),
      });
    }
    const form = new FormData();
    form.set(
      "file",
      new Blob([new Uint8Array(whisperAudio(preview))], { type: "audio/wav" }),
      "audio.wav",
    );
    form.set("response_format", "json");
    form.set("temperature", "0.0");
    if (this.options.language !== "auto") form.set("language", this.options.language);
    const response = await fetch(`${this.server.url}/inference`, {
      method: "POST",
      body: form,
      ...(signal === undefined ? {} : { signal }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text.trim() || `whisper-server returned HTTP ${String(response.status)}.`);
    }
    if (!text.trim() || text.length > MAX_WHISPER_OUTPUT_BYTES) {
      throw new Error("Whisper output is invalid or too large.");
    }
    return text;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const child = this.server.child;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        child.kill();
      }
    }
    await new Promise<void>((resolveClose) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveClose();
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveClose();
      }, 5_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }
}

async function resolveWhisperServerExecutable(executable: string): Promise<string | undefined> {
  const configured = process.env["TUTORUX_WHISPER_SERVER"]?.trim();
  const candidates = [
    ...(configured ? [resolve(configured)] : []),
    ...(/whisper-server(?:\.exe)?$/iu.test(executable)
      ? [executable]
      : [
          join(dirname(executable), "whisper-server"),
          join(dirname(executable), "whisper-server.exe"),
        ]),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port) resolvePort(port);
        else rejectPort(new Error("Could not reserve a local whisper-server port."));
      });
    });
  });
}

interface WhisperOptions {
  snapshot: ArchiveSnapshot;
  sessionId: string;
  trackId: string;
  executable: string;
  model: string;
  language: string;
  startUs: bigint;
  endUs?: bigint;
  refine: boolean;
  diarizeSpeakerTurns?: boolean;
  threads?: number;
  progress: (message: string) => void;
  commit?: (
    records: readonly ArchiveRecord[],
    expectedGeneration: bigint,
  ) => Promise<ArchiveRecord[]>;
  expectedGeneration?: bigint;
}

interface WhisperTrackResult {
  changes: ArchiveRecord[];
  generated: number;
  superseded: number;
  skipped: number;
  speakerTurnBoundaries: number;
  windows: number;
  threads: number;
}

/** Run whisper.cpp locally over bounded recording windows, without invoking a shell. */
export async function transcribeTrack(options: WhisperOptions): Promise<WhisperTrackResult> {
  const executable = resolve(options.executable);
  const model = resolve(options.model);
  if (!(await stat(executable)).isFile() || !(await stat(model)).isFile()) {
    throw new Error("Whisper executable and model must be regular files.");
  }
  validateWhisperLanguage(options.language);
  const threads = validateWhisperThreads(options.threads);
  if ((options.commit === undefined) !== (options.expectedGeneration === undefined)) {
    throw new Error("Incremental transcription needs both a commit callback and a generation.");
  }
  const chunks = await options.snapshot.listAudioChunkMetadata(options.sessionId, options.trackId);
  const last = chunks.at(-1);
  const firstFrame = last?.fields.get("first_sample_index") ?? "";
  const count = last?.fields.get("sample_count") ?? "";
  const rate = last?.fields.get("sample_rate_hz") ?? "";
  const channels = last?.fields.get("channel_count") ?? "";
  const sampleFormat = last?.fields.get("sample_format") ?? "pcm_s16le";
  if (
    ![firstFrame, count, rate, channels].every((value) => /^\d+$/u.test(value)) ||
    BigInt(rate) === 0n ||
    BigInt(channels) === 0n
  )
    throw new Error("Recording audio metadata is invalid.");
  const bytesPerSample = captureBytesPerSample(sampleFormat);
  const trackEnd =
    ((BigInt(firstFrame) + BigInt(count)) * 1_000_000n + BigInt(rate) - 1n) / BigInt(rate);
  const end = options.endUs === undefined || options.endUs > trackEnd ? trackEnd : options.endUs;
  if (options.startUs < 0n || end <= options.startUs)
    throw new Error("The selected recording range is empty.");
  const seconds = transcriptionWindowSeconds(Number(rate), Number(channels), bytesPerSample);
  if (seconds < 1n) throw new Error("The recording format exceeds the transcription window limit.");
  const windowUs = (seconds < 20n ? seconds : 20n) * 1_000_000n;
  const existing = await options.snapshot.listRecords(RecordType.transcriptSegment);
  const changes = new Map<string, ArchiveRecord>();
  const directory = await mkdtemp(join(tmpdir(), "tutorux-whisper-"));
  const audioPath = join(directory, "audio.wav");
  const outputBase = join(directory, "transcript");
  const outputPath = `${outputBase}.json`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const runId = randomUUID();
  let skipped = 0;
  let windows = 0;
  let generated = 0;
  let superseded = 0;
  let speakerTurnBoundaries = 0;
  let generation = options.expectedGeneration ?? 0n;
  const committedIds = new Set<string>();
  const commitPending = async (): Promise<void> => {
    if (!options.commit || changes.size === 0) return;
    const pending = [...changes.values()].filter((record) => !committedIds.has(record.id));
    changes.clear();
    if (!pending.length) return;
    try {
      await options.commit(pending, generation);
    } catch (error) {
      for (const record of pending) changes.set(record.id, record);
      throw error;
    }
    for (const record of pending) committedIds.add(record.id);
    generation += 1n;
    for (const record of pending) {
      if (record.fields.get("_deleted") === "true") superseded += 1;
      else {
        generated += 1;
        if (record.fields.get("speaker_turn_next") === "true") speakerTurnBoundaries += 1;
      }
    }
  };
  try {
    for (let cursor = options.startUs; cursor < end; cursor += windowUs) {
      if (controller.signal.aborted) throw new Error("Transcription cancelled.");
      const windowEnd = cursor + windowUs < end ? cursor + windowUs : end;
      const preview = await buildAudioPreview(
        options.snapshot,
        options.sessionId,
        options.trackId,
        cursor,
        windowEnd,
      );
      await writeFile(audioPath, whisperAudio(preview), { mode: 0o600 });
      await rm(outputPath, { force: true });
      await new Promise<void>((accept, reject) => {
        const child = spawn(
          executable,
          [
            "-m",
            model,
            "-f",
            audioPath,
            "-l",
            options.language,
            "-oj",
            "-of",
            outputBase,
            "-np",
            "-t",
            String(threads),
            ...(options.diarizeSpeakerTurns ? ["-tdrz"] : []),
          ],
          { stdio: "ignore", windowsHide: true, signal: controller.signal },
        );
        let failedToStart = false;
        child.once("error", () => {
          failedToStart = true;
        });
        child.once("close", (code) =>
          code === 0 && !failedToStart
            ? accept()
            : reject(
                new Error(
                  controller.signal.aborted
                    ? "Transcription cancelled."
                    : failedToStart
                      ? "Could not start Whisper."
                      : "Whisper could not transcribe this audio. Check your executable and model.",
                ),
              ),
        );
      });
      const metadata = await stat(outputPath);
      if (!metadata.isFile() || metadata.size > MAX_WHISPER_OUTPUT_BYTES)
        throw new Error("Whisper output is invalid or too large.");
      const result = makeWhisperRecords({
        json: await readFile(outputPath, "utf8"),
        sessionId: options.sessionId,
        trackId: options.trackId,
        modelName: basename(model),
        language: options.language,
        preview,
        existing,
        replaceProvisional: options.refine,
        runId,
        ...(options.diarizeSpeakerTurns === undefined
          ? {}
          : { diarizeSpeakerTurns: options.diarizeSpeakerTurns }),
      });
      for (const record of result.records) changes.set(record.id, record);
      if (!options.commit) {
        if (changes.size > 100_000)
          throw new Error("The transcription produced too many cues for one operation.");
      }
      skipped += result.skipped;
      await commitPending();
      options.progress(`Processed audio window ${++windows}.`);
    }
    if (controller.signal.aborted) throw new Error("Transcription cancelled.");
    await commitPending();
    const records = options.commit ? [] : [...changes.values()];
    const finalSuperseded = options.commit
      ? superseded
      : records.filter((record) => record.fields.get("_deleted") === "true").length;
    const finalGenerated = options.commit ? generated : records.length - finalSuperseded;
    const finalSpeakerTurns = options.commit
      ? speakerTurnBoundaries
      : records.filter(
          (record) =>
            record.fields.get("_deleted") !== "true" &&
            record.fields.get("speaker_turn_next") === "true",
        ).length;
    return {
      changes: records,
      generated: finalGenerated,
      superseded: finalSuperseded,
      skipped,
      speakerTurnBoundaries: finalSpeakerTurns,
      windows,
      threads,
    };
  } catch (error) {
    if (options.commit) {
      try {
        await commitPending();
      } catch (commitError) {
        const detail = commitError instanceof Error ? commitError.message : String(commitError);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} Saving completed transcript batches also failed: ${detail}`, {
          cause: commitError,
        });
      }
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await rm(directory, { recursive: true, force: true });
  }
}
