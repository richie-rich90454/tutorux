import { twClasses } from "./tailwind";
import { jsxTailwindStyles } from "./EvidencePage.tailwind";
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
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
import { field } from "./shared-utils";

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
    onExtract: (sessionId: string) => void;
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
    const [relationship, setRelationship] =
        createSignal<(typeof EVIDENCE_RELATIONSHIPS)[number]>("supports");
    const selectedSession = createMemo(
        () =>
            props.sessions.find((session) => session.id === props.selectedSessionId) ??
            props.sessions[0] ??
            null,
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

    function submitEvidence(event: SubmitEvent): void {
        event.preventDefault();
        const session = selectedSession();
        if (!session || !sourceSegmentId()) return;
        void props
            .onCreate(session.id, sourceSegmentId(), {
                title: createTitle(),
                type: createType(),
                priority: createPriority(),
                content: createContent(),
            })
            .then((saved) => {
                if (!saved) return;
                setSourceSegmentId("");
                setCreateTitle("");
                setCreateType("tutor-observation");
                setCreatePriority("normal");
                setCreateContent("");
            });
    }

    return (
        <div class={twClasses("page-body evidence-page", jsxTailwindStyles, "div")}>
            <section
                class={twClasses("record-heading evidence-heading", jsxTailwindStyles, "section")}
            >
                <div class={twClasses("", jsxTailwindStyles, "div")}>
                    <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                        A traceable record of learning
                    </span>
                    <h1 class={twClasses("", jsxTailwindStyles, "h1")}>Evidence</h1>
                    <p class={twClasses("", jsxTailwindStyles, "p")}>
                        Review what the session supports, check each source revision, then connect
                        related ideas.
                    </p>
                </div>
                <button
                    class={twClasses("button button-primary", jsxTailwindStyles, "button")}
                    type="button"
                    disabled={props.disabled || !selectedSession()}
                    onClick={() => selectedSession() && props.onExtract(selectedSession()!.id)}
                >
                    <Icon name="spark" />
                    Extract session evidence
                </button>
            </section>

            <section
                class={twClasses("evidence-session-bar surface-card", jsxTailwindStyles, "section")}
            >
                <label class={twClasses("material-session-picker", jsxTailwindStyles, "label")}>
                    <span class={twClasses("", jsxTailwindStyles, "span")}>Session to review</span>
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
                        class={twClasses("", jsxTailwindStyles, "select")}
                    >
                        <Show when={props.sessions.length === 0}>
                            <option value="">No sessions yet</option>
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
                <div class={twClasses("evidence-session-counts", jsxTailwindStyles, "div")}>
                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            {
                                sessionRecords().filter(
                                    (record) =>
                                        field(record, "verification_state") === "needs-review",
                                ).length
                            }
                        </strong>{" "}
                        to review
                    </span>
                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            {
                                sessionRecords().filter(
                                    (record) =>
                                        field(record, "verification_state") === "human-verified",
                                ).length
                            }
                        </strong>{" "}
                        verified
                    </span>
                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            {sessionEdges().length}
                        </strong>{" "}
                        links
                    </span>
                </div>
            </section>

            <Show when={selectedSession()}>
                <section
                    class={twClasses("evidence-create surface-card", jsxTailwindStyles, "section")}
                    aria-labelledby="evidence-create-title"
                >
                    <div class={twClasses("evidence-create-heading", jsxTailwindStyles, "div")}>
                        <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                            Tutor-authored source
                        </span>
                        <h2
                            id="evidence-create-title"
                            class={twClasses("", jsxTailwindStyles, "h2")}
                        >
                            Add evidence from a transcript
                        </h2>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            Write a reviewed claim and keep its source segment, revision, and linked
                            materials attached.
                        </p>
                    </div>
                    <form
                        class={twClasses("evidence-create-form", jsxTailwindStyles, "form")}
                        onSubmit={submitEvidence}
                    >
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                Transcript segment
                            </span>
                            <select
                                aria-label="Transcript source segment"
                                required
                                value={sourceSegmentId()}
                                disabled={props.disabled || sessionTranscripts().length === 0}
                                onChange={(event) =>
                                    chooseTranscriptSource(event.currentTarget.value)
                                }
                                class={twClasses("", jsxTailwindStyles, "select")}
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
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>Title</span>
                            <input
                                aria-label="Evidence title"
                                required
                                maxLength={512}
                                value={createTitle()}
                                disabled={props.disabled || !sourceSegmentId()}
                                onInput={(event) => setCreateTitle(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "input")}
                            />
                        </label>
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>Type</span>
                            <input
                                aria-label="Evidence type"
                                required
                                maxLength={128}
                                value={createType()}
                                disabled={props.disabled || !sourceSegmentId()}
                                onInput={(event) => setCreateType(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "input")}
                            />
                        </label>
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>Priority</span>
                            <select
                                aria-label="Evidence priority"
                                value={createPriority()}
                                disabled={props.disabled || !sourceSegmentId()}
                                onChange={(event) => setCreatePriority(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "select")}
                            >
                                <option value="low">Low</option>
                                <option value="normal">Normal</option>
                                <option value="high">High</option>
                                <option value="critical">Critical</option>
                            </select>
                        </label>
                        <label
                            class={twClasses("evidence-create-content", jsxTailwindStyles, "label")}
                        >
                            <span class={twClasses("", jsxTailwindStyles, "span")}>Evidence</span>
                            <textarea
                                aria-label="Evidence content"
                                required
                                value={createContent()}
                                disabled={props.disabled || !sourceSegmentId()}
                                onInput={(event) => setCreateContent(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "textarea")}
                            />
                        </label>
                        <div class={twClasses("evidence-create-footer", jsxTailwindStyles, "div")}>
                            <Show
                                when={selectedSegmentAssets().length > 0}
                                fallback={
                                    <small class={twClasses("", jsxTailwindStyles, "small")}>
                                        {selectedSegmentAssetIds().length > 0
                                            ? "Linked material metadata is unavailable. Source IDs will still be preserved."
                                            : "The source transcript revision will be recorded with this item."}
                                    </small>
                                }
                            >
                                <small class={twClasses("", jsxTailwindStyles, "small")}>
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
                                class={twClasses(
                                    "button button-primary",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="submit"
                                disabled={
                                    props.disabled ||
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
                    <section
                        class={twClasses(
                            "surface-card evidence-empty",
                            jsxTailwindStyles,
                            "section",
                        )}
                    >
                        <span class={twClasses("material-empty-mark", jsxTailwindStyles, "span")}>
                            <Icon name="evidence" />
                        </span>
                        <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                            Start with a tutoring session
                        </h2>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            Evidence is grounded in observations and transcript cues from a specific
                            session.
                        </p>
                    </section>
                }
            >
                <Show
                    when={sessionRecords().length > 0}
                    fallback={
                        <section
                            class={twClasses(
                                "surface-card evidence-empty",
                                jsxTailwindStyles,
                                "section",
                            )}
                        >
                            <span
                                class={twClasses("material-empty-mark", jsxTailwindStyles, "span")}
                            >
                                <Icon name="evidence" />
                            </span>
                            <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                                Evidence begins with what happened
                            </h2>
                            <p class={twClasses("", jsxTailwindStyles, "p")}>
                                Extract tutor observations and transcript cues from this session.
                                Spoken cues stay unverified until you review them.
                            </p>
                            <button
                                class={twClasses(
                                    "button button-outline",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                disabled={props.disabled}
                                onClick={() => props.onExtract(selectedSession()!.id)}
                            >
                                Extract evidence
                            </button>
                        </section>
                    }
                >
                    <section
                        class={twClasses(
                            "evidence-review-toolbar surface-card",
                            jsxTailwindStyles,
                            "section",
                        )}
                    >
                        <div
                            class={twClasses(
                                "evidence-review-toolbar-copy",
                                jsxTailwindStyles,
                                "div",
                            )}
                        >
                            <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                                Review session evidence
                            </strong>
                            <small class={twClasses("", jsxTailwindStyles, "small")}>
                                Rejected items stay in the review queue so you can reconsider them.
                            </small>
                        </div>
                        <div
                            class={twClasses(
                                "evidence-review-filter-list",
                                jsxTailwindStyles,
                                "div",
                            )}
                            role="group"
                            aria-label="Filter evidence by review status"
                        >
                            <For each={evidenceFilters}>
                                {(filter) => (
                                    <button
                                        class={twClasses(
                                            "button button-quiet evidence-review-filter",
                                            jsxTailwindStyles,
                                            "button",
                                        )}
                                        type="button"
                                        aria-pressed={evidenceFilter() === filter.id}
                                        onClick={() => setEvidenceFilter(filter.id)}
                                    >
                                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                                            {filter.label}
                                        </span>
                                        <span
                                            class={twClasses(
                                                "evidence-review-filter-count",
                                                jsxTailwindStyles,
                                                "span",
                                            )}
                                        >
                                            {evidenceFilterCount(filter.id)}
                                        </span>
                                    </button>
                                )}
                            </For>
                        </div>
                    </section>
                    <section
                        class={twClasses("evidence-list", jsxTailwindStyles, "section")}
                        aria-label="Session evidence"
                    >
                        <Show
                            when={visibleEvidenceRecords().length > 0}
                            fallback={
                                <div
                                    class={twClasses(
                                        "evidence-filter-empty surface-card",
                                        jsxTailwindStyles,
                                        "div",
                                    )}
                                    role="status"
                                >
                                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                                        {evidenceFilter() === "review"
                                            ? "Everything in this session has been verified."
                                            : "There are no verified items in this session yet."}
                                    </span>
                                    <button
                                        class={twClasses(
                                            "button button-quiet",
                                            jsxTailwindStyles,
                                            "button",
                                        )}
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

                    <section
                        class={twClasses(
                            "evidence-graph surface-card",
                            jsxTailwindStyles,
                            "section",
                        )}
                    >
                        <div class={twClasses("evidence-graph-heading", jsxTailwindStyles, "div")}>
                            <div class={twClasses("", jsxTailwindStyles, "div")}>
                                <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                                    Relationships
                                </span>
                                <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                                    Connect the evidence
                                </h2>
                            </div>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                {graph().nodes.length} items · {graph().edges.length} links
                            </span>
                        </div>
                        <div
                            class={twClasses("evidence-graph-legend", jsxTailwindStyles, "div")}
                            aria-label="Evidence map legend"
                        >
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                <i
                                    class={twClasses(
                                        "evidence-legend-dot evidence-legend-review",
                                        jsxTailwindStyles,
                                        "i",
                                    )}
                                    aria-hidden="true"
                                />
                                Needs review
                            </span>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                <i
                                    class={twClasses(
                                        "evidence-legend-dot evidence-legend-verified",
                                        jsxTailwindStyles,
                                        "i",
                                    )}
                                    aria-hidden="true"
                                />
                                Verified
                            </span>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                <i
                                    class={twClasses(
                                        "evidence-legend-line evidence-legend-contradiction",
                                        jsxTailwindStyles,
                                        "i",
                                    )}
                                    aria-hidden="true"
                                />
                                Contradicts
                            </span>
                        </div>
                        <EvidenceNetwork layout={graph()} />
                        <section
                            class={twClasses(
                                "evidence-contradictions",
                                jsxTailwindStyles,
                                "section",
                            )}
                            aria-labelledby="evidence-contradictions-title"
                        >
                            <div
                                class={twClasses(
                                    "evidence-contradictions-heading",
                                    jsxTailwindStyles,
                                    "div",
                                )}
                            >
                                <div class={twClasses("", jsxTailwindStyles, "div")}>
                                    <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                                        Source review
                                    </span>
                                    <h3
                                        id="evidence-contradictions-title"
                                        class={twClasses("", jsxTailwindStyles, "h3")}
                                    >
                                        Explicit contradiction links
                                    </h3>
                                </div>
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    {graph().contradictions.length}
                                </span>
                            </div>
                            <p class={twClasses("", jsxTailwindStyles, "p")}>
                                These pairs were explicitly linked as contradictions. Review each
                                item’s source status above.
                            </p>
                            <Show
                                when={graph().contradictions.length > 0}
                                fallback={
                                    <small class={twClasses("", jsxTailwindStyles, "small")}>
                                        No evidence items are explicitly linked as contradicting
                                        another.
                                    </small>
                                }
                            >
                                <div
                                    class={twClasses(
                                        "evidence-contradiction-list",
                                        jsxTailwindStyles,
                                        "div",
                                    )}
                                >
                                    <For each={graph().contradictions}>
                                        {(pair) => (
                                            <div
                                                class={twClasses(
                                                    "evidence-contradiction-row",
                                                    jsxTailwindStyles,
                                                    "div",
                                                )}
                                            >
                                                <span
                                                    class={twClasses("", jsxTailwindStyles, "span")}
                                                >
                                                    {field(pair.first, "title", "Evidence item")}
                                                </span>
                                                <strong
                                                    class={twClasses(
                                                        "",
                                                        jsxTailwindStyles,
                                                        "strong",
                                                    )}
                                                >
                                                    contradicts
                                                </strong>
                                                <span
                                                    class={twClasses("", jsxTailwindStyles, "span")}
                                                >
                                                    {field(pair.second, "title", "Evidence item")}
                                                </span>
                                            </div>
                                        )}
                                    </For>
                                </div>
                            </Show>
                            <Show when={graph().invalidEdgeCount > 0}>
                                <p
                                    class={twClasses(
                                        "evidence-graph-warning",
                                        jsxTailwindStyles,
                                        "p",
                                    )}
                                    role="status"
                                >
                                    {graph().invalidEdgeCount} relationship
                                    {graph().invalidEdgeCount === 1 ? "" : "s"} could not be drawn
                                    because an endpoint or session reference is invalid.
                                </p>
                            </Show>
                        </section>
                        <form
                            class={twClasses("evidence-link-form", jsxTailwindStyles, "form")}
                            onSubmit={(event) => {
                                event.preventDefault();
                                if (fromId() && toId())
                                    props.onLink(fromId(), toId(), relationship());
                            }}
                        >
                            <label class={twClasses("", jsxTailwindStyles, "label")}>
                                <span class={twClasses("", jsxTailwindStyles, "span")}>From</span>
                                <select
                                    required
                                    value={fromId()}
                                    disabled={props.disabled}
                                    onChange={(event) => setFromId(event.currentTarget.value)}
                                    class={twClasses("", jsxTailwindStyles, "select")}
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
                            <label class={twClasses("", jsxTailwindStyles, "label")}>
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    Relationship
                                </span>
                                <select
                                    value={relationship()}
                                    disabled={props.disabled}
                                    onChange={(event) =>
                                        setRelationship(
                                            event.currentTarget
                                                .value as (typeof EVIDENCE_RELATIONSHIPS)[number],
                                        )
                                    }
                                    class={twClasses("", jsxTailwindStyles, "select")}
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
                            <label class={twClasses("", jsxTailwindStyles, "label")}>
                                <span class={twClasses("", jsxTailwindStyles, "span")}>To</span>
                                <select
                                    required
                                    value={toId()}
                                    disabled={props.disabled}
                                    onChange={(event) => setToId(event.currentTarget.value)}
                                    class={twClasses("", jsxTailwindStyles, "select")}
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
                                class={twClasses(
                                    "button button-outline",
                                    jsxTailwindStyles,
                                    "button",
                                )}
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
                            <div class={twClasses("evidence-edge-list", jsxTailwindStyles, "div")}>
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
                                            <div
                                                class={twClasses(
                                                    "evidence-edge-row",
                                                    jsxTailwindStyles,
                                                    "div",
                                                )}
                                            >
                                                <span
                                                    class={twClasses("", jsxTailwindStyles, "span")}
                                                >
                                                    {from()
                                                        ? field(
                                                              from()!,
                                                              "title",
                                                              field(from()!, "type", "Evidence"),
                                                          )
                                                        : "Missing evidence item"}
                                                </span>
                                                <strong
                                                    class={twClasses(
                                                        "",
                                                        jsxTailwindStyles,
                                                        "strong",
                                                    )}
                                                >
                                                    {field(
                                                        edge,
                                                        "relationship",
                                                        "unknown",
                                                    ).replaceAll("-", " ")}
                                                </strong>
                                                <span
                                                    class={twClasses("", jsxTailwindStyles, "span")}
                                                >
                                                    {to()
                                                        ? field(
                                                              to()!,
                                                              "title",
                                                              field(to()!, "type", "Evidence"),
                                                          )
                                                        : "Missing evidence item"}
                                                </span>
                                                <button
                                                    class={twClasses(
                                                        "button button-quiet",
                                                        jsxTailwindStyles,
                                                        "button",
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
            class={twClasses("evidence-network-scroll", jsxTailwindStyles, "div")}
            role="region"
            aria-label="Evidence relationship map"
        >
            <svg
                class={twClasses("evidence-network", jsxTailwindStyles, "svg")}
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
                        <path
                            d="M 0 0 L 10 5 L 0 10 z"
                            class={twClasses("evidence-network-arrow", jsxTailwindStyles, "path")}
                        />
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
                                    class={twClasses("", jsxTailwindStyles, "path")}
                                >
                                    <title>{relationship.replaceAll("-", " ")}</title>
                                </path>
                                <text
                                    x={edge.labelX}
                                    y={edge.labelY - 5}
                                    text-anchor="middle"
                                    class={twClasses("", jsxTailwindStyles, "text")}
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
                                    class={twClasses("", jsxTailwindStyles, "rect")}
                                />
                                <circle
                                    cx="14"
                                    cy="15"
                                    r="4"
                                    class={twClasses("", jsxTailwindStyles, "circle")}
                                />
                                <text
                                    class={twClasses(
                                        "evidence-network-state",
                                        jsxTailwindStyles,
                                        "text",
                                    )}
                                    x="24"
                                    y="18"
                                >
                                    {state.replaceAll("-", " ")}
                                </text>
                                <text
                                    class={twClasses(
                                        "evidence-network-title",
                                        jsxTailwindStyles,
                                        "text",
                                    )}
                                    x="12"
                                    y="39"
                                >
                                    {shortTitle}
                                </text>
                                <text
                                    class={twClasses(
                                        "evidence-network-type",
                                        jsxTailwindStyles,
                                        "text",
                                    )}
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
            class={twClasses(
                `evidence-card surface-card evidence-${state()}`,
                jsxTailwindStyles,
                "article",
            )}
            data-evidence-id={props.record.id}
        >
            <div
                class={twClasses("evidence-card-rail", jsxTailwindStyles, "div")}
                aria-hidden="true"
            >
                <span class={twClasses("", jsxTailwindStyles, "span")} />
            </div>
            <div class={twClasses("evidence-card-content", jsxTailwindStyles, "div")}>
                <EvidenceSources record={props.record} snapshot={props.snapshot} />
                <header class={twClasses("evidence-card-header", jsxTailwindStyles, "header")}>
                    <div class={twClasses("evidence-card-labels", jsxTailwindStyles, "div")}>
                        <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                            {sourceLabel()}
                        </span>
                        <span
                            class={twClasses(
                                `evidence-state evidence-state-${state()}`,
                                jsxTailwindStyles,
                                "span",
                            )}
                        >
                            {state() === "human-verified"
                                ? "Verified"
                                : state() === "rejected"
                                  ? "Rejected"
                                  : "Needs review"}
                        </span>
                    </div>
                    <span class={twClasses("evidence-type", jsxTailwindStyles, "span")}>
                        {field(props.record, "type", "learning evidence").replaceAll("-", " ")}
                    </span>
                </header>
                <Show
                    when={editing()}
                    fallback={
                        <>
                            <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                                {field(props.record, "title", "Evidence from this session")}
                            </h2>
                            <p class={twClasses("evidence-content", jsxTailwindStyles, "p")}>
                                {field(props.record, "content")}
                            </p>
                        </>
                    }
                >
                    <form
                        class={twClasses("evidence-edit-form", jsxTailwindStyles, "form")}
                        onSubmit={save}
                    >
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>Title</span>
                            <input
                                value={title()}
                                maxLength={512}
                                required
                                disabled={props.disabled}
                                onInput={(event) => setTitle(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "input")}
                            />
                        </label>
                        <div class={twClasses("evidence-edit-row", jsxTailwindStyles, "div")}>
                            <label class={twClasses("", jsxTailwindStyles, "label")}>
                                <span class={twClasses("", jsxTailwindStyles, "span")}>Type</span>
                                <input
                                    value={type()}
                                    maxLength={128}
                                    required
                                    disabled={props.disabled}
                                    onInput={(event) => setType(event.currentTarget.value)}
                                    class={twClasses("", jsxTailwindStyles, "input")}
                                />
                            </label>
                            <label class={twClasses("", jsxTailwindStyles, "label")}>
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    Priority
                                </span>
                                <input
                                    value={priority()}
                                    maxLength={32}
                                    required
                                    disabled={props.disabled}
                                    onInput={(event) => setPriority(event.currentTarget.value)}
                                    class={twClasses("", jsxTailwindStyles, "input")}
                                />
                            </label>
                        </div>
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>Evidence</span>
                            <textarea
                                value={content()}
                                maxLength={16 * 1024 * 1024}
                                rows={5}
                                required
                                disabled={props.disabled}
                                onInput={(event) => setContent(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "textarea")}
                            />
                        </label>
                        <div class={twClasses("evidence-review-actions", jsxTailwindStyles, "div")}>
                            <button
                                class={twClasses(
                                    "button button-primary",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="submit"
                                disabled={props.disabled}
                            >
                                Save changes
                            </button>
                            <button
                                class={twClasses(
                                    "button button-quiet",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                disabled={props.disabled}
                                onClick={() => setEditing(false)}
                            >
                                Cancel
                            </button>
                        </div>
                    </form>
                </Show>
                <div class={twClasses("evidence-source-meta", jsxTailwindStyles, "div")}>
                    <Show when={timestamp()}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            <Icon name="clock" /> {formattedTimestamp()}
                        </span>
                    </Show>
                    <Show when={field(props.record, "detection_confidence")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            Heuristic confidence {field(props.record, "detection_confidence")}
                        </span>
                    </Show>
                    <Show when={field(props.record, "source_speaker_label")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            Speaker: {field(props.record, "source_speaker_label")}
                        </span>
                    </Show>
                    <For each={sourceAssets()}>
                        {(asset) => (
                            <span
                                class={twClasses(
                                    "evidence-source-material",
                                    jsxTailwindStyles,
                                    "span",
                                )}
                            >
                                Material: {field(asset, "filename", "Untitled material")}
                            </span>
                        )}
                    </For>
                    <Show when={sourceAssetIds().length > sourceAssets().length}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            {sourceAssetIds().length - sourceAssets().length} linked materials
                            unavailable
                        </span>
                    </Show>
                </div>
                <Show when={!editing()}>
                    <div
                        class={twClasses(
                            "evidence-review-actions evidence-card-actions",
                            jsxTailwindStyles,
                            "div",
                        )}
                    >
                        <button
                            class={twClasses("button button-outline", jsxTailwindStyles, "button")}
                            type="button"
                            disabled={props.disabled}
                            onClick={beginEditing}
                        >
                            Edit evidence
                        </button>
                        <button
                            class={twClasses("button button-quiet", jsxTailwindStyles, "button")}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onTrash(props.record)}
                        >
                            Move to Trash
                        </button>
                        <Show when={state() !== "human-verified"}>
                            <button
                                class={twClasses(
                                    "button button-primary",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                disabled={props.disabled}
                                onClick={() => props.onReview(props.record, "human-verified")}
                            >
                                Approve source
                            </button>
                        </Show>
                        <button
                            class={twClasses("button button-quiet", jsxTailwindStyles, "button")}
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
