import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    archiveJournalOrganizerRecord,
    cloneSessionRecords,
    makeJournalCollectionRecord,
    makeJournalRecords,
    makeJournalTagRecord,
    makeSessionRecords,
    makeStudentRecord,
    moveRecordToTrash,
    notesEditState,
    readRemovedNoteBlocks,
    restoreJournalOrganizerRecord,
    restoreRecordFromTrash,
    restoreRemovedNoteBlock,
    setSessionArchiveState,
    transitionSessionRecord,
    updateJournalOrganizerRecord,
    updateJournalRecords,
    updateOwnerNotes,
    updateSessionRecords,
    updateStudentRecord,
} from "../../../frontend/domain/records";

type Fields = Record<string, string>;
type FixtureRecord = ArchiveRecord & { fields: Map<string, string> };

function makeRecord(type: number, fields: Fields = {}, id = crypto.randomUUID()): FixtureRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

function clone(record: ArchiveRecord, extra: Fields = {}): FixtureRecord {
    return { ...record, fields: new Map([...record.fields, ...Object.entries(extra)]) };
}

function sessionRecord(fields: Fields = {}): FixtureRecord {
    return makeRecord(RecordType.session, {
        title: "Fractions",
        subject: "Math",
        entry_id: crypto.randomUUID(),
        student_id: "anonymous",
        session_state: "created",
        ...fields,
    });
}

function journalRecord(fields: Fields = {}): FixtureRecord {
    return makeRecord(RecordType.settings, {
        record_role: "journal-entry",
        title: "Reflection",
        entry_date: "2025-04-01",
        ...fields,
    });
}

function notesRecord(
    owner: { entryId: string; sessionId: string },
    blocks: Array<{ id: string; kind: string; text: string }>,
    extra: Fields = {},
): FixtureRecord {
    const fields: Fields = {
        record_role: "journal-notes",
        entry_id: owner.entryId,
        session_id: owner.sessionId,
        block_count: String(blocks.length),
        ...extra,
    };
    blocks.forEach((item, index) => {
        fields[`block.${index}.id`] = item.id;
        fields[`block.${index}.kind`] = item.kind;
        fields[`block.${index}.text`] = item.text;
    });
    return makeRecord(RecordType.settings, fields);
}

// 2025-04-01T00:00:00Z is not used; timestamps only need to be monotonic strings.

describe("record trash transitions", () => {
    it("marks session trash groups and rejects re-trashing", () => {
        const session = sessionRecord();
        const trashed = moveRecordToTrash(session);
        expect(trashed.fields.get("_trash_group_id")).toBe(session.id);
        expect(trashed.fields.get("_deleted")).toBe("true");
        expect(() => moveRecordToTrash(trashed)).toThrow("already in Trash");
        expect(() => restoreRecordFromTrash(session)).toThrow("not in Trash");
    });
});

describe("session lifecycle transitions", () => {
    it("validates the record type and trash state", () => {
        expect(() => transitionSessionRecord(makeRecord(RecordType.student), "start")).toThrow(
            "Only a session",
        );
        expect(() => transitionSessionRecord(sessionRecord({ _deleted: "true" }), "start")).toThrow(
            "Restore this session",
        );
    });

    it("starts sessions with valid, missing, and invalid timestamps", () => {
        const missingState = makeRecord(RecordType.session, {});
        const started = transitionSessionRecord(missingState, "start");
        expect(started.fields.get("session_state")).toBe("active");
        expect(started.fields.get("started_at_us")).toMatch(/^\d+$/u);
        expect(started.fields.get("ended_at_us")).toBe("0");

        const missingStart = transitionSessionRecord(
            sessionRecord({ started_at_us: undefined as never }),
            "start",
        );
        expect(missingStart.fields.get("started_at_us")).toMatch(/^\d+$/u);

        const zeroStart = transitionSessionRecord(sessionRecord({ started_at_us: "0" }), "start");
        expect(zeroStart.fields.get("started_at_us")).not.toBe("0");

        const badStart = transitionSessionRecord(
            sessionRecord({ started_at_us: "not-a-number" }),
            "start",
        );
        expect(badStart.fields.get("started_at_us")).not.toBe("not-a-number");

        const positiveStart = transitionSessionRecord(
            sessionRecord({ started_at_us: "5000", session_state: "in-progress" }),
            "start",
        );
        expect(positiveStart.fields.get("started_at_us")).toBe("5000");

        const created = transitionSessionRecord(sessionRecord(), "start");
        expect(created.fields.get("session_state")).toBe("active");

        expect(() =>
            transitionSessionRecord(sessionRecord({ session_state: "completed" }), "start"),
        ).toThrow("must use resume");
    });

    it("completes, reviews, and resumes only valid states", () => {
        const completed = transitionSessionRecord(
            sessionRecord({ session_state: "active" }),
            "complete",
        );
        expect(completed.fields.get("session_state")).toBe("completed");
        expect(completed.fields.get("last_completed_at_us")).toMatch(/^\d+$/u);

        const inProgress = transitionSessionRecord(
            sessionRecord({ session_state: "in-progress" }),
            "complete",
        );
        expect(inProgress.fields.get("session_state")).toBe("completed");

        expect(() =>
            transitionSessionRecord(sessionRecord({ session_state: "created" }), "complete"),
        ).toThrow("Only an active session");
        expect(() =>
            transitionSessionRecord(
                sessionRecord({ session_state: "active", recording_state: "recording" }),
                "complete",
            ),
        ).toThrow("Stop the active recording");

        const reviewed = transitionSessionRecord(completed, "review");
        expect(reviewed.fields.get("session_state")).toBe("reviewed");
        expect(reviewed.fields.get("reviewed_at_us")).toMatch(/^\d+$/u);
        const reviewedAgain = transitionSessionRecord(reviewed, "review");
        expect(reviewedAgain.fields.get("session_state")).toBe("reviewed");

        expect(() =>
            transitionSessionRecord(sessionRecord({ session_state: "active" }), "review"),
        ).toThrow("Complete the session");

        const resumed = transitionSessionRecord(reviewed, "resume");
        expect(resumed.fields.get("session_state")).toBe("active");
        expect(resumed.fields.get("ended_at_us")).toBe("0");
        const resumedCompleted = transitionSessionRecord(completed, "resume");
        expect(resumedCompleted.fields.get("session_state")).toBe("active");

        expect(() =>
            transitionSessionRecord(sessionRecord({ session_state: "active" }), "resume"),
        ).toThrow("Only a completed or reviewed session");
    });
});

describe("session cloning", () => {
    it("clones a session into a new journal entry without recording payloads", () => {
        const current = sessionRecord({
            title: "Fractions",
            entry_id: "",
            recording_track_ids: "track",
            recording_state: "recording",
            recording_track_count: "1",
            audio_import_state: "imported",
            audio_import_track_id: "track",
            _trash_group_id: "group",
            _trash_session_group_id: "group",
            deleted_at_us: "1",
            last_completed_at_us: "1",
            resumed_at_us: "1",
            restored_at_us: "1",
            future_field: "keep",
        });
        current.blob = new Uint8Array([1, 2, 3]);
        const records = cloneSessionRecords(current, null);
        expect(records).toHaveLength(4);
        const session = records[0]!;
        expect(session.id).not.toBe(current.id);
        expect(session.fields.get("title")).toBe("Fractions (copy)");
        expect(session.fields.get("session_state")).toBe("active");
        expect(session.fields.get("session_type")).toBe("notes-only");
        expect(session.fields.get("recording_source")).toBe("none");
        expect(session.fields.get("recording_state")).toBe("not-started");
        expect(session.fields.get("processing_state")).toBe("not-processed");
        expect(session.fields.get("archived")).toBe("false");
        expect(session.fields.get("recording_track_ids")).toBeUndefined();
        expect(session.fields.get("recording_track_count")).toBeUndefined();
        expect(session.fields.get("audio_import_state")).toBeUndefined();
        expect(session.fields.get("deleted_at_us")).toBeUndefined();
        expect(session.fields.get("future_field")).toBe("keep");
        expect(session.blob).toEqual(new Uint8Array([1, 2, 3]));
        expect(session.blob).not.toBe(current.blob);
        expect(records[1]!.fields.get("record_role")).toBe("journal-entry");

        const withRoot = cloneSessionRecords(current, null, { ensureJournalRoot: true });
        expect(withRoot).toHaveLength(5);
        expect(withRoot[1]!.fields.get("record_role")).toBe("journal");
    });

    it("reuses a linked journal entry and merges its session ids", () => {
        const current = sessionRecord({ entry_id: "" });
        const sessionId = current.id;
        const entry = journalRecord({ session_ids: `old, ${sessionId.toUpperCase()}` });
        current.fields = new Map([...current.fields, ["entry_id", entry.id]]);
        const records = cloneSessionRecords(current, entry, { sessionType: "record-audio" });
        expect(records).toHaveLength(3);
        expect(records[1]!.fields.get("session_ids")).toBe(
            `old,${sessionId.toUpperCase()},${records[0]!.id}`,
        );
        expect(records[0]!.fields.get("session_type")).toBe("record-audio");
    });

    it("applies title overrides and truncates copied titles", () => {
        const current = sessionRecord({ entry_id: crypto.randomUUID() });
        current.fields = new Map([...current.fields, ["entry_id", crypto.randomUUID()]]);
        const entry = journalRecord();
        current.fields.set("entry_id", entry.id);
        const renamed = cloneSessionRecords(current, entry, { title: "New title" });
        expect(renamed[0]!.fields.get("title")).toBe("New title");

        const longTitle = cloneSessionRecords(
            { ...current, fields: new Map([...current.fields, ["title", "a".repeat(400)]]) },
            entry,
        );
        const title = longTitle[0]!.fields.get("title")!;
        expect(new TextEncoder().encode(title).byteLength).toBeLessThanOrEqual(240);
        expect(title.endsWith(" (copy)")).toBe(true);

        expect(() => cloneSessionRecords(current, entry, { title: " " })).toThrow(
            "Session title is required",
        );
        expect(() => cloneSessionRecords(current, entry, { sessionType: "invalid" })).toThrow(
            "Session type must be",
        );
    });

    it("rejects invalid sources and impossible entry links", () => {
        expect(() => cloneSessionRecords(makeRecord(RecordType.student), null)).toThrow(
            "active session",
        );
        const deleted = sessionRecord({ _deleted: "true" });
        expect(() => cloneSessionRecords(deleted, null)).toThrow("active session");

        const linked = sessionRecord();
        expect(() => cloneSessionRecords(linked, null)).toThrow("could not be found");
        expect(() => cloneSessionRecords(linked, journalRecord({ _deleted: "true" }))).toThrow(
            "could not be found",
        );
        expect(() =>
            cloneSessionRecords(linked, makeRecord(RecordType.settings, { record_role: "other" })),
        ).toThrow("could not be found");
        expect(() => cloneSessionRecords(linked, makeRecord(RecordType.session))).toThrow(
            "could not be found",
        );
        expect(() =>
            cloneSessionRecords(
                linked,
                makeRecord(
                    RecordType.settings,
                    { record_role: "journal-entry" },
                    crypto.randomUUID(),
                ),
            ),
        ).toThrow("could not be found");

        const unlinked = sessionRecord({ entry_id: "" });
        unlinked.fields.set("entry_id", "");
        expect(() => cloneSessionRecords(unlinked, journalRecord())).toThrow(
            "no journal entry to link",
        );
    });
});

describe("session archive state", () => {
    it("archives and unarchives active sessions", () => {
        expect(() => setSessionArchiveState(makeRecord(RecordType.student), true)).toThrow(
            "active session",
        );
        expect(() => setSessionArchiveState(sessionRecord({ _deleted: "true" }), true)).toThrow(
            "active session",
        );
        expect(() =>
            setSessionArchiveState(sessionRecord({ recording_state: "recording" }), true),
        ).toThrow("Stop the active recording");
        const archived = setSessionArchiveState(sessionRecord(), true);
        expect(archived.fields.get("archived")).toBe("true");
        const restored = setSessionArchiveState(archived, false);
        expect(restored.fields.get("archived")).toBe("false");
        expect(
            setSessionArchiveState(
                sessionRecord({ recording_state: "recording" }),
                false,
            ).fields.get("archived"),
        ).toBe("false");
    });
});

describe("session creation", () => {
    it("applies recording defaults for each session type", () => {
        const notes = makeSessionRecords({
            studentId: "",
            subject: "Math",
            title: "Notes",
            objectives: "",
            notes: "",
        });
        expect(notes[0]!.fields.get("recording_source")).toBe("none");
        expect(notes[0]!.fields.get("student_id")).toBe("anonymous");
        expect(notes).toHaveLength(5);

        const audio = makeSessionRecords(
            { studentId: "s", subject: "Math", title: "Audio", objectives: "", notes: "" },
            { sessionType: "record-audio" },
        );
        expect(audio[0]!.fields.get("recording_source")).toBe("microphone");

        const imported = makeSessionRecords(
            { studentId: "s", subject: "Math", title: "Import", objectives: "", notes: "" },
            { sessionType: "import-recording" },
        );
        expect(imported[0]!.fields.get("recording_source")).toBe("imported-file");

        const explicit = makeSessionRecords(
            { studentId: "s", subject: "Math", title: "Explicit", objectives: "", notes: "" },
            { recordingSource: "both", transcriptionLanguage: "zh-Hant" },
        );
        expect(explicit[0]!.fields.get("recording_source")).toBe("both");
        expect(explicit[0]!.fields.get("transcription_language")).toBe("zh-Hant");
    });

    it("validates session type, language, source, template, and entry", () => {
        const input = {
            studentId: "s",
            subject: "Math",
            title: "Session",
            objectives: "",
            notes: "",
        };
        expect(() => makeSessionRecords(input, { sessionType: "bad" })).toThrow(
            "Session type must be",
        );
        expect(() => makeSessionRecords(input, { transcriptionLanguage: "e" })).toThrow(
            "language code",
        );
        expect(() => makeSessionRecords(input, { transcriptionLanguage: "e".repeat(33) })).toThrow(
            "language code",
        );
        expect(() => makeSessionRecords(input, { transcriptionLanguage: "en_US" })).toThrow(
            "language code",
        );
        expect(() => makeSessionRecords(input, { recordingSource: "bad" })).toThrow("Choose none");
        expect(() => makeSessionRecords(input, { guideTemplateId: "a".repeat(129) })).toThrow(
            "too long",
        );
        expect(() => makeSessionRecords(input, { guideTemplateId: "bad\u0001" })).toThrow(
            "control characters",
        );
        expect(() =>
            makeSessionRecords(input, {
                linkedEntry: makeRecord(RecordType.settings, { record_role: "other" }),
            }),
        ).toThrow("active journal entry");
        expect(() =>
            makeSessionRecords(input, { linkedEntry: makeRecord(RecordType.session) }),
        ).toThrow("active journal entry");
        expect(() =>
            makeSessionRecords(input, {
                linkedEntry: journalRecord({ _deleted: "true" }),
            }),
        ).toThrow("active journal entry");
        expect(() => makeSessionRecords({ ...input, title: " " })).toThrow(
            "Session title is required",
        );
    });

    it("links a journal entry and honors the root option", () => {
        const entry = journalRecord({ session_ids: "old" });
        const linked = makeSessionRecords(
            { studentId: "s", subject: "Math", title: "Linked", objectives: "", notes: "" },
            { linkedEntry: entry },
        );
        expect(linked).toHaveLength(3);
        expect(linked[2]!.fields.get("session_ids")).toContain(linked[0]!.id);
        expect(linked[2]!.fields.get("session_ids")).toContain("old");

        const withoutRoot = makeSessionRecords(
            { studentId: "s", subject: "Math", title: "No root", objectives: "", notes: "" },
            { ensureJournalRoot: false },
        );
        expect(withoutRoot).toHaveLength(4);
        expect(withoutRoot.map((record) => record.fields.get("record_role"))).not.toContain(
            "journal",
        );

        const blocks = makeSessionRecords({
            studentId: "s",
            subject: "Math",
            title: "Blocks",
            objectives: "",
            noteBlocks: [{ id: "one", kind: "quote", text: "Quoted" }],
        });
        expect(blocks[1]!.fields.get("block.0.kind")).toBe("quote");
    });
});

describe("journal creation", () => {
    it("validates calendar dates and link ids", () => {
        expect(() => makeJournalRecords({ title: "Bad", date: "2024-2-9", notes: "" })).toThrow(
            "valid journal date",
        );
        expect(() => makeJournalRecords({ title: "Bad", date: "0000-01-01", notes: "" })).toThrow(
            "valid journal date",
        );
        expect(() => makeJournalRecords({ title: "Bad", date: "2025-00-01", notes: "" })).toThrow(
            "valid journal date",
        );
        expect(() => makeJournalRecords({ title: "Bad", date: "2025-13-01", notes: "" })).toThrow(
            "valid journal date",
        );
        expect(() => makeJournalRecords({ title: "Bad", date: "2025-01-00", notes: "" })).toThrow(
            "valid journal date",
        );
        expect(() => makeJournalRecords({ title: "Bad", date: "2025-01-32", notes: "" })).toThrow(
            "valid journal date",
        );
        expect(() => makeJournalRecords({ title: "Bad", date: "2025-02-29", notes: "" })).toThrow(
            "valid journal date",
        );
        expect(() => makeJournalRecords({ title: "Bad", date: "1900-02-29", notes: "" })).toThrow(
            "valid journal date",
        );
        expect(
            makeJournalRecords({ title: "Good", date: "2000-02-29", notes: "" })[0]!.fields.get(
                "entry_date",
            ),
        ).toBe("2000-02-29");
        expect(() =>
            makeJournalRecords({
                title: "Links",
                date: "",
                notes: "",
                tagIds: Array.from({ length: 10_001 }, () => crypto.randomUUID()),
            }),
        ).toThrow("exceed the archive limit");
        expect(() => makeJournalTagRecord({ name: "tag", color: "red" })).toThrow("#RRGGBB");
        expect(() => makeJournalTagRecord({ name: " ", color: "" })).toThrow("Tag name");
    });

    it("normalizes organizer links and honors the root option", () => {
        const id = crypto.randomUUID();
        const entry = makeJournalRecords({
            title: "Entry",
            date: "",
            notes: "",
            collectionIds: [id.toUpperCase(), ` ${id} `],
            tagIds: [id],
        });
        expect(entry[0]!.fields.get("collection_ids")).toBe(id);
        expect(entry[0]!.fields.get("tag_ids")).toBe(id);

        const withoutRoot = makeJournalRecords(
            { title: "Entry", date: "", notes: "" },
            { ensureJournalRoot: false },
        );
        expect(withoutRoot).toHaveLength(2);

        const blocks = makeJournalRecords({
            title: "Entry",
            date: "",
            noteBlocks: [{ id: "one", kind: "heading", text: "Heading" }],
        });
        expect(blocks[1]!.fields.get("block.0.kind")).toBe("heading");
    });
});

describe("journal organizer updates", () => {
    it("updates collection and tag records", () => {
        const collection = makeJournalCollectionRecord({
            name: "Confidence",
            description: "Moments",
            color: "#AABBCC",
        });
        const updatedCollection = updateJournalOrganizerRecord(collection, {
            name: "Confidence 2",
            description: "Updated",
            color: "#001122",
        });
        expect(updatedCollection.fields.get("name")).toBe("Confidence 2");
        expect(updatedCollection.fields.get("description")).toBe("Updated");
        expect(updatedCollection.fields.get("color")).toBe("#001122");

        const tag = makeJournalTagRecord({ name: "fractions", color: "" });
        const updatedTag = updateJournalOrganizerRecord(tag, { name: "ratios", color: "#ABCDEF" });
        expect(updatedTag.fields.get("name")).toBe("ratios");
        expect(updatedTag.fields.get("record_role")).toBe("journal-tag");

        expect(() =>
            updateJournalOrganizerRecord(makeRecord(RecordType.session), {
                name: "x",
                color: "",
            }),
        ).toThrow("Only a journal collection or tag");
        expect(() =>
            updateJournalOrganizerRecord(
                makeRecord(RecordType.settings, { record_role: "other" }),
                {
                    name: "x",
                    color: "",
                },
            ),
        ).toThrow("Only a journal collection or tag");
        expect(() => updateJournalOrganizerRecord(tag, { name: " ", color: "" })).toThrow(
            "Tag name",
        );
        expect(() =>
            updateJournalOrganizerRecord(collection, { name: "x", description: "", color: "bad" }),
        ).toThrow("#RRGGBB");
    });

    it("archives tags and skips entries that do not reference the organizer", () => {
        const tag = makeJournalTagRecord({ name: "fractions", color: "" });
        const linked = journalRecord({ tag_ids: `${tag.id}, other` });
        const unlinked = journalRecord({ tag_ids: "other" });
        const nonEntry = makeRecord(RecordType.session);
        const noIds = journalRecord();
        noIds.fields.delete("tag_ids");
        const trashed = journalRecord({ tag_ids: tag.id, _deleted: "true" });
        const archived = archiveJournalOrganizerRecord(tag, [
            linked,
            unlinked,
            nonEntry,
            noIds,
            trashed,
        ]);
        expect(archived).toHaveLength(2);
        expect(archived[0]!.fields.get("tag_ids")).toBe("other");
        expect(archived[0]!.fields.get("_trash_restore_tag_refs")).toBe(tag.id);
        expect(archived[1]!.fields.get("_deleted")).toBe("true");

        const merges = archiveJournalOrganizerRecord(tag, [
            journalRecord({ tag_ids: tag.id, _trash_restore_tag_refs: "existing" }),
        ]);
        expect(merges[0]!.fields.get("_trash_restore_tag_refs")).toBe(`existing,${tag.id}`);

        for (const invalid of [
            makeRecord(RecordType.session, { record_role: "journal-tag" }),
            makeRecord(RecordType.settings, { record_role: "other" }),
            makeRecord(RecordType.settings, { record_role: "journal-tag", _deleted: "true" }),
        ]) {
            expect(() => archiveJournalOrganizerRecord(invalid, [])).toThrow(
                "Select an active journal collection or tag",
            );
        }
    });

    it("restores tags and keeps or clears remaining restore markers", () => {
        const tag = makeJournalTagRecord({ name: "fractions", color: "" });
        const archivedTag = clone(tag, { _deleted: "true", deleted_at_us: "1" });
        const entry = journalRecord({
            tag_ids: "other",
            _trash_restore_tag_refs: `${tag.id}, more`,
        });
        const restored = restoreJournalOrganizerRecord(archivedTag, [entry]);
        expect(restored[0]!.fields.get("tag_ids")).toBe(`other,${tag.id}`);
        expect(restored[0]!.fields.get("_trash_restore_tag_refs")).toBe("more");
        expect(restored[1]!.fields.has("_deleted")).toBe(false);
        expect(restored[1]!.fields.get("restored_at_us")).toBeTruthy();

        const last = journalRecord({ tag_ids: "", _trash_restore_tag_refs: tag.id });
        const restoredLast = restoreJournalOrganizerRecord(archivedTag, [last]);
        expect(restoredLast[0]!.fields.has("_trash_restore_tag_refs")).toBe(false);

        const skipped = restoreJournalOrganizerRecord(archivedTag, [
            makeRecord(RecordType.session),
            journalRecord(),
        ]);
        expect(skipped).toHaveLength(1);

        for (const invalid of [
            makeRecord(RecordType.session, { record_role: "journal-tag" }),
            makeRecord(RecordType.settings, { record_role: "other" }),
            tag,
        ]) {
            expect(() => restoreJournalOrganizerRecord(invalid, [])).toThrow(
                "Select an archived journal collection or tag",
            );
        }
    });
});

describe("notes decoding", () => {
    it("treats missing and non-notes records as read-only or empty", () => {
        expect(notesEditState(null)).toEqual({ blocks: [], editable: true });
        expect(notesEditState(undefined)).toEqual({ blocks: [], editable: true });
        expect(notesEditState(makeRecord(RecordType.session))).toEqual({
            blocks: [],
            editable: false,
        });
        expect(notesEditState(makeRecord(RecordType.settings, { record_role: "other" }))).toEqual({
            blocks: [],
            editable: false,
        });
        const deleted = notesRecord({ entryId: crypto.randomUUID(), sessionId: "" }, []);
        expect(notesEditState(clone(deleted, { _deleted: "true" })).editable).toBe(false);
        expect(
            notesEditState(notesRecord({ entryId: "A", sessionId: "" }, []), {
                entryId: "B",
                sessionId: "",
            }).editable,
        ).toBe(false);
        expect(
            notesEditState(notesRecord({ entryId: "A", sessionId: "S" }, []), {
                entryId: "A",
                sessionId: "T",
            }).editable,
        ).toBe(false);
    });

    it("rejects oversized payloads, bad counts, and malformed blocks", () => {
        const valid = notesRecord({ entryId: "E", sessionId: "S" }, [
            { id: "one", kind: "paragraph", text: "Text" },
        ]);
        const oversized = {
            ...valid,
            blob: { byteLength: Number.MAX_SAFE_INTEGER } as unknown as Uint8Array,
        };
        expect(notesEditState(oversized).editable).toBe(false);
        expect(notesEditState(clone(valid, { block_count: "x" })).editable).toBe(false);
        expect(notesEditState(clone(valid, { block_count: "99999999999999999999" })).editable).toBe(
            false,
        );
        expect(notesEditState(clone(valid, { block_count: "10001" })).editable).toBe(false);
        expect(notesEditState(notesRecord({ entryId: "E", sessionId: "S" }, []))).toEqual({
            blocks: [],
            editable: true,
        });

        const cases: Fields[] = [
            { "block.0.id": "" },
            {
                "block.0.id": "one",
                "block.1.id": "one",
                block_count: "2",
                "block.1.kind": "paragraph",
                "block.1.text": "",
            },
            { "block.0.id": "\ud800" },
            { "block.0.kind": "future" },
            { "block.0.text": "\udc00" },
            { "block.0.text": "bad\u0000" },
            { "block.0.render_hint": "future" },
        ];
        for (const extra of cases) {
            expect(notesEditState(clone(valid, extra)).editable).toBe(false);
        }
    });
});

describe("removed note blocks", () => {
    it("reads absent, legacy, and current recovery fields", () => {
        expect(readRemovedNoteBlocks(makeRecord(RecordType.session))).toEqual([]);
        const base = notesRecord({ entryId: "E", sessionId: "" }, [
            { id: "one", kind: "paragraph", text: "Text" },
        ]);
        expect(readRemovedNoteBlocks(clone(base, { _deleted: "true" }))).toEqual([]);
        expect(readRemovedNoteBlocks(base)).toEqual([]);

        const current = clone(base, {
            removed_block_count: "1",
            removed_block_0_id: "removed",
            removed_block_0_kind: "quote",
            removed_block_0_text: "Gone",
            removed_block_0_index: "0",
        });
        expect(readRemovedNoteBlocks(current)).toEqual([
            {
                documentId: current.id,
                entryId: "E",
                sessionId: "",
                id: "removed",
                kind: "quote",
                text: "Gone",
                index: 0,
            },
        ]);

        const legacy = clone(base, {
            last_removed_block_id: "legacy",
            last_removed_block_kind: "heading",
            last_removed_block_text: "Old",
            last_removed_block_index: "2",
        });
        expect(readRemovedNoteBlocks(legacy)?.[0]?.id).toBe("legacy");

        const invalidFields: Fields[] = [
            { removed_block_count: "x" },
            { removed_block_count: "257" },
            { removed_block_count: "1" },
            {
                removed_block_count: "1",
                removed_block_0_id: "one",
                removed_block_0_kind: "future",
                removed_block_0_text: "",
                removed_block_0_index: "0",
            },
            {
                removed_block_count: "1",
                removed_block_0_id: "one",
                removed_block_0_kind: "quote",
                removed_block_0_text: "bad\u0000",
                removed_block_0_index: "0",
            },
            {
                removed_block_count: "1",
                removed_block_0_id: "one",
                removed_block_0_kind: "quote",
                removed_block_0_text: "",
                removed_block_0_index: "x",
            },
            {
                removed_block_count: "1",
                removed_block_0_id: "one",
                removed_block_0_kind: "quote",
                removed_block_0_text: "",
                removed_block_0_index: "99999999999999999999",
            },
            { last_removed_block_id: "legacy" },
            {
                last_removed_block_id: "legacy",
                last_removed_block_kind: "quote",
                last_removed_block_text: "bad\u0000",
                last_removed_block_index: "0",
            },
            {
                last_removed_block_id: "legacy",
                last_removed_block_kind: "quote",
                last_removed_block_text: "",
                last_removed_block_index: "99999999999999999999",
            },
        ];
        for (const extra of invalidFields) {
            expect(readRemovedNoteBlocks(clone(base, extra))).toBeNull();
        }
    });

    it("restores removed blocks and rejects invalid restores", () => {
        const document = notesRecord(
            { entryId: "E", sessionId: "" },
            [
                { id: "a", kind: "paragraph", text: "A" },
                { id: "c", kind: "paragraph", text: "C" },
            ],
            {
                removed_block_count: "2",
                removed_block_0_id: "b",
                removed_block_0_kind: "heading",
                removed_block_0_text: "B",
                removed_block_0_index: "1",
                removed_block_1_id: "d",
                removed_block_1_kind: "quote",
                removed_block_1_text: "D",
                removed_block_1_index: "9",
            },
        );
        const restored = restoreRemovedNoteBlock(document, "b");
        expect(notesEditState(restored).blocks.map((block) => block.id)).toEqual(["a", "b", "c"]);
        expect(restored.fields.get("removed_block_count")).toBe("1");
        expect(restored.fields.get("removed_block_0_id")).toBe("d");
        expect(restored.fields.get("removed_block_0_index")).toBe("10");

        const last = restoreRemovedNoteBlock(restored, "d");
        expect(last.fields.get("removed_block_count")).toBe("0");
        expect(last.fields.has("last_removed_block_id")).toBe(false);
        expect(notesEditState(last).blocks.map((block) => block.id)).toEqual(["a", "b", "c", "d"]);

        expect(() => restoreRemovedNoteBlock(makeRecord(RecordType.session), "b")).toThrow(
            "unavailable",
        );
        expect(() => restoreRemovedNoteBlock(clone(document, { _deleted: "true" }), "b")).toThrow(
            "unavailable",
        );
        expect(() => restoreRemovedNoteBlock(clone(document, { block_count: "x" }), "b")).toThrow(
            "recovery data is invalid",
        );
        expect(() =>
            restoreRemovedNoteBlock(
                clone(document, {
                    removed_block_count: "1",
                    removed_block_0_kind: "future",
                }),
                "b",
            ),
        ).toThrow("recovery data is invalid");
        expect(() => restoreRemovedNoteBlock(document, "missing")).toThrow("no longer in Trash");
        expect(() => restoreRemovedNoteBlock(document, "a")).toThrow("no longer in Trash");
        const already = clone(document, {
            removed_block_count: "1",
            removed_block_0_id: "a",
            removed_block_0_kind: "paragraph",
            removed_block_0_text: "A",
            removed_block_0_index: "0",
        });
        expect(() => restoreRemovedNoteBlock(already, "a")).toThrow("already active");
    });
});

describe("notes updates", () => {
    it("records and recovers removed blocks through updates", () => {
        const created = makeJournalRecords({
            title: "Reflection",
            date: "",
            noteBlocks: [
                { id: "a", kind: "paragraph", text: "A" },
                { id: "b", kind: "paragraph", text: "B" },
            ],
        });
        const unchanged = updateJournalRecords(
            created[0]!,
            {
                title: "Reflection",
                date: "",
                noteBlocks: [
                    { id: "a", kind: "paragraph", text: "A" },
                    { id: "b", kind: "paragraph", text: "B" },
                ],
            },
            created[1]!,
            true,
        );
        expect(unchanged[1]!.fields.has("removed_block_count")).toBe(false);

        const removed = updateJournalRecords(
            created[0]!,
            {
                title: "Reflection",
                date: "",
                noteBlocks: [{ id: "a", kind: "paragraph", text: "A" }],
            },
            created[1]!,
            true,
        );
        expect(removed[1]!.fields.get("removed_block_0_id")).toBe("b");

        const deduped = updateJournalRecords(
            created[0]!,
            {
                title: "Reflection",
                date: "",
                noteBlocks: [{ id: "a", kind: "paragraph", text: "A" }],
            },
            removed[1]!,
            true,
        );
        expect(deduped[1]!.fields.get("removed_block_count")).toBe("1");

        const invalid = updateJournalRecords(
            created[0]!,
            {
                title: "Reflection",
                date: "",
                noteBlocks: [{ id: "a", kind: "paragraph", text: "A" }],
            },
            clone(removed[1]!, {
                last_removed_block_id: "legacy",
                last_removed_block_kind: "quote",
                last_removed_block_text: "bad\u0000",
                last_removed_block_index: "0",
            }),
            true,
        );
        expect(invalid[1]!.fields.get("block_count")).toBe("1");
    });

    it("refuses to exceed the recoverable block limit", () => {
        const created = makeJournalRecords({
            title: "Reflection",
            date: "",
            noteBlocks: [
                { id: "a", kind: "paragraph", text: "A" },
                { id: "b", kind: "paragraph", text: "B" },
            ],
        });
        const fields: Fields = { removed_block_count: "256" };
        for (let index = 0; index < 256; index += 1) {
            fields[`removed_block_${index}_id`] = `removed-${index}`;
            fields[`removed_block_${index}_kind`] = "paragraph";
            fields[`removed_block_${index}_text`] = "";
            fields[`removed_block_${index}_index`] = String(index);
        }
        const saturated = clone(created[1]!, fields);
        expect(() =>
            updateJournalRecords(
                created[0]!,
                {
                    title: "Reflection",
                    date: "",
                    noteBlocks: [{ id: "a", kind: "paragraph", text: "A" }],
                },
                saturated,
                true,
            ),
        ).toThrow("Trash can hold 256 removed note blocks");
    });

    it("rejects an invalid recovery payload before writing", () => {
        const created = makeJournalRecords({
            title: "Reflection",
            date: "",
            noteBlocks: [
                { id: "a", kind: "paragraph", text: "A" },
                { id: "b", kind: "paragraph", text: "B" },
            ],
        });
        expect(() =>
            updateJournalRecords(
                created[0]!,
                {
                    title: "Reflection",
                    date: "",
                    noteBlocks: [{ id: "a", kind: "paragraph", text: "A" }],
                },
                clone(created[1]!, {
                    removed_block_count: "1",
                    removed_block_0_id: "bad",
                    removed_block_0_kind: "future",
                }),
                true,
            ),
        ).toThrow("recovery data is invalid");
    });
});

describe("session and journal editing", () => {
    it("updates sessions with and without notes", () => {
        expect(() =>
            updateSessionRecords(
                makeRecord(RecordType.student),
                { studentId: "", subject: "", title: "", objectives: "", notes: "" },
                null,
                false,
            ),
        ).toThrow("Only a session");
        const session = sessionRecord({ notes_document_id: "" });
        const withoutNotes = updateSessionRecords(
            session,
            { studentId: "", subject: "Math", title: "Updated", objectives: "", notes: "" },
            null,
            false,
        );
        expect(withoutNotes).toHaveLength(1);
        expect(withoutNotes[0]!.fields.get("title")).toBe("Updated");

        const created = updateSessionRecords(
            session,
            { studentId: "", subject: "Math", title: "Updated", objectives: "", notes: "Text" },
            null,
            true,
        );
        expect(created).toHaveLength(2);
        expect(created[0]!.fields.get("notes_document_id")).toBe(created[1]!.id);

        const missing = clone(session, { notes_document_id: crypto.randomUUID() });
        expect(() =>
            updateSessionRecords(
                missing,
                { studentId: "", subject: "Math", title: "Updated", objectives: "", notes: "" },
                null,
                true,
            ),
        ).toThrow("linked notes document is missing");
    });

    it("rejects unsafe note structures when replacing plain text", () => {
        const created = makeSessionRecords({
            studentId: "",
            subject: "Math",
            title: "Session",
            objectives: "",
            noteBlocks: [
                { id: "a", kind: "paragraph", text: "A" },
                { id: "b", kind: "paragraph", text: "B" },
            ],
        });
        expect(() =>
            updateSessionRecords(
                created[0]!,
                { studentId: "", subject: "Math", title: "Session", objectives: "", notes: "New" },
                created[1]!,
                true,
            ),
        ).toThrow("structured format");

        const heading = makeSessionRecords({
            studentId: "",
            subject: "Math",
            title: "Session",
            objectives: "",
            noteBlocks: [{ id: "a", kind: "heading", text: "A" }],
        });
        expect(() =>
            updateSessionRecords(
                heading[0]!,
                { studentId: "", subject: "Math", title: "Session", objectives: "", notes: "New" },
                heading[1]!,
                true,
            ),
        ).toThrow("structured format");

        const paragraph = makeSessionRecords({
            studentId: "",
            subject: "Math",
            title: "Session",
            objectives: "",
            noteBlocks: [{ id: "a", kind: "paragraph", text: "A" }],
        });
        const cleared = updateSessionRecords(
            paragraph[0]!,
            { studentId: "", subject: "Math", title: "Session", objectives: "", notes: "" },
            paragraph[1]!,
            true,
        );
        expect(cleared[1]!.fields.get("block_count")).toBe("0");
    });

    it("updates journal entries with optional links and notes", () => {
        expect(() =>
            updateJournalRecords(
                makeRecord(RecordType.session),
                { title: "x", date: "", notes: "" },
                null,
                false,
            ),
        ).toThrow("Only a journal entry");
        expect(() =>
            updateJournalRecords(
                makeRecord(RecordType.settings, { record_role: "other" }),
                { title: "x", date: "", notes: "" },
                null,
                false,
            ),
        ).toThrow("Only a journal entry");

        const entry = journalRecord({ collection_ids: "old", tag_ids: "old" });
        expect(() =>
            updateJournalRecords(entry, { title: "x", date: "bad", notes: "" }, null, false),
        ).toThrow("valid journal date");

        const withoutNotes = updateJournalRecords(
            entry,
            { title: "Updated", date: "2025-05-01", notes: "" },
            null,
            false,
        );
        expect(withoutNotes).toHaveLength(1);
        expect(withoutNotes[0]!.fields.get("collection_ids")).toBe("old");

        const withLinks = updateJournalRecords(
            entry,
            {
                title: "Updated",
                date: "2025-05-01",
                notes: "",
                collectionIds: [crypto.randomUUID()],
                tagIds: [crypto.randomUUID()],
            },
            null,
            false,
        );
        expect(withLinks[0]!.fields.get("collection_ids")).not.toBe("old");

        const withNotes = updateJournalRecords(
            clone(entry, { notes_document_id: "" }),
            { title: "Updated", date: "2025-05-01", notes: "Text" },
            null,
            true,
        );
        expect(withNotes).toHaveLength(2);

        const missing = clone(entry, { notes_document_id: crypto.randomUUID() });
        expect(() =>
            updateJournalRecords(
                missing,
                { title: "Updated", date: "2025-05-01", notes: "" },
                null,
                true,
            ),
        ).toThrow("linked notes document is missing");
    });

    it("updates owner notes directly and reports the final document", () => {
        expect(() => updateOwnerNotes(makeRecord(RecordType.student), null, [])).toThrow(
            "Select an active session or journal entry",
        );
        expect(() =>
            updateOwnerNotes(
                makeRecord(RecordType.settings, { record_role: "journal-entry", _deleted: "true" }),
                null,
                [],
            ),
        ).toThrow("Select an active session or journal entry");

        const session = sessionRecord({ notes_document_id: "" });
        const created = updateOwnerNotes(session, null, []);
        expect(created).toHaveLength(2);
        expect(created[0]!.fields.get("notes_document_id")).toBe(created[1]!.id);

        const existing = notesRecord(
            { entryId: session.fields.get("entry_id")!, sessionId: session.id },
            [{ id: "one", kind: "paragraph", text: "Text" }],
        );
        const owner = clone(session, { notes_document_id: existing.id });
        const updated = updateOwnerNotes(owner, existing, [
            { id: "one", kind: "paragraph", text: "Changed" },
        ]);
        expect(updated).toHaveLength(1);
        expect(updated[0]!.fields.get("block.0.text")).toBe("Changed");

        const entry = journalRecord({ notes_document_id: "" });
        const createdEntry = updateOwnerNotes(entry, null, [
            { id: "one", kind: "paragraph", text: "Entry" },
        ]);
        expect(createdEntry).toHaveLength(2);
        expect(createdEntry[1]!.fields.get("entry_id")).toBe(entry.id);
        expect(createdEntry[1]!.fields.get("session_id")).toBe("");

        const missing = clone(session, { notes_document_id: crypto.randomUUID() });
        expect(() => updateOwnerNotes(missing, null, [])).toThrow(
            "linked notes document is missing",
        );
    });

    it("rejects malformed note blocks", () => {
        const base = { title: "Reflection", date: "" };
        expect(() =>
            makeJournalRecords({
                ...base,
                noteBlocks: [{ id: "", kind: "paragraph", text: "" }],
            }),
        ).toThrow("present and unique");
        expect(() =>
            makeJournalRecords({
                ...base,
                noteBlocks: [{ id: "\ud800", kind: "paragraph", text: "" }],
            }),
        ).toThrow("present and unique");
        expect(() =>
            makeJournalRecords({
                ...base,
                noteBlocks: [{ id: "one", kind: "future" as never, text: "" }],
            }),
        ).toThrow("unsupported document type");
        expect(() =>
            makeJournalRecords({
                ...base,
                noteBlocks: [{ id: "one", kind: "paragraph", text: "\udc00" }],
            }),
        ).toThrow("invalid Unicode text");
        expect(() =>
            makeJournalRecords({
                ...base,
                noteBlocks: [{ id: "one", kind: "paragraph", text: "bad\u0000" }],
            }),
        ).toThrow("unsupported control characters");
        const empty = makeJournalRecords({
            ...base,
            noteBlocks: [{ id: "one", kind: "paragraph", text: "" }],
        });
        expect(empty[1]!.fields.get("block_count")).toBe("0");
        expect(() =>
            makeJournalRecords({
                ...base,
                notes: "bad\rtext",
            }),
        ).toThrow("unsupported control characters");
        expect(
            makeJournalRecords({ ...base, notes: "tab\there\nline" })[1]!.fields.get(
                "block.0.text",
            ),
        ).toBe("tab\there\nline");
    });

    it("validates text limits and lone surrogates", () => {
        expect(() =>
            makeStudentRecord({
                name: "bad\u007f",
                grade: "",
                subjects: "",
                objectives: "",
                tutorNotes: "",
            }),
        ).toThrow("unsupported control characters");
        expect(() =>
            makeStudentRecord({
                name: "\udc00",
                grade: "",
                subjects: "",
                objectives: "",
                tutorNotes: "",
            }),
        ).toThrow("invalid Unicode");
        expect(() =>
            makeStudentRecord({
                name: "",
                grade: "",
                subjects: "",
                objectives: "",
                tutorNotes: "",
            }),
        ).toThrow("Student name is required");
        expect(() =>
            updateStudentRecord(makeRecord(RecordType.session), {
                name: "x",
                grade: "",
                subjects: "",
                objectives: "",
                tutorNotes: "",
            }),
        ).toThrow("Only a student profile");
    });
});

describe("record fallback fields", () => {
    it("clones sessions that lack a title and entry id", () => {
        const bare = makeRecord(RecordType.session, { subject: "Math" });
        const records = cloneSessionRecords(bare, null);
        expect(records[0]!.fields.get("title")).toBe("Untitled session (copy)");
        expect(records[1]!.fields.get("record_role")).toBe("journal-entry");
    });

    it("links an entry without existing session ids", () => {
        const entry = makeRecord(RecordType.settings, { record_role: "journal-entry" });
        const records = makeSessionRecords(
            { studentId: "", subject: "Math", title: "Session", objectives: "", notes: "" },
            { linkedEntry: entry },
        );
        expect(records[2]!.fields.get("session_ids")).toBe(records[0]!.id);
    });

    it("restores an organizer when the entry has no link list yet", () => {
        const tag = makeJournalTagRecord({ name: "tag", color: "" });
        const archivedTag = clone(tag, { _deleted: "true" });
        const entry = makeRecord(RecordType.settings, {
            record_role: "journal-entry",
            _trash_restore_tag_refs: tag.id,
        });
        const restored = restoreJournalOrganizerRecord(archivedTag, [entry]);
        expect(restored[0]!.fields.get("tag_ids")).toBe(tag.id);
    });

    it("rebuilds removal markers that already list the organizer", () => {
        const tag = makeJournalTagRecord({ name: "tag", color: "" });
        const entry = journalRecord({ tag_ids: tag.id, _trash_restore_tag_refs: tag.id });
        const archived = archiveJournalOrganizerRecord(tag, [entry]);
        expect(archived[0]!.fields.get("_trash_restore_tag_refs")).toBe(tag.id);
    });

    it("decodes notes with every optional field missing", () => {
        const noOwner = notesRecord({ entryId: "E", sessionId: "S" }, [
            { id: "a", kind: "paragraph", text: "Text" },
        ]);
        noOwner.fields.delete("entry_id");
        noOwner.fields.delete("session_id");
        expect(notesEditState(noOwner, { entryId: "", sessionId: "" }).editable).toBe(true);

        const noCount = makeRecord(RecordType.settings, { record_role: "journal-notes" });
        expect(notesEditState(noCount).editable).toBe(false);

        const noId = makeRecord(RecordType.settings, {
            record_role: "journal-notes",
            block_count: "1",
        });
        expect(notesEditState(noId).editable).toBe(false);

        const noKind = makeRecord(RecordType.settings, {
            record_role: "journal-notes",
            block_count: "1",
            "block.0.id": "a",
            "block.0.text": "Text",
        });
        expect(notesEditState(noKind).editable).toBe(false);

        const noText = makeRecord(RecordType.settings, {
            record_role: "journal-notes",
            block_count: "1",
            "block.0.id": "a",
            "block.0.kind": "paragraph",
        });
        expect(notesEditState(noText)).toEqual({
            blocks: [{ id: "a", kind: "paragraph", text: "" }],
            editable: true,
        });
    });

    it("reads removal records without owner fields and with a zero count", () => {
        const document = notesRecord(
            { entryId: "E", sessionId: "S" },
            [{ id: "a", kind: "paragraph", text: "Text" }],
            {
                removed_block_count: "1",
                removed_block_0_id: "removed",
                removed_block_0_kind: "quote",
                removed_block_0_text: "Gone",
                removed_block_0_index: "0",
            },
        );
        document.fields.delete("entry_id");
        document.fields.delete("session_id");
        expect(readRemovedNoteBlocks(document)).toEqual([
            {
                documentId: document.id,
                entryId: "",
                sessionId: "",
                id: "removed",
                kind: "quote",
                text: "Gone",
                index: 0,
            },
        ]);

        const zero = clone(document, { removed_block_count: "0" });
        expect(readRemovedNoteBlocks(zero)).toEqual([]);
    });

    it("keeps removed indices below the restored position unchanged", () => {
        const document = notesRecord(
            { entryId: "E", sessionId: "" },
            [{ id: "a", kind: "paragraph", text: "A" }],
            {
                removed_block_count: "2",
                removed_block_0_id: "b",
                removed_block_0_kind: "paragraph",
                removed_block_0_text: "B",
                removed_block_0_index: "5",
                removed_block_1_id: "e",
                removed_block_1_kind: "paragraph",
                removed_block_1_text: "E",
                removed_block_1_index: "2",
            },
        );
        const restored = restoreRemovedNoteBlock(document, "b");
        expect(notesEditState(restored).blocks.map((item) => item.id)).toEqual(["a", "b"]);
        expect(restored.fields.get("removed_block_0_id")).toBe("e");
        expect(restored.fields.get("removed_block_0_index")).toBe("2");
    });

    it("does not duplicate a removed block already tracked in Trash", () => {
        const created = makeJournalRecords({
            title: "Reflection",
            date: "",
            noteBlocks: [
                { id: "a", kind: "paragraph", text: "A" },
                { id: "b", kind: "paragraph", text: "B" },
            ],
        });
        const document = clone(created[1]!, {
            removed_block_count: "1",
            removed_block_0_id: "b",
            removed_block_0_kind: "paragraph",
            removed_block_0_text: "B",
            removed_block_0_index: "1",
        });
        const updated = updateJournalRecords(
            created[0]!,
            {
                title: "Reflection",
                date: "",
                noteBlocks: [{ id: "a", kind: "paragraph", text: "A" }],
            },
            document,
            true,
        );
        expect(updated[1]!.fields.get("removed_block_count")).toBe("1");
        expect(updated[1]!.fields.get("removed_block_0_id")).toBe("b");
    });

    it("creates notes when owners omit their notes pointers", () => {
        const session = makeRecord(RecordType.session, {
            title: "Session",
            subject: "Math",
            session_state: "active",
        });
        const sessionUpdate = updateSessionRecords(
            session,
            { studentId: "", subject: "Math", title: "Session", objectives: "", notes: "" },
            null,
            true,
        );
        expect(sessionUpdate).toHaveLength(2);
        expect(sessionUpdate[1]!.fields.get("entry_id")).toBe("");
        expect(sessionUpdate[1]!.fields.get("session_id")).toBe(session.id);

        const entry = makeRecord(RecordType.settings, {
            record_role: "journal-entry",
            title: "Entry",
        });
        const entryUpdate = updateJournalRecords(
            entry,
            { title: "Entry", date: "", notes: "" },
            null,
            true,
        );
        expect(entryUpdate[1]!.fields.get("entry_id")).toBe(entry.id);

        const ownerSession = makeRecord(RecordType.session, { session_state: "active" });
        const ownerUpdate = updateOwnerNotes(ownerSession, null, []);
        expect(ownerUpdate).toHaveLength(2);
        expect(ownerUpdate[1]!.fields.get("entry_id")).toBe("");
    });

    it("reuses the first block id when replacing an empty notes document", () => {
        const entry = journalRecord();
        const document = notesRecord({ entryId: entry.id, sessionId: "" }, []);
        const withDocument = clone(entry, { notes_document_id: document.id });
        const updated = updateJournalRecords(
            withDocument,
            { title: "Entry", date: "", notes: "Text" },
            document,
            true,
        );
        expect(updated[1]!.fields.get("block_count")).toBe("1");
        expect(updated[1]!.fields.get("block.0.id")).toMatch(/^[\da-f-]{36}$/u);
    });

    it("treats missing plain-text notes as empty", () => {
        const created = makeJournalRecords({
            title: "Entry",
            date: "",
            notes: undefined as unknown as string,
        });
        expect(created[1]!.fields.get("block_count")).toBe("0");
    });
});
