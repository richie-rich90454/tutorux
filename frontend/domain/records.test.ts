import { describe, expect, it } from "vitest";
import { RecordType } from "../archive/format";
import {
  archiveJournalOrganizerRecord,
  makeJournalCollectionRecord,
  makeJournalRecords,
  makeJournalTagRecord,
  makeSessionRecords,
  makeStudentRecord,
  moveRecordToTrash,
  notesEditState,
  restoreRecordFromTrash,
  restoreJournalOrganizerRecord,
  updateJournalRecords,
  updateSessionRecords,
  updateStudentRecord,
} from "./records";

describe("student profile lifecycle", () => {
  it("creates and edits the complete legacy student profile", () => {
    const created = makeStudentRecord({
      name: "Mina Chen",
      grade: "Year 8",
      subjects: "Math",
      objectives: "Fractions",
      difficulties: "Comparing unlike denominators",
      demonstratedImprovements: "Explains the scale factor",
      preferredGuideTemplate: "mathematics",
      tutorNotes: "Use visual models first.",
    });

    const updated = updateStudentRecord(created, {
      name: "Mina Chen",
      grade: "Year 8",
      subjects: "Math, Science",
      objectives: "Fractions and ratios",
      difficulties: "Choosing a common denominator",
      demonstratedImprovements: "Finds equivalent fractions independently",
      preferredGuideTemplate: "concise-review",
      tutorNotes: "Ask Mina to explain each step.",
    });

    expect(created.fields.get("known_difficulties")).toBe("Comparing unlike denominators");
    expect(created.fields.get("demonstrated_improvements")).toBe("Explains the scale factor");
    expect(created.fields.get("preferred_guide_template")).toBe("mathematics");
    expect(updated.fields.get("known_difficulties")).toBe("Choosing a common denominator");
    expect(updated.fields.get("demonstrated_improvements")).toBe(
      "Finds equivalent fractions independently",
    );
    expect(updated.fields.get("preferred_guide_template")).toBe("concise-review");
  });

  it("edits a profile without changing its identity or unknown legacy fields", () => {
    const base = makeStudentRecord({
      name: "Mina Chen",
      grade: "Year 8",
      subjects: "Math",
      objectives: "Fractions",
      tutorNotes: "",
    });
    const fields = new Map(base.fields);
    fields.set("known_difficulties", "Fractions vocabulary");
    fields.set("future_extension", "preserve this");
    const original = { ...base, fields };

    const updated = updateStudentRecord(original, {
      name: "Mina C.",
      grade: "Year 9",
      subjects: "Math, Science",
      objectives: "Ratios",
      tutorNotes: "Check in about confidence.",
    });

    expect(updated.id).toBe(original.id);
    expect(updated.revision).toBe(original.revision);
    expect(updated.fields.get("display_name")).toBe("Mina C.");
    expect(updated.fields.get("known_difficulties")).toBe("Fractions vocabulary");
    expect(updated.fields.get("future_extension")).toBe("preserve this");
    expect(updated.fields.get("updated_at_us")).not.toBe(original.fields.get("updated_at_us"));
    expect(original.fields.get("display_name")).toBe("Mina Chen");
  });

  it("moves a record to Trash and restores its recoverable state", () => {
    const base = makeStudentRecord({
      name: "Mina Chen",
      grade: "Year 8",
      subjects: "Math",
      objectives: "Fractions",
      tutorNotes: "",
    });
    const fields = new Map(base.fields);
    fields.set("future_extension", "preserve this");
    const original = { ...base, fields };

    const trashed = moveRecordToTrash(original);
    expect(trashed.fields.get("_deleted")).toBe("true");
    expect(trashed.fields.get("deleted_at_us")).toMatch(/^\d+$/u);
    expect(original.fields.has("_deleted")).toBe(false);

    const restored = restoreRecordFromTrash(trashed);
    expect(restored.id).toBe(original.id);
    expect(restored.fields.has("_deleted")).toBe(false);
    expect(restored.fields.has("deleted_at_us")).toBe(false);
    expect(restored.fields.get("future_extension")).toBe("preserve this");
    expect(restored.fields.has("restored_at_us")).toBe(true);
  });

  it("rejects invalid student and Trash transitions", () => {
    const student = makeStudentRecord({
      name: "Mina Chen",
      grade: "Year 8",
      subjects: "Math",
      objectives: "Fractions",
      tutorNotes: "",
    });
    const session = { ...student, type: RecordType.session };
    expect(() =>
      updateStudentRecord(session, {
        name: "Mina",
        grade: "",
        subjects: "",
        objectives: "",
        tutorNotes: "",
      }),
    ).toThrow("Only a student profile");
    expect(() => restoreRecordFromTrash(student)).toThrow("not in Trash");
    expect(() => moveRecordToTrash(moveRecordToTrash(student))).toThrow("already in Trash");
  });

  it("updates session details and notes without losing recording metadata", () => {
    const created = makeSessionRecords({
      studentId: "student-id",
      subject: "Math",
      title: "Fractions",
      objectives: "Compare fractions",
      notes: "We used fraction strips.",
    });
    const sessionFields = new Map(created[0]!.fields);
    sessionFields.set("recording_track_ids", "track-id");
    const existingSession = { ...created[0]!, fields: sessionFields };

    const updated = updateSessionRecords(
      existingSession,
      {
        studentId: "student-id",
        subject: "Math",
        title: "Fractions and equivalence",
        objectives: "Explain equivalent fractions",
        notes: "Mina explained the model back clearly.",
      },
      created[1]!,
      true,
    );

    expect(updated[0]!.fields.get("title")).toBe("Fractions and equivalence");
    expect(updated[0]!.fields.get("recording_track_ids")).toBe("track-id");
    expect(updated[0]!.fields.get("notes_document_id")).toBe(created[1]!.id);
    expect(updated[1]!.fields.get("block.0.id")).toBe(created[1]!.fields.get("block.0.id"));
    expect(updated[1]!.fields.get("block.0.text")).toBe("Mina explained the model back clearly.");
  });

  it("updates journal metadata and keeps structured notes protected", () => {
    const created = makeJournalRecords({
      title: "Reflection",
      date: "2024-02-29",
      notes: "A useful example.",
    });
    const fields = new Map(created[1]!.fields);
    fields.set("block_count", "2");
    fields.set("block.1.id", "second-block");
    fields.set("block.1.kind", "heading");
    fields.set("block.1.text", "Next time");
    const structuredNotes = { ...created[1]!, fields };

    expect(notesEditState(structuredNotes).editable).toBe(false);
    const updated = updateJournalRecords(
      created[0]!,
      { title: "A clearer reflection", date: "2025-03-01", notes: "" },
      structuredNotes,
      false,
    );
    expect(updated[0]!.fields.get("title")).toBe("A clearer reflection");
    expect(updated[0]!.fields.get("entry_date")).toBe("2025-03-01");
    expect(structuredNotes.fields.get("block.1.text")).toBe("Next time");
  });

  it("round-trips collection and tag links through archive and restore", () => {
    const collection = makeJournalCollectionRecord({
      name: "Confidence",
      description: "Moments worth returning to",
      color: "#6F8F7B",
    });
    const tag = makeJournalTagRecord({ name: "fractions", color: "#7185AD" });
    const entry = makeJournalRecords({
      title: "A new approach",
      date: "2026-10-26",
      notes: "The visual model helped.",
      collectionIds: [collection.id],
      tagIds: [tag.id],
    })[0]!;

    expect(collection.fields.get("record_role")).toBe("journal-collection");
    expect(collection.fields.get("color")).toBe("#6f8f7b");
    expect(entry.fields.get("collection_ids")).toBe(collection.id);
    expect(entry.fields.get("tag_ids")).toBe(tag.id);

    const archived = archiveJournalOrganizerRecord(collection, [entry]);
    const detachedEntry = archived[0]!;
    const archivedCollection = archived[1]!;
    expect(detachedEntry.fields.get("collection_ids")).toBe("");
    expect(detachedEntry.fields.get("_trash_restore_collection_refs")).toBe(collection.id);
    expect(archivedCollection.fields.get("_deleted")).toBe("true");

    const restored = restoreJournalOrganizerRecord(archivedCollection, [detachedEntry]);
    expect(restored[0]!.fields.get("collection_ids")).toBe(collection.id);
    expect(restored[0]!.fields.has("_trash_restore_collection_refs")).toBe(false);
    expect(restored[1]!.fields.has("_deleted")).toBe(false);
    expect(restored[1]!.fields.get("restored_at_us")).toBeTruthy();
  });

  it("restores an archived collection link while its journal entry is in Trash", () => {
    const collection = makeJournalCollectionRecord({
      name: "Confidence",
      description: "Moments worth returning to",
      color: "#6f8f7b",
    });
    const entry = makeJournalRecords({
      title: "A new approach",
      date: "2026-10-26",
      notes: "The visual model helped.",
      collectionIds: [collection.id],
    })[0]!;

    const archived = archiveJournalOrganizerRecord(collection, [entry]);
    const trashedEntry = moveRecordToTrash(archived[0]!);
    const restoredCollectionAndEntry = restoreJournalOrganizerRecord(archived[1]!, [trashedEntry]);
    const restoredEntryWhileTrashed = restoredCollectionAndEntry[0]!;

    expect(restoredEntryWhileTrashed.fields.get("_deleted")).toBe("true");
    expect(restoredEntryWhileTrashed.fields.get("collection_ids")).toBe(collection.id);
    expect(restoredEntryWhileTrashed.fields.has("_trash_restore_collection_refs")).toBe(false);

    const restoredEntry = restoreRecordFromTrash(restoredEntryWhileTrashed);
    expect(restoredEntry.fields.has("_deleted")).toBe(false);
    expect(restoredEntry.fields.get("collection_ids")).toBe(collection.id);
  });

  it("validates journal link IDs and organizer colors", () => {
    expect(() =>
      makeJournalRecords({
        title: "Reflection",
        date: "2026-10-26",
        notes: "",
        collectionIds: ["not-an-archive-id"],
      }),
    ).toThrow("valid archive IDs");
    expect(() => makeJournalTagRecord({ name: "review", color: "red" })).toThrow("#RRGGBB");
  });

  it("rejects impossible calendar dates instead of normalizing them", () => {
    expect(() => makeJournalRecords({ title: "Bad date", date: "2026-02-31", notes: "" })).toThrow(
      "valid journal date",
    );
  });

  it("counts profile limits in UTF-8 bytes and preserves multiline note text", () => {
    const withinLimit = makeStudentRecord({
      name: "顾".repeat(85),
      grade: "",
      subjects: "",
      objectives: "",
      tutorNotes: "",
    });
    expect(withinLimit.fields.get("display_name")).toHaveLength(85);
    expect(() =>
      makeStudentRecord({
        name: "顾".repeat(86),
        grade: "",
        subjects: "",
        objectives: "",
        tutorNotes: "",
      }),
    ).toThrow("UTF-8 bytes");

    const session = makeSessionRecords({
      studentId: "",
      subject: "Math",
      title: "Reflection",
      objectives: "",
      notes: "first line\nsecond line\n",
    });
    expect(session[1]!.fields.get("block.0.text")).toBe("first line\nsecond line\n");
  });

  it("rejects lone surrogate code units instead of silently replacing them", () => {
    expect(() =>
      makeStudentRecord({
        name: "Mina\ud800",
        grade: "",
        subjects: "",
        objectives: "",
        tutorNotes: "",
      }),
    ).toThrow("invalid Unicode");
  });
});
