import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
    archiveJournalOrganizerRecord,
    makeJournalCollectionRecord,
    makeJournalTagRecord,
    restoreJournalOrganizerRecord,
    updateJournalOrganizerRecord,
    type JournalCollectionInput,
    type JournalTagInput,
} from "../../frontend/domain/records";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { ensureUniqueJournalName, getJournalOrganizerAtPath } from "./journal-store";
import { CliError, emit, field, requiredOption } from "./shared";
import { toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runJournalOrganizerAction(
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
            const entries = settings.filter(
                (record) => field(record, "record_role") === "journal-entry",
            );
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
