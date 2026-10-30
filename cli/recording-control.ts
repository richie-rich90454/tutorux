import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";

const CONTROL_PROTOCOL_VERSION = 1;
const MAXIMUM_CONTROL_MESSAGE_BYTES = 16 * 1024;
const CONTROL_CONNECT_TIMEOUT_MS = 1_500;

export type RecordingControlState =
  | "starting"
  | "initializing"
  | "recording"
  | "paused"
  | "finalizing"
  | "completed"
  | "interrupted"
  | "failed";

export type RecordingControlCommand = "status" | "pause" | "resume" | "stop";

export interface RecordingControlSnapshot {
  sessionId: string;
  state: RecordingControlState | "not-started" | "partial";
  message: string;
  worker: "detached" | "not-running";
  workerId?: string;
}

export interface RecordingControlWorker {
  readonly stopRequested: () => boolean;
  readonly pauseRequested: () => boolean;
  readonly state: () => RecordingControlState;
  readonly stateChanged: (state: RecordingControlState, message: string) => void;
  close(): Promise<void>;
}

interface ControlEndpoint {
  address: string;
  filesystemPath?: string;
}

interface ControlRequest {
  version: number;
  command: RecordingControlCommand;
}

interface ControlResponse {
  version: number;
  ok: boolean;
  state: RecordingControlState;
  message: string;
  workerId?: string;
  error?: { code: string; message: string };
}

export class RecordingControlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RecordingControlError";
    this.code = code;
  }
}

/** Start the local, per-session control endpoint used by detached CLI workers. */
export async function startRecordingControlWorker(
  archivePath: string,
  sessionId: string,
  workerId: string,
): Promise<RecordingControlWorker> {
  const endpoint = await recordingControlEndpoint(archivePath, sessionId);
  const previous = await requestRecordingControlAt(endpoint.address, "status");
  if (previous) {
    throw new RecordingControlError(
      "recording_worker_already_running",
      `A recording worker for session ${sessionId} is already ${previous.state}.`,
    );
  }
  await removeStaleSocket(endpoint);

  let state: RecordingControlState = "starting";
  let message = "The detached recording worker is starting.";
  let wantsStop = false;
  let wantsPause = false;
  let closing = false;
  const server = createServer((socket) => {
    handleControlConnection(socket, (request) => {
      if (!isControlRequest(request)) {
        return {
          ...errorResponse(
            state,
            message,
            "recording_control_protocol_invalid",
            "Malformed recording control request.",
          ),
          workerId,
        };
      }
      const response = respondToControl(request.command, {
        get state() {
          return state;
        },
        get message() {
          return message;
        },
        setStop(value) {
          wantsStop = value;
        },
        setPause(value) {
          wantsPause = value;
        },
      });
      return { ...response, workerId };
    });
  });
  await listen(server, endpoint.address);
  let socketIdentity: { dev: number; ino: number } | undefined;
  try {
    if (endpoint.filesystemPath) {
      await chmod(endpoint.filesystemPath, 0o600);
      const details = await lstat(endpoint.filesystemPath);
      socketIdentity = { dev: details.dev, ino: details.ino };
    }
  } catch (error) {
    await closeServer(server);
    if (endpoint.filesystemPath) await unlink(endpoint.filesystemPath).catch(() => {});
    throw error;
  }

  return {
    stopRequested: () => wantsStop,
    pauseRequested: () => wantsPause,
    state: () => state,
    stateChanged(nextState, nextMessage) {
      if (closing) return;
      state = nextState;
      message = nextMessage;
    },
    async close() {
      if (closing) return;
      closing = true;
      await closeServer(server);
      if (endpoint.filesystemPath && socketIdentity) {
        const current = await lstat(endpoint.filesystemPath).catch(() => undefined);
        if (
          current?.isSocket() &&
          current.dev === socketIdentity.dev &&
          current.ino === socketIdentity.ino
        ) {
          await unlink(endpoint.filesystemPath).catch(() => {});
        }
      }
    },
  };
}

/** Return undefined when no worker owns this session's control endpoint. */
export async function sendRecordingControl(
  archivePath: string,
  sessionId: string,
  command: RecordingControlCommand,
): Promise<RecordingControlSnapshot | undefined> {
  const endpoint = await recordingControlEndpoint(archivePath, sessionId);
  const response = await requestRecordingControlAt(endpoint.address, command);
  if (!response) return undefined;
  if (!response.ok) {
    throw new RecordingControlError(
      response.error?.code ?? "recording_control_rejected",
      response.error?.message ?? "The recording worker rejected the control request.",
    );
  }
  return {
    sessionId: sessionId.toLowerCase(),
    state: response.state,
    message: response.message,
    worker: "detached",
    ...(response.workerId === undefined ? {} : { workerId: response.workerId }),
  };
}

async function recordingControlEndpoint(
  archivePath: string,
  sessionId: string,
): Promise<ControlEndpoint> {
  const canonicalArchivePath = await realpath(resolve(archivePath));
  const digest = createHash("sha256")
    .update(canonicalArchivePath)
    .update("\0")
    .update(sessionId.toLowerCase())
    .digest("hex");
  if (process.platform === "win32") {
    return { address: `\\\\.\\pipe\\tutorux-recording-${digest}` };
  }

  const username = process.getuid ? String(process.getuid()) : "user";
  // Keep both the directory and socket basename compact: macOS temporary
  // directories can already be long, and Unix-domain socket paths are capped
  // at roughly 104 bytes on common platforms.
  const directoryName = `tx-${createHash("sha256").update(username).digest("hex").slice(0, 8)}`;
  const directory = join(tmpdir(), directoryName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryDetails = await lstat(directory);
  if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
    throw new RecordingControlError(
      "recording_control_directory_invalid",
      "The private recording control directory is unsafe.",
    );
  }
  if (process.getuid && directoryDetails.uid !== process.getuid()) {
    throw new RecordingControlError(
      "recording_control_directory_invalid",
      "The recording control directory belongs to another user.",
    );
  }
  if ((directoryDetails.mode & 0o077) !== 0) await chmod(directory, 0o700);
  const filesystemPath = join(directory, `${digest.slice(0, 32)}.sock`);
  if (Buffer.byteLength(filesystemPath, "utf8") >= 104) {
    throw new RecordingControlError(
      "recording_control_path_too_long",
      "The system temporary path is too long for local recording control.",
    );
  }
  return { address: filesystemPath, filesystemPath };
}

async function removeStaleSocket(endpoint: ControlEndpoint): Promise<void> {
  if (!endpoint.filesystemPath) return;
  const existing = await lstat(endpoint.filesystemPath).catch(() => undefined);
  if (!existing) return;
  if (existing.isSymbolicLink() || !existing.isSocket()) {
    throw new RecordingControlError(
      "recording_control_path_unsafe",
      "The recording control endpoint is occupied by an unexpected filesystem entry.",
    );
  }
  if (await requestRecordingControlAt(endpoint.address, "status")) {
    throw new RecordingControlError(
      "recording_worker_already_running",
      "A recording worker already owns this session control endpoint.",
    );
  }
  const current = await lstat(endpoint.filesystemPath).catch(() => undefined);
  if (!current) return;
  if (
    !current.isSocket() ||
    current.isSymbolicLink() ||
    current.dev !== existing.dev ||
    current.ino !== existing.ino
  ) {
    throw new RecordingControlError(
      "recording_control_path_changed",
      "The recording control endpoint changed while checking for a stale socket.",
    );
  }
  await unlink(endpoint.filesystemPath);
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });
}

function handleControlConnection(
  socket: Socket,
  respond: (request: unknown) => ControlResponse,
): void {
  let input = Buffer.alloc(0);
  let finished = false;
  socket.setTimeout(CONTROL_CONNECT_TIMEOUT_MS, () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    if (finished) return;
    if (input.byteLength + chunk.byteLength > MAXIMUM_CONTROL_MESSAGE_BYTES) {
      finished = true;
      socket.end(
        JSON.stringify(
          errorResponse(
            "starting",
            "",
            "recording_control_request_too_large",
            "The recording control request is too large.",
          ),
        ) + "\n",
      );
      return;
    }
    input = Buffer.concat([input, chunk]);
    const newline = input.indexOf(0x0a);
    if (newline < 0) return;
    finished = true;
    try {
      const request = JSON.parse(input.subarray(0, newline).toString("utf8")) as unknown;
      socket.end(`${JSON.stringify(respond(request))}\n`);
    } catch {
      socket.end(
        JSON.stringify(
          errorResponse(
            "starting",
            "",
            "recording_control_protocol_invalid",
            "Malformed recording control request.",
          ),
        ) + "\n",
      );
    }
  });
  socket.on("error", () => {});
}

function isControlRequest(request: unknown): request is ControlRequest {
  if (typeof request !== "object" || request === null) return false;
  const value = request as Record<string, unknown>;
  return (
    value["version"] === CONTROL_PROTOCOL_VERSION &&
    (value["command"] === "status" ||
      value["command"] === "pause" ||
      value["command"] === "resume" ||
      value["command"] === "stop")
  );
}

function respondToControl(
  command: RecordingControlCommand,
  state: {
    readonly state: RecordingControlState;
    readonly message: string;
    setStop(value: boolean): void;
    setPause(value: boolean): void;
  },
): ControlResponse {
  if (command === "status") return successResponse(state.state, state.message);
  if (command === "stop") {
    if (isTerminalState(state.state)) return successResponse(state.state, state.message);
    state.setStop(true);
    return successResponse(state.state, "Recording stop was requested.");
  }
  if (command === "pause") {
    if (state.state !== "recording") {
      return errorResponse(
        state.state,
        state.message,
        "recording_not_active",
        "Recording is not in the active state.",
      );
    }
    state.setPause(true);
    return successResponse(state.state, "Recording pause was requested.");
  }
  if (state.state !== "paused") {
    return errorResponse(
      state.state,
      state.message,
      "recording_not_paused",
      "Recording is not paused.",
    );
  }
  state.setPause(false);
  return successResponse(state.state, "Recording resume was requested.");
}

function successResponse(state: RecordingControlState, message: string): ControlResponse {
  return { version: CONTROL_PROTOCOL_VERSION, ok: true, state, message };
}

function errorResponse(
  state: RecordingControlState,
  message: string,
  code: string,
  errorMessage: string,
): ControlResponse {
  return {
    version: CONTROL_PROTOCOL_VERSION,
    ok: false,
    state,
    message,
    error: { code, message: errorMessage },
  };
}

function isTerminalState(state: RecordingControlState): boolean {
  return state === "completed" || state === "interrupted" || state === "failed";
}

async function requestRecordingControlAt(
  address: string,
  command: RecordingControlCommand,
): Promise<ControlResponse | undefined> {
  return await new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(address);
    let input = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, response?: ControlResponse): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectResponse(error);
      else resolveResponse(response);
    };
    socket.setTimeout(CONTROL_CONNECT_TIMEOUT_MS, () => {
      finish(
        new RecordingControlError(
          "recording_control_timeout",
          "The recording control worker did not respond.",
        ),
      );
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ version: CONTROL_PROTOCOL_VERSION, command })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (input.byteLength + chunk.byteLength > MAXIMUM_CONTROL_MESSAGE_BYTES) {
        finish(
          new RecordingControlError(
            "recording_control_response_too_large",
            "The recording control response is too large.",
          ),
        );
        return;
      }
      input = Buffer.concat([input, chunk]);
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const response = JSON.parse(input.subarray(0, newline).toString("utf8")) as unknown;
        if (!isControlResponse(response)) throw new Error("Malformed recording control response.");
        finish(undefined, response);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Malformed recording control response."));
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (
        error.code === "ENOENT" ||
        error.code === "ECONNREFUSED" ||
        error.code === "ECONNRESET" ||
        error.code === "EPIPE"
      ) {
        finish(undefined, undefined);
      } else {
        finish(error);
      }
    });
  });
}

function isControlResponse(response: unknown): response is ControlResponse {
  if (typeof response !== "object" || response === null) return false;
  const value = response as Record<string, unknown>;
  return (
    value["version"] === CONTROL_PROTOCOL_VERSION &&
    typeof value["ok"] === "boolean" &&
    typeof value["message"] === "string" &&
    typeof value["state"] === "string" &&
    (value["workerId"] === undefined || typeof value["workerId"] === "string")
  );
}
