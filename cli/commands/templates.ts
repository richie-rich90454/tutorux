import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
    GUIDE_TEMPLATES,
    applyGuideTemplateOverride,
    builtInGuideTemplates,
} from "../../frontend/domain/guides";
import { moveRecordToTrash, restoreRecordFromTrash } from "../../frontend/domain/records";
import {
    makeCustomGuideTemplateRecord,
    parseGuideTemplateImport,
    type GuideTemplateInput,
} from "../../frontend/domain/templates";
import { closeSnapshot, mutateArchive, openForCommand, writeTextAtomically } from "./archive-io";
import {
    CliError,
    emit,
    field,
    requiredOption,
    requiredPosition,
    sameFileIdentity,
    timestampNow,
} from "./shared";
import { toPlainRecord, validateEvidenceText, validateUpdatedField } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runTemplateCommand(
    action: string,
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
    const json = args.flags.has("json");
    if (action === "list") {
        const snapshot = await openForCommand(path);
        try {
            const stored = await snapshot.listRecords(RecordType.settings);
            const rows: Record<string, unknown>[] = builtInGuideTemplates(stored).map(
                (template) => ({
                    id: template.id,
                    name: template.name,
                    origin: "built-in",
                    subject: template.subject,
                    description: template.description,
                    sections: [...template.sections],
                    body: template.body,
                }),
            );
            for (const record of stored) {
                if (
                    field(record, "record_role") !== "guide-template" ||
                    field(record, "builtin_template_id")
                )
                    continue;
                rows.push({
                    ...toPlainRecord(record),
                    origin: "custom",
                    sections: decodeStoredTemplateSections(field(record, "sections")),
                });
            }
            emit(
                output,
                rows,
                `${rows.length} study-guide template${rows.length === 1 ? "" : "s"}.`,
                json,
            );
            return 0;
        } finally {
            await closeSnapshot(snapshot);
        }
    }

    if (action === "show" || action === "export") {
        const idOrName = requiredPosition(args, 0, "template ID or name");
        const snapshot = await openForCommand(path);
        let template: Record<string, unknown>;
        try {
            const stored = await snapshot.listRecords(RecordType.settings);
            const builtin = GUIDE_TEMPLATES.find(
                (item) => item.id.toLocaleLowerCase() === idOrName.toLocaleLowerCase(),
            );
            if (builtin) {
                const effective = applyGuideTemplateOverride(builtin, stored);
                template = {
                    id: effective.id,
                    name: effective.name,
                    origin: "built-in",
                    subject: effective.subject,
                    description: effective.description,
                    sections: [...effective.sections],
                    body: effective.body,
                };
            } else {
                const record = stored.find(
                    (item) =>
                        field(item, "record_role") === "guide-template" &&
                        (item.id.toLowerCase() === idOrName.toLowerCase() ||
                            field(item, "name").toLocaleLowerCase() ===
                                idOrName.toLocaleLowerCase()),
                );
                if (!record) throw new CliError(`Template “${idOrName}” was not found.`);
                template = customTemplateValue(record);
            }
        } finally {
            await closeSnapshot(snapshot);
        }
        if (action === "show") {
            if (json) emit(output, template, "", true);
            else {
                output.stdout(
                    `${String(template["name"])}\n${String(template["description"] ?? "")}\n\n${(template["sections"] as string[]).join("\n")}`,
                );
            }
            return 0;
        }
        const outputPath = args.options.get("output");
        if (!outputPath) throw new CliError("--output is required.");
        const destination = resolve(outputPath);
        if (await sameFileIdentity(destination, path))
            throw new CliError("Template output cannot replace its source archive.");
        const exported = {
            format: "tutorux-guide-template-v1",
            name: template["name"],
            subject: template["subject"],
            description: template["description"],
            sections: template["sections"],
            body: template["body"],
        };
        await writeTextAtomically(destination, `${JSON.stringify(exported, null, 2)}\n`);
        emit(
            output,
            { id: template["id"], output: destination },
            `Exported template to ${destination}.`,
            json,
        );
        return 0;
    }

    if (action === "create" || action === "import") {
        const imported =
            action === "import" ? await readTemplateImport(requiredOption(args, "input")) : null;
        const name = args.options.get("name")?.trim() || imported?.name || "";
        if (!name) throw new CliError("--name is required.");
        const sections = args.options.has("sections")
            ? parseTemplateSectionArgument(args.options.get("sections")!)
            : (imported?.sections ?? []);
        if (!sections.length && action !== "import")
            throw new CliError("Provide at least one template section with --sections.");
        const record = makeCustomGuideTemplateRecord({
            name,
            subject: args.options.get("subject") ?? imported?.subject ?? "general",
            description: args.options.get("description") ?? imported?.description ?? "",
            sections,
            body: args.options.get("body") ?? imported?.body ?? "",
        });
        const saved = (await mutateArchive(path, [record]))[0] ?? record;
        emit(
            output,
            toPlainRecord(saved),
            `Created template ${field(saved, "name")} (${saved.id}).`,
            json,
        );
        return 0;
    }

    if (action === "update" || action === "delete" || action === "restore") {
        const id = requiredPosition(args, 0, "template ID");
        const builtin = GUIDE_TEMPLATES.find(
            (template) => template.id.toLocaleLowerCase() === id.toLocaleLowerCase(),
        );
        if (builtin && (action === "update" || action === "delete")) {
            const snapshot = await openForCommand(path);
            let stored: ArchiveRecord[];
            let override: ArchiveRecord | undefined;
            try {
                stored = await snapshot.listRecords(RecordType.settings, true);
                const matching = stored.filter(
                    (record) =>
                        field(record, "record_role") === "guide-template" &&
                        field(record, "builtin_template_id") === builtin.id,
                );
                override =
                    matching.find((record) => field(record, "_deleted") !== "true") ?? matching[0];
            } finally {
                await closeSnapshot(snapshot);
            }
            if (action === "delete") {
                if (!override || field(override, "_deleted") === "true") {
                    emit(
                        output,
                        { id: builtin.id, restored: true },
                        "Built-in template restored to its defaults.",
                        json,
                    );
                    return 0;
                }
                const removed = moveRecordToTrash(override);
                const saved = (await mutateArchive(path, [removed]))[0] ?? removed;
                emit(
                    output,
                    toPlainRecord(saved),
                    "Built-in template restored to its defaults.",
                    json,
                );
                return 0;
            }
            if (override && field(override, "_deleted") === "true")
                throw new CliError(`Template ${id} is in Trash. Restore it before updating.`);
            const existingSections = override
                ? decodeStoredTemplateSections(field(override, "sections"))
                : [];
            const record = makeCustomGuideTemplateRecord(
                {
                    name: args.options.has("name")
                        ? requiredOption(args, "name")
                        : (override ? field(override, "name") : "") || builtin.name,
                    subject: args.options.has("subject")
                        ? args.options.get("subject")!
                        : (override ? field(override, "subject") : "") || builtin.subject,
                    description: args.options.has("description")
                        ? args.options.get("description")!
                        : (override ? field(override, "description") : "") || builtin.description,
                    sections: args.options.has("sections")
                        ? validateTemplateSections(
                              parseTemplateSectionArgument(args.options.get("sections")!),
                          )
                        : existingSections.length
                          ? existingSections
                          : [...builtin.sections],
                    body: args.options.has("body")
                        ? args.options.get("body")!
                        : (override ? field(override, "body") : "") || builtin.body,
                    builtinTemplateId: builtin.id,
                },
                override ?? null,
            );
            const saved = (await mutateArchive(path, [record]))[0] ?? record;
            emit(output, toPlainRecord(saved), "Built-in template override updated.", json);
            return 0;
        }

        const snapshot = await openForCommand(path);
        let current: ArchiveRecord;
        try {
            const candidate = await snapshot.getRecord(RecordType.settings, id);
            if (!candidate || field(candidate, "record_role") !== "guide-template") {
                throw new CliError(`Template ${id} was not found.`);
            }
            if (action === "delete" && field(candidate, "_deleted") === "true")
                throw new CliError(`Template ${id} is already in Trash.`);
            if (action === "restore" && field(candidate, "_deleted") !== "true")
                throw new CliError(`Template ${id} is not in Trash.`);
            if (action === "update" && field(candidate, "_deleted") === "true")
                throw new CliError(`Template ${id} is in Trash. Restore it before updating.`);
            current = candidate;
        } finally {
            await closeSnapshot(snapshot);
        }
        let updated: ArchiveRecord;
        if (action === "delete") updated = moveRecordToTrash(current);
        else if (action === "restore") updated = restoreRecordFromTrash(current);
        else {
            const fields = new Map(current.fields);
            if (args.options.has("name"))
                fields.set("name", validateUpdatedField("title", requiredOption(args, "name")));
            if (args.options.has("subject"))
                fields.set(
                    "subject",
                    validateEvidenceText(args.options.get("subject")!, "Template subject", 128),
                );
            if (args.options.has("description"))
                fields.set(
                    "description",
                    validateEvidenceText(
                        args.options.get("description")!,
                        "Template description",
                        4_096,
                    ),
                );
            if (args.options.has("sections")) {
                const sections = validateTemplateSections(
                    parseTemplateSectionArgument(args.options.get("sections")!),
                );
                fields.set("sections", sections.join("\n"));
            }
            if (args.options.has("body"))
                fields.set(
                    "body",
                    validateEvidenceText(args.options.get("body")!, "Template body", 100_000),
                );
            if (
                !["name", "subject", "description", "sections", "body"].some((key) =>
                    args.options.has(key),
                )
            ) {
                throw new CliError("Provide a template field to update.");
            }
            fields.set("updated_at_us", timestampNow());
            updated = { ...current, fields };
        }
        const saved = (await mutateArchive(path, [updated]))[0] ?? updated;
        const message =
            action === "delete"
                ? "Template moved to Trash."
                : action === "restore"
                  ? "Template restored."
                  : "Template updated.";
        emit(output, toPlainRecord(saved), message, json);
        return 0;
    }

    throw new CliError(`template ${action} is not implemented in the TypeScript CLI yet.`);
}

export function parseTemplateSectionArgument(value: string): string[] {
    return value
        .split(/[\r\n,;]/u)
        .map((heading) => heading.trim())
        .filter(Boolean);
}

export function decodeStoredTemplateSections(value: string): string[] {
    const sections = /[\r\n]/u.test(value) ? value.split(/\r\n|\r|\n/u) : [value];
    return sections.map((heading) => heading.trim()).filter(Boolean);
}

export function validateTemplateSections(sections: readonly string[]): string[] {
    if (sections.length > 250) throw new CliError("A template can contain at most 250 sections.");
    return sections.map((heading, index) => {
        const value = validateEvidenceText(heading, `Template section ${index + 1}`, 256).trim();
        if (!value) throw new CliError("Every template section needs a heading.");
        return value;
    });
}

export function customTemplateValue(record: ArchiveRecord): Record<string, unknown> {
    return {
        id: record.id,
        name: field(record, "name"),
        origin: field(record, "builtin_template_id") ? "built-in override" : "custom",
        subject: field(record, "subject"),
        description: field(record, "description"),
        sections: decodeStoredTemplateSections(field(record, "sections")),
        body: field(record, "body"),
    };
}

export async function readTemplateImport(inputPath: string): Promise<GuideTemplateInput> {
    const absolutePath = resolve(inputPath);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink())
        throw new CliError("Template input must be a regular, non-symlink file.");
    if (info.size > 1024 * 1024) throw new CliError("Template input exceeds the 1 MiB limit.");
    return parseGuideTemplateImport(await readFile(absolutePath, "utf8"), basename(absolutePath));
}
