import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { importAiResponseRecords } from "../../../frontend/ai/import-response";

const encoder = new TextEncoder();

function record(
    type: ArchiveRecord["type"],
    fields: Record<string, string>,
    id = newUuid(),
): ArchiveRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

function session(): ArchiveRecord {
    return record(RecordType.session, {
        entry_id: "",
        student_id: "anonymous",
        title: "Fractions",
    });
}

function guideResponse(sourceIds: string[], templateId = "general"): string {
    return JSON.stringify({
        title: "Fraction guide",
        template_id: templateId,
        sections: [
            {
                heading: "Equivalent fractions",
                blocks: [{ kind: "paragraph", text: "Same value.", source_ids: sourceIds }],
            },
        ],
    });
}

function encode(value: string): Uint8Array {
    return encoder.encode(value);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("importAiResponseRecords", () => {
    it("builds an unapproved guide and manual job from a structured response", async () => {
        const currentSession = session();
        const segment = record(RecordType.transcriptSegment, {
            session_id: currentSession.id,
            text: "One half equals two quarters.",
        });
        const bytes = encode(guideResponse([segment.id], "selected-template"));
        const before = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

        const imported = await importAiResponseRecords({
            session: currentSession,
            bytes,
            filename: "response.json",
            templateId: "selected-template",
            records: [currentSession, segment],
        });

        expect(imported.status).toBe("response-imported");
        expect(imported.warnings).toEqual([]);
        expect(imported.records).toHaveLength(2);
        const [guide, job] = imported.records as [ArchiveRecord, ArchiveRecord];
        expect(guide.type).toBe(RecordType.guide);
        expect(imported.guideId).toBe(guide.id);
        expect(job.type).toBe(RecordType.aiJob);
        expect(imported.jobId).toBe(job.id);
        expect(job.fields.get("session_id")).toBe(currentSession.id.toLowerCase());
        expect(job.fields.get("mode")).toBe("manual");
        expect(job.fields.get("status")).toBe("response-imported");
        expect(job.fields.get("schema_valid")).toBe("true");
        expect(job.fields.get("source_validation")).toBe("passed");
        expect(job.fields.get("import_warnings")).toBe("");
        expect(job.fields.get("guide_id")).toBe(guide.id);
        expect(job.fields.get("original_filename")).toBe("response.json");
        expect(job.fields.get("content_hash")).toBe(
            createHash("sha256").update(bytes).digest("hex"),
        );
        expect(job.fields.get("created_at_us")).toBe("1700000000000000");
        expect(job.blob).toEqual(bytes);
        expect(job.blob).not.toBe(bytes);
        expect(before).toBeGreaterThan(0);
    });

    it("rejects empty and oversized response files", async () => {
        const currentSession = session();
        const options = {
            session: currentSession,
            filename: "response.json",
            templateId: "general",
            records: [currentSession],
        };
        await expect(
            importAiResponseRecords({ ...options, bytes: new Uint8Array() }),
        ).rejects.toThrow("Response must be between 1 byte and 16 MiB.");
        await expect(
            importAiResponseRecords({ ...options, bytes: new Uint8Array(16 * 1024 * 1024 + 1) }),
        ).rejects.toThrow("Response must be between 1 byte and 16 MiB.");
    });

    it("rejects bytes that are not valid UTF-8", async () => {
        const currentSession = session();
        await expect(
            importAiResponseRecords({
                session: currentSession,
                bytes: new Uint8Array([0xff, 0xfe, 0xfd]),
                filename: "response.bin",
                templateId: "general",
                records: [currentSession],
            }),
        ).rejects.toThrow();
    });

    it("uses the response template only when the requested template is auto", async () => {
        const currentSession = session();
        const segment = record(RecordType.transcriptSegment, { session_id: currentSession.id });
        const bytes = encode(guideResponse([segment.id], "lab-report"));

        const auto = await importAiResponseRecords({
            session: currentSession,
            bytes,
            filename: "response.json",
            templateId: "auto",
            records: [currentSession, segment],
        });
        const autoGuide = auto.records[0] as ArchiveRecord;
        expect(autoGuide.fields.get("template_id")).toBe("lab-report");

        const explicit = await importAiResponseRecords({
            session: currentSession,
            bytes,
            filename: "response.json",
            templateId: "general",
            records: [currentSession, segment],
        });
        expect((explicit.records[0] as ArchiveRecord).fields.get("template_id")).toBe("general");
    });

    it("falls back to the general template for unstructured or untemplated JSON", async () => {
        const currentSession = session();
        const cases = ["plain notes", "42", "null", "[1,2]", '{"template_id":5}', "{}"];
        for (const response of cases) {
            const imported = await importAiResponseRecords({
                session: currentSession,
                bytes: encode(response),
                filename: "response.txt",
                templateId: "auto",
                records: [currentSession],
            });
            const guide = imported.records[0] as ArchiveRecord;
            expect(guide.fields.get("template_id")).toBe("general");
            expect(imported.status).toBe("response-needs-correction");
        }
    });

    it("keeps a structured response without source links as missing evidence", async () => {
        const currentSession = session();
        const imported = await importAiResponseRecords({
            session: currentSession,
            bytes: encode(guideResponse([])),
            filename: "response.json",
            templateId: "general",
            records: [currentSession],
        });

        expect(imported.status).toBe("response-needs-correction");
        expect(imported.records[1]?.fields.get("source_validation")).toBe("missing-evidence");
        expect(imported.records[1]?.fields.get("schema_valid")).toBe("true");
    });

    it("preserves the raw response when guide source links cannot be resolved", async () => {
        const currentSession = session();
        const unknown = newUuid();
        const response = guideResponse([unknown]);
        const imported = await importAiResponseRecords({
            session: currentSession,
            bytes: encode(response),
            filename: "response.json",
            templateId: "general",
            records: [currentSession],
        });

        expect(imported.status).toBe("response-needs-correction");
        expect(imported.records[1]?.fields.get("source_validation")).toBe("failed");
        expect(imported.warnings).toContain(
            "Some source links need correction; the original response was kept as editable text.",
        );
        const guide = imported.records[0] as ArchiveRecord;
        expect(guide.fields.get("title")).toBe("AI response — review required");
        expect(guide.fields.get("section.0.heading")).toBe("Generated response — review required");
        expect(guide.fields.get("section.0.block.0.text")).toBe(response);
        expect(guide.fields.get("section.0.block.0.origin")).toBe("ai-generated");
    });
});
