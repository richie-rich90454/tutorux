import { describe, expect, it } from "vitest";
import {
    BrowserFileArchiveSource,
    CompositeArchiveSource,
    MemoryArchiveSource,
    sourceStream,
    type ArchiveByteSource,
} from "../../../frontend/archive/source";

async function readAll(source: ArchiveByteSource): Promise<Uint8Array> {
    return readStream(sourceStream(source, 3));
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

describe("archive byte sources", () => {
    it("reads bounded ranges from memory and exposes its data", async () => {
        const bytes = new Uint8Array([1, 2, 3, 4, 5]);
        const source = new MemoryArchiveSource(bytes);
        expect(source.size).toBe(5n);
        expect(source.data).toBe(bytes);
        expect(await source.read(1n, 2)).toEqual(new Uint8Array([2, 3]));
        expect(await source.read(5n, 0)).toEqual(new Uint8Array());
    });

    it("rejects out-of-bounds memory reads", async () => {
        const source = new MemoryArchiveSource(new Uint8Array([1, 2, 3]));
        await expect(source.read(-1n, 1)).rejects.toBeInstanceOf(RangeError);
        await expect(source.read(0n, -1)).rejects.toBeInstanceOf(RangeError);
        await expect(source.read(0n, 1.5)).rejects.toBeInstanceOf(RangeError);
        await expect(source.read(1n, 3)).rejects.toBeInstanceOf(RangeError);
        await expect(source.read(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0)).rejects.toBeInstanceOf(
            RangeError,
        );
    });

    it("reads across the join of a composite source", async () => {
        const base = new MemoryArchiveSource(new Uint8Array([1, 2, 3]));
        const appended = new MemoryArchiveSource(new Uint8Array([4, 5, 6]));
        const source = new CompositeArchiveSource(base, appended);
        expect(source.size).toBe(6n);
        expect(await source.read(0n, 2)).toEqual(new Uint8Array([1, 2]));
        expect(await source.read(4n, 2)).toEqual(new Uint8Array([5, 6]));
        expect(await source.read(2n, 3)).toEqual(new Uint8Array([3, 4, 5]));
        expect(await source.read(3n, 3)).toEqual(new Uint8Array([4, 5, 6]));
        await expect(source.read(5n, 2)).rejects.toBeInstanceOf(RangeError);
    });

    it("closes both parts of a composite source when they support closing", async () => {
        const closed: string[] = [];
        const base: ArchiveByteSource = {
            size: 1n,
            read: async () => new Uint8Array([1]),
            close: async () => {
                closed.push("base");
            },
        };
        const appended: ArchiveByteSource = {
            size: 1n,
            read: async () => new Uint8Array([2]),
            close: async () => {
                closed.push("appended");
            },
        };
        await new CompositeArchiveSource(base, appended).close();
        expect(closed).toEqual(["base", "appended"]);
        await new CompositeArchiveSource(
            new MemoryArchiveSource(new Uint8Array([1])),
            new MemoryArchiveSource(new Uint8Array([2])),
        ).close();
    });

    it("reads file slices through the browser file source", async () => {
        const file = new File([new Uint8Array([9, 8, 7, 6])], "archive.tux");
        const source = new BrowserFileArchiveSource(file);
        expect(source.size).toBe(4n);
        expect(await source.read(1n, 2)).toEqual(new Uint8Array([8, 7]));
        await expect(source.read(3n, 2)).rejects.toBeInstanceOf(RangeError);
    });

    it("streams a source in bounded chunks", async () => {
        const source = new MemoryArchiveSource(new Uint8Array([1, 2, 3, 4, 5]));
        expect(await readAll(source)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
        expect(await readStream(sourceStream(source))).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
        expect(await readStream(sourceStream(new MemoryArchiveSource(new Uint8Array())))).toEqual(
            new Uint8Array(),
        );
    });

    it("rejects an invalid stream chunk size", () => {
        const source = new MemoryArchiveSource(new Uint8Array([1]));
        expect(() => sourceStream(source, 0)).toThrowError(RangeError);
        expect(() => sourceStream(source, -1)).toThrowError(RangeError);
        expect(() => sourceStream(source, 1.5)).toThrowError(RangeError);
        expect(() => sourceStream(source, Number.MAX_SAFE_INTEGER + 1)).toThrowError(RangeError);
    });

    it("errors the stream on short reads and read failures", async () => {
        const short: ArchiveByteSource = {
            size: 4n,
            read: async (_offset, length) => new Uint8Array(Math.max(0, length - 1)),
        };
        await expect(readStream(sourceStream(short, 2))).rejects.toThrowError(
            "Archive source returned a short read.",
        );

        const failure = new Error("read failed");
        const broken: ArchiveByteSource = {
            size: 1n,
            read: async () => {
                throw failure;
            },
        };
        await expect(readStream(sourceStream(broken))).rejects.toBe(failure);
    });
});
