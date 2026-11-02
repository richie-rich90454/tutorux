import {
    buttonOutline,
    buttonPrimary,
    cn,
    inputBase,
    labelBase,
    selectBase,
    textareaBase,
} from "./ui";
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { RecordType, type ArchiveRecord } from "./archive/format";
import {
    canonicalizeProgressUuid,
    classificationLabel,
    decodeStudentProgress,
    STUDENT_PROGRESS_CLASSIFICATIONS,
    validateProgressEvidence,
    type StudentProgressClassification,
} from "./domain/student-progress";

interface StudentProgressPanelProps {
    student: ArchiveRecord;
    sessions: ArchiveRecord[];
    evidence: ArchiveRecord[];
    disabled: boolean;
    busy: boolean;
    onSave: (input: {
        student: ArchiveRecord;
        skill: string;
        classification: StudentProgressClassification;
        evidenceSourceIds: string[];
        reviewedBy: string;
        note: string;
    }) => Promise<boolean>;
}

export function StudentProgressPanel(props: StudentProgressPanelProps): JSX.Element {
    const [editing, setEditing] = createSignal(false);
    const [skill, setSkill] = createSignal("");
    const [classification, setClassification] =
        createSignal<StudentProgressClassification>("newly-observed");
    const [reviewedBy, setReviewedBy] = createSignal("");
    const [note, setNote] = createSignal("");
    const [selectedIds, setSelectedIds] = createSignal<string[]>([]);
    const [error, setError] = createSignal("");

    const history = createMemo(() =>
        props.sessions
            .filter(
                (session) =>
                    session.type === RecordType.session &&
                    session.fields.get("_deleted") !== "true" &&
                    canonicalizeProgressUuid(session.fields.get("student_id") ?? "") ===
                        canonicalizeProgressUuid(props.student.id),
            )
            .sort((left, right) =>
                compareUs(right.fields.get("started_at_us"), left.fields.get("started_at_us")),
            ),
    );
    const progress = createMemo(() => {
        try {
            return {
                items: decodeStudentProgress(
                    props.student.fields.get("progress_classifications") ?? "",
                ),
                error: "",
            };
        } catch (cause) {
            return {
                items: [],
                error:
                    cause instanceof Error ? cause.message : "Progress history could not be read.",
            };
        }
    });
    const evidenceOptions = createMemo(() => {
        const sessionById = new Set(
            history()
                .map((session) => canonicalizeProgressUuid(session.id))
                .filter((id): id is string => id !== undefined),
        );
        return props.evidence
            .filter(
                (item) =>
                    item.type === RecordType.evidenceNode &&
                    item.fields.get("_deleted") !== "true" &&
                    sessionById.has(
                        canonicalizeProgressUuid(item.fields.get("session_id") ?? "") ?? "",
                    ),
            )
            .sort((left, right) =>
                compareUs(right.fields.get("created_at_us"), left.fields.get("created_at_us")),
            );
    });
    const evidenceById = createMemo(
        () =>
            new Map(
                props.evidence.map((item) => [
                    canonicalizeProgressUuid(item.id) ?? item.id.toLowerCase(),
                    item,
                ]),
            ),
    );

    function sourcesAreValid(sourceIds: string[], type: StudentProgressClassification): boolean {
        try {
            validateProgressEvidence(
                props.student.id,
                sourceIds,
                props.sessions,
                props.evidence,
                type,
            );
            return true;
        } catch {
            return false;
        }
    }

    async function saveReview(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            const saved = await props.onSave({
                student: props.student,
                skill: skill(),
                classification: classification(),
                evidenceSourceIds: selectedIds(),
                reviewedBy: reviewedBy(),
                note: note(),
            });
            if (!saved) return;
            setEditing(false);
            setSkill("");
            setReviewedBy("");
            setNote("");
            setSelectedIds([]);
        } catch (cause) {
            setError(
                cause instanceof Error ? cause.message : "The progress review could not be saved.",
            );
        }
    }

    const classificationTone = (value: StudentProgressClassification): string =>
        value === "demonstrated-mastery"
            ? "border-success/30 bg-success/10 text-success"
            : value === "unverified-improvement"
              ? "border-warning/35 bg-warning/10 text-warning"
              : "border-accent/25 bg-accent-soft text-accent";

    return (
        <details class="student-history mt-3 rounded-[5px] border border-line-soft bg-surface-subtle/60">
            <summary class="flex min-h-10 cursor-pointer list-none items-center gap-2.5 rounded-[5px] px-[11px] py-2 text-ink-soft before:size-[7px] before:shrink-0 before:rotate-[-45deg] before:border-b-[1.5px] before:border-r-[1.5px] before:border-muted before:content-[''] before:transition-transform open:before:translate-y-[-2px] open:before:rotate-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                <span class="student-history-title text-xs font-semibold">Learning history</span>
                <span class="student-history-counts inline-flex items-center gap-1.5 text-xs tabular-nums text-muted max-[680px]:ml-auto max-[680px]:grid max-[680px]:gap-px max-[680px]:text-right">
                    {history().length} {history().length === 1 ? "session" : "sessions"}
                    <span aria-hidden="true" class="max-[680px]:hidden">
                        ·
                    </span>
                    {progress().items.length} reviewed{" "}
                    {progress().items.length === 1 ? "skill" : "skills"}
                </span>
            </summary>

            <div class="student-history-content grid gap-4 border-t border-line-soft p-4 md:grid-cols-[minmax(210px,0.76fr)_minmax(0,1.5fr)]">
                <section
                    class="student-session-history min-w-0 border-line-soft pr-4 max-md:border-b max-md:pb-3.5 max-md:pr-0 md:border-r"
                    aria-label="Session history"
                >
                    <div class="student-history-section-heading mb-3 flex items-center justify-between gap-2.5">
                        <div>
                            <span class="text-xs font-bold tracking-widest text-faint">
                                The thread over time
                            </span>
                            <h3 class="mt-1 text-xs font-semibold tracking-tight text-ink">
                                Sessions
                            </h3>
                        </div>
                        <span class="student-history-total inline-flex items-center gap-1.5 text-xs tabular-nums text-muted">
                            {history().length} recorded
                        </span>
                    </div>
                    <Show
                        when={history().length > 0}
                        fallback={
                            <p class="student-history-empty m-0 rounded-[5px] border border-line-soft bg-surface px-[11px] py-2.5 text-xs leading-relaxed text-muted">
                                Sessions linked to this learner will appear here as their work
                                unfolds.
                            </p>
                        }
                    >
                        <ol class="student-session-list m-0 grid max-h-[330px] list-none overflow-y-auto p-0">
                            <For each={history()}>
                                {(session) => (
                                    <li class="student-session-item grid min-w-0 grid-cols-[57px_minmax(0,1fr)] gap-2 border-b border-line-soft py-2 last:border-b-0">
                                        <span class="student-session-date text-xs tabular-nums text-muted">
                                            {formatTimestamp(field(session, "started_at_us"))}
                                        </span>
                                        <span class="student-session-copy grid min-w-0 gap-1">
                                            <strong class="truncate text-xs font-semibold text-ink-soft">
                                                {field(session, "title", "Tutoring session")}
                                            </strong>
                                            <small class="truncate text-xs text-faint">
                                                {[
                                                    field(session, "subject"),
                                                    field(session, "session_state"),
                                                ]
                                                    .filter(Boolean)
                                                    .join(" · ") || "Session"}
                                            </small>
                                        </span>
                                    </li>
                                )}
                            </For>
                        </ol>
                    </Show>
                </section>

                <section
                    class="student-progress-history min-w-0"
                    aria-label="Tutor-reviewed progress"
                >
                    <div class="student-history-section-heading mb-3 flex items-center justify-between gap-2.5">
                        <div>
                            <span class="text-xs font-bold tracking-widest text-faint">
                                Human review, sources attached
                            </span>
                            <h3 class="mt-1 text-xs font-semibold tracking-tight text-ink">
                                Progress by skill
                            </h3>
                        </div>
                        <button
                            class={cn("button student-review-trigger", buttonOutline)}
                            type="button"
                            disabled={props.disabled || props.busy}
                            onClick={() => {
                                setEditing(!editing());
                                setError("");
                            }}
                        >
                            {editing() ? "Close review" : "Review a skill"}
                        </button>
                    </div>

                    <Show when={progress().error}>
                        <p
                            class="student-progress-warning m-0 rounded-[5px] border border-warning/40 bg-warning/5 px-[11px] py-2.5 text-xs leading-relaxed text-warning"
                            role="status"
                        >
                            This archive’s stored progress history is malformed. Other student
                            details remain available.
                        </p>
                    </Show>
                    <Show when={!progress().error && progress().items.length === 0}>
                        <p class="student-history-empty m-0 rounded-[5px] border border-line-soft bg-surface px-[11px] py-2.5 text-xs leading-relaxed text-muted">
                            No tutor-reviewed progress yet. A review stays tied to evidence from
                            this learner’s sessions.
                        </p>
                    </Show>
                    <Show when={!progress().error && progress().items.length > 0}>
                        <ul class="student-progress-list m-0 grid list-none gap-2 p-0">
                            <For each={progress().items}>
                                {(item) => {
                                    const valid = () =>
                                        sourcesAreValid(
                                            item.evidenceSourceIds,
                                            item.classification,
                                        );
                                    return (
                                        <li class="student-progress-item min-w-0 rounded-[5px] border border-line-soft border-l-2 border-l-accent/50 bg-surface p-3">
                                            <div class="student-progress-item-heading flex items-center justify-between gap-2">
                                                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                                                    <h4 class="m-0 truncate text-xs font-semibold text-ink-soft">
                                                        {item.skill}
                                                    </h4>
                                                    <span
                                                        class={cn(
                                                            "student-classification rounded-[5px] border px-1.5 py-[3px] text-xs font-semibold",
                                                            classificationTone(item.classification),
                                                        )}
                                                    >
                                                        {classificationLabel(item.classification)}
                                                    </span>
                                                </div>
                                                <span class="student-review-date text-xs tabular-nums text-muted">
                                                    Reviewed {formatTimestamp(item.reviewedAtUs)}
                                                </span>
                                            </div>
                                            <Show
                                                when={
                                                    item.classification === "unverified-improvement"
                                                }
                                            >
                                                <p class="student-unverified-claim mt-2 rounded-[5px] border border-warning/35 bg-warning/10 px-2 py-1.5 text-xs font-semibold tracking-wide text-warning">
                                                    UNVERIFIED CLAIM: improvement is not
                                                    established.
                                                </p>
                                            </Show>
                                            <Show when={item.note}>
                                                <p class="student-progress-note mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted">
                                                    {item.note}
                                                </p>
                                            </Show>
                                            <div class="student-progress-sources mt-2 flex flex-wrap items-center justify-start gap-2 text-xs text-faint [&>span+span]:before:mr-2 [&>span+span]:before:text-line-strong [&>span+span]:before:content-['·']">
                                                <span>
                                                    {item.evidenceSourceIds.length} cited source
                                                    {item.evidenceSourceIds.length === 1 ? "" : "s"}
                                                </span>
                                                <span>Reviewed by {item.reviewedBy}</span>
                                                <Show when={!valid()}>
                                                    <span class="student-source-warning text-warning">
                                                        Sources unavailable or no longer valid
                                                    </span>
                                                </Show>
                                            </div>
                                            <ul
                                                class="student-source-chips m-0 mt-2 flex list-none flex-wrap gap-1 p-0"
                                                aria-label="Cited evidence"
                                            >
                                                <For each={item.evidenceSourceIds}>
                                                    {(id) => {
                                                        const source = () =>
                                                            evidenceById().get(
                                                                canonicalizeProgressUuid(id) ??
                                                                    id.toLowerCase(),
                                                            );
                                                        return (
                                                            <li
                                                                class={cn(
                                                                    "max-w-full truncate rounded-[5px] border border-line-soft bg-surface-subtle px-1.5 py-1 text-xs text-muted",
                                                                    !source() &&
                                                                        "border-warning/40 text-warning",
                                                                )}
                                                            >
                                                                {source()
                                                                    ? field(
                                                                          source()!,
                                                                          "title",
                                                                          "Untitled evidence",
                                                                      )
                                                                    : `Missing source ${id}`}
                                                            </li>
                                                        );
                                                    }}
                                                </For>
                                            </ul>
                                        </li>
                                    );
                                }}
                            </For>
                        </ul>
                    </Show>

                    <Show when={editing()}>
                        <form
                            class="student-review-form mt-3 grid gap-3 rounded-[5px] border border-line-soft bg-surface p-3"
                            onSubmit={(event) => void saveReview(event)}
                        >
                            <div class="student-review-form-heading">
                                <span class="text-xs font-bold tracking-widest text-faint">
                                    A new tutor review
                                </span>
                                <p class="mt-1 text-xs leading-relaxed text-muted">
                                    Each skill keeps its latest classification. Earlier archive
                                    revisions remain part of the file history.
                                </p>
                            </div>
                            <div class="student-review-fields grid gap-2.5 md:grid-cols-[1.2fr_1fr_1fr]">
                                <label class={cn("field-label", labelBase)}>
                                    Skill or learning goal
                                    <input
                                        required
                                        maxLength={256}
                                        value={skill()}
                                        onInput={(event) => setSkill(event.currentTarget.value)}
                                        placeholder="For example, equivalent fractions"
                                        class={inputBase}
                                    />
                                </label>
                                <label class={cn("field-label", labelBase)}>
                                    Classification
                                    <select
                                        value={classification()}
                                        onChange={(event) =>
                                            setClassification(
                                                event.currentTarget
                                                    .value as StudentProgressClassification,
                                            )
                                        }
                                        class={selectBase}
                                    >
                                        <For each={STUDENT_PROGRESS_CLASSIFICATIONS}>
                                            {(item) => (
                                                <option value={item}>
                                                    {classificationLabel(item)}
                                                </option>
                                            )}
                                        </For>
                                    </select>
                                </label>
                                <label class={cn("field-label", labelBase)}>
                                    Reviewed by
                                    <input
                                        required
                                        maxLength={128}
                                        value={reviewedBy()}
                                        onInput={(event) =>
                                            setReviewedBy(event.currentTarget.value)
                                        }
                                        placeholder="Your name or tutor label"
                                        class={inputBase}
                                    />
                                    <small class="text-xs font-normal leading-normal text-faint">
                                        This is a tutor-entered audit label, not an authenticated
                                        identity.
                                    </small>
                                </label>
                            </div>

                            <fieldset class="student-evidence-picker m-0 min-w-0 border-0 p-0">
                                <legend class="mb-1 text-xs font-semibold text-ink-soft">
                                    Evidence from this learner’s sessions
                                </legend>
                                <p class="student-evidence-guidance mb-2 mt-0 text-xs leading-normal text-muted">
                                    Recurring, partial improvement, and mastery need sources from at
                                    least two sessions. Mastery also needs every source verified by
                                    a tutor.
                                </p>
                                <Show
                                    when={evidenceOptions().length > 0}
                                    fallback={
                                        <p class="student-history-empty m-0 rounded-[5px] border border-line-soft bg-surface px-[11px] py-2.5 text-xs leading-relaxed text-muted">
                                            No evidence is available yet. Review evidence from this
                                            learner’s sessions first.
                                        </p>
                                    }
                                >
                                    <div class="student-evidence-options grid max-h-[235px] grid-cols-1 gap-1.5 overflow-y-auto p-0.5 sm:grid-cols-2">
                                        <For each={evidenceOptions()}>
                                            {(item) => {
                                                const session = () =>
                                                    history().find(
                                                        (candidate) =>
                                                            canonicalizeProgressUuid(
                                                                candidate.id,
                                                            ) ===
                                                            canonicalizeProgressUuid(
                                                                item.fields.get("session_id") ?? "",
                                                            ),
                                                    );
                                                const checked = () =>
                                                    selectedIds().includes(item.id);
                                                return (
                                                    <label class="student-evidence-option flex min-w-0 cursor-pointer items-start gap-2 rounded-[5px] border border-line-soft bg-surface-subtle p-2 focus-within:border-accent">
                                                        <input
                                                            type="checkbox"
                                                            checked={checked()}
                                                            onChange={(event) => {
                                                                const selected = new Set(
                                                                    selectedIds(),
                                                                );
                                                                if (event.currentTarget.checked)
                                                                    selected.add(item.id);
                                                                else selected.delete(item.id);
                                                                setSelectedIds([...selected]);
                                                            }}
                                                            class="mt-0.5 accent-accent"
                                                        />
                                                        <span class="student-evidence-option-copy grid min-w-0 gap-1">
                                                            <strong class="truncate text-xs font-semibold text-ink-soft">
                                                                {field(
                                                                    item,
                                                                    "title",
                                                                    "Untitled evidence",
                                                                )}
                                                            </strong>
                                                            <small class="line-clamp-2 text-xs leading-snug text-faint">
                                                                {session()
                                                                    ? field(
                                                                          session()!,
                                                                          "title",
                                                                          "Tutoring session",
                                                                      )
                                                                    : "Session unavailable"}
                                                                {field(
                                                                    item,
                                                                    "verification_state",
                                                                ) === "human-verified"
                                                                    ? " · Tutor verified"
                                                                    : " · Needs review"}
                                                            </small>
                                                            <span class="line-clamp-2 text-xs leading-snug text-faint">
                                                                {snippet(field(item, "content"))}
                                                            </span>
                                                        </span>
                                                    </label>
                                                );
                                            }}
                                        </For>
                                    </div>
                                </Show>
                            </fieldset>

                            <label class={cn("field-label student-review-note", labelBase)}>
                                Review note{" "}
                                <span class="text-xs font-normal text-faint">Optional</span>
                                <textarea
                                    maxLength={4096}
                                    rows={3}
                                    value={note()}
                                    onInput={(event) => setNote(event.currentTarget.value)}
                                    placeholder="Describe what the evidence means for this learner."
                                    class={cn(textareaBase, "resize-y leading-normal")}
                                />
                            </label>
                            <Show when={error()}>
                                <p
                                    class="student-progress-form-error m-0 rounded-[5px] border border-warning/40 bg-warning/5 px-2 py-2 text-xs text-warning"
                                    role="alert"
                                >
                                    {error()}
                                </p>
                            </Show>
                            <div class="student-review-form-actions flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                                <span>
                                    {selectedIds().length} source
                                    {selectedIds().length === 1 ? "" : "s"} selected
                                </span>
                                <button
                                    class={cn("button", buttonPrimary)}
                                    type="submit"
                                    disabled={
                                        props.disabled ||
                                        props.busy ||
                                        evidenceOptions().length === 0
                                    }
                                >
                                    Save tutor review
                                </button>
                            </div>
                        </form>
                    </Show>
                </section>
            </div>
        </details>
    );
}

function field(record: ArchiveRecord, name: string, fallback = ""): string {
    return record.fields.get(name) ?? fallback;
}

function compareUs(left = "0", right = "0"): number {
    try {
        const a = BigInt(left || "0");
        const b = BigInt(right || "0");
        return a < b ? -1 : a > b ? 1 : 0;
    } catch {
        return left.localeCompare(right);
    }
}

function formatTimestamp(value: string): string {
    try {
        const milliseconds = Number(BigInt(value || "0") / 1000n);
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "Date not set";
        return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
            new Date(milliseconds),
        );
    } catch {
        return "Date not set";
    }
}

function snippet(value: string): string {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length > 150
        ? `${normalized.slice(0, 147)}…`
        : normalized || "No evidence detail";
}
