import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeApplicationAudioDevice {
  id: string;
  name: string;
  backend: string;
  processId: number;
  bundleId?: string;
}

export type NativeCaptureSource = "microphone" | "system-audio";

export interface NativeCaptureDevice {
  id: string;
  name: string;
  backend: string;
  source: NativeCaptureSource;
  isDefault: boolean;
  sampleFormat?: string;
  sampleRateHz?: number;
  channelCount?: number;
}

export interface NativeCaptureProbe {
  id: string;
  name: string;
  backend: string;
  source: NativeCaptureSource | "application";
  sampleFormat: string;
  sampleRateHz: number;
  channelCount: number;
  sampleCount: number;
  durationMs: number;
  rms: number;
  peak: number;
  dbfs: number;
  signalDetected: boolean;
  probe: string;
}

const MAX_HELPER_OUTPUT_BYTES = 4 * 1024 * 1024;
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = resolve(MODULE_DIRECTORY, "..");

/** Locate only an explicitly configured or app-bundled helper; never substitute shared audio. */
export async function resolveNativeAudioHelper(): Promise<string> {
  const configured = process.env["TUTORUX_AUDIO_HELPER"]?.trim();
  if (configured) {
    const path = resolve(configured);
    if (await isExecutableFile(path)) return path;
    throw new Error("TUTORUX_AUDIO_HELPER does not point to an executable file: " + path);
  }

  const executableName =
    process.platform === "win32" ? "tutorux-audio-helper.exe" : "tutorux-audio-helper";
  const candidates = new Set<string>([
    join(PROJECT_DIRECTORY, "native-audio-helper", "target", "debug", executableName),
    join(PROJECT_DIRECTORY, "native-audio-helper", "target", "release", executableName),
    join(PROJECT_DIRECTORY, "src-tauri", "target", "debug", executableName),
    join(PROJECT_DIRECTORY, "src-tauri", "target", "release", executableName),
  ]);
  const helperTargetDirectory = join(PROJECT_DIRECTORY, "native-audio-helper", "target");
  let helperTargets: string[] = [];
  try {
    helperTargets = await readdir(helperTargetDirectory);
  } catch {
    // A helper that has not been built has no target directory yet.
  }
  for (const profile of ["debug", "release"]) {
    for (const target of helperTargets) {
      candidates.add(join(helperTargetDirectory, target, profile, executableName));
    }
  }

  const binaryDirectory = join(PROJECT_DIRECTORY, "src-tauri", "binaries");
  for (const path of await matchingSidecarPaths(binaryDirectory)) candidates.add(path);

  for (const directory of installedResourceDirectories()) {
    candidates.add(join(directory, executableName));
    candidates.add(join(directory, "resources", executableName));
    for (const path of await matchingSidecarPaths(directory)) candidates.add(path);
    for (const path of await matchingSidecarPaths(join(directory, "resources")))
      candidates.add(path);
  }

  for (const path of candidates) {
    if (await isExecutableFile(path)) return path;
  }
  throw new Error(
    "Native audio capture needs Tutorux's audio helper. Install the desktop app, build it with pnpm run build:audio-helper, or set TUTORUX_AUDIO_HELPER to its full path. The CLI does not substitute shared system audio for an application-specific source.",
  );
}

export async function listNativeApplicationAudioDevices(
  helper?: string,
): Promise<{ helper: string; devices: NativeApplicationAudioDevice[] }> {
  const executable = helper ?? (await resolveNativeAudioHelper());
  const result = await runHelper(executable, ["devices"]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        "Native application-audio discovery exited with code " + String(result.code) + ".",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("The native audio helper returned an invalid application list.");
  }
  if (!Array.isArray(parsed) || parsed.length > 4096) {
    throw new Error("The native audio helper returned an unsupported application list.");
  }
  const devices = parsed.map((item): NativeApplicationAudioDevice => {
    if (
      !isRecord(item) ||
      typeof item["id"] !== "string" ||
      !item["id"].trim() ||
      typeof item["name"] !== "string" ||
      !item["name"].trim() ||
      typeof item["backend"] !== "string" ||
      !item["backend"].trim() ||
      typeof item["processId"] !== "number" ||
      !Number.isSafeInteger(item["processId"]) ||
      item["processId"] < 1 ||
      (item["bundleId"] !== undefined && typeof item["bundleId"] !== "string")
    ) {
      throw new Error("The native audio helper returned an invalid application entry.");
    }
    return {
      id: item["id"],
      name: item["name"],
      backend: item["backend"],
      processId: item["processId"],
      ...(item["bundleId"] === undefined ? {} : { bundleId: item["bundleId"] }),
    };
  });
  return { helper: executable, devices };
}

export async function selectNativeApplicationAudioDevice(
  helper: string,
  requested?: string,
): Promise<NativeApplicationAudioDevice> {
  const { devices } = await listNativeApplicationAudioDevices(helper);
  const matching = requested
    ? devices.find(
        (device) =>
          device.id === requested ||
          device.name === requested ||
          String(device.processId) === requested,
      )
    : devices.length === 1
      ? devices[0]
      : undefined;
  if (matching) return matching;
  if (!devices.length) {
    throw new Error(
      process.platform === "win32"
        ? "No active WASAPI application-audio sessions were found. Start playback in the target application and retry."
        : process.platform === "darwin"
          ? "No shareable applications were found. Check Screen & System Audio Recording permission and retry."
          : "No active PipeWire application-audio streams were found. ALSA cannot identify per-application audio.",
    );
  }
  if (!requested) {
    throw new Error(
      "Several applications are playing audio. Choose one with --application <id> from record devices.",
    );
  }
  throw new Error(
    "The selected application '" + requested + "' is not currently available for audio capture.",
  );
}

export async function listNativeCaptureDevices(
  helper?: string,
): Promise<{ helper: string; devices: NativeCaptureDevice[] }> {
  const executable = helper ?? (await resolveNativeAudioHelper());
  const result = await runHelper(executable, ["inputs"]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        "Native microphone and system-audio discovery exited with code " +
          String(result.code) +
          ".",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("The native audio helper returned an invalid input list.");
  }
  if (!Array.isArray(parsed) || parsed.length > 4096) {
    throw new Error("The native audio helper returned an unsupported input list.");
  }
  const devices = parsed.map((item): NativeCaptureDevice => {
    if (
      !isRecord(item) ||
      typeof item["id"] !== "string" ||
      !item["id"].trim() ||
      typeof item["name"] !== "string" ||
      !item["name"].trim() ||
      typeof item["backend"] !== "string" ||
      !item["backend"].trim() ||
      (item["source"] !== "microphone" && item["source"] !== "system-audio") ||
      typeof item["isDefault"] !== "boolean" ||
      (item["sampleFormat"] !== undefined &&
        (typeof item["sampleFormat"] !== "string" || !item["sampleFormat"].trim())) ||
      (item["sampleRateHz"] !== undefined &&
        (typeof item["sampleRateHz"] !== "number" ||
          !Number.isSafeInteger(item["sampleRateHz"]) ||
          item["sampleRateHz"] < 1)) ||
      (item["channelCount"] !== undefined &&
        (typeof item["channelCount"] !== "number" ||
          !Number.isSafeInteger(item["channelCount"]) ||
          item["channelCount"] < 1))
    ) {
      throw new Error("The native audio helper returned an invalid input entry.");
    }
    return {
      id: item["id"],
      name: item["name"],
      backend: item["backend"],
      source: item["source"],
      isDefault: item["isDefault"],
      ...(item["sampleFormat"] === undefined ? {} : { sampleFormat: item["sampleFormat"] }),
      ...(item["sampleRateHz"] === undefined ? {} : { sampleRateHz: item["sampleRateHz"] }),
      ...(item["channelCount"] === undefined ? {} : { channelCount: item["channelCount"] }),
    };
  });
  return { helper: executable, devices };
}

export async function selectNativeCaptureDevice(
  helper: string,
  source: NativeCaptureSource,
  requested?: string,
): Promise<NativeCaptureDevice> {
  const { devices } = await listNativeCaptureDevices(helper);
  const candidates = devices.filter((device) => device.source === source);
  if (requested && requested !== "default") {
    const matching = candidates.find(
      (device) => device.id === requested || device.name === requested,
    );
    if (matching) return matching;
    throw new Error(
      `The selected native ${source} device '${requested}' is not currently available. Choose an ID from record devices.`,
    );
  }
  const defaultDevice = candidates.find((device) => device.isDefault);
  if (defaultDevice) return defaultDevice;
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length) throw new Error(nativeCaptureLimitation(source));
  throw new Error(
    `Several native ${source} devices are available. Choose one with --${source === "microphone" ? "microphone" : "playback"} <id> from record devices.`,
  );
}

export async function probeNativeCaptureDevice(
  helper: string,
  device: NativeCaptureDevice,
): Promise<NativeCaptureProbe> {
  const result = await runHelper(helper, [
    "probe",
    "--source",
    device.source,
    "--device",
    device.id,
  ]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `The native ${device.source} signal probe exited with code ${String(result.code)}.`,
    );
  }
  return parseNativeProbe(result.stdout, device.source);
}

/** Measure a short app-audio stream without saving or archiving the samples. */
export async function probeNativeApplicationAudioDevice(
  helper: string,
  device: NativeApplicationAudioDevice,
): Promise<NativeCaptureProbe> {
  const result = await runHelper(helper, ["probe", "--application", device.id]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `The application-audio signal probe exited with code ${String(result.code)}.`,
    );
  }
  return parseNativeProbe(result.stdout, "application");
}

function parseNativeProbe(
  value: string,
  source: NativeCaptureSource | "application",
): NativeCaptureProbe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The native audio helper returned an invalid signal-probe result.");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed["id"] !== "string" ||
    typeof parsed["name"] !== "string" ||
    typeof parsed["backend"] !== "string" ||
    parsed["source"] !== source ||
    typeof parsed["sampleFormat"] !== "string" ||
    !Number.isSafeInteger(parsed["sampleRateHz"]) ||
    !Number.isSafeInteger(parsed["channelCount"]) ||
    !Number.isSafeInteger(parsed["sampleCount"]) ||
    !Number.isSafeInteger(parsed["durationMs"]) ||
    typeof parsed["rms"] !== "number" ||
    !Number.isFinite(parsed["rms"]) ||
    typeof parsed["peak"] !== "number" ||
    !Number.isFinite(parsed["peak"]) ||
    typeof parsed["dbfs"] !== "number" ||
    !Number.isFinite(parsed["dbfs"]) ||
    typeof parsed["signalDetected"] !== "boolean" ||
    parsed["probe"] !== "native-stream-opened-and-signal-measured"
  ) {
    throw new Error("The native audio helper returned an invalid signal-probe result.");
  }
  return parsed as unknown as NativeCaptureProbe;
}

function nativeCaptureLimitation(source: NativeCaptureSource): string {
  if (source === "microphone") {
    return "No native microphone input is available. Check device support and operating-system microphone permissions.";
  }
  if (process.platform === "linux") {
    return "No PipeWire monitor or loopback input is available. Select an explicit monitor source; this helper does not guess which input carries system playback.";
  }
  if (process.platform === "darwin") {
    return "No CoreAudio output-loopback endpoint is available. Duplex devices are omitted to avoid capturing their microphone input as system audio.";
  }
  return "No native system-output loopback device is available on this host. Check output-device support and routing.";
}

function installedResourceDirectories(): string[] {
  const values: string[] = [];
  const packageRoot = process.env["APPDIR"];
  if (packageRoot) {
    values.push(
      join(packageRoot, "usr", "lib", "tutorux"),
      join(packageRoot, "usr", "bin"),
      join(packageRoot, "resources"),
    );
  }
  if (process.platform === "win32") {
    for (const variable of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA"]) {
      const root = process.env[variable];
      if (root) values.push(join(root, "Tutorux"), join(root, "Programs", "Tutorux"));
    }
  } else if (process.platform === "darwin") {
    values.push(
      "/Applications/Tutorux.app/Contents/MacOS",
      "/Applications/Tutorux.app/Contents/Resources",
      join(homedir(), "Applications", "Tutorux.app", "Contents", "MacOS"),
      join(homedir(), "Applications", "Tutorux.app", "Contents", "Resources"),
    );
  } else {
    values.push(
      "/usr/lib/tutorux",
      "/usr/local/lib/tutorux",
      "/opt/tutorux",
      "/usr/bin",
      "/usr/local/bin",
    );
  }
  for (const entry of (process.env["PATH"] ?? "").split(delimiter).filter(Boolean))
    values.push(entry);
  return [...new Set(values)];
}

async function matchingSidecarPaths(directory: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return [];
  }
  const helperName =
    process.platform === "win32"
      ? /^tutorux-audio-helper(?:-[a-z0-9_-]+)?\.exe$/iu
      : /^tutorux-audio-helper(?:-[a-z0-9_-]+)?$/iu;
  return files.filter((name) => helperName.test(name)).map((name) => join(directory, name));
}

async function isExecutableFile(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runHelper(
  executable: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputOverflow = false;
    const timeout = setTimeout(() => {
      child.kill();
      rejectResult(new Error("The native audio helper did not respond within 15 seconds."));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) + chunk.length > MAX_HELPER_OUTPUT_BYTES) {
        outputOverflow = true;
        child.kill();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 32 * 1024) {
        stderr += chunk.toString("utf8").slice(0, 32 * 1024 - stderr.length);
      }
    });
    child.once("error", (error: Error) => {
      clearTimeout(timeout);
      rejectResult(new Error("Could not start the native audio helper: " + error.message));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (outputOverflow) {
        rejectResult(new Error("The native audio helper returned more than 4 MiB of data."));
      } else {
        resolveResult({ code, stdout, stderr });
      }
    });
  });
}
