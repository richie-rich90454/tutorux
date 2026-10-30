import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
    cloneSessionRecords,
    setSessionArchiveState,
    transitionSessionRecord,
    type SessionCloneInput,
    type SessionTransitionAction,
} from "../../frontend/domain/records";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { emit, field, requiredPosition } from "./shared";
import {
    getJournalEntry,
    getLiveRecordAtPath,
    requireLiveRecord,
    toPlainRecord,
} from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runSessionTransitionCommand(
    group: string,
    action: string,
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number | null> {
    const json = args.flags.has("json");

    if (group === "session" && action === "clone") {
        const sessionId = requiredPosition(args, 0, "session ID");
        const snapshot = await openForCommand(path);
        let records: ArchiveRecord[];
        let expectedGeneration: bigint;
        try {
            expectedGeneration = snapshot.commit.generation;
            const current = await requireLiveRecord(snapshot, RecordType.session, sessionId);
            const linkedEntryId = field(current, "entry_id");
            const linkedEntry = linkedEntryId
                ? await getJournalEntry(snapshot, linkedEntryId)
                : null;
            const settings = await snapshot.listRecords(RecordType.settings);
            const hasJournalRoot = settings.some(
                (record) =>
                    field(record, "record_role") === "journal" &&
                    field(record, "_deleted") !== "true",
            );
            const input: SessionCloneInput = {
                ...(args.options.has("title") ? { title: args.options.get("title")! } : {}),
                ...(args.options.has("type") ? { sessionType: args.options.get("type")! } : {}),
                ensureJournalRoot: !hasJournalRoot,
            };
            records = cloneSessionRecords(current, linkedEntry, input);
        } finally {
            await closeSnapshot(snapshot);
        }
        const saved = await mutateArchive(
            path,
            records,
            expectedGeneration,
            "The archive changed while this session copy was being prepared. Retry the clone.",
        );
        const session = saved[0] ?? records[0]!;
        emit(
            output,
            toPlainRecord(session),
            `Cloned session ${sessionId} as ${field(session, "title")} (${session.id}).`,
            json,
        );
        return 0;
    }

    if (group === "session" && (action === "archive" || action === "unarchive")) {
        const sessionId = requiredPosition(args, 0, "session ID");
        const snapshot = await openForCommand(path);
        let updated: ArchiveRecord;
        let expectedGeneration: bigint;
        try {
            expectedGeneration = snapshot.commit.generation;
            const current = await requireLiveRecord(snapshot, RecordType.session, sessionId);
            updated = setSessionArchiveState(current, action === "archive");
        } finally {
            await closeSnapshot(snapshot);
        }
        const [saved] = await mutateArchive(
            path,
            [updated],
            expectedGeneration,
            "The archive changed while this session archive state was being updated. Retry the command.",
        );
        const session = saved ?? updated;
        emit(
            output,
            toPlainRecord(session),
            action === "archive"
                ? `Archived session ${sessionId}.`
                : `Returned session ${sessionId} to current sessions.`,
            json,
        );
        return 0;
    }

    if (group === "session" && ["start", "resume", "complete", "review"].includes(action)) {
        const sessionId = requiredPosition(args, 0, "session ID");
        const transition = action as SessionTransitionAction;
        const current = await getLiveRecordAtPath(path, RecordType.session, sessionId);
        const updated = transitionSessionRecord(current, transition);
        const [session] = await mutateArchive(path, [updated]);
        const actionMessage: Record<SessionTransitionAction, string> = {
            start: "started",
            complete: "completed",
            review: "marked reviewed",
            resume: "resumed",
        };
        emit(
            output,
            toPlainRecord(session ?? updated),
            `Session ${sessionId} ${actionMessage[transition]}.`,
            json,
        );
        return 0;
    }

    return null;
}
