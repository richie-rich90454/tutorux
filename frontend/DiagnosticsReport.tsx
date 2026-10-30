import { Show, createSignal, type JSX } from "solid-js";
import {
  verifyArchiveHistory,
  verifyArchiveSnapshot,
  type ArchiveSnapshot,
} from "./archive/archive";
import { ArchiveFormatError } from "./archive/format";
import { platform } from "@platform";
import type { DesktopDiagnostics, DiagnosticMetric, EndpointAvailability } from "./platform/types";
import "./diagnostics-report.css";

interface DiagnosticsReportProps {
  snapshot: ArchiveSnapshot;
  disabled: boolean;
}

interface DiagnosticsSummary {
  archiveValid: boolean;
  generation: string;
  recordsChecked: number;
  liveRecords: number;
  deletedRecords: number;
  issues: string;
  os: string;
  architecture: string | null;
  availableThreads: number | null;
  processUptime: string;
  processCpuTime: string;
  residentMemory: string;
  peakResidentMemory: string;
  availableMemory: string;
  microphoneProbes: string;
  systemAudioProbes: string;
  applicationAudioProbes: string;
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function formatDuration(microseconds: number): string {
  const totalSeconds = Math.floor(microseconds / 1_000_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} m`;
  if (minutes > 0) return `${minutes} m ${seconds} s`;
  return `${(microseconds / 1_000_000).toFixed(2)} s`;
}

function metricText(
  metric: DiagnosticMetric | null | undefined,
  format: (value: number) => string,
): string {
  if (!metric) return "Unavailable · native process metrics were not returned.";
  if (metric.available && metric.value !== null) return format(metric.value);
  return `Unavailable · ${metric.unavailableReason ?? "The operating system did not provide this metric."}`;
}

function endpointProbeText(
  endpoint: EndpointAvailability | null | undefined,
  probeScope: string | undefined,
): string {
  if (!endpoint) return "Unavailable · native audio diagnostics were not returned.";
  const opened = endpoint.probes.filter((probe) => probe.state === "stream-opened").length;
  const ready = endpoint.probes.filter((probe) =>
    ["configuration-ready", "stream-opened"].includes(probe.state),
  ).length;
  const notProbed = endpoint.probes.filter((probe) => probe.state === "not-probed").length;
  const failed = endpoint.probes.filter((probe) => probe.state === "unavailable");
  const reasons = [
    ...new Set(
      failed.flatMap((probe) => (probe.unavailableReason ? [probe.unavailableReason] : [])),
    ),
  ];
  const reason = endpoint.unavailableReason ?? reasons.join(" ");
  const explicitStreamProbe = probeScope?.startsWith("explicit opt-in") ?? false;
  const result = explicitStreamProbe
    ? `${opened} streams opened / ${endpoint.probes.length} endpoints listed`
    : `${ready} configurations ready / ${endpoint.probes.length} endpoints listed`;
  return `${result}${notProbed ? ` · ${notProbed} not opened` : ""}${endpoint.truncatedCount ? ` · ${endpoint.truncatedCount} additional endpoints omitted from this bounded report` : ""}${reason ? ` · ${reason}` : ""}`;
}

/** Run local archive checks and optionally export a bounded support report. */
export function DiagnosticsReport(props: DiagnosticsReportProps): JSX.Element {
  const [includeHistory, setIncludeHistory] = createSignal(false);
  const [probeAudioEndpoints, setProbeAudioEndpoints] = createSignal(false);
  const [working, setWorking] = createSignal(false);
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [summary, setSummary] = createSignal<DiagnosticsSummary | null>(null);

  async function inspectArchive(
    snapshot: ArchiveSnapshot,
    includeAudioStreamProbe: boolean,
  ): Promise<{
    report: Record<string, unknown>;
    summary: DiagnosticsSummary;
  }> {
    let currentVerification: Awaited<ReturnType<typeof verifyArchiveSnapshot>> | null = null;
    let historyVerification: Awaited<ReturnType<typeof verifyArchiveHistory>> | null = null;
    let verificationIssue = "";

    try {
      if (includeHistory()) {
        historyVerification = await verifyArchiveHistory(snapshot);
        currentVerification = historyVerification;
      } else {
        currentVerification = await verifyArchiveSnapshot(snapshot);
      }
    } catch (cause) {
      verificationIssue = cause instanceof ArchiveFormatError ? cause.code : "archive_read_failed";
    }

    let desktopDiagnostics: DesktopDiagnostics | null = null;
    try {
      desktopDiagnostics = (await platform.desktopDiagnostics?.(includeAudioStreamProbe)) ?? null;
    } catch {
      // Platform details are optional; an unavailable audio backend must not block diagnostics.
    }

    const report = {
      report_format: "tutorux-diagnostics-v1",
      generated_at: new Date().toISOString(),
      runtime: {
        kind: platform.kind,
        os: desktopDiagnostics?.os ?? (navigator.platform || "unknown"),
        architecture: desktopDiagnostics?.architecture ?? null,
        available_threads:
          desktopDiagnostics?.availableThreads ?? (navigator.hardwareConcurrency || null),
        user_agent: navigator.userAgent.slice(0, 512),
        process_metrics: desktopDiagnostics?.processMetrics ?? null,
        audio_endpoints: desktopDiagnostics?.audioEndpoints ?? null,
        desktop_diagnostics_available: desktopDiagnostics !== null,
      },
      archive_id: snapshot.header.id,
      archive_generation: snapshot.commit.generation.toString(),
      archive_format: {
        major: snapshot.header.majorVersion,
        minor: snapshot.header.minorVersion,
      },
      archive_size_bytes: snapshot.source.size.toString(),
      encrypted: snapshot.encrypted,
      archive_valid: currentVerification !== null && !verificationIssue,
      audio_stream_probe_requested: includeAudioStreamProbe,
      records_checked: currentVerification?.currentRecords ?? 0,
      live_records: currentVerification?.liveRecords ?? 0,
      deleted_records: currentVerification?.deletedRecords ?? 0,
      index_entries: snapshot.indexEntryCount(),
      issues: verificationIssue,
      full_verification: historyVerification,
      network_checked: false,
    };
    const diagnosticsSummary: DiagnosticsSummary = {
      archiveValid: report.archive_valid,
      generation: report.archive_generation,
      recordsChecked: report.records_checked,
      liveRecords: report.live_records,
      deletedRecords: report.deleted_records,
      issues: report.issues,
      os: report.runtime.os,
      architecture: report.runtime.architecture,
      availableThreads: report.runtime.available_threads,
      processUptime: metricText(
        desktopDiagnostics?.processMetrics.uptimeMicroseconds,
        formatDuration,
      ),
      processCpuTime: metricText(
        desktopDiagnostics?.processMetrics.cpuTimeMicroseconds,
        (value) => `${(value / 1_000_000).toFixed(2)} s`,
      ),
      residentMemory: metricText(
        desktopDiagnostics?.processMetrics.residentMemoryBytes,
        formatBytes,
      ),
      peakResidentMemory: metricText(
        desktopDiagnostics?.processMetrics.peakResidentMemoryBytes,
        formatBytes,
      ),
      availableMemory: metricText(
        desktopDiagnostics?.processMetrics.availableMemoryBytes,
        formatBytes,
      ),
      microphoneProbes: endpointProbeText(
        desktopDiagnostics?.audioEndpoints.microphones,
        desktopDiagnostics?.audioEndpoints.probeScope,
      ),
      systemAudioProbes: endpointProbeText(
        desktopDiagnostics?.audioEndpoints.systemAudio,
        desktopDiagnostics?.audioEndpoints.probeScope,
      ),
      applicationAudioProbes: endpointProbeText(
        desktopDiagnostics?.audioEndpoints.applicationAudio,
        desktopDiagnostics?.audioEndpoints.probeScope,
      ),
    };
    return { report, summary: diagnosticsSummary };
  }

  async function runDiagnostics(): Promise<void> {
    const snapshot = props.snapshot;
    const includeAudioStreamProbe = probeAudioEndpoints();
    setWorking(true);
    setError("");
    setStatus("");
    setSummary(null);
    try {
      const result = await inspectArchive(snapshot, includeAudioStreamProbe);
      if (props.snapshot !== snapshot) {
        throw new Error("The archive changed while diagnostics were running. Run them again.");
      }
      setSummary(result.summary);
      setStatus(
        result.summary.archiveValid
          ? "Diagnostics finished. No network request was made."
          : "Diagnostics found an archive verification issue. No network request was made.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not run diagnostics.");
    } finally {
      setWorking(false);
    }
  }

  async function exportReport(): Promise<void> {
    const snapshot = props.snapshot;
    const includeAudioStreamProbe = probeAudioEndpoints();
    setWorking(true);
    setError("");
    setStatus("");

    try {
      const result = await inspectArchive(snapshot, includeAudioStreamProbe);
      if (props.snapshot !== snapshot) {
        throw new Error("The archive changed while the report was prepared. Create it again.");
      }
      setSummary(result.summary);
      const suffix = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      const savedPath = await platform.exportTextFile(
        `tutorux-diagnostics-${suffix}.json`,
        `${JSON.stringify(result.report, null, 2)}\n`,
        "application/json;charset=utf-8",
      );
      if (savedPath) {
        setStatus(
          result.summary.archiveValid
            ? "The diagnostics report was saved. It contains no archive path or record contents."
            : "The diagnostics report was saved and records an archive verification issue.",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export the diagnostics report.");
    } finally {
      setWorking(false);
    }
  }

  const unavailable = () => props.disabled || working() || props.snapshot.locked;

  return (
    <section class="settings-section diagnostics-report" aria-labelledby="diagnostics-report-title">
      <div class="settings-section-heading">
        <h2 id="diagnostics-report-title">Diagnostics and support reports</h2>
        <p>Run local integrity checks or save a redacted report for support.</p>
      </div>
      <div class="diagnostics-report-body">
        <p class="diagnostics-report-privacy">
          The report includes the archive ID, format, generation, verification counts, and app
          runtime and user-agent details. Native desktop diagnostics add process uptime, CPU time,
          resident and available memory, and microphone, system-audio, and per-application endpoint
          results with format, rate, channel count, and probe status. Endpoint names, process IDs,
          and identifiers are omitted. Audio stream probes are optional: when selected, each
          supported endpoint is opened for up to 125 ms, for at most 12 endpoints total. Audio
          callback buffers are immediately discarded and never saved. Your operating system may ask
          for audio permission. Diagnostics never make a network request or write audio to the
          archive. The report omits file paths, credentials, transcripts, recordings, and record
          contents.
        </p>
        <label class="diagnostics-report-history">
          <input
            type="checkbox"
            checked={includeHistory()}
            disabled={unavailable()}
            onChange={(event) => setIncludeHistory(event.currentTarget.checked)}
          />
          Verify historical revisions and include full history counts
        </label>
        <Show when={platform.kind === "desktop"}>
          <label class="diagnostics-report-history">
            <input
              type="checkbox"
              checked={probeAudioEndpoints()}
              disabled={unavailable()}
              onChange={(event) => setProbeAudioEndpoints(event.currentTarget.checked)}
            />
            Open supported microphone, system-audio, and per-application endpoints briefly to check
            capture access; endpoint names are omitted, callback audio is discarded, and nothing is
            saved
          </label>
        </Show>
        <div class="diagnostics-report-actions">
          <button
            class="button button-outline"
            type="button"
            disabled={unavailable()}
            onClick={() => void runDiagnostics()}
          >
            {working() ? "Checking archive…" : "Run diagnostics"}
          </button>
          <button
            class="button button-outline"
            type="button"
            disabled={unavailable()}
            onClick={() => void exportReport()}
          >
            {working() ? "Preparing report…" : "Export report"}
          </button>
          <Show when={working()}>
            <span role="status">
              {probeAudioEndpoints()
                ? "Verifying the archive and checking approved audio endpoints…"
                : "Reading and verifying archive records…"}
            </span>
          </Show>
        </div>
        <Show when={error()}>
          <p class="diagnostics-report-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={status()}>
          <p class="diagnostics-report-status" role="status">
            {status()}
          </p>
        </Show>
        <Show when={summary()}>
          {(result) => (
            <dl class="diagnostics-report-summary" aria-label="Diagnostic results">
              <div>
                <dt>Archive integrity</dt>
                <dd>{result().archiveValid ? "Valid" : "Issue found"}</dd>
              </div>
              <div>
                <dt>Generation</dt>
                <dd>{result().generation}</dd>
              </div>
              <div>
                <dt>Records checked</dt>
                <dd>{result().recordsChecked}</dd>
              </div>
              <div>
                <dt>Live / in Trash</dt>
                <dd>
                  {result().liveRecords} / {result().deletedRecords}
                </dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>
                  {result().os}
                  {result().architecture ? ` · ${result().architecture}` : ""}
                  {result().availableThreads === null
                    ? ""
                    : ` · ${result().availableThreads} threads`}
                </dd>
              </div>
              <div>
                <dt>Process uptime / CPU time</dt>
                <dd>
                  {result().processUptime} · {result().processCpuTime}
                </dd>
              </div>
              <div>
                <dt>Resident / peak memory</dt>
                <dd>
                  {result().residentMemory} · {result().peakResidentMemory}
                </dd>
              </div>
              <div>
                <dt>Available system memory</dt>
                <dd>{result().availableMemory}</dd>
              </div>
              <div>
                <dt>Microphone endpoint probes</dt>
                <dd>{result().microphoneProbes}</dd>
              </div>
              <div>
                <dt>System-audio endpoint probes</dt>
                <dd>{result().systemAudioProbes}</dd>
              </div>
              <div>
                <dt>Per-application audio endpoint probes</dt>
                <dd>{result().applicationAudioProbes}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>Not checked</dd>
              </div>
              <Show when={result().issues}>
                <div class="diagnostics-report-issues">
                  <dt>Issues</dt>
                  <dd>{result().issues}</dd>
                </div>
              </Show>
            </dl>
          )}
        </Show>
        <Show when={props.snapshot.locked}>
          <p class="diagnostics-report-muted">Unlock this archive to verify and export a report.</p>
        </Show>
      </div>
    </section>
  );
}
