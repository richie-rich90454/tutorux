import { describe, expect, it, vi } from "vitest";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import type { AiRequestPreview } from "../../../frontend/ai/request";
import { executeAiGeneration } from "../../../frontend/ai/execution";

vi.mock("../../../frontend/ai/response", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../frontend/ai/response")>();
    return {
        ...actual,
        extractAiResponseText: () => {
            throw "The provider returned a non-Error failure.";
        },
    };
});

function session(): ArchiveRecord {
    return {
        type: RecordType.session,
        id: newUuid(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["entry_id", ""],
            ["student_id", "anonymous"],
        ]),
        blob: new Uint8Array(),
    };
}

function preview(): AiRequestPreview {
    return {
        providerId: "openai",
        providerName: "OpenAI",
        guideTemplateId: "general",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4.1",
        method: "POST",
        accept: "application/json",
        headers: [],
        authentication: "Bearer saved key; value hidden",
        packageHash: "b".repeat(64),
        packageBytes: 200,
        attachedImages: [],
        requestBodyHash: "a".repeat(64),
        requestBytes: 400,
        maxOutputTokens: 4096,
        localOnly: false,
        credentialAvailable: true,
        requestBody: '{"model":"gpt-4.1"}',
    };
}

describe("reviewed AI generation decode failures", () => {
    it("falls back to a generic message when decoding throws a non-Error", async () => {
        const targetSession = session();
        const requestPreview = preview();
        const body = new TextEncoder().encode("{}");
        const result = await executeAiGeneration({
            packageJob: {
                type: RecordType.aiJob,
                id: newUuid(),
                revision: 0n,
                previousOffset: 0n,
                fields: new Map([["mode", "manual"]]),
                blob: new Uint8Array(),
            },
            expectedTemplateId: "general",
            preview: requestPreview,
            confirmedEndpoint: requestPreview.endpoint,
            confirmedBodyHash: requestPreview.requestBodyHash,
            credential: "private-provider-key",
            session: targetSession,
            sourceRecords: [],
            send: async (_request, onChunk) => {
                onChunk(body);
                return {
                    status: 200,
                    contentType: "application/json",
                    responseBytes: body.byteLength,
                    complete: true,
                };
            },
            onProgress: () => undefined,
        });

        expect(result.summary.status).toBe("response-needs-correction");
        expect(result.job.fields.get("error_code")).toBe("response_decode_failed");
        expect(result.summary.warnings).toEqual([
            "The provider response could not be decoded. Raw bytes were saved for export.",
        ]);
    });
});
