import { BrowserFileArchiveSource, sourceStream, type ArchiveByteSource } from "../archive/source";
import type {
  ArchivePlatform,
  AiTransportRequest,
  AiTransportResult,
  BinaryExportPayload,
  BinaryExportSource,
  OpenedArchive,
} from "./types";

interface FilePickerType {
  description: string;
  accept: Record<string, string[]>;
}

const MAX_AI_RESPONSE_BYTES = 16 * 1024 * 1024;

const archiveFilter: FilePickerType[] = [
  { description: "Tutorux archive", accept: { "application/x-tutorux": [".tux"] } },
];
interface BrowserArchiveHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: ReadableStream<Uint8Array>): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
  }>;
}
type FileAccessWindow = Window & {
  showOpenFilePicker?: (options: {
    multiple: false;
    types: typeof archiveFilter;
  }) => Promise<BrowserArchiveHandle[]>;
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: FilePickerType[];
  }) => Promise<BrowserArchiveHandle>;
};

export const platform: ArchivePlatform = {
  kind: "browser",

  async openArchive(): Promise<OpenedArchive | null> {
    const accessWindow = window as FileAccessWindow;
    if (accessWindow.showOpenFilePicker) {
      const [handle] = await accessWindow.showOpenFilePicker({
        multiple: false,
        types: archiveFilter,
      });
      if (!handle) return null;
      const file = await handle.getFile();
      return { source: new BrowserFileArchiveSource(file), name: file.name, location: null };
    }

    const file = await chooseFile();
    return file
      ? { source: new BrowserFileArchiveSource(file), name: file.name, location: null }
      : null;
  },

  async saveArchive(source: ArchiveByteSource, suggestedName: string): Promise<string | null> {
    const accessWindow = window as FileAccessWindow;
    if (accessWindow.showSaveFilePicker) {
      const handle = await accessWindow.showSaveFilePicker({
        suggestedName,
        types: archiveFilter,
      });
      const writable = await handle.createWritable();
      try {
        await writable.write(sourceStream(source));
        await writable.close();
      } catch (error) {
        await writable.abort(error).catch(() => undefined);
        throw error;
      }
      return handle.name;
    }

    if (source.size > 512n * 1024n * 1024n) {
      throw new Error(
        "This browser cannot safely export an archive larger than 512 MiB. Use Tutorux for desktop to save large archives.",
      );
    }
    const blob = await new Response(sourceStream(source), {
      headers: { "Content-Type": "application/x-tutorux" },
    }).blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return suggestedName;
  },

  async exportTextFile(suggestedName: string, contents: string, mimeType: string): Promise<string> {
    const blob = new Blob([contents], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return suggestedName;
  },

  async exportBinaryFile(
    suggestedName: string,
    contents: BinaryExportSource,
    mimeType: string,
  ): Promise<string> {
    const extension = suggestedName.split(".").at(-1) ?? "bin";
    const isDocx =
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const fileType = {
      description:
        mimeType === "audio/wav" ? "WAV audio" : isDocx ? "Word document" : "Exported file",
      accept: { [mimeType]: [`.${extension}`] },
    };
    const accessWindow = window as FileAccessWindow;
    if (accessWindow.showSaveFilePicker) {
      const handle = await accessWindow.showSaveFilePicker({
        suggestedName,
        types: [fileType],
      });
      const writable = await handle.createWritable();
      try {
        const payload = await resolveExportPayload(contents);
        await writable.write(toReadableStream(payload));
        await writable.close();
        return handle.name;
      } catch (error) {
        await writable.abort(error).catch(() => undefined);
        throw error;
      }
    }

    const payload = await resolveExportPayload(contents);
    const blob =
      payload instanceof Uint8Array
        ? new Blob([payload.slice().buffer], { type: mimeType })
        : await new Response(payload, { headers: { "Content-Type": mimeType } }).blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return suggestedName;
  },

  async sendAiRequest(
    request: AiTransportRequest,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<AiTransportResult> {
    const headers = new Headers({
      "Content-Type": "application/json",
      Accept: request.accept,
    });
    if (request.credential) {
      const header =
        request.providerId === "anthropic"
          ? "x-api-key"
          : request.providerId === "google-gemini"
            ? "x-goog-api-key"
            : "Authorization";
      headers.set(
        header,
        request.providerId === "anthropic" || request.providerId === "google-gemini"
          ? request.credential
          : `Bearer ${request.credential}`,
      );
    }
    if (request.providerId === "anthropic") headers.set("anthropic-version", "2023-06-01");
    const timeout = new AbortController();
    const timeoutId = window.setTimeout(() => timeout.abort(), 600_000);
    let response: Response;
    try {
      response = await fetch(request.endpoint, {
        method: "POST",
        headers,
        body: request.requestBody,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: timeout.signal,
      });
    } catch {
      window.clearTimeout(timeoutId);
      throw new Error(
        "The provider request could not be completed. Check the endpoint and browser CORS settings, then try the desktop app.",
      );
    }
    window.clearTimeout(timeoutId);
    const contentType =
      (response.headers.get("content-type") ?? "").split(";").at(0)?.trim().toLowerCase() ?? "";
    if (!response.body) {
      return { status: response.status, contentType, responseBytes: 0, complete: true };
    }
    const reader = response.body.getReader();
    const streamTimeoutId = window.setTimeout(() => timeout.abort(), 600_000);
    let responseBytes = 0;
    let complete = true;
    try {
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch {
          complete = false;
          break;
        }
        if (result.done) break;
        const remaining = MAX_AI_RESPONSE_BYTES - responseBytes;
        if (result.value.byteLength > remaining) {
          if (remaining > 0) {
            onChunk(result.value.subarray(0, remaining));
            responseBytes = MAX_AI_RESPONSE_BYTES;
          }
          complete = false;
          await reader.cancel().catch(() => undefined);
          break;
        }
        onChunk(result.value);
        responseBytes += result.value.byteLength;
      }
    } finally {
      reader.releaseLock();
      window.clearTimeout(streamTimeoutId);
    }
    return {
      status: response.status,
      contentType,
      responseBytes,
      complete,
    };
  },

  async aiCredentialStoreAvailable(): Promise<boolean> {
    return false;
  },

  async hasAiCredential(): Promise<boolean> {
    return false;
  },

  async saveAiCredential(): Promise<void> {
    throw new Error("System keychain storage is available only in the Tutorux desktop app.");
  },

  async removeAiCredential(): Promise<void> {
    throw new Error("System keychain storage is available only in the Tutorux desktop app.");
  },

  async createArchiveLocation(suggestedName: string): Promise<string | null> {
    return suggestedName;
  },

  notify(message: string, tone = "info"): void {
    window.dispatchEvent(new CustomEvent("tutorux:notice", { detail: { message, tone } }));
  },
};

async function resolveExportPayload(source: BinaryExportSource): Promise<BinaryExportPayload> {
  return typeof source === "function" ? source() : source;
}

function toReadableStream(payload: BinaryExportPayload): ReadableStream<Uint8Array> {
  return payload instanceof Uint8Array
    ? (new Blob([payload.slice().buffer]).stream() as ReadableStream<Uint8Array>)
    : payload;
}

async function chooseFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".tux,application/x-tutorux";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}
