import {
    buttonOutline,
    buttonPrimary,
    buttonQuiet,
    cn,
    heading1,
    heading3,
    inputBase,
    labelBase,
    pageBody,
    selectBase,
    textareaBase,
} from "./ui";
import {
    createContext,
    createEffect,
    createMemo,
    createSignal,
    For,
    on,
    onCleanup,
    Show,
    useContext,
    type Accessor,
    type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { pluralNoun } from "./shared-utils";
import { mergeObservations, setObservationLink, splitObservation } from "./annotation-operations";
import {
    ANNOTATION_PRIORITIES,
    ANNOTATION_TYPES,
    type AnnotationInput,
} from "./domain/annotations";
import { formatTranscriptTimestampUs } from "./domain/transcript";

type IconName = "annotations" | "sessions" | "plus" | "clock" | "check";
type IconRenderer = (props: { name: IconName }) => JSX.Element;
const IconContext = createContext<Accessor<IconRenderer>>(() => () => null);
function Icon(props: { name: IconName }): JSX.Element {
    const context = useContext(IconContext);
    return <Dynamic component={context()} name={props.name} />;
}

export function AnnotationPage(props: {
    icon: (props: { name: IconName }) => JSX.Element;
    sessions: ArchiveRecord[];
    records: ArchiveRecord[];
    assets: ArchiveRecord[];
    evidence: ArchiveRecord[];
    onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
    selectedSessionId: string;
    disabled: boolean;
    onSelectSession: (sessionId: string) => void;
    onSave: (input: AnnotationInput, current: ArchiveRecord | null) => Promise<boolean>;
    onRemove: (record: ArchiveRecord) => void;
    onDuplicate: (record: ArchiveRecord) => Promise<boolean>;
    onNewSession: () => void;
    onHistory: (record: ArchiveRecord) => Promise<ArchiveRecord[]>;
    onRestore: (record: ArchiveRecord, historyIndex: number) => Promise<boolean>;
    onPlayFromTimestamp: ((record: ArchiveRecord) => void) | undefined;
}): JSX.Element {
    const [adding, setAdding] = createSignal(false);
    const [markerNote, setMarkerNote] = createSignal("");
    const quickMarker = (event: Event) => {
        const value = (event as CustomEvent<string>).detail;
        if (!ANNOTATION_TYPES.includes(value as AnnotationInput["type"]) || props.disabled) return;
        const session = selectedSession();
        if (!session) return;
        const type = value as AnnotationInput["type"];
        let elapsed = safeBigInt(field(session, "recording_duration_us"));
        const started = safeBigInt(field(session, "recording_started_at_us"));
        if (field(session, "recording_state") === "recording" && started > 0n) {
            const now = BigInt(Date.now()) * 1000n;
            elapsed = now > started ? now - started : 0n;
        }
        void props
            .onSave(
                {
                    sessionId: session.id,
                    start: formatTranscriptTimestampUs(elapsed),
                    end: "",
                    type,
                    priority: "normal",
                    title: annotationTypeLabel(type),
                    content: markerNote(),
                },
                null,
            )
            .then((saved) => {
                if (saved) setMarkerNote("");
            });
    };
    window.addEventListener("tutorux:quick-marker", quickMarker);
    onCleanup(() => window.removeEventListener("tutorux:quick-marker", quickMarker));
    const [selected, setSelected] = createSignal<string[]>([]);
    const [operationError, setOperationError] = createSignal("");
    const [typeFilter, setTypeFilter] = createSignal("");
    const [priorityFilter, setPriorityFilter] = createSignal("");
    const sessionId = createMemo(() =>
        props.sessions.some((session) => session.id === props.selectedSessionId)
            ? props.selectedSessionId
            : "",
    );
    const annotations = createMemo(() =>
        sessionId()
            ? props.records
                  .filter((record) => field(record, "session_id") === sessionId())
                  .sort((left, right) => {
                      const a = safeBigInt(field(left, "start_time_us"));
                      const b = safeBigInt(field(right, "start_time_us"));
                      return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
                  })
            : [],
    );
    const visibleAnnotations = createMemo(() =>
        annotations().filter(
            (record) =>
                (!typeFilter() || field(record, "type", "general-note") === typeFilter()) &&
                (!priorityFilter() || field(record, "priority", "normal") === priorityFilter()),
        ),
    );
    const selectedSession = createMemo(() =>
        props.sessions.find((item) => item.id === sessionId()),
    );
    const selectedVisible = createMemo(() => {
        const visible = new Set(visibleAnnotations().map((record) => record.id));
        return selected().filter((id) => visible.has(id));
    });
    createEffect(on(sessionId, () => setSelected([]), { defer: true }));
    createEffect(
        on(
            visibleAnnotations,
            (visible) => {
                const ids = new Set(visible.map((record) => record.id));
                setSelected((current) => {
                    const next = current.filter((id) => ids.has(id));
                    return next.length === current.length ? current : next;
                });
            },
            { defer: true },
        ),
    );

    async function mergeSelected(): Promise<void> {
        try {
            const ids = new Set(selectedVisible());
            const records = annotations().filter((record) => ids.has(record.id));
            if (await props.onWriteRecords(mergeObservations(records), "Observations merged."))
                setSelected([]);
            setOperationError("");
        } catch (error) {
            setOperationError(error instanceof Error ? error.message : String(error));
        }
    }

    async function saveNewAnnotation(input: AnnotationInput): Promise<boolean> {
        const saved = await props.onSave(input, null);
        if (saved) setAdding(false);
        return saved;
    }

    const iconRenderer = createMemo(() => props.icon);
    return (
        <IconContext.Provider value={iconRenderer}>
            <div class={cn("page-body annotation-page", pageBody)}>
                <section class="record-heading annotation-heading mb-4 flex flex-wrap items-center justify-between gap-3.5 rounded-[5px] border border-line bg-surface px-[23px] py-5 max-sm:items-start max-sm:p-[17px]">
                    <div class="min-w-0">
                        <span class="eyebrow text-xs font-medium tracking-wide text-accent">
                            Notice the moments that matter
                        </span>
                        <h1 class={cn(heading1, "mt-1.5 mb-1")}>Observations</h1>
                        <p class="m-0 text-xs leading-relaxed text-muted">
                            Mark ideas, questions, corrections, and follow-ups as they happen in a
                            session.
                        </p>
                    </div>
                    <div
                        class="annotation-count grid min-w-[95px] justify-items-end gap-[3px] border-l border-line pl-[18px] text-faint max-sm:min-w-0 max-sm:pl-2.5"
                        aria-label={`${annotations().length} ${pluralNoun(annotations().length, "observation")}`}
                    >
                        <strong class="font-semibold text-ink-soft">
                            {annotations().length.toString().padStart(2, "0")}
                        </strong>
                        <span>In this session</span>
                    </div>
                </section>

                <label class="annotation-quick-note grid max-w-lg gap-1.5 text-[0.8rem] text-muted">
                    <span>Quick marker note</span>
                    <input
                        value={markerNote()}
                        disabled={props.disabled || !sessionId()}
                        onInput={(event) => setMarkerNote(event.currentTarget.value)}
                        placeholder="Optional note for the next keyboard marker"
                        class={inputBase}
                    />
                </label>

                <section class="annotation-controls mb-4 flex min-h-[69px] flex-wrap items-center gap-3.5 rounded-[5px] border border-line bg-surface px-[13px] py-[11px] max-sm:flex-col max-sm:items-stretch">
                    <label class="transcript-session-picker grid min-w-[150px] flex-1 basis-[290px] gap-1.5 text-xs font-semibold text-muted max-sm:basis-auto">
                        Session
                        <select
                            aria-label="Choose a session for observations"
                            value={sessionId()}
                            disabled={!props.sessions.length}
                            onChange={(event) => props.onSelectSession(event.currentTarget.value)}
                            class={selectBase}
                        >
                            <Show when={!selectedSession()}>
                                <option value="" disabled>
                                    {props.sessions.length === 0
                                        ? "No sessions yet"
                                        : "Select a session"}
                                </option>
                            </Show>
                            <For each={props.sessions}>
                                {(session) => (
                                    <option value={session.id}>
                                        {field(session, "title", "Untitled session")} ·{" "}
                                        {formatTimestamp(field(session, "started_at_us"))}
                                    </option>
                                )}
                            </For>
                        </select>
                    </label>
                    <Show when={selectedSession()}>
                        {(session) => (
                            <div class="annotation-session-context ml-auto flex min-w-0 items-center gap-[9px] pr-2 max-lg:hidden">
                                <span class="annotation-session-glyph grid h-8 w-8 flex-none place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent">
                                    <Icon name="sessions" />
                                </span>
                                <span class="grid min-w-0 gap-0.5">
                                    <strong class="font-semibold text-ink-soft">
                                        {field(session(), "title", "Untitled session")}
                                    </strong>
                                    <small class="text-xs text-faint">
                                        {field(session(), "subject", "Session notes and moments")}
                                    </small>
                                </span>
                            </div>
                        )}
                    </Show>
                    <button
                        class={buttonPrimary}
                        type="button"
                        disabled={props.disabled || !sessionId()}
                        onClick={() => setAdding((value) => !value)}
                    >
                        <Icon name="plus" />
                        Add observation
                    </button>
                </section>

                <Show when={adding()}>
                    <section class="annotation-compose surface-card mb-3.5 rounded-[5px] border border-line bg-surface p-5 max-sm:p-[15px]">
                        <div class="annotation-compose-heading mb-3.5 flex items-center justify-between gap-3.5">
                            <div class="min-w-0">
                                <span class="eyebrow text-xs font-medium tracking-wide text-muted">
                                    Capture a moment
                                </span>
                                <h2 class={heading3}>New observation</h2>
                            </div>
                            <button
                                class={buttonQuiet}
                                type="button"
                                onClick={() => setAdding(false)}
                            >
                                Cancel
                            </button>
                        </div>
                        <AnnotationForm
                            initial={{
                                sessionId: sessionId(),
                                start: "00:00:00",
                                end: "",
                                type: "general-note",
                                priority: "normal",
                                title: "",
                                content: "",
                            }}
                            disabled={props.disabled}
                            submitLabel="Save observation"
                            onCancel={() => setAdding(false)}
                            onSave={saveNewAnnotation}
                        />
                    </section>
                </Show>

                <Show
                    when={selectedSession()}
                    fallback={
                        <Show
                            when={props.sessions.length === 0}
                            fallback={
                                <section class="surface-card annotation-empty flex min-h-[280px] flex-col items-center justify-center rounded-[5px] border border-line bg-surface px-[22px] py-7 text-center max-sm:min-h-0 max-sm:items-start max-sm:border-0 max-sm:px-0.5 max-sm:pb-[38px] max-sm:pt-[30px] max-sm:text-left">
                                    <div class="annotation-empty-mark mb-3 grid h-[50px] w-[50px] place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent -rotate-[4deg]">
                                        <Icon name="annotations" />
                                    </div>
                                    <h2 class={heading3}>Session unavailable</h2>
                                    <p class="m-0 text-xs leading-relaxed text-muted">
                                        The selected session is not in this workspace. Choose
                                        another session above.
                                    </p>
                                </section>
                            }
                        >
                            <section class="surface-card annotation-empty flex min-h-[280px] flex-col items-center justify-center rounded-[5px] border border-line bg-surface px-[22px] py-7 text-center max-sm:min-h-0 max-sm:items-start max-sm:border-0 max-sm:px-0.5 max-sm:pb-[38px] max-sm:pt-[30px] max-sm:text-left">
                                <div class="annotation-empty-mark mb-3 grid h-[50px] w-[50px] place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent -rotate-[4deg]">
                                    <Icon name="annotations" />
                                </div>
                                <h2 class={heading3}>Start with a session</h2>
                                <p class="m-0 text-xs leading-relaxed text-muted">
                                    Observations are attached to a session so you can revisit the
                                    right moment later.
                                </p>
                                <button
                                    class={buttonPrimary}
                                    type="button"
                                    onClick={props.onNewSession}
                                >
                                    <Icon name="plus" /> Create a session
                                </button>
                            </section>
                        </Show>
                    }
                >
                    <Show
                        when={annotations().length > 0 || adding()}
                        fallback={
                            <section class="surface-card annotation-empty flex min-h-[280px] flex-col items-center justify-center rounded-[5px] border border-line bg-surface px-[22px] py-7 text-center max-sm:min-h-0 max-sm:items-start max-sm:border-0 max-sm:px-0.5 max-sm:pb-[38px] max-sm:pt-[30px] max-sm:text-left">
                                <div class="annotation-empty-mark mb-3 grid h-[50px] w-[50px] place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent -rotate-[4deg]">
                                    <Icon name="annotations" />
                                </div>
                                <h2 class={heading3}>A clear page for this session</h2>
                                <p class="m-0 text-xs leading-relaxed text-muted">
                                    Add an observation when a useful idea, misunderstanding, or next
                                    step appears.
                                </p>
                                <button
                                    class={buttonOutline}
                                    type="button"
                                    disabled={props.disabled}
                                    onClick={() => setAdding(true)}
                                >
                                    <Icon name="plus" /> Add the first observation
                                </button>
                            </section>
                        }
                    >
                        <section
                            class="annotation-timeline rounded-[5px] border border-line bg-surface-subtle p-[18px] pb-[3px] max-sm:px-3 max-sm:pt-[15px] max-sm:pb-0.5"
                            aria-label="Session observations"
                        >
                            <div class="annotation-timeline-heading mb-3 ml-11 flex items-center justify-between gap-3.5 max-sm:ml-[34px]">
                                <div class="min-w-0">
                                    <span class="eyebrow text-xs font-medium tracking-wide text-muted">
                                        Session timeline
                                    </span>
                                    <h2 class={heading3}>What stood out</h2>
                                </div>
                                <span>
                                    {selectedSession()
                                        ? formatTimestamp(
                                              field(selectedSession()!, "started_at_us"),
                                          )
                                        : ""}
                                </span>
                            </div>
                            <div class="annotation-filters my-4 flex flex-wrap items-end gap-3">
                                <label class={labelBase}>
                                    Type
                                    <select
                                        value={typeFilter()}
                                        onChange={(event) =>
                                            setTypeFilter(event.currentTarget.value)
                                        }
                                        class={selectBase}
                                    >
                                        <option value="">All types</option>
                                        <For each={ANNOTATION_TYPES}>
                                            {(value) => (
                                                <option value={value}>
                                                    {annotationTypeLabel(value)}
                                                </option>
                                            )}
                                        </For>
                                    </select>
                                </label>
                                <label class={labelBase}>
                                    Priority
                                    <select
                                        value={priorityFilter()}
                                        onChange={(event) =>
                                            setPriorityFilter(event.currentTarget.value)
                                        }
                                        class={selectBase}
                                    >
                                        <option value="">All priorities</option>
                                        <For each={ANNOTATION_PRIORITIES}>
                                            {(value) => (
                                                <option value={value}>
                                                    {value[0]!.toUpperCase() + value.slice(1)}
                                                </option>
                                            )}
                                        </For>
                                    </select>
                                </label>
                                <span>{visibleAnnotations().length} shown</span>
                                <button
                                    type="button"
                                    class={cn(
                                        "record-action",
                                        buttonOutline,
                                        "min-h-[30px] px-[9px] text-xs",
                                    )}
                                    disabled={props.disabled || selectedVisible().length < 2}
                                    onClick={() => void mergeSelected()}
                                >
                                    Merge selected
                                </button>
                            </div>
                            <Show when={operationError()}>
                                <p
                                    role="alert"
                                    class="annotation-filter-empty my-3 text-xs text-muted"
                                >
                                    {operationError()}
                                </p>
                            </Show>
                            <Show
                                when={visibleAnnotations().length > 0}
                                fallback={
                                    <p class="annotation-filter-empty my-3 text-xs text-muted">
                                        No observations match these filters.
                                    </p>
                                }
                            >
                                <div class="annotation-list grid">
                                    <For each={visibleAnnotations()}>
                                        {(record) => (
                                            <AnnotationCard
                                                record={record}
                                                selected={selected().includes(record.id)}
                                                onSelect={(checked) =>
                                                    setSelected((current) =>
                                                        checked
                                                            ? [...current, record.id]
                                                            : current.filter(
                                                                  (id) => id !== record.id,
                                                              ),
                                                    )
                                                }
                                                targets={[
                                                    ...props.assets,
                                                    ...props.evidence,
                                                ].filter(
                                                    (target) =>
                                                        !field(target, "session_id") ||
                                                        field(
                                                            target,
                                                            "session_id",
                                                        ).toLowerCase() ===
                                                            sessionId().toLowerCase(),
                                                )}
                                                onWriteRecords={props.onWriteRecords}
                                                disabled={props.disabled}
                                                onSave={(input) => props.onSave(input, record)}
                                                onRemove={() => props.onRemove(record)}
                                                onDuplicate={() => props.onDuplicate(record)}
                                                onHistory={props.onHistory}
                                                onRestore={props.onRestore}
                                                onPlayFromTimestamp={props.onPlayFromTimestamp}
                                            />
                                        )}
                                    </For>
                                </div>
                            </Show>
                        </section>
                    </Show>
                </Show>
            </div>
        </IconContext.Provider>
    );
}

function AnnotationCard(props: {
    record: ArchiveRecord;
    selected: boolean;
    onSelect: (checked: boolean) => void;
    targets: ArchiveRecord[];
    onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
    disabled: boolean;
    onSave: (input: AnnotationInput) => Promise<boolean>;
    onRemove: () => void;
    onDuplicate: () => Promise<boolean>;
    onHistory: (record: ArchiveRecord) => Promise<ArchiveRecord[]>;
    onRestore: (record: ArchiveRecord, historyIndex: number) => Promise<boolean>;
    onPlayFromTimestamp: ((record: ArchiveRecord) => void) | undefined;
}): JSX.Element {
    const [editing, setEditing] = createSignal(false);
    const [splitting, setSplitting] = createSignal(false);
    const [splitOffset, setSplitOffset] = createSignal(0);
    const [splitTime, setSplitTime] = createSignal("");
    const [linksOpen, setLinksOpen] = createSignal(false);
    const [operationError, setOperationError] = createSignal("");
    async function split(): Promise<void> {
        try {
            if (
                await props.onWriteRecords(
                    splitObservation(props.record, splitOffset(), splitTime()),
                    "Observation split.",
                )
            )
                setSplitting(false);
            setOperationError("");
        } catch (error) {
            setOperationError(error instanceof Error ? error.message : String(error));
        }
    }
    async function toggleLink(target: ArchiveRecord, checked: boolean): Promise<void> {
        try {
            await props.onWriteRecords(
                [setObservationLink(props.record, target, checked)],
                checked ? "Link added." : "Link removed.",
            );
            setOperationError("");
        } catch (error) {
            setOperationError(error instanceof Error ? error.message : String(error));
        }
    }
    const [history, setHistory] = createSignal<ArchiveRecord[] | null>(null);
    const [historyLoading, setHistoryLoading] = createSignal(false);
    const priority = () => field(props.record, "priority", "normal");
    const kind = () => annotationTypeLabel(field(props.record, "type", "general-note"));
    const time = () => formatAnnotationRange(props.record);

    async function saveEditedAnnotation(input: AnnotationInput): Promise<boolean> {
        const saved = await props.onSave(input);
        if (saved) {
            setEditing(false);
            setHistory(null);
        }
        return saved;
    }

    async function toggleHistory(): Promise<void> {
        if (history() !== null) {
            setHistory(null);
            return;
        }
        setHistoryLoading(true);
        try {
            setHistory(await props.onHistory(props.record));
        } finally {
            setHistoryLoading(false);
        }
    }

    async function restoreRevision(historyIndex: number): Promise<void> {
        if (!(await props.onRestore(props.record, historyIndex))) return;
        setHistory(await props.onHistory(props.record));
    }

    return (
        <article
            class={cn(
                `annotation-item priority-${priority()}`,
                "relative grid grid-cols-[24px_minmax(0,1fr)] gap-3 pb-[13px] animate-[annotation-enter_210ms_ease-out_both] motion-reduce:animate-none max-sm:grid-cols-[16px_minmax(0,1fr)] max-sm:gap-2",
            )}
        >
            <div
                class="annotation-timeline-rail relative flex justify-center before:absolute before:top-[3px] before:-bottom-[13px] before:w-px before:bg-line before:content-['']"
                aria-hidden="true"
            >
                <span />
            </div>
            <div class="annotation-card surface-card min-w-0 rounded-[5px] border border-line bg-surface px-[15px] pb-3 pt-[13px] max-sm:p-[11px]">
                <header class="annotation-card-header flex flex-wrap items-center justify-between gap-2 max-sm:flex-col max-sm:items-start">
                    <div class="annotation-type-line flex flex-wrap items-center gap-2">
                        <label class="annotation-select inline-flex items-center">
                            <input
                                type="checkbox"
                                checked={props.selected}
                                disabled={props.disabled}
                                onChange={(event) => props.onSelect(event.currentTarget.checked)}
                                class="accent-accent"
                            />{" "}
                            <span class="sr-only">Select observation for merging</span>
                        </label>
                        <span class="annotation-type-icon grid h-6 w-6 flex-none place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent">
                            <Icon name="annotations" />
                        </span>
                        <span class="annotation-type-label text-xs font-semibold text-ink-soft">
                            {kind()}
                        </span>
                        <span
                            class={cn(
                                `annotation-priority priority-label-${priority()}`,
                                "rounded-[5px] border border-line-soft bg-surface-subtle px-[7px] py-[3px] text-xs font-semibold capitalize text-muted",
                                (priority() === "high" || priority() === "critical") &&
                                    "text-[var(--warning)]",
                            )}
                        >
                            {priority()}
                        </span>
                    </div>
                    <span class="annotation-card-time inline-flex items-center gap-[5px] text-xs tabular-nums text-faint">
                        <Icon name="clock" /> {time()}
                    </span>
                </header>
                <Show when={!editing()}>
                    <div class="annotation-card-copy m-0 break-words whitespace-pre-wrap">
                        <h3 class="text-xs font-semibold tracking-tight text-ink">
                            {field(props.record, "title") || kind()}
                        </h3>
                        <p class="m-0 text-xs leading-relaxed text-muted">
                            {field(props.record, "content")}
                        </p>
                    </div>
                    <div class="annotation-card-actions mt-2 flex flex-wrap items-center gap-1.5">
                        <button
                            class={cn(
                                "record-action",
                                buttonQuiet,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => setEditing(true)}
                        >
                            Edit observation
                        </button>
                        <Show when={props.onPlayFromTimestamp}>
                            <button
                                class={cn(
                                    "record-action",
                                    buttonQuiet,
                                    "min-h-[30px] px-[9px] text-xs",
                                )}
                                type="button"
                                disabled={props.disabled}
                                onClick={() => props.onPlayFromTimestamp?.(props.record)}
                            >
                                Play from timestamp
                            </button>
                        </Show>
                        <button
                            class={cn(
                                "record-action",
                                buttonQuiet,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => void props.onDuplicate()}
                        >
                            Duplicate
                        </button>
                        <label class="annotation-quick-priority flex items-center gap-2 text-[0.8rem] text-muted">
                            Priority
                            <select
                                value={priority()}
                                disabled={props.disabled}
                                onChange={(event) =>
                                    void props.onSave({
                                        ...annotationInput(props.record),
                                        priority: event.currentTarget
                                            .value as AnnotationInput["priority"],
                                    })
                                }
                                class={selectBase}
                            >
                                <For each={ANNOTATION_PRIORITIES}>
                                    {(value) => (
                                        <option value={value}>
                                            {value[0]!.toUpperCase() + value.slice(1)}
                                        </option>
                                    )}
                                </For>
                            </select>
                        </label>
                        <button
                            class={cn(
                                "record-action",
                                buttonQuiet,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={historyLoading()}
                            aria-expanded={history() !== null}
                            onClick={() => void toggleHistory()}
                        >
                            {historyLoading()
                                ? "Loading history…"
                                : history() === null
                                  ? "View history"
                                  : "Hide history"}
                        </button>
                        <button
                            class={cn(
                                "record-action",
                                buttonQuiet,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => setSplitting((value) => !value)}
                        >
                            Split
                        </button>
                        <button
                            class={cn(
                                "record-action",
                                buttonQuiet,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            aria-expanded={linksOpen()}
                            onClick={() => setLinksOpen((value) => !value)}
                        >
                            Links
                        </button>
                        <button
                            class={cn(
                                "record-action annotation-remove-action",
                                buttonQuiet,
                                "min-h-[30px] px-[9px] text-xs",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onRemove()}
                        >
                            Move to Trash
                        </button>
                    </div>
                    <Show when={operationError()}>
                        <p role="alert" class="annotation-filter-empty my-3 text-xs text-muted">
                            {operationError()}
                        </p>
                    </Show>
                    <Show when={splitting()}>
                        <section
                            class="annotation-operation flex flex-col items-start gap-2.5 border-t border-line py-4"
                            aria-label="Split observation"
                        >
                            <p class="m-0 text-xs leading-relaxed text-muted">
                                Select where to split the text. Both parts retain the observation’s
                                links.
                            </p>
                            <textarea
                                readonly
                                rows={4}
                                value={field(props.record, "content")}
                                onSelect={(event) =>
                                    setSplitOffset(event.currentTarget.selectionStart)
                                }
                                aria-label="Select the split position in the observation text"
                                class={textareaBase}
                            />
                            <span>Split after character {splitOffset()}</span>
                            <label class="flex items-center gap-2 text-xs text-ink-soft">
                                Split time{" "}
                                <input
                                    placeholder="HH:MM:SS"
                                    value={splitTime()}
                                    onInput={(event) => setSplitTime(event.currentTarget.value)}
                                    class={inputBase}
                                />
                            </label>
                            <button
                                type="button"
                                class={buttonOutline}
                                disabled={props.disabled}
                                onClick={() => void split()}
                            >
                                Split observation
                            </button>
                        </section>
                    </Show>
                    <Show when={linksOpen()}>
                        <section
                            class="annotation-operation flex flex-col items-start gap-2.5 border-t border-line py-4"
                            aria-label="Linked records"
                        >
                            <p class="m-0 text-xs leading-relaxed text-muted">
                                Link materials and evidence from this session.
                            </p>
                            <Show
                                when={props.targets.length}
                                fallback={<span>No materials or evidence available.</span>}
                            >
                                <For each={props.targets}>
                                    {(target) => {
                                        const key =
                                            target.type === RecordType.assetMetadata
                                                ? "linked_asset_ids"
                                                : "linked_evidence_ids";
                                        const linked = () =>
                                            field(props.record, key)
                                                .split(",")
                                                .some(
                                                    (id) =>
                                                        id.trim().toLowerCase() ===
                                                        target.id.toLowerCase(),
                                                );
                                        return (
                                            <label class="flex items-center gap-2 text-xs text-ink-soft">
                                                <input
                                                    type="checkbox"
                                                    checked={linked()}
                                                    disabled={props.disabled}
                                                    onChange={(event) =>
                                                        void toggleLink(
                                                            target,
                                                            event.currentTarget.checked,
                                                        )
                                                    }
                                                    class="accent-accent"
                                                />{" "}
                                                {target.type === RecordType.assetMetadata
                                                    ? "Material"
                                                    : "Evidence"}
                                                :{" "}
                                                {field(target, "title") ||
                                                    field(target, "filename") ||
                                                    target.id}
                                            </label>
                                        );
                                    }}
                                </For>
                            </Show>
                        </section>
                    </Show>
                    <Show when={history() !== null}>
                        <section
                            class="annotation-history-panel mt-3 border-t border-line-soft pt-[11px]"
                            aria-label="Observation version history"
                        >
                            <div class="annotation-history-heading mb-[7px] flex items-center justify-between gap-2">
                                <span class="eyebrow text-xs font-medium tracking-wide text-muted">
                                    Version history
                                </span>
                                <span>
                                    {Math.max(0, (history()?.length ?? 1) - 1)} earlier versions
                                </span>
                            </div>
                            <Show
                                when={(history()?.length ?? 0) > 1}
                                fallback={
                                    <p class="annotation-history-empty my-2 text-xs text-muted">
                                        This observation has no earlier versions.
                                    </p>
                                }
                            >
                                <div class="annotation-history-list grid gap-[7px]">
                                    <For
                                        each={(history()?.slice(1) ?? []).map((record, index) => ({
                                            record,
                                            historyIndex: index + 1,
                                        }))}
                                    >
                                        {(entry) => {
                                            const revision = entry.record;
                                            const historyIndex = entry.historyIndex;
                                            return (
                                                <article class="annotation-history-entry grid gap-1.5 rounded-[5px] border border-line-soft bg-surface-subtle px-[11px] py-2.5">
                                                    <div class="min-w-0">
                                                        <strong class="font-semibold text-ink-soft">
                                                            {field(revision, "title") ||
                                                                annotationTypeLabel(
                                                                    field(revision, "type"),
                                                                )}
                                                        </strong>
                                                        <small class="text-xs text-faint">
                                                            Version {historyIndex} ·{" "}
                                                            {formatTimestamp(
                                                                field(
                                                                    revision,
                                                                    "updated_at_us",
                                                                    field(
                                                                        revision,
                                                                        "created_at_us",
                                                                    ),
                                                                ),
                                                            )}
                                                            {field(revision, "_deleted") === "true"
                                                                ? " · removed"
                                                                : ""}
                                                        </small>
                                                    </div>
                                                    <p class="m-0 text-xs leading-relaxed text-muted">
                                                        {field(revision, "content")}
                                                    </p>
                                                    <button
                                                        class={cn(
                                                            "record-action",
                                                            buttonOutline,
                                                            "min-h-[30px] px-[9px] text-xs",
                                                        )}
                                                        type="button"
                                                        disabled={props.disabled}
                                                        onClick={() =>
                                                            void restoreRevision(historyIndex)
                                                        }
                                                    >
                                                        Restore version {historyIndex}
                                                    </button>
                                                </article>
                                            );
                                        }}
                                    </For>
                                </div>
                            </Show>
                        </section>
                    </Show>
                </Show>
                <Show when={editing()}>
                    <AnnotationForm
                        initial={annotationInput(props.record)}
                        disabled={props.disabled}
                        submitLabel="Save changes"
                        onCancel={() => setEditing(false)}
                        onSave={saveEditedAnnotation}
                    />
                </Show>
            </div>
        </article>
    );
}

function AnnotationForm(props: {
    initial: AnnotationInput;
    disabled: boolean;
    submitLabel: string;
    onCancel: () => void;
    onSave: (input: AnnotationInput) => Promise<boolean> | void;
}): JSX.Element {
    const [title, setTitle] = createSignal(props.initial.title);
    const [content, setContent] = createSignal(props.initial.content);
    const [start, setStart] = createSignal(props.initial.start);
    const [end, setEnd] = createSignal(props.initial.end);
    const [type, setType] = createSignal<AnnotationInput["type"]>(props.initial.type);
    const [priority, setPriority] = createSignal<AnnotationInput["priority"]>(
        props.initial.priority,
    );

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const result = await props.onSave({
            sessionId: props.initial.sessionId,
            start: start(),
            end: end(),
            type: type(),
            priority: priority(),
            title: title(),
            content: content(),
        });
        if (result !== false) props.onCancel();
    }

    return (
        <form class="annotation-form grid gap-[11px]" onSubmit={submit}>
            <div class="annotation-form-grid grid grid-cols-2 gap-[9px] md:grid-cols-[1.1fr_0.8fr_1.5fr_0.8fr_0.8fr]">
                <label class="form-field grid min-w-0 gap-[5px] text-xs font-semibold text-ink-soft">
                    Type
                    <select
                        value={type()}
                        onChange={(event) =>
                            setType(event.currentTarget.value as AnnotationInput["type"])
                        }
                        class={selectBase}
                    >
                        <For each={ANNOTATION_TYPES}>
                            {(value) => <option value={value}>{annotationTypeLabel(value)}</option>}
                        </For>
                    </select>
                </label>
                <label class="form-field grid min-w-0 gap-[5px] text-xs font-semibold text-ink-soft">
                    Priority
                    <select
                        value={priority()}
                        onChange={(event) =>
                            setPriority(event.currentTarget.value as AnnotationInput["priority"])
                        }
                        class={selectBase}
                    >
                        <For each={ANNOTATION_PRIORITIES}>
                            {(value) => (
                                <option value={value}>
                                    {value[0]!.toUpperCase() + value.slice(1)}
                                </option>
                            )}
                        </For>
                    </select>
                </label>
                <label class="form-field annotation-form-title grid min-w-0 gap-[5px] text-xs font-semibold text-ink-soft relative col-span-2 md:col-span-1">
                    Title{" "}
                    <span class="optional absolute right-0 top-0 text-xs font-normal text-faint">
                        optional
                    </span>
                    <input
                        value={title()}
                        onInput={(event) => setTitle(event.currentTarget.value)}
                        maxlength="512"
                        class={inputBase}
                    />
                </label>
                <label class="form-field grid min-w-0 gap-[5px] text-xs font-semibold text-ink-soft">
                    Start time
                    <input
                        value={start()}
                        onInput={(event) => setStart(event.currentTarget.value)}
                        placeholder="HH:MM:SS"
                        inputmode="decimal"
                        required
                        class={inputBase}
                    />
                </label>
                <label class="form-field grid min-w-0 gap-[5px] text-xs font-semibold text-ink-soft">
                    End time <span class="optional text-xs font-normal text-faint">optional</span>
                    <input
                        value={end()}
                        onInput={(event) => setEnd(event.currentTarget.value)}
                        placeholder="Same as start"
                        inputmode="decimal"
                        class={inputBase}
                    />
                </label>
            </div>
            <label class="form-field grid min-w-0 gap-[5px] text-xs font-semibold text-ink-soft">
                Observation
                <textarea
                    value={content()}
                    onInput={(event) => setContent(event.currentTarget.value)}
                    rows={4}
                    maxlength="16000000"
                    required
                    placeholder="What did you notice? Include context that will help you remember why it matters."
                    class={textareaBase}
                />
            </label>
            <div class="annotation-form-actions flex flex-wrap gap-1.5">
                <button
                    class={cn("record-action", buttonPrimary, "min-h-[30px] px-[9px] text-xs")}
                    type="submit"
                    disabled={props.disabled || !content().trim()}
                >
                    <Icon name="check" /> {props.submitLabel}
                </button>
                <button
                    class={cn("record-action", buttonQuiet, "min-h-[30px] px-[9px] text-xs")}
                    type="button"
                    onClick={() => props.onCancel()}
                >
                    Cancel
                </button>
            </div>
        </form>
    );
}

function annotationInput(record: ArchiveRecord): AnnotationInput {
    return {
        sessionId: field(record, "session_id"),
        start: transcriptTimeInput(field(record, "start_time_us")) || "00:00:00",
        end: transcriptTimeInput(field(record, "end_time_us")),
        type: ANNOTATION_TYPES.includes(field(record, "type") as AnnotationInput["type"])
            ? (field(record, "type") as AnnotationInput["type"])
            : "custom",
        priority: ANNOTATION_PRIORITIES.includes(
            field(record, "priority") as AnnotationInput["priority"],
        )
            ? (field(record, "priority") as AnnotationInput["priority"])
            : "normal",
        title: field(record, "title"),
        content: field(record, "content"),
    };
}

function formatAnnotationRange(record: ArchiveRecord): string {
    const start = transcriptTimeInput(field(record, "start_time_us"));
    const end = transcriptTimeInput(field(record, "end_time_us"));
    return end && end !== start ? `${start} – ${end}` : start || "Time not provided";
}

function annotationTypeLabel(type: string): string {
    return type
        .split("-")
        .map((word) => word[0]!.toUpperCase() + word.slice(1))
        .join(" ");
}

function safeBigInt(value: string): bigint {
    try {
        return BigInt(value || "0");
    } catch {
        return 0n;
    }
}
function transcriptTimeInput(raw: string): string {
    if (!/^\d+$/u.test(raw)) return "";
    return formatTranscriptTimestampUs(BigInt(raw));
}
function field(record: ArchiveRecord, name: string, fallback = ""): string {
    return record.fields.get(name) ?? fallback;
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
