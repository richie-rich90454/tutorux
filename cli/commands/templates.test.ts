import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeCli } from "../main";

describe("template CLI parity", () => {
    it("imports plain guidance and applies built-in overrides", async () => {
        const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-template-parity-"));
        const archivePath = join(directory, "lesson.tux");
        const guidancePath = join(directory, "review-guidance.md");
        const stdout: string[] = [];
        const stderr: string[] = [];
        const io = {
            stdout: (value: string) => stdout.push(value),
            stderr: (value: string) => stderr.push(value),
        };

        try {
            expect(
                await executeCli(["archive", "init", archivePath, "--name", "Templates"], io),
            ).toBe(0);
            await writeFile(guidancePath, "Ask one question at a time.", "utf8");
            expect(
                await executeCli(
                    [
                        "--json",
                        "--archive",
                        archivePath,
                        "template",
                        "import",
                        "--input",
                        guidancePath,
                    ],
                    io,
                ),
            ).toBe(0);
            const imported = JSON.parse(stdout.at(-1)!) as Record<string, string>;
            expect(imported["name"]).toBe("review-guidance");
            expect(imported["sections"]).toBe("");
            expect(imported["body"]).toBe("Ask one question at a time.");

            expect(
                await executeCli(
                    [
                        "--json",
                        "--archive",
                        archivePath,
                        "template",
                        "update",
                        "general",
                        "--description",
                        "Local wording.",
                    ],
                    io,
                ),
            ).toBe(0);
            expect(
                await executeCli(
                    ["--json", "--archive", archivePath, "template", "show", "general"],
                    io,
                ),
            ).toBe(0);
            expect((JSON.parse(stdout.at(-1)!) as { description: string }).description).toBe(
                "Local wording.",
            );

            expect(
                await executeCli(["--json", "--archive", archivePath, "template", "list"], io),
            ).toBe(0);
            const rows = JSON.parse(stdout.at(-1)!) as { id: string; description: string }[];
            expect(rows.filter((row) => row.id === "general")).toHaveLength(1);
            expect(rows.find((row) => row.id === "general")?.description).toBe("Local wording.");

            expect(
                await executeCli(
                    ["--json", "--archive", archivePath, "template", "delete", "general"],
                    io,
                ),
            ).toBe(0);
            expect(
                await executeCli(
                    ["--json", "--archive", archivePath, "template", "show", "general"],
                    io,
                ),
            ).toBe(0);
            expect((JSON.parse(stdout.at(-1)!) as { description: string }).description).not.toBe(
                "Local wording.",
            );
            expect(stderr).toEqual([]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
