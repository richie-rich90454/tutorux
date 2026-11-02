import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFile } from "../../cli/commands/archive-io";

describe("replaceFile", () => {
    it("refuses to replace a directory and preserves its contents", async () => {
        const directory = await mkdtemp(join(process.cwd(), "tutorux-replace-directory-"));
        const target = join(directory, "lesson.tux");
        const staged = join(directory, "lesson.staged");
        await mkdir(target);
        await writeFile(join(target, "original.txt"), "original material");
        await writeFile(staged, "replacement");

        try {
            await expect(replaceFile(staged, target)).rejects.toThrow(
                "Refusing to replace the non-regular file",
            );
            expect(await readFile(join(target, "original.txt"), "utf8")).toBe("original material");
            expect(await readdir(target)).toEqual(["original.txt"]);
            expect(await readdir(directory)).not.toContain("lesson.staged");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("restores the original and reports the backup path when publication fails", async () => {
        const directory = await mkdtemp(join(process.cwd(), "tutorux-replace-failure-"));
        const target = join(directory, "lesson.tux");
        const staged = join(directory, "lesson.staged");
        await writeFile(target, "original archive");

        try {
            const error = await replaceFile(staged, target).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain("Could not replace");
            expect((error as Error).message).toContain(".backup");
            expect(await readFile(target, "utf8")).toBe("original archive");
            expect((await readdir(directory)).filter((name) => name.endsWith(".backup"))).toEqual(
                [],
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
