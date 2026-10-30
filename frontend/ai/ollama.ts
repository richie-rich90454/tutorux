import { providerById, validateProviderEndpoint } from "./providers";

const MAXIMUM_TAGS_BYTES = 4 * 1024 * 1024;
const MAXIMUM_TAGS_MODELS = 10_000;

export interface OllamaInstalledModel {
  name: string;
  sizeBytes: number | null;
  family: string;
  parameterSize: string;
  quantization: string;
}

export interface AiConnectionTest {
  status: "connected" | "reachable" | "authentication-required" | "local-runtime" | "not-tested";
  detail: string;
  modelCount: number | null;
}

export async function listOllamaInstalledModels(
  endpointValue: string,
  signal?: AbortSignal,
): Promise<OllamaInstalledModel[]> {
  const provider = providerById("ollama");
  if (!provider) throw new Error("Ollama is not a supported provider.");
  const endpoint = validateProviderEndpoint(endpointValue, provider);
  const base = endpoint.replace(/\/v1$/u, "").replace(/\/+$/u, "");
  const response = await fetch(`${base}/api/tags`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status} for its model list.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAXIMUM_TAGS_BYTES) {
    throw new Error("Ollama returned an oversized model list.");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAXIMUM_TAGS_BYTES) {
    throw new Error("Ollama returned an oversized model list.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Ollama returned an invalid model list.");
  }
  if (!isObject(parsed) || !Array.isArray(parsed["models"])) {
    throw new Error("Ollama returned an invalid model list.");
  }
  if (parsed["models"].length > MAXIMUM_TAGS_MODELS) {
    throw new Error("Ollama returned too many installed models.");
  }
  const models: OllamaInstalledModel[] = [];
  for (const item of parsed["models"]) {
    if (!isObject(item)) continue;
    const name = typeof item["name"] === "string" ? item["name"] : item["model"];
    if (typeof name !== "string" || !name.trim() || name.includes("\0")) continue;
    const details = isObject(item["details"]) ? item["details"] : {};
    const size =
      typeof item["size"] === "number" && Number.isSafeInteger(item["size"]) ? item["size"] : null;
    models.push({
      name: name.trim(),
      sizeBytes: size,
      family: textValue(details["family"]),
      parameterSize: textValue(details["parameter_size"]),
      quantization: textValue(details["quantization_level"]),
    });
  }
  models.sort((left, right) => left.name.localeCompare(right.name));
  return models;
}

/** Check reachability without reading or sending credentials or archive data. */
export async function testAiProviderConnection(
  providerId: string,
  endpointValue: string,
  signal?: AbortSignal,
): Promise<AiConnectionTest> {
  const provider = providerById(providerId);
  if (!provider) throw new Error("Choose a supported AI provider.");
  if (provider.id === "embedded-gguf") {
    return {
      status: "local-runtime",
      detail:
        "Embedded GGUF inference runs inside the desktop app; no provider connection is needed.",
      modelCount: null,
    };
  }
  if (provider.id === "replicate") {
    return {
      status: "not-tested",
      detail: "Replicate predictions need a saved token; this check does not send credentials.",
      modelCount: null,
    };
  }
  const endpoint = validateProviderEndpoint(endpointValue, provider);
  if (provider.id === "ollama") {
    const models = await listOllamaInstalledModels(endpoint, signal);
    return {
      status: "connected",
      detail: `Ollama is reachable with ${models.length} installed model(s).`,
      modelCount: models.length,
    };
  }
  const path =
    provider.id === "anthropic"
      ? "/v1/models"
      : provider.id === "cohere"
        ? "/v1/models"
        : provider.id === "google-gemini"
          ? "/models"
          : "/models";
  const base = endpoint.replace(/\/+$/u, "");
  const response = await fetch(`${base}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (response.ok) {
    let modelCount: number | null = null;
    try {
      const data = (await response.json()) as unknown;
      if (isObject(data)) {
        const entries = Array.isArray(data["data"])
          ? data["data"]
          : Array.isArray(data["models"])
            ? data["models"]
            : undefined;
        if (entries) modelCount = entries.length;
      }
    } catch {
      // Reachability is still proven by a successful HTTP response.
    }
    return {
      status: "connected",
      detail:
        modelCount === null
          ? "Provider endpoint is reachable."
          : `Provider endpoint is reachable with ${modelCount} listed model(s).`,
      modelCount,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      status: "authentication-required",
      detail: `Provider endpoint is reachable (HTTP ${response.status}); authentication is required.`,
      modelCount: null,
    };
  }
  if (response.status === 404) {
    return {
      status: "reachable",
      detail: "Provider endpoint is reachable but did not expose a model list.",
      modelCount: null,
    };
  }
  throw new Error(`Provider connection check returned HTTP ${response.status}.`);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
