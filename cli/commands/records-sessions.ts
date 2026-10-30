import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { updateSessionRecords } from "../../frontend/domain/records";
import { canonicalizeProgressUuid } from "../../frontend/domain/student-progress";
import { moveJournalSessionForCli } from "../journal-move";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { readGuideSourceRecords } from "./guides";
import { CliError, emit, field, requiredPosition } from "./shared";
import { readableSessionRecord, requireLiveRecord, toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runSessionRecordCommand(
    group: string,
    action: string,
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number | null> {
    const json = args.flags.has("json");

    if (group === "session" && action === "show") {
        const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
        const snapshot = await openForCommand(path);
        let session: ArchiveRecord;
        try {
            session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
        } finally {
            await closeSnapshot(snapshot);
        }
        const response = {
            ...toPlainRecord(session),
            entry_id: field(session, "entry_id"),
            notes_document_id: field(session, "notes_document_id"),
            session_state: session.fields.get("session_state") ?? "active",
            session_type:
                session.fields.get("session_type") ??
                (field(session, "recording_state") === "not-started"
                    ? "notes-only"
                    : "record-audio"),
            started_at_us:
                session.fields.get("started_at_us") ?? session.fields.get("created_at_us") ?? "0",
            ended_at_us: session.fields.get("ended_at_us") ?? "0",
            reviewed_at_us: session.fields.get("reviewed_at_us") ?? "0",
        };
        emit(output, response, readableSessionRecord(session), json);
        return 0;
    }

    if (group === "session" && action === "verify") {
        const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
        const snapshot = await openForCommand(path);
        try {
            const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
            const [annotations, transcripts, assets] = await Promise.all([
                snapshot.listRecords(RecordType.annotation),
                snapshot.listRecords(RecordType.transcriptSegment),
                snapshot.listRecords(RecordType.assetMetadata),
            ]);
            const countForSession = (
                records: ArchiveRecord[],
                include: (record: ArchiveRecord) => boolean = () => true,
            ) =>
                records.filter(
                    (record) =>
                        canonicalizeProgressUuid(field(record, "session_id")) ===
                            canonicalizeProgressUuid(session.id) && include(record),
                ).length;
            const summary = {
                session_id: session.id,
                annotations: String(countForSession(annotations)),
                transcript_segments: String(countForSession(transcripts)),
                assets: String(
                    countForSession(
                        assets,
                        (record) =>
                            ![
                                "audio-track",
                                "recording-take",
                                "waveform-pyramid",
                                "sparse-timestamp-seek-index",
                                "asset-blob-manifest",
                                "asset-blob-chunk",
                            ].includes(field(record, "record_role")),
                    ),
                ),
            };
            emit(
                output,
                summary,
                `Session references are internally readable.\n${JSON.stringify(summary, null, 2)}`,
                json,
            );
            return 0;
        } finally {
            await closeSnapshot(snapshot);
        }
    }

    if (group === "session" && action === "update") {
        const sessionId = requiredPosition(args, 0, "session ID");
        const metadataOptions = [
            "title",
            "subject",
            "objectives",
            "learning-objectives",
            "student-id",
            "entry-id",
        ];
        const updateNotes = args.options.has("notes");
        if (!updateNotes && !metadataOptions.some((option) => args.options.has(option))) {
            throw new CliError("Provide a session field to update.");
        }
        const snapshot = await openForCommand(path);
        let records: ArchiveRecord[];
        let expectedGeneration: bigint;
        try {
            expectedGeneration = snapshot.commit.generation;
            const current = await requireLiveRecord(snapshot, RecordType.session, sessionId);
            const studentId =
                args.options.get("student-id") ?? field(current, "student_id", "anonymous");
            if (args.options.has("student-id") && studentId !== "anonymous") {
                await requireLiveRecord(snapshot, RecordType.student, studentId);
            }
            const notesDocumentId = field(current, "notes_document_id");
            const notesDocument =
                updateNotes && notesDocumentId
                    ? ((await snapshot.getRecord(RecordType.settings, notesDocumentId)) ?? null)
                    : null;
            records = updateSessionRecords(
                current,
                {
                    studentId,
                    subject: args.options.get("subject") ?? field(current, "subject"),
                    title: args.options.get("title") ?? field(current, "title", "Untitled session"),
                    objectives:
                        args.options.get("objectives") ??
                        args.options.get("learning-objectives") ??
                        field(current, "learning_objectives"),
                    notes: args.options.get("notes") ?? "",
                },
                notesDocument,
                updateNotes,
            );
            const destinationId = args.options.get("entry-id");
            if (destinationId !== undefined) {
                const canonical = canonicalizeProgressUuid(destinationId);
                if (!canonical) throw new CliError("--entry-id must be a valid UUID.");
                const destination = await requireLiveRecord(
                    snapshot,
                    RecordType.settings,
                    canonical,
                );
                if (field(destination, "record_role") !== "journal-entry")
                    throw new CliError("Destination journal entry was not found.");
                if (field(current, "entry_id").toLowerCase() !== canonical) {
                    const sources = await readGuideSourceRecords(snapshot);
                    const replacements = new Map(
                        records.map((record) => [
                            `${record.type}:${record.id.toLowerCase()}`,
                            record,
                        ]),
                    );
                    const projectedSources = sources.map(
                        (record) =>
                            replacements.get(`${record.type}:${record.id.toLowerCase()}`) ?? record,
                    );
                    for (const record of records)
                        if (
                            !projectedSources.some(
                                (existing) =>
                                    existing.type === record.type &&
                                    existing.id.toLowerCase() === record.id.toLowerCase(),
                            )
                        )
                            projectedSources.push(record);
                    const guides = await snapshot.listRecords(RecordType.guide);
                    const moved = moveJournalSessionForCli(
                        destination,
                        records[0]!,
                        projectedSources,
                        guides,
                    );
                    const movedKeys = new Set(
                        moved.map((record) => `${record.type}:${record.id.toLowerCase()}`),
                    );
                    records = [
                        ...moved.filter((record) => record.type === RecordType.session),
                        ...moved.filter((record) => record.type !== RecordType.session),
                        ...records.filter(
                            (record) => !movedKeys.has(`${record.type}:${record.id.toLowerCase()}`),
                        ),
                    ];
                }
            }
        } finally {
            await closeSnapshot(snapshot);
        }
        const saved = await mutateArchive(
            path,
            records,
            expectedGeneration,
            "The archive changed while this session edit was being prepared. Retry the update.",
        );
        const record = saved[0] ?? records[0]!;
        emit(
            output,
            toPlainRecord(record),
            `Updated session ${field(record, "title")} (${record.id}).`,
            json,
        );
        return 0;
    }

    return null;
}
