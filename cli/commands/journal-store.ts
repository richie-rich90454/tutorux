import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { closeSnapshot, openForCommand } from "./archive-io";
import { CliError, field } from "./shared";

export async function getJournalOrganizerAtPath(
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
            throw new CliError(
                `${role === "journal-tag" ? "Tag" : "Collection"} ${id} was not found.`,
            );
        return record;
    } finally {
        await closeSnapshot(snapshot);
    }
}

export async function ensureUniqueJournalName(
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

export async function validateJournalLinks(
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
                throw new CliError(
                    `${role === "journal-tag" ? "Tag" : "Collection"} ${id} was not found.`,
                );
            }
        }
    } finally {
        await closeSnapshot(snapshot);
    }
}

/** Match the Solid editor: replace selected live labels while retaining unavailable legacy IDs. */
export async function preserveUnavailableJournalLinks(
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
                    (record) =>
                        field(record, "record_role") === role &&
                        field(record, "_deleted") !== "true",
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
