import {
  enumerateFfmpegAudioDevices,
  isSupportedFfmpegSystemAudioDevice,
  probeFfmpegAudioDevice,
  resolveFfmpegCommand,
  type FfmpegAudioDevice,
} from "./live-recording";
import {
  listNativeApplicationAudioDevices,
  listNativeCaptureDevices,
  probeNativeApplicationAudioDevice,
  probeNativeCaptureDevice,
  resolveNativeAudioHelper,
  type NativeApplicationAudioDevice,
  type NativeCaptureDevice,
  type NativeCaptureProbe,
} from "./native-audio-helper";

export interface RecordingTestOptions {
  source: "microphone" | "system-audio" | "application" | "both";
  device?: string;
  microphone?: string;
  playback?: string;
  application?: string;
  ffmpeg?: string;
}

interface EndpointProbe {
  source: "microphone" | "system-audio" | "application";
  available: boolean;
  device_id?: string;
  device_name?: string;
  backend?: string;
  sample_format?: string;
  sample_rate_hz?: number;
  channel_count?: number;
  sample_count?: number;
  duration_ms?: number;
  rms?: number;
  peak?: number;
  dbfs?: number;
  signal_detected?: boolean;
  probe: string;
  limitation?: string;
}

export interface RecordingTestReport {
  available: boolean;
  source: RecordingTestOptions["source"];
  probe: string;
  device_id?: string;
  device_name?: string;
  backend?: string;
  sample_format?: string;
  sample_rate_hz?: number;
  channel_count?: number;
  sample_count?: number;
  duration_ms?: number;
  rms?: number;
  peak?: number;
  dbfs?: number;
  signal_detected?: boolean;
  synchronized_tracks?: EndpointProbe[];
  limitation?: string;
}

/** Open the selected endpoint briefly and measure its signal without saving the audio. */
export async function inspectRecordingSources(
  options: RecordingTestOptions,
): Promise<RecordingTestReport> {
  const needsMicrophone = options.source === "microphone" || options.source === "both";
  const needsSystemAudio =
    options.source === "system-audio" || (options.source === "both" && !options.application);
  const needsApplication = options.source === "application" || Boolean(options.application);
  const ffmpeg = resolveFfmpegCommand(options.ffmpeg);
  let ffmpegDevices: FfmpegAudioDevice[] = [];
  let ffmpegUnavailableReason: string | undefined;
  if (needsMicrophone || needsSystemAudio) {
    try {
      ffmpegDevices = await enumerateFfmpegAudioDevices(ffmpeg);
    } catch (error) {
      ffmpegUnavailableReason = errorMessage(error, "FFmpeg device discovery failed.");
    }
  }

  let helper: string | undefined;
  let nativeCaptureDevices: NativeCaptureDevice[] = [];
  let nativeApplicationDevices: NativeApplicationAudioDevice[] = [];
  let nativeCaptureUnavailableReason: string | undefined;
  let nativeApplicationUnavailableReason: string | undefined;
  if (needsMicrophone || needsSystemAudio || needsApplication) {
    try {
      helper = await resolveNativeAudioHelper();
    } catch (error) {
      const reason = errorMessage(error, "Native audio helper discovery failed.");
      nativeCaptureUnavailableReason = reason;
      nativeApplicationUnavailableReason = reason;
    }
    if (helper && (needsMicrophone || needsSystemAudio)) {
      try {
        nativeCaptureDevices = (await listNativeCaptureDevices(helper)).devices;
      } catch (error) {
        nativeCaptureUnavailableReason = errorMessage(error, "Native input discovery failed.");
      }
    }
    if (helper && needsApplication) {
      try {
        nativeApplicationDevices = (await listNativeApplicationAudioDevices(helper)).devices;
      } catch (error) {
        nativeApplicationUnavailableReason = errorMessage(error, "Native application-audio discovery failed.");
      }
    }
  }

  const microphone = needsMicrophone
    ? await probeInput({
        source: "microphone",
        requested:
          options.source === "microphone"
            ? (options.microphone ?? options.device)
            : options.microphone,
        helper,
        nativeDevices: nativeCaptureDevices,
        ffmpeg,
        ffmpegDevices,
        unavailableReason: nativeCaptureUnavailableReason ?? ffmpegUnavailableReason,
      })
    : undefined;
  const systemAudio = needsSystemAudio
    ? await probeInput({
        source: "system-audio",
        requested:
          options.source === "system-audio"
            ? (options.playback ?? options.device)
            : options.playback,
        helper,
        nativeDevices: nativeCaptureDevices,
        ffmpeg,
        ffmpegDevices,
        unavailableReason: nativeCaptureUnavailableReason ?? ffmpegUnavailableReason,
      })
    : undefined;

  if (options.source === "application") {
    const selected = findApplication(nativeApplicationDevices, options.application ?? options.device);
    if (!selected) {
      return {
        available: false,
        source: "application",
        probe: "native-stream-not-opened",
        ...(nativeApplicationUnavailableReason
          ? { limitation: nativeApplicationUnavailableReason }
          : {
              limitation: nativeApplicationDevices.length
                ? "Choose an available application with --application <id>."
                : applicationTargetLimitation(),
            }),
      };
    }
    try {
      const measured = await probeNativeApplicationAudioDevice(helper!, selected);
      return {
        available: true,
        source: "application",
        ...probeFields(measured),
        probe: measured.probe,
        ...(measured.signalDetected
          ? {}
          : { limitation: "The application stream opened, but no signal above the detection threshold was measured." }),
      };
    } catch (error) {
      return {
        available: false,
        source: "application",
        device_id: selected.id,
        device_name: selected.name,
        backend: selected.backend,
        probe: "native-stream-open-failed",
        limitation: errorMessage(error, "The application-audio signal probe failed."),
      };
    }
  }

  if (options.source === "microphone") return microphone!;
  if (options.source === "system-audio") return systemAudio!;

  const secondary: EndpointProbe = options.application
    ? await probeApplication(
        nativeApplicationDevices,
        helper,
        options.application,
        nativeApplicationUnavailableReason,
      )
    : systemAudio!;
  const synchronizedTracks = [microphone!, secondary];
  return {
    available: synchronizedTracks.every((track) => track.available),
    source: "both",
    probe: "separate-stream-probes-opened-and-signal-measured",
    synchronized_tracks: synchronizedTracks,
  };
}

async function probeInput(options: {
  source: "microphone" | "system-audio";
  requested?: string;
  helper?: string;
  nativeDevices: readonly NativeCaptureDevice[];
  ffmpeg: string;
  ffmpegDevices: readonly FfmpegAudioDevice[];
  unavailableReason?: string;
}): Promise<EndpointProbe> {
  const nativeDevice = selectNativeCandidate(options.nativeDevices, options.source, options.requested);
  if (nativeDevice && options.helper) {
    try {
      const measured = await probeNativeCaptureDevice(options.helper, nativeDevice);
      return probeEndpoint(measured);
    } catch (error) {
      return {
        source: options.source,
        available: false,
        device_id: nativeDevice.id,
        device_name: nativeDevice.name,
        backend: nativeDevice.backend,
        probe: "native-stream-open-failed",
        limitation: errorMessage(error, "The native audio signal probe failed."),
      };
    }
  }

  const fallback = selectFfmpegCandidate(options);
  if (!fallback.device) {
    return {
      source: options.source,
      available: false,
      probe: "stream-not-opened",
      limitation:
        fallback.limitation ?? options.unavailableReason ??
        (options.source === "system-audio" ? systemAudioLimitation() : microphoneLimitation()),
    };
  }
  try {
    const measured = await probeFfmpegAudioDevice({
      ffmpeg: options.ffmpeg,
      device: fallback.device,
      source: options.source,
    });
    return {
      ...probeEndpoint(measured),
      ...(fallback.limitation ? { limitation: fallback.limitation } : {}),
    };
  } catch (error) {
    return {
      source: options.source,
      available: false,
      device_id: fallback.device.id,
      device_name: fallback.device.name,
      backend: fallback.device.backend,
      probe: "ffmpeg-stream-open-failed",
      limitation: errorMessage(error, "The FFmpeg audio signal probe failed."),
    };
  }
}

async function probeApplication(
  devices: readonly NativeApplicationAudioDevice[],
  helper: string | undefined,
  requested: string,
  unavailableReason?: string,
): Promise<EndpointProbe> {
  const selected = findApplication(devices, requested);
  if (!selected || !helper) {
    return {
      source: "application",
      available: false,
      probe: "native-stream-not-opened",
      limitation:
        unavailableReason ??
        (devices.length ? "Choose an available application with --application <id>." : applicationTargetLimitation()),
    };
  }
  try {
    const measured = await probeNativeApplicationAudioDevice(helper, selected);
    return probeEndpoint(measured);
  } catch (error) {
    return {
      source: "application",
      available: false,
      device_id: selected.id,
      device_name: selected.name,
      backend: selected.backend,
      probe: "native-stream-open-failed",
      limitation: errorMessage(error, "The application-audio signal probe failed."),
    };
  }
}

function selectNativeCandidate(
  devices: readonly NativeCaptureDevice[],
  source: "microphone" | "system-audio",
  requested?: string,
): NativeCaptureDevice | undefined {
  const candidates = devices.filter((device) => device.source === source);
  if (requested && requested !== "default") {
    return candidates.find((device) => device.id === requested || device.name === requested);
  }
  return candidates.find((device) => device.isDefault) ?? (candidates.length === 1 ? candidates[0] : undefined);
}

function selectFfmpegCandidate(options: {
  source: "microphone" | "system-audio";
  requested?: string;
  ffmpegDevices: readonly FfmpegAudioDevice[];
  unavailableReason?: string;
}): { device?: FfmpegAudioDevice; limitation?: string } {
  const matching = options.ffmpegDevices.filter((device) =>
    options.source === "microphone" ? !isFfmpegLoopback(device) : isSupportedFfmpegSystemAudioDevice(device),
  );
  if (options.requested && options.requested !== "default") {
    const device = options.ffmpegDevices.find(
      (candidate) => candidate.id === options.requested || candidate.name === options.requested,
    );
    if (!device) {
      return {
        limitation: `${options.unavailableReason ? `${options.unavailableReason} ` : ""}The selected ${options.source} device '${options.requested}' is not listed by the native helper or FFmpeg.`,
      };
    }
    if (options.source === "system-audio" && !isSupportedFfmpegSystemAudioDevice(device)) {
      return { limitation: systemAudioLimitation() };
    }
    if (options.source === "microphone" && isFfmpegLoopback(device)) {
      return {
        limitation: "The selected endpoint appears to be a loopback source, not a microphone input.",
      };
    }
    return { device };
  }
  const device = matching.find((candidate) => candidate.backend === preferredFfmpegBackend()) ?? matching[0];
  return device
    ? {
        device,
        limitation:
          options.source === "microphone"
            ? "The FFmpeg device list does not identify the operating-system default input; the selected endpoint was opened and measured."
            : undefined,
      }
    : {
        limitation:
          options.unavailableReason ??
          (options.source === "system-audio" ? systemAudioLimitation() : microphoneLimitation()),
      };
}

function probeEndpoint(probe: NativeCaptureProbe): EndpointProbe {
  return {
    source: probe.source === "application" ? "application" : probe.source,
    available: true,
    ...probeFields(probe),
    probe: probe.probe,
    ...(probe.signalDetected
      ? {}
      : { limitation: "The stream opened, but no signal above the detection threshold was measured." }),
  };
}

function probeFields(probe: NativeCaptureProbe): Pick<
  EndpointProbe,
  | "device_id"
  | "device_name"
  | "backend"
  | "sample_format"
  | "sample_rate_hz"
  | "channel_count"
  | "sample_count"
  | "duration_ms"
  | "rms"
  | "peak"
  | "dbfs"
  | "signal_detected"
> {
  return {
    device_id: probe.id,
    device_name: probe.name,
    backend: probe.backend,
    sample_format: probe.sampleFormat,
    sample_rate_hz: probe.sampleRateHz,
    channel_count: probe.channelCount,
    sample_count: probe.sampleCount,
    duration_ms: probe.durationMs,
    rms: probe.rms,
    peak: probe.peak,
    dbfs: probe.dbfs,
    signal_detected: probe.signalDetected,
  };
}

function findApplication(
  devices: readonly NativeApplicationAudioDevice[],
  requested?: string,
): NativeApplicationAudioDevice | undefined {
  if (!requested) return devices.length === 1 ? devices[0] : undefined;
  return devices.find(
    (device) =>
      device.id === requested ||
      device.name === requested ||
      String(device.processId) === requested,
  );
}

function isFfmpegLoopback(device: FfmpegAudioDevice): boolean {
  return isSupportedFfmpegSystemAudioDevice(device) || /monitor|loopback|stereo\s*mix/iu.test(`${device.id} ${device.name}`);
}

function preferredFfmpegBackend(): string {
  if (process.platform === "win32") return "dshow";
  if (process.platform === "darwin") return "avfoundation";
  return "pulse";
}

function systemAudioLimitation(): string {
  if (process.platform === "win32") {
    return "No native WASAPI output loopback was available. FFmpeg can capture only an explicitly exposed Stereo Mix or virtual loopback input.";
  }
  if (process.platform === "darwin") {
    return "No CoreAudio output-loopback device was available. Duplex endpoints are omitted to avoid confusing their microphone input with system playback.";
  }
  return "No PipeWire monitor/loopback input was available. Select a monitor source exposed by the Linux audio service.";
}

function microphoneLimitation(): string {
  return "No microphone endpoint was available from the native helper or FFmpeg. Check device support and operating-system microphone permissions.";
}

function applicationTargetLimitation(): string {
  if (process.platform === "win32") {
    return "No active WASAPI application-audio sessions were found. Start playback in the target application and retry.";
  }
  if (process.platform === "darwin") {
    return "No shareable applications were found. Check Screen & System Audio Recording permission and retry.";
  }
  return "No active PipeWire application-audio streams were found. ALSA cannot identify per-application audio.";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
