import { AI_GENERATION_SYSTEM_PROMPT_BYTES } from "../frontend/ai/prompt";
import { providerById, validateProviderEndpoint } from "../frontend/ai/providers";

const OLLAMA_METADATA_TIMEOUT_MS = 30_000;
const OLLAMA_METADATA_MAX_BYTES = 4 * 1024 * 1024;
const OLLAMA_MAX_MODEL_ID_BYTES = 1024;
const OLLAMA_CHAT_MESSAGE_OVERHEAD_BYTES = 16;
const OLLAMA_MAX_MODEL_INFO_FIELDS = 200_000;

export type OllamaContextFit = "yes" | "no" | "unknown";

/** Estimate prompt tokens conservatively by counting UTF-8 bytes, matching the legacy CLI. */
export function estimateOllamaInputTokenUpperBound(packageBytes: number): number {
  if (!Number.isSafeInteger(packageBytes) || packageBytes < 1) {
    throw new Error("The AI package must contain a positive, safe byte length.");
  }
  const estimate =
    packageBytes + AI_GENERATION_SYSTEM_PROMPT_BYTES + OLLAMA_CHAT_MESSAGE_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(estimate)) {
    throw new Error("The AI package is too large to estimate safely.");
  }
  return estimate;
}

/** Return unknown when Ollama does not report a usable context length. */
export function estimateOllamaContextFit(
  inputTokenUpperBound: number,
  requestedOutputTokens: number,
  contextLength: number | null,
): OllamaContextFit {
  if (
    !Number.isSafeInteger(inputTokenUpperBound) ||
    inputTokenUpperBound < 0 ||
    !Number.isSafeInteger(requestedOutputTokens) ||
    requestedOutputTokens < 1 ||
    (contextLength !== null && (!Number.isSafeInteger(contextLength) || contextLength < 0))
  ) {
    throw new Error("The Ollama context estimate contains an invalid token count.");
  }
  if (contextLength === null || contextLength === 0) return "unknown";
  return inputTokenUpperBound < contextLength &&
    requestedOutputTokens <= contextLength - inputTokenUpperBound
    ? "yes"
    : "no";
}

/** Parse Ollama's `/api/show` response, taking the largest reported context length. */
export function parseOllamaShowContextLength(value: unknown): number | null {
  if (!isObject(value)) throw new Error("Ollama returned invalid model metadata.");
  const modelInfo = value["model_info"];
  if (!isObject(modelInfo)) return null;
  const entries = Object.entries(modelInfo);
  if (entries.length > OLLAMA_MAX_MODEL_INFO_FIELDS) {
    throw new Error("Ollama returned invalid model metadata.");
  }

  let contextLength = 0;
  for (const [name, rawValue] of entries) {
    if (
      name.endsWith(".context_length") &&
      typeof rawValue === "number" &&
      Number.isSafeInteger(rawValue) &&
      rawValue > contextLength
    ) {
      contextLength = rawValue;
    }
  }
  return contextLength > 0 ? contextLength : null;
}

/** Inspect local Ollama metadata without transmitting a package, prompt, or generation request. */
export async function inspectOllamaContextLength(
  endpoint: string,
  modelId: string,
): Promise<number | null> {
  const provider = providerById("ollama");
  if (!provider) throw new Error("Ollama provider configuration is unavailable.");
  const normalizedEndpoint = validateProviderEndpoint(endpoint, provider);
  validateOllamaModelId(modelId);
  const rootEndpoint = normalizedEndpoint.endsWith("/v1")
    ? normalizedEndpoint.slice(0, -3)
    : normalizedEndpoint;
  const response = await fetch(`${rootEndpoint}/api/show`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: modelId, verbose: false }),
    redirect: "error",
    signal: AbortSignal.timeout(OLLAMA_METADATA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Ollama model inspection returned HTTP ${response.status}.`);
  }
  const body = await readBoundedResponse(response);
  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new Error("Ollama returned invalid model metadata.");
  }
  return parseOllamaShowContextLength(metadata);
}

function validateOllamaModelId(modelId: string): void {
  if (
    !modelId ||
    new TextEncoder().encode(modelId).byteLength > OLLAMA_MAX_MODEL_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(modelId)
  ) {
    throw new Error("A valid Ollama model name is required.");
  }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > OLLAMA_METADATA_MAX_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Ollama model metadata exceeded 4 MiB.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Ollama returned invalid model metadata.");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > OLLAMA_METADATA_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Ollama model metadata exceeded 4 MiB.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
