import {
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    onMount,
    untrack,
    type JSX,
} from "solid-js";
import { RecordType, type ArchiveRecord } from "./archive/format";
import type { ArchiveSnapshot } from "./archive/archive";
import { GuideVersionHistory } from "./GuideVersionHistory";
import {
    GUIDE_BLOCK_KINDS,
    GUIDE_BLOCK_ORIGINS,
    GUIDE_TEMPLATES,
    createGuideDraft,
    createGuideDraftFromSections,
    duplicateGuideDraft,
    field,
    findGuideTextMatches,
    generateGuideDraftFromEntry,
    generateGuideDraftFromSession,
    getGuideTemplate,
    guideDraftFromRecord,
    guideRegenerationTarget,
    insertGuideImageBlock,
    isGuideSourceInScope,
    makeGuideRecord,
    moveGuideSection,
    replaceAllGuideText,
    replaceGuideSectionFromGenerated,
    replaceGuideTextMatch,
    resolveGuideTemplates,
    validateGuideForExport,
    type GuideBlockDraft,
    type GuideDraft,
    type GuideTemplate,
    type GuideTextMatch,
} from "./domain/guides";
import {
    guideTemplateFromRecord,
    parseGuideTemplateImport,
    type GuideTemplateInput,
} from "./domain/templates";
import { cn, heading1, pageBody } from "./ui";

const denseButton =
    "button inline-flex min-h-[30px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] border border-transparent px-[9px] text-xs font-semibold leading-none transition-colors active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const densePrimary = cn(
    denseButton,
    "button-primary border-accent bg-accent text-white hover:border-accent-hover hover:bg-accent-hover",
);
const denseOutline = cn(
    denseButton,
    "button-outline border-[var(--line-strong)] bg-surface text-ink-soft hover:bg-[var(--surface-inset)] hover:text-ink",
);
const denseQuiet = cn(
    denseButton,
    "button-quiet bg-transparent text-ink-soft hover:bg-accent-soft hover:text-ink",
);
const denseDanger = cn(
    denseButton,
    "button-danger-quiet border-danger/30 bg-[var(--danger-soft)] text-danger hover:border-danger",
);
const moveButton =
    "button button-quiet guide-section-move grid min-h-8 w-8 place-items-center rounded-[5px] border border-transparent bg-transparent p-0 text-sm text-ink-soft transition-colors hover:bg-accent-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const formIconButton =
    "icon-button grid h-8 w-8 shrink-0 place-items-center rounded-[5px] text-muted transition-colors hover:bg-[var(--surface-inset)] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const trashIconButton =
    "guide-trash-button grid h-7 w-7 shrink-0 place-items-center rounded-[5px] text-[18px] text-muted transition-colors hover:bg-[var(--danger-soft)] hover:text-danger disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const eyebrowText = "eyebrow text-xs font-medium tracking-wide text-muted";
const fieldLabel = "form-field grid min-w-0 gap-[5px] text-xs font-semibold text-muted";
const textInput =
    "w-full min-w-0 rounded-[5px] border border-line bg-surface px-2.5 text-xs text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/55 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted";
const textArea =
    "w-full min-w-0 resize-y rounded-[5px] border border-line bg-surface px-2.5 py-[9px] text-xs leading-normal text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/55";

interface GuideDialogProps {
    children: JSX.Element;
    class: string;
    labelledBy: string;
    onEscape: () => void;
    canEscape: () => boolean;
    returnFocus?: HTMLElement | null;
}

function GuideDialog(props: GuideDialogProps): JSX.Element {
    const initialReturnFocus = untrack(() => props.returnFocus);
    const returnFocus =
        initialReturnFocus !== undefined
            ? initialReturnFocus
            : document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
    let dialogElement!: HTMLElement;

    const focusableElements = (): HTMLElement[] =>
        [
            ...dialogElement.querySelectorAll<HTMLElement>(
                'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, audio[controls], video[controls], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
            ),
        ].filter(
            (element) =>
                !element.hasAttribute("hidden") &&
                element.getAttribute("aria-hidden") !== "true" &&
                element.getClientRects().length > 0,
        );

    onMount(() => {
        const initialFocus =
            dialogElement.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
            dialogElement.querySelector<HTMLElement>(
                'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]',
            ) ??
            focusableElements()[0] ??
            dialogElement;
        initialFocus.focus({ preventScroll: true });

        const onKeyDown = (event: KeyboardEvent): void => {
            if (
                !dialogElement.isConnected ||
                [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].at(-1) !==
                    dialogElement
            ) {
                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (props.canEscape()) props.onEscape();
                return;
            }

            if (event.key !== "Tab") return;
            const focusable = focusableElements();
            if (focusable.length === 0) {
                event.preventDefault();
                dialogElement.focus({ preventScroll: true });
                return;
            }

            const first = focusable[0]!;
            const last = focusable.at(-1)!;
            const active = document.activeElement;
            if (
                event.shiftKey &&
                (active === first || active === dialogElement || !dialogElement.contains(active))
            ) {
                event.preventDefault();
                last.focus();
            } else if (
                !event.shiftKey &&
                (active === last || active === dialogElement || !dialogElement.contains(active))
            ) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener("keydown", onKeyDown, true);
        onCleanup(() => {
            document.removeEventListener("keydown", onKeyDown, true);
            queueMicrotask(() => {
                const activeDialog = [
                    ...document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),
                ].at(-1);
                const returnTarget =
                    returnFocus?.isConnected &&
                    !returnFocus.matches(":disabled, [aria-disabled='true']")
                        ? returnFocus
                        : null;
                const target = activeDialog
                    ? returnTarget && activeDialog.contains(returnTarget)
                        ? returnTarget
                        : (activeDialog.querySelector<HTMLElement>(
                              'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
                          ) ?? activeDialog)
                    : (returnTarget ?? document.querySelector<HTMLElement>("#main-content"));
                target?.focus({ preventScroll: true });
            });
        });
    });

    return (
        <section
            ref={(element) => {
                dialogElement = element;
            }}
            class={cn(
                props.class,
                "modal-focus-scope overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-accent/40",
            )}
            role="dialog"
            aria-modal="true"
            aria-labelledby={props.labelledBy}
            tabindex="-1"
        >
            {props.children}
        </section>
    );
}

interface GuidePageProps {
    snapshot: ArchiveSnapshot;
    records: ArchiveRecord[];
    sessions: ArchiveRecord[];
    entries: ArchiveRecord[];
    students: ArchiveRecord[];
    sourceRecords: ArchiveRecord[];
    customTemplates: ArchiveRecord[];
    trashedTemplates: ArchiveRecord[];
    templateManagerOpen: boolean;
    initialSessionId?: string;
    onToggleTemplateManager: () => void;
    disabled: boolean;
    busy: boolean;
    onOpenSessions: () => void;
    onSave: (draft: GuideDraft, current: ArchiveRecord | null) => Promise<boolean>;
    onRestoreVersion: (selected: ArchiveRecord, current: ArchiveRecord) => Promise<boolean>;
    onApprove: (record: ArchiveRecord) => void;
    onTrash: (record: ArchiveRecord) => void;
    onExport: (
        record: ArchiveRecord,
        format: "markdown" | "html" | "json" | "docx" | "pdf",
    ) => void;
    onSaveTemplate: (input: GuideTemplateInput, current: ArchiveRecord | null) => Promise<boolean>;
    onTrashTemplate: (record: ArchiveRecord) => void;
    onRestoreTemplate: (record: ArchiveRecord) => void;
    onExportTemplate: (template: GuideTemplate) => void;
}

export function GuidesPage(props: GuidePageProps): JSX.Element {
    const [editor, setEditor] = createSignal<{
        record: ArchiveRecord | null;
        templateId: string;
        initialDraft?: GuideDraft;
    } | null>(null);
    const [generation, setGeneration] = createSignal<{
        scope: "session" | "entry";
        sourceId: string;
        templateId: string;
        includeEntryEvidence: boolean;
        record: ArchiveRecord | null;
    } | null>(null);
    const [regenerationTitle, setRegenerationTitle] = createSignal("");
    const [generationError, setGenerationError] = createSignal("");
    const [templateEditor, setTemplateEditor] = createSignal<{
        current: ArchiveRecord | null;
        builtinTemplate?: GuideTemplate | undefined;
    } | null>(null);
    const [templateNotice, setTemplateNotice] = createSignal("");
    const [guideNotice, setGuideNotice] = createSignal("");
    const [templateSearch, setTemplateSearch] = createSignal("");
    const [templateKind, setTemplateKind] = createSignal<"all" | "built-in" | "custom">("all");
    const [previewTemplateId, setPreviewTemplateId] = createSignal("");
    const [armedTemplateDeleteId, setArmedTemplateDeleteId] = createSignal("");
    const [overrideRecords, setOverrideRecords] = createSignal<ArchiveRecord[]>([]);
    createEffect(() => {
        const snapshot = props.snapshot;
        let active = true;
        void snapshot
            .listRecords(RecordType.settings)
            .then((records) => {
                if (!active) return;
                setOverrideRecords(
                    records.filter(
                        (record) =>
                            field(record, "record_role") === "guide-template" &&
                            Boolean(field(record, "builtin_template_id")),
                    ),
                );
            })
            .catch(() => {
                if (active) setOverrideRecords([]);
            });
        onCleanup(() => {
            active = false;
        });
    });
    const canCreate = () => props.sessions.length > 0 && !props.disabled;
    const canCreateEntry = () => props.entries.length > 0 && !props.disabled;
    const canCreateGuide = () => canCreate() || canCreateEntry();
    const customTemplates = () => props.customTemplates.map(guideTemplateFromRecord);
    const templateOverrides = () => {
        const seen = new Set<string>();
        return [...props.customTemplates, ...overrideRecords()].filter((record) => {
            const builtinId = field(record, "builtin_template_id");
            if (
                !builtinId ||
                seen.has(builtinId) ||
                field(record, "record_role") !== "guide-template"
            )
                return false;
            seen.add(builtinId);
            return true;
        });
    };
    const allTemplates = () =>
        resolveGuideTemplates([...props.customTemplates, ...overrideRecords()]);
    const visibleTemplates = () => {
        const query = templateSearch().trim().toLowerCase();
        return allTemplates().filter((template) => {
            const custom = !GUIDE_TEMPLATES.some((builtIn) => builtIn.id === template.id);
            if (templateKind() === "built-in" && custom) return false;
            if (templateKind() === "custom" && !custom) return false;
            if (!query) return true;
            return [
                template.name,
                template.subject,
                template.description,
                ...template.sections,
                template.body,
            ]
                .join(" ")
                .toLowerCase()
                .includes(query);
        });
    };
    const visibleCustomTemplateRecords = () => {
        const query = templateSearch().trim().toLowerCase();
        return props.customTemplates.filter((record) => {
            if (!query) return true;
            const template = guideTemplateFromRecord(record);
            return [
                template.name,
                template.subject,
                template.description,
                ...template.sections,
                template.body,
            ]
                .join(" ")
                .toLowerCase()
                .includes(query);
        });
    };

    function openGeneration(): void {
        setGenerationError("");
        setRegenerationTitle("");
        setGeneration({
            scope: "session",
            sourceId:
                props.sessions.find((session) => session.id === props.initialSessionId)?.id ??
                props.sessions[0]?.id ??
                "",
            templateId: "auto",
            includeEntryEvidence: false,
            record: null,
        });
    }

    function openEntryGeneration(): void {
        setGenerationError("");
        setRegenerationTitle("");
        setGeneration({
            scope: "entry",
            sourceId: props.entries[0]?.id ?? "",
            templateId: "auto",
            includeEntryEvidence: false,
            record: null,
        });
    }

    function openRegeneration(record: ArchiveRecord): void {
        const sessionId = field(record, "session_id");
        const entryId = field(record, "entry_id");
        const scope = sessionId ? "session" : "entry";
        const sourceId = sessionId || entryId;
        const savedTemplateId = field(record, "template_id", "auto");
        const recordDraft = guideDraftFromRecord(record);
        const entryNoteIds = new Set(
            props.sourceRecords
                .filter(
                    (source) =>
                        source.type === RecordType.settings &&
                        field(source, "record_role") === "journal-notes" &&
                        field(source, "entry_id").toLowerCase() === entryId.toLowerCase() &&
                        field(source, "session_id").toLowerCase() !== sessionId.toLowerCase(),
                )
                .map((source) => source.id.toLowerCase()),
        );
        const includesEntryNotes = recordDraft.sections.some((section) =>
            section.blocks.some((block) =>
                block.sourceIds
                    .split(/[\s,;]+/u)
                    .some((sourceId) => entryNoteIds.has(sourceId.toLowerCase())),
            ),
        );
        setGenerationError("");
        setRegenerationTitle(field(record, "title"));
        setGeneration({
            scope,
            sourceId,
            templateId: allTemplates().some((template) => template.id === savedTemplateId)
                ? savedTemplateId
                : "auto",
            includeEntryEvidence: includesEntryNotes,
            record,
        });
    }

    async function duplicateGuide(record: ArchiveRecord): Promise<void> {
        setGuideNotice("");
        try {
            const saved = await props.onSave(
                duplicateGuideDraft(guideDraftFromRecord(record)),
                null,
            );
            setGuideNotice(
                saved
                    ? `Created a draft copy of “${field(record, "title", "Study guide")}”.`
                    : "The guide copy was not saved. Review the workspace notice and try again.",
            );
        } catch (cause) {
            setGuideNotice(
                cause instanceof Error ? cause.message : "The guide could not be copied.",
            );
        }
    }

    function exportGuideRecord(
        record: ArchiveRecord,
        format: "markdown" | "html" | "json" | "docx" | "pdf",
    ): void {
        setGuideNotice("");
        try {
            const sessionId = field(record, "session_id");
            const entryId = field(record, "entry_id");
            const session = props.sessions.find((item) => item.id === sessionId);
            const entry = props.entries.find((item) => item.id === entryId);
            if (!session && !entry) {
                throw new Error(
                    "Restore the source journal entry or session before exporting this guide.",
                );
            }
            validateGuideForExport(record, {
                ...(session ? { session } : {}),
                ...(entry ? { entry } : {}),
                records: props.sourceRecords,
            });
            props.onExport(record, format);
        } catch (cause) {
            setGuideNotice(
                cause instanceof Error ? cause.message : "The study guide could not be exported.",
            );
        }
    }

    function generateSelectedGuide(event: SubmitEvent): void {
        event.preventDefault();
        const selection = generation();
        if (!selection) return;
        try {
            let draft: GuideDraft;
            if (selection.scope === "entry") {
                const entry = props.entries.find((item) => item.id === selection.sourceId);
                if (!entry)
                    throw new Error(
                        "Choose a journal entry that is still available in this archive.",
                    );
                draft = generateGuideDraftFromEntry(
                    entry,
                    selection.templateId,
                    props.sourceRecords,
                    props.students,
                    allTemplates(),
                );
            } else {
                const session = props.sessions.find((item) => item.id === selection.sourceId);
                if (!session)
                    throw new Error("Choose a session that is still available in this archive.");
                draft = generateGuideDraftFromSession(
                    session,
                    selection.templateId,
                    props.sourceRecords,
                    props.students,
                    allTemplates(),
                    selection.includeEntryEvidence,
                );
            }
            if (selection.record) draft.title = regenerationTitle() || draft.title;
            setEditor({
                record: guideRegenerationTarget(selection.record),
                templateId: draft.templateId,
                initialDraft: draft,
            });
            setGeneration(null);
        } catch (cause) {
            setGenerationError(
                cause instanceof Error
                    ? cause.message
                    : "A guide could not be generated from this source.",
            );
        }
    }

    async function importTemplate(event: Event): Promise<void> {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        input.value = "";
        if (!file) return;
        try {
            if (file.size > 1024 * 1024) throw new Error("Template file exceeds the 1 MiB limit.");
            const template = parseGuideTemplateImport(await file.text(), file.name);
            const saved = await props.onSaveTemplate(template, null);
            setTemplateNotice(
                saved ? `Imported “${template.name}”.` : "Template import was not saved.",
            );
        } catch (cause) {
            setTemplateNotice(
                cause instanceof Error ? cause.message : "Template could not be imported.",
            );
        }
    }

    async function duplicateTemplate(record: ArchiveRecord): Promise<void> {
        const template = guideTemplateFromRecord(record);
        try {
            const saved = await props.onSaveTemplate(
                {
                    name: `${template.name.slice(0, 233).trimEnd()} (copy)`,
                    subject: template.subject,
                    description: template.description,
                    sections: template.sections,
                    body: template.body,
                },
                null,
            );
            setTemplateNotice(
                saved ? `Created a copy of “${template.name}”.` : "Template copy was not saved.",
            );
        } catch (cause) {
            setTemplateNotice(
                cause instanceof Error ? cause.message : "Template could not be copied.",
            );
        }
    }

    return (
        <div class={cn("page-body guides-page", pageBody)}>
            <section class="record-heading guides-heading mt-[5px] mb-[-3px] flex items-end justify-between gap-5 rounded-[10px]">
                <div>
                    <span class="eyebrow text-xs font-medium tracking-wide text-accent">
                        Structure that leaves room
                    </span>
                    <h1 class={cn(heading1, "mt-1 mb-[7px] text-balance")}>Study guides</h1>
                    <p class="max-w-[66ch] text-sm leading-relaxed text-muted">
                        Turn session notes into clear, reusable learning material, with its sources
                        kept close.
                    </p>
                </div>
            </section>

            <Show when={generation()} keyed>
                {(selection) => (
                    <div
                        class={
                            "dialog-backdrop guide-editor-backdrop fixed inset-0 z-30 grid items-stretch justify-items-center bg-[rgb(10_16_12_/_43%)] p-[22px] [animation:fade-in_0.14s_ease-out] max-[680px]:p-0"
                        }
                        onClick={(event) => {
                            if (event.target === event.currentTarget && !props.busy)
                                setGeneration(null);
                        }}
                    >
                        <GuideDialog
                            class={
                                "guide-generation-dialog max-h-full w-[min(620px,100%)] overflow-auto rounded-[5px] border border-line bg-surface shadow-none max-[680px]:max-h-[100dvh] max-[680px]:w-full max-[680px]:self-center"
                            }
                            labelledBy="guide-generation-title"
                            onEscape={() => setGeneration(null)}
                            canEscape={() => !props.busy}
                        >
                            <header
                                class={
                                    "guide-editor-header flex justify-between gap-[18px] border-b border-[var(--line-soft)] bg-surface px-[25px] pb-[18px] pt-[22px] max-[680px]:px-4"
                                }
                            >
                                <div>
                                    <span class={eyebrowText}>
                                        A draft grounded in your archive
                                    </span>
                                    <h2
                                        id="guide-generation-title"
                                        class="mt-[5px] mb-[5px] text-[23px] font-semibold tracking-[-0.04em] text-ink"
                                    >
                                        {selection.record
                                            ? "Regenerate a study guide"
                                            : "Generate a study guide"}
                                    </h2>
                                    <p class="m-0 text-xs text-muted">
                                        Choose a source and structure. The result opens as an
                                        editable draft for tutor review before it is saved.
                                    </p>
                                </div>
                                <button
                                    class={trashIconButton}
                                    type="button"
                                    aria-label="Close guide generation"
                                    disabled={props.busy}
                                    onClick={() => setGeneration(null)}
                                >
                                    ×
                                </button>
                            </header>
                            <form onSubmit={generateSelectedGuide}>
                                <div class="guide-generation-fields grid gap-[13px] px-[25px] pb-2 pt-[18px] max-[680px]:px-4">
                                    <label class={fieldLabel}>
                                        <span>Source type</span>
                                        <select
                                            value={selection.scope}
                                            disabled={Boolean(selection.record)}
                                            onChange={(event) =>
                                                setGeneration((current) => {
                                                    if (!current) return current;
                                                    const scope = event.currentTarget.value as
                                                        | "session"
                                                        | "entry";
                                                    return {
                                                        ...current,
                                                        scope,
                                                        sourceId:
                                                            scope === "session"
                                                                ? (props.sessions[0]?.id ?? "")
                                                                : (props.entries[0]?.id ?? ""),
                                                        includeEntryEvidence: false,
                                                    };
                                                })
                                            }
                                            class={cn(
                                                textInput,
                                                "min-h-[38px] cursor-pointer pr-8",
                                            )}
                                        >
                                            <option
                                                value="session"
                                                disabled={!props.sessions.length}
                                            >
                                                Session
                                            </option>
                                            <option value="entry" disabled={!props.entries.length}>
                                                Journal entry
                                            </option>
                                        </select>
                                    </label>
                                    <label class={fieldLabel}>
                                        <span>
                                            {selection.scope === "session"
                                                ? "Session"
                                                : "Journal entry"}
                                        </span>
                                        <select
                                            required
                                            value={selection.sourceId}
                                            disabled={Boolean(selection.record)}
                                            onChange={(event) =>
                                                setGeneration((current) =>
                                                    current
                                                        ? {
                                                              ...current,
                                                              sourceId: event.currentTarget.value,
                                                          }
                                                        : current,
                                                )
                                            }
                                            class={cn(
                                                textInput,
                                                "min-h-[38px] cursor-pointer pr-8",
                                            )}
                                        >
                                            <Show when={selection.scope === "session"}>
                                                <For each={props.sessions}>
                                                    {(session) => (
                                                        <option value={session.id}>
                                                            {field(
                                                                session,
                                                                "title",
                                                                "Tutoring Session",
                                                            )}
                                                            {field(session, "subject")
                                                                ? ` · ${field(session, "subject")}`
                                                                : ""}
                                                        </option>
                                                    )}
                                                </For>
                                            </Show>
                                            <Show when={selection.scope === "entry"}>
                                                <For each={props.entries}>
                                                    {(entry) => (
                                                        <option value={entry.id}>
                                                            {field(entry, "title", "Journal entry")}
                                                        </option>
                                                    )}
                                                </For>
                                            </Show>
                                        </select>
                                    </label>
                                    <label class={fieldLabel}>
                                        <span>Structure</span>
                                        <select
                                            value={selection.templateId}
                                            onChange={(event) =>
                                                setGeneration((current) =>
                                                    current
                                                        ? {
                                                              ...current,
                                                              templateId: event.currentTarget.value,
                                                          }
                                                        : current,
                                                )
                                            }
                                            class={cn(
                                                textInput,
                                                "min-h-[38px] cursor-pointer pr-8",
                                            )}
                                        >
                                            <option value="auto">
                                                Automatic · use the source subject
                                            </option>
                                            <For each={allTemplates()}>
                                                {(template) => (
                                                    <option value={template.id}>
                                                        {template.name}
                                                    </option>
                                                )}
                                            </For>
                                        </select>
                                    </label>
                                </div>
                                <Show when={selection.record}>
                                    <label
                                        class={cn(
                                            fieldLabel,
                                            "guide-regeneration-title mx-[25px] mt-1 gap-[6px] max-[680px]:mx-4",
                                        )}
                                    >
                                        <span>Guide title</span>
                                        <input
                                            required
                                            maxlength="240"
                                            value={regenerationTitle()}
                                            onInput={(event) =>
                                                setRegenerationTitle(event.currentTarget.value)
                                            }
                                            class={cn(textInput, "min-h-[38px]")}
                                        />
                                    </label>
                                </Show>
                                <Show when={selection.scope === "session"}>
                                    <label class="guide-generation-entry-evidence mx-[25px] mt-2.5 flex cursor-pointer items-start gap-[9px] rounded-[5px] border border-line px-3 py-[11px] text-xs leading-normal text-ink max-[680px]:mx-4">
                                        <input
                                            type="checkbox"
                                            checked={selection.includeEntryEvidence}
                                            onChange={(event) =>
                                                setGeneration((current) =>
                                                    current
                                                        ? {
                                                              ...current,
                                                              includeEntryEvidence:
                                                                  event.currentTarget.checked,
                                                          }
                                                        : current,
                                                )
                                            }
                                            class="mt-0.5 h-3.5 w-3.5 flex-none accent-accent"
                                        />
                                        <span class="grid gap-[3px]">
                                            Include notes from the linked journal entry
                                            <small class="text-xs text-muted">
                                                Bring in reflection notes saved with this entry and
                                                its sessions.
                                            </small>
                                        </span>
                                    </label>
                                </Show>
                                <p
                                    class={
                                        "guide-generation-note mx-[25px] mt-2 border-l-2 border-accent bg-[var(--surface-inset)] px-3 py-2.5 text-xs leading-[1.6] text-muted max-[680px]:mx-4"
                                    }
                                >
                                    {selection.scope === "entry"
                                        ? "Gather linked sessions and the entry’s own notes into one cited guide. Transcript excerpts stay marked for review; transcript-derived claims appear only after a tutor verifies them."
                                        : "Tutor observations and notes are included with citations. Transcript excerpts stay marked for review; transcript-derived claims appear only after a tutor verifies them."}
                                    <Show when={selection.record}>
                                        <br /> Saving this regenerated draft{" "}
                                        {field(selection.record!, "approval_state") === "approved"
                                            ? "creates a new draft and leaves the approved guide unchanged."
                                            : "creates a new revision and keeps the previous guide in history."}
                                    </Show>
                                </p>
                                <Show when={generationError()}>
                                    <p
                                        class="guide-editor-error mx-[25px] mb-3 text-xs text-danger max-[680px]:ml-4"
                                        role="alert"
                                    >
                                        {generationError()}
                                    </p>
                                </Show>
                                <footer class="guide-generation-footer flex justify-end gap-2 px-[25px] pb-5 pt-4 max-[680px]:px-4">
                                    <button
                                        class={denseQuiet}
                                        type="button"
                                        disabled={props.busy}
                                        onClick={() => setGeneration(null)}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        class={densePrimary}
                                        type="submit"
                                        disabled={
                                            props.disabled || props.busy || !selection.sourceId
                                        }
                                    >
                                        Generate draft
                                    </button>
                                </footer>
                            </form>
                        </GuideDialog>
                    </div>
                )}
            </Show>

            <section
                class="guide-template-section grid gap-3"
                aria-labelledby="guide-templates-title"
            >
                <div class="guide-section-heading flex items-end justify-between gap-4">
                    <div>
                        <span class={eyebrowText}>A thoughtful place to start</span>
                        <h2
                            id="guide-templates-title"
                            class="mt-1 mb-0 text-[19px] font-semibold tracking-[-0.035em] text-ink"
                        >
                            Choose a structure
                        </h2>
                    </div>
                    <div class="guide-template-heading-actions flex items-center justify-end gap-[7px] max-[680px]:flex-col max-[680px]:items-start">
                        <span class="text-xs text-muted">{allTemplates().length} structures</span>
                        <button
                            class={densePrimary}
                            type="button"
                            disabled={!canCreate() || props.busy}
                            onClick={openGeneration}
                        >
                            Generate from a session
                        </button>
                        <button
                            class={denseOutline}
                            type="button"
                            disabled={!canCreateEntry() || props.busy}
                            onClick={openEntryGeneration}
                        >
                            Generate from a journal entry
                        </button>
                        <button
                            class={denseQuiet}
                            type="button"
                            aria-expanded={props.templateManagerOpen}
                            onClick={() => {
                                props.onToggleTemplateManager();
                                setTemplateNotice("");
                            }}
                        >
                            {props.templateManagerOpen ? "Close manager" : "Manage templates"}
                        </button>
                    </div>
                </div>
                <div
                    class={
                        "guide-template-browser flex items-center justify-between gap-3.5 rounded-[5px] border border-line bg-[var(--surface-inset)] px-2.5 py-2 max-[980px]:flex-col max-[980px]:items-stretch"
                    }
                    aria-label="Browse guide structures"
                >
                    <div
                        class="guide-template-search flex min-w-[180px] max-w-[420px] flex-[1_1_280px] items-center gap-2 text-muted focus-within:text-accent max-[980px]:max-w-none"
                        role="search"
                    >
                        <span
                            aria-hidden="true"
                            class="guide-template-search-icon flex-none text-[20px] leading-none"
                        >
                            ⌕
                        </span>
                        <input
                            type="search"
                            aria-label="Search guide templates"
                            placeholder="Search by name, subject, or section"
                            value={templateSearch()}
                            onInput={(event) => setTemplateSearch(event.currentTarget.value)}
                            class="min-w-0 flex-auto border-0 bg-transparent px-0 py-1.5 text-xs text-ink outline-none placeholder:text-faint"
                        />
                        <Show when={templateSearch()}>
                            <button
                                type="button"
                                class="guide-template-search-clear h-[25px] w-[25px] flex-none cursor-pointer rounded-[5px] border-0 bg-transparent text-[16px] text-muted hover:bg-surface hover:text-ink"
                                aria-label="Clear template search"
                                onClick={() => setTemplateSearch("")}
                            >
                                ×
                            </button>
                        </Show>
                    </div>
                    <div
                        class={
                            "guide-template-filters flex items-center gap-[3px] rounded-[5px] bg-[color-mix(in_srgb,var(--line)_28%,transparent)] p-[3px] max-[680px]:w-full"
                        }
                        role="group"
                        aria-label="Template type"
                    >
                        <For
                            each={
                                [
                                    { id: "all", label: `All · ${allTemplates().length}` },
                                    {
                                        id: "built-in",
                                        label: `Built in · ${GUIDE_TEMPLATES.length}`,
                                    },
                                    { id: "custom", label: `Custom · ${customTemplates().length}` },
                                ] as const
                            }
                        >
                            {(filter) => (
                                <button
                                    type="button"
                                    class={cn(
                                        "guide-template-filter min-h-[27px] cursor-pointer rounded-[5px] border-0 px-[9px] text-xs transition-colors max-[680px]:flex-[1_1_auto] max-[680px]:px-[5px]",
                                        templateKind() === filter.id
                                            ? "is-active bg-surface text-ink"
                                            : "text-muted hover:text-ink",
                                    )}
                                    aria-pressed={templateKind() === filter.id}
                                    onClick={() => setTemplateKind(filter.id)}
                                >
                                    {filter.label}
                                </button>
                            )}
                        </For>
                    </div>
                </div>
                <div class="guide-template-grid grid grid-cols-2 gap-x-[22px] gap-y-0 max-[680px]:grid-cols-1">
                    <Show
                        when={visibleTemplates().length > 0}
                        fallback={
                            <div
                                class={
                                    "guide-template-no-results col-span-full flex min-h-[100px] items-center gap-[13px] rounded-[5px] border border-dashed border-line bg-[var(--surface-inset)] p-[17px] text-muted max-[680px]:flex-wrap max-[680px]:items-start"
                                }
                            >
                                <span
                                    class="guide-template-no-results-mark text-[28px] text-accent"
                                    aria-hidden="true"
                                >
                                    ⌕
                                </span>
                                <div>
                                    <strong class="text-xs text-ink">
                                        {templateSearch()
                                            ? "No structures match that search"
                                            : "No templates in this view"}
                                    </strong>
                                    <p class="mt-[3px] text-xs">
                                        Try another word or switch the template type filter.
                                    </p>
                                </div>
                                <Show when={templateSearch()}>
                                    <button
                                        class={denseQuiet}
                                        type="button"
                                        onClick={() => setTemplateSearch("")}
                                    >
                                        Clear search
                                    </button>
                                </Show>
                            </div>
                        }
                    >
                        <For each={visibleTemplates()}>
                            {(template, index) => {
                                const isBuiltIn = () =>
                                    GUIDE_TEMPLATES.some((builtIn) => builtIn.id === template.id);
                                const override = () =>
                                    templateOverrides().find(
                                        (record) =>
                                            field(record, "builtin_template_id") === template.id,
                                    );
                                return (
                                    <article
                                        class={
                                            "guide-template-card grid min-w-0 grid-cols-[28px_minmax(0,1fr)] items-start gap-[11px] rounded-[5px] border-b border-[var(--line-soft)] bg-transparent px-0 py-3.5 transition-colors hover:bg-[var(--surface-inset)]"
                                        }
                                    >
                                        <span
                                            class={cn(
                                                "guide-template-number grid h-7 w-7 flex-none place-items-center rounded-[5px] text-xs font-bold tracking-[0.05em]",
                                                `guide-template-number-${index() % 5}`,
                                                index() % 5 === 1
                                                    ? "bg-[#f3eee1] text-[#705e3d]"
                                                    : index() % 5 === 2
                                                      ? "bg-[#e9eff4] text-[#4c6382]"
                                                      : index() % 5 === 3
                                                        ? "bg-[#eef0e6] text-[#5b6542]"
                                                        : index() % 5 === 4
                                                          ? "bg-[#f3ebea] text-[#735454]"
                                                          : "bg-[#eaf1e9] text-[#47604e]",
                                            )}
                                            aria-hidden="true"
                                        >
                                            {String(index() + 1).padStart(2, "0")}
                                        </span>
                                        <div class="guide-template-copy grid min-w-0 gap-1.5">
                                            <div class="guide-template-title-line flex min-w-0 items-start justify-between gap-2">
                                                <strong class="text-xs font-semibold text-ink">
                                                    {template.name}
                                                </strong>
                                                <span
                                                    class={cn(
                                                        "guide-template-kind flex-none rounded-[5px] border px-1.5 py-[3px] text-xs font-semibold leading-none",
                                                        isBuiltIn()
                                                            ? "is-built-in border-line bg-[var(--surface-inset)] text-muted"
                                                            : "is-custom border-[color-mix(in_srgb,var(--accent)_18%,var(--line))] bg-[color-mix(in_srgb,var(--accent)_7%,var(--surface))] text-accent",
                                                    )}
                                                >
                                                    {isBuiltIn() ? "Built in" : "Custom"}
                                                </span>
                                            </div>
                                            <small class="min-h-[29px] text-xs leading-[1.45] text-muted">
                                                {template.description ||
                                                    "A reusable structure for your next study guide."}
                                            </small>
                                            <span class="text-xs font-semibold text-accent">
                                                {template.subject || "General"}{" "}
                                                <span aria-hidden="true">·</span>{" "}
                                                {template.sections.length} sections
                                            </span>
                                            <div class="guide-template-card-actions mt-0.5 flex flex-wrap items-center gap-[3px]">
                                                <button
                                                    class={densePrimary}
                                                    type="button"
                                                    disabled={!canCreateGuide() || props.busy}
                                                    onClick={() =>
                                                        setEditor({
                                                            record: null,
                                                            templateId: template.id,
                                                        })
                                                    }
                                                >
                                                    Use structure
                                                </button>
                                                <button
                                                    class={denseQuiet}
                                                    type="button"
                                                    aria-expanded={
                                                        previewTemplateId() === template.id
                                                    }
                                                    aria-controls="guide-template-preview"
                                                    onClick={() =>
                                                        setPreviewTemplateId((current) =>
                                                            current === template.id
                                                                ? ""
                                                                : template.id,
                                                        )
                                                    }
                                                >
                                                    {previewTemplateId() === template.id
                                                        ? "Hide details"
                                                        : "Preview"}
                                                </button>
                                                <button
                                                    class={cn(
                                                        denseQuiet,
                                                        "guide-template-export-card",
                                                    )}
                                                    type="button"
                                                    disabled={props.busy}
                                                    onClick={() => props.onExportTemplate(template)}
                                                >
                                                    Export
                                                </button>
                                                <Show when={isBuiltIn()}>
                                                    <button
                                                        class={denseOutline}
                                                        type="button"
                                                        disabled={props.disabled || props.busy}
                                                        onClick={() => {
                                                            setTemplateNotice("");
                                                            setTemplateEditor({
                                                                current: override() ?? null,
                                                                builtinTemplate: template,
                                                            });
                                                        }}
                                                    >
                                                        {override() ? "Edit override" : "Customize"}
                                                    </button>
                                                </Show>
                                            </div>
                                        </div>
                                    </article>
                                );
                            }}
                        </For>
                    </Show>
                </div>
                <Show
                    when={allTemplates().find((template) => template.id === previewTemplateId())}
                    keyed
                >
                    {(template) => (
                        <section
                            class={
                                "guide-template-preview grid gap-4 rounded-[5px] border border-[color-mix(in_srgb,var(--accent)_23%,var(--line))] bg-[var(--surface-inset)] p-[18px] [animation:guide-manager-enter_180ms_ease-out_both]"
                            }
                            id="guide-template-preview"
                            aria-labelledby="guide-template-preview-title"
                        >
                            <div class="guide-template-preview-heading flex items-start justify-between gap-5 max-[680px]:flex-col">
                                <div>
                                    <span class={eyebrowText}>
                                        TEMPLATE PREVIEW · {template.subject || "GENERAL"}
                                    </span>
                                    <h3
                                        id="guide-template-preview-title"
                                        class="my-[5px] text-[19px] font-semibold tracking-[-0.035em] text-ink"
                                    >
                                        {template.name}
                                    </h3>
                                    <p class="m-0 max-w-[720px] whitespace-pre-wrap text-xs leading-[1.6] text-muted">
                                        {template.description ||
                                            "A reusable guide structure with your chosen editorial guidance."}
                                    </p>
                                </div>
                                <button
                                    class={densePrimary}
                                    type="button"
                                    disabled={!canCreateGuide() || props.busy}
                                    onClick={() =>
                                        setEditor({ record: null, templateId: template.id })
                                    }
                                >
                                    Start a guide
                                </button>
                            </div>
                            <div
                                class={
                                    "guide-template-preview-content grid grid-cols-[minmax(180px,0.65fr)_minmax(0,1.35fr)] gap-[25px] border-t border-line pt-3.5 max-[680px]:grid-cols-1 max-[680px]:gap-4"
                                }
                            >
                                <div>
                                    <span class="eyebrow text-xs font-medium tracking-wide text-faint">
                                        Ordered sections
                                    </span>
                                    <ol class="mt-2 grid gap-[5px] pl-[21px] text-xs leading-normal text-ink">
                                        <For each={template.sections}>
                                            {(section) => <li>{section}</li>}
                                        </For>
                                    </ol>
                                </div>
                                <Show when={template.body}>
                                    <div>
                                        <span class="eyebrow text-xs font-medium tracking-wide text-faint">
                                            Writing guidance
                                        </span>
                                        <p class="m-0 max-w-[720px] whitespace-pre-wrap text-xs leading-[1.6] text-muted">
                                            {template.body}
                                        </p>
                                    </div>
                                </Show>
                            </div>
                        </section>
                    )}
                </Show>
                <Show when={props.templateManagerOpen}>
                    <section
                        class={
                            "guide-template-manager grid gap-3 rounded-[5px] border border-line bg-[var(--surface-inset)] p-4 [animation:guide-manager-enter_180ms_ease-out_both]"
                        }
                        aria-labelledby="guide-template-manager-title"
                    >
                        <div class="guide-template-manager-heading flex items-center justify-between gap-3.5 max-[680px]:flex-col max-[680px]:items-start">
                            <div>
                                <span class={eyebrowText}>Your archive</span>
                                <h3
                                    id="guide-template-manager-title"
                                    class="mt-1 mb-0 text-base font-semibold tracking-[-0.025em] text-ink"
                                >
                                    Custom templates
                                </h3>
                            </div>
                            <div class="guide-template-manager-actions flex items-center justify-end gap-[7px] max-[680px]:w-full max-[680px]:justify-start">
                                <label
                                    class={cn(
                                        denseOutline,
                                        "guide-template-import relative cursor-pointer overflow-hidden",
                                    )}
                                >
                                    Import
                                    <input
                                        type="file"
                                        accept=".json,.md,.markdown,.txt,application/json,text/plain,text/markdown"
                                        aria-label="Import a study guide template JSON or Markdown file"
                                        onChange={(event) => void importTemplate(event)}
                                        disabled={props.disabled || props.busy}
                                        class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                                    />
                                </label>
                                <button
                                    class={densePrimary}
                                    type="button"
                                    disabled={props.disabled || props.busy}
                                    onClick={() => {
                                        setTemplateNotice("");
                                        setTemplateEditor({ current: null });
                                    }}
                                >
                                    Create template
                                </button>
                            </div>
                        </div>
                        <Show when={templateNotice()}>
                            <p
                                class="guide-template-notice m-0 text-xs leading-[1.55] text-accent"
                                role="status"
                            >
                                {templateNotice()}
                            </p>
                        </Show>
                        <Show
                            when={
                                props.customTemplates.length > 0 || templateOverrides().length > 0
                            }
                            fallback={
                                <p class="guide-template-empty m-0 text-xs leading-[1.55] text-muted">
                                    Your archive has no custom structures yet. Create one for a
                                    teaching approach you return to, or import a Tutorux template
                                    JSON, Markdown, or text file.
                                </p>
                            }
                        >
                            <div class="guide-template-manage-list grid border-t border-line">
                                <For each={visibleCustomTemplateRecords()}>
                                    {(record) => {
                                        const template = () => guideTemplateFromRecord(record);
                                        const deleteArmed = () =>
                                            armedTemplateDeleteId() === record.id;
                                        return (
                                            <article
                                                class={
                                                    "guide-template-manage-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-b border-[var(--line-soft)] py-[11px] max-[680px]:grid-cols-1"
                                                }
                                            >
                                                <div class="guide-template-manage-copy grid min-w-0 gap-[3px]">
                                                    <strong class="truncate text-xs font-semibold text-ink">
                                                        {field(record, "name", "Untitled template")}
                                                    </strong>
                                                    <span class="truncate text-xs text-muted">
                                                        {field(record, "subject", "General")} ·{" "}
                                                        {template().sections.length} sections
                                                    </span>
                                                    <small class="truncate text-xs text-faint">
                                                        {field(record, "description") ||
                                                            "No description"}
                                                    </small>
                                                </div>
                                                <div class="guide-template-manage-actions flex items-center justify-end gap-[7px] max-[680px]:flex-wrap max-[680px]:justify-start">
                                                    <button
                                                        class={denseQuiet}
                                                        type="button"
                                                        disabled={props.busy}
                                                        onClick={() =>
                                                            props.onExportTemplate(template())
                                                        }
                                                    >
                                                        Export
                                                    </button>
                                                    <button
                                                        class={denseQuiet}
                                                        type="button"
                                                        disabled={props.disabled || props.busy}
                                                        onClick={() =>
                                                            void duplicateTemplate(record)
                                                        }
                                                    >
                                                        Duplicate
                                                    </button>
                                                    <button
                                                        class={denseOutline}
                                                        type="button"
                                                        disabled={props.disabled || props.busy}
                                                        onClick={() => {
                                                            setTemplateNotice("");
                                                            setTemplateEditor({ current: record });
                                                        }}
                                                    >
                                                        Edit
                                                    </button>
                                                    <Show
                                                        when={deleteArmed()}
                                                        fallback={
                                                            <button
                                                                class={denseQuiet}
                                                                type="button"
                                                                disabled={
                                                                    props.disabled || props.busy
                                                                }
                                                                onClick={() =>
                                                                    setArmedTemplateDeleteId(
                                                                        record.id,
                                                                    )
                                                                }
                                                            >
                                                                Move to Trash
                                                            </button>
                                                        }
                                                    >
                                                        <button
                                                            class={denseDanger}
                                                            type="button"
                                                            disabled={props.disabled || props.busy}
                                                            onClick={() => {
                                                                props.onTrashTemplate(record);
                                                                setArmedTemplateDeleteId("");
                                                            }}
                                                        >
                                                            Confirm move
                                                        </button>
                                                        <button
                                                            class={denseQuiet}
                                                            type="button"
                                                            onClick={() =>
                                                                setArmedTemplateDeleteId("")
                                                            }
                                                        >
                                                            Cancel
                                                        </button>
                                                    </Show>
                                                </div>
                                            </article>
                                        );
                                    }}
                                </For>
                            </div>
                            <Show when={visibleCustomTemplateRecords().length === 0}>
                                <p class="guide-template-empty m-0 text-xs leading-[1.55] text-muted">
                                    No custom templates match this search. Clear the search to
                                    browse every saved template.
                                </p>
                            </Show>
                        </Show>
                        <Show when={templateOverrides().length > 0}>
                            <div class="guide-template-manage-list grid border-t border-line">
                                <span class={eyebrowText}>Built-in overrides</span>
                                <For each={templateOverrides()}>
                                    {(record) => {
                                        const builtin = () =>
                                            GUIDE_TEMPLATES.find(
                                                (template) =>
                                                    template.id ===
                                                    field(record, "builtin_template_id"),
                                            );
                                        const effective = () => {
                                            const template = builtin();
                                            return template
                                                ? (allTemplates().find(
                                                      (item) => item.id === template.id,
                                                  ) ?? template)
                                                : guideTemplateFromRecord(record);
                                        };
                                        return (
                                            <article
                                                class={
                                                    "guide-template-manage-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-b border-[var(--line-soft)] py-[11px] max-[680px]:grid-cols-1"
                                                }
                                            >
                                                <div class="guide-template-manage-copy grid min-w-0 gap-[3px]">
                                                    <strong class="truncate text-xs font-semibold text-ink">
                                                        {effective().name}
                                                    </strong>
                                                    <span class="truncate text-xs text-muted">
                                                        Built-in override ·{" "}
                                                        {effective().sections.length} sections
                                                    </span>
                                                    <small class="truncate text-xs text-faint">
                                                        {effective().description ||
                                                            "No description"}
                                                    </small>
                                                </div>
                                                <div class="guide-template-manage-actions flex items-center justify-end gap-[7px] max-[680px]:flex-wrap max-[680px]:justify-start">
                                                    <button
                                                        class={denseQuiet}
                                                        type="button"
                                                        disabled={props.busy}
                                                        onClick={() =>
                                                            props.onExportTemplate(effective())
                                                        }
                                                    >
                                                        Export
                                                    </button>
                                                    <button
                                                        class={denseOutline}
                                                        type="button"
                                                        disabled={props.disabled || props.busy}
                                                        onClick={() => {
                                                            setTemplateNotice("");
                                                            setTemplateEditor({
                                                                current: record,
                                                                ...(builtin()
                                                                    ? {
                                                                          builtinTemplate:
                                                                              builtin()!,
                                                                      }
                                                                    : {}),
                                                            });
                                                        }}
                                                    >
                                                        Edit override
                                                    </button>
                                                    <button
                                                        class={denseQuiet}
                                                        type="button"
                                                        disabled={props.disabled || props.busy}
                                                        onClick={() => {
                                                            props.onTrashTemplate(record);
                                                            setTemplateNotice(
                                                                "Built-in template restored to its defaults.",
                                                            );
                                                        }}
                                                    >
                                                        Restore defaults
                                                    </button>
                                                </div>
                                            </article>
                                        );
                                    }}
                                </For>
                            </div>
                        </Show>
                        <Show when={props.trashedTemplates.length > 0}>
                            <div class="guide-template-trash-list grid gap-1 border-t border-line pt-2.5">
                                <span class={eyebrowText}>In trash</span>
                                <For each={props.trashedTemplates}>
                                    {(record) => (
                                        <div class="guide-template-trash-row flex items-center justify-between gap-3 text-xs text-muted">
                                            <span>
                                                {field(record, "name", "Untitled template")}
                                            </span>
                                            <button
                                                class={denseQuiet}
                                                type="button"
                                                disabled={props.disabled || props.busy}
                                                onClick={() => props.onRestoreTemplate(record)}
                                            >
                                                Restore
                                            </button>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </section>
                </Show>
                <Show when={!props.sessions.length && !props.entries.length}>
                    <p class="guide-inline-note m-0 flex items-center gap-[5px] text-xs text-muted">
                        Add a session or journal entry first. Each guide stays connected to the
                        learning it came from.
                        <button
                            type="button"
                            class={denseQuiet}
                            onClick={() => props.onOpenSessions()}
                        >
                            Open sessions
                        </button>
                    </p>
                </Show>
            </section>

            <section class="record-list-shell guide-list-shell overflow-hidden rounded-[5px]">
                <div class="record-list-toolbar flex min-h-[43px] items-center justify-between border-b border-line px-0.5 text-[13px] text-muted max-[650px]:px-[11px]">
                    <span>
                        <strong class="text-[13px] font-semibold text-ink-soft">
                            {props.records.length}
                        </strong>{" "}
                        saved guides
                    </span>
                    <span class="list-view-label inline-flex items-center gap-[5px]">
                        Drafts remain yours to shape
                    </span>
                </div>
                <Show when={guideNotice()}>
                    <p
                        class="guide-action-notice my-2 text-xs leading-[1.55] text-accent"
                        role="status"
                        aria-live="polite"
                    >
                        {guideNotice()}
                    </p>
                </Show>
                <Show
                    when={props.records.length > 0}
                    fallback={
                        <div class="guide-empty-state mx-auto max-w-[430px] px-[22px] pb-12 pt-[42px] text-center">
                            <div
                                class={
                                    "guide-empty-mark mx-auto mb-3.5 grid h-14 w-[47px] place-items-center rounded-[5px] border border-[color-mix(in_srgb,var(--accent)_24%,var(--line))] bg-accent-soft text-[21px] text-accent"
                                }
                                aria-hidden="true"
                            >
                                G
                            </div>
                            <h2 class="m-0 mb-[7px] text-[19px] font-semibold text-ink">
                                Your guide shelf is ready
                            </h2>
                            <p class="m-0 text-xs leading-[1.65] text-muted">
                                Start with a session or journal entry. You can refine every section
                                before sharing or approving it.
                            </p>
                        </div>
                    }
                >
                    <div class="guide-record-list grid">
                        <For
                            each={[...props.records].sort((a, b) =>
                                field(b, "updated_at_us").localeCompare(field(a, "updated_at_us")),
                            )}
                        >
                            {(record) => {
                                const session = () =>
                                    props.sessions.find(
                                        (item) => item.id === field(record, "session_id"),
                                    );
                                const entry = () =>
                                    props.entries.find(
                                        (item) => item.id === field(record, "entry_id"),
                                    );
                                const template = () =>
                                    GUIDE_TEMPLATES.find(
                                        (item) => item.id === field(record, "template_id"),
                                    )?.name ?? "Custom";
                                const staleBlocks = () =>
                                    Math.max(
                                        0,
                                        Number.parseInt(
                                            field(record, "stale_block_count", "0"),
                                            10,
                                        ) || 0,
                                    );
                                const sections = () =>
                                    Math.max(
                                        0,
                                        Number.parseInt(field(record, "section_count", "0"), 10) ||
                                            0,
                                    );
                                const canEdit = () =>
                                    Boolean(
                                        (field(record, "session_id") ? session() : entry()) &&
                                        !props.disabled,
                                    );
                                return (
                                    <article
                                        class={
                                            "guide-record-card grid grid-cols-[39px_minmax(0,1fr)_auto] items-center gap-3.5 border-t border-[var(--line-soft)] px-5 py-[17px] max-[980px]:grid-cols-[39px_minmax(0,1fr)] max-[680px]:gap-2.5 max-[680px]:p-3.5"
                                        }
                                    >
                                        <div
                                            class={
                                                "guide-record-marker grid h-[43px] w-[37px] place-items-center rounded-[5px] border border-[color-mix(in_srgb,var(--accent)_17%,var(--line))] bg-accent-soft text-[17px] text-accent"
                                            }
                                            aria-hidden="true"
                                        >
                                            <span>✳</span>
                                        </div>
                                        <div class="guide-record-main min-w-0">
                                            <div class="guide-record-title-row flex items-center gap-[9px]">
                                                <span class={eyebrowText}>
                                                    {template().toUpperCase()} GUIDE
                                                </span>
                                                <span
                                                    class={cn(
                                                        "guide-status rounded-[5px] border px-[7px] py-[3px] text-xs font-bold tracking-[0.04em]",
                                                        `status-${field(record, "approval_state", "draft")}`,
                                                        field(record, "approval_state", "draft") ===
                                                            "approved"
                                                            ? "border-accent/25 bg-accent-soft text-accent"
                                                            : "border-line bg-[var(--surface-inset)] text-muted",
                                                    )}
                                                >
                                                    {field(record, "approval_state", "draft")}
                                                </span>
                                            </div>
                                            <h2 class="mb-[3px] mt-[5px] truncate text-base font-semibold tracking-[-0.025em] text-ink">
                                                {field(record, "title", "Untitled guide")}
                                            </h2>
                                            <p class="m-0 truncate text-xs text-muted">
                                                {session()
                                                    ? field(session()!, "title", "Tutoring session")
                                                    : entry()
                                                      ? field(entry()!, "title", "Journal entry")
                                                      : "Guide source unavailable"}
                                                {session() && field(session()!, "subject")
                                                    ? ` · ${field(session()!, "subject")}`
                                                    : ""}
                                            </p>
                                            <div class="guide-record-meta mt-2 flex flex-wrap gap-x-[13px] gap-y-1.5 text-xs text-faint">
                                                <span>{sections()} sections</span>
                                                <span>
                                                    {timestampLabel(field(record, "updated_at_us"))}
                                                </span>
                                                <Show when={staleBlocks() > 0}>
                                                    <span class="guide-stale-count text-[#9a6034]">
                                                        {staleBlocks()} source-changed block
                                                        {staleBlocks() === 1 ? "" : "s"}
                                                    </span>
                                                </Show>
                                            </div>
                                            <GuideVersionHistory
                                                guide={record}
                                                snapshot={props.snapshot}
                                                disabled={props.disabled || props.busy}
                                                onRestore={props.onRestoreVersion}
                                            />
                                        </div>
                                        <div class="guide-record-actions flex flex-wrap items-center gap-1 max-[980px]:col-start-2 max-[980px]:justify-start">
                                            <button
                                                class={denseOutline}
                                                type="button"
                                                disabled={!canEdit()}
                                                onClick={() =>
                                                    setEditor({
                                                        record,
                                                        templateId: field(
                                                            record,
                                                            "template_id",
                                                            "general",
                                                        ),
                                                    })
                                                }
                                            >
                                                Edit
                                            </button>
                                            <button
                                                class={denseQuiet}
                                                type="button"
                                                disabled={!canEdit() || props.busy}
                                                onClick={() => void duplicateGuide(record)}
                                            >
                                                Duplicate
                                            </button>
                                            <Show
                                                when={
                                                    field(record, "approval_state", "draft") !==
                                                    "approved"
                                                }
                                            >
                                                <button
                                                    class={denseQuiet}
                                                    type="button"
                                                    disabled={
                                                        !canEdit() ||
                                                        staleBlocks() > 0 ||
                                                        props.busy
                                                    }
                                                    onClick={() => props.onApprove(record)}
                                                >
                                                    Approve
                                                </button>
                                            </Show>
                                            <button
                                                class={denseQuiet}
                                                type="button"
                                                disabled={props.busy}
                                                onClick={() =>
                                                    exportGuideRecord(record, "markdown")
                                                }
                                            >
                                                Markdown
                                            </button>
                                            <button
                                                class={denseQuiet}
                                                type="button"
                                                disabled={props.busy}
                                                onClick={() => exportGuideRecord(record, "html")}
                                            >
                                                HTML
                                            </button>
                                            <details
                                                class={
                                                    "guide-export-menu relative [&[open]]:flex [&[open]]:flex-[1_1_100%] [&[open]]:flex-wrap [&[open]]:items-center [&[open]]:gap-[5px] [&[open]]:rounded-[5px] [&[open]]:border [&[open]]:border-line [&[open]]:bg-[var(--surface-inset)] [&[open]]:px-[7px] [&[open]]:py-[5px]"
                                                }
                                            >
                                                <summary
                                                    class={cn(
                                                        denseQuiet,
                                                        "list-none [&::-webkit-details-marker]:hidden",
                                                    )}
                                                >
                                                    More
                                                </summary>
                                                <div
                                                    class="guide-export-menu-popover flex flex-wrap gap-1"
                                                    aria-label="More guide exports"
                                                >
                                                    <button
                                                        class={denseQuiet}
                                                        type="button"
                                                        disabled={!canEdit() || props.busy}
                                                        onClick={() => openRegeneration(record)}
                                                    >
                                                        Regenerate from latest evidence
                                                    </button>
                                                    <button
                                                        class={denseQuiet}
                                                        type="button"
                                                        disabled={props.busy}
                                                        onClick={() =>
                                                            exportGuideRecord(record, "json")
                                                        }
                                                    >
                                                        JSON record
                                                    </button>
                                                    <button
                                                        class={denseQuiet}
                                                        type="button"
                                                        disabled={props.busy}
                                                        onClick={() =>
                                                            exportGuideRecord(record, "docx")
                                                        }
                                                    >
                                                        Word document
                                                    </button>
                                                    <button
                                                        class={denseQuiet}
                                                        type="button"
                                                        disabled={props.busy}
                                                        onClick={() =>
                                                            exportGuideRecord(record, "pdf")
                                                        }
                                                    >
                                                        PDF / Print
                                                    </button>
                                                </div>
                                            </details>
                                            <button
                                                class={trashIconButton}
                                                type="button"
                                                title="Move guide to Trash"
                                                aria-label={`Move ${field(record, "title", "guide")} to Trash`}
                                                disabled={props.disabled || props.busy}
                                                onClick={() => props.onTrash(record)}
                                            >
                                                ×
                                            </button>
                                        </div>
                                    </article>
                                );
                            }}
                        </For>
                    </div>
                </Show>
            </section>

            <Show when={editor()} keyed>
                {(active) => (
                    <GuideEditor
                        record={active.record}
                        templateId={active.templateId}
                        initialDraft={active.initialDraft}
                        sessions={props.sessions}
                        entries={props.entries}
                        students={props.students}
                        sourceRecords={props.sourceRecords}
                        templates={allTemplates()}
                        disabled={props.disabled}
                        busy={props.busy}
                        onClose={() => setEditor(null)}
                        onSave={props.onSave}
                    />
                )}
            </Show>
            <Show when={templateEditor()} keyed>
                {(active) => (
                    <GuideTemplateEditor
                        current={active.current}
                        {...(active.builtinTemplate
                            ? { builtinTemplate: active.builtinTemplate }
                            : {})}
                        busy={props.busy}
                        disabled={props.disabled}
                        onClose={() => setTemplateEditor(null)}
                        onSave={props.onSaveTemplate}
                    />
                )}
            </Show>
        </div>
    );
}

function GuideEditor(props: {
    record: ArchiveRecord | null;
    templateId: string;
    initialDraft?: GuideDraft | undefined;
    sessions: ArchiveRecord[];
    entries: ArchiveRecord[];
    students: ArchiveRecord[];
    sourceRecords: ArchiveRecord[];
    templates: GuideTemplate[];
    disabled: boolean;
    busy: boolean;
    onClose: () => void;
    onSave: (draft: GuideDraft, current: ArchiveRecord | null) => Promise<boolean>;
}): JSX.Element {
    // The editor is mounted with keyed Show for the selected record, so its initial draft is a snapshot.
    /* eslint-disable solid/reactivity */
    const initialDraft =
        props.initialDraft ??
        initialGuideDraft(props.record, props.sessions, props.templateId, props.templates);
    const [draft, setDraftState] = createSignal<GuideDraft>(initialDraft);
    /* eslint-enable solid/reactivity */
    const initialBlockSection = initialDraft.sections.find((section) => section.blocks.length > 0);
    const [activeBlock, setActiveBlock] = createSignal<{
        sectionId: string;
        blockIndex: number;
    } | null>(initialBlockSection ? { sectionId: initialBlockSection.id, blockIndex: 0 } : null);
    const [error, setError] = createSignal("");
    const [confirmDiscard, setConfirmDiscard] = createSignal(false);
    const [validationReport, setValidationReport] = createSignal<{
        valid: boolean;
        message: string;
    } | null>(null);
    const [undoStack, setUndoStack] = createSignal<GuideDraft[]>([]);
    const [redoStack, setRedoStack] = createSignal<GuideDraft[]>([]);
    const [findQuery, setFindQuery] = createSignal("");
    const [replaceText, setReplaceText] = createSignal("");
    const [activeMatch, setActiveMatch] = createSignal<GuideTextMatch | null>(null);
    const [findStatus, setFindStatus] = createSignal("");
    const [saveAsNewDraft, setSaveAsNewDraft] = createSignal(false);
    const findBlockPosition = createMemo(() => {
        const selected = activeBlock();
        if (!selected) return null;
        const sectionIndex = draft().sections.findIndex(
            (section) => section.id === selected.sectionId,
        );
        const blockIndex = selected.blockIndex;
        if (
            sectionIndex < 0 ||
            blockIndex < 0 ||
            blockIndex >= draft().sections[sectionIndex]!.blocks.length
        )
            return null;
        return { sectionIndex, blockIndex };
    });
    const findMatches = createMemo(() => {
        const selected = findBlockPosition();
        return selected ? findGuideTextMatches(draft(), findQuery(), selected) : [];
    });
    const blockTextareas = new Map<string, HTMLTextAreaElement>();
    let inlineEditStart: GuideDraft | null = null;
    const selectedSession = createMemo(() =>
        props.sessions.find((session) => session.id === draft().sessionId),
    );
    const selectedEntry = createMemo(() =>
        props.entries.find((entry) => entry.id === draft().entryId),
    );
    const imageAssets = createMemo(() => {
        const session = selectedSession();
        const entry = selectedEntry();
        if (!session && !entry) return [];
        const scope = session
            ? { session, records: props.sourceRecords }
            : { entry: entry!, records: props.sourceRecords };
        return props.sourceRecords.filter(
            (record) =>
                record.type === RecordType.assetMetadata &&
                field(record, "_deleted") !== "true" &&
                /^image\//u.test(field(record, "mime_type")) &&
                isGuideSourceInScope(record.id.toLowerCase(), scope),
        );
    });

    function setDraft(
        update: GuideDraft | ((current: GuideDraft) => GuideDraft),
        recordHistory = false,
    ): void {
        const current = draft();
        const next = typeof update === "function" ? update(current) : update;
        if (next === current) return;
        if (recordHistory) {
            setUndoStack((history) => [...history.slice(-99), current]);
            setRedoStack([]);
            inlineEditStart = null;
        }
        setValidationReport(null);
        setDraftState(next);
    }

    function handleEditorFocusIn(event: FocusEvent): void {
        const target = event.target;
        if (
            target instanceof HTMLElement &&
            target.closest(
                ".guide-editor-fields, .guide-editor-section-heading, .guide-block-editor",
            )
        ) {
            inlineEditStart = draft();
        }
    }

    function handleEditorFocusOut(event: FocusEvent): void {
        const target = event.target;
        if (
            inlineEditStart &&
            target instanceof HTMLElement &&
            target.closest(
                ".guide-editor-fields, .guide-editor-section-heading, .guide-block-editor",
            )
        ) {
            const before = inlineEditStart;
            inlineEditStart = null;
            if (draft() !== before) {
                setUndoStack((history) => [...history.slice(-99), before]);
                setRedoStack([]);
            }
        }
    }

    function undoGuideChange(): void {
        const previous = undoStack().at(-1);
        if (!previous) return;
        setUndoStack((history) => history.slice(0, -1));
        setRedoStack((history) => [...history.slice(-99), draft()]);
        setValidationReport(null);
        setDraftState(previous);
        clearFindSelection();
    }

    function redoGuideChange(): void {
        const next = redoStack().at(-1);
        if (!next) return;
        setRedoStack((history) => history.slice(0, -1));
        setUndoStack((history) => [...history.slice(-99), draft()]);
        setValidationReport(null);
        setDraftState(next);
        clearFindSelection();
    }

    function handleEditorKeyDown(event: KeyboardEvent): void {
        if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
        const target = event.target;
        if (
            target instanceof HTMLElement &&
            target.closest("input, textarea, select, [contenteditable='true']")
        ) {
            return;
        }
        const key = event.key.toLowerCase();
        if (key === "z") {
            event.preventDefault();
            if (event.shiftKey) redoGuideChange();
            else undoGuideChange();
        } else if (key === "y") {
            event.preventDefault();
            redoGuideChange();
        }
    }

    function validateSources(): void {
        const current = draft();
        const session = props.sessions.find((item) => item.id === current.sessionId);
        const entry = props.entries.find((item) => item.id === current.entryId);
        try {
            const checked = makeGuideRecord(
                current,
                {
                    ...(session ? { session } : {}),
                    ...(entry ? { entry } : {}),
                    records: props.sourceRecords,
                },
                props.record,
            );
            const sourceReferenceCount = [...checked.fields]
                .filter(([key]) => /^section\.\d+\.block\.\d+\.source_ids$/u.test(key))
                .reduce((count, [, value]) => count + value.split(",").filter(Boolean).length, 0);
            const staleBlockCount = current.sections.reduce(
                (count, section) => count + section.blocks.filter((block) => block.stale).length,
                0,
            );
            const staleNote = staleBlockCount
                ? ` ${staleBlockCount} source-changed ${staleBlockCount === 1 ? "block needs" : "blocks need"} review.`
                : "";
            const sourceSummary = sourceReferenceCount
                ? `${sourceReferenceCount.toLocaleString("en-US")} source ${sourceReferenceCount === 1 ? "reference resolves" : "references resolve"} within this guide’s scope.`
                : "No source references are attached.";
            setValidationReport({
                valid: true,
                message: `Validation passed. Guide structure is valid. ${sourceSummary}${staleNote}`,
            });
        } catch (cause) {
            setValidationReport({
                valid: false,
                message: `Validation failed: ${cause instanceof Error ? cause.message : "The guide sources could not be validated."}`,
            });
        }
    }

    function updateSection(
        index: number,
        update: (section: GuideDraft["sections"][number]) => GuideDraft["sections"][number],
        recordHistory = true,
    ): void {
        setDraft(
            (current) => ({
                ...current,
                sections: current.sections.map((section, i) =>
                    i === index ? update(section) : section,
                ),
            }),
            recordHistory,
        );
    }

    function updateBlock(
        sectionIndex: number,
        blockIndex: number,
        update: (block: GuideBlockDraft) => GuideBlockDraft,
        recordHistory = true,
    ): void {
        updateSection(
            sectionIndex,
            (section) => ({
                ...section,
                blocks: section.blocks.map((block, i) =>
                    i === blockIndex ? update(block) : block,
                ),
            }),
            recordHistory,
        );
    }

    function clearFindSelection(): void {
        setActiveMatch(null);
        setFindStatus("");
    }

    function moveSection(index: number, direction: -1 | 1): void {
        clearFindSelection();
        setDraft(
            (current) => ({
                ...current,
                sections: moveGuideSection(current.sections, index, direction),
            }),
            true,
        );
    }

    function addExampleAfter(sectionIndex: number, blockIndex: number): void {
        clearFindSelection();
        const sectionId = draft().sections[sectionIndex]?.id;
        if (sectionId) setActiveBlock({ sectionId, blockIndex });
        updateSection(
            sectionIndex,
            (section) => ({
                ...section,
                blocks: [
                    ...section.blocks.slice(0, blockIndex + 1),
                    {
                        kind: "example",
                        text: "",
                        sourceIds: "",
                        stale: false,
                        origin: "tutor-authored",
                    },
                    ...section.blocks.slice(blockIndex + 1),
                ],
            }),
            true,
        );
    }

    function regenerateSection(sectionIndex: number): void {
        setError("");
        const current = draft();
        try {
            const session = selectedSession();
            const entry = selectedEntry();
            let generated: GuideDraft;
            if (session) {
                generated = generateGuideDraftFromSession(
                    session,
                    current.templateId || "auto",
                    props.sourceRecords,
                    props.students,
                    props.templates,
                    draftIncludesEntryNotes(current, props.sourceRecords),
                );
            } else if (entry) {
                generated = generateGuideDraftFromEntry(
                    entry,
                    current.templateId || "auto",
                    props.sourceRecords,
                    props.students,
                    props.templates,
                );
            } else {
                throw new Error("Choose a session or journal entry before regenerating a section.");
            }
            setDraft(replaceGuideSectionFromGenerated(current, sectionIndex, generated), true);
            if (props.record && field(props.record, "approval_state") === "approved")
                setSaveAsNewDraft(true);
            clearFindSelection();
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : "The guide section could not be regenerated.",
            );
        }
    }

    function insertImage(sectionIndex: number, assetId: string): void {
        setError("");
        const asset = imageAssets().find((record) => record.id === assetId);
        if (!asset) return;
        try {
            setDraft((current) => insertGuideImageBlock(current, sectionIndex, asset), true);
            clearFindSelection();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The image could not be inserted.");
        }
    }

    function activateBlock(sectionId: string, blockIndex: number): void {
        const selected = activeBlock();
        if (selected?.sectionId !== sectionId || selected.blockIndex !== blockIndex) {
            setActiveMatch(null);
            setFindStatus("");
        }
        setActiveBlock({ sectionId, blockIndex });
    }

    function focusMatch(match: GuideTextMatch): void {
        const sectionId = draft().sections[match.sectionIndex]?.id;
        if (!sectionId) return;
        queueMicrotask(() => {
            const textarea = blockTextareas.get(`${sectionId}:${match.blockIndex}`);
            if (!textarea) return;
            textarea.focus();
            textarea.setSelectionRange(match.start, match.end);
        });
    }

    function findNext(): void {
        if (!findBlockPosition()) {
            setFindStatus("Focus a content block before searching.");
            return;
        }
        const matches = findMatches();
        if (!findQuery()) {
            setFindStatus("Enter text to find.");
            return;
        }
        if (!matches.length) {
            setActiveMatch(null);
            setFindStatus("No matches in the selected block.");
            return;
        }
        const current = activeMatch();
        const currentIndex = current
            ? matches.findIndex(
                  (match) =>
                      match.sectionIndex === current.sectionIndex &&
                      match.blockIndex === current.blockIndex &&
                      match.start === current.start,
              )
            : -1;
        const nextIndex = (currentIndex + 1) % matches.length;
        const match = matches[nextIndex]!;
        setActiveMatch(match);
        setFindStatus(`Match ${nextIndex + 1} of ${matches.length}.`);
        focusMatch(match);
    }

    function replaceCurrent(): void {
        if (!findBlockPosition()) {
            setFindStatus("Focus a content block before replacing text.");
            return;
        }
        const query = findQuery();
        if (!query) {
            setFindStatus("Enter text to find.");
            return;
        }
        if (query === replaceText()) {
            setFindStatus("The replacement is identical. Nothing changed.");
            return;
        }
        const matches = findMatches();
        const match = activeMatch() ?? matches[0];
        if (!match) {
            setFindStatus("No matches in the selected block.");
            return;
        }
        const updated = replaceGuideTextMatch(draft(), match, query, replaceText());
        if (updated === draft()) {
            setActiveMatch(null);
            setFindStatus("The selected match changed. Find next to choose another match.");
            return;
        }
        setDraft(updated, true);
        setActiveMatch(null);
        setFindStatus("Replaced one match.");
    }

    function replaceAll(): void {
        const selectedBlock = findBlockPosition();
        if (!selectedBlock) {
            setFindStatus("Focus a content block before replacing text.");
            return;
        }
        const query = findQuery();
        if (!query) {
            setActiveMatch(null);
            setFindStatus("Enter text to find.");
            return;
        }
        if (query === replaceText()) {
            setFindStatus("The replacement is identical. Nothing changed.");
            return;
        }
        const result = replaceAllGuideText(draft(), query, replaceText(), selectedBlock);
        setActiveMatch(null);
        setFindStatus(
            result.replacedCount
                ? `Replaced ${result.replacedCount.toLocaleString("en-US")} ${result.replacedCount === 1 ? "match" : "matches"}.`
                : findQuery()
                  ? "No matches to replace."
                  : "Enter text to find.",
        );
        if (result.replacedCount) setDraft(result.draft, true);
    }

    function selectTemplate(templateId: string): void {
        clearFindSelection();
        const templates = props.templates;
        setDraft(
            (current) => ({
                ...current,
                templateId,
                sections: current.sections.every((section) =>
                    section.blocks.every((block) => !block.text.trim()),
                )
                    ? templateSections(templateId, templates)
                    : current.sections,
            }),
            true,
        );
    }

    function requestClose(): void {
        if (props.busy) return;
        if (draft() !== initialDraft && !confirmDiscard()) {
            setConfirmDiscard(true);
            return;
        }
        props.onClose();
    }

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            const saved = await props.onSave(draft(), saveAsNewDraft() ? null : props.record);
            if (saved) props.onClose();
            else setError("Guide could not be saved. See the workspace notice for details.");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The guide could not be saved.");
        }
    }

    return (
        <div
            class={
                "dialog-backdrop guide-editor-backdrop fixed inset-0 z-30 grid items-stretch justify-items-center bg-[rgb(10_16_12_/_43%)] p-[22px] [animation:fade-in_0.14s_ease-out] max-[680px]:p-0"
            }
            onClick={(event) => {
                if (event.target === event.currentTarget) requestClose();
            }}
        >
            <GuideDialog
                class={
                    "guide-editor-dialog flex max-h-full w-[min(980px,100%)] flex-col overflow-hidden rounded-[5px] border border-line bg-surface shadow-none max-[680px]:h-full max-[680px]:max-h-[100dvh] max-[680px]:w-full"
                }
                labelledBy="guide-editor-title"
                onEscape={requestClose}
                canEscape={() => !props.busy}
            >
                <header
                    class={
                        "guide-editor-header flex justify-between gap-[18px] border-b border-[var(--line-soft)] bg-surface px-[25px] pb-[18px] pt-[22px] max-[680px]:px-4"
                    }
                >
                    <div>
                        <span class={eyebrowText}>A guide built from your work</span>
                        <h2
                            id="guide-editor-title"
                            class="mt-[5px] mb-[5px] text-[23px] font-semibold tracking-[-0.04em] text-ink"
                        >
                            {props.record
                                ? "Shape this study guide"
                                : props.initialDraft
                                  ? "Review a generated guide"
                                  : "Start a study guide"}
                        </h2>
                        <p class="m-0 text-xs text-muted">
                            Sections are a scaffold. Keep citations attached as you make the
                            material your own.
                        </p>
                    </div>
                    <button
                        class={formIconButton}
                        type="button"
                        aria-label="Close guide editor"
                        disabled={props.busy}
                        onClick={() => requestClose()}
                    >
                        ×
                    </button>
                </header>
                <form
                    class="guide-editor-form flex min-h-0 flex-col overflow-hidden"
                    onSubmit={(event) => void submit(event)}
                    onKeyDown={handleEditorKeyDown}
                    onFocusIn={handleEditorFocusIn}
                    onFocusOut={handleEditorFocusOut}
                >
                    <div
                        class={
                            "guide-editor-fields grid grid-cols-[minmax(220px,1.4fr)_minmax(230px,1.4fr)_minmax(160px,0.8fr)] gap-3 border-b border-[var(--line-soft)] bg-[var(--surface-inset)] px-[25px] py-4 max-[680px]:grid-cols-2 max-[680px]:px-4"
                        }
                    >
                        <label class="form-field guide-title-field grid min-w-0 gap-[5px] text-xs font-semibold text-muted max-[680px]:col-span-full">
                            Guide title
                            <input
                                value={draft().title}
                                maxlength="240"
                                required
                                onInput={(event) =>
                                    setDraft((current) => ({
                                        ...current,
                                        title: event.currentTarget.value,
                                    }))
                                }
                                class={cn(textInput, "min-h-[35px]")}
                            />
                        </label>
                        <Show when={draft().sessionId}>
                            <label class={fieldLabel}>
                                Session
                                <select
                                    required
                                    value={draft().sessionId}
                                    onChange={(event) => {
                                        const session = props.sessions.find(
                                            (item) => item.id === event.currentTarget.value,
                                        );
                                        setDraft(
                                            (current) => ({
                                                ...current,
                                                sessionId: event.currentTarget.value,
                                                entryId: session ? field(session, "entry_id") : "",
                                                title: props.record
                                                    ? current.title
                                                    : session
                                                      ? `${field(session, "title", "Tutoring Session")} — Study Guide`
                                                      : current.title,
                                            }),
                                            true,
                                        );
                                    }}
                                    class={cn(textInput, "min-h-[35px] cursor-pointer pr-8")}
                                >
                                    <option value="" disabled>
                                        Choose a session
                                    </option>
                                    <For each={props.sessions}>
                                        {(session) => {
                                            const student = props.students.find(
                                                (item) => item.id === field(session, "student_id"),
                                            );
                                            const label = [
                                                field(session, "title", "Tutoring session"),
                                                student
                                                    ? field(student, "display_name")
                                                    : "Independent",
                                                field(session, "subject"),
                                            ]
                                                .filter(Boolean)
                                                .join(" · ");
                                            return <option value={session.id}>{label}</option>;
                                        }}
                                    </For>
                                </select>
                            </label>
                        </Show>
                        <label class={fieldLabel}>
                            Structure
                            <select
                                value={draft().templateId}
                                onChange={(event) => selectTemplate(event.currentTarget.value)}
                                class={cn(textInput, "min-h-[35px] cursor-pointer pr-8")}
                            >
                                <Show
                                    when={
                                        !allTemplates(props.templates).some(
                                            (template) => template.id === draft().templateId,
                                        )
                                    }
                                >
                                    <option value={draft().templateId}>
                                        Saved template · {draft().templateId}
                                    </option>
                                </Show>
                                <For each={allTemplates(props.templates)}>
                                    {(template) => (
                                        <option value={template.id}>{template.name}</option>
                                    )}
                                </For>
                            </select>
                        </label>
                    </div>

                    <div
                        class={
                            "guide-find flex flex-wrap items-end gap-2 border-b border-[var(--line-soft)] px-[25px] py-3 max-[680px]:px-4"
                        }
                        role="search"
                        aria-label="Find and replace in selected guide block"
                    >
                        <label class="grid flex-[1_1_170px] gap-[5px] text-xs font-semibold text-muted">
                            Find
                            <input
                                value={findQuery()}
                                onInput={(event) => {
                                    setFindQuery(event.currentTarget.value);
                                    setActiveMatch(null);
                                    setFindStatus("");
                                }}
                                class={cn(textInput, "min-h-[35px]")}
                            />
                        </label>
                        <label class="grid flex-[1_1_170px] gap-[5px] text-xs font-semibold text-muted">
                            Replace with
                            <input
                                value={replaceText()}
                                onInput={(event) => setReplaceText(event.currentTarget.value)}
                                class={cn(textInput, "min-h-[35px]")}
                            />
                        </label>
                        <span
                            class="guide-find-status min-w-24 pb-2.5 text-xs text-muted"
                            aria-live="polite"
                        >
                            {findStatus() ||
                                (findBlockPosition()
                                    ? `${findMatches().length.toLocaleString("en-US")} ${findMatches().length === 1 ? "match" : "matches"} in selected block`
                                    : "Focus a content block to search its text.")}
                        </span>
                        <div class="guide-find-actions flex flex-wrap gap-1.5">
                            <button
                                class={denseQuiet}
                                type="button"
                                disabled={
                                    props.busy ||
                                    !findBlockPosition() ||
                                    !findQuery() ||
                                    findMatches().length === 0
                                }
                                onClick={findNext}
                            >
                                Find next
                            </button>
                            <button
                                class={denseQuiet}
                                type="button"
                                disabled={
                                    props.busy ||
                                    !findBlockPosition() ||
                                    !findQuery() ||
                                    findMatches().length === 0
                                }
                                onClick={replaceCurrent}
                            >
                                Replace
                            </button>
                            <button
                                class={denseQuiet}
                                type="button"
                                disabled={
                                    props.busy ||
                                    !findBlockPosition() ||
                                    !findQuery() ||
                                    findMatches().length === 0
                                }
                                onClick={replaceAll}
                            >
                                Replace all
                            </button>
                        </div>
                    </div>

                    <div
                        class={
                            "guide-editor-commands flex items-center justify-between gap-[9px] border-b border-[var(--line-soft)] bg-[var(--surface-inset)] px-[25px] py-[9px] max-[680px]:px-4"
                        }
                        aria-label="Guide editing commands"
                    >
                        <div
                            class="guide-history-actions flex gap-1.5"
                            role="group"
                            aria-label="Guide-wide edit history"
                        >
                            <button
                                class={denseQuiet}
                                type="button"
                                aria-label="Undo guide change"
                                title="Undo the last guide-wide edit (Ctrl/Cmd+Z outside text fields)"
                                disabled={props.busy || undoStack().length === 0}
                                onClick={undoGuideChange}
                            >
                                Undo
                            </button>
                            <button
                                class={denseQuiet}
                                type="button"
                                aria-label="Redo guide change"
                                title="Redo the last guide-wide edit (Ctrl/Cmd+Shift+Z outside text fields)"
                                disabled={props.busy || redoStack().length === 0}
                                onClick={redoGuideChange}
                            >
                                Redo
                            </button>
                        </div>
                        <button
                            class={denseOutline}
                            type="button"
                            disabled={props.busy}
                            onClick={validateSources}
                        >
                            Validate sources
                        </button>
                    </div>
                    <Show when={validationReport()}>
                        {(report) => (
                            <p
                                class={cn(
                                    "guide-validation-report m-0 px-[25px] py-[9px] text-xs leading-normal max-[680px]:px-4",
                                    report().valid
                                        ? "text-accent bg-[color-mix(in_srgb,var(--accent-soft)_38%,var(--surface))]"
                                        : "is-invalid text-danger bg-[color-mix(in_srgb,var(--danger)_7%,var(--surface))]",
                                )}
                                role={report().valid ? "status" : "alert"}
                                aria-live={report().valid ? "polite" : "assertive"}
                            >
                                {report().message}
                            </p>
                        )}
                    </Show>

                    <Show
                        when={draft().sessionId && selectedSession()}
                        fallback={
                            <Show when={draft().entryId}>
                                <div
                                    class={
                                        "guide-session-context mx-[25px] mt-[13px] flex items-center gap-[9px] rounded-[5px] border border-[var(--line-soft)] bg-[color-mix(in_srgb,var(--accent-soft)_48%,var(--surface))] px-[11px] py-[9px] max-[680px]:mx-4"
                                    }
                                >
                                    <span class="guide-context-mark grid h-[25px] w-[25px] flex-none place-items-center rounded-[5px] bg-surface text-xs font-bold text-accent">
                                        J
                                    </span>
                                    <div class="grid min-w-0 gap-[3px]">
                                        <strong class="truncate text-xs font-semibold text-ink-soft">
                                            {selectedEntry()
                                                ? field(selectedEntry()!, "title", "Journal entry")
                                                : "Journal entry unavailable"}
                                        </strong>
                                        <small class="truncate text-xs text-muted">
                                            Entry-wide guide · linked sessions and notes
                                        </small>
                                    </div>
                                </div>
                            </Show>
                        }
                    >
                        <div
                            class={
                                "guide-session-context mx-[25px] mt-[13px] flex items-center gap-[9px] rounded-[5px] border border-[var(--line-soft)] bg-[color-mix(in_srgb,var(--accent-soft)_48%,var(--surface))] px-[11px] py-[9px] max-[680px]:mx-4"
                            }
                        >
                            <span class="guide-context-mark grid h-[25px] w-[25px] flex-none place-items-center rounded-[5px] bg-surface text-xs font-bold text-accent">
                                S
                            </span>
                            <div class="grid min-w-0 gap-[3px]">
                                <strong class="truncate text-xs font-semibold text-ink-soft">
                                    {field(selectedSession()!, "title", "Tutoring session")}
                                </strong>
                                <small class="truncate text-xs text-muted">
                                    {field(selectedSession()!, "subject", "Session source")}
                                    {field(selectedSession()!, "learning_objectives")
                                        ? ` · ${field(selectedSession()!, "learning_objectives")}`
                                        : ""}
                                </small>
                            </div>
                        </div>
                    </Show>

                    <div class="guide-sections-heading flex items-center justify-between gap-4 px-[25px] pb-[9px] pt-[17px] max-[680px]:px-4">
                        <div>
                            <span class={eyebrowText}>Your material</span>
                            <h3 class="mt-1 mb-0 text-base font-semibold tracking-[-0.035em] text-ink">
                                Sections and blocks
                            </h3>
                        </div>
                        <span class="text-xs text-muted">{draft().sections.length} sections</span>
                    </div>
                    <div class="guide-editor-sections grid min-h-0 gap-2.5 overflow-auto overscroll-contain px-[25px] pb-[15px] pt-0 max-[680px]:px-4">
                        <For each={draft().sections}>
                            {(section, sectionIndex) => (
                                <article class="guide-editor-section rounded-[5px] border border-line bg-surface p-3.5">
                                    <div
                                        class={
                                            "guide-editor-section-heading grid grid-cols-[25px_minmax(0,1fr)_auto] items-end gap-[9px]"
                                        }
                                    >
                                        <span class="guide-section-index pb-2.5 text-xs font-bold text-faint">
                                            {String(sectionIndex() + 1).padStart(2, "0")}
                                        </span>
                                        <label class={fieldLabel}>
                                            Section heading
                                            <input
                                                value={section.heading}
                                                maxlength="256"
                                                onInput={(event) =>
                                                    updateSection(
                                                        sectionIndex(),
                                                        (current) => ({
                                                            ...current,
                                                            heading: event.currentTarget.value,
                                                        }),
                                                        false,
                                                    )
                                                }
                                                class={cn(textInput, "min-h-[35px]")}
                                            />
                                        </label>
                                        <div class="guide-section-actions flex items-center gap-1">
                                            <button
                                                class={moveButton}
                                                type="button"
                                                title="Move section up"
                                                aria-label={`Move section ${sectionIndex() + 1} up`}
                                                disabled={sectionIndex() === 0}
                                                onClick={() => moveSection(sectionIndex(), -1)}
                                            >
                                                ↑
                                            </button>
                                            <button
                                                class={moveButton}
                                                type="button"
                                                title="Move section down"
                                                aria-label={`Move section ${sectionIndex() + 1} down`}
                                                disabled={
                                                    sectionIndex() === draft().sections.length - 1
                                                }
                                                onClick={() => moveSection(sectionIndex(), 1)}
                                            >
                                                ↓
                                            </button>
                                            <button
                                                class={denseQuiet}
                                                type="button"
                                                title="Regenerate this section from current evidence"
                                                disabled={props.disabled || props.busy}
                                                onClick={() => regenerateSection(sectionIndex())}
                                            >
                                                Regenerate section
                                            </button>
                                            <Show when={imageAssets().length > 0}>
                                                <select
                                                    class="guide-section-image-select min-h-[35px] cursor-pointer rounded-[5px] border border-line bg-surface px-2.5 text-xs text-ink"
                                                    aria-label={`Insert an image in section ${sectionIndex() + 1}`}
                                                    value=""
                                                    disabled={props.disabled || props.busy}
                                                    onChange={(event) => {
                                                        const assetId = event.currentTarget.value;
                                                        if (!assetId) return;
                                                        insertImage(sectionIndex(), assetId);
                                                        event.currentTarget.value = "";
                                                    }}
                                                >
                                                    <option value="">Insert image…</option>
                                                    <For each={imageAssets()}>
                                                        {(asset) => (
                                                            <option value={asset.id}>
                                                                {field(
                                                                    asset,
                                                                    "title",
                                                                    "Archive image",
                                                                )}
                                                            </option>
                                                        )}
                                                    </For>
                                                </select>
                                            </Show>
                                            <button
                                                class={cn(denseQuiet, "guide-remove-section")}
                                                type="button"
                                                disabled={draft().sections.length <= 1}
                                                onClick={() => {
                                                    clearFindSelection();
                                                    setActiveBlock((selected) =>
                                                        selected?.sectionId === section.id
                                                            ? null
                                                            : selected,
                                                    );
                                                    setDraft(
                                                        (current) => ({
                                                            ...current,
                                                            sections: current.sections.filter(
                                                                (_, index) =>
                                                                    index !== sectionIndex(),
                                                            ),
                                                        }),
                                                        true,
                                                    );
                                                }}
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </div>
                                    <div class="guide-block-list ml-[34px] mt-3 grid gap-[9px]">
                                        <For each={section.blocks}>
                                            {(block, blockIndex) => (
                                                <div
                                                    class={
                                                        "guide-block-editor grid gap-2 rounded-[5px] border border-[var(--line-soft)] bg-[var(--surface-inset)] p-2.5"
                                                    }
                                                >
                                                    <div class="guide-block-toolbar flex flex-wrap items-end gap-2">
                                                        <label class="grid gap-1 text-xs text-faint">
                                                            Block style
                                                            <select
                                                                value={block.kind}
                                                                onChange={(event) =>
                                                                    updateBlock(
                                                                        sectionIndex(),
                                                                        blockIndex(),
                                                                        (current) => ({
                                                                            ...current,
                                                                            kind: event
                                                                                .currentTarget
                                                                                .value as GuideBlockDraft["kind"],
                                                                            stale: false,
                                                                            origin:
                                                                                current.origin ===
                                                                                "ai-generated"
                                                                                    ? "human-edited"
                                                                                    : current.origin,
                                                                        }),
                                                                    )
                                                                }
                                                                class="min-h-[29px] cursor-pointer rounded-[5px] border border-line bg-surface px-2 text-xs capitalize text-ink"
                                                            >
                                                                <For each={GUIDE_BLOCK_KINDS}>
                                                                    {(kind) => (
                                                                        <option value={kind}>
                                                                            {kind.replaceAll(
                                                                                "-",
                                                                                " ",
                                                                            )}
                                                                        </option>
                                                                    )}
                                                                </For>
                                                                <Show
                                                                    when={
                                                                        !(
                                                                            GUIDE_BLOCK_KINDS as readonly string[]
                                                                        ).includes(block.kind)
                                                                    }
                                                                >
                                                                    <option value={block.kind}>
                                                                        {block.kind} (unsupported ·
                                                                        preserved)
                                                                    </option>
                                                                </Show>
                                                            </select>
                                                        </label>
                                                        <label class="grid gap-1 text-xs text-faint">
                                                            Origin
                                                            <select
                                                                value={block.origin}
                                                                onChange={(event) =>
                                                                    updateBlock(
                                                                        sectionIndex(),
                                                                        blockIndex(),
                                                                        (current) => ({
                                                                            ...current,
                                                                            origin: event
                                                                                .currentTarget
                                                                                .value as GuideBlockDraft["origin"],
                                                                        }),
                                                                    )
                                                                }
                                                                class="min-h-[29px] cursor-pointer rounded-[5px] border border-line bg-surface px-2 text-xs capitalize text-ink"
                                                            >
                                                                <For each={GUIDE_BLOCK_ORIGINS}>
                                                                    {(origin) => (
                                                                        <option value={origin}>
                                                                            {origin.replaceAll(
                                                                                "-",
                                                                                " ",
                                                                            )}
                                                                        </option>
                                                                    )}
                                                                </For>
                                                                <Show
                                                                    when={
                                                                        !(
                                                                            GUIDE_BLOCK_ORIGINS as readonly string[]
                                                                        ).includes(block.origin)
                                                                    }
                                                                >
                                                                    <option value={block.origin}>
                                                                        {block.origin} (unsupported
                                                                        · preserved)
                                                                    </option>
                                                                </Show>
                                                            </select>
                                                        </label>
                                                        <Show when={block.stale}>
                                                            <span class="guide-stale-label ml-auto text-xs text-[#9a6034]">
                                                                Source changed · review this block
                                                            </span>
                                                        </Show>
                                                        <button
                                                            class={cn(
                                                                denseQuiet,
                                                                "guide-example-shortcut",
                                                            )}
                                                            type="button"
                                                            disabled={props.busy}
                                                            title="Insert an example block after this block"
                                                            onClick={() =>
                                                                addExampleAfter(
                                                                    sectionIndex(),
                                                                    blockIndex(),
                                                                )
                                                            }
                                                        >
                                                            Add example
                                                        </button>
                                                        <button
                                                            class={cn(formIconButton, "ml-auto")}
                                                            type="button"
                                                            title="Remove block"
                                                            aria-label="Remove block"
                                                            onClick={() => {
                                                                clearFindSelection();
                                                                setActiveBlock((selected) => {
                                                                    if (
                                                                        selected?.sectionId !==
                                                                        section.id
                                                                    )
                                                                        return selected;
                                                                    if (
                                                                        selected.blockIndex ===
                                                                        blockIndex()
                                                                    )
                                                                        return null;
                                                                    return selected.blockIndex >
                                                                        blockIndex()
                                                                        ? {
                                                                              ...selected,
                                                                              blockIndex:
                                                                                  selected.blockIndex -
                                                                                  1,
                                                                          }
                                                                        : selected;
                                                                });
                                                                updateSection(
                                                                    sectionIndex(),
                                                                    (current) => ({
                                                                        ...current,
                                                                        blocks: current.blocks.filter(
                                                                            (_, index) =>
                                                                                index !==
                                                                                blockIndex(),
                                                                        ),
                                                                    }),
                                                                );
                                                            }}
                                                        >
                                                            ×
                                                        </button>
                                                    </div>
                                                    <textarea
                                                        ref={(element) =>
                                                            blockTextareas.set(
                                                                `${section.id}:${blockIndex()}`,
                                                                element,
                                                            )
                                                        }
                                                        onFocus={() =>
                                                            activateBlock(section.id, blockIndex())
                                                        }
                                                        rows={4}
                                                        value={block.text}
                                                        placeholder="Write the explanation, example, prompt, or practice note…"
                                                        onInput={(event) => {
                                                            updateBlock(
                                                                sectionIndex(),
                                                                blockIndex(),
                                                                (current) => ({
                                                                    ...current,
                                                                    text: event.currentTarget.value,
                                                                    stale: false,
                                                                    origin:
                                                                        current.origin ===
                                                                        "ai-generated"
                                                                            ? "human-edited"
                                                                            : "human-edited",
                                                                }),
                                                                false,
                                                            );
                                                            clearFindSelection();
                                                        }}
                                                        class={cn(
                                                            textArea,
                                                            "min-h-[78px] leading-[1.55]",
                                                        )}
                                                    />
                                                    <div
                                                        class={
                                                            "guide-source-row grid grid-cols-[1fr_minmax(200px,0.85fr)] gap-[9px]"
                                                        }
                                                    >
                                                        <label class="grid min-w-0 gap-1 text-xs font-semibold text-faint">
                                                            Cited source IDs
                                                            <input
                                                                value={block.sourceIds}
                                                                placeholder="Paste archive IDs, separated by commas"
                                                                onInput={(event) =>
                                                                    updateBlock(
                                                                        sectionIndex(),
                                                                        blockIndex(),
                                                                        (current) => ({
                                                                            ...current,
                                                                            sourceIds:
                                                                                event.currentTarget
                                                                                    .value,
                                                                            stale: false,
                                                                        }),
                                                                        false,
                                                                    )
                                                                }
                                                                class="w-full min-w-0 min-h-[30px] rounded-[5px] border border-line bg-surface px-2 text-xs text-ink"
                                                            />
                                                        </label>
                                                        <label class="grid min-w-0 gap-1 text-xs font-semibold text-faint">
                                                            Attach source
                                                            <select
                                                                value=""
                                                                onChange={(event) => {
                                                                    const id =
                                                                        event.currentTarget.value;
                                                                    if (!id) return;
                                                                    updateBlock(
                                                                        sectionIndex(),
                                                                        blockIndex(),
                                                                        (current) => ({
                                                                            ...current,
                                                                            sourceIds:
                                                                                appendSourceId(
                                                                                    current.sourceIds,
                                                                                    id,
                                                                                ),
                                                                        }),
                                                                        true,
                                                                    );
                                                                    event.currentTarget.value = "";
                                                                }}
                                                                class="w-full min-w-0 min-h-[30px] cursor-pointer rounded-[5px] border border-line bg-surface px-2 text-xs text-ink"
                                                            >
                                                                <option value="">
                                                                    Choose a guide source…
                                                                </option>
                                                                <For
                                                                    each={sourceOptions(
                                                                        props.sourceRecords,
                                                                        selectedSession(),
                                                                        draft().sessionId
                                                                            ? undefined
                                                                            : selectedEntry(),
                                                                    )}
                                                                >
                                                                    {(source) => (
                                                                        <option value={source.id}>
                                                                            {source.label}
                                                                        </option>
                                                                    )}
                                                                </For>
                                                            </select>
                                                        </label>
                                                    </div>
                                                </div>
                                            )}
                                        </For>
                                    </div>
                                    <button
                                        class={cn(denseQuiet, "guide-add-block ml-[34px] mt-2.5")}
                                        type="button"
                                        onClick={() =>
                                            updateSection(
                                                sectionIndex(),
                                                (current) => ({
                                                    ...current,
                                                    blocks: [
                                                        ...current.blocks,
                                                        {
                                                            kind: "paragraph",
                                                            text: "",
                                                            sourceIds: "",
                                                            stale: false,
                                                            origin: "tutor-authored",
                                                        },
                                                    ],
                                                }),
                                                true,
                                            )
                                        }
                                    >
                                        + Add a content block
                                    </button>
                                </article>
                            )}
                        </For>
                    </div>
                    <button
                        class={cn(
                            denseOutline,
                            "guide-add-section mx-[25px] mb-3.5 max-[680px]:ml-4",
                        )}
                        type="button"
                        onClick={() =>
                            setDraft(
                                (current) => ({
                                    ...current,
                                    sections: [
                                        ...current.sections,
                                        {
                                            id: crypto.randomUUID(),
                                            heading: "New section",
                                            blocks: [],
                                        },
                                    ],
                                }),
                                true,
                            )
                        }
                    >
                        + Add section
                    </button>
                    <Show when={error()}>
                        <p
                            class="guide-editor-error mx-[25px] mb-3 text-xs text-danger max-[680px]:ml-4"
                            role="alert"
                        >
                            {error()}
                        </p>
                    </Show>
                    <Show when={confirmDiscard()}>
                        <div
                            class="guide-editor-discard mx-[25px] mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[5px] border border-line bg-surface-subtle px-3 py-2 text-xs text-muted max-[680px]:mx-4"
                            role="alert"
                        >
                            <span>Discard unsaved changes to this guide?</span>
                            <div class="flex gap-2">
                                <button
                                    class={denseQuiet}
                                    type="button"
                                    onClick={() => setConfirmDiscard(false)}
                                >
                                    Keep editing
                                </button>
                                <button
                                    class={denseDanger}
                                    type="button"
                                    disabled={props.busy}
                                    onClick={() => props.onClose()}
                                >
                                    Discard changes
                                </button>
                            </div>
                        </div>
                    </Show>
                    <footer
                        class={
                            "guide-editor-footer flex items-center justify-between gap-4 border-t border-line bg-[var(--surface-inset)] px-[25px] py-[13px] max-[680px]:flex-col max-[680px]:items-start max-[680px]:p-4"
                        }
                    >
                        <span class="max-w-[420px] text-xs leading-normal text-muted">
                            Saving creates a new archive revision. The previous version stays
                            available in the archive history.
                        </span>
                        <div class="flex flex-none gap-[7px] max-[680px]:self-end">
                            <button
                                class={denseQuiet}
                                type="button"
                                disabled={props.busy}
                                onClick={() => requestClose()}
                            >
                                Cancel
                            </button>
                            <button
                                class={densePrimary}
                                type="submit"
                                disabled={
                                    props.disabled ||
                                    props.busy ||
                                    (!draft().sessionId && !draft().entryId)
                                }
                            >
                                {props.busy
                                    ? "Saving…"
                                    : props.record
                                      ? "Save changes"
                                      : "Save draft"}
                            </button>
                        </div>
                    </footer>
                </form>
            </GuideDialog>
        </div>
    );
}

function draftIncludesEntryNotes(draft: GuideDraft, records: readonly ArchiveRecord[]): boolean {
    const entryNoteIds = new Set(
        records
            .filter(
                (record) =>
                    record.type === RecordType.settings &&
                    field(record, "record_role") === "journal-notes" &&
                    field(record, "entry_id").toLowerCase() === draft.entryId?.toLowerCase() &&
                    field(record, "session_id").toLowerCase() !== draft.sessionId.toLowerCase(),
            )
            .map((record) => record.id.toLowerCase()),
    );
    return draft.sections.some((section) =>
        section.blocks.some((block) =>
            block.sourceIds
                .split(/[\s,;]+/u)
                .some((sourceId) => entryNoteIds.has(sourceId.toLowerCase())),
        ),
    );
}

function templateSections(
    templateId: string,
    templates: readonly GuideTemplate[],
): GuideDraft["sections"] {
    const template = allTemplates(templates).find((item) => item.id === templateId);
    return (template ?? getGuideTemplate(templateId)).sections.map((heading) => ({
        id: crypto.randomUUID(),
        heading,
        blocks: [],
    }));
}

function initialGuideDraft(
    record: ArchiveRecord | null,
    sessions: ArchiveRecord[],
    templateId: string,
    templates: readonly GuideTemplate[],
): GuideDraft {
    if (record) return guideDraftFromRecord(record);
    const firstSession = sessions[0];
    const template = allTemplates(templates).find((item) => item.id === templateId);
    if (template) {
        return firstSession
            ? createGuideDraftFromSections(firstSession, template.id, template.sections)
            : {
                  title: "",
                  sessionId: "",
                  templateId: template.id,
                  sections: templateSections(template.id, templates),
              };
    }
    return firstSession
        ? createGuideDraft(firstSession, templateId)
        : {
              title: "",
              sessionId: "",
              templateId,
              sections: templateSections(templateId, templates),
          };
}

function allTemplates(templates: readonly GuideTemplate[]): GuideTemplate[] {
    return [...templates];
}

function GuideTemplateEditor(props: {
    current: ArchiveRecord | null;
    builtinTemplate?: GuideTemplate | undefined;
    busy: boolean;
    disabled: boolean;
    onClose: () => void;
    onSave: (input: GuideTemplateInput, current: ArchiveRecord | null) => Promise<boolean>;
}): JSX.Element {
    const existing = createMemo(() =>
        props.current ? guideTemplateFromRecord(props.current) : (props.builtinTemplate ?? null),
    );
    const [error, setError] = createSignal("");

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        const form = event.currentTarget as HTMLFormElement;
        const data = new FormData(form);
        const value = (name: string): string => String(data.get(name) ?? "");
        try {
            const saved = await props.onSave(
                {
                    name: value("name"),
                    subject: value("subject"),
                    description: value("description"),
                    sections: value("sections")
                        .split(/\r?\n/u)
                        .map((section) => section.trim())
                        .filter(Boolean),
                    body: value("body"),
                    builtinTemplateId: props.builtinTemplate?.id,
                },
                props.current,
            );
            if (saved) props.onClose();
            else setError("Template could not be saved. See the workspace notice for details.");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The template could not be saved.");
        }
    }

    return (
        <div
            class={
                "dialog-backdrop guide-editor-backdrop fixed inset-0 z-30 grid items-stretch justify-items-center bg-[rgb(10_16_12_/_43%)] p-[22px] [animation:fade-in_0.14s_ease-out] max-[680px]:p-0"
            }
        >
            <GuideDialog
                class={
                    "guide-editor-dialog guide-template-editor-dialog flex max-h-full w-[min(720px,100%)] flex-col overflow-hidden rounded-[5px] border border-line bg-surface shadow-none max-[680px]:h-full max-[680px]:max-h-[100dvh] max-[680px]:w-full"
                }
                labelledBy="guide-template-editor-title"
                onEscape={props.onClose}
                canEscape={() => !props.busy}
            >
                <header
                    class={
                        "guide-editor-header flex justify-between gap-[18px] border-b border-[var(--line-soft)] bg-surface px-[25px] pb-[18px] pt-[22px] max-[680px]:px-4"
                    }
                >
                    <div>
                        <span class={eyebrowText}>A structure that's yours</span>
                        <h2
                            id="guide-template-editor-title"
                            class="mt-[5px] mb-[5px] text-[23px] font-semibold tracking-[-0.04em] text-ink"
                        >
                            {props.builtinTemplate
                                ? props.current
                                    ? `Edit ${props.builtinTemplate.name} override`
                                    : `Customize ${props.builtinTemplate.name}`
                                : props.current
                                  ? "Edit template"
                                  : "Create a template"}
                        </h2>
                        <p class="m-0 text-xs text-muted">
                            Give a reusable teaching approach a name, clear sections, and a little
                            guidance.
                        </p>
                    </div>
                    <button
                        class={formIconButton}
                        type="button"
                        aria-label="Close template editor"
                        disabled={props.busy}
                        onClick={() => props.onClose()}
                    >
                        ×
                    </button>
                </header>
                <form
                    class="guide-editor-form flex min-h-0 flex-col overflow-hidden"
                    onSubmit={(event) => void submit(event)}
                >
                    <div
                        class={
                            "guide-template-form-fields grid grid-cols-[minmax(0,1fr)_minmax(0,0.55fr)] gap-3 overflow-y-auto px-[25px] py-[18px] max-[680px]:grid-cols-1 max-[680px]:p-4"
                        }
                    >
                        <label class="form-field grid min-w-0 content-start gap-1.5 text-xs font-semibold text-muted">
                            Template name
                            <input
                                name="name"
                                maxlength="240"
                                required
                                value={existing()?.name ?? ""}
                                class="min-h-[35px] w-full min-w-0 rounded-[5px] border border-line bg-surface-subtle px-2.5 text-xs text-ink"
                            />
                        </label>
                        <label class="form-field grid min-w-0 content-start gap-1.5 text-xs font-semibold text-muted">
                            Subject
                            <input
                                name="subject"
                                maxlength="128"
                                value={existing()?.subject ?? "general"}
                                class="min-h-[35px] w-full min-w-0 rounded-[5px] border border-line bg-surface-subtle px-2.5 text-xs text-ink"
                            />
                        </label>
                        <label class="form-field guide-template-description-field col-span-full grid min-w-0 content-start gap-1.5 text-xs font-semibold text-muted max-[680px]:col-auto">
                            Short description
                            <textarea
                                name="description"
                                rows="2"
                                maxlength="4096"
                                value={existing()?.description ?? ""}
                                class="min-h-[72px] w-full resize-y rounded-[5px] border border-line bg-surface-subtle px-2.5 py-[9px] text-xs leading-[1.6] text-ink"
                            />
                        </label>
                        <label class="form-field guide-template-sections-field col-span-full grid min-w-0 content-start gap-1.5 text-xs font-semibold text-muted max-[680px]:col-auto">
                            Sections{" "}
                            <span class="form-hint text-xs font-normal text-faint">
                                One heading per line
                            </span>
                            <textarea
                                name="sections"
                                rows="8"
                                required
                                maxlength="64000"
                                value={
                                    existing()?.sections.join("\n") ??
                                    "Session overview\nKey ideas\nNext steps"
                                }
                                class="min-h-[72px] w-full resize-y rounded-[5px] border border-line bg-surface-subtle px-2.5 py-[9px] text-xs leading-[1.6] text-ink"
                            />
                        </label>
                        <label class="form-field guide-template-description-field col-span-full grid min-w-0 content-start gap-1.5 text-xs font-semibold text-muted max-[680px]:col-auto">
                            Writing guidance{" "}
                            <span class="form-hint text-xs font-normal text-faint">Optional</span>
                            <textarea
                                name="body"
                                rows="4"
                                maxlength="100000"
                                value={existing()?.body ?? ""}
                                class="min-h-[72px] w-full resize-y rounded-[5px] border border-line bg-surface-subtle px-2.5 py-[9px] text-xs leading-[1.6] text-ink"
                            />
                        </label>
                    </div>
                    <Show when={error()}>
                        <p
                            class="form-error mx-[25px] mb-3 text-xs text-danger max-[680px]:mx-4"
                            role="alert"
                        >
                            {error()}
                        </p>
                    </Show>
                    <footer
                        class={
                            "guide-editor-footer flex items-center justify-between gap-4 border-t border-line bg-[var(--surface-inset)] px-[25px] py-[13px] max-[680px]:flex-col max-[680px]:items-start max-[680px]:p-4"
                        }
                    >
                        <span class="max-w-[420px] text-xs leading-normal text-muted">
                            Saved in this archive and available on Windows, macOS, Linux, and web.
                        </span>
                        <div class="flex flex-none gap-[7px] max-[680px]:self-end">
                            <button
                                class={denseQuiet}
                                type="button"
                                disabled={props.busy}
                                onClick={() => props.onClose()}
                            >
                                Cancel
                            </button>
                            <button
                                class={densePrimary}
                                type="submit"
                                disabled={props.disabled || props.busy}
                            >
                                {props.busy
                                    ? "Saving…"
                                    : props.current
                                      ? "Save changes"
                                      : "Save template"}
                            </button>
                        </div>
                    </footer>
                </form>
            </GuideDialog>
        </div>
    );
}

function sourceOptions(
    records: readonly ArchiveRecord[],
    session: ArchiveRecord | undefined,
    entry: ArchiveRecord | undefined,
): { id: string; label: string }[] {
    if (!session && !entry) return [];
    const scope = session ? { session, records } : { entry: entry!, records };
    return records
        .filter((record) => isGuideSourceInScope(record.id.toLowerCase(), scope))
        .map((record) => {
            return {
                id: record.id,
                label: `${sourceKind(record)} · ${field(record, "title", field(record, "text", field(record, "content", field(record, "display_name", record.id))))}`,
            };
        });
}

function sourceKind(record: ArchiveRecord): string {
    switch (record.type) {
        case RecordType.session:
            return "Session";
        case RecordType.student:
            return "Student";
        case RecordType.annotation:
            return "Observation";
        case RecordType.transcriptSegment:
            return "Transcript";
        case RecordType.evidenceNode:
            return "Evidence";
        case RecordType.assetMetadata:
            return "Material";
        case RecordType.settings:
            return "Journal note";
        default:
            return "Source";
    }
}

function appendSourceId(current: string, id: string): string {
    const ids = current.split(/[\s,;]+/u).filter(Boolean);
    return ids.some((existing) => existing.toLowerCase() === id.toLowerCase())
        ? current
        : [...ids, id].join(", ");
}

function timestampLabel(value: string): string {
    if (!/^\d+$/u.test(value)) return "Recently edited";
    const date = new Date(Number(BigInt(value) / 1000n));
    return Number.isNaN(date.getTime())
        ? "Recently edited"
        : `Edited ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}
