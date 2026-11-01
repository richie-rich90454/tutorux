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
        // libsodium-wrappers-sumo is a single ~534 kB vendor module. It is kept
        // behind lazy crypto imports, so allow that known chunk while warning
        // on chunks larger than 535 kB.
        chunkSizeWarningLimit: 535,
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    },
}));
