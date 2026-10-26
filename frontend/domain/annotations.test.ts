import { describe, expect, it } from "vitest";
import { RecordType, newUuid } from "../archive/format";
import {
  duplicateAnnotationRecord,
  makeAnnotationRecord,
  removeAnnotationRecord,
  updateAnnotationRecord,
} from "./annotations";

const input = {
  sessionId: newUuid(),
  start: "00:01:12.250",
  end: "00:01:15.000",
  type: "important-concept" as const,
  priority: "high" as const,
  title: "Balance model",
  content: "The two sides stay equal.",
};

describe("annotation records", () => {
  it("creates legacy-compatible session-linked annotation records", () => {
    const annotation = makeAnnotationRecord(input);
    expect(annotation.type).toBe(RecordType.annotation);
    expect(annotation.fields.get("session_id")).toBe(input.sessionId);
    expect(annotation.fields.get("start_time_us")).toBe("72250000");
    expect(annotation.fields.get("end_time_us")).toBe("75000000");
    expect(annotation.fields.get("type")).toBe("important-concept");
    expect(annotation.fields.get("priority")).toBe("high");
    expect(annotation.fields.get("origin")).toBe("tutor-authored");
  });

  it("updates known fields without losing extension data", () => {
    const created = makeAnnotationRecord(input);
    const fields = new Map(created.fields);
    fields.set("linked_evidence_ids", "evidence-id");
    const original = { ...created, fields };
    const updated = updateAnnotationRecord(original, {
      ...input,
      end: "00:01:17",
      priority: "critical",
      content: "We checked both sides together.",
    });
    expect(updated.id).toBe(original.id);
    expect(updated.fields.get("end_time_us")).toBe("77000000");
    expect(updated.fields.get("priority")).toBe("critical");
    expect(updated.fields.get("linked_evidence_ids")).toBe("evidence-id");
    expect(original.fields.get("content")).toBe(input.content);
  });

  it("duplicates identity and moves removed annotations to recoverable state", () => {
    const created = makeAnnotationRecord(input);
    const duplicate = duplicateAnnotationRecord(created);
    expect(duplicate.id).not.toBe(created.id);
    expect(duplicate.fields.get("content")).toBe(created.fields.get("content"));

    const removed = removeAnnotationRecord(created);
    expect(removed.id).toBe(created.id);
    expect(removed.fields.get("_deleted")).toBe("true");
    expect(removed.fields.has("deleted_at_us")).toBe(true);
    expect(created.fields.has("_deleted")).toBe(false);
    expect(() => removeAnnotationRecord(removed)).toThrow("already removed");
  });

  it("rejects invalid ranges, session IDs, and enum values", () => {
    expect(() => makeAnnotationRecord({ ...input, sessionId: "bad" })).toThrow("valid UUID");
    expect(() => makeAnnotationRecord({ ...input, end: "00:01:00" })).toThrow("precedes its start");
    expect(() => makeAnnotationRecord({ ...input, type: "unknown" as "custom" })).toThrow(
      "Unsupported annotation type",
    );
    expect(() => makeAnnotationRecord({ ...input, priority: "urgent" as "normal" })).toThrow(
      "Priority must be low, normal, high, or critical",
    );
  });
});
