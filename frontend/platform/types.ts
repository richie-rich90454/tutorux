import type { ArchiveByteSource } from "../archive/source";

export interface OpenedArchive {
  readonly source: ArchiveByteSource;
  readonly name: string;
  readonly location: string | null;
}

export type BinaryExportPayload = Uint8Array | ReadableStream<Uint8Array>;
export type BinaryExportSource = BinaryExportPayload | (() => Promise<BinaryExportPayload>);

export interface AiTransportRequest {
  providerId: string;
  endpoint: string;
  confirmedEndpoint: string;
  model: string;
  accept: string;
  requestBody: string;
  requestBodyHash: string;
  confirmedBodyHash: string;
  credential: string;
}

export interface AiTransportResult {
  status: number;
  contentType: string;
  responseBytes: number;
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
  createArchiveLocation(suggestedName: string): Promise<string | null>;
  notify(message: string, tone?: "success" | "info" | "error"): void;
  onNativeCommand?(handler: (command: string) => void): Promise<() => void>;
  openLaunchArchive?(): Promise<OpenedArchive | null>;
}
