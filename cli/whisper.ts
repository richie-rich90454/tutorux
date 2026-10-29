import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { RecordType, type ArchiveRecord } from "../frontend/archive/format";
import type { ArchiveSnapshot } from "../frontend/archive/archive";
import { buildAudioPreview } from "../frontend/domain/audio";
import { makeWhisperRecords, whisperAudio } from "../frontend/domain/whisper";

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
  progress: (message: string) => void;
}

/** Run whisper.cpp locally over bounded recording windows, without invoking a shell. */
export async function transcribeTrack(options: WhisperOptions): Promise<{
  changes: ArchiveRecord[];
  generated: number;
  superseded: number;
  skipped: number;
  speakerTurnBoundaries: number;
  windows: number;
}> {
  const executable = resolve(options.executable);
  const model = resolve(options.model);
  if (!(await stat(executable)).isFile() || !(await stat(model)).isFile()) {
    throw new Error("Whisper executable and model must be regular files.");
  }
  if (!/^[A-Za-z-]{1,16}$/u.test(options.language)) {
    throw new Error("The Whisper language must be a language code or auto.");
  }
  const chunks = await options.snapshot.listAudioChunkMetadata(options.sessionId, options.trackId);
  const last = chunks.at(-1);
  const firstFrame = last?.fields.get("first_sample_index") ?? "";
  const count = last?.fields.get("sample_count") ?? "";
  const rate = last?.fields.get("sample_rate_hz") ?? "";
  const channels = last?.fields.get("channel_count") ?? "";
  if (
    ![firstFrame, count, rate, channels].every((value) => /^\d+$/u.test(value)) ||
    BigInt(rate) === 0n ||
    BigInt(channels) === 0n
  )
    throw new Error("Recording audio metadata is invalid.");
  const trackEnd =
    ((BigInt(firstFrame) + BigInt(count)) * 1_000_000n + BigInt(rate) - 1n) / BigInt(rate);
  const end = options.endUs === undefined || options.endUs > trackEnd ? trackEnd : options.endUs;
  if (options.startUs < 0n || end <= options.startUs)
    throw new Error("The selected recording range is empty.");
  const seconds = (28n * 1024n * 1024n) / (BigInt(rate) * BigInt(channels) * 2n);
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
      if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024)
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
      if (changes.size > 100_000)
        throw new Error("The transcription produced too many cues for one operation.");
      skipped += result.skipped;
      options.progress(`Processed audio window ${++windows}.`);
    }
    if (controller.signal.aborted) throw new Error("Transcription cancelled.");
    const records = [...changes.values()];
    const superseded = records.filter((record) => record.fields.get("_deleted") === "true").length;
    return {
      changes: records,
      generated: records.length - superseded,
      superseded,
      skipped,
      speakerTurnBoundaries: records.filter(
        (record) =>
          record.fields.get("_deleted") !== "true" &&
          record.fields.get("speaker_turn_next") === "true",
      ).length,
      windows,
    };
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await rm(directory, { recursive: true, force: true });
  }
}
