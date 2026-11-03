import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";
import { convert } from "ast-v8-to-istanbul";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAstAsync } from "vite";

const distDirectory = resolve("dist");
const rawDirectory = resolve("coverage-e2e/raw");
let sequence = 0;

/**
 * Collect raw V8 coverage for every test and convert it back to the original
 * frontend sources with the build's source maps. The merge step in
 * scripts/e2e-coverage.mjs turns these snapshots into the enforced report.
 */
export const test = base.extend<{ e2eCoverage: void }>({
    e2eCoverage: [
        async ({ page }, use, testInfo) => {
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => {
                pageErrors.push(error.stack ?? error.message);
            });
            await page.coverage.startJSCoverage({ resetOnNavigation: false });
            await use();
            const entries = await page.coverage.stopJSCoverage();
            const merged: Record<string, unknown> = {};
            for (const entry of entries) {
                if (!entry.url.includes("/assets/") || !entry.url.endsWith(".js")) continue;
                const pathname = new URL(entry.url).pathname.replace(/^\/+/u, "");
                const bundle = join(distDirectory, pathname);
                const sourceMapPath = `${bundle}.map`;
                if (!existsSync(sourceMapPath)) continue;
                const source = entry.source;
                if (source === undefined) continue;
                const data = await convert({
                    ast: await parseAstAsync(source),
                    code: source,
                    coverage: { ...entry, url: pathToFileURL(bundle).href },
                    sourceMap: JSON.parse(readFileSync(sourceMapPath, "utf8")),
                });
                Object.assign(merged, data);
            }
            if (Object.keys(merged).length > 0) {
                await mkdir(rawDirectory, { recursive: true });
                sequence += 1;
                const name = `${testInfo.workerIndex}-${sequence}-${testInfo.testId}.json`;
                await writeFile(join(rawDirectory, name), JSON.stringify(merged));
            }
            if (pageErrors.length > 0) {
                throw new Error(`Uncaught page errors:\n${pageErrors.join("\n\n")}`);
            }
        },
        { auto: true },
    ],
});

export { expect };
export type { Page };
