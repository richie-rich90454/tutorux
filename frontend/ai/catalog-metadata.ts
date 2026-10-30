import { openCodeZenProtocolForModel, type OpenCodeZenProtocol } from "./providers";

export const AI_MODEL_CATALOG_TTL_SECONDS = 60 * 60;

export type AiCapabilityStatus = "supported" | "unsupported" | "unknown";
export type AiCatalogFreshness = "fresh" | "stale" | "unavailable";

export interface AiModelCatalogRow {
    provider_id: string;
    model_id: string;
    owner: string;
    catalog_state: string;
    capabilities: string;
    protocol_family: string;
    context_window: string;
    maximum_output_tokens: string;
    input_modalities: string;
    output_modalities: string;
    structured_output_support: AiCapabilityStatus;
    streaming_support: AiCapabilityStatus;
    tool_support: AiCapabilityStatus;
    tokenizer_information: string;
    pricing_information: string;
    availability_status: string;
    verification_status: string;
    metadata_source: string;
    api_family: string;
    catalog_source: string;
    discovered_at_us: string;
    catalog_freshness: string;
    catalog_age_seconds: string;
    catalog_checked_at_us: string;
    catalog_ttl_seconds: string;
    catalog_status: string;
    catalog_refresh_source: string;
    [key: string]: string;
}

export interface AiModelCatalogMetadata {
    providerId: string;
    modelId: string;
    owner?: string;
    catalogState?: string;
    protocolFamily?: string;
    contextWindow?: number | null;
    maximumOutputTokens?: number | null;
    inputModalities?: readonly string[];
    outputModalities?: readonly string[];
    structuredOutputSupport?: AiCapabilityStatus;
    streamingSupport?: AiCapabilityStatus;
    toolSupport?: boolean | null;
    tokenizer?: string | null;
    inputCost?: number | null;
    outputCost?: number | null;
    availabilityStatus?: string;
    metadataSource?: string;
    catalogSource?: string;
    discoveredAtUs?: string;
}

export function capabilityStatus(value: boolean | null | undefined): AiCapabilityStatus {
    return value === true ? "supported" : value === false ? "unsupported" : "unknown";
}

export function structuredOutputCapability(providerId: string, model = ""): AiCapabilityStatus {
    if (
        providerId === "openai" ||
        providerId === "openai-compatible" ||
        providerId === "ollama" ||
        providerId === "google-gemini"
    ) {
        return "supported";
    }
    if (providerId === "opencode-zen") {
        if (model.startsWith("jev-")) return "unsupported";
        try {
            return openCodeZenProtocolForModel(model) === "anthropic" ? "unsupported" : "supported";
        } catch {
            return "unknown";
        }
    }
    return "unknown";
}

export function streamingCapability(providerId: string): AiCapabilityStatus {
    if (providerId === "replicate" || providerId === "embedded-gguf") return "unsupported";
    return "supported";
}

export function aiModelProtocolFamily(providerId: string, model = ""): string {
    if (providerId === "opencode-zen") {
        if (model.startsWith("jev-")) return "systemone-structured-classification";
        try {
            return openCodeZenProtocolFamily(openCodeZenProtocolForModel(model));
        } catch {
            return "unsupported";
        }
    }
    switch (providerId) {
        case "openai":
        case "openai-compatible":
            return "openai-chat-completions";
        case "anthropic":
            return "anthropic-messages";
        case "google-gemini":
            return "gemini-generate-content";
        case "cohere":
            return "cohere-chat-v2";
        case "perplexity":
            return "perplexity-agent";
        case "ollama":
            return "ollama-chat";
        case "replicate":
            return "replicate-prediction-api";
        case "cloudflare-workers-ai":
            return "cloudflare-workers-ai-openai-compatible";
        case "embedded-gguf":
            return "embedded-gguf-runtime";
        default:
            return "openai-chat-completions";
    }
}

function openCodeZenProtocolFamily(protocol: OpenCodeZenProtocol): string {
    switch (protocol) {
        case "openai-responses":
            return "openai-responses";
        case "anthropic":
            return "anthropic-messages";
        case "gemini":
            return "gemini-generate-content";
        default:
            return "openai-chat-completions";
    }
}

export function catalogAgeSeconds(checkedAtUs: string, nowUs = Date.now() * 1000): number {
    const checked = Number(checkedAtUs);
    if (!Number.isSafeInteger(checked) || checked <= 0 || checked > nowUs) {
        return AI_MODEL_CATALOG_TTL_SECONDS + 1;
    }
    return Math.floor((nowUs - checked) / 1_000_000);
}

export function catalogFreshness(
    checkedAtUs: string,
    nowUs = Date.now() * 1000,
): AiCatalogFreshness {
    const checked = Number(checkedAtUs);
    if (!Number.isSafeInteger(checked) || checked <= 0) return "unavailable";
    return catalogAgeSeconds(checkedAtUs, nowUs) <= AI_MODEL_CATALOG_TTL_SECONDS
        ? "fresh"
        : "stale";
}

export function buildAiModelCatalogRow(
    metadata: AiModelCatalogMetadata,
    checkedAtUs: string,
    nowUs = Date.now() * 1000,
): AiModelCatalogRow {
    const structured = metadata.structuredOutputSupport ?? "unknown";
    const streaming = metadata.streamingSupport ?? "unknown";
    const tools = capabilityStatus(metadata.toolSupport);
    const protocolFamily =
        metadata.protocolFamily ?? aiModelProtocolFamily(metadata.providerId, metadata.modelId);
    const freshness = catalogFreshness(checkedAtUs, nowUs);
    const row: AiModelCatalogRow = {
        provider_id: metadata.providerId,
        model_id: metadata.modelId,
        owner: metadata.owner ?? "",
        catalog_state: metadata.catalogState ?? "listed",
        capabilities: `structured=${structured};streaming=${streaming};tools=${tools}`,
        protocol_family: protocolFamily,
        context_window: positiveIntegerText(metadata.contextWindow),
        maximum_output_tokens: positiveIntegerText(metadata.maximumOutputTokens),
        input_modalities: (metadata.inputModalities ?? []).join(","),
        output_modalities: (metadata.outputModalities ?? []).join(","),
        structured_output_support: structured,
        streaming_support: streaming,
        tool_support: tools,
        tokenizer_information: metadata.tokenizer?.trim() || "unknown",
        pricing_information: pricingInformation(metadata),
        availability_status: metadata.availabilityStatus?.trim() || "listed",
        verification_status: "unverified",
        metadata_source: metadata.metadataSource ?? "provider-api",
        api_family: protocolFamily,
        catalog_source: metadata.catalogSource ?? "provider-api",
        discovered_at_us: metadata.discoveredAtUs ?? checkedAtUs,
        catalog_freshness: freshness,
        catalog_age_seconds: catalogAgeSeconds(checkedAtUs, nowUs).toString(),
        catalog_checked_at_us: checkedAtUs,
        catalog_ttl_seconds: AI_MODEL_CATALOG_TTL_SECONDS.toString(),
        catalog_status: freshness === "fresh" ? "fresh" : freshness,
        catalog_refresh_source: metadata.catalogSource ?? "provider-api",
    };
    return row;
}

export function withCatalogFreshness(
    row: AiModelCatalogRow,
    checkedAtUs: string,
    nowUs = Date.now() * 1000,
): AiModelCatalogRow {
    return {
        ...row,
        catalog_freshness: catalogFreshness(checkedAtUs, nowUs),
        catalog_age_seconds: catalogAgeSeconds(checkedAtUs, nowUs).toString(),
        catalog_checked_at_us: checkedAtUs,
        catalog_ttl_seconds: AI_MODEL_CATALOG_TTL_SECONDS.toString(),
    };
}

function positiveIntegerText(value: number | null | undefined): string {
    return Number.isSafeInteger(value) && value! > 0 ? value!.toString() : "";
}

function pricingInformation(metadata: AiModelCatalogMetadata): string {
    const parts: string[] = [];
    if (metadata.inputCost !== null && metadata.inputCost !== undefined) {
        parts.push(`input=${metadata.inputCost}`);
    }
    if (metadata.outputCost !== null && metadata.outputCost !== undefined) {
        parts.push(`output=${metadata.outputCost}`);
    }
    return parts.length ? parts.join(";") : "unknown";
}
