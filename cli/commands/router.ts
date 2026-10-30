import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { RecordType } from "../../frontend/archive/format";
import { openArchiveSource, type ArchiveSnapshot } from "../../frontend/archive/archive";
import { NodeFileArchiveSource } from "../../frontend/archive/node-source";
import { canonicalizeProgressUuid } from "../../frontend/domain/student-progress";
import {
  makeJournalRecords,
  makeSessionRecords,
  makeStudentRecord,
  type SessionCreateOptions,
} from "../../frontend/domain/records";
import { createSessionPackage, importSessionPackage } from "../../frontend/domain/session-packages";
import { type RecordingControlWorker } from "../recording-control";
import { runAiCommand } from "./ai";
import { runAnnotationCommand } from "./annotations";
import {
  closeSnapshot,
  mutateArchive,
  openForCommand,
  writeSourceAtomically,
  writeSourceToNewFileAtomically,
} from "./archive-io";
import { runAssetCommand } from "./assets";
import { runEvidenceCommand } from "./evidence";
import { runGuideCommand } from "./guides";
import {
  runJournalDocument,
  runJournalOrganizerCommand,
  runJournalSearch,
  validateJournalLinks,
} from "./journal";
import { runModelCommand } from "./model";
import { runRecordingTakeCommand, runSessionAudioRecovery } from "./recording-takes";
import { runExtendedRecordCommand } from "./records";
import { runSettingsCommand } from "./settings";
import {
  CliError,
  emit,
  field,
  isNotFound,
  optionIdList,
  requiredOption,
  requiredPosition,
} from "./shared";
import {
  getJournalEntry,
  parseSessionDateBound,
  requireLiveRecord,
  sessionStartedAt,
  studentProfileObject,
  toPlainRecord,
} from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";
import { runTemplateCommand } from "./templates";
import { runTranscriptCommand } from "./transcripts";

export async function runRecordCommand(
  group: string,
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
  signal?: AbortSignal,
  recordingControl?: RecordingControlWorker,
): Promise<number> {
  if ((group === "session" || group === "record") && action === "recover") {
    return runSessionAudioRecovery(path, args, output);
  }
  if (group === "ai") return runAiCommand(action, path, args, output);
  if (group === "model") return runModelCommand(action, path, args, output);
  if (group === "record")
    return runRecordingTakeCommand(action, path, args, output, signal, recordingControl);
  if (group === "journal" && (action === "collection" || action === "tag")) {
    return runJournalOrganizerCommand(action, path, args, output);
  }
  if (group === "journal" && (action === "search" || action === "list")) {
    return runJournalSearch(path, args, output, action === "search");
  }
  if (group === "journal" && action === "document") return runJournalDocument(path, args, output);
  if (group === "journal" && action === "entry") {
    const entryAction = args.positionals[0];
    if (!entryAction) throw new CliError("Choose a journal entry action.");
    const forwarded = { ...args, positionals: args.positionals.slice(1) };
    if (entryAction === "search" || entryAction === "list") {
      return runJournalSearch(path, forwarded, output, entryAction === "search");
    }
    return runRecordCommand("journal", entryAction, path, forwarded, output);
  }
  if (group === "session" && action === "export") {
    const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
    const destinationPath = resolve(requiredOption(args, "output"));
    if (!destinationPath.toLowerCase().endsWith(".tux")) {
      throw new CliError("Session packages must use the .tux extension.");
    }
    const archivePath = resolve(path);
    const sourceCanonicalPath = await realpath(archivePath);
    let canonicalDestinationPath: string;
    try {
      canonicalDestinationPath = await realpath(destinationPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const destinationParentPath = await realpath(dirname(destinationPath));
      canonicalDestinationPath = resolve(destinationParentPath, basename(destinationPath));
    }
    const samePath =
      process.platform === "win32"
        ? sourceCanonicalPath.toLowerCase() === canonicalDestinationPath.toLowerCase()
        : sourceCanonicalPath === canonicalDestinationPath;
    if (samePath) throw new CliError("Session package output must be a separate file.");

    const snapshot = await openForCommand(archivePath);
    let packageSnapshot: ArchiveSnapshot | undefined;
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      packageSnapshot = await createSessionPackage(snapshot, session.id);
      if (args.flags.has("force")) {
        await writeSourceAtomically(destinationPath, packageSnapshot);
      } else {
        await writeSourceToNewFileAtomically(
          destinationPath,
          packageSnapshot,
          undefined,
          "Session package",
        );
      }
      emit(
        output,
        {
          path: canonicalDestinationPath,
          session_id: session.id,
          bytes: packageSnapshot.source.size.toString(),
          created: true,
        },
        `Exported session package for ${session.id} to ${canonicalDestinationPath}.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      packageSnapshot?.lock();
      await packageSnapshot?.source.close?.();
      await closeSnapshot(snapshot);
    }
  }
  if (group === "session" && action === "import") {
    const positionalPath = args.positionals[0];
    const optionPath = args.options.get("input");
    if (positionalPath && optionPath) {
      throw new CliError("Choose either a package path or --input, not both.");
    }
    const packagePath = positionalPath ?? optionPath;
    if (!packagePath) throw new CliError("session import requires a package path.");
    const canonicalPackagePath = resolve(packagePath);
    if (!canonicalPackagePath.toLowerCase().endsWith(".tux")) {
      throw new CliError("Session packages must use the .tux extension.");
    }
    const packageInfo = await lstat(canonicalPackagePath);
    if (packageInfo.isSymbolicLink() || !packageInfo.isFile()) {
      throw new CliError("The session package must be a regular, non-symlink file.");
    }
    const importState = await (async () => {
      let packageSource: NodeFileArchiveSource | undefined;
      let packageSnapshot: ArchiveSnapshot | undefined;
      let destination: ArchiveSnapshot | undefined;
      try {
        packageSource = await NodeFileArchiveSource.open(canonicalPackagePath);
        destination = await openForCommand(path);
        if (BigInt(packageInfo.size) !== packageSource.size) {
          throw new CliError(
            "The session package changed while import was starting. Retry the command.",
          );
        }
        packageSnapshot = await openArchiveSource(packageSource);
        const expectedGeneration = destination.commit.generation;
        const imported = await importSessionPackage(
          packageSnapshot,
          destination,
          args.options.get("student-id"),
        );
        return {
          importedRecords: imported.records,
          importedSessionId: imported.sessionId,
          expectedGeneration,
        };
      } finally {
        packageSnapshot?.lock();
        await packageSource?.close();
        if (destination) await closeSnapshot(destination);
      }
    })();
    const { importedRecords, importedSessionId, expectedGeneration } = importState;
    const saved = await mutateArchive(
      path,
      importedRecords,
      expectedGeneration,
      "The destination archive changed while the session package was being prepared. Retry the import.",
    );
    const importedSession =
      saved.find(
        (record) => record.type === RecordType.session && record.id === importedSessionId,
      ) ??
      importedRecords.find(
        (record) => record.type === RecordType.session && record.id === importedSessionId,
      );
    if (!importedSession) throw new CliError("The imported package has no session record.");
    emit(
      output,
      {
        session: toPlainRecord(importedSession),
        session_id: importedSessionId,
        imported_records: importedRecords.length,
      },
      `Imported session ${field(importedSession, "title", "Tutoring session")} (${importedSessionId}).`,
      args.flags.has("json"),
    );
    return 0;
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
        ...(args.options.has("type") ? { sessionType: args.options.get("type")! } : {}),
        ...(args.options.has("language")
          ? { transcriptionLanguage: args.options.get("language")! }
          : {}),
        ...(args.options.has("guide-template")
          ? { guideTemplateId: args.options.get("guide-template")! }
          : {}),
        ...(args.options.has("recording-source")
          ? { recordingSource: args.options.get("recording-source")! }
          : {}),
      };
    } finally {
      await closeSnapshot(snapshot);
    }
    const records = makeSessionRecords(
      {
        studentId: args.options.get("student") ?? args.options.get("student-id") ?? "",
        subject: args.options.get("subject") ?? "",
        title: args.options.get("title") ?? "Untitled session",
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
  if (group === "settings") return runSettingsCommand(action, path, args, output);
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
