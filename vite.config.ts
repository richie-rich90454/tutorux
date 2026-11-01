import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => ({
    plugins: [tailwindcss(), solid()],
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
        // Tailwind's Vite generator does not emit source maps; disabling output maps avoids
        // publishing broken maps and keeps desktop release files smaller.
        sourcemap: false,
        rolldownOptions: {
            output: {
                // Keep startup and shared dependency chunks comfortably below Vite's
                // warning threshold while retaining the existing lazy feature boundaries.
                // Strict execution order protects modules with initialization side effects.
                strictExecutionOrder: true,
                codeSplitting: {
                    groups: [
                        {
                            name: "tailwind-styles",
                            test: /[.]tailwind[.]tsx?$/u,
                            minSize: 32 * 1024,
                            maxSize: 440 * 1024,
                            entriesAware: true,
                            priority: 30,
                        },
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
