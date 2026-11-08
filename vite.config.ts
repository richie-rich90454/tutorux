import { defineConfig } from "vitest/config";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";

const browserCsp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "connect-src 'self' https://models.dev https://api.openai.com https://api.anthropic.com https://generativelanguage.googleapis.com https://api.cohere.com https://api.perplexity.ai https://api.replicate.com https://api.x.ai https://openrouter.ai https://api.together.ai https://api.together.xyz https://api.fireworks.ai https://api.deepinfra.com https://api.novita.ai https://api.studio.nebius.com https://api.groq.com https://api.cerebras.ai https://api.sambanova.ai https://integrate.api.nvidia.com https://api.deepseek.com https://api.mistral.ai https://router.huggingface.co https://api.moonshot.ai https://api.z.ai https://api.minimax.io https://api.siliconflow.cn https://dashscope.aliyuncs.com https://qianfan.baidubce.com https://tokenhub.tencentmaas.com https://ark.cn-beijing.volces.com https://*.api.aws https://*.openai.azure.com https://api.cloudflare.com https://api.ai21.com https://opencode.ai http://127.0.0.1:* http://localhost:*",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join("; ");

function browserCspPlugin() {
    return {
        name: "tutorux-browser-csp",
        apply: "build" as const,
        transformIndexHtml(html: string): string {
            return html.replace(
                "</head>",
                `    <meta http-equiv="Content-Security-Policy" content="${browserCsp}" />\n    </head>`,
            );
        },
    };
}

export default defineConfig(({ mode }) => ({
    plugins: [tailwindcss(), solid(), ...(mode === "desktop" ? [] : [browserCspPlugin()])],
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
        coverage: {
            provider: "v8",
            include: [
                "frontend/app/router.ts",
                "frontend/app/workspace-path.ts",
                "frontend/shared/attendance.ts",
                "frontend/shared/format.ts",
            ],
            exclude: ["frontend/**/*.d.ts"],
            reporter: ["text-summary", "json-summary", "json"],
            reportsDirectory: "coverage",
            thresholds: {
                statements: 100,
                branches: 100,
                functions: 100,
                lines: 100,
            },
        },
    },
}));
