import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { deterministicUuid } from "../../frontend/ai/providers";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import {
  CliError,
  emit,
  field,
  parseBoundedOption,
  requiredOption,
  requiredPosition,
  timestampNow,
} from "./shared";
import { requireLiveRecord, toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runModelCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const snapshot = await openForCommand(path);
  const generation = snapshot.commit.generation;
  let changes: ArchiveRecord[] = [];
  let result: unknown;
  let message: string;
  let exitCode = 0;
  try {
    if (action === "list") {
      const references = (await snapshot.listRecords(RecordType.settings)).filter(
        (record) =>
          field(record, "record_role") === "model-reference" &&
          field(record, "_deleted") !== "true",
      );
      result = references.map(toPlainRecord);
      message =
        references
          .map(
            (record) =>
              `${record.id}  ${field(record, "provider")} / ${field(record, "model_id")}  ${field(record, "path")}${field(record, "active") === "true" ? "  selected" : ""}`,
          )
          .join("\n") || "No model references in this archive.";
    } else if (action === "select") {
      const provider = requiredOption(args, "provider").toLowerCase();
      const model = requiredOption(args, "model");
      const modelPath = args.options.get("path") ?? "";
      const localFile = ["whisper", "whisper.cpp", "local-whisper", "llama.cpp-embedded"].includes(
        provider,
      );
      if (localFile && !modelPath)
        throw new CliError("This provider requires --path to a selected model file.");
      if (localFile) {
        const checked = await inspectCliModel(resolve(dirname(resolve(path)), modelPath));
        if (!checked.available)
          throw new CliError("Selected model must be a regular non-symlink file.");
        if (provider === "llama.cpp-embedded" && checked.format !== "GGUF")
          throw new CliError("Select a GGUF file for the embedded model.");
      }
      const id = await deterministicUuid(`model-reference:${provider}:${model}`);
      const references = await snapshot.listRecords(RecordType.settings);
      changes = references
        .filter(
          (record) =>
            field(record, "record_role") === "model-reference" &&
            field(record, "provider") === provider &&
            field(record, "active") === "true" &&
            field(record, "_deleted") !== "true" &&
            record.id !== id,
        )
        .map((record) => ({
          ...record,
          fields: new Map(record.fields)
            .set("active", "false")
            .set("updated_at_us", timestampNow()),
        }));
      const fields = new Map([
        ["record_role", "model-reference"],
        ["provider", provider],
        ["model_id", model],
        ["path", modelPath],
        ["capabilities", args.options.get("capabilities") ?? "unknown"],
        ["active", "true"],
        ["updated_at_us", timestampNow()],
      ]);
      if (provider === "llama.cpp-embedded") {
        const context = parseBoundedOption(
          args.options.get("context-tokens"),
          "context-tokens",
          4096,
          32,
          1_048_576,
        );
        const threads = parseBoundedOption(args.options.get("threads"), "threads", 0, 0, 64);
        const maxThreads = parseBoundedOption(
          args.options.get("max-threads"),
          "max-threads",
          16,
          1,
          64,
        );
        const layers = parseBoundedOption(
          args.options.get("gpu-layers"),
          "gpu-layers",
          0,
          0,
          1_000_000,
        );
        if (threads > maxThreads) throw new CliError("--threads cannot exceed --max-threads.");
        fields.set("context_tokens", String(context));
        fields.set("cpu_threads", String(threads));
        fields.set("maximum_cpu_threads", String(maxThreads));
        fields.set("gpu_layers", String(layers));
      }
      const record: ArchiveRecord = {
        type: RecordType.settings,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields,
        blob: new Uint8Array(),
      };
      changes.push(record);
      result = toPlainRecord(record);
      message = `Model reference ${id} selected.`;
    } else if (action === "remove-reference") {
      const record = await requireLiveRecord(
        snapshot,
        RecordType.settings,
        requiredPosition(args, 0, "model reference ID"),
      );
      if (field(record, "record_role") !== "model-reference")
        throw new CliError("Model reference not found.");
      changes = [{ ...record, fields: new Map(record.fields).set("_deleted", "true") }];
      result = toPlainRecord(changes[0]!);
      message = "Model reference removed from this archive.";
    } else if (action === "inspect" || action === "verify") {
      const selected = args.options.get("path") ?? requiredPosition(args, 0, "model path");
      const report = await inspectCliModel(resolve(dirname(resolve(path)), selected));
      result = report;
      if (!report.available) {
        if (action === "inspect")
          throw new CliError(
            "Selected model path is missing or is not a regular non-symlink file.",
          );
        exitCode = 2;
      }
      message = report.available
        ? `Model file: ${report.path} (${report.size_bytes} bytes; ${report.metadata}).`
        : "Selected model file is missing or not a regular non-symlink file.";
    } else throw new CliError(`Unknown model action: ${action}.`);
  } finally {
    await closeSnapshot(snapshot);
  }
  if (changes.length) await mutateArchive(path, changes, generation);
  emit(output, result, message, args.flags.has("json"));
  return exitCode;
}

export async function inspectCliModel(path: string): Promise<{
  path: string;
  available: boolean;
  size_bytes?: number;
  format?: string;
  metadata?: string;
  gguf_version?: number;
  tensor_count?: string;
  metadata_count?: string;
}> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return { path, available: false };
    const report: {
      path: string;
      available: boolean;
      size_bytes: number;
      format: string;
      metadata: string;
      gguf_version?: number;
      tensor_count?: string;
      metadata_count?: string;
    } = {
      path,
      available: true,
      size_bytes: info.size,
      format: path.toLowerCase().endsWith(".gguf") ? "GGUF" : "unknown",
      metadata: "not-inspected",
    };
    if (report.format === "GGUF") {
      const file = await open(path, "r");
      try {
        const header = Buffer.alloc(24);
        const read = await file.read(header, 0, 24, 0);
        if (read.bytesRead < 24 || header.toString("ascii", 0, 4) !== "GGUF")
          throw new CliError("The GGUF header is invalid.");
        const version = header.readUInt32LE(4);
        if (version !== 2 && version !== 3) throw new CliError("Unsupported GGUF version.");
        report.gguf_version = version;
        report.tensor_count = header.readBigUInt64LE(8).toString();
        report.metadata_count = header.readBigUInt64LE(16).toString();
        report.metadata = "header-inspected";
      } finally {
        await file.close();
      }
    }
    return report;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, available: false };
    throw error;
  }
}
