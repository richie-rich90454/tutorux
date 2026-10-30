import { RecordType, type ArchiveRecord } from "../archive/format";
import type { ArchiveSnapshot } from "../archive/archive";
import { readAssetBytes } from "../domain/assets";
import {
  MAX_AI_PACKAGE_BYTES,
  isAiImageAttachmentCandidate,
  parseAiImageAttachmentManifest,
  type AiImageAttachmentManifest,
} from "./package";
import {
  isEmbeddedGgufProvider,
  isOpenAiCompatibleProvider,
  openCodeZenProtocolForModel,
  providerById,
  providerAuthenticationHeaderName,
  validateProviderEndpoint,
  usesAnthropicVersionHeader,
} from "./providers";
import { AI_GENERATION_SYSTEM_PROMPT } from "./prompt";
import type { ReplicateModelInputSchema } from "./replicate-schema";

export const MAX_AI_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_REPLICATE_PROMPT_BYTES = 8 * 1024 * 1024;
export const MAX_REPLICATE_REQUEST_BYTES = 8 * 1024 * 1024;
export const DEFAULT_AI_OUTPUT_TOKENS = 4096;
export { AI_GENERATION_SYSTEM_PROMPT_BYTES } from "./prompt";

const encoder = new TextEncoder();

export interface AiRequestHeaderPreview {
  name: string;
  valueDescription: string;
}

export interface AiRequestPreview {
  providerId: string;
  providerName: string;
  guideTemplateId: string | null;
  endpoint: string;
  model: string;
  method: "POST";
  accept: string;
  headers: readonly AiRequestHeaderPreview[];
  authentication: string;
  packageHash: string;
  packageBytes: number;
  attachedImages: readonly AiImageAttachmentManifest[];
  requestBodyHash: string;
  requestBytes: number;
  maxOutputTokens: number;
  localOnly: boolean;
  credentialAvailable: boolean;
  requestBody: string;
  replicateInputSchema?: ReplicateModelInputSchema | null;
}

/** Build the exact provider request, without reading keys or making a network request. */
export async function createAiRequestPreview(
  packageJob: ArchiveRecord,
  providerConfiguration: ArchiveRecord,
  maximumOutputTokens = DEFAULT_AI_OUTPUT_TOKENS,
  credentialMetadata: readonly ArchiveRecord[] = [],
  systemCredentialAvailable = false,
  snapshot?: ArchiveSnapshot,
  replicateInputSchema?: ReplicateModelInputSchema,
): Promise<AiRequestPreview> {
  if (
    packageJob.type !== RecordType.aiJob ||
    packageJob.fields.get("mode") !== "manual" ||
    packageJob.fields.get("format") !== "json" ||
    packageJob.fields.get("status") !== "package-ready"
  ) {
    throw new Error("Choose a prepared JSON package before reviewing a provider request.");
  }
  if (packageJob.blob.byteLength === 0 || packageJob.blob.byteLength > MAX_AI_PACKAGE_BYTES) {
    throw new Error("The AI package is empty or exceeds the 8 MiB send limit.");
  }
  if (
    !Number.isSafeInteger(maximumOutputTokens) ||
    maximumOutputTokens < 1 ||
    maximumOutputTokens > 1_000_000
  ) {
    throw new Error("The output-token limit must be between 1 and 1,000,000.");
  }
  const packageHash = await sha256(packageJob.blob);
  if (packageHash !== packageJob.fields.get("content_hash")) {
    throw new Error("The stored package hash does not match its content.");
  }
  const packageText = new TextDecoder("utf-8", { fatal: true }).decode(packageJob.blob);
  let parsedPackage: unknown;
  try {
    parsedPackage = JSON.parse(packageText);
  } catch {
    throw new Error("The stored AI package is not valid JSON.");
  }
  const packageManifest =
    isObject(parsedPackage) && isObject(parsedPackage["manifest"])
      ? parsedPackage["manifest"]
      : undefined;
  if (!packageManifest || packageManifest["format"] !== "tutorux-ai-package-v1") {
    throw new Error("The stored JSON does not use the supported Tutorux AI package format.");
  }
  const imageManifest = parseAiImageAttachmentManifest(parsedPackage);
  const declaredImageIds = packageManifest["attached_image_ids"];
  if (
    declaredImageIds !== undefined &&
    (!Array.isArray(declaredImageIds) ||
      declaredImageIds.length !== imageManifest.length ||
      declaredImageIds.some((id, index) => id !== imageManifest[index]?.id))
  ) {
    throw new Error("The AI image attachment list does not match its package manifest.");
  }

  const providerId = providerConfiguration.fields.get("provider_id") ?? "";
  const provider = providerById(providerId);
  if (
    providerConfiguration.type !== RecordType.settings ||
    providerConfiguration.fields.get("record_role") !== "ai-provider" ||
    !provider
  ) {
    throw new Error("Choose a saved, supported provider configuration.");
  }
  if (provider.generationAvailable === false) {
    throw new Error(
      provider.generationUnavailableReason ??
        "This provider is available for model discovery only.",
    );
  }
  const model = cleanModel(providerConfiguration.fields.get("selected_model") ?? "");
  const endpoint = validateProviderEndpoint(
    providerConfiguration.fields.get("endpoint") ?? "",
    provider,
  );
  if (imageManifest.length > 0 && !supportsImageInput(provider.id)) {
    throw new Error(
      "This provider does not support image attachments in Tutorux. Choose a compatible vision model from an OpenAI, Anthropic, Gemini, or Ollama provider.",
    );
  }
  const imageAttachments = await loadImageAttachments(snapshot, packageManifest, imageManifest);
  if (provider.id === "replicate" && replicateInputSchema?.modelId !== model) {
    throw new Error("Inspect the selected Replicate model inputs before reviewing its request.");
  }
  const requestBody = buildRequestBody(
    provider.id,
    model,
    packageText,
    maximumOutputTokens,
    imageAttachments,
    replicateInputSchema,
  );
  const requestBytes = encoder.encode(requestBody);
  const maximumRequestBytes =
    provider.id === "replicate" ? MAX_REPLICATE_REQUEST_BYTES : MAX_AI_REQUEST_BODY_BYTES;
  if (requestBytes.byteLength > maximumRequestBytes) {
    throw new Error(
      provider.id === "replicate"
        ? "The Replicate request exceeds the 8 MiB send limit. Shorten the session package."
        : imageAttachments.length > 0
          ? "The provider request exceeds the 16 MiB send limit. Remove images or shorten the session package."
          : "The provider request exceeds the 16 MiB send limit.",
    );
  }

  const requestEndpoint = generationEndpoint(provider.id, endpoint, model);
  const accept =
    provider.id === "ollama"
      ? "application/x-ndjson"
      : provider.id === "replicate"
        ? "application/json"
        : "text/event-stream";
  const credentialAvailable =
    provider.local ||
    systemCredentialAvailable ||
    credentialMetadata.some(
      (record) =>
        record.fields.get("provider_id") === provider.id ||
        record.fields.get("key") === provider.credentialKey,
    );
  const headers = providerHeaders(provider.id, credentialAvailable, model);
  return {
    providerId: provider.id,
    providerName: provider.name,
    guideTemplateId:
      typeof packageManifest["guide_template_id"] === "string"
        ? packageManifest["guide_template_id"]
        : null,
    endpoint: requestEndpoint,
    model,
    method: "POST",
    accept,
    headers,
    authentication: authenticationDescription(provider.id, model, credentialAvailable),
    packageHash,
    packageBytes: packageJob.blob.byteLength,
    attachedImages: imageManifest,
    requestBodyHash: await sha256(requestBytes),
    requestBytes: requestBytes.byteLength,
    maxOutputTokens: maximumOutputTokens,
    localOnly: provider.local,
    credentialAvailable,
    requestBody,
    replicateInputSchema: provider.id === "replicate" ? replicateInputSchema! : null,
  };
}

function buildRequestBody(
  providerId: string,
  model: string,
  packageText: string,
  maximumOutputTokens: number,
  imageAttachments: readonly LoadedAiImageAttachment[],
  replicateInputSchema?: ReplicateModelInputSchema,
): string {
  const openCodeProtocol =
    providerId === "opencode-zen" ? openCodeZenProtocolForModel(model) : undefined;
  let body: unknown;
  if (providerId === "replicate") {
    splitReplicateModelId(model);
    if (!replicateInputSchema || replicateInputSchema.modelId !== model) {
      throw new Error("Inspect the selected Replicate model inputs before reviewing its request.");
    }
    const prompt = replicateInputSchema.hasSystemPrompt
      ? packageText
      : `${AI_GENERATION_SYSTEM_PROMPT}\n\n${packageText}`;
    const promptBytes = encoder.encode(prompt).byteLength;
    if (promptBytes > MAX_REPLICATE_PROMPT_BYTES) {
      throw new Error("The Replicate prompt exceeds the 8 MiB send limit.");
    }
    const input: Record<string, string | number> = { prompt };
    if (replicateInputSchema.hasSystemPrompt) {
      input["system_prompt"] = AI_GENERATION_SYSTEM_PROMPT;
    }
    if (replicateInputSchema.tokenInput) {
      input[replicateInputSchema.tokenInput] = maximumOutputTokens;
    }
    body = { version: replicateInputSchema.version, input };
  } else if (
    isOpenAiCompatibleProvider(providerId) ||
    isEmbeddedGgufProvider(providerId) ||
    (providerId === "opencode-zen" && openCodeProtocol === "openai-chat")
  ) {
    body = {
      model,
      stream: true,
      [usesMaxCompletionTokens(providerId) ? "max_completion_tokens" : "max_tokens"]:
        maximumOutputTokens,
      messages: [
        { role: "system", content: AI_GENERATION_SYSTEM_PROMPT },
        {
          role: "user",
          content: imageAttachments.length
            ? [
                { type: "text", text: packageText },
                ...imageAttachments.map((image) => ({
                  type: "image_url",
                  image_url: { url: `data:${image.mimeType};base64,${toBase64(image.bytes)}` },
                })),
              ]
            : packageText,
        },
      ],
    };
  } else if (providerId === "opencode-zen" && openCodeProtocol === "openai-responses") {
    body = {
      model,
      instructions: AI_GENERATION_SYSTEM_PROMPT,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: packageText },
            ...imageAttachments.map((image) => ({
              type: "input_image",
              image_url: `data:${image.mimeType};base64,${toBase64(image.bytes)}`,
            })),
          ],
        },
      ],
      max_output_tokens: maximumOutputTokens,
      stream: true,
    };
  } else if (
    providerId === "anthropic" ||
    (providerId === "opencode-zen" && openCodeProtocol === "anthropic")
  ) {
    body = {
      model,
      max_tokens: maximumOutputTokens,
      stream: true,
      system: AI_GENERATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: imageAttachments.length
            ? [
                { type: "text", text: packageText },
                ...imageAttachments.map((image) => ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: image.mimeType,
                    data: toBase64(image.bytes),
                  },
                })),
              ]
            : packageText,
        },
      ],
    };
  } else if (
    providerId === "google-gemini" ||
    (providerId === "opencode-zen" && openCodeProtocol === "gemini")
  ) {
    body = {
      systemInstruction: { parts: [{ text: AI_GENERATION_SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: packageText },
            ...imageAttachments.map((image) => ({
              inlineData: { mimeType: image.mimeType, data: toBase64(image.bytes) },
            })),
          ],
        },
      ],
      generationConfig: { maxOutputTokens: maximumOutputTokens },
    };
  } else if (providerId === "cohere") {
    body = {
      model,
      stream: true,
      max_tokens: maximumOutputTokens,
      messages: [
        { role: "system", content: AI_GENERATION_SYSTEM_PROMPT },
        {
          role: "user",
          content: packageText,
        },
      ],
    };
  } else if (providerId === "perplexity") {
    body = {
      model,
      instructions: AI_GENERATION_SYSTEM_PROMPT,
      input: packageText,
      max_output_tokens: maximumOutputTokens,
      stream: true,
    };
  } else if (providerId === "ollama") {
    body = {
      model,
      stream: true,
      messages: [
        { role: "system", content: AI_GENERATION_SYSTEM_PROMPT },
        {
          role: "user",
          content: packageText,
          ...(imageAttachments.length
            ? { images: imageAttachments.map((image) => toBase64(image.bytes)) }
            : {}),
        },
      ],
      options: { num_predict: maximumOutputTokens },
    };
  } else {
    throw new Error("Request previews are not available for this provider.");
  }
  return JSON.stringify(body);
}

interface LoadedAiImageAttachment extends AiImageAttachmentManifest {
  bytes: Uint8Array;
}

async function loadImageAttachments(
  snapshot: ArchiveSnapshot | undefined,
  packageManifest: Record<string, unknown>,
  images: readonly AiImageAttachmentManifest[],
): Promise<LoadedAiImageAttachment[]> {
  if (images.length === 0) return [];
  if (!snapshot) throw new Error("Open the source archive to load its selected images.");
  const sessionId = packageManifest["session_id"];
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("The AI package does not identify the session for its selected images.");
  }
  const loaded: LoadedAiImageAttachment[] = [];
  for (const image of images) {
    const metadata = await snapshot.getRecord(RecordType.assetMetadata, image.id);
    if (
      !metadata ||
      metadata.fields.get("_deleted") === "true" ||
      !isAiImageAttachmentCandidate(metadata) ||
      metadata.fields.get("session_id")?.toLowerCase() !== sessionId.toLowerCase() ||
      metadata.fields.get("filename") !== image.filename ||
      metadata.fields.get("mime_type") !== image.mimeType ||
      metadata.fields.get("content_hash")?.toLowerCase() !== image.contentHash ||
      Number(metadata.fields.get("byte_size")) !== image.byteSize
    ) {
      throw new Error(
        `Image material “${image.filename}” changed after the package was prepared. Prepare and review it again.`,
      );
    }
    const blobId = metadata.fields.get("blob_id");
    const blob = blobId ? await snapshot.getRecord(RecordType.assetBlob, blobId) : null;
    const archivedByteSize =
      blob?.fields.get("record_role") === "asset-blob-manifest"
        ? Number(blob.fields.get("byte_size"))
        : blob?.blob.byteLength;
    if (!blob || blob.fields.get("_deleted") === "true" || archivedByteSize !== image.byteSize) {
      throw new Error(`Image material “${image.filename}” failed its content validation.`);
    }
    const bytes = await readAssetBytes(snapshot, metadata);
    const actualMimeType = detectAttachedImageMimeType(bytes);
    if (bytes.byteLength !== image.byteSize || actualMimeType !== image.mimeType) {
      throw new Error(`Image material “${image.filename}” failed its content validation.`);
    }
    loaded.push({ ...image, bytes });
  }
  return loaded;
}

function supportsImageInput(providerId: string): boolean {
  return (
    isOpenAiCompatibleProvider(providerId) ||
    providerId === "opencode-zen" ||
    ["anthropic", "google-gemini", "ollama"].includes(providerId)
  );
}

function usesMaxCompletionTokens(providerId: string): boolean {
  return ["openai", "minimax", "volcengine"].includes(providerId);
}

function detectAttachedImageMimeType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number, expected: string): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)),
    );
  }
  return btoa(binary);
}

function generationEndpoint(providerId: string, configuredEndpoint: string, model: string): string {
  const base = configuredEndpoint.replace(/\/+$/u, "");
  if (providerId === "opencode-zen") {
    const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
    const protocol = openCodeZenProtocolForModel(model);
    const gateway =
      protocol === "anthropic"
        ? `${root}/anthropic`
        : protocol === "gemini"
          ? `${root}/google/v1beta`
          : `${root}/openai/v1`;
    if (protocol === "anthropic") return `${gateway}/v1/messages`;
    if (protocol === "gemini") {
      const modelPath = model.startsWith("models/") ? model.slice("models/".length) : model;
      return `${gateway}/models/${encodeModelId(modelPath)}:streamGenerateContent?alt=sse`;
    }
    return `${gateway}/${protocol === "openai-responses" ? "responses" : "chat/completions"}`;
  }
  if (isOpenAiCompatibleProvider(providerId)) return `${base}/chat/completions`;
  switch (providerId) {
    case "replicate": {
      const [owner, name] = splitReplicateModelId(model);
      return `${base}/models/${owner}/${name}/predictions`;
    }
    case "anthropic":
      return `${base}/v1/messages`;
    case "cohere":
      return `${base}/v2/chat`;
    case "perplexity":
      return `${base}/agent`;
    case "ollama":
      return `${base.endsWith("/v1") ? base.slice(0, -3) : base}/api/chat`;
    case "embedded-gguf":
    case "llama.cpp-embedded":
      return base;
    case "google-gemini": {
      const modelPath = model.startsWith("models/") ? model.slice("models/".length) : model;
      return `${base}/models/${encodeModelId(modelPath)}:streamGenerateContent?alt=sse`;
    }
    default:
      throw new Error("Request previews are not available for this provider.");
  }
}

function providerHeaders(
  providerId: string,
  credentialAvailable: boolean,
  model: string,
): AiRequestHeaderPreview[] {
  const headers: AiRequestHeaderPreview[] = [
    { name: "Content-Type", valueDescription: "application/json" },
    {
      name: "Accept",
      valueDescription:
        providerId === "ollama"
          ? "application/x-ndjson"
          : providerId === "replicate"
            ? "application/json"
            : "text/event-stream",
    },
  ];
  if (providerId === "replicate") {
    headers.push({ name: "Prefer", valueDescription: "wait up to 60 seconds for a result" });
  }
  const authenticationHeader = providerAuthenticationHeaderName(providerId, model);
  if (authenticationHeader) {
    headers.push({
      name: authenticationHeader,
      valueDescription: credentialAvailable
        ? authenticationHeader === "Authorization"
          ? "Bearer saved API key; value hidden"
          : "Saved API key; value hidden"
        : "API key required; no value included in this preview",
    });
  }
  if (usesAnthropicVersionHeader(providerId, model)) {
    headers.push({ name: "anthropic-version", valueDescription: "2023-06-01" });
  }
  return headers;
}

function authenticationDescription(
  providerId: string,
  model: string,
  credentialAvailable: boolean,
): string {
  const authenticationHeader = providerAuthenticationHeaderName(providerId, model);
  if (authenticationHeader === null) {
    switch (providerId) {
      case "ollama":
      case "lm-studio":
      case "llama.cpp-server":
        return "No credential; loopback service";
      default:
        return "No credential; inference stays inside the desktop process";
    }
  }
  if (!credentialAvailable) {
    return `${authenticationHeader}: API key required; no value included in this preview`;
  }
  return authenticationHeader === "Authorization"
    ? "Authorization: Bearer saved API key; value hidden"
    : `${authenticationHeader}: saved API key; value hidden`;
}

function encodeModelId(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function cleanModel(value: string): string {
  const model = value.trim();
  if (!model || encoder.encode(model).byteLength > 1024) {
    throw new Error("Choose a valid provider model before reviewing a request.");
  }
  for (const character of model) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      throw new Error("Choose a valid provider model before reviewing a request.");
    }
  }
  return model;
}

function splitReplicateModelId(value: string): [string, string] {
  const match = /^([A-Za-z0-9_.-]{1,128})\/([A-Za-z0-9_.-]{1,128})$/u.exec(value);
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw new Error("Replicate models must use the owner/model form from the public catalog.");
  }
  return [match[1]!, match[2]!];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
