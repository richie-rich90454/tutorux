import { describe, expect, it } from "vitest";
import {
  createProviderConfigurationRecord,
  createProviderCredentialRecord,
  maskCredentialMetadata,
  providerById,
} from "./providers";

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
});
