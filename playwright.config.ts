import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./tests/e2e",
    globalSetup: "./tests/e2e/global-setup.ts",
    fullyParallel: true,
    forbidOnly: Boolean(process.env["CI"]),
    retries: process.env["CI"] ? 2 : 0,
    reporter: "list",
    use: {
        baseURL: "http://127.0.0.1:1420",
        trace: "retain-on-failure",
        ...devices["Desktop Chrome"],
    },
    webServer: {
        command: "pnpm run build:e2e && pnpm run preview",
        url: "http://127.0.0.1:1420",
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
