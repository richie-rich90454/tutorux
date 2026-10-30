import type { AiTransportRequest, AiTransportResult } from "../../frontend/platform/types";
import { CliError } from "./shared";

export const CLI_AI_MODEL_MAX_PAGES = 50;

export const CLI_AI_MODEL_MAX_COUNT = 50_000;

export const CLI_AI_MODEL_MAX_PAGE_BYTES = 8 * 1024 * 1024;

export const CLI_AI_MODEL_MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export const CLI_AI_MODEL_MAX_ID_BYTES = 1024;

export const CLI_AI_MODEL_MAX_CURSOR_BYTES = 8 * 1024;

export interface CliAiModelPage {
  models: { id: string; owner?: string }[];
  nextCursor: string | undefined;
}

export function buildCliAiModelPageUrl(
  providerId: string,
  endpoint: string,
  cursor: string | undefined,
): string {
  const parameters = new URLSearchParams();
  let path: string;
  if (providerId === "ollama") {
    path = "/api/tags";
  } else if (providerId === "anthropic") {
    path = "/v1/models";
    parameters.set("limit", "1000");
    if (cursor) parameters.set("after_id", cursor);
  } else if (providerId === "cohere") {
    path = "/v1/models";
    parameters.set("page_size", "1000");
    parameters.set("endpoint", "chat");
    if (cursor) parameters.set("page_token", cursor);
  } else if (providerId === "google-gemini") {
    path = "/models";
    parameters.set("pageSize", "1000");
    if (cursor) parameters.set("pageToken", cursor);
  } else {
    path = "/models";
    if (cursor) parameters.set("after", cursor);
  }
  const query = parameters.toString();
  return `${endpoint}${path}${query ? `?${query}` : ""}`;
}

export function parseCliAiModelPage(providerId: string, data: unknown): CliAiModelPage {
  if (!data || typeof data !== "object")
    throw new CliError("Provider returned an invalid model catalog.");
  const root = data as Record<string, unknown>;
  const entries = root["data"] ?? root["models"];
  if (!Array.isArray(entries)) throw new CliError("Provider returned an invalid model list.");
  const models = entries.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = row["id"] ?? row["name"] ?? row["model"];
    if (typeof id !== "string" || !id) return [];
    if (new TextEncoder().encode(id).byteLength > CLI_AI_MODEL_MAX_ID_BYTES)
      throw new CliError("Provider model catalog contains an invalid model ID.");
    const details =
      providerId === "ollama" && row["details"] && typeof row["details"] === "object"
        ? (row["details"] as Record<string, unknown>)
        : undefined;
    const family = typeof details?.["family"] === "string" ? details["family"] : "";
    const parameterSize =
      typeof details?.["parameter_size"] === "string" ? details["parameter_size"] : "";
    const owner = [family, parameterSize].filter(Boolean).join(" · ");
    return [{ id, ...(owner ? { owner } : {}) }];
  });

  let nextCursor: string | undefined;
  if (providerId === "anthropic") {
    if (root["has_more"] !== undefined && typeof root["has_more"] !== "boolean")
      throw new CliError("Provider model catalog has invalid pagination metadata.");
    if (root["has_more"] === true) {
      const cursor = root["last_id"];
      if (typeof cursor !== "string" || !cursor)
        throw new CliError("Provider model pagination cursor is invalid.");
      nextCursor = cursor;
    }
  } else if (providerId === "cohere") {
    const cursor = root["next_page_token"];
    if (cursor !== undefined && cursor !== null && typeof cursor !== "string")
      throw new CliError("Provider model catalog has invalid pagination metadata.");
    if (typeof cursor === "string" && cursor) nextCursor = cursor;
  } else if (providerId === "google-gemini") {
    const cursor = root["nextPageToken"];
    if (cursor !== undefined && cursor !== null && typeof cursor !== "string")
      throw new CliError("Provider model catalog has invalid pagination metadata.");
    if (typeof cursor === "string" && cursor) nextCursor = cursor;
  } else if (providerId !== "ollama") {
    if (root["has_more"] !== undefined && typeof root["has_more"] !== "boolean")
      throw new CliError("Provider model catalog has invalid pagination metadata.");
    if (root["has_more"] === true) {
      const rootCursor = root["last_id"];
      const cursor =
        typeof rootCursor === "string" && rootCursor ? rootCursor : (models.at(-1)?.id ?? "");
      if (!cursor) throw new CliError("Provider model pagination cursor is invalid.");
      nextCursor = cursor;
    }
  }
  if (nextCursor && new TextEncoder().encode(nextCursor).byteLength > CLI_AI_MODEL_MAX_CURSOR_BYTES)
    throw new CliError("Provider model pagination cursor is invalid.");

  return { models, nextCursor };
}

export async function readCliAiModelPage(
  response: Response,
): Promise<{ data: unknown; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) throw new CliError("Provider returned an empty model catalog.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > CLI_AI_MODEL_MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new CliError("Provider model catalog page exceeds 8 MiB.");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    bytes: size,
  };
}

export async function discoverCliAiModels(
  providerId: string,
  endpoint: string,
  credential: string,
): Promise<{ id: string; owner?: string }[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (credential) {
    const header =
      providerId === "anthropic"
        ? "x-api-key"
        : providerId === "google-gemini"
          ? "x-goog-api-key"
          : "authorization";
    headers[header] = header === "authorization" ? `Bearer ${credential}` : credential;
  }
  if (providerId === "anthropic") headers["anthropic-version"] = "2023-06-01";
  const signal = AbortSignal.timeout(30_000);
  const models: { id: string; owner?: string }[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let totalBytes = 0;
  for (let pageNumber = 0; pageNumber < CLI_AI_MODEL_MAX_PAGES; pageNumber += 1) {
    const response = await fetch(buildCliAiModelPageUrl(providerId, endpoint, cursor), {
      headers,
      redirect: "error",
      signal,
    });
    if (!response.ok)
      throw new CliError(`Provider model discovery returned HTTP ${response.status}.`);
    const pageResponse = await readCliAiModelPage(response);
    totalBytes += pageResponse.bytes;
    if (totalBytes > CLI_AI_MODEL_MAX_CATALOG_BYTES)
      throw new CliError("Provider model catalog exceeds 8 MiB across all pages.");
    const page = parseCliAiModelPage(providerId, pageResponse.data);
    for (const model of page.models) {
      if (seenIds.has(model.id)) continue;
      seenIds.add(model.id);
      models.push(model);
      if (models.length > CLI_AI_MODEL_MAX_COUNT)
        throw new CliError("Provider model catalog exceeds 50,000 models.");
    }
    if (!page.nextCursor) return models;
    if (seenCursors.has(page.nextCursor))
      throw new CliError("Provider model pagination cursor is invalid.");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new CliError("Provider model catalog exceeded 50 pages.");
}

export async function sendCliAiRequest(
  request: AiTransportRequest,
  onChunk: (chunk: Uint8Array) => void,
): Promise<AiTransportResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: request.accept,
  };
  if (request.credential) {
    const header =
      request.providerId === "anthropic"
        ? "x-api-key"
        : request.providerId === "google-gemini"
          ? "x-goog-api-key"
          : "authorization";
    headers[header] =
      header === "authorization" ? `Bearer ${request.credential}` : request.credential;
  }
  if (request.providerId === "anthropic") headers["anthropic-version"] = "2023-06-01";
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers,
    body: request.requestBody,
    redirect: "error",
    signal: AbortSignal.timeout(300_000),
  });
  const reader = response.body?.getReader();
  let total = 0;
  let complete = true;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        onChunk(chunk.value);
        if (total > 16 * 1024 * 1024) {
          complete = false;
          await reader.cancel();
          break;
        }
      }
    } catch {
      complete = false;
    }
  }
  return {
    status: response.status,
    contentType: (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(),
    responseBytes: total,
    complete,
  };
}
