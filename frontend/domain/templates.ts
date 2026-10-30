import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import type { GuideTemplate } from "./guides";

export interface GuideTemplateInput {
    name: string;
    subject: string;
    description: string;
    sections: readonly string[];
    body: string;
    builtinTemplateId?: string | undefined;
}

const TEMPLATE_FORMAT = "tutorux-guide-template-v1";
// Preserve newlines and tabs while rejecting other control characters in archive text fields.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function makeCustomGuideTemplateRecord(
    input: GuideTemplateInput,
    current: ArchiveRecord | null = null,
): ArchiveRecord {
    if (
        current &&
        (current.type !== RecordType.settings ||
            current.fields.get("record_role") !== "guide-template")
    ) {
        throw new Error("Only a custom guide template can be updated here.");
    }
    const builtinTemplateId =
        input.builtinTemplateId ?? current?.fields.get("builtin_template_id") ?? "";
    const currentBuiltinTemplateId = current?.fields.get("builtin_template_id") ?? "";
    if (
        currentBuiltinTemplateId &&
        builtinTemplateId &&
        currentBuiltinTemplateId !== builtinTemplateId
    ) {
        throw new Error("A built-in template override cannot change its built-in template.");
    }

    const name = cleanField(input.name, "Template name", 240).trim();
    if (!name) throw new Error("Template name is required.");
    const subject = cleanField(input.subject, "Template subject", 128);
    const description = cleanField(input.description, "Template description", 4_096);
    const body = cleanField(input.body, "Template guidance", 100_000);
    if (input.sections.length > 250)
        throw new Error("A template can contain at most 250 sections.");
    const sections = input.sections.map((section, index) => {
        const heading = cleanField(section, `Section ${index + 1}`, 256).trim();
        if (!heading) throw new Error("Every template section needs a heading.");
        if (/[\r\n]/u.test(heading)) {
            throw new Error("Template section headings cannot contain line breaks.");
        }
        return heading;
    });

    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    const fields = new Map(current?.fields ?? []);
    fields.set("record_role", "guide-template");
    fields.set("name", name);
    fields.set("subject", subject);
    fields.set("description", description);
    fields.set("sections", sections.join("\n"));
    fields.set("body", body);
    if (builtinTemplateId) fields.set("builtin_template_id", builtinTemplateId);
    else fields.delete("builtin_template_id");
    if (!current) fields.set("created_at_us", timestamp);
    fields.set("updated_at_us", timestamp);
    return {
        type: RecordType.settings,
        id: current?.id ?? newUuid(),
        revision: current?.revision ?? 0n,
        previousOffset: current?.previousOffset ?? 0n,
        blob: current?.blob ?? new Uint8Array(),
        fields,
    };
}

export function guideTemplateFromRecord(record: ArchiveRecord): GuideTemplate {
    if (
        record.type !== RecordType.settings ||
        record.fields.get("record_role") !== "guide-template"
    ) {
        throw new Error("Select a saved guide template.");
    }
    return {
        id: record.id,
        name: record.fields.get("name") ?? "Untitled template",
        subject: record.fields.get("subject") ?? "general",
        description: record.fields.get("description") ?? "",
        sections: (record.fields.get("sections") ?? "")
            .split(/\r?\n/u)
            .map((section) => section.trim())
            .filter(Boolean),
        body: record.fields.get("body") ?? "",
    };
}

export function parseGuideTemplateImport(
    contents: string,
    fileName = "Imported template",
): GuideTemplateInput {
    if (new TextEncoder().encode(contents).byteLength > 1024 * 1024) {
        throw new Error("Template file exceeds the 1 MiB limit.");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch {
        parsed = undefined;
    }
    const value =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    if (!value || !("format" in value)) {
        return {
            name: templateNameFromFileName(fileName),
            subject: "general",
            description: "",
            sections: [],
            body: contents,
        };
    }
    if (value["format"] !== TEMPLATE_FORMAT) {
        throw new Error(`Template format must be ${TEMPLATE_FORMAT}.`);
    }
    if (typeof value["name"] !== "string") throw new Error("Template name must be a string.");
    if (typeof value["description"] !== "string") {
        throw new Error("Template description must be a string.");
    }
    if (typeof value["body"] !== "string") throw new Error("Template guidance must be a string.");
    const sections = value["sections"];
    if (!Array.isArray(sections) || !sections.every((item) => typeof item === "string")) {
        throw new Error("Template sections must be an array of strings.");
    }
    return {
        name: value["name"],
        subject: typeof value["subject"] === "string" ? value["subject"] : "general",
        description: value["description"],
        sections,
        body: value["body"],
    };
}

function templateNameFromFileName(fileName: string): string {
    const name = fileName.split(/[\\/]/u).at(-1) ?? "";
    return name.replace(/\.[^.]+$/u, "").trim() || "Imported template";
}

export function serializeGuideTemplate(template: GuideTemplate): string {
    return `${JSON.stringify(
        {
            format: TEMPLATE_FORMAT,
            name: template.name,
            subject: template.subject,
            description: template.description,
            sections: template.sections,
            body: template.body,
        },
        null,
        2,
    )}\n`;
}

function cleanField(value: string, label: string, limit: number): string {
    if (value.length > limit) throw new Error(`${label} must be ${limit} characters or fewer.`);
    if (CONTROL_CHARACTERS.test(value))
        throw new Error(`${label} contains unsupported control characters.`);
    return value;
}
