import { openAsBlob } from "node:fs";
import { resolve } from "node:path";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { prepareAudioImport } from "../audio-import";
import { canonicalizeProgressUuid } from "../../frontend/domain/student-progress";
import { makeWaveImportRecordsIncremental } from "../../frontend/domain/wav";
import { buildAudioTrackWavExport, listSessionAudioTracks } from "../../frontend/domain/audio";
import { mixRecordingTracksIncremental } from "../../frontend/domain/audio-mix";
import {
  buildWaveformIndex,
  readWaveformIndex,
  waveformIndexIsCurrent,
  type WaveformBucket,
} from "../../frontend/domain/waveform-index";
import { resolveFfmpegCommand } from "../live-recording";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import {
  CliError,
  emit,
  field,
  parseBoundedOption,
  requiredOption,
  sameFileIdentity,
} from "./shared";
import { requireLiveRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";
import { writeAudioStreamAtomically } from "./recording-playback";

/** Combine a stored pyramid level into exactly the requested bucket count. */
function downsampleWaveformBuckets(
  buckets: readonly WaveformBucket[],
  limit: number,
): WaveformBucket[] {
  const count = Math.min(limit, buckets.length);
  if (count === buckets.length) return [...buckets];
  const result: WaveformBucket[] = [];
  for (let index = 0; index < count; index++) {
    const start = Math.floor((index * buckets.length) / count);
    const end = Math.floor(((index + 1) * buckets.length) / count);
    const slice = buckets.slice(start, Math.max(start + 1, end));
    result.push({
      startFrame: slice[0]!.startFrame,
      endFrame: slice.at(-1)!.endFrame,
      minimum: Math.min(...slice.map((bucket) => bucket.minimum)),
      maximum: Math.max(...slice.map((bucket) => bucket.maximum)),
      containsGap: slice.some((bucket) => bucket.containsGap),
    });
  }
  return result;
}

export async function runRecordingAudioCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
  if (!sessionId) throw new CliError("--session must be a valid UUID.");
  const snapshot = await openForCommand(path);
  const generation = snapshot.commit.generation;
  let changes: ArchiveRecord[] = [];
  let result: unknown;
  let message: string;
  try {
    let session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
    const assets = await snapshot.listRecordMetadata(RecordType.assetMetadata);
    const tracks = listSessionAudioTracks(session, assets);
    if (action === "mix") {
      const takeId = canonicalizeProgressUuid(requiredOption(args, "take"));
      const trackIds = requiredOption(args, "tracks")
        .split(",")
        .map((id) => canonicalizeProgressUuid(id.trim()));
      if (!takeId || trackIds.some((id) => !id))
        throw new CliError("--take and --tracks require valid UUIDs.");
      let expectedGeneration = generation;
      const mixLabel = args.options.get("label");
      const mixed = await mixRecordingTracksIncremental({
        snapshot,
        sessionId,
        takeId,
        trackIds: trackIds as string[],
        ...(mixLabel === undefined ? {} : { label: mixLabel }),
        expectedGeneration,
        commit: async (records, expected) => {
          const saved = await mutateArchive(
            path,
            records,
            expected,
            "The archive changed during mixing. Retry with the current archive.",
          );
          expectedGeneration = expected + 1n;
          return saved;
        },
      });
      changes = [];
      result = {
        session_id: sessionId,
        take_id: takeId,
        track_id: mixed.trackId,
        sample_format: "pcm_s16le",
        sample_rate_hz: mixed.sampleRateHz,
        channel_count: 2,
        frame_count: mixed.frameCount,
        duration_us: mixed.durationUs,
        chunk_count: mixed.chunkCount,
      };
      message = `Created mixdown track ${mixed.trackId}.`;
    } else if (action === "import") {
      const input = resolve(requiredOption(args, "input"));
      if (await sameFileIdentity(input, path))
        throw new CliError("Audio input cannot be the archive itself.");
      const capture = args.options.get("capture-source");
      if (capture) {
        if (
          !["browser-microphone", "browser-system-audio"].includes(capture) ||
          !args.flags.has("consent")
        )
          throw new CliError("Browser capture requires an accepted capture source and --consent.");
        const timestamp = requiredOption(args, "capture-consent-at-us");
        if (!/^[1-9]\d*$/u.test(timestamp))
          throw new CliError(
            "Capture consent timestamp must be a positive integer in microseconds.",
          );
        session = {
          ...session,
          fields: new Map(session.fields)
            .set("audio_import_capture_source", capture)
            .set("audio_import_capture_consent_at_us", timestamp)
            .set("audio_import_capture_consent_policy", "1"),
        };
      } else if (args.flags.has("consent") || args.options.has("capture-consent-at-us"))
        throw new CliError("Consent metadata requires --capture-source.");
      if (args.flags.has("ffmpeg")) throw new CliError("--ffmpeg requires an executable path.");
      const ffmpegValue = args.options.get("ffmpeg");
      if (args.options.has("ffmpeg") && !ffmpegValue?.trim())
        throw new CliError("--ffmpeg cannot be empty.");
      const prepared = await prepareAudioImport(input, resolveFfmpegCommand(ffmpegValue));
      let imported: Awaited<ReturnType<typeof makeWaveImportRecordsIncremental>>;
      try {
        const blob = await openAsBlob(prepared.path);
        let expectedGeneration = generation;
        imported = await makeWaveImportRecordsIncremental({
          session,
          file: {
            name: prepared.sourceFilename,
            size: blob.size,
            slice: (start, end) => blob.slice(start, end),
          },
          allowAdditionalTrack: args.flags.has("additional-track"),
          knownTrackIds: tracks.map((track) => track.id),
          sourceMetadata: prepared.sourceCodec
            ? {
                sourceFilename: prepared.sourceFilename,
                sourceCodec: prepared.sourceCodec,
              }
            : { sourceFilename: prepared.sourceFilename },
          expectedGeneration,
          commit: async (records, expected) => {
            const saved = await mutateArchive(
              path,
              records,
              expected,
              "The archive changed during audio import. Recover or review it and try again.",
            );
            expectedGeneration = expected + 1n;
            return saved;
          },
        });
        await prepared.validateSourceUnchanged();
      } finally {
        await prepared.cleanup();
      }
      changes = [];
      result = {
        session_id: sessionId,
        track_id: imported.trackId,
        take_id: imported.takeId,
        sample_format: imported.sampleFormat,
        sample_rate_hz: imported.sampleRateHz,
        channel_count: imported.channelCount,
        sample_count: imported.sampleCount.toString(),
        chunk_count: imported.chunkCount,
        duration_us: imported.durationUs.toString(),
        byte_count: imported.byteCount,
        state: "completed",
      };
      message = `Imported ${imported.chunkCount} audio chunks as track ${imported.trackId}.`;
    } else {
      const trackId = args.options.get("track")?.toLowerCase() ?? tracks[0]?.id;
      if (!trackId || !tracks.some((track) => track.id === trackId))
        throw new CliError("Select an available audio track for this session.");
      if (action === "waveform-index-build") {
        const index = await buildWaveformIndex(snapshot, sessionId, trackId);
        changes = [index];
        result = {
          id: index.id,
          session_id: sessionId,
          track_id: trackId,
          level_count: field(index, "level_count"),
          base_bucket_count: field(index, "base_bucket_count"),
          timeline_frame_count: field(index, "timeline_frame_count"),
          source_fingerprint: field(index, "source_fingerprint"),
        };
        message = `Built waveform index for track ${trackId} with ${field(index, "level_count")} levels.`;
      } else if (action === "waveform-index-show") {
        const index = (await snapshot.listRecords(RecordType.waveformIndex)).find(
          (record) =>
            field(record, "record_role") === "waveform-pyramid" &&
            field(record, "session_id").toLowerCase() === sessionId &&
            field(record, "track_id").toLowerCase() === trackId,
        );
        if (!index) throw new CliError("This track has no saved waveform index. Build one first.");
        const levels = readWaveformIndex(index);
        const level = parseBoundedOption(
          args.options.get("level"),
          "level",
          0,
          0,
          levels.length - 1,
        );
        const current = await waveformIndexIsCurrent(snapshot, index);
        const buckets = levels[level]!.map((bucket) => ({
          start_frame: bucket.startFrame.toString(),
          end_frame: bucket.endFrame.toString(),
          minimum: bucket.minimum,
          maximum: bucket.maximum,
          contains_gap: bucket.containsGap,
        }));
        result = {
          id: index.id,
          session_id: sessionId,
          track_id: trackId,
          level,
          level_count: levels.length,
          current,
          buckets,
        };
        message = `Waveform index for track ${trackId}: level ${level + 1} of ${levels.length}, ${buckets.length} buckets${current ? "" : " (source changed; rebuild recommended)"}.`;
      } else if (action === "waveform") {
        const limit = parseBoundedOption(args.options.get("buckets"), "buckets", 512, 1, 8192);
        const stored = (await snapshot.listRecords(RecordType.waveformIndex)).find(
          (record) =>
            field(record, "record_role") === "waveform-pyramid" &&
            field(record, "session_id").toLowerCase() === sessionId &&
            field(record, "track_id").toLowerCase() === trackId,
        );
        let index = stored;
        let levels: WaveformBucket[][] | undefined;
        if (stored && (await waveformIndexIsCurrent(snapshot, stored))) {
          try {
            levels = readWaveformIndex(stored);
          } catch {
            levels = undefined;
          }
        }
        if (!levels) {
          index = await buildWaveformIndex(snapshot, sessionId, trackId);
          changes = [index];
          levels = readWaveformIndex(index);
        }
        const base = downsampleWaveformBuckets(levels[0]!, limit);
        const buckets = base.map((bucket, bucketIndex) => ({
          track_id: trackId,
          sample_rate_hz: Number(field(index!, "sample_rate_hz")),
          channel_count: Number(field(index!, "channel_count")),
          bucket: bucketIndex,
          start_frame: Number(bucket.startFrame),
          end_frame: Number(bucket.endFrame),
          minimum: bucket.minimum,
          maximum: bucket.maximum,
          contains_gap: bucket.containsGap,
        }));
        result = buckets.map((bucket) => ({
          track_id: bucket.track_id,
          sample_rate_hz: String(bucket.sample_rate_hz),
          channel_count: String(bucket.channel_count),
          bucket: String(bucket.bucket),
          start_frame: String(bucket.start_frame),
          end_frame: String(bucket.end_frame),
          minimum: String(bucket.minimum),
          maximum: String(bucket.maximum),
          contains_gap: bucket.contains_gap ? "true" : "false",
        }));
        const glyphs = " .:-=+*#@";
        message = `Waveform for track ${trackId}\nAmplitude: ${buckets.map((bucket) => glyphs[Math.floor((Math.max(Math.abs(bucket.minimum), Math.abs(bucket.maximum)) * (glyphs.length - 1)) / 32768)]).join("")}\nGaps:      ${buckets.map((bucket) => (bucket.contains_gap ? "!" : " ")).join("")}`;
      } else {
        const destination = resolve(requiredOption(args, "output"));
        if (await sameFileIdentity(destination, path))
          throw new CliError("WAV output cannot replace its source archive.");
        const chunks = await snapshot.listAudioChunkMetadata(sessionId, trackId);
        const hasGaps = chunks.some(
          (chunk) => BigInt(field(chunk, "gap_before_samples") || "0") > 0n,
        );
        if (hasGaps && !args.flags.has("fill-gaps"))
          throw new CliError(
            "This recording contains gaps. Use --fill-gaps to insert silence explicitly.",
          );
        const exported = await buildAudioTrackWavExport(snapshot, sessionId, trackId);
        await writeAudioStreamAtomically(destination, exported.stream, args.flags.has("overwrite"));
        const rate = BigInt(field(chunks[0]!, "sample_rate_hz") || "0");
        result = {
          session_id: sessionId,
          track_id: trackId,
          destination,
          sample_format: field(chunks[0]!, "sample_format"),
          sample_rate_hz: rate.toString(),
          channel_count: field(chunks[0]!, "channel_count"),
          sample_count: exported.sampleCount.toString(),
          chunk_count: String(chunks.length),
          duration_us: rate === 0n ? "0" : ((exported.sampleCount * 1_000_000n) / rate).toString(),
          data_bytes: exported.dataBytes.toString(),
          container: exported.rf64 ? "RF64" : "RIFF/WAVE",
          inserted_silence_for_gaps: hasGaps ? "true" : "false",
        };
        message = `Exported audio track ${trackId} to ${destination}.`;
      }
    }
  } finally {
    await closeSnapshot(snapshot);
  }
  if (changes.length) await mutateArchive(path, changes, generation);
  emit(output, result, message, args.flags.has("json"));
  return 0;
}
