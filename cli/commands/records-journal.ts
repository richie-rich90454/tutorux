import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { updateJournalRecords } from "../../frontend/domain/records";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { preserveUnavailableJournalLinks, validateJournalLinks } from "./journal";
import { CliError, emit, field, optionIdList, requiredPosition, timestampNow } from "./shared";
import { getJournalEntryAtPath, toPlainRecord, updateJournalNote } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runJournalRecordCommand(
  group: string,
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number | null> {
  const json = args.flags.has("json");

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

  return null;
}
