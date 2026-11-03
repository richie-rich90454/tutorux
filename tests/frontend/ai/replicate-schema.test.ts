import { describe, expect, it } from "vitest";
import { parseReplicateModelInputSchema } from "../../../frontend/ai/replicate-schema";

const encoder = new TextEncoder();

type Properties = Record<string, Record<string, unknown>>;

function schemaBytes(
    options: {
        version?: unknown;
        properties?: Properties;
        required?: unknown;
        latestVersion?: unknown;
        input?: unknown;
    } = {},
): Uint8Array {
    const properties = options.properties ?? { prompt: { type: "string" } };
    const input =
        options.input ??
        ({
            properties,
            ...(options.required === undefined ? {} : { required: options.required }),
        } as Record<string, unknown>);
    const latestVersion =
        options.latestVersion ??
        ({
            id: options.version ?? "version-1",
            openapi_schema: {
                components: { schemas: { Input: input } },
            },
        } as Record<string, unknown>);
    return encoder.encode(JSON.stringify({ latest_version: latestVersion }));
}

function parse(options: Parameters<typeof schemaBytes>[0] = {}) {
    return parseReplicateModelInputSchema(schemaBytes(options), "owner/model");
}

describe("parseReplicateModelInputSchema", () => {
    it("reads a versioned string prompt input", () => {
        expect(parse()).toEqual({
            modelId: "owner/model",
            version: "version-1",
            hasSystemPrompt: false,
            tokenInput: null,
        });
    });

    it("accepts a non-secret system prompt", () => {
        expect(
            parse({
                properties: {
                    prompt: { type: "string" },
                    system_prompt: { type: "string" },
                },
            }).hasSystemPrompt,
        ).toBe(true);
    });

    it("does not treat a secret or non-string system prompt as supported", () => {
        expect(
            parse({
                properties: {
                    prompt: { type: "string" },
                    system_prompt: { type: "string", "x-cog-secret": true },
                },
            }).hasSystemPrompt,
        ).toBe(false);
        expect(
            parse({
                properties: {
                    prompt: { type: "string" },
                    system_prompt: { type: "integer" },
                },
            }).hasSystemPrompt,
        ).toBe(false);
    });

    it("prefers a required supported integer token input", () => {
        const properties: Properties = {
            prompt: { type: "string" },
            max_new_tokens: { type: "integer" },
            max_tokens: { type: "integer" },
            max_output_tokens: { type: "integer" },
        };
        expect(parse({ properties, required: ["prompt", "max_output_tokens"] }).tokenInput).toBe(
            "max_output_tokens",
        );
        expect(parse({ properties, required: ["max_tokens"] }).tokenInput).toBe("max_tokens");
    });

    it("falls back to the first supported optional token input", () => {
        const properties: Properties = {
            prompt: { type: "string" },
            max_new_tokens: { type: "string" },
            max_tokens: { type: "integer" },
        };
        expect(parse({ properties, required: ["prompt"] }).tokenInput).toBe("max_tokens");
    });

    it("ignores secret, non-integer, and absent token inputs", () => {
        expect(
            parse({
                properties: {
                    prompt: { type: "string" },
                    max_new_tokens: { type: "integer", "x-cog-secret": true },
                    max_tokens: { type: "number" },
                },
                required: ["prompt"],
            }).tokenInput,
        ).toBeNull();
    });

    it("rejects empty and oversized schema payloads", () => {
        expect(() => parseReplicateModelInputSchema(new Uint8Array(), "owner/model")).toThrow(
            "Replicate returned an empty or oversized model schema.",
        );
        expect(() =>
            parseReplicateModelInputSchema(new Uint8Array(8 * 1024 * 1024 + 1), "owner/model"),
        ).toThrow("Replicate returned an empty or oversized model schema.");
    });

    it("rejects invalid JSON, invalid UTF-8, and excessive nesting", () => {
        expect(() =>
            parseReplicateModelInputSchema(encoder.encode("{not json"), "owner/model"),
        ).toThrow("Replicate returned an invalid model schema.");
        expect(() =>
            parseReplicateModelInputSchema(new Uint8Array([0xff, 0xfe]), "owner/model"),
        ).toThrow("Replicate returned an invalid model schema.");

        let nested: unknown = 1;
        for (let index = 0; index < 70; index += 1) nested = [nested];
        expect(() =>
            parseReplicateModelInputSchema(
                encoder.encode(JSON.stringify({ latest_version: nested })),
                "owner/model",
            ),
        ).toThrow("Replicate returned an invalid model schema.");
    });

    it("rejects schemas with too many JSON values", () => {
        const wide = new Array<number>(300_001).fill(0);
        expect(() =>
            parseReplicateModelInputSchema(
                encoder.encode(JSON.stringify({ latest_version: wide })),
                "owner/model",
            ),
        ).toThrow("Replicate returned an invalid model schema.");
    });

    it("rejects non-object roots and missing schema sections", () => {
        for (const raw of ["null", "[]", "42", '"text"']) {
            expect(() =>
                parseReplicateModelInputSchema(encoder.encode(raw), "owner/model"),
            ).toThrow("Replicate returned an invalid model schema.");
        }

        const invalid = [
            { latest_version: undefined },
            { latest_version: "v1" },
            { latest_version: { id: "v1" } },
            { latest_version: { id: "v1", openapi_schema: "schema" } },
            { latest_version: { id: "v1", openapi_schema: { components: "x" } } },
            { latest_version: { id: "v1", openapi_schema: { components: { schemas: "x" } } } },
            {
                latest_version: {
                    id: "v1",
                    openapi_schema: { components: { schemas: { Input: "x" } } },
                },
            },
        ];
        for (const value of invalid) {
            expect(() =>
                parseReplicateModelInputSchema(
                    encoder.encode(JSON.stringify(value)),
                    "owner/model",
                ),
            ).toThrow(
                "This Replicate model does not expose a versioned string prompt input Tutorux can use.",
            );
        }
    });

    it("rejects missing, malformed, or oversized prompts", () => {
        const cases: Array<Parameters<typeof schemaBytes>[0]> = [
            { properties: {} },
            { properties: { prompt: { type: "integer" } } },
            { properties: { prompt: { type: 5 } } },
            { version: "" },
            { version: 5 },
            { version: "v".repeat(257) },
        ];
        for (const options of cases) {
            expect(() => parse(options)).toThrow(
                "This Replicate model does not expose a versioned string prompt input Tutorux can use.",
            );
        }
    });

    it("rejects a prompt marked as an author-defined secret", () => {
        expect(() =>
            parse({ properties: { prompt: { type: "string", "x-cog-secret": true } } }),
        ).toThrow(
            "This Replicate model marks its prompt as an author-defined secret input that Tutorux cannot collect safely.",
        );
    });

    it("rejects invalid required-input lists", () => {
        const cases: unknown[] = [
            "prompt",
            new Array<string>(257).fill("prompt"),
            [5],
            [""],
            ["x".repeat(129)],
            ["bad\u0001name"],
        ];
        for (const required of cases) {
            expect(() => parse({ required })).toThrow(
                "Replicate returned an invalid required-input list for this model.",
            );
        }
    });

    it("rejects required secret and unsupported inputs", () => {
        expect(() =>
            parse({
                properties: {
                    prompt: { type: "string" },
                    api_key: { type: "string", "x-cog-secret": true },
                },
                required: ["prompt", "api_key"],
            }),
        ).toThrow(
            "This Replicate model requires an author-defined secret input (api_key) that Tutorux cannot collect safely.",
        );

        expect(() => parse({ required: ["prompt", "seed"] })).toThrow(
            "This Replicate model requires an unsupported input (seed).",
        );

        expect(() =>
            parse({
                properties: {
                    prompt: { type: "string" },
                    system_prompt: { type: "integer" },
                },
                required: ["prompt", "system_prompt"],
            }),
        ).toThrow("This Replicate model requires an unsupported input (system_prompt).");
    });

    it("accepts required prompt, supported system prompt, and token limit together", () => {
        expect(
            parse({
                properties: {
                    prompt: { type: "string" },
                    system_prompt: { type: "string" },
                    max_new_tokens: { type: "integer" },
                },
                required: ["prompt", "system_prompt", "max_new_tokens"],
            }),
        ).toEqual({
            modelId: "owner/model",
            version: "version-1",
            hasSystemPrompt: true,
            tokenInput: "max_new_tokens",
        });
    });
});
