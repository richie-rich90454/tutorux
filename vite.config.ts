import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => ({
    plugins: [solid()],
    resolve: {
        alias: {
            "@platform": resolve(
                projectRoot,
                "frontend/platform",
                mode === "desktop" ? "tauri.ts" : "browser.ts",
            ),
        },
    },
    base: "./",
    optimizeDeps: {
        entries: ["index.html"],
    },
    build: {
        target: "es2022",
        sourcemap: true,
        rolldownOptions: {
            output: {
                // Keep startup and shared dependency chunks comfortably below Vite's
                // warning threshold while retaining the existing lazy feature boundaries.
                // Strict execution order protects modules with initialization side effects.
                strictExecutionOrder: true,
                codeSplitting: {
                    groups: [
                        {
                            name: "vendor",
                            test: /node_modules[\\/]/u,
                            minSize: 32 * 1024,
                            maxSize: 440 * 1024,
                            entriesAware: true,
                            priority: 20,
                        },
                        {
                            name: "initial",
                            tags: ["$initial"],
                            minSize: 32 * 1024,
                            maxSize: 440 * 1024,
                            entriesAware: true,
                            priority: 10,
                        },
                    ],
                },
            },
        },
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    },
}));
