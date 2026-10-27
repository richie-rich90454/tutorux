import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { link, lstat, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveFormatError, RecordType, type ArchiveRecord } from "../frontend/archive/format";
import {
  appendRecords,
  compactArchiveSnapshot,
  createArchiveBytes,
  openArchiveSource,
  repairArchiveSnapshot,
  recoverUnpublishedCommit,
  verifyArchiveSnapshot,
  type ArchiveSnapshot,
} from "../frontend/archive/archive";
import { NodeFileArchiveSource } from "../frontend/archive/node-source";
import { MAX_ASSET_BYTES, makeAssetImport, readAssetBytes } from "../frontend/domain/assets";
import {
  evidenceSourcesAreCurrent,
  extractSessionEvidence,
  makeEvidenceEdge,
  reviewEvidenceRecord,
} from "../frontend/domain/evidence";
import {
  GUIDE_TEMPLATES,
  approveGuideRecord,
  createGuideDraft,
  createGuideDraftFromSections,
  guideDraftFromRecord,
  GUIDE_BLOCK_KINDS,
  makeGuideRecord,
  renderGuideMarkdown,
  type GuideBlockKind,
  type GuideDraft,
  type GuideSourceScope,
} from "../frontend/domain/guides";
import {
  duplicateAnnotationRecord,
  makeAnnotationRecord,
  removeAnnotationRecord,
  updateAnnotationRecord,
  validateAnnotationPriority,
  validateAnnotationType,
  type AnnotationInput,
} from "../frontend/domain/annotations";
import {
  canonicalizeProgressUuid,
  decodeStudentProgress,
  isStudentProgressClassification,
  normalizeStudentProgressSkill,
  reviewStudentProgressRecord,
  validateProgressEvidence,
} from "../frontend/domain/student-progress";
import {
  archiveJournalOrganizerRecord,
  cloneSessionRecords,
  makeJournalCollectionRecord,
  makeJournalRecords,
  makeJournalTagRecord,
  makeSessionRecords,
  makeStudentRecord,
  moveRecordToTrash,
  restoreJournalOrganizerRecord,
  restoreRecordFromTrash,
  setSessionArchiveState,
  transitionSessionRecord,
  updateJournalOrganizerRecord,
  updateJournalRecords,
  type JournalCollectionInput,
  type JournalTagInput,
  type SessionCloneInput,
  type SessionCreateOptions,
  type SessionTransitionAction,
  updateSessionRecords,
} from "../frontend/domain/records";
import {
  loadSessionAudioTrashChanges,
  planSessionRestore,
  planSessionTrash,
} from "../frontend/domain/session-trash";
import {
  correctTranscriptRecord,
  formatTranscriptExport,
  formatTranscriptTimestampUs,
  makeTranscriptRecords,
  parseTranscriptSource,
  parseTranscriptTimestamp,
  resolveTranscriptFormat,
  setTranscriptSpeaker,
  setTranscriptTimestamp,
  setTranscriptVerification,
  sortTranscriptRecords,
  type TranscriptExportFormat,
} from "../frontend/domain/transcript";
import {
  makeCustomGuideTemplateRecord,
  parseGuideTemplateImport,
  type GuideTemplateInput,
} from "../frontend/domain/templates";

interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

const ASSET_IMPORT_BATCH_BYTES = 64 * 1024 * 1024;

const io: CliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

const HELP = `Tutorux — local-first tutoring archive tools

Usage:
  tutorux archive init <file.tux> --name <name> [--description <text>]
  tutorux archive info <file.tux> [--json]
  tutorux archive verify <file.tux> [--json]
  tutorux archive recover <file.tux> [--apply] [--json]
  tutorux archive compact <file.tux> [--apply] [--json]
  tutorux archive repair <file.tux> --output <copy.tux> --confirm-sensitive [--json]
  tutorux --archive <file.tux> student create --name <name> [--grade <grade>] [--difficulties <text>] [--demonstrated-improvements <text>] [--preferred-guide-template <id>]
  tutorux --archive <file.tux> student list [--include-deleted] [--json]
  tutorux --archive <file.tux> student show <uuid> [--json]
  tutorux --archive <file.tux> student history <student-id> [--json]
  tutorux --archive <file.tux> student progress <student-id> [--json]
  tutorux --archive <file.tux> student progress-review <student-id> --skill <name> --classification <value> --evidence-ids <uuid,...> --reviewed-by <name> [--note <text>]
  tutorux --archive <file.tux> session create --title <title> --subject <subject> [--student <uuid>] [--entry-id <uuid>]
  tutorux --archive <file.tux> session list [--student-id <uuid>] [--entry-id <uuid>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--archived|--unarchived] [--include-deleted] [--json]
  tutorux --archive <file.tux> session show|verify <uuid> [--json]
  tutorux --archive <file.tux> session update <uuid> [--title <title>] [--subject <subject>] [--objectives <text>] [--student-id <uuid>] [--notes <text>]
  tutorux --archive <file.tux> session clone <uuid> [--title <title>] [--type notes-only|record-audio|import-recording]
  tutorux --archive <file.tux> session archive|unarchive <uuid>
  tutorux --archive <file.tux> session start|complete|review|resume <uuid>
  tutorux --archive <file.tux> session delete <uuid> [--dry-run] [--confirm-scope --scope-token <token>]
  tutorux --archive <file.tux> session restore <uuid>
  tutorux --archive <file.tux> journal create --title <title> --date <YYYY-MM-DD> [--collection-ids <uuid,...>] [--tag-ids <uuid,...>]
  tutorux --archive <file.tux> journal update <entry-id> [--title <title>] [--date <YYYY-MM-DD>] [--notes <text>] [--collection-ids <uuid,...>] [--tag-ids <uuid,...>]
  tutorux --archive <file.tux> journal list [--json]
  tutorux --archive <file.tux> journal collection|tag list|create|show|update|delete|restore
  tutorux --archive <file.tux> annotation add --session <uuid> --type <type> --at <time> --text <text> [--end <time>] [--priority low|normal|high|critical]
  tutorux --archive <file.tux> annotation list [--session <uuid>] [--json]
  tutorux --archive <file.tux> annotation update <id> [--text <text>] [--title <title>] [--start <time>] [--end <time>]
  tutorux --archive <file.tux> annotation remove|prioritize|duplicate <id>
  tutorux --archive <file.tux> annotation history <id> [--limit <1..10000>]
  tutorux --archive <file.tux> annotation restore <id> --revision <history-index>
  tutorux --archive <file.tux> annotation merge <id> <id> [<id>...] [--separator <text>]
  tutorux --archive <file.tux> annotation split <id> --before <text> --after <text> [--at <time>]
  tutorux --archive <file.tux> annotation link|unlink <id> --to asset|evidence --target-id <uuid>
  tutorux --archive <file.tux> asset add <file> [--session <uuid>] | import --input <file> [--session <uuid>]
    [--capture-source browser-microphone --consent [--capture-consent-at-us <us>]]
  tutorux --archive <file.tux> asset import-folder <directory> [--session <uuid>]
    [--capture-source browser-microphone --consent [--capture-consent-at-us <us>]]
  tutorux --archive <file.tux> asset list [--session <uuid>] [--include-deleted] [--json]
  tutorux --archive <file.tux> asset show|preview|verify|remove|restore <id> [--json]
  tutorux --archive <file.tux> asset extract|export <id> --output <file>
  tutorux --archive <file.tux> asset link|unlink <id> --to annotation|transcript --target-id <uuid>
  tutorux --archive <file.tux> evidence extract --session <uuid>
  tutorux --archive <file.tux> evidence list|review [--session <uuid>] [--json]
  tutorux --archive <file.tux> evidence create --session <uuid> --source-segment <uuid> --type <type> --title <title> --content <text>
  tutorux --archive <file.tux> evidence approve|reject|verify|show|update|delete|restore <id>
  tutorux --archive <file.tux> evidence link --from <id> --to <id> --relationship <type>
  tutorux --archive <file.tux> evidence unlink <edge-id>
  tutorux --archive <file.tux> evidence edges --session <uuid>
  tutorux --archive <file.tux> guide create --session <uuid> [--template general|english|mathematics|science|programming|language-learning]
  tutorux --archive <file.tux> guide list [--session <uuid>] [--include-deleted] [--json]
  tutorux --archive <file.tux> guide show|approve|trash|restore|history <id>
  tutorux --archive <file.tux> guide update <id> [--title <title>]
  tutorux --archive <file.tux> guide add-section <id> --heading <heading> [--text <text>]
  tutorux --archive <file.tux> guide remove-section <id> --section-index <index>
  tutorux --archive <file.tux> guide add-block|update-block|remove-block <id> --section-index <index> [--block-index <index>]
  tutorux --archive <file.tux> guide export <id> --output <file.md>
  tutorux --archive <file.tux> template list|show [<id>]
  tutorux --archive <file.tux> template create --name <name> --sections <heading;heading;...>
  tutorux --archive <file.tux> template update <id> [--name <name>] [--sections <headings>]
  tutorux --archive <file.tux> template delete|restore <id>
  tutorux --archive <file.tux> template import --input <file.json>
  tutorux --archive <file.tux> template export <id> --output <file.json>
  tutorux --archive <file.tux> transcript import --session <uuid> --input <file> [--format auto|text|srt|vtt]
  tutorux --archive <file.tux> transcript show --session <uuid> [--json]
  tutorux --archive <file.tux> transcript export --session <uuid> --output <file> [--format text|srt|vtt|json]
  tutorux --archive <file.tux> transcript correct <segment-id> --text <replacement>
  tutorux --archive <file.tux> transcript history <segment-id> [--limit <1..10000>]
  tutorux --archive <file.tux> transcript restore <segment-id> --revision <history-index>
  tutorux --archive <file.tux> transcript timestamp <segment-id> --start <time> --end <time>
  tutorux --archive <file.tux> transcript verify <segment-id> [--state human-verified|provisional|needs-review]
  tutorux --archive <file.tux> transcript speaker <segment-id> --name <label> | --unknown

Global options:
  --archive <path>  Select the archive for record commands
  --json            Print machine-readable JSON
  --help            Show this help
  --version         Show the application version`;

export async function executeCli(argv: readonly string[], output: CliIo = io): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    output.stdout(HELP);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    output.stdout("Tutorux 1.0.0 (TypeScript)");
    return 0;
  }

  try {
    const args = [...argv];
    const jsonOutput = args.includes("--json");
    for (let index = args.length - 1; index >= 0; index -= 1) {
      if (args[index] === "--json") args.splice(index, 1);
    }
    const archiveFlag = args.indexOf("--archive");
    let archivePath: string | undefined;
    if (archiveFlag >= 0) {
      if (args.indexOf("--archive", archiveFlag + 1) >= 0) {
        throw new CliError("Choose only one --archive path.");
      }
      archivePath = args[archiveFlag + 1];
      if (!archivePath || archivePath.startsWith("--"))
        throw new CliError("--archive requires a file path.");
      args.splice(archiveFlag, 2);
    }
    const group = args.shift();
    const action = args.shift();
    if (!group || !action)
      throw new CliError("Choose a command group and action. Run `tutorux --help` for help.");
    const parsed = parseArguments(args);
    if (jsonOutput) parsed.flags.add("json");

    if (group === "archive") return await runArchiveCommand(action, parsed, output);
    if (!archivePath) throw new CliError("Record commands require --archive <path>.");
    return await runRecordCommand(group, action, archivePath, parsed, output);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The command failed unexpectedly.";
    output.stderr(`tutorux: ${message}`);
    return error instanceof CliError ? 2 : 1;
  }
}

class CliError extends Error {}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [name, inlineValue] = value.slice(2).split("=", 2);
    if (!name) throw new CliError("Option names cannot be empty.");
    const next = inlineValue ?? args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(name, next);
      if (inlineValue === undefined) index += 1;
    } else {
      flags.add(name);
    }
  }
  return { positionals, options, flags };
}

async function runArchiveCommand(
  action: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const path = args.positionals[0];
  if (!path) throw new CliError(`archive ${action} requires a file path.`);
  if (action === "init") {
    const name = requiredOption(args, "name");
    const bytes = await createArchiveBytes(name, args.options.get("description") ?? "");
    await writeBytesAtomically(resolve(path), bytes);
    emit(
      output,
      { path: resolve(path), name, bytes: bytes.byteLength, created: true },
      `${basename(path)} created (${bytes.byteLength} bytes).`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (action === "recover") {
    const archivePath = resolve(path);
    const openedInfo = await stat(archivePath);
    const source = await NodeFileArchiveSource.open(archivePath);
    try {
      if (BigInt(openedInfo.size) !== source.size) {
        throw new CliError("The archive changed while recovery was starting. Retry the command.");
      }
      const snapshot = await openArchiveSource(source);
      const recovery = await recoverUnpublishedCommit(snapshot);
      const applied = args.flags.has("apply");
      if (applied) {
        const currentInfo = await stat(archivePath);
        if (
          currentInfo.size !== openedInfo.size ||
          currentInfo.mtimeMs !== openedInfo.mtimeMs ||
          currentInfo.dev !== openedInfo.dev ||
          currentInfo.ino !== openedInfo.ino
        ) {
          throw new CliError("The archive changed during recovery review. Retry the command.");
        }
        await writeSourceAtomically(archivePath, recovery.snapshot);
      }
      const result = {
        path: archivePath,
        previousGeneration: snapshot.commit.generation.toString(),
        recoveredGeneration: recovery.recoveredGeneration.toString(),
        discardedTrailingBytes: recovery.discardedTrailingBytes.toString(),
        recoverable: true,
        applied,
      };
      emit(
        output,
        result,
        applied
          ? `Recovered ${basename(path)} to generation ${result.recoveredGeneration}; discarded ${result.discardedTrailingBytes} trailing bytes.`
          : `Generation ${result.recoveredGeneration} is recoverable. Add --apply to publish it.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      await source.close();
    }
  }
  if (action === "compact") {
    const archivePath = resolve(path);
    const openedInfo = await stat(archivePath);
    const source = await NodeFileArchiveSource.open(archivePath);
    try {
      if (BigInt(openedInfo.size) !== source.size) {
        throw new CliError("The archive changed while compaction was starting. Retry the command.");
      }
      const snapshot = await openArchiveSource(source);
      const compaction = await compactArchiveSnapshot(snapshot);
      const applied = args.flags.has("apply");
      if (applied) {
        const currentInfo = await stat(archivePath);
        if (
          currentInfo.size !== openedInfo.size ||
          currentInfo.mtimeMs !== openedInfo.mtimeMs ||
          currentInfo.dev !== openedInfo.dev ||
          currentInfo.ino !== openedInfo.ino
        ) {
          throw new CliError("The archive changed during compaction review. Retry the command.");
        }
        await writeSourceAtomically(archivePath, compaction.snapshot);
      }
      const result = {
        path: archivePath,
        generation: snapshot.commit.generation.toString(),
        compactedGeneration: compaction.snapshot.commit.generation.toString(),
        originalBytes: compaction.originalBytes.toString(),
        compactedBytes: compaction.compactedBytes.toString(),
        bytesSaved: (compaction.originalBytes - compaction.compactedBytes).toString(),
        recordsPreserved: compaction.preservedRecords,
        applied,
      };
      emit(
        output,
        result,
        applied
          ? `Compacted ${basename(path)} from ${result.originalBytes} to ${result.compactedBytes} bytes.`
          : `Compaction would reduce ${basename(path)} from ${result.originalBytes} to ${result.compactedBytes} bytes. Add --apply to replace it.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      await source.close();
    }
  }
  if (action === "repair") {
    if (!args.flags.has("confirm-sensitive")) {
      throw new CliError(
        "A repaired copy contains student records, recordings, annotations, and credentials. Review the destination and retry with --confirm-sensitive.",
      );
    }
    const archivePath = resolve(path);
    const destinationPath = resolve(requiredOption(args, "output"));
    if (!destinationPath.toLowerCase().endsWith(".tux")) {
      throw new CliError("Repaired archive copies must use the .tux extension.");
    }
    const [sourceCanonicalPath, destinationParentPath] = await Promise.all([
      realpath(archivePath),
      realpath(dirname(destinationPath)),
    ]);
    const canonicalDestinationPath = resolve(destinationParentPath, basename(destinationPath));
    const samePath =
      process.platform === "win32"
        ? sourceCanonicalPath.toLowerCase() === canonicalDestinationPath.toLowerCase()
        : sourceCanonicalPath === canonicalDestinationPath;
    if (samePath) throw new CliError("Repair output must be a separate archive copy.");
    const destinationDirectory = await stat(destinationParentPath);
    if (!destinationDirectory.isDirectory()) {
      throw new CliError("The repair destination directory is unavailable.");
    }
    try {
      await stat(destinationPath);
      throw new CliError(`Repair output already exists: ${destinationPath}`);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (!isNotFound(error)) throw error;
    }

    const openedInfo = await stat(archivePath);
    const source = await NodeFileArchiveSource.open(archivePath);
    try {
      if (BigInt(openedInfo.size) !== source.size) {
        throw new CliError("The archive changed while repair was starting. Retry the command.");
      }
      const snapshot = await openArchiveSource(source);
      const repair = await repairArchiveSnapshot(snapshot);
      const validateBeforePublish = async (): Promise<void> => {
        const currentInfo = await stat(archivePath);
        if (
          currentInfo.size !== openedInfo.size ||
          currentInfo.mtimeMs !== openedInfo.mtimeMs ||
          currentInfo.dev !== openedInfo.dev ||
          currentInfo.ino !== openedInfo.ino
        ) {
          throw new CliError("The archive changed during repair. Retry the command.");
        }
      };
      await writeSourceToNewFileAtomically(destinationPath, repair.snapshot, validateBeforePublish);
      const result = {
        path: archivePath,
        output: destinationPath,
        status: "repaired-copy",
        original_preserved: true,
        selected_verified_generation: repair.selectedGeneration.toString(),
        discarded_bytes: repair.discardedTrailingBytes.toString(),
        original_bytes: repair.originalBytes.toString(),
        compacted_bytes: repair.compactedBytes.toString(),
        records_preserved: repair.preservedRecords,
      };
      emit(
        output,
        result,
        `Validated repair copy created at ${destinationPath}; the original archive was preserved. Selected verified generation ${result.selected_verified_generation}; discarded ${result.discarded_bytes} source bytes.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      await source.close();
    }
  }
  if (action !== "info" && action !== "verify") {
    throw new CliError(`archive ${action} is not implemented in the TypeScript CLI yet.`);
  }
  const source = await NodeFileArchiveSource.open(resolve(path));
  try {
    const snapshot = await openArchiveSource(source);
    if (action === "verify" && snapshot.locked) {
      throw new CliError(
        "This archive is encrypted. Unlock support is required for full verification.",
      );
    }
    const verification = snapshot.locked ? null : await verifyArchiveSnapshot(snapshot);
    const result = {
      path: resolve(path),
      name: (await snapshot.getManifest()).displayName,
      archiveId: snapshot.header.id,
      generation: snapshot.commit.generation.toString(),
      size: snapshot.source.size.toString(),
      records: verification?.liveRecords ?? 0,
      recordsVerified: verification?.currentRecords ?? 0,
      deletedRecords: verification?.deletedRecords ?? 0,
      encrypted: snapshot.encrypted,
      locked: snapshot.locked,
      verified: verification !== null,
      verificationScope: verification
        ? "all-current-primary-records-and-index"
        : "header-and-index",
    };
    emit(
      output,
      result,
      snapshot.locked
        ? `${result.name}: generation ${result.generation}, encrypted records are locked.`
        : `${result.name}: generation ${result.generation}, ${result.records} live records verified (${result.deletedRecords} in Trash).`,
      args.flags.has("json"),
    );
    return 0;
  } finally {
    await source.close();
  }
}

async function runRecordCommand(
  group: string,
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  if (group === "journal" && (action === "collection" || action === "tag")) {
    return runJournalOrganizerCommand(action, path, args, output);
  }
  if (group === "student" && action === "create") {
    const record = makeStudentRecord({
      name: requiredOption(args, "name"),
      grade: args.options.get("grade") ?? "",
      subjects: args.options.get("subjects") ?? "",
      objectives: args.options.get("objectives") ?? "",
      tutorNotes: args.options.get("notes") ?? "",
      difficulties: args.options.get("difficulties") ?? "",
      demonstratedImprovements: args.options.get("demonstrated-improvements") ?? "",
      preferredGuideTemplate: args.options.get("preferred-guide-template") ?? "",
    });
    const [saved] = await mutateArchive(path, [record]);
    const created = saved ?? record;
    emit(
      output,
      toPlainRecord(created),
      `Created student ${field(created, "display_name")} (${created.id}).`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (group === "session" && action === "create") {
    const snapshot = await openForCommand(path);
    let expectedGeneration: bigint;
    let creationOptions: SessionCreateOptions;
    try {
      expectedGeneration = snapshot.commit.generation;
      const studentId = args.options.get("student") ?? args.options.get("student-id") ?? "";
      const student = studentId ? await snapshot.getRecord(RecordType.student, studentId) : null;
      if (studentId && (!student || field(student, "_deleted") === "true")) {
        throw new CliError(`Student ${studentId} was not found in this archive.`);
      }
      if (args.flags.has("entry-id"))
        throw new CliError("--entry-id requires a journal entry UUID.");
      const linkedEntryId = args.options.get("entry-id");
      const linkedEntry = linkedEntryId
        ? await getJournalEntry(snapshot, linkedEntryId.toLowerCase())
        : undefined;
      const settings = await snapshot.listRecords(RecordType.settings);
      creationOptions = {
        ensureJournalRoot: !settings.some((record) => field(record, "record_role") === "journal"),
        ...(linkedEntry ? { linkedEntry } : {}),
      };
    } finally {
      await closeSnapshot(snapshot);
    }
    const records = makeSessionRecords(
      {
        studentId: args.options.get("student") ?? args.options.get("student-id") ?? "",
        subject: requiredOption(args, "subject"),
        title: requiredOption(args, "title"),
        objectives: args.options.get("objectives") ?? "",
        notes: args.options.get("notes") ?? "",
      },
      creationOptions,
    );
    const saved = await mutateArchive(
      path,
      records,
      expectedGeneration,
      "The archive changed while the new session and journal link were being prepared. Retry the command.",
    );
    const session = saved[0] ?? records[0]!;
    emit(
      output,
      {
        session: toPlainRecord(session),
        notesDocumentId: (saved[1] ?? records[1]!).id,
        entryId: field(session, "entry_id"),
      },
      `Created session ${field(session, "title")} (${session.id}) in journal entry ${field(session, "entry_id")}.`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (group === "journal" && action === "create") {
    const collectionIds = optionIdList(args, "collection-ids");
    const tagIds = optionIdList(args, "tag-ids");
    await validateJournalLinks(path, collectionIds ?? [], "journal-collection");
    await validateJournalLinks(path, tagIds ?? [], "journal-tag");
    const records = makeJournalRecords({
      title: requiredOption(args, "title"),
      date: requiredOption(args, "date"),
      notes: args.options.get("notes") ?? "",
      ...(collectionIds === undefined ? {} : { collectionIds }),
      ...(tagIds === undefined ? {} : { tagIds }),
    });
    const saved = await mutateArchive(path, records);
    const entry = saved[0] ?? records[0]!;
    emit(
      output,
      { entry: toPlainRecord(entry), notesDocumentId: (saved[1] ?? records[1]!).id },
      `Created journal entry ${field(entry, "title")} (${entry.id}).`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (group === "transcript") return runTranscriptCommand(action, path, args, output);
  if (group === "annotation") return runAnnotationCommand(action, path, args, output);
  if (group === "asset") return runAssetCommand(action, path, args, output);
  if (group === "evidence") return runEvidenceCommand(action, path, args, output);
  if (group === "guide") return runGuideCommand(action, path, args, output);
  if (group === "template") return runTemplateCommand(action, path, args, output);
  const extended = await runExtendedRecordCommand(group, action, path, args, output);
  if (extended !== null) return extended;
  if ((group === "student" || group === "session" || group === "journal") && action === "list") {
    const type =
      group === "student"
        ? RecordType.student
        : group === "session"
          ? RecordType.session
          : RecordType.settings;
    const role = group === "journal" ? "journal-entry" : undefined;
    const snapshot = await openForCommand(path);
    try {
      let records = (await snapshot.listRecords(type, args.flags.has("include-deleted"))).filter(
        (record) => !role || field(record, "record_role") === role,
      );
      if (group === "session" && (args.flags.has("unarchived") || !args.flags.has("archived"))) {
        records = records.filter((record) => field(record, "archived") !== "true");
      }
      if (group === "session") {
        const studentId = args.options.get("student-id");
        if (studentId !== undefined) {
          records = records.filter((record) => field(record, "student_id") === studentId);
        }
        const rawEntryId = args.options.get("entry-id");
        if (rawEntryId !== undefined) {
          const entryId = canonicalizeProgressUuid(rawEntryId);
          if (!entryId) throw new CliError("--entry-id must be a valid UUID.");
          records = records.filter(
            (record) => canonicalizeProgressUuid(field(record, "entry_id")) === entryId,
          );
        }
        const from = parseSessionDateBound(args.options.get("from"), false);
        const to = parseSessionDateBound(args.options.get("to"), true);
        if (from !== undefined && to !== undefined && from > to) {
          throw new CliError("--from must not be later than --to.");
        }
        if (from !== undefined || to !== undefined) {
          records = records.filter((record) => {
            const startedAt = sessionStartedAt(record);
            return (
              (from === undefined || startedAt >= from) && (to === undefined || startedAt <= to)
            );
          });
        }
        records.sort((left, right) => {
          const leftStartedAt = sessionStartedAt(left);
          const rightStartedAt = sessionStartedAt(right);
          return leftStartedAt > rightStartedAt ? -1 : leftStartedAt < rightStartedAt ? 1 : 0;
        });
      }
      const transcriptCounts = new Map<string, number>();
      if (group === "session" && args.flags.has("json")) {
        for (const transcript of await snapshot.listRecords(RecordType.transcriptSegment)) {
          const sessionId = canonicalizeProgressUuid(field(transcript, "session_id"));
          if (sessionId)
            transcriptCounts.set(sessionId, (transcriptCounts.get(sessionId) ?? 0) + 1);
        }
      }
      const rows = records.map((record) => {
        if (group === "student") return studentProfileObject(record);
        const row = toPlainRecord(record);
        if (group !== "session") return row;
        const audioChunkCount = record.fields.get("recording_audio_chunks") ?? "0";
        const audioDuration = record.fields.get("recording_duration_us") ?? "0";
        const transcriptSegmentCount = transcriptCounts.get(record.id.toLowerCase()) ?? 0;
        return {
          ...row,
          entry_id: field(record, "entry_id"),
          notes_document_id: field(record, "notes_document_id"),
          session_id: record.id,
          title: record.fields.get("title") ?? "Untitled session",
          session_type:
            record.fields.get("session_type") ??
            (field(record, "recording_state") === "not-started" ? "notes-only" : "record-audio"),
          session_state: record.fields.get("session_state") ?? "active",
          recording_state: record.fields.get("recording_state") ?? "not-started",
          started_at_us:
            record.fields.get("started_at_us") ?? record.fields.get("created_at_us") ?? "0",
          ended_at_us: record.fields.get("ended_at_us") ?? "0",
          reviewed_at_us: record.fields.get("reviewed_at_us") ?? "0",
          audio_chunk_count: audioChunkCount,
          audio_duration_us: audioDuration,
          has_audio: audioChunkCount !== "0" || audioDuration !== "0" ? "true" : "false",
          transcript_segment_count: String(transcriptSegmentCount),
          has_transcript: transcriptSegmentCount > 0 ? "true" : "false",
        };
      });
      const sessionSummary =
        records.length === 0
          ? "No sessions in this archive."
          : records
              .map(
                (record) =>
                  `${record.id}  ${field(record, "subject")} · ${field(record, "title")}  [${field(record, "processing_state")}]`,
              )
              .join("\n");
      const studentSummary =
        records.length === 0
          ? "No students in this archive."
          : records
              .map(
                (record) =>
                  `${record.id}  ${field(record, "display_name")}  ${field(record, "grade")}`,
              )
              .join("\n");
      emit(
        output,
        rows,
        group === "session"
          ? sessionSummary
          : group === "student"
            ? studentSummary
            : rows.length === 0
              ? `No ${group} records.`
              : `${rows.length} ${group} record${rows.length === 1 ? "" : "s"}.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }
  throw new CliError(`${group} ${action} is not implemented in the TypeScript CLI yet.`);
}

async function runGuideCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");

  if (action === "list") {
    const snapshot = await openForCommand(path);
    try {
      let records = await snapshot.listRecords(RecordType.guide, args.flags.has("include-deleted"));
      const sessionId = args.options.get("session")?.toLowerCase();
      if (sessionId)
        records = records.filter(
          (record) => field(record, "session_id").toLowerCase() === sessionId,
        );
      const rows = records.map(toPlainRecord);
      emit(
        output,
        rows,
        rows.length
          ? `${rows.length} study guide${rows.length === 1 ? "" : "s"}.`
          : "No study guides.",
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "create") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord;
    try {
      const scope = await readGuideScope(snapshot, sessionId);
      const requestedTemplate = args.options.get("template");
      let draft: GuideDraft;
      if (!requestedTemplate) draft = createGuideDraft(scope.session);
      else {
        const builtin = GUIDE_TEMPLATES.find((template) => template.id === requestedTemplate);
        if (builtin) draft = createGuideDraft(scope.session, builtin.id);
        else {
          const settings = await snapshot.listRecords(RecordType.settings);
          const custom = settings.find(
            (entry) =>
              field(entry, "record_role") === "guide-template" &&
              (entry.id.toLowerCase() === requestedTemplate.toLowerCase() ||
                field(entry, "name").toLocaleLowerCase() === requestedTemplate.toLocaleLowerCase()),
          );
          if (!custom) throw new CliError(`Template “${requestedTemplate}” was not found.`);
          draft = createGuideDraftFromSections(
            scope.session,
            custom.id,
            decodeStoredTemplateSections(field(custom, "sections")),
          );
        }
      }
      if (args.options.has("title")) draft.title = args.options.get("title")!;
      record = makeGuideRecord(draft, scope);
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = (await mutateArchive(path, [record]))[0] ?? record;
    emit(
      output,
      toPlainRecord(saved),
      `Created study guide ${field(saved, "title")} (${saved.id}).`,
      json,
    );
    return 0;
  }

  const id = requiredPosition(args, 0, "study guide ID");

  if (action === "show" || action === "export") {
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord;
    let markdown: string;
    try {
      record = await requireLiveRecord(snapshot, RecordType.guide, id);
      markdown = renderGuideMarkdown(record);
    } finally {
      await closeSnapshot(snapshot);
    }
    if (action === "show") {
      if (json) emit(output, toPlainRecord(record), "", true);
      else output.stdout(markdown);
      return 0;
    }
    const outputPath = args.options.get("output");
    if (!outputPath) throw new CliError("--output is required.");
    const destination = resolve(outputPath);
    if (await sameFileIdentity(destination, path))
      throw new CliError("Guide output cannot replace its source archive.");
    await writeTextAtomically(destination, markdown);
    emit(
      output,
      { id: record.id, output: destination },
      `Exported study guide to ${destination}.`,
      json,
    );
    return 0;
  }

  if (action === "history") {
    const snapshot = await openForCommand(path);
    try {
      const records = await snapshot.getRecordHistory(
        RecordType.guide,
        id,
        parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000),
      );
      const rows = records.map(toPlainRecord);
      emit(output, rows, `${rows.length} guide revision${rows.length === 1 ? "" : "s"}.`, json);
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "trash" || action === "delete" || action === "restore") {
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord | null;
    try {
      record = await snapshot.getRecord(RecordType.guide, id);
      if (!record || (action !== "restore" && field(record, "_deleted") === "true")) {
        throw new CliError(`Study guide ${id} was not found.`);
      }
      if (action === "restore" && field(record, "_deleted") !== "true") {
        throw new CliError(`Study guide ${id} is not in Trash.`);
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const changed =
      action === "restore" ? restoreRecordFromTrash(record) : moveGuideToTrash(record);
    await mutateArchive(path, [changed]);
    emit(
      output,
      { id: changed.id, deleted: action !== "restore" },
      action === "restore" ? "Study guide restored." : "Study guide moved to Trash.",
      json,
    );
    return 0;
  }

  const context = await readGuideContext(path, id);
  const { current, draft, scope } = context;
  if (action === "approve") {
    const checked = makeGuideRecord(draft, scope, current);
    const approved = approveGuideRecord(checked);
    const saved = (await mutateArchive(path, [approved]))[0] ?? approved;
    emit(output, toPlainRecord(saved), `Approved study guide ${saved.id}.`, json);
    return 0;
  }

  if (action === "duplicate") {
    const copy = { ...draft, title: `${draft.title} (copy)` };
    const duplicated = makeGuideRecord(copy, scope);
    const saved = (await mutateArchive(path, [duplicated]))[0] ?? duplicated;
    emit(output, toPlainRecord(saved), `Duplicated study guide ${saved.id}.`, json);
    return 0;
  }

  if (action === "update") {
    let changed = false;
    if (args.options.has("title")) {
      draft.title = args.options.get("title")!;
      changed = true;
    }
    if (args.options.has("heading")) {
      const index = guideIndex(
        args.options.get("section-index"),
        "section-index",
        draft.sections.length,
      );
      draft.sections[index]!.heading = args.options.get("heading")!;
      changed = true;
    }
    if (!changed)
      throw new CliError("Provide --title or --heading with --section-index to update a guide.");
  } else if (action === "add-section") {
    const heading = requiredOption(args, "heading");
    const blocks = args.options.has("text")
      ? [
          guideBlock(
            args.options.get("kind") ?? "paragraph",
            args.options.get("text")!,
            args.options.get("sources") ?? "",
          ),
        ]
      : [];
    draft.sections.push({ id: randomUUID(), heading, blocks });
  } else if (action === "remove-section") {
    const index = guideIndex(
      args.options.get("section-index"),
      "section-index",
      draft.sections.length,
    );
    draft.sections.splice(index, 1);
  } else if (action === "add-block") {
    const sectionIndex = guideIndex(
      args.options.get("section-index"),
      "section-index",
      draft.sections.length,
    );
    draft.sections[sectionIndex]!.blocks.push(
      guideBlock(
        args.options.get("kind") ?? "paragraph",
        requiredOption(args, "text"),
        args.options.get("sources") ?? "",
      ),
    );
  } else if (action === "remove-block") {
    const sectionIndex = guideIndex(
      args.options.get("section-index"),
      "section-index",
      draft.sections.length,
    );
    const section = draft.sections[sectionIndex]!;
    const blockIndex = guideIndex(
      args.options.get("block-index"),
      "block-index",
      section.blocks.length,
    );
    section.blocks.splice(blockIndex, 1);
  } else if (action === "update-block") {
    const sectionIndex = guideIndex(
      args.options.get("section-index"),
      "section-index",
      draft.sections.length,
    );
    const section = draft.sections[sectionIndex]!;
    const blockIndex = guideIndex(
      args.options.get("block-index"),
      "block-index",
      section.blocks.length,
    );
    const block = section.blocks[blockIndex]!;
    if (args.options.has("text")) {
      block.text = args.options.get("text")!;
      block.stale = false;
      block.origin = "human-edited";
    }
    if (args.options.has("kind")) {
      block.kind = validateGuideKind(args.options.get("kind")!);
      block.stale = false;
      if (block.origin === "ai-generated") block.origin = "human-edited";
    }
    if (args.options.has("sources")) {
      block.sourceIds = args.options.get("sources")!;
      block.stale = false;
    }
    if (args.flags.has("mark-reviewed")) block.stale = false;
    if (
      !args.options.has("text") &&
      !args.options.has("kind") &&
      !args.options.has("sources") &&
      !args.flags.has("mark-reviewed")
    ) {
      throw new CliError("Provide --text, --kind, --sources, or --mark-reviewed.");
    }
  } else {
    throw new CliError(`guide ${action} is not implemented in the TypeScript CLI yet.`);
  }

  const updated = makeGuideRecord(draft, scope, current);
  const saved = (await mutateArchive(path, [updated]))[0] ?? updated;
  emit(output, toPlainRecord(saved), `Study guide ${saved.id} updated.`, json);
  return 0;
}

function guideBlock(
  kind: string,
  text: string,
  sourceIds: string,
): GuideDraft["sections"][number]["blocks"][number] {
  return {
    kind: validateGuideKind(kind),
    text,
    sourceIds,
    stale: false,
    origin: "tutor-authored",
  };
}

function moveGuideToTrash(record: ArchiveRecord): ArchiveRecord {
  const removed = moveRecordToTrash(record);
  const fields = new Map(removed.fields);
  fields.set("_trash_group_id", record.id);
  return { ...removed, fields };
}

function validateGuideKind(value: string): GuideBlockKind {
  if ((GUIDE_BLOCK_KINDS as readonly string[]).includes(value)) return value as GuideBlockKind;
  throw new CliError(`Guide block kind “${value}” is not supported.`);
}

function guideIndex(raw: string | undefined, name: string, length: number): number {
  const value = parseBoundedOption(raw, name, -1, 0, Math.max(0, length - 1));
  if (value >= length) throw new CliError(`--${name} is outside the available range.`);
  return value;
}

async function readGuideScope(
  snapshot: ArchiveSnapshot,
  sessionId: string,
): Promise<GuideSourceScope> {
  const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
  const [students, sessions, settings, transcripts, annotations, assets, evidence] =
    await Promise.all([
      snapshot.listRecords(RecordType.student),
      snapshot.listRecords(RecordType.session),
      snapshot.listRecords(RecordType.settings),
      snapshot.listRecords(RecordType.transcriptSegment),
      snapshot.listRecords(RecordType.annotation),
      snapshot.listRecords(RecordType.assetMetadata),
      snapshot.listRecords(RecordType.evidenceNode),
    ]);
  return {
    session,
    records: [
      ...students,
      ...sessions,
      ...settings,
      ...transcripts,
      ...annotations,
      ...assets,
      ...evidence,
    ],
  };
}

async function readGuideContext(
  path: string,
  id: string,
): Promise<{ current: ArchiveRecord; draft: GuideDraft; scope: GuideSourceScope }> {
  const snapshot = await openForCommand(path);
  try {
    const current = await requireLiveRecord(snapshot, RecordType.guide, id);
    const draft = guideDraftFromRecord(current);
    if (!draft.sessionId)
      throw new CliError(
        "This guide is linked to a journal entry but not a session; CLI editing currently requires a session.",
      );
    const scope = await readGuideScope(snapshot, draft.sessionId);
    return { current, draft, scope };
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function runTemplateCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  if (action === "list") {
    const snapshot = await openForCommand(path);
    try {
      const stored = await snapshot.listRecords(RecordType.settings);
      const rows: Record<string, unknown>[] = GUIDE_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        origin: "built-in",
        subject: template.subject,
        description: template.description,
        sections: [...template.sections],
        body: template.body,
      }));
      for (const record of stored) {
        if (
          field(record, "record_role") !== "guide-template" ||
          field(record, "builtin_template_id")
        )
          continue;
        rows.push({
          ...toPlainRecord(record),
          origin: "custom",
          sections: decodeStoredTemplateSections(field(record, "sections")),
        });
      }
      emit(
        output,
        rows,
        `${rows.length} study-guide template${rows.length === 1 ? "" : "s"}.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "show" || action === "export") {
    const idOrName = requiredPosition(args, 0, "template ID or name");
    const snapshot = await openForCommand(path);
    let template: Record<string, unknown>;
    try {
      const builtin = GUIDE_TEMPLATES.find((item) => item.id === idOrName);
      if (builtin) {
        template = {
          id: builtin.id,
          name: builtin.name,
          origin: "built-in",
          subject: builtin.subject,
          description: builtin.description,
          sections: [...builtin.sections],
          body: builtin.body,
        };
      } else {
        const stored = await snapshot.listRecords(RecordType.settings);
        const record = stored.find(
          (item) =>
            field(item, "record_role") === "guide-template" &&
            (item.id.toLowerCase() === idOrName.toLowerCase() ||
              field(item, "name").toLocaleLowerCase() === idOrName.toLocaleLowerCase()),
        );
        if (!record) throw new CliError(`Template “${idOrName}” was not found.`);
        template = customTemplateValue(record);
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    if (action === "show") {
      if (json) emit(output, template, "", true);
      else {
        output.stdout(
          `${String(template["name"])}\n${String(template["description"] ?? "")}\n\n${(template["sections"] as string[]).join("\n")}`,
        );
      }
      return 0;
    }
    const outputPath = args.options.get("output");
    if (!outputPath) throw new CliError("--output is required.");
    const destination = resolve(outputPath);
    if (await sameFileIdentity(destination, path))
      throw new CliError("Template output cannot replace its source archive.");
    const exported = {
      format: "tutorux-guide-template-v1",
      name: template["name"],
      subject: template["subject"],
      description: template["description"],
      sections: template["sections"],
      body: template["body"],
    };
    await writeTextAtomically(destination, `${JSON.stringify(exported, null, 2)}\n`);
    emit(
      output,
      { id: template["id"], output: destination },
      `Exported template to ${destination}.`,
      json,
    );
    return 0;
  }

  if (action === "create" || action === "import") {
    const imported =
      action === "import" ? await readTemplateImport(requiredOption(args, "input")) : null;
    const name = args.options.get("name")?.trim() || imported?.name || "";
    if (!name) throw new CliError("--name is required.");
    const sections = args.options.has("sections")
      ? parseTemplateSectionArgument(args.options.get("sections")!)
      : (imported?.sections ?? []);
    if (!sections.length)
      throw new CliError("Provide at least one template section with --sections.");
    const record = makeCustomGuideTemplateRecord({
      name,
      subject: args.options.get("subject") ?? imported?.subject ?? "general",
      description: args.options.get("description") ?? imported?.description ?? "",
      sections,
      body: args.options.get("body") ?? imported?.body ?? "",
    });
    const saved = (await mutateArchive(path, [record]))[0] ?? record;
    emit(
      output,
      toPlainRecord(saved),
      `Created template ${field(saved, "name")} (${saved.id}).`,
      json,
    );
    return 0;
  }

  if (action === "update" || action === "delete" || action === "restore") {
    const id = requiredPosition(args, 0, "template ID");
    const snapshot = await openForCommand(path);
    let current: ArchiveRecord;
    try {
      const candidate = await snapshot.getRecord(RecordType.settings, id);
      if (!candidate || field(candidate, "record_role") !== "guide-template") {
        throw new CliError(`Template ${id} was not found.`);
      }
      if (action === "delete" && field(candidate, "_deleted") === "true")
        throw new CliError(`Template ${id} is already in Trash.`);
      if (action === "restore" && field(candidate, "_deleted") !== "true")
        throw new CliError(`Template ${id} is not in Trash.`);
      if (action === "update" && field(candidate, "_deleted") === "true")
        throw new CliError(`Template ${id} is in Trash. Restore it before updating.`);
      current = candidate;
    } finally {
      await closeSnapshot(snapshot);
    }
    let updated: ArchiveRecord;
    if (action === "delete") updated = moveRecordToTrash(current);
    else if (action === "restore") updated = restoreRecordFromTrash(current);
    else {
      const fields = new Map(current.fields);
      if (args.options.has("name"))
        fields.set("name", validateUpdatedField("title", requiredOption(args, "name")));
      if (args.options.has("subject"))
        fields.set(
          "subject",
          validateEvidenceText(args.options.get("subject")!, "Template subject", 128),
        );
      if (args.options.has("description"))
        fields.set(
          "description",
          validateEvidenceText(args.options.get("description")!, "Template description", 4_096),
        );
      if (args.options.has("sections")) {
        const sections = validateTemplateSections(
          parseTemplateSectionArgument(args.options.get("sections")!),
        );
        if (!sections.length) throw new CliError("A template must contain at least one section.");
        fields.set("sections", sections.join("\n"));
      }
      if (args.options.has("body"))
        fields.set(
          "body",
          validateEvidenceText(args.options.get("body")!, "Template body", 100_000),
        );
      if (
        !["name", "subject", "description", "sections", "body"].some((key) => args.options.has(key))
      ) {
        throw new CliError("Provide a template field to update.");
      }
      fields.set("updated_at_us", timestampNow());
      updated = { ...current, fields };
    }
    const saved = (await mutateArchive(path, [updated]))[0] ?? updated;
    const message =
      action === "delete"
        ? "Template moved to Trash."
        : action === "restore"
          ? "Template restored."
          : "Template updated.";
    emit(output, toPlainRecord(saved), message, json);
    return 0;
  }

  throw new CliError(`template ${action} is not implemented in the TypeScript CLI yet.`);
}

function parseTemplateSectionArgument(value: string): string[] {
  return value
    .split(/[\r\n,;]/u)
    .map((heading) => heading.trim())
    .filter(Boolean);
}

function decodeStoredTemplateSections(value: string): string[] {
  const sections = /[\r\n]/u.test(value) ? value.split(/\r\n|\r|\n/u) : [value];
  return sections.map((heading) => heading.trim()).filter(Boolean);
}

function validateTemplateSections(sections: readonly string[]): string[] {
  if (sections.length > 250) throw new CliError("A template can contain at most 250 sections.");
  return sections.map((heading, index) => {
    const value = validateEvidenceText(heading, `Template section ${index + 1}`, 256).trim();
    if (!value) throw new CliError("Every template section needs a heading.");
    return value;
  });
}

function customTemplateValue(record: ArchiveRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: field(record, "name"),
    origin: field(record, "builtin_template_id") ? "built-in override" : "custom",
    subject: field(record, "subject"),
    description: field(record, "description"),
    sections: decodeStoredTemplateSections(field(record, "sections")),
    body: field(record, "body"),
  };
}

async function sameFileIdentity(firstPath: string, secondPath: string): Promise<boolean> {
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  if (
    first === second ||
    (process.platform === "win32" && first.toLowerCase() === second.toLowerCase())
  ) {
    return true;
  }
  try {
    const [firstStat, secondStat] = await Promise.all([stat(first), stat(second)]);
    if (
      firstStat.dev === secondStat.dev &&
      firstStat.ino !== 0 &&
      firstStat.ino === secondStat.ino
    ) {
      return true;
    }
  } catch {
    // A missing output path is expected; canonical path comparison still handles aliases.
  }
  try {
    const [firstRealPath, secondRealPath] = await Promise.all([realpath(first), realpath(second)]);
    return process.platform === "win32"
      ? firstRealPath.toLowerCase() === secondRealPath.toLowerCase()
      : firstRealPath === secondRealPath;
  } catch {
    return false;
  }
}

async function readTemplateImport(inputPath: string): Promise<GuideTemplateInput> {
  const absolutePath = resolve(inputPath);
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink())
    throw new CliError("Template input must be a regular, non-symlink file.");
  if (info.size > 1024 * 1024) throw new CliError("Template input exceeds the 1 MiB limit.");
  return parseGuideTemplateImport(await readFile(absolutePath, "utf8"));
}

async function runAssetCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  if (action === "import" || action === "add" || action === "import-folder") {
    const singleImport = action === "import" || action === "add";
    let inputPaths: string[];
    if (singleImport) {
      const inputValue =
        action === "add" ? args.positionals[0] : (args.options.get("input") ?? args.positionals[0]);
      if (!inputValue) {
        throw new CliError(action === "add" ? "Source file is required." : "--input is required.");
      }
      inputPaths = [resolve(inputValue)];
    } else {
      const inputDirectory = resolve(requiredPosition(args, 0, "source directory"));
      const directoryInfo = await stat(inputDirectory);
      if (!directoryInfo.isDirectory()) {
        throw new CliError("Import source must be a directory.");
      }
      const entries = await readdir(inputDirectory, { withFileTypes: true });
      inputPaths = [];
      for (const entry of entries) {
        const entryPath = join(inputDirectory, entry.name);
        const fileInfo = await lstat(entryPath);
        if (fileInfo.isFile() && !fileInfo.isSymbolicLink()) inputPaths.push(entryPath);
        if (inputPaths.length > 10_000) {
          throw new CliError("Folder import is limited to 10,000 regular files.");
        }
      }
      inputPaths.sort((left, right) => {
        const leftName = basename(left);
        const rightName = basename(right);
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
      });
    }
    const sessionId = args.options.get("session") ?? "";
    const captureSource = args.options.get("capture-source");
    if (captureSource !== undefined && captureSource !== "browser-microphone") {
      throw new CliError("Captured assets support the browser-microphone source label.");
    }
    if (captureSource && !args.flags.has("consent")) {
      throw new CliError(
        "Confirm microphone recording consent with --consent before importing a browser capture.",
      );
    }
    if (captureSource && !sessionId) {
      throw new CliError("A browser microphone capture must be associated with a session.");
    }
    let captureConsentAtUs: string | undefined;
    if (args.options.has("capture-consent-at-us")) {
      const rawConsentTime = args.options.get("capture-consent-at-us") ?? "";
      if (!captureSource || !/^\d+$/u.test(rawConsentTime)) {
        throw new CliError("Capture consent time requires a valid browser microphone source.");
      }
      const parsedConsentTime = BigInt(rawConsentTime);
      if (parsedConsentTime <= 0n || parsedConsentTime > 18_446_744_073_709_551_615n) {
        throw new CliError("Capture consent time requires a valid browser microphone source.");
      }
      captureConsentAtUs = parsedConsentTime.toString();
    }
    const importedAssets: Array<{
      readonly metadata: ArchiveRecord;
      readonly deduplicated: boolean;
      readonly chunkCount: number;
    }> = [];
    let snapshot: ArchiveSnapshot | null = null;
    let pendingBytes = 0;
    let pendingRecords: ArchiveRecord[] = [];
    let pendingResultIndices: number[] = [];
    let pendingBlobs = new Map<string, { readonly id: string; readonly chunkCount: string }>();
    const flushBatch = async (): Promise<void> => {
      if (snapshot) {
        await closeSnapshot(snapshot);
        snapshot = null;
      }
      if (pendingRecords.length === 0) return;
      const saved = await mutateArchive(path, pendingRecords);
      const savedMetadata = new Map<string, ArchiveRecord>();
      for (const record of saved) {
        if (record.type === RecordType.assetMetadata) savedMetadata.set(record.id, record);
      }
      for (const index of pendingResultIndices) {
        const pending = importedAssets[index]!;
        const metadata = savedMetadata.get(pending.metadata.id);
        if (metadata) importedAssets[index] = { ...pending, metadata };
      }
      pendingBytes = 0;
      pendingRecords = [];
      pendingResultIndices = [];
      pendingBlobs = new Map();
    };

    try {
      for (const inputPath of inputPaths) {
        const fileInfo = await lstat(inputPath);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
          throw new CliError("Material input must be a regular, non-symlink file.");
        }
        if (fileInfo.size > MAX_ASSET_BYTES) {
          throw new CliError("Material exceeds the configured 256 MiB import limit.");
        }
        const bytes = await readFile(inputPath);
        if (!snapshot) {
          snapshot = await openForCommand(path);
          if (sessionId) await requireLiveRecord(snapshot, RecordType.session, sessionId);
        }
        const importSnapshot = snapshot;
        if (!importSnapshot) throw new Error("The archive snapshot could not be opened.");
        const imported = await makeAssetImport(
          importSnapshot,
          { name: basename(inputPath), size: bytes.byteLength, readBytes: async () => bytes },
          sessionId,
        );
        const metadataFields = new Map(imported.metadata.fields);
        if (captureSource) {
          const mimeType = field(imported.metadata, "mime_type");
          const browserWebmAudio =
            mimeType === "video/webm" && inputPath.toLowerCase().endsWith(".webm");
          if (!mimeType.startsWith("audio/") && !browserWebmAudio) {
            throw new CliError(
              "A browser microphone capture must contain a recognized audio file.",
            );
          }
          if (browserWebmAudio) metadataFields.set("mime_type", "audio/webm");
          metadataFields.set("capture_source", captureSource);
          metadataFields.set("capture_consent_at_us", captureConsentAtUs ?? timestampNow());
          metadataFields.set("capture_consent_policy", "1");
        }
        const contentHash = field(imported.metadata, "content_hash").toLowerCase();
        const existingBatchBlob = pendingBlobs.get(contentHash);
        let deduplicated = imported.deduplicated;
        if (existingBatchBlob) {
          metadataFields.set("blob_id", existingBatchBlob.id);
          metadataFields.set("blob_count", existingBatchBlob.chunkCount);
          deduplicated = true;
        } else {
          pendingRecords.push(
            ...imported.records.filter((record) => record.type !== RecordType.assetMetadata),
          );
          pendingBlobs.set(contentHash, {
            id: field(imported.metadata, "blob_id"),
            chunkCount: field(imported.metadata, "blob_count"),
          });
          if (!imported.deduplicated) pendingBytes += bytes.byteLength;
        }
        const metadata = { ...imported.metadata, fields: metadataFields };
        pendingRecords.push(metadata);
        pendingResultIndices.push(importedAssets.length);
        importedAssets.push({ metadata, deduplicated, chunkCount: imported.chunkCount });
        if (pendingBytes >= ASSET_IMPORT_BATCH_BYTES) await flushBatch();
      }
      await flushBatch();
    } finally {
      if (snapshot) await closeSnapshot(snapshot);
    }
    if (singleImport) {
      const imported = importedAssets[0]!;
      emit(
        output,
        {
          material: toPlainRecord(imported.metadata),
          deduplicated: imported.deduplicated,
          chunk_count: String(imported.chunkCount),
        },
        `${field(imported.metadata, "filename") || "Material"} imported${imported.deduplicated ? " (content deduplicated)" : ""}.`,
        json,
      );
    } else {
      emit(
        output,
        importedAssets.map(({ metadata }) => toPlainRecord(metadata)),
        `Imported ${importedAssets.length} asset${importedAssets.length === 1 ? "" : "s"} into the archive.`,
        json,
      );
    }
    return 0;
  }

  if (action === "list") {
    const snapshot = await openForCommand(path);
    try {
      const records = await snapshot.listRecords(
        RecordType.assetMetadata,
        args.flags.has("include-deleted"),
      );
      const sessionId = args.options.get("session")?.toLowerCase();
      const internalRoles = new Set([
        "audio-track",
        "recording-take",
        "waveform-pyramid",
        "sparse-timestamp-seek-index",
        "asset-blob-manifest",
        "asset-blob-chunk",
      ]);
      const rows = records
        .filter((record) => !internalRoles.has(field(record, "record_role")))
        .filter((record) => sessionId === undefined || field(record, "session_id") === sessionId)
        .map(toPlainRecord);
      emit(
        output,
        rows,
        rows.length === 0
          ? "No materials."
          : `${rows.length} material${rows.length === 1 ? "" : "s"}.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "show" || action === "preview") {
    const id = requiredPosition(args, 0, "material ID");
    const record = await getLiveRecordAtPath(path, RecordType.assetMetadata, id);
    emit(output, toPlainRecord(record), `Material ${id}.`, json);
    return 0;
  }

  if (action === "remove") {
    const id = requiredPosition(args, 0, "material ID");
    const current = await getLiveRecordAtPath(path, RecordType.assetMetadata, id);
    const fields = new Map(current.fields);
    fields.set("_deleted", "true");
    const [saved] = await mutateArchive(path, [
      { ...current, revision: 0n, previousOffset: 0n, fields },
    ]);
    emit(
      output,
      toPlainRecord(saved ?? { ...current, fields }),
      "Material reference removed; immutable blob remains until archive compaction.",
      json,
    );
    return 0;
  }

  if (action === "restore") {
    const id = requiredPosition(args, 0, "material ID");
    const current = await getRecordAtPath(path, RecordType.assetMetadata, id);
    if (field(current, "_deleted") !== "true") {
      throw new CliError("Material is not in Trash.");
    }
    const fields = new Map(current.fields);
    fields.delete("_deleted");
    fields.set("restored_at_us", timestampNow());
    const [saved] = await mutateArchive(path, [
      { ...current, revision: 0n, previousOffset: 0n, fields },
    ]);
    emit(
      output,
      toPlainRecord(saved ?? { ...current, fields }),
      "Material restored from Trash.",
      json,
    );
    return 0;
  }

  if (action === "verify") {
    const id = requiredPosition(args, 0, "material ID");
    const snapshot = await openForCommand(path);
    try {
      const asset = await snapshot.getRecord(RecordType.assetMetadata, id);
      if (!asset || field(asset, "_deleted") === "true") {
        throw new CliError(`Material ${id} was not found in this archive.`);
      }
      let valid = true;
      try {
        await readAssetBytes(snapshot, asset);
      } catch (error) {
        if (
          !(error instanceof ArchiveFormatError) ||
          error.code !== "asset_content_integrity_failed"
        ) {
          throw error;
        }
        valid = false;
      }
      emit(
        output,
        { asset_id: asset.id, valid, sha256: field(asset, "content_hash") },
        valid ? "Asset content hash is valid." : "Asset content hash mismatch.",
        json,
      );
      return valid ? 0 : 2;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "export" || action === "extract") {
    const id = requiredPosition(args, 0, "material ID");
    const outputPath = args.options.get("output");
    if (!outputPath) throw new CliError("--output is required.");
    const archivePath = resolve(path);
    const destination = resolve(outputPath);
    if (await sameFileIdentity(destination, archivePath))
      throw new CliError("Material output cannot replace its source archive.");
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord | null;
    let bytes: Uint8Array;
    try {
      record = await snapshot.getRecord(RecordType.assetMetadata, id);
      if (!record || record.fields.get("_deleted") === "true") {
        throw new CliError(`Material ${id} was not found in this archive.`);
      }
      bytes = await readAssetBytes(snapshot, record);
    } finally {
      await closeSnapshot(snapshot);
    }
    await writeBytesAtomically(destination, bytes);
    emit(
      output,
      { id: record.id, output: destination, bytes: bytes.byteLength },
      `Exported ${field(record, "filename") || id} to ${destination}.`,
      json,
    );
    return 0;
  }
  if (action === "link" || action === "unlink") {
    const assetId = requiredPosition(args, 0, "material ID");
    const targetName = requiredOption(args, "to").toLowerCase();
    const targetId = requiredOption(args, "target-id");
    const targetType =
      targetName === "annotation"
        ? RecordType.annotation
        : targetName === "transcript"
          ? RecordType.transcriptSegment
          : null;
    if (targetType === null) {
      throw new CliError("Assets can currently link to annotations or transcript segments.");
    }

    const asset = await getLiveRecordAtPath(path, RecordType.assetMetadata, assetId);
    const target = await getLiveRecordAtPath(path, targetType, targetId);
    const assetSession = field(asset, "session_id");
    const targetSession = field(target, "session_id");
    if (assetSession && assetSession !== targetSession) {
      throw new CliError("An asset cannot link to a record from a different session.");
    }

    const canonicalAssetId = asset.id.toLowerCase();
    const linkedAssetIds = field(target, "linked_asset_ids")
      .split(",")
      .filter((id) => id.length > 0);
    const existingIndex = linkedAssetIds.indexOf(canonicalAssetId);
    if (action === "link" && existingIndex === -1) linkedAssetIds.push(canonicalAssetId);
    if (action === "unlink" && existingIndex !== -1) linkedAssetIds.splice(existingIndex, 1);

    const fields = new Map(target.fields);
    fields.set("linked_asset_ids", linkedAssetIds.join(","));
    if (targetType === RecordType.transcriptSegment) {
      fields.set("human_edited_at_us", timestampNow());
    }
    const [saved] = await mutateArchive(path, [
      { ...target, revision: 0n, previousOffset: 0n, fields },
    ]);
    const result = saved ?? { ...target, fields };
    emit(
      output,
      toPlainRecord(result),
      action === "link" ? "Asset linked to target." : "Asset unlinked from target.",
      json,
    );
    return 0;
  }
  throw new CliError(`asset ${action} is not implemented in the TypeScript CLI yet.`);
}

async function runEvidenceCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  if (action === "extract") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      records = await extractSessionEvidence(snapshot, session);
    } finally {
      await closeSnapshot(snapshot);
    }
    if (records.length === 0) {
      emit(output, [], "No new evidence was found for this session.", json);
      return 0;
    }
    const saved = await mutateArchive(path, records);
    const rows = saved.map(toPlainRecord);
    emit(
      output,
      rows,
      `Added ${rows.length} evidence item(s). Transcript candidates need human review.`,
      json,
    );
    return 0;
  }

  if (action === "create") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const segmentId = requiredOption(args, "source-segment").toLowerCase();
    const type = validateEvidenceText(requiredOption(args, "type"), "Evidence type", 128);
    const title = validateEvidenceText(requiredOption(args, "title"), "Evidence title", 512);
    const content = validateEvidenceText(
      requiredOption(args, "content"),
      "Evidence content",
      16 * 1024 * 1024,
    );
    if (type.length === 0 || title.length === 0 || content.length === 0) {
      throw new CliError("Evidence needs a type, title, and content.");
    }
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord;
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const segment = await requireLiveRecord(snapshot, RecordType.transcriptSegment, segmentId);
      if (field(segment, "session_id") !== sessionId) {
        throw new CliError("Choose a transcript segment from the selected session.");
      }
      const priority = args.options.get("priority") ?? "normal";
      if (!"low normal high critical".split(" ").includes(priority)) {
        throw new CliError("Priority must be low, normal, high, or critical.");
      }
      const createdAt = timestampNow();
      record = {
        type: RecordType.evidenceNode,
        id: randomUUID(),
        revision: 0n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map([
          ["session_id", sessionId],
          ["student_id", field(session, "student_id")],
          ["type", type.trim().toLowerCase()],
          ["title", title],
          ["content", content],
          ["priority", priority],
          ["origin", "tutor-authored"],
          ["source_annotation_id", ""],
          ["source_segment_ids", segment.id],
          ["source_segment_revision", segment.revision.toString()],
          ["source_segment_revisions", `${segment.id}=${segment.revision}`],
          ["source_asset_ids", ""],
          ["source_speaker_label", field(segment, "speaker_label")],
          ["start_time_us", field(segment, "start_time_us") || "0"],
          ["end_time_us", field(segment, "end_time_us") || "0"],
          ["verification_state", "needs-review"],
          ["created_at_us", createdAt],
        ]),
      };
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [record]);
    emit(output, toPlainRecord(saved ?? record), "Evidence added to review.", json);
    return 0;
  }

  if (action === "list" || action === "review") {
    const sessionId = args.options.get("session")?.toLowerCase();
    const snapshot = await openForCommand(path);
    try {
      let records = await snapshot.listRecords(
        RecordType.evidenceNode,
        args.flags.has("include-deleted"),
      );
      if (sessionId)
        records = records.filter((record) => field(record, "session_id") === sessionId);
      if (action === "review") {
        records = records.filter(
          (record) => field(record, "verification_state") !== "human-verified",
        );
      }
      const rows = records.map(toPlainRecord);
      emit(
        output,
        rows,
        rows.length === 0
          ? action === "review"
            ? "No evidence needs review."
            : "No evidence found."
          : `${rows.length} evidence item${rows.length === 1 ? "" : "s"}.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "edges") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const nodes = await snapshot.listRecords(RecordType.evidenceNode);
      const nodeById = new Map(
        nodes
          .filter((node) => field(node, "session_id") === sessionId)
          .map((node) => [node.id, node]),
      );
      const edges = (await snapshot.listRecords(RecordType.evidenceEdge)).filter(
        (edge) => nodeById.has(field(edge, "from_id")) && nodeById.has(field(edge, "to_id")),
      );
      const rows = edges.map((edge) => {
        const from = nodeById.get(field(edge, "from_id"))!;
        const to = nodeById.get(field(edge, "to_id"))!;
        return {
          ...toPlainRecord(edge),
          from_title: field(from, "title") || field(from, "type") || "Evidence",
          to_title: field(to, "title") || field(to, "type") || "Evidence",
        };
      });
      emit(output, rows, `${rows.length} evidence relationship(s).`, json);
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "link") {
    const snapshot = await openForCommand(path);
    let edge: ArchiveRecord;
    try {
      edge = await makeEvidenceEdge(
        snapshot,
        requiredOption(args, "from"),
        requiredOption(args, "to"),
        requiredOption(args, "relationship"),
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [edge]);
    emit(output, toPlainRecord(saved ?? edge), "Evidence relationship created.", json);
    return 0;
  }

  if (
    action === "show" ||
    action === "update" ||
    action === "approve" ||
    action === "reject" ||
    action === "verify" ||
    action === "delete" ||
    action === "restore"
  ) {
    const id = requiredPosition(args, 0, "Evidence ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let current: ArchiveRecord;
    let changes: ArchiveRecord[] = [];
    try {
      const record = await snapshot.getRecord(RecordType.evidenceNode, id);
      if (!record || (field(record, "_deleted") === "true" && action !== "restore")) {
        throw new CliError(`Evidence ${id} was not found in this archive.`);
      }
      current = record;
      if (action === "show") {
        emit(output, toPlainRecord(current), `Evidence ${id}.`, json);
        return 0;
      }
      if (action === "verify") {
        const valid = await evidenceSourcesAreCurrent(snapshot, current);
        emit(
          output,
          { evidence_id: id, source_valid: valid },
          valid
            ? "Evidence sources are current."
            : "Evidence sources are missing, stale, or cross-session.",
          json,
        );
        return valid ? 0 : 2;
      }
      if (action === "approve" || action === "reject") {
        changes = [
          await reviewEvidenceRecord(
            snapshot,
            current,
            action === "approve" ? "human-verified" : "rejected",
          ),
        ];
      } else if (action === "update") {
        const fields = new Map(current.fields);
        const updates = ["title", "content", "type", "priority"] as const;
        let changed = false;
        for (const key of updates) {
          const value = args.options.get(key);
          if (value === undefined) continue;
          const maximumBytes = key === "content" ? 16 * 1024 * 1024 : key === "title" ? 512 : 128;
          const clean = validateEvidenceText(value, `Evidence ${key}`, maximumBytes);
          if (clean.length === 0) throw new CliError(`Evidence ${key} cannot be empty.`);
          fields.set(key, key === "type" ? clean.trim().toLowerCase() : clean);
          changed = true;
        }
        if (!changed) throw new CliError("Provide a title, content, type, or priority to update.");
        const priority = args.options.get("priority");
        if (priority && !"low normal high critical".split(" ").includes(priority)) {
          throw new CliError("Priority must be low, normal, high, or critical.");
        }
        fields.set("verification_state", "needs-review");
        fields.set("reviewed_at_us", "");
        fields.set("updated_at_us", timestampNow());
        changes = [{ ...current, fields }];
      } else if (action === "delete") {
        const deletedAt = timestampNow();
        const fields = new Map(current.fields);
        fields.set("_deleted", "true");
        fields.set("_trash_group_id", id);
        fields.set("deleted_at_us", deletedAt);
        changes.push({ ...current, fields });
        const edges = await snapshot.listRecords(RecordType.evidenceEdge);
        for (const edge of edges) {
          if (field(edge, "from_id") !== id && field(edge, "to_id") !== id) continue;
          const edgeFields = new Map(edge.fields);
          edgeFields.set("_deleted", "true");
          edgeFields.set("_trash_group_id", id);
          edgeFields.set("deleted_at_us", deletedAt);
          changes.push({ ...edge, fields: edgeFields });
        }
      } else {
        if (field(current, "_deleted") !== "true") throw new CliError("Evidence is not in Trash.");
        const fields = new Map(current.fields);
        fields.delete("_deleted");
        fields.delete("_trash_group_id");
        fields.set("restored_at_us", timestampNow());
        changes.push({ ...current, fields });
        const edges = await snapshot.listRecords(RecordType.evidenceEdge, true);
        for (const edge of edges) {
          if (field(edge, "_deleted") !== "true" || field(edge, "_trash_group_id") !== id) continue;
          const edgeFields = new Map(edge.fields);
          edgeFields.delete("_deleted");
          edgeFields.delete("_trash_group_id");
          edgeFields.set("restored_at_us", timestampNow());
          changes.push({ ...edge, fields: edgeFields });
        }
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = await mutateArchive(path, changes);
    const result = saved.find((record) => record.type === RecordType.evidenceNode) ?? changes[0]!;
    emit(output, toPlainRecord(result), `Evidence ${action} complete.`, json);
    return 0;
  }

  if (action === "unlink") {
    const id = requiredPosition(args, 0, "Evidence relationship ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let edge: ArchiveRecord;
    try {
      const current = await snapshot.getRecord(RecordType.evidenceEdge, id);
      if (!current || field(current, "_deleted") === "true") {
        throw new CliError(`Evidence relationship ${id} was not found.`);
      }
      const fields = new Map(current.fields);
      fields.set("_deleted", "true");
      fields.set("_trash_group_id", id);
      fields.set("deleted_at_us", timestampNow());
      edge = { ...current, fields };
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [edge]);
    emit(output, toPlainRecord(saved ?? edge), "Evidence relationship moved to Trash.", json);
    return 0;
  }

  throw new CliError(`evidence ${action} is not implemented in the TypeScript CLI yet.`);
}

async function runJournalOrganizerCommand(
  kind: "collection" | "tag",
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const action = args.positionals[0];
  const isCollection = kind === "collection";
  const role = isCollection ? "journal-collection" : "journal-tag";
  const label = isCollection ? "Collection" : "Tag";
  const recordId = args.positionals[1];
  const json = args.flags.has("json");

  if (action === "list") {
    const snapshot = await openForCommand(path);
    try {
      const records = (
        await snapshot.listRecords(RecordType.settings, args.flags.has("include-deleted"))
      )
        .filter((record) => field(record, "record_role") === role)
        .sort((left, right) => field(left, "name").localeCompare(field(right, "name")));
      const rows = records.map(toPlainRecord);
      emit(
        output,
        rows,
        rows.length
          ? rows.map((row) => `${row["id"]}  ${row["name"]}`).join("\n")
          : `No ${kind}s in this archive.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "create") {
    const name = requiredOption(args, "name");
    await ensureUniqueJournalName(path, role, name);
    const input: JournalCollectionInput | JournalTagInput = isCollection
      ? {
          name,
          description: args.options.get("description") ?? "",
          color: args.options.get("color") ?? "",
        }
      : { name, color: args.options.get("color") ?? "" };
    const record = isCollection
      ? makeJournalCollectionRecord(input as JournalCollectionInput)
      : makeJournalTagRecord(input as JournalTagInput);
    const [saved] = await mutateArchive(path, [record]);
    const result = saved ?? record;
    emit(
      output,
      toPlainRecord(result),
      `Created ${kind} ${field(result, "name")} (${result.id}).`,
      json,
    );
    return 0;
  }

  if (action === "show") {
    if (!recordId) throw new CliError(`${kind} show requires a ${kind} ID.`);
    const record = await getJournalOrganizerAtPath(path, recordId, role);
    emit(output, toPlainRecord(record), `${field(record, "name")} (${record.id})`, json);
    return 0;
  }

  if (action === "update") {
    if (!recordId) throw new CliError(`${kind} update requires a ${kind} ID.`);
    if (
      !["name", "color", ...(isCollection ? ["description"] : [])].some((key) =>
        args.options.has(key),
      )
    ) {
      throw new CliError("Provide at least one supported field to update.");
    }
    const current = await getJournalOrganizerAtPath(path, recordId, role);
    const name = args.options.get("name") ?? field(current, "name");
    await ensureUniqueJournalName(path, role, name, current.id);
    const input: JournalCollectionInput | JournalTagInput = isCollection
      ? {
          name,
          description: args.options.get("description") ?? field(current, "description"),
          color: args.options.get("color") ?? field(current, "color"),
        }
      : { name, color: args.options.get("color") ?? field(current, "color") };
    const updated = updateJournalOrganizerRecord(current, input);
    const [saved] = await mutateArchive(path, [updated]);
    const result = saved ?? updated;
    emit(
      output,
      toPlainRecord(result),
      `Updated ${kind} ${field(result, "name")} (${result.id}).`,
      json,
    );
    return 0;
  }

  if (action === "delete" || action === "restore") {
    if (!recordId) throw new CliError(`${kind} ${action} requires a ${kind} ID.`);
    const current = await getJournalOrganizerAtPath(path, recordId, role, action === "restore");
    const snapshot = await openForCommand(path);
    let changes: ArchiveRecord[];
    try {
      const settings = await snapshot.listRecords(RecordType.settings, true);
      const entries = settings.filter((record) => field(record, "record_role") === "journal-entry");
      changes =
        action === "delete"
          ? archiveJournalOrganizerRecord(current, entries)
          : restoreJournalOrganizerRecord(current, entries);
    } finally {
      await closeSnapshot(snapshot);
    }
    await mutateArchive(path, changes);
    emit(
      output,
      { status: action === "delete" ? "deleted" : "restored", id: recordId },
      `${label} ${action === "delete" ? "archived and detached from entries" : "restored with its prior entry links"}.`,
      json,
    );
    return 0;
  }

  throw new CliError(`journal ${kind} ${action ?? ""} is not implemented.`);
}

async function getJournalOrganizerAtPath(
  path: string,
  id: string,
  role: "journal-collection" | "journal-tag",
  includeDeleted = false,
): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    const record = await snapshot.getRecord(RecordType.settings, id);
    if (
      !record ||
      field(record, "record_role") !== role ||
      (!includeDeleted && field(record, "_deleted") === "true") ||
      (includeDeleted && field(record, "_deleted") !== "true")
    )
      throw new CliError(`${role === "journal-tag" ? "Tag" : "Collection"} ${id} was not found.`);
    return record;
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function ensureUniqueJournalName(
  path: string,
  role: "journal-collection" | "journal-tag",
  name: string,
  exceptId = "",
): Promise<void> {
  const normalized = name.trim().toLocaleLowerCase();
  if (!normalized) throw new CliError("Journal label name cannot be empty.");
  const snapshot = await openForCommand(path);
  try {
    const records = await snapshot.listRecords(RecordType.settings);
    if (
      records.some(
        (record) =>
          field(record, "record_role") === role &&
          record.id !== exceptId &&
          field(record, "name").trim().toLocaleLowerCase() === normalized,
      )
    )
      throw new CliError(
        `${role === "journal-tag" ? "Tag" : "Collection"} name already exists in this archive.`,
      );
  } finally {
    await closeSnapshot(snapshot);
  }
}

function optionIdList(args: ParsedArguments, name: string): string[] | undefined {
  const value = args.options.get(name);
  if (value === undefined) return undefined;
  if (!value.trim()) return [];
  const ids = value.split(",").map((id) => id.trim().toLowerCase());
  if (ids.some((id) => !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(id))) {
    throw new CliError(`--${name} must contain comma-separated archive IDs.`);
  }
  return [...new Set(ids)];
}

async function validateJournalLinks(
  path: string,
  ids: readonly string[],
  role: "journal-collection" | "journal-tag",
): Promise<void> {
  if (!ids.length) return;
  const snapshot = await openForCommand(path);
  try {
    for (const id of ids) {
      const record = await snapshot.getRecord(RecordType.settings, id);
      if (
        !record ||
        field(record, "record_role") !== role ||
        field(record, "_deleted") === "true"
      ) {
        throw new CliError(`${role === "journal-tag" ? "Tag" : "Collection"} ${id} was not found.`);
      }
    }
  } finally {
    await closeSnapshot(snapshot);
  }
}

/** Match the Solid editor: replace selected live labels while retaining unavailable legacy IDs. */
async function preserveUnavailableJournalLinks(
  path: string,
  requestedIds: readonly string[],
  existingIds: string,
  role: "journal-collection" | "journal-tag",
): Promise<string[]> {
  const snapshot = await openForCommand(path);
  try {
    const liveIds = new Set(
      (await snapshot.listRecords(RecordType.settings, true))
        .filter(
          (record) => field(record, "record_role") === role && field(record, "_deleted") !== "true",
        )
        .map((record) => record.id.toLowerCase()),
    );
    const unavailableIds = existingIds
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id && !liveIds.has(id));
    return [...new Set([...requestedIds, ...unavailableIds])];
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function runTranscriptCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  const sessionId = args.options.get("session") ?? "";

  if (action === "import") {
    if (!sessionId) throw new CliError("--session is required.");
    const inputPath = args.options.get("input") ?? args.positionals[0];
    if (!inputPath) throw new CliError("--input is required.");
    const inputAbsolutePath = resolve(inputPath);
    const metadata = await lstat(inputAbsolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new CliError("Transcript input must be a regular, non-symlink file.");
    if (metadata.size > 256 * 1024 * 1024)
      throw new CliError("Transcript source exceeds the configured 256 MiB limit.");
    const bytes = await readFile(inputAbsolutePath);
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CliError("Transcript source must be valid UTF-8.");
    }
    const format = resolveTranscriptFormat(args.options.get("format") ?? "auto", inputAbsolutePath);
    const cues = parseTranscriptSource(source, format);
    const snapshot = await openForCommand(path);
    let session: ArchiveRecord;
    try {
      session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
    } finally {
      await closeSnapshot(snapshot);
    }
    const changes = makeTranscriptRecords(sessionId, cues, format, basename(inputAbsolutePath));
    if (changes.length > 0) {
      const fields = new Map(session.fields);
      fields.set("processing_state", "review-required");
      fields.set(
        "processing_detail",
        "Imported transcript is provisional and ready for tutor review.",
      );
      fields.set("processing_updated_at_us", timestampNow());
      changes.push({ ...session, fields });
      await mutateArchive(path, changes);
    }
    emit(
      output,
      {
        session_id: sessionId,
        source_format: format,
        imported_segment_count: String(cues.length),
        verification_state: "provisional",
      },
      `Imported ${cues.length} transcript segment(s) from ${format}; all imported text is provisional pending tutor review.`,
      json,
    );
    return 0;
  }

  if (action === "history" || action === "restore") {
    const id = requiredPosition(args, 0, "transcript segment ID");
    const snapshot = await openForCommand(path);
    let snapshotClosed = false;
    try {
      const limit = parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000);
      const history = await snapshot.getRecordHistory(RecordType.transcriptSegment, id, limit);
      if (history.length === 0) throw new CliError(`Transcript segment was not found: ${id}`);
      if (action === "history") {
        const rows = history.map((record, historyIndex) => ({
          history_index: historyIndex,
          ...toFlatTranscriptRecord(record),
        }));
        const summary = history
          .map(
            (record, historyIndex) =>
              `${historyIndex}: revision ${record.revision.toString()}${field(record, "_deleted") === "true" ? " (removed)" : ""}`,
          )
          .join("\n");
        emit(output, rows, summary || "No transcript revisions found.", json);
        return 0;
      }

      const revision = parseBoundedOption(args.options.get("revision"), "revision", -1, 1, 10_000);
      const selected = history[revision];
      if (!selected) throw new CliError(`Transcript history index ${revision} was not found.`);
      const fields = new Map(selected.fields);
      fields.delete("_deleted");
      fields.delete("deleted_at_us");
      fields.set("restored_from_revision", revision.toString());
      fields.set("updated_at_us", timestampNow());
      const restored = { ...selected, fields };
      await closeSnapshot(snapshot);
      snapshotClosed = true;
      const [saved] = await mutateArchive(path, [restored]);
      emit(
        output,
        toFlatTranscriptRecord(saved ?? restored),
        `Transcript revision ${revision} restored as a new revision.`,
        json,
      );
      return 0;
    } finally {
      if (!snapshotClosed) await closeSnapshot(snapshot);
    }
  }

  if (["show", "search", "export"].includes(action)) {
    if (!sessionId) throw new CliError("--session is required.");
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
      records = (await snapshot.listRecords(RecordType.transcriptSegment)).filter(
        (record) => field(record, "session_id") === sessionId,
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const query = args.options.get("query");
    if (action === "search" && !query)
      throw new CliError("--query is required for transcript search.");
    if (query !== undefined)
      records = records.filter((record) => field(record, "text").includes(query));
    records = sortTranscriptRecords(records);
    if (action === "export") {
      const format = args.options.get("format") ?? "text";
      if (format !== "text" && format !== "srt" && format !== "vtt" && format !== "json") {
        throw new CliError("Transcript export format must be text, srt, vtt, or json.");
      }
      const destination = resolve(requiredOption(args, "output"));
      const text = formatTranscriptExport(records, format as TranscriptExportFormat);
      await writeTextAtomically(destination, text);
      emit(
        output,
        { output: destination, format, segment_count: String(records.length) },
        `Exported ${format} transcript to ${destination}.`,
        json,
      );
      return 0;
    }
    if (json) {
      emit(
        output,
        records.map(toFlatTranscriptRecord),
        `${records.length} transcript segment(s).`,
        true,
      );
    } else {
      const lines = records.map(
        (record) => `[${transcriptTimeRange(record)}] ${field(record, "text")}`,
      );
      output.stdout(lines.length ? lines.join("\n") : "No transcript segments found.");
    }
    return 0;
  }

  if (["correct", "timestamp", "verify", "speaker"].includes(action)) {
    const id = requiredPosition(args, 0, "transcript segment ID");
    const current = await getLiveRecordAtPath(path, RecordType.transcriptSegment, id);
    let updated: ArchiveRecord;
    if (action === "correct") {
      const text = args.options.get("text");
      if (text === undefined || text.length === 0) throw new CliError("--text is required.");
      updated = correctTranscriptRecord(current, text);
    } else if (action === "timestamp") {
      const start = args.options.get("start");
      const end = args.options.get("end");
      if (!start || !end) throw new CliError("--start and --end are required.");
      updated = setTranscriptTimestamp(current, start, end);
    } else if (action === "verify") {
      const state = args.options.get("state") ?? "human-verified";
      if (state !== "human-verified" && state !== "provisional" && state !== "needs-review") {
        throw new CliError(
          "Verification state must be human-verified, provisional, or needs-review.",
        );
      }
      updated = setTranscriptVerification(current, state);
    } else {
      const label = args.options.get("name");
      if (args.flags.has("unknown") && label)
        throw new CliError("Use either --unknown or --name, not both.");
      if (args.flags.has("unknown")) {
        updated = setTranscriptSpeaker(current, null);
      } else if (label) {
        updated = setTranscriptSpeaker(current, label);
      } else throw new CliError("Provide --name <label> or --unknown.");
    }
    const [saved] = await mutateArchive(path, [updated]);
    emit(
      output,
      toFlatTranscriptRecord(saved ?? updated),
      `Updated transcript segment ${id}.`,
      json,
    );
    return 0;
  }

  throw new CliError(`transcript ${action} is not implemented in the TypeScript CLI yet.`);
}

async function runAnnotationCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  if (action === "add") {
    const sessionId = requiredOption(args, "session");
    const start = requiredOption(args, "at");
    const content = args.options.get("text");
    if (content === undefined) throw new CliError("--text is required.");
    const snapshot = await openForCommand(path);
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
    } finally {
      await closeSnapshot(snapshot);
    }
    const record = makeAnnotationRecord({
      sessionId,
      start,
      end: args.options.get("end") ?? start,
      type: validateAnnotationType(requiredOption(args, "type")),
      priority: validateAnnotationPriority(args.options.get("priority") ?? "normal"),
      title: args.options.get("title") ?? "",
      content,
    });
    const [saved] = await mutateArchive(path, [record]);
    const savedRecord = saved ?? record;
    emit(
      output,
      toPlainRecord(savedRecord),
      `Added ${field(savedRecord, "type")} annotation (${savedRecord.id}).`,
      json,
    );
    return 0;
  }

  if (action === "list") {
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    try {
      records = await snapshot.listRecords(
        RecordType.annotation,
        args.flags.has("include-deleted"),
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const sessionId = args.options.get("session");
    if (sessionId)
      records = records.filter((record) => field(record, "session_id") === sessionId.toLowerCase());
    records.sort((left, right) => {
      const a = parseIntegerField(field(left, "start_time_us"));
      const b = parseIntegerField(field(right, "start_time_us"));
      return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
    });
    const rows = records.map(toPlainRecord);
    emit(output, rows, `${rows.length} annotation${rows.length === 1 ? "" : "s"}.`, json);
    return 0;
  }

  if (action === "link" || action === "unlink") {
    const id = requiredPosition(args, 0, "annotation ID");
    const targetType = requiredOption(args, "to").toLowerCase();
    const targetId = requiredOption(args, "target-id");
    const targetRecordType =
      targetType === "asset"
        ? RecordType.assetMetadata
        : targetType === "evidence"
          ? RecordType.evidenceNode
          : null;
    if (targetRecordType === null) {
      throw new CliError("Annotations can link to assets or evidence nodes.");
    }
    const current = await getLiveRecordAtPath(path, RecordType.annotation, id);
    const target = await getLiveRecordAtPath(path, targetRecordType, targetId);
    const annotationSession = field(current, "session_id");
    const targetSession = field(target, "session_id");
    if (targetSession && annotationSession !== targetSession) {
      throw new CliError("An annotation cannot link to a record from a different session.");
    }
    const fieldName = targetType === "asset" ? "linked_asset_ids" : "linked_evidence_ids";
    const linked = new Set(
      field(current, fieldName)
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    if (action === "link") linked.add(targetId.toLowerCase());
    else linked.delete(targetId.toLowerCase());
    const fields = new Map(current.fields);
    fields.set(fieldName, [...linked].join(","));
    const updated = { ...current, fields };
    const [saved] = await mutateArchive(path, [updated]);
    emit(
      output,
      toPlainRecord(saved ?? updated),
      action === "link" ? "Annotation link added." : "Annotation link removed.",
      json,
    );
    return 0;
  }

  if (action === "merge") {
    const ids = args.positionals;
    if (ids.length < 2) throw new CliError("Provide at least two annotation IDs to merge.");
    const uniqueIds = new Set(ids.map((value) => value.toLowerCase()));
    if (uniqueIds.size !== ids.length)
      throw new CliError("Each annotation ID may appear only once in a merge.");
    const snapshot = await openForCommand(path);
    let annotations: ArchiveRecord[];
    try {
      annotations = [];
      for (const id of ids) {
        const record = await snapshot.getRecord(RecordType.annotation, id);
        if (!record || field(record, "_deleted") === "true") {
          throw new CliError(`Annotation was not found: ${id}`);
        }
        annotations.push(record);
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const first = annotations[0]!;
    const sessionId = field(first, "session_id");
    const type = field(first, "type");
    const priority = field(first, "priority");
    const contents: string[] = [];
    const titles: string[] = [];
    const mergedLinks = new Map<string, Set<string>>([
      ["linked_asset_ids", new Set()],
      ["linked_evidence_ids", new Set()],
      ["source_segment_ids", new Set()],
    ]);
    let latestEnd = parseIntegerField(field(first, "end_time_us"));
    let previousStart = -1n;
    for (const record of annotations) {
      if (field(record, "session_id") !== sessionId) {
        throw new CliError("All annotations must belong to the same session.");
      }
      if (field(record, "type") !== type || field(record, "priority") !== priority) {
        throw new CliError("Annotations must have the same type and priority to merge.");
      }
      const start = parseIntegerField(field(record, "start_time_us"));
      if (start < previousStart) throw new CliError("Provide annotations in chronological order.");
      previousStart = start;
      latestEnd =
        latestEnd > parseIntegerField(field(record, "end_time_us"))
          ? latestEnd
          : parseIntegerField(field(record, "end_time_us"));
      contents.push(field(record, "content"));
      const title = field(record, "title");
      if (title && !titles.includes(title)) titles.push(title);
      for (const [key, values] of mergedLinks) {
        for (const value of field(record, key)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)) {
          values.add(value);
        }
      }
    }
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    const mergedFields = new Map(first.fields);
    mergedFields.set("content", contents.join(args.options.get("separator") ?? "\n"));
    mergedFields.set("start_time_us", parseIntegerField(field(first, "start_time_us")).toString());
    mergedFields.set("end_time_us", latestEnd.toString());
    mergedFields.set("merged_titles", titles.join("\n"));
    mergedFields.set("source_annotation_ids", ids.map((value) => value.toLowerCase()).join(","));
    for (const [key, values] of mergedLinks) mergedFields.set(key, [...values].join(","));
    mergedFields.set("updated_at_us", timestamp);
    const changes: ArchiveRecord[] = [{ ...first, fields: mergedFields }];
    for (const record of annotations.slice(1)) {
      changes.push(removeAnnotationRecord(record));
    }
    const [saved] = await mutateArchive(path, changes);
    const resultRecord = saved ?? { ...first, fields: mergedFields };
    emit(output, toPlainRecord(resultRecord), `Merged ${annotations.length} annotations.`, json);
    return 0;
  }

  const id = requiredPosition(args, 0, "annotation ID");
  if (action === "history" || action === "restore") {
    const snapshot = await openForCommand(path);
    let snapshotClosed = false;
    try {
      const limit = parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000);
      const history = await snapshot.getRecordHistory(RecordType.annotation, id, limit);
      if (history.length === 0) throw new CliError(`Annotation was not found: ${id}`);
      if (action === "history") {
        const rows = history.map((record, historyIndex) => ({
          history_index: historyIndex,
          ...toPlainRecord(record),
        }));
        const summary = history
          .map(
            (record, historyIndex) =>
              `${historyIndex}: revision ${record.revision.toString()}${field(record, "_deleted") === "true" ? " (removed)" : ""}`,
          )
          .join("\n");
        emit(output, rows, summary || "No annotation revisions found.", json);
        return 0;
      }

      const revision = parseBoundedOption(args.options.get("revision"), "revision", -1, 1, 10_000);
      const selected = history[revision];
      if (!selected) throw new CliError(`Annotation history index ${revision} was not found.`);
      const fields = new Map(selected.fields);
      fields.delete("_deleted");
      fields.delete("deleted_at_us");
      const timestamp = (BigInt(Date.now()) * 1000n).toString();
      fields.set("restored_from_revision", revision.toString());
      fields.set("updated_at_us", timestamp);
      fields.set("human_edited_at_us", timestamp);
      const restored = { ...selected, fields };
      await closeSnapshot(snapshot);
      snapshotClosed = true;
      const [saved] = await mutateArchive(path, [restored]);
      emit(
        output,
        toPlainRecord(saved ?? restored),
        `Annotation revision ${revision} restored (${(saved ?? restored).id}).`,
        json,
      );
      return 0;
    } finally {
      if (!snapshotClosed) await closeSnapshot(snapshot);
    }
  }

  const current = await getLiveRecordAtPath(path, RecordType.annotation, id);
  if (action === "split") {
    const before = args.options.get("before");
    const after = args.options.get("after");
    if (before === undefined || after === undefined) {
      throw new CliError("--before and --after are required.");
    }
    if (!before || !after || before + after !== field(current, "content")) {
      throw new CliError(
        "The before and after text must be non-empty and exactly preserve the original annotation.",
      );
    }
    const originalStart = parseIntegerField(field(current, "start_time_us"));
    const originalEnd = parseIntegerField(field(current, "end_time_us"));
    const requestedTime = args.options.get("at");
    if (!requestedTime && originalStart !== originalEnd) {
      throw new CliError("Splitting a time range requires --at within the annotation.");
    }
    const splitTime = requestedTime ? parseTranscriptTimestamp(requestedTime) : originalStart;
    if (
      splitTime < originalStart ||
      splitTime > originalEnd ||
      (originalStart !== originalEnd && (splitTime === originalStart || splitTime === originalEnd))
    ) {
      throw new CliError("The split time must be inside the annotation range.");
    }
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    const firstFields = new Map(current.fields);
    firstFields.set("content", before);
    firstFields.set("end_time_us", splitTime.toString());
    firstFields.set("updated_at_us", timestamp);
    const first: ArchiveRecord = { ...current, fields: firstFields };
    const duplicate = duplicateAnnotationRecord(current);
    const secondFields = new Map(duplicate.fields);
    secondFields.set("content", after);
    secondFields.set("start_time_us", splitTime.toString());
    secondFields.set("end_time_us", originalEnd.toString());
    secondFields.set("created_at_us", timestamp);
    secondFields.set("updated_at_us", timestamp);
    const second: ArchiveRecord = { ...duplicate, fields: secondFields };
    const saved = await mutateArchive(path, [first, second]);
    const savedFirst = saved[0] ?? first;
    const savedSecond = saved[1] ?? second;
    emit(
      output,
      { first: toPlainRecord(savedFirst), second: toPlainRecord(savedSecond) },
      `Annotation split into ${savedFirst.id} and ${savedSecond.id}.`,
      json,
    );
    return 0;
  }
  if (action === "show") {
    emit(output, toPlainRecord(current), `${field(current, "type")} (${current.id})`, json);
    return 0;
  }
  let updated: ArchiveRecord;
  if (action === "remove") {
    updated = removeAnnotationRecord(current);
  } else if (action === "duplicate") {
    updated = duplicateAnnotationRecord(current);
  } else if (action === "prioritize" || action === "update") {
    const options =
      action === "prioritize"
        ? ["priority"]
        : ["text", "title", "priority", "type", "at", "start", "end"];
    if (!options.some((name) => args.options.has(name))) {
      throw new CliError(`Provide an annotation field to ${action}.`);
    }
    const currentStart = parseIntegerField(field(current, "start_time_us"));
    const currentEnd = parseIntegerField(field(current, "end_time_us"));
    const at = args.options.get("at");
    const input: AnnotationInput = {
      sessionId: args.options.get("session") ?? field(current, "session_id"),
      start: args.options.get("start") ?? at ?? formatTranscriptTimestampUs(currentStart),
      end: args.options.get("end") ?? at ?? formatTranscriptTimestampUs(currentEnd),
      type: validateAnnotationType(args.options.get("type") ?? field(current, "type")),
      priority: validateAnnotationPriority(
        args.options.get("priority") ?? field(current, "priority"),
      ),
      title: args.options.get("title") ?? field(current, "title"),
      content: args.options.get("text") ?? field(current, "content"),
    };
    updated = updateAnnotationRecord(current, input);
  } else {
    throw new CliError(`annotation ${action} is not implemented in the TypeScript CLI yet.`);
  }
  const [saved] = await mutateArchive(path, [updated]);
  emit(
    output,
    toPlainRecord(saved ?? updated),
    `Annotation ${action} completed (${(saved ?? updated).id}).`,
    json,
  );
  return 0;
}

async function runExtendedRecordCommand(
  group: string,
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number | null> {
  const id = args.positionals[0];
  const json = args.flags.has("json");
  const recordType =
    group === "student"
      ? RecordType.student
      : group === "session"
        ? RecordType.session
        : RecordType.settings;

  if (group === "student" && action === "show") {
    const studentId = requiredPosition(args, 0, "student ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let student: ArchiveRecord;
    try {
      student = await requireLiveRecord(snapshot, RecordType.student, studentId);
    } finally {
      await closeSnapshot(snapshot);
    }
    emit(output, studentProfileObject(student), readableStudentRecord(student), json);
    return 0;
  }

  if (group === "session" && action === "show") {
    const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let session: ArchiveRecord;
    try {
      session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
    } finally {
      await closeSnapshot(snapshot);
    }
    const response = {
      ...toPlainRecord(session),
      entry_id: field(session, "entry_id"),
      notes_document_id: field(session, "notes_document_id"),
      session_state: session.fields.get("session_state") ?? "active",
      session_type:
        session.fields.get("session_type") ??
        (field(session, "recording_state") === "not-started" ? "notes-only" : "record-audio"),
      started_at_us:
        session.fields.get("started_at_us") ?? session.fields.get("created_at_us") ?? "0",
      ended_at_us: session.fields.get("ended_at_us") ?? "0",
      reviewed_at_us: session.fields.get("reviewed_at_us") ?? "0",
    };
    emit(output, response, readableSessionRecord(session), json);
    return 0;
  }

  if (group === "session" && action === "verify") {
    const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
    const snapshot = await openForCommand(path);
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const [annotations, transcripts, assets] = await Promise.all([
        snapshot.listRecords(RecordType.annotation),
        snapshot.listRecords(RecordType.transcriptSegment),
        snapshot.listRecords(RecordType.assetMetadata),
      ]);
      const countForSession = (
        records: ArchiveRecord[],
        include: (record: ArchiveRecord) => boolean = () => true,
      ) =>
        records.filter(
          (record) =>
            canonicalizeProgressUuid(field(record, "session_id")) ===
              canonicalizeProgressUuid(session.id) && include(record),
        ).length;
      const summary = {
        session_id: session.id,
        annotations: String(countForSession(annotations)),
        transcript_segments: String(countForSession(transcripts)),
        assets: String(
          countForSession(
            assets,
            (record) =>
              ![
                "audio-track",
                "recording-take",
                "waveform-pyramid",
                "sparse-timestamp-seek-index",
                "asset-blob-manifest",
                "asset-blob-chunk",
              ].includes(field(record, "record_role")),
          ),
        ),
      };
      emit(
        output,
        summary,
        `Session references are internally readable.\n${JSON.stringify(summary, null, 2)}`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (group === "session" && action === "delete") {
    const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let changes: ArchiveRecord[];
    let generation: bigint | undefined;
    let scope: Awaited<ReturnType<typeof planSessionTrash>> | undefined;
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      try {
        scope = await planSessionTrash(snapshot, session);
      } catch (error) {
        throw new CliError(
          error instanceof Error ? error.message : "Unable to review the session deletion scope.",
        );
      }
      generation = snapshot.commit.generation;
      changes = scope.changes;
    } finally {
      await closeSnapshot(snapshot);
    }
    if (!scope || generation === undefined) {
      throw new CliError("Unable to prepare the session deletion scope.");
    }

    const scopeMaterial = scope.scopeRecords
      .map((record) => `${record.type}:${record.id.toLowerCase()}:${record.revision}`)
      .sort()
      .map((part) => `${part}\n`)
      .join("");
    const scopeToken = createHash("sha256").update(scopeMaterial).digest("hex");
    const summary = {
      status: "confirmation-required",
      session_id: sessionId,
      scope_token: scopeToken,
      audio_chunks: String(scope.counts.audioChunks),
      waveform_indices: String(scope.counts.waveformIndices),
      session_notes: String(scope.counts.sessionNotes),
      transcript_segments: String(scope.counts.transcriptSegments),
      annotations: String(scope.counts.annotations),
      guides: String(scope.counts.guides),
      assets: String(scope.counts.assets),
      entries_updated: String(scope.counts.entriesUpdated),
      evidence_nodes: String(scope.counts.evidenceNodes),
      evidence_edges: String(scope.counts.evidenceEdges),
      total_records: String(scope.counts.totalRecords),
    };
    const recordsMoved = scope.counts.totalRecords - scope.counts.entriesUpdated;
    if (args.flags.has("dry-run") || !args.flags.has("confirm-scope")) {
      emit(
        output,
        summary,
        `Deleting this session would affect ${scope.counts.totalRecords} records: move ${recordsMoved} to Trash, including ${scope.counts.audioChunks} audio chunks, ${scope.counts.guides} guides, and ${scope.counts.assets} materials; detach ${scope.counts.entriesUpdated} journal entries. Review the scope, then repeat with --confirm-scope --scope-token ${scopeToken}.`,
        json,
      );
      return 0;
    }
    if (args.options.get("scope-token") !== scopeToken) {
      throw new CliError(
        "Deletion scope confirmation is missing or stale. Review the current scope and confirm it with the returned --scope-token.",
      );
    }
    const audioSnapshot = await openForCommand(path);
    try {
      if (audioSnapshot.commit.generation !== generation) {
        throw new CliError(
          "The archive changed after this operation was reviewed. Review it again before retrying.",
        );
      }
      changes = [
        ...changes,
        ...(await loadSessionAudioTrashChanges(audioSnapshot, sessionId, scope.audioChunkRecords)),
      ];
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        error instanceof Error ? error.message : "Unable to load the reviewed recording chunks.",
      );
    } finally {
      await closeSnapshot(audioSnapshot);
    }
    await mutateArchive(path, changes, generation);
    emit(
      output,
      { ...summary, status: "deleted" },
      "Session and associated records moved to recoverable Trash.",
      json,
    );
    return 0;
  }

  if (group === "session" && action === "restore") {
    const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let changes: ArchiveRecord[];
    let generation: bigint | undefined;
    try {
      const session = await snapshot.getRecord(RecordType.session, sessionId);
      if (!session || field(session, "_deleted") !== "true") {
        throw new CliError(`Session ${sessionId} is not in Trash.`);
      }
      try {
        changes = await planSessionRestore(snapshot, session);
      } catch (error) {
        throw new CliError(
          error instanceof Error ? error.message : "Unable to restore the session group.",
        );
      }
      generation = snapshot.commit.generation;
    } finally {
      await closeSnapshot(snapshot);
    }
    if (generation === undefined) throw new CliError("Unable to prepare the session restore.");
    await mutateArchive(path, changes, generation);
    emit(
      output,
      { status: "restored", session_id: sessionId, restored_records: String(changes.length) },
      `Restored session ${sessionId} and ${Math.max(0, changes.length - 1)} associated records.`,
      json,
    );
    return 0;
  }

  if (group === "student" && (action === "history" || action === "progress")) {
    const studentId = requiredPosition(args, 0, "student ID").toLocaleLowerCase();
    const snapshot = await openForCommand(path);
    try {
      const student = await requireLiveRecord(snapshot, RecordType.student, studentId);
      const sessions = (await snapshot.listRecords(RecordType.session)).filter(
        (session) =>
          canonicalizeProgressUuid(field(session, "student_id")) ===
          canonicalizeProgressUuid(student.id),
      );
      sessions.sort((left, right) => {
        const a = parseIntegerField(field(right, "started_at_us"));
        const b = parseIntegerField(field(left, "started_at_us"));
        return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
      });

      if (action === "history") {
        const rows = sessions.map(toPlainRecord);
        emit(
          output,
          rows,
          rows.length === 0
            ? `No sessions recorded for ${field(student, "display_name") || "this student"}.`
            : `${rows.length} session${rows.length === 1 ? "" : "s"} in ${field(student, "display_name") || "student"} history.`,
          json,
        );
        return 0;
      }

      const progress = decodeStudentProgress(field(student, "progress_classifications"));
      const evidence = await snapshot.listRecords(RecordType.evidenceNode);
      const classifications = progress.map((item) => {
        let sourceStatus = "valid";
        try {
          validateProgressEvidence(
            student.id,
            item.evidenceSourceIds,
            sessions,
            evidence,
            item.classification,
          );
        } catch {
          sourceStatus = "invalid-or-unavailable";
        }
        return {
          skill: item.skill,
          classification: item.classification,
          evidence_source_ids: item.evidenceSourceIds.join(","),
          reviewed_by: item.reviewedBy,
          reviewed_at_us: item.reviewedAtUs,
          note: item.note,
          claim_label:
            item.classification === "unverified-improvement"
              ? "UNVERIFIED CLAIM: improvement is not established"
              : "Human-reviewed classification",
          human_reviewed: "true",
          source_status: sourceStatus,
        };
      });
      if (json) {
        emit(
          output,
          { student_id: student.id, sessions: sessions.map(toPlainRecord), classifications },
          `${classifications.length} progress classification(s).`,
          true,
        );
      } else {
        const lines = [
          `Progress classifications for ${field(student, "display_name") || "student"}:`,
        ];
        if (classifications.length === 0) {
          lines.push("  No progress classifications have been human-reviewed.");
        }
        for (const item of classifications) {
          lines.push(
            `  ${item.skill} — ${item.classification}${item.classification === "unverified-improvement" ? " [UNVERIFIED CLAIM: improvement is not established]" : ""}${item.source_status === "valid" ? "" : " [SOURCE REFERENCES INVALID OR UNAVAILABLE]"}`,
            `    Evidence: ${item.evidence_source_ids.split(",").join(", ")}`,
            `    Human review: ${item.reviewed_by} at ${item.reviewed_at_us}`,
          );
          if (item.note) lines.push(`    Note: ${item.note}`);
        }
        lines.push("  Sessions:");
        if (sessions.length === 0) lines.push("    No sessions recorded yet.");
        for (const session of sessions) {
          lines.push(
            `    ${session.id}  ${field(session, "subject")} · ${field(session, "title")}`,
          );
        }
        output.stdout(lines.join("\n"));
      }
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (group === "student" && (action === "progress-review" || action === "progress-edit")) {
    const studentId = requiredPosition(args, 0, "student ID").toLocaleLowerCase();
    const skill = requiredOption(args, "skill");
    const classificationValue = requiredOption(args, "classification");
    if (!isStudentProgressClassification(classificationValue)) {
      throw new CliError(
        "Classification must be newly-observed, recurring, partial-improvement, demonstrated-mastery, unverified-improvement, or not-revisited.",
      );
    }
    const rawIds = requiredOption(args, "evidence-ids");
    const evidenceSourceIds = rawIds.split(",").map((id) => id.trim().toLocaleLowerCase());
    if (evidenceSourceIds.some((id) => !id)) {
      throw new CliError("Evidence IDs must be a comma-separated list without empty items.");
    }
    const reviewedBy = requiredOption(args, "reviewed-by");
    const note = args.options.get("note") ?? "";
    const snapshot = await openForCommand(path);
    let updated: ArchiveRecord;
    try {
      const student = await requireLiveRecord(snapshot, RecordType.student, studentId);
      const sessions = await snapshot.listRecords(RecordType.session);
      const evidence = await snapshot.listRecords(RecordType.evidenceNode);
      updated = reviewStudentProgressRecord(
        student,
        { skill, classification: classificationValue, evidenceSourceIds, reviewedBy, note },
        sessions,
        evidence,
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [updated]);
    const savedRecord = saved ?? updated;
    const savedItem = decodeStudentProgress(field(savedRecord, "progress_classifications")).find(
      (item) => normalizeStudentProgressSkill(item.skill) === normalizeStudentProgressSkill(skill),
    );
    if (!savedItem) throw new CliError("The saved progress review could not be read back.");
    emit(
      output,
      {
        skill: savedItem.skill,
        classification: savedItem.classification,
        evidence_source_ids: savedItem.evidenceSourceIds.join(","),
        reviewed_by: savedItem.reviewedBy,
        reviewed_at_us: savedItem.reviewedAtUs,
        note: savedItem.note,
        claim_label:
          savedItem.classification === "unverified-improvement"
            ? "UNVERIFIED CLAIM: improvement is not established"
            : "Human-reviewed classification",
        human_reviewed: "true",
        source_status: "valid",
      },
      `Human-reviewed progress saved for ${savedItem.skill}.`,
      json,
    );
    return 0;
  }

  if ((group === "student" || group === "session" || group === "journal") && action === "show") {
    if (!id) throw new CliError(`${group} show requires a record ID.`);
    const snapshot = await openForCommand(path);
    try {
      const record =
        group === "journal"
          ? await getJournalEntry(snapshot, id)
          : await requireLiveRecord(snapshot, recordType, id);
      emit(
        output,
        toPlainRecord(record),
        `${field(record, "title") || field(record, "display_name")} (${record.id})`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (group === "student" && action === "update") {
    const record = await updateRecord(
      path,
      RecordType.student,
      requiredPosition(args, 0, "student ID"),
      {
        name: "display_name",
        grade: "grade",
        subjects: "subjects",
        objectives: "learning_objectives",
        "learning-objectives": "learning_objectives",
        difficulties: "known_difficulties",
        "demonstrated-improvements": "demonstrated_improvements",
        "tutor-notes": "tutor_notes",
        "preferred-guide-template": "preferred_guide_template",
      },
      args,
    );
    emit(
      output,
      toPlainRecord(record),
      `Updated student ${field(record, "display_name")} (${record.id}).`,
      json,
    );
    return 0;
  }

  if (group === "session" && action === "update") {
    const sessionId = requiredPosition(args, 0, "session ID");
    const metadataOptions = ["title", "subject", "objectives", "learning-objectives", "student-id"];
    const updateNotes = args.options.has("notes");
    if (!updateNotes && !metadataOptions.some((option) => args.options.has(option))) {
      throw new CliError("Provide a session field to update.");
    }
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    let expectedGeneration: bigint;
    try {
      expectedGeneration = snapshot.commit.generation;
      const current = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const studentId = args.options.get("student-id") ?? field(current, "student_id", "anonymous");
      if (args.options.has("student-id") && studentId !== "anonymous") {
        await requireLiveRecord(snapshot, RecordType.student, studentId);
      }
      const notesDocumentId = field(current, "notes_document_id");
      const notesDocument =
        updateNotes && notesDocumentId
          ? ((await snapshot.getRecord(RecordType.settings, notesDocumentId)) ?? null)
          : null;
      records = updateSessionRecords(
        current,
        {
          studentId,
          subject: args.options.get("subject") ?? field(current, "subject"),
          title: args.options.get("title") ?? field(current, "title", "Untitled session"),
          objectives:
            args.options.get("objectives") ??
            args.options.get("learning-objectives") ??
            field(current, "learning_objectives"),
          notes: args.options.get("notes") ?? "",
        },
        notesDocument,
        updateNotes,
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = await mutateArchive(
      path,
      records,
      expectedGeneration,
      "The archive changed while this session edit was being prepared. Retry the update.",
    );
    const record = saved[0] ?? records[0]!;
    emit(
      output,
      toPlainRecord(record),
      `Updated session ${field(record, "title")} (${record.id}).`,
      json,
    );
    return 0;
  }

  if (group === "journal" && action === "update") {
    const current = await getJournalEntryAtPath(
      path,
      requiredPosition(args, 0, "journal entry ID"),
    );
    let collectionIds = optionIdList(args, "collection-ids");
    let tagIds = optionIdList(args, "tag-ids");
    await validateJournalLinks(path, collectionIds ?? [], "journal-collection");
    await validateJournalLinks(path, tagIds ?? [], "journal-tag");
    if (collectionIds !== undefined) {
      collectionIds = await preserveUnavailableJournalLinks(
        path,
        collectionIds,
        field(current, "collection_ids"),
        "journal-collection",
      );
    }
    if (tagIds !== undefined) {
      tagIds = await preserveUnavailableJournalLinks(
        path,
        tagIds,
        field(current, "tag_ids"),
        "journal-tag",
      );
    }
    const hasMetadataChanges =
      args.options.has("title") ||
      args.options.has("date") ||
      collectionIds !== undefined ||
      tagIds !== undefined;
    let record: ArchiveRecord;
    if (hasMetadataChanges) {
      record = updateJournalRecords(
        current,
        {
          title: args.options.get("title") ?? field(current, "title"),
          date: args.options.get("date") ?? field(current, "entry_date"),
          notes: "",
          ...(collectionIds === undefined ? {} : { collectionIds }),
          ...(tagIds === undefined ? {} : { tagIds }),
        },
        null,
        false,
      )[0]!;
    } else {
      const fields = new Map(current.fields);
      if (args.options.has("notes")) fields.set("updated_at_us", timestampNow());
      record = { ...current, fields };
    }
    const changes = [record];
    const notes = args.options.get("notes");
    if (notes !== undefined) {
      const snapshot = await openForCommand(path);
      try {
        const notesId = field(current, "notes_document_id");
        if (notesId) {
          const noteRecord = await snapshot.getRecord(RecordType.settings, notesId);
          if (noteRecord) changes.push(updateJournalNote(noteRecord, notes));
        }
      } finally {
        await closeSnapshot(snapshot);
      }
    }
    if (!hasMetadataChanges && notes === undefined) {
      throw new CliError("Provide at least one supported journal field to update.");
    }
    const saved = await mutateArchive(path, changes);
    const savedRecord = saved.find((item) => item.id === record.id) ?? record;
    emit(
      output,
      toPlainRecord(savedRecord),
      `Updated journal entry ${field(savedRecord, "title")} (${savedRecord.id}).`,
      json,
    );
    return 0;
  }

  if (["student", "session", "journal"].includes(group) && action === "delete") {
    if (!id) throw new CliError(`${group} delete requires a record ID.`);
    const current =
      group === "journal"
        ? await getJournalEntryAtPath(path, id)
        : await getLiveRecordAtPath(path, recordType, id);
    const deleted = updateFields(current, {}, args, {
      _deleted: "true",
      deleted_at_us: timestampNow(),
      updated_at_us: timestampNow(),
    });
    const [saved] = await mutateArchive(path, [deleted]);
    emit(output, toPlainRecord(saved ?? deleted), `Moved ${group} record ${id} to Trash.`, json);
    return 0;
  }

  if (["student", "session", "journal"].includes(group) && action === "restore") {
    if (!id) throw new CliError(`${group} restore requires a record ID.`);
    const current = await getRecordAtPath(path, recordType, id);
    if (field(current, "_deleted") !== "true") throw new CliError(`Record ${id} is not in Trash.`);
    const restored = updateFields(current, {}, args, {
      _deleted: "false",
      restored_at_us: timestampNow(),
      updated_at_us: timestampNow(),
    });
    const [saved] = await mutateArchive(path, [restored]);
    emit(output, toPlainRecord(saved ?? restored), `Restored ${group} record ${id}.`, json);
    return 0;
  }

  if (group === "session" && action === "clone") {
    const sessionId = requiredPosition(args, 0, "session ID");
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    let expectedGeneration: bigint;
    try {
      expectedGeneration = snapshot.commit.generation;
      const current = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const linkedEntryId = field(current, "entry_id");
      const linkedEntry = linkedEntryId ? await getJournalEntry(snapshot, linkedEntryId) : null;
      const settings = await snapshot.listRecords(RecordType.settings);
      const hasJournalRoot = settings.some(
        (record) =>
          field(record, "record_role") === "journal" && field(record, "_deleted") !== "true",
      );
      const input: SessionCloneInput = {
        ...(args.options.has("title") ? { title: args.options.get("title")! } : {}),
        ...(args.options.has("type") ? { sessionType: args.options.get("type")! } : {}),
        ensureJournalRoot: !hasJournalRoot,
      };
      records = cloneSessionRecords(current, linkedEntry, input);
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = await mutateArchive(
      path,
      records,
      expectedGeneration,
      "The archive changed while this session copy was being prepared. Retry the clone.",
    );
    const session = saved[0] ?? records[0]!;
    emit(
      output,
      toPlainRecord(session),
      `Cloned session ${sessionId} as ${field(session, "title")} (${session.id}).`,
      json,
    );
    return 0;
  }

  if (group === "session" && (action === "archive" || action === "unarchive")) {
    const sessionId = requiredPosition(args, 0, "session ID");
    const snapshot = await openForCommand(path);
    let updated: ArchiveRecord;
    let expectedGeneration: bigint;
    try {
      expectedGeneration = snapshot.commit.generation;
      const current = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      updated = setSessionArchiveState(current, action === "archive");
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(
      path,
      [updated],
      expectedGeneration,
      "The archive changed while this session archive state was being updated. Retry the command.",
    );
    const session = saved ?? updated;
    emit(
      output,
      toPlainRecord(session),
      action === "archive"
        ? `Archived session ${sessionId}.`
        : `Returned session ${sessionId} to current sessions.`,
      json,
    );
    return 0;
  }

  if (group === "session" && ["start", "resume", "complete", "review"].includes(action)) {
    const sessionId = requiredPosition(args, 0, "session ID");
    const transition = action as SessionTransitionAction;
    const current = await getLiveRecordAtPath(path, RecordType.session, sessionId);
    const updated = transitionSessionRecord(current, transition);
    const [session] = await mutateArchive(path, [updated]);
    const actionMessage: Record<SessionTransitionAction, string> = {
      start: "started",
      complete: "completed",
      review: "marked reviewed",
      resume: "resumed",
    };
    emit(
      output,
      toPlainRecord(session ?? updated),
      `Session ${sessionId} ${actionMessage[transition]}.`,
      json,
    );
    return 0;
  }

  return null;
}

async function updateRecord(
  path: string,
  type: number,
  id: string,
  allowedOptions: Readonly<Record<string, string>>,
  args: ParsedArguments,
  fixedFields: Readonly<Record<string, string>> = {},
): Promise<ArchiveRecord> {
  const current = await getLiveRecordAtPath(path, type, id);
  const updated = updateFields(current, allowedOptions, args, fixedFields);
  const [saved] = await mutateArchive(path, [updated]);
  return saved ?? updated;
}

function updateFields(
  current: ArchiveRecord,
  allowedOptions: Readonly<Record<string, string>>,
  args: ParsedArguments,
  fixedFields: Readonly<Record<string, string>> = {},
): ArchiveRecord {
  const fields = new Map(current.fields);
  let changed = false;
  for (const [option, fieldName] of Object.entries(allowedOptions)) {
    const value = args.options.get(option);
    if (value === undefined) continue;
    fields.set(fieldName, validateUpdatedField(fieldName, value));
    changed = true;
  }
  for (const [fieldName, value] of Object.entries(fixedFields)) {
    fields.set(fieldName, value);
    changed = true;
  }
  if (!changed) throw new CliError("Provide at least one supported field to update.");
  if (fields.has("updated_at_us") && !Object.hasOwn(fixedFields, "updated_at_us")) {
    fields.set("updated_at_us", timestampNow());
  }
  return { ...current, revision: 0n, previousOffset: 0n, fields };
}

async function getLiveRecordAtPath(path: string, type: number, id: string): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    return await requireLiveRecord(snapshot, type, id);
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function getRecordAtPath(path: string, type: number, id: string): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    const record = await snapshot.getRecord(type, id);
    if (!record) throw new CliError(`Record ${id} was not found in this archive.`);
    return record;
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function requireLiveRecord(
  snapshot: ArchiveSnapshot,
  type: number,
  id: string,
): Promise<ArchiveRecord> {
  const record = await snapshot.getRecord(type, id);
  if (!record || field(record, "_deleted") === "true")
    throw new CliError(`Record ${id} was not found in this archive.`);
  return record;
}

async function getJournalEntry(snapshot: ArchiveSnapshot, id: string): Promise<ArchiveRecord> {
  const record = await requireLiveRecord(snapshot, RecordType.settings, id);
  if (field(record, "record_role") !== "journal-entry")
    throw new CliError(`Journal entry ${id} was not found in this archive.`);
  return record;
}

async function getJournalEntryAtPath(path: string, id: string): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    return await getJournalEntry(snapshot, id);
  } finally {
    await closeSnapshot(snapshot);
  }
}

function updateJournalNote(current: ArchiveRecord, text: string): ArchiveRecord {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in imported note content.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new CliError("Journal notes contain unsupported control characters.");
  }
  if (text.length > 100_000)
    throw new CliError("Journal notes must be 100,000 characters or fewer.");
  const fields = new Map(
    [...current.fields].filter(([key]) => !/^block\.\d+\.(id|kind|text)$/u.test(key)),
  );
  const note = text.trim();
  fields.set("block_count", note ? "1" : "0");
  if (note) {
    fields.set("block.0.id", randomUUID());
    fields.set("block.0.kind", "paragraph");
    fields.set("block.0.text", note);
  }
  fields.set("updated_at_us", timestampNow());
  return { ...current, revision: 0n, previousOffset: 0n, fields };
}

function timestampNow(): string {
  return (BigInt(Date.now()) * 1000n).toString();
}

function validateUpdatedField(fieldName: string, rawValue: string): string {
  const limits: Readonly<Record<string, number>> = {
    display_name: 200,
    grade: 80,
    subjects: 1_000,
    learning_objectives: 4_000,
    tutor_notes: 20_000,
    title: 240,
    subject: 200,
    student_id: 36,
    entry_date: 10,
  };
  const value = rawValue.trim();
  const maximum = limits[fieldName] ?? 100_000;
  if (value.length > maximum)
    throw new CliError(
      `${fieldName.replaceAll("_", " ")} must be ${maximum.toLocaleString()} characters or fewer.`,
    );
  // eslint-disable-next-line no-control-regex -- Prevent control bytes from entering the archive.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new CliError(
      `${fieldName.replaceAll("_", " ")} contains unsupported control characters.`,
    );
  }
  if ((fieldName === "display_name" || fieldName === "title") && !value) {
    throw new CliError(`${fieldName.replaceAll("_", " ")} is required.`);
  }
  if (
    fieldName === "entry_date" &&
    (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
  ) {
    throw new CliError("Choose a valid journal date.");
  }
  return value;
}

function requiredPosition(args: ParsedArguments, index: number, label: string): string {
  const value = args.positionals[index]?.trim();
  if (!value) throw new CliError(`${label} is required.`);
  return value;
}

function validateEvidenceText(value: string, label: string, maximumBytes: number): string {
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new CliError(`${label} must be ${maximumBytes} UTF-8 bytes or fewer.`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x7f ||
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    ) {
      throw new CliError(`${label} contains unsupported control characters.`);
    }
  }
  return value;
}

async function openForCommand(path: string): Promise<ArchiveSnapshot> {
  const source = await NodeFileArchiveSource.open(resolve(path));
  try {
    return await openArchiveSource(source);
  } catch (error) {
    await source.close();
    throw error;
  }
}

async function closeSnapshot(snapshot: ArchiveSnapshot): Promise<void> {
  const source = snapshot.source;
  if (source instanceof NodeFileArchiveSource) await source.close();
}

async function mutateArchive(
  path: string,
  changes: readonly ArchiveRecord[],
  expectedGeneration?: bigint,
  generationConflictMessage = "The archive changed after this operation was reviewed. Review it again before retrying.",
): Promise<ArchiveRecord[]> {
  const archivePath = resolve(path);
  const source = await NodeFileArchiveSource.open(archivePath);
  let next: ArchiveSnapshot;
  try {
    const current = await openArchiveSource(source);
    if (expectedGeneration !== undefined && current.commit.generation !== expectedGeneration) {
      throw new CliError(generationConflictMessage);
    }
    next = await appendRecords(current, changes);
    await writeSourceAtomically(archivePath, next);
    const savedRecords: ArchiveRecord[] = [];
    for (const change of changes) {
      const saved = await next.getRecord(change.type, change.id);
      if (saved) savedRecords.push(saved);
    }
    return savedRecords;
  } finally {
    await source.close();
  }
}

async function writeSourceAtomically(path: string, snapshot: ArchiveSnapshot): Promise<void> {
  const temporary = join(dirname(path), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  try {
    const chunkSize = 1024 * 1024;
    for (let offset = 0n; offset < snapshot.source.size;) {
      const length = Number(
        snapshot.source.size - offset > BigInt(chunkSize)
          ? BigInt(chunkSize)
          : snapshot.source.size - offset,
      );
      const bytes = await snapshot.source.read(offset, length);
      let written = 0;
      while (written < bytes.length) {
        const result = await output.write(bytes, written, bytes.length - written);
        if (result.bytesWritten === 0) throw new Error("Archive output stopped accepting bytes.");
        written += result.bytesWritten;
      }
      offset += BigInt(length);
    }
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await output.close();
  await replaceFile(temporary, path);
}

async function writeSourceToNewFileAtomically(
  path: string,
  snapshot: ArchiveSnapshot,
  validateBeforePublish?: () => Promise<void>,
): Promise<void> {
  const destination = resolve(path);
  try {
    await stat(destination);
    throw new CliError(`Repair output already exists: ${destination}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isNotFound(error)) throw error;
  }

  const temporary = join(dirname(destination), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  let closed = false;
  try {
    const chunkSize = 1024 * 1024;
    for (let offset = 0n; offset < snapshot.source.size;) {
      const length = Number(
        snapshot.source.size - offset > BigInt(chunkSize)
          ? BigInt(chunkSize)
          : snapshot.source.size - offset,
      );
      const bytes = await snapshot.source.read(offset, length);
      if (bytes.byteLength !== length) {
        throw new CliError("The repaired archive source returned an incomplete read.");
      }
      let written = 0;
      while (written < bytes.length) {
        const result = await output.write(bytes, written, bytes.length - written);
        if (result.bytesWritten === 0) throw new Error("Archive output stopped accepting bytes.");
        written += result.bytesWritten;
      }
      offset += BigInt(length);
    }
    await output.sync();
    await output.close();
    closed = true;
    await validateBeforePublish?.();
    if (process.platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$source = [Environment]::GetEnvironmentVariable('TUTORUX_REPAIR_TEMP')",
        "$target = [Environment]::GetEnvironmentVariable('TUTORUX_REPAIR_DESTINATION')",
        "[System.IO.File]::Move($source, $target)",
      ].join("\n");
      const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
          {
            windowsHide: true,
            env: {
              ...process.env,
              TUTORUX_REPAIR_TEMP: temporary,
              TUTORUX_REPAIR_DESTINATION: destination,
            },
          },
          (error) => (error ? rejectPromise(error) : resolvePromise()),
        );
      });
    } else {
      await link(temporary, destination);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (!closed) await output.close();
    await rm(temporary, { force: true });
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new CliError(`Repair output already exists: ${destination}`);
    }
    try {
      await stat(destination);
      throw new CliError(`Repair output already exists: ${destination}`);
    } catch (destinationError) {
      if (destinationError instanceof CliError) throw destinationError;
      if (!isNotFound(destinationError)) throw destinationError;
    }
    throw error;
  }
  if (process.platform !== "win32") {
    try {
      const directory = await open(dirname(destination), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown filesystem error";
      throw new CliError(
        `Repair copy exists at ${destination}, but its directory could not be durably flushed: ${detail}`,
      );
    }
  }
}

async function writeBytesAtomically(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await stat(path);
    throw new CliError(`Refusing to overwrite the existing file: ${path}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isNotFound(error)) throw error;
  }
  const temporary = join(dirname(path), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  try {
    await output.writeFile(bytes);
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await output.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeTextAtomically(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  try {
    await output.writeFile(text, { encoding: "utf8" });
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await output.close();
  await replaceFile(temporary, path);
}

async function replaceFile(temporary: string, target: string): Promise<void> {
  const backup = `${target}.${randomUUID()}.backup`;
  let hadTarget = false;
  try {
    await stat(target);
    hadTarget = true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    if (hadTarget) await rename(target, backup);
    await rename(temporary, target);
    if (hadTarget) await rm(backup, { force: true });
  } catch (error) {
    if (hadTarget) await rename(backup, target).catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function requiredOption(args: ParsedArguments, name: string): string {
  const value = args.options.get(name)?.trim();
  if (!value) throw new CliError(`--${name} is required.`);
  return value;
}

function field(record: ArchiveRecord, name: string, fallback = ""): string {
  return record.fields.get(name) ?? fallback;
}

function studentProfileObject(record: ArchiveRecord): Record<string, unknown> {
  const fields = Object.fromEntries(record.fields);
  delete fields["progress_classifications"];
  return {
    id: record.id.toLowerCase(),
    type: "student",
    revision: record.revision.toString(),
    ...fields,
  };
}

function readableStudentRecord(record: ArchiveRecord): string {
  return [
    `student ${record.id} (revision ${record.revision})`,
    ...[...record.fields]
      .filter(([key]) => key !== "progress_classifications")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `  ${key}: ${value}`),
  ].join("\n");
}

function readableSessionRecord(record: ArchiveRecord): string {
  return [
    `session ${record.id} (revision ${record.revision})`,
    ...[...record.fields]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `  ${key}: ${value}`),
  ].join("\n");
}

function parseIntegerField(value: string): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

function parseSessionDateBound(
  value: string | undefined,
  inclusiveEnd: boolean,
): bigint | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new CliError("Use a valid calendar date in YYYY-MM-DD format.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]!) {
    throw new CliError("Use a valid calendar date in YYYY-MM-DD format.");
  }
  const start = new Date(0);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCFullYear(year, month - 1, day);
  if (!inclusiveEnd) return BigInt(start.getTime()) * 1000n;
  start.setUTCDate(start.getUTCDate() + 1);
  return BigInt(start.getTime()) * 1000n - 1n;
}

function sessionStartedAt(record: ArchiveRecord): bigint {
  const startedAt = field(record, "started_at_us");
  if (/^-?\d+$/u.test(startedAt)) return BigInt(startedAt);
  return parseIntegerField(field(record, "created_at_us"));
}

function parseBoundedOption(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined && fallback >= minimum) return fallback;
  if (!raw || !/^\d+$/u.test(raw)) {
    throw new CliError(`--${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CliError(`--${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function toPlainRecord(record: ArchiveRecord): Record<string, unknown> {
  return {
    type: record.type,
    id: record.id,
    revision: record.revision.toString(),
    fields: Object.fromEntries(record.fields),
  };
}

function toFlatTranscriptRecord(record: ArchiveRecord): Record<string, string> {
  return {
    id: record.id,
    type: "transcript",
    revision: record.revision.toString(),
    ...Object.fromEntries(record.fields),
  };
}

function transcriptTimeRange(record: ArchiveRecord): string {
  if (field(record, "timestamp_state") === "not-timestamped") return "time not provided";
  const parse = (name: string): bigint => {
    const raw = field(record, name);
    return /^-?\d+$/u.test(raw) ? BigInt(raw) : 0n;
  };
  const start = parse("start_time_us");
  const end = parse("end_time_us");
  const format = (value: bigint): string => {
    const seconds = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
    const hours = seconds / 3600n;
    const minutes = (seconds / 60n) % 60n;
    const remainder = seconds % 60n;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
  };
  return `${format(start)}${end > start ? `–${format(end)}` : ""}`;
}

function emit(output: CliIo, data: unknown, summary: string, json: boolean): void {
  output.stdout(json ? JSON.stringify(data, null, 2) : summary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await executeCli(process.argv.slice(2));
}
