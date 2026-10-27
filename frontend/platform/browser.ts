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
    const fileType = {
      description: mimeType === "audio/wav" ? "WAV audio" : "Exported file",
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
    if (!response.ok) {
      throw new Error(
        `The provider returned HTTP ${response.status}. Review the provider settings and try again.`,
      );
    }
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json" && contentType !== request.accept) {
      throw new Error("The provider returned an unsupported response format.");
    }
    if (!response.body) throw new Error("The provider returned an empty response stream.");
    const reader = response.body.getReader();
    const streamTimeoutId = window.setTimeout(() => timeout.abort(), 600_000);
    let responseBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        responseBytes += result.value.byteLength;
        if (responseBytes > 16 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("The provider response exceeded the 16 MiB safety limit.");
        }
        onChunk(result.value);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("16 MiB")) throw error;
      throw new Error("The provider response stream ended unexpectedly.", { cause: error });
    } finally {
      reader.releaseLock();
      window.clearTimeout(streamTimeoutId);
    }
    return {
      status: response.status,
      contentType,
      responseBytes,
    };
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
