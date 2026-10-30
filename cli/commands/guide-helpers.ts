import type { ArchiveSnapshot } from "../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
    GUIDE_BLOCK_KINDS,
    guideDraftFromRecord,
    type GuideBlockKind,
    type GuideDraft,
    type GuideSourceScope,
} from "../../frontend/domain/guides";
import { moveRecordToTrash } from "../../frontend/domain/records";
import { closeSnapshot, openForCommand } from "./archive-io";
import { CliError, field, parseBoundedOption } from "./shared";
import { requireLiveRecord } from "./record-helpers";
import type { ParsedArguments } from "./shared";

export function updateGuideBlock(
    block: GuideDraft["sections"][number]["blocks"][number],
    args: ParsedArguments,
): void {
    if (args.flags.has("clear-sources") && args.options.has("sources"))
        throw new CliError("Choose --sources or --clear-sources, not both.");
    if (args.options.has("text")) {
        block.text = args.options.get("text")!;
        block.stale = false;
        block.origin = "human-edited";
    }
    if (args.options.has("kind")) {
        block.kind = validateGuideKind(args.options.get("kind")!);
        block.stale = false;
        if (block.origin === "ai-generated") block.origin = "human-edited";
    }
    if (args.options.has("sources") || args.flags.has("clear-sources")) {
        block.sourceIds = args.options.get("sources") ?? "";
        block.stale = false;
    }
    if (args.flags.has("mark-reviewed")) block.stale = false;
}

export function guideBlock(
    kind: string,
    text: string,
    sourceIds: string,
): GuideDraft["sections"][number]["blocks"][number] {
    return {
        kind: validateGuideKind(kind),
        text,
        sourceIds,
        stale: false,
        origin: "tutor-authored",
    };
}

export function moveGuideToTrash(record: ArchiveRecord): ArchiveRecord {
    const removed = moveRecordToTrash(record);
    const fields = new Map(removed.fields);
    fields.set("_trash_group_id", record.id);
    return { ...removed, fields };
}

export function validateGuideKind(value: string): GuideBlockKind {
    if ((GUIDE_BLOCK_KINDS as readonly string[]).includes(value)) return value as GuideBlockKind;
    throw new CliError(`Guide block kind “${value}” is not supported.`);
}

export function guideIndex(raw: string | undefined, name: string, length: number): number {
    const value = parseBoundedOption(raw, name, -1, 0, Math.max(0, length - 1));
    if (value >= length) throw new CliError(`--${name} is outside the available range.`);
    return value;
}

export async function readGuideScope(
    snapshot: ArchiveSnapshot,
    sessionId: string,
): Promise<GuideSourceScope & { session: ArchiveRecord }> {
    const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
    return { session, records: await readGuideSourceRecords(snapshot) };
}

export async function readGuideEntryScope(
    snapshot: ArchiveSnapshot,
    entryId: string,
): Promise<GuideSourceScope & { entry: ArchiveRecord }> {
    const entry = await requireLiveRecord(snapshot, RecordType.settings, entryId);
    if (field(entry, "record_role") !== "journal-entry")
        throw new CliError(`Journal entry ${entryId} was not found.`);
    return { entry, records: await readGuideSourceRecords(snapshot) };
}

export async function readGuideSourceRecords(snapshot: ArchiveSnapshot): Promise<ArchiveRecord[]> {
    const [students, sessions, settings, transcripts, annotations, assets, evidence] =
        await Promise.all([
            snapshot.listRecords(RecordType.student),
            snapshot.listRecords(RecordType.session),
            snapshot.listRecords(RecordType.settings),
            snapshot.listRecords(RecordType.transcriptSegment),
            snapshot.listRecords(RecordType.annotation),
            snapshot.listRecords(RecordType.assetMetadata),
            snapshot.listRecords(RecordType.evidenceNode),
        ]);
    return [
        ...students,
        ...sessions,
        ...settings,
        ...transcripts,
        ...annotations,
        ...assets,
        ...evidence,
    ];
}

export async function readGuideContext(
    path: string,
    id: string,
): Promise<{ current: ArchiveRecord; draft: GuideDraft; scope: GuideSourceScope }> {
    const snapshot = await openForCommand(path);
    try {
        const current = await requireLiveRecord(snapshot, RecordType.guide, id);
        const draft = guideDraftFromRecord(current);
        const scope = draft.sessionId
            ? await readGuideScope(snapshot, draft.sessionId)
            : draft.entryId
              ? await readGuideEntryScope(snapshot, draft.entryId)
              : null;
        if (!scope) throw new CliError("This guide has no journal entry or session scope.");
        return { current, draft, scope };
    } finally {
        await closeSnapshot(snapshot);
    }
}
