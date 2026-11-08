import { For, Show, createResource, createSignal, type JSX } from "solid-js";
import {
    backup as backupApi,
    chooseBackupFile,
    errorMessage,
    today as todayApi,
    sessions as sessionsApi,
} from "../../api/client";
import {
    Badge,
    Button,
    EmptyState,
    InlineNotice,
    PageHeader,
    Panel,
    PanelHeader,
} from "../../design-system/ui";
import {
    formatBytes,
    formatDate,
    formatShortDate,
    formatTime,
    initials,
    daysUntil,
} from "../../shared/format";
import { Icon } from "../../shared-ui";
import { navigate, sessionPath, studentPath } from "../../app/router";
import { useWorkspace } from "../../app/workspace";
import { workspaceFileName } from "../../app/workspace-path";

export function TodayPage(): JSX.Element {
    const workspace = useWorkspace();
    const [error, setError] = createSignal("");
    const [starting, setStarting] = createSignal("");
    const [data, { refetch }] = createResource(todayApi.data);

    async function startSession(id: string, active: boolean): Promise<void> {
        setStarting(id);
        setError("");
        try {
            if (!active) await sessionsApi.start(id);
            navigate(sessionPath(id, active ? "overview" : "capture"));
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setStarting("");
        }
    }

    async function backUpNow(): Promise<void> {
        setError("");
        try {
            const destination = await chooseBackupFile(workspace.summary()?.name ?? "workspace");
            if (!destination) return;
            const result = await backupApi.create(destination);
            workspace.notify(`Backup saved (${formatBytes(result.bytes)}).`, "success");
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    const backupAgeDays = (): number | null => {
        const last = data()?.backupLastAt;
        if (!last) return null;
        return Math.floor((Date.now() - last) / 86_400_000);
    };

    const checklist = (): Array<{
        done: boolean;
        title: string;
        text: string;
        action: () => void;
        label: string;
    }> => [
        {
            done: (data()?.students.length ?? 0) > 0,
            title: "Add your first student",
            text: "A student profile keeps sessions, notes, progress, and materials together.",
            action: () => navigate("/students"),
            label: "Open students",
        },
        {
            done: (data()?.workspace.sessionCount ?? 0) > 0,
            title: "Start a session",
            text: "Every lesson gets one session record with a capture tab and notes.",
            action: () => navigate("/sessions"),
            label: "Open sessions",
        },
        {
            done: (data()?.workspace.materialCount ?? 0) > 0,
            title: "Add a material",
            text: "Import a worksheet, image, document, or link so it stays with the lesson.",
            action: () => navigate("/materials"),
            label: "Open materials",
        },
    ];

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <PageHeader
                eyebrow={formatDate(Date.now())}
                title={`Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}`}
                description="Your day, the next lesson, and the work that needs a small amount of attention."
                actions={
                    <>
                        <Button onClick={() => navigate("/schedule")}>
                            <Icon name="calendar" />
                            Schedule
                        </Button>
                        <Button variant="primary" onClick={() => navigate("/sessions?new=1")}>
                            <Icon name="plus" />
                            New session
                        </Button>
                    </>
                }
            />

            <Show when={error()}>
                <div class="mb-4">
                    <InlineNotice tone="danger">{error()}</InlineNotice>
                </div>
            </Show>

            <div class="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
                <div class="grid content-start gap-4">
                    <Panel>
                        <PanelHeader
                            title="Today and next"
                            detail={
                                data()?.upcomingSessions.length
                                    ? "Scheduled lessons, ready to start."
                                    : "Nothing is scheduled yet."
                            }
                            actions={
                                <Button size="sm" onClick={() => navigate("/schedule")}>
                                    Open schedule
                                </Button>
                            }
                        />
                        <Show
                            when={data()?.upcomingSessions.length}
                            fallback={
                                <EmptyState
                                    icon="calendar"
                                    title="No upcoming lessons"
                                    text="Create a one-off or recurring lesson in Schedule. Tutorux will make the session record for you."
                                    action={
                                        <Button size="sm" onClick={() => navigate("/schedule")}>
                                            Open schedule
                                        </Button>
                                    }
                                />
                            }
                        >
                            <div class="divide-y divide-line-soft">
                                <For each={data()?.upcomingSessions}>
                                    {(session) => (
                                        <div class="flex flex-wrap items-center gap-3 px-4 py-3">
                                            <div class="grid h-10 w-10 flex-none place-items-center rounded-[5px] border border-line bg-surface-subtle text-accent">
                                                <span class="text-xs font-semibold">
                                                    {formatShortDate(
                                                        session.scheduledAt ?? session.startedAt,
                                                    )}
                                                </span>
                                            </div>
                                            <div class="min-w-0 flex-1">
                                                <div class="flex flex-wrap items-center gap-2">
                                                    <strong class="truncate text-[13px] text-ink">
                                                        {session.title}
                                                    </strong>
                                                    <Badge
                                                        tone={
                                                            session.status === "active"
                                                                ? "accent"
                                                                : "neutral"
                                                        }
                                                    >
                                                        {daysUntil(session.scheduledAt)}
                                                    </Badge>
                                                </div>
                                                <div class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                                                    <span>{formatTime(session.scheduledAt)}</span>
                                                    <Show when={session.studentName}>
                                                        <span>{session.studentName}</span>
                                                    </Show>
                                                    <Show when={session.subject}>
                                                        <span>{session.subject}</span>
                                                    </Show>
                                                </div>
                                            </div>
                                            <Button
                                                variant={
                                                    session.status === "active"
                                                        ? "secondary"
                                                        : "primary"
                                                }
                                                size="sm"
                                                disabled={starting() === session.id}
                                                onClick={() =>
                                                    void startSession(
                                                        session.id,
                                                        session.status === "active",
                                                    )
                                                }
                                            >
                                                {starting() === session.id
                                                    ? "Starting…"
                                                    : session.status === "active"
                                                      ? "Continue"
                                                      : "Start"}
                                            </Button>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </Panel>

                    <Show when={data()?.unfinishedSession}>
                        {(session) => (
                            <Panel>
                                <PanelHeader
                                    title="Continue"
                                    detail="This session is still open."
                                />
                                <div class="flex flex-wrap items-center gap-3 px-4 py-3">
                                    <div class="min-w-0 flex-1">
                                        <strong class="text-[13px] text-ink">
                                            {session().title}
                                        </strong>
                                        <p class="mt-0.5 text-xs text-muted">
                                            {session().studentName || "Independent session"}
                                            {session().startedAt
                                                ? ` · started ${formatTime(session().startedAt)}`
                                                : ""}
                                        </p>
                                    </div>
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        onClick={() =>
                                            navigate(sessionPath(session().id, "capture"))
                                        }
                                    >
                                        Continue session
                                    </Button>
                                </div>
                            </Panel>
                        )}
                    </Show>

                    <Panel>
                        <PanelHeader
                            title="Recent sessions"
                            detail="The latest lesson records in this workspace."
                            actions={
                                <Button size="sm" onClick={() => navigate("/sessions")}>
                                    All sessions
                                </Button>
                            }
                        />
                        <Show
                            when={data()?.recentSessions.length}
                            fallback={
                                <EmptyState
                                    icon="sessions"
                                    title="No sessions yet"
                                    text="Start with a student, then create the first session."
                                    action={
                                        <Button size="sm" onClick={() => navigate("/students")}>
                                            Open students
                                        </Button>
                                    }
                                />
                            }
                        >
                            <div class="divide-y divide-line-soft">
                                <For each={data()?.recentSessions}>
                                    {(session) => (
                                        <button
                                            type="button"
                                            class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-inset"
                                            onClick={() => navigate(sessionPath(session.id))}
                                        >
                                            <span class="grid h-8 w-8 flex-none place-items-center rounded-[5px] bg-surface-inset text-xs font-semibold text-accent">
                                                {initials(session.studentName || session.title)}
                                            </span>
                                            <span class="min-w-0 flex-1">
                                                <strong class="block truncate text-[13px] font-medium text-ink">
                                                    {session.title}
                                                </strong>
                                                <span class="block truncate text-xs text-muted">
                                                    {session.studentName || "Independent"}
                                                    {session.startedAt
                                                        ? ` · ${formatDate(session.startedAt)}`
                                                        : ""}
                                                    {` · ${session.cueCount} cues`}
                                                </span>
                                            </span>
                                            <Badge
                                                tone={
                                                    session.status === "active"
                                                        ? "accent"
                                                        : "neutral"
                                                }
                                            >
                                                {session.status}
                                            </Badge>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </Panel>
                </div>

                <div class="grid content-start gap-4">
                    <Panel>
                        <PanelHeader
                            title="Your students"
                            detail={`${data()?.students.length ?? 0} active`}
                        />
                        <Show
                            when={data()?.students.length}
                            fallback={
                                <EmptyState
                                    icon="students"
                                    title="No students yet"
                                    text="Add a learner to connect sessions, progress, and materials."
                                    action={
                                        <Button size="sm" onClick={() => navigate("/students")}>
                                            Add a student
                                        </Button>
                                    }
                                />
                            }
                        >
                            <div class="divide-y divide-line-soft">
                                <For each={data()?.students}>
                                    {(student) => (
                                        <button
                                            type="button"
                                            class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-inset"
                                            onClick={() => navigate(studentPath(student.id))}
                                        >
                                            <span class="grid h-7 w-7 flex-none place-items-center rounded-[5px] bg-surface-inset text-[11px] font-semibold text-accent">
                                                {initials(student.displayName)}
                                            </span>
                                            <span class="min-w-0 flex-1">
                                                <strong class="block truncate text-xs font-medium text-ink">
                                                    {student.displayName}
                                                </strong>
                                                <span class="block truncate text-[11px] text-muted">
                                                    {student.year || "No year"}
                                                    {student.lastSessionAt
                                                        ? ` · ${formatDate(student.lastSessionAt)}`
                                                        : " · No sessions"}
                                                </span>
                                            </span>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </Panel>

                    <Show when={checklist().some((item) => !item.done)}>
                        <Panel>
                            <PanelHeader
                                title="Getting started"
                                detail="Three steps make the workspace useful."
                            />
                            <div class="divide-y divide-line-soft">
                                <For each={checklist()}>
                                    {(item) => (
                                        <div class="flex items-start gap-2.5 px-4 py-3">
                                            <span
                                                class={
                                                    item.done
                                                        ? "mt-0.5 text-success"
                                                        : "mt-0.5 text-faint"
                                                }
                                            >
                                                <Icon name={item.done ? "check" : "arrow"} />
                                            </span>
                                            <div class="min-w-0 flex-1">
                                                <strong class="block text-xs font-medium text-ink">
                                                    {item.title}
                                                </strong>
                                                <p class="mt-0.5 text-[11px] leading-relaxed text-muted">
                                                    {item.text}
                                                </p>
                                            </div>
                                            <Show when={!item.done}>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={item.action}
                                                >
                                                    {item.label}
                                                </Button>
                                            </Show>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </Panel>
                    </Show>

                    <Panel>
                        <PanelHeader
                            title="Workspace health"
                            detail={
                                backupAgeDays() === null
                                    ? "No verified backup yet"
                                    : backupAgeDays()! > 7
                                      ? `Last backup ${backupAgeDays()} days ago`
                                      : `Last backup ${formatDate(data()?.backupLastAt)}`
                            }
                            actions={
                                <Button size="sm" onClick={() => void backUpNow()}>
                                    Back up now
                                </Button>
                            }
                        />
                        <div class="grid gap-2 px-4 py-3 text-xs text-muted">
                            <div class="flex justify-between gap-3">
                                <span>File</span>
                                <strong
                                    class="min-w-0 truncate text-right text-ink"
                                    title={workspace.summary()?.path ?? ""}
                                >
                                    {workspace.summary()?.path
                                        ? workspaceFileName(workspace.summary()!.path)
                                        : "Unknown"}
                                </strong>
                            </div>
                            <Show when={backupAgeDays() !== null && backupAgeDays()! > 7}>
                                <div class="rounded-[4px] bg-[var(--warning-soft)] px-2 py-1 text-[11px] text-warning">
                                    This workspace has not been backed up in over a week.
                                </div>
                            </Show>
                            <div class="flex justify-between gap-3">
                                <span>Students</span>
                                <strong class="text-ink">
                                    {data()?.workspace.studentCount ?? 0}
                                </strong>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span>Sessions</span>
                                <strong class="text-ink">
                                    {data()?.workspace.sessionCount ?? 0}
                                </strong>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span>Materials</span>
                                <strong class="text-ink">
                                    {data()?.workspace.materialCount ?? 0}
                                </strong>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span>File size</span>
                                <strong class="text-ink">
                                    {formatBytes(data()?.workspace.sizeBytes ?? 0)}
                                </strong>
                            </div>
                        </div>
                    </Panel>
                </div>
            </div>
        </div>
    );
}
