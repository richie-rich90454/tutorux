import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeCli } from "./main";
import {
  appendRecords,
  createArchiveBytes,
  createEncryptedArchiveBytes,
  openArchiveBytes,
  verifyArchiveSnapshot,
} from "../frontend/archive/archive";
import { crc32, newUuid, RecordType, type ArchiveRecord } from "../frontend/archive/format";

describe("CLI recording take management", () => {
  it("lists, renames, trashes, and restores takes with their audio intact", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-recording-take-"));
    const archivePath = join(directory, "recording.tux");
    const sessionId = newUuid();
    const takeId = newUuid();
    const trackId = newUuid();
    const chunkId = newUuid();
    const pcm = new Uint8Array([0x34, 0x12, 0xcc, 0xed]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      const created = await openArchiveBytes(await createArchiveBytes("Recording take CLI"));
      const archive = await appendRecords(created, [
        cliRecordingRecord(RecordType.session, sessionId, [
          ["title", "Reading practice"],
          ["recording_track_ids", trackId],
          ["recording_track_id", trackId],
          ["recording_track_count", "1"],
        ]),
        cliRecordingRecord(RecordType.assetMetadata, trackId, [
          ["record_role", "audio-track"],
          ["session_id", sessionId],
          ["track_id", trackId],
          ["recording_take_id", takeId],
          ["label", "Imported WAV"],
          ["state", "completed"],
        ]),
        cliRecordingRecord(RecordType.assetMetadata, takeId, [
          ["record_role", "recording-take"],
          ["session_id", sessionId],
          ["track_ids", trackId],
          ["label", "Initial take"],
          ["state", "completed"],
        ]),
        {
          ...cliRecordingRecord(RecordType.audioChunk, chunkId, [
            ["session_id", sessionId],
            ["track_id", trackId],
            ["sequence_number", "0"],
            ["first_sample_index", "0"],
            ["sample_count", "2"],
            ["sample_rate_hz", "8000"],
            ["channel_count", "1"],
            ["sample_format", "pcm_s16le"],
            ["codec", "none"],
            ["payload_checksum", String(crc32(pcm))],
          ]),
          blob: pcm,
        },
      ]);
      await writeFile(archivePath, await archive.source.read(0n, Number(archive.source.size)));

      const run = (command: string, options: string[]) =>
        executeCli(["--archive", archivePath, "record", command, ...options, "--json"], io);

      expect(await run("take-list", ["--session", sessionId])).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toHaveLength(1);
      expect(
        await run("take-rename", ["--session", sessionId, "--take", takeId, "--label", "Review"]),
      ).toBe(0);
      expect(
        await run("track-rename", ["--session", sessionId, "--track", trackId, "--label", "Tutor"]),
      ).toBe(0);
      expect(await run("take-delete", ["--session", sessionId, "--take", takeId])).toBe(0);

      const trashed = await openArchiveBytes(new Uint8Array(await readFile(archivePath)));
      expect((await trashed.getRecord(RecordType.assetMetadata, takeId))?.fields.get("label")).toBe(
        "Review",
      );
      expect(
        (await trashed.getRecord(RecordType.assetMetadata, trackId))?.fields.get("label"),
      ).toBe("Tutor");
      expect(
        (await trashed.getRecord(RecordType.audioChunk, chunkId))?.fields.get("_deleted"),
      ).toBe("true");
      expect((await trashed.getRecord(RecordType.audioChunk, chunkId))?.blob).toEqual(pcm);
      expect(
        (await trashed.getRecord(RecordType.session, sessionId))?.fields.get("recording_track_ids"),
      ).toBe("");
      expect(await run("take-list", ["--session", sessionId, "--include-deleted"])).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)[0]).toMatchObject({
        _deleted: "true",
        label: "Review",
      });
      expect(await run("take-restore", ["--session", sessionId, "--take", takeId])).toBe(0);

      const restored = await openArchiveBytes(new Uint8Array(await readFile(archivePath)));
      expect(
        (await restored.getRecord(RecordType.assetMetadata, takeId))?.fields.has("_deleted"),
      ).toBe(false);
      expect(
        (await restored.getRecord(RecordType.audioChunk, chunkId))?.fields.has("_deleted"),
      ).toBe(false);
      expect(
        (await restored.getRecord(RecordType.session, sessionId))?.fields.get("recording_track_id"),
      ).toBe(trackId);
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("CLI session package transfer", () => {
  it("exports a private package, preserves no-overwrite behavior, and imports to a fresh session", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-session-package-"));
    const sourcePath = join(directory, "source.tux");
    const packagePath = join(directory, "reading-session.tux");
    const destinationPath = join(directory, "destination.tux");
    const sourceStudentId = newUuid();
    const sourceSessionId = newUuid();
    const destinationStudentId = newUuid();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };
    const run = (archivePath: string, action: string, options: string[]) =>
      executeCli(["--archive", archivePath, "session", action, ...options, "--json"], io);

    try {
      const sourceBase = await openArchiveBytes(await createArchiveBytes("Source workspace"));
      const source = await appendRecords(sourceBase, [
        cliRecordingRecord(RecordType.student, sourceStudentId, [
          ["display_name", "Private learner"],
        ]),
        cliRecordingRecord(RecordType.session, sourceSessionId, [
          ["student_id", sourceStudentId],
          ["title", "Reading practice"],
          ["session_type", "notes-only"],
          ["session_state", "completed"],
        ]),
      ]);
      await writeFile(sourcePath, await source.source.read(0n, Number(source.source.size)));

      const destinationBase = await openArchiveBytes(
        await createArchiveBytes("Destination workspace"),
      );
      const destination = await appendRecords(destinationBase, [
        cliRecordingRecord(RecordType.student, destinationStudentId, [
          ["display_name", "Destination learner"],
        ]),
      ]);
      await writeFile(
        destinationPath,
        await destination.source.read(0n, Number(destination.source.size)),
      );

      expect(await run(sourcePath, "export", [sourceSessionId, "--output", packagePath])).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        path: packagePath,
        output: packagePath,
        session_id: sourceSessionId,
        status: "exported",
        created: true,
      });
      const packageSnapshot = await openArchiveBytes(new Uint8Array(await readFile(packagePath)));
      const packageSession = await packageSnapshot.getRecord(RecordType.session, sourceSessionId);
      expect(packageSession?.fields.get("student_id")).toBe("anonymous");
      expect(await packageSnapshot.listRecords(RecordType.student, true)).toEqual([]);
      expect(await run(sourcePath, "export", [sourceSessionId, "--output", packagePath])).toBe(2);
      expect(stderr.at(-1)).toContain("already exists");
      expect(
        await run(sourcePath, "export", [sourceSessionId, "--output", sourcePath, "--force"]),
      ).toBe(2);
      expect(stderr.at(-1)).toContain("separate file");
      expect(
        await run(sourcePath, "export", [sourceSessionId, "--output", packagePath, "--force"]),
      ).toBe(0);
      stderr.length = 0;

      expect(
        await run(destinationPath, "import", [
          "--input",
          packagePath,
          "--student-id",
          destinationStudentId,
        ]),
      ).toBe(0);
      const imported = JSON.parse(stdout.at(-1)!) as {
        session_id: string;
        entry_id: string;
        notes_document_id: string;
        student_id: string;
        status: string;
        session: Record<string, string>;
        imported_records: number;
      };
      expect(imported.session_id).not.toBe(sourceSessionId);
      expect(imported.session["id"]).toBe(imported.session_id);
      expect(imported.session["student_id"]).toBe(destinationStudentId);
      expect(imported.student_id).toBe(destinationStudentId);
      expect(imported.status).toBe("imported");
      expect(imported.entry_id).toBe(imported.session["entry_id"]);
      expect(imported.notes_document_id).toBe(imported.session["notes_document_id"]);
      expect(imported.imported_records).toBeGreaterThan(1);
      const importedArchive = await openArchiveBytes(
        new Uint8Array(await readFile(destinationPath)),
      );
      expect(await importedArchive.getRecord(RecordType.student, sourceStudentId)).toBeNull();
      expect(
        await importedArchive.getRecord(RecordType.student, destinationStudentId),
      ).not.toBeNull();
      expect(await importedArchive.getRecord(RecordType.settings, imported.entry_id)).toMatchObject(
        { fields: expect.any(Map) },
      );
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function cliRecordingRecord(
  type: ArchiveRecord["type"],
  id: string,
  fields: readonly (readonly [string, string])[],
): ArchiveRecord {
  return {
    type,
    id,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map(fields),
    blob: new Uint8Array(),
  };
}
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
            "--expected-encrypted-output",
            "no",
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

  it("rejects a confirmation that removes encryption promised by the preview", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-sanitize-choice-"));
    const archivePath = join(directory, "lesson.tux");
    const outputPath = join(directory, "encrypted-copy.tux");
    const environmentName = "TUTORUX_CLI_TEST_SANITIZE_OPTIONAL_PASSPHRASE";
    const passphrase = "Optional encrypted sanitized copy phrase";
    const previousPassphrase = process.env[environmentName];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      process.env[environmentName] = passphrase;
      const source = await openArchiveBytes(await createArchiveBytes("Sanitize encryption choice"));
      const studentId = newUuid();
      const populated = await appendRecords(source, [
        {
          type: RecordType.student,
          id: studentId,
          revision: 0n,
          previousOffset: 0n,
          fields: new Map([["display_name", "Mina"]]),
          blob: new Uint8Array(),
        },
      ]);
      const sourceBytes = await populated.source.read(0n, Number(populated.source.size));
      await writeFile(archivePath, sourceBytes);
      const selectionArgs = [
        "archive",
        "sanitize",
        archivePath,
        "--output",
        outputPath,
        "--include-students",
        studentId,
      ];
      expect(
        await executeCli([...selectionArgs, "--new-passphrase-env", environmentName, "--json"], io),
      ).toBe(0);
      const preview = JSON.parse(stdout.at(-1)!) as {
        source_generation: string;
        selection_fingerprint: string;
        encrypted_output: boolean;
      };
      expect(preview.encrypted_output).toBe(true);

      expect(
        await executeCli(
          [
            ...selectionArgs,
            "--confirm-sensitive",
            "--expected-generation",
            preview.source_generation,
            "--expected-selection",
            preview.selection_fingerprint,
            "--expected-output",
            outputPath,
            "--expected-encrypted-output",
            "yes",
            "--json",
          ],
          io,
        ),
      ).toBe(2);
      expect(stderr.at(-1)).toContain("encryption choice differs");
      expect(await readFile(archivePath)).toEqual(Buffer.from(sourceBytes));
      await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });

      expect(
        await executeCli(
          [
            ...selectionArgs,
            "--confirm-sensitive",
            "--expected-generation",
            preview.source_generation,
            "--expected-selection",
            preview.selection_fingerprint,
            "--expected-output",
            outputPath,
            "--expected-encrypted-output",
            "yes",
            "--new-passphrase-env",
            environmentName,
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      const lockedCopy = await openArchiveBytes(await readFile(outputPath));
      const encryptedCopy = await lockedCopy.unlock(passphrase);
      const verification = await verifyArchiveSnapshot(encryptedCopy);
      expect(verification.currentRecords).toBeGreaterThan(0);
      encryptedCopy.lock();
      lockedCopy.lock();
      populated.lock();
      source.lock();
    } finally {
      if (previousPassphrase === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previousPassphrase;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("CLI encrypted sanitized archive copies", () => {
  it("previews, confirms, encrypts, and verifies a credential-inclusive copy", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-sanitize-encrypted-"));
    const archivePath = join(directory, "protected.tux");
    const outputPath = join(directory, "sanitized.tux");
    const sourceEnvironmentName = "TUTORUX_CLI_TEST_SANITIZE_SOURCE_PASSPHRASE";
    const destinationEnvironmentName = "TUTORUX_CLI_TEST_SANITIZE_DESTINATION_PASSPHRASE";
    const sourcePassphrase = "Source archive phrase for CLI sanitizer";
    const destinationPassphrase = "Destination archive phrase for CLI sanitizer";
    const credentialValue = "provider-token-never-printed-or-written-plaintext";
    const previousSourcePassphrase = process.env[sourceEnvironmentName];
    const previousDestinationPassphrase = process.env[destinationEnvironmentName];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      process.env[sourceEnvironmentName] = sourcePassphrase;
      delete process.env[destinationEnvironmentName];
      const locked = await openArchiveBytes(
        await createEncryptedArchiveBytes("Protected sanitizer source", "", sourcePassphrase),
      );
      const unlocked = await locked.unlock(sourcePassphrase);
      const credentialId = newUuid();
      const source = await appendRecords(unlocked, [
        {
          type: RecordType.student,
          id: newUuid(),
          revision: 0n,
          previousOffset: 0n,
          fields: new Map([["display_name", "Mina"]]),
          blob: new Uint8Array(),
        },
        {
          type: RecordType.settings,
          id: credentialId,
          revision: 0n,
          previousOffset: 0n,
          fields: new Map([
            ["record_role", "credential"],
            ["key", "openai-api-key"],
            ["value", credentialValue],
          ]),
          blob: new Uint8Array(),
        },
      ]);
      const sourceBytes = await source.source.read(0n, Number(source.source.size));
      await writeFile(archivePath, sourceBytes);

      const baseArgs = [
        "--passphrase-env",
        sourceEnvironmentName,
        "archive",
        "sanitize",
        archivePath,
        "--output",
        outputPath,
        "--include-credentials",
        "--json",
      ];
      expect(await executeCli(baseArgs, io)).toBe(0);
      const preview = JSON.parse(stdout.at(-1)!) as {
        source_generation: string;
        selection_fingerprint: string;
        credentials: number;
        encrypted_output: boolean;
      };
      expect(preview).toMatchObject({ credentials: 1, encrypted_output: true });

      const confirmationArgs = [
        ...baseArgs.slice(0, -1),
        "--confirm-sensitive",
        "--expected-generation",
        preview.source_generation,
        "--expected-selection",
        preview.selection_fingerprint,
        "--expected-encrypted-output",
        "yes",
        "--expected-output",
        outputPath,
        "--json",
      ];
      expect(await executeCli(confirmationArgs, io)).toBe(2);
      expect(stderr.at(-1)).toContain("--new-passphrase-env");
      expect(await readFile(archivePath)).toEqual(Buffer.from(sourceBytes));

      process.env[destinationEnvironmentName] = destinationPassphrase;
      expect(
        await executeCli(
          [
            ...confirmationArgs.slice(0, -1),
            "--new-passphrase-env",
            destinationEnvironmentName,
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        status: "created",
        encrypted_output: true,
        credentials: 1,
      });
      expect(await readFile(archivePath)).toEqual(Buffer.from(sourceBytes));
      expect(stdout.join("\n")).not.toContain(credentialValue);
      expect(stderr.join("\n")).not.toContain(destinationPassphrase);

      const outputBytes = new Uint8Array(await readFile(outputPath));
      expect(new TextDecoder().decode(outputBytes)).not.toContain(credentialValue);
      const protectedCopy = await openArchiveBytes(outputBytes);
      await expect(protectedCopy.unlock(sourcePassphrase)).rejects.toBeDefined();
      const verifiedCopy = await protectedCopy.unlock(destinationPassphrase);
      await expect(verifyArchiveSnapshot(verifiedCopy)).resolves.toMatchObject({
        currentRecords: 4,
      });
      const credentials = (await verifiedCopy.listRecords(RecordType.settings)).filter(
        (record) => record.fields.get("record_role") === "credential",
      );
      expect(credentials).toHaveLength(1);
      expect(credentials[0]!.fields.get("value")).toBe(credentialValue);
      verifiedCopy.lock();
      protectedCopy.lock();
      source.lock();
      unlocked.lock();
      locked.lock();
    } finally {
      if (previousSourcePassphrase === undefined) delete process.env[sourceEnvironmentName];
      else process.env[sourceEnvironmentName] = previousSourcePassphrase;
      if (previousDestinationPassphrase === undefined)
        delete process.env[destinationEnvironmentName];
      else process.env[destinationEnvironmentName] = previousDestinationPassphrase;
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
    const newEnvironmentName = "TUTORUX_CLI_TEST_ROTATED_PASSPHRASE";
    const previousPassphrase = process.env[environmentName];
    const previousNewPassphrase = process.env[newEnvironmentName];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      await writeFile(archivePath, fixtureBytes);
      delete process.env[environmentName];
      delete process.env[newEnvironmentName];

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
        display_name: "CLI encrypted update",
      });

      const reopened = await openArchiveBytes(new Uint8Array(await readFile(archivePath)));
      const unlocked = await reopened.unlock("Tutorux cross-language fixture phrase 2026");
      await expect(verifyArchiveSnapshot(unlocked)).resolves.toMatchObject({ currentRecords: 3 });
      expect(
        (await unlocked.getRecord(RecordType.student, studentId))?.fields.get("display_name"),
      ).toBe("CLI encrypted update");
      unlocked.lock();

      expect(
        await executeCli(
          ["archive", "change-passphrase", archivePath, "--new-passphrase-env", "--json"],
          io,
        ),
      ).toBe(2);
      expect(stderr.at(-1)).toContain("requires an environment variable name");
      expect(
        await executeCli(
          [
            "--passphrase-env",
            environmentName,
            "archive",
            "change-passphrase",
            archivePath,
            "--new-passphrase-env",
            newEnvironmentName,
            "--json",
          ],
          io,
        ),
      ).toBe(2);
      expect(stderr.at(-1)).toContain("new archive passphrase environment variable is not set");

      const bytesBeforeInvalidRotation = await readFile(archivePath);
      process.env[newEnvironmentName] = process.env[environmentName];
      expect(
        await executeCli(
          [
            "--passphrase-env",
            environmentName,
            "archive",
            "change-passphrase",
            archivePath,
            "--new-passphrase-env",
            newEnvironmentName,
          ],
          io,
        ),
      ).toBe(2);
      expect(stderr.at(-1)).toContain("different new passphrase");
      expect(await readFile(archivePath)).toEqual(bytesBeforeInvalidRotation);

      process.env[newEnvironmentName] = "too-short";
      expect(
        await executeCli(
          [
            "--passphrase-env",
            environmentName,
            "archive",
            "change-passphrase",
            archivePath,
            "--new-passphrase-env",
            newEnvironmentName,
          ],
          io,
        ),
      ).toBe(1);
      expect(stderr.at(-1)).toContain("at least 12 UTF-8 bytes");
      expect(await readFile(archivePath)).toEqual(bytesBeforeInvalidRotation);

      process.env[newEnvironmentName] = "CLI-rotated archive phrase 2026";
      expect(
        await executeCli(
          [
            "--passphrase-env",
            environmentName,
            "archive",
            "change-passphrase",
            archivePath,
            "--new-passphrase-env",
            newEnvironmentName,
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        generation: "1",
        encrypted: true,
        verified: true,
        passphrase_changed: true,
      });

      expect(
        await executeCli(
          ["archive", "verify", archivePath, "--passphrase-env", environmentName],
          io,
        ),
      ).toBe(1);
      expect(stderr.at(-1)).toContain("Passphrase is incorrect");
      expect(stderr.at(-1)).not.toContain(process.env[environmentName]!);
      expect(
        await executeCli(
          ["archive", "verify", archivePath, "--passphrase-env", newEnvironmentName, "--json"],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ encrypted: true, verified: true });
      expect(stderr.join("\n")).not.toContain(process.env[newEnvironmentName]!);
      expect(stdout.join("\n")).not.toContain(process.env[newEnvironmentName]!);

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
      if (previousNewPassphrase === undefined) delete process.env[newEnvironmentName];
      else process.env[newEnvironmentName] = previousNewPassphrase;
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
