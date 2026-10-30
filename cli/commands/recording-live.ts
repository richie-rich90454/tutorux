import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { canonicalizeProgressUuid } from "../../frontend/domain/student-progress";
import { recordLiveSource, recordLiveSynchronized, resolveFfmpegCommand } from "../live-recording";
import type { RecordingDurability } from "../live-recording";
import {
    resolveNativeAudioHelper,
    selectNativeApplicationAudioDevice,
} from "../native-audio-helper";
import { type RecordingControlWorker } from "../recording-control";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { requireLiveRecord } from "./record-helpers";
import {
    isArchiveRecordingActive,
    startDetachedRecordingCommand,
} from "./recording-control-command";
import { CliError, emit, field, parseBoundedOption, requiredOption } from "./shared";
import type { CliIo, ParsedArguments } from "./shared";

export async function runLiveRecordingCommand(
    path: string,
    args: ParsedArguments,
    output: CliIo,
    signal?: AbortSignal,
    recordingControl?: RecordingControlWorker,
): Promise<number> {
    const json = args.flags.has("json");
    if (args.positionals.length)
        throw new CliError("record start does not accept positional arguments.");
    if (!args.flags.has("consent"))
        throw new CliError("Recording requires explicit confirmation with --consent.");
    if (
        [
            "source",
            "device",
            "microphone",
            "playback",
            "application",
            "language",
            "threads",
            "window-seconds",
            "confirmed-by",
        ].some((name) => args.flags.has(name))
    )
        throw new CliError("A recording option is missing its value.");
    if (args.options.has("system-audio"))
        throw new CliError("--system-audio is a flag and does not accept a value.");
    if (args.flags.has("ffmpeg")) throw new CliError("--ffmpeg requires an executable path.");
    const sourceOption = args.options.get("source");
    const source = sourceOption ?? (args.flags.has("system-audio") ? "system-audio" : "microphone");
    if (!["microphone", "system-audio", "loopback", "both", "application"].includes(source)) {
        throw new CliError(
            "Recording source must be 'microphone', 'system-audio', 'application', or 'both'.",
        );
    }
    const requestedSource = source === "loopback" ? "system-audio" : source;
    const deviceOption = args.options.get("device");
    const microphoneOption = args.options.get("microphone");
    const playbackOption = args.options.get("playback");
    const applicationOption = args.options.get("application");
    for (const [name, value] of [
        ["--device", deviceOption],
        ["--microphone", microphoneOption],
        ["--playback", playbackOption],
        ["--application", applicationOption],
    ] as const) {
        if (value !== undefined && !value.trim()) throw new CliError(`${name} cannot be empty.`);
    }
    let requestsMicrophone = false;
    let requestsSystemAudio = false;
    let requestsApplicationAudio = false;
    if (requestedSource === "both") {
        requestsMicrophone = true;
        if (applicationOption !== undefined && args.flags.has("system-audio")) {
            throw new CliError(
                "Choose one synchronized secondary track with --application or --system-audio.",
            );
        }
        requestsSystemAudio = applicationOption === undefined;
        requestsApplicationAudio = applicationOption !== undefined;
    } else if (requestedSource === "microphone") {
        requestsMicrophone = true;
        requestsSystemAudio = args.flags.has("system-audio");
        if (applicationOption !== undefined) {
            throw new CliError(
                "Use --application only with --source application or --source both.",
            );
        }
    } else if (requestedSource === "application") {
        requestsApplicationAudio = true;
        if (
            args.flags.has("system-audio") ||
            microphoneOption !== undefined ||
            playbackOption !== undefined
        ) {
            throw new CliError(
                "Application-only capture accepts --device or --application, not microphone or system-audio selectors.",
            );
        }
    } else {
        requestsSystemAudio = true;
        requestsMicrophone = microphoneOption !== undefined;
        if (applicationOption !== undefined) {
            throw new CliError(
                "Use --application only with --source application or --source both.",
            );
        }
    }
    if (applicationOption !== undefined && playbackOption !== undefined) {
        throw new CliError(
            "Select one synchronized secondary track with --application or --playback.",
        );
    }
    if (microphoneOption !== undefined && !requestsMicrophone) {
        throw new CliError("Use --microphone only when the microphone source is enabled.");
    }
    if (playbackOption !== undefined && !requestsSystemAudio) {
        throw new CliError("Use --playback only when system-audio capture is enabled.");
    }
    if (!requestsMicrophone && !requestsSystemAudio && !requestsApplicationAudio) {
        throw new CliError("Choose at least one supported recording source.");
    }
    if (
        requestsMicrophone &&
        (requestsSystemAudio || requestsApplicationAudio) &&
        deviceOption !== undefined
    ) {
        throw new CliError(
            "Use source-specific selectors to choose synchronized inputs; --device is only for one source.",
        );
    }
    if (
        deviceOption !== undefined &&
        (microphoneOption !== undefined ||
            playbackOption !== undefined ||
            applicationOption !== undefined)
    ) {
        throw new CliError("Choose --device or source-specific audio selectors, not both.");
    }
    const device =
        deviceOption ??
        (requestsMicrophone
            ? microphoneOption
            : requestsApplicationAudio
              ? applicationOption
              : playbackOption);
    const inputFormatValue = args.options.get("input-format");
    if (args.flags.has("input-format"))
        throw new CliError("--input-format requires pulse or alsa.");
    if (
        inputFormatValue !== undefined &&
        inputFormatValue !== "pulse" &&
        inputFormatValue !== "alsa"
    )
        throw new CliError("--input-format must be pulse or alsa.");
    if (requestsApplicationAudio && !requestsMicrophone && inputFormatValue !== undefined) {
        throw new CliError(
            "--input-format applies to FFmpeg microphone capture, not application audio.",
        );
    }

    const liveWhisper = args.flags.has("live-transcribe");
    const diarize = args.flags.has("diarize");
    if (liveWhisper && requestsMicrophone && (requestsSystemAudio || requestsApplicationAudio)) {
        throw new CliError(
            "Live transcription requires one captured track. Start a single source or transcribe the synchronized tracks after recording.",
        );
    }
    const whisperOptionsPresent = [
        "whisper",
        "model",
        "language",
        "threads",
        "window-seconds",
    ].some((name) => args.options.has(name));
    if (diarize && !liveWhisper) throw new CliError("Use --diarize with --live-transcribe.");
    if (!liveWhisper && (whisperOptionsPresent || args.flags.has("consent-local-audio")))
        throw new CliError("Whisper options require --live-transcribe.");
    if (liveWhisper && !args.flags.has("consent-local-audio"))
        throw new CliError(
            "Use --consent-local-audio to authorize local Whisper processing during recording.",
        );
    if (args.flags.has("consent-local-audio") && !liveWhisper)
        throw new CliError("--consent-local-audio requires --live-transcribe.");
    if (!liveWhisper && (args.flags.has("whisper") || args.flags.has("model")))
        throw new CliError("--whisper and --model require values.");

    let whisper:
        | {
              executable: string;
              model: string;
              language: string;
              windowSeconds: number;
              threads?: number;
              diarizeSpeakerTurns: boolean;
          }
        | undefined;
    if (liveWhisper) {
        if (["language", "threads", "window-seconds"].some((name) => args.flags.has(name)))
            throw new CliError("A Whisper option is missing its value.");
        const executable = requiredOption(args, "whisper");
        const model = requiredOption(args, "model");
        const language = args.options.get("language") ?? "auto";
        const windowSeconds = parseBoundedOption(
            args.options.get("window-seconds"),
            "window-seconds",
            5,
            1,
            27,
        );
        const threads = args.options.has("threads")
            ? parseBoundedOption(args.options.get("threads"), "threads", 1, 1, 64)
            : undefined;
        whisper = {
            executable,
            model,
            language,
            windowSeconds,
            ...(threads === undefined ? {} : { threads }),
            diarizeSpeakerTurns: diarize,
        };
    }

    const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
    if (!sessionId) throw new CliError("--session must be a valid UUID.");
    const durationSeconds = args.options.has("duration-seconds")
        ? parseBoundedOption(
              args.options.get("duration-seconds"),
              "duration-seconds",
              1,
              1,
              604_800,
          )
        : undefined;
    if (args.flags.has("duration-seconds"))
        throw new CliError("--duration-seconds requires a value.");
    const consentConfirmedBy = args.options.get("confirmed-by")?.trim() ?? "CLI user";
    if (
        !consentConfirmedBy ||
        consentConfirmedBy.length > 256 ||
        /[\r\n\0]/u.test(consentConfirmedBy)
    )
        throw new CliError(
            "--confirmed-by must be a non-empty, single-line label up to 256 characters.",
        );

    const ffmpegValue = args.options.get("ffmpeg");
    if (args.options.has("ffmpeg") && !ffmpegValue?.trim())
        throw new CliError("--ffmpeg cannot be empty.");
    const ffmpeg = resolveFfmpegCommand(ffmpegValue);
    const applicationCapture = requestsApplicationAudio
        ? await (async () => {
              const helper = await resolveNativeAudioHelper();
              const device = await selectNativeApplicationAudioDevice(
                  helper,
                  applicationOption ?? deviceOption,
              );
              return { helper, device };
          })()
        : undefined;
    const snapshot = await openForCommand(path);
    let session: ArchiveRecord;
    let expectedGeneration: bigint;
    let knownTrackIds: string[];
    let transcriptRecords: ArchiveRecord[];
    let configuredMicrophone: string;
    let configuredPlayback: string;
    let configuredDurability: RecordingDurability;
    try {
        session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
        expectedGeneration = snapshot.commit.generation;
        if (isArchiveRecordingActive(field(session, "recording_state"))) {
            throw new CliError(
                `Session ${sessionId} already has an active recording state. Check record status or recover the saved take before starting another recording.`,
            );
        }
        const metadata = await snapshot.listRecordMetadata(RecordType.assetMetadata);
        const settings = await snapshot.listRecords(RecordType.settings);
        configuredMicrophone =
            settings
                .find(
                    (record) =>
                        field(record, "record_role") === "setting" &&
                        field(record, "key") === "recording.microphone_device_id",
                )
                ?.fields.get("value") ?? "default";
        configuredPlayback =
            settings
                .find(
                    (record) =>
                        field(record, "record_role") === "setting" &&
                        field(record, "key") === "recording.playback_device_id",
                )
                ?.fields.get("value") ?? "default";
        const durability = settings
            .find(
                (record) =>
                    field(record, "record_role") === "setting" &&
                    field(record, "key") === "recording.durability",
            )
            ?.fields.get("value");
        configuredDurability =
            durability === "maximum" || durability === "reduced-write" ? durability : "default";
        knownTrackIds = metadata
            .filter(
                (record) =>
                    field(record, "record_role") === "audio-track" &&
                    field(record, "session_id").toLowerCase() === sessionId,
            )
            .map((record) => field(record, "track_id", record.id));
        transcriptRecords = (await snapshot.listRecords(RecordType.transcriptSegment)).filter(
            (record) => field(record, "session_id").toLowerCase() === sessionId,
        );
    } finally {
        await closeSnapshot(snapshot);
    }

    if (args.flags.has("detach")) {
        return await startDetachedRecordingCommand(path, args, output, signal);
    }

    const commit = async (records: readonly ArchiveRecord[], generation: bigint) =>
        await mutateArchive(
            path,
            records,
            generation,
            "The archive changed during live recording. Stop, recover the saved take, then retry.",
        );
    const inputOptions = {
        ...(inputFormatValue === undefined
            ? {}
            : { inputFormat: inputFormatValue as "pulse" | "alsa" }),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        durability: configuredDurability,
        consentConfirmedBy,
        progress: (message: string) => output.stderr(message),
        ...(signal === undefined ? {} : { signal }),
        ...(recordingControl === undefined ? {} : { recordingControl }),
        commit,
    };
    const result =
        requestsMicrophone && (requestsSystemAudio || requestsApplicationAudio)
            ? await recordLiveSynchronized({
                  sessionId,
                  session,
                  knownTrackIds,
                  expectedGeneration,
                  ffmpeg,
                  ...inputOptions,
                  ...((microphoneOption ?? configuredMicrophone) === "default"
                      ? {}
                      : { microphoneDevice: microphoneOption ?? configuredMicrophone }),
                  ...(applicationCapture
                      ? { applicationCapture }
                      : playbackOption === undefined
                        ? { systemAudioDevice: configuredPlayback }
                        : { systemAudioDevice: playbackOption }),
              })
            : await recordLiveSource({
                  sessionId,
                  session,
                  knownTrackIds,
                  transcriptRecords,
                  expectedGeneration,
                  ffmpeg,
                  source: requestsApplicationAudio
                      ? "application-audio"
                      : requestsSystemAudio
                        ? "system-audio"
                        : "microphone",
                  ...inputOptions,
                  ...(device === undefined
                      ? requestsSystemAudio
                          ? { device: configuredPlayback }
                          : configuredMicrophone === "default"
                            ? {}
                            : { device: configuredMicrophone }
                      : device === "default"
                        ? requestsSystemAudio
                            ? { device }
                            : {}
                        : { device }),
                  ...(applicationCapture === undefined ? {} : { applicationCapture }),
                  ...(whisper === undefined ? {} : { whisper }),
              });
    emit(
        output,
        result,
        (result.source === "both"
            ? `Synchronized recording ${result.state}: ${result.durationUs} microseconds across ${result.tracks.length} separate tracks and ${result.chunkCount} checkpoints.`
            : `Recording ${result.state}: ${result.durationUs} microseconds saved in ${result.chunkCount} checkpoint(s).`) +
            (result.source !== "both" && result.liveTranscriptSegmentCount
                ? ` Saved ${result.liveTranscriptSegmentCount} provisional Whisper cue(s).`
                : "") +
            (result.error ? ` ${result.error}` : "") +
            (result.source !== "both" && result.liveTranscriptionError
                ? ` Live transcription stopped: ${result.liveTranscriptionError}`
                : ""),
        json,
    );
    return result.state === "completed" ? 0 : 1;
}
