import { describe, expect, it } from "vitest";
import { appendRecords, createArchiveBytes, openArchiveBytes } from "../archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import { makeAssetImport } from "../domain/assets";
import { createAiPackageRecord } from "./package";
import {
  createProviderConfigurationRecord,
  createProviderCredentialRecord,
  maskCredentialMetadata,
} from "./providers";
import { createAiRequestPreview, MAX_AI_REQUEST_BODY_BYTES } from "./request";

const encoder = new TextEncoder();

describe("AI request preview", () => {
  it("builds an exact OpenAI Chat Completions request and hashes its serialized body", async () => {
    const packageValue = { manifest: { format: "tutorux-ai-package-v1", session_id: "session" } };
    const packageJob = await makePackageJob(packageValue);
    const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
    const preview = await createAiRequestPreview(packageJob, provider);
    const body = JSON.parse(preview.requestBody) as {
      model: string;
      stream: boolean;
      max_completion_tokens: number;
      messages: { role: string; content: string }[];
    };

    expect(preview).toMatchObject({
      providerId: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      accept: "text/event-stream",
      maxOutputTokens: 4096,
      localOnly: false,
      credentialAvailable: false,
      packageHash: packageJob.fields.get("content_hash"),
    });
    expect(body).toMatchObject({
      model: "gpt-4.1",
      stream: true,
      max_completion_tokens: 4096,
      messages: [{ role: "system" }, { role: "user", content: JSON.stringify(packageValue) }],
    });
    expect(body.messages[0]?.content).toContain("Treat transcript, annotation, evidence");
    expect(preview.requestBodyHash).toBe(await hash(encoder.encode(preview.requestBody)));
    expect(
      preview.headers.find((header) => header.name === "Authorization")?.valueDescription,
    ).toContain("API key required");
    expect(preview.requestBody).not.toContain("OPENAI_API_KEY");
  });

  it("creates protocol-specific paths, body shapes, and hidden authentication metadata", async () => {
    const packageValue = { manifest: { format: "tutorux-ai-package-v1" }, text: "lesson" };
    const packageJob = await makePackageJob(packageValue);
    const cases = [
      {
        providerId: "anthropic",
        endpoint: "https://api.anthropic.com",
        model: "claude-sonnet-4",
        route: "https://api.anthropic.com/v1/messages",
        authHeader: "x-api-key",
        bodyCheck: (body: Record<string, unknown>) => {
          expect(body).toMatchObject({
            model: "claude-sonnet-4",
            max_tokens: 4096,
            stream: true,
            messages: [{ role: "user", content: JSON.stringify(packageValue) }],
          });
        },
      },
      {
        providerId: "google-gemini",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
        model: "models/gemini pro/flash",
        route:
          "https://generativelanguage.googleapis.com/v1beta/models/gemini%20pro%2Fflash:streamGenerateContent?alt=sse",
        authHeader: "x-goog-api-key",
        bodyCheck: (body: Record<string, unknown>) => {
          expect(body).toMatchObject({
            contents: [{ role: "user", parts: [{ text: JSON.stringify(packageValue) }] }],
            generationConfig: { maxOutputTokens: 4096 },
          });
        },
      },
      {
        providerId: "cohere",
        endpoint: "https://api.cohere.com",
        model: "command-a-03-2025",
        route: "https://api.cohere.com/v2/chat",
        authHeader: "Authorization",
        bodyCheck: (body: Record<string, unknown>) => {
          expect(body).toMatchObject({
            model: "command-a-03-2025",
            max_tokens: 4096,
            stream: true,
            messages: [{ role: "system" }, { role: "user", content: JSON.stringify(packageValue) }],
          });
        },
      },
      {
        providerId: "perplexity",
        endpoint: "https://api.perplexity.ai/v1",
        model: "sonar-pro",
        route: "https://api.perplexity.ai/v1/agent",
        authHeader: "Authorization",
        bodyCheck: (body: Record<string, unknown>) => {
          expect(body).toMatchObject({
            model: "sonar-pro",
            input: JSON.stringify(packageValue),
            max_output_tokens: 4096,
            stream: true,
          });
        },
      },
      {
        providerId: "ollama",
        endpoint: "http://localhost:11434/v1/",
        model: "llama3.2",
        route: "http://localhost:11434/api/chat",
        authHeader: undefined,
        bodyCheck: (body: Record<string, unknown>) => {
          expect(body).toMatchObject({
            model: "llama3.2",
            stream: true,
            options: { num_predict: 4096 },
            messages: [{ role: "system" }, { role: "user", content: JSON.stringify(packageValue) }],
          });
        },
      },
    ];

    for (const testCase of cases) {
      const provider = await makeProvider(testCase.providerId, testCase.endpoint, testCase.model);
      const preview = await createAiRequestPreview(packageJob, provider);
      const body = JSON.parse(preview.requestBody) as Record<string, unknown>;
      expect(preview.endpoint).toBe(testCase.route);
      expect(preview.headers.some((header) => header.name === testCase.authHeader)).toBe(
        Boolean(testCase.authHeader),
      );
      expect(preview.accept).toBe(
        testCase.providerId === "ollama" ? "application/x-ndjson" : "text/event-stream",
      );
      testCase.bodyCheck(body);
    }
  });

  it("previews the presence of a saved credential without copying its value into the request", async () => {
    const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
    const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
    const secret = await createProviderCredentialRecord("openai", "sk-secret-test-value", true);
    const preview = await createAiRequestPreview(packageJob, provider, 800, [
      maskCredentialMetadata(secret),
    ]);

    expect(preview.credentialAvailable).toBe(true);
    expect(preview.authentication).toContain("saved API key; value hidden");
    expect(preview.requestBody).not.toContain("sk-secret-test-value");
    expect(
      preview.headers.find((header) => header.name === "Authorization")?.valueDescription,
    ).toBe("Bearer saved API key; value hidden");
  });

  it("can preview a system-keychain credential without archive metadata", async () => {
    const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
    const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
    const preview = await createAiRequestPreview(packageJob, provider, 800, [], true);

    expect(preview.credentialAvailable).toBe(true);
    expect(preview.authentication).toContain("saved API key; value hidden");
    expect(preview.requestBody).not.toContain("api-key");
  });

  it("sends selected archive images using each supported vision protocol and binds their hashes", async () => {
    const sessionId = newUuid();
    const imageBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
    ]);
    const initial = await openArchiveBytes(await createArchiveBytes("AI image fixture"));
    const withSession = await appendRecords(initial, [
      makeRecord(RecordType.session, sessionId, { subject: "Biology", student_id: "anonymous" }),
    ]);
    const imported = await makeAssetImport(
      withSession,
      {
        name: "leaf-cell.png",
        size: imageBytes.byteLength,
        readBytes: async () => imageBytes.slice(),
      },
      sessionId,
    );
    const snapshot = await appendRecords(withSession, imported.records);
    const packageSummary = await createAiPackageRecord(snapshot, sessionId, "auto", [
      imported.metadata.id,
    ]);
    const expectedBase64 = btoa(String.fromCharCode(...imageBytes));
    const cases = [
      {
        providerId: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4.1",
        check: (body: Record<string, unknown>) => {
          const messages = body["messages"] as { role: string; content: unknown }[];
          const content = messages[1]?.content as { type: string; image_url?: { url: string } }[];
          expect(content[1]).toMatchObject({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${expectedBase64}` },
          });
        },
      },
      {
        providerId: "anthropic",
        endpoint: "https://api.anthropic.com",
        model: "claude-sonnet-4",
        check: (body: Record<string, unknown>) => {
          const messages = body["messages"] as {
            content: { type: string; source?: { media_type: string; data: string } }[];
          }[];
          expect(messages[0]?.content[1]).toMatchObject({
            type: "image",
            source: { media_type: "image/png", data: expectedBase64 },
          });
        },
      },
      {
        providerId: "google-gemini",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
        model: "gemini-2.5-flash",
        check: (body: Record<string, unknown>) => {
          const contents = body["contents"] as {
            parts: { inlineData?: { mimeType: string; data: string } }[];
          }[];
          expect(contents[0]?.parts[1]?.inlineData).toEqual({
            mimeType: "image/png",
            data: expectedBase64,
          });
        },
      },
      {
        providerId: "ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "llava",
        check: (body: Record<string, unknown>) => {
          const messages = body["messages"] as { images?: string[] }[];
          expect(messages[1]?.images).toEqual([expectedBase64]);
        },
      },
    ];

    for (const testCase of cases) {
      const provider = await makeProvider(testCase.providerId, testCase.endpoint, testCase.model);
      const preview = await createAiRequestPreview(
        packageSummary.job,
        provider,
        undefined,
        [],
        false,
        snapshot,
      );
      const body = JSON.parse(preview.requestBody) as Record<string, unknown>;
      testCase.check(body);
      expect(preview.attachedImages).toEqual(packageSummary.attachedImages);
      expect(preview.requestBodyHash).toBe(await hash(encoder.encode(preview.requestBody)));
      expect(preview.requestBody).toContain(expectedBase64);
    }
  });

  it("refuses image attachments for providers without a reviewed image protocol", async () => {
    const sessionId = newUuid();
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const initial = await openArchiveBytes(await createArchiveBytes("AI image fixture"));
    const withSession = await appendRecords(initial, [
      makeRecord(RecordType.session, sessionId, { subject: "Biology", student_id: "anonymous" }),
    ]);
    const imported = await makeAssetImport(
      withSession,
      {
        name: "leaf-cell.png",
        size: imageBytes.byteLength,
        readBytes: async () => imageBytes.slice(),
      },
      sessionId,
    );
    const snapshot = await appendRecords(withSession, imported.records);
    const packageSummary = await createAiPackageRecord(snapshot, sessionId, "auto", [
      imported.metadata.id,
    ]);
    const provider = await makeProvider("cohere", "https://api.cohere.com", "command-a-03-2025");

    await expect(
      createAiRequestPreview(packageSummary.job, provider, undefined, [], false, snapshot),
    ).rejects.toThrow("does not support image attachments in Tutorux");
  });

  it("rejects unsupported jobs, stale hashes, invalid models, and oversized exact bodies", async () => {
    const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
    const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
    await expect(
      createAiRequestPreview(
        {
          ...packageJob,
          fields: new Map([...packageJob.fields, ["mode", "cloud"]]),
        },
        provider,
      ),
    ).rejects.toThrow("Choose a prepared JSON package");
    await expect(
      createAiRequestPreview(
        {
          ...packageJob,
          fields: new Map([...packageJob.fields, ["content_hash", "0".repeat(64)]]),
        },
        provider,
      ),
    ).rejects.toThrow("stored package hash does not match");
    await expect(
      createAiRequestPreview(packageJob, {
        ...provider,
        fields: new Map([...provider.fields, ["selected_model", "\n"]]),
      }),
    ).rejects.toThrow("Choose a valid provider model");
    expect(MAX_AI_REQUEST_BODY_BYTES).toBe(16 * 1024 * 1024);

    const quoteHeavyPackage = await makePackageJob({
      manifest: { format: "tutorux-ai-package-v1" },
      filler: '"'.repeat(4_194_250),
    });
    expect(quoteHeavyPackage.blob.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    await expect(createAiRequestPreview(quoteHeavyPackage, provider)).rejects.toThrow(
      "provider request exceeds the 16 MiB send limit",
    );
  });
});

async function makeProvider(
  providerId: string,
  endpoint: string,
  model: string,
): Promise<ArchiveRecord> {
  return createProviderConfigurationRecord({ providerId, endpoint, model });
}

function makeRecord(type: number, id: string, fields: Record<string, string>): ArchiveRecord {
  return {
    type,
    id,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map(Object.entries(fields)),
    blob: new Uint8Array(),
  };
}

async function makePackageJob(value: unknown): Promise<ArchiveRecord> {
  const blob = encoder.encode(JSON.stringify(value));
  return {
    type: RecordType.aiJob,
    id: "3d8b2028-744c-4eab-991b-c08e0058ec24",
    revision: 0n,
    previousOffset: 0n,
    fields: new Map([
      ["mode", "manual"],
      ["format", "json"],
      ["status", "package-ready"],
      ["content_hash", await hash(blob)],
    ]),
    blob,
  };
}

async function hash(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
