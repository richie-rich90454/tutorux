import { describe, expect, it } from "vitest";
import {
  AI_MODEL_CATALOG_TTL_SECONDS,
  buildAiModelCatalogRow,
  catalogAgeSeconds,
  catalogFreshness,
  structuredOutputCapability,
} from "./catalog-metadata";

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
    expect(catalogAgeSeconds(String(checkedAtUs), nowUs)).toBe(AI_MODEL_CATALOG_TTL_SECONDS + 1);
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
});
