import type { ArchiveByteSource } from "../archive/source";

/** Session-only capability tied to the file chosen by the user. */
export interface BrowserArchiveAutosave {
  /** Must be called from a user gesture; never prompts during an automatic save. */
  requestPermission(): Promise<boolean>;
  /** Refuses changed or unauthorized files; returns a fresh source after saving. */
  save(source: ArchiveByteSource): Promise<ArchiveByteSource>;
}

export interface OpenedArchive {
  readonly source: ArchiveByteSource;
  readonly name: string;
  readonly location: string | null;
  readonly autosave?: BrowserArchiveAutosave;
}

export type BinaryExportPayload = Uint8Array | ReadableStream<Uint8Array>;
export type BinaryExportSource = BinaryExportPayload | (() => Promise<BinaryExportPayload>);
export type AiCredentialStorage = "none" | "encrypted-archive" | "system-keychain";

export interface AiTransportRequest {
  providerId: string;
  endpoint: string;
  confirmedEndpoint: string;
  model: string;
  accept: string;
  requestBody: string;
  requestBodyHash: string;
  confirmedBodyHash: string;
  credentialStorage: AiCredentialStorage;
  credential: string;
}

export interface AiTransportResult {
  status: number;
  contentType: string;
  responseBytes: number;
  complete: boolean;
}

export interface ArchivePlatform {
  readonly kind: "browser" | "desktop";
  openArchive(): Promise<OpenedArchive | null>;
  saveArchive(
    source: ArchiveByteSource,
    suggestedName: string,
    location?: string | null,
  ): Promise<string | null>;
  exportTextFile(suggestedName: string, contents: string, mimeType: string): Promise<string | null>;
  exportBinaryFile(
    suggestedName: string,
    contents: BinaryExportSource,
    mimeType: string,
  ): Promise<string | null>;
  sendAiRequest(
    request: AiTransportRequest,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<AiTransportResult>;
  aiCredentialStoreAvailable(): Promise<boolean>;
  hasAiCredential(providerId: string): Promise<boolean>;
  saveAiCredential(providerId: string, value: string): Promise<void>;
  removeAiCredential(providerId: string): Promise<void>;
  createArchiveLocation(suggestedName: string): Promise<string | null>;
  notify(message: string, tone?: "success" | "info" | "error"): void;
  onNativeCommand?(handler: (command: string) => void): Promise<() => void>;
  openLaunchArchive?(): Promise<OpenedArchive | null>;
}
