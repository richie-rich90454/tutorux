import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import type { ArchiveRecord } from "./archive/format";
import type { StudentProgressClassification } from "./domain/student-progress";
import type { SessionTransitionAction } from "./domain/records";
import { DatePicker } from "./DatePicker";
import { GUIDE_TEMPLATES } from "./domain/guides";
import {
    JournalHistory,
    JournalOrganizer,
    JournalRelations,
    SessionVersionHistory,
    StudentProgressPanel,
    StudentVersionHistory,
} from "./lazy-components";
import { EmptyState, Icon, type IconName } from "./shared-ui";
import {
    dateParts,
    field,
    formatBytes,
    formatTimestamp,
    initials,
    safeJournalColor,
} from "./shared-utils";
import type { Workspace } from "./main";

import "./journal.css";

export function RecordPage(props: {
    kind: "students" | "sessions" | "journal" | "guides" | "evidence" | "assets";
    records: ArchiveRecord[];
    state: Workspace;
    busy: boolean;
    onAdd?: () => void;
    onEdit?: (record: ArchiveRecord) => void;
    onTrash?: (record: ArchiveRecord) => void;
    onTransition?: (record: ArchiveRecord, action: SessionTransitionAction) => void;
    onClone?: (record: ArchiveRecord) => void;
    onExportSessionPackage?: (record: ArchiveRecord) => void;
    onImportSessionPackage?: (studentId?: string) => void;
    onArchive?: (record: ArchiveRecord, archived: boolean) => void;
    onOpenTranscript?: (record: ArchiveRecord) => void;
    onOpenObservations?: (record: ArchiveRecord) => void;
    onOpenStudyGuide?: (record: ArchiveRecord) => void;
    onProgressReview?: (input: {
        student: ArchiveRecord;
        skill: string;
        classification: StudentProgressClassification;
        evidenceSourceIds: string[];
        reviewedBy: string;
        note: string;
    }) => Promise<boolean>;
    onSaveOrganizer?: (record: ArchiveRecord, message: string) => Promise<boolean>;
    onArchiveOrganizer?: (record: ArchiveRecord) => void;
    onRestoreOrganizer?: (record: ArchiveRecord) => void;
    onRestoreSessionVersion?: (current: ArchiveRecord, previous: ArchiveRecord) => Promise<boolean>;
    onWriteRecords?: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}): JSX.Element {
    const [collectionFilter, setCollectionFilter] = createSignal("");
    const [tagFilter, setTagFilter] = createSignal("");
    const [journalSort, setJournalSort] = createSignal<"newest" | "oldest" | "title">("newest");
    const [journalFrom, setJournalFrom] = createSignal("");
    const [journalTo, setJournalTo] = createSignal("");
    const [hasSessions, setHasSessions] = createSignal<"all" | "yes" | "no">("all");
    const [sessionPackageStudentId, setSessionPackageStudentId] = createSignal("");
    const [sessionArchiveView, setSessionArchiveView] = createSignal<"current" | "archived">(
        "current",
    );
    const visibleRecords = createMemo(() => {
        if (props.kind === "sessions") {
            const showArchived = sessionArchiveView() === "archived";
            return props.records.filter(
                (record) => (field(record, "archived") === "true") === showArchived,
            );
        }
        if (props.kind !== "journal") return props.records;
        return props.records.filter((record) => {
            const collections = field(record, "collection_ids").split(",").filter(Boolean);
            const tags = field(record, "tag_ids").split(",").filter(Boolean);
            const date = field(record, "entry_date");
            const linkedSessionIds = field(record, "session_ids").split(",").filter(Boolean);
            const entryId = record.id.toLowerCase();
            const linkedSessionRecord =
                props.state.sessions.some(
                    (session) => field(session, "entry_id").toLowerCase() === entryId,
                ) ||
                props.state.archivedSessions.some(
                    (session) => field(session, "entry_id").toLowerCase() === entryId,
                );
            const hasLinkedSessions = linkedSessionIds.length > 0 || linkedSessionRecord;
            return (
                (!collectionFilter() || collections.includes(collectionFilter())) &&
                (!tagFilter() || tags.includes(tagFilter())) &&
                (!journalFrom() || (Boolean(date) && date >= journalFrom())) &&
                (!journalTo() || (Boolean(date) && date <= journalTo())) &&
                (hasSessions() === "all" || (hasSessions() === "yes") === hasLinkedSessions)
            );
        });
    });
    const displayedRecords = createMemo(() => {
        const kind = props.kind;
        const records = [...visibleRecords()];
        if (kind !== "journal") {
            return records.sort((a, b) => recordSort(kind, b).localeCompare(recordSort(kind, a)));
        }
        const sortMode = journalSort();
        return records.sort((left, right) => {
            const titleOrder = field(left, "title").localeCompare(field(right, "title"));
            if (sortMode === "title") return titleOrder || left.id.localeCompare(right.id);
            const leftDate = field(left, "entry_date");
            const rightDate = field(right, "entry_date");
            if (!leftDate || !rightDate) {
                if (leftDate) return -1;
                if (rightDate) return 1;
                return titleOrder || left.id.localeCompare(right.id);
            }
            const dateOrder = leftDate.localeCompare(rightDate);
            if (sortMode === "oldest") return dateOrder || titleOrder;
            return -dateOrder || titleOrder;
        });
    });
    const meta: Record<
        typeof props.kind,
        {
            eyebrow: string;
            title: string;
            description: string;
            emptyTitle: string;
            emptyText: string;
            action: string;
            icon: IconName;
        }
    > = {
        students: {
            eyebrow: "The people at the heart of it",
            title: "Students",
            description:
                "Know each learner as a whole person. Keep their goals and progress close to your teaching.",
            emptyTitle: "Start with a learner",
            emptyText:
                "Student profiles help you connect session notes with the person you’re supporting.",
            action: "Add your first student",
            icon: "students",
        },
        sessions: {
            eyebrow: "Every conversation counts",
            title: "Sessions",
            description:
                "A connected record of your tutoring work: notes, materials, and ideas for next time.",
            emptyTitle: "Make room for a first session",
            emptyText:
                "Record the shape of a lesson and the small moments that move learning forward.",
            action: "Create a session",
            icon: "sessions",
        },
        journal: {
            eyebrow: "Notice what’s changing",
            title: "Teaching journal",
            description:
                "A calm, chronological place for reflections, plans, and the details you want to remember.",
            emptyTitle: "Your first note can be small",
            emptyText:
                "Capture one thing you noticed, one question to return to, or one win worth remembering.",
            action: "Write a journal entry",
            icon: "journal",
        },
        guides: {
            eyebrow: "Structure that leaves room",
            title: "Study guides",
            description:
                "Reusable guides and lesson structures, ready to adapt to the learner in front of you.",
            emptyTitle: "No study guides yet",
            emptyText: "Guides from this archive will be gathered here when they’re available.",
            action: "Create a guide",
            icon: "guides",
        },
        evidence: {
            eyebrow: "Growth you can point to",
            title: "Learning evidence",
            description:
                "Observations and source material that make a learner’s progress easier to see and revisit.",
            emptyTitle: "Evidence builds over time",
            emptyText:
                "Verified observations and learning sources from this archive will appear here.",
            action: "Explore sessions",
            icon: "evidence",
        },
        assets: {
            eyebrow: "Materials for the work",
            title: "Materials",
            description: "Files and resources connected to the tutoring work in this archive.",
            emptyTitle: "Your library is quiet for now",
            emptyText: "Audio, images, and documents attached to this archive will live here.",
            action: "Browse sessions",
            icon: "assets",
        },
    };
    const heading = createMemo(() => meta[props.kind]);
    const canAdd = createMemo(
        () => props.kind === "students" || props.kind === "sessions" || props.kind === "journal",
    );
    return (
        <div class="page-body record-page">
            <section class="record-heading">
                <div>
                    <span class="eyebrow">{heading().eyebrow}</span>
                    <h1>{heading().title}</h1>
                    <p>{heading().description}</p>
                </div>
                <div class="record-heading-actions">
                    <Show when={props.kind === "sessions" && props.onImportSessionPackage}>
                        <label class="session-package-student-picker">
                            <span>Link imported session to</span>
                            <select
                                value={sessionPackageStudentId()}
                                disabled={!props.state.snapshot.canMutate || props.busy}
                                onChange={(event) =>
                                    setSessionPackageStudentId(event.currentTarget.value)
                                }
                                aria-label="Student for imported session"
                            >
                                <option value="">Automatically match or leave independent</option>
                                <For each={props.state.students}>
                                    {(student) => (
                                        <option value={student.id}>
                                            {field(student, "display_name", "Learner")}
                                        </option>
                                    )}
                                </For>
                            </select>
                        </label>
                        <button
                            class="button button-outline"
                            type="button"
                            disabled={!props.state.snapshot.canMutate || props.busy}
                            onClick={() =>
                                props.onImportSessionPackage?.(
                                    sessionPackageStudentId() || undefined,
                                )
                            }
                        >
                            Import session package
                        </button>
                    </Show>
                    <Show when={canAdd()}>
                        <button
                            class="button button-primary"
                            type="button"
                            disabled={!props.state.snapshot.canMutate || props.busy}
                            onClick={() => props.onAdd?.()}
                        >
                            <Icon name="plus" />
                            {props.kind === "students"
                                ? "Add student"
                                : props.kind === "sessions"
                                  ? "New session"
                                  : "New entry"}
                        </button>
                    </Show>
                </div>
            </section>
            <Show when={props.kind === "journal"}>
                <JournalOrganizer
                    collections={props.state.collections}
                    tags={props.state.tags}
                    archived={props.state.trashedJournalOrganizers}
                    disabled={!props.state.snapshot.canMutate}
                    busy={props.busy}
                    onSave={(record, message) =>
                        props.onSaveOrganizer?.(record, message) ?? Promise.resolve(false)
                    }
                    onArchive={(record) => props.onArchiveOrganizer?.(record)}
                    onRestore={(record) => props.onRestoreOrganizer?.(record)}
                />
                <div class="journal-filter-row" aria-label="Filter journal entries">
                    <label>
                        <span>Filter by collection</span>
                        <select
                            value={collectionFilter()}
                            onChange={(event) => setCollectionFilter(event.currentTarget.value)}
                        >
                            <option value="">All collections</option>
                            <For each={props.state.collections}>
                                {(item) => (
                                    <option value={item.id}>
                                        {field(item, "name", "Untitled collection")}
                                    </option>
                                )}
                            </For>
                        </select>
                    </label>
                    <label>
                        <span>Filter by tag</span>
                        <select
                            value={tagFilter()}
                            onChange={(event) => setTagFilter(event.currentTarget.value)}
                        >
                            <option value="">All tags</option>
                            <For each={props.state.tags}>
                                {(item) => (
                                    <option value={item.id}>
                                        {field(item, "name", "Untitled tag")}
                                    </option>
                                )}
                            </For>
                        </select>
                    </label>
                    <label>
                        <span>Sort</span>
                        <select
                            value={journalSort()}
                            onChange={(event) =>
                                setJournalSort(
                                    event.currentTarget.value as "newest" | "oldest" | "title",
                                )
                            }
                        >
                            <option value="newest">Newest first</option>
                            <option value="oldest">Oldest first</option>
                            <option value="title">Title</option>
                        </select>
                    </label>
                    <label>
                        <span>From date</span>
                        <DatePicker
                            id="journal-from-date"
                            value={journalFrom()}
                            aria-label="Filter from date"
                            onChange={setJournalFrom}
                        />
                    </label>
                    <label>
                        <span>To date</span>
                        <DatePicker
                            id="journal-to-date"
                            value={journalTo()}
                            aria-label="Filter to date"
                            onChange={setJournalTo}
                        />
                    </label>
                    <label>
                        <span>Has sessions</span>
                        <select
                            value={hasSessions()}
                            onChange={(event) =>
                                setHasSessions(event.currentTarget.value as "all" | "yes" | "no")
                            }
                        >
                            <option value="all">Any entry</option>
                            <option value="yes">Linked to a session</option>
                            <option value="no">No linked sessions</option>
                        </select>
                    </label>
                    <Show
                        when={
                            collectionFilter() ||
                            tagFilter() ||
                            journalFrom() ||
                            journalTo() ||
                            hasSessions() !== "all"
                        }
                    >
                        <button
                            class="text-action"
                            type="button"
                            onClick={() => {
                                setCollectionFilter("");
                                setTagFilter("");
                                setJournalFrom("");
                                setJournalTo("");
                                setHasSessions("all");
                            }}
                        >
                            Clear filters
                        </button>
                    </Show>
                </div>
            </Show>
            <section class="record-list-shell">
                <div
                    class={`record-list-toolbar ${props.kind === "sessions" ? "session-list-toolbar" : ""}`}
                >
                    <span>
                        <strong>{visibleRecords().length}</strong> {heading().title.toLowerCase()}
                    </span>
                    <Show when={props.kind === "sessions"}>
                        <div
                            class="session-view-switch"
                            role="group"
                            aria-label="Session archive view"
                        >
                            <button
                                type="button"
                                aria-pressed={sessionArchiveView() === "current"}
                                classList={{ "is-selected": sessionArchiveView() === "current" }}
                                onClick={() => setSessionArchiveView("current")}
                            >
                                Current <span>{props.state.sessions.length}</span>
                            </button>
                            <button
                                type="button"
                                aria-pressed={sessionArchiveView() === "archived"}
                                classList={{ "is-selected": sessionArchiveView() === "archived" }}
                                onClick={() => setSessionArchiveView("archived")}
                            >
                                Archived <span>{props.state.archivedSessions.length}</span>
                            </button>
                        </div>
                    </Show>
                    <Show when={props.kind !== "sessions"}>
                        <span class="list-view-label">
                            <Icon name="more" />
                            Latest first
                        </span>
                    </Show>
                </div>
                <Show
                    when={visibleRecords().length > 0}
                    fallback={
                        <EmptyState
                            icon={heading().icon}
                            title={
                                props.kind === "sessions" && sessionArchiveView() === "archived"
                                    ? "No archived sessions"
                                    : heading().emptyTitle
                            }
                            text={
                                props.kind === "sessions" && sessionArchiveView() === "archived"
                                    ? "Archived sessions stay available here until you return them to current sessions."
                                    : heading().emptyText
                            }
                            action={
                                props.kind === "sessions" && sessionArchiveView() === "archived"
                                    ? ""
                                    : heading().action
                            }
                            onAction={() => (canAdd() ? props.onAdd?.() : undefined)}
                            disabled={
                                !canAdd() ||
                                !props.state.snapshot.canMutate ||
                                (props.kind === "sessions" && sessionArchiveView() === "archived")
                            }
                        />
                    }
                >
                    <div class={`record-list record-list-${props.kind}`}>
                        <For each={displayedRecords()}>
                            {(record) => (
                                <RecordCard
                                    kind={props.kind}
                                    record={record}
                                    students={props.state.students}
                                    sessions={props.state.sessions}
                                    evidence={props.state.evidence}
                                    collections={props.state.collections}
                                    tags={props.state.tags}
                                    guideTemplates={props.state.guideTemplates}
                                    snapshot={props.state.snapshot}
                                    workspace={props.state}
                                    notesDocuments={props.state.notesDocuments}
                                    onWriteRecords={props.onWriteRecords}
                                    onRestoreSessionVersion={props.onRestoreSessionVersion}
                                    disabled={!props.state.snapshot.canMutate}
                                    busy={props.busy}
                                    onProgressReview={props.onProgressReview}
                                    onEdit={
                                        !props.state.snapshot.canMutate ? undefined : props.onEdit
                                    }
                                    onTrash={
                                        !props.state.snapshot.canMutate ? undefined : props.onTrash
                                    }
                                    onTransition={
                                        !props.state.snapshot.canMutate
                                            ? undefined
                                            : props.onTransition
                                    }
                                    onClone={
                                        !props.state.snapshot.canMutate ? undefined : props.onClone
                                    }
                                    onExportSessionPackage={
                                        !props.state.snapshot.canMutate
                                            ? undefined
                                            : props.onExportSessionPackage
                                    }
                                    onArchive={
                                        !props.state.snapshot.canMutate
                                            ? undefined
                                            : props.onArchive
                                    }
                                    onOpenTranscript={props.onOpenTranscript}
                                    onOpenObservations={props.onOpenObservations}
                                    onOpenStudyGuide={props.onOpenStudyGuide}
                                />
                            )}
                        </For>
                    </div>
                </Show>
            </section>
        </div>
    );
}

function RecordCard(props: {
    kind: RecordPagePropsKind;
    record: ArchiveRecord;
    students: ArchiveRecord[];
    sessions: ArchiveRecord[];
    evidence: ArchiveRecord[];
    collections: ArchiveRecord[];
    tags: ArchiveRecord[];
    guideTemplates: ArchiveRecord[];
    snapshot: ArchiveSnapshot;
    workspace: Workspace;
    notesDocuments: ArchiveRecord[];
    onWriteRecords: ((records: ArchiveRecord[], message: string) => Promise<boolean>) | undefined;
    onRestoreSessionVersion:
        | ((current: ArchiveRecord, previous: ArchiveRecord) => Promise<boolean>)
        | undefined;
    disabled: boolean;
    busy: boolean;
    onProgressReview:
        | ((input: {
              student: ArchiveRecord;
              skill: string;
              classification: StudentProgressClassification;
              evidenceSourceIds: string[];
              reviewedBy: string;
              note: string;
          }) => Promise<boolean>)
        | undefined;
    onEdit: ((record: ArchiveRecord) => void) | undefined;
    onTrash: ((record: ArchiveRecord) => void) | undefined;
    onTransition: ((record: ArchiveRecord, action: SessionTransitionAction) => void) | undefined;
    onClone: ((record: ArchiveRecord) => void) | undefined;
    onExportSessionPackage: ((record: ArchiveRecord) => void) | undefined;
    onArchive: ((record: ArchiveRecord, archived: boolean) => void) | undefined;
    onOpenTranscript: ((record: ArchiveRecord) => void) | undefined;
    onOpenObservations: ((record: ArchiveRecord) => void) | undefined;
    onOpenStudyGuide: ((record: ArchiveRecord) => void) | undefined;
}): JSX.Element {
    const renderedCard = createMemo<JSX.Element>(() => {
        const record = props.record;
        if (props.kind === "students") {
            const subjects = field(record, "subjects")
                .split(/[;,]/u)
                .map((value) => value.trim())
                .filter(Boolean)
                .slice(0, 3);
            const count = props.students.length
                ? props.students.findIndex((item) => item.id === record.id) + 1
                : 1;
            return (
                <article class="student-record-card">
                    <div class={`student-avatar avatar-${count % 5}`}>
                        {initials(field(record, "display_name", "S"))}
                    </div>
                    <div class="student-record-main">
                        <div class="record-card-title">
                            <h2>{field(record, "display_name", "Student")}</h2>
                            <span class="record-badge">{field(record, "grade", "Learner")}</span>
                        </div>
                        <p>
                            {field(
                                record,
                                "learning_objectives",
                                "No learning objectives have been added yet.",
                            )}
                        </p>
                        <Show when={subjects.length}>
                            <div class="chip-row">
                                <For each={subjects}>
                                    {(subject) => <span class="subject-chip">{subject}</span>}
                                </For>
                            </div>
                        </Show>
                        <Show
                            when={
                                field(record, "known_difficulties") ||
                                field(record, "demonstrated_improvements") ||
                                field(record, "preferred_guide_template")
                            }
                        >
                            <details class="record-detail">
                                <summary>Learning context</summary>
                                <Show when={field(record, "known_difficulties")}>
                                    <p>
                                        <strong>Areas to revisit</strong>
                                        {field(record, "known_difficulties")}
                                    </p>
                                </Show>
                                <Show when={field(record, "demonstrated_improvements")}>
                                    <p>
                                        <strong>Demonstrated improvements</strong>
                                        {field(record, "demonstrated_improvements")}
                                    </p>
                                </Show>
                                <Show when={field(record, "preferred_guide_template")}>
                                    <p>
                                        <strong>Preferred guide structure</strong>
                                        {GUIDE_TEMPLATES.find(
                                            (template) =>
                                                template.id ===
                                                field(record, "preferred_guide_template"),
                                        )?.name ??
                                            props.guideTemplates
                                                .find(
                                                    (template) =>
                                                        template.id ===
                                                        field(record, "preferred_guide_template"),
                                                )
                                                ?.fields.get("name") ??
                                            field(record, "preferred_guide_template")}
                                    </p>
                                </Show>
                            </details>
                        </Show>
                        <Show when={field(record, "tutor_notes")}>
                            <details class="record-detail">
                                <summary>Private tutor notes</summary>
                                <p>{field(record, "tutor_notes")}</p>
                            </details>
                        </Show>
                        <Show when={props.onProgressReview}>
                            <StudentProgressPanel
                                student={record}
                                sessions={props.sessions}
                                evidence={props.evidence}
                                disabled={props.disabled || !props.onProgressReview}
                                busy={props.busy}
                                onSave={props.onProgressReview!}
                            />
                        </Show>
                        <Show when={props.onWriteRecords}>
                            {(save) => (
                                <StudentVersionHistory
                                    student={record}
                                    snapshot={props.snapshot}
                                    disabled={props.disabled || props.busy}
                                    onSave={save()}
                                />
                            )}
                        </Show>
                    </div>
                    <Show when={props.onEdit || props.onTrash}>
                        <div class="record-actions">
                            <button
                                class="button button-outline record-action"
                                type="button"
                                onClick={() => props.onEdit?.(record)}
                            >
                                Edit
                            </button>
                            <button
                                class="icon-button record-menu"
                                type="button"
                                title="Move to Trash"
                                aria-label={`Move ${field(record, "display_name", "student")} to Trash`}
                                onClick={() => props.onTrash?.(record)}
                            >
                                <Icon name="trash" />
                            </button>
                        </div>
                    </Show>
                </article>
            );
        }
        if (props.kind === "sessions")
            return (
                <SessionRow
                    session={record}
                    students={props.students}
                    expanded
                    snapshot={props.snapshot}
                    onRestoreVersion={props.onRestoreSessionVersion}
                    disabled={props.disabled || props.busy}
                    onEdit={props.onEdit}
                    onTrash={props.onTrash}
                    onTransition={props.onTransition}
                    onClone={props.onClone}
                    onExportPackage={props.onExportSessionPackage}
                    onArchive={props.onArchive}
                    onOpenTranscript={props.onOpenTranscript}
                    onOpenObservations={props.onOpenObservations}
                    onOpenStudyGuide={props.onOpenStudyGuide}
                />
            );
        if (props.kind === "journal") {
            const date = dateParts(field(record, "entry_date"));
            const undated = !field(record, "entry_date");
            const labels = createMemo(() => {
                const collectionIds = field(props.record, "collection_ids")
                    .split(",")
                    .filter(Boolean);
                const tagIds = field(props.record, "tag_ids").split(",").filter(Boolean);
                return [
                    ...props.collections.filter((item) => collectionIds.includes(item.id)),
                    ...props.tags.filter((item) => tagIds.includes(item.id)),
                ];
            });
            return (
                <article class="journal-record-card">
                    <div class="journal-date journal-date-large">
                        <strong>{undated ? "–" : date.day}</strong>
                        <small>{undated ? "NO DATE" : date.month}</small>
                    </div>
                    <div class="journal-record-main">
                        <span class="eyebrow">{undated ? "UNDATED" : date.year}</span>
                        <h2>{field(record, "title", "Untitled entry")}</h2>
                        <p>
                            {record.fields.get("session_ids")
                                ? "Linked to a tutoring session"
                                : "A teaching reflection"}
                        </p>
                        <div class="record-inline-meta">
                            <span>
                                <Icon name="clock" />
                                {field(record, "entry_date") || "No date"}
                            </span>
                            <span>
                                <Icon name="book" />
                                Journal entry
                            </span>
                        </div>
                        <Show when={labels().length > 0}>
                            <div class="chip-row journal-label-chips">
                                <For each={labels()}>
                                    {(item) => (
                                        <span
                                            class="journal-label-chip"
                                            style={{ "--label-color": safeJournalColor(item) }}
                                        >
                                            <span />
                                            {field(item, "name", "Untitled label")}
                                        </span>
                                    )}
                                </For>
                            </div>
                        </Show>
                        <Show when={props.onWriteRecords}>
                            {(writeRecords) => (
                                <JournalHistory
                                    entry={record}
                                    notesDocument={props.notesDocuments.find(
                                        (document) =>
                                            document.id.toLowerCase() ===
                                            field(record, "notes_document_id").toLowerCase(),
                                    )}
                                    snapshot={props.snapshot}
                                    disabled={props.disabled || props.busy}
                                    onWriteRecords={writeRecords()}
                                />
                            )}
                        </Show>
                        <Show when={props.onWriteRecords}>
                            {(writeRecords) => (
                                <JournalRelations
                                    entry={record}
                                    snapshot={props.snapshot}
                                    entries={props.workspace.entries}
                                    sessions={[
                                        ...props.workspace.sessions,
                                        ...props.workspace.archivedSessions,
                                    ]}
                                    students={props.students}
                                    guides={props.workspace.guides}
                                    guideTemplates={props.guideTemplates}
                                    assets={props.workspace.assets}
                                    notesDocuments={props.workspace.notesDocuments}
                                    disabled={props.disabled || props.busy}
                                    onWriteRecords={writeRecords()}
                                />
                            )}
                        </Show>
                    </div>
                    <Show when={props.onEdit}>
                        <button
                            class="button button-outline record-action"
                            type="button"
                            onClick={() => props.onEdit?.(record)}
                        >
                            Edit
                        </button>
                    </Show>
                </article>
            );
        }
        if (props.kind === "guides")
            return (
                <article class="library-record-card">
                    <span class="library-icon guide-icon">
                        <Icon name="guides" />
                    </span>
                    <div>
                        <span class="eyebrow">Study guide</span>
                        <h2>{field(record, "title", "Untitled guide")}</h2>
                        <p>
                            {field(
                                record,
                                "summary",
                                field(record, "description", "A reusable structure for learning."),
                            )}
                        </p>
                        <small>Updated {formatTimestamp(field(record, "updated_at_us"))}</small>
                    </div>
                    <span class="record-badge">{field(record, "status", "Draft")}</span>
                </article>
            );
        if (props.kind === "evidence")
            return (
                <article class="library-record-card">
                    <span class="library-icon evidence-icon">
                        <Icon name="evidence" />
                    </span>
                    <div>
                        <span class="eyebrow">Learning observation</span>
                        <h2>
                            {field(record, "title", field(record, "skill", "Untitled observation"))}
                        </h2>
                        <p>
                            {field(
                                record,
                                "description",
                                field(record, "note", "Evidence linked to a learner’s progress."),
                            )}
                        </p>
                        <small>
                            {field(record, "classification", "Observation")} ·{" "}
                            {formatTimestamp(field(record, "created_at_us"))}
                        </small>
                    </div>
                </article>
            );
        return (
            <article class="library-record-card">
                <span class="library-icon asset-icon">
                    <Icon name="assets" />
                </span>
                <div>
                    <span class="eyebrow">Archive material</span>
                    <h2>
                        {field(
                            record,
                            "display_name",
                            field(record, "file_name", "Untitled material"),
                        )}
                    </h2>
                    <p>
                        {field(
                            record,
                            "media_type",
                            field(
                                record,
                                "description",
                                "File attached to the tutoring workspace.",
                            ),
                        )}
                    </p>
                    <small>
                        {formatBytes(BigInt(field(record, "size_bytes", "0")))} ·{" "}
                        {formatTimestamp(field(record, "created_at_us"))}
                    </small>
                </div>
                <span class="record-badge">{field(record, "status", "Stored")}</span>
            </article>
        );
    });
    return <>{renderedCard()}</>;
}

type RecordPagePropsKind = "students" | "sessions" | "journal" | "guides" | "evidence" | "assets";

export function SessionRow(props: {
    session: ArchiveRecord;
    students: ArchiveRecord[];
    expanded?: boolean;
    snapshot?: ArchiveSnapshot;
    onRestoreVersion?:
        | ((current: ArchiveRecord, previous: ArchiveRecord) => Promise<boolean>)
        | undefined;
    disabled?: boolean;
    onEdit?: ((record: ArchiveRecord) => void) | undefined;
    onTrash?: ((record: ArchiveRecord) => void) | undefined;
    onTransition?: ((record: ArchiveRecord, action: SessionTransitionAction) => void) | undefined;
    onClone?: ((record: ArchiveRecord) => void) | undefined;
    onExportPackage?: ((record: ArchiveRecord) => void) | undefined;
    onArchive?: ((record: ArchiveRecord, archived: boolean) => void) | undefined;
    onOpenTranscript?: ((record: ArchiveRecord) => void) | undefined;
    onOpenObservations?: ((record: ArchiveRecord) => void) | undefined;
    onOpenStudyGuide?: ((record: ArchiveRecord) => void) | undefined;
}): JSX.Element {
    const student = createMemo(() =>
        props.students.find((item) => item.id === field(props.session, "student_id")),
    );
    const sessionState = createMemo(() => field(props.session, "session_state", "active"));
    const displayState = createMemo(() =>
        sessionState() === "in-progress" ? "active" : sessionState(),
    );
    return (
        <article class={`session-record ${props.expanded ? "is-expanded" : ""}`}>
            <div class="session-date">
                <strong>
                    {dateParts(formatTimestamp(field(props.session, "started_at_us"))).day}
                </strong>
                <span>
                    {dateParts(formatTimestamp(field(props.session, "started_at_us"))).month}
                </span>
            </div>
            <span class="session-kind-icon">
                <Icon name="sessions" />
            </span>
            <div class="session-record-main">
                <div class="record-card-title">
                    <h2>{field(props.session, "title", "Untitled session")}</h2>
                    <span class={`session-state state-${displayState()}`}>{displayState()}</span>
                </div>
                <p>
                    {[
                        student() ? field(student()!, "display_name") : "Independent session",
                        field(props.session, "subject"),
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                </p>
                <Show when={field(props.session, "learning_objectives")}>
                    <span class="session-objective">
                        {field(props.session, "learning_objectives")}
                    </span>
                </Show>
                <div class="record-inline-meta">
                    <span>
                        <Icon name="clock" />
                        {formatTimestamp(field(props.session, "started_at_us"))}
                    </span>
                    <Show when={field(props.session, "notes_document_id")}>
                        <span>
                            <Icon name="journal" />
                            Notes attached
                        </span>
                    </Show>
                </div>
                <Show when={props.snapshot && props.onRestoreVersion}>
                    <SessionVersionHistory
                        session={props.session}
                        snapshot={props.snapshot!}
                        disabled={Boolean(props.disabled)}
                        onRestore={props.onRestoreVersion!}
                    />
                </Show>
            </div>
            <Show
                when={
                    props.expanded &&
                    (props.onEdit ||
                        props.onTrash ||
                        props.onTransition ||
                        props.onClone ||
                        props.onExportPackage ||
                        props.onArchive)
                }
            >
                <div class="record-actions session-actions">
                    <Show
                        when={
                            props.onEdit ||
                            props.onOpenTranscript ||
                            props.onOpenObservations ||
                            props.onOpenStudyGuide
                        }
                    >
                        <div class="session-document-links" aria-label="Session documents">
                            <Show when={props.onEdit}>
                                <button
                                    type="button"
                                    class="session-document-link"
                                    disabled={props.disabled}
                                    onClick={() => props.onEdit?.(props.session)}
                                >
                                    Notebook
                                </button>
                            </Show>
                            <Show when={props.onOpenTranscript}>
                                <button
                                    type="button"
                                    class="session-document-link"
                                    onClick={() => props.onOpenTranscript?.(props.session)}
                                >
                                    Record & transcript
                                </button>
                            </Show>
                            <Show when={props.onOpenStudyGuide}>
                                <button
                                    type="button"
                                    class="session-document-link"
                                    onClick={() => props.onOpenStudyGuide?.(props.session)}
                                >
                                    Study guide
                                </button>
                            </Show>
                        </div>
                    </Show>
                    <Show when={props.onOpenObservations}>
                        <button
                            class="button button-quiet record-action"
                            type="button"
                            onClick={() => props.onOpenObservations?.(props.session)}
                        >
                            Observations
                        </button>
                    </Show>
                    <Show when={props.onTransition && sessionState() === "created"}>
                        <button
                            class="button button-outline record-action"
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onTransition?.(props.session, "start")}
                        >
                            Start
                        </button>
                    </Show>
                    <Show
                        when={
                            props.onTransition &&
                            (sessionState() === "active" || sessionState() === "in-progress")
                        }
                    >
                        <button
                            class="button button-outline record-action"
                            type="button"
                            disabled={
                                props.disabled ||
                                field(props.session, "recording_state") === "recording"
                            }
                            title={
                                field(props.session, "recording_state") === "recording"
                                    ? "Stop recording before completing this session."
                                    : undefined
                            }
                            onClick={() => props.onTransition?.(props.session, "complete")}
                        >
                            Complete
                        </button>
                    </Show>
                    <Show
                        when={
                            props.onTransition &&
                            (sessionState() === "completed" || sessionState() === "reviewed")
                        }
                    >
                        <Show when={sessionState() === "completed"}>
                            <button
                                class="button button-outline record-action"
                                type="button"
                                disabled={props.disabled}
                                onClick={() => props.onTransition?.(props.session, "review")}
                            >
                                Review
                            </button>
                        </Show>
                        <button
                            class="button button-outline record-action"
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onTransition?.(props.session, "resume")}
                        >
                            Resume
                        </button>
                    </Show>
                    <Show when={props.onClone}>
                        <button
                            class="button button-outline record-action"
                            type="button"
                            title="Create a fresh session from these details"
                            disabled={props.disabled}
                            onClick={() => props.onClone?.(props.session)}
                        >
                            Duplicate
                        </button>
                    </Show>
                    <Show when={props.onExportPackage}>
                        <button
                            class="button button-outline record-action"
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onExportPackage?.(props.session)}
                        >
                            Export session package
                        </button>
                    </Show>
                    <Show when={props.onArchive}>
                        <button
                            class="button button-outline record-action"
                            type="button"
                            disabled={
                                props.disabled ||
                                (field(props.session, "recording_state") === "recording" &&
                                    field(props.session, "archived") !== "true")
                            }
                            title={
                                field(props.session, "recording_state") === "recording" &&
                                field(props.session, "archived") !== "true"
                                    ? "Stop recording before archiving this session."
                                    : undefined
                            }
                            onClick={() =>
                                props.onArchive?.(
                                    props.session,
                                    field(props.session, "archived") !== "true",
                                )
                            }
                        >
                            {field(props.session, "archived") === "true" ? "Unarchive" : "Archive"}
                        </button>
                    </Show>
                    <Show when={props.onTrash}>
                        <button
                            class="icon-button record-menu"
                            type="button"
                            title="Review session and linked records before moving them to Trash"
                            aria-label={`Review moving ${field(props.session, "title", "session")} and linked records to Trash`}
                            disabled={props.disabled}
                            onClick={() => props.onTrash?.(props.session)}
                        >
                            <Icon name="trash" />
                        </button>
                    </Show>
                </div>
            </Show>
            <Show when={!props.expanded}>
                <Icon name="chevron" />{" "}
            </Show>
        </article>
    );
}

function recordSort(kind: RecordPagePropsKind, record: ArchiveRecord): string {
    if (kind === "journal") return field(record, "entry_date");
    if (kind === "sessions") return field(record, "started_at_us");
    return field(record, "updated_at_us", field(record, "created_at_us"));
}
