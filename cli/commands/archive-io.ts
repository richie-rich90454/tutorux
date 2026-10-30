import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { link, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ArchiveRecord } from "../../frontend/archive/format";
import {
  appendRecords,
  openArchiveSource,
  type ArchiveSnapshot,
} from "../../frontend/archive/archive";
import {
  NodeFileArchiveSource,
  findActiveNodeArchiveSource,
} from "../../frontend/archive/node-source";
import { acquireArchiveLock } from "../archive-lock";
import { CliError, archiveAccessContext, isNotFound } from "./shared";

export async function openForCommand(path: string): Promise<ArchiveSnapshot> {
  const source = await NodeFileArchiveSource.open(resolve(path));
  let snapshot: ArchiveSnapshot | undefined;
  try {
    snapshot = await openArchiveSource(source);
    return await unlockSnapshotForCli(snapshot, true);
  } catch (error) {
    snapshot?.lock();
    await source.close();
    throw error;
  }
}

export async function unlockSnapshotForCli(
  snapshot: ArchiveSnapshot,
  required: boolean,
): Promise<ArchiveSnapshot> {
  if (!snapshot.encrypted || !snapshot.locked) return snapshot;
  const passphrase = archiveAccessContext.getStore()?.passphrase;
  if (passphrase === undefined) {
    if (!required) return snapshot;
    throw new CliError("This archive is encrypted. Supply --passphrase-env <name> to unlock it.");
  }
  try {
    return await snapshot.unlock(passphrase);
  } catch (error) {
    snapshot.lock();
    throw error;
  }
}

export async function closeSnapshot(snapshot: ArchiveSnapshot): Promise<void> {
  const source = snapshot.source;
  snapshot.lock();
  await Promise.all(findNodeArchiveSources(source).map((nodeSource) => nodeSource.close()));
}

export async function mutateArchive(
  path: string,
  changes: readonly ArchiveRecord[],
  expectedGeneration?: bigint,
  generationConflictMessage = "The archive changed after this operation was reviewed. Review it again before retrying.",
): Promise<ArchiveRecord[]> {
  const archivePath = resolve(path);
  const source = await NodeFileArchiveSource.open(archivePath);
  let current: ArchiveSnapshot | undefined;
  let next: ArchiveSnapshot | undefined;
  try {
    current = await unlockSnapshotForCli(await openArchiveSource(source), true);
    if (expectedGeneration !== undefined && current.commit.generation !== expectedGeneration) {
      throw new CliError(generationConflictMessage);
    }
    next = await appendRecords(current, changes);
    await writeSourceAtomically(archivePath, next);
    const savedRecords: ArchiveRecord[] = [];
    for (const change of changes) {
      const saved = await next.getRecord(change.type, change.id);
      if (saved) savedRecords.push(saved);
    }
    return savedRecords;
  } finally {
    current?.lock();
    if (next && next !== current) next.lock();
    await source.close();
  }
}

export async function writeSourceAtomically(
  path: string,
  snapshot: ArchiveSnapshot,
): Promise<void> {
  const destination = resolve(path);
  const temporary = join(dirname(destination), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  try {
    const chunkSize = 1024 * 1024;
    for (let offset = 0n; offset < snapshot.source.size;) {
      const length = Number(
        snapshot.source.size - offset > BigInt(chunkSize)
          ? BigInt(chunkSize)
          : snapshot.source.size - offset,
      );
      const bytes = await snapshot.source.read(offset, length);
      let written = 0;
      while (written < bytes.length) {
        const result = await output.write(bytes, written, bytes.length - written);
        if (result.bytesWritten === 0) throw new Error("Archive output stopped accepting bytes.");
        written += result.bytesWritten;
      }
      offset += BigInt(length);
    }
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await output.close();
  let destinationLock: Awaited<ReturnType<typeof acquireArchiveLock>> | undefined;
  let sourceLock: NodeFileArchiveSource | undefined;
  try {
    for (const candidate of findNodeArchiveSources(snapshot.source)) {
      if (await candidate.isSamePath(destination)) {
        sourceLock = candidate;
        break;
      }
    }
    sourceLock ??= findActiveNodeArchiveSource(destination);
    if (sourceLock) {
      await sourceLock.upgradeLock();
      if (!(await sourceLock.stillMatchesPath())) {
        throw new CliError(
          "The archive changed before the updated generation could be published. Reopen it and retry.",
        );
      }
      await sourceLock.prepareLockReplacement(temporary);
    } else {
      destinationLock = await acquireArchiveLock(destination, "exclusive");
      await destinationLock.prepareReplacement(temporary);
    }
    await replaceFile(temporary, destination);
    if (sourceLock) await sourceLock.adoptLockReplacement();
    else await destinationLock?.adoptReplacement();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await destinationLock?.close();
  }
}

export async function writeSourceToNewFileAtomically(
  path: string,
  snapshot: ArchiveSnapshot,
  validateBeforePublish?: () => Promise<void>,
  purpose = "Repair",
): Promise<void> {
  const destination = resolve(path);
  try {
    await stat(destination);
    throw new CliError(`${purpose} output already exists: ${destination}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isNotFound(error)) throw error;
  }

  const temporary = join(dirname(destination), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  let closed = false;
  try {
    const chunkSize = 1024 * 1024;
    for (let offset = 0n; offset < snapshot.source.size;) {
      const length = Number(
        snapshot.source.size - offset > BigInt(chunkSize)
          ? BigInt(chunkSize)
          : snapshot.source.size - offset,
      );
      const bytes = await snapshot.source.read(offset, length);
      if (bytes.byteLength !== length) {
        throw new CliError("The generated archive source returned an incomplete read.");
      }
      let written = 0;
      while (written < bytes.length) {
        const result = await output.write(bytes, written, bytes.length - written);
        if (result.bytesWritten === 0) throw new Error("Archive output stopped accepting bytes.");
        written += result.bytesWritten;
      }
      offset += BigInt(length);
    }
    await output.sync();
    await output.close();
    closed = true;
  } catch (error) {
    if (!closed) await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await publishStagedFileAtomically(temporary, destination, validateBeforePublish, purpose);
}

export async function publishStagedFileAtomically(
  temporary: string,
  path: string,
  validateBeforePublish?: () => Promise<void>,
  purpose = "Archive",
): Promise<void> {
  const destination = resolve(path);
  const destinationLock = await acquireArchiveLock(destination, "exclusive");
  try {
    try {
      await stat(destination);
      throw new CliError(`${purpose} output already exists: ${destination}`);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (!isNotFound(error)) throw error;
    }
    await validateBeforePublish?.();
    await destinationLock.prepareReplacement(temporary);
    if (process.platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$source = [Environment]::GetEnvironmentVariable('TUTORUX_PUBLISH_TEMP')",
        "$target = [Environment]::GetEnvironmentVariable('TUTORUX_PUBLISH_DESTINATION')",
        "[System.IO.File]::Move($source, $target)",
      ].join("\n");
      const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
          {
            windowsHide: true,
            env: {
              ...process.env,
              TUTORUX_PUBLISH_TEMP: temporary,
              TUTORUX_PUBLISH_DESTINATION: destination,
            },
          },
          (error) => (error ? rejectPromise(error) : resolvePromise()),
        );
      });
    } else {
      await link(temporary, destination);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    await destinationLock.adoptReplacement();
    if (process.platform !== "win32") {
      try {
        const directory = await open(dirname(destination), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown filesystem error";
        throw new CliError(
          `${purpose} exists at ${destination}, but its directory could not be durably flushed: ${detail}`,
        );
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new CliError(`${purpose} output already exists: ${destination}`);
    }
    try {
      await stat(destination);
      throw new CliError(`${purpose} output already exists: ${destination}`);
    } catch (destinationError) {
      if (destinationError instanceof CliError) throw destinationError;
      if (!isNotFound(destinationError)) throw destinationError;
    }
    throw error;
  } finally {
    await destinationLock.close();
  }
}

export function findNodeArchiveSources(source: ArchiveSnapshot["source"]): NodeFileArchiveSource[] {
  const pending = [source as object];
  const visited = new Set<object>();
  const sources = new Set<NodeFileArchiveSource>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current instanceof NodeFileArchiveSource) {
      sources.add(current);
      continue;
    }
    const composite = current as {
      appended?: unknown;
      base?: unknown;
      original?: unknown;
      source?: unknown;
    };
    for (const nested of [
      composite.base,
      composite.appended,
      composite.original,
      composite.source,
    ]) {
      if (nested && typeof nested === "object") pending.push(nested);
    }
  }
  return [...sources];
}

export async function writeBytesAtomically(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await stat(path);
    throw new CliError(`Refusing to overwrite the existing file: ${path}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isNotFound(error)) throw error;
  }
  const temporary = join(dirname(path), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  try {
    await output.writeFile(bytes);
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await output.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function stageBytesForPublication(path: string, bytes: Uint8Array): Promise<string> {
  const temporary = join(dirname(path), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  try {
    await output.writeFile(bytes);
    await output.sync();
    await output.close();
    return temporary;
  } catch (error) {
    await output.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeTextAtomically(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  try {
    await output.writeFile(text, { encoding: "utf8" });
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await output.close();
  await replaceFile(temporary, path);
}

export async function replaceFile(temporary: string, target: string): Promise<void> {
  const backup = `${target}.${randomUUID()}.backup`;
  let hadTarget = false;
  try {
    await stat(target);
    hadTarget = true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    if (hadTarget) await rename(target, backup);
    await rename(temporary, target);
    if (hadTarget) await rm(backup, { force: true });
  } catch (error) {
    if (hadTarget) await rename(backup, target).catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}
