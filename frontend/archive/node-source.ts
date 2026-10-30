import { open, type FileHandle } from "node:fs/promises";
import { realpath, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { acquireArchiveLock, type ArchiveLockHandle, type ArchiveLockMode } from "../../cli/archive-lock";
import type { ArchiveByteSource } from "./source";

/** A bounded, positional archive reader for the Node CLI. */
export class NodeFileArchiveSource implements ArchiveByteSource {
  private closed = false;
  private readHandleClosed = false;

  private constructor(
    private readonly handle: FileHandle,
    private readonly lock: ArchiveLockHandle,
    readonly path: string,
    private readonly initialVersion: FileVersion,
    readonly size: bigint,
  ) {}

  static async open(path: string, lockMode: ArchiveLockMode = "shared"): Promise<NodeFileArchiveSource> {
    const canonicalPath = await realpath(path);
    const lock = await acquireArchiveLock(canonicalPath, lockMode);
    let handle: FileHandle | undefined;
    try {
      if (normalizePath(await realpath(path)) !== normalizePath(canonicalPath)) {
        throw new Error("The selected archive location changed while it was being opened.");
      }
      handle = await open(canonicalPath, "r");
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("The selected archive is not a regular file.");
      const initialVersion = await getFileVersion(handle);
      return new NodeFileArchiveSource(handle, lock, canonicalPath, initialVersion, initialVersion.size);
    } catch (error) {
      await handle?.close();
      await lock.close();
      throw error;
    }
  }

  async upgradeLock(): Promise<void> {
    await this.lock.upgrade();
  }

  async prepareLockReplacement(path: string): Promise<void> {
    await this.lock.prepareReplacement(path);
  }

  async adoptLockReplacement(): Promise<void> {
    await this.lock.adoptReplacement();
  }

  async isSamePath(path: string): Promise<boolean> {
    const canonicalPath = await realpath(path).catch(() => path);
    return normalizePath(canonicalPath) === normalizePath(this.path);
  }

  /** Check that the opened inode still matches the selected path before publishing a write. */
  async stillMatchesPath(): Promise<boolean> {
    try {
      const [opened, current] = await Promise.all([
        getFileVersion(this.handle),
        stat(this.path, { bigint: true }),
      ]);
      return sameFileVersion(opened, this.initialVersion) && sameFileVersion(current, this.initialVersion);
    } catch {
      return false;
    }
  }

  async read(offset: bigint, length: number): Promise<Uint8Array> {
    if (this.readHandleClosed || this.closed) {
      throw new Error("The archive reader has been closed.");
    }
    if (
      offset < 0n ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset + BigInt(length) > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(length) > this.size - offset
    ) {
      throw new RangeError("Archive read is outside the selected file.");
    }
    const bytes = new Uint8Array(length);
    let readOffset = 0;
    while (readOffset < length) {
      const result = await this.handle.read(
        bytes,
        readOffset,
        length - readOffset,
        Number(offset) + readOffset,
      );
      if (result.bytesRead === 0) throw new Error("The archive changed or ended during a read.");
      readOffset += result.bytesRead;
    }
    return bytes;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.closeReadHandle();
    } finally {
      await this.lock.close();
    }
  }

  /** Close the archive data handle while retaining its cross-process lock for replacement. */
  async closeReadHandle(): Promise<void> {
    if (this.readHandleClosed) return;
    this.readHandleClosed = true;
    await this.handle.close();
  }
}

interface FileVersion {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

async function getFileVersion(handle: FileHandle): Promise<FileVersion> {
  const stats = await handle.stat({ bigint: true });
  return fileVersion(stats);
}

function fileVersion(stats: BigIntStats): FileVersion {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameFileVersion(left: FileVersion, right: FileVersion): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}
