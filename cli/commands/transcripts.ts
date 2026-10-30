import { lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { availableParallelism } from "node:os";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { canonicalizeProgressUuid } from "../../frontend/domain/student-progress";
import {
  correctTranscriptRecord,
  formatTranscriptExport,
  mergeTranscriptRecords,
  parseTranscriptTimestamp,
  resolveTranscriptFormat,
  setTranscriptSpeaker,
  setTranscriptTimestamp,
  setTranscriptVerification,
  sortTranscriptRecords,
  splitTranscriptRecord,
  type TranscriptExportFormat,
} from "../../frontend/domain/transcript";
import { listSessionAudioTracks } from "../../frontend/domain/audio";
import { importTranscriptBatches } from "../../frontend/audio/transcript-import";
import { transcribeTrack } from "../whisper";
import { closeSnapshot, mutateArchive, openForCommand, writeTextAtomically } from "./archive-io";
import {
  CliError,
  emit,
  field,
  parseBoundedOption,
  requiredOption,
  requiredPosition,
  timestampNow,
} from "./shared";
import { requireLiveRecord, toFlatTranscriptRecord, transcriptTimeRange } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runTranscriptionPlan(
  path: string,
  args: ParsedArguments,
  output: CliIo,
  detailed: boolean,
): Promise<number> {
  const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
  if (!sessionId) throw new CliError("--session must be a valid UUID.");
  const trackValue = args.options.get("track");
  const trackId = trackValue ? canonicalizeProgressUuid(trackValue) : undefined;
  if (trackValue && !trackId) throw new CliError("--track must be a valid UUID.");
  const threads = parseBoundedOption(
    args.options.get("threads"),
    "threads",
    0,
    detailed ? 1 : 0,
    64,
  );
  const modelMemory = parseBoundedOption(
    args.options.get("model-memory-mb"),
    "model-memory-mb",
    detailed ? 0 : 512,
    detailed ? 1 : 0,
    1_048_576,
  );
  const availableMemory = parseBoundedOption(
    args.options.get("available-memory-mb"),
    "available-memory-mb",
    0,
    detailed ? 1 : 0,
    1_048_576,
  );
  const hardware = Math.max(1, availableParallelism());
  const snapshot = await openForCommand(path);
  try {
    const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
    if (!detailed) {
      const effectiveThreads = threads || Math.min(8, hardware);
      const estimatedMemory = modelMemory + 128 + effectiveThreads * 16;
      const feasible = availableMemory === 0 || estimatedMemory <= availableMemory;
      const result = {
        session_id: sessionId,
        track_id: trackId ?? "",
        duration_us: field(session, "audio_duration_us") || "0",
        threads: effectiveThreads,
        model_memory_mb: modelMemory,
        estimated_memory_mb: estimatedMemory,
        available_memory_mb: availableMemory,
        available_known: availableMemory !== 0,
        feasible,
      };
      emit(
        output,
        result,
        `Transcription plan: ${effectiveThreads} thread(s), ${estimatedMemory} MB estimated working memory${availableMemory ? `, ${feasible ? "within" : "above"} the available ${availableMemory} MB` : "; available memory not supplied"}.`,
        args.flags.has("json"),
      );
      return 0;
    }
    let workers = Math.min(Math.max(1, hardware - 1), threads || hardware);
    if (!modelMemory || !availableMemory) workers = 1;
    else {
      const memoryWorkers = Math.floor(availableMemory / modelMemory);
      if (!memoryWorkers)
        throw new CliError("The transcription model exceeds the available memory budget.");
      workers = Math.min(workers, memoryWorkers);
    }
    const assets = await snapshot.listRecordMetadata(RecordType.assetMetadata);
    const tracks = listSessionAudioTracks(session, assets).filter(
      (track) => !trackId || track.id.toLowerCase() === trackId,
    );
    const work: {
      work_id: string;
      track_id: string;
      start_time_us: string;
      end_time_us: string;
      priority: number;
      provisional: boolean;
    }[] = [];
    let count = 0;
    let estimated = 0n;
    for (const track of tracks) {
      const chunks = await snapshot.listAudioChunkMetadata(sessionId, track.id);
      let duration = 0n;
      for (const chunk of chunks) {
        const raw = field(chunk, "timeline_end_us") || "0";
        if (!/^\d+$/u.test(raw)) throw new CliError("Audio timeline metadata is invalid.");
        const end = BigInt(raw);
        if (end > duration) duration = end;
      }
      if (!duration) continue;
      count += 1;
      const elapsed = (duration + BigInt(workers) - 1n) / BigInt(workers);
      if (elapsed > estimated) estimated = elapsed;
      if ((duration + 29_999_999n) / 30_000_000n > BigInt(100_000 - work.length))
        throw new CliError("Transcription plan exceeds the 100,000 work item limit.");
      for (let start = 0n; start < duration; start += 30_000_000n) {
        const end = start + 30_000_000n < duration ? start + 30_000_000n : duration;
        work.push({
          work_id: `${sessionId}:${track.id}:${start}`,
          track_id: track.id,
          start_time_us: start.toString(),
          end_time_us: end.toString(),
          priority: 2,
          provisional: true,
        });
      }
    }
    if (!count) throw new CliError("The session has no audio chunks for the selected track.");
    const result = {
      session_id: sessionId,
      track_count: count,
      chunk_count: work.length,
      worker_count: workers,
      estimated_work_duration_us: estimated.toString(),
      work,
    };
    emit(
      output,
      result,
      `Transcription plan: ${count} track(s), ${work.length} bounded work item(s), ${workers} worker(s), estimated ${estimated} µs elapsed.\n${work.map((item) => `  ${item.track_id} [${item.start_time_us}, ${item.end_time_us})`).join("\n")}`,
      args.flags.has("json"),
    );
    return 0;
  } finally {
    await closeSnapshot(snapshot);
  }
}

export async function runTranscriptCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  const sessionId = args.options.get("session") ?? "";

  if (action === "plan") return runTranscriptionPlan(path, args, output, false);

  if (action === "transcribe" || action === "generate" || action === "refine") {
    const selectedSession = requiredOption(args, "session");
    const trackValue = args.options.get("track");
    const language = args.options.get("language") ?? "auto";
    if (args.flags.has("threads")) throw new CliError("--threads requires a value.");
    const threads = args.options.has("threads")
      ? parseBoundedOption(args.options.get("threads"), "threads", 1, 1, 64)
      : undefined;
    const startUs = args.options.has("start")
      ? parseTranscriptTimestamp(requiredOption(args, "start"))
      : 0n;
    const endUs = args.options.has("end")
      ? parseTranscriptTimestamp(requiredOption(args, "end"))
      : undefined;
    const snapshot = await openForCommand(path);
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, selectedSession);
      const generation = snapshot.commit.generation;
      const assets = await snapshot.listRecordMetadata(RecordType.assetMetadata);
      const tracks = listSessionAudioTracks(session, assets);
      if (!tracks.length) throw new CliError("The session has no recorded audio track.");
      const requestedTrack = trackValue?.toLowerCase();
      const track =
        requestedTrack === undefined
          ? tracks[0]!
          : tracks.find((candidate) => candidate.id.toLowerCase() === requestedTrack);
      if (!track) throw new CliError("--track must select an audio track in this session.");
      const trackId = track.id;
      let model = args.options.get("model");
      if (model && !isAbsolute(model)) model = resolve(dirname(resolve(path)), model);
      if (!model) {
        const activeModels = (await snapshot.listRecords(RecordType.settings)).filter(
          (record) =>
            field(record, "record_role") === "model-reference" &&
            field(record, "_deleted") !== "true" &&
            field(record, "active") === "true" &&
            ["whisper", "whisper.cpp", "local-whisper"].includes(field(record, "provider")),
        );
        if (activeModels.length > 1)
          throw new CliError(
            "More than one local Whisper model is active; pass --model FILE to choose one.",
          );
        const referenced = activeModels[0] ? field(activeModels[0], "path") : "";
        if (referenced) model = resolve(dirname(resolve(path)), referenced);
      }
      if (!model) throw new CliError("Select an active local Whisper model or pass --model FILE.");
      const executable =
        args.options.get("whisper") ?? process.env["TUTORUX_WHISPER"] ?? "whisper-cli";
      const chunks = await snapshot.listAudioChunkMetadata(selectedSession, trackId);
      const lastChunk = chunks.at(-1);
      const rate = BigInt(lastChunk ? field(lastChunk, "sample_rate_hz", "0") : "0");
      const frames = lastChunk
        ? BigInt(field(lastChunk, "first_sample_index", "0")) +
          BigInt(field(lastChunk, "sample_count", "0"))
        : 0n;
      const audioDurationUs = rate === 0n ? "0" : ((frames * 1_000_000n) / rate).toString();
      let expectedGeneration = generation;
      const result = await transcribeTrack({
        snapshot,
        sessionId: selectedSession,
        trackId,
        executable,
        model,
        language,
        startUs,
        ...(endUs === undefined ? {} : { endUs }),
        refine: action === "refine",
        diarizeSpeakerTurns: args.flags.has("diarize"),
        ...(threads === undefined ? {} : { threads }),
        progress: (message) => {
          if (!json) output.stderr(message);
        },
        expectedGeneration,
        commit: async (records, expected) => {
          const saved = await mutateArchive(
            path,
            records,
            expected,
            "The archive changed during transcription. Review it and try again.",
          );
          expectedGeneration = expected + 1n;
          return saved;
        },
      });
      if (result.generated || result.superseded || result.skipped) {
        const fields = new Map(session.fields);
        fields.set("processing_state", "review-required");
        fields.set(
          "processing_detail",
          "Local transcription is provisional and ready for tutor review.",
        );
        fields.set("processing_updated_at_us", timestampNow());
        await mutateArchive(
          path,
          [{ ...session, fields }],
          expectedGeneration,
          "The archive changed during transcription. Review it and try again.",
        );
      }
      const diarizationEnabled = args.flags.has("diarize");
      emit(
        output,
        {
          session_id: selectedSession,
          track_id: trackId,
          created_segment_count: String(result.generated),
          superseded_segment_count: String(result.superseded),
          preserved_human_segment_count: String(result.skipped),
          diarization_enabled: diarizationEnabled ? "true" : "false",
          diarization_scope: diarizationEnabled
            ? "experimental-speaker-turn-boundaries-only"
            : "disabled",
          diarization_model_requirement: diarizationEnabled
            ? "TDRZ-compatible Whisper model required"
            : "not-applicable",
          speaker_turn_boundary_count: String(result.speakerTurnBoundaries),
          audio_duration_us: audioDurationUs,
          model: basename(model),
          backend: "whisper.cpp-cli",
          threads: result.threads,
          verification_state: "provisional",
          generated: result.generated,
          superseded: result.superseded,
          skipped: result.skipped,
          speaker_turn_boundaries: result.speakerTurnBoundaries,
          windows: result.windows,
        },
        `Generated ${result.generated} provisional cue(s), replaced ${result.superseded}, skipped ${result.skipped}.${args.flags.has("diarize") ? ` Tiny diarization marked ${result.speakerTurnBoundaries} speaker-turn boundaries; assign speaker identities manually.` : ""} Review generated cues before reuse.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "import") {
    if (!sessionId) throw new CliError("--session is required.");
    const inputPath = args.options.get("input") ?? args.positionals[0];
    if (!inputPath) throw new CliError("--input is required.");
    const inputAbsolutePath = resolve(inputPath);
    const metadata = await lstat(inputAbsolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new CliError("Transcript input must be a regular, non-symlink file.");
    if (metadata.size > 256 * 1024 * 1024)
      throw new CliError("Transcript source exceeds the configured 256 MiB limit.");
    const format = resolveTranscriptFormat(args.options.get("format") ?? "auto", inputAbsolutePath);
    const snapshot = await openForCommand(path);
    let session: ArchiveRecord;
    let expectedGeneration: bigint;
    try {
      session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      expectedGeneration = snapshot.commit.generation;
    } finally {
      await closeSnapshot(snapshot);
    }
    const imported = await importTranscriptBatches({
      source: createReadStream(inputAbsolutePath),
      format,
      sessionId,
      filename: basename(inputAbsolutePath),
      expectedGeneration,
      commit: async (records, expected) => {
        const saved = await mutateArchive(path, records, expected);
        expectedGeneration = expected + 1n;
        return saved;
      },
    });
    if (imported.imported > 0) {
      const fields = new Map(session.fields);
      fields.set("processing_state", "review-required");
      fields.set(
        "processing_detail",
        "Imported transcript is provisional and ready for tutor review.",
      );
      fields.set("processing_updated_at_us", timestampNow());
      await mutateArchive(path, [{ ...session, fields }], expectedGeneration);
    }
    emit(
      output,
      {
        session_id: sessionId,
        source_format: format,
        imported_segment_count: String(imported.imported),
        verification_state: "provisional",
      },
      `Imported ${imported.imported} transcript segment(s) from ${format}; all imported text is provisional pending tutor review.`,
      json,
    );
    return 0;
  }

  if (action === "history" || action === "restore") {
    const id = requiredPosition(args, 0, "transcript segment ID");
    const snapshot = await openForCommand(path);
    let snapshotClosed = false;
    try {
      const expectedGeneration = snapshot.commit.generation;
      const limit = parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000);
      const history = await snapshot.getRecordHistory(RecordType.transcriptSegment, id, limit);
      if (history.length === 0) throw new CliError(`Transcript segment was not found: ${id}`);
      if (action === "history") {
        const rows = history.map((record, historyIndex) => ({
          history_index: historyIndex,
          ...toFlatTranscriptRecord(record),
        }));
        const summary = history
          .map(
            (record, historyIndex) =>
              `${historyIndex}: revision ${record.revision.toString()}${field(record, "_deleted") === "true" ? " (removed)" : ""}`,
          )
          .join("\n");
        emit(output, rows, summary || "No transcript revisions found.", json);
        return 0;
      }

      const revision = parseBoundedOption(args.options.get("revision"), "revision", -1, 1, 10_000);
      const selected = history[revision];
      if (!selected) throw new CliError(`Transcript history index ${revision} was not found.`);
      const fields = new Map(selected.fields);
      fields.delete("_deleted");
      fields.delete("deleted_at_us");
      fields.set("restored_from_revision", revision.toString());
      fields.set("updated_at_us", timestampNow());
      const restored = { ...selected, fields };
      await closeSnapshot(snapshot);
      snapshotClosed = true;
      const [saved] = await mutateArchive(path, [restored], expectedGeneration);
      emit(
        output,
        toFlatTranscriptRecord(saved ?? restored),
        `Transcript revision ${revision} restored as a new revision.`,
        json,
      );
      return 0;
    } finally {
      if (!snapshotClosed) await closeSnapshot(snapshot);
    }
  }

  if (["show", "search", "export"].includes(action)) {
    if (!sessionId) throw new CliError("--session is required.");
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
      records = (await snapshot.listRecords(RecordType.transcriptSegment)).filter(
        (record) => field(record, "session_id") === sessionId,
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const query = args.options.get("query");
    if (action === "search" && !query)
      throw new CliError("--query is required for transcript search.");
    if (query !== undefined)
      records = records.filter((record) => field(record, "text").includes(query));
    records = sortTranscriptRecords(records);
    if (action === "export") {
      const format = args.options.get("format") ?? "text";
      if (format !== "text" && format !== "srt" && format !== "vtt" && format !== "json") {
        throw new CliError("Transcript export format must be text, srt, vtt, or json.");
      }
      const destination = resolve(requiredOption(args, "output"));
      const text = formatTranscriptExport(records, format as TranscriptExportFormat);
      await writeTextAtomically(destination, text);
      emit(
        output,
        { output: destination, format, segment_count: String(records.length) },
        `Exported ${format} transcript to ${destination}.`,
        json,
      );
      return 0;
    }
    if (json) {
      emit(
        output,
        records.map(toFlatTranscriptRecord),
        `${records.length} transcript segment(s).`,
        true,
      );
    } else {
      const lines = records.map(
        (record) => `[${transcriptTimeRange(record)}] ${field(record, "text")}`,
      );
      output.stdout(lines.length ? lines.join("\n") : "No transcript segments found.");
    }
    return 0;
  }

  if (action === "split" || action === "merge") {
    const ids =
      action === "split" ? [requiredPosition(args, 0, "transcript segment ID")] : args.positionals;
    if (action === "merge" && ids.length < 2) {
      throw new CliError("Provide at least two transcript segment IDs to merge.");
    }
    const snapshot = await openForCommand(path);
    let changes: ArchiveRecord[];
    let generation: bigint;
    try {
      generation = snapshot.commit.generation;
      const records: ArchiveRecord[] = [];
      for (const id of ids) {
        records.push(await requireLiveRecord(snapshot, RecordType.transcriptSegment, id));
      }
      if (action === "split") {
        const before = args.options.get("before");
        const after = args.options.get("after");
        if (before === undefined || after === undefined) {
          throw new CliError("--before and --after are required.");
        }
        changes = splitTranscriptRecord(records[0]!, before, after, args.options.get("at"));
      } else {
        changes = mergeTranscriptRecords(records, args.options.get("separator") ?? " ");
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = await mutateArchive(path, changes, generation);
    const result = action === "split" ? (saved[1] ?? changes[1]!) : (saved[0] ?? changes[0]!);
    emit(
      output,
      toFlatTranscriptRecord(result),
      action === "split"
        ? `Transcript segment split into ${changes[0]!.id} and ${changes[1]!.id}.`
        : `Merged ${ids.length} transcript segments.`,
      json,
    );
    return 0;
  }

  if (["correct", "timestamp", "verify", "speaker"].includes(action)) {
    const id = requiredPosition(args, 0, "transcript segment ID");
    const snapshot = await openForCommand(path);
    let updated: ArchiveRecord;
    let expectedGeneration: bigint;
    try {
      expectedGeneration = snapshot.commit.generation;
      const current = await requireLiveRecord(snapshot, RecordType.transcriptSegment, id);
      if (action === "correct") {
        const text = args.options.get("text");
        if (text === undefined || text.length === 0) throw new CliError("--text is required.");
        updated = correctTranscriptRecord(current, text);
      } else if (action === "timestamp") {
        const start = args.options.get("start");
        const end = args.options.get("end");
        if (!start || !end) throw new CliError("--start and --end are required.");
        updated = setTranscriptTimestamp(current, start, end);
      } else if (action === "verify") {
        const state = args.options.get("state") ?? "human-verified";
        if (state !== "human-verified" && state !== "provisional" && state !== "needs-review") {
          throw new CliError(
            "Verification state must be human-verified, provisional, or needs-review.",
          );
        }
        updated = setTranscriptVerification(current, state);
      } else {
        const nameProvided = args.options.has("name");
        const speakerProvided = args.options.has("speaker");
        const label = args.options.get("name") ?? args.options.get("speaker");
        if (args.flags.has("unknown") && (nameProvided || speakerProvided))
          throw new CliError("Use either --unknown or a speaker name, not both.");
        if (args.flags.has("unknown")) {
          updated = setTranscriptSpeaker(current, null);
        } else if (label !== undefined && label.length > 0) {
          updated = setTranscriptSpeaker(current, label);
        } else {
          throw new CliError("Provide --name <label>, --speaker <label>, or --unknown.");
        }
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [updated], expectedGeneration);
    emit(
      output,
      toFlatTranscriptRecord(saved ?? updated),
      `Updated transcript segment ${id}.`,
      json,
    );
    return 0;
  }

  throw new CliError(`transcript ${action} is not implemented in the TypeScript CLI yet.`);
}
