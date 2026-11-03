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

    it("saves partial output when the transport rejects after emitting chunks", async () => {
        const session = createSession();
        const preview = createPreview();
        const partial = encoder.encode("data: partial provider response");
        const transportError = new Error("socket hang up");
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
                throw transportError;
            },
            onProgress: () => undefined,
        });

        expect(result.job.blob).toEqual(partial);
        expect(result.job.fields.get("status")).toBe("failed");
        expect(result.job.fields.get("error_code")).toBe("transport_error");
        expect(result.job.fields.get("error_message")).toContain("socket hang up");
        expect(result.job.fields.get("response_bytes")).toBe(String(partial.byteLength));
        expect(result.guide).toBeNull();
        expect(result.summary.status).toBe("failed");
        expect(result.summary.responseBytes).toBe(partial.byteLength);
        expect(result.summary.warnings).toContain(
            "socket hang up The received partial response was saved for export.",
        );
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
            "Generation was canceled; the partial response is an unapproved draft that needs review.",
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

function previewWith(overrides: Partial<AiRequestPreview> = {}): AiRequestPreview {
    return { ...createPreview(), ...overrides };
}

function inputWith(
    preview: AiRequestPreview,
    send: (
        request: import("../../../frontend/platform/types").AiTransportRequest,
        onChunk: (chunk: Uint8Array) => void,
    ) => Promise<import("../../../frontend/platform/types").AiTransportResult>,
    overrides: Record<string, unknown> = {},
) {
    return {
        packageJob: createPackageJob(),
        expectedTemplateId: "general",
        preview,
        confirmedEndpoint: preview.endpoint,
        confirmedBodyHash: preview.requestBodyHash,
        credential: "private-provider-key",
        session: createSession(),
        sourceRecords: [],
        send,
        onProgress: () => undefined,
        ...overrides,
    };
}

function plainResponse(text: string): Uint8Array {
    return encoder.encode(JSON.stringify({ choices: [{ message: { content: text } }] }));
}

describe("reviewed AI generation edge cases", () => {
    it("rejects a changed confirmed endpoint", async () => {
        const session = createSession();
        await expect(
            executeAiGeneration({
                ...inputWith(createPreview(), vi.fn()),
                session,
                confirmedEndpoint: "https://example.com/other",
            }),
        ).rejects.toThrow("Confirm the exact provider endpoint before sending.");
    });

    it("ignores empty transport chunks", async () => {
        const session = createSession();
        const chunk = responseChunk(session.id);
        const result = await executeAiGeneration(
            inputWith(
                createPreview(),
                async (_request, onChunk) => {
                    onChunk(new Uint8Array());
                    onChunk(chunk);
                    return {
                        status: 200,
                        contentType: "text/event-stream",
                        responseBytes: chunk.byteLength,
                        complete: true,
                    };
                },
                { session },
            ),
        );
        expect(result.summary.status).toBe("response-needs-review");
        expect(result.job.blob).toEqual(chunk);
    });

    it("defaults transport failure messages for empty or non-Error rejections", async () => {
        const emptyError = await executeAiGeneration(
            inputWith(createPreview(), () => Promise.reject(new Error(""))),
        );
        expect(emptyError.summary.warnings).toEqual(["The provider transport failed."]);
        expect(emptyError.job.fields.get("error_code")).toBe("transport_error");

        const thrown = await executeAiGeneration(
            inputWith(createPreview(), () => Promise.reject("boom")),
        );
        expect(thrown.summary.warnings).toEqual(["The provider transport failed."]);
    });

    it("flags responses that exceed the 16 MiB limit", async () => {
        const huge = new Uint8Array(16 * 1024 * 1024 + 1);
        const result = await executeAiGeneration(
            inputWith(createPreview(), async (_request, onChunk) => {
                onChunk(huge);
                return {
                    status: 200,
                    contentType: "text/event-stream",
                    responseBytes: huge.byteLength,
                    complete: true,
                };
            }),
        );
        expect(result.summary.status).toBe("response-partial");
        expect(result.job.fields.get("error_code")).toBe("response_too_large");
        expect(result.job.fields.get("response_complete")).toBe("false");
        expect(result.job.blob.byteLength).toBe(16 * 1024 * 1024);
    });

    it("reports a response byte-count mismatch as partial", async () => {
        const chunk = responseChunk(createSession().id);
        const result = await executeAiGeneration(
            inputWith(createPreview(), async (_request, onChunk) => {
                onChunk(chunk);
                return {
                    status: 200,
                    contentType: "text/event-stream",
                    responseBytes: chunk.byteLength + 1,
                    complete: true,
                };
            }),
        );
        expect(result.summary.status).toBe("response-partial");
        expect(result.job.fields.get("error_code")).toBe("response_partial");
    });

    it("reports cancellations with and without readable partial output", async () => {
        const noOutput = await executeAiGeneration(
            inputWith(createPreview(), async () => ({
                status: 200,
                contentType: "text/event-stream",
                responseBytes: 0,
                complete: false,
                cancelled: true,
            })),
        );
        expect(noOutput.summary.status).toBe("cancelled");
        expect(noOutput.summary.warnings).toEqual([
            "Generation was canceled. The received partial response was saved for export.",
        ]);

        const withMessage = await executeAiGeneration(
            inputWith(createPreview(), async () => ({
                status: 200,
                contentType: "text/event-stream",
                responseBytes: 0,
                complete: false,
                cancelled: true,
                errorMessage: "Stopped by the tutor.",
            })),
        );
        expect(withMessage.summary.warnings).toEqual(["Stopped by the tutor."]);

        const garbage = encoder.encode("not a provider response");
        const undecodable = await executeAiGeneration(
            inputWith(createPreview(), async (_request, onChunk) => {
                onChunk(garbage);
                return {
                    status: 200,
                    contentType: "text/event-stream",
                    responseBytes: garbage.byteLength,
                    complete: false,
                    cancelled: true,
                };
            }),
        );
        expect(undecodable.summary.status).toBe("cancelled");
        expect(undecodable.job.fields.get("error_code")).toBe("operation_cancelled");
        expect(undecodable.job.blob).toEqual(garbage);
    });

    it("rejects unsupported content types and undecodable responses", async () => {
        const unsupported = await executeAiGeneration(
            inputWith(createPreview(), async () => ({
                status: 200,
                contentType: "text/plain",
                responseBytes: 0,
                complete: true,
            })),
        );
        expect(unsupported.summary.status).toBe("response-needs-correction");
        expect(unsupported.job.fields.get("error_code")).toBe("response_content_type_unsupported");

        const body = encoder.encode("not a provider response");
        const undecodable = await executeAiGeneration(
            inputWith(previewWith({ accept: "application/json" }), async (_request, onChunk) => {
                onChunk(body);
                return {
                    status: 200,
                    contentType: "application/json",
                    responseBytes: body.byteLength,
                    complete: true,
                };
            }),
        );
        expect(undecodable.summary.status).toBe("response-needs-correction");
        expect(undecodable.job.fields.get("error_code")).toBe("response_decode_failed");
        expect(undecodable.summary.warnings[0]).toContain(
            "The provider response contained invalid JSON data.",
        );
    });

    it("adds a missing-evidence warning to a guide without citations", async () => {
        const session = createSession();
        const guideText = JSON.stringify({
            title: "No citations",
            template_id: "general",
            sections: [
                {
                    heading: "Section",
                    blocks: [{ kind: "paragraph", text: "Uncited claim.", source_ids: [] }],
                },
            ],
        });
        const body = plainResponse(guideText);
        const result = await executeAiGeneration(
            inputWith(
                previewWith({ accept: "application/json" }),
                async (_request, onChunk) => {
                    onChunk(body);
                    return {
                        status: 200,
                        contentType: "application/json",
                        responseBytes: body.byteLength,
                        complete: true,
                    };
                },
                { session, sourceRecords: [session] },
            ),
        );
        expect(result.summary.sourceValidation).toBe("missing-evidence");
        expect(result.summary.warnings).toContain(
            "The guide has no source references. Add evidence links before approval.",
        );
        expect(result.summary.status).toBe("response-needs-correction");
    });

    it("truncates very long response previews", async () => {
        const body = plainResponse("x".repeat(45_000));
        const result = await executeAiGeneration(
            inputWith(previewWith({ accept: "application/json" }), async (_request, onChunk) => {
                onChunk(body);
                return {
                    status: 200,
                    contentType: "application/json",
                    responseBytes: body.byteLength,
                    complete: true,
                };
            }),
        );
        expect(result.summary.responseText).toHaveLength(40_000);
        expect(result.summary.responseTextTruncated).toBe(true);
        expect(result.summary.responseBytes).toBe(body.byteLength);
    });

    it("stores Replicate consent and schema metadata", async () => {
        const session = createSession();
        const preview = previewWith({
            providerId: "replicate",
            accept: "application/json",
            localOnly: false,
            replicateInputSchema: {
                modelId: "owner/model",
                version: "version-9",
                hasSystemPrompt: false,
                tokenInput: null,
            },
        });
        const guideText = JSON.stringify({
            title: "Guide",
            template_id: "general",
            sections: [
                {
                    heading: "Section",
                    blocks: [{ kind: "paragraph", text: "Text.", source_ids: [session.id] }],
                },
            ],
        });
        const body = encoder.encode(JSON.stringify({ status: "succeeded", output: guideText }));
        const result = await executeAiGeneration({
            ...inputWith(
                preview,
                async (_request, onChunk) => {
                    onChunk(body);
                    return {
                        status: 200,
                        contentType: "application/json",
                        responseBytes: body.byteLength,
                        complete: true,
                    };
                },
                { session, sourceRecords: [session], expectedTemplateId: "general" },
            ),
            confirmedEndpoint: preview.endpoint,
            confirmedBodyHash: preview.requestBodyHash,
        });

        expect(result.job.fields.get("outbound_consent_method")).toBe(
            "explicit-replicate-prediction-lifecycle",
        );
        expect(result.job.fields.get("replicate_model_schema_version")).toBe("version-9");
        expect(result.job.fields.get("mode")).toBe("byok");
        expect(result.job.fields.get("processing_boundary")).toBe("remote-provider");
    });

    it("explains Replicate HTTP failures", async () => {
        const cases: Array<[number, string]> = [
            [
                401,
                "Replicate rejected the API token or model access. Its raw response was saved for export.",
            ],
            [429, "Replicate rate limited the prediction. Its raw response was saved for export."],
            [
                408,
                "Replicate prediction exceeded the five-minute wait limit. Its latest raw response was saved for export.",
            ],
            [500, "The provider returned HTTP 500. Its raw response was saved for export."],
        ];
        for (const [status, message] of cases) {
            const body = encoder.encode("{}");
            const result = await executeAiGeneration(
                inputWith(
                    previewWith({ providerId: "replicate", accept: "application/json" }),
                    async (_request, onChunk) => {
                        onChunk(body);
                        return {
                            status,
                            contentType: "application/json",
                            responseBytes: body.byteLength,
                            complete: true,
                        };
                    },
                ),
            );
            expect(result.summary.warnings).toEqual([message]);
            expect(result.job.fields.get("error_code")).toBe(`provider_http_${status}`);
        }
    });

    it("keeps a local preview free of outbound consent fields", async () => {
        const send = vi.fn(async (_request: unknown, onChunk: (chunk: Uint8Array) => void) => {
            onChunk(plainResponse("plain text"));
            return {
                status: 200,
                contentType: "application/json",
                responseBytes: plainResponse("plain text").byteLength,
                complete: true,
            };
        });
        const result = await executeAiGeneration(
            inputWith(previewWith({ localOnly: true, accept: "application/json" }), send as never),
        );
        expect(result.job.fields.has("outbound_consent_hash")).toBe(false);
        expect(result.job.fields.get("mode")).toBe("local");
        expect(result.job.fields.get("processing_boundary")).toBe("loopback-only");
        expect((send.mock.calls[0]?.[0] as { credentialStorage: string }).credentialStorage).toBe(
            "none",
        );
    });
});
