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
  },
  test: {
    environment: "node",
    include: ["frontend/**/*.test.ts", "frontend/**/*.test.tsx", "cli/**/*.test.ts"],
  },
}));
