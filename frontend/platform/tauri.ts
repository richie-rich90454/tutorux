import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { open as openFile, writeFile, type FileHandle } from "@tauri-apps/plugin-fs";
import { MemoryArchiveSource, sourceStream, type ArchiveByteSource } from "../archive/source";
import { sendEmbeddedAiRequest } from "./embedded-ai";
import { isEmbeddedGgufProvider } from "../ai/providers";
import type {
    CommandConsoleAvailability,
    CommandConsoleResult,
    CommandConsoleRun,
} from "./command-console";
import {
    registerReplicateCancellationHandler,
    replicateModelMetadataEndpoint,
} from "../ai/replicate";
import type {
    AiModelInspectionRequest,
    AiTransportRequest,
    AiTransportResult,
    ArchivePlatform,
    BinaryExportSource,
    DesktopDiagnostics,
    OpenedArchive,
    SanitizedCopyDestination,
} from "./types";

class TauriArchiveSource implements ArchiveByteSource {
    constructor(
        readonly token: string,
        readonly size: bigint,
    ) {
        archiveTokens.set(this, token);
        archiveSizes.set(token, size);
    }

    async read(offset: bigint, length: number): Promise<Uint8Array> {
        if (
            offset < 0n ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            offset + BigInt(length) > this.size
        ) {
            throw new RangeError("Archive read is outside the selected file.");
        }
        const rangeSize = 4 * 1024 * 1024;
        const result = new Uint8Array(length);
        for (let copied = 0; copied < length; copied += rangeSize) {
            const count = Math.min(rangeSize, length - copied);
            const bytes = await invoke<ArrayBuffer>("read_archive_range", {
                archiveToken: this.token,
                offset: (offset + BigInt(copied)).toString(),
                length: count,
            });
            if (bytes.byteLength !== count)
                throw new Error("The desktop file adapter returned a short read.");
            result.set(new Uint8Array(bytes), copied);
        }
        return result;
    }

    async close(): Promise<void> {
        await invoke("close_archive", { archiveToken: this.token });
        archiveSizes.delete(this.token);
    }
}

const archiveTokens = new WeakMap<object, string>();
const archiveSizes = new Map<string, bigint>();
let activeReplicateRequestId: string | null = null;

registerReplicateCancellationHandler(async () => {
    const requestId = activeReplicateRequestId;
    if (!requestId) return;
    const channel = new Channel<{ kind: "chunk"; base64: string }>();
    await invoke("send_ai_request", {
        request: {
            providerId: "replicate",
            replicateRequestId: requestId,
            cancelReplicateRequest: true,
        },
        onChunk: channel,
    });
});

export function hasDesktopArchiveCapability(source: ArchiveByteSource): boolean {
    return findArchiveToken(source) !== undefined;
}

/** Durably publish one already-verified archive generation to its opened desktop file. */
export async function persistMicrophoneArchiveGeneration(
    source: ArchiveByteSource,
    generationBytes: Uint8Array,
    generation: bigint,
): Promise<void> {
    const archiveToken = findArchiveToken(source);
    if (!archiveToken) {
        throw new Error("The microphone archive no longer has an authorized desktop file handle.");
    }
    const expectedSize = archiveSizes.get(archiveToken);
    if (expectedSize === undefined) {
        throw new Error(
            "The microphone archive capability has expired. Reopen the archive to continue.",
        );
    }
    if (generationBytes.byteLength < 32 || generationBytes.byteLength > 8 * 1024 * 1024) {
        throw new Error("A microphone archive checkpoint has an unsupported generation size.");
    }
    const published = await invoke<{ size: string }>("append_audio_archive_generation", {
        archiveToken,
        expectedSize: expectedSize.toString(),
        generation: generation.toString(),
        bytes: Array.from(generationBytes),
    });
    const nextSize = BigInt(published.size);
    if (nextSize !== expectedSize + BigInt(generationBytes.byteLength)) {
        throw new Error("The desktop archive writer published an unexpected checkpoint size.");
    }
    archiveSizes.set(archiveToken, nextSize);
    compactPublishedArchiveSource(source, archiveToken, nextSize);
}

/** Drop the just-published in-memory append chain while keeping the snapshot's source object valid. */
function compactPublishedArchiveSource(
    source: ArchiveByteSource,
    archiveToken: string,
    publishedSize: bigint,
): void {
    const composite = source as ArchiveByteSource & {
        base?: ArchiveByteSource;
        appended?: ArchiveByteSource;
        size?: bigint;
    };
    if (!composite.base || !composite.appended || composite.size === undefined) return;

    const diskSource = new TauriArchiveSource(archiveToken, publishedSize);
    const emptyTail = new MemoryArchiveSource(new Uint8Array());
    if (
        !Reflect.set(source, "base", diskSource) ||
        !Reflect.set(source, "appended", emptyTail) ||
        !Reflect.set(source, "size", publishedSize)
    ) {
        throw new Error(
            "The saved archive snapshot could not release its in-memory checkpoint chain.",
        );
    }
}

function findArchiveToken(source: ArchiveByteSource): string | undefined {
    const pending = [source as object];
    const visited = new Set<object>();
    while (pending.length > 0) {
        const current = pending.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        const token = archiveTokens.get(current);
        if (token) return token;
        const composite = current as { base?: unknown; appended?: unknown };
        if (composite.base && typeof composite.base === "object") pending.push(composite.base);
        if (composite.appended && typeof composite.appended === "object")
            pending.push(composite.appended);
    }
    return undefined;
}

async function authorizeArchivePath(path: string): Promise<OpenedArchive> {
    const selected = await invoke<{ token: string; size: string; name: string }>(
        "authorize_archive_path",
        { path },
    );
    return {
        source: new TauriArchiveSource(selected.token, BigInt(selected.size)),
        name: selected.name,
        location: path,
    };
}

export const platform: ArchivePlatform = {
    kind: "desktop",

    async commandConsoleAvailability(): Promise<CommandConsoleAvailability> {
        return invoke<CommandConsoleAvailability>("command_console_availability");
    },

    async startCommandConsole(
        source: ArchiveByteSource,
        input: string,
        passphrase: string,
        newPassphrase: string,
        onOutput: (text: string) => void,
    ): Promise<CommandConsoleRun> {
        const archiveToken = findArchiveToken(source);
        if (!archiveToken) {
            throw new Error(
                "The selected archive no longer has an authorized desktop file handle.",
            );
        }
        const runId = crypto.randomUUID();
        const unlisten = await listen<{ runId: string; text: string }>(
            "tutorux:console-output",
            (event) => {
                if (event.payload.runId === runId) onOutput(event.payload.text);
            },
        );
        const completion = invoke<CommandConsoleResult>("run_command_console", {
            runId,
            archiveToken,
            input,
            passphrase,
            newPassphrase,
        }).finally(unlisten);
        return {
            completion,
            cancel: () => invoke<void>("cancel_command_console", { runId }),
        };
    },

    async openArchive(): Promise<OpenedArchive | null> {
        const path = await open({
            title: "Open Tutorux archive",
            multiple: false,
            filters: [{ name: "Tutorux archive", extensions: ["tux"] }],
        });
        if (!path || Array.isArray(path)) return null;
        return authorizeArchivePath(path);
    },

    async saveArchive(
        source: ArchiveByteSource,
        suggestedName: string,
        location?: string | null,
    ): Promise<string | null> {
        const path =
            location ??
            (await save({
                title: "Save Tutorux archive",
                defaultPath: suggestedName,
                filters: [{ name: "Tutorux archive", extensions: ["tux"] }],
            }));
        if (!path) return null;

        const { token, temporaryPath } = await invoke<{ token: string; temporaryPath: string }>(
            "prepare_archive_save",
            {
                targetPath: path,
                archiveToken: findArchiveToken(source) ?? null,
                createOnly: false,
            },
        );
        try {
            await writeFile(temporaryPath, sourceStream(source), { create: true });
            await invoke("publish_archive_save", { token });
            const archiveToken = findArchiveToken(source);
            if (archiveToken) {
                archiveSizes.set(archiveToken, source.size);
            } else {
                // A rebuilt archive (encryption, passphrase rotation, or creation) has no token from its
                // source file. Re-authorize the published target so later saves and native checkpoints
                // retain external-change protection.
                try {
                    const opened = await authorizeArchivePath(path);
                    const openedSource = opened.source as TauriArchiveSource;
                    archiveTokens.set(source as object, openedSource.token);
                    archiveSizes.set(openedSource.token, source.size);
                    const closeSource = source.close?.bind(source);
                    if (
                        Reflect.set(source, "close", async () => {
                            await closeSource?.();
                            await openedSource.close();
                        }) === false
                    ) {
                        // The capability remains usable for writes even if this source disallows attaching
                        // the corresponding cleanup hook.
                    }
                } catch {
                    // Saving has already succeeded. The next explicit reopen can restore its read handle.
                }
            }
            return path;
        } catch (error) {
            await invoke("cancel_archive_save", { token }).catch(() => undefined);
            throw error;
        }
    },

    async exportTextFile(
        suggestedName: string,
        contents: string,
        mimeType: string,
    ): Promise<string | null> {
        const extension = suggestedName.split(".").at(-1) ?? "txt";
        const isJson = mimeType.startsWith("application/json");
        const isHtml = mimeType.startsWith("text/html");
        const title = isJson
            ? "Export JSON file"
            : isHtml
              ? "Export study guide as HTML"
              : "Export text file";
        const filterName = isJson ? "JSON file" : isHtml ? "HTML document" : "Text file";
        const path = await save({
            title,
            defaultPath: suggestedName,
            filters: [{ name: filterName, extensions: [extension] }],
        });
        if (!path) return null;
        await invoke("write_export_file", { path, contents });
        return path;
    },

    async exportBinaryFile(
        suggestedName: string,
        contents: BinaryExportSource,
        mimeType: string,
    ): Promise<string | null> {
        const isWav = mimeType === "audio/wav";
        const isDocx =
            mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        const extension = suggestedName.split(".").at(-1) ?? "bin";
        const path = await save({
            title: isWav
                ? "Export audio track"
                : isDocx
                  ? "Export study guide as Word"
                  : "Export material",
            defaultPath: suggestedName,
            filters: [
                {
                    name: isWav ? "WAV audio" : isDocx ? "Word document" : "Material",
                    extensions: [extension],
                },
            ],
        });
        if (!path) return null;
        const { token, temporaryPath } = await invoke<{ token: string; temporaryPath: string }>(
            "prepare_archive_save",
            { targetPath: path, archiveToken: null, createOnly: false },
        );
        try {
            const payload = typeof contents === "function" ? await contents() : contents;
            await writeFile(temporaryPath, payload, { create: true });
            await invoke("publish_archive_save", { token });
            return path;
        } catch (error) {
            await invoke("cancel_archive_save", { token }).catch(() => undefined);
            throw error;
        }
    },

    async chooseSanitizedCopyDestination(
        suggestedName: string,
    ): Promise<SanitizedCopyDestination | null> {
        const path = await save({
            title: "Create sanitized Tutorux archive",
            defaultPath: suggestedName,
            filters: [{ name: "Tutorux archive", extensions: ["tux"] }],
        });
        if (!path) return null;

        let preparation: { token: string; temporaryPath: string } | null = null;
        let file: FileHandle | null = null;
        let writtenSize = 0n;
        let closed = false;
        return {
            label: path,
            async checkpoint(source, previousSize) {
                if (closed) throw new Error("This copy destination is no longer available.");
                if (previousSize !== writtenSize || source.size < previousSize) {
                    throw new Error("Sanitized archive checkpoints arrived out of order.");
                }
                if (!preparation) {
                    preparation = await invoke<{ token: string; temporaryPath: string }>(
                        "prepare_archive_save",
                        { targetPath: path, archiveToken: null, createOnly: true },
                    );
                    file = await openFile(preparation.temporaryPath, {
                        append: true,
                        create: true,
                    });
                }

                const rangeSize = 1024 * 1024;
                for (let offset = previousSize; offset < source.size;) {
                    const remaining = source.size - offset;
                    const length = Number(
                        remaining > BigInt(rangeSize) ? BigInt(rangeSize) : remaining,
                    );
                    const bytes = await source.read(offset, length);
                    if (bytes.byteLength !== length) {
                        throw new Error(
                            "The sanitized archive returned an incomplete checkpoint range.",
                        );
                    }
                    const count = await file!.write(bytes);
                    if (count !== length)
                        throw new Error("The sanitized archive checkpoint was truncated.");
                    offset += BigInt(length);
                }
                writtenSize = source.size;
            },
            async publish(source) {
                if (closed) throw new Error("This copy destination is no longer available.");
                if (!preparation || !file || writtenSize !== source.size) {
                    throw new Error("The sanitized archive has not been completely staged.");
                }
                await file.close();
                file = null;
                await invoke("publish_archive_save", { token: preparation.token });
                closed = true;
                return path;
            },
            async cancel() {
                if (closed) return;
                closed = true;
                await file?.close().catch(() => undefined);
                file = null;
                if (preparation) {
                    await invoke("cancel_archive_save", { token: preparation.token }).catch(
                        () => undefined,
                    );
                }
            },
        };
    },

    async sendAiRequest(
        request: AiTransportRequest,
        onChunk: (chunk: Uint8Array) => void,
    ): Promise<AiTransportResult> {
        if (request.providerId === "replicate") {
            const requestId = crypto.randomUUID();
            activeReplicateRequestId = requestId;
            const channel = new Channel<{ kind: "chunk"; base64: string }>();
            channel.onmessage = (event) => onChunk(decodeBase64(event.base64));
            try {
                return await invoke<AiTransportResult>("send_ai_request", {
                    request: { ...request, replicateRequestId: requestId },
                    onChunk: channel,
                });
            } finally {
                if (activeReplicateRequestId === requestId) activeReplicateRequestId = null;
            }
        }
        if (isEmbeddedGgufProvider(request.providerId)) {
            return sendEmbeddedAiRequest(request, onChunk);
        }
        const channel = new Channel<{ kind: "chunk"; base64: string }>();
        channel.onmessage = (event) => onChunk(decodeBase64(event.base64));
        return invoke<AiTransportResult>("send_ai_request", { request, onChunk: channel });
    },

    async inspectReplicateModel(
        request: AiModelInspectionRequest,
        onChunk: (chunk: Uint8Array) => void,
    ): Promise<AiTransportResult> {
        const endpoint = replicateModelMetadataEndpoint(request.model);
        const channel = new Channel<{ kind: "chunk"; base64: string }>();
        channel.onmessage = (event) => onChunk(decodeBase64(event.base64));
        return invoke<AiTransportResult>("send_ai_request", {
            request: {
                providerId: "replicate",
                endpoint,
                confirmedEndpoint: endpoint,
                model: request.model,
                accept: "application/json",
                requestBody: "",
                requestBodyHash: "",
                confirmedBodyHash: "",
                credentialStorage: request.credentialStorage,
                credential: request.credential,
                inspectReplicateModel: true,
            },
            onChunk: channel,
        });
    },

    async aiCredentialStoreAvailable(): Promise<boolean> {
        return invoke<boolean>("ai_credential_store_available");
    },

    async desktopDiagnostics(probeAudioEndpoints: boolean): Promise<DesktopDiagnostics> {
        return invoke<DesktopDiagnostics>("get_desktop_diagnostics", { probeAudioEndpoints });
    },

    async hasAiCredential(providerId: string): Promise<boolean> {
        return invoke<boolean>("has_ai_credential", { providerId });
    },

    async saveAiCredential(providerId: string, value: string): Promise<void> {
        await invoke("save_ai_credential", { providerId, value });
    },

    async removeAiCredential(providerId: string): Promise<void> {
        await invoke("remove_ai_credential", { providerId });
    },

    async createArchiveLocation(suggestedName: string): Promise<string | null> {
        return save({
            title: "Create Tutorux archive",
            defaultPath: suggestedName,
            filters: [{ name: "Tutorux archive", extensions: ["tux"] }],
        });
    },

    async openLaunchArchive(): Promise<OpenedArchive | null> {
        const path = await invoke<string | null>("take_pending_open_archive");
        return path ? authorizeArchivePath(path) : null;
    },

    async reopenArchiveAtPath(path: string): Promise<OpenedArchive> {
        return authorizeArchivePath(path);
    },

    notify(message: string, tone = "info"): void {
        window.dispatchEvent(new CustomEvent("tutorux:notice", { detail: { message, tone } }));
    },

    onNativeCommand(handler): Promise<() => void> {
        return listen<string>("tutorux:native-command", (event) => handler(event.payload));
    },
};

function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}
