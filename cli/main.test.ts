import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeCli } from "./main";
import {
  appendRecords,
  createArchiveBytes,
  openArchiveBytes,
  verifyArchiveSnapshot,
} from "../frontend/archive/archive";
import { newUuid, RecordType } from "../frontend/archive/format";
describe("CLI sanitized archive copies", () => {
  it("requires a reviewed sanitized-copy preview and publishes a private-data-filtered archive", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-sanitize-"));
    const archivePath = join(directory, "lesson.tux");
    const outputPath = join(directory, "sanitized.tux");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      let source = await openArchiveBytes(await createArchiveBytes("Sanitize lesson"));
      const studentId = newUuid();
      const sessionId = newUuid();
      const publicAnnotationId = newUuid();
      const privateAnnotationId = newUuid();
      source = await appendRecords(source, [
        {
          type: RecordType.student,
          id: studentId,
          revision: 0n,
          previousOffset: 0n,
          fields: new Map([["display_name", "Mina"]]),
          blob: new Uint8Array(),
        },
        {
          type: RecordType.session,
          id: sessionId,
          revision: 0n,
          previousOffset: 0n,
          fields: new Map([
            ["title", "Fractions"],
            ["student_id", studentId],
            ["session_type", "notes-only"],
            ["recording_state", "not-started"],
          ]),
          blob: new Uint8Array(),
        },
        {
          type: RecordType.annotation,
          id: publicAnnotationId,
          revision: 0n,
          previousOffset: 0n,
          fields: new Map([
            ["session_id", sessionId],
            ["content", "Visible observation"],
          ]),
          blob: new Uint8Array(),
        },
        {
          type: RecordType.annotation,
          id: privateAnnotationId,
          revision: 0n,
          previousOffset: 0n,
          fields: new Map([
            ["session_id", sessionId],
            ["content", "Private observation"],
            ["visibility", "restricted"],
          ]),
          blob: new Uint8Array(),
        },
        {
          type: RecordType.settings,
          id: newUuid(),
          revision: 0n,
          previousOffset: 0n,
          fields: new Map([
            ["record_role", "provider-settings"],
            ["api_key", "private-token-value"],
          ]),
          blob: new Uint8Array(),
        },
      ]);
      const sourceBytes = await source.source.read(0n, Number(source.source.size));
      await writeFile(archivePath, sourceBytes);

      expect(
        await executeCli(
          [
            "archive",
            "sanitize",
            archivePath,
            "--output",
            outputPath,
            "--include-students",
            studentId,
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      const preview = JSON.parse(stdout.at(-1)!) as {
        output: string;
        status: string;
        source_generation: string;
        selection_fingerprint: string;
        students: number;
        sessions: number;
        annotations: number;
      };
      expect(preview).toMatchObject({
        output: outputPath,
        status: "preview-required",
        source_generation: "2",
        students: 1,
        sessions: 1,
        annotations: 1,
      });
      expect(preview.selection_fingerprint).toMatch(/^[\da-f]{64}$/u);
      expect(await readFile(archivePath)).toEqual(Buffer.from(sourceBytes));

      expect(
        await executeCli(
          [
            "archive",
            "sanitize",
            archivePath,
            "--output",
            outputPath,
            "--include-students",
            studentId,
            "--confirm-sensitive",
            "--json",
          ],
          io,
        ),
      ).toBe(2);
      expect(stderr.at(-1)).toContain("--expected-generation");

      expect(
        await executeCli(
          [
            "archive",
            "sanitize",
            archivePath,
            "--output",
            outputPath,
            "--include-students",
            studentId,
            "--confirm-sensitive",
            "--expected-generation",
            preview.source_generation,
            "--expected-selection",
            preview.selection_fingerprint,
            "--expected-output",
            outputPath,
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ status: "created", output: outputPath });
      expect(await readFile(archivePath)).toEqual(Buffer.from(sourceBytes));
      const sanitized = await openArchiveBytes(await readFile(outputPath));
      await expect(verifyArchiveSnapshot(sanitized)).resolves.toMatchObject({ currentRecords: 4 });
      expect(await sanitized.listRecords(RecordType.annotation)).toHaveLength(1);
      const copiedSettings = await sanitized.listRecords(RecordType.settings);
      expect(
        copiedSettings.some((item) => item.fields.get("api_key") === "private-token-value"),
      ).toBe(false);

      expect(
        await executeCli(
          [
            "archive",
            "sanitize",
            archivePath,
            "--output",
            outputPath,
            "--include-students",
            studentId,
            "--json",
          ],
          io,
        ),
      ).toBe(2);
      expect(stderr.at(-1)).toContain("already exists");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
