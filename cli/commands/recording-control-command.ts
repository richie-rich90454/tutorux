import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { RecordType } from "../../frontend/archive/format";
import { canonicalizeProgressUuid } from "../../frontend/domain/student-progress";
import {
  RecordingControlError,
  sendRecordingControl,
  type RecordingControlCommand,
  type RecordingControlSnapshot,
  type RecordingControlState,
} from "../recording-control";
import { closeSnapshot, openForCommand } from "./archive-io";
import {
  CliError,
  RECORDING_WORKER_ID_ENVIRONMENT,
  RECORDING_WORKER_PASSPHRASE_ENVIRONMENT,
  archiveAccessContext,
  delay,
  emit,
  field,
  requiredOption,
} from "./shared";
import { requireLiveRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function startDetachedRecordingCommand(
  archivePath: string,
  args: ParsedArguments,
  output: CliIo,
  signal?: AbortSignal,
): Promise<number> {
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new CliError("The CLI entry path is unavailable for detached recording.");
  const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
  if (!sessionId) throw new CliError("--session must be a valid UUID.");
  const existingWorker = await sendRecordingControl(archivePath, sessionId, "status");
  if (existingWorker && isArchiveRecordingActive(existingWorker.state)) {
    throw new CliError(
      `A detached recording worker for session ${sessionId} is already ${existingWorker.state}.`,
    );
  }
  const workerId = randomUUID();
  const workerArguments = ["--record-worker"];
  const passphrase = archiveAccessContext.getStore()?.passphrase;
  const passphraseEnvironment = RECORDING_WORKER_PASSPHRASE_ENVIRONMENT;
  if (passphrase !== undefined) {
    workerArguments.push("--passphrase-env", passphraseEnvironment);
  }
  workerArguments.push(
    "--archive",
    resolve(archivePath),
    "record",
    "start",
    ...serializeParsedArguments(args, new Set(["detach"])),
  );

  const environment = { ...process.env };
  environment[RECORDING_WORKER_ID_ENVIRONMENT] = workerId;
  if (passphrase !== undefined) environment[passphraseEnvironment] = passphrase;
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...workerArguments], {
    cwd: process.cwd(),
    env: environment,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  let childExit: { code: number | null; signal: NodeJS.Signals | null; error?: Error } | undefined;
  const childClosed = new Promise<void>((resolveClose) => {
    child.once("error", (error: Error) => {
      childExit = { code: null, signal: null, error };
      resolveClose();
    });
    child.once("close", (code, childSignal) => {
      childExit ??= { code, signal: childSignal };
      resolveClose();
    });
  });
  const terminateWorker = async (requestStop: boolean, gracePeriodMs = 30_000): Promise<void> => {
    if (requestStop)
      await sendRecordingControl(archivePath, sessionId, "stop").catch(() => undefined);
    if (!childExit) await Promise.race([childClosed, delay(gracePeriodMs)]);
    if (!childExit) {
      try {
        child.kill("SIGTERM");
      } catch {
        child.kill();
      }
      await Promise.race([childClosed, delay(5_000)]);
    }
    if (!childExit) {
      try {
        child.kill("SIGKILL");
      } catch {
        child.kill();
      }
      await Promise.race([childClosed, delay(2_000)]);
    }
  };

  const deadline = Date.now() + 60_000;
  let current: RecordingControlSnapshot | undefined;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      await terminateWorker(true);
      return 130;
    }
    if (childExit) break;
    current = await sendRecordingControl(archivePath, sessionId, "status").catch(
      (error: unknown) => {
        if (error instanceof RecordingControlError && error.code === "recording_control_timeout")
          return undefined;
        throw error;
      },
    );
    if (current?.worker === "detached" && current.workerId !== workerId) {
      await terminateWorker(false, 1_000);
      throw new CliError(
        `A detached recording worker for session ${sessionId} is already ${current.state}.`,
      );
    }
    if (current && (current.state === "recording" || current.state === "paused")) break;
    if (current && isRecordingControlTerminal(current.state)) break;
    if (childExit) break;
    await Promise.race([childClosed, delay(100)]);
  }

  if (
    !current ||
    (current.state !== "recording" &&
      current.state !== "paused" &&
      !isRecordingControlTerminal(current.state))
  ) {
    current = await sendRecordingControl(archivePath, sessionId, "status").catch(() => undefined);
  }
  if (!current || current.state === "not-started") {
    current = await readRecordingSessionStatus(archivePath, sessionId).catch(() => undefined);
  }
  if (!current) {
    await terminateWorker(true);
    const detail = childExit?.error?.message;
    throw new CliError(
      detail
        ? `The detached recording worker could not start: ${detail}`
        : "The detached recording worker did not report a ready state within 60 seconds.",
    );
  }
  if (current.worker === "detached" && current.workerId !== workerId) {
    await terminateWorker(false, 1_000);
    throw new CliError(
      `A detached recording worker for session ${sessionId} is already ${current.state}.`,
    );
  }
  if (current.worker === "not-running" && isArchiveRecordingActive(current.state)) {
    await terminateWorker(false, 1_000);
    throw new CliError(
      `Session ${sessionId} has a persisted active recording state but no detached worker. Recover the saved recording before starting another take.`,
    );
  }
  if (
    current.state !== "recording" &&
    current.state !== "paused" &&
    current.state !== "completed" &&
    !isRecordingControlTerminal(current.state)
  ) {
    await terminateWorker(true);
    const detail = childExit?.error?.message
      ? `The detached recording worker could not start: ${childExit.error.message}`
      : childExit
        ? `The detached recording worker exited before audio capture became active (code ${String(childExit.code)}).`
        : "The detached recording worker did not report a ready state within 60 seconds.";
    throw new CliError(detail);
  }

  const report = { ...current, worker: current.worker === "detached" ? "detached" : "not-running" };
  const json = args.flags.has("json");
  emit(output, report, `Recording ${report.state}: ${report.message}`, json);
  return report.state === "recording" || report.state === "paused" || report.state === "completed"
    ? 0
    : 1;
}

export async function runRecordingControlCommand(
  action: string,
  archivePath: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  if (args.positionals.length)
    throw new CliError(`record ${action} does not accept positional arguments.`);
  for (const flag of args.flags) {
    if (flag !== "json" && flag !== "session")
      throw new CliError(`record ${action} does not accept --${flag}.`);
  }
  for (const option of args.options.keys()) {
    if (option !== "session") throw new CliError(`record ${action} does not accept --${option}.`);
  }
  if (args.flags.has("session")) throw new CliError("--session requires a value.");
  const sessionOption = args.options.get("session");
  const json = args.flags.has("json");

  if (sessionOption === undefined) {
    if (action !== "status") throw new CliError(`Recording control requires '--session UUID'.`);
    const snapshot = await openForCommand(archivePath);
    let activeCount: number;
    try {
      const sessions = await snapshot.listRecords(RecordType.session);
      activeCount = sessions.filter((session) =>
        isArchiveRecordingActive(field(session, "recording_state")),
      ).length;
    } finally {
      await closeSnapshot(snapshot);
    }
    emit(
      output,
      { active_recordings: String(activeCount) },
      `Active recording sessions: ${activeCount}.`,
      json,
    );
    return 0;
  }

  const sessionId = canonicalizeProgressUuid(sessionOption);
  if (!sessionId) throw new CliError("--session must be a valid UUID.");
  let current = await sendRecordingControl(
    archivePath,
    sessionId,
    action as RecordingControlCommand,
  );
  if (!current && action === "status")
    current = await readRecordingSessionStatus(archivePath, sessionId);
  if (!current) {
    throw new CliError(`No detached recording worker is active for session ${sessionId}.`);
  }
  if (action === "status") {
    emit(output, current, `Recording state: ${current.state}\n${current.message}`, json);
    return 0;
  }

  const expectedState: RecordingControlState | undefined =
    action === "pause" ? "paused" : action === "resume" ? "recording" : undefined;
  const deadline = Date.now() + (action === "stop" ? 30_000 : 5_000);
  while (Date.now() < deadline) {
    if (
      (expectedState !== undefined && current.state === expectedState) ||
      (action === "stop" && isRecordingControlTerminal(current.state))
    ) {
      break;
    }
    await delay(100);
    const refreshed = await sendRecordingControl(archivePath, sessionId, "status").catch(
      () => undefined,
    );
    if (refreshed) current = refreshed;
    else if (action === "stop") {
      current = await readRecordingSessionStatus(archivePath, sessionId).catch(() => current!);
      if (isArchiveRecordingTerminal(current.state)) break;
    } else {
      throw new CliError(
        "The detached recording worker stopped before confirming the requested state.",
      );
    }
    if (isRecordingControlTerminal(current.state)) break;
  }

  const confirmed =
    (expectedState !== undefined && current.state === expectedState) ||
    (action === "stop" &&
      (isRecordingControlTerminal(current.state) || isArchiveRecordingTerminal(current.state)));
  emit(output, current, `Recording state: ${current.state}\n${current.message}`, json);
  return confirmed ? 0 : 2;
}

export async function readRecordingSessionStatus(
  archivePath: string,
  sessionId: string,
): Promise<RecordingControlSnapshot> {
  const snapshot = await openForCommand(archivePath);
  try {
    const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
    const state = field(session, "recording_state", "not-started");
    const controlState = isRecordingControlState(state)
      ? state
      : state === "partial"
        ? "partial"
        : "not-started";
    return {
      sessionId,
      state: controlState,
      message:
        field(session, "recording_error") ||
        `Archive recording state is '${state}'. No detached worker is connected.`,
      worker: "not-running",
    };
  } finally {
    await closeSnapshot(snapshot);
  }
}

export function isArchiveRecordingActive(state: string): boolean {
  return (
    state === "starting" ||
    state === "initializing" ||
    state === "recording" ||
    state === "paused" ||
    state === "finalizing"
  );
}

export function isArchiveRecordingTerminal(state: string): boolean {
  return (
    state === "completed" || state === "interrupted" || state === "partial" || state === "failed"
  );
}

export function isRecordingControlState(state: string): state is RecordingControlState {
  return (
    state === "starting" ||
    state === "initializing" ||
    state === "recording" ||
    state === "paused" ||
    state === "finalizing" ||
    state === "completed" ||
    state === "interrupted" ||
    state === "failed"
  );
}

export function isRecordingControlTerminal(state: string): boolean {
  return (
    state === "completed" || state === "interrupted" || state === "partial" || state === "failed"
  );
}

export function serializeParsedArguments(
  args: ParsedArguments,
  omitFlags: ReadonlySet<string> = new Set(),
): string[] {
  return [
    ...[...args.options].map(([name, value]) => `--${name}=${value}`),
    ...[...args.flags].filter((flag) => !omitFlags.has(flag)).map((flag) => `--${flag}`),
  ];
}
