import {
  enumerateFfmpegAudioDevices,
  resolveFfmpegCommand,
  type FfmpegAudioDevice,
} from "../live-recording";
import {
  listNativeApplicationAudioDevices,
  listNativeCaptureDevices,
} from "../native-audio-helper";
import { inspectRecordingSources } from "../record-test";
import { CliError, emit } from "./shared";
import type { CliIo, ParsedArguments } from "./shared";

export async function runRecordingDevicesCommand(
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  if (args.positionals.length)
    throw new CliError("record devices does not accept positional arguments.");
  if (args.flags.has("ffmpeg")) throw new CliError("--ffmpeg requires an executable path.");
  const ffmpegValue = args.options.get("ffmpeg");
  if (args.options.has("ffmpeg") && !ffmpegValue?.trim())
    throw new CliError("--ffmpeg cannot be empty.");
  const ffmpeg = resolveFfmpegCommand(ffmpegValue);
  let ffmpegUnavailableReason = "";
  let devices: FfmpegAudioDevice[] = [];
  try {
    devices = await enumerateFfmpegAudioDevices(ffmpeg);
  } catch (error) {
    ffmpegUnavailableReason = error instanceof Error ? error.message : "FFmpeg discovery failed.";
  }
  const rows: Array<{
    id: string;
    name: string;
    backend: string;
    source?: string;
    is_default?: boolean;
    process_id?: number;
    bundle_id?: string;
  }> = devices.map((device) => ({
    id: device.id,
    name: device.name,
    backend: device.backend,
  }));
  let nativeInputUnavailableReason = "";
  try {
    const native = await listNativeCaptureDevices();
    rows.push(
      ...native.devices.map((device) => ({
        id: device.id,
        name: device.name,
        backend: device.backend,
        source: device.source,
        is_default: device.isDefault,
      })),
    );
  } catch (error) {
    nativeInputUnavailableReason =
      error instanceof Error ? error.message : "Native microphone/system-audio discovery failed.";
  }
  let applicationAudioUnavailableReason = "";
  try {
    const native = await listNativeApplicationAudioDevices();
    rows.push(
      ...native.devices.map((device) => ({
        id: device.id,
        name: device.name,
        backend: device.backend,
        source: "application",
        process_id: device.processId,
        ...(device.bundleId === undefined ? {} : { bundle_id: device.bundleId }),
      })),
    );
  } catch (error) {
    applicationAudioUnavailableReason =
      error instanceof Error ? error.message : "Native application-audio discovery failed.";
  }
  emit(
    output,
    {
      ffmpeg,
      devices: rows,
      ...(ffmpegUnavailableReason ? { ffmpeg_unavailable_reason: ffmpegUnavailableReason } : {}),
      ...(nativeInputUnavailableReason
        ? { native_audio_unavailable_reason: nativeInputUnavailableReason }
        : {}),
      ...(applicationAudioUnavailableReason
        ? { application_audio_unavailable_reason: applicationAudioUnavailableReason }
        : {}),
    },
    [
      ...rows.map(
        (device) =>
          `${device.id}  ${device.name}  (${device.backend}${device.source ? ` · ${device.source}` : ""}${device.is_default ? " · default" : ""})`,
      ),
      ...(ffmpegUnavailableReason ? [`FFmpeg unavailable: ${ffmpegUnavailableReason}`] : []),
      ...(nativeInputUnavailableReason
        ? [`Native microphone/system audio unavailable: ${nativeInputUnavailableReason}`]
        : []),
      ...(applicationAudioUnavailableReason
        ? [`Application audio unavailable: ${applicationAudioUnavailableReason}`]
        : []),
      ...(!rows.length &&
      !ffmpegUnavailableReason &&
      !nativeInputUnavailableReason &&
      !applicationAudioUnavailableReason
        ? [
            "No audio input endpoints were found. Check device support and operating-system permissions.",
          ]
        : []),
    ].join("\n"),
    args.flags.has("json"),
  );
  return rows.length ? 0 : 1;
}

export async function runRecordingTestCommand(
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  if (args.positionals.length)
    throw new CliError("record test does not accept positional arguments.");
  if (args.options.has("system-audio"))
    throw new CliError("--system-audio is a flag and does not accept a value.");
  const optionValue = (name: string): string | undefined => {
    if (args.flags.has(name)) throw new CliError(`--${name} requires a value.`);
    const value = args.options.get(name);
    if (value === "") throw new CliError(`--${name} cannot be empty.`);
    return value;
  };
  const requestedSource =
    optionValue("source") ?? (args.flags.has("system-audio") ? "system-audio" : "microphone");
  if (
    requestedSource !== "microphone" &&
    requestedSource !== "system-audio" &&
    requestedSource !== "loopback" &&
    requestedSource !== "application" &&
    requestedSource !== "both"
  ) {
    throw new CliError(
      "Recording test source must be 'microphone', 'system-audio', 'application', or 'both'.",
    );
  }
  const device = optionValue("device");
  const microphone = optionValue("microphone");
  const playback = optionValue("playback");
  const application = optionValue("application");
  const ffmpeg = optionValue("ffmpeg");
  const testBoth =
    requestedSource === "both" ||
    (requestedSource === "microphone" && args.flags.has("system-audio"));
  if (application && args.flags.has("system-audio")) {
    throw new CliError(
      "Choose one synchronized secondary track with '--application' or '--system-audio'.",
    );
  }
  if (application && playback) {
    throw new CliError(
      "Select one synchronized secondary track with '--application' or '--playback'.",
    );
  }
  if (application && requestedSource !== "both" && requestedSource !== "application") {
    throw new CliError("Use '--application ID' with '--source application' or '--source both'.");
  }
  if (
    requestedSource === "application" &&
    (args.flags.has("system-audio") || microphone !== undefined || playback !== undefined)
  ) {
    throw new CliError("Application audio tests accept only '--device ID' or '--application ID'.");
  }
  if (testBoth && device !== undefined) {
    throw new CliError("Test synchronized sources with '--microphone' and '--playback'.");
  }
  if (
    !testBoth &&
    device !== undefined &&
    ((requestedSource === "microphone" && microphone !== undefined) ||
      ((requestedSource === "system-audio" || requestedSource === "loopback") &&
        playback !== undefined) ||
      (requestedSource === "application" && application !== undefined))
  ) {
    throw new CliError("Use either '--device ID' or the source-specific device option.");
  }
  const source = testBoth
    ? "both"
    : requestedSource === "loopback"
      ? "system-audio"
      : requestedSource;
  const report = await inspectRecordingSources({
    source,
    ...(device === undefined ? {} : { device }),
    ...(microphone === undefined ? {} : { microphone }),
    ...(playback === undefined ? {} : { playback }),
    ...(application === undefined ? {} : { application }),
    ...(ffmpeg === undefined ? {} : { ffmpeg }),
  });
  const limitation =
    report.limitation ??
    (report.synchronized_tracks
      ?.map((track) => track.limitation)
      .filter(Boolean)
      .join(" ") ||
      "The selected stream was opened and measured for about 1.8 seconds; no recording was saved.");
  const measurements = (report.synchronized_tracks ?? [report])
    .filter((track) => track.available)
    .map((track) =>
      track.signal_detected
        ? `${track.source}: signal detected (RMS ${track.rms?.toFixed(4)}, peak ${track.peak?.toFixed(4)}, ${track.dbfs?.toFixed(1)} dBFS).`
        : `${track.source}: stream opened, but no signal above threshold was measured (RMS ${track.rms?.toFixed(4)}, ${track.dbfs?.toFixed(1)} dBFS).`,
    )
    .join(" ");
  const summary = report.available
    ? `${report.source === "both" ? "Requested audio streams were" : `The ${report.source} stream was`} opened and measured. ${measurements} ${limitation}`
    : `The requested ${report.source} input is unavailable or unsupported. ${limitation}`;
  emit(output, report, summary, args.flags.has("json"));
  return report.available ? 0 : 1;
}
