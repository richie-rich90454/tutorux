import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { sourceStream, type ArchiveByteSource } from "../archive/source";
import type {
  AiTransportRequest,
  AiTransportResult,
  ArchivePlatform,
  BinaryExportSource,
  OpenedArchive,
} from "./types";

class TauriArchiveSource implements ArchiveByteSource {
  constructor(
    readonly token: string,
    readonly size: bigint,
  ) {}

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
  }
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
        archiveToken: source instanceof TauriArchiveSource ? source.token : null,
      },
    );
    try {
      await writeFile(temporaryPath, sourceStream(source), { create: true });
      await invoke("publish_archive_save", { token });
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
      { targetPath: path, archiveToken: null },
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

  async sendAiRequest(
    request: AiTransportRequest,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<AiTransportResult> {
    const channel = new Channel<{ kind: "chunk"; base64: string }>();
    channel.onmessage = (event) => onChunk(decodeBase64(event.base64));
    return invoke<AiTransportResult>("send_ai_request", { request, onChunk: channel });
  },

  async aiCredentialStoreAvailable(): Promise<boolean> {
    return invoke<boolean>("ai_credential_store_available");
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
