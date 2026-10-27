import { unwrapArchiveDataKeyBytes } from "./crypto";
import type { ArchiveEncryptionEnvelope } from "./crypto";
import { ArchiveFormatError } from "./format";

interface CryptoWorkerRequest {
  passphrase: string;
  envelope: ArchiveEncryptionEnvelope;
  archiveId: string;
}

type CryptoWorkerResponse =
  { success: true; key: ArrayBuffer } | { success: false; code: string; message: string };

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<CryptoWorkerRequest>) => void) | null;
  postMessage(message: CryptoWorkerResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = async (event): Promise<void> => {
  try {
    const key = await unwrapArchiveDataKeyBytes(
      event.data.passphrase,
      event.data.envelope,
      event.data.archiveId,
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
    workerScope.postMessage({ success: true, key: keyBuffer }, [keyBuffer]);
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
