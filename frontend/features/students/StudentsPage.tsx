import { For, Show, createResource, createSignal, untrack, type JSX } from "solid-js";
import {
    errorMessage,
    goals as goalsApi,
    skills as skillsApi,
    students as studentsApi,
} from "../../api/client";
import type { Goal, SkillRating, Student, StudentInput } from "../../api/types";
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
    Tabs,
    TextArea,
    TextInput,
} from "../../design-system/ui";
import { formatDate, formatShortDate, initials, plural } from "../../shared/format";
import { Icon } from "../../shared-ui";
import { navigate, sessionPath, useRoute } from "../../app/router";

function splitList(value: string): string[] {
    return value
        .split(/[,\n]/u)
        .map((item) => item.trim())
        .filter(Boolean);
}

function StudentForm(props: {
    initial?: Student;
    submitLabel: string;
    onSubmit: (input: StudentInput) => Promise<void>;
    onCancel?: (() => void) | undefined;
}): JSX.Element {
    const [name, setName] = createSignal(props.initial?.displayName ?? "");
    const [year, setYear] = createSignal(props.initial?.year ?? "");
    const [subjects, setSubjects] = createSignal((props.initial?.subjects ?? []).join(", "));
    const [goals, setGoals] = createSignal((props.initial?.goals ?? []).join(", "));
    const [notes, setNotes] = createSignal(props.initial?.notes ?? "");
    const [error, setError] = createSignal("");
    const [saving, setSaving] = createSignal(false);

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
            await props.onSubmit({
                displayName: name(),
                year: year(),
                subjects: splitList(subjects()),
                goals: splitList(goals()),
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
                <Field label="Student name">
                    <TextInput
                        value={name()}
                        onInput={setName}
                        placeholder="Maya Ortiz"
                        ariaLabel="Student name"
                    />
                </Field>
                <Field label="Year or level">
                    <TextInput
                        value={year()}
                        onInput={setYear}
                        placeholder="Year 10"
                        ariaLabel="Year or level"
                    />
                </Field>
            </div>
            <Field label="Subjects" helper="Separate subjects with commas.">
                <TextInput
                    value={subjects()}
                    onInput={setSubjects}
                    placeholder="Algebra, Geometry"
                    ariaLabel="Subjects"
                />
            </Field>
            <Field label="Goals" helper="Separate goals with commas.">
                <TextInput
                    value={goals()}
                    onInput={setGoals}
                    placeholder="Build confidence with fractions"
                    ariaLabel="Goals"
                />
            </Field>
            <Field label="Notes">
                <TextArea
                    value={notes()}
                    onInput={setNotes}
                    rows={3}
                    placeholder="What should you remember about this learner?"
                    ariaLabel="Student notes"
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

export function StudentsPage(): JSX.Element {
    const [query, setQuery] = createSignal("");
    const [creating, setCreating] = createSignal(false);
    const [error, setError] = createSignal("");
    const [students, { refetch }] = createResource(query, studentsApi.list);

    async function addStudent(input: StudentInput): Promise<void> {
        try {
            await studentsApi.create(input);
            setCreating(false);
            setError("");
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <PageHeader
                title="Students"
                description="Every learner, their sessions, progress, materials, and guides in one place."
                actions={
                    <Button variant="primary" onClick={() => setCreating((value) => !value)}>
                        <Icon name="plus" />
                        Add student
                    </Button>
                }
            />

            <Show when={error()}>
                <div class="mb-4">
                    <InlineNotice tone="danger">{error()}</InlineNotice>
                </div>
            </Show>

            <Show when={creating()}>
                <div class="mb-4">
                    <Panel>
                        <PanelHeader title="New student" detail="Only the name is required." />
                        <StudentForm
                            submitLabel="Add student"
                            onCancel={() => setCreating(false)}
                            onSubmit={addStudent}
                        />
                    </Panel>
                </div>
            </Show>

            <Panel>
                <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
                    <div>
                        <h2 class="text-sm font-semibold text-ink">
                            {plural(students()?.length ?? 0, "student")}
                        </h2>
                        <p class="mt-0.5 text-xs text-muted">
                            Name, next lesson, and recent activity.
                        </p>
                    </div>
                    <label class="flex min-h-8 w-full max-w-[300px] items-center gap-2 rounded-[5px] border border-line-strong bg-surface px-2.5 text-xs text-muted">
                        <Icon name="search" />
                        <input
                            class="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
                            placeholder="Filter students"
                            value={query()}
                            onInput={(event) => setQuery(event.currentTarget.value)}
                            aria-label="Filter students"
                        />
                    </label>
                </div>
                <Show
                    when={students()?.length}
                    fallback={
                        <EmptyState
                            icon="students"
                            title="No students yet"
                            text="Add the first learner. Sessions, notes, progress, and materials will stay connected to them."
                            action={
                                <Button size="sm" onClick={() => setCreating(true)}>
                                    Add a student
                                </Button>
                            }
                        />
                    }
                >
                    <div class="divide-y divide-line-soft">
                        <For each={students()}>
                            {(student) => (
                                <button
                                    type="button"
                                    class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-inset"
                                    onClick={() => navigate(`/students/${student.id}/overview`)}
                                >
                                    <span class="grid h-9 w-9 flex-none place-items-center rounded-[5px] bg-accent-soft text-xs font-semibold text-accent">
                                        {initials(student.displayName)}
                                    </span>
                                    <span class="min-w-0 flex-1">
                                        <span class="flex flex-wrap items-center gap-2">
                                            <strong class="truncate text-[13px] font-medium text-ink">
                                                {student.displayName}
                                            </strong>
                                            <Show when={student.year}>
                                                <Badge>{student.year}</Badge>
                                            </Show>
                                        </span>
                                        <span class="mt-0.5 block truncate text-xs text-muted">
                                            {plural(student.sessionCount, "session")}
                                            {student.lastSessionAt
                                                ? ` · last ${formatShortDate(student.lastSessionAt)}`
                                                : " · no sessions yet"}
                                            {student.subjects.length
                                                ? ` · ${student.subjects.join(", ")}`
                                                : ""}
                                        </span>
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

function GoalEditor(props: {
    studentId: string;
    goal?: Goal | undefined;
    onSaved: () => void;
    onCancel?: (() => void) | undefined;
}): JSX.Element {
    const initial = untrack(() => props.goal);
    const [title, setTitle] = createSignal(initial?.title ?? "");
    const [status, setStatus] = createSignal(initial?.status ?? "active");
    const [targetDate, setTargetDate] = createSignal(initial?.targetDate ?? "");
    const [notes, setNotes] = createSignal(initial?.notes ?? "");
    const [error, setError] = createSignal("");

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            await goalsApi.upsert(props.goal?.id ?? null, {
                studentId: props.studentId,
                title: title(),
                status: status(),
                targetDate: targetDate(),
                notes: notes(),
            });
            props.onSaved();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <form
            class="grid gap-2 border-t border-line-soft p-4"
            onSubmit={(event) => void submit(event)}
        >
            <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_150px]">
                <TextInput
                    value={title()}
                    onInput={setTitle}
                    placeholder="Goal"
                    ariaLabel="Goal title"
                />
                <select
                    class="h-9 rounded-[5px] border border-line-strong bg-surface px-2 text-[13px]"
                    value={status()}
                    onChange={(event) => setStatus(event.currentTarget.value)}
                    aria-label="Goal status"
                >
                    <option value="active">Active</option>
                    <option value="achieved">Achieved</option>
                    <option value="paused">Paused</option>
                </select>
                <TextInput
                    value={targetDate()}
                    onInput={setTargetDate}
                    placeholder="Target date"
                    ariaLabel="Target date"
                />
            </div>
            <TextInput
                value={notes()}
                onInput={setNotes}
                placeholder="Notes (optional)"
                ariaLabel="Goal notes"
            />
            <Show when={error()}>
                <InlineNotice tone="danger">{error()}</InlineNotice>
            </Show>
            <div class="flex justify-end gap-2">
                <Show when={props.onCancel}>
                    <Button variant="ghost" size="sm" onClick={props.onCancel}>
                        Cancel
                    </Button>
                </Show>
                <Button size="sm" variant="primary" type="submit">
                    Save goal
                </Button>
            </div>
        </form>
    );
}

function SkillEditor(props: {
    studentId: string;
    skill?: SkillRating | undefined;
    onSaved: () => void;
    onCancel?: (() => void) | undefined;
}): JSX.Element {
    const initial = untrack(() => props.skill);
    const [name, setName] = createSignal(initial?.skill ?? "");
    const [rating, setRating] = createSignal(String(initial?.rating ?? 0));
    const [note, setNote] = createSignal(initial?.note ?? "");
    const [error, setError] = createSignal("");

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            await skillsApi.upsert(props.skill?.id ?? null, {
                studentId: props.studentId,
                skill: name(),
                rating: Number(rating()),
                note: note(),
            });
            props.onSaved();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <form
            class="grid gap-2 border-t border-line-soft p-4"
            onSubmit={(event) => void submit(event)}
        >
            <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_100px_minmax(0,1fr)]">
                <TextInput
                    value={name()}
                    onInput={setName}
                    placeholder="Skill"
                    ariaLabel="Skill name"
                />
                <select
                    class="h-9 rounded-[5px] border border-line-strong bg-surface px-2 text-[13px]"
                    value={rating()}
                    onChange={(event) => setRating(event.currentTarget.value)}
                    aria-label="Skill rating"
                >
                    <option value="0">0 · not started</option>
                    <option value="1">1 · emerging</option>
                    <option value="2">2 · developing</option>
                    <option value="3">3 · secure</option>
                    <option value="4">4 · strong</option>
                    <option value="5">5 · independent</option>
                </select>
                <TextInput
                    value={note()}
                    onInput={setNote}
                    placeholder="Note (optional)"
                    ariaLabel="Skill note"
                />
            </div>
            <Show when={error()}>
                <InlineNotice tone="danger">{error()}</InlineNotice>
            </Show>
            <div class="flex justify-end gap-2">
                <Show when={props.onCancel}>
                    <Button variant="ghost" size="sm" onClick={props.onCancel}>
                        Cancel
                    </Button>
                </Show>
                <Button size="sm" variant="primary" type="submit">
                    Save skill
                </Button>
            </div>
        </form>
    );
}

export function StudentDetailPage(): JSX.Element {
    const route = useRoute();
    const [error, setError] = createSignal("");
    const [editing, setEditing] = createSignal(false);
    const [addingGoal, setAddingGoal] = createSignal(false);
    const [editingGoal, setEditingGoal] = createSignal<Goal | null>(null);
    const [addingSkill, setAddingSkill] = createSignal(false);
    const [editingSkill, setEditingSkill] = createSignal<SkillRating | null>(null);
    const [detail, { refetch }] = createResource(() => route().id, studentsApi.detail);
    const tab = (): string => route().tab || "overview";

    async function saveStudent(id: string, input: StudentInput): Promise<void> {
        try {
            await studentsApi.update(id, input);
            setEditing(false);
            setError("");
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    const report = (): string => {
        const value = detail();
        if (!value) return "";
        const lines = [
            `# Progress report · ${value.student.displayName}`,
            "",
            value.student.year ? `Year: ${value.student.year}` : "",
            value.student.subjects.length ? `Subjects: ${value.student.subjects.join(", ")}` : "",
            "",
            "## Goals",
            ...value.goals.map(
                (goal) =>
                    `- [${goal.status}] ${goal.title}${goal.targetDate ? ` (target ${goal.targetDate})` : ""}`,
            ),
            "",
            "## Skills",
            ...value.skills.map(
                (skill) =>
                    `- ${skill.skill}: ${skill.rating}/5${skill.note ? ` — ${skill.note}` : ""}`,
            ),
            "",
            "## Evidence",
            ...value.evidence.map((item) => `- ${item.statement}`),
            "",
            "## Sessions",
            ...value.sessions.map(
                (session) =>
                    `- ${formatDate(session.startedAt ?? session.scheduledAt)} · ${session.title}`,
            ),
        ];
        return lines.filter((line) => line !== "").join("\n");
    };

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <Show when={detail()} fallback={<p class="text-sm text-muted">Loading student…</p>}>
                {(value) => (
                    <>
                        <div class="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
                            <button
                                type="button"
                                class="hover:text-ink"
                                onClick={() => navigate("/students")}
                            >
                                Students
                            </button>
                            <Icon name="chevron" class="h-3 w-3" />
                            <span class="text-ink">{value().student.displayName}</span>
                        </div>
                        <PageHeader
                            title={value().student.displayName}
                            description={
                                [value().student.year, value().student.subjects.join(", ")]
                                    .filter(Boolean)
                                    .join(" · ") || "Student profile"
                            }
                            actions={
                                <>
                                    <Button onClick={() => setEditing((current) => !current)}>
                                        Edit profile
                                    </Button>
                                    <Button
                                        variant="primary"
                                        onClick={() =>
                                            navigate(
                                                `/sessions?new=1&student=${value().student.id}`,
                                            )
                                        }
                                    >
                                        <Icon name="plus" />
                                        Start session
                                    </Button>
                                </>
                            }
                        />
                        <Show when={error()}>
                            <div class="mb-4">
                                <InlineNotice tone="danger">{error()}</InlineNotice>
                            </div>
                        </Show>
                        <Show when={editing()}>
                            <div class="mb-4">
                                <Panel>
                                    <PanelHeader title="Edit student" />
                                    <StudentForm
                                        initial={value().student}
                                        submitLabel="Save changes"
                                        onCancel={() => setEditing(false)}
                                        onSubmit={(input) => saveStudent(value().student.id, input)}
                                    />
                                </Panel>
                            </div>
                        </Show>
                        <div class="mb-4">
                            <Tabs
                                active={tab()}
                                onChange={(id) => navigate(`/students/${value().student.id}/${id}`)}
                                tabs={[
                                    { id: "overview", label: "Overview" },
                                    {
                                        id: "sessions",
                                        label: "Sessions",
                                        count: value().sessions.length,
                                    },
                                    {
                                        id: "progress",
                                        label: "Progress",
                                        count: value().goals.length + value().skills.length,
                                    },
                                    {
                                        id: "materials",
                                        label: "Materials",
                                        count: value().materials.length,
                                    },
                                    { id: "guides", label: "Guides", count: value().guides.length },
                                    { id: "reports", label: "Reports" },
                                ]}
                            />
                        </div>

                        <Show when={tab() === "overview"}>
                            <div class="grid gap-4 lg:grid-cols-2">
                                <Panel>
                                    <PanelHeader title="Profile" />
                                    <div class="grid gap-2 p-4 text-xs text-muted">
                                        <p class="m-0 leading-relaxed text-ink-soft">
                                            {value().student.notes || "No profile notes yet."}
                                        </p>
                                        <Show when={value().student.goals.length}>
                                            <div class="mt-2">
                                                <strong class="text-ink-soft">Goals</strong>
                                                <ul class="mt-1 list-disc pl-4">
                                                    <For each={value().student.goals}>
                                                        {(goal) => <li>{goal}</li>}
                                                    </For>
                                                </ul>
                                            </div>
                                        </Show>
                                    </div>
                                </Panel>
                                <Panel>
                                    <PanelHeader
                                        title="Recent sessions"
                                        actions={
                                            <Button
                                                size="sm"
                                                onClick={() =>
                                                    navigate(
                                                        `/students/${value().student.id}/sessions`,
                                                    )
                                                }
                                            >
                                                All sessions
                                            </Button>
                                        }
                                    />
                                    <Show
                                        when={value().sessions.length}
                                        fallback={
                                            <EmptyState
                                                icon="sessions"
                                                title="No sessions yet"
                                                text="Start a session to build this learner's history."
                                                action={
                                                    <Button
                                                        size="sm"
                                                        onClick={() =>
                                                            navigate(
                                                                `/sessions?new=1&student=${value().student.id}`,
                                                            )
                                                        }
                                                    >
                                                        Start session
                                                    </Button>
                                                }
                                            />
                                        }
                                    >
                                        <div class="divide-y divide-line-soft">
                                            <For each={value().sessions.slice(0, 6)}>
                                                {(session) => (
                                                    <button
                                                        type="button"
                                                        class="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-inset"
                                                        onClick={() =>
                                                            navigate(sessionPath(session.id))
                                                        }
                                                    >
                                                        <span class="min-w-0 flex-1">
                                                            <strong class="block truncate text-xs font-medium text-ink">
                                                                {session.title}
                                                            </strong>
                                                            <span class="text-[11px] text-muted">
                                                                {formatDate(
                                                                    session.startedAt ??
                                                                        session.scheduledAt,
                                                                )}{" "}
                                                                · {session.status}
                                                            </span>
                                                        </span>
                                                    </button>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                </Panel>
                            </div>
                        </Show>

                        <Show when={tab() === "sessions"}>
                            <Panel>
                                <PanelHeader
                                    title="Session history"
                                    detail={plural(value().sessions.length, "session")}
                                />
                                <Show
                                    when={value().sessions.length}
                                    fallback={
                                        <EmptyState
                                            icon="sessions"
                                            title="No sessions yet"
                                            text="Create the first session for this student."
                                            action={
                                                <Button
                                                    size="sm"
                                                    onClick={() =>
                                                        navigate(
                                                            `/sessions?new=1&student=${value().student.id}`,
                                                        )
                                                    }
                                                >
                                                    Start session
                                                </Button>
                                            }
                                        />
                                    }
                                >
                                    <div class="divide-y divide-line-soft">
                                        <For each={value().sessions}>
                                            {(session) => (
                                                <button
                                                    type="button"
                                                    class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-inset"
                                                    onClick={() =>
                                                        navigate(sessionPath(session.id))
                                                    }
                                                >
                                                    <span class="min-w-0 flex-1">
                                                        <strong class="block truncate text-[13px] font-medium text-ink">
                                                            {session.title}
                                                        </strong>
                                                        <span class="text-xs text-muted">
                                                            {formatDate(
                                                                session.startedAt ??
                                                                    session.scheduledAt,
                                                            )}{" "}
                                                            · {session.subject || "No subject"} ·{" "}
                                                            {session.status}
                                                        </span>
                                                    </span>
                                                    <span class="flex gap-2 text-[11px] text-faint">
                                                        <span>{session.cueCount} cues</span>
                                                        <span>
                                                            {session.observationCount} notes
                                                        </span>
                                                        <span>{session.materialCount} files</span>
                                                    </span>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </Panel>
                        </Show>

                        <Show when={tab() === "progress"}>
                            <div class="grid gap-4 lg:grid-cols-2">
                                <Panel>
                                    <PanelHeader
                                        title="Goals"
                                        actions={
                                            <Button
                                                size="sm"
                                                onClick={() => {
                                                    setAddingGoal(true);
                                                    setEditingGoal(null);
                                                }}
                                            >
                                                Add goal
                                            </Button>
                                        }
                                    />
                                    <Show when={addingGoal() || editingGoal()}>
                                        <GoalEditor
                                            studentId={value().student.id}
                                            goal={editingGoal() ?? undefined}
                                            onCancel={() => {
                                                setAddingGoal(false);
                                                setEditingGoal(null);
                                            }}
                                            onSaved={() => {
                                                setAddingGoal(false);
                                                setEditingGoal(null);
                                                void refetch();
                                            }}
                                        />
                                    </Show>
                                    <Show
                                        when={value().goals.length}
                                        fallback={
                                            <EmptyState
                                                icon="evidence"
                                                title="No goals yet"
                                                text="Add a goal to make progress visible."
                                            />
                                        }
                                    >
                                        <div class="divide-y divide-line-soft">
                                            <For each={value().goals}>
                                                {(goal) => (
                                                    <div class="flex items-start gap-2 px-4 py-3">
                                                        <Badge
                                                            tone={
                                                                goal.status === "achieved"
                                                                    ? "success"
                                                                    : "neutral"
                                                            }
                                                        >
                                                            {goal.status}
                                                        </Badge>
                                                        <div class="min-w-0 flex-1">
                                                            <strong class="block text-xs font-medium text-ink">
                                                                {goal.title}
                                                            </strong>
                                                            <span class="block text-[11px] text-muted">
                                                                {goal.targetDate ||
                                                                    "No target date"}
                                                                {goal.notes
                                                                    ? ` · ${goal.notes}`
                                                                    : ""}
                                                            </span>
                                                        </div>
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            onClick={() => {
                                                                setEditingGoal(goal);
                                                                setAddingGoal(false);
                                                            }}
                                                        >
                                                            Edit
                                                        </Button>
                                                        <ConfirmButton
                                                            label="Delete"
                                                            confirmLabel="Delete goal"
                                                            onConfirm={() =>
                                                                void goalsApi
                                                                    .remove(goal.id)
                                                                    .then(refetch)
                                                            }
                                                        />
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                </Panel>
                                <Panel>
                                    <PanelHeader
                                        title="Skills"
                                        actions={
                                            <Button
                                                size="sm"
                                                onClick={() => {
                                                    setAddingSkill(true);
                                                    setEditingSkill(null);
                                                }}
                                            >
                                                Add skill
                                            </Button>
                                        }
                                    />
                                    <Show when={addingSkill() || editingSkill()}>
                                        <SkillEditor
                                            studentId={value().student.id}
                                            skill={editingSkill() ?? undefined}
                                            onCancel={() => {
                                                setAddingSkill(false);
                                                setEditingSkill(null);
                                            }}
                                            onSaved={() => {
                                                setAddingSkill(false);
                                                setEditingSkill(null);
                                                void refetch();
                                            }}
                                        />
                                    </Show>
                                    <Show
                                        when={value().skills.length}
                                        fallback={
                                            <EmptyState
                                                icon="evidence"
                                                title="No skill ratings yet"
                                                text="Rate a skill to see progress over time."
                                            />
                                        }
                                    >
                                        <div class="divide-y divide-line-soft">
                                            <For each={value().skills}>
                                                {(skill) => (
                                                    <div class="flex items-center gap-2 px-4 py-3">
                                                        <div class="min-w-0 flex-1">
                                                            <strong class="block text-xs font-medium text-ink">
                                                                {skill.skill}
                                                            </strong>
                                                            <span class="text-[11px] text-muted">
                                                                {skill.note || "No note"}
                                                            </span>
                                                            <div
                                                                class="mt-1 flex gap-0.5"
                                                                aria-hidden="true"
                                                            >
                                                                <For each={[1, 2, 3, 4, 5]}>
                                                                    {(step) => (
                                                                        <span
                                                                            class={
                                                                                step <= skill.rating
                                                                                    ? "h-1.5 flex-1 rounded-[2px] bg-accent"
                                                                                    : "h-1.5 flex-1 rounded-[2px] bg-surface-inset"
                                                                            }
                                                                        />
                                                                    )}
                                                                </For>
                                                            </div>
                                                        </div>
                                                        <Badge
                                                            tone={
                                                                skill.rating >= 3
                                                                    ? "success"
                                                                    : "neutral"
                                                            }
                                                        >
                                                            {skill.rating}/5
                                                        </Badge>
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            onClick={() => {
                                                                setEditingSkill(skill);
                                                                setAddingSkill(false);
                                                            }}
                                                        >
                                                            Edit
                                                        </Button>
                                                        <ConfirmButton
                                                            label="Delete"
                                                            confirmLabel="Delete skill"
                                                            onConfirm={() =>
                                                                void skillsApi
                                                                    .remove(skill.id)
                                                                    .then(refetch)
                                                            }
                                                        />
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                </Panel>
                                <Panel class="lg:col-span-2">
                                    <PanelHeader
                                        title="Evidence timeline"
                                        detail={plural(value().evidence.length, "evidence item")}
                                        actions={
                                            <Button size="sm" onClick={() => navigate("/evidence")}>
                                                Open evidence
                                            </Button>
                                        }
                                    />
                                    <Show
                                        when={value().evidence.length}
                                        fallback={
                                            <EmptyState
                                                icon="evidence"
                                                title="No evidence yet"
                                                text="Evidence shows what changed and where it came from."
                                            />
                                        }
                                    >
                                        <div class="divide-y divide-line-soft">
                                            <For each={value().evidence}>
                                                {(item) => (
                                                    <div class="px-4 py-3">
                                                        <div class="flex items-center gap-2">
                                                            <Badge
                                                                tone={
                                                                    item.status === "approved"
                                                                        ? "success"
                                                                        : "neutral"
                                                                }
                                                            >
                                                                {item.status}
                                                            </Badge>
                                                            <span class="text-[11px] text-muted">
                                                                {item.kind}
                                                            </span>
                                                            <span class="ml-auto text-[11px] text-faint">
                                                                {formatDate(item.createdAt)}
                                                            </span>
                                                        </div>
                                                        <p class="mt-1 text-xs leading-relaxed text-ink-soft">
                                                            {item.statement}
                                                        </p>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                </Panel>
                            </div>
                        </Show>

                        <Show when={tab() === "materials"}>
                            <Panel>
                                <PanelHeader
                                    title="Materials"
                                    actions={
                                        <Button size="sm" onClick={() => navigate("/materials")}>
                                            Add material
                                        </Button>
                                    }
                                />
                                <Show
                                    when={value().materials.length}
                                    fallback={
                                        <EmptyState
                                            icon="assets"
                                            title="No materials yet"
                                            text="Files attached to this student will appear here."
                                        />
                                    }
                                >
                                    <div class="divide-y divide-line-soft">
                                        <For each={value().materials}>
                                            {(material) => (
                                                <button
                                                    type="button"
                                                    class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-inset"
                                                    onClick={() => navigate("/materials")}
                                                >
                                                    <Icon name="assets" class="text-muted" />
                                                    <span class="min-w-0 flex-1">
                                                        <strong class="block truncate text-xs font-medium text-ink">
                                                            {material.title || material.filename}
                                                        </strong>
                                                        <span class="text-[11px] text-muted">
                                                            {material.kind} ·{" "}
                                                            {Math.round(
                                                                material.byteSize / 1024,
                                                            ).toLocaleString()}{" "}
                                                            KB
                                                        </span>
                                                    </span>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </Panel>
                        </Show>

                        <Show when={tab() === "guides"}>
                            <Panel>
                                <PanelHeader
                                    title="Study guides"
                                    actions={
                                        <Button size="sm" onClick={() => navigate("/guides")}>
                                            Create guide
                                        </Button>
                                    }
                                />
                                <Show
                                    when={value().guides.length}
                                    fallback={
                                        <EmptyState
                                            icon="guides"
                                            title="No guides yet"
                                            text="Create a study guide from this student's sessions and observations."
                                        />
                                    }
                                >
                                    <div class="divide-y divide-line-soft">
                                        <For each={value().guides}>
                                            {(guide) => (
                                                <button
                                                    type="button"
                                                    class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-inset"
                                                    onClick={() =>
                                                        navigate(`/guides/${guide.id}/edit`)
                                                    }
                                                >
                                                    <Icon name="guides" class="text-muted" />
                                                    <span class="min-w-0 flex-1">
                                                        <strong class="block truncate text-xs font-medium text-ink">
                                                            {guide.title}
                                                        </strong>
                                                        <span class="text-[11px] text-muted">
                                                            {guide.status} · updated{" "}
                                                            {formatDate(guide.updatedAt)}
                                                        </span>
                                                    </span>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </Panel>
                        </Show>

                        <Show when={tab() === "reports"}>
                            <Panel>
                                <PanelHeader
                                    title="Progress report"
                                    detail="Generated from goals, skills, evidence, and sessions."
                                    actions={
                                        <Button size="sm" onClick={() => window.print()}>
                                            Print
                                        </Button>
                                    }
                                />
                                <pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap p-4 text-xs leading-relaxed text-ink-soft">
                                    {report()}
                                </pre>
                            </Panel>
                        </Show>
                    </>
                )}
            </Show>
        </div>
    );
}
