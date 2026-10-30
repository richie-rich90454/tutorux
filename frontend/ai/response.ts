import { newUuid } from "../archive/format";
import { GUIDE_BLOCK_KINDS, type GuideDraft } from "../domain/guides";
import {
    isEmbeddedGgufProvider,
    isOpenAiCompatibleProvider,
    openCodeZenProtocolForModel,
} from "./providers";

const MAX_RESPONSE_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_GUIDE_SECTIONS = 500;
const MAX_GUIDE_BLOCKS = 5000;
const MAX_GUIDE_BLOCK_TEXT_BYTES = 4 * 1024 * 1024;
export const AI_RESPONSE_PREVIEW_CHARACTER_LIMIT = 40_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const allowedKinds = new Set<string>(GUIDE_BLOCK_KINDS);

export interface AiGuideProposal {
    draft: GuideDraft;
    schemaValid: boolean;
    warnings: string[];
}

export interface AiExecutionSummary {
    jobId: string;
    status: string;
    providerName: string;
    model: string;
    guideId: string | null;
    schemaValid: boolean;
    sourceValidation: "passed" | "failed" | "missing-evidence" | "not-available";
    responseText: string;
    responseTextTruncated: boolean;
    responseBytes: number;
    warnings: string[];
}

export interface AiResponseMetadata {
    providerResponseId: string;
    errorCode: string;
    errorMessage: string;
    retryAfter: string;
}

const EMPTY_RESPONSE_METADATA: AiResponseMetadata = {
    providerResponseId: "",
    errorCode: "",
    errorMessage: "",
    retryAfter: "",
};

/** Read provider identifiers and error metadata without requiring a complete response. */
export function extractAiResponseMetadata(
    providerId: string,
    responseBytes: Uint8Array,
): AiResponseMetadata {
    let raw: string;
    try {
        raw = utf8.decode(responseBytes);
    } catch {
        return { ...EMPTY_RESPONSE_METADATA };
    }
    const metadata: AiResponseMetadata = { ...EMPTY_RESPONSE_METADATA };
    const visit = (value: unknown): void => {
        if (!isObject(value)) return;
        mergeResponseMetadata(metadata, value);
    };
    if (providerId === "ollama") {
        for (const line of raw.split(/\r?\n/u)) {
            if (!line.trim()) continue;
            visit(parseJsonSafely(line));
        }
        return metadata;
    }
    if (/^(?:event|data|id|retry|:)/mu.test(raw.trim())) {
        for (const block of raw.replaceAll("\r\n", "\n").split("\n\n")) {
            const payload = block
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice("data:".length).replace(/^ /u, ""))
                .join("\n");
            if (!payload || payload === "[DONE]") continue;
            visit(parseJsonSafely(payload));
        }
        return metadata;
    }
    visit(parseJsonSafely(raw));
    return metadata;
}

function parseJsonSafely(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function mergeResponseMetadata(target: AiResponseMetadata, value: Record<string, unknown>): void {
    if (!target.providerResponseId) {
        for (const candidate of [value["id"], value["responseId"], value["response_id"]]) {
            if (typeof candidate === "string" && candidate.trim()) {
                target.providerResponseId = candidate.trim();
                break;
            }
        }
    }
    if (!target.providerResponseId && isObject(value["response"])) {
        const nested = value["response"]["id"];
        if (typeof nested === "string" && nested.trim()) target.providerResponseId = nested.trim();
    }
    if (!target.providerResponseId && isObject(value["message"])) {
        const nested = value["message"]["id"];
        if (typeof nested === "string" && nested.trim()) target.providerResponseId = nested.trim();
    }
    const error = value["error"];
    if (isObject(error)) {
        if (!target.errorCode) {
            const code = error["code"] ?? error["type"] ?? error["status"];
            if (typeof code === "string" || typeof code === "number") {
                target.errorCode = String(code);
            }
        }
        if (!target.errorMessage && typeof error["message"] === "string") {
            target.errorMessage = error["message"];
        }
        if (!target.retryAfter) {
            const retry = error["retry_after"] ?? error["retryAfter"];
            if (typeof retry === "string" || typeof retry === "number") {
                target.retryAfter = String(retry);
            }
        }
    } else if (typeof error === "string" && error) {
        if (!target.errorMessage) target.errorMessage = error;
    }
    if (!target.errorCode && value["type"] === "error" && typeof value["code"] === "string") {
        target.errorCode = value["code"];
    }
    if (!target.errorMessage && value["type"] === "error" && typeof value["message"] === "string") {
        target.errorMessage = value["message"];
    }
    if (!target.retryAfter) {
        const retry = value["retry_after"] ?? value["retryAfter"];
        if (typeof retry === "string" || typeof retry === "number") {
            target.retryAfter = String(retry);
        }
    }
}

/** Extract generated text from the provider's bounded streaming response bytes. */
export function extractAiResponseText(
    providerId: string,
    responseBytes: Uint8Array,
    model = "",
    allowPartial = false,
): string {
    if (responseBytes.byteLength === 0 || responseBytes.byteLength > MAX_RESPONSE_TEXT_BYTES) {
        throw new Error("The provider returned an empty or oversized response.");
    }
    let raw: string;
    try {
        raw = utf8.decode(responseBytes);
    } catch {
        throw new Error("The provider response was not valid UTF-8.");
    }
    const trimmed = raw.trim();
    if (!trimmed) throw new Error("The provider returned no generated text.");
    if (providerId === "replicate") return collectReplicatePrediction(raw);
    if (providerId === "ollama") return collectOllama(raw, allowPartial);
    if (/^(?:event|data|id|retry|:)/mu.test(trimmed)) {
        return collectEventStream(providerId, raw, model, allowPartial);
    }
    return collectJsonResponse(providerId, parseJson(raw), model);
}

function collectReplicatePrediction(raw: string): string {
    const prediction = parseJson(raw);
    assertJsonDepth(prediction, 0);
    if (prediction["status"] !== "succeeded") {
        if (prediction["status"] === "failed") {
            throw new Error(
                "The Replicate prediction failed. Its raw response was saved for export.",
            );
        }
        throw new Error("The Replicate prediction did not finish successfully.");
    }
    const output = prediction["output"];
    let text: string;
    if (typeof output === "string") {
        text = output;
    } else if (Array.isArray(output) && output.every((part) => typeof part === "string")) {
        text = output.join("");
    } else {
        throw new Error("Replicate returned a non-text prediction output.");
    }
    if (!text.trim()) throw new Error("Replicate returned no generated text.");
    if (encoder.encode(text).byteLength > MAX_RESPONSE_TEXT_BYTES) {
        throw new Error("The generated text exceeded the 16 MiB safety limit.");
    }
    return text;
}

/** Turn a model's structured response into an unapproved guide draft or a safe text fallback. */
export function createAiGuideProposal(
    responseText: string,
    sessionId: string,
    expectedTemplateId: string,
): AiGuideProposal {
    const fallback = (warning: string): AiGuideProposal => ({
        draft: {
            title: "AI response — review required",
            sessionId,
            templateId: expectedTemplateId,
            sections: [
                {
                    id: newUuid(),
                    heading: "Unstructured response — review required",
                    blocks: [
                        {
                            kind: "paragraph",
                            text: responseText,
                            sourceIds: "",
                            stale: false,
                            origin: "ai-generated",
                        },
                    ],
                },
            ],
        },
        schemaValid: false,
        warnings: [warning],
    });

    const jsonText = stripCodeFence(responseText.trim());
    let value: unknown;
    try {
        value = JSON.parse(jsonText);
        assertJsonDepth(value, 0);
    } catch {
        return fallback(
            "The response did not match the guide JSON schema; it was kept as editable text.",
        );
    }
    if (!isObject(value)) {
        return fallback(
            "The response did not contain a guide object; it was kept as editable text.",
        );
    }
    const title = value["title"];
    const templateId = value["template_id"];
    const sections = value["sections"];
    if (
        typeof title !== "string" ||
        !title ||
        encoder.encode(title).byteLength > 1024 ||
        typeof templateId !== "string" ||
        !templateId ||
        encoder.encode(templateId).byteLength > 128 ||
        !Array.isArray(sections) ||
        sections.length === 0 ||
        sections.length > MAX_GUIDE_SECTIONS
    ) {
        return fallback(
            "The response did not match the guide JSON schema; it was kept as editable text.",
        );
    }

    const warnings: string[] = [];
    if (templateId !== expectedTemplateId) {
        warnings.push(
            "The response named a different guide template; Tutorux kept the selected template.",
        );
    }
    let totalBlocks = 0;
    const draftSections: GuideDraft["sections"] = [];
    for (const section of sections) {
        if (!isObject(section)) {
            return fallback(
                "The response contained an invalid guide section and was kept as editable text.",
            );
        }
        const heading = section["heading"];
        const blocks = section["blocks"];
        if (
            typeof heading !== "string" ||
            !heading ||
            encoder.encode(heading).byteLength > 2048 ||
            !Array.isArray(blocks) ||
            (totalBlocks += blocks.length) > MAX_GUIDE_BLOCKS
        ) {
            return fallback(
                "The response contained invalid guide sections and was kept as editable text.",
            );
        }
        const draftBlocks: GuideDraft["sections"][number]["blocks"] = [];
        for (const block of blocks) {
            if (!isObject(block)) {
                return fallback(
                    "The response contained an invalid guide block and was kept as editable text.",
                );
            }
            const kind = block["kind"];
            const text = block["text"];
            const sourceIds = block["source_ids"];
            if (
                typeof kind !== "string" ||
                !allowedKinds.has(kind) ||
                typeof text !== "string" ||
                encoder.encode(text).byteLength > MAX_GUIDE_BLOCK_TEXT_BYTES ||
                !Array.isArray(sourceIds) ||
                sourceIds.length > 500 ||
                sourceIds.some((id) => typeof id !== "string")
            ) {
                return fallback(
                    "The response contained invalid guide blocks and was kept as editable text.",
                );
            }
            draftBlocks.push({
                kind: kind as GuideDraft["sections"][number]["blocks"][number]["kind"],
                text,
                sourceIds: (sourceIds as string[]).join(","),
                stale: false,
                origin: "ai-generated",
            });
        }
        draftSections.push({ id: newUuid(), heading, blocks: draftBlocks });
    }
    return {
        draft: { title, sessionId, templateId: expectedTemplateId, sections: draftSections },
        schemaValid: true,
        warnings,
    };
}

function collectEventStream(
    providerId: string,
    raw: string,
    model: string,
    allowPartial: boolean,
): string {
    const collected: string[] = [];
    let totalTextBytes = 0;
    for (const block of raw.replaceAll("\r\n", "\n").split("\n\n")) {
        const lines = block.split("\n");
        const eventName = lines
            .find((line) => line.startsWith("event:"))
            ?.slice("event:".length)
            .trim();
        const payload = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).replace(/^ /u, ""))
            .join("\n");
        if (!payload || payload === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
            event = parseJson(payload);
        } catch (cause) {
            if (allowPartial) continue;
            throw cause;
        }
        const eventType = typeof event["type"] === "string" ? event["type"] : eventName;
        if (
            (event["error"] !== undefined && event["error"] !== null) ||
            eventType === "error" ||
            eventType === "response.failed"
        ) {
            throw new Error("The provider reported an error while generating the response.");
        }
        const text = extractStreamDelta(providerId, event, eventType, false, model);
        if (text) {
            totalTextBytes += encoder.encode(text).byteLength;
            collected.push(text);
        }
        if (totalTextBytes > MAX_RESPONSE_TEXT_BYTES) {
            throw new Error("The generated text exceeded the 16 MiB safety limit.");
        }
    }
    const result = collected.join("");
    if (!result.trim()) throw new Error("The provider returned no generated text.");
    return result;
}

function collectOllama(raw: string, allowPartial = false): string {
    const collected: string[] = [];
    for (const line of raw.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
            event = parseJson(line);
        } catch (cause) {
            if (allowPartial) continue;
            throw cause;
        }
        if (event["error"] !== undefined && event["error"] !== null) {
            throw new Error("The local model reported an error while generating the response.");
        }
        const message = isObject(event["message"]) ? event["message"] : undefined;
        const text = message && typeof message["content"] === "string" ? message["content"] : "";
        if (text) collected.push(text);
    }
    const result = collected.join("");
    if (!result.trim()) throw new Error("The provider returned no generated text.");
    return result;
}

function collectJsonResponse(
    providerId: string,
    event: Record<string, unknown>,
    model: string,
): string {
    if (event["error"] !== undefined && event["error"] !== null) {
        throw new Error("The provider reported an error while generating the response.");
    }
    const text = extractStreamDelta(providerId, event, undefined, true, model);
    if (!text.trim()) throw new Error("The provider returned no generated text.");
    return text;
}

function extractStreamDelta(
    providerId: string,
    event: Record<string, unknown>,
    eventType: string | undefined,
    fullResponse = false,
    model = "",
): string {
    const openCodeProtocol =
        providerId === "opencode-zen" ? openCodeZenProtocolForModel(model) : undefined;
    if (
        isOpenAiCompatibleProvider(providerId) ||
        isEmbeddedGgufProvider(providerId) ||
        (providerId === "opencode-zen" && openCodeProtocol === "openai-chat")
    ) {
        const choices = Array.isArray(event["choices"]) ? event["choices"] : [];
        const choice = choices[0];
        if (!isObject(choice)) return "";
        const message = fullResponse ? choice["message"] : choice["delta"];
        return isObject(message) ? textContent(message["content"]) : "";
    }
    if (
        providerId === "anthropic" ||
        (providerId === "opencode-zen" && openCodeProtocol === "anthropic")
    ) {
        if (eventType && eventType !== "content_block_delta" && eventType !== "message") return "";
        const delta = event["delta"];
        if (isObject(delta) && typeof delta["text"] === "string") return delta["text"];
        return fullResponse ? collectTextArray(event["content"]) : "";
    }
    if (
        providerId === "google-gemini" ||
        (providerId === "opencode-zen" && openCodeProtocol === "gemini")
    ) {
        const candidates = Array.isArray(event["candidates"]) ? event["candidates"] : [];
        const candidate = candidates[0];
        if (!isObject(candidate)) return "";
        const content = candidate["content"];
        return isObject(content) ? collectTextArray(content["parts"]) : "";
    }
    if (providerId === "cohere") {
        if (eventType === "content-delta") {
            const delta = event["delta"];
            if (isObject(delta) && isObject(delta["message"])) {
                const content = delta["message"]["content"];
                return isObject(content) && typeof content["text"] === "string"
                    ? content["text"]
                    : "";
            }
        }
        const message = event["message"];
        return fullResponse && isObject(message) ? collectTextArray(message["content"]) : "";
    }
    if (
        providerId === "perplexity" ||
        (providerId === "opencode-zen" && openCodeProtocol === "openai-responses")
    ) {
        if (eventType === "response.output_text.delta" && typeof event["delta"] === "string") {
            return event["delta"];
        }
        if (fullResponse && Array.isArray(event["output"])) {
            return event["output"]
                .map((item) => (isObject(item) ? collectTextArray(item["content"]) : ""))
                .join("");
        }
    }
    if (providerId === "ollama") {
        const message = event["message"];
        return isObject(message) && typeof message["content"] === "string"
            ? message["content"]
            : "";
    }
    return "";
}

function collectTextArray(value: unknown): string {
    if (!Array.isArray(value)) return "";
    return value
        .map((item) => {
            if (!isObject(item)) return "";
            if (typeof item["text"] === "string") return item["text"];
            return "";
        })
        .join("");
}

function textContent(value: unknown): string {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value
        .map((item) => (isObject(item) && typeof item["text"] === "string" ? item["text"] : ""))
        .join("");
}

function parseJson(value: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("The provider response contained invalid JSON data.");
    }
    if (!isObject(parsed)) throw new Error("The provider response data was not a JSON object.");
    return parsed;
}

function stripCodeFence(value: string): string {
    if (!value.startsWith("```")) return value;
    const firstLine = value.indexOf("\n");
    const lastFence = value.lastIndexOf("```");
    return firstLine >= 0 && lastFence > firstLine
        ? value.slice(firstLine + 1, lastFence).trim()
        : value;
}

function assertJsonDepth(value: unknown, depth: number): void {
    if (depth > 32) throw new Error("Response JSON nesting is too deep.");
    if (Array.isArray(value)) {
        for (const item of value) assertJsonDepth(item, depth + 1);
    } else if (isObject(value)) {
        for (const item of Object.values(value)) assertJsonDepth(item, depth + 1);
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
