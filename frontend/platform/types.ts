import type { ArchiveByteSource } from "../archive/source";
import type {
  CommandConsoleAvailability,
  CommandConsoleRun,
} from "./command-console";

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

/** A selected destination for a verified sanitized copy, published as a separate archive. */
export interface SanitizedCopyDestination {
  readonly label: string;
  /** Persist only the new byte range produced by this archive checkpoint. */
  checkpoint(source: ArchiveByteSource, previousSize: bigint): Promise<void>;
  /** Finish publishing the new archive without replacing an existing destination. */
  publish(source: ArchiveByteSource): Promise<string | null>;
  /** Remove staged output when generation is canceled or fails. */
  cancel(): Promise<void>;
}

export interface EndpointAvailability {
  readonly available: boolean;
  readonly count: number;
  readonly truncatedCount: number;
  readonly probes: readonly AudioEndpointProbe[];
  readonly unavailableReason: string | null;
}

export interface AudioEndpointProbe {
  readonly state: "configuration-ready" | "stream-opened" | "unavailable" | "not-probed";
  readonly sampleFormat: string | null;
  readonly sampleRateHz: number | null;
  readonly channelCount: number | null;
  readonly unavailableReason: string | null;
}

export interface DiagnosticMetric {
  readonly available: boolean;
  readonly value: number | null;
  readonly unavailableReason: string | null;
}

export interface ProcessDiagnostics {
  readonly uptimeMicroseconds: DiagnosticMetric;
  readonly cpuTimeMicroseconds: DiagnosticMetric;
  readonly residentMemoryBytes: DiagnosticMetric;
  readonly peakResidentMemoryBytes: DiagnosticMetric;
  readonly availableMemoryBytes: DiagnosticMetric;
}

export interface DesktopDiagnostics {
  readonly os: string;
  readonly architecture: string;
  readonly availableThreads: number | null;
  readonly processMetrics: ProcessDiagnostics;
  readonly audioEndpoints: {
    readonly probeScope: string;
    readonly microphones: EndpointAvailability;
    readonly systemAudio: EndpointAvailability;
    readonly applicationAudio: EndpointAvailability;
  };
}

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

export interface AiModelInspectionRequest {
  model: string;
  credentialStorage: AiCredentialStorage;
  credential: string;
}

export interface AiTransportResult {
  status: number;
  contentType: string;
  responseBytes: number;
  complete: boolean;
  cancelled?: boolean;
  errorMessage?: string;
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
  chooseSanitizedCopyDestination(suggestedName: string): Promise<SanitizedCopyDestination | null>;
  sendAiRequest(
    request: AiTransportRequest,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<AiTransportResult>;
  inspectReplicateModel(
    request: AiModelInspectionRequest,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<AiTransportResult>;
  aiCredentialStoreAvailable(): Promise<boolean>;
  desktopDiagnostics?(probeAudioEndpoints: boolean): Promise<DesktopDiagnostics>;
  commandConsoleAvailability?(): Promise<CommandConsoleAvailability>;
  startCommandConsole?(
    source: ArchiveByteSource,
    input: string,
    passphrase: string,
    newPassphrase: string,
    onOutput: (text: string) => void,
  ): Promise<CommandConsoleRun>;
  reopenArchiveAtPath?(path: string): Promise<OpenedArchive>;
  hasAiCredential(providerId: string): Promise<boolean>;
  saveAiCredential(providerId: string, value: string): Promise<void>;
  removeAiCredential(providerId: string): Promise<void>;
  createArchiveLocation(suggestedName: string): Promise<string | null>;
  notify(message: string, tone?: "success" | "info" | "error"): void;
  onNativeCommand?(handler: (command: string) => void): Promise<() => void>;
  openLaunchArchive?(): Promise<OpenedArchive | null>;
}
