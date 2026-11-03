import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    openArchiveBytes,
} from "../../../frontend/archive/archive";
import { previewSanitizedCopy } from "../../../frontend/archive/sanitized-copy";
import {
    newUuid,
    RecordType,
    type ArchiveRecord,
    type RecordTypeValue,
} from "../../../frontend/archive/format";

function record(
    type: RecordTypeValue,
    id: string,
    fields: Record<string, string> = {},
): ArchiveRecord {
    return {
        type,
        id,
        revision: 1n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

describe("guide inline source references", () => {
    it("collects inline sources and keeps guides whose inline source is retained", async () => {
        const student = newUuid();
        const session = newUuid();
        const evidence = newUuid();
        const guide = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("inline sources")),
            [
                record(RecordType.student, student, { display_name: "Amina" }),
                record(RecordType.session, session, { student_id: student }),
                record(RecordType.evidenceNode, evidence, {
                    session_id: session,
                    student_id: student,
                }),
                record(RecordType.guide, guide, {
                    session_id: session,
                    title: "Inline guide",
                    section_count: "1",
                    "section.0.heading": "Evidence",
                    "section.0.block_count": "1",
                    "section.0.block.0.kind": "paragraph",
                    "section.0.block.0.text": `See [[source:${evidence}]] for context.`,
                }),
            ],
        );

        const summary = await previewSanitizedCopy(snapshot);
        expect(summary.guides).toBe(1);
        expect(summary.evidenceItems).toBe(1);
    });
});
