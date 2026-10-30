import { resolve } from "node:path";
import { buildArchiveDiagnosticReport, enumerateAudioDiagnostics } from "../diagnostics";
import {
  CLI_BENCHMARK_ACTIONS,
  createBenchmarkReport,
  measureArchiveIndex,
  measureAudioEnumeration,
  measureGuideExport,
  measureRendering,
  type CliBenchmarkAction,
} from "../benchmark";
import { RecordType } from "../../frontend/archive/format";
import { AI_PROVIDERS } from "../../frontend/ai/providers";
import { runAiCommand } from "./ai";
import { closeSnapshot, openForCommand, writeTextAtomically } from "./archive-io";
import { CliError, emit, requiredOption, sameFileIdentity } from "./shared";
import { requireLiveRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runDiagnosticsCommand(
  action: string,
  path: string | undefined,
  args: ParsedArguments,
  output: CliIo,
  signal?: AbortSignal,
): Promise<number> {
  if (action === "providers") {
    emit(
      output,
      AI_PROVIDERS,
      AI_PROVIDERS.map((provider) => `${provider.id}  ${provider.name}`).join("\n"),
      args.flags.has("json"),
    );
    return 0;
  }
  if (action === "network") {
    if (!args.options.has("provider")) {
      emit(
        output,
        { network_checked: false, reason: "provider-not-selected" },
        "No provider selected; no request sent.",
        args.flags.has("json"),
      );
      return 0;
    }
    if (!path) throw new CliError("Network diagnostics require --archive.");
    return runAiCommand("test", path, args, output);
  }
  if (action === "audio") {
    const audio = await enumerateAudioDiagnostics(signal);
    if (!audio.available) {
      const report = { status: "unavailable-in-cli", reason: audio.reason };
      emit(
        output,
        report,
        report.reason ?? "Audio endpoint enumeration is unavailable.",
        args.flags.has("json"),
      );
      return 0;
    }
    emit(
      output,
      audio.rows,
      `Audio diagnostics inspected ${audio.rows.length} endpoint(s); no stream was started.\n${JSON.stringify(audio.rows, null, 2)}`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (action === "graphics") {
    const report = {
      backend: "Tauri",
      compiled: true,
      status: "native-gui-enabled",
      reason: "No frame was rendered by this CLI process.",
      rendering_measured: false,
      rendering_reason: "run-the-benchmark-in-the-active-desktop-window",
    };
    emit(
      output,
      report,
      "Graphics diagnostics: native-gui-enabled; no frame was rendered by this CLI process.",
      args.flags.has("json"),
    );
    return 0;
  }
  if (!["run", "archive", "report"].includes(action))
    throw new CliError(`Unknown diagnostics action: ${action}.`);
  if (!path) throw new CliError("Archive diagnostics require --archive.");
  const snapshot = await openForCommand(path);
  let report: Record<string, unknown>;
  try {
    report = await buildArchiveDiagnosticReport(snapshot, {
      full: args.flags.has("full"),
      includeSystem: action !== "archive",
      ...(signal === undefined ? {} : { signal }),
    });
  } finally {
    await closeSnapshot(snapshot);
  }
  if (action === "report") {
    const destination = resolve(requiredOption(args, "output"));
    if (await sameFileIdentity(destination, path))
      throw new CliError("Diagnostic output cannot replace its source archive.");
    const contents = `${JSON.stringify(report, null, 2)}\n`;
    await writeTextAtomically(destination, contents);
    emit(
      output,
      {
        output: destination,
        status: "exported",
        bytes: new TextEncoder().encode(contents).byteLength,
      },
      `Diagnostic report exported to ${destination}.`,
      args.flags.has("json"),
    );
    return 0;
  }
  const valid = report["archive_valid"] === true;
  emit(
    output,
    report,
    `Archive diagnostics: ${valid}; generation ${String(report["archive_generation"])}; ${String(report["records_checked"])} record(s) checked.\n${JSON.stringify(report, null, 2)}`,
    args.flags.has("json"),
  );
  return valid ? 0 : 2;
}

export async function runBenchmarkCommand(
  action: string,
  path: string | undefined,
  args: ParsedArguments,
  output: CliIo,
  signal?: AbortSignal,
): Promise<number> {
  if (!(CLI_BENCHMARK_ACTIONS as readonly string[]).includes(action))
    throw new CliError(`Unknown benchmark: ${action}.`);
  const start = performance.now();
  const benchmark = action as CliBenchmarkAction;
  const report = createBenchmarkReport(benchmark);
  const needsArchive = benchmark === "indexing" || benchmark === "export" || benchmark === "full";
  if (needsArchive) {
    if (!path) throw new CliError(`benchmark ${action} requires --archive.`);
    const snapshot = await openForCommand(path);
    try {
      if (benchmark === "indexing" || benchmark === "full") {
        await measureArchiveIndex(report, snapshot, signal === undefined ? {} : { signal });
      }
      if (benchmark === "export") {
        const guide = await requireLiveRecord(
          snapshot,
          RecordType.guide,
          requiredOption(args, "guide"),
        );
        measureGuideExport(report, guide);
      }
    } finally {
      await closeSnapshot(snapshot);
    }
  }
  if (benchmark === "audio" || benchmark === "full")
    await measureAudioEnumeration(report, signal === undefined ? {} : { signal });
  if (benchmark === "rendering") measureRendering(report);
  report["command_elapsed_us"] = Math.round((performance.now() - start) * 1000);
  emit(output, report, JSON.stringify(report, null, 2), args.flags.has("json"));
  return 0;
}
