import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(
    readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as { app: { security: { csp: string } } };

describe("desktop content security policy", () => {
    it("allows WebAssembly compilation without enabling JavaScript eval", () => {
        const scriptSource = config.app.security.csp
            .split(";")
            .find((directive) => directive.trimStart().startsWith("script-src "));

        expect(scriptSource).toContain("'wasm-unsafe-eval'");
        expect(scriptSource).not.toContain("'unsafe-eval'");
    });
});
