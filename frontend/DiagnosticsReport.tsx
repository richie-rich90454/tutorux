import { Show, createSignal, type JSX } from "solid-js";
import {
    verifyArchiveHistory,
    verifyArchiveSnapshot,
    type ArchiveSnapshot,
} from "./archive/archive";
import { ArchiveFormatError } from "./archive/format";
import { buttonOutline, card, cn, errorText, mutedText } from "./ui";
import { platform } from "@platform";
import type { DesktopDiagnostics, DiagnosticMetric, EndpointAvailability } from "./platform/types";

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

const settingsSection = cn(card, "settings-section my-3 overflow-hidden");
const sectionHeading = "settings-section-heading border-b border-line-soft px-4 pb-2.5 pt-3.5";
const actionRow = "diagnostics-report-actions flex flex-wrap items-center gap-2.5";
const checkboxLabel = "flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-ink-soft";
const checkbox =
    "mt-0.5 size-4 shrink-0 accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";
const summaryRow =
    "min-w-0 grid gap-1 rounded-[5px] border border-line-soft bg-surface-subtle px-3 py-2.5";
const summaryTerm = "text-xs text-muted";
const summaryValue = "min-w-0 break-words text-xs text-ink-soft tabular-nums";

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
            verificationIssue =
                cause instanceof ArchiveFormatError ? cause.code : "archive_read_failed";
        }

        let desktopDiagnostics: DesktopDiagnostics | null = null;
        try {
            desktopDiagnostics =
                (await platform.desktopDiagnostics?.(includeAudioStreamProbe)) ?? null;
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
                throw new Error(
                    "The archive changed while diagnostics were running. Run them again.",
                );
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
                throw new Error(
                    "The archive changed while the report was prepared. Create it again.",
                );
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
            setError(
                cause instanceof Error ? cause.message : "Could not export the diagnostics report.",
            );
        } finally {
            setWorking(false);
        }
    }

    const unavailable = () => props.disabled || working() || props.snapshot.locked;

    return (
        <section
            class={cn("diagnostics-report", settingsSection)}
            aria-labelledby="diagnostics-report-title"
        >
            <div class={sectionHeading}>
                <h2 id="diagnostics-report-title" class="text-xs font-semibold text-ink-soft">
                    Diagnostics and support reports
                </h2>
                <p class={cn(mutedText, "mt-1")}>
                    Run local integrity checks or save a redacted report for support.
                </p>
            </div>
            <div class="diagnostics-report-body grid gap-3 px-4 pb-4 pt-3">
                <p class={cn("diagnostics-report-privacy", mutedText, "max-w-[760px]")}>
                    The report includes the archive ID, format, generation, verification counts, and
                    app runtime and user-agent details. Native desktop diagnostics add process
                    uptime, CPU time, resident and available memory, and microphone, system-audio,
                    and per-application endpoint results with format, rate, channel count, and probe
                    status. Endpoint names, process IDs, and identifiers are omitted. Audio stream
                    probes are optional: when selected, each supported endpoint is opened for up to
                    125 ms, for at most 12 endpoints total. Audio callback buffers are immediately
                    discarded and never saved. Your operating system may ask for audio permission.
                    Diagnostics never make a network request or write audio to the archive. The
                    report omits file paths, credentials, transcripts, recordings, and record
                    contents.
                </p>
                <label class={cn("diagnostics-report-history", checkboxLabel)}>
                    <input
                        type="checkbox"
                        checked={includeHistory()}
                        disabled={unavailable()}
                        onChange={(event) => setIncludeHistory(event.currentTarget.checked)}
                        class={checkbox}
                    />
                    Verify historical revisions and include full history counts
                </label>
                <Show when={platform.kind === "desktop"}>
                    <label class={cn("diagnostics-report-history", checkboxLabel)}>
                        <input
                            type="checkbox"
                            checked={probeAudioEndpoints()}
                            disabled={unavailable()}
                            onChange={(event) =>
                                setProbeAudioEndpoints(event.currentTarget.checked)
                            }
                            class={checkbox}
                        />
                        Open supported microphone, system-audio, and per-application endpoints
                        briefly to check capture access; endpoint names are omitted, callback audio
                        is discarded, and nothing is saved
                    </label>
                </Show>
                <div class={actionRow}>
                    <button
                        class={cn("button", buttonOutline)}
                        type="button"
                        disabled={unavailable()}
                        onClick={() => void runDiagnostics()}
                    >
                        {working() ? "Checking archive…" : "Run diagnostics"}
                    </button>
                    <button
                        class={cn("button", buttonOutline)}
                        type="button"
                        disabled={unavailable()}
                        onClick={() => void exportReport()}
                    >
                        {working() ? "Preparing report…" : "Export report"}
                    </button>
                    <Show when={working()}>
                        <span role="status" class={mutedText}>
                            {probeAudioEndpoints()
                                ? "Verifying the archive and checking approved audio endpoints…"
                                : "Reading and verifying archive records…"}
                        </span>
                    </Show>
                </div>
                <Show when={error()}>
                    <p class={cn("diagnostics-report-error", errorText)} role="alert">
                        {error()}
                    </p>
                </Show>
                <Show when={status()}>
                    <p class={cn("diagnostics-report-status", mutedText)} role="status">
                        {status()}
                    </p>
                </Show>
                <Show when={summary()}>
                    {(result) => (
                        <dl
                            class="diagnostics-report-summary grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-2"
                            aria-label="Diagnostic results"
                        >
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Archive integrity</dt>
                                <dd class={summaryValue}>
                                    {result().archiveValid ? "Valid" : "Issue found"}
                                </dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Generation</dt>
                                <dd class={summaryValue}>{result().generation}</dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Records checked</dt>
                                <dd class={summaryValue}>{result().recordsChecked}</dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Live / in Trash</dt>
                                <dd class={summaryValue}>
                                    {result().liveRecords} / {result().deletedRecords}
                                </dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Runtime</dt>
                                <dd class={summaryValue}>
                                    {result().os}
                                    {result().architecture ? ` · ${result().architecture}` : ""}
                                    {result().availableThreads === null
                                        ? ""
                                        : ` · ${result().availableThreads} threads`}
                                </dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Process uptime / CPU time</dt>
                                <dd class={summaryValue}>
                                    {result().processUptime} · {result().processCpuTime}
                                </dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Resident / peak memory</dt>
                                <dd class={summaryValue}>
                                    {result().residentMemory} · {result().peakResidentMemory}
                                </dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Available system memory</dt>
                                <dd class={summaryValue}>{result().availableMemory}</dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Microphone endpoint probes</dt>
                                <dd class={summaryValue}>{result().microphoneProbes}</dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>System-audio endpoint probes</dt>
                                <dd class={summaryValue}>{result().systemAudioProbes}</dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Per-application audio endpoint probes</dt>
                                <dd class={summaryValue}>{result().applicationAudioProbes}</dd>
                            </div>
                            <div class={summaryRow}>
                                <dt class={summaryTerm}>Network</dt>
                                <dd class={summaryValue}>Not checked</dd>
                            </div>
                            <Show when={result().issues}>
                                <div class={cn("diagnostics-report-issues", summaryRow)}>
                                    <dt class={summaryTerm}>Issues</dt>
                                    <dd class={cn(summaryValue, "whitespace-pre-wrap")}>
                                        {result().issues}
                                    </dd>
                                </div>
                            </Show>
                        </dl>
                    )}
                </Show>
                <Show when={props.snapshot.locked}>
                    <p class={cn("diagnostics-report-muted", mutedText)}>
                        Unlock this archive to verify and export a report.
                    </p>
                </Show>
            </div>
        </section>
    );
}
