import { describe, expect, it } from "vitest";
import { extractAiResponseText, createAiGuideProposal } from "../../../frontend/ai/response";

const encoder = new TextEncoder();

describe("AI provider response decoding", () => {
    it("collects OpenAI-compatible Chat Completions SSE deltas", () => {
        const first = JSON.stringify({ choices: [{ delta: { content: '{"title":"A' } }] });
        const second = JSON.stringify({ choices: [{ delta: { content: ' guide"}' } }] });
        const response = [`data: ${first}`, `data: ${second}`, "data: [DONE]", ""].join("\n\n");
        expect(extractAiResponseText("openai", encoder.encode(response))).toBe(
            '{"title":"A guide"}',
        );
    });

    it("decodes the native stream formats used by supported providers", () => {
        expect(
            extractAiResponseText(
                "anthropic",
                encoder.encode(
                    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude"}}\n\n',
                ),
            ),
        ).toBe("Claude");
        expect(
            extractAiResponseText(
                "google-gemini",
                encoder.encode(
                    'data: {"candidates":[{"content":{"parts":[{"text":"Gemini"}]}}]}\n\n',
                ),
            ),
        ).toBe("Gemini");
        expect(
            extractAiResponseText(
                "cohere",
                encoder.encode(
                    'data: {"type":"content-delta","delta":{"message":{"content":{"text":"Cohere"}}}}\n\n',
                ),
            ),
        ).toBe("Cohere");
        expect(
            extractAiResponseText(
                "perplexity",
                encoder.encode(
                    'data: {"type":"response.output_text.delta","delta":"Perplexity"}\n\n',
                ),
            ),
        ).toBe("Perplexity");
        expect(
            extractAiResponseText(
                "ollama",
                encoder.encode(
                    '{"message":{"content":"Local"},"done":false}\n{"message":{"content":" model"},"done":true}\n',
                ),
            ),
        ).toBe("Local model");
    });

    it("reads bounded non-stream JSON responses and hides provider error bodies", () => {
        expect(
            extractAiResponseText(
                "openai",
                encoder.encode('{"choices":[{"message":{"content":"Complete"}}]}'),
            ),
        ).toBe("Complete");
        expect(() =>
            extractAiResponseText("openai", encoder.encode('{"error":{"message":"secret data"}}')),
        ).toThrow("The provider reported an error while generating the response.");
    });

    it("creates a structured draft while preserving unsafe or malformed output as text", () => {
        const structured = createAiGuideProposal(
            JSON.stringify({
                title: "Lesson guide",
                template_id: "wrong-template",
                sections: [
                    {
                        heading: "Key idea",
                        blocks: [{ kind: "paragraph", text: "Explain the idea.", source_ids: [] }],
                    },
                ],
            }),
            "session-id",
            "selected-template",
        );
        expect(structured.schemaValid).toBe(true);
        expect(structured.draft.templateId).toBe("selected-template");
        expect(structured.draft.sections[0]?.blocks[0]).toMatchObject({
            text: "Explain the idea.",
            origin: "ai-generated",
        });
        expect(structured.warnings).toHaveLength(1);

        const unstructured = createAiGuideProposal("A plain response", "session-id", "general");
        expect(unstructured.schemaValid).toBe(false);
        expect(unstructured.draft.sections[0]?.blocks[0]).toMatchObject({
            kind: "paragraph",
            text: "A plain response",
            sourceIds: "",
        });
        expect(() =>
            extractAiResponseText("openai", encoder.encode("not a provider response")),
        ).toThrow("The provider response contained invalid JSON data.");
    });
});
