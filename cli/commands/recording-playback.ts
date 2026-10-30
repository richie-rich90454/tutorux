import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RecordType } from "../../frontend/archive/format";
import { canonicalizeProgressUuid } from "../../frontend/domain/student-progress";
import { buildAudioTrackPcmRangeStream } from "../../frontend/domain/audio";
import { playAudioRange } from "../record-playback";
import { closeSnapshot, openForCommand, replaceFile } from "./archive-io";
import { CliError, emit, field, requiredOption } from "./shared";
import { requireLiveRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function writeAudioStreamAtomically(
  destination: string,
  stream: ReadableStream<Uint8Array>,
  overwrite: boolean,
): Promise<void> {
  const temporary = join(dirname(destination), `.tutorux-${randomUUID()}.partial`);
  const file = await open(temporary, "wx", 0o600);
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      await file.writeFile(chunk.value);
    }
    await file.sync();
    await file.close();
    if (overwrite) await replaceFile(temporary, destination);
    else {
      await link(temporary, destination);
      await rm(temporary, { force: true });
    }
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function runRecordingPlaybackCommand(
  path: string,
  args: ParsedArguments,
  output: CliIo,
  signal?: AbortSignal,
): Promise<number> {
  if (args.positionals.length)
    throw new CliError("record play does not accept positional arguments.");
  const optionValue = (name: string): string | undefined => {
    if (args.flags.has(name)) throw new CliError(`--${name} requires a value.`);
    const value = args.options.get(name);
    if (value === "") throw new CliError(`--${name} cannot be empty.`);
    return value;
  };
  const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
  if (!sessionId) throw new CliError("--session must be a valid UUID.");
  const requestedTrack = optionValue("track");
  const trackId =
    requestedTrack === undefined ? undefined : canonicalizeProgressUuid(requestedTrack);
  if (requestedTrack !== undefined && !trackId) throw new CliError("--track must be a valid UUID.");
  const startFrameValue = parsePlaybackUnsignedOption(args, "start-frame");
  const startUsValue = parsePlaybackUnsignedOption(args, "start-us");
  const durationFramesValue = parsePlaybackUnsignedOption(args, "duration-frames");
  const durationUsValue = parsePlaybackUnsignedOption(args, "duration-us");
  if (
    (startFrameValue !== undefined && startUsValue !== undefined) ||
    (durationFramesValue !== undefined && durationUsValue !== undefined)
  ) {
    throw new CliError("Choose either a frame or microsecond value for each playback position.");
  }
  if (durationFramesValue === 0n)
    throw new CliError("Playback duration must be greater than zero.");
  const ffplay = optionValue("ffplay");
  const snapshot = await openForCommand(path);
  let report: Record<string, unknown>;
  let completed = true;
  let cancelled = false;
  let exitStatus = 0;
  try {
    await requireLiveRecord(snapshot, RecordType.session, sessionId);
    let selectedTrackId = trackId;
    if (selectedTrackId === undefined) {
      const chunkRecords = await snapshot.listRecordMetadata(RecordType.audioChunk);
      const sessionTrackIds = new Set(
        chunkRecords
          .filter((record) => field(record, "session_id").toLowerCase() === sessionId)
          .map((record) => field(record, "track_id").toLowerCase())
          .filter(Boolean),
      );
      if (sessionTrackIds.size === 0)
        throw new CliError("The selected session contains no audio tracks.");
      if (sessionTrackIds.size !== 1)
        throw new CliError("This session has multiple audio tracks. Select one explicitly.");
      selectedTrackId = [...sessionTrackIds][0]!;
    }

    const chunkMetadata = await snapshot.listAudioChunkMetadata(sessionId, selectedTrackId);
    if (!chunkMetadata.length)
      throw new CliError("The selected session track has no committed audio chunks.");
    const sampleRateHz = Number(field(chunkMetadata[0]!, "sample_rate_hz"));
    if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 384_000)
      throw new CliError("The selected track has an invalid sample rate.");
    const startFrame =
      startUsValue === undefined
        ? (startFrameValue ?? 0n)
        : playbackMicrosecondsToFrames(startUsValue, sampleRateHz, "Playback start time");
    const maximumFrames =
      durationUsValue === undefined
        ? durationFramesValue
        : playbackMicrosecondsToFrames(durationUsValue, sampleRateHz, "Playback duration");
    if (durationUsValue !== undefined && maximumFrames === 0n) {
      throw new CliError("The requested playback duration is shorter than one audio frame.");
    }

    const range = await buildAudioTrackPcmRangeStream(
      snapshot,
      sessionId,
      selectedTrackId,
      startFrame,
      maximumFrames,
    );
    let submittedFrames = 0n;
    let gapFramesPlayed: string | null = range.gapFramesPlayed.toString();
    if (range.playedFrames === 0n) {
      await range.stream.cancel();
    } else {
      const playback = await playAudioRange(range, ffplay, signal, (message) => {
        if (!args.flags.has("json")) output.stdout(message);
      });
      if (playback.error) throw new Error(playback.error);
      completed = playback.completed;
      cancelled = playback.cancelled;
      submittedFrames = playback.submittedFrames;
      if (!completed) {
        gapFramesPlayed = null;
        exitStatus = cancelled ? 130 : 1;
      }
    }
    const playedFrames = completed ? range.playedFrames : submittedFrames;
    const playbackDurationUs = (playedFrames * 1_000_000n) / BigInt(range.sampleRateHz);
    report = {
      session_id: sessionId,
      track_id: range.trackId,
      sample_rate_hz: String(range.sampleRateHz),
      channel_count: String(range.channelCount),
      start_frame: range.startFrame.toString(),
      timeline_frame_count: range.timelineFrameCount.toString(),
      played_frames: playedFrames.toString(),
      frames_submitted_to_player: submittedFrames.toString(),
      gap_frames_played: gapFramesPlayed,
      duration_us: (playbackDurationUs > 18_446_744_073_709_551_615n
        ? 18_446_744_073_709_551_615n
        : playbackDurationUs
      ).toString(),
      completed,
    };
  } finally {
    await closeSnapshot(snapshot);
  }

  const summary = completed
    ? `Played ${String(report["played_frames"])} frame(s) from track ${String(report["track_id"])}.`
    : cancelled
      ? `Playback stopped after submitting ${String(report["frames_submitted_to_player"])} frame(s) to ffplay. The player may have buffered additional audio.`
      : `Playback stopped after submitting ${String(report["frames_submitted_to_player"])} frame(s) to ffplay.`;
  emit(output, report, summary, args.flags.has("json"));
  return exitStatus;
}

export function parsePlaybackUnsignedOption(
  args: ParsedArguments,
  name: string,
): bigint | undefined {
  if (args.flags.has(name)) throw new CliError(`--${name} requires a non-negative integer.`);
  const value = args.options.get(name);
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new CliError(`--${name} must be a non-negative integer.`);
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n)
    throw new CliError(`--${name} exceeds the supported playback range.`);
  return parsed;
}

export function playbackMicrosecondsToFrames(
  value: bigint,
  sampleRateHz: number,
  label: string,
): bigint {
  const rate = BigInt(sampleRateHz);
  const wholeSeconds = value / 1_000_000n;
  const remainingUs = value % 1_000_000n;
  const maximum = 18_446_744_073_709_551_615n;
  if (wholeSeconds > maximum / rate)
    throw new CliError(`${label} exceeds the supported audio timeline.`);
  const wholeFrames = wholeSeconds * rate;
  const partialFrames = (remainingUs * rate) / 1_000_000n;
  if (partialFrames > maximum - wholeFrames)
    throw new CliError(`${label} exceeds the supported audio timeline.`);
  return wholeFrames + partialFrames;
}
