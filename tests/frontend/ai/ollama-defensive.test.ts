import { describe, expect, it, vi } from "vitest";
import { listOllamaInstalledModels } from "../../../frontend/ai/ollama";

vi.mock("../../../frontend/ai/providers", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../frontend/ai/providers")>();
    return {
        ...actual,
        providerById: (providerId: string) =>
            providerId === "ollama" ? undefined : actual.providerById(providerId),
    };
});

describe("Ollama provider availability", () => {
    it("rejects an installation whose provider registry omits Ollama", async () => {
        await expect(listOllamaInstalledModels("http://127.0.0.1:11434")).rejects.toThrow(
            "Ollama is not a supported provider.",
        );
    });
});
