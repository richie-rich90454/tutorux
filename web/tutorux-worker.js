"use strict";

importScripts("./tutorux-core.js");

let moduleReady = null;
let archiveDatabaseReady = null;
const pendingArchiveKeys = new Set();
const pcmRecordingWriters = new Map();
const maximumPcmRecordingBytes = 64 * 1024 * 1024;
const archiveChannel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel("tutorux-archive-v1")
    : null;

if (archiveChannel) {
    archiveChannel.onmessage = (event) => {
        const { key, pending } = event.data || {};
        if (typeof key !== "string" || !key.startsWith("archive:")) return;
        if (pending) pendingArchiveKeys.add(key);
        else pendingArchiveKeys.delete(key);
    };
}

function isWorkspacePath(path) {
    if (typeof path !== "string" || !path.startsWith("/workspace/")) return false;
    if (path.includes("\\") || path.includes("\0")) return false;
    const segments = path.slice("/workspace/".length).split("/");
    return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
        segments.length > 0;
}

function commandArchivePath(argumentsList) {
    const pathOptions = new Set([
        "--archive",
        "--directory",
        "--input",
        "--output",
        "--path",
    ]);
    let archivePath = "";
    for (let index = 0; index < argumentsList.length; index += 1) {
        const argument = argumentsList[index];
        const separator = argument.indexOf("=");
        const option = separator < 0 ? argument : argument.slice(0, separator);
        if (!pathOptions.has(option)) continue;
        const value = separator < 0 ? argumentsList[++index] : argument.slice(separator + 1);
        const validPath = option === "--directory"
            ? value === "/workspace" || isWorkspacePath(value)
            : isWorkspacePath(value);
        if (!validPath) {
            throw new Error("Browser commands may access files only in the active archive workspace.");
        }
        if (option === "--archive") archivePath = value;
    }
    if (argumentsList[0] === "archive" && argumentsList[1] === "init") {
        archivePath = argumentsList[2] || "";
        if (!isWorkspacePath(archivePath)) {
            throw new Error("New browser archives must be created in the active workspace.");
        }
    }
    return archivePath;
}

function initializeModule() {
    if (!moduleReady) {
        moduleReady = self.createTutoruxModule().then((module) => {
            try {
                module.FS.mkdir("/workspace");
            } catch (error) {
                if (!String(error).includes("EEXIST")) throw error;
            }
            return module;
        });
    }
    return moduleReady;
}

function pcmWaveHeader(dataBytes, sampleRateHz) {
    if (!Number.isSafeInteger(dataBytes) || dataBytes <= 0 || dataBytes > maximumPcmRecordingBytes) {
        throw new Error("The browser microphone recording contains no audio or exceeds 64 MiB.");
    }
    const bytes = new Uint8Array(44);
    const view = new DataView(bytes.buffer);
    const writeText = (offset, value) => {
        for (let index = 0; index < value.length; index += 1) {
            bytes[offset + index] = value.charCodeAt(index);
        }
    };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRateHz, true);
    view.setUint32(28, sampleRateHz * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, dataBytes, true);
    return bytes;
}

function beginPcmRecording(module, payload) {
    if (!payload || !isWorkspacePath(payload.path) || pcmRecordingWriters.size >= 2) {
        throw new Error("The browser microphone recording writer limit was reached or its path is invalid.");
    }
    const sampleRateHz = Number(payload.sampleRateHz);
    if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8000 || sampleRateHz > 384000) {
        throw new Error("The browser microphone sample rate is unsupported.");
    }
    const descriptor = module.FS.open(payload.path, "w+");
    try {
        const placeholder = new Uint8Array(44);
        const written = module.FS.write(descriptor, placeholder, 0, placeholder.length, 0);
        if (written !== placeholder.length) {
            throw new Error("The browser could not initialize the microphone recording file.");
        }
        pcmRecordingWriters.set(payload.path, { descriptor, dataBytes: 0, sampleRateHz });
    } catch (error) {
        try {
            module.FS.close(descriptor);
        } catch {
            // Preserve the original file initialization error.
        }
        try {
            module.FS.unlink(payload.path);
        } catch {
            // The file may not have been created.
        }
        throw error;
    }
}

function appendPcmRecording(module, payload) {
    const writer = payload && pcmRecordingWriters.get(payload.path);
    if (!writer || !(payload.samples instanceof ArrayBuffer)) {
        throw new Error("The browser microphone recording stream is not open.");
    }
    const samples = new Uint8Array(payload.samples);
    if (samples.byteLength === 0 || samples.byteLength % 2 !== 0) {
        throw new Error("The browser microphone supplied an incomplete PCM sample block.");
    }
    if (samples.byteLength > maximumPcmRecordingBytes - writer.dataBytes) {
        throw new Error("The browser microphone recording reached its 64 MiB limit.");
    }
    const written = module.FS.write(
        writer.descriptor,
        samples,
        0,
        samples.byteLength,
        44 + writer.dataBytes,
    );
    if (written !== samples.byteLength) {
        throw new Error("The browser could not persist a complete microphone audio block.");
    }
    writer.dataBytes += written;
    return writer.dataBytes;
}

function finishPcmRecording(module, payload) {
    const writer = payload && pcmRecordingWriters.get(payload.path);
    if (!writer) throw new Error("The browser microphone recording stream is not open.");
    try {
        const header = pcmWaveHeader(writer.dataBytes, writer.sampleRateHz);
        const written = module.FS.write(writer.descriptor, header, 0, header.length, 0);
        if (written !== header.length) {
            throw new Error("The browser could not finish the microphone WAV header.");
        }
        module.FS.close(writer.descriptor);
        pcmRecordingWriters.delete(payload.path);
        return { dataBytes: writer.dataBytes, fileBytes: writer.dataBytes + 44 };
    } catch (error) {
        try {
            module.FS.close(writer.descriptor);
        } catch {
            // Preserve the original finalization error.
        }
        pcmRecordingWriters.delete(payload.path);
        throw error;
    }
}

function abortPcmRecording(module, path) {
    const writer = pcmRecordingWriters.get(path);
    if (!writer) return;
    try {
        module.FS.close(writer.descriptor);
    } catch {
        // The descriptor may have been closed during a failed finalization.
    }
    pcmRecordingWriters.delete(path);
}

function archiveStorageKey(bytes) {
    const magic = [0x54, 0x55, 0x54, 0x4f, 0x52, 0x55, 0x58, 0x00];
    if (bytes.byteLength < 32 || magic.some((byte, index) => bytes[index] !== byte)) return "";
    const archiveId = Array.from(bytes.subarray(16, 32), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
    return `archive:${archiveId}`;
}

function markArchivePending(key, pending) {
    if (!key) return;
    if (pending) pendingArchiveKeys.add(key);
    else pendingArchiveKeys.delete(key);
    archiveChannel?.postMessage({ key, pending });
}

function openArchiveDatabase() {
    if (!self.indexedDB) return Promise.resolve(null);
    if (!archiveDatabaseReady) {
        archiveDatabaseReady = new Promise((resolve, reject) => {
            const request = self.indexedDB.open("tutorux-portable-archive", 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains("workspace")) {
                    request.result.createObjectStore("workspace", { keyPath: "key" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("Browser archive storage failed."));
            request.onblocked = () => reject(new Error("Browser archive storage is blocked."));
        }).catch((error) => {
            archiveDatabaseReady = null;
            throw error;
        });
    }
    return archiveDatabaseReady;
}

async function readArchiveSnapshot(key) {
    const database = await openArchiveDatabase();
    if (!database) return null;
    return new Promise((resolve, reject) => {
        const transaction = database.transaction("workspace", "readonly");
        const request = transaction.objectStore("workspace").get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("Browser archive could not be read."));
        transaction.onerror = () => reject(transaction.error || new Error("Browser archive could not be read."));
    });
}

async function storeArchiveSnapshot(key, name, bytes) {
    const database = await openArchiveDatabase();
    if (!database) return;
    const savedAt = Date.now();
    const snapshot = {
        key,
        name,
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        savedAt,
    };
    return new Promise((resolve, reject) => {
        const transaction = database.transaction("workspace", "readwrite");
        const store = transaction.objectStore("workspace");
        store.put(snapshot);
        store.put({ key: "active", archiveKey: key, name, savedAt });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Browser archive could not be saved."));
        transaction.onabort = () => reject(transaction.error || new Error("Browser archive save was interrupted."));
    });
}

async function synchronizeArchive(module, path) {
    let currentBytes;
    try {
        currentBytes = module.FS.readFile(path, { encoding: "binary" });
    } catch {
        return "";
    }
    const key = archiveStorageKey(currentBytes);
    if (!key) return "";
    let stored;
    try {
        stored = await readArchiveSnapshot(key);
    } catch {
        return key;
    }
    if (stored?.bytes instanceof ArrayBuffer) {
        module.FS.writeFile(path, new Uint8Array(stored.bytes));
        return key;
    }
    return key;
}

async function persistArchive(module, path, key = "") {
    const bytes = module.FS.readFile(path, { encoding: "binary" });
    const snapshotKey = key || archiveStorageKey(bytes);
    if (!snapshotKey) return;
    await storeArchiveSnapshot(snapshotKey, path.slice("/workspace/".length), bytes);
}

async function dispatch(payload) {
    const module = await initializeModule();
    const argumentsList = Array.isArray(payload) ? payload : payload?.arguments;
    if (!Array.isArray(argumentsList) || argumentsList.some((argument) => typeof argument !== "string")) {
        throw new Error("Browser commands require a JSON array of argument strings.");
    }
    const archivePath = commandArchivePath(argumentsList);
    const invoke = async () => {
        let archiveKey = "";
        if (archivePath) {
            try {
                archiveKey = archiveStorageKey(
                    module.FS.readFile(archivePath, { encoding: "binary" }),
                );
            } catch {
                // Archive initialization has no existing bytes to identify.
            }
            if (payload?.synchronizeArchive !== false && !pendingArchiveKeys.has(archiveKey)) {
                archiveKey = await synchronizeArchive(module, archivePath) || archiveKey;
            }
        }
        const raw = await module.ccall(
            "tutorux_web_dispatch_json",
            "string",
            ["string"],
            [JSON.stringify(payload)],
            { async: true },
        );
        const result = JSON.parse(raw);
        if (archivePath) {
            try {
                await persistArchive(module, archivePath, archiveKey);
                if (!archiveKey) {
                    archiveKey = archiveStorageKey(
                        module.FS.readFile(archivePath, { encoding: "binary" }),
                    );
                }
                markArchivePending(archiveKey, false);
            } catch {
                if (!archiveKey) {
                    try {
                        archiveKey = archiveStorageKey(
                            module.FS.readFile(archivePath, { encoding: "binary" }),
                        );
                    } catch {
                        // Keep the command result even if no archive header was written.
                    }
                }
                markArchivePending(archiveKey, true);
                result.archive_persistence_error =
                    "Browser storage could not retain the latest archive. Download the current archive before closing this page.";
            }
        }
        return result;
    };
    let lockKey = archivePath;
    if (archivePath) {
        try {
            lockKey = archiveStorageKey(module.FS.readFile(archivePath, { encoding: "binary" })) || archivePath;
        } catch {
            // Archive initialization has no file header to lock by UUID yet.
        }
    }
    return archivePath && self.navigator?.locks
        ? await self.navigator.locks.request(`tutorux-${lockKey}`, { mode: "exclusive" }, invoke)
        : await invoke();
}

async function handleMessage(event) {
    const { id, type, payload } = event.data || {};
    try {
        if (type === "initialize") {
            await initializeModule();
            self.postMessage({ id, ok: true, type: "ready" });
            return;
        }
        if (type === "dispatch") {
            const result = await dispatch(payload);
            self.postMessage({ id, ok: true, result });
            return;
        }
        const module = await initializeModule();
        if (type === "write-file") {
            if (!payload || !isWorkspacePath(payload.path)) {
                throw new Error("Browser worker file operations are limited to the active workspace.");
            }
            module.FS.writeFile(payload.path, new Uint8Array(payload.bytes));
            self.postMessage({ id, ok: true });
            return;
        }
        if (type === "read-file") {
            if (!payload || !isWorkspacePath(payload.path)) {
                throw new Error("Browser worker file operations are limited to the active workspace.");
            }
            const bytes = module.FS.readFile(payload.path, { encoding: "binary" });
            const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            self.postMessage({ id, ok: true, bytes: copy }, [copy]);
            return;
        }
        if (type === "begin-pcm-recording") {
            beginPcmRecording(module, payload);
            self.postMessage({ id, ok: true });
            return;
        }
        if (type === "append-pcm-recording") {
            const dataBytes = appendPcmRecording(module, payload);
            self.postMessage({ id, ok: true, result: { dataBytes } });
            return;
        }
        if (type === "finish-pcm-recording") {
            const result = finishPcmRecording(module, payload);
            self.postMessage({ id, ok: true, result });
            return;
        }
        if (type === "read-archive") {
            if (!payload || !isWorkspacePath(payload.path)) {
                throw new Error("Browser worker file operations are limited to the active workspace.");
            }
            const readArchive = async () => {
                let archiveKey = "";
                try {
                    archiveKey = archiveStorageKey(
                        module.FS.readFile(payload.path, { encoding: "binary" }),
                    );
                } catch {
                    // The read below reports missing archive files.
                }
                if (!pendingArchiveKeys.has(archiveKey)) {
                    await synchronizeArchive(module, payload.path);
                }
                const bytes = module.FS.readFile(payload.path, { encoding: "binary" });
                const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                return copy;
            };
            let lockKey = payload.path;
            try {
                const bytes = module.FS.readFile(payload.path, { encoding: "binary" });
                lockKey = archiveStorageKey(bytes) || payload.path;
            } catch {
                // A missing archive will be reported by the read below.
            }
            const copy = self.navigator?.locks
                ? await self.navigator.locks.request(
                    `tutorux-${lockKey}`,
                    { mode: "exclusive" },
                    readArchive,
                )
                : await readArchive();
            self.postMessage({ id, ok: true, bytes: copy }, [copy]);
            return;
        }
        if (type === "remove-file") {
            if (!payload || !isWorkspacePath(payload.path)) {
                throw new Error("Browser worker file operations are limited to the active workspace.");
            }
            abortPcmRecording(module, payload.path);
            try {
                module.FS.unlink(payload.path);
            } catch (error) {
                if (!String(error).includes("ENOENT")) throw error;
            }
            self.postMessage({ id, ok: true });
            return;
        }
        throw new Error(`Unknown worker request: ${type}`);
    } catch (error) {
        self.postMessage({
            id,
            type: id === 0 ? "init-error" : "error",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

let requestQueue = Promise.resolve();
self.onmessage = (event) => {
    const next = requestQueue.then(() => handleMessage(event));
    requestQueue = next.catch(() => {});
};
