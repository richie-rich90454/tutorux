import { twClasses } from "./tailwind";
import { jsxTailwindStyles } from "./AnnotationPage.tailwind";
import {
    createContext,
    createMemo,
    createSignal,
    For,
    onCleanup,
    Show,
    useContext,
    type Accessor,
    type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { RecordType, type ArchiveRecord } from "./archive/format";
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

    const iconRenderer = createMemo(() => props.icon);
    return (
        <IconContext.Provider value={iconRenderer}>
            <div class={twClasses("page-body annotation-page", jsxTailwindStyles, "div")}>
                <section
                    class={twClasses(
                        "record-heading annotation-heading",
                        jsxTailwindStyles,
                        "section",
                    )}
                >
                    <div class={twClasses("", jsxTailwindStyles, "div")}>
                        <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                            Notice the moments that matter
                        </span>
                        <h1 class={twClasses("", jsxTailwindStyles, "h1")}>Observations</h1>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            Mark ideas, questions, corrections, and follow-ups as they happen in a
                            session.
                        </p>
                    </div>
                    <div
                        class={twClasses("annotation-count", jsxTailwindStyles, "div")}
                        aria-label={`${annotations().length} observations`}
                    >
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            {annotations().length.toString().padStart(2, "0")}
                        </strong>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            In this session
                        </span>
                    </div>
                </section>

                <label class={twClasses("annotation-quick-note", jsxTailwindStyles, "label")}>
                    <span class={twClasses("", jsxTailwindStyles, "span")}>Quick marker note</span>
                    <input
                        value={markerNote()}
                        disabled={props.disabled || !sessionId()}
                        onInput={(event) => setMarkerNote(event.currentTarget.value)}
                        placeholder="Optional note for the next keyboard marker"
                        class={twClasses("", jsxTailwindStyles, "input")}
                    />
                </label>

                <section class={twClasses("annotation-controls", jsxTailwindStyles, "section")}>
                    <label
                        class={twClasses("transcript-session-picker", jsxTailwindStyles, "label")}
                    >
                        Session
                        <select
                            aria-label="Choose a session for observations"
                            value={sessionId()}
                            disabled={!props.sessions.length}
                            onChange={(event) => props.onSelectSession(event.currentTarget.value)}
                            class={twClasses("", jsxTailwindStyles, "select")}
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
                            <div
                                class={twClasses(
                                    "annotation-session-context",
                                    jsxTailwindStyles,
                                    "div",
                                )}
                            >
                                <span
                                    class={twClasses(
                                        "annotation-session-glyph",
                                        jsxTailwindStyles,
                                        "span",
                                    )}
                                >
                                    <Icon name="sessions" />
                                </span>
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                                        {field(session(), "title", "Untitled session")}
                                    </strong>
                                    <small class={twClasses("", jsxTailwindStyles, "small")}>
                                        {field(session(), "subject", "Session notes and moments")}
                                    </small>
                                </span>
                            </div>
                        )}
                    </Show>
                    <button
                        class={twClasses("button button-primary", jsxTailwindStyles, "button")}
                        type="button"
                        disabled={props.disabled || !sessionId()}
                        onClick={() => setAdding((value) => !value)}
                    >
                        <Icon name="plus" />
                        Add observation
                    </button>
                </section>

                <Show when={adding()}>
                    <section
                        class={twClasses(
                            "annotation-compose surface-card",
                            jsxTailwindStyles,
                            "section",
                        )}
                    >
                        <div
                            class={twClasses(
                                "annotation-compose-heading",
                                jsxTailwindStyles,
                                "div",
                            )}
                        >
                            <div class={twClasses("", jsxTailwindStyles, "div")}>
                                <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                                    Capture a moment
                                </span>
                                <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                                    New observation
                                </h2>
                            </div>
                            <button
                                class={twClasses(
                                    "button button-quiet",
                                    jsxTailwindStyles,
                                    "button",
                                )}
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
                        <section
                            class={twClasses(
                                "surface-card annotation-empty",
                                jsxTailwindStyles,
                                "section",
                            )}
                        >
                            <div
                                class={twClasses("annotation-empty-mark", jsxTailwindStyles, "div")}
                            >
                                <Icon name="annotations" />
                            </div>
                            <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                                Start with a session
                            </h2>
                            <p class={twClasses("", jsxTailwindStyles, "p")}>
                                Observations are attached to a session so you can revisit the right
                                moment later.
                            </p>
                            <button
                                class={twClasses(
                                    "button button-primary",
                                    jsxTailwindStyles,
                                    "button",
                                )}
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
                            <section
                                class={twClasses(
                                    "surface-card annotation-empty",
                                    jsxTailwindStyles,
                                    "section",
                                )}
                            >
                                <div
                                    class={twClasses(
                                        "annotation-empty-mark",
                                        jsxTailwindStyles,
                                        "div",
                                    )}
                                >
                                    <Icon name="annotations" />
                                </div>
                                <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                                    A clear page for this session
                                </h2>
                                <p class={twClasses("", jsxTailwindStyles, "p")}>
                                    Add an observation when a useful idea, misunderstanding, or next
                                    step appears.
                                </p>
                                <button
                                    class={twClasses(
                                        "button button-outline",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
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
                            class={twClasses("annotation-timeline", jsxTailwindStyles, "section")}
                            aria-label="Session observations"
                        >
                            <div
                                class={twClasses(
                                    "annotation-timeline-heading",
                                    jsxTailwindStyles,
                                    "div",
                                )}
                            >
                                <div class={twClasses("", jsxTailwindStyles, "div")}>
                                    <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                                        Session timeline
                                    </span>
                                    <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                                        What stood out
                                    </h2>
                                </div>
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    {selectedSession()
                                        ? formatTimestamp(
                                              field(selectedSession()!, "started_at_us"),
                                          )
                                        : ""}
                                </span>
                            </div>
                            <div class={twClasses("annotation-filters", jsxTailwindStyles, "div")}>
                                <label class={twClasses("", jsxTailwindStyles, "label")}>
                                    Type
                                    <select
                                        value={typeFilter()}
                                        onChange={(event) =>
                                            setTypeFilter(event.currentTarget.value)
                                        }
                                        class={twClasses("", jsxTailwindStyles, "select")}
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
                                <label class={twClasses("", jsxTailwindStyles, "label")}>
                                    Priority
                                    <select
                                        value={priorityFilter()}
                                        onChange={(event) =>
                                            setPriorityFilter(event.currentTarget.value)
                                        }
                                        class={twClasses("", jsxTailwindStyles, "select")}
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
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    {visibleAnnotations().length} shown
                                </span>
                                <button
                                    type="button"
                                    class={twClasses(
                                        "button button-outline record-action",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
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
                                <p
                                    role="alert"
                                    class={twClasses(
                                        "annotation-filter-empty",
                                        jsxTailwindStyles,
                                        "p",
                                    )}
                                >
                                    {operationError()}
                                </p>
                            </Show>
                            <Show
                                when={visibleAnnotations().length > 0}
                                fallback={
                                    <p
                                        class={twClasses(
                                            "annotation-filter-empty",
                                            jsxTailwindStyles,
                                            "p",
                                        )}
                                    >
                                        No observations match these filters.
                                    </p>
                                }
                            >
                                <div class={twClasses("annotation-list", jsxTailwindStyles, "div")}>
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
            class={twClasses(
                `annotation-item priority-${priority()}`,
                jsxTailwindStyles,
                "article",
            )}
        >
            <div
                class={twClasses("annotation-timeline-rail", jsxTailwindStyles, "div")}
                aria-hidden="true"
            >
                <span class={twClasses("", jsxTailwindStyles, "span")} />
            </div>
            <div class={twClasses("annotation-card surface-card", jsxTailwindStyles, "div")}>
                <header class={twClasses("annotation-card-header", jsxTailwindStyles, "header")}>
                    <div class={twClasses("annotation-type-line", jsxTailwindStyles, "div")}>
                        <label class={twClasses("annotation-select", jsxTailwindStyles, "label")}>
                            <input
                                type="checkbox"
                                checked={props.selected}
                                disabled={props.disabled}
                                onChange={(event) => props.onSelect(event.currentTarget.checked)}
                                class={twClasses("", jsxTailwindStyles, "input")}
                            />{" "}
                            <span class={twClasses("sr-only", jsxTailwindStyles, "span")}>
                                Select observation for merging
                            </span>
                        </label>
                        <span class={twClasses("annotation-type-icon", jsxTailwindStyles, "span")}>
                            <Icon name="annotations" />
                        </span>
                        <span class={twClasses("annotation-type-label", jsxTailwindStyles, "span")}>
                            {kind()}
                        </span>
                        <span
                            class={twClasses(
                                `annotation-priority priority-label-${priority()}`,
                                jsxTailwindStyles,
                                "span",
                            )}
                        >
                            {priority()}
                        </span>
                    </div>
                    <span class={twClasses("annotation-card-time", jsxTailwindStyles, "span")}>
                        <Icon name="clock" /> {time()}
                    </span>
                </header>
                <Show when={!editing()}>
                    <div class={twClasses("annotation-card-copy", jsxTailwindStyles, "div")}>
                        <h3 class={twClasses("", jsxTailwindStyles, "h3")}>
                            {field(props.record, "title") || kind()}
                        </h3>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            {field(props.record, "content")}
                        </p>
                    </div>
                    <div class={twClasses("annotation-card-actions", jsxTailwindStyles, "div")}>
                        <button
                            class={twClasses(
                                "button button-quiet record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => setEditing(true)}
                        >
                            Edit observation
                        </button>
                        <Show when={props.onPlayFromTimestamp}>
                            <button
                                class={twClasses(
                                    "button button-quiet record-action",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                disabled={props.disabled}
                                onClick={() => props.onPlayFromTimestamp?.(props.record)}
                            >
                                Play from timestamp
                            </button>
                        </Show>
                        <button
                            class={twClasses(
                                "button button-quiet record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => void props.onDuplicate()}
                        >
                            Duplicate
                        </button>
                        <label
                            class={twClasses(
                                "annotation-quick-priority",
                                jsxTailwindStyles,
                                "label",
                            )}
                        >
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
                                class={twClasses("", jsxTailwindStyles, "select")}
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
                            class={twClasses(
                                "button button-quiet record-action",
                                jsxTailwindStyles,
                                "button",
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
                            class={twClasses(
                                "button button-quiet record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => setSplitting((value) => !value)}
                        >
                            Split
                        </button>
                        <button
                            class={twClasses(
                                "button button-quiet record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
                            type="button"
                            aria-expanded={linksOpen()}
                            onClick={() => setLinksOpen((value) => !value)}
                        >
                            Links
                        </button>
                        <button
                            class={twClasses(
                                "button button-quiet record-action annotation-remove-action",
                                jsxTailwindStyles,
                                "button",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onRemove()}
                        >
                            Move to Trash
                        </button>
                    </div>
                    <Show when={operationError()}>
                        <p
                            role="alert"
                            class={twClasses("annotation-filter-empty", jsxTailwindStyles, "p")}
                        >
                            {operationError()}
                        </p>
                    </Show>
                    <Show when={splitting()}>
                        <section
                            class={twClasses("annotation-operation", jsxTailwindStyles, "section")}
                            aria-label="Split observation"
                        >
                            <p class={twClasses("", jsxTailwindStyles, "p")}>
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
                                class={twClasses("", jsxTailwindStyles, "textarea")}
                            />
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                Split after character {splitOffset()}
                            </span>
                            <label class={twClasses("", jsxTailwindStyles, "label")}>
                                Split time{" "}
                                <input
                                    placeholder="HH:MM:SS"
                                    value={splitTime()}
                                    onInput={(event) => setSplitTime(event.currentTarget.value)}
                                    class={twClasses("", jsxTailwindStyles, "input")}
                                />
                            </label>
                            <button
                                type="button"
                                class={twClasses(
                                    "button button-outline",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                disabled={props.disabled}
                                onClick={() => void split()}
                            >
                                Split observation
                            </button>
                        </section>
                    </Show>
                    <Show when={linksOpen()}>
                        <section
                            class={twClasses("annotation-operation", jsxTailwindStyles, "section")}
                            aria-label="Linked records"
                        >
                            <p class={twClasses("", jsxTailwindStyles, "p")}>
                                Link materials and evidence from this session.
                            </p>
                            <Show
                                when={props.targets.length}
                                fallback={
                                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                                        No materials or evidence available.
                                    </span>
                                }
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
                                            <label
                                                class={twClasses("", jsxTailwindStyles, "label")}
                                            >
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
                                                    class={twClasses(
                                                        "",
                                                        jsxTailwindStyles,
                                                        "input",
                                                    )}
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
                            class={twClasses(
                                "annotation-history-panel",
                                jsxTailwindStyles,
                                "section",
                            )}
                            aria-label="Observation version history"
                        >
                            <div
                                class={twClasses(
                                    "annotation-history-heading",
                                    jsxTailwindStyles,
                                    "div",
                                )}
                            >
                                <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                                    Version history
                                </span>
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    {Math.max(0, (history()?.length ?? 1) - 1)} earlier versions
                                </span>
                            </div>
                            <Show
                                when={(history()?.length ?? 0) > 1}
                                fallback={
                                    <p
                                        class={twClasses(
                                            "annotation-history-empty",
                                            jsxTailwindStyles,
                                            "p",
                                        )}
                                    >
                                        This observation has no earlier versions.
                                    </p>
                                }
                            >
                                <div
                                    class={twClasses(
                                        "annotation-history-list",
                                        jsxTailwindStyles,
                                        "div",
                                    )}
                                >
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
                                                <article
                                                    class={twClasses(
                                                        "annotation-history-entry",
                                                        jsxTailwindStyles,
                                                        "article",
                                                    )}
                                                >
                                                    <div
                                                        class={twClasses(
                                                            "",
                                                            jsxTailwindStyles,
                                                            "div",
                                                        )}
                                                    >
                                                        <strong
                                                            class={twClasses(
                                                                "",
                                                                jsxTailwindStyles,
                                                                "strong",
                                                            )}
                                                        >
                                                            {field(revision, "title") ||
                                                                annotationTypeLabel(
                                                                    field(revision, "type"),
                                                                )}
                                                        </strong>
                                                        <small
                                                            class={twClasses(
                                                                "",
                                                                jsxTailwindStyles,
                                                                "small",
                                                            )}
                                                        >
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
                                                    <p
                                                        class={twClasses(
                                                            "",
                                                            jsxTailwindStyles,
                                                            "p",
                                                        )}
                                                    >
                                                        {field(revision, "content")}
                                                    </p>
                                                    <button
                                                        class={twClasses(
                                                            "button button-outline record-action",
                                                            jsxTailwindStyles,
                                                            "button",
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
        <form class={twClasses("annotation-form", jsxTailwindStyles, "form")} onSubmit={submit}>
            <div class={twClasses("annotation-form-grid", jsxTailwindStyles, "div")}>
                <label class={twClasses("form-field", jsxTailwindStyles, "label")}>
                    Type
                    <select
                        value={type()}
                        onChange={(event) =>
                            setType(event.currentTarget.value as AnnotationInput["type"])
                        }
                        class={twClasses("", jsxTailwindStyles, "select")}
                    >
                        <For each={ANNOTATION_TYPES}>
                            {(value) => <option value={value}>{annotationTypeLabel(value)}</option>}
                        </For>
                    </select>
                </label>
                <label class={twClasses("form-field", jsxTailwindStyles, "label")}>
                    Priority
                    <select
                        value={priority()}
                        onChange={(event) =>
                            setPriority(event.currentTarget.value as AnnotationInput["priority"])
                        }
                        class={twClasses("", jsxTailwindStyles, "select")}
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
                <label
                    class={twClasses(
                        "form-field annotation-form-title",
                        jsxTailwindStyles,
                        "label",
                    )}
                >
                    Title{" "}
                    <span class={twClasses("optional", jsxTailwindStyles, "span")}>optional</span>
                    <input
                        value={title()}
                        onInput={(event) => setTitle(event.currentTarget.value)}
                        maxlength="512"
                        class={twClasses("", jsxTailwindStyles, "input")}
                    />
                </label>
                <label class={twClasses("form-field", jsxTailwindStyles, "label")}>
                    Start time
                    <input
                        value={start()}
                        onInput={(event) => setStart(event.currentTarget.value)}
                        placeholder="HH:MM:SS"
                        inputmode="decimal"
                        required
                        class={twClasses("", jsxTailwindStyles, "input")}
                    />
                </label>
                <label class={twClasses("form-field", jsxTailwindStyles, "label")}>
                    End time{" "}
                    <span class={twClasses("optional", jsxTailwindStyles, "span")}>optional</span>
                    <input
                        value={end()}
                        onInput={(event) => setEnd(event.currentTarget.value)}
                        placeholder="Same as start"
                        inputmode="decimal"
                        class={twClasses("", jsxTailwindStyles, "input")}
                    />
                </label>
            </div>
            <label class={twClasses("form-field", jsxTailwindStyles, "label")}>
                Observation
                <textarea
                    value={content()}
                    onInput={(event) => setContent(event.currentTarget.value)}
                    rows={4}
                    maxlength="16000000"
                    required
                    placeholder="What did you notice? Include context that will help you remember why it matters."
                    class={twClasses("", jsxTailwindStyles, "textarea")}
                />
            </label>
            <div class={twClasses("annotation-form-actions", jsxTailwindStyles, "div")}>
                <button
                    class={twClasses(
                        "button button-primary record-action",
                        jsxTailwindStyles,
                        "button",
                    )}
                    type="submit"
                    disabled={props.disabled || !content().trim()}
                >
                    <Icon name="check" /> {props.submitLabel}
                </button>
                <button
                    class={twClasses(
                        "button button-quiet record-action",
                        jsxTailwindStyles,
                        "button",
                    )}
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
