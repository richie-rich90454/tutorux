import { describe, expect, it } from "vitest";
import { RecordType } from "../../../frontend/archive/format";
import {
    guideTemplateFromRecord,
    makeCustomGuideTemplateRecord,
    parseGuideTemplateImport,
    serializeGuideTemplate,
} from "../../../frontend/domain/templates";

describe("custom guide templates", () => {
    it("creates and updates an archive-compatible template record", () => {
        const created = makeCustomGuideTemplateRecord({
            name: "Socratic review",
            subject: "General",
            description: "A question-led structure.",
            sections: ["Starting point", "Questions", "Next steps"],
            body: "Keep each question grounded in the lesson.",
        });
        const updated = makeCustomGuideTemplateRecord(
            {
                name: "Socratic review · revised",
                subject: "General",
                description: "A clear, question-led structure.",
                sections: ["Starting point", "Questions", "Evidence", "Next steps"],
                body: "Keep each question grounded in the lesson.",
            },
            created,
        );

        expect(created.fields.get("record_role")).toBe("guide-template");
        expect(updated.id).toBe(created.id);
        expect(updated.fields.get("created_at_us")).toBe(created.fields.get("created_at_us"));
        expect(updated.fields.get("sections")).toBe(
            "Starting point\nQuestions\nEvidence\nNext steps",
        );
        expect(guideTemplateFromRecord(updated)).toMatchObject({
            id: created.id,
            name: "Socratic review · revised",
            sections: ["Starting point", "Questions", "Evidence", "Next steps"],
        });
    });

    it("round-trips the portable template JSON format", () => {
        const input = {
            name: "Language reflection",
            subject: "Languages",
            description: "A short reflection scaffold.",
            sections: ["Vocabulary", "Corrections", "Practice"],
            body: "Preserve uncertain points as uncertain.",
        };
        const imported = parseGuideTemplateImport(
            serializeGuideTemplate({ id: "template", ...input }),
        );
        expect(imported).toEqual(input);
    });

    it("imports plain text and Markdown files as editorial guidance", () => {
        const text = parseGuideTemplateImport(
            "# Review\n\nAsk one question at a time.",
            "review.md",
        );
        expect(text).toMatchObject({
            name: "review",
            subject: "general",
            description: "",
            sections: [],
            body: "# Review\n\nAsk one question at a time.",
        });
        const jsonBody = parseGuideTemplateImport('{"subject":"x"}', "notes.json");
        expect(jsonBody.body).toBe('{"subject":"x"}');
    });

    it("creates and updates built-in overrides without touching custom templates", () => {
        const created = makeCustomGuideTemplateRecord({
            name: "General tutoring · local",
            subject: "general",
            description: "Local wording.",
            sections: ["Session overview", "Key concepts"],
            body: "Use local examples.",
            builtinTemplateId: "general",
        });
        expect(created.fields.get("builtin_template_id")).toBe("general");
        const updated = makeCustomGuideTemplateRecord(
            {
                name: "General tutoring · revised",
                subject: "general",
                description: "Revised wording.",
                sections: ["Session overview", "Key concepts", "Sources"],
                body: "Use local examples.",
            },
            created,
        );
        expect(updated.id).toBe(created.id);
        expect(updated.fields.get("builtin_template_id")).toBe("general");
    });

    it("allows a plain-text template with no section catalog", () => {
        const record = makeCustomGuideTemplateRecord({
            name: "Plain guidance",
            subject: "general",
            description: "",
            sections: [],
            body: "Use this as writing guidance only.",
        });
        expect(guideTemplateFromRecord(record).sections).toEqual([]);
    });

    it("preserves commas and semicolons within section headings", () => {
        const record = makeCustomGuideTemplateRecord({
            name: "Compare and connect",
            subject: "General",
            description: "Keep punctuation inside headings intact.",
            sections: ["Causes, effects", "Claim; counterclaim"],
            body: "",
        });
        const template = guideTemplateFromRecord(record);
        const imported = parseGuideTemplateImport(serializeGuideTemplate(template));

        expect(template.sections).toEqual(["Causes, effects", "Claim; counterclaim"]);
        expect(imported.sections).toEqual(template.sections);
    });

    it("rejects incomplete, oversized, and malformed templates", () => {
        expect(() =>
            makeCustomGuideTemplateRecord({
                name: "  ",
                subject: "General",
                description: "",
                sections: ["Overview"],
                body: "",
            }),
        ).toThrow("Template name is required");
        expect(() =>
            makeCustomGuideTemplateRecord({
                name: "Empty",
                subject: "General",
                description: "",
                sections: [" "],
                body: "",
            }),
        ).toThrow("Every template section needs a heading");
        expect(() =>
            makeCustomGuideTemplateRecord({
                name: "Ambiguous heading",
                subject: "General",
                description: "",
                sections: ["Opening\nEvidence"],
                body: "",
            }),
        ).toThrow("cannot contain line breaks");
        expect(() => parseGuideTemplateImport('{"format":"wrong"}')).toThrow(
            "format must be tutorux-guide-template-v1",
        );
    });

    it("rejects records that are not guide templates", () => {
        const created = makeCustomGuideTemplateRecord({
            name: "Valid",
            subject: "General",
            description: "",
            sections: [],
            body: "",
        });
        expect(() =>
            makeCustomGuideTemplateRecord(
                { name: "X", subject: "", description: "", sections: [], body: "" },
                { ...created, type: RecordType.guide },
            ),
        ).toThrow("Only a custom guide template");
        expect(() =>
            makeCustomGuideTemplateRecord(
                {
                    name: "X",
                    subject: "",
                    description: "",
                    sections: [],
                    body: "",
                },
                { ...created, fields: new Map([["record_role", "other"]]) },
            ),
        ).toThrow("Only a custom guide template");
        expect(() => guideTemplateFromRecord({ ...created, type: RecordType.guide })).toThrow(
            "Select a saved guide template",
        );
        expect(() => guideTemplateFromRecord({ ...created, fields: new Map() })).toThrow(
            "Select a saved guide template",
        );
    });

    it("falls back to template defaults for sparse records", () => {
        const created = makeCustomGuideTemplateRecord({
            name: "Valid",
            subject: "General",
            description: "",
            sections: [],
            body: "",
        });
        const sparse = { ...created, fields: new Map([["record_role", "guide-template"]]) };
        expect(guideTemplateFromRecord(sparse)).toEqual({
            id: created.id,
            name: "Untitled template",
            subject: "general",
            description: "",
            sections: [],
            body: "",
        });
    });

    it("refuses to change the built-in template a record overrides", () => {
        const created = makeCustomGuideTemplateRecord({
            name: "General override",
            subject: "general",
            description: "",
            sections: [],
            body: "",
            builtinTemplateId: "general",
        });
        expect(() =>
            makeCustomGuideTemplateRecord(
                {
                    name: "Other override",
                    subject: "general",
                    description: "",
                    sections: [],
                    body: "",
                    builtinTemplateId: "other",
                },
                created,
            ),
        ).toThrow("cannot change its built-in template");
    });

    it("validates field lengths and control characters", () => {
        const base = {
            name: "Valid",
            subject: "General",
            description: "",
            sections: [] as string[],
            body: "",
        };
        expect(() => makeCustomGuideTemplateRecord({ ...base, name: "a".repeat(241) })).toThrow(
            "240 characters or fewer",
        );
        expect(() => makeCustomGuideTemplateRecord({ ...base, subject: "a".repeat(129) })).toThrow(
            "128 characters or fewer",
        );
        expect(() =>
            makeCustomGuideTemplateRecord({ ...base, description: "a".repeat(4_097) }),
        ).toThrow("4096 characters or fewer");
        expect(() => makeCustomGuideTemplateRecord({ ...base, body: "a".repeat(100_001) })).toThrow(
            "100000 characters or fewer",
        );
        expect(() => makeCustomGuideTemplateRecord({ ...base, name: "bad\u0000name" })).toThrow(
            "unsupported control characters",
        );
        expect(() =>
            makeCustomGuideTemplateRecord({
                ...base,
                sections: Array.from({ length: 251 }, (_, index) => `Section ${index}`),
            }),
        ).toThrow("at most 250 sections");
    });

    it("rejects oversized import files", () => {
        expect(() => parseGuideTemplateImport("a".repeat(1024 * 1024 + 1))).toThrow("1 MiB limit");
    });

    it("validates every imported field", () => {
        const valid = {
            format: "tutorux-guide-template-v1",
            name: "Name",
            description: "",
            sections: [] as string[],
            body: "",
        };
        const raw = (patch: Record<string, unknown>) => JSON.stringify({ ...valid, ...patch });

        expect(() => parseGuideTemplateImport(raw({ name: 1 }))).toThrow(
            "Template name must be a string",
        );
        expect(() => parseGuideTemplateImport(raw({ description: 1 }))).toThrow(
            "Template description must be a string",
        );
        expect(() => parseGuideTemplateImport(raw({ body: 1 }))).toThrow(
            "Template guidance must be a string",
        );
        expect(() => parseGuideTemplateImport(raw({ sections: "x" }))).toThrow("array of strings");
        expect(() => parseGuideTemplateImport(raw({ sections: [1] }))).toThrow("array of strings");
        expect(parseGuideTemplateImport(raw({ subject: 7 })).subject).toBe("general");
    });

    it("derives a fallback name from empty or extensionless file names", () => {
        expect(parseGuideTemplateImport("plain", "").name).toBe("Imported template");
        expect(parseGuideTemplateImport("plain", ".txt").name).toBe("Imported template");
        expect(parseGuideTemplateImport("plain", "C:\\notes\\lesson").name).toBe("lesson");
    });
});
