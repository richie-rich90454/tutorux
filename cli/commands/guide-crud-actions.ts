import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
    createGuideDraft,
    createGuideDraftFromSections,
    generateGuideDraftFromEntry,
    generateGuideDraftFromSession,
    guideRecordsWithEntryLinks,
    makeGuideRecord,
    resolveGuideTemplates,
    type GuideDraft,
} from "../../frontend/domain/guides";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { readGuideEntryScope, readGuideScope } from "./guide-helpers";
import { CliError, emit, field, requiredOption } from "./shared";
import { toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function guideListAction(
    path: string,
    args: ParsedArguments,
    output: CliIo,
    json: boolean,
): Promise<number> {
    const snapshot = await openForCommand(path);
    try {
        let records = await snapshot.listRecords(
            RecordType.guide,
            args.flags.has("include-deleted"),
        );
        const sessionId = args.options.get("session")?.toLowerCase();
        if (sessionId)
            records = records.filter(
                (record) => field(record, "session_id").toLowerCase() === sessionId,
            );
        const entryId = args.options.get("entry-id")?.toLowerCase();
        if (entryId) {
            const sessions = await snapshot.listRecords(RecordType.session);
            const sessionIds = new Set(
                sessions
                    .filter((session) => field(session, "entry_id").toLowerCase() === entryId)
                    .map((session) => session.id.toLowerCase()),
            );
            records = records.filter(
                (record) =>
                    field(record, "entry_id").toLowerCase() === entryId ||
                    sessionIds.has(field(record, "session_id").toLowerCase()),
            );
        }
        const rows = records.map(toPlainRecord);
        emit(
            output,
            rows,
            rows.length
                ? `${rows.length} study guide${rows.length === 1 ? "" : "s"}.`
                : "No study guides.",
            json,
        );
        return 0;
    } finally {
        await closeSnapshot(snapshot);
    }
}

export async function guideCreateAction(
    path: string,
    args: ParsedArguments,
    output: CliIo,
    json: boolean,
): Promise<number> {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord;
    let changes: ArchiveRecord[];
    try {
        const scope = await readGuideScope(snapshot, sessionId);
        const requestedTemplate = args.options.get("template");
        let draft: GuideDraft;
        if (!requestedTemplate) draft = createGuideDraft(scope.session);
        else {
            const templates = resolveGuideTemplates(scope.records);
            const template = templates.find(
                (candidate) =>
                    candidate.id.toLocaleLowerCase() === requestedTemplate.toLocaleLowerCase() ||
                    candidate.name.toLocaleLowerCase() === requestedTemplate.toLocaleLowerCase(),
            );
            if (!template) throw new CliError(`Template “${requestedTemplate}” was not found.`);
            draft = createGuideDraftFromSections(scope.session, template.id, template.sections);
        }
        if (args.options.has("title")) draft.title = args.options.get("title")!;
        record = makeGuideRecord(draft, scope);
        changes = guideRecordsWithEntryLinks(record, null, scope.records);
    } finally {
        await closeSnapshot(snapshot);
    }
    const saved = (await mutateArchive(path, changes))[0] ?? record;
    emit(
        output,
        toPlainRecord(saved),
        `Created study guide ${field(saved, "title")} (${saved.id}).`,
        json,
    );
    return 0;
}

export async function guideGenerateAction(
    path: string,
    args: ParsedArguments,
    output: CliIo,
    json: boolean,
): Promise<number> {
    const sessionId = args.options.get("session")?.toLowerCase();
    const entryId = args.options.get("entry-id")?.toLowerCase();
    if (Boolean(sessionId) === Boolean(entryId)) {
        throw new CliError("Provide exactly one of --session or --entry-id.");
    }
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord;
    let changes: ArchiveRecord[];
    try {
        const scope = sessionId
            ? await readGuideScope(snapshot, sessionId)
            : await readGuideEntryScope(snapshot, entryId!);
        const students = scope.records.filter((item) => item.type === RecordType.student);
        const templates = resolveGuideTemplates(scope.records);
        const draft = scope.session
            ? generateGuideDraftFromSession(
                  scope.session,
                  args.options.get("template") ?? "auto",
                  scope.records,
                  students,
                  templates,
                  args.flags.has("include-entry-evidence"),
              )
            : generateGuideDraftFromEntry(
                  scope.entry!,
                  args.options.get("template") ?? "auto",
                  scope.records,
                  students,
                  templates,
              );
        if (args.options.has("title")) draft.title = args.options.get("title")!;
        record = makeGuideRecord(draft, scope);
        changes = guideRecordsWithEntryLinks(record, null, scope.records);
    } finally {
        await closeSnapshot(snapshot);
    }
    const saved = (await mutateArchive(path, changes))[0] ?? record;
    emit(
        output,
        toPlainRecord(saved),
        `Generated study guide ${field(saved, "title")} (${saved.id}).`,
        json,
    );
    return 0;
}
