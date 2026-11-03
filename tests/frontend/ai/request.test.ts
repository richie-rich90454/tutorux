import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
} from "../../../frontend/archive/archive";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { makeAssetImport } from "../../../frontend/domain/assets";
import { aiPackageText, createAiPackageRecord } from "../../../frontend/ai/package";
import {
    createProviderConfigurationRecord,
    createProviderCredentialRecord,
    maskCredentialMetadata,
} from "../../../frontend/ai/providers";
import { createAiRequestPreview, MAX_AI_REQUEST_BODY_BYTES } from "../../../frontend/ai/request";

const encoder = new TextEncoder();

describe("AI request preview", () => {
    it("builds an exact OpenAI Chat Completions request and hashes its serialized body", async () => {
        const packageValue = {
            manifest: { format: "tutorux-ai-package-v1", session_id: "session" },
        };
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
                route: "https://generativelanguage.googleapis.com/v1beta/models/gemini%20pro%2Fflash:streamGenerateContent?alt=sse",
                authHeader: "x-goog-api-key",
                bodyCheck: (body: Record<string, unknown>) => {
                    expect(body).toMatchObject({
                        contents: [
                            { role: "user", parts: [{ text: JSON.stringify(packageValue) }] },
                        ],
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
                        messages: [
                            { role: "system" },
                            { role: "user", content: JSON.stringify(packageValue) },
                        ],
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
                        messages: [
                            { role: "system" },
                            { role: "user", content: JSON.stringify(packageValue) },
                        ],
                    });
                },
            },
        ];

        for (const testCase of cases) {
            const provider = await makeProvider(
                testCase.providerId,
                testCase.endpoint,
                testCase.model,
            );
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
            makeRecord(RecordType.session, sessionId, {
                subject: "Biology",
                student_id: "anonymous",
            }),
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
                    const content = messages[1]?.content as {
                        type: string;
                        image_url?: { url: string };
                    }[];
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
            const provider = await makeProvider(
                testCase.providerId,
                testCase.endpoint,
                testCase.model,
            );
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
            makeRecord(RecordType.session, sessionId, {
                subject: "Biology",
                student_id: "anonymous",
            }),
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
        const provider = await makeProvider(
            "cohere",
            "https://api.cohere.com",
            "command-a-03-2025",
        );

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
    it("attaches PDF, audio, and video materials from the package manifest per protocol", async () => {
        const sessionId = newUuid();
        const initial = await openArchiveBytes(await createArchiveBytes("AI multimodal fixture"));
        const withSession = await appendRecords(initial, [
            makeRecord(RecordType.session, sessionId, {
                subject: "Science",
                student_id: "anonymous",
            }),
        ]);
        const pdfBytes = encoder.encode("%PDF-1.4\n%%EOF");
        const wavBytes = new Uint8Array([
            0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d,
            0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00,
            0x88, 0x58, 0x01, 0x00, 0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00,
            0x00, 0x00,
        ]);
        const webmBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
        const snapshot = await appendRecords(withSession, [
            ...(await materialRecords(
                sessionId,
                "handout.pdf",
                "application/pdf",
                pdfBytes,
                "Worksheet text",
            )),
            ...(await materialRecords(sessionId, "lecture.wav", "audio/wav", wavBytes)),
            ...(await materialRecords(sessionId, "clip.webm", "video/webm", webmBytes)),
        ]);
        const summary = await createAiPackageRecord(snapshot, sessionId);
        const packageValue = JSON.parse(aiPackageText(summary.job)) as {
            assets_manifest: { mime_type: string }[];
        };
        expect(packageValue.assets_manifest).toHaveLength(3);

        const expectedKinds = ["audio", "document", "video"];
        const gemini = await makeProvider(
            "google-gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-2.5-flash",
        );
        const geminiPreview = await createAiRequestPreview(
            summary.job,
            gemini,
            undefined,
            [],
            false,
            snapshot,
        );
        const geminiBody = JSON.parse(geminiPreview.requestBody) as {
            contents: { parts: { inlineData?: { mimeType: string } }[] }[];
        };
        expect(geminiPreview.attachedAssets).toHaveLength(3);
        expect(
            geminiBody.contents[0]?.parts
                .flatMap((part) => (part.inlineData ? [part.inlineData.mimeType] : []))
                .sort(),
        ).toEqual(["application/pdf", "audio/wav", "video/webm"]);
        expect(geminiPreview.attachedAssets?.map((asset) => asset.kind).sort()).toEqual(
            expectedKinds,
        );

        const anthropic = await makeProvider(
            "anthropic",
            "https://api.anthropic.com",
            "claude-sonnet-4",
        );
        const anthropicPreview = await createAiRequestPreview(
            summary.job,
            anthropic,
            undefined,
            [],
            false,
            snapshot,
        );
        const anthropicBody = JSON.parse(anthropicPreview.requestBody) as {
            messages: {
                content: { type: string; text?: string; source?: { media_type: string } }[];
            }[];
        };
        expect(
            anthropicBody.messages[0]?.content.some(
                (part) => part.type === "document" && part.source?.media_type === "application/pdf",
            ),
        ).toBe(true);
        expect(anthropicBody.messages[0]?.content[0]?.text).toContain("Audio lecture.wav");

        const responses = await makeProvider(
            "opencode-zen",
            "https://opencode.ai/inference/v1",
            "gpt-5",
        );
        const responsesPreview = await createAiRequestPreview(
            summary.job,
            responses,
            undefined,
            [],
            false,
            snapshot,
        );
        const responsesBody = JSON.parse(responsesPreview.requestBody) as {
            input: { content: { type: string; filename?: string }[] }[];
        };
        expect(
            responsesBody.input[0]?.content.some(
                (part) => part.type === "input_file" && part.filename === "handout.pdf",
            ),
        ).toBe(true);
    });

    it("rejects an oversized attachment list from package metadata before reading asset bytes", async () => {
        const sessionId = newUuid();
        const attachment = (filename: string) => ({
            id: newUuid(),
            fields: {
                filename,
                mime_type: "application/pdf",
                content_hash: "a".repeat(64),
                byte_size: String(4 * 1024 * 1024),
            },
        });
        const packageJob = await makePackageJob({
            manifest: { format: "tutorux-ai-package-v1", session_id: sessionId },
            assets_manifest: [attachment("first.pdf"), attachment("second.pdf")],
        });
        const provider = await makeProvider(
            "google-gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-2.5-flash",
        );

        await expect(createAiRequestPreview(packageJob, provider)).rejects.toThrow(
            "6 MiB outbound request budget",
        );
    });

    it("builds provider-native structured-output fields from a supported model capability", async () => {
        const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
        const cases = [
            {
                providerId: "openai",
                endpoint: "https://api.openai.com/v1",
                model: "gpt-4.1",
                check: (body: Record<string, unknown>) => {
                    expect(body["response_format"]).toEqual({ type: "json_object" });
                },
            },
            {
                providerId: "ollama",
                endpoint: "http://127.0.0.1:11434",
                model: "llama3.2",
                check: (body: Record<string, unknown>) => {
                    expect(body["format"]).toBe("json");
                },
            },
            {
                providerId: "google-gemini",
                endpoint: "https://generativelanguage.googleapis.com/v1beta",
                model: "gemini-2.5-flash",
                check: (body: Record<string, unknown>) => {
                    expect(body["generationConfig"]).toMatchObject({
                        responseMimeType: "application/json",
                    });
                },
            },
            {
                providerId: "opencode-zen",
                endpoint: "https://opencode.ai/inference/v1",
                model: "gpt-5",
                check: (body: Record<string, unknown>) => {
                    expect(body["text"]).toEqual({ format: { type: "json_object" } });
                },
            },
        ];

        for (const testCase of cases) {
            const provider = await makeProvider(
                testCase.providerId,
                testCase.endpoint,
                testCase.model,
            );
            const preview = await createAiRequestPreview(
                packageJob,
                provider,
                undefined,
                [],
                false,
                undefined,
                undefined,
                true,
            );
            testCase.check(JSON.parse(preview.requestBody) as Record<string, unknown>);
            expect(preview.structuredOutput).toBe(true);
        }

        const anthropic = await makeProvider(
            "anthropic",
            "https://api.anthropic.com",
            "claude-sonnet-4",
        );
        const preview = await createAiRequestPreview(
            packageJob,
            anthropic,
            undefined,
            [],
            false,
            undefined,
            undefined,
            true,
        );
        const body = JSON.parse(preview.requestBody) as Record<string, unknown>;
        expect(body["response_format"]).toBeUndefined();
        expect(body["text"]).toBeUndefined();
        expect(preview.structuredOutput).toBe(false);
    });
});

describe("AI request preview edge cases", () => {
    it("validates package bytes, token limits, JSON, format, and image manifests", async () => {
        const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
        const valid = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });

        const emptyBlob = { ...valid, blob: new Uint8Array() };
        await expect(createAiRequestPreview(emptyBlob, provider)).rejects.toThrow(
            "The AI package is empty or exceeds the 8 MiB send limit.",
        );
        const oversizedBlob = { ...valid, blob: new Uint8Array(8 * 1024 * 1024 + 1) };
        await expect(createAiRequestPreview(oversizedBlob, provider)).rejects.toThrow(
            "The AI package is empty or exceeds the 8 MiB send limit.",
        );

        for (const limit of [0, 1.5, 1_000_001]) {
            await expect(createAiRequestPreview(valid, provider, limit)).rejects.toThrow(
                "The output-token limit must be between 1 and 1,000,000.",
            );
        }

        const invalidJson = encoder.encode("not json");
        await expect(
            createAiRequestPreview(
                {
                    ...valid,
                    blob: invalidJson,
                    fields: new Map([...valid.fields, ["content_hash", await hash(invalidJson)]]),
                },
                provider,
            ),
        ).rejects.toThrow("The stored AI package is not valid JSON.");

        for (const value of [null, [], 5, { manifest: {} }, { manifest: { format: "other" } }]) {
            await expect(
                createAiRequestPreview(await makePackageJob(value), provider),
            ).rejects.toThrow("does not use the supported Tutorux AI package format");
        }

        const mismatched = await makePackageJob({
            manifest: {
                format: "tutorux-ai-package-v1",
                attached_image_ids: "not-an-array",
            },
        });
        await expect(createAiRequestPreview(mismatched, provider)).rejects.toThrow(
            "The AI image attachment list does not match its package manifest.",
        );
        const wrongCount = await makePackageJob({
            manifest: { format: "tutorux-ai-package-v1", attached_image_ids: ["id"] },
        });
        await expect(createAiRequestPreview(wrongCount, provider)).rejects.toThrow(
            "The AI image attachment list does not match its package manifest.",
        );
    });

    it("validates the saved provider configuration", async () => {
        const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
        const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
        const variants = [
            { ...provider, type: RecordType.guide },
            { ...provider, fields: new Map([...provider.fields, ["record_role", "other"]]) },
            { ...provider, fields: new Map([...provider.fields, ["provider_id", "unknown"]]) },
        ];
        for (const variant of variants) {
            await expect(createAiRequestPreview(packageJob, variant)).rejects.toThrow(
                "Choose a saved, supported provider configuration.",
            );
        }

        const restricted = makeRecord(RecordType.settings, newUuid(), {
            record_role: "ai-provider",
            provider_id: "opencode-go",
            selected_model: "gpt-5",
            endpoint: "https://opencode.ai/zen/go/v1",
        });
        await expect(createAiRequestPreview(packageJob, restricted)).rejects.toThrow(
            "restricted to coding-agent traffic",
        );

        for (const model of ["x".repeat(1025), "bad\u0001model"]) {
            await expect(
                createAiRequestPreview(packageJob, {
                    ...provider,
                    fields: new Map([...provider.fields, ["selected_model", model]]),
                }),
            ).rejects.toThrow("Choose a valid provider model before reviewing a request.");
        }
    });

    it("treats missing provider configuration fields as invalid", async () => {
        const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
        const settings = (fields: Record<string, string>) =>
            makeRecord(RecordType.settings, newUuid(), { record_role: "ai-provider", ...fields });

        await expect(createAiRequestPreview(packageJob, settings({}))).rejects.toThrow(
            "Choose a saved, supported provider configuration.",
        );
        await expect(
            createAiRequestPreview(packageJob, settings({ provider_id: "openai" })),
        ).rejects.toThrow("Choose a valid provider model before reviewing a request.");
        await expect(
            createAiRequestPreview(
                packageJob,
                settings({ provider_id: "openai", selected_model: "gpt-4.1" }),
            ),
        ).rejects.toThrow("Endpoint is required.");
    });

    it("loads a manifest attachment whose metadata omits its record role", async () => {
        const sessionId = newUuid();
        const records = [
            ...(await materialRecords(
                sessionId,
                "handout.pdf",
                "application/pdf",
                encoder.encode("%PDF-1.4\n%%EOF"),
                "Worksheet notes",
            )),
        ];
        const last = records.at(-1)!;
        const metadata = { ...last, fields: new Map(last.fields) };
        metadata.fields.delete("record_role");
        records[records.length - 1] = metadata;
        const packageJob = await makePackageJob({
            manifest: { format: "tutorux-ai-package-v1", session_id: sessionId },
            assets_manifest: [
                {
                    id: metadata.id,
                    fields: {
                        filename: "handout.pdf",
                        mime_type: "application/pdf",
                        content_hash: metadata.fields.get("content_hash"),
                        byte_size: metadata.fields.get("byte_size"),
                    },
                },
            ],
        });
        const provider = await makeProvider(
            "cohere",
            "https://api.cohere.com",
            "command-a-03-2025",
        );

        const preview = await createAiRequestPreview(
            packageJob,
            provider,
            undefined,
            [],
            false,
            fakeSnapshot(records),
        );
        expect(preview.attachedAssets).toHaveLength(1);
        expect(preview.requestBody).toContain("Document handout.pdf:");
        expect(preview.requestBody).toContain("Worksheet notes");
    });

    it("names attachments when they push the request past the 16 MiB send limit", async () => {
        const sessionId = newUuid();
        const imageBytes = () => {
            const bytes = new Uint8Array(2 * 1024 * 1024);
            bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
            return bytes;
        };
        const pdfBytes = new Uint8Array(2 * 1024 * 1024);
        pdfBytes.set(encoder.encode("%PDF-1.4"));
        const records: ArchiveRecord[] = [];
        const images: ArchiveRecord[] = [];
        for (let index = 0; index < 2; index += 1) {
            const material = await materialRecords(
                sessionId,
                `page-${index}.png`,
                "image/png",
                imageBytes(),
            );
            records.push(...material);
            images.push(material.at(-1)!);
        }
        const pdfRecords = await materialRecords(
            sessionId,
            "handout.pdf",
            "application/pdf",
            pdfBytes,
        );
        records.push(...pdfRecords);
        const pdf = pdfRecords.at(-1)!;

        const imageManifest = images.map((metadata) => ({
            id: metadata.id,
            filename: metadata.fields.get("filename"),
            mime_type: metadata.fields.get("mime_type"),
            content_hash: metadata.fields.get("content_hash"),
            byte_size: Number(metadata.fields.get("byte_size")),
        }));
        const baseValue = {
            manifest: {
                format: "tutorux-ai-package-v1",
                session_id: sessionId,
                attached_image_ids: imageManifest.map((image) => image.id),
            },
            attached_images: imageManifest,
            assets_manifest: [
                {
                    id: pdf.id,
                    fields: {
                        filename: "handout.pdf",
                        mime_type: "application/pdf",
                        content_hash: pdf.fields.get("content_hash"),
                        byte_size: pdf.fields.get("byte_size"),
                    },
                },
            ],
        };
        const baseBytes = encoder.encode(JSON.stringify(baseValue)).byteLength;
        const overhead =
            encoder.encode(JSON.stringify({ ...baseValue, filler: "" })).byteLength - baseBytes;
        const packageJob = await makePackageJob({
            ...baseValue,
            filler: "x".repeat(8 * 1024 * 1024 - baseBytes - overhead),
        });
        expect(packageJob.blob.byteLength).toBe(8 * 1024 * 1024);

        const provider = await makeProvider(
            "google-gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-2.5-flash",
        );
        await expect(
            createAiRequestPreview(
                packageJob,
                provider,
                undefined,
                [],
                false,
                fakeSnapshot(records),
            ),
        ).rejects.toThrow(
            "The provider request exceeds the 16 MiB send limit. Remove attachments or shorten the session package.",
        );
    });

    it("requires a matching Replicate input schema and a valid model id", async () => {
        const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
        const provider = await makeProvider(
            "replicate",
            "https://api.replicate.com/v1",
            "owner/model",
        );
        await expect(createAiRequestPreview(packageJob, provider)).rejects.toThrow(
            "Inspect the selected Replicate model inputs before reviewing its request.",
        );
        await expect(
            createAiRequestPreview(packageJob, provider, undefined, [], false, undefined, {
                modelId: "other/model",
                version: "v1",
                hasSystemPrompt: false,
                tokenInput: null,
            }),
        ).rejects.toThrow(
            "Inspect the selected Replicate model inputs before reviewing its request.",
        );

        const invalidModel = await makeProvider(
            "replicate",
            "https://api.replicate.com/v1",
            "invalidmodel",
        );
        await expect(
            createAiRequestPreview(packageJob, invalidModel, undefined, [], false, undefined, {
                modelId: "invalidmodel",
                version: "v1",
                hasSystemPrompt: false,
                tokenInput: null,
            }),
        ).rejects.toThrow("Replicate models must use the owner/model form");
    });

    it("builds Replicate request bodies with optional system prompts and token limits", async () => {
        const packageValue = {
            manifest: { format: "tutorux-ai-package-v1" },
            text: "lesson body",
        };
        const packageJob = await makePackageJob(packageValue);
        const provider = await makeProvider(
            "replicate",
            "https://api.replicate.com/v1",
            "owner/model",
        );

        const minimal = await createAiRequestPreview(
            packageJob,
            provider,
            1234,
            [],
            false,
            undefined,
            {
                modelId: "owner/model",
                version: "v9",
                hasSystemPrompt: false,
                tokenInput: "max_tokens",
            },
        );
        const minimalBody = JSON.parse(minimal.requestBody) as {
            version: string;
            input: Record<string, unknown>;
        };
        expect(minimal).toMatchObject({
            endpoint: "https://api.replicate.com/v1/models/owner/model/predictions",
            accept: "application/json",
        });
        expect(minimal.headers.find((header) => header.name === "Prefer")).toBeDefined();
        expect(minimalBody.version).toBe("v9");
        expect(minimalBody.input["max_tokens"]).toBe(1234);
        expect(minimalBody.input["prompt"]).toContain("Treat transcript, annotation, evidence");
        expect(minimalBody.input["system_prompt"]).toBeUndefined();

        const withSystem = await createAiRequestPreview(
            packageJob,
            provider,
            99,
            [],
            false,
            undefined,
            { modelId: "owner/model", version: "v2", hasSystemPrompt: true, tokenInput: null },
        );
        const withSystemBody = JSON.parse(withSystem.requestBody) as {
            input: Record<string, unknown>;
        };
        expect(withSystemBody.input["prompt"]).toBe(JSON.stringify(packageValue));
        expect(withSystemBody.input["system_prompt"]).toContain("Treat transcript");

        const oversized = await makePackageJob({
            manifest: { format: "tutorux-ai-package-v1" },
            filler: "x".repeat(8 * 1024 * 1024 - 100),
        });
        await expect(
            createAiRequestPreview(oversized, provider, undefined, [], false, undefined, {
                modelId: "owner/model",
                version: "v1",
                hasSystemPrompt: false,
                tokenInput: null,
            }),
        ).rejects.toThrow("The Replicate prompt exceeds the 8 MiB send limit.");
    });

    it("builds embedded GGUF requests without remote credentials", async () => {
        const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
        const provider = await makeProvider(
            "embedded-gguf",
            "tutorux://embedded/generate",
            "local-model",
        );
        const preview = await createAiRequestPreview(packageJob, provider);
        const body = JSON.parse(preview.requestBody) as Record<string, unknown>;
        expect(preview.endpoint).toBe("tutorux://embedded/generate");
        expect(preview.localOnly).toBe(true);
        expect(preview.authentication).toBe(
            "No credential; inference stays inside the desktop process",
        );
        expect(body).toMatchObject({ model: "local-model", stream: true, max_tokens: 4096 });
    });

    it("routes every OpenCode Zen protocol", async () => {
        const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
        const cases = [
            {
                model: "claude-sonnet-4",
                endpoint: "https://opencode.ai/inference/anthropic/v1/messages",
                accept: "text/event-stream",
            },
            {
                model: "gemini-2.5",
                endpoint:
                    "https://opencode.ai/inference/google/v1beta/models/gemini-2.5:streamGenerateContent?alt=sse",
                accept: "text/event-stream",
            },
            {
                model: "gemini-(1)!",
                endpoint:
                    "https://opencode.ai/inference/google/v1beta/models/gemini-%281%29%21:streamGenerateContent?alt=sse",
                accept: "text/event-stream",
            },
            {
                model: "llama-3",
                endpoint: "https://opencode.ai/inference/openai/v1/chat/completions",
                accept: "text/event-stream",
            },
            {
                model: "gpt-5",
                endpoint: "https://opencode.ai/inference/openai/v1/responses",
                accept: "text/event-stream",
            },
        ];
        for (const testCase of cases) {
            const provider = await makeProvider(
                "opencode-zen",
                "https://opencode.ai/inference/v1",
                testCase.model,
            );
            const preview = await createAiRequestPreview(packageJob, provider);
            expect(preview.endpoint).toBe(testCase.endpoint);
            expect(preview.accept).toBe(testCase.accept);
        }

        await expect(
            createAiRequestPreview(
                packageJob,
                await makeProvider("opencode-zen", "https://opencode.ai/inference/v1", "jev-1"),
            ),
        ).rejects.toThrow("structured classifications");
    });

    it("builds OpenAI-compatible and max_completion_token variants", async () => {
        const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
        const compatible = await makeProvider(
            "openai-compatible",
            "https://llm.example.com/v1",
            "custom-model",
        );
        const compatiblePreview = await createAiRequestPreview(packageJob, compatible);
        expect(compatiblePreview.endpoint).toBe("https://llm.example.com/v1/chat/completions");
        expect(JSON.parse(compatiblePreview.requestBody)).toMatchObject({
            max_tokens: 4096,
        });

        const minimax = await makeProvider("minimax", "https://api.minimax.io/v1", "mini-model");
        const minimaxPreview = await createAiRequestPreview(packageJob, minimax);
        expect(JSON.parse(minimaxPreview.requestBody)).toMatchObject({
            max_completion_tokens: 4096,
        });
    });

    it("describes provider authentication headers for every protocol", async () => {
        const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
        const anthropic = await makeProvider(
            "anthropic",
            "https://api.anthropic.com",
            "claude-sonnet-4",
        );
        const anthropicPreview = await createAiRequestPreview(packageJob, anthropic);
        expect(
            anthropicPreview.headers.find((header) => header.name === "x-api-key")
                ?.valueDescription,
        ).toBe("API key required; no value included in this preview");
        expect(
            anthropicPreview.headers.find((header) => header.name === "anthropic-version"),
        ).toBeDefined();

        const secret = await createProviderCredentialRecord("anthropic", "sk-test", true);
        const withKey = await createAiRequestPreview(packageJob, anthropic, undefined, [
            maskCredentialMetadata(secret),
        ]);
        expect(
            withKey.headers.find((header) => header.name === "x-api-key")?.valueDescription,
        ).toBe("Saved API key; value hidden");
        expect(withKey.authentication).toBe("x-api-key: saved API key; value hidden");
    });

    it("skips malformed asset-manifest rows", async () => {
        const packageJob = await makePackageJob({
            manifest: { format: "tutorux-ai-package-v1", session_id: newUuid() },
            assets_manifest: [
                "not-object",
                { fields: { mime_type: "text/plain" } },
                { fields: { mime_type: 5 } },
                {
                    id: newUuid(),
                    fields: {
                        filename: "ignored.png",
                        mime_type: "image/png",
                        content_hash: "a".repeat(64),
                        byte_size: "10",
                    },
                },
                {
                    id: "not-a-uuid",
                    fields: {
                        filename: "bad-id.pdf",
                        mime_type: "application/pdf",
                        content_hash: "a".repeat(64),
                        byte_size: "10",
                    },
                },
                {
                    id: newUuid(),
                    fields: {
                        filename: "  ",
                        mime_type: "application/pdf",
                        content_hash: "a".repeat(64),
                        byte_size: "10",
                    },
                },
                {
                    id: newUuid(),
                    fields: {
                        filename: "bad-hash.pdf",
                        mime_type: "application/pdf",
                        content_hash: "short",
                        byte_size: "10",
                    },
                },
                {
                    id: newUuid(),
                    fields: {
                        filename: "bad-size.pdf",
                        mime_type: "application/pdf",
                        content_hash: "a".repeat(64),
                        byte_size: "not-a-number",
                    },
                },
                {
                    id: newUuid(),
                    fields: {
                        filename: "zero.pdf",
                        mime_type: "application/pdf",
                        content_hash: "a".repeat(64),
                        byte_size: "0",
                    },
                },
            ],
        });
        const provider = await makeProvider(
            "google-gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-2.5-flash",
        );
        const preview = await createAiRequestPreview(packageJob, provider);
        expect(preview.attachedAssets).toEqual([]);
        expect(preview.attachedImages).toEqual([]);
    });

    it("requires a snapshot and session for manifest attachments", async () => {
        const attachment = (sessionId?: string) => ({
            manifest: {
                format: "tutorux-ai-package-v1",
                ...(sessionId ? { session_id: sessionId } : {}),
            },
            assets_manifest: [
                {
                    id: newUuid(),
                    fields: {
                        filename: "handout.pdf",
                        mime_type: "application/pdf",
                        content_hash: "a".repeat(64),
                        byte_size: "10",
                    },
                },
            ],
        });
        const provider = await makeProvider(
            "google-gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-2.5-flash",
        );

        await expect(
            createAiRequestPreview(await makePackageJob(attachment(newUuid())), provider),
        ).rejects.toThrow("Open the source archive to load its selected attachments.");

        await expect(
            createAiRequestPreview(
                await makePackageJob(attachment()),
                provider,
                undefined,
                [],
                false,
                fakeSnapshot([]),
            ),
        ).rejects.toThrow(
            "The AI package does not identify the session for its selected attachments.",
        );
    });

    it("rejects manifest attachments whose metadata or blob changed", async () => {
        const sessionId = newUuid();
        const attachmentId = newUuid();
        const blobId = newUuid();
        const packageJob = await makePackageJob({
            manifest: { format: "tutorux-ai-package-v1", session_id: sessionId },
            assets_manifest: [
                {
                    id: attachmentId,
                    fields: {
                        filename: "handout.pdf",
                        mime_type: "application/pdf",
                        content_hash: "a".repeat(64),
                        byte_size: "10",
                    },
                },
            ],
        });
        const provider = await makeProvider(
            "google-gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-2.5-flash",
        );
        const metadata = (fields: Record<string, string>) =>
            makeRecord(RecordType.assetMetadata, attachmentId, {
                record_role: "material",
                session_id: sessionId,
                filename: "handout.pdf",
                mime_type: "application/pdf",
                content_hash: "a".repeat(64),
                byte_size: "10",
                blob_id: blobId,
                ...fields,
            });
        const blob = (fields: Record<string, string>, bytes = new Uint8Array(10)) => ({
            ...makeRecord(RecordType.assetBlob, blobId, fields),
            blob: bytes,
        });

        const cases = [
            [],
            [metadata({ filename: "renamed.pdf" })],
            [metadata({ record_role: "waveform-pyramid" })],
            [metadata({ session_id: newUuid() })],
            [metadata({ mime_type: "image/png" })],
            [metadata({ content_hash: "b".repeat(64) })],
            [metadata({ byte_size: "11" })],
            [metadata({ record_role: "asset-blob-manifest" })],
            [metadata({ blob_id: "" })],
            [metadata({}), blob({ _deleted: "true" })],
            [metadata({}), blob({ record_role: "asset-blob-chunk" }, new Uint8Array(9))],
            [
                metadata({}),
                blob({ record_role: "asset-blob-manifest", byte_size: "9" }, new Uint8Array(10)),
            ],
        ];
        for (const records of cases) {
            await expect(
                createAiRequestPreview(
                    packageJob,
                    provider,
                    undefined,
                    [],
                    false,
                    fakeSnapshot(records),
                ),
            ).rejects.toThrow(
                /changed after the package was prepared|failed its content validation/,
            );
        }
    });

    it("rejects non-PDF documents and mismatched image contents", async () => {
        const sessionId = newUuid();
        const initial = await openArchiveBytes(await createArchiveBytes("AI attachment checks"));
        const withSession = await appendRecords(initial, [
            makeRecord(RecordType.session, sessionId, {
                subject: "Science",
                student_id: "anonymous",
            }),
        ]);
        const pdfSnapshot = await appendRecords(
            withSession,
            await materialRecords(
                sessionId,
                "handout.pdf",
                "application/pdf",
                encoder.encode("plain"),
            ),
        );
        const pdfPackage = await createAiPackageRecord(pdfSnapshot, sessionId);
        const gemini = await makeProvider(
            "google-gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-2.5-flash",
        );
        await expect(
            createAiRequestPreview(pdfPackage.job, gemini, undefined, [], false, pdfSnapshot),
        ).rejects.toThrow("is not a valid PDF document.");

        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
        const imageRecords = await materialRecords(sessionId, "photo.jpg", "image/jpeg", pngBytes);
        const imageSnapshot = await appendRecords(withSession, imageRecords);
        const imagePackage = await createAiPackageRecord(imageSnapshot, sessionId, "auto", [
            imageRecords.at(-1)!.id,
        ]);
        await expect(
            createAiRequestPreview(imagePackage.job, gemini, undefined, [], false, imageSnapshot),
        ).rejects.toThrow("failed its content validation.");
    });

    it("validates image attachment manifests against the archive", async () => {
        const sessionId = newUuid();
        const imageId = newUuid();
        const image = {
            id: imageId,
            filename: "photo.png",
            mime_type: "image/png",
            content_hash: "a".repeat(64),
            byte_size: 10,
        };
        const makeImagePackage = (withSession = true) =>
            makePackageJob({
                manifest: {
                    format: "tutorux-ai-package-v1",
                    ...(withSession ? { session_id: sessionId } : {}),
                    attached_image_ids: [imageId],
                },
                attached_images: [image],
            });
        const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");

        await expect(createAiRequestPreview(await makeImagePackage(), provider)).rejects.toThrow(
            "Open the source archive to load its selected images.",
        );
        await expect(
            createAiRequestPreview(
                await makeImagePackage(false),
                provider,
                undefined,
                [],
                false,
                fakeSnapshot([]),
            ),
        ).rejects.toThrow("The AI package does not identify the session for its selected images.");
        await expect(
            createAiRequestPreview(
                await makeImagePackage(),
                provider,
                undefined,
                [],
                false,
                fakeSnapshot([]),
            ),
        ).rejects.toThrow("changed after the package was prepared");

        const metadata = (fields: Record<string, string>) =>
            makeRecord(RecordType.assetMetadata, imageId, {
                record_role: "material",
                session_id: sessionId,
                filename: "photo.png",
                mime_type: "image/png",
                byte_size: "10",
                content_hash: "a".repeat(64),
                blob_id: newUuid(),
                ...fields,
            });
        for (const record of [
            metadata({ mime_type: "text/plain" }),
            metadata({ session_id: newUuid() }),
            metadata({ filename: "other.png" }),
            metadata({ content_hash: "b".repeat(64) }),
            metadata({ byte_size: "11" }),
        ]) {
            await expect(
                createAiRequestPreview(
                    await makeImagePackage(),
                    provider,
                    undefined,
                    [],
                    false,
                    fakeSnapshot([record]),
                ),
            ).rejects.toThrow("changed after the package was prepared");
        }

        await expect(
            createAiRequestPreview(
                await makeImagePackage(),
                provider,
                undefined,
                [],
                false,
                fakeSnapshot([metadata({})]),
            ),
        ).rejects.toThrow("failed its content validation.");

        await expect(
            createAiRequestPreview(
                await makeImagePackage(),
                provider,
                undefined,
                [],
                false,
                fakeSnapshot([
                    metadata({}),
                    {
                        ...makeRecord(RecordType.assetBlob, newUuid(), {
                            record_role: "asset-blob-manifest",
                            byte_size: "9",
                        }),
                    },
                ]),
            ),
        ).rejects.toThrow("failed its content validation.");
    });

    it("rejects an image whose bytes do not match its declared type", async () => {
        const sessionId = newUuid();
        const initial = await openArchiveBytes(await createArchiveBytes("AI image mismatch"));
        const withSession = await appendRecords(initial, [
            makeRecord(RecordType.session, sessionId, { subject: "Art", student_id: "anonymous" }),
        ]);
        const records = await materialRecords(
            sessionId,
            "fake.png",
            "image/png",
            encoder.encode("plain text"),
        );
        const snapshot = await appendRecords(withSession, records);
        const summary = await createAiPackageRecord(snapshot, sessionId, "auto", [
            records.at(-1)!.id,
        ]);
        const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
        await expect(
            createAiRequestPreview(summary.job, provider, undefined, [], false, snapshot),
        ).rejects.toThrow("failed its content validation.");
    });

    it("reads top-level manifest fields and numeric byte sizes", async () => {
        const sessionId = newUuid();
        const packageJob = await makePackageJob({
            manifest: { format: "tutorux-ai-package-v1", session_id: sessionId },
            assets_manifest: [
                {
                    id: newUuid(),
                    filename: "handout.pdf",
                    mime_type: "application/pdf",
                    content_hash: "a".repeat(64),
                    byte_size: 10,
                },
            ],
        });
        const provider = await makeProvider(
            "google-gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-2.5-flash",
        );
        await expect(
            createAiRequestPreview(packageJob, provider, undefined, [], false, fakeSnapshot([])),
        ).rejects.toThrow("changed after the package was prepared");
    });

    it("matches credentials by provider key metadata", async () => {
        const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
        const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
        const preview = await createAiRequestPreview(packageJob, provider, undefined, [
            makeRecord(RecordType.settings, newUuid(), {
                provider_id: "other",
                key: "OPENAI_API_KEY",
            }),
        ]);
        expect(preview.credentialAvailable).toBe(true);
    });

    it("accepts matching declared image ids before loading the archive", async () => {
        const imageId = newUuid();
        const packageJob = await makePackageJob({
            manifest: { format: "tutorux-ai-package-v1", attached_image_ids: [imageId] },
            attached_images: [
                {
                    id: imageId,
                    filename: "photo.png",
                    mime_type: "image/png",
                    content_hash: "a".repeat(64),
                    byte_size: 10,
                },
            ],
        });
        const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
        await expect(createAiRequestPreview(packageJob, provider)).rejects.toThrow(
            "Open the source archive to load its selected images.",
        );
    });

    it("rejects image manifests whose declared ids disagree", async () => {
        const imageId = newUuid();
        const packageJob = await makePackageJob({
            manifest: {
                format: "tutorux-ai-package-v1",
                attached_image_ids: [newUuid()],
            },
            attached_images: [
                {
                    id: imageId,
                    filename: "photo.png",
                    mime_type: "image/png",
                    content_hash: "a".repeat(64),
                    byte_size: 10,
                },
            ],
        });
        const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
        await expect(createAiRequestPreview(packageJob, provider)).rejects.toThrow(
            "The AI image attachment list does not match its package manifest.",
        );
    });

    it("enforces the Replicate request size limit", async () => {
        const packageJob = await makePackageJob({
            manifest: { format: "tutorux-ai-package-v1" },
            filler: "x".repeat(8 * 1024 * 1024 - 400),
        });
        const provider = await makeProvider(
            "replicate",
            "https://api.replicate.com/v1",
            "owner/model",
        );
        await expect(
            createAiRequestPreview(packageJob, provider, undefined, [], false, undefined, {
                modelId: "owner/model",
                version: "v1",
                hasSystemPrompt: true,
                tokenInput: null,
            }),
        ).rejects.toThrow("The Replicate request exceeds the 8 MiB send limit.");
    });

    it("accepts OpenCode Zen endpoints without a version suffix", async () => {
        const packageJob = await makePackageJob({ manifest: { format: "tutorux-ai-package-v1" } });
        const provider = await makeProvider(
            "opencode-zen",
            "https://opencode.ai/inference",
            "gpt-5",
        );
        const preview = await createAiRequestPreview(packageJob, provider);
        expect(preview.endpoint).toBe("https://opencode.ai/inference/openai/v1/responses");
    });

    it("loads PNG, JPEG, and WebP images in supported protocols", async () => {
        const sessionId = newUuid();
        const initial = await openArchiveBytes(await createArchiveBytes("AI image formats"));
        const withSession = await appendRecords(initial, [
            makeRecord(RecordType.session, sessionId, { subject: "Art", student_id: "anonymous" }),
        ]);
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1]);
        const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
        const records = [
            ...(await materialRecords(sessionId, "a.png", "image/png", png)),
            ...(await materialRecords(sessionId, "b.jpg", "image/jpeg", jpeg)),
            ...(await materialRecords(sessionId, "c.webp", "image/webp", webp)),
        ];
        const snapshot = await appendRecords(withSession, records);
        const imageIds = records
            .filter((record) => record.type === RecordType.assetMetadata)
            .map((record) => record.id);
        const summary = await createAiPackageRecord(snapshot, sessionId, "auto", imageIds);
        const provider = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
        const preview = await createAiRequestPreview(
            summary.job,
            provider,
            undefined,
            [],
            false,
            snapshot,
        );
        expect(preview.attachedImages).toHaveLength(3);
        expect(preview.requestBody).toContain("data:image/png;base64,");
        expect(preview.requestBody).toContain("data:image/jpeg;base64,");
        expect(preview.requestBody).toContain("data:image/webp;base64,");
    });

    it("encodes OpenAI and Responses audio attachments and skips unsupported audio formats", async () => {
        const sessionId = newUuid();
        const initial = await openArchiveBytes(await createArchiveBytes("AI audio formats"));
        const withSession = await appendRecords(initial, [
            makeRecord(RecordType.session, sessionId, {
                subject: "Music",
                student_id: "anonymous",
            }),
        ]);
        const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
        const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1]);
        const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1]);
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
        const pngRecords = await materialRecords(sessionId, "d.png", "image/png", png);
        const snapshot = await appendRecords(withSession, [
            ...(await materialRecords(sessionId, "a.wav", "audio/wav", wav)),
            ...(await materialRecords(sessionId, "b.mp3", "audio/mpeg", mp3)),
            ...(await materialRecords(sessionId, "c.ogg", "audio/ogg", ogg)),
            ...pngRecords,
            ...(await materialRecords(
                sessionId,
                "handout.pdf",
                "application/pdf",
                encoder.encode("%PDF-1.4"),
                "Worksheet notes",
            )),
        ]);
        const summary = await createAiPackageRecord(snapshot, sessionId, "auto", [
            pngRecords.at(-1)!.id,
        ]);

        const openai = await makeProvider("openai", "https://api.openai.com/v1", "gpt-4.1");
        const openaiPreview = await createAiRequestPreview(
            summary.job,
            openai,
            undefined,
            [],
            false,
            snapshot,
        );
        const openaiBody = JSON.parse(openaiPreview.requestBody) as {
            messages: { content: { type: string; input_audio?: { format: string } }[] }[];
        };
        const openaiParts = openaiBody.messages[1]?.content as {
            type: string;
            input_audio?: { format: string };
        }[];
        expect(
            openaiParts
                .flatMap((part) => (part.input_audio ? [part.input_audio.format] : []))
                .sort(),
        ).toEqual(["mp3", "wav"]);

        const responses = await makeProvider(
            "opencode-zen",
            "https://opencode.ai/inference/v1",
            "gpt-5",
        );
        const responsesPreview = await createAiRequestPreview(
            summary.job,
            responses,
            undefined,
            [],
            false,
            snapshot,
        );
        const responsesBody = JSON.parse(responsesPreview.requestBody) as {
            input: { content: { type: string; input_audio?: { format: string } }[] }[];
        };
        const responseParts = responsesBody.input[0]?.content as {
            type: string;
            input_audio?: { format: string };
        }[];
        expect(responseParts.some((part) => part.type === "input_image")).toBe(true);
        expect(
            responseParts
                .flatMap((part) => (part.input_audio ? [part.input_audio.format] : []))
                .sort(),
        ).toEqual(["mp3", "wav"]);

        const anthropic = await makeProvider(
            "anthropic",
            "https://api.anthropic.com",
            "claude-sonnet-4",
        );
        const anthropicPreview = await createAiRequestPreview(
            summary.job,
            anthropic,
            undefined,
            [],
            false,
            snapshot,
        );
        const anthropicBody = JSON.parse(anthropicPreview.requestBody) as {
            messages: { content: { type?: string; text?: string }[] }[];
        };
        expect(
            anthropicBody.messages[0]?.content.some(
                (part) =>
                    typeof part.text === "string" && part.text.includes("Audio a.wav (audio/wav)"),
            ),
        ).toBe(true);

        const summaryNoImages = await createAiPackageRecord(snapshot, sessionId);
        const cohere = await makeProvider("cohere", "https://api.cohere.com", "command-a-03-2025");
        const coherePreview = await createAiRequestPreview(
            summaryNoImages.job,
            cohere,
            undefined,
            [],
            false,
            snapshot,
        );
        const cohereBody = JSON.parse(coherePreview.requestBody) as {
            messages: { content: string }[];
        };
        expect(cohereBody.messages[1]?.content).toContain("Document handout.pdf:\nWorksheet notes");
    });
});

function fakeSnapshot(records: readonly ArchiveRecord[]): ArchiveSnapshot {
    return {
        async getRecord(type: number, id: string) {
            return (
                records.find(
                    (item) => item.type === type && item.id.toLowerCase() === id.toLowerCase(),
                ) ?? null
            );
        },
        async listRecords(type: number) {
            return records.filter((item) => item.type === type);
        },
    } as unknown as ArchiveSnapshot;
}

async function materialRecords(
    sessionId: string,
    filename: string,
    mimeType: string,
    bytes: Uint8Array,
    extractedText = "",
): Promise<ArchiveRecord[]> {
    const blobId = newUuid();
    const chunkId = newUuid();
    const contentHash = await hash(bytes);
    return [
        {
            ...makeRecord(RecordType.assetBlob, chunkId, {
                record_role: "asset-blob-chunk",
                manifest_id: blobId,
                chunk_index: "0",
                byte_size: String(bytes.byteLength),
            }),
            blob: bytes.slice(),
        },
        makeRecord(RecordType.assetBlob, blobId, {
            record_role: "asset-blob-manifest",
            content_hash: contentHash,
            byte_size: String(bytes.byteLength),
            chunk_count: "1",
            chunk_ids: chunkId,
        }),
        makeRecord(RecordType.assetMetadata, newUuid(), {
            record_role: "material",
            session_id: sessionId,
            filename,
            mime_type: mimeType,
            byte_size: String(bytes.byteLength),
            content_hash: contentHash,
            blob_id: blobId,
            blob_count: "1",
            ...(extractedText ? { extracted_text: extractedText } : {}),
        }),
    ];
}

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
