import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { guideDraftFromRecord } from "../../frontend/domain/guides";
import { canonicalizeProgressUuid } from "../../frontend/domain/student-progress";
import { closeSnapshot, openForCommand } from "./archive-io";
import { CliError, emit, field, parseIntegerField } from "./shared";
import { toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runJournalSearchAction(
  path: string,
  args: ParsedArguments,
  output: CliIo,
  requireQuery = true,
): Promise<number> {
  const query = args.options.get("query");
  if (requireQuery && query === undefined) throw new CliError("--query is required.");
  if (query !== undefined && !query.trim()) throw new CliError("Provide non-empty --query text.");
  const searchMode = query !== undefined;
  const foldedQuery = query?.toLocaleLowerCase() ?? "";
  const filterId = (name: string): string | undefined => {
    const value = args.options.get(name);
    if (!value) return undefined;
    const id = canonicalizeProgressUuid(value);
    if (!id) throw new CliError(`--${name} must be a valid UUID.`);
    return id;
  };
  const collectionId = filterId("collection-id");
  const tagId = filterId("tag-id");
  const from = args.options.get("from");
  const to = args.options.get("to");
  for (const [name, date] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
        !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    ) {
      throw new CliError(`--${name} must be a valid YYYY-MM-DD date.`);
    }
  }
  if (from && to && from > to) throw new CliError("--from must not be later than --to.");
  const hasSessions = args.options.get("has-sessions");
  if (hasSessions !== undefined && hasSessions !== "true" && hasSessions !== "false")
    throw new CliError("--has-sessions must be true or false.");
  const snapshot = await openForCommand(path);
  try {
    const [settings, sessions, transcripts, guides] = await Promise.all([
      snapshot.listRecords(RecordType.settings),
      snapshot.listRecords(RecordType.session),
      snapshot.listRecords(RecordType.transcriptSegment),
      snapshot.listRecords(RecordType.guide),
    ]);
    const entries = settings.filter((record) => field(record, "record_role") === "journal-entry");
    const notes = settings.filter((record) => field(record, "record_role") === "journal-notes");
    const rows: {
      record: ArchiveRecord;
      source?: string;
      excerpt?: string;
      sessionIds: string[];
    }[] = [];
    for (const entry of entries) {
      const id = entry.id.toLowerCase();
      const linkedSessions = sessions.filter(
        (session) => field(session, "entry_id").toLowerCase() === id,
      );
      const sessionIds = linkedSessions.map((session) => session.id.toLowerCase());
      const idSet = new Set(sessionIds);
      const ids = (key: string) =>
        field(entry, key)
          .split(",")
          .map((value) => value.trim().toLowerCase());
      if (
        (collectionId && !ids("collection_ids").includes(collectionId)) ||
        (tagId && !ids("tag_ids").includes(tagId))
      )
        continue;
      const date = field(entry, "entry_date");
      if (
        (from && date < from) ||
        (to && date > to) ||
        (hasSessions === "true" && !sessionIds.length) ||
        (hasSessions === "false" && sessionIds.length)
      )
        continue;
      const candidates: { source: string; text: string }[] = [
        { source: "title", text: field(entry, "title") },
      ];
      for (const note of notes) {
        if (
          field(note, "entry_id").toLowerCase() !== id &&
          !idSet.has(field(note, "session_id").toLowerCase())
        )
          continue;
        for (const [key, text] of note.fields)
          if (/^block\.\d+\.text$/u.test(key)) candidates.push({ source: "notes", text });
      }
      for (const cue of transcripts)
        if (idSet.has(field(cue, "session_id").toLowerCase()))
          candidates.push({ source: "transcript", text: field(cue, "text") });
      for (const guide of guides) {
        if (
          field(guide, "entry_id").toLowerCase() !== id &&
          !idSet.has(field(guide, "session_id").toLowerCase())
        )
          continue;
        const draft = guideDraftFromRecord(guide);
        candidates.push({ source: "guide", text: draft.title });
        for (const section of draft.sections) {
          candidates.push({ source: "guide", text: section.heading });
          for (const block of section.blocks)
            candidates.push({ source: "guide", text: block.text });
        }
      }
      const match = searchMode
        ? candidates.find((candidate) => candidate.text.toLocaleLowerCase().includes(foldedQuery))
        : undefined;
      if (searchMode && !match) continue;
      const excerpt = match
        ? (() => {
            const offset = match.text.toLocaleLowerCase().indexOf(foldedQuery);
            const characters = Array.from(match.text);
            const start = Array.from(match.text.slice(0, offset)).length;
            return characters
              .slice(Math.max(0, start - 48), Math.max(0, start - 48) + 180)
              .join("");
          })()
        : undefined;
      rows.push({
        record: entry,
        ...(match === undefined ? {} : { source: match.source }),
        ...(excerpt === undefined ? {} : { excerpt }),
        sessionIds,
      });
    }
    rows.sort((a, b) => {
      const left = parseIntegerField(field(a.record, "created_at_us"));
      const right = parseIntegerField(field(b.record, "created_at_us"));
      return left === right ? a.record.id.localeCompare(b.record.id) : left > right ? -1 : 1;
    });
    const result = rows.map((row) => ({
      ...toPlainRecord(row.record),
      session_ids: row.sessionIds.join(","),
      session_count: String(row.sessionIds.length),
      ...(row.source === undefined ? {} : { match_source: row.source }),
      ...(row.excerpt === undefined ? {} : { excerpt: row.excerpt }),
    }));
    emit(
      output,
      result,
      rows.length
        ? rows
            .map(
              (row) =>
                `${row.record.id}  ${field(row.record, "title")}  ${field(row.record, "entry_date")}  ${row.sessionIds.length} session(s)${row.source === undefined ? "" : `  [${row.source}] ${row.excerpt ?? ""}`}`,
            )
            .join("\n")
        : searchMode
          ? "No journal entries matched the search."
          : "No journal entries in this archive.",
      args.flags.has("json"),
    );
    return 0;
  } finally {
    await closeSnapshot(snapshot);
  }
}
