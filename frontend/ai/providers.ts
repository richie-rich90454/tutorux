import { RecordType, type ArchiveRecord } from "../archive/format";

export interface AiProviderDefinition {
  id: string;
  name: string;
  description: string;
  protocol: string;
  defaultEndpoint: string;
  credentialKey: string | null;
  local: boolean;
}

export interface AiProviderConfigurationInput {
  providerId: string;
  endpoint: string;
  model: string;
}

export const AI_PROVIDERS: readonly AiProviderDefinition[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI Chat Completions API",
    protocol: "OpenAI Chat Completions",
    defaultEndpoint: "https://api.openai.com/v1",
    credentialKey: "OPENAI_API_KEY",
    local: false,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude Messages API",
    protocol: "Anthropic Messages",
    defaultEndpoint: "https://api.anthropic.com",
    credentialKey: "ANTHROPIC_API_KEY",
    local: false,
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    description: "Gemini generate content API",
    protocol: "Gemini Generate Content",
    defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta",
    credentialKey: "GEMINI_API_KEY",
    local: false,
  },
  {
    id: "cohere",
    name: "Cohere",
    description: "Cohere Chat v2 API",
    protocol: "Cohere Chat v2",
    defaultEndpoint: "https://api.cohere.com",
    credentialKey: "COHERE_API_KEY",
    local: false,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    description: "Perplexity Agent API",
    protocol: "Perplexity Agent",
    defaultEndpoint: "https://api.perplexity.ai/v1",
    credentialKey: "PERPLEXITY_API_KEY",
    local: false,
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    description: "Local Ollama service",
    protocol: "Ollama Chat",
    defaultEndpoint: "http://127.0.0.1:11434",
    credentialKey: null,
    local: true,
  },
  {
    id: "embedded-gguf",
    name: "Embedded GGUF (offline)",
    description: "In-process GGUF model · no network request",
    protocol: "Local llama.cpp runtime",
    defaultEndpoint: "tutorux://embedded/generate",
    credentialKey: null,
    local: true,
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible endpoint",
    description: "Custom OpenAI-compatible service",
    protocol: "OpenAI-compatible Chat Completions",
    defaultEndpoint: "",
    credentialKey: "TUTORUX_OPENAI_COMPATIBLE_API_KEY",
    local: false,
  },
];

/** `llama.cpp-embedded` is the legacy archive/CLI ID; `embedded-gguf` is its current UI ID. */
export function isEmbeddedGgufProvider(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  return normalized === "embedded-gguf" || normalized === "llama.cpp-embedded";
}

export function providerById(providerId: string): AiProviderDefinition | undefined {
  const normalized = providerId.trim().toLowerCase();
  if (isEmbeddedGgufProvider(normalized)) {
    return AI_PROVIDERS.find((provider) => provider.id === "embedded-gguf");
  }
  return AI_PROVIDERS.find((provider) => provider.id === normalized);
}

export async function createProviderConfigurationRecord(
  input: AiProviderConfigurationInput,
  now = Date.now(),
): Promise<ArchiveRecord> {
  const provider = providerById(input.providerId);
  if (!provider) throw new Error("Choose a supported AI provider.");
  const endpoint = validateProviderEndpoint(input.endpoint, provider);
  const model = cleanField(input.model, "Model", 256, true);
  const id = await deterministicUuid(`ai-provider:${provider.id}`);
  return {
    type: RecordType.settings,
    id,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map([
      ["record_role", "ai-provider"],
      ["provider_id", provider.id],
      ["endpoint", endpoint],
      ["selected_model", model],
      ["configured_at_us", (BigInt(now) * 1000n).toString()],
      ["credential_storage", "memory-only"],
    ]),
    blob: new Uint8Array(),
  };
}

export async function createProviderCredentialRecord(
  providerId: string,
  value: string,
  encryptedArchive: boolean,
  now = Date.now(),
): Promise<ArchiveRecord> {
  const provider = providerById(providerId);
  if (!provider) throw new Error("Choose a supported AI provider.");
  if (!provider.credentialKey) throw new Error("This local provider does not need an API key.");
  if (!encryptedArchive) {
    throw new Error("API keys can only be saved inside an encrypted archive.");
  }
  const secret = cleanField(value, "API key", 4096, false);
  if (/\s/u.test(secret)) throw new Error("API key cannot contain whitespace.");
  return {
    type: RecordType.settings,
    id: await deterministicUuid(`credential:${provider.credentialKey}`),
    revision: 0n,
    previousOffset: 0n,
    fields: new Map([
      ["record_role", "credential"],
      ["key", provider.credentialKey],
      ["provider_id", provider.id],
      ["value", secret],
      ["updated_at_us", (BigInt(now) * 1000n).toString()],
    ]),
    blob: new Uint8Array(),
  };
}

export function maskCredentialMetadata(record: ArchiveRecord): ArchiveRecord {
  const fields = new Map(record.fields);
  for (const name of fields.keys()) {
    if (
      ["value", "secret", "api_key", "token", "access_token", "refresh_token"].includes(
        name.toLowerCase(),
      )
    ) {
      fields.delete(name);
    }
  }
  return { ...record, fields, blob: new Uint8Array() };
}

export function validateProviderEndpoint(value: string, provider: AiProviderDefinition): string {
  const endpoint = cleanField(value, "Endpoint", 2048, false);
  if (isEmbeddedGgufProvider(provider.id)) {
    if (endpoint !== provider.defaultEndpoint) {
      throw new Error("Embedded GGUF inference uses the in-process desktop runtime endpoint.");
    }
    return endpoint;
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Enter a valid provider endpoint URL.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Endpoint URLs cannot contain credentials, query parameters, or fragments.");
  }
  if (provider.local) {
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
    if (parsed.protocol !== "http:" || !loopback) {
      throw new Error("Local model endpoints must use HTTP on localhost, 127.0.0.1, or ::1.");
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error("Cloud provider endpoints must use HTTPS.");
  }
  return endpoint.replace(/\/$/u, "");
}

function cleanField(
  value: string,
  label: string,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const cleaned = value.trim();
  if (!allowEmpty && !cleaned) throw new Error(`${label} is required.`);
  if (new TextEncoder().encode(cleaned).byteLength > maximumBytes) {
    throw new Error(`${label} must be ${maximumBytes.toLocaleString()} bytes or fewer.`);
  }
  return cleaned;
}

export async function deterministicUuid(seed: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0"));
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
