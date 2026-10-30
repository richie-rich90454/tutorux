import { execFile } from "node:child_process";
import { arch, availableParallelism, freemem, platform, release, totalmem } from "node:os";
import { promisify } from "node:util";
import {
  verifyArchiveHistory,
  type ArchiveHistoryVerificationResult,
  type ArchiveSnapshot,
} from "../frontend/archive/archive";
import { listNativeCaptureDevices, type NativeCaptureDevice } from "./native-audio-helper";

const executeFile = promisify(execFile);
const AUDIO_COMMAND_TIMEOUT_MS = 5_000;
const AUDIO_COMMAND_MAX_BUFFER = 2 * 1024 * 1024;
const MAX_AUDIO_DEVICES = 512;
const MAX_DEVICE_TEXT_LENGTH = 512;

export interface SystemDiagnosticSnapshot {
  operating_system: string;
  architecture: string;
  process_uptime_us: string;
  process_cpu_time_us: string;
  process_cpu_available: string;
  resident_memory_bytes: string;
  peak_resident_memory_bytes: string;
  resident_memory_available: string;
  available_memory_bytes: string;
  available_memory_available: string;
  hardware_threads: string;
}

export interface AudioDiagnosticRow {
  device_id: string;
  name: string;
  kind: "microphone" | "application" | "playback";
  default: boolean | null;
  probe_state: "ready" | "unsupported" | "not-probed";
  probe_message: string;
  sample_format?: string;
  sample_rate_hz?: string;
  channel_count?: string;
}

export interface AudioDiagnosticResult {
  available: boolean;
  rows: AudioDiagnosticRow[];
  status: string;
  reason?: string;
}

export interface ArchiveDiagnosticOptions {
  full: boolean;
  includeSystem: boolean;
  signal?: AbortSignal;
}

export async function buildArchiveDiagnosticReport(
  snapshot: ArchiveSnapshot,
  options: ArchiveDiagnosticOptions,
): Promise<Record<string, unknown>> {
  throwIfAborted(options.signal);
  const issues: string[] = [];
  let verification: ArchiveHistoryVerificationResult | null = null;
  try {
    await snapshot.verifyEncryptionAuthentication();
    if (options.full) {
      throwIfAborted(options.signal);
      verification = await verifyArchiveHistory(snapshot);
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    issues.push(error instanceof Error ? error.message : "Archive verification failed.");
  }

  const report: Record<string, unknown> = {
    archive_generation: snapshot.commit.generation.toString(),
    archive_valid: issues.length === 0,
    records_checked: verification?.verifiedGenerationRecords ?? 0,
    index_pages_checked: options.full ? null : 1,
    issues: issues.join("\n"),
    archive_id: snapshot.header.id,
    encrypted: snapshot.encrypted,
    full_verification: verification,
  };
  if (options.includeSystem) {
    Object.assign(
      report,
      Object.fromEntries(
        Object.entries(readSystemDiagnosticSnapshot()).map(([key, value]) => [
          `system_${key}`,
          value,
        ]),
      ),
    );
    throwIfAborted(options.signal);
    const audio = await enumerateAudioDiagnostics(options.signal);
    report["audio_device_count"] = audio.available ? audio.rows.length : "unavailable";
    report["audio_status"] = audio.available ? "checked" : "unavailable";
    if (audio.reason) report["audio_reason"] = audio.reason;
    report["network_checked"] = false;
  }
  return report;
}

export function readSystemDiagnosticSnapshot(): SystemDiagnosticSnapshot {
  const memory = process.memoryUsage();
  const resources = process.resourceUsage();
  const cpu = process.cpuUsage();
  const operatingSystem = systemName(platform());
  const hardwareThreads = Math.max(1, availableParallelism());
  const currentRss = Math.max(0, Math.trunc(memory.rss));
  const peakRss = Math.max(currentRss, Math.trunc(resources.maxRSS * 1024));
  const cpuTime = Math.max(0, Math.trunc(cpu.user + cpu.system));

  return {
    operating_system: operatingSystem,
    architecture: architectureName(arch()),
    process_uptime_us: Math.max(0, Math.trunc(process.uptime() * 1_000_000)).toString(),
    process_cpu_time_us: cpuTime.toString(),
    process_cpu_available: "true",
    resident_memory_bytes: currentRss.toString(),
    peak_resident_memory_bytes: peakRss.toString(),
    resident_memory_available: "true",
    available_memory_bytes: Math.max(0, Math.trunc(freemem())).toString(),
    available_memory_available: "true",
    hardware_threads: hardwareThreads.toString(),
  };
}

export function readBenchmarkHostSummary(): Record<string, string | number> {
  return {
    platform: platform(),
    os_release: release(),
    cpu_count: Math.max(1, availableParallelism()),
    total_memory_bytes: Math.max(0, Math.trunc(totalmem())),
  };
}

export async function enumerateAudioDiagnostics(
  signal?: AbortSignal,
): Promise<AudioDiagnosticResult> {
  throwIfAborted(signal);
  const native = await inspectNativeAudioEndpoints(signal);
  if (native.rows.length) {
    return { available: true, rows: native.rows.slice(0, MAX_AUDIO_DEVICES), status: "checked" };
  }
  try {
    const rows = await enumerateHostAudioDevices(signal);
    throwIfAborted(signal);
    return {
      available: true,
      rows: rows.slice(0, MAX_AUDIO_DEVICES).map((row) => ({
        ...row,
        probe_state: "unsupported",
        probe_message: native.reason,
      })),
      status: "checked",
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const detail =
      error instanceof Error ? error.message : "The host audio device list is unavailable.";
    return {
      available: false,
      rows: [],
      status: "unavailable",
      reason: detail.slice(0, MAX_DEVICE_TEXT_LENGTH),
    };
  }
}

async function inspectNativeAudioEndpoints(
  signal?: AbortSignal,
): Promise<{ rows: AudioDiagnosticRow[]; reason: string }> {
  try {
    const { devices } = await listNativeCaptureDevices();
    throwIfAborted(signal);
    return {
      rows: audioDiagnosticRowsFromNativeDevices(devices),
      reason: "The native audio helper enumerated no microphone or system-audio endpoints.",
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const detail =
      error instanceof Error ? error.message : "The native audio helper is unavailable.";
    return {
      rows: [],
      reason: `Endpoint formats are unavailable from the native audio helper: ${detail}`.slice(
        0,
        MAX_DEVICE_TEXT_LENGTH,
      ),
    };
  }
}

export function audioDiagnosticRowsFromNativeDevices(
  devices: NativeCaptureDevice[],
): AudioDiagnosticRow[] {
  return devices.map(nativeDiagnosticRow);
}

function nativeDiagnosticRow(device: NativeCaptureDevice): AudioDiagnosticRow {
  const base = {
    device_id: device.id.slice(0, MAX_DEVICE_TEXT_LENGTH),
    name: device.name.slice(0, MAX_DEVICE_TEXT_LENGTH),
    kind: device.source === "microphone" ? ("microphone" as const) : ("playback" as const),
    default: device.isDefault,
  };
  if (
    device.sampleFormat !== undefined &&
    device.sampleRateHz !== undefined &&
    device.channelCount !== undefined
  ) {
    return {
      ...base,
      probe_state: "ready",
      probe_message:
        "The native audio helper inspected the endpoint configuration without starting a stream.",
      sample_format: device.sampleFormat.slice(0, MAX_DEVICE_TEXT_LENGTH),
      sample_rate_hz: String(device.sampleRateHz),
      channel_count: String(device.channelCount),
    };
  }
  return {
    ...base,
    probe_state: "unsupported",
    probe_message:
      "This native audio helper did not report an endpoint configuration; rebuild the audio helper and retry.",
  };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The diagnostics operation was cancelled.");
  }
}

function systemName(value: ReturnType<typeof platform>): string {
  if (value === "win32") return "Windows";
  if (value === "darwin") return "macOS";
  if (value === "linux") return "Linux";
  if (value === "freebsd") return "FreeBSD";
  return value === "android" ? "Android" : "Unknown";
}

function architectureName(value: ReturnType<typeof arch>): string {
  if (value === "x64") return "x86_64";
  if (value === "arm64") return "arm64";
  if (value === "ia32") return "x86";
  if (value === "arm") return "arm";
  return value;
}

async function enumerateHostAudioDevices(signal?: AbortSignal): Promise<AudioDiagnosticRow[]> {
  switch (platform()) {
    case "win32":
      return enumerateWindowsAudioDevices(signal);
    case "darwin":
      return enumerateMacAudioDevices(signal);
    case "linux":
      return enumerateLinuxAudioDevices(signal);
    default:
      throw new Error("Audio endpoint enumeration is unsupported on this operating system.");
  }
}

async function enumerateWindowsAudioDevices(signal?: AbortSignal): Promise<AudioDiagnosticRow[]> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$devices = @(Get-PnpDevice -Class AudioEndpoint -ErrorAction Stop | Select-Object FriendlyName, InstanceId, Status)",
    "ConvertTo-Json -InputObject $devices -Compress -Depth 3",
  ].join("\n");
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const output = await runHostCommand(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    signal,
  );
  const parsed: unknown = JSON.parse(output.trim() || "[]");
  const devices = Array.isArray(parsed) ? parsed : [parsed];
  return devices.flatMap((value) => {
    if (!isRecord(value)) return [];
    const deviceId = boundedText(value["InstanceId"]);
    const name = boundedText(value["FriendlyName"]);
    if (!deviceId || !name) return [];
    const endpoint = `${deviceId} ${name}`.toLowerCase();
    const kind = /(?:capture|microphone|\bmic\b|input|0\.0\.1\.)/u.test(endpoint)
      ? "microphone"
      : "playback";
    return [makeAudioRow(deviceId, name, kind, boundedText(value["Status"]))];
  });
}

async function enumerateMacAudioDevices(signal?: AbortSignal): Promise<AudioDiagnosticRow[]> {
  const output = await runHostCommand("system_profiler", ["SPAudioDataType", "-json"], signal);
  const parsed: unknown = JSON.parse(output);
  const devices = findMacAudioDevices(parsed);
  return devices.flatMap((value) => {
    if (!isRecord(value)) return [];
    const name = boundedText(value["_name"]);
    if (!name) return [];
    const deviceId = boundedText(value["coreaudio_device_uid"]) || name;
    const hasInput = isEnabled(value["coreaudio_device_input"]);
    const hasOutput = isEnabled(value["coreaudio_device_output"]);
    const inputIsDefault = optionalEnabled(value, "coreaudio_default_audio_input_device");
    const outputIsDefault = optionalEnabled(value, "coreaudio_default_audio_output_device");
    const rows: AudioDiagnosticRow[] = [];
    if (hasInput)
      rows.push(makeAudioRow(`${deviceId}:input`, name, "microphone", "", inputIsDefault));
    if (hasOutput)
      rows.push(makeAudioRow(`${deviceId}:output`, name, "playback", "", outputIsDefault));
    return rows;
  });
}

async function enumerateLinuxAudioDevices(signal?: AbortSignal): Promise<AudioDiagnosticRow[]> {
  try {
    const [sourcesOutput, sinksOutput, defaultSource, defaultSink] = await Promise.all([
      runHostCommand("pactl", ["--format=json", "list", "short", "sources"], signal),
      runHostCommand("pactl", ["--format=json", "list", "short", "sinks"], signal),
      runHostCommand("pactl", ["get-default-source"], signal).catch(() => ""),
      runHostCommand("pactl", ["get-default-sink"], signal).catch(() => ""),
    ]);
    const sources: unknown = JSON.parse(sourcesOutput);
    const sinks: unknown = JSON.parse(sinksOutput);
    if (!Array.isArray(sources) || !Array.isArray(sinks))
      throw new Error("The PulseAudio device list was invalid.");
    const sourceDefault = defaultSource.trim();
    const sinkDefault = defaultSink.trim();
    const rows = [
      ...sources.flatMap((value) => {
        const device = linuxPactlDevice(value);
        if (!device) return [];
        const monitor = device.name.includes(".monitor") || device.name.includes("monitor");
        return [
          makeAudioRow(
            device.name,
            device.description || device.name,
            monitor ? "application" : "microphone",
            "",
            sourceDefault ? device.name === sourceDefault : null,
          ),
        ];
      }),
      ...sinks.flatMap((value) => {
        const device = linuxPactlDevice(value);
        if (!device) return [];
        return [
          makeAudioRow(
            device.name,
            device.description || device.name,
            "playback",
            "",
            sinkDefault ? device.name === sinkDefault : null,
          ),
        ];
      }),
    ];
    return rows;
  } catch (error) {
    if (signal?.aborted) throw error;
    return enumerateLinuxAlsaDevices(signal);
  }
}

async function enumerateLinuxAlsaDevices(signal?: AbortSignal): Promise<AudioDiagnosticRow[]> {
  const [captureOutput, playbackOutput] = await Promise.all([
    runHostCommand("arecord", ["-l"], signal).catch(() => ""),
    runHostCommand("aplay", ["-l"], signal).catch(() => ""),
  ]);
  const rows = [
    ...parseAlsaDevices(captureOutput, "microphone"),
    ...parseAlsaDevices(playbackOutput, "playback"),
  ];
  if (!captureOutput && !playbackOutput) {
    throw new Error("Neither PulseAudio/PipeWire nor ALSA device enumeration is available.");
  }
  return rows;
}

function parseAlsaDevices(output: string, kind: "microphone" | "playback"): AudioDiagnosticRow[] {
  const rows: AudioDiagnosticRow[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match =
      /^\s*(?:card\s+)?(\d+):\s*([^[]*?)\s*\[([^\]]+)\].*?(?:device\s+)?(\d+):\s*([^[]*?)\s*\[([^\]]+)\]/iu.exec(
        line,
      );
    if (!match) continue;
    const deviceId = `hw:${match[1]},${match[4]}`;
    const name = `${match[3]} — ${match[6]}`.slice(0, MAX_DEVICE_TEXT_LENGTH);
    rows.push(makeAudioRow(deviceId, name, kind, ""));
  }
  return rows;
}

function linuxPactlDevice(value: unknown): { name: string; description: string } | null {
  if (!isRecord(value)) return null;
  const name = boundedText(value["name"]);
  if (!name) return null;
  return { name, description: boundedText(value["description"]) };
}

function findMacAudioDevices(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(findMacAudioDevices);
  if (!isRecord(value)) return [];
  const name = value["_name"];
  const children = value["_items"];
  const result = typeof name === "string" ? [value] : [];
  return Array.isArray(children) ? [...result, ...children.flatMap(findMacAudioDevices)] : result;
}

function makeAudioRow(
  deviceId: string,
  name: string,
  kind: AudioDiagnosticRow["kind"],
  state: string,
  isDefault: boolean | null = null,
): AudioDiagnosticRow {
  const message =
    state && state.toLowerCase() !== "ok"
      ? `Host endpoint status: ${state}. The CLI did not open an audio stream.`
      : "The CLI enumerated this endpoint without opening an audio stream.";
  return {
    device_id: deviceId.slice(0, MAX_DEVICE_TEXT_LENGTH),
    name: name.slice(0, MAX_DEVICE_TEXT_LENGTH),
    kind,
    default: isDefault,
    probe_state: "not-probed",
    probe_message: message.slice(0, MAX_DEVICE_TEXT_LENGTH),
  };
}

function boundedText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_DEVICE_TEXT_LENGTH) : "";
}

function isEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function optionalEnabled(value: Record<string, unknown>, key: string): boolean | null {
  if (!Object.hasOwn(value, key)) return null;
  return isEnabled(value[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function runHostCommand(
  file: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const options = {
    encoding: "utf8" as const,
    timeout: AUDIO_COMMAND_TIMEOUT_MS,
    maxBuffer: AUDIO_COMMAND_MAX_BUFFER,
    windowsHide: true,
    ...(signal === undefined ? {} : { signal }),
  };
  const { stdout } = await executeFile(file, [...args], options);
  return stdout;
}
