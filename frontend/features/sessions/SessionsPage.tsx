import {
    For,
    Show,
    createMemo,
    createResource,
    createSignal,
    onMount,
    untrack,
    type JSX,
} from "solid-js";
import {
    chooseSessionPackageImport,
    errorMessage,
    sessions as sessionsApi,
    students as studentsApi,
} from "../../api/client";
import type { Session, SessionInput } from "../../api/types";
import {
    Badge,
    Button,
    EmptyState,
    Field,
    InlineNotice,
    PageHeader,
    Panel,
    PanelHeader,
    Select,
    TextArea,
    TextInput,
} from "../../design-system/ui";
import {
    formatDate,
    formatTime,
    fromDateTimeLocal,
    initials,
    plural,
    toDateTimeLocal,
} from "../../shared/format";
import { Icon } from "../../shared-ui";
import { navigate, sessionPath } from "../../app/router";

export function SessionForm(props: {
    initial?: Session;
    students: Array<{ id: string; name: string }>;
    submitLabel: string;
    onSubmit: (input: SessionInput) => Promise<void>;
    onCancel?: (() => void) | undefined;
    presetStudentId?: string | undefined;
}): JSX.Element {
    const initial = untrack(() => props.initial);
    const presetStudentId = untrack(() => props.presetStudentId);
    const [studentId, setStudentId] = createSignal(initial?.studentId ?? presetStudentId ?? "");
    const [title, setTitle] = createSignal(initial?.title ?? "");
    const [subject, setSubject] = createSignal(initial?.subject ?? "");
    const [when, setWhen] = createSignal(
        toDateTimeLocal(initial?.scheduledAt ?? initial?.startedAt ?? Date.now()),
    );
    const [status, setStatus] = createSignal(initial?.status ?? "planned");
    const [notes, setNotes] = createSignal(initial?.notes ?? "");
    const [error, setError] = createSignal("");
    const [saving, setSaving] = createSignal(false);

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
            const timestamp = fromDateTimeLocal(when());
            await props.onSubmit({
                studentId: studentId() || null,
                title: title(),
                subject: subject(),
                scheduledAt: status() === "planned" ? timestamp : null,
                startedAt: status() === "planned" ? null : timestamp,
                endedAt: status() === "completed" ? timestamp : null,
                status: status(),
                notes: notes(),
            });
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setSaving(false);
        }
    }

    return (
        <form class="grid gap-3 p-4" onSubmit={(event) => void submit(event)}>
            <div class="grid gap-3 sm:grid-cols-2">
                <Field label="Student">
                    <Select
                        value={studentId()}
                        onChange={setStudentId}
                        ariaLabel="Student"
                        options={[
                            { value: "", label: "Independent session" },
                            ...props.students.map((student) => ({
                                value: student.id,
                                label: student.name,
                            })),
                        ]}
                    />
                </Field>
                <Field label="Subject">
                    <TextInput
                        value={subject()}
                        onInput={setSubject}
                        placeholder="Algebra"
                        ariaLabel="Subject"
                    />
                </Field>
            </div>
            <Field label="Session title">
                <TextInput
                    value={title()}
                    onInput={setTitle}
                    placeholder="Fractions review"
                    ariaLabel="Session title"
                />
            </Field>
            <div class="grid gap-3 sm:grid-cols-2">
                <Field label="Date and time">
                    <input
                        class="h-9 rounded-[5px] border border-line-strong bg-surface px-2 text-[13px] text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
                        type="datetime-local"
                        value={when()}
                        onInput={(event) => setWhen(event.currentTarget.value)}
                        aria-label="Date and time"
                    />
                </Field>
                <Field label="Status">
                    <Select
                        value={status()}
                        onChange={setStatus}
                        ariaLabel="Status"
                        options={[
                            { value: "planned", label: "Planned" },
                            { value: "active", label: "Active" },
                            { value: "completed", label: "Completed" },
                            { value: "cancelled", label: "Cancelled" },
                        ]}
                    />
                </Field>
            </div>
            <Field label="Session notes">
                <TextArea
                    value={notes()}
                    onInput={setNotes}
                    rows={3}
                    placeholder="What is the focus of this lesson?"
                    ariaLabel="Session notes"
                />
            </Field>
            <Show when={error()}>
                <InlineNotice tone="danger">{error()}</InlineNotice>
            </Show>
            <div class="flex justify-end gap-2">
                <Show when={props.onCancel}>
                    <Button variant="ghost" onClick={props.onCancel}>
                        Cancel
                    </Button>
                </Show>
                <Button variant="primary" type="submit" disabled={saving()}>
                    {saving() ? "Saving…" : props.submitLabel}
                </Button>
            </div>
        </form>
    );
}

export function SessionsPage(): JSX.Element {
    const queryParams = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const presetStudent = queryParams.get("student") ?? "";
    const [showCreate, setShowCreate] = createSignal(queryParams.get("new") === "1");
    const [search, setSearch] = createSignal("");
    const [status, setStatus] = createSignal("");
    const [error, setError] = createSignal("");
    const [message, setMessage] = createSignal("");
    const [students] = createResource(() => studentsApi.list(""));
    const [sessions, { refetch }] = createResource(
        () => ({ status: status() }),
        (source) => sessionsApi.list(null, source.status || null, 1000),
    );
    onMount(() => {
        if (queryParams.get("new") === "1") setShowCreate(true);
    });

    const visible = createMemo(() => {
        const needle = search().trim().toLowerCase();
        if (!needle) return sessions() ?? [];
        return (sessions() ?? []).filter((session) =>
            `${session.title} ${session.studentName} ${session.subject}`
                .toLowerCase()
                .includes(needle),
        );
    });

    const studentOptions = (): Array<{ id: string; name: string }> =>
        (students() ?? []).map((student) => ({ id: student.id, name: student.displayName }));

    async function createSession(input: SessionInput): Promise<void> {
        try {
            const created = await sessionsApi.create(input);
            setShowCreate(false);
            setError("");
            await refetch();
            navigate(sessionPath(created.id, "capture"));
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function importPackage(): Promise<void> {
        setError("");
        setMessage("");
        try {
            const path = await chooseSessionPackageImport();
            if (!path) return;
            const imported = await sessionsApi.importPackage(path);
            await refetch();
            setMessage(`Imported ${imported.title}.`);
            navigate(sessionPath(imported.sessionId));
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <PageHeader
                title="Sessions"
                description="The lesson records that hold capture, notes, materials, evidence, and guides."
                actions={
                    <div class="flex flex-wrap gap-2">
                        <Button onClick={() => void importPackage()}>Import package</Button>
                        <Button variant="primary" onClick={() => setShowCreate((value) => !value)}>
                            <Icon name="plus" />
                            New session
                        </Button>
                    </div>
                }
            />
            <Show when={error()}>
                <div class="mb-4">
                    <InlineNotice tone="danger">{error()}</InlineNotice>
                </div>
            </Show>
            <Show when={message()}>
                <div class="mb-4">
                    <InlineNotice tone="success">{message()}</InlineNotice>
                </div>
            </Show>
            <Show when={showCreate()}>
                <div class="mb-4">
                    <Panel>
                        <PanelHeader
                            title="New session"
                            detail="The session opens immediately so capture and notes are ready."
                        />
                        <SessionForm
                            students={studentOptions()}
                            presetStudentId={presetStudent}
                            submitLabel="Create session"
                            onCancel={() => setShowCreate(false)}
                            onSubmit={createSession}
                        />
                    </Panel>
                </div>
            </Show>
            <Panel>
                <div class="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
                    <label class="flex min-h-8 min-w-[220px] flex-1 items-center gap-2 rounded-[5px] border border-line-strong bg-surface px-2.5 text-xs text-muted">
                        <Icon name="search" />
                        <input
                            class="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
                            placeholder="Search sessions"
                            value={search()}
                            onInput={(event) => setSearch(event.currentTarget.value)}
                            aria-label="Search sessions"
                        />
                    </label>
                    <Select
                        value={status()}
                        onChange={setStatus}
                        ariaLabel="Filter by status"
                        class="max-w-[180px]"
                        options={[
                            { value: "", label: "All statuses" },
                            { value: "planned", label: "Planned" },
                            { value: "active", label: "Active" },
                            { value: "completed", label: "Completed" },
                            { value: "cancelled", label: "Cancelled" },
                        ]}
                    />
                    <span class="ml-auto text-xs text-muted">{visible().length} sessions</span>
                </div>
                <Show
                    when={visible().length}
                    fallback={
                        <EmptyState
                            icon="sessions"
                            title="No sessions found"
                            text={
                                search() || status()
                                    ? "Try a different search or status."
                                    : "Create the first session to start capturing lessons."
                            }
                            action={
                                <Button size="sm" onClick={() => setShowCreate(true)}>
                                    Create session
                                </Button>
                            }
                        />
                    }
                >
                    <div class="divide-y divide-line-soft">
                        <For each={visible()}>
                            {(session) => (
                                <button
                                    type="button"
                                    class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-inset"
                                    onClick={() => navigate(sessionPath(session.id))}
                                >
                                    <span class="grid h-9 w-9 flex-none place-items-center rounded-[5px] bg-accent-soft text-xs font-semibold text-accent">
                                        {initials(session.studentName || session.title)}
                                    </span>
                                    <span class="min-w-0 flex-1">
                                        <span class="flex flex-wrap items-center gap-2">
                                            <strong class="truncate text-[13px] font-medium text-ink">
                                                {session.title}
                                            </strong>
                                            <Badge
                                                tone={
                                                    session.status === "active"
                                                        ? "accent"
                                                        : session.status === "completed"
                                                          ? "success"
                                                          : "neutral"
                                                }
                                            >
                                                {session.status}
                                            </Badge>
                                        </span>
                                        <span class="mt-0.5 block truncate text-xs text-muted">
                                            {session.studentName || "Independent"}
                                            {` · ${formatDate(session.startedAt ?? session.scheduledAt ?? session.createdAt)}`}
                                            {session.startedAt
                                                ? ` · ${formatTime(session.startedAt)}`
                                                : ""}
                                            {session.subject ? ` · ${session.subject}` : ""}
                                        </span>
                                    </span>
                                    <span class="hidden text-[11px] text-faint sm:flex sm:gap-3">
                                        <span>{plural(session.cueCount, "cue")}</span>
                                        <span>{plural(session.observationCount, "note")}</span>
                                        <span>{plural(session.recordingCount, "recording")}</span>
                                    </span>
                                    <Icon name="chevron" class="text-faint" />
                                </button>
                            )}
                        </For>
                    </div>
                </Show>
            </Panel>
        </div>
    );
}
