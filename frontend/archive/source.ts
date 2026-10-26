const DEFAULT_STREAM_CHUNK = 1024 * 1024;

export interface ArchiveByteSource {
  readonly size: bigint;
  read(offset: bigint, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export class MemoryArchiveSource implements ArchiveByteSource {
  readonly size: bigint;

  constructor(private readonly bytes: Uint8Array) {
    this.size = BigInt(bytes.byteLength);
  }

  async read(offset: bigint, length: number): Promise<Uint8Array> {
    const range = validateRange(offset, length, this.size);
    return this.bytes.subarray(range.start, range.end);
  }

  get data(): Uint8Array {
    return this.bytes;
  }
}

/** Reads a large archive as a stable base file plus a small append-only generation. */
export class CompositeArchiveSource implements ArchiveByteSource {
  readonly size: bigint;

  constructor(
    private readonly base: ArchiveByteSource,
    private readonly appended: ArchiveByteSource,
  ) {
    this.size = base.size + appended.size;
  }

  async read(offset: bigint, length: number): Promise<Uint8Array> {
    validateRange(offset, length, this.size);
    const end = offset + BigInt(length);
    if (end <= this.base.size) return this.base.read(offset, length);
    if (offset >= this.base.size) return this.appended.read(offset - this.base.size, length);

    const baseLength = Number(this.base.size - offset);
    const appendedLength = length - baseLength;
    const [baseBytes, appendedBytes] = await Promise.all([
      this.base.read(offset, baseLength),
      this.appended.read(0n, appendedLength),
    ]);
    const output = new Uint8Array(length);
    output.set(baseBytes);
    output.set(appendedBytes, baseLength);
    return output;
  }

  async close(): Promise<void> {
    await this.base.close?.();
    await this.appended.close?.();
  }
}

export class BrowserFileArchiveSource implements ArchiveByteSource {
  readonly size: bigint;

  constructor(private readonly file: File) {
    this.size = BigInt(file.size);
  }

  async read(offset: bigint, length: number): Promise<Uint8Array> {
    const range = validateRange(offset, length, this.size);
    const contents = await this.file.slice(range.start, range.end).arrayBuffer();
    return new Uint8Array(contents);
  }
}

export function sourceStream(
  source: ArchiveByteSource,
  chunkSize = DEFAULT_STREAM_CHUNK,
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError("Archive stream chunk size must be a positive safe integer.");
  }
  let offset = 0n;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= source.size) {
        controller.close();
        return;
      }
      const remaining = source.size - offset;
      const length = Number(remaining > BigInt(chunkSize) ? BigInt(chunkSize) : remaining);
      try {
        const chunk = await source.read(offset, length);
        if (chunk.length !== length) {
          controller.error(new Error("Archive source returned a short read."));
          return;
        }
        offset += BigInt(length);
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function validateRange(
  offset: bigint,
  length: number,
  size: bigint,
): { start: number; end: number } {
  if (
    offset < 0n ||
    offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    BigInt(length) > size - offset
  ) {
    throw new RangeError("Archive read is outside the source bounds.");
  }
  const start = Number(offset);
  return { start, end: start + length };
}
