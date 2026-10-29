import { BrowserFileArchiveSource, MemoryArchiveSource, type ArchiveByteSource } from "./source";

const MEMORY_LIMIT = 32 * 1024 * 1024;

/** Private append-only staging; nothing is published until the caller installs its sealed source. */
export interface ArchiveStaging {
  append(bytes: Uint8Array): Promise<void>;
  seal(): Promise<ArchiveByteSource>;
  abort(): Promise<void>;
}

export async function createArchiveStaging(): Promise<ArchiveStaging> {
  if (navigator.storage?.getDirectory) {
    const directory = await navigator.storage.getDirectory();
    const name = `tutorux-import-${crypto.randomUUID()}.partial`;
    const handle = await directory.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    let done = false;
    return {
      async append(bytes) {
        if (done) throw new Error("The archive staging transaction is closed.");
        await writer.write(bytes.slice().buffer);
      },
      async seal() {
        if (done) throw new Error("The archive staging transaction is closed.");
        await writer.close();
        done = true;
        const file = await handle.getFile();
        const source = new BrowserFileArchiveSource(file);
        return {
          size: source.size,
          read: (offset, length) => source.read(offset, length),
          close: () => directory.removeEntry(name).catch(() => undefined),
        };
      },
      async abort() {
        if (!done) {
          done = true;
          await writer.abort().catch(() => undefined);
        }
        await directory.removeEntry(name).catch(() => undefined);
      },
    };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  return {
    async append(bytes) {
      if (done) throw new Error("The archive staging transaction is closed.");
      if (size + bytes.length > MEMORY_LIMIT) {
        throw new Error(
          "This browser cannot safely stage materials larger than 32 MiB. Use a browser with private file storage or the CLI.",
        );
      }
      chunks.push(bytes.slice());
      size += bytes.length;
    },
    async seal() {
      if (done) throw new Error("The archive staging transaction is closed.");
      done = true;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      chunks.length = 0;
      return new MemoryArchiveSource(bytes);
    },
    async abort() {
      done = true;
      chunks.length = 0;
    },
  };
}
