import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import type { ArchiveRecord } from "./archive/format";
import {
    EVIDENCE_RELATIONSHIPS,
    classifyTranscriptEvidence,
    type EvidenceCreateInput,
    type EvidenceUpdateInput,
} from "./domain/evidence";
import { createEvidenceGraphLayout, type EvidenceGraphLayout } from "./domain/evidence-graph";
import { formatTranscriptTimestampUs } from "./domain/transcript";
import { EvidenceSources } from "./lazy-components";
import { Icon } from "./shared-ui";
import { field, pluralize } from "./shared-utils";
import {
    bodyText,
    buttonOutline,
    buttonPrimary,
    buttonQuiet,
    card,
    cn,
    eyebrow,
    heading1,
    heading2,
    heading3,
    inputBase,
    labelBase,
    mutedText,
    pageBody,
    selectBase,
    textareaBase,
} from "./ui";

const cardAction = "min-h-8 px-3 text-xs";

function timestampForEvidence(record: ArchiveRecord): bigint {
    try {
        const timestamp = BigInt(field(record, "start_time_us", "0"));
        return timestamp < 0n ? 0n : timestamp;
    } catch {
        return 0n;
    }
}

function evidenceTranscriptLabel(record: ArchiveRecord): string {
    const speaker = field(record, "speaker_label");
    const text = field(record, "text").replace(/\s+/gu, " ").trim();
    const preview = Array.from(text).slice(0, 96).join("");
    return `${formatTranscriptTimestampUs(timestampForEvidence(record))}${speaker ? ` · ${speaker}` : ""} — ${preview || "Empty segment"}`;
}

export function EvidencePage(props: {
    snapshot: ArchiveSnapshot;
    sessions: ArchiveRecord[];
    records: ArchiveRecord[];
    edges: ArchiveRecord[];
    transcripts: ArchiveRecord[];
    assets: ArchiveRecord[];
    selectedSessionId: string;
    disabled: boolean;
    onSelectSession: (sessionId: string) => void;
    onExtract: (sessionId: string) => Promise<void>;
    onCreate: (
        sessionId: string,
        segmentId: string,
        input: EvidenceCreateInput,
    ) => Promise<boolean>;
    onReview: (record: ArchiveRecord, outcome: "human-verified" | "rejected") => void;
    onLink: (fromId: string, toId: string, relationship: string) => void;
    onUnlink: (edge: ArchiveRecord) => void;
    onUpdate: (record: ArchiveRecord, input: EvidenceUpdateInput) => Promise<boolean>;
    onTrash: (record: ArchiveRecord) => void;
}): JSX.Element {
    const [fromId, setFromId] = createSignal("");
    const [toId, setToId] = createSignal("");
    const [evidenceFilter, setEvidenceFilter] = createSignal<"all" | "review" | "verified">("all");
    const [sourceSegmentId, setSourceSegmentId] = createSignal("");
    const [createTitle, setCreateTitle] = createSignal("");
    const [createType, setCreateType] = createSignal("tutor-observation");
    const [createPriority, setCreatePriority] = createSignal("normal");
    const [createContent, setCreateContent] = createSignal("");
    const [saving, setSaving] = createSignal(false);
    const [relationship, setRelationship] =
        createSignal<(typeof EVIDENCE_RELATIONSHIPS)[number]>("supports");
    const selectedSession = createMemo(() =>
        props.sessions.find((session) => session.id === props.selectedSessionId),
    );
    const createdAt = (record: ArchiveRecord): bigint => {
        try {
            return BigInt(field(record, "created_at_us", "0"));
        } catch {
            return 0n;
        }
    };
    const sessionRecords = createMemo(() => {
        const session = selectedSession();
        if (!session) return [] as ArchiveRecord[];
        return [...props.records]
            .filter((record) => field(record, "session_id") === session.id)
            .sort((left, right) => {
                const leftAt = createdAt(left);
                const rightAt = createdAt(right);
                return leftAt > rightAt ? -1 : leftAt < rightAt ? 1 : 0;
            });
    });
    const evidenceFilters = [
        { id: "all", label: "All evidence" },
        { id: "review", label: "Review queue" },
        { id: "verified", label: "Verified" },
    ] as const;
    const evidenceFilterCount = (filter: (typeof evidenceFilters)[number]["id"]): number => {
        if (filter === "all") return sessionRecords().length;
        if (filter === "verified")
            return sessionRecords().filter(
                (record) => field(record, "verification_state") === "human-verified",
            ).length;
        return sessionRecords().filter(
            (record) => field(record, "verification_state", "needs-review") !== "human-verified",
        ).length;
    };
    const visibleEvidenceRecords = createMemo(() => {
        const filter = evidenceFilter();
        return sessionRecords().filter((record) => {
            const state = field(record, "verification_state", "needs-review");
            return (
                filter === "all" ||
                (filter === "verified" ? state === "human-verified" : state !== "human-verified")
            );
        });
    });
    const sessionTranscripts = createMemo(() => {
        const session = selectedSession();
        if (!session) return [] as ArchiveRecord[];
        return [...props.transcripts]
            .filter(
                (record) => field(record, "session_id").toLowerCase() === session.id.toLowerCase(),
            )
            .sort((left, right) => {
                const leftAt = timestampForEvidence(left);
                const rightAt = timestampForEvidence(right);
                return leftAt < rightAt
                    ? -1
                    : leftAt > rightAt
                      ? 1
                      : left.id.localeCompare(right.id);
            });
    });
    const selectedSegment = createMemo(
        () => sessionTranscripts().find((record) => record.id === sourceSegmentId()) ?? null,
    );
    const selectedSegmentAssetIds = createMemo(() =>
        (selectedSegment()?.fields.get("linked_asset_ids") ?? "")
            .split(",")
            .map((id) => id.trim().toLowerCase())
            .filter(Boolean),
    );
    const selectedSegmentAssets = createMemo(() => {
        const ids = new Set(selectedSegmentAssetIds());
        return props.assets.filter((asset) => ids.has(asset.id.toLowerCase()));
    });
    const sessionEdges = createMemo(() => {
        const ids = new Set(sessionRecords().map((record) => record.id.toLowerCase()));
        const sessionId = selectedSession()?.id.toLowerCase() ?? "";
        return props.edges.filter(
            (edge) =>
                field(edge, "session_id").toLowerCase() === sessionId ||
                ids.has(field(edge, "from_id").toLowerCase()) ||
                ids.has(field(edge, "to_id").toLowerCase()),
        );
    });
    const graph = createMemo(() => createEvidenceGraphLayout(sessionRecords(), sessionEdges()));

    function chooseTranscriptSource(segmentId: string): void {
        setSourceSegmentId(segmentId);
        const segment = sessionTranscripts().find((record) => record.id === segmentId);
        if (!segment) {
            setCreateTitle("");
            setCreateType("tutor-observation");
            setCreateContent("");
            return;
        }
        const text = field(segment, "text");
        const candidate = classifyTranscriptEvidence(text)[0];
        setCreateTitle(candidate?.title ?? "Tutor observation");
        setCreateType(candidate?.type ?? "tutor-observation");
        setCreateContent(text);
    }

    function resetCreateForm(): void {
        setSourceSegmentId("");
        setCreateTitle("");
        setCreateType("tutor-observation");
        setCreatePriority("normal");
        setCreateContent("");
    }

    createEffect(
        on(
            () => selectedSession()?.id,
            () => resetCreateForm(),
            { defer: true },
        ),
    );

    async function extractEvidence(): Promise<void> {
        const session = selectedSession();
        if (!session || saving() || props.disabled) return;
        setSaving(true);
        try {
            await props.onExtract(session.id);
        } finally {
            setSaving(false);
        }
    }

    async function submitEvidence(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const session = selectedSession();
        if (!session || !sourceSegmentId() || saving()) return;
        setSaving(true);
        try {
            const saved = await props.onCreate(session.id, sourceSegmentId(), {
                title: createTitle(),
                type: createType(),
                priority: createPriority(),
                content: createContent(),
            });
            if (!saved) return;
            resetCreateForm();
        } finally {
            setSaving(false);
        }
    }

    return (
        <div class={cn("page-body evidence-page flex flex-col gap-5", pageBody)}>
            <section class="record-heading evidence-heading mb-5 flex flex-wrap items-center justify-between gap-5 max-[700px]:flex-col max-[700px]:items-start">
                <div class="grid gap-1">
                    <span class={eyebrow}>A traceable record of learning</span>
                    <h1 class={heading1}>Evidence</h1>
                    <p class={cn("m-0 max-w-[620px] text-muted", bodyText)}>
                        Review what the session supports, check each source revision, then connect
                        related ideas.
                    </p>
                </div>
                <button
                    class={cn("button button-primary", buttonPrimary)}
                    type="button"
                    disabled={props.disabled || !selectedSession() || saving()}
                    onClick={() => void extractEvidence()}
                >
                    <Icon name="spark" />
                    Extract session evidence
                </button>
            </section>

            <section
                class={cn(
                    "evidence-session-bar surface-card flex flex-wrap items-center justify-between gap-6 p-5 max-[700px]:flex-col max-[700px]:items-start",
                    card,
                )}
            >
                <label class="material-session-picker flex items-center gap-3 text-xs text-muted max-[700px]:w-full max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-1">
                    <span>Session to review</span>
                    <select
                        value={selectedSession()?.id ?? ""}
                        disabled={props.sessions.length === 0}
                        onChange={(event) => {
                            props.onSelectSession(event.currentTarget.value);
                            setFromId("");
                            setToId("");
                            chooseTranscriptSource("");
                        }}
                        aria-label="Evidence session"
                        class={cn(selectBase, "w-auto min-w-[220px] max-[700px]:w-full")}
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
                                    {field(session, "title", "Untitled session")}
                                </option>
                            )}
                        </For>
                    </select>
                </label>
                <div class="evidence-session-counts flex items-center gap-5 text-xs text-muted max-[700px]:w-full max-[700px]:justify-between max-[700px]:gap-2">
                    <span>
                        <strong class="font-semibold text-ink">
                            {
                                sessionRecords().filter(
                                    (record) =>
                                        field(record, "verification_state") === "needs-review",
                                ).length
                            }
                        </strong>{" "}
                        to review
                    </span>
                    <span>
                        <strong class="font-semibold text-ink">
                            {
                                sessionRecords().filter(
                                    (record) =>
                                        field(record, "verification_state") === "human-verified",
                                ).length
                            }
                        </strong>{" "}
                        verified
                    </span>
                    <span>
                        <strong class="font-semibold text-ink">{sessionEdges().length}</strong>{" "}
                        links
                    </span>
                </div>
            </section>

            <Show when={selectedSession()}>
                <section
                    class={cn(
                        "evidence-create surface-card grid grid-cols-[minmax(190px,0.75fr)_minmax(0,1.6fr)] items-start gap-5 p-4 max-[900px]:grid-cols-1",
                        card,
                    )}
                    aria-labelledby="evidence-create-title"
                >
                    <div class="evidence-create-heading grid gap-1.5">
                        <span class={eyebrow}>Tutor-authored source</span>
                        <h2 id="evidence-create-title" class={heading2}>
                            Add evidence from a transcript
                        </h2>
                        <p class={cn("m-0", mutedText)}>
                            Write a reviewed claim and keep its source segment, revision, and linked
                            materials attached.
                        </p>
                    </div>
                    <form
                        class="evidence-create-form grid grid-cols-2 items-end gap-3 max-[700px]:grid-cols-1"
                        onSubmit={(event) => void submitEvidence(event)}
                    >
                        <label class={labelBase}>
                            <span>Transcript segment</span>
                            <select
                                aria-label="Transcript source segment"
                                required
                                value={sourceSegmentId()}
                                disabled={props.disabled || sessionTranscripts().length === 0}
                                onChange={(event) =>
                                    chooseTranscriptSource(event.currentTarget.value)
                                }
                                class={selectBase}
                            >
                                <option value="">Choose a transcript segment</option>
                                <For each={sessionTranscripts()}>
                                    {(segment) => (
                                        <option value={segment.id}>
                                            {evidenceTranscriptLabel(segment)}
                                        </option>
                                    )}
                                </For>
                            </select>
                        </label>
                        <label class={labelBase}>
                            <span>Title</span>
                            <input
                                aria-label="Evidence title"
                                required
                                maxLength={512}
                                value={createTitle()}
                                disabled={props.disabled || !sourceSegmentId()}
                                onInput={(event) => setCreateTitle(event.currentTarget.value)}
                                class={inputBase}
                            />
                        </label>
                        <label class={labelBase}>
                            <span>Type</span>
                            <input
                                aria-label="Evidence type"
                                required
                                maxLength={128}
                                value={createType()}
                                disabled={props.disabled || !sourceSegmentId()}
                                onInput={(event) => setCreateType(event.currentTarget.value)}
                                class={inputBase}
                            />
                        </label>
                        <label class={labelBase}>
                            <span>Priority</span>
                            <select
                                aria-label="Evidence priority"
                                value={createPriority()}
                                disabled={props.disabled || !sourceSegmentId()}
                                onChange={(event) => setCreatePriority(event.currentTarget.value)}
                                class={selectBase}
                            >
                                <option value="low">Low</option>
                                <option value="normal">Normal</option>
                                <option value="high">High</option>
                                <option value="critical">Critical</option>
                            </select>
                        </label>
                        <label class={cn("evidence-create-content col-span-full", labelBase)}>
                            <span>Evidence</span>
                            <textarea
                                aria-label="Evidence content"
                                required
                                value={createContent()}
                                disabled={props.disabled || !sourceSegmentId()}
                                onInput={(event) => setCreateContent(event.currentTarget.value)}
                                class={textareaBase}
                            />
                        </label>
                        <div class="evidence-create-footer col-span-full flex flex-wrap items-center justify-between gap-2 max-[700px]:flex-col max-[700px]:items-start">
                            <Show
                                when={selectedSegmentAssets().length > 0}
                                fallback={
                                    <small class={mutedText}>
                                        {selectedSegmentAssetIds().length > 0
                                            ? "Linked material metadata is unavailable. Source IDs will still be preserved."
                                            : "The source transcript revision will be recorded with this item."}
                                    </small>
                                }
                            >
                                <small class={mutedText}>
                                    Linked materials:{" "}
                                    {selectedSegmentAssets()
                                        .map((asset) => field(asset, "filename", "Material"))
                                        .join(", ")}
                                    {selectedSegmentAssetIds().length >
                                    selectedSegmentAssets().length
                                        ? ` · ${selectedSegmentAssetIds().length - selectedSegmentAssets().length} unavailable`
                                        : ""}
                                </small>
                            </Show>
                            <button
                                class={cn("button button-primary", buttonPrimary)}
                                type="submit"
                                disabled={
                                    props.disabled ||
                                    saving() ||
                                    !selectedSession() ||
                                    !sourceSegmentId() ||
                                    !createTitle().trim() ||
                                    !createType().trim() ||
                                    !createContent().trim()
                                }
                            >
                                Create evidence
                            </button>
                        </div>
                    </form>
                </section>
            </Show>

            <Show
                when={selectedSession()}
                fallback={
                    <Show
                        when={props.sessions.length === 0}
                        fallback={
                            <section
                                class={cn(
                                    "surface-card evidence-empty flex min-h-[245px] flex-col items-center justify-center gap-2 p-8 text-center",
                                    card,
                                )}
                            >
                                <span class="material-empty-mark grid h-12 w-12 shrink-0 place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent">
                                    <Icon name="evidence" />
                                </span>
                                <h2 class={heading2}>Session unavailable</h2>
                                <p class={cn("m-0 max-w-[440px]", mutedText)}>
                                    The selected session is not in this workspace. Choose another
                                    session above.
                                </p>
                            </section>
                        }
                    >
                        <section
                            class={cn(
                                "surface-card evidence-empty flex min-h-[245px] flex-col items-center justify-center gap-2 p-8 text-center",
                                card,
                            )}
                        >
                            <span class="material-empty-mark grid h-12 w-12 shrink-0 place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent">
                                <Icon name="evidence" />
                            </span>
                            <h2 class={heading2}>Start with a tutoring session</h2>
                            <p class={cn("m-0 max-w-[440px]", mutedText)}>
                                Evidence is grounded in observations and transcript cues from a
                                specific session.
                            </p>
                        </section>
                    </Show>
                }
            >
                <Show
                    when={sessionRecords().length > 0}
                    fallback={
                        <section
                            class={cn(
                                "surface-card evidence-empty flex min-h-[245px] flex-col items-center justify-center gap-2 p-8 text-center",
                                card,
                            )}
                        >
                            <span class="material-empty-mark grid h-12 w-12 shrink-0 place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent">
                                <Icon name="evidence" />
                            </span>
                            <h2 class={heading2}>Evidence begins with what happened</h2>
                            <p class={cn("m-0 max-w-[440px]", mutedText)}>
                                Extract tutor observations and transcript cues from this session.
                                Spoken cues stay unverified until you review them.
                            </p>
                            <button
                                class={cn("button button-outline", buttonOutline)}
                                type="button"
                                disabled={props.disabled || saving()}
                                onClick={() => void extractEvidence()}
                            >
                                Extract evidence
                            </button>
                        </section>
                    }
                >
                    <section
                        class={cn(
                            "evidence-review-toolbar surface-card flex flex-wrap items-center justify-between gap-4 p-3.5 max-[700px]:flex-col max-[700px]:items-start",
                            card,
                        )}
                    >
                        <div class="evidence-review-toolbar-copy grid min-w-0 gap-1">
                            <strong class="text-sm font-semibold text-ink">
                                Review session evidence
                            </strong>
                            <small class={mutedText}>
                                Rejected items stay in the review queue so you can reconsider them.
                            </small>
                        </div>
                        <div
                            class="evidence-review-filter-list flex flex-wrap justify-end gap-1.5 max-[700px]:w-full max-[700px]:justify-start"
                            role="group"
                            aria-label="Filter evidence by review status"
                        >
                            <For each={evidenceFilters}>
                                {(filter) => (
                                    <button
                                        class={cn(
                                            "button button-quiet evidence-review-filter min-h-[31px] px-2.5 text-xs",
                                            buttonQuiet,
                                            "aria-pressed:bg-accent-soft aria-pressed:text-accent",
                                        )}
                                        type="button"
                                        aria-pressed={evidenceFilter() === filter.id}
                                        onClick={() => setEvidenceFilter(filter.id)}
                                    >
                                        <span>{filter.label}</span>
                                        <span class="evidence-review-filter-count min-w-[18px] rounded-[5px] bg-line/40 px-1 py-0.5 text-center text-xs text-muted">
                                            {evidenceFilterCount(filter.id)}
                                        </span>
                                    </button>
                                )}
                            </For>
                        </div>
                    </section>
                    <section class="evidence-list grid gap-3" aria-label="Session evidence">
                        <Show
                            when={visibleEvidenceRecords().length > 0}
                            fallback={
                                <div
                                    class={cn(
                                        "evidence-filter-empty surface-card flex min-h-[70px] flex-wrap items-center justify-between gap-3 p-3.5 text-xs text-muted max-[700px]:flex-col max-[700px]:items-start",
                                        card,
                                    )}
                                    role="status"
                                >
                                    <span>
                                        {evidenceFilter() === "review"
                                            ? "Everything in this session has been verified."
                                            : "There are no verified items in this session yet."}
                                    </span>
                                    <button
                                        class={cn("button button-quiet", buttonQuiet)}
                                        type="button"
                                        onClick={() => setEvidenceFilter("all")}
                                    >
                                        Show all evidence
                                    </button>
                                </div>
                            }
                        >
                            <For each={visibleEvidenceRecords()}>
                                {(record) => (
                                    <EvidenceCard
                                        snapshot={props.snapshot}
                                        record={record}
                                        assets={props.assets}
                                        disabled={props.disabled}
                                        onReview={props.onReview}
                                        onUpdate={props.onUpdate}
                                        onTrash={props.onTrash}
                                    />
                                )}
                            </For>
                        </Show>
                    </section>

                    <section class={cn("evidence-graph surface-card p-5", card)}>
                        <div class="evidence-graph-heading mb-4 flex items-center justify-between gap-3">
                            <div class="grid gap-1">
                                <span class={eyebrow}>Relationships</span>
                                <h2 class={heading2}>Connect the evidence</h2>
                            </div>
                            <span class="text-xs text-muted">
                                {pluralize(graph().nodes.length, "item")} ·{" "}
                                {pluralize(graph().edges.length, "link")}
                            </span>
                        </div>
                        <div
                            class="evidence-graph-legend flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted"
                            aria-label="Evidence map legend"
                        >
                            <span class="inline-flex items-center gap-1.5">
                                <i
                                    class="evidence-legend-dot evidence-legend-review inline-block h-[7px] w-[7px] rounded-full bg-warning"
                                    aria-hidden="true"
                                />
                                Needs review
                            </span>
                            <span class="inline-flex items-center gap-1.5">
                                <i
                                    class="evidence-legend-dot evidence-legend-verified inline-block h-[7px] w-[7px] rounded-full bg-success"
                                    aria-hidden="true"
                                />
                                Verified
                            </span>
                            <span class="inline-flex items-center gap-1.5">
                                <i
                                    class="evidence-legend-line evidence-legend-contradiction inline-block h-0 w-4 border-t-2 border-dashed border-warning"
                                    aria-hidden="true"
                                />
                                Contradicts
                            </span>
                        </div>
                        <EvidenceNetwork layout={graph()} />
                        <section
                            class="evidence-contradictions mb-4 rounded-[5px] border border-line-soft bg-surface-subtle p-3.5"
                            aria-labelledby="evidence-contradictions-title"
                        >
                            <div class="evidence-contradictions-heading flex items-center justify-between gap-3">
                                <div class="grid gap-1">
                                    <span class={eyebrow}>Source review</span>
                                    <h3 id="evidence-contradictions-title" class={heading3}>
                                        Explicit contradiction links
                                    </h3>
                                </div>
                                <span class="text-xs text-muted">
                                    {graph().contradictions.length}
                                </span>
                            </div>
                            <p class={cn("m-0 mt-1.5", mutedText)}>
                                These pairs were explicitly linked as contradictions. Review each
                                item’s source status above.
                            </p>
                            <Show
                                when={graph().contradictions.length > 0}
                                fallback={
                                    <small class={cn("mt-1.5 block", mutedText)}>
                                        No evidence items are explicitly linked as contradicting
                                        another.
                                    </small>
                                }
                            >
                                <div class="evidence-contradiction-list mt-2.5 grid gap-1.5">
                                    <For each={graph().contradictions}>
                                        {(pair) => (
                                            <div class="evidence-contradiction-row grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2.5 rounded-[5px] border border-warning bg-surface px-2.5 py-2 text-xs text-ink-soft max-[700px]:grid-cols-1 max-[700px]:gap-1">
                                                <span>
                                                    {field(pair.first, "title", "Evidence item")}
                                                </span>
                                                <strong class="font-semibold text-ink">
                                                    contradicts
                                                </strong>
                                                <span>
                                                    {field(pair.second, "title", "Evidence item")}
                                                </span>
                                            </div>
                                        )}
                                    </For>
                                </div>
                            </Show>
                            <Show when={graph().invalidEdgeCount > 0}>
                                <p
                                    class="evidence-graph-warning m-0 mt-2 text-xs font-medium text-warning"
                                    role="status"
                                >
                                    {graph().invalidEdgeCount} relationship
                                    {graph().invalidEdgeCount === 1 ? "" : "s"} could not be drawn
                                    because an endpoint or session reference is invalid.
                                </p>
                            </Show>
                        </section>
                        <form
                            class="evidence-link-form mt-4 grid grid-cols-[minmax(0,1fr)_170px_minmax(0,1fr)_auto] items-end gap-2.5 max-[900px]:grid-cols-2 max-[700px]:grid-cols-1"
                            onSubmit={(event) => {
                                event.preventDefault();
                                if (fromId() && toId())
                                    props.onLink(fromId(), toId(), relationship());
                            }}
                        >
                            <label class={labelBase}>
                                <span>From</span>
                                <select
                                    required
                                    value={fromId()}
                                    disabled={props.disabled}
                                    onChange={(event) => setFromId(event.currentTarget.value)}
                                    class={selectBase}
                                >
                                    <option value="">Choose evidence</option>
                                    <For each={sessionRecords()}>
                                        {(record) => (
                                            <option value={record.id}>
                                                {field(
                                                    record,
                                                    "title",
                                                    field(record, "type", "Evidence"),
                                                )}
                                            </option>
                                        )}
                                    </For>
                                </select>
                            </label>
                            <label class={labelBase}>
                                <span>Relationship</span>
                                <select
                                    value={relationship()}
                                    disabled={props.disabled}
                                    onChange={(event) =>
                                        setRelationship(
                                            event.currentTarget
                                                .value as (typeof EVIDENCE_RELATIONSHIPS)[number],
                                        )
                                    }
                                    class={selectBase}
                                >
                                    <For each={EVIDENCE_RELATIONSHIPS}>
                                        {(value) => (
                                            <option value={value}>
                                                {value.replaceAll("-", " ")}
                                            </option>
                                        )}
                                    </For>
                                </select>
                            </label>
                            <label class={labelBase}>
                                <span>To</span>
                                <select
                                    required
                                    value={toId()}
                                    disabled={props.disabled}
                                    onChange={(event) => setToId(event.currentTarget.value)}
                                    class={selectBase}
                                >
                                    <option value="">Choose evidence</option>
                                    <For each={sessionRecords()}>
                                        {(record) => (
                                            <option value={record.id}>
                                                {field(
                                                    record,
                                                    "title",
                                                    field(record, "type", "Evidence"),
                                                )}
                                            </option>
                                        )}
                                    </For>
                                </select>
                            </label>
                            <button
                                class={cn("button button-outline", buttonOutline)}
                                type="submit"
                                disabled={
                                    props.disabled ||
                                    sessionRecords().length < 2 ||
                                    !fromId() ||
                                    !toId()
                                }
                            >
                                Add relationship
                            </button>
                        </form>
                        <Show when={sessionEdges().length > 0}>
                            <div class="evidence-edge-list mt-4 grid gap-2 border-t border-line-soft pt-3.5">
                                <For each={sessionEdges()}>
                                    {(edge) => {
                                        const from = () =>
                                            sessionRecords().find(
                                                (record) =>
                                                    record.id.toLowerCase() ===
                                                    field(edge, "from_id").toLowerCase(),
                                            );
                                        const to = () =>
                                            sessionRecords().find(
                                                (record) =>
                                                    record.id.toLowerCase() ===
                                                    field(edge, "to_id").toLowerCase(),
                                            );
                                        return (
                                            <div class="evidence-edge-row grid grid-cols-[minmax(0,1fr)_minmax(90px,160px)_minmax(0,1fr)_auto] items-center gap-2.5 text-xs text-ink-soft max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:gap-1">
                                                <span>
                                                    {from()
                                                        ? field(
                                                              from()!,
                                                              "title",
                                                              field(from()!, "type", "Evidence"),
                                                          )
                                                        : "Missing evidence item"}
                                                </span>
                                                <strong class="font-semibold text-ink">
                                                    {field(
                                                        edge,
                                                        "relationship",
                                                        "unknown",
                                                    ).replaceAll("-", " ")}
                                                </strong>
                                                <span>
                                                    {to()
                                                        ? field(
                                                              to()!,
                                                              "title",
                                                              field(to()!, "type", "Evidence"),
                                                          )
                                                        : "Missing evidence item"}
                                                </span>
                                                <button
                                                    class={cn(
                                                        "button button-quiet min-h-[28px] px-2 text-xs",
                                                        buttonQuiet,
                                                    )}
                                                    type="button"
                                                    disabled={
                                                        props.disabled ||
                                                        edge.fields.get("_deleted") === "true"
                                                    }
                                                    aria-label={`Remove relationship: ${field(edge, "relationship", "unknown")}`}
                                                    onClick={() => props.onUnlink(edge)}
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                        );
                                    }}
                                </For>
                            </div>
                        </Show>
                    </section>
                </Show>
            </Show>
        </div>
    );
}

function EvidenceNetwork(props: { layout: EvidenceGraphLayout }): JSX.Element {
    const itemLabel = () => (props.layout.nodes.length === 1 ? "evidence item" : "evidence items");
    const relationshipLabel = () =>
        props.layout.edges.length === 1 ? "relationship" : "relationships";
    return (
        <div
            class="evidence-network-scroll my-3 w-full overflow-x-auto rounded-[5px] border border-line-soft bg-surface-subtle"
            role="region"
            aria-label="Evidence relationship map"
        >
            <svg
                class="evidence-network block h-auto w-full min-w-[700px]"
                viewBox={`0 0 ${props.layout.width} ${props.layout.height}`}
                role="img"
                aria-label={`${props.layout.nodes.length} ${itemLabel()} connected by ${props.layout.edges.length} ${relationshipLabel()}`}
            >
                <defs>
                    <marker
                        id="evidence-edge-arrow"
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                    >
                        <path d="M 0 0 L 10 5 L 0 10 z" class="evidence-network-arrow fill-muted" />
                    </marker>
                </defs>
                <For each={props.layout.edges}>
                    {(edge) => {
                        const relationship = field(edge.record, "relationship", "references");
                        return (
                            <g
                                class={`evidence-network-link evidence-network-link-${relationship}`}
                            >
                                <path
                                    d={edge.path}
                                    marker-end="url(#evidence-edge-arrow)"
                                    class={cn(
                                        "fill-none stroke-[1.6]",
                                        relationship === "contradicts"
                                            ? "stroke-warning stroke-2 [stroke-dasharray:5_4]"
                                            : relationship === "supports" ||
                                                relationship === "reinforces"
                                              ? "stroke-accent"
                                              : "stroke-line",
                                    )}
                                >
                                    <title>{relationship.replaceAll("-", " ")}</title>
                                </path>
                                <text
                                    x={edge.labelX}
                                    y={edge.labelY - 5}
                                    text-anchor="middle"
                                    class="fill-muted stroke-surface-subtle stroke-[5px] text-xs [paint-order:stroke] [stroke-linejoin:round]"
                                >
                                    {relationship.replaceAll("-", " ")}
                                </text>
                            </g>
                        );
                    }}
                </For>
                <For each={props.layout.nodes}>
                    {(node) => {
                        const state = field(node.record, "verification_state", "needs-review");
                        const title = field(node.record, "title", "Evidence item");
                        const titleCharacters = Array.from(title);
                        const shortTitle =
                            titleCharacters.length > 23
                                ? `${titleCharacters.slice(0, 22).join("")}…`
                                : title;
                        return (
                            <g
                                class={`evidence-network-node evidence-network-node-${state}`}
                                transform={`translate(${node.x} ${node.y})`}
                            >
                                <title>{`${title} · ${state.replaceAll("-", " ")}`}</title>
                                <rect
                                    width="176"
                                    height="64"
                                    rx="8"
                                    class={cn(
                                        "stroke-1",
                                        state === "human-verified"
                                            ? "fill-surface stroke-success"
                                            : state === "needs-review"
                                              ? "fill-surface stroke-warning"
                                              : "fill-surface-subtle stroke-line [stroke-dasharray:4_3]",
                                    )}
                                />
                                <circle
                                    cx="14"
                                    cy="15"
                                    r="4"
                                    class={cn(
                                        state === "human-verified"
                                            ? "fill-success"
                                            : state === "needs-review"
                                              ? "fill-warning"
                                              : "fill-muted",
                                    )}
                                />
                                <text
                                    class="evidence-network-state fill-muted text-xs"
                                    x="24"
                                    y="18"
                                >
                                    {state.replaceAll("-", " ")}
                                </text>
                                <text class="evidence-network-title fill-ink text-xs" x="12" y="39">
                                    {shortTitle}
                                </text>
                                <text
                                    class="evidence-network-type fill-faint text-xs"
                                    x="12"
                                    y="55"
                                >
                                    {field(node.record, "type", "learning evidence").replaceAll(
                                        "-",
                                        " ",
                                    )}
                                </text>
                            </g>
                        );
                    }}
                </For>
            </svg>
        </div>
    );
}

function EvidenceCard(props: {
    snapshot: ArchiveSnapshot;
    record: ArchiveRecord;
    assets: ArchiveRecord[];
    disabled: boolean;
    onReview: (record: ArchiveRecord, outcome: "human-verified" | "rejected") => void;
    onUpdate: (record: ArchiveRecord, input: EvidenceUpdateInput) => Promise<boolean>;
    onTrash: (record: ArchiveRecord) => void;
}): JSX.Element {
    const [editing, setEditing] = createSignal(false);
    const [title, setTitle] = createSignal("");
    const [type, setType] = createSignal("");
    const [priority, setPriority] = createSignal("");
    const [content, setContent] = createSignal("");
    const state = () => field(props.record, "verification_state", "needs-review");
    const sourceLabel = () => {
        const origin = field(props.record, "origin");
        if (field(props.record, "source_annotation_id")) return "Tutor observation";
        if (field(props.record, "source_segment_ids")) {
            return origin === "tutor-authored"
                ? "Tutor-authored transcript evidence"
                : "Transcript candidate";
        }
        return "Imported evidence";
    };
    const sourceAssetIds = () =>
        field(props.record, "source_asset_ids")
            .split(",")
            .map((id) => id.trim().toLowerCase())
            .filter(Boolean);
    const sourceAssets = createMemo(() => {
        const ids = new Set(sourceAssetIds());
        return props.assets.filter((asset) => ids.has(asset.id.toLowerCase()));
    });
    const beginEditing = (): void => {
        setTitle(field(props.record, "title", "Evidence from this session"));
        setType(field(props.record, "type", "learning-evidence"));
        setPriority(field(props.record, "priority", "normal"));
        setContent(field(props.record, "content"));
        setEditing(true);
    };
    const save = (event: SubmitEvent): void => {
        event.preventDefault();
        void props
            .onUpdate(props.record, {
                title: title(),
                type: type(),
                priority: priority(),
                content: content(),
            })
            .then((saved) => {
                if (saved) setEditing(false);
            });
    };
    const timestamp = () => field(props.record, "start_time_us");
    const formattedTimestamp = () => {
        try {
            return formatTranscriptTimestampUs(BigInt(timestamp()));
        } catch {
            return "Timestamp unavailable";
        }
    };

    return (
        <article
            class={cn(
                `evidence-card surface-card evidence-${state()} grid min-w-0 grid-cols-[4px_minmax(0,1fr)] overflow-hidden rounded-[5px]`,
                card,
            )}
            data-evidence-id={props.record.id}
        >
            <div
                class={cn(
                    "evidence-card-rail",
                    state() === "human-verified"
                        ? "bg-success"
                        : state() === "rejected"
                          ? "bg-faint"
                          : "bg-warning",
                )}
                aria-hidden="true"
            >
                <span class="block h-full w-full" />
            </div>
            <div class="evidence-card-content min-w-0 p-5 max-[700px]:p-3.5">
                <EvidenceSources record={props.record} snapshot={props.snapshot} />
                <header class="evidence-card-header flex flex-wrap items-center justify-between gap-3 max-[700px]:flex-col max-[700px]:items-start">
                    <div class="evidence-card-labels flex items-center justify-between gap-3">
                        <span class={eyebrow}>{sourceLabel()}</span>
                        <span
                            class={cn(
                                `evidence-state evidence-state-${state()} rounded-[5px] border px-2 py-1 text-xs font-semibold`,
                                state() === "human-verified"
                                    ? "border-success text-success"
                                    : state() === "rejected"
                                      ? "border-line text-faint"
                                      : "border-warning text-warning",
                            )}
                        >
                            {state() === "human-verified"
                                ? "Verified"
                                : state() === "rejected"
                                  ? "Rejected"
                                  : "Needs review"}
                        </span>
                    </div>
                    <span class="evidence-type text-xs capitalize text-faint">
                        {field(props.record, "type", "learning evidence").replaceAll("-", " ")}
                    </span>
                </header>
                <Show
                    when={editing()}
                    fallback={
                        <>
                            <h2 class="mt-3 text-lg font-medium tracking-tight text-ink">
                                {field(props.record, "title", "Evidence from this session")}
                            </h2>
                            <p class="evidence-content m-0 mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft wrap-anywhere">
                                {field(props.record, "content")}
                            </p>
                        </>
                    }
                >
                    <form class="evidence-edit-form mt-3.5 grid gap-3" onSubmit={save}>
                        <label class={labelBase}>
                            <span>Title</span>
                            <input
                                value={title()}
                                maxLength={512}
                                required
                                disabled={props.disabled}
                                onInput={(event) => setTitle(event.currentTarget.value)}
                                class={inputBase}
                            />
                        </label>
                        <div class="evidence-edit-row grid grid-cols-[minmax(0,2fr)_minmax(120px,1fr)] gap-2.5 max-[700px]:grid-cols-1">
                            <label class={labelBase}>
                                <span>Type</span>
                                <input
                                    value={type()}
                                    maxLength={128}
                                    required
                                    disabled={props.disabled}
                                    onInput={(event) => setType(event.currentTarget.value)}
                                    class={inputBase}
                                />
                            </label>
                            <label class={labelBase}>
                                <span>Priority</span>
                                <input
                                    value={priority()}
                                    maxLength={32}
                                    required
                                    disabled={props.disabled}
                                    onInput={(event) => setPriority(event.currentTarget.value)}
                                    class={inputBase}
                                />
                            </label>
                        </div>
                        <label class={labelBase}>
                            <span>Evidence</span>
                            <textarea
                                value={content()}
                                maxLength={16 * 1024 * 1024}
                                rows={5}
                                required
                                disabled={props.disabled}
                                onInput={(event) => setContent(event.currentTarget.value)}
                                class={textareaBase}
                            />
                        </label>
                        <div class="evidence-review-actions flex flex-wrap items-center justify-start gap-2 border-t border-line-soft pt-3">
                            <button
                                class={cn("button button-primary", buttonPrimary)}
                                type="submit"
                                disabled={props.disabled}
                            >
                                Save changes
                            </button>
                            <button
                                class={cn("button button-quiet", buttonQuiet)}
                                type="button"
                                disabled={props.disabled}
                                onClick={() => setEditing(false)}
                            >
                                Cancel
                            </button>
                        </div>
                    </form>
                </Show>
                <div class="evidence-source-meta mt-3 flex flex-wrap items-center gap-3 text-xs text-faint">
                    <Show when={timestamp()}>
                        <span class="inline-flex items-center gap-1">
                            <Icon name="clock" /> {formattedTimestamp()}
                        </span>
                    </Show>
                    <Show when={field(props.record, "detection_confidence")}>
                        <span>
                            Heuristic confidence {field(props.record, "detection_confidence")}
                        </span>
                    </Show>
                    <Show when={field(props.record, "source_speaker_label")}>
                        <span>Speaker: {field(props.record, "source_speaker_label")}</span>
                    </Show>
                    <For each={sourceAssets()}>
                        {(asset) => (
                            <span class="evidence-source-material text-ink-soft">
                                Material: {field(asset, "filename", "Untitled material")}
                            </span>
                        )}
                    </For>
                    <Show when={sourceAssetIds().length > sourceAssets().length}>
                        <span>
                            {sourceAssetIds().length - sourceAssets().length} linked materials
                            unavailable
                        </span>
                    </Show>
                </div>
                <Show when={!editing()}>
                    <div class="evidence-review-actions evidence-card-actions mt-4 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
                        <button
                            class={cn("button button-outline", buttonOutline, cardAction)}
                            type="button"
                            disabled={props.disabled}
                            onClick={beginEditing}
                        >
                            Edit evidence
                        </button>
                        <button
                            class={cn("button button-quiet", buttonQuiet, cardAction)}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onTrash(props.record)}
                        >
                            Move to Trash
                        </button>
                        <Show when={state() !== "human-verified"}>
                            <button
                                class={cn("button button-primary", buttonPrimary, cardAction)}
                                type="button"
                                disabled={props.disabled}
                                onClick={() => props.onReview(props.record, "human-verified")}
                            >
                                Approve source
                            </button>
                        </Show>
                        <button
                            class={cn("button button-quiet", buttonQuiet, cardAction)}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onReview(props.record, "rejected")}
                        >
                            {state() === "human-verified" ? "Revoke approval" : "Reject candidate"}
                        </button>
                    </div>
                </Show>
            </div>
        </article>
    );
}
