import { For, Show, createResource, createSignal, type JSX } from "solid-js";
import {
    chooseTextExport,
    errorMessage,
    schedule as scheduleApi,
    students as studentsApi,
    writeExportFile,
} from "../../api/client";
import type { ScheduleEvent, ScheduleInput } from "../../api/types";
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
    TextInput,
} from "../../design-system/ui";
import { formatDate, formatTime, fromDateTimeLocal, toDateTimeLocal } from "../../shared/format";
import { Icon } from "../../shared-ui";

function icsDate(value: number): string {
    const date = new Date(value);
    const pad = (part: number): string => String(part).padStart(2, "0");
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00Z`;
}

function parseIcsDate(value: string): number | null {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/u.exec(value.trim());
    if (!match) return null;
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
    const date = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
    );
    return Number.isNaN(date) ? null : date;
}

function parseIcs(
    text: string,
): Array<{ title: string; startAt: number; durationMin: number; location: string; notes: string }> {
    const unfolded = text.replace(/\r\n[ \t]/gu, "").replace(/\r\n/gu, "\n");
    const events: Array<{
        title: string;
        startAt: number;
        durationMin: number;
        location: string;
        notes: string;
    }> = [];
    for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
        const body = block.split("END:VEVENT")[0] ?? "";
        const get = (key: string): string => {
            const match = new RegExp(`^${key}[^:]*:(.*)$`, "mu").exec(body);
            return match?.[1]?.trim() ?? "";
        };
        const start = parseIcsDate(get("DTSTART"));
        const end = parseIcsDate(get("DTEND"));
        if (!start) continue;
        events.push({
            title: get("SUMMARY") || "Imported lesson",
            startAt: start,
            durationMin: end && end > start ? Math.max(5, Math.round((end - start) / 60_000)) : 60,
            location: get("LOCATION"),
            notes: get("DESCRIPTION").replace(/\\n/gu, "\n"),
        });
    }
    return events;
}

function toIcs(events: ScheduleEvent[]): string {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tutorux//Workspace//EN"];
    for (const event of events) {
        lines.push(
            "BEGIN:VEVENT",
            `UID:${event.id}@tutorux`,
            `DTSTAMP:${icsDate(Date.now())}`,
            `DTSTART:${icsDate(event.startAt)}`,
            `DTEND:${icsDate(event.startAt + event.durationMin * 60_000)}`,
            `SUMMARY:${event.title}`,
            `LOCATION:${event.location}`,
            `DESCRIPTION:${event.notes.replace(/\n/gu, "\\n")}`,
        );
        if (event.recurrence) {
            lines.push(
                `RRULE:FREQ=${event.recurrence === "biweekly" ? "WEEKLY;INTERVAL=2" : event.recurrence.toUpperCase()}`,
            );
        }
        lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
}

export function SchedulePage(): JSX.Element {
    const [error, setError] = createSignal("");
    const [message, setMessage] = createSignal("");
    const [creating, setCreating] = createSignal(false);
    const [editing, setEditing] = createSignal<ScheduleEvent | null>(null);
    const [students] = createResource(() => studentsApi.list(""));
    const [events, { refetch }] = createResource(() =>
        scheduleApi.list(Date.now() - 86_400_000, Date.now() + 120 * 86_400_000),
    );
    const [studentId, setStudentId] = createSignal("");
    const [title, setTitle] = createSignal("");
    const [subject, setSubject] = createSignal("");
    const [start, setStart] = createSignal(toDateTimeLocal(Date.now()));
    const [duration, setDuration] = createSignal("60");
    const [recurrence, setRecurrence] = createSignal("");
    const [location, setLocation] = createSignal("");
    const [notes, setNotes] = createSignal("");
    let fileInput: HTMLInputElement | undefined;

    function resetForm(): void {
        setStudentId("");
        setTitle("");
        setSubject("");
        setStart(toDateTimeLocal(Date.now()));
        setDuration("60");
        setRecurrence("");
        setLocation("");
        setNotes("");
        setEditing(null);
    }

    function loadForEdit(event: ScheduleEvent): void {
        setEditing(event);
        setCreating(true);
        setStudentId(event.studentId ?? "");
        setTitle(event.title);
        setSubject(event.subject);
        setStart(toDateTimeLocal(event.startAt));
        setDuration(String(event.durationMin));
        setRecurrence(event.recurrence);
        setLocation(event.location);
        setNotes(event.notes);
    }

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        const startAt = fromDateTimeLocal(start());
        if (!startAt) {
            setError("Choose a valid start time.");
            return;
        }
        const input: ScheduleInput = {
            studentId: studentId() || null,
            title: title(),
            subject: subject(),
            startAt,
            durationMin: Number(duration()),
            recurrence: recurrence(),
            location: location(),
            notes: notes(),
        };
        try {
            const wasEditing = Boolean(editing());
            if (editing()) await scheduleApi.update(editing()!.id, input);
            else await scheduleApi.create(input);
            resetForm();
            setCreating(false);
            setMessage(
                wasEditing ? "Lesson updated." : "Lesson scheduled. The session record is ready.",
            );
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function importIcs(file: File): Promise<void> {
        setError("");
        try {
            const parsed = parseIcs(await file.text());
            if (!parsed.length) throw new Error("No events were found in that calendar file.");
            for (const item of parsed) {
                await scheduleApi.create({
                    studentId: null,
                    title: item.title,
                    subject: "",
                    startAt: item.startAt,
                    durationMin: item.durationMin,
                    recurrence: "",
                    location: item.location,
                    notes: item.notes,
                });
            }
            setMessage(`${parsed.length} events imported.`);
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function exportIcs(): Promise<void> {
        setError("");
        try {
            const path = await chooseTextExport("tutorux-schedule.ics", "ics", "Calendar file");
            if (!path) return;
            await writeExportFile(path, toIcs(events() ?? []));
            setMessage("Calendar exported.");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    const studentOptions = (): Array<{ value: string; label: string }> => [
        { value: "", label: "No student" },
        ...(students() ?? []).map((student) => ({ value: student.id, label: student.displayName })),
    ];

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <PageHeader
                title="Schedule"
                description="Recurring lessons become session records automatically. Import and export calendars as ICS files."
                actions={
                    <>
                        <Button
                            onClick={() => {
                                resetForm();
                                setCreating((value) => !value);
                            }}
                        >
                            <Icon name="plus" />
                            New lesson
                        </Button>
                        <Button onClick={() => void exportIcs()}>Export ICS</Button>
                    </>
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
            <Show when={creating()}>
                <div class="mb-4">
                    <Panel>
                        <PanelHeader
                            title={editing() ? "Edit lesson" : "New lesson"}
                            detail="One record keeps the schedule, session, and reminder together."
                        />
                        <form class="grid gap-3 p-4" onSubmit={(event) => void submit(event)}>
                            <div class="grid gap-3 sm:grid-cols-2">
                                <Field label="Student">
                                    <Select
                                        value={studentId()}
                                        onChange={setStudentId}
                                        options={studentOptions()}
                                        ariaLabel="Student"
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
                            <Field label="Lesson title">
                                <TextInput
                                    value={title()}
                                    onInput={setTitle}
                                    placeholder="Fractions review"
                                    ariaLabel="Lesson title"
                                />
                            </Field>
                            <div class="grid gap-3 sm:grid-cols-3">
                                <Field label="Start">
                                    <input
                                        class="h-9 rounded-[5px] border border-line-strong bg-surface px-2 text-[13px]"
                                        type="datetime-local"
                                        value={start()}
                                        onInput={(event) => setStart(event.currentTarget.value)}
                                        aria-label="Start"
                                    />
                                </Field>
                                <Field label="Minutes">
                                    <TextInput
                                        value={duration()}
                                        onInput={setDuration}
                                        type="number"
                                        ariaLabel="Duration in minutes"
                                    />
                                </Field>
                                <Field label="Repeats">
                                    <Select
                                        value={recurrence()}
                                        onChange={setRecurrence}
                                        ariaLabel="Recurrence"
                                        options={[
                                            { value: "", label: "One time" },
                                            { value: "daily", label: "Daily" },
                                            { value: "weekly", label: "Weekly" },
                                            { value: "biweekly", label: "Every two weeks" },
                                            { value: "monthly", label: "Monthly" },
                                        ]}
                                    />
                                </Field>
                            </div>
                            <div class="grid gap-3 sm:grid-cols-2">
                                <Field label="Location">
                                    <TextInput
                                        value={location()}
                                        onInput={setLocation}
                                        placeholder="Room, address, or online"
                                        ariaLabel="Location"
                                    />
                                </Field>
                                <Field label="Notes">
                                    <TextInput
                                        value={notes()}
                                        onInput={setNotes}
                                        placeholder="What to prepare"
                                        ariaLabel="Schedule notes"
                                    />
                                </Field>
                            </div>
                            <div class="flex justify-end gap-2">
                                <Button
                                    variant="ghost"
                                    onClick={() => {
                                        setCreating(false);
                                        resetForm();
                                    }}
                                >
                                    Cancel
                                </Button>
                                <Button variant="primary" type="submit">
                                    {editing() ? "Save lesson" : "Schedule lesson"}
                                </Button>
                            </div>
                        </form>
                    </Panel>
                </div>
            </Show>
            <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.35fr)]">
                <Panel>
                    <PanelHeader
                        title="Upcoming lessons"
                        detail={`${events()?.length ?? 0} scheduled`}
                    />
                    <Show
                        when={events()?.length}
                        fallback={
                            <EmptyState
                                icon="calendar"
                                title="No lessons scheduled"
                                text="Add a one-off or recurring lesson. The matching session appears automatically."
                                action={
                                    <Button size="sm" onClick={() => setCreating(true)}>
                                        Schedule a lesson
                                    </Button>
                                }
                            />
                        }
                    >
                        <div class="divide-y divide-line-soft">
                            <For each={events()}>
                                {(event) => (
                                    <div class="flex flex-wrap items-center gap-3 px-4 py-3">
                                        <div class="min-w-0 flex-1">
                                            <div class="flex flex-wrap items-center gap-2">
                                                <strong class="truncate text-[13px] font-medium text-ink">
                                                    {event.title}
                                                </strong>
                                                <Show when={event.recurrence}>
                                                    <Badge>{event.recurrence}</Badge>
                                                </Show>
                                            </div>
                                            <div class="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                                                <span>
                                                    {formatDate(event.startAt)} ·{" "}
                                                    {formatTime(event.startAt)}
                                                </span>
                                                <span>{event.durationMin} min</span>
                                                <Show when={event.studentName}>
                                                    <span>{event.studentName}</span>
                                                </Show>
                                                <Show when={event.location}>
                                                    <span>{event.location}</span>
                                                </Show>
                                            </div>
                                        </div>
                                        <Button size="sm" onClick={() => loadForEdit(event)}>
                                            Edit
                                        </Button>
                                        <ConfirmButton
                                            label="Cancel"
                                            confirmLabel="Cancel lesson"
                                            onConfirm={() =>
                                                void scheduleApi
                                                    .remove(event.id)
                                                    .then(() => void refetch())
                                            }
                                        />
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </Panel>
                <div class="grid content-start gap-4">
                    <Panel>
                        <PanelHeader
                            title="Calendar file"
                            detail="Works with Google Calendar, Outlook, and Apple Calendar."
                        />
                        <div class="grid gap-2 p-4">
                            <Button size="sm" onClick={() => fileInput?.click()}>
                                Import ICS
                            </Button>
                            <Button size="sm" onClick={() => void exportIcs()}>
                                Export ICS
                            </Button>
                            <input
                                ref={(element) => (fileInput = element)}
                                type="file"
                                accept=".ics,text/calendar"
                                class="hidden"
                                onChange={(event) => {
                                    const file = event.currentTarget.files?.[0];
                                    if (file) void importIcs(file);
                                    event.currentTarget.value = "";
                                }}
                            />
                            <p class="m-0 text-[11px] leading-relaxed text-muted">
                                Importing or exporting a calendar file keeps the workspace portable.
                                Connected calendar accounts are managed in Settings.
                            </p>
                        </div>
                    </Panel>
                </div>
            </div>
        </div>
    );
}
