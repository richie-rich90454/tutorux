import { twClasses } from "./tailwind";
import { jsxTailwindStyles } from "./RecordPage.tailwind";
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
        <div class={twClasses("page-body record-page", jsxTailwindStyles, "div")}>
            <section class={twClasses("record-heading", jsxTailwindStyles, "section")}>
                <div class={twClasses("", jsxTailwindStyles, "div")}>
                    <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                        {heading().eyebrow}
                    </span>
                    <h1 class={twClasses("", jsxTailwindStyles, "h1")}>{heading().title}</h1>
                    <p class={twClasses("", jsxTailwindStyles, "p")}>{heading().description}</p>
                </div>
                <div class={twClasses("record-heading-actions", jsxTailwindStyles, "div")}>
                    <Show when={props.kind === "sessions" && props.onImportSessionPackage}>
                        <label
                            class={twClasses(
                                "session-package-student-picker",
                                jsxTailwindStyles,
                                "label",
                            )}
                        >
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                Link imported session to
                            </span>
                            <select
                                value={sessionPackageStudentId()}
                                disabled={!props.state.snapshot.canMutate || props.busy}
                                onChange={(event) =>
                                    setSessionPackageStudentId(event.currentTarget.value)
                                }
                                aria-label="Student for imported session"
                                class={twClasses("", jsxTailwindStyles, "select")}
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
                            class={twClasses("button button-outline", jsxTailwindStyles, "button")}
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
                            class={twClasses("button button-primary", jsxTailwindStyles, "button")}
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
                <div
                    class={twClasses("journal-filter-row", jsxTailwindStyles, "div")}
                    aria-label="Filter journal entries"
                >
                    <label class={twClasses("", jsxTailwindStyles, "label")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            Filter by collection
                        </span>
                        <select
                            value={collectionFilter()}
                            onChange={(event) => setCollectionFilter(event.currentTarget.value)}
                            class={twClasses("", jsxTailwindStyles, "select")}
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
                    <label class={twClasses("", jsxTailwindStyles, "label")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>Filter by tag</span>
                        <select
                            value={tagFilter()}
                            onChange={(event) => setTagFilter(event.currentTarget.value)}
                            class={twClasses("", jsxTailwindStyles, "select")}
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
                    <label class={twClasses("", jsxTailwindStyles, "label")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>Sort</span>
                        <select
                            value={journalSort()}
                            onChange={(event) =>
                                setJournalSort(
                                    event.currentTarget.value as "newest" | "oldest" | "title",
                                )
                            }
                            class={twClasses("", jsxTailwindStyles, "select")}
                        >
                            <option value="newest">Newest first</option>
                            <option value="oldest">Oldest first</option>
                            <option value="title">Title</option>
                        </select>
                    </label>
                    <label class={twClasses("", jsxTailwindStyles, "label")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>From date</span>
                        <DatePicker
                            id="journal-from-date"
                            value={journalFrom()}
                            aria-label="Filter from date"
                            onChange={setJournalFrom}
                        />
                    </label>
                    <label class={twClasses("", jsxTailwindStyles, "label")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>To date</span>
                        <DatePicker
                            id="journal-to-date"
                            value={journalTo()}
                            aria-label="Filter to date"
                            onChange={setJournalTo}
                        />
                    </label>
                    <label class={twClasses("", jsxTailwindStyles, "label")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>Has sessions</span>
                        <select
                            value={hasSessions()}
                            onChange={(event) =>
                                setHasSessions(event.currentTarget.value as "all" | "yes" | "no")
                            }
                            class={twClasses("", jsxTailwindStyles, "select")}
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
                            class={twClasses("text-action", jsxTailwindStyles, "button")}
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
            <section class={twClasses("record-list-shell", jsxTailwindStyles, "section")}>
                <div
                    class={twClasses(
                        `record-list-toolbar ${props.kind === "sessions" ? "session-list-toolbar" : ""}`,
                        jsxTailwindStyles,
                        "div",
                    )}
                >
                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            {visibleRecords().length}
                        </strong>{" "}
                        {heading().title.toLowerCase()}
                    </span>
                    <Show when={props.kind === "sessions"}>
                        <div
                            class={twClasses("session-view-switch", jsxTailwindStyles, "div")}
                            role="group"
                            aria-label="Session archive view"
                        >
                            <button
                                type="button"
                                aria-pressed={sessionArchiveView() === "current"}
                                class={twClasses("", jsxTailwindStyles, "button", ["is-selected"])}
                                classList={{ "is-selected": sessionArchiveView() === "current" }}
                                onClick={() => setSessionArchiveView("current")}
                            >
                                Current{" "}
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    {props.state.sessions.length}
                                </span>
                            </button>
                            <button
                                type="button"
                                aria-pressed={sessionArchiveView() === "archived"}
                                class={twClasses("", jsxTailwindStyles, "button", ["is-selected"])}
                                classList={{ "is-selected": sessionArchiveView() === "archived" }}
                                onClick={() => setSessionArchiveView("archived")}
                            >
                                Archived{" "}
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    {props.state.archivedSessions.length}
                                </span>
                            </button>
                        </div>
                    </Show>
                    <Show when={props.kind !== "sessions"}>
                        <span class={twClasses("list-view-label", jsxTailwindStyles, "span")}>
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
                    <div
                        class={twClasses(
                            `record-list record-list-${props.kind}`,
                            jsxTailwindStyles,
                            "div",
                        )}
                    >
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
                <article class={twClasses("student-record-card", jsxTailwindStyles, "article")}>
                    <div
                        class={twClasses(
                            `student-avatar avatar-${count % 5}`,
                            jsxTailwindStyles,
                            "div",
                        )}
                    >
                        {initials(field(record, "display_name", "S"))}
                    </div>
                    <div class={twClasses("student-record-main", jsxTailwindStyles, "div")}>
                        <div class={twClasses("record-card-title", jsxTailwindStyles, "div")}>
                            <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                                {field(record, "display_name", "Student")}
                            </h2>
                            <span class={twClasses("record-badge", jsxTailwindStyles, "span")}>
                                {field(record, "grade", "Learner")}
                            </span>
                        </div>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            {field(
                                record,
                                "learning_objectives",
                                "No learning objectives have been added yet.",
                            )}
                        </p>
                        <Show when={subjects.length}>
                            <div class={twClasses("chip-row", jsxTailwindStyles, "div")}>
                                <For each={subjects}>
                                    {(subject) => (
                                        <span
                                            class={twClasses(
                                                "subject-chip",
                                                jsxTailwindStyles,
                                                "span",
                                            )}
                                        >
                                            {subject}
                                        </span>
                                    )}
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
                            <details
                                class={twClasses("record-detail", jsxTailwindStyles, "details")}
                            >
                                <summary class={twClasses("", jsxTailwindStyles, "summary")}>
                                    Learning context
                                </summary>
                                <Show when={field(record, "known_difficulties")}>
                                    <p class={twClasses("", jsxTailwindStyles, "p")}>
                                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                                            Areas to revisit
                                        </strong>
                                        {field(record, "known_difficulties")}
                                    </p>
                                </Show>
                                <Show when={field(record, "demonstrated_improvements")}>
                                    <p class={twClasses("", jsxTailwindStyles, "p")}>
                                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                                            Demonstrated improvements
                                        </strong>
                                        {field(record, "demonstrated_improvements")}
                                    </p>
                                </Show>
                                <Show when={field(record, "preferred_guide_template")}>
                                    <p class={twClasses("", jsxTailwindStyles, "p")}>
                                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                                            Preferred guide structure
                                        </strong>
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
                            <details
                                class={twClasses("record-detail", jsxTailwindStyles, "details")}
                            >
                                <summary class={twClasses("", jsxTailwindStyles, "summary")}>
                                    Private tutor notes
                                </summary>
                                <p class={twClasses("", jsxTailwindStyles, "p")}>
                                    {field(record, "tutor_notes")}
                                </p>
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
                        <div class={twClasses("record-actions", jsxTailwindStyles, "div")}>
                            <button
                                class={twClasses(
                                    "button button-outline record-action",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                onClick={() => props.onEdit?.(record)}
                            >
                                Edit
                            </button>
                            <button
                                class={twClasses(
                                    "icon-button record-menu",
                                    jsxTailwindStyles,
                                    "button",
                                )}
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
                <article class={twClasses("journal-record-card", jsxTailwindStyles, "article")}>
                    <div
                        class={twClasses(
                            "journal-date journal-date-large",
                            jsxTailwindStyles,
                            "div",
                        )}
                    >
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            {undated ? "–" : date.day}
                        </strong>
                        <small class={twClasses("", jsxTailwindStyles, "small")}>
                            {undated ? "NO DATE" : date.month}
                        </small>
                    </div>
                    <div class={twClasses("journal-record-main", jsxTailwindStyles, "div")}>
                        <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                            {undated ? "UNDATED" : date.year}
                        </span>
                        <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                            {field(record, "title", "Untitled entry")}
                        </h2>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            {record.fields.get("session_ids")
                                ? "Linked to a tutoring session"
                                : "A teaching reflection"}
                        </p>
                        <div class={twClasses("record-inline-meta", jsxTailwindStyles, "div")}>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                <Icon name="clock" />
                                {field(record, "entry_date") || "No date"}
                            </span>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                <Icon name="book" />
                                Journal entry
                            </span>
                        </div>
                        <Show when={labels().length > 0}>
                            <div
                                class={twClasses(
                                    "chip-row journal-label-chips",
                                    jsxTailwindStyles,
                                    "div",
                                )}
                            >
                                <For each={labels()}>
                                    {(item) => (
                                        <span
                                            class={twClasses(
                                                "journal-label-chip",
                                                jsxTailwindStyles,
                                                "span",
                                            )}
                                            style={{ "--label-color": safeJournalColor(item) }}
                                        >
                                            <span
                                                class={twClasses("", jsxTailwindStyles, "span")}
                                            />
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
                            class={twClasses(
                                "button button-outline record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
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
                <article class={twClasses("library-record-card", jsxTailwindStyles, "article")}>
                    <span class={twClasses("library-icon guide-icon", jsxTailwindStyles, "span")}>
                        <Icon name="guides" />
                    </span>
                    <div class={twClasses("", jsxTailwindStyles, "div")}>
                        <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                            Study guide
                        </span>
                        <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                            {field(record, "title", "Untitled guide")}
                        </h2>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            {field(
                                record,
                                "summary",
                                field(record, "description", "A reusable structure for learning."),
                            )}
                        </p>
                        <small class={twClasses("", jsxTailwindStyles, "small")}>
                            Updated {formatTimestamp(field(record, "updated_at_us"))}
                        </small>
                    </div>
                    <span class={twClasses("record-badge", jsxTailwindStyles, "span")}>
                        {field(record, "status", "Draft")}
                    </span>
                </article>
            );
        if (props.kind === "evidence")
            return (
                <article class={twClasses("library-record-card", jsxTailwindStyles, "article")}>
                    <span
                        class={twClasses("library-icon evidence-icon", jsxTailwindStyles, "span")}
                    >
                        <Icon name="evidence" />
                    </span>
                    <div class={twClasses("", jsxTailwindStyles, "div")}>
                        <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                            Learning observation
                        </span>
                        <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                            {field(record, "title", field(record, "skill", "Untitled observation"))}
                        </h2>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            {field(
                                record,
                                "description",
                                field(record, "note", "Evidence linked to a learner’s progress."),
                            )}
                        </p>
                        <small class={twClasses("", jsxTailwindStyles, "small")}>
                            {field(record, "classification", "Observation")} ·{" "}
                            {formatTimestamp(field(record, "created_at_us"))}
                        </small>
                    </div>
                </article>
            );
        return (
            <article class={twClasses("library-record-card", jsxTailwindStyles, "article")}>
                <span class={twClasses("library-icon asset-icon", jsxTailwindStyles, "span")}>
                    <Icon name="assets" />
                </span>
                <div class={twClasses("", jsxTailwindStyles, "div")}>
                    <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                        Archive material
                    </span>
                    <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                        {field(
                            record,
                            "display_name",
                            field(record, "file_name", "Untitled material"),
                        )}
                    </h2>
                    <p class={twClasses("", jsxTailwindStyles, "p")}>
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
                    <small class={twClasses("", jsxTailwindStyles, "small")}>
                        {formatBytes(BigInt(field(record, "size_bytes", "0")))} ·{" "}
                        {formatTimestamp(field(record, "created_at_us"))}
                    </small>
                </div>
                <span class={twClasses("record-badge", jsxTailwindStyles, "span")}>
                    {field(record, "status", "Stored")}
                </span>
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
        <article
            class={twClasses(
                `session-record ${props.expanded ? "is-expanded" : ""}`,
                jsxTailwindStyles,
                "article",
            )}
        >
            <div class={twClasses("session-date", jsxTailwindStyles, "div")}>
                <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                    {dateParts(formatTimestamp(field(props.session, "started_at_us"))).day}
                </strong>
                <span class={twClasses("", jsxTailwindStyles, "span")}>
                    {dateParts(formatTimestamp(field(props.session, "started_at_us"))).month}
                </span>
            </div>
            <span class={twClasses("session-kind-icon", jsxTailwindStyles, "span")}>
                <Icon name="sessions" />
            </span>
            <div class={twClasses("session-record-main", jsxTailwindStyles, "div")}>
                <div class={twClasses("record-card-title", jsxTailwindStyles, "div")}>
                    <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                        {field(props.session, "title", "Untitled session")}
                    </h2>
                    <span
                        class={twClasses(
                            `session-state state-${displayState()}`,
                            jsxTailwindStyles,
                            "span",
                        )}
                    >
                        {displayState()}
                    </span>
                </div>
                <p class={twClasses("", jsxTailwindStyles, "p")}>
                    {[
                        student() ? field(student()!, "display_name") : "Independent session",
                        field(props.session, "subject"),
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                </p>
                <Show when={field(props.session, "learning_objectives")}>
                    <span class={twClasses("session-objective", jsxTailwindStyles, "span")}>
                        {field(props.session, "learning_objectives")}
                    </span>
                </Show>
                <div class={twClasses("record-inline-meta", jsxTailwindStyles, "div")}>
                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                        <Icon name="clock" />
                        {formatTimestamp(field(props.session, "started_at_us"))}
                    </span>
                    <Show when={field(props.session, "notes_document_id")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
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
                <div class={twClasses("record-actions session-actions", jsxTailwindStyles, "div")}>
                    <Show
                        when={
                            props.onEdit ||
                            props.onOpenTranscript ||
                            props.onOpenObservations ||
                            props.onOpenStudyGuide
                        }
                    >
                        <div
                            class={twClasses("session-document-links", jsxTailwindStyles, "div")}
                            aria-label="Session documents"
                        >
                            <Show when={props.onEdit}>
                                <button
                                    type="button"
                                    class={twClasses(
                                        "session-document-link",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
                                    disabled={props.disabled}
                                    onClick={() => props.onEdit?.(props.session)}
                                >
                                    Notebook
                                </button>
                            </Show>
                            <Show when={props.onOpenTranscript}>
                                <button
                                    type="button"
                                    class={twClasses(
                                        "session-document-link",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
                                    onClick={() => props.onOpenTranscript?.(props.session)}
                                >
                                    Record & transcript
                                </button>
                            </Show>
                            <Show when={props.onOpenStudyGuide}>
                                <button
                                    type="button"
                                    class={twClasses(
                                        "session-document-link",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
                                    onClick={() => props.onOpenStudyGuide?.(props.session)}
                                >
                                    Study guide
                                </button>
                            </Show>
                        </div>
                    </Show>
                    <Show when={props.onOpenObservations}>
                        <button
                            class={twClasses(
                                "button button-quiet record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
                            type="button"
                            onClick={() => props.onOpenObservations?.(props.session)}
                        >
                            Observations
                        </button>
                    </Show>
                    <Show when={props.onTransition && sessionState() === "created"}>
                        <button
                            class={twClasses(
                                "button button-outline record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
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
                            class={twClasses(
                                "button button-outline record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
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
                                class={twClasses(
                                    "button button-outline record-action",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                disabled={props.disabled}
                                onClick={() => props.onTransition?.(props.session, "review")}
                            >
                                Review
                            </button>
                        </Show>
                        <button
                            class={twClasses(
                                "button button-outline record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onTransition?.(props.session, "resume")}
                        >
                            Resume
                        </button>
                    </Show>
                    <Show when={props.onClone}>
                        <button
                            class={twClasses(
                                "button button-outline record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
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
                            class={twClasses(
                                "button button-outline record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
                            type="button"
                            disabled={props.disabled}
                            onClick={() => props.onExportPackage?.(props.session)}
                        >
                            Export session package
                        </button>
                    </Show>
                    <Show when={props.onArchive}>
                        <button
                            class={twClasses(
                                "button button-outline record-action",
                                jsxTailwindStyles,
                                "button",
                            )}
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
                            class={twClasses(
                                "icon-button record-menu",
                                jsxTailwindStyles,
                                "button",
                            )}
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
