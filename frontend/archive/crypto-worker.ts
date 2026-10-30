import { unwrapArchiveDataKeyBytes, wrapArchiveDataKeyBytesInWorker } from "./crypto";
import type { ArchiveEncryptionEnvelope } from "./crypto";
import { ArchiveFormatError } from "./format";

interface CryptoWorkerRequest {
    operation: "unwrap";
    passphrase: string;
    envelope: ArchiveEncryptionEnvelope;
    archiveId: string;
}

interface CryptoWorkerWrapRequest {
    operation: "wrap";
    passphrase: string;
    key: ArrayBuffer;
    archiveId: string;
}

type CryptoWorkerMessage = CryptoWorkerRequest | CryptoWorkerWrapRequest;

type CryptoWorkerResponse =
    | { success: true; operation: "unwrap"; key: ArrayBuffer }
    | { success: true; operation: "wrap"; envelope: ArchiveEncryptionEnvelope }
    | { success: false; code: string; message: string };

const workerScope = globalThis as unknown as {
    onmessage: ((event: MessageEvent<CryptoWorkerMessage>) => void) | null;
    postMessage(message: CryptoWorkerResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = async (event): Promise<void> => {
    const request = event.data;
    try {
        if (request.operation === "wrap") {
            const key = new Uint8Array(request.key);
            try {
                const envelope = await wrapArchiveDataKeyBytesInWorker(
                    request.passphrase,
                    key,
                    request.archiveId,
                );
                workerScope.postMessage({ success: true, operation: "wrap", envelope });
            } finally {
                key.fill(0);
            }
            return;
        }
        const key = await unwrapArchiveDataKeyBytes(
            request.passphrase,
            request.envelope,
            request.archiveId,
        );
        if (key.byteLength !== 32) {
            key.fill(0);
            throw new ArchiveFormatError(
                "crypto_worker_failed",
                "Archive key could not be transferred safely.",
            );
        }
        const transferredKey = new Uint8Array(32);
        transferredKey.set(key);
        key.fill(0);
        const keyBuffer = transferredKey.buffer;
        workerScope.postMessage({ success: true, operation: "unwrap", key: keyBuffer }, [
            keyBuffer,
        ]);
    } catch (error) {
        const response: CryptoWorkerResponse =
            error instanceof ArchiveFormatError
                ? { success: false, code: error.code, message: error.message }
                : {
                      success: false,
                      code: "crypto_worker_failed",
                      message: "Unable to derive the archive key in a worker.",
                  };
        workerScope.postMessage(response);
    }
};
