import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { RecordType, type ArchiveRecord } from "./archive/format";
import type { ArchiveSnapshot } from "./archive/archive";
import { GuideVersionHistory } from "./GuideVersionHistory";
import {
  GUIDE_BLOCK_KINDS,
  GUIDE_BLOCK_ORIGINS,
  GUIDE_TEMPLATES,
  createGuideDraft,
  createGuideDraftFromSections,
  field,
  generateGuideDraftFromEntry,
  generateGuideDraftFromSession,
  getGuideTemplate,
  guideDraftFromRecord,
  isGuideSourceInScope,
  type GuideBlockDraft,
  type GuideDraft,
  type GuideTemplate,
} from "./domain/guides";
import {
  guideTemplateFromRecord,
  parseGuideTemplateImport,
  type GuideTemplateInput,
} from "./domain/templates";
import "./guides.css";

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
  onToggleTemplateManager: () => void;
  disabled: boolean;
  busy: boolean;
  onOpenSessions: () => void;
  onSave: (draft: GuideDraft, current: ArchiveRecord | null) => Promise<boolean>;
  onRestoreVersion: (selected: ArchiveRecord, current: ArchiveRecord) => Promise<boolean>;
  onApprove: (record: ArchiveRecord) => void;
  onTrash: (record: ArchiveRecord) => void;
  onExport: (record: ArchiveRecord, format: "markdown" | "html" | "json" | "docx" | "pdf") => void;
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
  } | null>(null);
  const [templateNotice, setTemplateNotice] = createSignal("");
  const canCreate = () => props.sessions.length > 0 && !props.disabled;
  const canCreateEntry = () => props.entries.length > 0 && !props.disabled;
  const customTemplates = () => props.customTemplates.map(guideTemplateFromRecord);
  const allTemplates = () => [...GUIDE_TEMPLATES, ...customTemplates()];

  function openGeneration(): void {
    setGenerationError("");
    setRegenerationTitle("");
    setGeneration({
      scope: "session",
      sourceId: props.sessions[0]?.id ?? "",
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

  function generateSelectedGuide(event: SubmitEvent): void {
    event.preventDefault();
    const selection = generation();
    if (!selection) return;
    try {
      let draft: GuideDraft;
      if (selection.scope === "entry") {
        const entry = props.entries.find((item) => item.id === selection.sourceId);
        if (!entry)
          throw new Error("Choose a journal entry that is still available in this archive.");
        draft = generateGuideDraftFromEntry(
          entry,
          selection.templateId,
          props.sourceRecords,
          props.students,
          allTemplates(),
        );
      } else {
        const session = props.sessions.find((item) => item.id === selection.sourceId);
        if (!session) throw new Error("Choose a session that is still available in this archive.");
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
      setEditor({ record: selection.record, templateId: draft.templateId, initialDraft: draft });
      setGeneration(null);
    } catch (cause) {
      setGenerationError(
        cause instanceof Error ? cause.message : "A guide could not be generated from this source.",
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
      const template = parseGuideTemplateImport(await file.text());
      const saved = await props.onSaveTemplate(template, null);
      setTemplateNotice(saved ? `Imported “${template.name}”.` : "Template import was not saved.");
    } catch (cause) {
      setTemplateNotice(cause instanceof Error ? cause.message : "Template could not be imported.");
    }
  }

  return (
    <div class="page-body guides-page">
      <section class="record-heading guides-heading">
        <div>
          <span class="eyebrow">STRUCTURE THAT LEAVES ROOM</span>
          <h1>Study guides</h1>
          <p>
            Turn session notes into clear, reusable learning material, with its sources kept close.
          </p>
        </div>
      </section>

      <Show when={generation()} keyed>
        {(selection) => (
          <div
            class="dialog-backdrop guide-editor-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget && !props.busy) setGeneration(null);
            }}
          >
            <section
              class="guide-generation-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="guide-generation-title"
              onKeyDown={(event) => {
                if (event.key === "Escape" && !props.busy) setGeneration(null);
              }}
            >
              <header class="guide-editor-header">
                <div>
                  <span class="eyebrow">A DRAFT GROUNDED IN YOUR ARCHIVE</span>
                  <h2 id="guide-generation-title">
                    {selection.record ? "Regenerate a study guide" : "Generate a study guide"}
                  </h2>
                  <p>
                    Choose a source and structure. The result opens as an editable draft for tutor
                    review before it is saved.
                  </p>
                </div>
                <button
                  class="icon-button guide-trash-button"
                  type="button"
                  aria-label="Close guide generation"
                  onClick={() => setGeneration(null)}
                >
                  ×
                </button>
              </header>
              <form onSubmit={generateSelectedGuide}>
                <div class="guide-generation-fields">
                  <label class="form-field">
                    <span>Source type</span>
                    <select
                      value={selection.scope}
                      disabled={Boolean(selection.record)}
                      onChange={(event) =>
                        setGeneration((current) => {
                          if (!current) return current;
                          const scope = event.currentTarget.value as "session" | "entry";
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
                    >
                      <option value="session" disabled={!props.sessions.length}>
                        Session
                      </option>
                      <option value="entry" disabled={!props.entries.length}>
                        Journal entry
                      </option>
                    </select>
                  </label>
                  <label class="form-field">
                    <span>{selection.scope === "session" ? "Session" : "Journal entry"}</span>
                    <select
                      required
                      value={selection.sourceId}
                      disabled={Boolean(selection.record)}
                      onChange={(event) =>
                        setGeneration((current) =>
                          current ? { ...current, sourceId: event.currentTarget.value } : current,
                        )
                      }
                    >
                      <Show when={selection.scope === "session"}>
                        <For each={props.sessions}>
                          {(session) => (
                            <option value={session.id}>
                              {field(session, "title", "Tutoring Session")}
                              {field(session, "subject") ? ` · ${field(session, "subject")}` : ""}
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
                  <label class="form-field">
                    <span>Structure</span>
                    <select
                      value={selection.templateId}
                      onChange={(event) =>
                        setGeneration((current) =>
                          current ? { ...current, templateId: event.currentTarget.value } : current,
                        )
                      }
                    >
                      <option value="auto">Automatic · use the source subject</option>
                      <For each={allTemplates()}>
                        {(template) => <option value={template.id}>{template.name}</option>}
                      </For>
                    </select>
                  </label>
                </div>
                <Show when={selection.record}>
                  <label class="form-field guide-regeneration-title">
                    <span>Guide title</span>
                    <input
                      required
                      maxlength="240"
                      value={regenerationTitle()}
                      onInput={(event) => setRegenerationTitle(event.currentTarget.value)}
                    />
                  </label>
                </Show>
                <Show when={selection.scope === "session"}>
                  <label class="guide-generation-entry-evidence">
                    <input
                      type="checkbox"
                      checked={selection.includeEntryEvidence}
                      onChange={(event) =>
                        setGeneration((current) =>
                          current
                            ? { ...current, includeEntryEvidence: event.currentTarget.checked }
                            : current,
                        )
                      }
                    />
                    <span>
                      Include notes from the linked journal entry
                      <small>
                        Bring in reflection notes saved with this entry and its sessions.
                      </small>
                    </span>
                  </label>
                </Show>
                <p class="guide-generation-note">
                  {selection.scope === "entry"
                    ? "Gather linked sessions and the entry’s own notes into one cited guide. Transcript excerpts stay marked for review; transcript-derived claims appear only after a tutor verifies them."
                    : "Tutor observations and notes are included with citations. Transcript excerpts stay marked for review; transcript-derived claims appear only after a tutor verifies them."}
                  <Show when={selection.record}>
                    <br /> Saving this regenerated draft creates a new revision and keeps the
                    previous guide in history.
                  </Show>
                </p>
                <Show when={generationError()}>
                  <p class="guide-editor-error" role="alert">
                    {generationError()}
                  </p>
                </Show>
                <footer class="guide-generation-footer">
                  <button
                    class="button button-quiet"
                    type="button"
                    disabled={props.busy}
                    onClick={() => setGeneration(null)}
                  >
                    Cancel
                  </button>
                  <button
                    class="button button-primary"
                    type="submit"
                    disabled={props.disabled || props.busy || !selection.sourceId}
                  >
                    Generate draft
                  </button>
                </footer>
              </form>
            </section>
          </div>
        )}
      </Show>

      <section class="guide-template-section" aria-labelledby="guide-templates-title">
        <div class="guide-section-heading">
          <div>
            <span class="eyebrow">A THOUGHTFUL PLACE TO START</span>
            <h2 id="guide-templates-title">Choose a structure</h2>
          </div>
          <div class="guide-template-heading-actions">
            <span>{allTemplates().length} structures</span>
            <button
              class="button button-primary"
              type="button"
              disabled={!canCreate() || props.busy}
              onClick={openGeneration}
            >
              Generate from a session
            </button>
            <button
              class="button button-outline"
              type="button"
              disabled={!canCreateEntry() || props.busy}
              onClick={openEntryGeneration}
            >
              Generate from a journal entry
            </button>
            <button
              class="button button-quiet"
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
        <div class="guide-template-grid">
          <For each={allTemplates()}>
            {(template, index) => (
              <button
                class="guide-template-card"
                type="button"
                disabled={!canCreate()}
                onClick={() => setEditor({ record: null, templateId: template.id })}
              >
                <span class={`guide-template-number guide-template-number-${index() % 5}`}>
                  {String(index() + 1).padStart(2, "0")}
                </span>
                <span class="guide-template-copy">
                  <strong>{template.name}</strong>
                  <small>{template.description}</small>
                  <span>
                    {template.sections.length} sections <span aria-hidden="true">·</span>{" "}
                    {GUIDE_TEMPLATES.some((builtIn) => builtIn.id === template.id)
                      ? "Built in"
                      : "Custom"}
                  </span>
                </span>
              </button>
            )}
          </For>
        </div>
        <Show when={props.templateManagerOpen}>
          <section class="guide-template-manager" aria-labelledby="guide-template-manager-title">
            <div class="guide-template-manager-heading">
              <div>
                <span class="eyebrow">YOUR ARCHIVE</span>
                <h3 id="guide-template-manager-title">Custom templates</h3>
              </div>
              <div class="guide-template-manager-actions">
                <label class="button button-outline guide-template-import">
                  Import JSON
                  <input
                    type="file"
                    accept=".json,application/json"
                    aria-label="Import a study guide template JSON file"
                    onChange={(event) => void importTemplate(event)}
                    disabled={props.disabled || props.busy}
                  />
                </label>
                <button
                  class="button button-primary"
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
              <p class="guide-template-notice" role="status">
                {templateNotice()}
              </p>
            </Show>
            <Show
              when={props.customTemplates.length > 0}
              fallback={
                <p class="guide-template-empty">
                  Your archive has no custom structures yet. Create one for a teaching approach you
                  return to, or import a Tutorux template JSON file.
                </p>
              }
            >
              <div class="guide-template-manage-list">
                <For each={props.customTemplates}>
                  {(record) => {
                    const template = () => guideTemplateFromRecord(record);
                    return (
                      <article class="guide-template-manage-row">
                        <div class="guide-template-manage-copy">
                          <strong>{field(record, "name", "Untitled template")}</strong>
                          <span>
                            {field(record, "subject", "General")} · {template().sections.length}{" "}
                            sections
                          </span>
                          <small>{field(record, "description") || "No description"}</small>
                        </div>
                        <div class="guide-template-manage-actions">
                          <button
                            class="button button-quiet"
                            type="button"
                            disabled={props.busy}
                            onClick={() => props.onExportTemplate(template())}
                          >
                            Export
                          </button>
                          <button
                            class="button button-outline"
                            type="button"
                            disabled={props.disabled || props.busy}
                            onClick={() => {
                              setTemplateNotice("");
                              setTemplateEditor({ current: record });
                            }}
                          >
                            Edit
                          </button>
                          <button
                            class="button button-quiet"
                            type="button"
                            disabled={props.disabled || props.busy}
                            onClick={() => props.onTrashTemplate(record)}
                          >
                            Move to Trash
                          </button>
                        </div>
                      </article>
                    );
                  }}
                </For>
              </div>
            </Show>
            <Show when={props.trashedTemplates.length > 0}>
              <div class="guide-template-trash-list">
                <span class="eyebrow">IN TRASH</span>
                <For each={props.trashedTemplates}>
                  {(record) => (
                    <div class="guide-template-trash-row">
                      <span>{field(record, "name", "Untitled template")}</span>
                      <button
                        class="button button-quiet"
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
          <p class="guide-inline-note">
            Add a session or journal entry first. Each guide stays connected to the learning it came
            from.
            <button
              type="button"
              class="button button-quiet"
              onClick={() => props.onOpenSessions()}
            >
              Open sessions
            </button>
          </p>
        </Show>
      </section>

      <section class="record-list-shell guide-list-shell">
        <div class="record-list-toolbar">
          <span>
            <strong>{props.records.length}</strong> saved guides
          </span>
          <span class="list-view-label">Drafts remain yours to shape</span>
        </div>
        <Show
          when={props.records.length > 0}
          fallback={
            <div class="guide-empty-state">
              <div class="guide-empty-mark" aria-hidden="true">
                G
              </div>
              <h2>Your guide shelf is ready</h2>
              <p>
                Start with a session or journal entry. You can refine every section before sharing
                or approving it.
              </p>
            </div>
          }
        >
          <div class="guide-record-list">
            <For
              each={[...props.records].sort((a, b) =>
                field(b, "updated_at_us").localeCompare(field(a, "updated_at_us")),
              )}
            >
              {(record) => {
                const session = () =>
                  props.sessions.find((item) => item.id === field(record, "session_id"));
                const entry = () =>
                  props.entries.find((item) => item.id === field(record, "entry_id"));
                const template = () =>
                  GUIDE_TEMPLATES.find((item) => item.id === field(record, "template_id"))?.name ??
                  "Custom";
                const staleBlocks = () =>
                  Math.max(0, Number.parseInt(field(record, "stale_block_count", "0"), 10) || 0);
                const sections = () =>
                  Math.max(0, Number.parseInt(field(record, "section_count", "0"), 10) || 0);
                const canEdit = () =>
                  Boolean((field(record, "session_id") ? session() : entry()) && !props.disabled);
                return (
                  <article class="guide-record-card">
                    <div class="guide-record-marker" aria-hidden="true">
                      <span>✳</span>
                    </div>
                    <div class="guide-record-main">
                      <div class="guide-record-title-row">
                        <span class="eyebrow">{template().toLocaleUpperCase()} GUIDE</span>
                        <span
                          class={`guide-status status-${field(record, "approval_state", "draft")}`}
                        >
                          {field(record, "approval_state", "draft")}
                        </span>
                      </div>
                      <h2>{field(record, "title", "Untitled guide")}</h2>
                      <p>
                        {session()
                          ? field(session()!, "title", "Tutoring session")
                          : entry()
                            ? field(entry()!, "title", "Journal entry")
                            : "Guide source unavailable"}
                        {session() && field(session()!, "subject")
                          ? ` · ${field(session()!, "subject")}`
                          : ""}
                      </p>
                      <div class="guide-record-meta">
                        <span>{sections()} sections</span>
                        <span>{timestampLabel(field(record, "updated_at_us"))}</span>
                        <Show when={staleBlocks() > 0}>
                          <span class="guide-stale-count">
                            {staleBlocks()} source-changed block{staleBlocks() === 1 ? "" : "s"}
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
                    <div class="guide-record-actions">
                      <button
                        class="button button-outline"
                        type="button"
                        disabled={!canEdit()}
                        onClick={() =>
                          setEditor({ record, templateId: field(record, "template_id", "general") })
                        }
                      >
                        Edit
                      </button>
                      <Show when={field(record, "approval_state", "draft") !== "approved"}>
                        <button
                          class="button button-quiet"
                          type="button"
                          disabled={!canEdit() || staleBlocks() > 0 || props.busy}
                          onClick={() => props.onApprove(record)}
                        >
                          Approve
                        </button>
                      </Show>
                      <button
                        class="button button-quiet"
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onExport(record, "markdown")}
                      >
                        Markdown
                      </button>
                      <button
                        class="button button-quiet"
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onExport(record, "html")}
                      >
                        HTML
                      </button>
                      <details class="guide-export-menu">
                        <summary class="button button-quiet">More</summary>
                        <div class="guide-export-menu-popover" aria-label="More guide exports">
                          <button
                            class="button button-quiet"
                            type="button"
                            disabled={!canEdit() || props.busy}
                            onClick={() => openRegeneration(record)}
                          >
                            Regenerate from latest evidence
                          </button>
                          <button
                            class="button button-quiet"
                            type="button"
                            disabled={props.busy}
                            onClick={() => props.onExport(record, "json")}
                          >
                            JSON record
                          </button>
                          <button
                            class="button button-quiet"
                            type="button"
                            disabled={props.busy}
                            onClick={() => props.onExport(record, "docx")}
                          >
                            Word document
                          </button>
                          <button
                            class="button button-quiet"
                            type="button"
                            disabled={props.busy}
                            onClick={() => props.onExport(record, "pdf")}
                          >
                            PDF / Print
                          </button>
                        </div>
                      </details>
                      <button
                        class="icon-button guide-trash-button"
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
            customTemplates={customTemplates()}
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
  customTemplates: GuideTemplate[];
  disabled: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: GuideDraft, current: ArchiveRecord | null) => Promise<boolean>;
}): JSX.Element {
  // The editor is mounted with keyed Show for the selected record, so its initial draft is a snapshot.
  /* eslint-disable solid/reactivity */
  const [draft, setDraft] = createSignal<GuideDraft>(
    props.initialDraft ??
      initialGuideDraft(props.record, props.sessions, props.templateId, props.customTemplates),
  );
  /* eslint-enable solid/reactivity */
  const [error, setError] = createSignal("");
  const selectedSession = createMemo(() =>
    props.sessions.find((session) => session.id === draft().sessionId),
  );
  const selectedEntry = createMemo(() =>
    props.entries.find((entry) => entry.id === draft().entryId),
  );

  function updateSection(
    index: number,
    update: (section: GuideDraft["sections"][number]) => GuideDraft["sections"][number],
  ): void {
    setDraft((current) => ({
      ...current,
      sections: current.sections.map((section, i) => (i === index ? update(section) : section)),
    }));
  }

  function updateBlock(
    sectionIndex: number,
    blockIndex: number,
    update: (block: GuideBlockDraft) => GuideBlockDraft,
  ): void {
    updateSection(sectionIndex, (section) => ({
      ...section,
      blocks: section.blocks.map((block, i) => (i === blockIndex ? update(block) : block)),
    }));
  }

  function selectTemplate(templateId: string): void {
    setDraft((current) => ({
      ...current,
      templateId,
      sections: current.sections.every((section) =>
        section.blocks.every((block) => !block.text.trim()),
      )
        ? templateSections(templateId, props.customTemplates)
        : current.sections,
    }));
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setError("");
    try {
      const saved = await props.onSave(draft(), props.record);
      if (saved) props.onClose();
      else setError("Guide could not be saved. See the workspace notice for details.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The guide could not be saved.");
    }
  }

  return (
    <div
      class="dialog-backdrop guide-editor-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onClose();
      }}
    >
      <section
        class="guide-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-editor-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) props.onClose();
        }}
      >
        <header class="guide-editor-header">
          <div>
            <span class="eyebrow">A GUIDE BUILT FROM YOUR WORK</span>
            <h2 id="guide-editor-title">
              {props.record
                ? "Shape this study guide"
                : props.initialDraft
                  ? "Review a generated guide"
                  : "Start a study guide"}
            </h2>
            <p>
              Sections are a scaffold. Keep citations attached as you make the material your own.
            </p>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label="Close guide editor"
            disabled={props.busy}
            onClick={() => props.onClose()}
          >
            ×
          </button>
        </header>
        <form class="guide-editor-form" onSubmit={(event) => void submit(event)}>
          <div class="guide-editor-fields">
            <label class="form-field guide-title-field">
              Guide title
              <input
                value={draft().title}
                maxlength="240"
                required
                onInput={(event) =>
                  setDraft((current) => ({ ...current, title: event.currentTarget.value }))
                }
              />
            </label>
            <Show when={draft().sessionId}>
              <label class="form-field">
                Session
                <select
                  required
                  value={draft().sessionId}
                  onChange={(event) => {
                    const session = props.sessions.find(
                      (item) => item.id === event.currentTarget.value,
                    );
                    setDraft((current) => ({
                      ...current,
                      sessionId: event.currentTarget.value,
                      entryId: session ? field(session, "entry_id") : "",
                      title: props.record
                        ? current.title
                        : session
                          ? `${field(session, "title", "Tutoring Session")} — Study Guide`
                          : current.title,
                    }));
                  }}
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
                        student ? field(student, "display_name") : "Independent",
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
            <label class="form-field">
              Structure
              <select
                value={draft().templateId}
                onChange={(event) => selectTemplate(event.currentTarget.value)}
              >
                <Show
                  when={
                    !allTemplates(props.customTemplates).some(
                      (template) => template.id === draft().templateId,
                    )
                  }
                >
                  <option value={draft().templateId}>Saved template · {draft().templateId}</option>
                </Show>
                <For each={allTemplates(props.customTemplates)}>
                  {(template) => <option value={template.id}>{template.name}</option>}
                </For>
              </select>
            </label>
          </div>

          <Show
            when={draft().sessionId && selectedSession()}
            fallback={
              <Show when={draft().entryId}>
                <div class="guide-session-context">
                  <span class="guide-context-mark">J</span>
                  <div>
                    <strong>
                      {selectedEntry()
                        ? field(selectedEntry()!, "title", "Journal entry")
                        : "Journal entry unavailable"}
                    </strong>
                    <small>Entry-wide guide · linked sessions and notes</small>
                  </div>
                </div>
              </Show>
            }
          >
            <div class="guide-session-context">
              <span class="guide-context-mark">S</span>
              <div>
                <strong>{field(selectedSession()!, "title", "Tutoring session")}</strong>
                <small>
                  {field(selectedSession()!, "subject", "Session source")}
                  {field(selectedSession()!, "learning_objectives")
                    ? ` · ${field(selectedSession()!, "learning_objectives")}`
                    : ""}
                </small>
              </div>
            </div>
          </Show>

          <div class="guide-sections-heading">
            <div>
              <span class="eyebrow">YOUR MATERIAL</span>
              <h3>Sections and blocks</h3>
            </div>
            <span>{draft().sections.length} sections</span>
          </div>
          <div class="guide-editor-sections">
            <For each={draft().sections}>
              {(section, sectionIndex) => (
                <article class="guide-editor-section">
                  <div class="guide-editor-section-heading">
                    <span class="guide-section-index">
                      {String(sectionIndex() + 1).padStart(2, "0")}
                    </span>
                    <label class="form-field">
                      Section heading
                      <input
                        value={section.heading}
                        maxlength="256"
                        onInput={(event) =>
                          updateSection(sectionIndex(), (current) => ({
                            ...current,
                            heading: event.currentTarget.value,
                          }))
                        }
                      />
                    </label>
                    <button
                      class="button button-quiet guide-remove-section"
                      type="button"
                      disabled={draft().sections.length <= 1}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          sections: current.sections.filter((_, index) => index !== sectionIndex()),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                  <div class="guide-block-list">
                    <For each={section.blocks}>
                      {(block, blockIndex) => (
                        <div class="guide-block-editor">
                          <div class="guide-block-toolbar">
                            <label>
                              Block style
                              <select
                                value={block.kind}
                                onChange={(event) =>
                                  updateBlock(sectionIndex(), blockIndex(), (current) => ({
                                    ...current,
                                    kind: event.currentTarget.value as GuideBlockDraft["kind"],
                                    stale: false,
                                    origin:
                                      current.origin === "ai-generated"
                                        ? "human-edited"
                                        : current.origin,
                                  }))
                                }
                              >
                                <For each={GUIDE_BLOCK_KINDS}>
                                  {(kind) => (
                                    <option value={kind}>{kind.replaceAll("-", " ")}</option>
                                  )}
                                </For>
                              </select>
                            </label>
                            <label>
                              Origin
                              <select
                                value={block.origin}
                                onChange={(event) =>
                                  updateBlock(sectionIndex(), blockIndex(), (current) => ({
                                    ...current,
                                    origin: event.currentTarget.value as GuideBlockDraft["origin"],
                                  }))
                                }
                              >
                                <For each={GUIDE_BLOCK_ORIGINS}>
                                  {(origin) => (
                                    <option value={origin}>{origin.replaceAll("-", " ")}</option>
                                  )}
                                </For>
                              </select>
                            </label>
                            <Show when={block.stale}>
                              <span class="guide-stale-label">
                                Source changed · review this block
                              </span>
                            </Show>
                            <button
                              class="icon-button"
                              type="button"
                              title="Remove block"
                              aria-label="Remove block"
                              onClick={() =>
                                updateSection(sectionIndex(), (current) => ({
                                  ...current,
                                  blocks: current.blocks.filter(
                                    (_, index) => index !== blockIndex(),
                                  ),
                                }))
                              }
                            >
                              ×
                            </button>
                          </div>
                          <textarea
                            rows={4}
                            value={block.text}
                            placeholder="Write the explanation, example, prompt, or practice note…"
                            onInput={(event) =>
                              updateBlock(sectionIndex(), blockIndex(), (current) => ({
                                ...current,
                                text: event.currentTarget.value,
                                stale: false,
                                origin:
                                  current.origin === "ai-generated"
                                    ? "human-edited"
                                    : "human-edited",
                              }))
                            }
                          />
                          <div class="guide-source-row">
                            <label class="form-field">
                              Cited source IDs
                              <input
                                value={block.sourceIds}
                                placeholder="Paste archive IDs, separated by commas"
                                onInput={(event) =>
                                  updateBlock(sectionIndex(), blockIndex(), (current) => ({
                                    ...current,
                                    sourceIds: event.currentTarget.value,
                                    stale: false,
                                  }))
                                }
                              />
                            </label>
                            <label class="form-field">
                              Attach source
                              <select
                                value=""
                                onChange={(event) => {
                                  const id = event.currentTarget.value;
                                  if (!id) return;
                                  updateBlock(sectionIndex(), blockIndex(), (current) => ({
                                    ...current,
                                    sourceIds: appendSourceId(current.sourceIds, id),
                                  }));
                                  event.currentTarget.value = "";
                                }}
                              >
                                <option value="">Choose a guide source…</option>
                                <For
                                  each={sourceOptions(
                                    props.sourceRecords,
                                    selectedSession(),
                                    draft().sessionId ? undefined : selectedEntry(),
                                  )}
                                >
                                  {(source) => <option value={source.id}>{source.label}</option>}
                                </For>
                              </select>
                            </label>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                  <button
                    class="button button-quiet guide-add-block"
                    type="button"
                    onClick={() =>
                      updateSection(sectionIndex(), (current) => ({
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
                      }))
                    }
                  >
                    + Add a content block
                  </button>
                </article>
              )}
            </For>
          </div>
          <button
            class="button button-outline guide-add-section"
            type="button"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                sections: [
                  ...current.sections,
                  { id: crypto.randomUUID(), heading: "New section", blocks: [] },
                ],
              }))
            }
          >
            + Add section
          </button>
          <Show when={error()}>
            <p class="guide-editor-error" role="alert">
              {error()}
            </p>
          </Show>
          <footer class="guide-editor-footer">
            <span>
              Saving creates a new archive revision. The previous version stays available in the
              archive history.
            </span>
            <div>
              <button
                class="button button-quiet"
                type="button"
                disabled={props.busy}
                onClick={() => props.onClose()}
              >
                Cancel
              </button>
              <button
                class="button button-primary"
                type="submit"
                disabled={props.disabled || props.busy || (!draft().sessionId && !draft().entryId)}
              >
                {props.busy ? "Saving…" : props.record ? "Save changes" : "Save draft"}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

function templateSections(
  templateId: string,
  customTemplates: readonly GuideTemplate[],
): GuideDraft["sections"] {
  const template = allTemplates(customTemplates).find((item) => item.id === templateId);
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
  customTemplates: readonly GuideTemplate[],
): GuideDraft {
  if (record) return guideDraftFromRecord(record);
  const firstSession = sessions[0];
  const template = allTemplates(customTemplates).find((item) => item.id === templateId);
  if (template) {
    return firstSession
      ? createGuideDraftFromSections(firstSession, template.id, template.sections)
      : {
          title: "",
          sessionId: "",
          templateId: template.id,
          sections: templateSections(template.id, customTemplates),
        };
  }
  return firstSession
    ? createGuideDraft(firstSession, templateId)
    : {
        title: "",
        sessionId: "",
        templateId,
        sections: templateSections(templateId, customTemplates),
      };
}

function allTemplates(customTemplates: readonly GuideTemplate[]): GuideTemplate[] {
  return [...GUIDE_TEMPLATES, ...customTemplates];
}

function GuideTemplateEditor(props: {
  current: ArchiveRecord | null;
  busy: boolean;
  disabled: boolean;
  onClose: () => void;
  onSave: (input: GuideTemplateInput, current: ArchiveRecord | null) => Promise<boolean>;
}): JSX.Element {
  const existing = createMemo(() =>
    props.current ? guideTemplateFromRecord(props.current) : null,
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
    <div class="dialog-backdrop guide-editor-backdrop">
      <section
        class="guide-editor-dialog guide-template-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-template-editor-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) props.onClose();
        }}
      >
        <header class="guide-editor-header">
          <div>
            <span class="eyebrow">A STRUCTURE THAT'S YOURS</span>
            <h2 id="guide-template-editor-title">
              {props.current ? "Edit template" : "Create a template"}
            </h2>
            <p>Give a reusable teaching approach a name, clear sections, and a little guidance.</p>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label="Close template editor"
            disabled={props.busy}
            onClick={() => props.onClose()}
          >
            ×
          </button>
        </header>
        <form class="guide-editor-form" onSubmit={(event) => void submit(event)}>
          <div class="guide-template-form-fields">
            <label class="form-field">
              Template name
              <input name="name" maxlength="240" required value={existing()?.name ?? ""} />
            </label>
            <label class="form-field">
              Subject
              <input name="subject" maxlength="128" value={existing()?.subject ?? "general"} />
            </label>
            <label class="form-field guide-template-description-field">
              Short description
              <textarea
                name="description"
                rows="2"
                maxlength="4096"
                value={existing()?.description ?? ""}
              />
            </label>
            <label class="form-field guide-template-sections-field">
              Sections <span class="form-hint">One heading per line</span>
              <textarea
                name="sections"
                rows="8"
                required
                maxlength="64000"
                value={existing()?.sections.join("\n") ?? "Session overview\nKey ideas\nNext steps"}
              />
            </label>
            <label class="form-field guide-template-description-field">
              Writing guidance <span class="form-hint">Optional</span>
              <textarea name="body" rows="4" maxlength="100000" value={existing()?.body ?? ""} />
            </label>
          </div>
          <Show when={error()}>
            <p class="form-error" role="alert">
              {error()}
            </p>
          </Show>
          <footer class="guide-editor-footer">
            <span>Saved in this archive and available on Windows, macOS, Linux, and web.</span>
            <div>
              <button
                class="button button-quiet"
                type="button"
                disabled={props.busy}
                onClick={() => props.onClose()}
              >
                Cancel
              </button>
              <button
                class="button button-primary"
                type="submit"
                disabled={props.disabled || props.busy}
              >
                {props.busy ? "Saving…" : props.current ? "Save changes" : "Save template"}
              </button>
            </div>
          </footer>
        </form>
      </section>
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
    : `Edited ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}
