import { describe, expect, it } from "vitest";
import {
    AI_PROVIDERS,
    aiProviderCatalogStatus,
    createProviderConfigurationRecord,
    createProviderCredentialRecord,
    isEmbeddedGgufProvider,
    isOpenAiCompatibleProvider,
    maskCredentialMetadata,
    openCodeZenProtocolForModel,
    providerAuthenticationHeaderName,
    providerById,
    usesAnthropicVersionHeader,
    validateProviderEndpoint,
} from "../../../frontend/ai/providers";

describe("AI provider settings", () => {
    it("creates a legacy-compatible provider record with a stable ID", async () => {
        const first = await createProviderConfigurationRecord(
            { providerId: "openai", endpoint: "https://api.openai.com/v1/", model: "gpt-4.1" },
            123,
        );
        const second = await createProviderConfigurationRecord(
            { providerId: "openai", endpoint: "https://api.openai.com/v1", model: "gpt-4.1" },
            123,
        );

        expect(first.id).toBe(second.id);
        expect(first.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(first.fields).toEqual(
            new Map([
                ["record_role", "ai-provider"],
                ["provider_id", "openai"],
                ["endpoint", "https://api.openai.com/v1"],
                ["selected_model", "gpt-4.1"],
                ["configured_at_us", "123000"],
                ["credential_storage", "memory-only"],
            ]),
        );
    });

    it("requires secure endpoints for cloud providers and loopback HTTP for local models", async () => {
        await expect(
            createProviderConfigurationRecord({
                providerId: "openai",
                endpoint: "http://api.example.com/v1",
                model: "model-1",
            }),
        ).rejects.toThrow("Cloud provider endpoints must use HTTPS.");
        await expect(
            createProviderConfigurationRecord({
                providerId: "ollama",
                endpoint: "http://192.168.1.4:11434",
                model: "llama3",
            }),
        ).rejects.toThrow("Local model endpoints must use HTTP on localhost, 127.0.0.1, or ::1.");
        await expect(
            createProviderConfigurationRecord({
                providerId: "ollama",
                endpoint: "http://127.0.0.1:11434",
                model: "llama3",
            }),
        ).resolves.toMatchObject({ type: 11 });
    });

    it("rejects endpoint credentials and query parameters", async () => {
        for (const endpoint of [
            "https://user:secret@example.com/v1",
            "https://example.com/v1?api_key=secret",
            "https://example.com/v1#fragment",
        ]) {
            await expect(
                createProviderConfigurationRecord({
                    providerId: "openai-compatible",
                    endpoint,
                    model: "model-1",
                }),
            ).rejects.toThrow(
                "Endpoint URLs cannot contain credentials, query parameters, or fragments.",
            );
        }
    });

    it("requires an encrypted archive before creating an API credential record", async () => {
        await expect(createProviderCredentialRecord("openai", "sk-example", false)).rejects.toThrow(
            "API keys can only be saved inside an encrypted archive.",
        );
        await expect(createProviderCredentialRecord("ollama", "sk-example", true)).rejects.toThrow(
            "This local provider does not need an API key.",
        );
        await expect(createProviderCredentialRecord("openai", "  ", true)).rejects.toThrow(
            "API key is required.",
        );
        await expect(createProviderCredentialRecord("openai", "sk example", true)).rejects.toThrow(
            "API key cannot contain whitespace.",
        );
    });

    it("stores credentials in a separate deterministic encrypted record and masks list metadata", async () => {
        const first = await createProviderCredentialRecord("openai", "sk-example-value", true, 321);
        const second = await createProviderCredentialRecord("openai", "sk-other-value", true, 321);
        expect(first.id).toBe(second.id);
        expect(first.fields.get("record_role")).toBe("credential");
        expect(first.fields.get("key")).toBe("OPENAI_API_KEY");
        expect(first.fields.get("provider_id")).toBe("openai");
        expect(first.fields.get("value")).toBe("sk-example-value");
        expect(first.fields.get("updated_at_us")).toBe("321000");
        const masked = maskCredentialMetadata({
            ...first,
            fields: new Map([
                ...first.fields,
                ["secret", "also-secret"],
                ["api_key", "also-secret"],
                ["token", "also-secret"],
                ["access_token", "also-secret"],
                ["refresh_token", "also-secret"],
            ]),
            blob: new Uint8Array([1, 2, 3]),
        });
        expect(masked.fields.has("value")).toBe(false);
        expect(masked.fields.has("secret")).toBe(false);
        expect(masked.fields.has("api_key")).toBe(false);
        expect(masked.fields.has("token")).toBe(false);
        expect(masked.fields.has("access_token")).toBe(false);
        expect(masked.fields.has("refresh_token")).toBe(false);
        expect(masked.blob).toHaveLength(0);
        expect(providerById("OPENAI")).toMatchObject({ id: "openai", local: false });
    });

    it("maps OpenCode Zen model prefixes to protocols", () => {
        expect(openCodeZenProtocolForModel("gpt-5")).toBe("openai-responses");
        expect(openCodeZenProtocolForModel("grok-4")).toBe("openai-responses");
        expect(openCodeZenProtocolForModel("muse-spark-1")).toBe("openai-responses");
        expect(openCodeZenProtocolForModel("claude-sonnet-4")).toBe("anthropic");
        expect(openCodeZenProtocolForModel("qwen3.5-large")).toBe("anthropic");
        expect(openCodeZenProtocolForModel("qwen3.6-large")).toBe("anthropic");
        expect(openCodeZenProtocolForModel("qwen3.7-large")).toBe("anthropic");
        expect(openCodeZenProtocolForModel("qwen3.8-flash")).toBe("anthropic");
        expect(openCodeZenProtocolForModel("gemini-2.5")).toBe("gemini");
        expect(openCodeZenProtocolForModel("llama-3")).toBe("openai-chat");
        expect(() => openCodeZenProtocolForModel("jev-1")).toThrow(
            "OpenCode Zen Jev models return structured classifications",
        );
    });

    it("resolves authentication headers and Anthropic version requirements", () => {
        expect(providerAuthenticationHeaderName("opencode-zen", "claude-sonnet-4")).toBe(
            "x-api-key",
        );
        expect(providerAuthenticationHeaderName("opencode-zen", "gemini-2.5")).toBe(
            "x-goog-api-key",
        );
        expect(providerAuthenticationHeaderName("opencode-zen", "gpt-5")).toBe("Authorization");
        expect(providerAuthenticationHeaderName("anthropic")).toBe("x-api-key");
        expect(providerAuthenticationHeaderName("google-gemini")).toBe("x-goog-api-key");
        expect(providerAuthenticationHeaderName("azure-openai")).toBe("api-key");
        expect(providerAuthenticationHeaderName("ollama")).toBeNull();
        expect(providerAuthenticationHeaderName("lm-studio")).toBeNull();
        expect(providerAuthenticationHeaderName("llama.cpp-server")).toBeNull();
        expect(providerAuthenticationHeaderName("embedded-gguf")).toBeNull();
        expect(providerAuthenticationHeaderName("llama.cpp-embedded")).toBeNull();
        expect(providerAuthenticationHeaderName("openai")).toBe("Authorization");

        expect(usesAnthropicVersionHeader("anthropic")).toBe(true);
        expect(usesAnthropicVersionHeader("opencode-zen", "claude-sonnet-4")).toBe(true);
        expect(usesAnthropicVersionHeader("opencode-zen", "gpt-5")).toBe(false);
        expect(usesAnthropicVersionHeader("openai")).toBe(false);
    });

    it("normalizes provider aliases and embedded runtime ids", () => {
        expect(isEmbeddedGgufProvider("  EMBEDDED-GGUF ")).toBe(true);
        expect(isEmbeddedGgufProvider("llama.cpp-embedded")).toBe(true);
        expect(isEmbeddedGgufProvider("openai")).toBe(false);
        expect(providerById("llama.cpp-embedded")?.id).toBe("embedded-gguf");
        expect(providerById("lm studio")?.id).toBe("lm-studio");
        expect(providerById("llama.cpp server")?.id).toBe("llama.cpp-server");
        expect(providerById("cloudflare")?.id).toBe("cloudflare-workers-ai");
        expect(providerById("workers-ai")?.id).toBe("cloudflare-workers-ai");
        expect(providerById("z.ai")?.id).toBe("zai");
        expect(providerById("missing")).toBeUndefined();
        expect(isOpenAiCompatibleProvider("openai")).toBe(true);
        expect(isOpenAiCompatibleProvider("anthropic")).toBe(false);
        expect(isOpenAiCompatibleProvider("missing")).toBe(false);
        expect(AI_PROVIDERS.length).toBeGreaterThan(0);
    });

    it("reports legacy catalog statuses for every provider family", () => {
        const cases: Record<string, string> = {
            anthropic: "anthropic-messages-protocol",
            "google-gemini": "gemini-generate-content-protocol",
            cohere: "cohere-chat-v2-protocol",
            perplexity: "perplexity-agent-api",
            replicate: "replicate-prediction-api",
            ollama: "native-ollama-api",
            "lm-studio": "local-openai-compatible",
            "llama.cpp-server": "local-openai-compatible",
            "llama.cpp-embedded": "embedded-gguf-runtime",
            "embedded-gguf": "embedded-gguf-runtime",
            "opencode-go": "coding-agent-use-restricted",
            "opencode-zen": "multi-protocol-model-routes",
            ai21: "models-dev-chat-completions",
            zai: "models-dev-chat-completions",
            openai: "openai-compatible-protocol",
        };
        for (const [providerId, expected] of Object.entries(cases)) {
            expect(aiProviderCatalogStatus(providerId)).toBe(expected);
        }
    });

    it("validates embedded runtime, Replicate, Cloudflare, Azure, and Bedrock endpoints", () => {
        const embedded = providerById("embedded-gguf")!;
        expect(validateProviderEndpoint("tutorux://embedded/generate", embedded)).toBe(
            "tutorux://embedded/generate",
        );
        expect(() => validateProviderEndpoint("tutorux://other", embedded)).toThrow(
            "Embedded GGUF inference uses the in-process desktop runtime endpoint.",
        );

        const replicate = providerById("replicate")!;
        expect(validateProviderEndpoint("https://api.replicate.com/v1/", replicate)).toBe(
            "https://api.replicate.com/v1",
        );
        for (const endpoint of [
            "http://api.replicate.com/v1",
            "https://example.com/v1",
            "https://api.replicate.com:8443/v1",
            "https://api.replicate.com/v2",
        ]) {
            expect(() => validateProviderEndpoint(endpoint, replicate)).toThrow(
                "Replicate requests must use the official https://api.replicate.com/v1 API.",
            );
        }

        const cloudflare = providerById("cloudflare-workers-ai")!;
        const account = "01234567-89ab-cdef-0123-456789abcdef";
        expect(
            validateProviderEndpoint(
                `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`,
                cloudflare,
            ),
        ).toBe(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`);
        for (const endpoint of [
            "https://api.cloudflare.com/client/v4/accounts/zzzz/ai/v1",
            "http://api.cloudflare.com/client/v4/accounts/" + account + "/ai/v1",
            "https://example.com/client/v4/accounts/" + account + "/ai/v1",
        ]) {
            expect(() => validateProviderEndpoint(endpoint, cloudflare)).toThrow(
                "Cloudflare Workers AI requires an account-scoped endpoint",
            );
        }

        const azure = providerById("azure-openai")!;
        expect(
            validateProviderEndpoint("https://other-resource.openai.azure.com/openai/v1", azure),
        ).toBe("https://other-resource.openai.azure.com/openai/v1");
        expect(() => validateProviderEndpoint("https://example.com/openai/v1", azure)).toThrow(
            "Azure OpenAI requests must use its official endpoint.",
        );

        const bedrock = providerById("bedrock")!;
        expect(validateProviderEndpoint("https://bedrock.api.aws", bedrock)).toBe(
            "https://bedrock.api.aws",
        );
        expect(() => validateProviderEndpoint("https://example.com", bedrock)).toThrow(
            /Amazon Bedrock .* requests must use its official endpoint\./u,
        );

        const openai = providerById("openai")!;
        expect(() => validateProviderEndpoint("https://example.com/v1", openai)).toThrow(
            "OpenAI requests must use its official endpoint.",
        );
        expect(validateProviderEndpoint("http://[::1]:11434", providerById("ollama")!)).toBe(
            "http://[::1]:11434",
        );
    });

    it("rejects malformed, oversized, and unknown fields", async () => {
        expect(() => validateProviderEndpoint("not a url", providerById("openai")!)).toThrow(
            "Enter a valid provider endpoint URL.",
        );
        expect(() =>
            validateProviderEndpoint(
                `https://api.openai.com/${"x".repeat(2048)}`,
                providerById("openai")!,
            ),
        ).toThrow("Endpoint must be 2,048 bytes or fewer.");
        expect(() =>
            validateProviderEndpoint("https://api.openai.com/v1\0", providerById("openai")!),
        ).toThrow("Endpoint is invalid.");

        await expect(
            createProviderConfigurationRecord({
                providerId: "missing",
                endpoint: "https://example.com",
                model: "m",
            }),
        ).rejects.toThrow("Choose a supported AI provider.");
        await expect(
            createProviderConfigurationRecord({
                providerId: "openai",
                endpoint: "https://api.openai.com/v1",
                model: "x".repeat(1025),
            }),
        ).rejects.toThrow("Model must be 1,024 bytes or fewer.");
        await expect(
            createProviderConfigurationRecord({
                providerId: "openai",
                endpoint: "https://api.openai.com/v1",
                model: "m\0",
            }),
        ).rejects.toThrow("Model is invalid.");

        await expect(createProviderCredentialRecord("missing", "sk", true)).rejects.toThrow(
            "Choose a supported AI provider.",
        );
        await expect(
            createProviderCredentialRecord("openai", "x".repeat(4097), true),
        ).rejects.toThrow("API key must be 4,096 bytes or fewer.");
        await expect(createProviderCredentialRecord("openai", "key\0", true)).rejects.toThrow(
            "API key is invalid.",
        );
    });

    it("requires an endpoint for provider configuration", async () => {
        await expect(
            createProviderConfigurationRecord({
                providerId: "openai",
                endpoint: "   ",
                model: "gpt-4.1",
            }),
        ).rejects.toThrow("Endpoint is required.");
    });
});
