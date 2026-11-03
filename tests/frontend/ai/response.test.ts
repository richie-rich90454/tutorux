import { describe, expect, it } from "vitest";
import {
    createAiGuideProposal,
    extractAiResponseMetadata,
    extractAiResponseText,
} from "../../../frontend/ai/response";

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

describe("AI provider response metadata", () => {
    it("returns empty metadata for undecodable bytes", () => {
        expect(extractAiResponseMetadata("openai", new Uint8Array([0xff]))).toEqual({
            providerResponseId: "",
            errorCode: "",
            errorMessage: "",
            retryAfter: "",
        });
    });

    it("reads Ollama metadata from newline-delimited objects", () => {
        const metadata = extractAiResponseMetadata(
            "ollama",
            encoder.encode(
                '{"id":"first"}\n\n{"response_id":"second"}\nnot json\n{"message":{"id":"third"}}\n',
            ),
        );
        expect(metadata.providerResponseId).toBe("first");
    });

    it("reads event-stream metadata and skips done or empty payloads", () => {
        const metadata = extractAiResponseMetadata(
            "openai",
            encoder.encode(
                'event: message\ndata: {"id":"  chat-1  "}\n\ndata: [DONE]\n\nid: 5\ndata:\n\n: comment\n',
            ),
        );
        expect(metadata.providerResponseId).toBe("chat-1");
    });

    it("reads plain JSON metadata from nested responses and messages", () => {
        expect(
            extractAiResponseMetadata(
                "openai",
                encoder.encode('{"responseId":"resp-1","response":{"id":"ignored"}}'),
            ).providerResponseId,
        ).toBe("resp-1");
        expect(
            extractAiResponseMetadata(
                "openai",
                encoder.encode('{"response":{"id":"nested-response"}}'),
            ).providerResponseId,
        ).toBe("nested-response");
        expect(
            extractAiResponseMetadata(
                "openai",
                encoder.encode('{"message":{"id":"nested-message"}}'),
            ).providerResponseId,
        ).toBe("nested-message");
        expect(
            extractAiResponseMetadata(
                "openai",
                encoder.encode('{"id":"   ","responseId":"resp-2","response_id":"resp-3"}'),
            ).providerResponseId,
        ).toBe("resp-2");
        expect(
            extractAiResponseMetadata(
                "openai",
                encoder.encode('{"id":"  ","response_id":"resp-4"}'),
            ).providerResponseId,
        ).toBe("resp-4");
    });

    it("reads provider error details in every supported shape", () => {
        const withCode = extractAiResponseMetadata(
            "openai",
            encoder.encode(
                '{"error":{"code":"rate_limit","message":"Slow down","retry_after":30}}',
            ),
        );
        expect(withCode).toEqual({
            providerResponseId: "",
            errorCode: "rate_limit",
            errorMessage: "Slow down",
            retryAfter: "30",
        });

        const withType = extractAiResponseMetadata(
            "anthropic",
            encoder.encode('{"error":{"type":"overloaded","status":503,"retryAfter":"10s"}}'),
        );
        expect(withType).toEqual({
            providerResponseId: "",
            errorCode: "overloaded",
            errorMessage: "",
            retryAfter: "10s",
        });

        const withStatus = extractAiResponseMetadata(
            "anthropic",
            encoder.encode('{"error":{"status":500}}'),
        );
        expect(withStatus.errorCode).toBe("500");

        expect(
            extractAiResponseMetadata("openai", encoder.encode('{"error":"plain failure"}')),
        ).toMatchObject({ errorMessage: "plain failure" });

        const typedError = extractAiResponseMetadata(
            "openai",
            encoder.encode('{"type":"error","code":"bad_request","message":"Bad","retry_after":5}'),
        );
        expect(typedError).toEqual({
            providerResponseId: "",
            errorCode: "bad_request",
            errorMessage: "Bad",
            retryAfter: "5",
        });

        const topLevelRetry = extractAiResponseMetadata(
            "openai",
            encoder.encode('{"retryAfter":12}'),
        );
        expect(topLevelRetry.retryAfter).toBe("12");
    });

    it("ignores malformed nested identifiers and repeated error metadata", () => {
        const malformed = extractAiResponseMetadata(
            "openai",
            encoder.encode('{"response":{"id":5},"message":{"id":5},"error":""}'),
        );
        expect(malformed).toEqual({
            providerResponseId: "",
            errorCode: "",
            errorMessage: "",
            retryAfter: "",
        });

        const noCode = extractAiResponseMetadata(
            "anthropic",
            encoder.encode('{"error":{"code":null,"type":null,"status":null}}'),
        );
        expect(noCode.errorCode).toBe("");

        const repeated = extractAiResponseMetadata(
            "openai",
            encoder.encode(
                'data: {"error":{"message":"first","code":"first","retry_after":1}}\n\ndata: {"error":{"message":"second","code":"second","retry_after":2}}\n\ndata: {"error":"third"}\n\n',
            ),
        );
        expect(repeated.errorCode).toBe("first");
        expect(repeated.errorMessage).toBe("first");
        expect(repeated.retryAfter).toBe("1");
    });
});

describe("AI provider response text edge cases", () => {
    it("rejects empty, oversized, and invalid UTF-8 responses", () => {
        expect(() => extractAiResponseText("openai", new Uint8Array())).toThrow(
            "The provider returned an empty or oversized response.",
        );
        expect(() => extractAiResponseText("openai", new Uint8Array(16 * 1024 * 1024 + 1))).toThrow(
            "The provider returned an empty or oversized response.",
        );
        expect(() => extractAiResponseText("openai", new Uint8Array([0xff]))).toThrow(
            "The provider response was not valid UTF-8.",
        );
        expect(() => extractAiResponseText("openai", encoder.encode("   "))).toThrow(
            "The provider returned no generated text.",
        );
    });

    it("decodes Replicate prediction outputs", () => {
        expect(
            extractAiResponseText(
                "replicate",
                encoder.encode('{"status":"succeeded","output":"Text result"}'),
            ),
        ).toBe("Text result");
        expect(
            extractAiResponseText(
                "replicate",
                encoder.encode('{"status":"succeeded","output":["A","B"]}'),
            ),
        ).toBe("AB");

        expect(() =>
            extractAiResponseText("replicate", encoder.encode('{"status":"failed","output":"x"}')),
        ).toThrow("The Replicate prediction failed. Its raw response was saved for export.");
        expect(() =>
            extractAiResponseText("replicate", encoder.encode('{"status":"processing"}')),
        ).toThrow("The Replicate prediction did not finish successfully.");
        expect(() =>
            extractAiResponseText(
                "replicate",
                encoder.encode('{"status":"succeeded","output":{"text":"x"}}'),
            ),
        ).toThrow("Replicate returned a non-text prediction output.");
        expect(() =>
            extractAiResponseText(
                "replicate",
                encoder.encode('{"status":"succeeded","output":["a",1]}'),
            ),
        ).toThrow("Replicate returned a non-text prediction output.");
        expect(() =>
            extractAiResponseText(
                "replicate",
                encoder.encode('{"status":"succeeded","output":"   "}'),
            ),
        ).toThrow("Replicate returned no generated text.");
    });

    it("decodes Ollama streams in strict and partial modes", () => {
        expect(
            extractAiResponseText(
                "ollama",
                encoder.encode(
                    '{"message":{"content":"A"}}\n\n{"done":true}\nnot json\n{"message":{"content":"B"}}\n{"message":{"content":5}}\n',
                ),
                "",
                true,
            ),
        ).toBe("AB");
        expect(() =>
            extractAiResponseText(
                "ollama",
                encoder.encode('{"message":{"content":"A"}}\nnot json\n'),
            ),
        ).toThrow("The provider response contained invalid JSON data.");
        expect(() =>
            extractAiResponseText("ollama", encoder.encode('{"error":"model crashed"}')),
        ).toThrow("The local model reported an error while generating the response.");
        expect(() =>
            extractAiResponseText("ollama", encoder.encode('{"message":{"content":"  "}}')),
        ).toThrow("The provider returned no generated text.");
    });

    it("tolerates missing or malformed stream fields", () => {
        const streams: Array<[string, string]> = [
            [
                "openai",
                'data: {}\n\ndata: {"choices":[5]}\n\ndata: {"choices":[{"delta":5}]}\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            ],
            [
                "google-gemini",
                'data: {"candidates":5}\n\ndata: {"candidates":[{"content":5}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
            ],
            [
                "cohere",
                'data: {"type":"content-delta","delta":5}\n\ndata: {"type":"content-delta","delta":{"message":{"content":5}}}\n\ndata: {"type":"content-delta","delta":{"message":{"content":{"text":"ok"}}}}\n\n',
            ],
            [
                "anthropic",
                'data: {"type":"message","delta":5}\n\ndata: {"type":"message","delta":{"text":"ok"}}\n\n',
            ],
        ];
        for (const [provider, stream] of streams) {
            expect(extractAiResponseText(provider, encoder.encode(stream))).toBe("ok");
        }
    });

    it("skips malformed events only when partial output is allowed", () => {
        const stream =
            'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: not json\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\n';
        expect(extractAiResponseText("openai", encoder.encode(stream), "", true)).toBe("AB");
        expect(() => extractAiResponseText("openai", encoder.encode(stream))).toThrow(
            "The provider response contained invalid JSON data.",
        );
    });

    it("reports provider error events in streams", () => {
        for (const payload of [
            'data: {"error":{"message":"failed"}}\n\n',
            'data: {"type":"error"}\n\n',
            'data: {"type":"response.failed"}\n\n',
            "event: error\ndata: {}\n\n",
        ]) {
            expect(() => extractAiResponseText("openai", encoder.encode(payload))).toThrow(
                "The provider reported an error while generating the response.",
            );
        }
    });

    it("decodes OpenAI-compatible full responses and content arrays", () => {
        expect(
            extractAiResponseText(
                "openai",
                encoder.encode(
                    '{"choices":[{"message":{"content":[{"text":"A"},{"text":"B"},5,"x"]}}]}',
                ),
            ),
        ).toBe("AB");
        expect(() =>
            extractAiResponseText(
                "openai",
                encoder.encode('{"choices":[{"message":{"content":5}}]}'),
            ),
        ).toThrow("The provider returned no generated text.");
    });

    it("decodes every OpenCode Zen protocol family", () => {
        expect(
            extractAiResponseText(
                "opencode-zen",
                encoder.encode('{"choices":[{"message":{"content":"Chat"}}]}'),
                "llama-3",
            ),
        ).toBe("Chat");
        expect(
            extractAiResponseText(
                "opencode-zen",
                encoder.encode('{"content":[{"text":"Claude"}]}'),
                "claude-sonnet-4",
            ),
        ).toBe("Claude");
        expect(
            extractAiResponseText(
                "opencode-zen",
                encoder.encode('{"candidates":[{"content":{"parts":[{"text":"Gemini"}]}}]}'),
                "gemini-2.5",
            ),
        ).toBe("Gemini");
        expect(
            extractAiResponseText(
                "opencode-zen",
                encoder.encode('{"output":[{"content":[{"text":"Responses"}]}]}'),
                "gpt-5",
            ),
        ).toBe("Responses");
        expect(() =>
            extractAiResponseText("opencode-zen", encoder.encode('{"choices":[]}'), "jev-1"),
        ).toThrow(
            "OpenCode Zen Jev models return structured classifications, not tutoring guide text.",
        );
    });

    it("decodes Anthropic, Gemini, Cohere, and Perplexity stream variants", () => {
        expect(() =>
            extractAiResponseText(
                "anthropic",
                encoder.encode('event: ping\ndata: {"delta":{"text":"ignored"}}\n\n'),
            ),
        ).toThrow("The provider returned no generated text.");
        expect(
            extractAiResponseText("anthropic", encoder.encode('{"content":[{"text":"A"}]}')),
        ).toBe("A");
        expect(
            extractAiResponseText(
                "google-gemini",
                encoder.encode(
                    'data: {"candidates":[{"content":{"parts":["bad",{"other":1},{"text":"A"}]}}]}\n\n',
                ),
            ),
        ).toBe("A");
        expect(() =>
            extractAiResponseText("google-gemini", encoder.encode('data: {"candidates":[5]}\n\n')),
        ).toThrow("The provider returned no generated text.");
        expect(() =>
            extractAiResponseText(
                "cohere",
                encoder.encode('data: {"type":"content-delta","delta":{"message":"x"}}\n\n'),
            ),
        ).toThrow("The provider returned no generated text.");
        expect(
            extractAiResponseText(
                "cohere",
                encoder.encode('{"message":{"content":[{"text":"Full"}]}}'),
            ),
        ).toBe("Full");
        expect(
            extractAiResponseText(
                "perplexity",
                encoder.encode('{"output":[{"content":[{"text":"A"}]},{"content":"bad"},"x"]}'),
            ),
        ).toBe("A");
        expect(() =>
            extractAiResponseText("perplexity", encoder.encode('{"output":"bad"}')),
        ).toThrow("The provider returned no generated text.");
    });

    it("rejects non-object JSON responses and unsupported providers", () => {
        expect(() => extractAiResponseText("openai", encoder.encode("[]"))).toThrow(
            "The provider response data was not a JSON object.",
        );
        expect(() => extractAiResponseText("unknown-provider", encoder.encode("{}"))).toThrow(
            "The provider returned no generated text.",
        );
    });
});

describe("AI guide proposal validation", () => {
    const valid = (overrides: Record<string, unknown> = {}): string =>
        JSON.stringify({
            title: "Guide",
            template_id: "general",
            sections: [
                {
                    heading: "Section",
                    blocks: [{ kind: "paragraph", text: "Text", source_ids: [] }],
                },
            ],
            ...overrides,
        });

    it("strips code fences and rejects non-object JSON", () => {
        expect(
            createAiGuideProposal("```json\n" + valid() + "\n```", "session", "general")
                .schemaValid,
        ).toBe(true);
        for (const text of ["```", "```json\n{}", "[]", "42"]) {
            expect(createAiGuideProposal(text, "session", "general").schemaValid).toBe(false);
        }
        const deep = "[".repeat(40) + "]".repeat(40);
        expect(createAiGuideProposal(deep, "session", "general").schemaValid).toBe(false);
    });

    it("rejects invalid top-level guide fields", () => {
        const cases = [
            valid({ title: undefined }),
            valid({ title: "" }),
            valid({ title: "x".repeat(1025) }),
            valid({ template_id: undefined }),
            valid({ template_id: "" }),
            valid({ template_id: "x".repeat(129) }),
            valid({ sections: undefined }),
            valid({ sections: [] }),
            valid({ sections: new Array(501).fill({ heading: "h", blocks: [] }) }),
        ];
        for (const text of cases) {
            const proposal = createAiGuideProposal(text, "session", "general");
            expect(proposal.schemaValid).toBe(false);
            expect(proposal.warnings).toHaveLength(1);
        }
    });

    it("rejects invalid sections and blocks", () => {
        const cases = [
            valid({ sections: [5] }),
            valid({ sections: [{ heading: "", blocks: [] }] }),
            valid({ sections: [{ heading: "h".repeat(2049), blocks: [] }] }),
            valid({ sections: [{ heading: "h", blocks: "x" }] }),
            valid({
                sections: [
                    {
                        heading: "h",
                        blocks: new Array(5001).fill({
                            kind: "paragraph",
                            text: "t",
                            source_ids: [],
                        }),
                    },
                ],
            }),
            valid({ sections: [{ heading: "h", blocks: [5] }] }),
            valid({
                sections: [
                    { heading: "h", blocks: [{ kind: "unsupported", text: "t", source_ids: [] }] },
                ],
            }),
            valid({
                sections: [{ heading: "h", blocks: [{ kind: 5, text: "t", source_ids: [] }] }],
            }),
            valid({
                sections: [
                    { heading: "h", blocks: [{ kind: "paragraph", text: 5, source_ids: [] }] },
                ],
            }),
            valid({
                sections: [
                    {
                        heading: "h",
                        blocks: [
                            {
                                kind: "paragraph",
                                text: "x".repeat(4 * 1024 * 1024 + 1),
                                source_ids: [],
                            },
                        ],
                    },
                ],
            }),
            valid({
                sections: [
                    { heading: "h", blocks: [{ kind: "paragraph", text: "t", source_ids: "x" }] },
                ],
            }),
            valid({
                sections: [
                    {
                        heading: "h",
                        blocks: [
                            { kind: "paragraph", text: "t", source_ids: new Array(501).fill("id") },
                        ],
                    },
                ],
            }),
            valid({
                sections: [
                    {
                        heading: "h",
                        blocks: [{ kind: "paragraph", text: "t", source_ids: [5] }],
                    },
                ],
            }),
        ];
        for (const text of cases) {
            expect(createAiGuideProposal(text, "session", "general").schemaValid).toBe(false);
        }
    });

    it("warns when the response selects a different template", () => {
        const proposal = createAiGuideProposal(
            valid({ template_id: "other" }),
            "session",
            "general",
        );
        expect(proposal.schemaValid).toBe(true);
        expect(proposal.draft.templateId).toBe("general");
        expect(proposal.warnings).toHaveLength(1);
    });
});
