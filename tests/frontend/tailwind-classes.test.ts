import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const frontendRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "frontend");
const arbitraryValueWithSpaces = /[A-Za-z0-9_:/.-]+-\[[^\]]*\s[^\]]*\]/gu;
const invalidScaleFraction = /\b(?:opacity-0\.\d+|opacity-1(?!\d)|outline-offset-0\.\d+)\b/gu;
const invalidNegativeOffset = /(?:left|right|top|bottom|inset)--\d/gu;
const bannedVisualUtility =
    /\b(?:bg-(?:linear|radial|conic)(?:-\d+)?|from-[a-z]|via-[a-z]|to-[a-z]|backdrop-(?:blur|filter)|uppercase|border-[lrtb]-[248])\b/gu;

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
    });
}

describe("Tailwind class strings", () => {
    it("never contains spaces inside an arbitrary value or invalid scale fractions", () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(frontendRoot)) {
            const lines = readFileSync(file, "utf8").split("\n");
            for (const [index, line] of lines.entries()) {
                for (const pattern of [
                    arbitraryValueWithSpaces,
                    invalidScaleFraction,
                    invalidNegativeOffset,
                    bannedVisualUtility,
                ]) {
                    for (const match of line.matchAll(pattern)) {
                        offenders.push(`${file}:${index + 1}: ${match[0]}`);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
