import { randomUUID } from "node:crypto";
import { link, lstat, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { appendStagedAssetRecords, type ArchiveSnapshot } from "../frontend/archive/archive";
import { NodeFileArchiveSource } from "../frontend/archive/node-source";
import type { ArchiveStaging } from "../frontend/archive/staging";
import { RecordType, type ArchiveRecord } from "../frontend/archive/format";
import { iterateVerifiedAssetChunks, MAX_ASSET_BYTES } from "../frontend/domain/assets";
import {
  prepareStreamingAssetImport,
  type AssetReadSource,
} from "../frontend/domain/assets-stream";

export interface CliAssetImportResult {
  readonly snapshot: ArchiveSnapshot;
  readonly metadata: ArchiveRecord;
  readonly deduplicated: boolean;
  readonly chunkCount: number;
}

/** Append one file as an independently verified, privately staged archive generation. */
export async function appendCliAssetFile(
  snapshot: ArchiveSnapshot,
  archivePath: string,
  inputPath: string,
  sessionId: string,
  transformMetadata?: (record: ArchiveRecord) => ArchiveRecord,
): Promise<CliAssetImportResult> {
  const { source, close } = await openCliAssetReadSource(inputPath);
  try {
    const imported = await prepareStreamingAssetImport(snapshot, source, sessionId);
    const metadata = transformMetadata?.(imported.metadata) ?? imported.metadata;
    async function* records(): AsyncGenerator<ArchiveRecord> {
      for await (const record of imported.records()) {
        yield record.type === RecordType.assetMetadata ? metadata : record;
      }
    }
    const staging = await createCliArchiveStaging(archivePath);
    try {
      const next = await appendStagedAssetRecords(snapshot, records(), staging);
      return {
        snapshot: next,
        metadata,
        deduplicated: imported.deduplicated,
        chunkCount: imported.chunkCount,
      };
    } catch (error) {
      await staging.abort().catch(() => undefined);
      throw error;
    }
  } finally {
    await close();
  }
}

/** Stream verified material chunks to a temporary file and publish only after hash validation. */
export async function exportCliAssetAtomically(
  snapshot: ArchiveSnapshot,
  metadata: ArchiveRecord,
  destination: string,
): Promise<number> {
  try {
    await lstat(destination);
    throw new Error(`Refusing to overwrite the existing file: ${destination}`);
  } catch (error) {
    if (isNotFound(error)) {
      // The destination is available for a new export.
    } else {
      throw error;
    }
  }

  const temporary = join(dirname(destination), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  let closed = false;
  let byteCount = 0;
  try {
    for await (const chunk of iterateVerifiedAssetChunks(snapshot, metadata)) {
      await writeAll(output, chunk);
      byteCount += chunk.byteLength;
    }
    await output.sync();
    await output.close();
    closed = true;
    await link(temporary, destination);
    await rm(temporary, { force: true }).catch(() => undefined);
    return byteCount;
  } catch (error) {
    if (!closed) await output.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function openCliAssetReadSource(inputPath: string): Promise<{
  source: AssetReadSource;
  close: () => Promise<void>;
}> {
  const absolutePath = resolve(inputPath);
  const pathInfo = await lstat(absolutePath);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw new Error("Material input must be a regular, non-symlink file.");
  }

  const handle = await open(absolutePath, "r");
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.dev !== pathInfo.dev ||
      info.ino !== pathInfo.ino ||
      !Number.isSafeInteger(info.size)
    ) {
      throw new Error("Material input changed while it was being opened.");
    }
    if (info.size > MAX_ASSET_BYTES) {
      throw new Error("Material exceeds the configured 256 MiB import limit.");
    }

    const source: AssetReadSource = {
      name: basename(absolutePath),
      size: info.size,
      async read(offset, length) {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          offset + length > info.size
        ) {
          throw new RangeError("Material read is outside the selected file.");
        }
        const bytes = new Uint8Array(length);
        let readOffset = 0;
        while (readOffset < length) {
          const result = await handle.read(
            bytes,
            readOffset,
            length - readOffset,
            offset + readOffset,
          );
          if (result.bytesRead === 0) throw new Error("Material input ended during import.");
          readOffset += result.bytesRead;
        }
        return bytes;
      },
    };
    return { source, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function createCliArchiveStaging(archivePath: string): Promise<ArchiveStaging> {
  const temporary = join(dirname(resolve(archivePath)), `.tutorux-${randomUUID()}.partial`);
  let output: FileHandle | undefined = await open(temporary, "wx", 0o600);
  let active = true;
  let stagedSource: { close(): Promise<void> } | undefined;

  return {
    async append(bytes) {
      if (!active || !output) throw new Error("The archive staging transaction is closed.");
      await writeAll(output, bytes);
    },
    async seal() {
      if (!active || !output) throw new Error("The archive staging transaction is closed.");
      await output.sync();
      await output.close();
      output = undefined;
      active = false;
      try {
        const source = await NodeFileArchiveSource.open(temporary);
        let closed = false;
        stagedSource = {
          async close() {
            if (closed) return;
            closed = true;
            try {
              await source.close();
            } finally {
              await rm(temporary, { force: true });
            }
          },
        };
        return {
          size: source.size,
          read: (offset, length) => source.read(offset, length),
          close: () => stagedSource!.close(),
        };
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async abort() {
      active = false;
      if (output) {
        await output.close().catch(() => undefined);
        output = undefined;
      }
      await stagedSource?.close().catch(() => undefined);
      await rm(temporary, { force: true });
    },
  };
}

async function writeAll(output: FileHandle, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await output.write(bytes, written, bytes.byteLength - written);
    if (result.bytesWritten === 0) throw new Error("File output stopped accepting bytes.");
    written += result.bytesWritten;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
