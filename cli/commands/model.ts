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
        ? report.format === "GGUF" && report.architecture
          ? `GGUF model: ${report.path} (${report.name || "unnamed"}, ${report.architecture}, ${report.layer_count} layers, ${report.size_bytes} bytes; estimated memory ${report.estimated_memory_bytes_upper_bound ?? "unknown"} bytes).`
          : `Model file: ${report.path} (${report.size_bytes} bytes; ${report.metadata}).`
        : "Selected model file is missing or not a regular non-symlink file.";
    } else throw new CliError(`Unknown model action: ${action}.`);
  } finally {
    await closeSnapshot(snapshot);
  }
  if (changes.length) await mutateArchive(path, changes, generation);
  emit(output, result, message, args.flags.has("json"));
  return exitCode;
}

export interface GgufModelInfo {
  gguf_version: number;
  tensor_count: string;
  metadata_count: string;
  architecture: string;
  name: string;
  description: string;
  training_context_tokens: string;
  embedding_length: string;
  layer_count: string;
}

export interface CliModelReport {
  path: string;
  available: boolean;
  size_bytes?: number;
  format?: string;
  metadata?: string;
  gguf_version?: number;
  tensor_count?: string;
  metadata_count?: string;
  architecture?: string;
  name?: string;
  description?: string;
  training_context_tokens?: string;
  embedding_length?: string;
  layer_count?: string;
  estimated_memory_bytes_upper_bound?: string;
  memory_estimate_overflowed?: string;
}

const GGUF_MAX_STRING_BYTES = 16 * 1024 * 1024;
const GGUF_MAX_METADATA_ENTRIES = 1_000_000;

export async function inspectCliModel(path: string): Promise<CliModelReport> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return { path, available: false };
    const report: CliModelReport = {
      path,
      available: true,
      size_bytes: info.size,
      format: path.toLowerCase().endsWith(".gguf") ? "GGUF" : "unknown",
      metadata: "not-inspected",
    };
    if (report.format === "GGUF") {
      const gguf = await inspectGgufFile(path, info.size);
      Object.assign(report, gguf);
      report.metadata = "inspected";
      if (gguf.architecture && gguf.embedding_length && gguf.layer_count) {
        const estimate = estimateGgufMemory(report);
        report.estimated_memory_bytes_upper_bound = estimate.totalBytesUpperBound;
        report.memory_estimate_overflowed = estimate.overflowed ? "true" : "false";
      }
    }
    return report;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, available: false };
    throw error;
  }
}

async function inspectGgufFile(path: string, fileSize: number): Promise<GgufModelInfo> {
  if (fileSize < 24) throw new CliError("The GGUF header is truncated.");
  const file = await open(path, "r");
  try {
    const reader = new GgufReader(file, fileSize);
    const header = await reader.bytes(24);
    if (header.toString("ascii", 0, 4) !== "GGUF")
      throw new CliError("The GGUF header is invalid.");
    const version = header.readUInt32LE(4);
    if (version !== 2 && version !== 3) throw new CliError("Unsupported GGUF version.");
    const tensorCount = header.readBigUInt64LE(8);
    const metadataCount = header.readBigUInt64LE(16);
    if (metadataCount > BigInt(GGUF_MAX_METADATA_ENTRIES))
      throw new CliError("The GGUF metadata index is too large.");

    const strings = new Map<string, string>();
    const integers = new Map<string, bigint>();
    for (let index = 0n; index < metadataCount; index += 1n) {
      const keyLength = await reader.uint64();
      if (keyLength > BigInt(GGUF_MAX_STRING_BYTES))
        throw new CliError("A GGUF metadata key is too large.");
      const key = (await reader.bytes(Number(keyLength))).toString("utf8");
      const valueType = await reader.uint32();
      if (valueType === 8) {
        const valueLength = await reader.uint64();
        if (valueLength > BigInt(GGUF_MAX_STRING_BYTES))
          throw new CliError("A GGUF metadata string is too large.");
        if (key === "general.architecture" || key === "general.name" || key === "general.description") {
          strings.set(key, (await reader.bytes(Number(valueLength))).toString("utf8"));
        } else {
          await reader.skip(Number(valueLength));
        }
      } else if (valueType === 9) {
        const elementType = await reader.uint32();
        const count = await reader.uint64();
        await reader.skipArray(elementType, count);
      } else {
        const value = await reader.scalar(valueType);
        if (
          value !== null &&
          (key.endsWith(".context_length") ||
            key.endsWith(".embedding_length") ||
            key.endsWith(".block_count"))
        ) {
          integers.set(key, value);
        }
      }
    }

    const architecture = strings.get("general.architecture") ?? "";
    const context = architecture ? integers.get(`${architecture}.context_length`) : undefined;
    const embedding = architecture ? integers.get(`${architecture}.embedding_length`) : undefined;
    const layers = architecture ? integers.get(`${architecture}.block_count`) : undefined;
    return {
      gguf_version: version,
      tensor_count: tensorCount.toString(),
      metadata_count: metadataCount.toString(),
      architecture,
      name: strings.get("general.name") ?? "",
      description: strings.get("general.description") ?? "",
      training_context_tokens: unsignedText(context),
      embedding_length: unsignedText(embedding),
      layer_count: unsignedText(layers),
    };
  } finally {
    await file.close();
  }
}

class GgufReader {
  private position = 0;
  private buffer = Buffer.alloc(0);
  private bufferStart = 0;
  private readonly chunk = 1024 * 1024;

  constructor(
    private readonly file: Awaited<ReturnType<typeof open>>,
    private readonly fileSize: number,
  ) {}

  async bytes(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0)
      throw new CliError("The GGUF metadata length is invalid.");
    if (length === 0) return Buffer.alloc(0);
    if (this.position + length > this.fileSize)
      throw new CliError("The GGUF metadata is truncated.");
    if (
      this.position < this.bufferStart ||
      this.position + length > this.bufferStart + this.buffer.length
    ) {
      const readLength = Math.min(Math.max(length, this.chunk), this.fileSize - this.position);
      const buffer = Buffer.alloc(readLength);
      const read = await this.file.read(buffer, 0, readLength, this.position);
      if (read.bytesRead < length) throw new CliError("The GGUF metadata is truncated.");
      this.buffer = buffer.subarray(0, read.bytesRead);
      this.bufferStart = this.position;
    }
    const start = this.position - this.bufferStart;
    const value = this.buffer.subarray(start, start + length);
    this.position += length;
    return value;
  }

  async skip(length: number): Promise<void> {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.fileSize)
      throw new CliError("The GGUF metadata is truncated.");
    this.position += length;
  }

  async uint32(): Promise<number> {
    return (await this.bytes(4)).readUInt32LE(0);
  }

  async uint64(): Promise<bigint> {
    return (await this.bytes(8)).readBigUInt64LE(0);
  }

  async scalar(type: number): Promise<bigint | null> {
    const value = await this.bytes(scalarSize(type));
    switch (type) {
      case 0:
        return BigInt(value.readUInt8(0));
      case 1:
        return BigInt(value.readInt8(0));
      case 2:
        return BigInt(value.readUInt16LE(0));
      case 3:
        return BigInt(value.readInt16LE(0));
      case 4:
        return BigInt(value.readUInt32LE(0));
      case 5:
        return BigInt(value.readInt32LE(0));
      case 7:
        return value.readUInt8(0) ? 1n : 0n;
      case 10:
        return value.readBigUInt64LE(0);
      case 11:
        return value.readBigInt64LE(0);
      case 6:
      case 12:
        return null;
      default:
        throw new CliError("The GGUF metadata contains an unsupported value type.");
    }
  }

  async skipArray(elementType: number, count: bigint): Promise<void> {
    if (count > BigInt(GGUF_MAX_METADATA_ENTRIES))
      throw new CliError("The GGUF metadata array is too large.");
    if (elementType === 8) {
      for (let index = 0n; index < count; index += 1n) {
        const length = await this.uint64();
        if (length > BigInt(GGUF_MAX_STRING_BYTES))
          throw new CliError("A GGUF metadata string is too large.");
        await this.skip(Number(length));
      }
      return;
    }
    if (elementType === 9)
      throw new CliError("The GGUF metadata contains a nested array.");
    const total = BigInt(scalarSize(elementType)) * count;
    if (total > BigInt(this.fileSize))
      throw new CliError("The GGUF metadata array is too large.");
    await this.skip(Number(total));
  }
}

function scalarSize(type: number): number {
  switch (type) {
    case 0:
    case 1:
    case 7:
      return 1;
    case 2:
    case 3:
      return 2;
    case 4:
    case 5:
    case 6:
      return 4;
    case 10:
    case 11:
    case 12:
      return 8;
    default:
      throw new CliError("The GGUF metadata contains an unsupported value type.");
  }
}

function unsignedText(value: bigint | undefined): string {
  return value !== undefined && value >= 0n ? value.toString() : "";
}

export function estimateGgufMemory(
  report: CliModelReport,
  contextTokens = 4096,
): { totalBytesUpperBound: string; overflowed: boolean } {
  const size = BigInt(report.size_bytes ?? 0);
  const embedding = BigInt(report.embedding_length || 0);
  const layers = BigInt(report.layer_count || 0);
  if (size === 0n || embedding === 0n || layers === 0n)
    throw new CliError(
      "Memory estimation requires a GGUF inspection with dimensions and file size.",
    );
  const maximum = (1n << 64n) - 1n;
  const overhead = 256n * 1024n * 1024n;
  const contextBytes = BigInt(contextTokens) * embedding * layers * 4n;
  const total = size + contextBytes + overhead;
  if (total > maximum) return { totalBytesUpperBound: maximum.toString(), overflowed: true };
  return { totalBytesUpperBound: total.toString(), overflowed: false };
}
