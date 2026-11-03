import { describe, expect, it, vi } from "vitest";
import {
    aiModelProtocolFamily,
    structuredOutputCapability,
} from "../../../frontend/ai/catalog-metadata";

vi.mock("../../../frontend/ai/providers", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../frontend/ai/providers")>();
    return {
        ...actual,
        openCodeZenProtocolForModel: (model: string) => {
            if (model === "explode") throw new Error("Provider protocol registry unavailable.");
            if (model === "weird") return "not-a-protocol";
            return actual.openCodeZenProtocolForModel(model);
        },
    };
});

describe("AI model catalog protocol fallbacks", () => {
    it("reports unknown and unsupported when the protocol helper throws", () => {
        expect(structuredOutputCapability("opencode-zen", "explode")).toBe("unknown");
        expect(aiModelProtocolFamily("opencode-zen", "explode")).toBe("unsupported");
    });

    it("defaults an unrecognized protocol to the OpenAI chat family", () => {
        expect(aiModelProtocolFamily("opencode-zen", "weird")).toBe("openai-chat-completions");
    });
});
