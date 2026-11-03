import { describe, expect, it } from "vitest";
import {
    AI_MODEL_CATALOG_TTL_SECONDS,
    aiModelProtocolFamily,
    buildAiModelCatalogRow,
    capabilityStatus,
    catalogAgeSeconds,
    catalogFreshness,
    streamingCapability,
    structuredOutputCapability,
    withCatalogFreshness,
} from "../../../frontend/ai/catalog-metadata";

describe("AI model catalog metadata", () => {
    it("keeps the legacy fields and marks a fresh model catalog", () => {
        const nowUs = 1_000_000_000;
        const row = buildAiModelCatalogRow(
            {
                providerId: "openai",
                modelId: "gpt-4.1",
                owner: "OpenAI",
                contextWindow: 1_047_576,
                maximumOutputTokens: 32_768,
                inputModalities: ["text", "image"],
                outputModalities: ["text"],
                structuredOutputSupport: "supported",
                streamingSupport: "supported",
                toolSupport: true,
                tokenizer: "o200k_base",
                inputCost: 2,
                outputCost: 8,
                availabilityStatus: "available",
                metadataSource: "models.dev",
                catalogSource: "models.dev",
                discoveredAtUs: String(nowUs),
            },
            String(nowUs),
            nowUs,
        );

        expect(row).toMatchObject({
            provider_id: "openai",
            model_id: "gpt-4.1",
            owner: "OpenAI",
            catalog_state: "listed",
            capabilities: "structured=supported;streaming=supported;tools=supported",
            protocol_family: "openai-chat-completions",
            context_window: "1047576",
            maximum_output_tokens: "32768",
            input_modalities: "text,image",
            output_modalities: "text",
            structured_output_support: "supported",
            streaming_support: "supported",
            tool_support: "supported",
            tokenizer_information: "o200k_base",
            pricing_information: "input=2;output=8",
            availability_status: "available",
            verification_status: "unverified",
            metadata_source: "models.dev",
            catalog_source: "models.dev",
            catalog_freshness: "fresh",
            catalog_age_seconds: "0",
            catalog_ttl_seconds: String(AI_MODEL_CATALOG_TTL_SECONDS),
            catalog_status: "fresh",
            catalog_refresh_source: "models.dev",
        });
    });

    it("expires cached catalog rows after the TTL", () => {
        const checkedAtUs = 1_000_000_000;
        const nowUs = checkedAtUs + (AI_MODEL_CATALOG_TTL_SECONDS + 1) * 1_000_000;
        expect(catalogAgeSeconds(String(checkedAtUs), nowUs)).toBe(
            AI_MODEL_CATALOG_TTL_SECONDS + 1,
        );
        expect(catalogFreshness(String(checkedAtUs), nowUs)).toBe("stale");
        expect(catalogFreshness("0", nowUs)).toBe("unavailable");
    });

    it("only advertises structured output for protocols that can enforce it", () => {
        expect(structuredOutputCapability("openai")).toBe("supported");
        expect(structuredOutputCapability("ollama")).toBe("supported");
        expect(structuredOutputCapability("google-gemini")).toBe("supported");
        expect(structuredOutputCapability("opencode-zen", "gpt-5")).toBe("supported");
        expect(structuredOutputCapability("opencode-zen", "claude-sonnet-4")).toBe("unsupported");
        expect(structuredOutputCapability("anthropic")).toBe("unknown");
    });

    it("maps tri-state capability values and streaming support", () => {
        expect(capabilityStatus(true)).toBe("supported");
        expect(capabilityStatus(false)).toBe("unsupported");
        expect(capabilityStatus(null)).toBe("unknown");
        expect(capabilityStatus(undefined)).toBe("unknown");

        expect(streamingCapability("replicate")).toBe("unsupported");
        expect(streamingCapability("embedded-gguf")).toBe("unsupported");
        expect(streamingCapability("openai")).toBe("supported");
    });

    it("classifies every OpenCode Zen protocol and falls back for unknown providers", () => {
        expect(structuredOutputCapability("openai-compatible")).toBe("supported");
        expect(structuredOutputCapability("opencode-zen", "jev-1")).toBe("unsupported");
        expect(structuredOutputCapability("opencode-zen", "gpt-5")).toBe("supported");
        expect(structuredOutputCapability("opencode-zen", "gemini-2.5")).toBe("supported");

        expect(aiModelProtocolFamily("opencode-zen", "jev-1")).toBe(
            "systemone-structured-classification",
        );
        expect(aiModelProtocolFamily("opencode-zen", "gpt-5")).toBe("openai-responses");
        expect(aiModelProtocolFamily("opencode-zen", "claude-sonnet-4")).toBe("anthropic-messages");
        expect(aiModelProtocolFamily("opencode-zen", "gemini-2.5")).toBe("gemini-generate-content");
        expect(aiModelProtocolFamily("opencode-zen", "llama-3")).toBe("openai-chat-completions");
        expect(aiModelProtocolFamily("openai")).toBe("openai-chat-completions");
        expect(aiModelProtocolFamily("openai-compatible")).toBe("openai-chat-completions");
        expect(aiModelProtocolFamily("anthropic")).toBe("anthropic-messages");
        expect(aiModelProtocolFamily("google-gemini")).toBe("gemini-generate-content");
        expect(aiModelProtocolFamily("cohere")).toBe("cohere-chat-v2");
        expect(aiModelProtocolFamily("perplexity")).toBe("perplexity-agent");
        expect(aiModelProtocolFamily("ollama")).toBe("ollama-chat");
        expect(aiModelProtocolFamily("replicate")).toBe("replicate-prediction-api");
        expect(aiModelProtocolFamily("cloudflare-workers-ai")).toBe(
            "cloudflare-workers-ai-openai-compatible",
        );
        expect(aiModelProtocolFamily("embedded-gguf")).toBe("embedded-gguf-runtime");
        expect(aiModelProtocolFamily("some-other-provider")).toBe("openai-chat-completions");
    });

    it("treats malformed or future timestamps as unavailable", () => {
        expect(catalogAgeSeconds("not-a-number")).toBe(AI_MODEL_CATALOG_TTL_SECONDS + 1);
        expect(catalogAgeSeconds("0")).toBe(AI_MODEL_CATALOG_TTL_SECONDS + 1);
        expect(catalogAgeSeconds("-5")).toBe(AI_MODEL_CATALOG_TTL_SECONDS + 1);
        expect(catalogAgeSeconds(String(2_000_000), 1_000_000)).toBe(
            AI_MODEL_CATALOG_TTL_SECONDS + 1,
        );
        expect(catalogAgeSeconds(String(1_500_000), 2_500_000)).toBe(1);

        expect(catalogFreshness("bogus")).toBe("unavailable");
        expect(catalogFreshness("0")).toBe("unavailable");
        expect(catalogFreshness(String(2_000_000), 1_000_000)).toBe("stale");
        expect(catalogFreshness(String(1_000_000), 1_500_000)).toBe("fresh");
    });

    it("fills defaults for a sparse catalog row", () => {
        const row = buildAiModelCatalogRow(
            { providerId: "ollama", modelId: "llama3" },
            "not-a-timestamp",
            1_000_000,
        );

        expect(row).toMatchObject({
            owner: "",
            catalog_state: "listed",
            capabilities: "structured=unknown;streaming=unknown;tools=unknown",
            protocol_family: "ollama-chat",
            context_window: "",
            maximum_output_tokens: "",
            input_modalities: "",
            output_modalities: "",
            tokenizer_information: "unknown",
            pricing_information: "unknown",
            availability_status: "listed",
            metadata_source: "provider-api",
            api_family: "ollama-chat",
            catalog_source: "provider-api",
            discovered_at_us: "not-a-timestamp",
            catalog_freshness: "unavailable",
            catalog_status: "unavailable",
            catalog_refresh_source: "provider-api",
        });
    });

    it("honours explicit overrides and individual pricing fields", () => {
        const checkedAtUs = "1000000";
        const nowUs = 1_500_000;
        const inputOnly = buildAiModelCatalogRow(
            {
                providerId: "openai",
                modelId: "gpt-4.1",
                structuredOutputSupport: "unsupported",
                streamingSupport: "supported",
                protocolFamily: "custom-protocol",
                toolSupport: null,
                tokenizer: "   ",
                inputCost: 0,
                outputCost: null,
                availabilityStatus: "   ",
                catalogState: "preview",
                contextWindow: 0,
                maximumOutputTokens: 1.5,
            },
            checkedAtUs,
            nowUs,
        );
        expect(inputOnly).toMatchObject({
            catalog_state: "preview",
            capabilities: "structured=unsupported;streaming=supported;tools=unknown",
            protocol_family: "custom-protocol",
            api_family: "custom-protocol",
            context_window: "",
            maximum_output_tokens: "",
            tokenizer_information: "unknown",
            pricing_information: "input=0",
            availability_status: "listed",
            catalog_freshness: "fresh",
            catalog_status: "fresh",
        });

        const outputOnly = buildAiModelCatalogRow(
            { providerId: "openai", modelId: "gpt-4.1", outputCost: 8 },
            checkedAtUs,
            nowUs,
        );
        expect(outputOnly.pricing_information).toBe("output=8");

        const stale = buildAiModelCatalogRow(
            { providerId: "openai", modelId: "gpt-4.1" },
            String(checkedAtUs),
            Number(checkedAtUs) + (AI_MODEL_CATALOG_TTL_SECONDS + 1) * 1_000_000,
        );
        expect(stale.catalog_freshness).toBe("stale");
        expect(stale.catalog_status).toBe("stale");
    });

    it("re-stamps freshness on an existing row", () => {
        const row = buildAiModelCatalogRow(
            { providerId: "openai", modelId: "gpt-4.1" },
            "1000000",
            1_000_000,
        );
        const updated = withCatalogFreshness(row, "4000000", 5_000_000);
        expect(updated.catalog_freshness).toBe("fresh");
        expect(updated.catalog_age_seconds).toBe("1");
        expect(updated.catalog_checked_at_us).toBe("4000000");
        expect(updated.model_id).toBe("gpt-4.1");
    });
});
