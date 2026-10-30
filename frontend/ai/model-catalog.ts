import { providerById } from "./providers";

const CATALOG_URL = "https://models.dev/api.json";
const MAXIMUM_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_MODELS = 50_000;
const MAXIMUM_CACHED_PROVIDERS = 2;
const REQUEST_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const CATALOG_PROVIDERS: Readonly<Record<string, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  "google-gemini": "google",
  cohere: "cohere",
  perplexity: "perplexity",
  xai: "xai",
  openrouter: "openrouter",
  together: "togetherai",
  fireworks: "fireworks",
  deepinfra: "deepinfra",
  novita: "novita",
  nebius: "nebius",
  groq: "groq",
  cerebras: "cerebras",
  sambanova: "sambanova",
  nvidia: "nvidia",
  deepseek: "deepseek",
  mistral: "mistral",
  huggingface: "huggingface",
  moonshot: "moonshotai",
  zai: "zai",
  minimax: "minimax",
  siliconflow: "siliconflow",
  "alibaba-cloud": "alibaba",
  baidu: "baidu",
  "tencent-cloud": "tencent",
  volcengine: "volcengine",
  bedrock: "amazon-bedrock",
  "azure-openai": "azure",
  "cloudflare-workers-ai": "cloudflare",
  ai21: "ai21",
  replicate: "replicate",
  "opencode-go": "opencode",
  "opencode-zen": "opencode",
};

export interface AiCatalogModel {
  id: string;
  owner: string;
  status: string;
  contextWindow: number | null;
  maximumOutputTokens: number | null;
  inputModalities: readonly string[];
  outputModalities: readonly string[];
  toolSupport: boolean | null;
  tokenizer: string | null;
  inputCost: number | null;
  outputCost: number | null;
  metadataSource: "models.dev";
}

interface CatalogCacheEntry {
  expiresAt: number;
  models: readonly AiCatalogModel[];
}

export interface AiModelCatalogResult {
  models: readonly AiCatalogModel[];
  freshness: "fresh" | "stale-cache-fallback";
}

const cache = new Map<string, CatalogCacheEntry>();

export function hasAiModelCatalog(providerId: string): boolean {
  const provider = providerById(providerId);
  return !!provider && CATALOG_PROVIDERS[provider.id] !== undefined;
}

/** Read public model metadata only; this request never contains archive or credential data. */
export async function loadAiModelCatalog(
  providerId: string,
  options: { signal?: AbortSignal; refresh?: boolean } = {},
): Promise<AiModelCatalogResult> {
  const provider = providerById(providerId);
  const catalogProviderId = CATALOG_PROVIDERS[provider?.id ?? ""];
  if (!provider || provider.local || !catalogProviderId) {
    throw new Error("This provider does not have a public models.dev catalog.");
  }

  const cached = cache.get(provider.id);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) {
    cache.delete(provider.id);
    cache.set(provider.id, cached);
    return { models: cached.models, freshness: "fresh" };
  }
  options.signal?.throwIfAborted();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const response = await fetch(CATALOG_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`The public model catalog returned HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json" && contentType !== "application/vnd.api+json") {
      throw new Error("The public model catalog returned an unexpected content type.");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const declaredBytes = Number(contentLength);
      if (
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes < 0 ||
        declaredBytes > MAXIMUM_RESPONSE_BYTES
      ) {
        throw new Error("The public model catalog exceeded the 32 MiB response limit.");
      }
    }
    const bytes = await readBoundedResponse(response, controller.signal);
    let decoded: string;
    try {
      decoded = decoder.decode(bytes);
    } catch {
      throw new Error("The public model catalog was not valid UTF-8.");
    }
    const models = parseCatalog(decoded, catalogProviderId);
    cache.delete(provider.id);
    cache.set(provider.id, { expiresAt: Date.now() + CACHE_TTL_MS, models });
    while (cache.size > MAXIMUM_CACHED_PROVIDERS) {
      const oldestProvider = cache.keys().next().value;
      if (oldestProvider === undefined) break;
      cache.delete(oldestProvider);
    }
    return { models, freshness: "fresh" };
  } catch (cause) {
    if (options.signal?.aborted)
      throw new DOMException("Catalog loading was cancelled.", "AbortError");
    if (cached) {
      cache.delete(provider.id);
      cache.set(provider.id, cached);
      return { models: cached.models, freshness: "stale-cache-fallback" };
    }
    if (controller.signal.aborted) {
      throw new Error("The public model catalog timed out. Try again when you are online.");
    }
    throw cause instanceof Error
      ? cause
      : new Error(
          "The public model catalog could not be loaded. Check your connection and try again.",
        );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) {
    throw new Error("This desktop webview cannot safely stream the public model catalog.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAXIMUM_RESPONSE_BYTES - totalBytes) {
        await reader.cancel();
        throw new Error("The public model catalog exceeded the 32 MiB response limit.");
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseCatalog(raw: string, providerId: string): readonly AiCatalogModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The public model catalog returned invalid JSON.");
  }
  if (!isObject(parsed)) throw new Error("The public model catalog had an invalid shape.");
  const provider = parsed[providerId];
  if (!isObject(provider) || !isObject(provider["models"])) {
    throw new Error("The public model catalog does not list this provider right now.");
  }
  const entries = Object.entries(provider["models"]);
  if (entries.length > MAXIMUM_MODELS) {
    throw new Error("The provider model catalog exceeded the 50,000 model safety limit.");
  }
  const owner = boundedText(provider["name"], 256) || providerId;
  const models: AiCatalogModel[] = [];
  const seen = new Set<string>();
  for (const [catalogKey, value] of entries) {
    if (!isObject(value)) continue;
    const modelId = boundedText(value["id"], 1024) || boundedText(catalogKey, 1024);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const limit = isObject(value["limit"]) ? value["limit"] : undefined;
    const modalities = isObject(value["modalities"]) ? value["modalities"] : undefined;
    const cost = isObject(value["cost"]) ? value["cost"] : undefined;
    models.push({
      id: modelId,
      owner,
      status: boundedText(value["status"], 64) || "unknown",
      contextWindow: boundedPositiveInteger(limit?.["context"], 10_000_000),
      maximumOutputTokens: boundedPositiveInteger(limit?.["output"], 1_000_000),
      inputModalities: boundedStringArray(modalities?.["input"]),
      outputModalities: boundedStringArray(modalities?.["output"]),
      toolSupport: nullableBoolean(value["tool_call"]),
      tokenizer: boundedText(value["tokenizer"], 128) || null,
      inputCost: boundedFiniteNumber(cost?.["input"]),
      outputCost: boundedFiniteNumber(cost?.["output"]),
      metadataSource: "models.dev",
    });
  }
  models.sort((left, right) => left.id.localeCompare(right.id));
  return models;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.includes("\0")) return "";
  const cleaned = value.trim();
  return cleaned && encoder.encode(cleaned).byteLength <= maximumBytes ? cleaned : "";
}

function boundedPositiveInteger(value: unknown, maximum: number): number | null {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : null;
}

function boundedFiniteNumber(value: unknown): number | null {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 1_000_000 ? number : null;
}

function boundedStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) return [];
  const result = new Set<string>();
  for (const item of value) {
    const text = boundedText(item, 48);
    if (text) result.add(text.toLowerCase());
  }
  return [...result];
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
