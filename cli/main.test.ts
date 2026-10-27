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

describe("CLI encrypted archive access", () => {
  it("creates encrypted archives from a passphrase environment variable", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-create-encrypted-"));
    const archivePath = join(directory, "protected.tux");
    const environmentName = "TUTORUX_CLI_TEST_NEW_ARCHIVE_PASSPHRASE";
    const previousPassphrase = process.env[environmentName];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      delete process.env[environmentName];
      expect(
        await executeCli(
          [
            "archive",
            "init",
            archivePath,
            "--name",
            "Protected CLI archive",
            "--new-passphrase-env",
            "--json",
          ],
          io,
        ),
      ).toBe(2);
      expect(stderr.at(-1)).toContain("requires an environment variable name");
      expect(
        await executeCli(
          [
            "archive",
            "init",
            archivePath,
            "--name",
            "Protected CLI archive",
            "--new-passphrase-env",
            environmentName,
          ],
          io,
        ),
      ).toBe(2);
      expect(stderr.at(-1)).toContain("environment variable is not set");

      process.env[environmentName] = "CLI-created archive phrase 2026";
      expect(
        await executeCli(
          [
            "archive",
            "init",
            archivePath,
            "--name",
            "Protected CLI archive",
            "--description",
            "Created without exposing its passphrase",
            "--new-passphrase-env",
            environmentName,
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        name: "Protected CLI archive",
        created: true,
      });

      const locked = await openArchiveBytes(new Uint8Array(await readFile(archivePath)));
      expect(locked.encrypted).toBe(true);
      expect(locked.locked).toBe(true);
      expect(
        await executeCli(
          ["archive", "verify", archivePath, "--passphrase-env", environmentName, "--json"],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        encrypted: true,
        locked: false,
        verified: true,
      });
      expect(stderr.join("\n")).not.toContain(process.env[environmentName]!);
    } finally {
      if (previousPassphrase === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previousPassphrase;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("unlocks, verifies, reads, and appends an encrypted archive generation", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-encrypted-"));
    const archivePath = join(directory, "encrypted.tux");
    const fixture = new URL("../tests/fixtures/encrypted-v1.tux", import.meta.url);
    const fixtureBytes = await readFile(fixture);
    const initial = await openArchiveBytes(new Uint8Array(fixtureBytes));
    const studentEntry = [...initial.allIndexEntries()].find(([key]) => key.startsWith("STUDENT:"));
    expect(studentEntry).toBeDefined();
    const studentId = studentEntry![0].slice("STUDENT:".length);
    const environmentName = "TUTORUX_CLI_TEST_ENCRYPTED_PASSPHRASE";
    const previousPassphrase = process.env[environmentName];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      await writeFile(archivePath, fixtureBytes);
      delete process.env[environmentName];

      expect(await executeCli(["archive", "info", archivePath, "--json"], io)).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        encrypted: true,
        locked: true,
        verified: false,
      });
      expect(await executeCli(["archive", "verify", archivePath], io)).toBe(2);
      expect(stderr.at(-1)).toContain("--passphrase-env");

      process.env[environmentName] = "Tutorux cross-language fixture phrase 2026";

      expect(
        await executeCli(
          ["archive", "verify", archivePath, "--passphrase-env", environmentName, "--json"],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        encrypted: true,
        locked: false,
        verified: true,
      });

      expect(
        await executeCli(
          [
            "--archive",
            archivePath,
            "--passphrase-env",
            environmentName,
            "student",
            "list",
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: studentId, display_name: "Interop Student" }),
        ]),
      );

      expect(
        await executeCli(
          [
            "--archive",
            archivePath,
            "--passphrase-env",
            environmentName,
            "student",
            "update",
            studentId,
            "--name",
            "CLI encrypted update",
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        fields: { display_name: "CLI encrypted update" },
      });

      const reopened = await openArchiveBytes(new Uint8Array(await readFile(archivePath)));
      const unlocked = await reopened.unlock("Tutorux cross-language fixture phrase 2026");
      await expect(verifyArchiveSnapshot(unlocked)).resolves.toMatchObject({ currentRecords: 3 });
      expect(
        (await unlocked.getRecord(RecordType.student, studentId))?.fields.get("display_name"),
      ).toBe("CLI encrypted update");
      unlocked.lock();

      process.env[environmentName] = "incorrect passphrase";
      expect(
        await executeCli(
          ["archive", "verify", archivePath, "--passphrase-env", environmentName],
          io,
        ),
      ).toBe(1);
      expect(stderr.at(-1)).toContain("Passphrase is incorrect");
      expect(stderr.at(-1)).not.toContain("incorrect passphrase");
    } finally {
      if (previousPassphrase === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previousPassphrase;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
