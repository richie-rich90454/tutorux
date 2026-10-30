import type { ArchiveSnapshot } from "../archive/archive";
import { RecordType, type ArchiveRecord } from "../archive/format";
import { moveRecordToTrash, restoreRecordFromTrash } from "./records";

const field = (record: ArchiveRecord, key: string) => record.fields.get(key) ?? "";
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const splitIds = (value: string) =>
    value
        .split(/[\s,;]+/u)
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean);
const inlineSourcePattern = /\[\[source:([^\]]+)\]\]/giu;

export interface JournalEntryDeleteBlockers {
    sessions: number;
    guides: number;
    attachments: number;
    additionalNotes: number;
}

export function journalEntryDeleteBlockers(
    entry: ArchiveRecord,
    sessions: readonly ArchiveRecord[],
    guides: readonly ArchiveRecord[],
    notesDocuments: readonly ArchiveRecord[],
): JournalEntryDeleteBlockers {
    const entryId = entry.id.toLowerCase();
    const linkedSessions = sessions.filter(
        (session) =>
            session.type === RecordType.session &&
            field(session, "_deleted") !== "true" &&
            same(field(session, "entry_id"), entryId),
    );
    const linkedGuideIds = new Set(splitIds(field(entry, "study_guide_ids")));
    for (const guide of guides) {
        if (
            guide.type === RecordType.guide &&
            field(guide, "_deleted") !== "true" &&
            guideReferencesEntry(guide, entryId)
        ) {
            linkedGuideIds.add(guide.id.toLowerCase());
        }
    }
    const additionalNotes = notesDocuments.filter(
        (document) =>
            document.type === RecordType.settings &&
            field(document, "record_role") === "journal-notes" &&
            field(document, "_deleted") !== "true" &&
            same(field(document, "entry_id"), entryId) &&
            !same(document.id, field(entry, "notes_document_id")),
    );
    return {
        sessions: linkedSessions.length,
        guides: linkedGuideIds.size,
        attachments: splitIds(field(entry, "attachment_ids")).length,
        additionalNotes: additionalNotes.length,
    };
}

export function journalEntryDeleteBlockerMessage(blockers: JournalEntryDeleteBlockers): string {
    const reasons = [
        blockers.sessions ? `${blockers.sessions} linked session${plural(blockers.sessions)}` : "",
        blockers.guides
            ? `${blockers.guides} linked or citing study guide${plural(blockers.guides)}`
            : "",
        blockers.attachments
            ? `${blockers.attachments} linked material${plural(blockers.attachments)}`
            : "",
        blockers.additionalNotes
            ? `${blockers.additionalNotes} additional notes document${plural(blockers.additionalNotes)}`
            : "",
    ].filter(Boolean);
    return reasons.length
        ? `Remove or detach ${joinReasons(reasons)} before moving this entry to Trash.`
        : "This journal entry can be moved to Trash.";
}

/** Recheck all references from the current snapshot, then trash the entry and its notes as one group. */
export async function trashJournalEntryGroup(
    snapshot: ArchiveSnapshot,
    entryId: string,
): Promise<ArchiveRecord[]> {
    const [settings, sessions, guides] = await Promise.all([
        snapshot.listRecords(RecordType.settings, true),
        snapshot.listRecords(RecordType.session, true),
        snapshot.listRecords(RecordType.guide, true),
    ]);
    const entry = settings.find((record) => record.id.toLowerCase() === entryId.toLowerCase());
    if (
        !entry ||
        field(entry, "record_role") !== "journal-entry" ||
        field(entry, "_deleted") === "true"
    ) {
        throw new Error("This journal entry is no longer available.");
    }

    const notesDocuments = settings.filter(
        (record) => field(record, "record_role") === "journal-notes",
    );
    const blockers = journalEntryDeleteBlockers(entry, sessions, guides, notesDocuments);
    const blockerMessage = journalEntryDeleteBlockerMessage(blockers);
    if (hasBlockers(blockers)) throw new Error(blockerMessage);

    const notesDocumentId = field(entry, "notes_document_id");
    const notesDocument = notesDocumentId
        ? settings.find((record) => same(record.id, notesDocumentId))
        : undefined;
    if (notesDocument && field(notesDocument, "record_role") !== "journal-notes") {
        throw new Error("The entry’s linked notes document has an unexpected record type.");
    }
    if (
        notesDocument &&
        field(notesDocument, "entry_id") &&
        !same(field(notesDocument, "entry_id"), entry.id)
    ) {
        throw new Error("The entry’s notes document belongs to a different journal entry.");
    }
    if (
        notesDocument &&
        field(notesDocument, "_deleted") === "true" &&
        !same(field(notesDocument, "_trash_group_id"), entry.id)
    ) {
        throw new Error("The entry’s notes document is already in a different Trash group.");
    }

    const entryTrash = markGroupedTrash(moveRecordToTrash(entry), entry.id);
    const notesTrash =
        notesDocument && field(notesDocument, "_deleted") !== "true"
            ? markGroupedTrash(moveRecordToTrash(notesDocument), entry.id)
            : undefined;
    return notesTrash ? [entryTrash, notesTrash] : [entryTrash];
}

/** Restore a journal entry and only the notes documents placed in its Trash group. */
export async function restoreJournalEntryGroup(
    snapshot: ArchiveSnapshot,
    entryId: string,
): Promise<ArchiveRecord[]> {
    const settings = await snapshot.listRecords(RecordType.settings, true);
    const entry = settings.find((record) => record.id.toLowerCase() === entryId.toLowerCase());
    if (
        !entry ||
        field(entry, "record_role") !== "journal-entry" ||
        field(entry, "_deleted") !== "true"
    ) {
        throw new Error("This journal entry is no longer in Trash.");
    }

    const notesDocumentId = field(entry, "notes_document_id");
    const notesDocuments = settings.filter(
        (record) =>
            field(record, "record_role") === "journal-notes" &&
            field(record, "_deleted") === "true" &&
            same(field(record, "_trash_group_id"), entry.id),
    );
    if (notesDocumentId) {
        const linkedNotes = settings.find((record) => same(record.id, notesDocumentId));
        if (linkedNotes && field(linkedNotes, "record_role") !== "journal-notes") {
            throw new Error("The entry’s linked notes document has an unexpected record type.");
        }
        if (
            linkedNotes &&
            field(linkedNotes, "record_role") === "journal-notes" &&
            field(linkedNotes, "_deleted") !== "true"
        ) {
            throw new Error("The entry’s notes document is not in the same Trash group.");
        }
        if (
            linkedNotes &&
            field(linkedNotes, "record_role") === "journal-notes" &&
            field(linkedNotes, "_deleted") === "true" &&
            !same(field(linkedNotes, "_trash_group_id"), entry.id)
        ) {
            throw new Error("The entry’s notes document is stored in a different Trash group.");
        }
    }
    const changes = [restoreRecordFromTrash(entry), ...notesDocuments.map(restoreRecordFromTrash)];
    return changes;
}

function guideReferencesEntry(guide: ArchiveRecord, entryId: string): boolean {
    if (same(field(guide, "entry_id"), entryId)) return true;
    for (const [key, value] of guide.fields) {
        if (/^section\.\d+\.block\.\d+\.source_ids$/u.test(key)) {
            if (splitIds(value).includes(entryId)) return true;
        } else if (/^section\.\d+\.block\.\d+\.text$/u.test(key)) {
            for (const match of value.matchAll(inlineSourcePattern)) {
                if (match[1]?.trim().toLowerCase() === entryId) return true;
            }
        }
    }
    return false;
}

function markGroupedTrash(record: ArchiveRecord, groupId: string): ArchiveRecord {
    const fields = new Map(record.fields);
    fields.set("_trash_group_id", groupId.toLowerCase());
    return { ...record, fields };
}

function plural(count: number): string {
    return count === 1 ? "" : "s";
}

function hasBlockers(blockers: JournalEntryDeleteBlockers): boolean {
    return Object.values(blockers).some((count) => count > 0);
}

function joinReasons(reasons: string[]): string {
    if (reasons.length < 2) return reasons[0] ?? "linked records";
    if (reasons.length === 2) return `${reasons[0]} and ${reasons[1]}`;
    return `${reasons.slice(0, -1).join(", ")}, and ${reasons.at(-1)}`;
}
