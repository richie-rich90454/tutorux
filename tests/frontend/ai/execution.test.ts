import { describe, expect, it, vi } from "vitest";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import type { AiRequestPreview } from "../../../frontend/ai/request";
import { executeAiGeneration } from "../../../frontend/ai/execution";

const encoder = new TextEncoder();

function createSession(): ArchiveRecord {
    return {
        type: RecordType.session,
        id: newUuid(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["entry_id", ""],
            ["student_id", "anonymous"],
            ["title", "Fraction lesson"],
        ]),
        blob: new Uint8Array(),
    };
}

function createPreview(bodyHash = "a".repeat(64)): AiRequestPreview {
    return {
        providerId: "openai",
        providerName: "OpenAI",
        guideTemplateId: "general",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4.1",
        method: "POST",
        accept: "text/event-stream",
        headers: [],
        authentication: "Bearer saved key; value hidden",
        packageHash: "b".repeat(64),
        packageBytes: 200,
        attachedImages: [],
        requestBodyHash: bodyHash,
        requestBytes: 400,
        maxOutputTokens: 4096,
        localOnly: false,
        credentialAvailable: true,
        requestBody: '{"model":"gpt-4.1","stream":true}',
    };
}

function responseChunk(sessionId: string, sourceId = sessionId): Uint8Array {
    const guideText = JSON.stringify({
        title: "Fraction guide",
        template_id: "general",
        sections: [
            {
                heading: "Equivalent fractions",
                blocks: [
                    {
                        kind: "paragraph",
                        text: "Equivalent fractions have the same value.",
                        source_ids: [sourceId],
                    },
                ],
            },
        ],
    });
    return encoder.encode(
        `data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ delta: { content: guideText } }] })}\n\ndata: [DONE]\n\n`,
    );
}

function createPackageJob(): ArchiveRecord {
    return {
        type: RecordType.aiJob,
        id: newUuid(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["mode", "manual"],
            ["session_id", "session-id"],
            ["status", "package-ready"],
        ]),
        blob: encoder.encode("{}"),
    };
}

describe("reviewed AI generation", () => {
    it("stores the bounded raw response and a draft guide with source consent metadata", async () => {
        const session = createSession();
        const preview = createPreview();
        const chunk = responseChunk(session.id);
        const send = vi.fn(async (_request, onChunk) => {
            onChunk(chunk);
            return {
                status: 200,
                contentType: "text/event-stream",
                responseBytes: chunk.byteLength,
                complete: true,
            };
        });
        const progress = vi.fn();
        const result = await executeAiGeneration({
            packageJob: createPackageJob(),
            expectedTemplateId: "general",
            preview,
            confirmedEndpoint: preview.endpoint,
            confirmedBodyHash: preview.requestBodyHash,
            credential: "private-provider-key",
            session,
            sourceRecords: [session],
            send,
            onProgress: progress,
        });

        expect(send).toHaveBeenCalledOnce();
        expect(send.mock.calls[0]?.[0]).toMatchObject({
            endpoint: preview.endpoint,
            confirmedEndpoint: preview.endpoint,
            confirmedBodyHash: preview.requestBodyHash,
            credential: "private-provider-key",
        });
        expect(progress).toHaveBeenCalledWith(chunk.byteLength);
        expect(result.summary).toMatchObject({
            status: "response-needs-review",
            schemaValid: true,
            sourceValidation: "passed",
            responseText: expect.stringContaining("Equivalent fractions"),
        });
        expect(result.job.fields.get("outbound_consent_hash")).toBe(preview.requestBodyHash);
        expect(result.job.fields.get("response_sha256")).toMatch(/^[\da-f]{64}$/u);
        expect(result.job.fields.get("provider_response_id")).toBe("chatcmpl-test");
        expect(result.job.fields.get("max_output_tokens")).toBe("4096");
        expect(result.job.fields.get("error_code")).toBeUndefined();
        expect(result.job.fields.get("error_message")).toBeUndefined();
        expect(result.job.fields.get("retry_after")).toBeUndefined();
        expect(result.job.fields.has("value")).toBe(false);
        expect(result.job.blob).toEqual(chunk);
        expect(result.guide?.fields.get("approval_state")).toBe("draft");
        expect(result.guide?.fields.get("section.0.block.0.source_ids")).toBe(session.id);
    });

    it("references system keychain credentials without passing their value through the frontend", async () => {
        const session = createSession();
        const preview = createPreview();
        const chunk = responseChunk(session.id);
        const send = vi.fn(async (_request, onChunk) => {
            onChunk(chunk);
            return {
                status: 200,
                contentType: "text/event-stream",
                responseBytes: chunk.byteLength,
                complete: true,
            };
        });

        await executeAiGeneration({
            packageJob: createPackageJob(),
            expectedTemplateId: "general",
            preview,
            confirmedEndpoint: preview.endpoint,
            confirmedBodyHash: preview.requestBodyHash,
            credential: "",
            credentialStorage: "system-keychain",
            session,
            sourceRecords: [session],
            send,
            onProgress: () => undefined,
        });

        expect(send.mock.calls[0]?.[0]).toMatchObject({
            credential: "",
            credentialStorage: "system-keychain",
        });
    });

    it("does not call the provider if either explicit confirmation no longer matches", async () => {
        const session = createSession();
        const preview = createPreview();
        const send = vi.fn();
        await expect(
            executeAiGeneration({
                packageJob: createPackageJob(),
                expectedTemplateId: "general",
                preview,
                confirmedEndpoint: preview.endpoint,
                confirmedBodyHash: "c".repeat(64),
                credential: "private-provider-key",
                session,
                sourceRecords: [session],
                send,
                onProgress: () => undefined,
            }),
        ).rejects.toThrow("Confirm the exact request body hash before sending.");
        expect(send).not.toHaveBeenCalled();
    });

    it("archives raw provider error responses and records structured error metadata", async () => {
        const session = createSession();
        const preview = createPreview();
        const rawError = encoder.encode(
            '{"error":{"message":"rate limit","code":"rate_limit_exceeded","retry_after":12}}',
        );
        const result = await executeAiGeneration({
            packageJob: createPackageJob(),
            expectedTemplateId: "general",
            preview,
            confirmedEndpoint: preview.endpoint,
            confirmedBodyHash: preview.requestBodyHash,
            credential: "private-provider-key",
            session,
            sourceRecords: [session],
            send: async (_request, onChunk) => {
                onChunk(rawError);
                return {
                    status: 429,
                    contentType: "application/json",
                    responseBytes: rawError.byteLength,
                    complete: true,
                };
            },
            onProgress: () => undefined,
        });

        expect(result.job.blob).toEqual(rawError);
        expect(result.job.fields.get("http_status")).toBe("429");
        expect(result.job.fields.get("response_complete")).toBe("true");
        expect(result.job.fields.get("status")).toBe("provider-error");
        expect(result.job.fields.get("error_code")).toBe("rate_limit_exceeded");
        expect(result.job.fields.get("error_message")).toBe("rate limit");
        expect(result.job.fields.get("retry_after")).toBe("12");
        expect(result.job.fields.get("max_output_tokens")).toBe("4096");
        expect(result.guide).toBeNull();
        expect(result.summary.guideId).toBeNull();
        expect(result.summary.warnings).toContain("rate limit");
    });

    it("archives received raw bytes when a response stream is interrupted", async () => {
        const session = createSession();
        const preview = createPreview();
        const partial = encoder.encode("data: partial provider response");
        const result = await executeAiGeneration({
            packageJob: createPackageJob(),
            expectedTemplateId: "general",
            preview,
            confirmedEndpoint: preview.endpoint,
            confirmedBodyHash: preview.requestBodyHash,
            credential: "private-provider-key",
            session,
            sourceRecords: [session],
            send: async (_request, onChunk) => {
                onChunk(partial);
                return {
                    status: 200,
                    contentType: "text/event-stream",
                    responseBytes: partial.byteLength,
                    complete: false,
                };
            },
            onProgress: () => undefined,
        });

        expect(result.job.blob).toEqual(partial);
        expect(result.job.fields.get("response_complete")).toBe("false");
        expect(result.job.fields.get("status")).toBe("response-partial");
        expect(result.guide).toBeNull();
        expect(result.summary.responseBytes).toBe(partial.byteLength);
    });

    it("keeps decodable partial output as a draft when generation is cancelled", async () => {
        const session = createSession();
        const preview = createPreview();
        const guideText = JSON.stringify({
            title: "Partial guide",
            template_id: "general",
            sections: [
                {
                    heading: "Partial section",
                    blocks: [
                        {
                            kind: "paragraph",
                            text: "A partial answer.",
                            source_ids: [session.id],
                        },
                    ],
                },
            ],
        });
        const partial = encoder.encode(
            `data: ${JSON.stringify({ id: "chatcmpl-cancelled", choices: [{ delta: { content: guideText } }] })}\n\ndata: {"choices":[{"delta":{"content":"truncated`,
        );
        const result = await executeAiGeneration({
            packageJob: createPackageJob(),
            expectedTemplateId: "general",
            preview,
            confirmedEndpoint: preview.endpoint,
            confirmedBodyHash: preview.requestBodyHash,
            credential: "private-provider-key",
            session,
            sourceRecords: [session],
            send: async (_request, onChunk) => {
                onChunk(partial);
                return {
                    status: 200,
                    contentType: "text/event-stream",
                    responseBytes: partial.byteLength,
                    complete: false,
                    cancelled: true,
                    errorMessage: "Generation was cancelled.",
                };
            },
            onProgress: () => undefined,
        });

        expect(result.summary.status).toBe("cancelled-with-partial-output");
        expect(result.guide).not.toBeNull();
        expect(result.summary.guideId).toBe(result.guide?.id);
        expect(result.summary.responseText).toContain("A partial answer.");
        expect(result.job.fields.get("status")).toBe("cancelled-with-partial-output");
        expect(result.job.fields.get("error_code")).toBe("operation_cancelled");
        expect(result.job.fields.get("error_message")).toBe("Generation was cancelled.");
        expect(result.job.fields.get("max_output_tokens")).toBe("4096");
        expect(result.job.fields.get("provider_response_id")).toBe("chatcmpl-cancelled");
        expect(result.summary.warnings).toContain(
            "Generation was cancelled; the partial response is an unapproved draft that needs review.",
        );
    });

    it("keeps an off-session citation as an editable response that needs correction", async () => {
        const session = createSession();
        const preview = createPreview();
        const chunk = responseChunk(session.id, newUuid());
        const result = await executeAiGeneration({
            packageJob: createPackageJob(),
            expectedTemplateId: "general",
            preview,
            confirmedEndpoint: preview.endpoint,
            confirmedBodyHash: preview.requestBodyHash,
            credential: "private-provider-key",
            session,
            sourceRecords: [session],
            send: async (_request, onChunk) => {
                onChunk(chunk);
                return {
                    status: 200,
                    contentType: "text/event-stream",
                    responseBytes: chunk.byteLength,
                    complete: true,
                };
            },
            onProgress: () => undefined,
        });

        expect(result.summary.status).toBe("response-needs-correction");
        expect(result.summary.sourceValidation).toBe("failed");
        expect(result.guide?.fields.get("section.0.block.0.source_ids")).toBe("");
        expect(result.summary.warnings).toContain(
            "Some generated guide content or source links need correction; the response was saved as editable text.",
        );
    });
});
