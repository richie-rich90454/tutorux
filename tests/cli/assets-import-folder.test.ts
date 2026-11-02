import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeCli } from "../../cli/main";

describe("asset import-folder", () => {
    it("imports nested regular files in relative-path order", async () => {
        const directory = await mkdtemp(join(process.cwd(), "tutorux-import-folder-"));
        const archivePath = join(directory, "lesson.tux");
        const source = join(directory, "materials");
        await mkdir(join(source, "nested", "deeper"), { recursive: true });
        await writeFile(join(source, "root.txt"), "root");
        await writeFile(join(source, "nested", "a.txt"), "a");
        await writeFile(join(source, "nested", "deeper", "b.txt"), "b");
        // Symlinks are skipped rather than followed out of the selected folder.
        await symlink(join(source, "root.txt"), join(source, "nested", "link.txt"), "file").catch(
            () => undefined,
        );
        const stdout: string[] = [];
        const stderr: string[] = [];
        const io = {
            stdout: (value: string) => stdout.push(value),
            stderr: (value: string) => stderr.push(value),
        };

        try {
            expect(await executeCli(["archive", "init", archivePath, "--name", "Folder"], io)).toBe(
                0,
            );
            expect(
                await executeCli(
                    ["--json", "--archive", archivePath, "asset", "import-folder", source],
                    io,
                ),
            ).toBe(0);
            const imported = JSON.parse(stdout.at(-1)!) as Array<{ filename: string }>;
            expect(imported.map((asset) => asset.filename)).toEqual(["a.txt", "b.txt", "root.txt"]);
            expect(
                await executeCli(["--json", "--archive", archivePath, "asset", "list"], io),
            ).toBe(0);
            expect(JSON.parse(stdout.at(-1)!)).toHaveLength(3);
            expect(stderr).toEqual([]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("rejects a folder with more than 10,000 regular files", async () => {
        const directory = await mkdtemp(join(process.cwd(), "tutorux-import-folder-limit-"));
        const archivePath = join(directory, "lesson.tux");
        const source = join(directory, "materials");
        await mkdir(source);
        for (let index = 0; index < 10_001; index += 1) {
            await writeFile(join(source, `file-${index}.txt`), "");
        }
        const stdout: string[] = [];
        const stderr: string[] = [];
        const io = {
            stdout: (value: string) => stdout.push(value),
            stderr: (value: string) => stderr.push(value),
        };

        try {
            expect(await executeCli(["archive", "init", archivePath, "--name", "Limit"], io)).toBe(
                0,
            );
            expect(
                await executeCli(
                    ["--json", "--archive", archivePath, "asset", "import-folder", source],
                    io,
                ),
            ).toBe(2);
            expect(stderr.at(-1)).toContain("10,000 regular files");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }, 120_000);
});
