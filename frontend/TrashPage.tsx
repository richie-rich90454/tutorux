import { buttonDanger, buttonOutline, cn, pageBody } from "./ui";
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
        <div class={cn("page-body record-page", pageBody)}>
            <section class="record-heading my-1 mb-[22px] flex items-end justify-between gap-5">
                <div>
                    <span class="text-xs font-bold tracking-widest text-accent">
                        Recoverable archive items
                    </span>
                    <h1 class="mb-1 mt-1.5 text-[27px] font-medium tracking-tighter text-ink">
                        Trash
                    </h1>
                    <p class="m-0 max-w-[620px] text-xs leading-relaxed text-muted">
                        Restore a session or journal entry with its linked records, or bring back an
                        individual item.
                    </p>
                </div>
            </section>
            <section class="record-list-shell overflow-hidden rounded-[5px] border border-line bg-surface">
                <div class="record-list-toolbar flex min-h-[42px] items-center justify-between gap-2 border-b border-line-soft px-4 text-xs text-faint">
                    <span>
                        <strong class="text-xs font-semibold text-ink-soft">{total()}</strong>{" "}
                        recoverable groups and items
                    </span>
                    <span class="list-view-label inline-flex items-center gap-1.5">
                        <Icon name="shield" class="h-[13px] w-[13px]" />
                        Recoverable
                    </span>
                    <button
                        class={cn("button trash-purge-start ml-auto", buttonDanger)}
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
                            class="trash-purge-review grid gap-3 rounded-[5px] border border-danger/25 bg-danger-soft/40 p-4"
                            aria-label="Permanent Trash purge review"
                        >
                            <div>
                                <span class="text-xs font-bold tracking-widest text-accent">
                                    Permanent action
                                </span>
                                <h2 class="mb-1 mt-1 text-base font-semibold text-ink">
                                    Review permanent purge
                                </h2>
                                <p class="m-0 text-xs leading-relaxed text-ink-soft">
                                    This removes{" "}
                                    {review().plan.deletedRecords.toLocaleString("en-US")} trashed
                                    archive records and their saved revisions from the workspace.
                                    Material content is preserved. It cannot be undone after you
                                    save the archive.
                                </p>
                            </div>
                            <Show when={review().plan.blockers.length > 0}>
                                <div
                                    class="trash-purge-blockers rounded-[5px] border border-danger/25 bg-surface px-3 py-2.5 text-xs leading-normal text-danger"
                                    role="alert"
                                >
                                    <strong class="mb-1 block">
                                        Active links block this purge.
                                    </strong>
                                    <p class="m-0 text-xs leading-relaxed text-ink-soft">
                                        Restore these items or remove the active links before
                                        purging Trash.
                                    </p>
                                    <ul class="mt-2 grid list-disc gap-2 pl-4">
                                        <For each={review().plan.blockers}>
                                            {(blocker) => (
                                                <li>
                                                    <strong class="font-semibold">
                                                        {blocker.label}
                                                    </strong>
                                                    <span class="block text-muted">
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
                                <p
                                    class="trash-purge-blockers rounded-[5px] border border-danger/25 bg-surface px-3 py-2.5 text-xs leading-normal text-danger"
                                    role="alert"
                                >
                                    {review().plan.opaqueRecords} record(s) from a newer archive
                                    version cannot be checked for active links. Open the archive in
                                    a compatible version before purging Trash.
                                </p>
                            </Show>
                            <div class="trash-purge-actions flex flex-wrap justify-end gap-2">
                                <button
                                    class={cn("button", buttonOutline)}
                                    type="button"
                                    disabled={props.disabled}
                                    onClick={props.onCancelPurge}
                                >
                                    Cancel
                                </button>
                                <button
                                    class={cn("button", buttonDanger)}
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
                                    {review().plan.deletedRecords.toLocaleString("en-US")} records
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
                        <div class="record-list grid" aria-label="Removed note blocks">
                            <For each={props.noteBlocks}>
                                {(block) => (
                                    <article class="library-record-card trash-record flex min-h-[84px] min-w-0 items-center gap-3 border-b border-line-soft p-4 last:border-b-0">
                                        <span class="library-icon grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[5px] bg-surface-inset text-muted">
                                            <Icon name="journal" />
                                        </span>
                                        <div class="min-w-0 flex-1">
                                            <span class="text-xs font-bold tracking-widest text-accent">
                                                Removed note block
                                            </span>
                                            <h2 class="mt-0.5 truncate text-xs font-semibold text-ink">
                                                {block.text || "Empty note block"}
                                            </h2>
                                            <p class="my-1 max-w-3xl text-xs leading-relaxed text-muted">
                                                {block.kind} block removed from{" "}
                                                {block.sessionId
                                                    ? "session notes"
                                                    : "journal notes"}
                                            </p>
                                        </div>
                                        <button
                                            class={cn("button record-action", buttonOutline)}
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
                    <div class="record-list grid">
                        <For each={trashed()}>
                            {(record) => {
                                const journalEntry =
                                    record.type === RecordType.settings &&
                                    field(record, "record_role") === "journal-entry";
                                const evidenceEdge = record.type === RecordType.evidenceEdge;
                                return (
                                    <article class="library-record-card trash-record flex min-h-[84px] min-w-0 items-center gap-3 border-b border-line-soft p-4 last:border-b-0">
                                        <span class="library-icon grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[5px] bg-surface-inset text-muted">
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
                                        <div class="min-w-0 flex-1">
                                            <span class="text-xs font-bold tracking-widest text-accent">
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
                                            <h2 class="mt-0.5 truncate text-xs font-semibold text-ink">
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
                                            <p class="my-1 max-w-3xl text-xs leading-relaxed text-muted">
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
                                                <span class="session-trash-detail mt-1 block max-w-[460px] text-xs leading-normal text-muted">
                                                    Notes, recordings, transcripts, observations,
                                                    materials, guides, and evidence restore
                                                    together; journal links reconnect automatically.
                                                </span>
                                            </Show>
                                            <Show when={journalEntry}>
                                                <span class="session-trash-detail mt-1 block max-w-[460px] text-xs leading-normal text-muted">
                                                    The entry and its linked notes restore together.
                                                </span>
                                            </Show>
                                        </div>
                                        <button
                                            class={cn("button record-action", buttonOutline)}
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
