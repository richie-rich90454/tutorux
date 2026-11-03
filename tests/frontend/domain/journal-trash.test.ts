import { describe, expect, it } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    journalEntryDeleteBlockerMessage,
    journalEntryDeleteBlockers,
    restoreJournalEntryGroup,
    trashJournalEntryGroup,
} from "../../../frontend/domain/journal-trash";

const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const NOTES_ID = "22222222-2222-4222-8222-222222222222";
const EXTRA_NOTES_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const GUIDE_ID = "55555555-5555-4555-8555-555555555555";

function record(type: number, id: string, fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type,
        id,
        revision: 1n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

function entry(fields: Record<string, string> = {}): ArchiveRecord {
    return record(RecordType.settings, ENTRY_ID, {
        record_role: "journal-entry",
        notes_document_id: NOTES_ID,
        study_guide_ids: "",
        attachment_ids: "",
        ...fields,
    });
}

function notes(id: string, fields: Record<string, string> = {}): ArchiveRecord {
    return record(RecordType.settings, id, {
        record_role: "journal-notes",
        entry_id: ENTRY_ID,
        ...fields,
    });
}

function snapshot(records: ArchiveRecord[]): ArchiveSnapshot {
    return {
        listRecords: async (type: number, includeDeleted = false) =>
            records.filter(
                (item) =>
                    item.type === type &&
                    (includeDeleted || item.fields.get("_deleted") !== "true"),
            ),
    } as unknown as ArchiveSnapshot;
}

describe("journal entry delete blockers", () => {
    it("counts linked sessions, guides, attachments, and extra notes", () => {
        const blockers = journalEntryDeleteBlockers(
            entry({
                study_guide_ids: `${GUIDE_ID}, missing-guide`,
                attachment_ids: "asset-a asset-b,asset-c;asset-d",
            }),
            [
                record(RecordType.session, SESSION_ID, { entry_id: ENTRY_ID.toUpperCase() }),
                record(RecordType.session, SESSION_ID, { entry_id: ENTRY_ID, _deleted: "true" }),
                record(RecordType.session, SESSION_ID, { entry_id: "other" }),
                record(RecordType.student, SESSION_ID, { entry_id: ENTRY_ID }),
            ],
            [
                record(RecordType.guide, GUIDE_ID, {}),
                record(RecordType.guide, GUIDE_ID, { _deleted: "true" }),
                record(RecordType.settings, GUIDE_ID, { entry_id: ENTRY_ID }),
            ],
            [
                notes(NOTES_ID),
                notes(EXTRA_NOTES_ID),
                notes(EXTRA_NOTES_ID, { _deleted: "true" }),
                notes(EXTRA_NOTES_ID, { entry_id: "other" }),
                record(RecordType.session, EXTRA_NOTES_ID, { record_role: "journal-notes" }),
            ],
        );
        expect(blockers).toEqual({
            sessions: 1,
            guides: 2,
            attachments: 4,
            additionalNotes: 1,
        });
    });

    it("recognizes guides citing the entry through source blocks and inline sources", () => {
        const sourceIds = record(RecordType.guide, GUIDE_ID, {
            "section.0.block.0.source_ids": `other ${ENTRY_ID}`,
        });
        const inline = record(RecordType.guide, GUIDE_ID, {
            "section.0.block.0.text": `See [[source: ${ENTRY_ID} ]] for details`,
        });
        expect(journalEntryDeleteBlockers(entry(), [], [sourceIds, inline], []).guides).toBe(1);
    });

    it("recognizes direct guide links and ignores other inline sources", () => {
        const direct = record(RecordType.guide, GUIDE_ID, { entry_id: ENTRY_ID });
        const inlineMiss = record(RecordType.guide, "66666666-6666-4666-8666-666666666666", {
            "section.0.block.0.text": "See [[source:other-entry]] for details",
        });
        expect(journalEntryDeleteBlockers(entry(), [], [direct, inlineMiss], []).guides).toBe(1);
    });

    it("ignores unrelated guide fields", () => {
        const unrelated = record(RecordType.guide, GUIDE_ID, {
            "section.0.block.0.text": "no citation",
            "section.0.block.0.source_ids": "another-id",
            title: "A guide",
        });
        expect(journalEntryDeleteBlockers(entry(), [], [unrelated], []).guides).toBe(0);
    });

    it("reports no blockers for an unlinked entry", () => {
        const blockers = journalEntryDeleteBlockers(entry({ attachment_ids: "" }), [], [], []);
        expect(blockers).toEqual({ sessions: 0, guides: 0, attachments: 0, additionalNotes: 0 });
        expect(journalEntryDeleteBlockerMessage(blockers)).toBe(
            "This journal entry can be moved to Trash.",
        );
    });

    it.each([
        [{ sessions: 1, guides: 0, attachments: 0, additionalNotes: 0 }, "1 linked session"],
        [{ sessions: 2, guides: 0, attachments: 0, additionalNotes: 0 }, "2 linked sessions"],
        [
            { sessions: 0, guides: 1, attachments: 0, additionalNotes: 0 },
            "1 linked or citing study guide",
        ],
        [
            { sessions: 0, guides: 2, attachments: 0, additionalNotes: 0 },
            "2 linked or citing study guides",
        ],
        [{ sessions: 0, guides: 0, attachments: 1, additionalNotes: 0 }, "1 linked material"],
        [{ sessions: 0, guides: 0, attachments: 2, additionalNotes: 0 }, "2 linked materials"],
        [
            { sessions: 0, guides: 0, attachments: 0, additionalNotes: 1 },
            "1 additional notes document",
        ],
        [
            { sessions: 0, guides: 0, attachments: 0, additionalNotes: 2 },
            "2 additional notes documents",
        ],
    ] as const)("describes blockers %j", (blockers, phrase) => {
        expect(journalEntryDeleteBlockerMessage({ ...blockers })).toContain(phrase);
    });

    it("joins two and four blocker reasons", () => {
        expect(
            journalEntryDeleteBlockerMessage({
                sessions: 1,
                guides: 1,
                attachments: 0,
                additionalNotes: 0,
            }),
        ).toBe(
            "Remove or detach 1 linked session and 1 linked or citing study guide before moving this entry to Trash.",
        );
        expect(
            journalEntryDeleteBlockerMessage({
                sessions: 1,
                guides: 1,
                attachments: 1,
                additionalNotes: 1,
            }),
        ).toBe(
            "Remove or detach 1 linked session, 1 linked or citing study guide, 1 linked material, and 1 additional notes document before moving this entry to Trash.",
        );
    });
});

describe("trashing a journal entry group", () => {
    it("moves the entry and its notes into one Trash group", async () => {
        const changes = await trashJournalEntryGroup(
            snapshot([entry(), notes(NOTES_ID)]),
            ENTRY_ID.toUpperCase(),
        );
        expect(changes).toHaveLength(2);
        expect(changes[0]!.fields.get("_deleted")).toBe("true");
        expect(changes[0]!.fields.get("_trash_group_id")).toBe(ENTRY_ID);
        expect(changes[1]!.id).toBe(NOTES_ID);
        expect(changes[1]!.fields.get("_trash_group_id")).toBe(ENTRY_ID);
    });

    it("moves only the entry when no notes document is linked", async () => {
        const changes = await trashJournalEntryGroup(
            snapshot([entry({ notes_document_id: "" })]),
            ENTRY_ID,
        );
        expect(changes).toHaveLength(1);
    });

    it("moves only the entry when notes are already deleted in the same group", async () => {
        const changes = await trashJournalEntryGroup(
            snapshot([entry(), notes(NOTES_ID, { _deleted: "true", _trash_group_id: ENTRY_ID })]),
            ENTRY_ID,
        );
        expect(changes).toHaveLength(1);
    });

    it.each([
        ["missing", undefined],
        ["wrong role", { record_role: "setting" }],
        ["already deleted", { _deleted: "true" }],
    ] as const)("rejects a %s entry", async (_label, override) => {
        const records = override ? [entry(override)] : [];
        await expect(trashJournalEntryGroup(snapshot(records), ENTRY_ID)).rejects.toThrow(
            "This journal entry is no longer available.",
        );
    });

    it("refuses to trash an entry with blockers", async () => {
        await expect(
            trashJournalEntryGroup(
                snapshot([entry(), record(RecordType.session, SESSION_ID, { entry_id: ENTRY_ID })]),
                ENTRY_ID,
            ),
        ).rejects.toThrow("1 linked session");
    });

    it("rejects notes with an unexpected role", async () => {
        await expect(
            trashJournalEntryGroup(
                snapshot([
                    entry(),
                    record(RecordType.settings, NOTES_ID, { record_role: "setting" }),
                ]),
                ENTRY_ID,
            ),
        ).rejects.toThrow("unexpected record type");
    });

    it("rejects notes belonging to another entry", async () => {
        await expect(
            trashJournalEntryGroup(
                snapshot([entry(), notes(NOTES_ID, { entry_id: "other" })]),
                ENTRY_ID,
            ),
        ).rejects.toThrow("belongs to a different journal entry");
    });

    it("rejects notes already in another Trash group", async () => {
        await expect(
            trashJournalEntryGroup(
                snapshot([
                    entry(),
                    notes(NOTES_ID, { _deleted: "true", _trash_group_id: "other" }),
                ]),
                ENTRY_ID,
            ),
        ).rejects.toThrow("already in a different Trash group");
    });
});

describe("restoring a journal entry group", () => {
    it("restores the entry and notes from its group", async () => {
        const changes = await restoreJournalEntryGroup(
            snapshot([
                entry({ _deleted: "true", _trash_group_id: ENTRY_ID }),
                notes(NOTES_ID, { _deleted: "true", _trash_group_id: ENTRY_ID }),
                notes(EXTRA_NOTES_ID, { _deleted: "true", _trash_group_id: ENTRY_ID }),
                notes(EXTRA_NOTES_ID, { _deleted: "true", _trash_group_id: "other" }),
                notes(EXTRA_NOTES_ID),
            ]),
            ENTRY_ID.toUpperCase(),
        );
        expect(changes.map((record) => record.id)).toEqual([ENTRY_ID, NOTES_ID, EXTRA_NOTES_ID]);
        expect(changes.every((record) => !record.fields.has("_deleted"))).toBe(true);
    });

    it("restores only the entry when no notes are linked", async () => {
        const changes = await restoreJournalEntryGroup(
            snapshot([entry({ notes_document_id: "", _deleted: "true" })]),
            ENTRY_ID,
        );
        expect(changes).toHaveLength(1);
    });

    it("skips a missing linked notes record", async () => {
        const changes = await restoreJournalEntryGroup(
            snapshot([entry({ _deleted: "true" })]),
            ENTRY_ID,
        );
        expect(changes).toHaveLength(1);
    });

    it.each([
        ["missing", undefined, "This journal entry is no longer in Trash."],
        [
            "wrong role",
            { record_role: "setting", _deleted: "true" },
            "This journal entry is no longer in Trash.",
        ],
        ["not deleted", {}, "This journal entry is no longer in Trash."],
    ] as const)("rejects a %s entry", async (_label, override, message) => {
        const records = override ? [entry(override)] : [];
        await expect(restoreJournalEntryGroup(snapshot(records), ENTRY_ID)).rejects.toThrow(
            message,
        );
    });

    it("rejects linked notes with an unexpected role", async () => {
        await expect(
            restoreJournalEntryGroup(
                snapshot([
                    entry({ _deleted: "true" }),
                    record(RecordType.settings, NOTES_ID, { record_role: "setting" }),
                ]),
                ENTRY_ID,
            ),
        ).rejects.toThrow("unexpected record type");
    });

    it("rejects linked notes that are still active", async () => {
        await expect(
            restoreJournalEntryGroup(
                snapshot([entry({ _deleted: "true" }), notes(NOTES_ID)]),
                ENTRY_ID,
            ),
        ).rejects.toThrow("not in the same Trash group");
    });

    it("rejects linked notes that are stored in another Trash group", async () => {
        await expect(
            restoreJournalEntryGroup(
                snapshot([
                    entry({ _deleted: "true" }),
                    notes(NOTES_ID, { _deleted: "true", _trash_group_id: "other" }),
                ]),
                ENTRY_ID,
            ),
        ).rejects.toThrow("stored in a different Trash group");
    });
});
