import { describe, expect, it } from "vitest";
import { encodeRecordPayload, RecordType, validateRecordPayloadSize } from "../archive/format";
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

  it("edits typed journal blocks while keeping block identities stable", () => {
    const created = makeJournalRecords({
      title: "Reflection",
      date: "2024-02-29",
      noteBlocks: [
        { id: "reflection-intro", kind: "paragraph", text: "A useful example." },
        { id: "reflection-next", kind: "heading", text: "Next time" },
      ],
    });
    const state = notesEditState(created[1]);
    expect(state.editable).toBe(true);
    expect(state.blocks).toEqual([
      { id: "reflection-intro", kind: "paragraph", text: "A useful example." },
      { id: "reflection-next", kind: "heading", text: "Next time" },
    ]);
    const updatedBlocks = state.blocks.map((block) =>
      block.id === "reflection-next" ? { ...block, text: "Try a visual model" } : block,
    );
    const updated = updateJournalRecords(
      created[0]!,
      {
        title: "A clearer reflection",
        date: "2025-03-01",
        noteBlocks: updatedBlocks,
      },
      created[1]!,
      true,
    );
    expect(updated[0]!.fields.get("title")).toBe("A clearer reflection");
    expect(updated[0]!.fields.get("entry_date")).toBe("2025-03-01");
    expect(updated[1]!.fields.get("block_count")).toBe("2");
    expect(updated[1]!.fields.get("block.0.id")).toBe("reflection-intro");
    expect(updated[1]!.fields.get("block.1.id")).toBe("reflection-next");
    expect(updated[1]!.fields.get("block.1.text")).toBe("Try a visual model");
  });

  it("leaves unknown journal block kinds and extension fields protected from edits", () => {
    const created = makeJournalRecords({
      title: "Reflection",
      date: "2024-02-29",
      notes: "A useful example.",
    });
    const fields = new Map(created[1]!.fields);
    fields.set("block.0.kind", "legacy-widget");
    const legacyNotes = { ...created[1]!, fields };

    expect(notesEditState(legacyNotes).editable).toBe(false);
    expect(() =>
      updateJournalRecords(
        created[0]!,
        { title: "Changed", date: "2025-03-01", noteBlocks: [] },
        legacyNotes,
        true,
      ),
    ).toThrow("structured format");
    expect(legacyNotes.fields.get("block.0.kind")).toBe("legacy-widget");

    const fieldsWithExtension = new Map(created[1]!.fields);
    fieldsWithExtension.set("block.0.render_hint", "future-format");
    expect(notesEditState({ ...created[1]!, fields: fieldsWithExtension }).editable).toBe(false);
  });

  it("rejects editing a journal notes document linked to another entry", () => {
    const first = makeJournalRecords({
      title: "First reflection",
      date: "2024-02-29",
      notes: "First notes",
    });
    const second = makeJournalRecords({
      title: "Second reflection",
      date: "2024-03-01",
      notes: "Second notes",
    });
    const secondNotes = second[1]!;
    const firstWithSecondNoteLink = {
      ...first[0]!,
      fields: new Map(first[0]!.fields),
    };
    firstWithSecondNoteLink.fields.set("notes_document_id", secondNotes.id);

    expect(
      notesEditState(secondNotes, { entryId: firstWithSecondNoteLink.id, sessionId: "" }).editable,
    ).toBe(false);
    expect(() =>
      updateJournalRecords(
        firstWithSecondNoteLink,
        { title: "Hijacked reflection", date: "2024-02-29", notes: "Changed" },
        secondNotes,
        true,
      ),
    ).toThrow("structured format");
    expect(secondNotes.fields.get("entry_id")).toBe(second[0]!.id);
    expect(secondNotes.fields.get("block.0.text")).toBe("Second notes");
  });

  it("rejects editing session notes linked to another session", () => {
    const first = makeSessionRecords({
      studentId: "student-id",
      subject: "Math",
      title: "First session",
      objectives: "Fractions",
      notes: "First notes",
    });
    const second = makeSessionRecords({
      studentId: "student-id",
      subject: "Math",
      title: "Second session",
      objectives: "Ratios",
      notes: "Second notes",
    });
    const firstWithSecondNoteLink = {
      ...first[0]!,
      fields: new Map(first[0]!.fields),
    };
    firstWithSecondNoteLink.fields.set("notes_document_id", second[1]!.id);

    expect(() =>
      updateSessionRecords(
        firstWithSecondNoteLink,
        {
          studentId: "student-id",
          subject: "Math",
          title: "Hijacked session",
          objectives: "Fractions",
          notes: "Changed",
        },
        second[1]!,
        true,
      ),
    ).toThrow("structured format");
    expect(second[1]!.fields.get("session_id")).toBe(second[0]!.id);
    expect(second[1]!.fields.get("block.0.text")).toBe("Second notes");
  });

  it("rejects duplicate note block IDs and preserves large multibyte legacy blocks", () => {
    expect(() =>
      makeJournalRecords({
        title: "Reflection",
        date: "2024-02-29",
        noteBlocks: [
          { id: "same-id", kind: "paragraph", text: "First" },
          { id: "same-id", kind: "quote", text: "Second" },
        ],
      }),
    ).toThrow("present and unique");
    const legacyId = `  ${"📝".repeat(100)}  `;
    const legacyText = "A preserved legacy note.\n".repeat(5_000);
    const legacy = makeJournalRecords({
      title: "Reflection",
      date: "2024-02-29",
      noteBlocks: [{ id: legacyId, kind: "paragraph", text: legacyText }],
    });
    const state = notesEditState(legacy[1]!);
    expect(state.editable).toBe(true);
    expect(state.blocks).toEqual([{ id: legacyId, kind: "paragraph", text: legacyText }]);

    const updated = updateJournalRecords(
      legacy[0]!,
      { title: "Reflection with details", date: "2024-02-29", noteBlocks: state.blocks },
      legacy[1]!,
      true,
    );
    expect(updated[1]!.fields.get("block.0.id")).toBe(legacyId);
    expect(updated[1]!.fields.get("block.0.text")).toBe(legacyText);
  });

  it("validates note controls and counts complete serialized metadata at the size boundary", () => {
    expect(() =>
      makeJournalRecords({
        title: "Reflection",
        date: "2024-02-29",
        noteBlocks: [{ id: "control-check", kind: "paragraph", text: "not\u0000safe" }],
      }),
    ).toThrow("unsupported control characters");

    const journal = makeJournalRecords({
      title: "Reflection",
      date: "2024-02-29",
      noteBlocks: [{ id: "stable-id", kind: "paragraph", text: "A safe note." }],
    });
    const notes = journal[1]!;
    const encoded = encodeRecordPayload(notes);
    expect(
      validateRecordPayloadSize(notes.fields, notes.blob.byteLength, BigInt(encoded.length)),
    ).toBe(encoded.length);
    expect(() =>
      validateRecordPayloadSize(notes.fields, notes.blob.byteLength, BigInt(encoded.length - 1)),
    ).toThrowError(expect.objectContaining({ code: "record_payload_limit" }));

    const withBlob = { ...notes, blob: new Uint8Array([0x41]) };
    const encodedWithBlob = encodeRecordPayload(withBlob);
    expect(
      validateRecordPayloadSize(
        withBlob.fields,
        withBlob.blob.byteLength,
        BigInt(encodedWithBlob.length),
      ),
    ).toBe(encodedWithBlob.length);
    const updated = updateJournalRecords(
      journal[0]!,
      { title: "Preserve extension blob", date: "2024-02-29", noteBlocks: [] },
      withBlob,
      true,
    );
    expect(updated[1]!.blob).toEqual(withBlob.blob);

    const invalidLegacyFields = new Map(notes.fields);
    invalidLegacyFields.set("block.0.text", "not\u0000safe");
    expect(notesEditState({ ...notes, fields: invalidLegacyFields }).editable).toBe(false);
  });

  it("honors the legacy-compatible journal document block limit", () => {
    const maximum = makeJournalRecords({
      title: "Reflection",
      date: "2024-02-29",
      noteBlocks: Array.from({ length: 10_000 }, (_, index) => ({
        id: `block-${index}`,
        kind: "paragraph" as const,
        text: "",
      })),
    });
    expect(maximum[1]!.fields.get("block_count")).toBe("10000");

    expect(() =>
      makeJournalRecords({
        title: "Reflection",
        date: "2024-02-29",
        noteBlocks: Array.from({ length: 10_001 }, (_, index) => ({
          id: `block-${index}`,
          kind: "paragraph" as const,
          text: "",
        })),
      }),
    ).toThrow("at most 10,000 blocks");
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
