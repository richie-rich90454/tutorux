import { describe, expect, it } from "vitest";
import {
  guideTemplateFromRecord,
  makeCustomGuideTemplateRecord,
  parseGuideTemplateImport,
  serializeGuideTemplate,
} from "./templates";

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
    expect(updated.fields.get("sections")).toBe("Starting point\nQuestions\nEvidence\nNext steps");
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
    const imported = parseGuideTemplateImport(serializeGuideTemplate({ id: "template", ...input }));
    expect(imported).toEqual(input);
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
    expect(() => parseGuideTemplateImport("not json")).toThrow("valid JSON");
    expect(() =>
      parseGuideTemplateImport(
        JSON.stringify({ format: "wrong", name: "Example", sections: ["Overview"] }),
      ),
    ).toThrow("format must be tutorux-guide-template-v1");
  });
});
