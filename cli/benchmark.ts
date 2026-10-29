import { performance } from "node:perf_hooks";
import { RecordType, type ArchiveRecord } from "../frontend/archive/format";
import type { ArchiveSnapshot } from "../frontend/archive/archive";
import { renderGuideMarkdown } from "../frontend/domain/guides";
import {
  enumerateAudioDiagnostics,
  readBenchmarkHostSummary,
  readSystemDiagnosticSnapshot,
  throwIfAborted,
} from "./diagnostics";

export const CLI_BENCHMARK_ACTIONS = [
  "startup",
  "memory",
  "cpu",
  "audio",
  "indexing",
  "rendering",
  "export",
  "full",
] as const;

export type CliBenchmarkAction = (typeof CLI_BENCHMARK_ACTIONS)[number];

export interface CliBenchmarkOptions {
  signal?: AbortSignal;
}

export function createBenchmarkReport(action: CliBenchmarkAction): Record<string, unknown> {
  const system = readSystemDiagnosticSnapshot();
  const host = readBenchmarkHostSummary();
  return {
    benchmark: action,
    ...system,
    ...host,
    total_memory_bytes: host["total_memory_bytes"],
    available_memory_bytes: Number(system.available_memory_bytes),
    resident_memory_bytes: Number(system.resident_memory_bytes),
    process_uptime_seconds: Number(system.process_uptime_us) / 1_000_000,
    measurement_scope:
      action === "startup" ? "process-uptime-and-current-command" : "current-process",
  };
}

export async function measureArchiveIndex(
  report: Record<string, unknown>,
  snapshot: ArchiveSnapshot,
  options: CliBenchmarkOptions = {},
): Promise<void> {
  const startedAt = performance.now();
  let indexedRecords = 0;
  const indexedTypes = [
    RecordType.student,
    RecordType.session,
    RecordType.transcriptSegment,
    RecordType.annotation,
    RecordType.assetMetadata,
    RecordType.evidenceNode,
    RecordType.guide,
  ];
  for (const type of indexedTypes) {
    throwIfAborted(options.signal);
    const records = await snapshot.listRecordMetadata(type);
    indexedRecords += records.length;
  }
  throwIfAborted(options.signal);
  report["index_records"] = indexedRecords;
  report["index_elapsed_us"] = Math.max(0, Math.round((performance.now() - startedAt) * 1000));
  report["archive_generation"] = snapshot.commit.generation.toString();
}

export function measureGuideExport(report: Record<string, unknown>, guide: ArchiveRecord): void {
  const startedAt = performance.now();
  const markdown = renderGuideMarkdown(guide);
  report["export_format"] = "markdown-render";
  report["export_bytes"] = new TextEncoder().encode(markdown).byteLength;
  report["export_elapsed_us"] = Math.max(0, Math.round((performance.now() - startedAt) * 1000));
}

export async function measureAudioEnumeration(
  report: Record<string, unknown>,
  options: CliBenchmarkOptions = {},
): Promise<void> {
  throwIfAborted(options.signal);
  const startedAt = performance.now();
  const audio = await enumerateAudioDiagnostics(options.signal);
  report["audio_devices"] = audio.available ? audio.rows.length : "unavailable";
  report["audio_enumeration_elapsed_us"] = Math.max(
    0,
    Math.round((performance.now() - startedAt) * 1000),
  );
  if (!audio.available)
    report["audio_reason"] = audio.reason ?? "Audio endpoint enumeration is unavailable.";
  report["audio_status"] = audio.status;
}

export function measureRendering(report: Record<string, unknown>): void {
  report["rendering_measured"] = false;
  report["rendering_reason"] = "run-the-benchmark-in-the-active-desktop-window";
}
