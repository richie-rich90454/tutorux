import { createHash } from "node:crypto";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
    loadSessionAudioTrashChanges,
    planSessionRestore,
    planSessionTrash,
} from "../../frontend/domain/session-trash";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { CliError, emit, field, requiredPosition, timestampNow } from "./shared";
import {
    getJournalEntry,
    getJournalEntryAtPath,
    getLiveRecordAtPath,
    getRecordAtPath,
    requireLiveRecord,
    toPlainRecord,
    updateFields,
} from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runLifecycleRecordCommand(
    group: string,
    action: string,
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number | null> {
    const id = args.positionals[0];
    const json = args.flags.has("json");
    const recordType =
        group === "student"
            ? RecordType.student
            : group === "session"
              ? RecordType.session
              : RecordType.settings;

    if (group === "session" && action === "delete") {
        const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
        const snapshot = await openForCommand(path);
        let changes: ArchiveRecord[];
        let generation: bigint | undefined;
        let scope: Awaited<ReturnType<typeof planSessionTrash>> | undefined;
        try {
            const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
            try {
                scope = await planSessionTrash(snapshot, session);
            } catch (error) {
                throw new CliError(
                    error instanceof Error
                        ? error.message
                        : "Unable to review the session deletion scope.",
                );
            }
            generation = snapshot.commit.generation;
            changes = scope.changes;
        } finally {
            await closeSnapshot(snapshot);
        }
        if (!scope || generation === undefined) {
            throw new CliError("Unable to prepare the session deletion scope.");
        }

        const scopeMaterial = scope.scopeRecords
            .map((record) => `${record.type}:${record.id.toLowerCase()}:${record.revision}`)
            .sort()
            .map((part) => `${part}\n`)
            .join("");
        const scopeToken = createHash("sha256").update(scopeMaterial).digest("hex");
        const summary = {
            status: "confirmation-required",
            session_id: sessionId,
            scope_token: scopeToken,
            audio_chunks: String(scope.counts.audioChunks),
            waveform_indices: String(scope.counts.waveformIndices),
            session_notes: String(scope.counts.sessionNotes),
            transcript_segments: String(scope.counts.transcriptSegments),
            annotations: String(scope.counts.annotations),
            guides: String(scope.counts.guides),
            assets: String(scope.counts.assets),
            entries_updated: String(scope.counts.entriesUpdated),
            evidence_nodes: String(scope.counts.evidenceNodes),
            evidence_edges: String(scope.counts.evidenceEdges),
            total_records: String(scope.counts.totalRecords),
        };
        const recordsMoved = scope.counts.totalRecords - scope.counts.entriesUpdated;
        if (args.flags.has("dry-run") || !args.flags.has("confirm-scope")) {
            emit(
                output,
                summary,
                `Deleting this session would affect ${scope.counts.totalRecords} records: move ${recordsMoved} to Trash, including ${scope.counts.audioChunks} audio chunks, ${scope.counts.guides} guides, and ${scope.counts.assets} materials; detach ${scope.counts.entriesUpdated} journal entries. Review the scope, then repeat with --confirm-scope --scope-token ${scopeToken}.`,
                json,
            );
            return 0;
        }
        if (args.options.get("scope-token") !== scopeToken) {
            throw new CliError(
                "Deletion scope confirmation is missing or stale. Review the current scope and confirm it with the returned --scope-token.",
            );
        }
        const audioSnapshot = await openForCommand(path);
        try {
            if (audioSnapshot.commit.generation !== generation) {
                throw new CliError(
                    "The archive changed after this operation was reviewed. Review it again before retrying.",
                );
            }
            changes = [
                ...changes,
                ...(await loadSessionAudioTrashChanges(
                    audioSnapshot,
                    sessionId,
                    scope.audioChunkRecords,
                )),
            ];
        } catch (error) {
            if (error instanceof CliError) throw error;
            throw new CliError(
                error instanceof Error
                    ? error.message
                    : "Unable to load the reviewed recording chunks.",
            );
        } finally {
            await closeSnapshot(audioSnapshot);
        }
        await mutateArchive(path, changes, generation);
        emit(
            output,
            { ...summary, status: "deleted" },
            "Session and associated records moved to recoverable Trash.",
            json,
        );
        return 0;
    }

    if (group === "session" && action === "restore") {
        const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
        const snapshot = await openForCommand(path);
        let changes: ArchiveRecord[];
        let generation: bigint | undefined;
        try {
            const session = await snapshot.getRecord(RecordType.session, sessionId);
            if (!session || field(session, "_deleted") !== "true") {
                throw new CliError(`Session ${sessionId} is not in Trash.`);
            }
            try {
                changes = await planSessionRestore(snapshot, session);
            } catch (error) {
                throw new CliError(
                    error instanceof Error ? error.message : "Unable to restore the session group.",
                );
            }
            generation = snapshot.commit.generation;
        } finally {
            await closeSnapshot(snapshot);
        }
        if (generation === undefined) throw new CliError("Unable to prepare the session restore.");
        await mutateArchive(path, changes, generation);
        emit(
            output,
            { status: "restored", session_id: sessionId, restored_records: String(changes.length) },
            `Restored session ${sessionId} and ${Math.max(0, changes.length - 1)} associated records.`,
            json,
        );
        return 0;
    }

    if ((group === "student" || group === "session" || group === "journal") && action === "show") {
        if (!id) throw new CliError(`${group} show requires a record ID.`);
        const snapshot = await openForCommand(path);
        try {
            const record =
                group === "journal"
                    ? await getJournalEntry(snapshot, id)
                    : await requireLiveRecord(snapshot, recordType, id);
            emit(
                output,
                toPlainRecord(record),
                `${field(record, "title") || field(record, "display_name")} (${record.id})`,
                json,
            );
            return 0;
        } finally {
            await closeSnapshot(snapshot);
        }
    }

    if (["student", "session", "journal"].includes(group) && action === "delete") {
        if (!id) throw new CliError(`${group} delete requires a record ID.`);
        const current =
            group === "journal"
                ? await getJournalEntryAtPath(path, id)
                : await getLiveRecordAtPath(path, recordType, id);
        const deleted = updateFields(current, {}, args, {
            _deleted: "true",
            deleted_at_us: timestampNow(),
            updated_at_us: timestampNow(),
        });
        const [saved] = await mutateArchive(path, [deleted]);
        emit(
            output,
            toPlainRecord(saved ?? deleted),
            `Moved ${group} record ${id} to Trash.`,
            json,
        );
        return 0;
    }

    if (["student", "session", "journal"].includes(group) && action === "restore") {
        if (!id) throw new CliError(`${group} restore requires a record ID.`);
        const current = await getRecordAtPath(path, recordType, id);
        if (field(current, "_deleted") !== "true")
            throw new CliError(`Record ${id} is not in Trash.`);
        const restored = updateFields(current, {}, args, {
            _deleted: "false",
            restored_at_us: timestampNow(),
            updated_at_us: timestampNow(),
        });
        const [saved] = await mutateArchive(path, [restored]);
        emit(output, toPlainRecord(saved ?? restored), `Restored ${group} record ${id}.`, json);
        return 0;
    }

    return null;
}
