import { expect, test } from "./fixtures";

test("desktop CSP allows WebAssembly compilation without enabling eval", async ({ page }) => {
    const config = JSON.parse(
        await (
            await import("node:fs/promises")
        ).readFile(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    ) as { app: { security: { csp: string } } };
    const policy = config.app.security.csp;

    await page.route("**/__csp_probe", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "text/html",
            headers: { "Content-Security-Policy": policy },
            body: '<!doctype html><body><script src="/__csp_probe.js"></script></body>',
        });
    });
    await page.route("**/__csp_probe.js", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body: `
                (async () => {
                    try {
                        await WebAssembly.instantiate(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
                        document.body.dataset.wasm = "ready";
                    } catch (error) {
                        document.body.dataset.wasm = String(error);
                    }
                    try {
                        eval("1");
                        document.body.dataset.eval = "allowed";
                    } catch {
                        document.body.dataset.eval = "blocked";
                    }
                })();
            `,
        });
    });

    await page.goto("/__csp_probe");
    await expect(page.locator("body")).toHaveAttribute("data-wasm", "ready");
    await expect(page.locator("body")).toHaveAttribute("data-eval", "blocked");
});
