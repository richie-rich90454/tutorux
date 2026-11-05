import { For, Show, createResource, createSignal, type JSX } from "solid-js";
import {
    errorMessage,
    evidence as evidenceApi,
    sessions as sessionsApi,
    students as studentsApi,
} from "../../api/client";
import type { Evidence } from "../../api/types";
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

export function EvidencePage(): JSX.Element {
    const workspace = useWorkspace();
    const [studentId, setStudentId] = createSignal("");
    const [sessionId, setSessionId] = createSignal("");
    const [statement, setStatement] = createSignal("");
    const [kind, setKind] = createSignal("observation");
    const [status, setStatus] = createSignal("draft");
    const [error, setError] = createSignal("");
    const [students] = createResource(() => studentsApi.list(""));
    const [sessions] = createResource(() => sessionsApi.list(null, null, 1000));
    const [items, { refetch }] = createResource(
        () => ({ studentId: studentId(), sessionId: sessionId() }),
        (source) => evidenceApi.list(source.studentId || null, source.sessionId || null),
    );

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
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

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
                description="Specific proof of what a learner can do, where it came from, and when it happened."
                actions={
                    <Badge tone="accent">
                        {workspace.simpleMode() ? "List view" : "List view"}
                    </Badge>
                }
            />
            <Show when={error()}>
                <div class="mb-4">
                    <InlineNotice tone="danger">{error()}</InlineNotice>
                </div>
            </Show>
            <div class="grid gap-4 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
                <Panel>
                    <PanelHeader
                        title="Add evidence"
                        detail="Use a concrete statement, not a general impression."
                    />
                    <form class="grid gap-3 p-4" onSubmit={(event) => void submit(event)}>
                        <div class="grid gap-3 sm:grid-cols-2">
                            <Field label="Student">
                                <Select
                                    value={studentId()}
                                    onChange={(value) => {
                                        setStudentId(value);
                                        setSessionId("");
                                    }}
                                    ariaLabel="Student"
                                    options={[
                                        { value: "", label: "All students" },
                                        ...(students() ?? []).map((student) => ({
                                            value: student.id,
                                            label: student.displayName,
                                        })),
                                    ]}
                                />
                            </Field>
                            <Field label="Session">
                                <Select
                                    value={sessionId()}
                                    onChange={setSessionId}
                                    ariaLabel="Session"
                                    options={sessionOptions()}
                                />
                            </Field>
                        </div>
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
                                            <span class="text-[11px] text-muted">{item.kind}</span>
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
                                                                .then(() => void refetch())
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
                                                            .then(() => void refetch())
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
            </div>
        </div>
    );
}
