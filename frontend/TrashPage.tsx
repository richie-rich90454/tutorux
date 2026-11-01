import { For, Show, type JSX } from "solid-js";
import type { ArchiveRecord } from "./archive/format";
import { RecordType } from "./archive/format";
import type { RemovedNoteBlock } from "./domain/records";
import { EmptyState, Icon } from "./shared-ui";
import { annotationTypeLabel, field, formatTimestamp } from "./shared-utils";
import type { TrashPurgeReview } from "./main";

export function TrashPage(props: {
    records: ArchiveRecord[];
    journalEntries: ArchiveRecord[];
    annotations: ArchiveRecord[];
    guides: ArchiveRecord[];
    evidence: ArchiveRecord[];
    evidenceEdges: ArchiveRecord[];
    noteBlocks: RemovedNoteBlock[];
    sessions: ArchiveRecord[];
    disabled: boolean;
    onRestore: (record: ArchiveRecord) => void;
    onRestoreJournalEntry: (record: ArchiveRecord) => void;
    onRestoreAnnotation: (record: ArchiveRecord) => void;
    onRestoreGuide: (record: ArchiveRecord) => void;
    onRestoreEvidence: (record: ArchiveRecord) => void;
    onRestoreEvidenceEdge: (record: ArchiveRecord) => void;
    onRestoreNoteBlock: (block: RemovedNoteBlock) => void;
    onRestoreSession: (record: ArchiveRecord) => void;
    pendingPurge: TrashPurgeReview | null;
    onBeginPurge: () => void;
    onCancelPurge: () => void;
    onConfirmPurge: () => void;
}): JSX.Element {
    const trashed = () => {
        const removedAt = (record: ArchiveRecord): bigint => {
            const raw = field(record, "deleted_at_us");
            return /^\d+$/u.test(raw) ? BigInt(raw) : 0n;
        };
        return [
            ...props.sessions,
            ...props.records,
            ...props.journalEntries,
            ...props.annotations,
            ...props.guides,
            ...props.evidence,
            ...props.evidenceEdges,
        ].sort((left, right) => {
            const a = removedAt(left);
            const b = removedAt(right);
            return a > b ? -1 : a < b ? 1 : left.id.localeCompare(right.id);
        });
    };
    const total = () => trashed().length + props.noteBlocks.length;
    return (
        <div class="page-body record-page">
            <section class="record-heading">
                <div>
                    <span class="eyebrow">Recoverable archive items</span>
                    <h1>Trash</h1>
                    <p>
                        Restore a session or journal entry with its linked records, or bring back an
                        individual item.
                    </p>
                </div>
            </section>
            <section class="record-list-shell">
                <div class="record-list-toolbar">
                    <span>
                        <strong>{total()}</strong> recoverable groups and items
                    </span>
                    <span class="list-view-label">
                        <Icon name="shield" />
                        Recoverable
                    </span>
                    <button
                        class="button button-danger trash-purge-start"
                        type="button"
                        disabled={props.disabled}
                        onClick={() => props.onBeginPurge()}
                    >
                        Permanently purge Trash
                    </button>
                </div>
                <Show when={props.pendingPurge}>
                    {(review) => (
                        <section
                            class="trash-purge-review"
                            aria-label="Permanent Trash purge review"
                        >
                            <div>
                                <span class="eyebrow">Permanent action</span>
                                <h2>Review permanent purge</h2>
                                <p>
                                    This removes {review().plan.deletedRecords.toLocaleString()}{" "}
                                    trashed archive records and their saved revisions from the
                                    workspace. Material content is preserved. It cannot be undone
                                    after you save the archive.
                                </p>
                            </div>
                            <Show when={review().plan.blockers.length > 0}>
                                <div class="trash-purge-blockers" role="alert">
                                    <strong>Active links block this purge.</strong>
                                    <p>
                                        Restore these items or remove the active links before
                                        purging Trash.
                                    </p>
                                    <ul>
                                        <For each={review().plan.blockers}>
                                            {(blocker) => (
                                                <li>
                                                    <strong>{blocker.label}</strong>
                                                    <span>
                                                        {blocker.recordType} {blocker.recordId} is
                                                        linked from{" "}
                                                        {blocker.references
                                                            .map(
                                                                (reference) =>
                                                                    `${reference.label} (${reference.fields.join(", ")})`,
                                                            )
                                                            .join("; ")}
                                                        .
                                                    </span>
                                                </li>
                                            )}
                                        </For>
                                    </ul>
                                </div>
                            </Show>
                            <Show when={review().plan.opaqueRecords > 0}>
                                <p class="trash-purge-blockers" role="alert">
                                    {review().plan.opaqueRecords} record(s) from a newer archive
                                    version cannot be checked for active links. Open the archive in
                                    a compatible version before purging Trash.
                                </p>
                            </Show>
                            <div class="trash-purge-actions">
                                <button
                                    class="button button-outline"
                                    type="button"
                                    disabled={props.disabled}
                                    onClick={props.onCancelPurge}
                                >
                                    Cancel
                                </button>
                                <button
                                    class="button button-danger"
                                    type="button"
                                    disabled={
                                        props.disabled ||
                                        review().plan.deletedRecords === 0 ||
                                        review().plan.blockers.length > 0 ||
                                        review().plan.opaqueRecords > 0
                                    }
                                    onClick={props.onConfirmPurge}
                                >
                                    Permanently purge{" "}
                                    {review().plan.deletedRecords.toLocaleString()} records
                                </button>
                            </div>
                        </section>
                    )}
                </Show>
                <Show
                    when={total() > 0}
                    fallback={
                        <EmptyState
                            icon="trash"
                            title="Trash is empty"
                            text="Sessions, journal entries, students, observations, study guides, and evidence you move here can be restored at any time."
                            action="Back to students"
                            onAction={() => undefined}
                            disabled
                        />
                    }
                >
                    <Show when={props.noteBlocks.length > 0}>
                        <div class="record-list" aria-label="Removed note blocks">
                            <For each={props.noteBlocks}>
                                {(block) => (
                                    <article class="library-record-card trash-record">
                                        <span class="library-icon">
                                            <Icon name="journal" />
                                        </span>
                                        <div>
                                            <span class="eyebrow">Removed note block</span>
                                            <h2>{block.text || "Empty note block"}</h2>
                                            <p>
                                                {block.kind} block removed from{" "}
                                                {block.sessionId
                                                    ? "session notes"
                                                    : "journal notes"}
                                            </p>
                                        </div>
                                        <button
                                            class="button button-outline record-action"
                                            type="button"
                                            disabled={props.disabled}
                                            onClick={() => props.onRestoreNoteBlock(block)}
                                        >
                                            Restore
                                        </button>
                                    </article>
                                )}
                            </For>
                        </div>
                    </Show>
                    <div class="record-list">
                        <For each={trashed()}>
                            {(record) => {
                                const journalEntry =
                                    record.type === RecordType.settings &&
                                    field(record, "record_role") === "journal-entry";
                                const evidenceEdge = record.type === RecordType.evidenceEdge;
                                return (
                                    <article class="library-record-card trash-record">
                                        <span class="library-icon">
                                            <Icon
                                                name={
                                                    journalEntry
                                                        ? "journal"
                                                        : record.type === RecordType.session
                                                          ? "sessions"
                                                          : record.type === RecordType.annotation
                                                            ? "annotations"
                                                            : record.type === RecordType.guide
                                                              ? "guides"
                                                              : record.type ===
                                                                  RecordType.evidenceNode
                                                                ? "evidence"
                                                                : evidenceEdge
                                                                  ? "evidence"
                                                                  : "students"
                                                }
                                            />
                                        </span>
                                        <div>
                                            <span class="eyebrow">
                                                {journalEntry
                                                    ? "JOURNAL ENTRY GROUP"
                                                    : record.type === RecordType.session
                                                      ? "SESSION GROUP"
                                                      : record.type === RecordType.annotation
                                                        ? "SESSION OBSERVATION"
                                                        : record.type === RecordType.guide
                                                          ? "STUDY GUIDE"
                                                          : record.type === RecordType.evidenceNode
                                                            ? "EVIDENCE ITEM"
                                                            : evidenceEdge
                                                              ? "EVIDENCE RELATIONSHIP"
                                                              : "STUDENT PROFILE"}
                                            </span>
                                            <h2>
                                                {journalEntry
                                                    ? field(record, "title", "Untitled entry")
                                                    : record.type === RecordType.session
                                                      ? field(record, "title", "Untitled session")
                                                      : record.type === RecordType.annotation
                                                        ? field(
                                                              record,
                                                              "title",
                                                              annotationTypeLabel(
                                                                  field(
                                                                      record,
                                                                      "type",
                                                                      "observation",
                                                                  ),
                                                              ),
                                                          )
                                                        : record.type === RecordType.guide
                                                          ? field(record, "title", "Untitled guide")
                                                          : record.type === RecordType.evidenceNode
                                                            ? field(
                                                                  record,
                                                                  "title",
                                                                  "Evidence item",
                                                              )
                                                            : evidenceEdge
                                                              ? `${field(record, "relationship", "relationship")} · ${field(record, "from_id")} → ${field(record, "to_id")}`
                                                              : field(
                                                                    record,
                                                                    "display_name",
                                                                    "Unnamed student",
                                                                )}
                                            </h2>
                                            <p>
                                                {journalEntry
                                                    ? "Journal reflection"
                                                    : record.type === RecordType.session
                                                      ? [
                                                            field(record, "subject"),
                                                            field(record, "session_state"),
                                                        ]
                                                            .filter(Boolean)
                                                            .join(" · ") || "Tutoring session"
                                                      : record.type === RecordType.annotation
                                                        ? field(record, "content", "Observation")
                                                        : record.type === RecordType.guide
                                                          ? `${field(record, "approval_state", "draft")} · ${field(record, "template_id", "general")}`
                                                          : record.type === RecordType.evidenceNode
                                                            ? field(record, "content", "Evidence")
                                                            : evidenceEdge
                                                              ? "Removed evidence relationship"
                                                              : field(record, "grade", "Learner")}
                                                {field(record, "deleted_at_us")
                                                    ? ` · Deleted ${formatTimestamp(field(record, "deleted_at_us"))}`
                                                    : " · Deletion date unavailable"}
                                            </p>
                                            <Show when={record.type === RecordType.session}>
                                                <span class="session-trash-detail">
                                                    Notes, recordings, transcripts, observations,
                                                    materials, guides, and evidence restore
                                                    together; journal links reconnect automatically.
                                                </span>
                                            </Show>
                                            <Show when={journalEntry}>
                                                <span class="session-trash-detail">
                                                    The entry and its linked notes restore together.
                                                </span>
                                            </Show>
                                        </div>
                                        <button
                                            class="button button-outline record-action"
                                            type="button"
                                            disabled={props.disabled}
                                            onClick={() =>
                                                journalEntry
                                                    ? props.onRestoreJournalEntry(record)
                                                    : record.type === RecordType.session
                                                      ? props.onRestoreSession(record)
                                                      : record.type === RecordType.annotation
                                                        ? props.onRestoreAnnotation(record)
                                                        : record.type === RecordType.guide
                                                          ? props.onRestoreGuide(record)
                                                          : record.type === RecordType.evidenceNode
                                                            ? props.onRestoreEvidence(record)
                                                            : evidenceEdge
                                                              ? props.onRestoreEvidenceEdge(record)
                                                              : props.onRestore(record)
                                            }
                                        >
                                            Restore
                                        </button>
                                    </article>
                                );
                            }}
                        </For>
                    </div>
                </Show>
            </section>
        </div>
    );
}
