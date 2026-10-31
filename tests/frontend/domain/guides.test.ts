import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    GUIDE_TEMPLATES,
    generateGuideDraftFromSession,
    guideDraftFromRecord,
    guideRegenerationTarget,
    insertGuideImageBlock,
    isGuideSourceInScope,
    makeGuideRecord,
    renderGuideHtml,
    replaceGuideSectionFromGenerated,
    resolveGuideTemplates,
    validateGuideForExport,
    type GuideExportImage,
} from "../../../frontend/domain/guides";

describe("study guide HTML export", () => {
    it("escapes imported text and keeps source review cues in the document", () => {
        const sourceId = crypto.randomUUID();
        const record: ArchiveRecord = {
            type: RecordType.guide,
            id: crypto.randomUUID(),
            revision: 1n,
            previousOffset: 0n,
            fields: new Map([
                ["title", "<script>review()</script>"],
                ["template_id", "general"],
                ["approval_state", "draft"],
                ["section_count", "1"],
                ["section.0.heading", "Questions & evidence"],
                ["section.0.block_count", "1"],
                ["section.0.block.0.kind", "paragraph"],
                ["section.0.block.0.text", "<img src=x onerror=review()> & discuss"],
                ["section.0.block.0.source_ids", sourceId],
                ["section.0.block.0.stale", "true"],
                ["section.0.block.0.origin", "tutor-authored"],
            ]),
            blob: new Uint8Array(),
        };

        const html = renderGuideHtml(record);
        expect(html).toContain("<!doctype html>");
        expect(html).toContain("&lt;script&gt;review()&lt;/script&gt;");
        expect(html).toContain("&lt;img src=x onerror=review()&gt; &amp; discuss");
        expect(html).not.toContain("<script>");
        expect(html).not.toContain("<img src=x");
        expect(html).toContain("Source changed. Review this block");
        expect(html).toContain(sourceId);
        expect(html).toContain("@media print");
    });

    it("renders Markdown tables and embeds validated archive image bytes", () => {
        const imageId = crypto.randomUUID();
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        const image: GuideExportImage = { assetId: imageId, mimeType: "image/png", bytes };
        const record: ArchiveRecord = {
            type: RecordType.guide,
            id: crypto.randomUUID(),
            revision: 1n,
            previousOffset: 0n,
            fields: new Map([
                ["title", "Visual review"],
                ["template_id", "general"],
                ["approval_state", "draft"],
                ["section_count", "1"],
                ["section.0.heading", "Examples"],
                ["section.0.block_count", "2"],
                ["section.0.block.0.kind", "table"],
                ["section.0.block.0.text", "| Ratio | Model |\n| --- | --- |\n| 2:3 | Bars |"],
                ["section.0.block.0.source_ids", ""],
                ["section.0.block.0.origin", "tutor-authored"],
                ["section.0.block.1.kind", "figure"],
                ["section.0.block.1.text", `![Bar model <safe>](asset:${imageId})`],
                ["section.0.block.1.source_ids", imageId],
                ["section.0.block.1.origin", "tutor-authored"],
            ]),
            blob: new Uint8Array(),
        };

        const html = renderGuideHtml(record, new Map([[imageId, image]]));
        expect(html).toContain('<table class="guide-table">');
        expect(html).toContain('<th scope="col">Ratio</th>');
        expect(html).toContain('src="data:image/png;base64,iVBORw=="');
        expect(html).toContain('alt="Bar model &lt;safe&gt;"');
        expect(html).toContain("Bar model &lt;safe&gt;");
    });
});

type MutableRecord = ArchiveRecord & { fields: Map<string, string> };

function record(type: ArchiveRecord["type"], fields: Record<string, string> = {}): MutableRecord {
    return {
        type,
        id: crypto.randomUUID(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

function sessionRecord(fields: Record<string, string> = {}): MutableRecord {
    return record(RecordType.session, {
        title: "Fractions",
        subject: "Math",
        entry_id: crypto.randomUUID(),
        student_id: "anonymous",
        ...fields,
    });
}

function guideRecord(blocks: readonly Record<string, string>[]): MutableRecord {
    const fields = new Map<string, string>([
        ["title", "Fractions guide"],
        ["template_id", "general"],
        ["approval_state", "draft"],
        ["section_count", "1"],
        ["section.0.heading", "Key concepts"],
        ["section.0.block_count", String(blocks.length)],
    ]);
    blocks.forEach((block, index) => {
        const prefix = `section.0.block.${index}.`;
        fields.set(`${prefix}kind`, block["kind"] ?? "paragraph");
        fields.set(`${prefix}text`, block["text"] ?? "");
        fields.set(`${prefix}source_ids`, block["sourceIds"] ?? "");
        fields.set(`${prefix}stale`, block["stale"] ?? "false");
        fields.set(`${prefix}origin`, block["origin"] ?? "tutor-authored");
    });
    return {
        type: RecordType.guide,
        id: crypto.randomUUID(),
        revision: 0n,
        previousOffset: 0n,
        fields,
        blob: new Uint8Array(),
    };
}

function templateRecord(fields: Record<string, string>): MutableRecord {
    return record(RecordType.settings, {
        record_role: "guide-template",
        name: "Socratic review",
        subject: "General",
        description: "A question-led structure.",
        sections: "Session overview\nCustom section",
        body: "Ask one question at a time.",
        ...fields,
    });
}

function notesRecord(session: ArchiveRecord, text: string): MutableRecord {
    return record(RecordType.settings, {
        record_role: "journal-notes",
        session_id: session.id,
        block_count: "1",
        "block.0.id": crypto.randomUUID(),
        "block.0.kind": "paragraph",
        "block.0.text": text,
    });
}

describe("guide parity behavior", () => {
    it("preserves unknown block kinds and origins until an edit changes them", () => {
        const session = sessionRecord();
        const current = guideRecord([
            { kind: "future-block", origin: "imported-origin", text: "Keep this verbatim." },
        ]);
        current.fields.set("session_id", session.id);
        current.fields.set("entry_id", session.fields.get("entry_id")!);
        const draft = guideDraftFromRecord(current);
        expect(draft.sections[0]!.blocks[0]).toMatchObject({
            kind: "future-block",
            origin: "imported-origin",
        });

        const saved = makeGuideRecord(draft, { session, records: [session] }, current);
        expect(saved.fields.get("section.0.block.0.kind")).toBe("future-block");
        expect(saved.fields.get("section.0.block.0.origin")).toBe("imported-origin");
        const roundTrip = makeGuideRecord(draft, { session, records: [session] });
        expect(roundTrip.fields.get("section.0.block.0.kind")).toBe("future-block");

        draft.sections[0]!.blocks[0]!.kind = "paragraph";
        expect(() => makeGuideRecord(draft, { session, records: [session] }, current)).toThrow(
            "not supported",
        );

        const textEdit = guideDraftFromRecord(current);
        textEdit.sections[0]!.blocks[0]!.text = "Rewritten.";
        expect(() => makeGuideRecord(textEdit, { session, records: [session] }, current)).toThrow(
            "not supported",
        );
    });

    it("uses the session template before auto, resolves custom templates by name, and skips empty sections", () => {
        const template = templateRecord({});
        const session = sessionRecord({ guide_template_id: template.id, subject: "Math" });
        const annotation = record(RecordType.annotation, {
            session_id: session.id,
            type: "important-concept",
            content: "Scale both quantities.",
            start_time_us: "0",
        });
        const records = [session, template, annotation];

        const byId = generateGuideDraftFromSession(session, "auto", records, []);
        expect(byId.templateId).toBe(template.id);
        expect(byId.sections.map((section) => section.heading)).not.toContain("Custom section");

        const byName = generateGuideDraftFromSession(session, "Socratic review", records, []);
        expect(byName.templateId).toBe(template.id);
    });

    it("adds an Evidence status section when a template has no supported evidence", () => {
        const session = sessionRecord();
        const draft = generateGuideDraftFromSession(session, "general", [session], []);
        expect(draft.sections.map((section) => section.heading)).toEqual([
            "Session overview",
            "Evidence status",
        ]);
    });

    it("includes secondary session notes in generation and citation scope", () => {
        const session = sessionRecord();
        const notes = notesRecord(session, "A second notes document for this session.");
        const records = [session, notes];
        const draft = generateGuideDraftFromSession(session, "general", records, []);
        const noteSection = draft.sections.find((section) => section.heading === "Session notes");
        expect(noteSection?.blocks[0]?.text).toBe("A second notes document for this session.");
        expect(isGuideSourceInScope(notes.id, { session, records })).toBe(true);
    });

    it("applies and resolves built-in overrides", () => {
        const override = templateRecord({
            builtin_template_id: "general",
            name: "General · local",
            sections: "Session overview\nLocal section",
        });
        const templates = resolveGuideTemplates([override]);
        expect(templates[0]).toMatchObject({
            id: "general",
            name: "General · local",
            sections: ["Session overview", "Local section"],
        });
        expect(GUIDE_TEMPLATES[0]!.sections).toContain("Terminology");
    });

    it("treats approved guides as new drafts when regenerated", () => {
        const draftGuide = guideRecord([]);
        expect(guideRegenerationTarget(draftGuide)).toBe(draftGuide);
        draftGuide.fields.set("approval_state", "approved");
        expect(guideRegenerationTarget(draftGuide)).toBeNull();
    });

    it("replaces only the regenerated section and ignores unrelated edits", () => {
        const draft = {
            title: "Guide",
            sessionId: "session",
            templateId: "general",
            sections: [
                { id: "one", heading: "Key concepts", blocks: [] },
                {
                    id: "two",
                    heading: "Practice",
                    blocks: [
                        {
                            kind: "paragraph",
                            text: "Mine",
                            sourceIds: "",
                            stale: false,
                            origin: "tutor-authored" as const,
                        },
                    ],
                },
            ],
        };
        const generated = {
            title: "Guide",
            sessionId: "session",
            templateId: "general",
            sections: [
                {
                    id: "new",
                    heading: "Key concepts",
                    blocks: [
                        {
                            kind: "quote",
                            text: "Evidence",
                            sourceIds: "",
                            stale: false,
                            origin: "session-evidence" as const,
                        },
                    ],
                },
            ],
        };
        const updated = replaceGuideSectionFromGenerated(draft, 0, generated);
        expect(updated.sections[0]!.blocks[0]!.text).toBe("Evidence");
        expect(updated.sections[1]).toBe(draft.sections[1]);
        expect(() => replaceGuideSectionFromGenerated(draft, 1, generated)).toThrow(
            "No current evidence",
        );
    });

    it("inserts a cited archive image markdown block", () => {
        const asset = record(RecordType.assetMetadata, {
            title: "Bar model",
            mime_type: "image/png",
            session_id: crypto.randomUUID(),
        });
        const draft = {
            title: "Guide",
            sessionId: "",
            templateId: "general",
            sections: [
                { id: "one", heading: "Examples", blocks: [] },
                { id: "two", heading: "Sources", blocks: [] },
            ],
        };
        const updated = insertGuideImageBlock(draft, 0, asset);
        expect(updated.sections[0]!.blocks[0]).toMatchObject({
            kind: "image",
            text: `![Bar model](asset:${asset.id})`,
            sourceIds: asset.id,
        });
        expect(updated.sections[1]!.blocks).toHaveLength(0);
    });

    it("refuses invalid exports and accepts a valid cited guide", () => {
        const session = sessionRecord();
        const valid = guideRecord([
            { kind: "paragraph", text: "Scale both quantities.", sourceIds: session.id },
        ]);
        valid.fields.set("session_id", session.id);
        valid.fields.set("entry_id", session.fields.get("entry_id")!);
        expect(() => validateGuideForExport(valid, { session, records: [session] })).not.toThrow();

        const unknown = guideRecord([{ kind: "future-block", text: "Unknown." }]);
        expect(() => validateGuideForExport(unknown)).toThrow("not supported for export");

        const badTable = guideRecord([{ kind: "table", text: "| one |" }]);
        expect(() => validateGuideForExport(badTable)).toThrow("separator");

        const outOfScope = guideRecord([
            { kind: "paragraph", text: "Unlinked.", sourceIds: crypto.randomUUID() },
        ]);
        outOfScope.fields.set("session_id", session.id);
        expect(() => validateGuideForExport(outOfScope, { session, records: [session] })).toThrow(
            "missing or does not belong",
        );

        const noHeading = guideRecord([]);
        noHeading.fields.set("section.0.heading", " ");
        expect(() => validateGuideForExport(noHeading)).toThrow("needs a heading");

        const asset = record(RecordType.assetMetadata, {
            title: "Notes",
            mime_type: "text/plain",
            session_id: session.id,
        });
        const wrongImage = guideRecord([
            { kind: "image", text: `![Notes](asset:${asset.id})`, sourceIds: asset.id },
        ]);
        wrongImage.fields.set("session_id", session.id);
        expect(() =>
            validateGuideForExport(wrongImage, { session, records: [session, asset] }),
        ).toThrow("not a supported image");
    });
});
