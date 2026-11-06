import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js";
import {
    errorMessage,
    evidence as evidenceApi,
    sessions as sessionsApi,
    students as studentsApi,
} from "../../api/client";
import type { Evidence, EvidenceGraph } from "../../api/types";
import {
    Badge,
    Button,
    ConfirmButton,
    EmptyState,
    Field,
    InlineNotice,
    PageHeader,
    Panel,
    PanelHeader,
    Select,
    TextArea,
} from "../../design-system/ui";
import { formatDate } from "../../shared/format";
import { useWorkspace } from "../../app/workspace";

const RELATIONSHIPS = [
    { value: "supports", label: "Supports" },
    { value: "builds-on", label: "Builds on" },
    { value: "supersedes", label: "Supersedes" },
    { value: "contrasts", label: "Contrasts" },
    { value: "evidence-for", label: "Evidence for" },
];

function shortLabel(statement: string): string {
    const compact = statement.trim().replace(/\s+/gu, " ");
    return compact.length > 28 ? `${compact.slice(0, 27)}…` : compact;
}

function GraphView(props: {
    graph: EvidenceGraph | undefined;
    onUnlink: (id: string) => void;
}): JSX.Element {
    const layout = createMemo(() => {
        const nodes = props.graph?.nodes ?? [];
        const centerX = 380;
        const centerY = 224;
        const radius = Math.min(176, 58 + nodes.length * 11);
        const positions = new Map<string, { x: number; y: number }>();
        nodes.forEach((node, index) => {
            const angle = (Math.PI * 2 * index) / Math.max(nodes.length, 1) - Math.PI / 2;
            positions.set(node.id, {
                x: centerX + Math.cos(angle) * radius,
                y: centerY + Math.sin(angle) * radius,
            });
        });
        return positions;
    });

    const nodeLabel = (id: string): string => {
        const node = props.graph?.nodes.find((item) => item.id === id);
        return node ? shortLabel(node.statement) : id.slice(0, 8);
    };

    return (
        <div class="grid gap-3 p-4">
            <Show
                when={props.graph?.nodes.length}
                fallback={
                    <EmptyState
                        icon="evidence"
                        title="No evidence to graph"
                        text="Add at least two evidence statements, then connect them."
                    />
                }
            >
                <svg
                    viewBox="0 0 760 460"
                    role="img"
                    aria-label="Evidence relationship graph"
                    class="h-auto w-full rounded-[5px] border border-line-soft bg-surface-subtle"
                >
                    <For each={props.graph?.links ?? []}>
                        {(link) => {
                            const from = () => layout().get(link.fromId);
                            const to = () => layout().get(link.toId);
                            return (
                                <Show when={from() && to()}>
                                    <line
                                        x1={from()?.x}
                                        y1={from()?.y}
                                        x2={to()?.x}
                                        y2={to()?.y}
                                        stroke="var(--color-line-strong)"
                                        stroke-width="1.5"
                                    >
                                        <title>{link.relationship}</title>
                                    </line>
                                </Show>
                            );
                        }}
                    </For>
                    <For each={props.graph?.nodes ?? []}>
                        {(node) => {
                            const point = () => layout().get(node.id) ?? { x: 380, y: 224 };
                            return (
                                <g>
                                    <circle
                                        cx={point().x}
                                        cy={point().y}
                                        r="9"
                                        fill={
                                            node.status === "approved"
                                                ? "var(--color-accent)"
                                                : "var(--color-surface)"
                                        }
                                        stroke="var(--color-accent)"
                                        stroke-width="2"
                                    >
                                        <title>{node.statement}</title>
                                    </circle>
                                    <text
                                        x={point().x}
                                        y={point().y + 25}
                                        text-anchor="middle"
                                        font-size="10"
                                        fill="var(--color-ink-soft)"
                                    >
                                        {shortLabel(node.statement)}
                                    </text>
                                </g>
                            );
                        }}
                    </For>
                </svg>
                <div class="grid gap-2">
                    <For each={props.graph?.links ?? []}>
                        {(link) => (
                            <div class="flex flex-wrap items-center gap-2 rounded-[5px] border border-line-soft px-3 py-2 text-xs">
                                <span class="text-ink">{nodeLabel(link.fromId)}</span>
                                <Badge>{link.relationship}</Badge>
                                <span class="text-ink">{nodeLabel(link.toId)}</span>
                                <Button
                                    size="sm"
                                    class="ml-auto"
                                    onClick={() => props.onUnlink(link.id)}
                                >
                                    Remove link
                                </Button>
                            </div>
                        )}
                    </For>
                    <Show when={!props.graph?.links.length}>
                        <p class="m-0 text-xs text-muted">
                            No links yet. Connect two statements to show how the evidence builds.
                        </p>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

export function EvidencePage(): JSX.Element {
    const workspace = useWorkspace();
    const [studentId, setStudentId] = createSignal("");
    const [sessionId, setSessionId] = createSignal("");
    const [statement, setStatement] = createSignal("");
    const [kind, setKind] = createSignal("observation");
    const [status, setStatus] = createSignal("draft");
    const [view, setView] = createSignal<"list" | "graph">("list");
    const [fromId, setFromId] = createSignal("");
    const [toId, setToId] = createSignal("");
    const [relationship, setRelationship] = createSignal("supports");
    const [error, setError] = createSignal("");
    const [students] = createResource(() => studentsApi.list(""));
    const [sessions] = createResource(() => sessionsApi.list(null, null, 1000));
    const [items, { refetch }] = createResource(
        () => ({ studentId: studentId(), sessionId: sessionId() }),
        (source) => evidenceApi.list(source.studentId || null, source.sessionId || null),
    );
    const [graph, { refetch: refetchGraph }] = createResource(
        () => ({ studentId: studentId(), sessionId: sessionId() }),
        (source) => evidenceApi.graph(source.studentId || null, source.sessionId || null),
    );

    async function refreshAll(): Promise<void> {
        await Promise.all([refetch(), refetchGraph()]);
    }

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            await evidenceApi.create({
                studentId: studentId() || null,
                sessionId: sessionId() || null,
                sourceType: sessionId() ? "session" : "manual",
                sourceId: sessionId(),
                kind: kind(),
                statement: statement(),
                status: status(),
            });
            setStatement("");
            await refreshAll();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function link(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            await evidenceApi.link({
                fromId: fromId(),
                toId: toId(),
                relationship: relationship(),
            });
            setFromId("");
            setToId("");
            await refreshAll();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function unlink(id: string): Promise<void> {
        setError("");
        try {
            await evidenceApi.unlink(id);
            await refreshAll();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    const nodeOptions = (): Array<{ value: string; label: string }> => [
        { value: "", label: "Choose evidence" },
        ...(graph()?.nodes ?? []).map((item) => ({
            value: item.id,
            label: shortLabel(item.statement),
        })),
    ];

    const sessionOptions = (): Array<{ value: string; label: string }> => [
        { value: "", label: "No session" },
        ...(sessions() ?? [])
            .filter((session) => !studentId() || session.studentId === studentId())
            .map((session) => ({
                value: session.id,
                label: `${session.title} · ${formatDate(session.startedAt ?? session.scheduledAt)}`,
            })),
    ];

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <PageHeader
                title="Evidence"
                description="Specific proof of what a learner can do, where it came from, when it happened, and how it connects."
                actions={
                    <div class="flex flex-wrap gap-2">
                        <Button
                            size="sm"
                            variant={view() === "list" ? "primary" : "secondary"}
                            onClick={() => setView("list")}
                        >
                            List
                        </Button>
                        <Show when={!workspace.simpleMode()}>
                            <Button
                                size="sm"
                                variant={view() === "graph" ? "primary" : "secondary"}
                                onClick={() => setView("graph")}
                            >
                                Graph
                            </Button>
                        </Show>
                    </div>
                }
            />
            <Show when={error()}>
                <div class="mb-4">
                    <InlineNotice tone="danger">{error()}</InlineNotice>
                </div>
            </Show>
            <div class="mb-4 grid gap-3 rounded-[5px] border border-line-soft bg-surface p-3 sm:grid-cols-2">
                <Field label="Student filter">
                    <Select
                        value={studentId()}
                        onChange={(value) => {
                            setStudentId(value);
                            setSessionId("");
                            setFromId("");
                            setToId("");
                        }}
                        ariaLabel="Student filter"
                        options={[
                            { value: "", label: "All students" },
                            ...(students() ?? []).map((student) => ({
                                value: student.id,
                                label: student.displayName,
                            })),
                        ]}
                    />
                </Field>
                <Field label="Session filter">
                    <Select
                        value={sessionId()}
                        onChange={setSessionId}
                        ariaLabel="Session filter"
                        options={sessionOptions()}
                    />
                </Field>
            </div>
            <div class="grid gap-4 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
                <Panel>
                    <PanelHeader
                        title="Add evidence"
                        detail="Use a concrete statement, not a general impression."
                    />
                    <form class="grid gap-3 p-4" onSubmit={(event) => void submit(event)}>
                        <Field label="Statement">
                            <TextArea
                                value={statement()}
                                onInput={setStatement}
                                rows={4}
                                placeholder="Maya explained why the sign changes when both sides are multiplied by a negative number."
                                ariaLabel="Evidence statement"
                            />
                        </Field>
                        <div class="grid gap-3 sm:grid-cols-2">
                            <Field label="Kind">
                                <Select
                                    value={kind()}
                                    onChange={setKind}
                                    ariaLabel="Evidence kind"
                                    options={[
                                        { value: "observation", label: "Observation" },
                                        { value: "skill", label: "Skill" },
                                        { value: "goal", label: "Goal" },
                                        { value: "transcript", label: "Transcript" },
                                        { value: "material", label: "Material" },
                                    ]}
                                />
                            </Field>
                            <Field label="Status">
                                <Select
                                    value={status()}
                                    onChange={setStatus}
                                    ariaLabel="Evidence status"
                                    options={[
                                        { value: "draft", label: "Draft" },
                                        { value: "approved", label: "Approved" },
                                        { value: "rejected", label: "Rejected" },
                                    ]}
                                />
                            </Field>
                        </div>
                        <div class="flex justify-end">
                            <Button size="sm" variant="primary" type="submit">
                                Add evidence
                            </Button>
                        </div>
                    </form>
                </Panel>
                <Show
                    when={view() === "list"}
                    fallback={
                        <div class="grid content-start gap-4">
                            <Panel>
                                <PanelHeader
                                    title="Evidence graph"
                                    detail={`${graph()?.nodes.length ?? 0} items · ${graph()?.links.length ?? 0} links`}
                                    actions={
                                        <Button size="sm" onClick={() => void refetchGraph()}>
                                            Refresh
                                        </Button>
                                    }
                                />
                                <GraphView graph={graph()} onUnlink={(id) => void unlink(id)} />
                            </Panel>
                            <Panel>
                                <PanelHeader title="Connect evidence" />
                                <form class="grid gap-3 p-4" onSubmit={(event) => void link(event)}>
                                    <div class="grid gap-3 sm:grid-cols-2">
                                        <Field label="From">
                                            <Select
                                                value={fromId()}
                                                onChange={setFromId}
                                                ariaLabel="From evidence"
                                                options={nodeOptions()}
                                            />
                                        </Field>
                                        <Field label="To">
                                            <Select
                                                value={toId()}
                                                onChange={setToId}
                                                ariaLabel="To evidence"
                                                options={nodeOptions()}
                                            />
                                        </Field>
                                    </div>
                                    <Field label="Relationship">
                                        <Select
                                            value={relationship()}
                                            onChange={setRelationship}
                                            ariaLabel="Evidence relationship"
                                            options={RELATIONSHIPS}
                                        />
                                    </Field>
                                    <div class="flex justify-end">
                                        <Button
                                            size="sm"
                                            variant="primary"
                                            type="submit"
                                            disabled={!fromId() || !toId() || fromId() === toId()}
                                        >
                                            Add link
                                        </Button>
                                    </div>
                                </form>
                            </Panel>
                        </div>
                    }
                >
                    <Panel>
                        <PanelHeader
                            title="Evidence record"
                            detail={`${items()?.length ?? 0} items`}
                            actions={
                                <Button size="sm" onClick={() => void refetch()}>
                                    Refresh
                                </Button>
                            }
                        />
                        <Show
                            when={items()?.length}
                            fallback={
                                <EmptyState
                                    icon="evidence"
                                    title="No evidence yet"
                                    text="Add a statement from a session, observation, transcript, or material."
                                />
                            }
                        >
                            <div class="divide-y divide-line-soft">
                                <For each={items()}>
                                    {(item: Evidence) => (
                                        <div class="px-4 py-3">
                                            <div class="flex flex-wrap items-center gap-2">
                                                <Badge
                                                    tone={
                                                        item.status === "approved"
                                                            ? "success"
                                                            : item.status === "rejected"
                                                              ? "danger"
                                                              : "neutral"
                                                    }
                                                >
                                                    {item.status}
                                                </Badge>
                                                <span class="text-[11px] text-muted">
                                                    {item.kind}
                                                </span>
                                                <span class="text-[11px] text-faint">
                                                    {formatDate(item.createdAt)}
                                                </span>
                                                <div class="ml-auto flex gap-1">
                                                    <Show when={item.status !== "approved"}>
                                                        <Button
                                                            size="sm"
                                                            onClick={() =>
                                                                void evidenceApi
                                                                    .update(item.id, {
                                                                        studentId: item.studentId,
                                                                        sessionId: item.sessionId,
                                                                        sourceType: item.sourceType,
                                                                        sourceId: item.sourceId,
                                                                        kind: item.kind,
                                                                        statement: item.statement,
                                                                        status: "approved",
                                                                    })
                                                                    .then(() => refreshAll())
                                                            }
                                                        >
                                                            Approve
                                                        </Button>
                                                    </Show>
                                                    <ConfirmButton
                                                        label="Delete"
                                                        confirmLabel="Delete evidence"
                                                        onConfirm={() =>
                                                            void evidenceApi
                                                                .remove(item.id)
                                                                .then(() => refreshAll())
                                                        }
                                                    />
                                                </div>
                                            </div>
                                            <p class="mt-1 text-xs leading-relaxed text-ink-soft">
                                                {item.statement}
                                            </p>
                                            <Show when={item.sessionId}>
                                                <p class="mt-1 text-[11px] text-faint">
                                                    Source: session {item.sessionId?.slice(0, 8)}
                                                </p>
                                            </Show>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </Panel>
                </Show>
            </div>
        </div>
    );
}
