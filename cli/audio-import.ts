import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

const MAX_STDERR_BYTES = 32 * 1024;
const DECODER_TIMEOUT_MS = 10 * 60 * 1_000;

export interface PreparedAudioImport {
  path: string;
  sourceFilename: string;
  sourceCodec?: "flac" | "mp3" | "m4a";
  validateSourceUnchanged: () => Promise<void>;
  cleanup: () => Promise<void>;
}

/** Validate the source and decode compressed audio to a bounded temporary PCM WAVE file. */
export async function prepareAudioImport(
  inputPath: string,
  ffmpeg: string,
): Promise<PreparedAudioImport> {
  const sourcePath = resolve(inputPath);
  let sourceInfo;
  try {
    sourceInfo = await lstat(sourcePath);
  } catch {
    throw new Error("Audio source file could not be opened.");
  }
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new Error("Audio source must be a regular, non-symlink file.");
  }
  const validateSourceUnchanged = async (): Promise<void> => {
    const latest = await lstat(sourcePath).catch(() => null);
    if (
      !latest ||
      latest.isSymbolicLink() ||
      !latest.isFile() ||
      latest.size !== sourceInfo.size ||
      latest.mtimeMs !== sourceInfo.mtimeMs ||
      latest.ctimeMs !== sourceInfo.ctimeMs ||
      latest.dev !== sourceInfo.dev ||
      latest.ino !== sourceInfo.ino
    ) {
      throw new Error("The audio source changed during import. Retry with an unchanged file.");
    }
  };

  const sourceFilename = basename(sourcePath);
  const extension = extname(sourceFilename).toLowerCase();
  if (extension === ".wav" || extension === ".wave") {
    return {
      path: sourcePath,
      sourceFilename,
      validateSourceUnchanged,
      cleanup: async () => undefined,
    };
  }
  if (extension !== ".flac" && extension !== ".mp3" && extension !== ".m4a") {
    throw new Error("Audio import supports WAV, FLAC, MP3, and M4A sources.");
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "tutorux-audio-import-"));
  const decodedPath = join(temporaryDirectory, "decoded.wav");
  try {
    await decodeCompressedAudio(sourcePath, decodedPath, ffmpeg);
    await validateSourceUnchanged();
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    path: decodedPath,
    sourceFilename,
    sourceCodec: extension.slice(1) as NonNullable<PreparedAudioImport["sourceCodec"]>,
    validateSourceUnchanged,
    cleanup: async () => await rm(temporaryDirectory, { recursive: true, force: true }),
  };
}

async function decodeCompressedAudio(
  sourcePath: string,
  destinationPath: string,
  ffmpeg: string,
): Promise<void> {
  const child = spawn(
    ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "-n",
      destinationPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  let stderr = "";
  let timedOut = false;
  let spawnError: Error | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, DECODER_TIMEOUT_MS);
  const forceKill = setTimeout(() => child.kill("SIGKILL"), DECODER_TIMEOUT_MS + 5_000);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClose) => {
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    },
  );
  child.once("error", (error: Error) => {
    spawnError = error;
    child.kill();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_BYTES) {
      stderr += chunk.toString("utf8").slice(0, MAX_STDERR_BYTES - stderr.length);
    }
  });

  try {
    const exit = await closed;
    if (spawnError) {
      throw new Error(`Could not start FFmpeg audio decoding: ${spawnError.message}`);
    }
    if (timedOut) throw new Error("FFmpeg audio decoding exceeded the 10-minute time limit.");
    if (exit.code !== 0) {
      throw new Error(
        stderr.trim() || `FFmpeg audio decoding exited with code ${String(exit.code)}.`,
      );
    }
    const decodedInfo = await lstat(destinationPath).catch(() => null);
    if (!decodedInfo?.isFile() || decodedInfo.isSymbolicLink() || decodedInfo.size < 12) {
      throw new Error("FFmpeg did not produce a valid decoded WAVE file.");
    }
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKill);
  }
}
