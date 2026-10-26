import type { ArchiveByteSource } from "../archive/source";

export interface OpenedArchive {
  readonly source: ArchiveByteSource;
  readonly name: string;
  readonly location: string | null;
}

export type BinaryExportPayload = Uint8Array | ReadableStream<Uint8Array>;
export type BinaryExportSource = BinaryExportPayload | (() => Promise<BinaryExportPayload>);

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
  createArchiveLocation(suggestedName: string): Promise<string | null>;
  notify(message: string, tone?: "success" | "info" | "error"): void;
  onNativeCommand?(handler: (command: string) => void): Promise<() => void>;
  openLaunchArchive?(): Promise<OpenedArchive | null>;
}
