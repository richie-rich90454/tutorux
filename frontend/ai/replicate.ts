import type {
  AiModelInspectionRequest,
  AiTransportRequest,
  AiTransportResult,
} from "../platform/types";

export const REPLICATE_API_ROOT = "https://api.replicate.com/v1";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 4096;
const CREATE_TIMEOUT_MS = 65_000;
const MODEL_INSPECTION_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 20_000;
const CANCEL_TIMEOUT_MS = 10_000;
const PREDICTION_TIMEOUT_MS = 5 * 60_000;

interface ActiveBrowserPrediction {
  cancelled: boolean;
  controller: AbortController | null;
  predictionId: string | null;
}

let activeBrowserPrediction: ActiveBrowserPrediction | null = null;
let cancelHandler: (() => Promise<void>) | null = null;

/** Install the active platform's Replicate cancellation operation for the AI workspace. */
export function registerReplicateCancellationHandler(handler: () => Promise<void>): () => void {
  cancelHandler = handler;
  return () => {
    if (cancelHandler === handler) cancelHandler = null;
  };
}

/** Request cancellation of the current prediction; no provider secret crosses this boundary. */
export async function cancelReplicatePrediction(): Promise<void> {
  if (!cancelHandler) throw new Error("Replicate cancellation is unavailable on this platform.");
  await cancelHandler();
}

/** Execute Replicate's create/poll/cancel lifecycle in a static browser build. */
export async function sendReplicateAiRequest(
  request: AiTransportRequest,
  onChunk: (chunk: Uint8Array) => void,
): Promise<AiTransportResult> {
  if (activeBrowserPrediction) throw new Error("A Replicate prediction is already active.");
  const active: ActiveBrowserPrediction = {
    cancelled: false,
    controller: null,
    predictionId: null,
  };
  activeBrowserPrediction = active;
  try {
    await assertReviewedReplicateRequest(request);
    validateCredential(request.credential);
    const creation = await requestJson(
      request.endpoint,
      "POST",
      request.credential,
      request.requestBody,
      CREATE_TIMEOUT_MS,
      null,
    );
    if (creation.transportError) {
      return finish(creation, onChunk, false, creation.transportError);
    }
    if (creation.status < 200 || creation.status >= 300 || !creation.complete) {
      return finish(creation, onChunk, false);
    }

    let prediction: { id: string; status: string };
    try {
      prediction = parsePrediction(creation.bytes);
    } catch (cause) {
      return finish(creation, onChunk, false, errorMessage(cause));
    }
    active.predictionId = prediction.id;
    if (prediction.status === "succeeded" || prediction.status === "failed") {
      return finish(creation, onChunk, false);
    }
    if (prediction.status === "canceled" || prediction.status === "cancelled") {
      return finish(creation, onChunk, true);
    }
    if (active.cancelled) {
      const canceled = await cancelRemotePrediction(prediction.id, request.credential);
      return finishCancellation(canceled, creation, onChunk);
    }

    const deadline = Date.now() + PREDICTION_TIMEOUT_MS;
    let delayMs = 500;
    let latest = creation;
    while (Date.now() < deadline) {
      await waitForNextPoll(delayMs, active);
      if (active.cancelled) {
        const canceled = await cancelRemotePrediction(prediction.id, request.credential);
        return finishCancellation(canceled, latest, onChunk);
      }
      const pollController = new AbortController();
      active.controller = pollController;
      const poll = await requestJson(
        `${REPLICATE_API_ROOT}/predictions/${prediction.id}`,
        "GET",
        request.credential,
        undefined,
        POLL_TIMEOUT_MS,
        pollController,
      );
      active.controller = null;
      if (poll.transportError || poll.status < 200 || poll.status >= 300 || !poll.complete) {
        if (active.cancelled) {
          const canceled = await cancelRemotePrediction(prediction.id, request.credential);
          return finishCancellation(canceled, latest, onChunk);
        }
        return finish(poll, onChunk, false, poll.transportError);
      }
      let current: { id: string; status: string };
      try {
        current = parsePrediction(poll.bytes, prediction.id);
      } catch (cause) {
        if (active.cancelled) {
          const canceled = await cancelRemotePrediction(prediction.id, request.credential);
          return finishCancellation(canceled, latest, onChunk, errorMessage(cause));
        }
        return finish(poll, onChunk, false, errorMessage(cause));
      }
      latest = poll;
      if (current.status === "succeeded" || current.status === "failed") {
        return finish(poll, onChunk, false);
      }
      if (current.status === "canceled" || current.status === "cancelled") {
        return finish(poll, onChunk, true);
      }
      if (active.cancelled) {
        const canceled = await cancelRemotePrediction(prediction.id, request.credential);
        return finishCancellation(canceled, latest, onChunk);
      }
      delayMs = Math.min(delayMs + 500, 5000);
    }

    const canceled = await cancelRemotePrediction(prediction.id, request.credential);
    const timeoutResponse = canceled?.bytes.byteLength ? canceled : latest;
    return finish(
      timeoutResponse,
      onChunk,
      false,
      "Replicate prediction timed out after five minutes.",
      408,
    );
  } catch (cause) {
    if (active.cancelled && active.predictionId) {
      const canceled = await cancelRemotePrediction(active.predictionId, request.credential);
      return finishCancellation(canceled, emptyResult(), onChunk, errorMessage(cause));
    }
    if (cause instanceof Error && cause.name === "AbortError" && active.cancelled) {
      return finish(emptyResult(), onChunk, true);
    }
    return finish(emptyResult(), onChunk, false, errorMessage(cause));
  } finally {
    if (activeBrowserPrediction === active) activeBrowserPrediction = null;
  }
}

/** Fetch the selected model's public input schema without sending the study package. */
export async function inspectReplicateModel(
  request: AiModelInspectionRequest,
  onChunk: (chunk: Uint8Array) => void,
): Promise<AiTransportResult> {
  if (request.credentialStorage !== "encrypted-archive") {
    throw new Error(
      "Static browser model inspection requires a key saved in the encrypted archive.",
    );
  }
  validateCredential(request.credential);
  const endpoint = replicateModelMetadataEndpoint(request.model);
  const response = await requestJson(
    endpoint,
    "GET",
    request.credential,
    undefined,
    MODEL_INSPECTION_TIMEOUT_MS,
    null,
  );
  return finish(response, onChunk, false, response.transportError ?? undefined);
}

/** Abort polling immediately; if creation is still resolving, cancel once its ID is known. */
export async function cancelBrowserReplicatePrediction(): Promise<void> {
  const active = activeBrowserPrediction;
  if (!active) return;
  active.cancelled = true;
  active.controller?.abort();
}

export async function assertReviewedReplicateRequest(request: AiTransportRequest): Promise<void> {
  if (
    request.providerId !== "replicate" ||
    request.endpoint !== request.confirmedEndpoint ||
    request.endpoint !== replicatePredictionEndpoint(request.model) ||
    request.accept !== "application/json"
  ) {
    throw new Error("The Replicate request changed after review. Prepare it again.");
  }
  const bodyBytes = new TextEncoder().encode(request.requestBody);
  if (!bodyBytes.byteLength || bodyBytes.byteLength > MAX_REQUEST_BYTES) {
    throw new Error("The reviewed Replicate request is empty or exceeds the 8 MiB limit.");
  }
  if (
    !/^[a-f\d]{64}$/u.test(request.requestBodyHash) ||
    request.confirmedBodyHash !== request.requestBodyHash
  ) {
    throw new Error("The Replicate request hash changed after review.");
  }
  const actualHash = await sha256Hex(bodyBytes);
  if (actualHash !== request.requestBodyHash) {
    throw new Error("The Replicate request body changed after review.");
  }
  let body: unknown;
  try {
    body = JSON.parse(request.requestBody);
  } catch {
    throw new Error("The reviewed Replicate request is not valid JSON.");
  }
  if (
    !isObject(body) ||
    !isObject(body["input"]) ||
    Object.keys(body).length !== 2 ||
    typeof body["version"] !== "string" ||
    !body["version"].trim() ||
    body["version"].length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(body["version"])
  ) {
    throw new Error("The reviewed Replicate request has an unsupported input shape.");
  }
  const input = body["input"];
  const allowedInputFields = new Set([
    "prompt",
    "system_prompt",
    "max_new_tokens",
    "max_tokens",
    "max_output_tokens",
  ]);
  if (Object.keys(input).some((key) => !allowedInputFields.has(key))) {
    throw new Error("The reviewed Replicate request includes an unsupported model input.");
  }
  const tokenFields = ["max_new_tokens", "max_tokens", "max_output_tokens"];
  if (
    tokenFields.filter((field) => field in input).length > 1 ||
    tokenFields.some(
      (field) =>
        field in input &&
        (!Number.isSafeInteger(input[field]) ||
          Number(input[field]) < 1 ||
          Number(input[field]) > 1_000_000),
    )
  ) {
    throw new Error("The reviewed Replicate output-token input is invalid.");
  }
  const prompt = input["prompt"];
  if (typeof prompt !== "string" || !prompt.trim() || byteLength(prompt) > MAX_RESPONSE_BYTES) {
    throw new Error("The reviewed Replicate prompt is empty or exceeds the 8 MiB limit.");
  }
  if (
    "system_prompt" in input &&
    (typeof input["system_prompt"] !== "string" ||
      byteLength(input["system_prompt"]) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error("The reviewed Replicate system prompt is invalid or exceeds the 8 MiB limit.");
  }
}

export function replicatePredictionEndpoint(model: string): string {
  splitReplicateModelId(model);
  return `${REPLICATE_API_ROOT}/predictions`;
}

export function replicateModelMetadataEndpoint(model: string): string {
  const [owner, name] = splitReplicateModelId(model);
  return `${REPLICATE_API_ROOT}/models/${owner}/${name}`;
}

function splitReplicateModelId(model: string): [string, string] {
  const match = /^([A-Za-z0-9_.-]{1,128})\/([A-Za-z0-9_.-]{1,128})$/u.exec(model);
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw new Error("Replicate models must use the owner/model form from the public catalog.");
  }
  const [, owner, name] = match;
  if (!owner || !name) {
    throw new Error("Replicate models must use the owner/model form from the public catalog.");
  }
  return [owner, name];
}

async function requestJson(
  endpoint: string,
  method: "GET" | "POST",
  credential: string,
  body: string | undefined,
  timeoutMs: number,
  activeController: AbortController | null,
): Promise<BoundedResponse> {
  const controller = activeController ?? new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential}`,
        ...(method === "POST" && endpoint.endsWith("/predictions") ? { Prefer: "wait=60" } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    const contentType =
      (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const bytes = await readBoundedBody(response, controller.signal);
    return {
      status: response.status,
      contentType,
      bytes: bytes.bytes,
      complete: bytes.complete,
      transportError: null,
    };
  } catch (cause) {
    if (activeController?.signal.aborted) {
      return { ...emptyResult(), transportError: "Replicate polling was canceled." };
    }
    return {
      ...emptyResult(),
      transportError:
        cause instanceof Error && cause.name === "AbortError"
          ? "Replicate request timed out."
          : "The Replicate request could not be completed. Check the connection and browser CORS settings, or use Tutorux for desktop.",
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

interface BoundedResponse {
  status: number;
  contentType: string;
  bytes: Uint8Array;
  complete: boolean;
  transportError: string | null;
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; complete: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), complete: true };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = true;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      const allowed = MAX_RESPONSE_BYTES - total;
      const count = Math.min(allowed, result.value.byteLength);
      if (count > 0) {
        chunks.push(result.value.subarray(0, count).slice());
        total += count;
      }
      if (count !== result.value.byteLength) {
        complete = false;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, complete };
}

async function cancelRemotePrediction(
  predictionId: string,
  credential: string,
): Promise<BoundedResponse | null> {
  if (!isPredictionId(predictionId)) return null;
  return requestJson(
    `${REPLICATE_API_ROOT}/predictions/${predictionId}/cancel`,
    "POST",
    credential,
    "{}",
    CANCEL_TIMEOUT_MS,
    null,
  );
}

function parsePrediction(
  bytes: Uint8Array,
  expectedId?: string,
): {
  id: string;
  status: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Replicate returned an invalid prediction response.");
  }
  if (
    !isObject(value) ||
    !isPredictionId(value["id"]) ||
    typeof value["status"] !== "string" ||
    value["status"].length > 64
  ) {
    throw new Error("Replicate returned an invalid prediction response.");
  }
  if (expectedId && value["id"] !== expectedId) {
    throw new Error("Replicate returned a prediction that did not match this request.");
  }
  return { id: value["id"], status: value["status"] };
}

async function waitForNextPoll(delayMs: number, active: ActiveBrowserPrediction): Promise<void> {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    if (active.cancelled) return;
    await new Promise((resolve) =>
      window.setTimeout(resolve, Math.min(100, deadline - Date.now())),
    );
  }
}

function finish(
  response: BoundedResponse,
  onChunk: (chunk: Uint8Array) => void,
  cancelled: boolean,
  errorMessage?: string,
  statusOverride?: number,
): AiTransportResult {
  if (response.bytes.byteLength > 0) onChunk(response.bytes);
  const effectiveError = errorMessage ?? response.transportError ?? undefined;
  return {
    status: statusOverride ?? response.status,
    contentType: response.contentType || "application/json",
    responseBytes: response.bytes.byteLength,
    complete: response.complete,
    cancelled,
    ...(effectiveError ? { errorMessage: effectiveError } : {}),
  };
}

function finishCancellation(
  response: BoundedResponse | null,
  fallback: BoundedResponse,
  onChunk: (chunk: Uint8Array) => void,
  originalError?: string,
): AiTransportResult {
  const confirmed =
    !!response && response.status >= 200 && response.status < 300 && response.complete;
  const responseToSave =
    response && response.bytes.byteLength > 0
      ? response
      : response
        ? {
            ...response,
            contentType: fallback.contentType,
            bytes: fallback.bytes,
            complete: fallback.complete,
          }
        : fallback;
  return finish(
    responseToSave,
    onChunk,
    confirmed,
    confirmed
      ? undefined
      : (originalError ??
          response?.transportError ??
          "Replicate did not confirm prediction cancellation. The latest response was saved for review."),
  );
}

function emptyResult(): BoundedResponse {
  return {
    status: 0,
    contentType: "application/json",
    bytes: new Uint8Array(),
    complete: false,
    transportError: null,
  };
}

function validateCredential(credential: string): void {
  if (!credential || byteLength(credential) > MAX_CREDENTIAL_BYTES || /\s/u.test(credential)) {
    throw new Error("The saved Replicate API token is missing or invalid.");
  }
}

function isPredictionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9-]+$/u.test(value)
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The Replicate request could not be completed.";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stableBytes = bytes.slice();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
