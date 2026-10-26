import { open, type FileHandle } from "node:fs/promises";
import type { ArchiveByteSource } from "./source";

/** A bounded, positional archive reader for the Node CLI. */
export class NodeFileArchiveSource implements ArchiveByteSource {
  private constructor(
    private readonly handle: FileHandle,
    readonly size: bigint,
  ) {}

  static async open(path: string): Promise<NodeFileArchiveSource> {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("The selected archive is not a regular file.");
      return new NodeFileArchiveSource(handle, BigInt(info.size));
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(offset: bigint, length: number): Promise<Uint8Array> {
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

  close(): Promise<void> {
    return this.handle.close();
  }
}
