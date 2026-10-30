import eslint from "@eslint/js";
import solid from "eslint-plugin-solid";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["dist/**", "build/**", "src-tauri/target/**", "node_modules/**"] },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["scripts/**/*.mjs"],
        languageOptions: {
            globals: {
                Buffer: "readonly",
                console: "readonly",
                fetch: "readonly",
                process: "readonly",
            },
        },
    },
    {
        files: [
            "frontend/**/*.{ts,tsx}",
            "cli/**/*.ts",
            "scripts/**/*.ts",
            "tests/e2e/**/*.ts",
            "*.ts",
        ],
        plugins: { solid },
        rules: {
            ...solid.configs.recommended.rules,
            "no-console": ["error", { allow: ["warn", "error"] }],
            "@typescript-eslint/consistent-type-imports": "error",
        },
    },
);
