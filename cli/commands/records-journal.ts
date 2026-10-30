import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { notesEditState } from "../../frontend/domain/records";
import {
    restoreJournalEntryGroup,
    trashJournalEntryGroup,
} from "../../frontend/domain/journal-trash";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { preserveUnavailableJournalLinks, validateJournalLinks } from "./journal";
import { CliError, emit, field, optionIdList, requiredPosition, timestampNow } from "./shared";
import {
    getJournalEntry,
    getJournalEntryAtPath,
    toPlainRecord,
    updateJournalNote,
    validateUpdatedField,
} from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runJournalRecordCommand(
    group: string,
    action: string,
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number | null> {
    const json = args.flags.has("json");

    if (group === "journal" && action === "show") {
        const id = requiredPosition(args, 0, "journal entry ID").toLowerCase();
        const snapshot = await openForCommand(path);
        try {
            const entry = await getJournalEntry(snapshot, id);
            const sessions = await snapshot.listRecords(RecordType.session);
            const sessionIds = sessions
                .filter(
                    (session) =>
                        field(session, "_deleted") !== "true" &&
                        field(session, "entry_id").toLowerCase() === entry.id.toLowerCase(),
                )
                .map((session) => session.id.toLowerCase());
            const notesId = field(entry, "notes_document_id");
            let notesText = "";
            if (notesId) {
                const document = await snapshot.getRecord(RecordType.settings, notesId);
                if (
                    !document ||
                    field(document, "record_role") !== "journal-notes" ||
                    field(document, "_deleted") === "true"
                )
                    throw new CliError("The entry's notes document was not found.");
                if (
                    field(document, "entry_id") &&
                    field(document, "entry_id").toLowerCase() !== entry.id.toLowerCase()
                )
                    throw new CliError(
                        "The entry's notes document points to a different journal entry.",
                    );
                const state = notesEditState(document);
                if (!state.editable)
                    throw new CliError("This notes document uses unsupported structured notes.");
                notesText = state.blocks.map((block) => block.text).join("\n");
            }
            const fields = new Map(entry.fields);
            fields.set("session_ids", sessionIds.join(","));
            fields.set("session_count", String(sessionIds.length));
            fields.set("notes_document_id", notesId);
            fields.set("notes_text", notesText);
            const record = { ...entry, fields };
            emit(
                output,
                toPlainRecord(record),
                `${field(record, "title") || "Journal entry"} (${record.id})`,
                json,
            );
            return 0;
        } finally {
            await closeSnapshot(snapshot);
        }
    }

    if (group === "journal" && (action === "delete" || action === "restore")) {
        const id = requiredPosition(args, 0, "journal entry ID").toLowerCase();
        const snapshot = await openForCommand(path);
        let changes: ArchiveRecord[];
        let generation: bigint;
        try {
            generation = snapshot.commit.generation;
            try {
                changes =
                    action === "delete"
                        ? await trashJournalEntryGroup(snapshot, id)
                        : await restoreJournalEntryGroup(snapshot, id);
            } catch (error) {
                throw new CliError(
                    error instanceof Error
                        ? error.message
                        : "Unable to update the journal entry Trash group.",
                );
            }
        } finally {
            await closeSnapshot(snapshot);
        }
        const saved = await mutateArchive(path, changes, generation);
        const record = saved.find((item) => item.id.toLowerCase() === id) ?? changes[0]!;
        emit(
            output,
            toPlainRecord(record),
            action === "delete"
                ? "Journal entry moved to Trash."
                : "Journal entry restored from Trash.",
            json,
        );
        return 0;
    }

    if (group === "journal" && action === "update") {
        const current = await getJournalEntryAtPath(
            path,
            requiredPosition(args, 0, "journal entry ID"),
        );
        if (args.flags.has("clear-date") && args.options.has("date")) {
            throw new CliError("Use either --date or --clear-date, not both.");
        }
        const clearDate = args.flags.has("clear-date");
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
            clearDate ||
            collectionIds !== undefined ||
            tagIds !== undefined;
        let record: ArchiveRecord;
        if (hasMetadataChanges) {
            const fields = new Map(current.fields);
            if (args.options.has("title"))
                fields.set("title", validateUpdatedField("title", args.options.get("title")!));
            if (clearDate) fields.set("entry_date", "");
            else if (args.options.has("date"))
                fields.set(
                    "entry_date",
                    validateUpdatedField("entry_date", args.options.get("date")!),
                );
            if (collectionIds !== undefined) fields.set("collection_ids", collectionIds.join(","));
            if (tagIds !== undefined) fields.set("tag_ids", tagIds.join(","));
            fields.set("updated_at_us", timestampNow());
            record = { ...current, fields };
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
