import { RecordType, type ArchiveRecord } from "../frontend/archive/format";
import { guideDraftFromRecord, makeGuideRecord } from "../frontend/domain/guides";

const field = (record: ArchiveRecord, key: string) => record.fields.get(key) ?? "";
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const ids = (value: string) =>
  value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
const withId = (value: string, id: string, present: boolean) => {
  const list = ids(value).filter((item) => !same(item, id));
  if (present) list.push(id.toLowerCase());
  return list.join(",");
};
function update(record: ArchiveRecord, changes: Record<string, string>): ArchiveRecord {
  const fields = new Map(record.fields);
  for (const [key, value] of Object.entries(changes)) fields.set(key, value);
  fields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
  return { ...record, fields };
}

/** Prepare a session move and validate all affected guide sources against the result. */
export function moveJournalSessionForCli(
  entry: ArchiveRecord,
  session: ArchiveRecord,
  records: readonly ArchiveRecord[],
  guides: readonly ArchiveRecord[],
): ArchiveRecord[] {
  if (
    field(entry, "record_role") !== "journal-entry" ||
    field(entry, "_deleted") === "true" ||
    session.type !== RecordType.session ||
    field(session, "_deleted") === "true"
  )
    throw new Error("Choose an active entry and session.");
  const oldId = field(session, "entry_id");
  const old = records.find(
    (record) =>
      record.type === RecordType.settings &&
      field(record, "record_role") === "journal-entry" &&
      field(record, "_deleted") !== "true" &&
      same(record.id, oldId),
  );
  const relatedGuides = guides.filter(
    (guide) => same(field(guide, "session_id"), session.id) && field(guide, "_deleted") !== "true",
  );
  const noteId = field(session, "notes_document_id");
  const note = records.find(
    (record) =>
      record.type === RecordType.settings &&
      same(record.id, noteId) &&
      field(record, "_deleted") !== "true",
  );
  if (
    noteId &&
    (!note ||
      field(note, "record_role") !== "journal-notes" ||
      !same(field(note, "session_id"), session.id) ||
      !same(field(note, "entry_id"), oldId))
  )
    throw new Error("The session notes cannot be safely moved. Repair their ownership first.");
  const movedIds = new Set(relatedGuides.map((guide) => guide.id.toLowerCase()));
  const changes: ArchiveRecord[] = [];
  if (old && !same(old.id, entry.id))
    changes.push(
      update(old, {
        session_ids: withId(field(old, "session_ids"), session.id, false),
        study_guide_ids: ids(field(old, "study_guide_ids"))
          .filter((id) => !movedIds.has(id.toLowerCase()))
          .join(","),
      }),
    );
  let targetGuides = field(entry, "study_guide_ids");
  for (const guide of relatedGuides) targetGuides = withId(targetGuides, guide.id, true);
  const destination = update(entry, {
    session_ids: withId(field(entry, "session_ids"), session.id, true),
    study_guide_ids: targetGuides,
  });
  const movedSession = update(session, { entry_id: entry.id.toLowerCase() });
  changes.push(destination, movedSession);
  if (note) changes.push(update(note, { entry_id: entry.id.toLowerCase() }));
  changes.push(
    ...relatedGuides.map((guide) => update(guide, { entry_id: entry.id.toLowerCase() })),
  );
  const replacements = new Map(
    changes.map((record) => [`${record.type}:${record.id.toLowerCase()}`, record]),
  );
  const projected = records.map(
    (record) => replacements.get(`${record.type}:${record.id.toLowerCase()}`) ?? record,
  );
  for (const record of changes)
    if (
      !projected.some((existing) => existing.type === record.type && same(existing.id, record.id))
    )
      projected.push(record);
  const remainingEntry =
    old && changes.find((record) => record.type === RecordType.settings && same(record.id, old.id));
  const entryGuides = guides.filter(
    (guide) =>
      field(guide, "_deleted") !== "true" &&
      !field(guide, "session_id") &&
      oldId &&
      same(field(guide, "entry_id"), oldId),
  );
  if (entryGuides.length && !remainingEntry)
    throw new Error(
      "The session's current journal entry is unavailable, so its guides cannot be checked.",
    );
  for (const guide of [...entryGuides, ...relatedGuides]) {
    const isSessionGuide = same(field(guide, "session_id"), session.id);
    try {
      const draft = guideDraftFromRecord(guide);
      makeGuideRecord(
        { ...draft, entryId: isSessionGuide ? destination.id : remainingEntry!.id },
        isSessionGuide
          ? { entry: destination, session: movedSession, records: projected }
          : { entry: remainingEntry!, records: projected },
        guide,
      );
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Cannot move the session because guide “${field(guide, "title") || guide.id}” would have invalid sources or content: ${reason}`,
        { cause },
      );
    }
  }
  return changes;
}
