import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { Writable } from "node:stream";
import type { AudioTrackPcmRange } from "../frontend/domain/audio";

const STDERR_CAPTURE_LIMIT = 32 * 1024;

export interface AudioPlaybackResult {
  completed: boolean;
  cancelled: boolean;
  submittedFrames: bigint;
  error: string;
}

/** Play a streamed PCM range through the host's FFmpeg `ffplay` executable. */
export async function playAudioRange(
  range: AudioTrackPcmRange,
  executableValue: string | undefined,
  signal?: AbortSignal,
  progress: (message: string) => void = () => {},
): Promise<AudioPlaybackResult> {
  if (signal?.aborted) {
    await range.stream.cancel();
    return { completed: false, cancelled: true, submittedFrames: 0n, error: "" };
  }
  const executable = resolveCommand(executableValue?.trim() || "ffplay");
  const reader = range.stream.getReader();
  let submittedFrames = 0n;
  let cancelled = false;
  let forceStop = false;
  let stderr = "";
  let forceStopTimer: NodeJS.Timeout | undefined;

  const child = spawn(
    executable,
    [
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(range.sampleRateHz),
      "-ac",
      String(range.channelCount),
      "-i",
      "pipe:0",
    ],
    { stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
  );
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < STDERR_CAPTURE_LIMIT) {
      stderr += chunk.toString("utf8").slice(0, STDERR_CAPTURE_LIMIT - stderr.length);
    }
  });
  child.stdin.on("error", () => {});

  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolveClose) => {
    child.once("error", (error: Error) => resolveClose({ code: null, signal: null, error }));
    child.once("close", (code, signalName) => resolveClose({ code, signal: signalName }));
  });

  const stop = (force = false): void => {
    cancelled = true;
    forceStop ||= force;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (forceStop || process.platform === "win32") child.kill();
      else child.kill("SIGINT");
    } catch {
      child.kill();
    }
    void reader.cancel().catch(() => {});
    if (!forceStop && !forceStopTimer) {
      forceStopTimer = setTimeout(() => stop(true), 5_000);
    }
  };
  const onInterrupt = (): void => stop(cancelled);
  const onTerminate = (): void => stop();
  const onAbort = (): void => stop();
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    if (cancelled) {
      child.stdin.destroy();
    } else {
      progress("Playing archive audio through ffplay; press Ctrl+C to stop.");
      const bytesPerFrame = BigInt(range.channelCount * 2);
      while (!cancelled) {
        const item = await reader.read();
        if (item.done) break;
        if (item.value.byteLength % Number(bytesPerFrame) !== 0) {
          throw new Error("The selected recording produced an incomplete audio frame.");
        }
        await writeInput(child.stdin, item.value);
        submittedFrames += BigInt(item.value.byteLength) / bytesPerFrame;
      }
      if (!cancelled) child.stdin.end();
    }
    const exit = await closed;
    if (forceStopTimer) clearTimeout(forceStopTimer);
    if (exit.error) {
      const errno = (exit.error as NodeJS.ErrnoException).code;
      const detail =
        errno === "ENOENT"
          ? `${exit.error.message}. Install an FFmpeg build that includes ffplay or pass its path with --ffplay.`
          : exit.error.message;
      return {
        completed: false,
        cancelled,
        submittedFrames,
        error: `Could not start ffplay: ${detail}`,
      };
    }
    if (cancelled) return { completed: false, cancelled, submittedFrames, error: "" };
    if (exit.code !== 0) {
      const detail = stderr.trim();
      return {
        completed: false,
        cancelled: false,
        submittedFrames,
        error: `ffplay exited with code ${String(exit.code)}${detail ? `: ${detail}` : ""}`,
      };
    }
    return { completed: true, cancelled: false, submittedFrames, error: "" };
  } catch (error) {
    stop(true);
    await closed;
    const message = error instanceof Error ? error.message : String(error);
    return {
      completed: false,
      cancelled: false,
      submittedFrames,
      error: message,
    };
  } finally {
    if (forceStopTimer) clearTimeout(forceStopTimer);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) stop(true);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function writeInput(input: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    input.write(bytes, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function resolveCommand(value: string): string {
  return value.includes("\\") || value.includes("/") || isAbsolute(value) ? resolve(value) : value;
}
