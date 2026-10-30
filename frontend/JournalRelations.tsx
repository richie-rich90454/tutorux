import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { RecordType, type ArchiveRecord } from "./archive/format";
import type { ArchiveSnapshot } from "./archive/archive";
import { GUIDE_TEMPLATES, guideDraftFromRecord, makeGuideRecord } from "./domain/guides";
import { makeSessionRecords, makeStudentRecord } from "./domain/records";
import {
    journalEntryDeleteBlockerMessage,
    journalEntryDeleteBlockers,
    trashJournalEntryGroup,
} from "./domain/journal-trash";
import "./journal-relations.css";

const field = (record: ArchiveRecord, key: string, fallback = "") =>
    record.fields.get(key) ?? fallback;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ids = (value: string) =>
    value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
const timestamp = () => (BigInt(Date.now()) * 1000n).toString();
function sessionDate(session: ArchiveRecord): { key: string; label: string } | null {
    try {
        const milliseconds = Number(
            BigInt(field(session, "started_at_us") || field(session, "created_at_us") || "0") /
                1000n,
        );
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
        const date = new Date(milliseconds);
        if (Number.isNaN(date.getTime())) return null;
        const pad = (value: number) => value.toString().padStart(2, "0");
        return {
            key: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
            label: new Intl.DateTimeFormat(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: "UTC",
                timeZoneName: "short",
            }).format(date),
        };
    } catch {
        return null;
    }
}
function startedAt(session: ArchiveRecord): bigint {
    try {
        return BigInt(field(session, "started_at_us") || field(session, "created_at_us") || "0");
    } catch {
        return 0n;
    }
}
function update(record: ArchiveRecord, changes: Record<string, string>): ArchiveRecord {
    const fields = new Map(record.fields);
    for (const [key, value] of Object.entries(changes)) fields.set(key, value);
    fields.set("updated_at_us", timestamp());
    return { ...record, fields };
}
function withId(value: string, id: string, present: boolean): string {
    const list = ids(value).filter((item) => !same(item, id));
    if (present) list.push(id.toLowerCase());
    return list.join(",");
}

async function loadGuideScope(snapshot: ArchiveSnapshot): Promise<ArchiveRecord[]> {
    const types = [
        RecordType.student,
        RecordType.session,
        RecordType.transcriptSegment,
        RecordType.annotation,
        RecordType.assetMetadata,
        RecordType.evidenceNode,
        RecordType.settings,
    ];
    return (await Promise.all(types.map((type) => snapshot.listRecords(type)))).flat();
}

/** Move a session and its dependent notes and guides in one archive transaction. */
export function moveJournalSession(
    entry: ArchiveRecord,
    session: ArchiveRecord,
    entries: readonly ArchiveRecord[],
    notes: readonly ArchiveRecord[],
    guides: readonly ArchiveRecord[],
    sourceRecords: readonly ArchiveRecord[],
): ArchiveRecord[] {
    if (
        field(entry, "record_role") !== "journal-entry" ||
        field(entry, "_deleted") === "true" ||
        session.type !== RecordType.session ||
        field(session, "_deleted") === "true"
    )
        throw new Error("Choose an active entry and session.");
    const oldId = field(session, "entry_id");
    const old = entries.find((item) => same(item.id, oldId));
    const relatedGuides = guides.filter(
        (guide) =>
            same(field(guide, "session_id"), session.id) && field(guide, "_deleted") !== "true",
    );
    const noteId = field(session, "notes_document_id");
    const note = notes.find((item) => same(item.id, noteId));
    if (
        noteId &&
        (!note ||
            field(note, "record_role") !== "journal-notes" ||
            !same(field(note, "session_id"), session.id) ||
            !same(field(note, "entry_id"), oldId))
    )
        throw new Error("The session notes cannot be safely moved. Repair their ownership first.");
    const movedGuideIds = new Set(relatedGuides.map((guide) => guide.id.toLowerCase()));
    const changes: ArchiveRecord[] = [];
    if (old && !same(old.id, entry.id))
        changes.push(
            update(old, {
                session_ids: withId(field(old, "session_ids"), session.id, false),
                study_guide_ids: ids(field(old, "study_guide_ids"))
                    .filter((id) => !movedGuideIds.has(id.toLowerCase()))
                    .join(","),
            }),
        );
    let targetGuideIds = field(entry, "study_guide_ids");
    for (const guide of relatedGuides) targetGuideIds = withId(targetGuideIds, guide.id, true);
    changes.push(
        update(entry, {
            session_ids: withId(field(entry, "session_ids"), session.id, true),
            study_guide_ids: targetGuideIds,
        }),
    );
    changes.push(update(session, { entry_id: entry.id.toLowerCase() }));
    if (note) changes.push(update(note, { entry_id: entry.id.toLowerCase() }));
    changes.push(
        ...relatedGuides.map((guide) => update(guide, { entry_id: entry.id.toLowerCase() })),
    );

    // Validate against the projected transaction, so moved notes and sessions have
    // their destination ownership while all other source records remain current.
    const replacements = new Map(
        changes.map((record) => [`${record.type}:${record.id.toLowerCase()}`, record]),
    );
    const projected = sourceRecords.map(
        (record) => replacements.get(`${record.type}:${record.id.toLowerCase()}`) ?? record,
    );
    for (const record of changes) {
        if (
            !projected.some(
                (existing) => existing.type === record.type && same(existing.id, record.id),
            )
        )
            projected.push(record);
    }
    const destination = changes.find(
        (record) => record.type === RecordType.settings && same(record.id, entry.id),
    )!;
    const movedSession = changes.find(
        (record) => record.type === RecordType.session && same(record.id, session.id),
    )!;
    const remainingEntry =
        old &&
        changes.find((record) => record.type === RecordType.settings && same(record.id, old.id));
    const entryGuides = guides.filter(
        (guide) =>
            field(guide, "_deleted") !== "true" &&
            !field(guide, "session_id") &&
            oldId &&
            same(field(guide, "entry_id"), oldId),
    );
    if (entryGuides.length && !remainingEntry)
        throw new Error(
            "The session's current journal entry is unavailable, so its guides cannot be checked.",
        );
    for (const guide of [...entryGuides, ...relatedGuides]) {
        const isSessionGuide = same(field(guide, "session_id"), session.id);
        try {
            const draft = guideDraftFromRecord(guide);
            makeGuideRecord(
                { ...draft, entryId: isSessionGuide ? destination.id : remainingEntry!.id },
                isSessionGuide
                    ? { entry: destination, session: movedSession, records: projected }
                    : { entry: remainingEntry!, records: projected },
                guide,
            );
        } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause);
            throw new Error(
                `Cannot move the session because guide “${field(guide, "title") || guide.id}” would have invalid sources or content: ${reason}`,
                { cause },
            );
        }
    }
    return changes;
}

export function JournalRelations(props: {
    entry: ArchiveRecord;
    snapshot: ArchiveSnapshot;
    entries: ArchiveRecord[];
    sessions: ArchiveRecord[];
    students: ArchiveRecord[];
    guides: ArchiveRecord[];
    guideTemplates: ArchiveRecord[];
    assets: ArchiveRecord[];
    notesDocuments: ArchiveRecord[];
    disabled: boolean;
    onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}): JSX.Element {
    const [open, setOpen] = createSignal(false);
    const [error, setError] = createSignal("");
    const [pending, setPending] = createSignal(false);
    const [deleteConfirmed, setDeleteConfirmed] = createSignal(false);
    const deleteBlockers = createMemo(() =>
        journalEntryDeleteBlockers(props.entry, props.sessions, props.guides, props.notesDocuments),
    );
    createEffect(() => {
        deleteBlockers();
        setDeleteConfirmed(false);
    });
    const canDeleteEntry = createMemo(() =>
        Object.values(deleteBlockers()).every((count) => count === 0),
    );
    const attached = createMemo(
        () => new Set(ids(field(props.entry, "attachment_ids")).map((id) => id.toLowerCase())),
    );
    const linkedSessions = createMemo(() =>
        props.sessions.filter(
            (item) =>
                field(item, "_deleted") !== "true" &&
                field(item, "archived") !== "true" &&
                same(field(item, "entry_id"), props.entry.id),
        ),
    );
    const linkedGuides = createMemo(() =>
        props.guides.filter((item) => same(field(item, "entry_id"), props.entry.id)),
    );
    const availableSessions = createMemo(() =>
        props.sessions.filter(
            (item) =>
                field(item, "_deleted") !== "true" &&
                field(item, "archived") !== "true" &&
                !same(field(item, "entry_id"), props.entry.id),
        ),
    );
    const [sessionId, setSessionId] = createSignal("");
    const [sessionTitle, setSessionTitle] = createSignal("");
    const [sessionType, setSessionType] = createSignal("notes-only");
    const [recordingSource, setRecordingSource] = createSignal("none");
    const [sessionStudent, setSessionStudent] = createSignal("");
    const [newStudentName, setNewStudentName] = createSignal("");
    const [newStudentGrade, setNewStudentGrade] = createSignal("");
    const [sessionSubject, setSessionSubject] = createSignal("");
    const [sessionObjectives, setSessionObjectives] = createSignal("");
    const [sessionLanguage, setSessionLanguage] = createSignal("auto");
    const [sessionGuideTemplate, setSessionGuideTemplate] = createSignal("");
    const [guideId, setGuideId] = createSignal("");
    const [timelineDate, setTimelineDate] = createSignal("");
    const [appliedTimelineDate, setAppliedTimelineDate] = createSignal("");
    const timelineSessions = createMemo(() =>
        linkedSessions()
            .filter(
                (session) =>
                    !appliedTimelineDate() || sessionDate(session)?.key === appliedTimelineDate(),
            )
            .sort((left, right) => {
                const leftStart = startedAt(left);
                const rightStart = startedAt(right);
                return leftStart < rightStart ? -1 : leftStart > rightStart ? 1 : 0;
            }),
    );
    const availableGuides = createMemo(() =>
        props.guides.filter(
            (guide) =>
                !field(guide, "session_id") && !same(field(guide, "entry_id"), props.entry.id),
        ),
    );
    async function moveGuide(): Promise<void> {
        try {
            const guide = availableGuides().find((item) => same(item.id, guideId()));
            if (!guide) throw new Error("Choose a study guide to move.");
            const draft = guideDraftFromRecord(guide);
            const sourceRecords = await loadGuideScope(props.snapshot);
            // Validate every explicit, inline, and image citation against the destination.
            // Preserve the original guide fields and content when changing its owner.
            makeGuideRecord(
                { ...draft, entryId: props.entry.id },
                { entry: props.entry, records: sourceRecords },
                guide,
            );
            const old = props.entries.find((item) => same(item.id, field(guide, "entry_id")));
            const records = [
                update(props.entry, {
                    study_guide_ids: withId(field(props.entry, "study_guide_ids"), guide.id, true),
                }),
                update(guide, { entry_id: props.entry.id.toLowerCase() }),
            ];
            if (old)
                records.push(
                    update(old, {
                        study_guide_ids: withId(field(old, "study_guide_ids"), guide.id, false),
                    }),
                );
            if (await write(records, "Study guide moved to journal entry.")) setGuideId("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }
    async function write(records: ArchiveRecord[], message: string): Promise<boolean> {
        setPending(true);
        setError("");
        try {
            return await props.onWriteRecords(records, message);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return false;
        } finally {
            setPending(false);
        }
    }
    async function move(): Promise<void> {
        try {
            const session = availableSessions().find((item) => same(item.id, sessionId()));
            if (!session) throw new Error("Choose a session to move.");
            const records = moveJournalSession(
                props.entry,
                session,
                props.entries,
                props.notesDocuments,
                props.guides,
                await loadGuideScope(props.snapshot),
            );
            if (await write(records, "Session and related records moved to journal entry."))
                setSessionId("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }
    async function createSession(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        const title = sessionTitle().trim();
        const creatingStudent = sessionStudent() === "__new_student__";
        if (!title) {
            setError("Enter a title for the session.");
            return;
        }
        if (creatingStudent && !newStudentName().trim()) {
            setError("Enter a name for the new student.");
            return;
        }
        try {
            const student = creatingStudent
                ? makeStudentRecord({
                      name: newStudentName(),
                      grade: newStudentGrade(),
                      subjects: sessionSubject(),
                      objectives: "",
                      tutorNotes: "",
                  })
                : null;
            const records = makeSessionRecords(
                {
                    title,
                    studentId: student?.id ?? sessionStudent(),
                    subject: sessionSubject(),
                    objectives: sessionObjectives(),
                    noteBlocks: [],
                },
                {
                    linkedEntry: props.entry,
                    sessionType: sessionType(),
                    recordingSource: recordingSource(),
                    transcriptionLanguage: sessionLanguage(),
                    guideTemplateId: sessionGuideTemplate(),
                },
            );
            if (
                await write(
                    [...(student ? [student] : []), ...records],
                    "Session created in this journal entry.",
                )
            ) {
                setSessionTitle("");
                setSessionType("notes-only");
                setRecordingSource("none");
                setSessionStudent("");
                setNewStudentName("");
                setNewStudentGrade("");
                setSessionSubject("");
                setSessionObjectives("");
                setSessionLanguage("auto");
                setSessionGuideTemplate("");
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }
    async function toggleAsset(asset: ArchiveRecord, enabled: boolean): Promise<void> {
        await write(
            [
                update(props.entry, {
                    attachment_ids: withId(field(props.entry, "attachment_ids"), asset.id, enabled),
                }),
            ],
            enabled ? "Material linked to journal entry." : "Material unlinked from journal entry.",
        );
    }
    async function trashEntry(): Promise<void> {
        setPending(true);
        setError("");
        try {
            const records = await trashJournalEntryGroup(props.snapshot, props.entry.id);
            if (
                await props.onWriteRecords(
                    records,
                    "Journal entry and its notes moved to recoverable Trash.",
                )
            ) {
                setDeleteConfirmed(false);
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <section class="journal-relations">
            <button
                type="button"
                class="button button-quiet record-action"
                aria-expanded={open()}
                onClick={() => setOpen((value) => !value)}
            >
                {open() ? "Hide connections" : "Connections"}
            </button>
            <div class="journal-entry-delete">
                <Show when={!canDeleteEntry()}>
                    <p>{journalEntryDeleteBlockerMessage(deleteBlockers())}</p>
                </Show>
                <Show when={canDeleteEntry()}>
                    <label>
                        <input
                            type="checkbox"
                            checked={deleteConfirmed()}
                            disabled={props.disabled || pending()}
                            onChange={(event) => setDeleteConfirmed(event.currentTarget.checked)}
                        />
                        Move this entry and its notes to recoverable Trash. The group can be
                        restored later.
                    </label>
                    <button
                        type="button"
                        class="button button-danger record-action"
                        disabled={props.disabled || pending() || !deleteConfirmed()}
                        onClick={() => void trashEntry()}
                    >
                        {pending() ? "Moving…" : "Move entry to Trash"}
                    </button>
                </Show>
            </div>
            <Show when={open()}>
                <div class="journal-relations-content">
                    <Show when={error()}>
                        <p role="alert">{error()}</p>
                    </Show>
                    <h3>Sessions</h3>
                    <form class="journal-session-create" onSubmit={createSession}>
                        <h4>Create a session in this entry</h4>
                        <label class="form-field">
                            Session title
                            <input
                                required
                                maxlength="240"
                                value={sessionTitle()}
                                onInput={(event) => setSessionTitle(event.currentTarget.value)}
                            />
                        </label>
                        <div class="journal-session-create-grid">
                            <label class="form-field">
                                Mode
                                <select
                                    value={sessionType()}
                                    onChange={(event) => {
                                        const value = event.currentTarget.value;
                                        setSessionType(value);
                                        setRecordingSource(
                                            value === "record-audio"
                                                ? "microphone"
                                                : value === "import-recording"
                                                  ? "imported-file"
                                                  : "none",
                                        );
                                    }}
                                >
                                    <option value="notes-only">Notes only</option>
                                    <option value="record-audio">Record audio</option>
                                    <option value="import-recording">Import recording</option>
                                </select>
                            </label>
                            <label class="form-field">
                                Student
                                <select
                                    value={sessionStudent()}
                                    onChange={(event) =>
                                        setSessionStudent(event.currentTarget.value)
                                    }
                                >
                                    <option value="">Independent session</option>
                                    <For each={props.students}>
                                        {(student) => (
                                            <option value={student.id}>
                                                {field(student, "display_name", "Student")}
                                            </option>
                                        )}
                                    </For>
                                    <option value="__new_student__">Create a new student</option>
                                </select>
                            </label>
                            <label class="form-field">
                                Transcription language
                                <input
                                    value={sessionLanguage()}
                                    placeholder="auto"
                                    maxlength="32"
                                    onInput={(event) =>
                                        setSessionLanguage(event.currentTarget.value)
                                    }
                                />
                            </label>
                            <label class="form-field">
                                Guide template
                                <select
                                    value={sessionGuideTemplate()}
                                    onChange={(event) =>
                                        setSessionGuideTemplate(event.currentTarget.value)
                                    }
                                >
                                    <option value="">Use recommended template</option>
                                    <For each={GUIDE_TEMPLATES}>
                                        {(template) => (
                                            <option value={template.id}>{template.name}</option>
                                        )}
                                    </For>
                                    <For
                                        each={props.guideTemplates.filter(
                                            (template) =>
                                                !GUIDE_TEMPLATES.some((builtIn) =>
                                                    same(builtIn.id, template.id),
                                                ),
                                        )}
                                    >
                                        {(template) => (
                                            <option value={template.id}>
                                                {field(template, "name", "Custom template")}
                                            </option>
                                        )}
                                    </For>
                                </select>
                            </label>
                            <label class="form-field">
                                Capture source
                                <select
                                    value={recordingSource()}
                                    onChange={(event) =>
                                        setRecordingSource(event.currentTarget.value)
                                    }
                                >
                                    <Show when={sessionType() === "record-audio"}>
                                        <option value="microphone">Microphone</option>
                                        <option value="system-audio">System audio</option>
                                        <option value="both">Microphone and system audio</option>
                                        <option value="application">Application audio</option>
                                    </Show>
                                    <Show when={sessionType() === "import-recording"}>
                                        <option value="imported-file">Imported file</option>
                                    </Show>
                                    <Show when={sessionType() === "notes-only"}>
                                        <option value="none">None</option>
                                    </Show>
                                </select>
                            </label>
                        </div>
                        <Show when={sessionStudent() === "__new_student__"}>
                            <div class="journal-session-create-grid">
                                <label class="form-field">
                                    New student name
                                    <input
                                        required
                                        maxlength="256"
                                        value={newStudentName()}
                                        onInput={(event) =>
                                            setNewStudentName(event.currentTarget.value)
                                        }
                                    />
                                </label>
                                <label class="form-field">
                                    Grade or level
                                    <input
                                        maxlength="128"
                                        value={newStudentGrade()}
                                        onInput={(event) =>
                                            setNewStudentGrade(event.currentTarget.value)
                                        }
                                    />
                                </label>
                            </div>
                        </Show>
                        <div class="journal-session-create-grid">
                            <label class="form-field">
                                Subject
                                <input
                                    maxlength="200"
                                    value={sessionSubject()}
                                    onInput={(event) =>
                                        setSessionSubject(event.currentTarget.value)
                                    }
                                />
                            </label>
                            <label class="form-field">
                                Learning objectives
                                <input
                                    maxlength="4000"
                                    value={sessionObjectives()}
                                    onInput={(event) =>
                                        setSessionObjectives(event.currentTarget.value)
                                    }
                                />
                            </label>
                        </div>
                        <button
                            type="submit"
                            class="button button-primary record-action"
                            disabled={props.disabled || pending()}
                        >
                            {pending() ? "Creating…" : "Create session"}
                        </button>
                    </form>
                    <div class="journal-relations-action journal-session-timeline-filter">
                        <label>
                            Timeline date (UTC)
                            <input
                                type="date"
                                value={timelineDate()}
                                aria-label="Filter linked sessions by UTC date"
                                onInput={(event) => setTimelineDate(event.currentTarget.value)}
                            />
                        </label>
                        <button
                            type="button"
                            class="button button-outline record-action"
                            disabled={!timelineDate() || linkedSessions().length === 0}
                            onClick={() => {
                                setAppliedTimelineDate(timelineDate());
                                setError("");
                            }}
                        >
                            Jump to date
                        </button>
                        <button
                            type="button"
                            class="button button-quiet record-action"
                            disabled={!appliedTimelineDate()}
                            onClick={() => {
                                setTimelineDate("");
                                setAppliedTimelineDate("");
                            }}
                        >
                            All dates
                        </button>
                    </div>
                    <Show when={linkedSessions().length} fallback={<p>No sessions linked.</p>}>
                        <Show
                            when={timelineSessions().length}
                            fallback={<p>No linked sessions on {appliedTimelineDate()}.</p>}
                        >
                            <ul>
                                <For each={timelineSessions()}>
                                    {(item) => (
                                        <li>
                                            {field(item, "title") || "Untitled session"}
                                            <Show when={sessionDate(item)}>
                                                {(date) => <small>{date().label}</small>}
                                            </Show>
                                        </li>
                                    )}
                                </For>
                            </ul>
                        </Show>
                    </Show>
                    <Show when={availableSessions().length}>
                        <div class="journal-relations-action">
                            <label>
                                Move a session here
                                <select
                                    value={sessionId()}
                                    disabled={props.disabled || pending()}
                                    onChange={(event) => setSessionId(event.currentTarget.value)}
                                >
                                    <option value="">Choose a session</option>
                                    <For each={availableSessions()}>
                                        {(item) => (
                                            <option value={item.id}>
                                                {field(item, "title") || "Untitled session"}
                                            </option>
                                        )}
                                    </For>
                                </select>
                            </label>
                            <button
                                type="button"
                                class="button button-outline record-action"
                                disabled={props.disabled || pending() || !sessionId()}
                                onClick={() => void move()}
                            >
                                Move session
                            </button>
                        </div>
                        <p>Session notes and linked study guides move with it.</p>
                    </Show>
                    <h3>Study guides</h3>
                    <Show when={linkedGuides().length} fallback={<p>No study guides linked.</p>}>
                        <ul>
                            <For each={linkedGuides()}>
                                {(item) => <li>{field(item, "title") || "Untitled guide"}</li>}
                            </For>
                        </ul>
                    </Show>
                    <Show when={availableGuides().length}>
                        <div class="journal-relations-action">
                            <label>
                                Move an entry guide here
                                <select
                                    value={guideId()}
                                    disabled={props.disabled || pending()}
                                    onChange={(event) => setGuideId(event.currentTarget.value)}
                                >
                                    <option value="">Choose a guide</option>
                                    <For each={availableGuides()}>
                                        {(item) => (
                                            <option value={item.id}>
                                                {field(item, "title") || "Untitled guide"}
                                            </option>
                                        )}
                                    </For>
                                </select>
                            </label>
                            <button
                                type="button"
                                class="button button-outline record-action"
                                disabled={props.disabled || pending() || !guideId()}
                                onClick={() => void moveGuide()}
                            >
                                Move guide
                            </button>
                        </div>
                        <p>All cited sources must belong to this entry to move a guide here.</p>
                    </Show>
                    <h3>Materials</h3>
                    <Show when={props.assets.length} fallback={<p>No materials available.</p>}>
                        <div class="journal-relations-materials">
                            <For each={props.assets}>
                                {(asset) => (
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={attached().has(asset.id.toLowerCase())}
                                            disabled={props.disabled || pending()}
                                            onChange={(event) =>
                                                void toggleAsset(asset, event.currentTarget.checked)
                                            }
                                        />{" "}
                                        {field(asset, "filename") ||
                                            field(asset, "display_name") ||
                                            field(asset, "file_name") ||
                                            "Untitled material"}
                                    </label>
                                )}
                            </For>
                        </div>
                    </Show>
                </div>
            </Show>
        </section>
    );
}
