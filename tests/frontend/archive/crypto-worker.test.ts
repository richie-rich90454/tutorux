import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveFormatError } from "../../../frontend/archive/format";

type CryptoModule = typeof import("../../../frontend/archive/crypto");

const stubs = vi.hoisted(() => ({
    unwrap: null as unknown as CryptoModule["unwrapArchiveDataKeyBytes"],
    wrap: null as unknown as CryptoModule["wrapArchiveDataKeyBytesInWorker"],
}));

vi.mock("../../../frontend/archive/crypto", async (importOriginal) => {
    const actual = await importOriginal<CryptoModule>();
    return {
        ...actual,
        unwrapArchiveDataKeyBytes: (
            ...args: Parameters<CryptoModule["unwrapArchiveDataKeyBytes"]>
        ) => stubs.unwrap(...args),
        wrapArchiveDataKeyBytesInWorker: (
            ...args: Parameters<CryptoModule["wrapArchiveDataKeyBytesInWorker"]>
        ) => stubs.wrap(...args),
    };
});

await import("../../../frontend/archive/crypto-worker");

interface WorkerScope {
    onmessage: ((event: MessageEvent<unknown>) => void | Promise<void>) | null;
}

const envelope = {
    salt: new Uint8Array(16),
    nonce: new Uint8Array(24),
    wrappedKey: new Uint8Array(48),
    opsLimit: 2,
    memoryLimit: 64 * 1024 * 1024,
};

function installScope(): {
    posted: { message: unknown; transfer?: Transferable[] }[];
    dispatch: (message: unknown) => Promise<void>;
} {
    const posted: { message: unknown; transfer?: Transferable[] }[] = [];
    vi.stubGlobal("postMessage", (message: unknown, transfer?: Transferable[]) => {
        posted.push(transfer === undefined ? { message } : { message, transfer });
    });
    return {
        posted,
        dispatch: async (message) => {
            const handler = (globalThis as unknown as WorkerScope).onmessage;
            if (!handler) throw new Error("worker handler was not installed");
            await handler({ data: message } as MessageEvent<unknown>);
        },
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("archive crypto worker", () => {
    it("transfers a derived unwrap key", async () => {
        stubs.unwrap = async () => new Uint8Array(32).fill(7);
        const { dispatch, posted } = installScope();
        await dispatch({ operation: "unwrap", passphrase: "phrase", envelope, archiveId: "id" });
        expect(posted).toHaveLength(1);
        const response = posted[0]!.message as {
            success: boolean;
            operation: string;
            key: ArrayBuffer;
        };
        expect(response.success).toBe(true);
        expect(response.operation).toBe("unwrap");
        expect(new Uint8Array(response.key)).toHaveLength(32);
        expect(posted[0]!.transfer).toEqual([response.key]);
    });

    it("reports a key that cannot be transferred safely", async () => {
        stubs.unwrap = async () => new Uint8Array(31);
        const { dispatch, posted } = installScope();
        await dispatch({ operation: "unwrap", passphrase: "phrase", envelope, archiveId: "id" });
        expect(posted[0]!.message).toMatchObject({
            success: false,
            code: "crypto_worker_failed",
            message: "Archive key could not be transferred safely.",
        });
    });

    it("reports typed and untyped unwrap failures", async () => {
        stubs.unwrap = async () => {
            throw new ArchiveFormatError("archive_passphrase_invalid", "wrong");
        };
        const typed = installScope();
        await typed.dispatch({
            operation: "unwrap",
            passphrase: "phrase",
            envelope,
            archiveId: "id",
        });
        expect(typed.posted[0]!.message).toEqual({
            success: false,
            code: "archive_passphrase_invalid",
            message: "wrong",
        });

        stubs.unwrap = async () => {
            throw new Error("unexpected");
        };
        const untyped = installScope();
        await untyped.dispatch({
            operation: "unwrap",
            passphrase: "phrase",
            envelope,
            archiveId: "id",
        });
        expect(untyped.posted[0]!.message).toEqual({
            success: false,
            code: "crypto_worker_failed",
            message: "Unable to derive the archive key in a worker.",
        });
    });

    it("wraps a data key and posts the envelope", async () => {
        stubs.wrap = async () => envelope;
        const { dispatch, posted } = installScope();
        await dispatch({
            operation: "wrap",
            passphrase: "phrase",
            key: new Uint8Array(32).fill(9).buffer,
            archiveId: "id",
        });
        expect(posted[0]!.message).toEqual({ success: true, operation: "wrap", envelope });
    });

    it("reports typed and untyped wrap failures", async () => {
        stubs.wrap = async () => {
            throw new ArchiveFormatError("archive_passphrase_too_short", "short");
        };
        const typed = installScope();
        await typed.dispatch({
            operation: "wrap",
            passphrase: "phrase",
            key: new Uint8Array(32).buffer,
            archiveId: "id",
        });
        expect(typed.posted[0]!.message).toEqual({
            success: false,
            code: "archive_passphrase_too_short",
            message: "short",
        });

        stubs.wrap = async () => {
            throw new Error("unexpected");
        };
        const untyped = installScope();
        await untyped.dispatch({
            operation: "wrap",
            passphrase: "phrase",
            key: new Uint8Array(32).buffer,
            archiveId: "id",
        });
        expect(untyped.posted[0]!.message).toEqual({
            success: false,
            code: "crypto_worker_failed",
            message: "Unable to derive the archive key in a worker.",
        });
    });
});
