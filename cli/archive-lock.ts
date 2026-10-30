import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ArchiveLockMode = "shared" | "exclusive";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = resolve(MODULE_DIRECTORY, "..");
const MAX_PROTOCOL_BYTES = 4096;
const HELPER_START_TIMEOUT_MS = 15_000;

interface ProtocolWaiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Hold a cross-process archive lock using the same native lock file as the Tauri host. */
export async function acquireArchiveLock(
  path: string,
  mode: ArchiveLockMode,
): Promise<ArchiveLockHandle> {
  const executable = await resolveArchiveLockHelper();
  const child = spawn(
    executable,
    ["archive-lock", mode === "shared" ? "--shared" : "--exclusive", resolve(path)],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const lock = new ArchiveLockHandle(child);
  try {
    const response = await lock.readResponse(HELPER_START_TIMEOUT_MS);
    if (response !== "LOCKED") {
      throw new Error("The native archive-lock helper returned an invalid response.");
    }
    return lock;
  } catch (error) {
    await lock.close().catch(() => undefined);
    throw error;
  }
}

/** A small line protocol keeps the native OS lock alive until the Node handle is closed. */
export class ArchiveLockHandle {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<number | null>;
  private readonly lines: string[] = [];
  private readonly waiters: ProtocolWaiter[] = [];
  private stdoutBuffer = "";
  private stderr = "";
  private terminalError: Error | undefined;
  private closing: Promise<void> | undefined;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.exited = new Promise((resolveExit) => {
      child.once("close", (code) => resolveExit(code));
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeOutput(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_PROTOCOL_BYTES);
    });
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      if (!this.closing && code !== 0) {
        this.fail(
          new Error(
            this.stderr.trim() ||
              "The native archive-lock helper exited with " +
                (signal ? "signal " + signal : "code " + String(code)) +
                ". Build the Tutorux native helper and try again.",
          ),
        );
      }
      this.finishWaiters();
    });
  }

  async upgrade(): Promise<void> {
    this.child.stdin.write("upgrade\n");
    const response = await this.readResponse(HELPER_START_TIMEOUT_MS);
    if (response === "EXCLUSIVE") return;
    if (response.startsWith("ERROR ")) throw new Error(response.slice("ERROR ".length));
    throw new Error("The native archive-lock helper could not upgrade the archive lock.");
  }

  async downgrade(): Promise<void> {
    this.child.stdin.write("downgrade\n");
    const response = await this.readResponse(HELPER_START_TIMEOUT_MS);
    if (response === "SHARED") return;
    if (response.startsWith("ERROR ")) throw new Error(response.slice("ERROR ".length));
    throw new Error("The native archive-lock helper could not downgrade the archive lock.");
  }

  async prepareReplacement(path: string): Promise<void> {
    this.child.stdin.write(`prepare-replacement ${JSON.stringify(resolve(path))}\n`);
    const response = await this.readResponse(HELPER_START_TIMEOUT_MS);
    if (response === "REPLACEMENT_READY") return;
    if (response.startsWith("ERROR ")) throw new Error(response.slice("ERROR ".length));
    throw new Error("The native archive-lock helper could not lock the staged replacement.");
  }

  async adoptReplacement(): Promise<void> {
    this.child.stdin.write("adopt-replacement\n");
    const response = await this.readResponse(HELPER_START_TIMEOUT_MS);
    if (response === "REPLACEMENT_ADOPTED") return;
    if (response.startsWith("ERROR ")) throw new Error(response.slice("ERROR ".length));
    throw new Error("The native archive-lock helper could not adopt the published archive.");
  }

  readResponse(timeoutMs: number): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise((resolveLine, rejectLine) => {
      const waiter = {
        resolve: resolveLine,
        reject: rejectLine,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          rejectLine(new Error("The native archive-lock helper did not respond in time."));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.child.stdin.end();
      const exit = await this.exited;
      if (exit !== 0 && exit !== null) {
        throw new Error(this.stderr.trim() || "The native archive-lock helper did not close cleanly.");
      }
    })();
    return this.closing;
  }

  private consumeOutput(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_PROTOCOL_BYTES) {
      this.fail(new Error("The native archive-lock helper exceeded its protocol limit."));
      this.child.kill();
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        this.lines.push(line);
      }
    }
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.finishWaiters();
  }

  private finishWaiters(): void {
    if (!this.terminalError) {
      this.terminalError = new Error(
        this.stderr.trim() || "The native archive-lock helper closed before responding.",
      );
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.terminalError);
    }
  }

  private removeWaiter(waiter: (typeof this.waiters)[number]): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }
}

async function resolveArchiveLockHelper(): Promise<string> {
  const configured = process.env["TUTORUX_ARCHIVE_LOCK_HELPER"]?.trim();
  if (configured) {
    const path = resolve(configured);
    if (await isExecutableFile(path)) return path;
    throw new Error("TUTORUX_ARCHIVE_LOCK_HELPER does not point to an executable file: " + path);
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
  for (const target of await listDirectory(helperTargetDirectory)) {
    for (const profile of ["debug", "release"]) {
      candidates.add(join(helperTargetDirectory, target, profile, executableName));
    }
  }

  for (const path of await matchingSidecars(join(PROJECT_DIRECTORY, "src-tauri", "binaries"))) {
    candidates.add(path);
  }
  for (const directory of installedResourceDirectories()) {
    candidates.add(join(directory, executableName));
    candidates.add(join(directory, "resources", executableName));
    for (const path of await matchingSidecars(directory)) candidates.add(path);
    for (const path of await matchingSidecars(join(directory, "resources"))) candidates.add(path);
  }

  for (const path of candidates) {
    if (await isExecutableFile(path)) return path;
  }
  throw new Error(
    "Archive access needs Tutorux's native archive-lock helper. Build it with npm run build:audio-helper or install the Tutorux desktop bundle.",
  );
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
    values.push("/usr/lib/tutorux", "/usr/local/lib/tutorux", "/opt/tutorux", "/usr/bin", "/usr/local/bin");
  }
  for (const entry of (process.env["PATH"] ?? "").split(delimiter).filter(Boolean)) values.push(entry);
  return [...new Set(values)];
}

async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function matchingSidecars(directory: string): Promise<string[]> {
  const executablePattern =
    process.platform === "win32"
      ? /^tutorux-audio-helper(?:-[a-z0-9_-]+)?\.exe$/iu
      : /^tutorux-audio-helper(?:-[a-z0-9_-]+)?$/u;
  return (await listDirectory(directory))
    .filter((name) => executablePattern.test(name))
    .map((name) => join(directory, name));
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
