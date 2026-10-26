import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeCli } from "../cli/main";
import { appendRecords, openArchiveBytes } from "./archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "./archive/format";

describe("TypeScript CLI", () => {
  it("shows student history and reviews source-backed progress", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-progress-cli-"));
    const archivePath = join(directory, "lesson.tux");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      expect(
        await executeCli(["archive", "init", archivePath, "--name", "Progress lesson"], io),
      ).toBe(0);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "student",
            "create",
            "--name",
            "Mina",
            "--difficulties",
            "Comparing unlike denominators",
            "--demonstrated-improvements",
            "Explains the scale factor",
            "--preferred-guide-template",
            "mathematics",
          ],
          io,
        ),
      ).toBe(0);
      const studentId = (JSON.parse(stdout[1]!) as { id: string }).id;
      const createdStudent = JSON.parse(stdout[1]!) as {
        fields: Record<string, string>;
      };
      expect(createdStudent.fields["known_difficulties"]).toBe("Comparing unlike denominators");
      expect(createdStudent.fields["demonstrated_improvements"]).toBe("Explains the scale factor");
      expect(createdStudent.fields["preferred_guide_template"]).toBe("mathematics");
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "session",
            "create",
            "--title",
            "Fractions",
            "--subject",
            "Math",
            "--student",
            studentId,
          ],
          io,
        ),
      ).toBe(0);
      const sessionId = (JSON.parse(stdout[2]!) as { session: { id: string } }).session.id;
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "add",
            "--session",
            sessionId,
            "--type",
            "learning-outcome",
            "--at",
            "00:01:00",
            "--title",
            "Explains equivalent fractions",
            "--text",
            "Mina explains the shared scale factor.",
          ],
          io,
        ),
      ).toBe(0);
      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "evidence", "extract", "--session", sessionId],
          io,
        ),
      ).toBe(0);
      const evidence = JSON.parse(stdout[4]!) as Array<{ id: string }>;
      expect(evidence).toHaveLength(1);

      expect(
        await executeCli(["--json", "--archive", archivePath, "student", "history", studentId], io),
      ).toBe(0);
      expect(JSON.parse(stdout[5]!)).toHaveLength(1);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "student",
            "progress-review",
            studentId,
            "--skill",
            "Equivalent fractions",
            "--classification",
            "newly-observed",
            "--evidence-ids",
            evidence[0]!.id,
            "--reviewed-by",
            "Tutor",
          ],
          io,
        ),
      ).toBe(0);
      expect((JSON.parse(stdout[6]!) as { classification: string }).classification).toBe(
        "newly-observed",
      );

      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "student", "progress", studentId],
          io,
        ),
      ).toBe(0);
      const progress = JSON.parse(stdout[7]!) as {
        sessions: unknown[];
        classifications: Array<{ skill: string; source_status: string }>;
      };
      expect(progress.sessions).toHaveLength(1);
      expect(progress.classifications).toMatchObject([
        { skill: "Equivalent fractions", source_status: "valid" },
      ]);
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("organizes journal entries with collections and tags from the CLI", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-journal-cli-"));
    const archivePath = join(directory, "journal.tux");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      expect(
        await executeCli(["archive", "init", archivePath, "--name", "Journal", "--json"], io),
      ).toBe(0);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "journal",
            "collection",
            "create",
            "--name",
            "Growth",
            "--color",
            "#6f8f7b",
          ],
          io,
        ),
      ).toBe(0);
      const collection = JSON.parse(stdout[1]!) as { id: string; fields: Record<string, string> };
      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "journal", "tag", "create", "--name", "fractions"],
          io,
        ),
      ).toBe(0);
      const tag = JSON.parse(stdout[2]!) as { id: string };
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "journal",
            "create",
            "--title",
            "A useful model",
            "--date",
            "2026-10-26",
            "--collection-ids",
            collection.id,
            "--tag-ids",
            tag.id,
          ],
          io,
        ),
      ).toBe(0);
      const entry = JSON.parse(stdout[3]!) as {
        entry: { id: string; fields: Record<string, string> };
      };
      expect(entry.entry.fields["collection_ids"]).toBe(collection.id);
      expect(entry.entry.fields["tag_ids"]).toBe(tag.id);

      const unavailableCollectionId = newUuid();
      const archiveSnapshot = await openArchiveBytes(new Uint8Array(await readFile(archivePath)));
      try {
        const current = await archiveSnapshot.getRecord(RecordType.settings, entry.entry.id);
        expect(current).not.toBeNull();
        const fields = new Map(current!.fields);
        fields.set("collection_ids", unavailableCollectionId);
        const updated = await appendRecords(archiveSnapshot, [{ ...current!, fields }]);
        await writeFile(archivePath, await updated.source.read(0n, Number(updated.source.size)));
        await updated.source.close?.();
      } finally {
        await archiveSnapshot.source.close?.();
      }

      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "journal",
            "update",
            entry.entry.id,
            "--collection-ids",
            collection.id,
          ],
          io,
        ),
      ).toBe(0);
      const reassigned = JSON.parse(stdout[4]!) as { fields: Record<string, string> };
      expect(reassigned.fields["collection_ids"]).toBe(
        `${collection.id},${unavailableCollectionId}`,
      );

      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "journal", "collection", "delete", collection.id],
          io,
        ),
      ).toBe(0);
      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "journal", "show", entry.entry.id],
          io,
        ),
      ).toBe(0);
      const detached = JSON.parse(stdout[6]!) as { fields: Record<string, string> };
      expect(detached.fields["collection_ids"]).toBe(unavailableCollectionId);
      expect(detached.fields["_trash_restore_collection_refs"]).toBe(collection.id);

      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "journal", "collection", "restore", collection.id],
          io,
        ),
      ).toBe(0);
      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "journal", "show", entry.entry.id],
          io,
        ),
      ).toBe(0);
      const restored = JSON.parse(stdout[8]!) as { fields: Record<string, string> };
      expect(restored.fields["collection_ids"]).toBe(`${unavailableCollectionId},${collection.id}`);
      expect(restored.fields["_trash_restore_collection_refs"]).toBeUndefined();
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates, updates, lists, and verifies a portable archive", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-"));
    const archivePath = join(directory, "lesson.tux");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      expect(await executeCli(["archive", "init", archivePath, "--name", "CLI lesson"], io)).toBe(
        0,
      );
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "student",
            "create",
            "--name",
            "Mina",
            "--difficulties",
            "Comparing unlike denominators",
            "--demonstrated-improvements",
            "Explains the scale factor",
            "--preferred-guide-template",
            "mathematics",
          ],
          io,
        ),
      ).toBe(0);
      expect(
        await executeCli(
          [
            "--archive",
            archivePath,
            "session",
            "create",
            "--title",
            "Fractions",
            "--subject",
            "Math",
          ],
          io,
        ),
      ).toBe(0);
      expect(
        await executeCli(
          [
            "--archive",
            archivePath,
            "journal",
            "create",
            "--title",
            "First notes",
            "--date",
            "2026-10-25",
          ],
          io,
        ),
      ).toBe(0);
      expect(await executeCli(["--archive", archivePath, "student", "list", "--json"], io)).toBe(0);
      expect(await executeCli(["archive", "verify", archivePath, "--json"], io)).toBe(0);

      const studentList = JSON.parse(stdout[4]!);
      const verification = JSON.parse(stdout[5]!);
      const student = JSON.parse(stdout[1]!);
      expect(student.fields.known_difficulties).toBe("Comparing unlike denominators");
      expect(student.fields.demonstrated_improvements).toBe("Explains the scale factor");
      expect(student.fields.preferred_guide_template).toBe("mathematics");
      expect(studentList).toHaveLength(1);
      expect(studentList[0].fields.display_name).toBe("Mina");
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "student",
            "update",
            student.id,
            "--grade",
            "Year 9",
            "--difficulties",
            "Choosing a common denominator",
            "--demonstrated-improvements",
            "Finds equivalent fractions independently",
            "--preferred-guide-template",
            "concise-review",
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout[6]!).fields.grade).toBe("Year 9");
      expect(JSON.parse(stdout[6]!).fields.known_difficulties).toBe(
        "Choosing a common denominator",
      );
      expect(JSON.parse(stdout[6]!).fields.demonstrated_improvements).toBe(
        "Finds equivalent fractions independently",
      );
      expect(JSON.parse(stdout[6]!).fields.preferred_guide_template).toBe("concise-review");
      expect(
        await executeCli(["--archive", archivePath, "student", "delete", student.id], io),
      ).toBe(0);
      expect(await executeCli(["--archive", archivePath, "student", "list", "--json"], io)).toBe(0);
      expect(JSON.parse(stdout[8]!)).toHaveLength(0);
      expect(
        await executeCli(["--archive", archivePath, "student", "restore", student.id], io),
      ).toBe(0);
      expect(verification.verified).toBe(true);
      expect(verification.records).toBeGreaterThan(1);
      expect(stderr).toEqual([]);
      expect((await readFile(archivePath)).subarray(0, 8).toString()).toBe("TUTORUX\0");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing archive during init", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-"));
    const archivePath = join(directory, "lesson.tux");
    const output = { stdout: () => undefined, stderr: () => undefined };
    try {
      expect(await executeCli(["archive", "init", archivePath, "--name", "First"], output)).toBe(0);
      expect(
        await executeCli(["archive", "init", archivePath, "--name", "Replacement"], output),
      ).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("round-trips punctuation in imported custom template headings", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-template-cli-"));
    const archivePath = join(directory, "lesson.tux");
    const inputPath = join(directory, "template.json");
    const exportPath = join(directory, "template-export.json");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };
    const templateInput = {
      format: "tutorux-guide-template-v1",
      name: "Contrast",
      subject: "General",
      description: "A punctuation round trip.",
      sections: ["Causes, effects", "Claim; counterclaim"],
      body: "",
    };

    try {
      expect(await executeCli(["archive", "init", archivePath, "--name", "Template CLI"], io)).toBe(
        0,
      );
      await writeFile(inputPath, JSON.stringify(templateInput), "utf8");
      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "template", "import", "--input", inputPath],
          io,
        ),
      ).toBe(0);
      const created = JSON.parse(stdout[1]!) as { id: string };
      expect(
        await executeCli(["--json", "--archive", archivePath, "template", "show", created.id], io),
      ).toBe(0);
      expect((JSON.parse(stdout[2]!) as { sections: string[] }).sections).toEqual(
        templateInput.sections,
      );
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "template",
            "export",
            created.id,
            "--output",
            exportPath,
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(await readFile(exportPath, "utf8")).sections).toEqual(
        templateInput.sections,
      );
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses template export to a case alias of its archive on Windows", async () => {
    if (process.platform !== "win32") return;
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-template-export-"));
    const archivePath = join(directory, "lesson.tux");
    const caseAliasPath = join(directory, "LESSON.TUX");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      expect(
        await executeCli(["archive", "init", archivePath, "--name", "Protected archive"], io),
      ).toBe(0);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "template",
            "create",
            "--name",
            "Quick review",
            "--sections",
            "Overview;Evidence",
          ],
          io,
        ),
      ).toBe(0);
      const created = JSON.parse(stdout[1]!) as { id: string };
      expect(
        await executeCli(
          ["--archive", archivePath, "template", "export", created.id, "--output", caseAliasPath],
          io,
        ),
      ).toBe(2);
      expect(stderr.at(-1)).toContain("cannot replace its source archive");
      expect(await executeCli(["archive", "verify", archivePath], io)).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("imports, reviews, searches, and exports session transcript cues", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-transcript-"));
    const archivePath = join(directory, "lesson.tux");
    const sourcePath = join(directory, "lesson.srt");
    const exportPath = join(directory, "reviewed.vtt");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      expect(
        await executeCli(["archive", "init", archivePath, "--name", "Transcript lesson"], io),
      ).toBe(0);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "session",
            "create",
            "--title",
            "Fractions",
            "--subject",
            "Math",
          ],
          io,
        ),
      ).toBe(0);
      const sessionId = JSON.parse(stdout[1]!).session.id as string;
      await writeFile(
        sourcePath,
        "1\n00:00:01,250 --> 00:00:02,500\nHello <class>\n\n2\n00:00:03,000 --> 00:00:04,000\nWe can compare them.\n",
        "utf8",
      );
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "transcript",
            "import",
            "--session",
            sessionId,
            "--input",
            sourcePath,
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout[2]!).imported_segment_count).toBe("2");
      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "transcript", "show", "--session", sessionId],
          io,
        ),
      ).toBe(0);
      const imported = JSON.parse(stdout[3]!) as Array<Record<string, string>>;
      expect(imported).toHaveLength(2);
      expect(imported[0]!["verification_state"]).toBe("provisional");
      expect(imported[0]!["source_cue_id"]).toBe("1");

      expect(
        await executeCli(
          [
            "--archive",
            archivePath,
            "transcript",
            "correct",
            imported[0]!["id"]!,
            "--text",
            "Hello, class.",
          ],
          io,
        ),
      ).toBe(0);
      expect(
        await executeCli(
          [
            "--archive",
            archivePath,
            "transcript",
            "speaker",
            imported[0]!["id"]!,
            "--name",
            "Tutor",
          ],
          io,
        ),
      ).toBe(0);
      expect(
        await executeCli(
          ["--archive", archivePath, "transcript", "verify", imported[0]!["id"]!],
          io,
        ),
      ).toBe(0);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "transcript",
            "search",
            "--session",
            sessionId,
            "--query",
            "compare",
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(stdout[7]!)).toHaveLength(1);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "transcript",
            "export",
            "--session",
            sessionId,
            "--output",
            exportPath,
            "--format",
            "vtt",
          ],
          io,
        ),
      ).toBe(0);
      const exported = await readFile(exportPath, "utf8");
      expect(exported).toContain("WEBVTT");
      expect(exported).toContain("Tutor: Hello, class.");
      expect(exported).toContain("Hello, class.");
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates, edits, duplicates, lists, and removes session annotations", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-annotation-"));
    const archivePath = join(directory, "lesson.tux");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      expect(
        await executeCli(["archive", "init", archivePath, "--name", "Annotation lesson"], io),
      ).toBe(0);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "session",
            "create",
            "--title",
            "Fractions",
            "--subject",
            "Math",
          ],
          io,
        ),
      ).toBe(0);
      const sessionId = JSON.parse(stdout[1]!).session.id as string;
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "add",
            "--session",
            sessionId,
            "--type",
            "important-concept",
            "--at",
            "00:00:02",
            "--end",
            "00:00:03",
            "--priority",
            "high",
            "--title",
            "Equivalent fractions",
            "--text",
            "The numerator and denominator scale together.",
          ],
          io,
        ),
      ).toBe(0);
      const annotation = JSON.parse(stdout[2]!) as {
        id: string;
        revision: string;
        fields: Record<string, string>;
      };
      expect(annotation.revision).toBe("1");
      expect(annotation.fields["start_time_us"]).toBe("2000000");
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "update",
            annotation.id,
            "--text",
            "Scale both parts by the same factor.",
          ],
          io,
        ),
      ).toBe(0);
      const updated = JSON.parse(stdout[3]!) as { revision: string };
      expect(updated.revision).toBe("2");
      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "annotation", "duplicate", annotation.id],
          io,
        ),
      ).toBe(0);
      const duplicate = JSON.parse(stdout[4]!) as { id: string };
      expect(duplicate.id).not.toBe(annotation.id);
      expect(
        await executeCli(["--archive", archivePath, "annotation", "remove", annotation.id], io),
      ).toBe(0);
      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "annotation", "history", annotation.id],
          io,
        ),
      ).toBe(0);
      const history = JSON.parse(stdout[6]!) as Array<{
        history_index: number;
        fields: Record<string, string>;
      }>;
      expect(history).toHaveLength(3);
      expect(history[0]?.fields["_deleted"]).toBe("true");
      expect(history[1]?.fields["content"]).toBe("Scale both parts by the same factor.");
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "restore",
            annotation.id,
            "--revision",
            "1",
          ],
          io,
        ),
      ).toBe(0);
      const restored = JSON.parse(stdout[7]!) as { fields: Record<string, string> };
      expect(restored.fields["_deleted"]).toBeUndefined();
      expect(restored.fields["restored_from_revision"]).toBe("1");
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "list",
            "--session",
            sessionId,
            "--include-deleted",
          ],
          io,
        ),
      ).toBe(0);
      const listed = JSON.parse(stdout[8]!) as Array<{
        id: string;
        fields: Record<string, string>;
      }>;
      expect(listed).toHaveLength(2);
      expect(listed.find((row) => row.id === annotation.id)?.fields["_deleted"]).toBeUndefined();
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("splits and merges annotation ranges without losing their source records", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-annotation-shapes-"));
    const archivePath = join(directory, "lesson.tux");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      expect(await executeCli(["archive", "init", archivePath, "--name", "Geometry"], io)).toBe(0);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "session",
            "create",
            "--title",
            "Angles",
            "--subject",
            "Math",
          ],
          io,
        ),
      ).toBe(0);
      const sessionId = JSON.parse(stdout[1]!).session.id as string;
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "add",
            "--session",
            sessionId,
            "--type",
            "important-concept",
            "--at",
            "00:00:01",
            "--end",
            "00:00:03",
            "--text",
            "Keep units together.",
          ],
          io,
        ),
      ).toBe(0);
      const original = JSON.parse(stdout[2]!) as { id: string };
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "split",
            original.id,
            "--before",
            "Keep units ",
            "--after",
            "together.",
            "--at",
            "00:00:02",
          ],
          io,
        ),
      ).toBe(0);
      const split = JSON.parse(stdout[3]!) as {
        first: { id: string; revision: string };
        second: { id: string; revision: string };
      };
      expect(split.first.id).toBe(original.id);
      expect(split.first.revision).toBe("2");
      expect(split.second.id).not.toBe(original.id);
      expect(split.second.revision).toBe("1");
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "merge",
            split.first.id,
            split.second.id,
            "--separator",
            "",
          ],
          io,
        ),
      ).toBe(0);
      const merged = JSON.parse(stdout[4]!) as { revision: string; fields: Record<string, string> };
      expect(merged.revision).toBe("3");
      expect(merged.fields["content"]).toBe("Keep units together.");
      expect(merged.fields["start_time_us"]).toBe("1000000");
      expect(merged.fields["end_time_us"]).toBe("3000000");
      expect(merged.fields["source_annotation_ids"]).toBe(`${split.first.id},${split.second.id}`);
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("links annotations to session materials and evidence records", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-annotation-links-"));
    const archivePath = join(directory, "lesson.tux");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      expect(await executeCli(["archive", "init", archivePath, "--name", "Evidence"], io)).toBe(0);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "session",
            "create",
            "--title",
            "Ratios",
            "--subject",
            "Math",
          ],
          io,
        ),
      ).toBe(0);
      const sessionId = JSON.parse(stdout[1]!).session.id as string;
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "add",
            "--session",
            sessionId,
            "--type",
            "important-concept",
            "--at",
            "00:00:01",
            "--text",
            "Compare both ratios.",
          ],
          io,
        ),
      ).toBe(0);
      const annotation = JSON.parse(stdout[2]!) as { id: string };
      const snapshot = await openArchiveBytes(new Uint8Array(await readFile(archivePath)));
      const targets: ArchiveRecord[] = [RecordType.assetMetadata, RecordType.evidenceNode].map(
        (type) => ({
          type,
          id: newUuid(),
          revision: 0n,
          previousOffset: 0n,
          blob: new Uint8Array(),
          fields: new Map([["session_id", sessionId]]),
        }),
      );
      const linked = await appendRecords(snapshot, targets);
      await writeFile(archivePath, await linked.source.read(0n, Number(linked.source.size)));

      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "link",
            annotation.id,
            "--to",
            "asset",
            "--target-id",
            targets[0]!.id,
          ],
          io,
        ),
      ).toBe(0);
      const linkedAsset = JSON.parse(stdout[3]!) as {
        revision: string;
        fields: Record<string, string>;
      };
      expect(linkedAsset.revision).toBe("2");
      expect(linkedAsset.fields["linked_asset_ids"]).toBe(targets[0]!.id);
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "unlink",
            annotation.id,
            "--to",
            "asset",
            "--target-id",
            targets[0]!.id,
          ],
          io,
        ),
      ).toBe(0);
      const unlinkedAsset = JSON.parse(stdout[4]!) as {
        revision: string;
        fields: Record<string, string>;
      };
      expect(unlinkedAsset.revision).toBe("3");
      expect(unlinkedAsset.fields["linked_asset_ids"]).toBe("");
      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "annotation",
            "link",
            annotation.id,
            "--to",
            "evidence",
            "--target-id",
            targets[1]!.id,
          ],
          io,
        ),
      ).toBe(0);
      const linkedEvidence = JSON.parse(stdout[5]!) as {
        revision: string;
        fields: Record<string, string>;
      };
      expect(linkedEvidence.revision).toBe("4");
      expect(linkedEvidence.fields["linked_evidence_ids"]).toBe(targets[1]!.id);
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
