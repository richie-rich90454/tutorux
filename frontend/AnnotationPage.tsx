import {
    createContext,
    createMemo,
    createSignal,
    For,
    onCleanup,
    Show,
    useContext,
    type JSX,
} from "solid-js";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { mergeObservations, setObservationLink, splitObservation } from "./annotation-operations";
import {
    ANNOTATION_PRIORITIES,
    ANNOTATION_TYPES,
    type AnnotationInput,
} from "./domain/annotations";
import { formatTranscriptTimestampUs } from "./domain/transcript";

type IconName = "annotations" | "sessions" | "plus" | "clock" | "check";
const IconContext = createContext<{ icon: (props: { name: IconName }) => JSX.Element }>({
    icon: () => null,
});
function Icon(props: { name: IconName }): JSX.Element {
    const context = useContext(IconContext);
    return <context.icon name={props.name} />;
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
            : (props.sessions[0]?.id ?? ""),
    );
    const annotations = createMemo(() =>
        props.records
            .filter((record) => field(record, "session_id") === sessionId())
            .sort((left, right) => {
                const a = safeBigInt(field(left, "start_time_us"));
                const b = safeBigInt(field(right, "start_time_us"));
                return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
            }),
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

    async function mergeSelected(): Promise<void> {
        try {
            const records = annotations().filter((record) => selected().includes(record.id));
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

    return (
        <IconContext.Provider value={{ icon: props.icon }}>
            <div class="page-body annotation-page">
                <section class="record-heading annotation-heading">
                    <div>
                        <span class="eyebrow">NOTICE THE MOMENTS THAT MATTER</span>
                        <h1>Observations</h1>
                        <p>
                            Mark ideas, questions, corrections, and follow-ups as they happen in a
                            session.
                        </p>
                    </div>
                    <div
                        class="annotation-count"
                        aria-label={`${annotations().length} observations`}
                    >
                        <strong>{annotations().length.toString().padStart(2, "0")}</strong>
                        <span>IN THIS SESSION</span>
                    </div>
                </section>

                <label class="annotation-quick-note">
                    <span>Quick marker note</span>
                    <input
                        value={markerNote()}
                        disabled={props.disabled || !sessionId()}
                        onInput={(event) => setMarkerNote(event.currentTarget.value)}
                        placeholder="Optional note for the next keyboard marker"
                    />
                </label>

                <section class="annotation-controls">
                    <label class="transcript-session-picker">
                        Session
                        <select
                            aria-label="Choose a session for observations"
                            value={sessionId()}
                            disabled={!props.sessions.length}
                            onChange={(event) => props.onSelectSession(event.currentTarget.value)}
                        >
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
                            <div class="annotation-session-context">
                                <span class="annotation-session-glyph">
                                    <Icon name="sessions" />
                                </span>
                                <span>
                                    <strong>{field(session(), "title", "Untitled session")}</strong>
                                    <small>
                                        {field(session(), "subject", "Session notes and moments")}
                                    </small>
                                </span>
                            </div>
                        )}
                    </Show>
                    <button
                        class="button button-primary"
                        type="button"
                        disabled={props.disabled || !sessionId()}
                        onClick={() => setAdding((value) => !value)}
                    >
                        <Icon name="plus" />
                        Add observation
                    </button>
                </section>

                <Show when={adding()}>
                    <section class="annotation-compose surface-card">
                        <div class="annotation-compose-heading">
                            <div>
                                <span class="eyebrow">CAPTURE A MOMENT</span>
                                <h2>New observation</h2>
                            </div>
                            <button
                                class="button button-quiet"
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
                    when={props.sessions.length > 0}
                    fallback={
                        <section class="surface-card annotation-empty">
                            <div class="annotation-empty-mark">
                                <Icon name="annotations" />
                            </div>
                            <h2>Start with a session</h2>
                            <p>
                                Observations are attached to a session so you can revisit the right
                                moment later.
                            </p>
                            <button
                                class="button button-primary"
                                type="button"
                                onClick={props.onNewSession}
                            >
                                <Icon name="plus" /> Create a session
                            </button>
                        </section>
                    }
                >
                    <Show
                        when={annotations().length > 0 || adding()}
                        fallback={
                            <section class="surface-card annotation-empty">
                                <div class="annotation-empty-mark">
                                    <Icon name="annotations" />
                                </div>
                                <h2>A clear page for this session</h2>
                                <p>
                                    Add an observation when a useful idea, misunderstanding, or next
                                    step appears.
                                </p>
                                <button
                                    class="button button-outline"
                                    type="button"
                                    disabled={props.disabled}
                                    onClick={() => setAdding(true)}
                                >
                                    <Icon name="plus" /> Add the first observation
                                </button>
                            </section>
                        }
                    >
                        <section class="annotation-timeline" aria-label="Session observations">
                            <div class="annotation-timeline-heading">
                                <div>
                                    <span class="eyebrow">SESSION TIMELINE</span>
                                    <h2>What stood out</h2>
                                </div>
                                <span>
                                    {selectedSession()
                                        ? formatTimestamp(
                                              field(selectedSession()!, "started_at_us"),
                                          )
                                        : ""}
                                </span>
                            </div>
                            <div class="annotation-filters">
                                <label>
                                    Type
                                    <select
                                        value={typeFilter()}
                                        onChange={(event) =>
                                            setTypeFilter(event.currentTarget.value)
                                        }
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
                                <label>
                                    Priority
                                    <select
                                        value={priorityFilter()}
                                        onChange={(event) =>
                                            setPriorityFilter(event.currentTarget.value)
                                        }
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
                                    class="button button-outline record-action"
                                    disabled={
                                        props.disabled ||
                                        selected().filter((id) =>
                                            annotations().some((record) => record.id === id),
                                        ).length < 2
                                    }
                                    onClick={() => void mergeSelected()}
                                >
                                    Merge selected
                                </button>
                            </div>
                            <Show when={operationError()}>
                                <p role="alert" class="annotation-filter-empty">
                                    {operationError()}
                                </p>
                            </Show>
                            <Show
                                when={visibleAnnotations().length > 0}
                                fallback={
                                    <p class="annotation-filter-empty">
                                        No observations match these filters.
                                    </p>
                                }
                            >
                                <div class="annotation-list">
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
        <article class={`annotation-item priority-${priority()}`}>
            <div class="annotation-timeline-rail" aria-hidden="true">
                <span />
            </div>
            <div class="annotation-card surface-card">
                <header class="annotation-card-header">
                    <div class="annotation-type-line">
                        <label class="annotation-select">
                            <input
                                type="checkbox"
                                checked={props.selected}
                                disabled={props.disabled}
                                onChange={(event) => props.onSelect(event.currentTarget.checked)}
                            />{" "}
                            <span class="sr-only">Select observation for merging</span>
                        </label>
                        <span class="annotation-type-icon">
                            <Icon name="annotations" />
                        </span>
                        <span class="annotation-type-label">{kind()}</span>
                        <span class={`annotation-priority priority-label-${priority()}`}>
                            {priority()}
                        </span>
                    </div>
                    <span class="annotation-card-time">
                        <Icon name="clock" /> {time()}
                    </span>
                </header>
                <Show when={!editing()}>
                    <div class="annotation-card-copy">
                        <h3>{field(props.record, "title") || kind()}</h3>
                        <p>{field(props.record, "content")}</p>
                    </div>
                    <div class="annotation-card-actions">
                        <button
                            class="button button-quiet record-action"
                            type="button"
                            disabled={props.disabled}
                            onClick={() => setEditing(true)}
                        >
                            Edit observation
                        </button>
                        <Show when={props.onPlayFromTimestamp}>
                            <button
                                class="button button-quiet record-action"
                                type="button"
                                disabled={props.disabled}
                                onClick={() => props.onPlayFromTimestamp?.(props.record)}
                            >
                                Play from timestamp
                            </button>
                        </Show>
                        <button
                            class="button button-quiet record-action"
                            type="button"
                            disabled={props.disabled}
                            onClick={() => void props.onDuplicate()}
                        >
                            Duplicate
                        </button>
                        <label class="annotation-quick-priority">
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
                            class="button button-quiet record-action"
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
                            class="button button-quiet record-action"
                            type="button"
                            disabled={props.disabled}
                            onClick={() => setSplitting((value) => !value)}
                        >
                            Split
                        </button>
                        <button
                            class="button button-quiet record-action"
                            type="button"
                            aria-expanded={linksOpen()}
                            onClick={() => setLinksOpen((value) => !value)}
                        >
                            Links
                        </button>
                        <button
                            class="button button-quiet record-action annotation-remove-action"
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onRemove()}
                        >
                            Move to Trash
                        </button>
                    </div>
                    <Show when={operationError()}>
                        <p role="alert" class="annotation-filter-empty">
                            {operationError()}
                        </p>
                    </Show>
                    <Show when={splitting()}>
                        <section class="annotation-operation" aria-label="Split observation">
                            <p>
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
                            />
                            <span>Split after character {splitOffset()}</span>
                            <label>
                                Split time{" "}
                                <input
                                    placeholder="HH:MM:SS"
                                    value={splitTime()}
                                    onInput={(event) => setSplitTime(event.currentTarget.value)}
                                />
                            </label>
                            <button
                                type="button"
                                class="button button-outline"
                                disabled={props.disabled}
                                onClick={() => void split()}
                            >
                                Split observation
                            </button>
                        </section>
                    </Show>
                    <Show when={linksOpen()}>
                        <section class="annotation-operation" aria-label="Linked records">
                            <p>Link materials and evidence from this session.</p>
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
                                            <label>
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
                            class="annotation-history-panel"
                            aria-label="Observation version history"
                        >
                            <div class="annotation-history-heading">
                                <span class="eyebrow">VERSION HISTORY</span>
                                <span>
                                    {Math.max(0, (history()?.length ?? 1) - 1)} earlier versions
                                </span>
                            </div>
                            <Show
                                when={(history()?.length ?? 0) > 1}
                                fallback={
                                    <p class="annotation-history-empty">
                                        This observation has no earlier versions.
                                    </p>
                                }
                            >
                                <div class="annotation-history-list">
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
                                                <article class="annotation-history-entry">
                                                    <div>
                                                        <strong>
                                                            {field(revision, "title") ||
                                                                annotationTypeLabel(
                                                                    field(revision, "type"),
                                                                )}
                                                        </strong>
                                                        <small>
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
                                                    <p>{field(revision, "content")}</p>
                                                    <button
                                                        class="button button-outline record-action"
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
        <form class="annotation-form" onSubmit={submit}>
            <div class="annotation-form-grid">
                <label class="form-field">
                    Type
                    <select
                        value={type()}
                        onChange={(event) =>
                            setType(event.currentTarget.value as AnnotationInput["type"])
                        }
                    >
                        <For each={ANNOTATION_TYPES}>
                            {(value) => <option value={value}>{annotationTypeLabel(value)}</option>}
                        </For>
                    </select>
                </label>
                <label class="form-field">
                    Priority
                    <select
                        value={priority()}
                        onChange={(event) =>
                            setPriority(event.currentTarget.value as AnnotationInput["priority"])
                        }
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
                <label class="form-field annotation-form-title">
                    Title <span class="optional">optional</span>
                    <input
                        value={title()}
                        onInput={(event) => setTitle(event.currentTarget.value)}
                        maxlength="512"
                    />
                </label>
                <label class="form-field">
                    Start time
                    <input
                        value={start()}
                        onInput={(event) => setStart(event.currentTarget.value)}
                        placeholder="HH:MM:SS"
                        inputmode="decimal"
                        required
                    />
                </label>
                <label class="form-field">
                    End time <span class="optional">optional</span>
                    <input
                        value={end()}
                        onInput={(event) => setEnd(event.currentTarget.value)}
                        placeholder="Same as start"
                        inputmode="decimal"
                    />
                </label>
            </div>
            <label class="form-field">
                Observation
                <textarea
                    value={content()}
                    onInput={(event) => setContent(event.currentTarget.value)}
                    rows={4}
                    maxlength="16000000"
                    required
                    placeholder="What did you notice? Include context that will help you remember why it matters."
                />
            </label>
            <div class="annotation-form-actions">
                <button
                    class="button button-primary record-action"
                    type="submit"
                    disabled={props.disabled || !content().trim()}
                >
                    <Icon name="check" /> {props.submitLabel}
                </button>
                <button
                    class="button button-quiet record-action"
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
        return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
            new Date(milliseconds),
        );
    } catch {
        return "Date not set";
    }
}
