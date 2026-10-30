const MAX_SCHEMA_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 300_000;

export type ReplicateTokenInput = "max_new_tokens" | "max_tokens" | "max_output_tokens";

export interface ReplicateModelInputSchema {
    modelId: string;
    version: string;
    hasSystemPrompt: boolean;
    tokenInput: ReplicateTokenInput | null;
}

/** Read only the supported, non-secret inputs needed to build a reviewed prediction body. */
export function parseReplicateModelInputSchema(
    bytes: Uint8Array,
    expectedModelId: string,
): ReplicateModelInputSchema {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCHEMA_RESPONSE_BYTES) {
        throw new Error("Replicate returned an empty or oversized model schema.");
    }

    let root: unknown;
    try {
        root = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        assertJsonDepth(root);
    } catch {
        throw new Error("Replicate returned an invalid model schema.");
    }

    if (!isObject(root)) throw new Error("Replicate returned an invalid model schema.");
    const latestVersion = root["latest_version"];
    const schema = isObject(latestVersion) ? latestVersion["openapi_schema"] : undefined;
    const components = isObject(schema) ? schema["components"] : undefined;
    const schemas = isObject(components) ? components["schemas"] : undefined;
    const input = isObject(schemas) ? schemas["Input"] : undefined;
    const properties = isObject(input) ? input["properties"] : undefined;
    const prompt =
        isObject(properties) && Object.hasOwn(properties, "prompt")
            ? properties["prompt"]
            : undefined;
    const version = isObject(latestVersion) ? latestVersion["id"] : undefined;

    if (
        !isObject(latestVersion) ||
        typeof version !== "string" ||
        version.length === 0 ||
        version.length > 256 ||
        !isObject(input) ||
        !isObject(properties) ||
        !isObject(prompt) ||
        prompt["type"] !== "string"
    ) {
        throw new Error(
            "This Replicate model does not expose a versioned string prompt input Tutorux can use.",
        );
    }
    if (prompt["x-cog-secret"] === true) {
        throw new Error(
            "This Replicate model marks its prompt as an author-defined secret input that Tutorux cannot collect safely.",
        );
    }

    const systemPrompt = Object.hasOwn(properties, "system_prompt")
        ? properties["system_prompt"]
        : undefined;
    const hasSystemPrompt =
        isObject(systemPrompt) &&
        systemPrompt["type"] === "string" &&
        systemPrompt["x-cog-secret"] !== true;
    const required = input["required"];
    if (
        required !== undefined &&
        (!Array.isArray(required) ||
            required.length > 256 ||
            required.some(
                (name) =>
                    typeof name !== "string" ||
                    name.length === 0 ||
                    name.length > 128 ||
                    [...name].some((character) => character.charCodeAt(0) < 0x20),
            ))
    ) {
        throw new Error("Replicate returned an invalid required-input list for this model.");
    }

    const requiredNames = (required ?? []) as string[];
    const tokenInputs = ["max_new_tokens", "max_tokens", "max_output_tokens"] as const;
    const isSupportedIntegerTokenInput = (name: (typeof tokenInputs)[number]): boolean => {
        const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
        return (
            isObject(property) &&
            property["type"] === "integer" &&
            property["x-cog-secret"] !== true
        );
    };
    const tokenInput =
        tokenInputs.find(
            (name) => requiredNames.includes(name) && isSupportedIntegerTokenInput(name),
        ) ?? tokenInputs.find(isSupportedIntegerTokenInput);

    for (const name of requiredNames) {
        const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
        if (isObject(property) && property["x-cog-secret"] === true) {
            throw new Error(
                `This Replicate model requires an author-defined secret input (${name}) that Tutorux cannot collect safely.`,
            );
        }
        if (
            name !== "prompt" &&
            !(name === "system_prompt" && hasSystemPrompt) &&
            name !== tokenInput
        ) {
            throw new Error(
                `This Replicate model requires an unsupported input (${name}). Choose a model with only prompt, system_prompt, and an optional supported token limit.`,
            );
        }
    }

    return {
        modelId: expectedModelId,
        version,
        hasSystemPrompt,
        tokenInput: tokenInput ?? null,
    };
}

function assertJsonDepth(root: unknown): void {
    const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    let visitedNodes = 0;
    while (pending.length > 0) {
        const current = pending.pop()!;
        visitedNodes += 1;
        if (visitedNodes > MAX_JSON_NODES) {
            throw new Error("Replicate returned a model schema with too many JSON values.");
        }
        if (current.depth > MAX_JSON_DEPTH) {
            throw new Error("Replicate returned a model schema that is nested too deeply.");
        }
        if (Array.isArray(current.value)) {
            for (const child of current.value)
                pending.push({ value: child, depth: current.depth + 1 });
        } else if (isObject(current.value)) {
            for (const child of Object.values(current.value)) {
                pending.push({ value: child, depth: current.depth + 1 });
            }
        }
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
