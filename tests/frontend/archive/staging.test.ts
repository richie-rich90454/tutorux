import { afterEach, describe, expect, it, vi } from "vitest";
import { createArchiveStaging } from "../../../frontend/archive/staging";
import { MemoryArchiveSource } from "../../../frontend/archive/source";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("archive staging", () => {
    it("stages chunks in memory when private storage is unavailable", async () => {
        const staging = await createArchiveStaging();
        await staging.append(new Uint8Array([1, 2]));
        await staging.append(new Uint8Array([3]));
        const source = await staging.seal();
        expect(source).toBeInstanceOf(MemoryArchiveSource);
        expect(await source.read(0n, 3)).toEqual(new Uint8Array([1, 2, 3]));
        await expect(staging.append(new Uint8Array([4]))).rejects.toThrowError(
            "The archive staging transaction is closed.",
        );
        await expect(staging.seal()).rejects.toThrowError(
            "The archive staging transaction is closed.",
        );
        await staging.abort();
    });

    it("rejects memory staging beyond the safe browser limit", async () => {
        const staging = await createArchiveStaging();
        await staging.append(new Uint8Array(32 * 1024 * 1024));
        await expect(staging.append(new Uint8Array([1]))).rejects.toThrowError(
            "This browser cannot safely stage materials larger than 32 MiB.",
        );
    });

    it("discards staged memory chunks on abort", async () => {
        const staging = await createArchiveStaging();
        await staging.append(new Uint8Array([1]));
        await staging.abort();
        await expect(staging.seal()).rejects.toThrowError(
            "The archive staging transaction is closed.",
        );
    });
});

describe("archive staging with private file storage", () => {
    interface FakeDirectory {
        removedNames: string[];
        writer: {
            written: Uint8Array[];
            closed: boolean;
            aborted: boolean;
            write: (buffer: ArrayBuffer) => Promise<void>;
            close: () => Promise<void>;
            abort: () => Promise<void>;
        };
        getFileHandle: (name: string, options: { create: boolean }) => Promise<unknown>;
        removeEntry: (name: string) => Promise<void>;
    }

    function installDirectory(
        options: {
            abortRejects?: boolean;
            removeRejects?: boolean;
        } = {},
    ): FakeDirectory {
        const directory: FakeDirectory = {
            removedNames: [],
            writer: {
                written: [],
                closed: false,
                aborted: false,
                async write(buffer: ArrayBuffer) {
                    this.written.push(new Uint8Array(buffer));
                },
                async close() {
                    this.closed = true;
                },
                async abort() {
                    this.aborted = true;
                    if (options.abortRejects) throw new Error("abort failed");
                },
            },
            getFileHandle: async () => ({
                createWritable: async () => directory.writer,
                getFile: async () => {
                    const concatenated = new Uint8Array(
                        directory.writer.written.reduce((total, chunk) => total + chunk.length, 0),
                    );
                    let offset = 0;
                    for (const chunk of directory.writer.written) {
                        concatenated.set(chunk, offset);
                        offset += chunk.length;
                    }
                    return new File([concatenated], "staged.tux");
                },
            }),
            removeEntry: async (name) => {
                directory.removedNames.push(name);
                if (options.removeRejects) throw new Error("remove failed");
            },
        };
        vi.stubGlobal("navigator", { storage: { getDirectory: async () => directory } });
        return directory;
    }

    it("writes to a private file handle and seals it as a readable source", async () => {
        const directory = installDirectory();
        const staging = await createArchiveStaging();
        await staging.append(new Uint8Array([1, 2]));
        await staging.append(new Uint8Array([3]));
        expect(directory.writer.written).toHaveLength(2);
        const source = await staging.seal();
        expect(directory.writer.closed).toBe(true);
        expect(directory.removedNames).toHaveLength(0);
        expect(source.size).toBe(3n);
        expect(await source.read(0n, 3)).toEqual(new Uint8Array([1, 2, 3]));
        await source.close?.();
        expect(directory.removedNames).toHaveLength(1);
        await expect(staging.append(new Uint8Array([4]))).rejects.toThrowError(
            "The archive staging transaction is closed.",
        );
        await expect(staging.seal()).rejects.toThrowError(
            "The archive staging transaction is closed.",
        );
        await staging.abort();
    });

    it("aborts an unfinished transaction and tolerates repeated cleanup failures", async () => {
        const directory = installDirectory({ abortRejects: true, removeRejects: true });
        const staging = await createArchiveStaging();
        await staging.append(new Uint8Array([1]));
        await staging.abort();
        expect(directory.writer.aborted).toBe(true);
        await staging.abort();
        expect(directory.removedNames).toHaveLength(2);
    });

    it("removes the sealed file on abort without aborting the closed writer", async () => {
        const directory = installDirectory();
        const staging = await createArchiveStaging();
        await staging.seal();
        expect(directory.writer.aborted).toBe(false);
        await staging.abort();
        expect(directory.writer.aborted).toBe(false);
        expect(directory.removedNames).toHaveLength(1);
    });

    it("ignores a failed cleanup when closing a sealed source", async () => {
        installDirectory({ removeRejects: true });
        const staging = await createArchiveStaging();
        const source = await staging.seal();
        await expect(source.close?.()).resolves.toBeUndefined();
    });
});
