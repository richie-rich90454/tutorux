import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type {
  GgufFileInfo,
  Llama,
  LlamaChatSession,
  LlamaContext,
  LlamaContextSequence,
  LlamaModel,
} from "node-llama-cpp";
import type * as NodeLlamaCpp from "node-llama-cpp";
import type { ArchiveRecord } from "../frontend/archive/format";
import type { AiTransportRequest, AiTransportResult } from "../frontend/platform/types";

const EMBEDDED_PROVIDER_IDS = new Set(["embedded-gguf", "llama.cpp-embedded"]);
const EMBEDDED_ENDPOINT = "tutorux://embedded/generate";
const MIN_MODEL_BYTES = 24;
const MAX_MODEL_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_CONTEXT_TOKENS = 32_768;
const MIN_CONTEXT_TOKENS = 32;
const MAX_CPU_THREADS = 64;
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const ESTIMATED_CONTEXT_BYTES_PER_TOKEN = 1024 * 1024;
const MEMORY_OVERHEAD_BYTES = 256 * 1024 * 1024;
const MAX_ESTIMATED_MEMORY_BYTES = 64 * 1024 * 1024 * 1024;

const encoder = new TextEncoder();

export interface CliEmbeddedModelSelection {
  /** Canonical, regular, local GGUF file path. */
  path: string;
  /** Must match the model ID in the reviewed OpenAI-compatible request body. */
  modelId: string;
  contextTokens: number;
  cpuThreads: number;
  gpuLayers: number;
  /** Captured when the archive model reference is resolved and checked again before loading. */
  identity: CliEmbeddedFileIdentity;
  architecture: string;
  tensorCount: number;
}

export interface CliEmbeddedFileIdentity {
  size: number;
  modifiedAt: number;
  createdAt: number;
  device: number;
  inode: number;
}

/**
 * Resolve the active archive model reference for the chosen offline provider and verify its
 * GGUF header before any inference runtime is initialized.
 */
export async function resolveCliEmbeddedModelReference(
  records: readonly ArchiveRecord[],
  archivePath: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<CliEmbeddedModelSelection> {
  validateModelId(modelId);
  const references = records.filter(
    (record) =>
      record.fields.get("record_role") === "model-reference" &&
      record.fields.get("_deleted") !== "true" &&
      record.fields.get("active") === "true" &&
      isCliEmbeddedProvider(record.fields.get("provider") ?? "") &&
      record.fields.get("model_id") === modelId,
  );
  if (references.length === 0) {
    throw new Error(
      `No active GGUF model reference matches “${modelId}”. Select it with “tutorux model select --provider llama.cpp-embedded” first.`,
    );
  }
  if (references.length !== 1) {
    throw new Error("More than one active GGUF model reference matches this provider model.");
  }

  const reference = references[0]!;
  const storedPath = reference.fields.get("path") ?? "";
  if (!storedPath || encoder.encode(storedPath).byteLength > 4096 || storedPath.includes("\0")) {
    throw new Error("The selected GGUF model reference does not contain a valid local file path.");
  }
  const absolutePath = isAbsolute(storedPath)
    ? resolve(storedPath)
    : resolve(dirname(resolve(archivePath)), storedPath);
  const path = await validateLocalGgufPath(absolutePath);
  const identity = await readIdentity(path);
  const model = await inspectGguf(path, signal);
  assertSameIdentity(identity, await readIdentity(path));

  const contextTokens = readBoundedInteger(
    reference.fields.get("context_tokens"),
    4096,
    MIN_CONTEXT_TOKENS,
    MAX_CONTEXT_TOKENS,
    "context-token limit",
  );
  const cpuThreads = readBoundedInteger(
    reference.fields.get("cpu_threads"),
    0,
    0,
    MAX_CPU_THREADS,
    "CPU thread limit",
  );
  const gpuLayers = readBoundedInteger(
    reference.fields.get("gpu_layers"),
    0,
    0,
    model.layerCount + 1,
    "GPU layer limit",
  );
  estimateMemory(identity.size, contextTokens);

  return {
    path,
    modelId,
    contextTokens,
    cpuThreads,
    gpuLayers,
    identity,
    architecture: model.architecture,
    tensorCount: model.tensorCount,
  };
}

/**
 * Run a reviewed, credential-free GGUF request in-process and adapt generated tokens to the
 * OpenAI-compatible SSE format consumed by the shared AI response parser. This function never
 * fetches a URL, downloads a model, or builds a native runtime from source.
 */
export async function sendCliEmbeddedAiRequest(
  request: AiTransportRequest,
  selection: CliEmbeddedModelSelection,
  onChunk: (chunk: Uint8Array) => void,
  signal?: AbortSignal,
): Promise<AiTransportResult> {
  const prompt = parseReviewedPrompt(request, selection);
  if (signal?.aborted) {
    return { status: 200, contentType: "text/event-stream", responseBytes: 0, complete: false };
  }
  const path = await validateLocalGgufPath(selection.path);
  if (path !== selection.path) {
    throw new Error(
      "The selected GGUF model path changed after it was inspected. Select it again.",
    );
  }
  validateContextAndThreads(selection.contextTokens, selection.cpuThreads, selection.gpuLayers);
  validateModelId(selection.modelId);
  const identity = await readIdentity(path);
  assertSameIdentity(selection.identity, identity);
  const modelInfo = await inspectGguf(path, signal);
  if (
    modelInfo.architecture !== selection.architecture ||
    modelInfo.tensorCount !== selection.tensorCount ||
    selection.gpuLayers > modelInfo.layerCount + 1
  ) {
    throw new Error("The selected GGUF model metadata changed after inspection. Select it again.");
  }
  estimateMemory(identity.size, selection.contextTokens);

  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error("Local generation cancelled."));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  let responseBytes = 0;
  let outputExceededLimit = false;
  let emittedText = false;
  const pushText = (text: string) => {
    if (!text || outputExceededLimit) return;
    const event = encoder.encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    );
    if (responseBytes + event.byteLength > MAX_RESPONSE_BYTES) {
      outputExceededLimit = true;
      controller.abort(new Error("Local model response exceeded the 16 MiB safety limit."));
      return;
    }
    responseBytes += event.byteLength;
    emittedText = true;
    onChunk(event);
  };

  let llama: Llama | undefined;
  let model: LlamaModel | undefined;
  let context: LlamaContext | undefined;
  let sequence: LlamaContextSequence | undefined;
  let session: LlamaChatSession | undefined;
  try {
    if (controller.signal.aborted) {
      return { status: 200, contentType: "text/event-stream", responseBytes, complete: false };
    }

    let runtime: typeof NodeLlamaCpp;
    try {
      runtime = await import("node-llama-cpp");
    } catch {
      throw new Error("The offline llama.cpp runtime is not installed for this Node.js platform.");
    }

    try {
      const gpu = selection.gpuLayers > 0 ? "auto" : false;
      llama = await runtime.getLlama({
        gpu,
        build: "never",
        skipDownload: true,
        progressLogs: false,
        logLevel: runtime.LlamaLogLevel.error,
        maxThreads: effectiveCpuThreads(selection.cpuThreads),
      });
    } catch (cause) {
      if (cause instanceof runtime.NoBinaryFoundError) {
        throw new Error(
          "No compatible local llama.cpp binary is installed. The CLI will not download or build one automatically.",
          { cause },
        );
      }
      throw new Error("The offline llama.cpp runtime could not initialize on this device.", {
        cause,
      });
    }

    assertSameIdentity(selection.identity, await readIdentity(selection.path));
    try {
      model = await llama.loadModel({
        modelPath: selection.path,
        gpuLayers: selection.gpuLayers,
        loadSignal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        return { status: 200, contentType: "text/event-stream", responseBytes, complete: false };
      }
      throw new Error(
        "The selected GGUF model could not be loaded within the configured device and memory limits.",
      );
    }
    assertSameIdentity(selection.identity, await readIdentity(selection.path));
    context = await model.createContext({
      contextSize: selection.contextTokens,
      threads: effectiveCpuThreads(selection.cpuThreads),
      sequences: 1,
      batchSize: Math.min(512, selection.contextTokens),
    });
    const chatWrapper = runtime.resolveChatWrapper(model);
    const history = chatWrapper.generateInitialChatHistory({
      systemPrompt: prompt.systemPrompt,
    });
    history.push({ type: "user", text: prompt.userContent });
    const contextState = chatWrapper.generateContextState({ chatHistory: history });
    const promptTokens = contextState.contextText.tokenize(model.tokenizer).length;
    const availableOutputTokens = selection.contextTokens - promptTokens;
    if (promptTokens === 0 || availableOutputTokens < 1) {
      throw new Error("The reviewed AI package does not fit in the selected GGUF context window.");
    }
    const maximumOutputTokens = Math.min(prompt.maximumOutputTokens, availableOutputTokens);
    if (maximumOutputTokens < 1) {
      throw new Error("No GGUF context remains for the generated guide.");
    }
    sequence = context.getSequence();
    session = new runtime.LlamaChatSession({
      contextSequence: sequence,
      chatWrapper,
      systemPrompt: prompt.systemPrompt,
      forceAddSystemPrompt: true,
      autoDisposeSequence: false,
      contextShift: { size: maximumOutputTokens },
    });
    await session.prompt(prompt.userContent, {
      maxTokens: maximumOutputTokens,
      signal: controller.signal,
      stopOnAbortSignal: true,
      onTextChunk: pushText,
    });

    if (outputExceededLimit || controller.signal.aborted) {
      return { status: 200, contentType: "text/event-stream", responseBytes, complete: false };
    }
    if (!emittedText) throw new Error("The local model returned no generated text.");
    const done = encoder.encode("data: [DONE]\n\n");
    if (responseBytes + done.byteLength > MAX_RESPONSE_BYTES) {
      return { status: 200, contentType: "text/event-stream", responseBytes, complete: false };
    }
    responseBytes += done.byteLength;
    onChunk(done);
    return { status: 200, contentType: "text/event-stream", responseBytes, complete: true };
  } catch (cause) {
    if (controller.signal.aborted || responseBytes > 0 || outputExceededLimit) {
      return { status: 200, contentType: "text/event-stream", responseBytes, complete: false };
    }
    if (cause instanceof Error) throw cause;
    throw new Error("The local GGUF model could not complete inference.", { cause });
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      session?.dispose();
    } finally {
      try {
        if (sequence && !sequence.disposed) await sequence.dispose();
      } finally {
        try {
          if (context && !context.disposed) await context.dispose();
        } finally {
          try {
            if (model && !model.disposed) await model.dispose();
          } finally {
            if (llama) await llama.dispose();
          }
        }
      }
    }
  }
}

function parseReviewedPrompt(
  request: AiTransportRequest,
  selection: CliEmbeddedModelSelection,
): { systemPrompt: string; userContent: string; maximumOutputTokens: number } {
  if (!isCliEmbeddedProvider(request.providerId)) {
    throw new Error("The local GGUF transport only accepts embedded provider IDs.");
  }
  if (
    request.endpoint !== EMBEDDED_ENDPOINT ||
    request.confirmedEndpoint !== EMBEDDED_ENDPOINT ||
    request.credential ||
    request.credentialStorage !== "none"
  ) {
    throw new Error("Local GGUF inference requires the exact credential-free in-process endpoint.");
  }
  if (
    request.requestBodyHash !== request.confirmedBodyHash ||
    sha256(request.requestBody) !== request.requestBodyHash
  ) {
    throw new Error("Confirm the exact reviewed request body before local generation.");
  }
  if (encoder.encode(request.requestBody).byteLength > 16 * 1024 * 1024) {
    throw new Error("The reviewed local inference request exceeds the 16 MiB safety limit.");
  }
  if (request.accept !== "text/event-stream") {
    throw new Error("The local GGUF request must use the reviewed event-stream response format.");
  }

  let value: unknown;
  try {
    value = JSON.parse(request.requestBody);
  } catch {
    throw new Error("The reviewed local AI request is not valid JSON.");
  }
  if (!isObject(value) || value["stream"] !== true || !Array.isArray(value["messages"])) {
    throw new Error("The reviewed local AI request has an unsupported message format.");
  }
  const model = value["model"];
  const systemMessages = value["messages"].filter(
    (message) => isObject(message) && message["role"] === "system",
  );
  const userMessages = value["messages"].filter(
    (message) => isObject(message) && message["role"] === "user",
  );
  if (
    model !== selection.modelId ||
    model !== request.model ||
    systemMessages.length !== 1 ||
    userMessages.length !== 1 ||
    value["messages"].length !== 2
  ) {
    throw new Error("The reviewed request does not match the active archive GGUF model reference.");
  }
  const systemMessage = systemMessages[0]!;
  const userMessage = userMessages[0]!;
  if (
    !isObject(systemMessage) ||
    !isObject(userMessage) ||
    typeof systemMessage["content"] !== "string" ||
    typeof userMessage["content"] !== "string"
  ) {
    throw new Error("Local GGUF inference requires text-only system and user messages.");
  }
  const systemPrompt = systemMessage["content"];
  const userContent = userMessage["content"];
  if (
    encoder.encode(systemPrompt).byteLength + encoder.encode(userContent).byteLength >
    MAX_PROMPT_BYTES
  ) {
    throw new Error("The reviewed local prompt exceeds the 4 MiB safety limit.");
  }
  const maximumOutputTokens = value["max_tokens"];
  if (
    typeof maximumOutputTokens !== "number" ||
    !Number.isSafeInteger(maximumOutputTokens) ||
    maximumOutputTokens < 1 ||
    maximumOutputTokens > MAX_OUTPUT_TOKENS
  ) {
    throw new Error(`Local GGUF generation supports 1 to ${MAX_OUTPUT_TOKENS} output tokens.`);
  }
  validateContextAndThreads(selection.contextTokens, selection.cpuThreads, selection.gpuLayers);
  return { systemPrompt, userContent, maximumOutputTokens };
}

async function validateLocalGgufPath(path: string): Promise<string> {
  if (!path || path.includes("\0") || encoder.encode(path).byteLength > 4096) {
    throw new Error("The selected GGUF model path is invalid.");
  }
  if (path.startsWith("\\\\") || path.startsWith("//")) {
    throw new Error("Network-share GGUF paths are not allowed for offline inference.");
  }
  if (!/\.gguf$/iu.test(basename(path))) {
    throw new Error("The selected local model file must use the .gguf extension.");
  }
  let canonical: string;
  try {
    canonical = await realpath(path);
    const selectedStats = await lstat(path);
    const canonicalStats = await lstat(canonical);
    if (
      !selectedStats.isFile() ||
      selectedStats.isSymbolicLink() ||
      !canonicalStats.isFile() ||
      canonicalStats.isSymbolicLink()
    ) {
      throw new Error("The model path is not a regular file.");
    }
    const identity = identityFromStats(canonicalStats);
    if (identity.size < MIN_MODEL_BYTES || identity.size > MAX_MODEL_BYTES) {
      throw new Error("GGUF file size must be between 24 bytes and 64 GiB.");
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("The model path")) throw cause;
    if (cause instanceof Error && cause.message.startsWith("GGUF file size")) throw cause;
    throw new Error("The selected GGUF model path is missing or is not a regular local file.", {
      cause,
    });
  }
  return canonical;
}

async function inspectGguf(
  path: string,
  signal?: AbortSignal,
): Promise<{ architecture: string; tensorCount: number; layerCount: number }> {
  if (signal?.aborted) throw signal.reason ?? new Error("GGUF inspection was cancelled.");
  let runtime: typeof NodeLlamaCpp;
  try {
    runtime = await import("node-llama-cpp");
  } catch {
    throw new Error("Install the node-llama-cpp offline runtime to inspect GGUF models.");
  }
  let info: GgufFileInfo;
  try {
    info = await runtime.readGgufFileInfo(path, {
      sourceType: "filesystem",
      readTensorInfo: false,
      spliceSplitFiles: false,
      ignoreKeys: ["tokenizer.ggml.tokens"],
      logWarnings: false,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    if (signal?.aborted) throw signal.reason ?? new Error("GGUF inspection was cancelled.");
    throw new Error("The selected file does not contain a valid readable GGUF model header.");
  }
  const general = info.metadata["general"] as Record<string, unknown> | undefined;
  const architectureValue = general?.["architecture"];
  const tensorCount = Number(info.tensorCount);
  const layerCountValue: unknown = info.architectureMetadata["block_count"];
  const layerCount =
    typeof layerCountValue === "bigint" ? Number(layerCountValue) : layerCountValue;
  if (
    info.version < 2 ||
    typeof architectureValue !== "string" ||
    architectureValue.trim().length === 0 ||
    architectureValue.length > 256 ||
    !Number.isSafeInteger(tensorCount) ||
    tensorCount < 1 ||
    typeof layerCount !== "number" ||
    !Number.isSafeInteger(layerCount) ||
    layerCount < 1 ||
    layerCount > 4096
  ) {
    throw new Error("The selected file does not contain a supported GGUF language model.");
  }
  return { architecture: architectureValue, tensorCount, layerCount };
}

async function readIdentity(path: string): Promise<CliEmbeddedFileIdentity> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("The selected GGUF model changed into a non-regular file.");
    }
    return identityFromStats(stats);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("The selected GGUF model changed")) {
      throw cause;
    }
    throw new Error("The selected GGUF model is no longer available at its validated path.", {
      cause,
    });
  }
}

function identityFromStats(stats: Awaited<ReturnType<typeof lstat>>): CliEmbeddedFileIdentity {
  return {
    size: Number(stats.size),
    modifiedAt: Number(stats.mtimeMs),
    createdAt: Number(stats.ctimeMs),
    device: Number(stats.dev),
    inode: Number(stats.ino),
  };
}

function assertSameIdentity(
  expected: CliEmbeddedFileIdentity,
  current: CliEmbeddedFileIdentity,
): void {
  if (
    expected.size !== current.size ||
    expected.modifiedAt !== current.modifiedAt ||
    expected.createdAt !== current.createdAt ||
    expected.device !== current.device ||
    expected.inode !== current.inode
  ) {
    throw new Error("The selected GGUF model changed after it was inspected. Select it again.");
  }
}

function estimateMemory(modelBytes: number, contextTokens: number): number {
  const estimate =
    modelBytes + contextTokens * ESTIMATED_CONTEXT_BYTES_PER_TOKEN + MEMORY_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(estimate) || estimate > MAX_ESTIMATED_MEMORY_BYTES) {
    throw new Error(
      "The selected GGUF context and model exceed the 64 GiB estimated memory limit.",
    );
  }
  return estimate;
}

function validateContextAndThreads(
  contextTokens: number,
  cpuThreads: number,
  gpuLayers: number,
): void {
  if (
    !Number.isSafeInteger(contextTokens) ||
    contextTokens < MIN_CONTEXT_TOKENS ||
    contextTokens > MAX_CONTEXT_TOKENS
  ) {
    throw new Error(
      `Local GGUF context must be between ${MIN_CONTEXT_TOKENS} and ${MAX_CONTEXT_TOKENS} tokens.`,
    );
  }
  if (!Number.isSafeInteger(cpuThreads) || cpuThreads < 0 || cpuThreads > MAX_CPU_THREADS) {
    throw new Error(`Local GGUF CPU threads must be between 0 and ${MAX_CPU_THREADS}.`);
  }
  if (!Number.isSafeInteger(gpuLayers) || gpuLayers < 0 || gpuLayers > 4097) {
    throw new Error("The selected GGUF GPU layer count is invalid.");
  }
}

function readBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) throw new Error(`The selected GGUF ${label} is invalid.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`The selected GGUF ${label} is outside its supported range.`);
  }
  return value;
}

function effectiveCpuThreads(configured: number): number {
  if (configured > 0) return configured;
  return Math.min(MAX_CPU_THREADS, Math.max(1, availableParallelism()));
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateModelId(value: string): void {
  if (!value.trim() || encoder.encode(value).byteLength > 1024 || hasControlCharacter(value)) {
    throw new Error("Choose a valid local GGUF model ID.");
  }
}

export function isCliEmbeddedProvider(value: string): boolean {
  return EMBEDDED_PROVIDER_IDS.has(value.trim().toLowerCase());
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
