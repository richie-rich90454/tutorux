(() => {
  "use strict";

  const bridge = window.tutoruxJournalBridge;
  if (!bridge) return;

  const byId = (id) => document.getElementById(id);
  const ui = {
    entries: byId("journal-entries"),
    resultCount: byId("journal-result-count"),
    error: byId("journal-error"),
    errorMessage: byId("journal-error-message"),
    errorDismiss: byId("journal-error-dismiss"),
    search: byId("journal-search"),
    sort: byId("journal-sort"),
    filters: byId("journal-filter-details"),
    filterCount: byId("journal-filter-count"),
    collectionFilter: byId("journal-collection-filter"),
    tagFilter: byId("journal-tag-filter"),
    fromFilter: byId("journal-from-filter"),
    toFilter: byId("journal-to-filter"),
    sessionFilter: byId("journal-session-filter"),
    collectionNav: byId("collection-nav"),
    entryTitle: byId("entry-title"),
    entryDate: byId("entry-date"),
    entryTaxonomy: byId("entry-taxonomy"),
    notes: byId("entry-notes"),
    richNotes: byId("entry-notes-editor"),
    notesToolbar: byId("notes-toolbar"),
    notesSourceToggle: byId("notes-markdown-toggle"),
    notesEditorMode: byId("notes-editor-mode"),
    notesStatus: byId("notes-save-status"),
    notesRevision: byId("notes-revision"),
    saveState: byId("entry-save-state"),
    timeline: byId("entry-session-timeline"),
    timelineDate: byId("timeline-date-filter"),
    timelineDateClear: byId("timeline-date-clear"),
    timelineDateStatus: byId("timeline-date-status"),
    sessionDetails: byId("entry-session-details"),
    sessionWorkspace: byId("session-workspace"),
    guideSourceScope: byId("guide-source-scope"),
    guideSession: byId("guide-session"),
    guideEntryScope: byId("guide-entry-scope"),
    relatedGuides: byId("entry-related-guides"),
    entryDialog: byId("entry-create-dialog"),
    entryCreateForm: byId("entry-create-form"),
    newEntryTitle: byId("new-entry-title"),
    newEntryDate: byId("new-entry-date"),
    sessionDialog: byId("session-start-dialog"),
    sessionStartForm: byId("session-start-form"),
    sessionStartStudent: byId("session-start-student"),
    newSessionStudentPanel: byId("session-new-student-panel"),
    newSessionStudentName: byId("session-new-student-name"),
    newSessionStudentGrade: byId("session-new-student-grade"),
    sessionStartSubject: byId("session-start-subject"),
    sessionStartName: byId("session-start-name"),
    sessionStartObjectives: byId("session-start-objectives"),
    sessionDeleteDialog: byId("session-delete-dialog"),
    sessionDeleteScope: byId("session-delete-scope"),
    sessionDeleteWarning: byId("session-delete-warning"),
    sessionDeleteConfirm: byId("session-delete-confirm"),
    recordingConsent: byId("session-recording-consent"),
    recordingCheckPanel: byId("recording-check-panel"),
    recordingImportPanel: byId("recording-import-panel"),
    microphoneStatus: byId("microphone-check-status"),
    microphoneLevel: byId("microphone-level"),
    createNotesSession: byId("create-notes-session"),
    startRecordingSession: byId("start-recording-session"),
    importRecordingSession: byId("import-recording-session"),
    recordingFile: byId("new-session-recording"),
    taxonomyDialog: byId("taxonomy-dialog"),
    entryCollections: byId("entry-collections"),
    entryTags: byId("entry-tags"),
    studentProgressStudent: byId("student-progress-student"),
    studentProgressStatus: byId("student-progress-status"),
    studentProgressSessions: byId("student-progress-sessions"),
    studentProgressHistory: byId("student-progress-history"),
    studentProfileForm: byId("student-profile-form"),
    studentProfileName: byId("student-profile-name"),
    studentProfileGrade: byId("student-profile-grade"),
    studentProfileSubjects: byId("student-profile-subjects"),
    studentProfileTemplate: byId("student-profile-template"),
    studentProfileObjectives: byId("student-profile-objectives"),
    studentProfileDifficulties: byId("student-profile-difficulties"),
    studentProfileImprovements: byId("student-profile-improvements"),
    studentProfileNotes: byId("student-profile-notes"),
    studentProgressForm: byId("student-progress-form"),
    studentProgressSkill: byId("student-progress-skill"),
    studentProgressClassification: byId("student-progress-classification"),
    studentProgressEvidence: byId("student-progress-evidence"),
    studentProgressReviewer: byId("student-progress-reviewer"),
    studentProgressNote: byId("student-progress-note"),
    managedCollections: byId("managed-collections"),
    managedTags: byId("managed-tags"),
    palette: byId("command-palette"),
    paletteSearch: byId("command-palette-search"),
    paletteActions: byId("command-palette-actions"),
    topbarRecording: byId("topbar-recording-indicator"),
  };

  const state = {
    entries: [],
    allEntries: [],
    collections: [],
    tags: [],
    sessions: [],
    guides: [],
    entryId: "",
    entry: null,
    documentId: "",
    lastNotes: "",
    notesDraftMarkdown: "",
    richNotesDirty: false,
    notesSourceMode: false,
    noteTimer: 0,
    saveInFlight: false,
    searchTimer: 0,
    refreshTimer: 0,
    journalRequest: 0,
    entryListScroll: 0,
    returnFocusEntryId: "",
    currentView: "journal",
    expandedSessionId: "",
    quickMarkerShortcuts: ["1", "2", "3", "4", "5", "6", "m"],
    quickMarkerShortcutRequest: 0,
    recordingSessionId: "",
    recordingStartedAt: 0,
    guideEntryScopeError: "",
    pendingRecordingStream: null,
    microphoneContext: null,
    microphoneAnalyser: null,
    microphoneAnimation: 0,
    microphoneReady: false,
    errorReturnFocus: null,
    studentProgressStudents: [],
    studentProgressEvidenceRows: [],
    studentProgressSessions: new Map(),
    studentProgressSelectedId: "",
    studentProgressRequest: 0,
    sessionDeleteTarget: "",
    sessionDeleteScopeToken: "",
  };

  const quickMarkerTypes = [
    ["important-concept", "Important concept"],
    ["student-mistake", "Student misconception"],
    ["tutor-correction", "Tutor correction"],
    ["explicit-instruction", "Tutor instruction"],
    ["worked-example", "Worked example"],
    ["follow-up-priority", "Follow-up priority"],
    ["general-note", "Tutor note"],
  ];

  function showJournalError(message) {
    if (!ui.error || !ui.errorMessage) return;
    if (ui.error.hidden) state.errorReturnFocus = document.activeElement;
    ui.errorMessage.textContent = String(message || "The journal action could not be completed.");
    ui.error.hidden = false;
    const openDialog = document.querySelector("dialog[open]");
    if (openDialog && !openDialog.contains(ui.error)) openDialog.append(ui.error);
    const transientNotice = byId("notice");
    if (transientNotice) transientNotice.hidden = true;
  }

  if (ui.sessionWorkspace && ui.sessionDetails) {
    ui.sessionDetails.append(ui.sessionWorkspace);
    ui.sessionWorkspace.hidden = true;
  }

  function responseRows(response, names = []) {
    const output = String(response?.output || "");
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) return parsed;
      for (const name of ["records", ...names]) {
        if (Array.isArray(parsed?.[name])) return parsed[name];
      }
    } catch {
      return [];
    }
    return [];
  }

  function responseRecord(response) {
    const output = String(response?.output || "").trim();
    try {
      const parsed = JSON.parse(output);
      if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
        return parsed.entry || parsed.session || parsed.record || parsed;
      }
    } catch {
      const firstObject = output.indexOf("{");
      if (firstObject >= 0) {
        try {
          const parsed = JSON.parse(output.slice(firstObject));
          return parsed.entry || parsed.session || parsed.record || parsed;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function field(record, ...keys) {
    for (const key of keys) {
      const value = record?.[key];
      if (value !== undefined && value !== null && value !== "") return value;
      const nested = record?.metadata?.[key] ?? record?.fields?.[key];
      if (nested !== undefined && nested !== null && nested !== "") return nested;
    }
    return "";
  }

  function idList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item?.id || item)).filter(Boolean);
    if (value && typeof value === "object") return Object.values(value).map(String).filter(Boolean);
    return String(value || "").split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
  }

  function entryCollections(entry) {
    return idList(field(entry, "collection_ids", "collections"));
  }

  function entryTags(entry) {
    return idList(field(entry, "tag_ids", "tags"));
  }

  function titleOf(record, fallback = "Untitled entry") {
    return String(field(record, "title", "name", "display_name") || fallback);
  }

  function dateValue(value) {
    const raw = String(value || "");
    const iso = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (iso) return iso;
    const parsed = timestampDate(value);
    if (!parsed) return "";
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function timestampDate(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value))) {
      const numeric = Number(value);
      const milliseconds = numeric > 1e14 ? numeric / 1000 : numeric > 1e11 ? numeric : numeric * 1000;
      const date = new Date(milliseconds);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12);
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function prettyDate(value, options = {}) {
    const date = timestampDate(value);
    if (!date) return "Date not set";
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: options.month || "short",
      ...(options.weekday ? { weekday: options.weekday } : {}),
      ...(options.year ? { year: "numeric" } : {}),
    }).format(date);
  }

  function prettyDateTime(value) {
    const date = timestampDate(value);
    if (!date) return "Time not recorded";
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function monthLabel(value) {
    const date = timestampDate(value);
    return date
      ? new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date)
      : "Undated entries";
  }

  function optionList(select, records, placeholder, selected = []) {
    if (!select) return;
    const selectedSet = new Set(selected.map(String));
    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    select.replaceChildren(first);
    for (const record of records) {
      const option = document.createElement("option");
      option.value = String(field(record, "id", "uuid"));
      option.textContent = titleOf(record, "Untitled");
      option.selected = selectedSet.has(option.value);
      select.append(option);
    }
  }

  function selectedIds(select) {
    return [...(select?.selectedOptions || [])].map((option) => option.value).filter(Boolean);
  }

  function showView(name) {
    state.currentView = name;
    const panelName = name === "entry" ? "entry" : name;
    for (const panel of document.querySelectorAll("[data-panel]")) {
      panel.classList.toggle("is-visible", panel.dataset.panel === panelName);
    }
    for (const button of document.querySelectorAll("[data-view]")) {
      const active = button.dataset.view === (name === "entry" ? "journal" : name);
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (name !== "journal") window.scrollTo(0, 0);
  }

  function emptyMessage(title, description, actions = false) {
    const panel = document.createElement("div");
    panel.className = "journal-empty";
    const rule = document.createElement("span");
    rule.className = "journal-empty-rule";
    rule.setAttribute("aria-hidden", "true");
    const heading = document.createElement("h2");
    heading.textContent = title;
    const body = document.createElement("p");
    body.textContent = description;
    panel.append(rule, heading, body);
    if (actions) {
      const controls = document.createElement("div");
      controls.className = "empty-actions";
      for (const [label, id] of [["Open archive", "open-archive"], ["Create archive", "create-archive"]]) {
        const button = document.createElement("button");
        button.className = "button button-outline";
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => byId(id)?.click());
        controls.append(button);
      }
      panel.append(controls);
    }
    return panel;
  }

  async function readCommand(command) {
    return bridge.read([...command, "--json"]);
  }

  function updateQuickMarkerHelp() {
    const help = byId("quick-marker-help");
    const button = byId("quick-marker");
    if (!help || !button) return;
    const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
    const shortcuts = quickMarkerTypes.map(([type, label], index) =>
      `${modifier}+${state.quickMarkerShortcuts[index]} ${label.toLowerCase()}`,
    );
    help.textContent = `Add a marker without interrupting notes. Shortcuts: ${shortcuts.join(" · ")}.`;
    button.title = `Add a tutor note at the current recording position (${modifier}+${state.quickMarkerShortcuts[6]})`;
  }

  async function loadQuickMarkerShortcuts() {
    const requestId = ++state.quickMarkerShortcutRequest;
    const defaults = ["1", "2", "3", "4", "5", "6", "m"];
    state.quickMarkerShortcuts = defaults;
    updateQuickMarkerHelp();
    if (!bridge.archiveOpen()) return;
    try {
      const response = await readCommand(["settings", "get", "annotation.quick_marker_shortcuts"]);
      if (requestId !== state.quickMarkerShortcutRequest || !bridge.archiveOpen()) return;
      const record = responseRecord(response);
      const value = String(field(record, "value") || "");
      const parsed = value.split(",").map((shortcut) => shortcut.trim());
      const valid = parsed.length === defaults.length && parsed.every((shortcut) =>
        /^[\x21-\x7e]$/.test(shortcut),
      );
      const normalized = valid
        ? parsed.map((shortcut) => shortcut.toLocaleLowerCase())
        : defaults;
      if (new Set(normalized).size === normalized.length) {
        state.quickMarkerShortcuts = normalized;
      }
      updateQuickMarkerHelp();
    } catch {
      // Archives without the optional shortcut setting use the documented defaults.
    }
  }

  async function writeCommand(command) {
    const response = await bridge.write([...command, "--json"]);
    if (response?.archive_persistence_error) {
      throw new Error(response.archive_persistence_error);
    }
    return response;
  }

  function collectionName(id) {
    const found = state.collections.find((record) => String(field(record, "id", "uuid")) === String(id));
    return found ? titleOf(found, "Collection") : "Collection";
  }

  function tagName(id) {
    const found = state.tags.find((record) => String(field(record, "id", "uuid")) === String(id));
    return found ? titleOf(found, "Tag") : "Tag";
  }

  function renderTaxonomyChips(container, record) {
    container.replaceChildren();
    for (const id of entryCollections(record)) {
      const chip = document.createElement("span");
      chip.className = "taxonomy-token";
      chip.textContent = collectionName(id);
      container.append(chip);
    }
    for (const id of entryTags(record)) {
      const chip = document.createElement("span");
      chip.className = "taxonomy-token";
      chip.textContent = tagName(id);
      container.append(chip);
    }
    if (!container.childElementCount) {
      const optional = document.createElement("span");
      optional.className = "sidebar-empty";
      optional.textContent = "No collections or tags";
      container.append(optional);
    }
  }

  function renderCollectionNavigation() {
    if (!ui.collectionNav) return;
    ui.collectionNav.replaceChildren();
    const all = document.createElement("button");
    all.className = `nav-item collection-filter-link${!ui.collectionFilter.value ? " is-active" : ""}`;
    all.type = "button";
    all.textContent = "All entries";
    all.setAttribute("aria-pressed", String(!ui.collectionFilter.value));
    all.addEventListener("click", () => {
      ui.collectionFilter.value = "";
      ui.filters.open = true;
      void refreshJournal();
    });
    ui.collectionNav.append(all);
    if (!state.collections.length) {
      const empty = document.createElement("span");
      empty.className = "sidebar-empty";
      empty.textContent = "Add a collection when it helps.";
      ui.collectionNav.append(empty);
      return;
    }
    for (const collection of state.collections) {
      const id = String(field(collection, "id", "uuid"));
      const button = document.createElement("button");
      button.className = `nav-item collection-filter-link${ui.collectionFilter.value === id ? " is-active" : ""}`;
      button.type = "button";
      button.textContent = titleOf(collection, "Untitled collection");
      button.title = button.textContent;
      button.setAttribute("aria-pressed", String(ui.collectionFilter.value === id));
      button.addEventListener("click", () => {
        ui.collectionFilter.value = id;
        ui.filters.open = true;
        void refreshJournal();
      });
      ui.collectionNav.append(button);
    }
  }

  function renderManagedTerms(container, records, noun, commandName) {
    container.replaceChildren();
    if (!records.length) {
      const empty = document.createElement("span");
      empty.className = "sidebar-empty";
      empty.textContent = `No ${noun.toLowerCase()}s yet.`;
      container.append(empty);
      return;
    }
    for (const record of records) {
      const id = String(field(record, "id", "uuid"));
      const row = document.createElement("div");
      row.className = "taxonomy-record";
      const name = document.createElement("span");
      name.textContent = titleOf(record, `Untitled ${noun.toLowerCase()}`);
      const actions = document.createElement("span");
      actions.className = "taxonomy-record-actions";
      const rename = document.createElement("button");
      rename.className = "text-button";
      rename.type = "button";
      rename.textContent = "Rename";
      rename.addEventListener("click", async () => {
        const nextName = window.prompt(`Rename ${noun.toLowerCase()}`, titleOf(record));
        if (!nextName?.trim()) return;
        try {
          await writeCommand(["journal", commandName, "update", id, "--name", nextName.trim()]);
          await loadTaxonomy();
          if (state.entryId) await loadEntry(state.entryId, true);
        } catch (error) {
          showJournalError(error.message);
        }
      });
      const remove = document.createElement("button");
      remove.className = "text-button destructive-action";
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        const accepted = window.confirm(
          `Delete “${titleOf(record)}”? Existing journal entries remain, and their collection or tag link will be removed.`,
        );
        if (!accepted) return;
        try {
          await writeCommand(["journal", commandName, "delete", id]);
          await loadTaxonomy();
          if (state.entryId) await loadEntry(state.entryId, true);
        } catch (error) {
          showJournalError(error.message);
        }
      });
      actions.append(rename, remove);
      row.append(name, actions);
      container.append(row);
    }
  }

  async function loadTaxonomy() {
    if (!bridge.archiveOpen()) {
      state.collections = [];
      state.tags = [];
      return;
    }
    const [collectionsResponse, tagsResponse] = await Promise.all([
      readCommand(["journal", "collection", "list"]),
      readCommand(["journal", "tag", "list"]),
    ]);
    state.collections = responseRows(collectionsResponse, ["collections"]);
    state.tags = responseRows(tagsResponse, ["tags"]);
    const selectedCollection = ui.collectionFilter.value;
    const selectedTag = ui.tagFilter.value;
    optionList(ui.collectionFilter, state.collections, "All collections", [selectedCollection]);
    optionList(ui.tagFilter, state.tags, "All tags", [selectedTag]);
    ui.collectionFilter.options[0].textContent = "All collections";
    ui.tagFilter.options[0].textContent = "All tags";
    renderCollectionNavigation();
    renderManagedTerms(ui.managedCollections, state.collections, "Collection", "collection");
    renderManagedTerms(ui.managedTags, state.tags, "Tag", "tag");
  }

  function readFilters() {
    return {
      query: ui.search.value.trim(),
      collection: ui.collectionFilter.value,
      tag: ui.tagFilter.value,
      from: ui.fromFilter.value,
      to: ui.toFilter.value,
      sessions: ui.sessionFilter.value,
    };
  }

  function entryListCommand(filters) {
    const command = ["journal", "entry", "list"];
    if (filters.query) command.push("--query", filters.query);
    if (filters.collection) command.push("--collection-id", filters.collection);
    if (filters.tag) command.push("--tag-id", filters.tag);
    if (filters.from) command.push("--from", filters.from);
    if (filters.to) command.push("--to", filters.to);
    if (filters.sessions !== "all") command.push("--has-sessions", filters.sessions === "yes" ? "true" : "false");
    return command;
  }

  function populateGuideEntryScope(entries = state.allEntries) {
    if (!ui.guideEntryScope) return;
    const selectedId = ui.guideEntryScope.value || state.entryId;
    const availableEntries = [...entries];
    if (state.entry && !availableEntries.some((entry) => String(field(entry, "id", "uuid")) === state.entryId)) {
      availableEntries.unshift(state.entry);
    }
    optionList(ui.guideEntryScope, availableEntries, "Choose a journal entry", [selectedId]);
    updateGuideSourceControls();
  }

  function updateGuideSourceControls() {
    if (!ui.guideSourceScope || !ui.guideSession || !ui.guideEntryScope) return;
    const archiveAvailable = bridge.archiveOpen();
    const entryOption = ui.guideSourceScope.querySelector('option[value="entry"]');
    if (entryOption) entryOption.disabled = Boolean(state.guideEntryScopeError);
    if (state.guideEntryScopeError && ui.guideSourceScope.value === "entry") {
      ui.guideSourceScope.value = "session";
    }
    const entryMode = ui.guideSourceScope.value === "entry" && !state.guideEntryScopeError;
    ui.guideSourceScope.disabled = !archiveAvailable;
    ui.guideSession.hidden = entryMode;
    ui.guideSession.disabled = !archiveAvailable || entryMode;
    ui.guideSession.required = !entryMode;
    ui.guideEntryScope.hidden = !entryMode;
    ui.guideEntryScope.disabled = !archiveAvailable || Boolean(state.guideEntryScopeError);
    ui.guideEntryScope.required = entryMode;
    if (state.guideEntryScopeError) {
      ui.guideEntryScope.replaceChildren(new Option("Entry-wide generation unavailable", ""));
      ui.guideEntryScope.title = state.guideEntryScopeError;
      ui.guideEntryScope.setAttribute("aria-label", `Entry-wide generation unavailable: ${state.guideEntryScopeError}`);
    } else {
      ui.guideEntryScope.removeAttribute("title");
      ui.guideEntryScope.setAttribute("aria-label", "Choose a journal entry");
    }
  }

  function createdValue(entry) {
    return field(entry, "created_at", "created_at_us", "created_timestamp", "creation_time") ||
      field(entry, "entry_date", "date", "display_date");
  }

  function sortTime(record) {
    const date = timestampDate(createdValue(record));
    return date ? date.getTime() : 0;
  }

  function entrySessionCount(entry) {
    const direct = Number(field(entry, "session_count", "sessions_count"));
    if (Number.isFinite(direct) && direct >= 0) return direct;
    return idList(field(entry, "session_ids", "sessions")).length;
  }

  function renderEntryList(records) {
    ui.entries.replaceChildren();
    if (!records.length) {
      const filters = readFilters();
      const hasFilters = filters.query || filters.collection || filters.tag || filters.from || filters.to || filters.sessions !== "all";
      ui.entries.append(emptyMessage(
        hasFilters ? "No entries match these filters." : "No journal entries yet.",
        hasFilters ? "Clear a filter or try a broader search." : "Create your first entry, then add sessions whenever you teach.",
      ));
      return;
    }

    const groups = new Map();
    if (ui.sort.value === "title") {
      groups.set("title", records);
    } else {
      for (const record of records) {
        const chronologicalDate = createdValue(record);
        const key = dateValue(chronologicalDate).slice(0, 7) || "undated";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
      }
    }

    for (const [month, entries] of groups) {
      const group = document.createElement("section");
      group.className = "journal-month-group";
      const heading = document.createElement("h2");
      heading.className = "journal-month-heading";
      heading.textContent = month === "title"
        ? "Entries A–Z"
        : monthLabel(month === "undated" ? "" : `${month}-01`);
      const number = document.createElement("span");
      number.textContent = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
      heading.append(number);
      group.append(heading);

      for (const record of entries) {
        const id = String(field(record, "id", "uuid"));
        const date = field(record, "entry_date", "date", "display_date") || createdValue(record);
        const row = document.createElement("article");
        row.className = "journal-entry-row";
        const dateCell = document.createElement("time");
        dateCell.className = "journal-entry-date";
        if (dateValue(date)) dateCell.dateTime = dateValue(date);
        const day = document.createElement("strong");
        day.textContent = date ? prettyDate(date) : "—";
        const weekday = document.createElement("span");
        const parsedDate = timestampDate(date);
        weekday.textContent = parsedDate
          ? new Intl.DateTimeFormat(undefined, { weekday: "short", year: "numeric" }).format(parsedDate)
          : "Date not set";
        dateCell.append(day, weekday);
        const open = document.createElement("button");
        open.className = "journal-entry-open";
        open.type = "button";
        open.dataset.entryId = id;
        open.setAttribute("aria-label", `Open ${titleOf(record)}`);
        const title = document.createElement("strong");
        title.textContent = titleOf(record);
        const summary = document.createElement("span");
        summary.className = "journal-entry-summary";
        summary.textContent = String(field(record, "summary", "notes_preview", "excerpt") || "Open this entry to review teaching notes and sessions.");
        open.append(title, summary);
        open.addEventListener("click", () => void openEntry(id));

        const meta = document.createElement("div");
        meta.className = "journal-entry-meta";
        const subject = field(record, "subject", "student_name");
        if (subject) {
          const term = document.createElement("span");
          term.textContent = String(subject);
          meta.append(term);
        }
        for (const collectionId of entryCollections(record).slice(0, 2)) {
          const token = document.createElement("span");
          token.className = "taxonomy-token";
          token.textContent = collectionName(collectionId);
          meta.append(token);
        }
        for (const tagId of entryTags(record).slice(0, 3)) {
          const token = document.createElement("span");
          token.className = "taxonomy-token";
          token.textContent = tagName(tagId);
          meta.append(token);
        }
        if (meta.childElementCount) open.append(meta);

        const sessionCount = entrySessionCount(record);
        const count = document.createElement("span");
        count.className = "journal-entry-count";
        count.textContent = sessionCount ? `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}` : "No sessions";
        row.append(dateCell, open, count);
        group.append(row);
      }
      ui.entries.append(group);
    }
  }

  async function refreshJournal() {
    const requestId = ++state.journalRequest;
    if (!bridge.archiveOpen()) {
      ui.entries.setAttribute("aria-busy", "false");
      ui.entries.replaceChildren(emptyMessage(
        "Your teaching record starts here.",
        "Open a .tux archive or create one. Each entry can hold notes and any number of tutoring sessions.",
        true,
      ));
      ui.resultCount.textContent = "Open or create a portable archive to begin.";
      ui.collectionNav.replaceChildren();
      state.entries = [];
      state.allEntries = [];
      populateGuideEntryScope();
      return;
    }
    const filters = readFilters();
    ui.entries.setAttribute("aria-busy", "true");
    ui.resultCount.textContent = "Searching the journal…";
    try {
      const needsUnfilteredEntries = Boolean(
        filters.query || filters.collection || filters.tag || filters.from || filters.to || filters.sessions !== "all",
      );
      const [entriesResponse, allEntriesResult] = await Promise.all([
        readCommand(entryListCommand(filters)),
        needsUnfilteredEntries
          ? readCommand(["journal", "entry", "list"]).then(
            (response) => ({ response }),
            (error) => ({ error }),
          )
          : Promise.resolve({ response: null }),
        loadTaxonomy(),
      ]);
      if (requestId !== state.journalRequest) return;
      let records = responseRows(entriesResponse, ["entries"]);
      if (ui.sort.value === "oldest") {
        records.sort((left, right) => sortTime(left) - sortTime(right));
      } else if (ui.sort.value === "title") {
        records.sort((left, right) => titleOf(left).localeCompare(titleOf(right)));
      } else {
        records.sort((left, right) => sortTime(right) - sortTime(left));
      }
      state.entries = records;
      state.guideEntryScopeError = allEntriesResult.error?.message || "";
      state.allEntries = allEntriesResult.response
        ? responseRows(allEntriesResult.response, ["entries"])
        : [...records];
      populateGuideEntryScope();
      renderEntryList(records);
      ui.entries.setAttribute("aria-busy", "false");
      const activeFilters = [filters.collection, filters.tag, filters.from, filters.to, filters.sessions !== "all" ? filters.sessions : ""]
        .filter(Boolean).length;
      ui.filterCount.textContent = activeFilters ? ` · ${activeFilters} active` : "";
      ui.resultCount.textContent = `${records.length} ${records.length === 1 ? "entry" : "entries"}` +
        (filters.query ? ` matching “${filters.query}”` : " in this journal");
    } catch (error) {
      if (requestId !== state.journalRequest) return;
      ui.entries.setAttribute("aria-busy", "false");
      ui.resultCount.textContent = "Journal could not be loaded.";
      ui.entries.replaceChildren(emptyMessage(
        "This archive could not return its journal.",
        `${error.message} Keep the archive open; you can retry after the journal command is available.`,
      ));
      showJournalError(`Journal could not be loaded: ${error.message}`);
    }
  }

  function setEntryTaxonomy() {
    renderTaxonomyChips(ui.entryTaxonomy, state.entry || {});
  }

  function documentText(documentRecord) {
    const value = field(documentRecord, "text", "markdown", "body", "content");
    if (typeof value === "string") return value;
    const blocks = documentRecord?.blocks || documentRecord?.nodes || [];
    if (Array.isArray(blocks)) {
      return blocks.map((block) => String(block.text || block.content || "")).join("\n\n");
    }
    return "";
  }

  function renderRelatedGuides() {
    ui.relatedGuides.replaceChildren();
    const guideIds = idList(field(state.entry, "study_guide_ids", "guide_ids"));
    const candidates = state.guides.filter((guide) =>
      guideIds.includes(String(field(guide, "id", "uuid"))) ||
      String(field(guide, "entry_id")) === state.entryId,
    );
    if (!candidates.length) {
      const empty = document.createElement("span");
      empty.className = "sidebar-empty";
      empty.textContent = "No study guides are linked to this entry yet.";
      ui.relatedGuides.append(empty);
      return;
    }
    for (const guide of candidates) {
      const button = document.createElement("button");
      button.className = "related-guide-link";
      button.type = "button";
      button.textContent = titleOf(guide, "Study guide");
      const stateLabel = document.createElement("span");
      stateLabel.textContent = field(guide, "approval_state") || "Draft";
      button.append(stateLabel);
      button.addEventListener("click", () => {
        document.querySelector('[data-view="guides"]')?.click();
        const activeGuide = byId("active-guide");
        if (activeGuide) {
          activeGuide.value = String(field(guide, "id", "uuid"));
          activeGuide.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      ui.relatedGuides.append(button);
    }
  }

  function sessionStartValue(session) {
    return field(session, "started_at", "started_at_us", "created_at", "created_at_us", "start_time");
  }

  function sessionDuration(session) {
    const microseconds = Number(field(session, "duration_us", "recording_duration_us", "duration_microseconds"));
    if (Number.isFinite(microseconds) && microseconds > 0) {
      const minutes = Math.round(microseconds / 60_000_000);
      return `${minutes} min`;
    }
    const seconds = Number(field(session, "duration_seconds", "duration"));
    if (Number.isFinite(seconds) && seconds > 0) return `${Math.round(seconds / 60)} min`;
    const start = timestampDate(sessionStartValue(session));
    const end = timestampDate(field(session, "ended_at", "ended_at_us"));
    if (start && end && end >= start) return `${Math.round((end - start) / 60000)} min`;
    return "Duration not recorded";
  }

  function hasRecordedAudio(session) {
    const recordingCount = Number(field(session, "recording_count", "recording_segment_count"));
    const identifiedRecordings = idList(field(session, "recording_ids", "recordings")).length;
    const audioPresent = field(session, "has_audio");
    const hasAudioFlag = audioPresent === true || String(audioPresent).toLowerCase() === "true";
    const audioChunks = Number(field(
      session,
      "audio_chunks_imported",
      "audio_chunk_count",
      "recording_audio_chunks",
    ));
    const audioDuration = Number(field(session, "audio_duration_us", "recording_duration_us"));
    return hasAudioFlag || recordingCount > 0 || identifiedRecordings > 0 ||
      audioChunks > 0 || audioDuration > 0 ||
      Boolean(field(session, "recording_id")) ||
      ["available", "recorded", "imported", "complete", "completed", "partial"].includes(
        String(field(session, "audio_state", "recording_state")),
      );
  }

  function recordingSummary(session) {
    const count = Number(field(session, "recording_count", "recording_segment_count")) ||
      idList(field(session, "recording_ids", "recordings")).length;
    const hasAudio = hasRecordedAudio(session);
    const hasTranscript = Boolean(field(session, "transcript_id")) ||
      Number(field(session, "transcript_segment_count", "transcript_count")) > 0;
    const parts = [];
    if (hasAudio) parts.push(count > 1 ? `${count} recording segments` : "Audio");
    if (hasTranscript) parts.push("Transcript");
    if (!hasAudio && !hasTranscript) parts.push("Notes only");
    return parts.join(" and ");
  }

  function renderTimeline(sessions) {
    ui.timeline.replaceChildren();
    if (!sessions.length) {
      const empty = document.createElement("li");
      empty.className = "timeline-empty";
      empty.textContent = "No sessions yet. Add a session whenever teaching begins.";
      ui.timeline.append(empty);
      if (ui.timelineDateStatus) ui.timelineDateStatus.textContent = "No sessions in this entry.";
      if (ui.timelineDateClear) ui.timelineDateClear.hidden = !ui.timelineDate?.value;
      ui.sessionDetails.replaceChildren();
      if (ui.sessionWorkspace) ui.sessionWorkspace.hidden = true;
      state.expandedSessionId = "";
      return;
    }
    const ordered = [...sessions].sort((left, right) =>
      (timestampDate(sessionStartValue(right))?.getTime() || 0) -
      (timestampDate(sessionStartValue(left))?.getTime() || 0),
    );
    const selectedDate = ui.timelineDate?.value || "";
    const visibleSessions = selectedDate
      ? ordered.filter((session) => dateValue(sessionStartValue(session)) === selectedDate)
      : ordered;
    if (ui.timelineDateClear) ui.timelineDateClear.hidden = !selectedDate;
    if (ui.timelineDateStatus) {
      ui.timelineDateStatus.textContent = selectedDate
        ? `${visibleSessions.length} ${visibleSessions.length === 1 ? "session" : "sessions"} on ${prettyDate(selectedDate, { year: true })}.`
        : `Showing all ${ordered.length} ${ordered.length === 1 ? "session" : "sessions"}.`;
    }
    if (state.expandedSessionId &&
        !visibleSessions.some((session) => String(field(session, "id", "uuid")) === state.expandedSessionId) &&
        state.recordingSessionId !== state.expandedSessionId) {
      state.expandedSessionId = "";
      if (ui.sessionWorkspace) ui.sessionWorkspace.hidden = true;
    }
    if (!visibleSessions.length) {
      const empty = document.createElement("li");
      empty.className = "timeline-empty";
      empty.textContent = `No sessions on ${prettyDate(selectedDate, { year: true })}. Choose another date or show all dates.`;
      ui.timeline.append(empty);
    }
    for (const session of visibleSessions) {
      const id = String(field(session, "id", "uuid"));
      const item = document.createElement("li");
      item.className = "timeline-item";
      if (state.recordingSessionId === id) item.classList.add("is-recording");
      const details = document.createElement("details");
      details.className = "timeline-session";
      details.open = state.expandedSessionId === id;
      const summary = document.createElement("summary");
      const title = document.createElement("span");
      title.className = "timeline-session-title";
      title.textContent = titleOf(session, "Tutoring session");
      const date = document.createElement("time");
      date.className = "timeline-session-meta";
      const startedAt = sessionStartValue(session);
      if (dateValue(startedAt)) date.dateTime = dateValue(startedAt);
      date.textContent = startedAt ? prettyDateTime(startedAt) : "Session time not recorded";
      const meta = document.createElement("span");
      meta.className = "timeline-session-meta";
      const lifecycle = String(
        field(session, "session_state", "state", "lifecycle_state") || "Created",
      );
      const audio = state.recordingSessionId === id ? "Recording now" : recordingSummary(session);
      meta.textContent = `${sessionDuration(session)} · ${audio} · ${lifecycle}`;
      summary.append(title, date, meta);
      details.append(summary);

      const information = document.createElement("div");
      information.className = "timeline-session-summary";
      information.textContent = String(field(session, "summary", "session_summary", "notes_preview") ||
        "Open this session to review its available notes and materials.");
      const actions = document.createElement("div");
      actions.className = "timeline-session-actions";
      const open = document.createElement("button");
      open.className = "button button-outline";
      open.type = "button";
      open.textContent = "Open session materials";
      open.addEventListener("click", (event) => {
        event.preventDefault();
        details.open = true;
        showSessionMaterials(id);
      });
      const review = document.createElement("button");
      review.className = "text-button";
      review.type = "button";
      review.textContent = "Review recording";
      review.hidden = !hasRecordedAudio(session);
      review.addEventListener("click", (event) => {
        event.preventDefault();
        details.open = true;
        showSessionMaterials(id);
        byId("browser-recording-status")?.scrollIntoView({ block: "center", behavior: "auto" });
      });
      actions.append(open, review);
      details.append(information, actions);
      details.addEventListener("toggle", () => {
        if (details.open) {
          state.expandedSessionId = id;
          void showSessionMaterials(id);
        } else if (state.expandedSessionId === id) {
          state.expandedSessionId = "";
          if (state.recordingSessionId !== id && ui.sessionWorkspace) ui.sessionWorkspace.hidden = true;
        }
      });
      item.append(details);
      ui.timeline.append(item);
    }
    if (state.expandedSessionId && ordered.some((session) => String(field(session, "id", "uuid")) === state.expandedSessionId)) {
      const expanded = [...ui.timeline.querySelectorAll("details")].find((item) => item.open);
      if (expanded) void showSessionMaterials(state.expandedSessionId);
    }
  }

  async function showSessionMaterials(sessionId) {
    if (!ui.sessionWorkspace || !sessionId) return;
    state.expandedSessionId = sessionId;
    ui.sessionWorkspace.hidden = false;
    if (ui.sessionWorkspace.parentElement !== ui.sessionDetails) {
      ui.sessionDetails.append(ui.sessionWorkspace);
    }
    bridge.selectSession(sessionId);
    renderSessionLifecycle(state.sessions.find((item) => String(field(item, "id", "uuid")) === sessionId));
  }

  function renderSessionLifecycle(session) {
    const id = String(field(session, "id", "uuid"));
    const lifecycle = String(
      field(session, "session_state", "state", "lifecycle_state") || "Created",
    );
    const stateLabel = byId("session-lifecycle-state");
    const recordingLabel = byId("session-recording-state");
    const complete = byId("session-complete");
    const review = byId("session-review");
    const resume = byId("session-resume");
    const remove = byId("session-delete-open");
    if (stateLabel) stateLabel.textContent = `${lifecycle[0]?.toUpperCase()}${lifecycle.slice(1)} session`;
    if (recordingLabel) {
      recordingLabel.textContent = state.recordingSessionId === id ? "Recording · microphone audio" : recordingSummary(session);
      recordingLabel.classList.toggle("is-recording", state.recordingSessionId === id);
    }
    if (complete) complete.hidden = lifecycle === "completed" || lifecycle === "reviewed";
    if (review) review.hidden = lifecycle !== "completed";
    if (resume) resume.hidden = !["completed", "reviewed"].includes(lifecycle);
    if (remove) remove.disabled = !id || state.recordingSessionId === id;
  }

  async function loadEntry(entryId, preserveNotes = false) {
    if (!entryId) return;
    if (state.entryId !== entryId && ui.timelineDate) ui.timelineDate.value = "";
    state.entryId = entryId;
    updateArchiveControls();
    state.saveInFlight = false;
    ui.saveState.textContent = "Loading archive record…";
    ui.saveState.className = "entry-save-state is-saving";
    try {
      const entryResponse = await readCommand(["journal", "entry", "show", entryId]);
      const entry = responseRecord(entryResponse);
      if (!entry) throw new Error("The journal entry response was empty or unreadable.");
      state.entry = entry;
      const previousText = ui.notes.value;
      const title = titleOf(entry);
      ui.entryTitle.value = title;
      ui.entryDate.value = dateValue(field(entry, "entry_date", "date", "display_date"));
      byId("entry-taxonomy-form").hidden = false;
      byId("taxonomy-title").textContent = "Organize this entry";
      setEntryTaxonomy();
      state.documentId = String(field(entry, "notes_document_id", "document_id", "notes_id"));
      if (state.documentId) {
        const documentResponse = await readCommand(["journal", "document", "show", state.documentId]);
        const documentRecord = responseRecord(documentResponse) || {};
        const text = documentText(documentRecord);
        ui.notes.value = preserveNotes && previousText !== state.lastNotes ? previousText : text;
        state.lastNotes = text;
        const revision = field(documentRecord, "revision", "revision_number", "version");
        ui.notesRevision.textContent = revision ? `Revision ${revision}` : "Archive document";
      } else {
        ui.notes.value = "";
        state.lastNotes = "";
        ui.notesRevision.textContent = "Notes document unavailable";
      }
      state.notesDraftMarkdown = ui.notes.value;
      state.richNotesDirty = false;
      renderMarkdownEditor(state.notesDraftMarkdown);
      updateNotesEditingState();
      const [sessionsResponse, guidesResponse] = await Promise.all([
        readCommand(["session", "list", "--entry-id", entryId]),
        readCommand(["guide", "list"]),
      ]);
      state.sessions = responseRows(sessionsResponse, ["sessions"]);
      state.guides = responseRows(guidesResponse, ["guides"]);
      renderTimeline(state.sessions);
      renderRelatedGuides();
      ui.saveState.textContent = "Archive record loaded";
      ui.saveState.className = "entry-save-state";
      ui.notesStatus.textContent = "Notes are stored in this journal archive.";
      const existingSessions = state.sessions;
      if (ui.guideSession) optionList(ui.guideSession, existingSessions, "Choose a session");
      if (ui.guideEntryScope) populateGuideEntryScope();
    } catch (error) {
      ui.saveState.textContent = "Could not load entry";
      ui.saveState.className = "entry-save-state is-error";
      showJournalError(error.message);
    }
  }

  async function openEntry(entryId) {
    const cameFromJournalLink = document.activeElement?.closest?.(".journal-entry-open");
    state.entryListScroll = window.scrollY;
    state.returnFocusEntryId = String(entryId);
    showView("entry");
    await loadEntry(entryId);
    if (cameFromJournalLink && !ui.entryTitle.disabled) ui.entryTitle.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function returnToJournal() {
    showView("journal");
    window.scrollTo(0, state.entryListScroll);
    const returnTarget = [...ui.entries.querySelectorAll(".journal-entry-open")]
      .find((button) => button.dataset.entryId === state.returnFocusEntryId);
    (returnTarget || ui.entries).focus?.({ preventScroll: true });
    state.returnFocusEntryId = "";
  }

  async function createEntry(event) {
    event.preventDefault();
    const title = ui.newEntryTitle.value.trim();
    if (!title) return;
    const command = ["journal", "entry", "create", "--title", title];
    if (ui.newEntryDate.value) command.push("--date", ui.newEntryDate.value);
    try {
      ui.entryCreateForm.querySelector('[type="submit"]').disabled = true;
      const response = await writeCommand(command);
      const created = responseRecord(response);
      const newId = String(field(created, "id", "uuid"));
      ui.entryDialog.close();
      ui.entryCreateForm.reset();
      await refreshJournal();
      if (newId) {
        await openEntry(newId);
      } else {
        const latest = [...state.entries].sort((left, right) =>
          sortTime(right) - sortTime(left),
        )[0];
        if (latest) await openEntry(String(field(latest, "id", "uuid")));
      }
      ui.entryTitle.focus();
      ui.entryTitle.select();
    } catch (error) {
      showJournalError(error.message);
    } finally {
      const button = ui.entryCreateForm.querySelector('[type="submit"]');
      if (button) button.disabled = !bridge.archiveOpen();
    }
  }

  async function saveEntryTitle(event) {
    event.preventDefault();
    if (!state.entryId) return;
    const title = ui.entryTitle.value.trim();
    if (!title) {
      ui.entryTitle.focus();
      return;
    }
    try {
      await writeCommand(["journal", "entry", "update", state.entryId, "--title", title]);
      ui.saveState.textContent = "Entry title saved";
      ui.saveState.className = "entry-save-state";
      await refreshJournal();
    } catch (error) {
      ui.saveState.textContent = "Title not saved";
      ui.saveState.className = "entry-save-state is-error";
      showJournalError(error.message);
    }
  }

  async function saveEntryDate() {
    if (!state.entryId || !ui.entryDate.value) return;
    ui.saveState.textContent = "Saving date…";
    ui.saveState.className = "entry-save-state is-saving";
    try {
      await writeCommand(["journal", "entry", "update", state.entryId, "--date", ui.entryDate.value]);
      state.entry.entry_date = ui.entryDate.value;
      ui.saveState.textContent = "Entry date saved";
      ui.saveState.className = "entry-save-state";
      await refreshJournal();
    } catch (error) {
      ui.saveState.textContent = "Date not saved";
      ui.saveState.className = "entry-save-state is-error";
      showJournalError(error.message);
    }
  }

  async function saveNotes() {
    if (!state.documentId || state.saveInFlight || ui.notes.value === state.lastNotes) return;
    state.saveInFlight = true;
    ui.notesStatus.textContent = "Saving document transaction…";
    ui.saveState.textContent = "Saving notes…";
    ui.saveState.className = "entry-save-state is-saving";
    const text = ui.notes.value;
    try {
      const response = await writeCommand([
        "journal", "document", "update", state.documentId, "--text", text,
      ]);
      state.lastNotes = text;
      const updated = responseRecord(response);
      const revision = field(updated, "revision", "revision_number", "version");
      if (revision) ui.notesRevision.textContent = `Revision ${revision}`;
      ui.notesStatus.textContent = `Saved to the archive · ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
      ui.saveState.textContent = "Notes saved";
      ui.saveState.className = "entry-save-state";
      bridge.setDirty(true);
    } catch (error) {
      ui.notesStatus.textContent = `Save failed: ${error.message}`;
      ui.saveState.textContent = "Notes not saved";
      ui.saveState.className = "entry-save-state is-error";
      showJournalError(error.message);
    } finally {
      state.saveInFlight = false;
      if (ui.notes.value !== state.lastNotes) {
        ui.notesStatus.textContent = "Unsaved edits";
        if (ui.notes.value !== text) {
          window.clearTimeout(state.noteTimer);
          state.noteTimer = window.setTimeout(() => void saveNotes(), 1100);
        }
      }
    }
  }

  function scheduleNotesSave() {
    ui.notesStatus.textContent = "Unsaved edits";
    ui.saveState.textContent = "Editing notes";
    ui.saveState.className = "entry-save-state is-saving";
    bridge.setDirty(true);
    window.clearTimeout(state.noteTimer);
    state.noteTimer = window.setTimeout(() => void saveNotes(), 1100);
  }

  function openEntryTaxonomy() {
    const entryForm = byId("entry-taxonomy-form");
    entryForm.hidden = !state.entryId;
    byId("taxonomy-title").textContent = state.entryId ? "Organize this entry" : "Collections and tags";
    if (state.entryId) populateEntryTaxonomy();
    ui.taxonomyDialog.showModal();
  }

  function populateEntryTaxonomy() {
    optionList(ui.entryCollections, state.collections, "No collections", entryCollections(state.entry));
    optionList(ui.entryTags, state.tags, "No tags", entryTags(state.entry));
    for (const select of [ui.entryCollections, ui.entryTags]) {
      const first = select.options[0];
      first.disabled = true;
      first.selected = false;
    }
  }

  async function saveEntryTaxonomy(event) {
    event.preventDefault();
    if (!state.entryId) return;
    try {
      await writeCommand([
        "journal", "entry", "update", state.entryId,
        "--collection-ids", selectedIds(ui.entryCollections).join(","),
        "--tag-ids", selectedIds(ui.entryTags).join(","),
      ]);
      ui.taxonomyDialog.close();
      await loadTaxonomy();
      await loadEntry(state.entryId, true);
      await refreshJournal();
    } catch (error) {
      showJournalError(error.message);
    }
  }

  function openNewEntry() {
    if (!bridge.archiveOpen()) {
      showJournalError("Open or create a .tux archive before creating an entry.");
      return;
    }
    ui.newEntryDate.value = new Date().toLocaleDateString("en-CA");
    ui.entryDialog.showModal();
    ui.newEntryTitle.focus();
  }

  function clearMicrophoneCheck() {
    if (state.microphoneAnimation) cancelAnimationFrame(state.microphoneAnimation);
    state.microphoneAnimation = 0;
    if (state.microphoneContext) void state.microphoneContext.close().catch(() => {});
    state.microphoneContext = null;
    state.microphoneAnalyser = null;
    ui.microphoneLevel.style.width = "0%";
    ui.microphoneLevel.parentElement.classList.remove("is-hot");
  }

  function releasePendingStream() {
    if (state.pendingRecordingStream) {
      state.pendingRecordingStream.getTracks().forEach((track) => track.stop());
      state.pendingRecordingStream = null;
    }
    window.tutoruxPendingRecordingStream = null;
    clearMicrophoneCheck();
    state.microphoneReady = false;
  }

  function updateMicMeter() {
    if (!state.microphoneAnalyser) return;
    const samples = new Uint8Array(state.microphoneAnalyser.fftSize);
    state.microphoneAnalyser.getByteTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      energy += normalized * normalized;
    }
    const rms = Math.sqrt(energy / samples.length);
    const level = Math.max(0, Math.min(100, Math.round(rms * 330)));
    ui.microphoneLevel.style.width = `${level}%`;
    ui.microphoneLevel.parentElement.classList.toggle("is-hot", level > 76);
    state.microphoneAnimation = requestAnimationFrame(updateMicMeter);
  }

  async function checkMicrophone() {
    if (!ui.recordingConsent.checked) {
      ui.microphoneStatus.textContent = "Confirm permission before checking the microphone.";
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia ||
        !window.AudioContext || typeof AudioWorkletNode === "undefined") {
      ui.microphoneStatus.textContent = "Microphone capture needs a secure browser with AudioWorklet support.";
      return;
    }
    releasePendingStream();
    ui.microphoneStatus.textContent = "Requesting microphone access…";
    try {
      state.pendingRecordingStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const AudioContextType = window.AudioContext;
      if (AudioContextType) {
        state.microphoneContext = new AudioContextType();
        await state.microphoneContext.resume();
        const source = state.microphoneContext.createMediaStreamSource(state.pendingRecordingStream);
        state.microphoneAnalyser = state.microphoneContext.createAnalyser();
        state.microphoneAnalyser.fftSize = 512;
        source.connect(state.microphoneAnalyser);
        updateMicMeter();
      }
      state.microphoneReady = true;
      ui.microphoneStatus.textContent = "Microphone ready. Confirm again to start recording; this check has not captured a session.";
      ui.startRecordingSession.disabled = false;
    } catch (error) {
      state.microphoneReady = false;
      ui.microphoneStatus.textContent = `Microphone access was not granted: ${error.message}`;
      ui.startRecordingSession.disabled = true;
    }
  }

  function selectSessionKind(kind) {
    const selected = ui.sessionStartForm.querySelector(`input[name="session-kind"][value="${kind}"]`);
    if (selected) selected.checked = true;
    ui.recordingCheckPanel.hidden = kind !== "record-audio";
    ui.recordingImportPanel.hidden = kind !== "import-recording";
    ui.createNotesSession.hidden = kind !== "notes-only";
    ui.startRecordingSession.hidden = kind !== "record-audio";
    ui.importRecordingSession.hidden = kind !== "import-recording";
    ui.startRecordingSession.disabled = kind !== "record-audio" || !state.microphoneReady;
    ui.importRecordingSession.disabled = kind !== "import-recording" || !ui.recordingFile.files?.length;
    if (kind !== "record-audio") releasePendingStream();
  }

  function openSessionDialog() {
    if (!state.entryId) {
      showJournalError("Open a journal entry before starting a session.");
      return;
    }
    releasePendingStream();
    ui.sessionStartForm.reset();
    ui.sessionStartStudent.replaceChildren(new Option("Anonymous session", ""));
    for (const student of state.studentProgressStudents) {
      const studentId = String(field(student, "id", "uuid"));
      const option = new Option(
        titleOf(student, "Unnamed student"),
        studentId,
      );
      ui.sessionStartStudent.append(option);
    }
    ui.sessionStartStudent.append(new Option("Create a new student…", "__new__"));
    ui.newSessionStudentPanel.hidden = true;
    ui.sessionStartSubject.value = String(field(state.entry, "subject") || "");
    selectSessionKind("notes-only");
    ui.microphoneStatus.textContent = "Microphone access is not checked.";
    ui.createNotesSession.hidden = false;
    ui.createNotesSession.disabled = false;
    ui.startRecordingSession.hidden = true;
    ui.importRecordingSession.hidden = true;
    ui.startRecordingSession.disabled = true;
    ui.importRecordingSession.disabled = true;
    ui.recordingCheckPanel.hidden = true;
    ui.recordingImportPanel.hidden = true;
    byId("session-entry-context").textContent = `Adding a session to “${titleOf(state.entry)}”. Choose how you would like to begin.`;
    ui.sessionDialog.showModal();
    ui.sessionStartForm.querySelector('input[name="session-kind"][value="notes-only"]').focus();
  }

  function closeDialog(id) {
    if (id === "session-start-dialog") releasePendingStream();
    byId(id)?.close();
  }

  function parseCreatedId(response) {
    const record = responseRecord(response);
    return String(field(record, "id", "uuid", "session_id", "entry_id"));
  }

  async function createSession(kind) {
    if (!state.entryId) throw new Error("Open a journal entry before creating a session.");
    let studentId = ui.sessionStartStudent.value;
    if (studentId === "__new__") {
      const studentName = ui.newSessionStudentName.value.trim();
      if (!studentName) {
        ui.newSessionStudentName.focus();
        throw new Error("Enter a name for the new student before creating the session.");
      }
      const studentArgs = ["student", "create", "--name", studentName];
      if (ui.newSessionStudentGrade.value.trim()) {
        studentArgs.push("--grade", ui.newSessionStudentGrade.value.trim());
      }
      const studentResponse = await writeCommand(studentArgs);
      studentId = parseCreatedId(studentResponse);
      if (!studentId) throw new Error("The archive created the student but did not return an ID.");
    }
    const title = ui.sessionStartName.value.trim() ||
      `${titleOf(state.entry)} · Session ${state.sessions.length + 1}`;
    const response = await writeCommand([
      "session", "create", "--entry-id", state.entryId, "--type", kind,
      "--title", title,
      ...(studentId
        ? ["--student-id", studentId]
        : []),
      ...(ui.sessionStartSubject.value.trim()
        ? ["--subject", ui.sessionStartSubject.value.trim()]
        : []),
      ...(ui.sessionStartObjectives.value.trim()
        ? ["--objectives", ui.sessionStartObjectives.value.trim()]
        : []),
    ]);
    let sessionId = parseCreatedId(response);
    if (!sessionId) {
      const listResponse = await readCommand(["session", "list", "--entry-id", state.entryId]);
      const sessions = responseRows(listResponse, ["sessions"]);
      sessionId = String(field(sessions.sort((left, right) =>
        (timestampDate(createdValue(right) || sessionStartValue(right))?.getTime() || 0) -
        (timestampDate(createdValue(left) || sessionStartValue(left))?.getTime() || 0),
      )[0], "id", "uuid"));
    }
    if (!sessionId) throw new Error("The archive created a session but did not return its ID.");
    await writeCommand(["session", "start", sessionId]);
    state.expandedSessionId = sessionId;
    return sessionId;
  }

  async function createNotesSession() {
    ui.createNotesSession.disabled = true;
    try {
      const sessionId = await createSession("notes-only");
      ui.sessionDialog.close();
      await loadEntry(state.entryId, true);
      showView("entry");
      await showSessionMaterials(sessionId);
    } catch (error) {
      showJournalError(error.message);
    } finally {
      ui.createNotesSession.disabled = false;
    }
  }

  async function createRecordingSession() {
    ui.startRecordingSession.disabled = true;
    if (!state.microphoneReady || !state.pendingRecordingStream) {
      ui.startRecordingSession.disabled = false;
      ui.microphoneStatus.textContent = "Check the microphone before starting the recording.";
      return;
    }
    const stream = state.pendingRecordingStream;
    clearMicrophoneCheck();
    state.pendingRecordingStream = null;
    window.tutoruxPendingRecordingStream = stream;
    try {
      const sessionId = await createSession("record-audio");
      ui.sessionDialog.close();
      ui.recordingConsent.checked = true;
      await loadEntry(state.entryId, true);
      showView("entry");
      await showSessionMaterials(sessionId);
      await bridge.startRecording();
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      window.tutoruxPendingRecordingStream = null;
      ui.microphoneStatus.textContent = error.message;
      ui.startRecordingSession.disabled = false;
      showJournalError(error.message);
    }
  }

  async function createImportedSession() {
    const file = ui.recordingFile.files?.[0];
    if (!file) {
      showJournalError("Choose a WAV recording to import.");
      return;
    }
    if (file.size > 64 * 1024 * 1024) {
      showJournalError("Browser recording imports are limited to 64 MiB per file.");
      return;
    }
    ui.importRecordingSession.disabled = true;
    let inputPath = "";
    try {
      const sessionId = await createSession("import-recording");
      const safeName = file.name.replace(/[\\/\0]/g, "_").replace(/^\.+/, "_");
      inputPath = `/workspace/journal-recording-${Date.now()}-${safeName}`;
      const bytes = await file.arrayBuffer();
      await bridge.writeFile(inputPath, bytes);
      await writeCommand(["record", "import", "--session", sessionId, "--input", inputPath]);
      ui.sessionDialog.close();
      await loadEntry(state.entryId, true);
      showView("entry");
      await showSessionMaterials(sessionId);
      bridge.notice("Recording imported into the selected journal session.");
    } catch (error) {
      showJournalError(`${error.message} The session remains in the journal so you can retry the import.`);
    } finally {
      if (inputPath) {
        await bridge.removeFile(inputPath).catch(() => {});
      }
      ui.importRecordingSession.disabled = !ui.recordingFile.files?.length;
    }
  }

  async function transitionSession(action) {
    const sessionId = byId("active-session")?.value;
    if (!sessionId) return;
    try {
      await writeCommand(["session", action, sessionId]);
      await loadEntry(state.entryId, true);
      state.expandedSessionId = sessionId;
      await showSessionMaterials(sessionId);
    } catch (error) {
      showJournalError(error.message);
    }
  }

  async function openSessionDeleteDialog() {
    const sessionId = state.expandedSessionId;
    if (!sessionId) {
      showJournalError("Expand a session in the timeline before deleting it.");
      return;
    }
    if (sessionId === state.recordingSessionId) {
      showJournalError("Stop recording before deleting the session.");
      return;
    }
    state.sessionDeleteTarget = sessionId;
    state.sessionDeleteScopeToken = "";
    ui.sessionDeleteScope.textContent = "Inspecting linked recordings, notes, transcripts, guides, and references…";
    ui.sessionDeleteWarning.hidden = true;
    ui.sessionDeleteWarning.textContent = "";
    ui.sessionDeleteConfirm.disabled = true;
    ui.sessionDeleteDialog.showModal();
    try {
      const response = await readCommand(["session", "delete", sessionId, "--dry-run"]);
      if (state.sessionDeleteTarget !== sessionId || !ui.sessionDeleteDialog.open) return;
      const scope = responseRecord(response);
      const total = Number(field(scope, "total_records"));
      const linked = [
        ["audio_chunks", "audio chunks"],
        ["session_notes", "session notes"],
        ["transcript_segments", "transcript segments"],
        ["annotations", "annotations"],
        ["evidence_nodes", "evidence records"],
        ["guides", "study guides"],
        ["assets", "attachments"],
        ["entries_updated", "journal entries updated"],
      ].map(([key, label]) => `${Number(field(scope, key) || 0)} ${label}`);
      const session = state.sessions.find((item) => String(field(item, "id", "uuid")) === sessionId);
      ui.sessionDeleteScope.textContent = [
        `Session: ${titleOf(session, "Tutoring session")}`,
        `Total records affected: ${Number.isFinite(total) ? total : "unknown"}.`,
        ...linked,
      ].join("\n");
      state.sessionDeleteScopeToken = String(field(scope, "scope_token"));
      if (!state.sessionDeleteScopeToken) {
        throw new Error("The archive did not return a deletion confirmation token.");
      }
      ui.sessionDeleteConfirm.disabled = false;
    } catch (error) {
      if (!ui.sessionDeleteDialog.open) return;
      ui.sessionDeleteWarning.textContent = error.message;
      ui.sessionDeleteWarning.hidden = false;
      ui.sessionDeleteScope.textContent = "Tutorux could not prepare a safe deletion preview.";
    }
  }

  async function confirmSessionDelete() {
    const sessionId = state.sessionDeleteTarget;
    const scopeToken = state.sessionDeleteScopeToken;
    if (!sessionId || !scopeToken || sessionId === state.recordingSessionId) return;
    ui.sessionDeleteConfirm.disabled = true;
    ui.sessionDeleteWarning.hidden = true;
    ui.sessionDeleteScope.textContent = "Deleting the reviewed records…";
    try {
      await writeCommand([
        "session", "delete", sessionId,
        "--confirm-scope", "--scope-token", scopeToken,
      ]);
      ui.sessionDeleteDialog.close();
      state.expandedSessionId = "";
      bridge.selectSession("");
      await loadEntry(state.entryId, true);
      bridge.notice("The session and its reviewed linked records were deleted.");
    } catch (error) {
      const message = error.message;
      ui.sessionDeleteWarning.textContent = error.message;
      ui.sessionDeleteWarning.hidden = false;
      ui.sessionDeleteConfirm.disabled = true;
      state.sessionDeleteScopeToken = "";
      await openSessionDeleteDialog();
      ui.sessionDeleteWarning.textContent =
        `Deletion was not completed: ${message}. Review the refreshed scope before trying again.`;
      ui.sessionDeleteWarning.hidden = false;
    }
  }

  function timestampForRecording() {
    if (!state.recordingStartedAt) return "00:00:00";
    const seconds = Math.max(0, Math.floor((Date.now() - state.recordingStartedAt) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function addTimestampedNote() {
    if (!byId("active-session")?.value) {
      showJournalError("Choose a session before adding a timestamped note.");
      return;
    }
    byId("annotation-id").value = "";
    byId("annotation-title").value = "Session marker";
    byId("annotation-type").value = "general-note";
    byId("annotation-time").value = state.recordingSessionId ? timestampForRecording() : "00:00:00";
    byId("annotation-priority").value = "normal";
    byId("annotation-content").value = "";
    byId("annotation-save").textContent = "Save marker";
    byId("annotation-content").focus();
  }

  async function addQuickMarker(typeIndex = 6) {
    const sessionId = state.recordingSessionId || byId("active-session")?.value || "";
    if (!sessionId) {
      showJournalError("Choose a session before adding a quick marker.");
      return;
    }
    const [type, title] = quickMarkerTypes[typeIndex] || quickMarkerTypes[6];
    const timestamp = state.recordingSessionId === sessionId ? timestampForRecording() : "00:00:00";
    try {
      await writeCommand([
        "annotation", "add",
        "--session", sessionId,
        "--type", type,
        "--at", timestamp,
        "--priority", "normal",
        "--title", title,
        "--text", "",
      ]);
    } catch (error) {
      showJournalError(error.message);
    }
  }

  function safeNotesHref(value) {
    const href = String(value || "").trim();
    if (!href) return "";
    try {
      const parsed = new URL(href, window.location.href);
      return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? href : "";
    } catch {
      return "";
    }
  }

  function appendTextWithBreaks(parent, value) {
    const lines = String(value).split("\n");
    lines.forEach((line, index) => {
      if (index) parent.append(document.createElement("br"));
      if (line) parent.append(document.createTextNode(line));
    });
  }

  function appendInlineMarkdown(parent, markdown) {
    const source = String(markdown || "");
    const tokenPattern = /\\(.)|(\*\*|__)(.+?)\2|([*_])(.+?)\4|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let cursor = 0;
    let match;
    while ((match = tokenPattern.exec(source))) {
      appendTextWithBreaks(parent, source.slice(cursor, match.index));
      if (match[1]) {
        parent.append(document.createTextNode(match[1]));
      } else if (match[2]) {
        const strong = document.createElement("strong");
        appendInlineMarkdown(strong, match[3]);
        parent.append(strong);
      } else if (match[4]) {
        const emphasis = document.createElement("em");
        appendInlineMarkdown(emphasis, match[5]);
        parent.append(emphasis);
      } else if (match[6] !== undefined) {
        const code = document.createElement("code");
        code.textContent = match[6];
        parent.append(code);
      } else if (match[7] !== undefined) {
        const href = safeNotesHref(match[8]);
        if (!href) {
          appendInlineMarkdown(parent, match[7]);
        } else {
          const link = document.createElement("a");
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          appendInlineMarkdown(link, match[7]);
          parent.append(link);
        }
      }
      cursor = tokenPattern.lastIndex;
    }
    appendTextWithBreaks(parent, source.slice(cursor));
  }

  function createTaskToggle(checked = false) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "note-task-toggle";
    toggle.dataset.noteTaskToggle = "true";
    toggle.contentEditable = "false";
    toggle.setAttribute("role", "checkbox");
    toggle.setAttribute("aria-checked", String(checked));
    toggle.setAttribute("aria-label", checked ? "Mark task incomplete" : "Mark task complete");
    toggle.textContent = checked ? "✓" : "";
    return toggle;
  }

  function markdownBlockStart(line) {
    return /^\s*```/.test(line) || /^#{1,6}\s+/.test(line) ||
      /^\s*>/.test(line) || /^\s*(?:[-+*]|\d+[.)])\s+/.test(line) ||
      /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line);
  }

  function renderMarkdownBlocks(markdown, parent) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const block = document.createElement(`h${heading[1].length}`);
        appendInlineMarkdown(block, heading[2]);
        parent.append(block);
        index += 1;
        continue;
      }

      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
        parent.append(document.createElement("hr"));
        index += 1;
        continue;
      }

      const fence = line.match(/^\s*(```+)([^`]*)$/);
      if (fence) {
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^\s*```+\s*$/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        const language = fence[2].trim().split(/\s+/)[0];
        if (/^[a-zA-Z0-9_-]{1,32}$/.test(language)) code.dataset.language = language;
        code.textContent = codeLines.join("\n");
        pre.append(code);
        parent.append(pre);
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quotedLines = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quotedLines.push(lines[index].replace(/^\s*> ?/, ""));
          index += 1;
        }
        const quote = document.createElement("blockquote");
        renderMarkdownBlocks(quotedLines.join("\n"), quote);
        parent.append(quote);
        continue;
      }

      const firstList = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
      if (firstList) {
        const ordered = /^\d/.test(firstList[2]);
        const list = document.createElement(ordered ? "ol" : "ul");
        if (ordered) {
          const start = Number.parseInt(firstList[2], 10);
          if (Number.isFinite(start) && start > 1) list.start = start;
        }
        const indent = firstList[1].length;
        while (index < lines.length) {
          const itemMatch = lines[index].match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
          if (!itemMatch || itemMatch[1].length !== indent || /^\d/.test(itemMatch[2]) !== ordered) break;
          const item = document.createElement("li");
          const task = itemMatch[3].match(/^\[([ xX])\]\s*(.*)$/);
          if (task) {
            item.append(createTaskToggle(task[1].toLowerCase() === "x"));
            appendInlineMarkdown(item, task[2]);
          } else {
            appendInlineMarkdown(item, itemMatch[3]);
          }
          list.append(item);
          index += 1;
        }
        parent.append(list);
        continue;
      }

      const paragraphLines = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() && !markdownBlockStart(lines[index])) {
        paragraphLines.push(lines[index]);
        index += 1;
      }
      const paragraph = document.createElement("p");
      paragraphLines.forEach((paragraphLine, lineIndex) => {
        if (lineIndex) paragraph.append(document.createElement("br"));
        appendInlineMarkdown(paragraph, paragraphLine);
      });
      parent.append(paragraph);
    }
  }

  function renderMarkdownEditor(markdown) {
    if (!ui.richNotes) return;
    ui.richNotes.replaceChildren();
    renderMarkdownBlocks(markdown, ui.richNotes);
  }

  function escapeMarkdownText(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/([*_`\[\]{}#+.!|>])/g, "\\$1");
  }

  function serializeInlineMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeMarkdownText(node.nodeValue || "").replace(/\n/g, "  \n");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node;
    if (element.matches(".note-task-toggle")) return "";
    const tag = element.tagName;
    if (tag === "BR") return "  \n";
    const content = Array.from(element.childNodes).map(serializeInlineMarkdown).join("");
    if (tag === "STRONG" || tag === "B") return `**${content}**`;
    if (tag === "EM" || tag === "I") return `*${content}*`;
    if (tag === "CODE" && element.parentElement?.tagName !== "PRE") {
      return `\`${(element.textContent || "").replace(/`/g, "\\`")}\``;
    }
    if (tag === "A") {
      const href = safeNotesHref(element.getAttribute("href"));
      return href ? `[${content}](${href})` : content;
    }
    return content;
  }

  function serializeList(list, indent = "") {
    const ordered = list.tagName === "OL";
    const base = ordered && Number(list.start) > 1 ? Number(list.start) : 1;
    return Array.from(list.children).filter((item) => item.tagName === "LI").map((item, itemIndex) => {
      const taskToggle = Array.from(item.children).find((child) => child.matches(".note-task-toggle"));
      const nestedList = Array.from(item.children).find((child) => child.tagName === "UL" || child.tagName === "OL");
      const content = Array.from(item.childNodes)
        .filter((child) => child !== taskToggle && child !== nestedList)
        .map(serializeInlineMarkdown).join("").trim();
      const checked = taskToggle?.getAttribute("aria-checked") === "true";
      const marker = taskToggle ? `- [${checked ? "x" : " "}] ` : ordered ? `${base + itemIndex}. ` : "- ";
      const ownLine = `${indent}${marker}${content}`;
      if (!nestedList) return ownLine;
      return `${ownLine}\n${serializeList(nestedList, `${indent}  `)}`;
    }).join("\n");
  }

  function serializeMarkdownBlock(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node;
    const tag = element.tagName;
    if (tag === "HR") return "---";
    if (tag === "PRE") {
      const code = element.querySelector("code");
      const text = (code?.textContent ?? element.textContent ?? "").replace(/\n$/, "");
      let fence = "```";
      while (text.includes(fence)) fence += "`";
      const language = /^[a-zA-Z0-9_-]{1,32}$/.test(code?.dataset.language || "") ? code.dataset.language : "";
      return `${fence}${language}\n${text}\n${fence}`;
    }
    if (tag === "UL" || tag === "OL") return serializeList(element);
    if (tag === "BLOCKQUOTE") {
      const quoted = serializeMarkdownChildren(element);
      return quoted.split("\n").map((line) => line ? `> ${line}` : "> ").join("\n");
    }
    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return `${"#".repeat(level)} ${Array.from(element.childNodes).map(serializeInlineMarkdown).join("").trim()}`;
    }
    if (tag === "P" || tag === "DIV") {
      if (Array.from(element.children).some((child) => /^(?:P|DIV|UL|OL|BLOCKQUOTE|PRE|H[1-6])$/.test(child.tagName))) {
        return serializeMarkdownChildren(element);
      }
      return Array.from(element.childNodes).map(serializeInlineMarkdown).join("").trim();
    }
    return Array.from(element.childNodes).map(serializeInlineMarkdown).join("").trim();
  }

  function serializeMarkdownChildren(parent) {
    return Array.from(parent.childNodes).map(serializeMarkdownBlock).filter((block) => block !== "").join("\n\n");
  }

  function serializeMarkdownEditor() {
    return serializeMarkdownChildren(ui.richNotes).replace(/^\n+|\n+$/g, "");
  }

  function placeCaretAtEnd(element) {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function currentNotesBlock() {
    const selection = window.getSelection();
    let node = selection?.anchorNode || null;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!(node instanceof Element) || !ui.richNotes.contains(node)) return null;
    return node.closest("p,div,h1,h2,h3,h4,h5,h6,blockquote,li,pre") || null;
  }

  function currentNotesList() {
    const block = currentNotesBlock();
    return block?.closest("ul,ol") || null;
  }

  function addTaskToggles(list) {
    for (const item of list.querySelectorAll("li")) {
      if (!Array.from(item.children).some((child) => child.matches(".note-task-toggle"))) {
        item.prepend(createTaskToggle(false));
      }
    }
  }

  function updateNotesToolbarState() {
    if (state.notesSourceMode || !ui.richNotes || !ui.notesToolbar) return;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const inside = anchor && (anchor === ui.richNotes || ui.richNotes.contains(anchor));
    if (!inside) return;
    for (const action of ["bold", "italic"]) {
      const button = ui.notesToolbar.querySelector(`[data-note-action="${action}"]`);
      try {
        button?.setAttribute("aria-pressed", String(document.queryCommandState(action)));
      } catch {
        button?.setAttribute("aria-pressed", "false");
      }
    }
  }

  function updateNotesEditingState() {
    const editable = Boolean(bridge.archiveOpen() && state.entryId && state.documentId);
    ui.notes.disabled = !editable;
    ui.notes.hidden = !state.notesSourceMode;
    ui.richNotes.hidden = state.notesSourceMode;
    ui.richNotes.contentEditable = String(editable && !state.notesSourceMode);
    ui.richNotes.setAttribute("aria-disabled", String(!editable || state.notesSourceMode));
    ui.notesSourceToggle.disabled = !editable;
    ui.notesSourceToggle.setAttribute("aria-pressed", String(state.notesSourceMode));
    ui.notesSourceToggle.textContent = state.notesSourceMode ? "Use visual editor" : "Show Markdown";
    ui.notesEditorMode.textContent = state.notesSourceMode ? "Markdown source" : "Visual notes";
    ui.notesToolbar.classList.toggle("is-source-mode", state.notesSourceMode);
    for (const button of ui.notesToolbar.querySelectorAll("[data-note-action]")) {
      button.disabled = !editable;
    }
  }

  function handleRichNotesInput() {
    const markdown = serializeMarkdownEditor();
    if (markdown.length > ui.notes.maxLength) {
      renderMarkdownEditor(state.notesDraftMarkdown);
      placeCaretAtEnd(ui.richNotes);
      ui.notesStatus.textContent = `Notes are limited to ${ui.notes.maxLength.toLocaleString()} characters.`;
      return;
    }
    ui.notes.value = markdown;
    state.notesDraftMarkdown = markdown;
    state.richNotesDirty = true;
    scheduleNotesSave();
  }

  function handleMarkdownSourceInput() {
    state.notesDraftMarkdown = ui.notes.value;
    scheduleNotesSave();
  }

  function setNotesSourceMode(sourceMode) {
    if (state.notesSourceMode === sourceMode) return;
    if (sourceMode) {
      if (state.richNotesDirty) {
        const markdown = serializeMarkdownEditor();
        ui.notes.value = markdown;
        state.notesDraftMarkdown = markdown;
        state.richNotesDirty = false;
        scheduleNotesSave();
      }
    } else {
      state.notesDraftMarkdown = ui.notes.value;
      renderMarkdownEditor(ui.notes.value);
      state.richNotesDirty = false;
    }
    state.notesSourceMode = sourceMode;
    updateNotesEditingState();
    (sourceMode ? ui.notes : ui.richNotes).focus();
  }

  function sourceInsertMarkdown(before, after = before) {
    const area = ui.notes;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const selected = area.value.slice(start, end) || "text";
    area.setRangeText(`${before}${selected}${after}`, start, end, "select");
    state.notesDraftMarkdown = area.value;
    area.focus();
    scheduleNotesSave();
  }

  function sourcePrependMarkdown(prefix) {
    const area = ui.notes;
    const start = area.selectionStart;
    const lineStart = area.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    area.setRangeText(prefix, lineStart, lineStart, "end");
    state.notesDraftMarkdown = area.value;
    area.focus();
    scheduleNotesSave();
  }

  function applyNotesAction(action) {
    if (state.notesSourceMode) {
      if (action === "bold") sourceInsertMarkdown("**");
      else if (action === "italic") sourceInsertMarkdown("*");
      else sourcePrependMarkdown({ heading: "## ", list: "- ", quote: "> ", checklist: "- [ ] " }[action] || "");
      return;
    }
    ui.richNotes.focus();
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    if (!selection?.rangeCount || !anchor || (anchor !== ui.richNotes && !ui.richNotes.contains(anchor))) {
      placeCaretAtEnd(ui.richNotes);
    }
    if (action === "bold" || action === "italic") {
      document.execCommand(action, false);
    } else if (action === "heading") {
      const block = currentNotesBlock();
      document.execCommand("formatBlock", false, /^H[1-6]$/.test(block?.tagName || "") ? "p" : "h2");
    } else if (action === "quote") {
      const block = currentNotesBlock();
      document.execCommand("formatBlock", false, block?.closest("blockquote") ? "p" : "blockquote");
    } else if (action === "list") {
      document.execCommand("insertUnorderedList", false);
    } else if (action === "checklist") {
      document.execCommand("insertUnorderedList", false);
      const list = currentNotesList();
      if (list) addTaskToggles(list);
    }
    handleRichNotesInput();
    updateNotesToolbarState();
  }

  function insertQuoteIntoRichNotes(text, citation) {
    const quote = document.createElement("blockquote");
    const paragraphs = String(text).split("\n");
    paragraphs.forEach((line) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      quote.append(paragraph);
    });
    if (citation) {
      const source = document.createElement("p");
      source.textContent = `— ${citation}`;
      quote.append(source);
    }
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const block = anchor && (anchor === ui.richNotes || ui.richNotes.contains(anchor)) ? currentNotesBlock() : null;
    let topBlock = block;
    while (topBlock && topBlock.parentElement !== ui.richNotes) topBlock = topBlock.parentElement;
    if (topBlock?.parentElement === ui.richNotes) topBlock.after(quote);
    else ui.richNotes.append(quote);
    placeCaretAtEnd(quote);
    handleRichNotesInput();
  }

  function insertTextAtSelection(text) {
    if (document.execCommand("insertText", false, text)) return;
    let selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const range = selection?.rangeCount && anchor && (anchor === ui.richNotes || ui.richNotes.contains(anchor))
      ? selection.getRangeAt(0)
      : (() => {
          placeCaretAtEnd(ui.richNotes);
          selection = window.getSelection();
          return selection?.rangeCount ? selection.getRangeAt(0) : null;
        })();
    if (!range) return;
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    handleRichNotesInput();
  }

  function addPassageToNotes(event) {
    const { text, speaker, timestamp } = event.detail || {};
    const passage = String(text || "").trim();
    if (!passage || !state.entryId) {
      showJournalError("Open an entry and select a transcript passage first.");
      return;
    }
    const citation = [speaker, timestamp].filter(Boolean).join(" · ");
    if (state.notesSourceMode) {
      const quote = passage.split("\n").map((line) => `> ${line}`).join("\n");
      const addition = `\n\n${quote}${citation ? `\n> — ${citation}` : ""}`;
      const at = ui.notes.selectionStart === ui.notes.selectionEnd ? ui.notes.value.length : ui.notes.selectionStart;
      ui.notes.setRangeText(addition, at, at, "end");
      state.notesDraftMarkdown = ui.notes.value;
      ui.notes.focus();
      scheduleNotesSave();
    } else {
      insertQuoteIntoRichNotes(passage, citation);
      ui.richNotes.focus();
    }
    bridge.notice("Transcript passage added to the entry notes. Review the citation before sharing.");
  }

  function openPalette() {
    if (ui.palette.open) {
      ui.paletteSearch.focus();
      return;
    }
    ui.palette.showModal();
    ui.paletteSearch.value = "";
    filterPalette();
    ui.paletteSearch.focus();
  }

  function filterPalette() {
    const query = ui.paletteSearch.value.trim().toLocaleLowerCase();
    for (const action of ui.paletteActions.querySelectorAll("button")) {
      action.hidden = query && !action.textContent.toLocaleLowerCase().includes(query);
    }
  }

  function studentProgressLabel(classification) {
    return ({
      "newly-observed": "Newly observed",
      recurring: "Recurring",
      "partial-improvement": "Partial improvement",
      "demonstrated-mastery": "Demonstrated mastery",
      "unverified-improvement": "Unverified improvement",
      "not-revisited": "Not revisited",
    })[classification] || String(classification || "Unclassified");
  }

  function setStudentProgressStatus(message) {
    if (ui.studentProgressStatus) ui.studentProgressStatus.textContent = message;
  }

  function populateStudentProfile(studentId) {
    const student = state.studentProgressStudents.find((item) =>
      String(field(item, "id", "uuid")) === studentId,
    );
    if (!student) {
      ui.studentProfileForm.hidden = true;
      return;
    }
    ui.studentProfileName.value = String(field(student, "display_name", "name") || "");
    ui.studentProfileGrade.value = String(field(student, "grade") || "");
    ui.studentProfileSubjects.value = String(field(student, "subjects") || "");
    ui.studentProfileTemplate.value = String(field(student, "preferred_guide_template") || "");
    ui.studentProfileObjectives.value = String(field(student, "learning_objectives", "objectives") || "");
    ui.studentProfileDifficulties.value = String(field(student, "known_difficulties", "difficulties") || "");
    ui.studentProfileImprovements.value = String(field(student, "demonstrated_improvements") || "");
    ui.studentProfileNotes.value = String(field(student, "tutor_notes", "notes") || "");
    ui.studentProfileForm.hidden = false;
  }

  function studentProgressEvidenceFor(studentProgress) {
    const sessions = new Map(
      (Array.isArray(studentProgress?.sessions) ? studentProgress.sessions : []).map((session) => [
        String(field(session, "id", "uuid")), session,
      ]),
    );
    return state.studentProgressEvidenceRows
      .filter((evidence) => {
        const evidenceStudentId = String(field(evidence, "student_id"));
        return sessions.has(String(field(evidence, "session_id"))) &&
          (!evidenceStudentId || evidenceStudentId === ui.studentProgressStudent.value);
      })
      .sort((left, right) => sortTime(right) - sortTime(left));
  }

  function renderStudentProgressEvidenceOptions(progress) {
    const sessions = new Map(
      (Array.isArray(progress?.sessions) ? progress.sessions : []).map((session) => [
        String(field(session, "id", "uuid")), session,
      ]),
    );
    const evidence = studentProgressEvidenceFor(progress);
    ui.studentProgressEvidence.replaceChildren();
    if (!evidence.length) {
      const option = document.createElement("option");
      option.disabled = true;
      option.value = "";
      option.textContent = "No evidence records are available for this student's sessions.";
      ui.studentProgressEvidence.append(option);
      return;
    }
    const groups = new Map();
    for (const item of evidence) {
      const sessionId = String(field(item, "session_id"));
      if (!groups.has(sessionId)) groups.set(sessionId, []);
      groups.get(sessionId).push(item);
    }
    for (const [sessionId, records] of groups) {
      const session = sessions.get(sessionId);
      const group = document.createElement("optgroup");
      group.label = `${field(session, "subject") || "Session"} · ${titleOf(session, "Untitled session")}`;
      for (const item of records) {
        const option = document.createElement("option");
        option.value = String(field(item, "id", "uuid"));
        const verification = field(item, "verification_state", "needs-review");
        const title = field(item, "title") || field(item, "type") || "Evidence record";
        const content = String(field(item, "content") || "").replace(/\s+/g, " ").trim();
        option.textContent = `${title} · ${verification}${content ? ` · ${content.slice(0, 110)}` : ""}`;
        group.append(option);
      }
      ui.studentProgressEvidence.append(group);
    }
  }

  function renderProgressCitation(evidenceId, evidenceById) {
    const item = evidenceById.get(evidenceId);
    const citation = document.createElement("li");
    citation.className = "student-progress-citation";
    const sessionId = String(field(item, "session_id"));
    const evidenceStudentId = String(field(item, "student_id"));
    if (!item || !state.studentProgressSessions.has(sessionId) ||
        (evidenceStudentId && evidenceStudentId !== ui.studentProgressStudent.value)) {
      citation.classList.add("is-unavailable");
      citation.textContent = `Unavailable or invalid evidence source · ${evidenceId}`;
      return citation;
    }
    const summary = document.createElement("strong");
    summary.textContent = `${field(item, "type") || "Evidence"} · ${field(item, "title") || "Untitled record"}`;
    const review = document.createElement("span");
    const verification = String(field(item, "verification_state", "needs-review"));
    review.className = verification === "human-verified" ? "student-progress-verified" : "student-progress-unverified-source";
    review.textContent = verification === "human-verified" ? "Evidence marked human verified" : `Evidence status: ${verification}`;
    const content = document.createElement("p");
    content.textContent = String(field(item, "content") || "No evidence text recorded.");
    citation.append(summary, review, content);
    if (sessionId) {
      const session = state.studentProgressSessions?.get(sessionId);
      if (session) {
        const open = document.createElement("button");
        open.className = "text-button student-progress-open-session";
        open.type = "button";
        open.textContent = `Open ${titleOf(session, "session")}`;
        open.addEventListener("click", () => {
          showView("sessions");
          bridge.selectSession(sessionId);
        });
        citation.append(open);
      }
    }
    return citation;
  }

  function renderStudentProgress(progress) {
    const sessionRows = Array.isArray(progress?.sessions) ? progress.sessions : [];
    state.studentProgressSessions = new Map(sessionRows.map((session) => [
      String(field(session, "id", "uuid")), session,
    ]));
    ui.studentProgressSessions.replaceChildren();
    const sortedSessions = [...sessionRows].sort((left, right) => sortTime(right) - sortTime(left));
    if (!sortedSessions.length) {
      const empty = document.createElement("li");
      empty.className = "student-progress-session-empty";
      empty.textContent = "No sessions recorded for this student.";
      ui.studentProgressSessions.append(empty);
    }
    for (const session of sortedSessions) {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = titleOf(session, "Untitled session");
      const meta = document.createElement("span");
      const sessionDate = createdValue(session);
      meta.textContent = [field(session, "subject"), sessionDate ? prettyDate(sessionDate, { year: true }) : "Date not set"]
        .filter(Boolean).join(" · ");
      const open = document.createElement("button");
      open.className = "text-button student-progress-open-session";
      open.type = "button";
      open.textContent = "Open session";
      const sessionId = String(field(session, "id", "uuid"));
      open.addEventListener("click", () => {
        showView("sessions");
        bridge.selectSession(sessionId);
      });
      item.append(title, meta, open);
      ui.studentProgressSessions.append(item);
    }
    renderStudentProgressEvidenceOptions(progress);
    const classifications = Array.isArray(progress?.classifications) ? progress.classifications : [];
    ui.studentProgressHistory.replaceChildren();
    if (!classifications.length) {
      const empty = document.createElement("p");
      empty.className = "student-progress-empty";
      empty.textContent = "No tutor-reviewed classifications yet. Use the form below to record a skill with its supporting evidence.";
      ui.studentProgressHistory.append(empty);
    }
    const evidenceById = new Map(state.studentProgressEvidenceRows.map((item) => [
      String(field(item, "id", "uuid")), item,
    ]));
    for (const item of classifications) {
      const row = document.createElement("article");
      const isUnverified = field(item, "classification") === "unverified-improvement";
      row.className = `student-progress-record${isUnverified ? " is-unverified-claim" : ""}`;
      const heading = document.createElement("div");
      heading.className = "student-progress-record-heading";
      const skill = document.createElement("h3");
      skill.textContent = String(field(item, "skill") || "Unnamed skill");
      const badge = document.createElement("span");
      badge.className = "student-progress-classification";
      badge.textContent = studentProgressLabel(field(item, "classification"));
      heading.append(skill, badge);
      row.append(heading);
      if (isUnverified) {
        const claim = document.createElement("p");
        claim.className = "student-progress-claim-warning";
        claim.textContent = String(field(item, "claim_label") || "Unverified claim: improvement is not established");
        row.append(claim);
      }
      const sourceStatus = String(field(item, "source_status"));
      const evidenceIds = idList(field(item, "evidence_source_ids"));
      if ((sourceStatus && sourceStatus !== "valid") || evidenceIds.some((id) => !evidenceById.has(id))) {
        const warning = document.createElement("p");
        warning.className = "student-progress-source-warning";
        warning.textContent = "Source references are invalid or unavailable in this archive. Review the cited IDs before relying on this classification.";
        row.append(warning);
      }
      const audit = document.createElement("p");
      audit.className = "student-progress-audit";
      audit.textContent = `Reviewer label: ${field(item, "reviewed_by") || "Not recorded"} · ${prettyDateTime(field(item, "reviewed_at_us"))}`;
      row.append(audit);
      const evidenceDetails = document.createElement("details");
      evidenceDetails.className = "student-progress-citations";
      const evidenceSummary = document.createElement("summary");
      evidenceSummary.textContent = `Evidence (${evidenceIds.length})`;
      const citations = document.createElement("ul");
      for (const id of evidenceIds) citations.append(renderProgressCitation(id, evidenceById));
      evidenceDetails.append(evidenceSummary, citations);
      row.append(evidenceDetails);
      const noteText = String(field(item, "note") || "");
      if (noteText) {
        const note = document.createElement("p");
        note.className = "student-progress-note-text";
        note.textContent = noteText;
        row.append(note);
      }
      ui.studentProgressHistory.append(row);
    }
    ui.studentProgressForm.hidden = false;
  }

  async function refreshStudentProgress() {
    if (!ui.studentProgressStudent || !ui.studentProgressHistory) return;
    const requestId = ++state.studentProgressRequest;
    if (!bridge.archiveOpen()) {
      state.studentProgressStudents = [];
      state.studentProgressEvidenceRows = [];
      state.studentProgressSelectedId = "";
      ui.studentProgressStudent.replaceChildren(new Option("Choose a student", ""));
      ui.studentProgressHistory.replaceChildren();
      ui.studentProgressSessions.replaceChildren();
      ui.studentProgressEvidence.replaceChildren();
      ui.studentProgressForm.hidden = true;
      ui.studentProfileForm.hidden = true;
      setStudentProgressStatus("Open an archive to review learning history.");
      return;
    }
    setStudentProgressStatus("Loading students…");
    try {
      const response = await readCommand(["student", "list"]);
      if (requestId !== state.studentProgressRequest || !bridge.archiveOpen()) return;
      state.studentProgressStudents = responseRows(response, ["students"]);
      const priorId = state.studentProgressSelectedId;
      const selectedExists = state.studentProgressStudents.some((student) =>
        String(field(student, "id", "uuid")) === priorId,
      );
      state.studentProgressSelectedId = selectedExists
        ? priorId
        : String(field(state.studentProgressStudents[0], "id", "uuid") || "");
      ui.studentProgressStudent.replaceChildren(new Option("Choose a student", ""));
      for (const student of state.studentProgressStudents) {
        const option = document.createElement("option");
        option.value = String(field(student, "id", "uuid"));
        option.textContent = `${titleOf(student, "Unnamed student")}${field(student, "grade") ? ` · ${field(student, "grade")}` : ""}`;
        option.selected = option.value === state.studentProgressSelectedId;
        ui.studentProgressStudent.append(option);
      }
      if (!state.studentProgressSelectedId) {
        state.studentProgressEvidenceRows = [];
        ui.studentProgressHistory.replaceChildren();
        ui.studentProgressSessions.replaceChildren();
        ui.studentProgressEvidence.replaceChildren();
        ui.studentProgressForm.hidden = true;
        ui.studentProfileForm.hidden = true;
        setStudentProgressStatus("Add a student to start a learning history.");
        return;
      }
      ui.studentProgressStudent.value = state.studentProgressSelectedId;
      await loadSelectedStudentProgress(requestId);
    } catch (error) {
      if (requestId !== state.studentProgressRequest) return;
      ui.studentProgressHistory.replaceChildren();
      ui.studentProgressSessions.replaceChildren();
      ui.studentProgressEvidence.replaceChildren();
      state.studentProgressEvidenceRows = [];
      ui.studentProgressForm.hidden = true;
      setStudentProgressStatus(`Learning history could not be loaded: ${error.message}`);
    }
  }

  async function loadSelectedStudentProgress(parentRequest = ++state.studentProgressRequest) {
    const studentId = ui.studentProgressStudent.value;
    state.studentProgressSelectedId = studentId;
    ui.studentProgressHistory.replaceChildren();
    ui.studentProgressSessions.replaceChildren();
    ui.studentProgressEvidence.replaceChildren();
    ui.studentProgressForm.hidden = true;
    if (!studentId) {
      ui.studentProfileForm.hidden = true;
      setStudentProgressStatus("Choose a student to view their learning history.");
      return;
    }
    populateStudentProfile(studentId);
    setStudentProgressStatus("Loading evidence-linked history…");
    try {
      const [progressResponse, evidenceResponse] = await Promise.all([
        readCommand(["student", "progress", studentId]),
        readCommand(["evidence", "list"]),
      ]);
      if (parentRequest !== state.studentProgressRequest || studentId !== ui.studentProgressStudent.value || !bridge.archiveOpen()) return;
      const progress = responseRecord(progressResponse);
      if (!progress || String(field(progress, "student_id")) !== studentId) {
        throw new Error("The archive returned an invalid student progress record.");
      }
      state.studentProgressEvidenceRows = responseRows(evidenceResponse, ["evidence"]);
      renderStudentProgress(progress);
      const sessionCount = Array.isArray(progress.sessions) ? progress.sessions.length : 0;
      const itemCount = Array.isArray(progress.classifications) ? progress.classifications.length : 0;
      setStudentProgressStatus(`${itemCount} reviewed ${itemCount === 1 ? "skill" : "skills"} · ${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}.`);
    } catch (error) {
      if (parentRequest !== state.studentProgressRequest) return;
      ui.studentProgressSessions.replaceChildren();
      ui.studentProgressEvidence.replaceChildren();
      state.studentProgressEvidenceRows = [];
      ui.studentProgressForm.hidden = true;
      setStudentProgressStatus(`Learning history could not be loaded: ${error.message}`);
    }
  }

  async function reviewStudentProgress(event) {
    event.preventDefault();
    const studentId = ui.studentProgressStudent.value;
    const evidenceIds = selectedIds(ui.studentProgressEvidence);
    if (!studentId || !evidenceIds.length) {
      setStudentProgressStatus("Choose a student and at least one evidence record before saving.");
      return;
    }
    const skill = ui.studentProgressSkill.value.trim();
    const reviewer = ui.studentProgressReviewer.value.trim();
    const note = ui.studentProgressNote.value.trim();
    if (!skill || !reviewer) return;
    setStudentProgressStatus("Saving tutor review…");
    try {
      await writeCommand([
        "student", "progress-review", studentId,
        "--skill", skill,
        "--classification", ui.studentProgressClassification.value,
        "--evidence-ids", evidenceIds.join(","),
        "--reviewed-by", reviewer,
        ...(note ? ["--note", note] : []),
      ]);
      ui.studentProgressSkill.value = "";
      ui.studentProgressNote.value = "";
      for (const option of ui.studentProgressEvidence.options) option.selected = false;
      await refreshStudentProgress();
    } catch (error) {
      setStudentProgressStatus(`Review was not saved: ${error.message}`);
      showJournalError(error.message);
    }
  }

  async function saveStudentProfile(event) {
    event.preventDefault();
    const studentId = ui.studentProgressStudent.value;
    const name = ui.studentProfileName.value.trim();
    if (!studentId || !name) {
      setStudentProgressStatus("Choose a student and enter a name before saving.");
      return;
    }
    setStudentProgressStatus("Saving student profile…");
    try {
      await writeCommand([
        "student", "update", studentId,
        "--name", name,
        "--grade", ui.studentProfileGrade.value.trim(),
        "--subjects", ui.studentProfileSubjects.value.trim(),
        "--objectives", ui.studentProfileObjectives.value.trim(),
        "--difficulties", ui.studentProfileDifficulties.value.trim(),
        "--demonstrated-improvements", ui.studentProfileImprovements.value.trim(),
        "--preferred-guide-template", ui.studentProfileTemplate.value.trim(),
        "--notes", ui.studentProfileNotes.value.trim(),
      ]);
      await refreshStudentProgress();
      setStudentProgressStatus("Student profile saved in the selected archive.");
    } catch (error) {
      setStudentProgressStatus("Profile was not saved: " + error.message);
      showJournalError(error.message);
    }
  }

  function runPaletteAction(action) {
    ui.palette.close();
    if (action === "new-entry") openNewEntry();
    else if (action === "new-session") openSessionDialog();
    else if (action === "journal") showView("journal");
    else showView(action);
  }

  async function createTaxonomy(type, event) {
    event.preventDefault();
    const input = byId(type === "collection" ? "new-collection-name" : "new-tag-name");
    const name = input.value.trim();
    if (!name) return;
    try {
      await writeCommand(["journal", type, "create", "--name", name]);
      input.value = "";
      await loadTaxonomy();
      if (state.entryId) populateEntryTaxonomy();
    } catch (error) {
      showJournalError(error.message);
    }
  }

  function installListeners() {
    const errorHome = ui.error?.parentElement;
    for (const dialog of document.querySelectorAll("dialog")) {
      dialog.addEventListener("close", () => {
        const openDialog = document.querySelector("dialog[open]");
        if (openDialog && openDialog !== dialog) openDialog.append(ui.error);
        else if (errorHome && ui.error.parentElement !== errorHome) errorHome.prepend(ui.error);
      });
    }
    ui.errorDismiss?.addEventListener("click", () => {
      ui.error.hidden = true;
      const returnFocus = state.errorReturnFocus;
      state.errorReturnFocus = null;
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected &&
          returnFocus.getClientRects().length > 0 && !returnFocus.matches(":disabled") &&
          !ui.error.contains(returnFocus)) {
        returnFocus.focus({ preventScroll: true });
      }
    });
    ui.entryCreateForm.addEventListener("submit", createEntry);
    ui.studentProgressStudent?.addEventListener("change", () => {
      state.studentProgressSelectedId = ui.studentProgressStudent.value;
      ui.studentProgressSkill.value = "";
      ui.studentProgressNote.value = "";
      void loadSelectedStudentProgress();
    });
    ui.studentProgressForm?.addEventListener("submit", (event) => void reviewStudentProgress(event));
    ui.studentProfileForm?.addEventListener("submit", (event) => void saveStudentProfile(event));
    byId("new-entry").addEventListener("click", openNewEntry);
    byId("back-to-journal").addEventListener("click", returnToJournal);
    byId("entry-title-form").addEventListener("submit", saveEntryTitle);
    ui.entryDate.addEventListener("change", () => void saveEntryDate());
    byId("save-entry-notes").addEventListener("click", () => {
      window.clearTimeout(state.noteTimer);
      void saveNotes();
    });
    ui.notes.addEventListener("input", handleMarkdownSourceInput);
    ui.notes.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        window.clearTimeout(state.noteTimer);
        void saveNotes();
      }
    });
    ui.richNotes.addEventListener("input", handleRichNotesInput);
    ui.richNotes.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        window.clearTimeout(state.noteTimer);
        void saveNotes();
      }
    });
    ui.richNotes.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") || "";
      if (text) insertTextAtSelection(text);
    });
    ui.richNotes.addEventListener("dragover", (event) => event.preventDefault());
    ui.richNotes.addEventListener("drop", (event) => {
      event.preventDefault();
      const text = event.dataTransfer?.getData("text/plain") || "";
      if (text) insertTextAtSelection(text);
    });
    ui.richNotes.addEventListener("click", (event) => {
      const toggle = event.target instanceof Element ? event.target.closest(".note-task-toggle") : null;
      if (!toggle || !ui.richNotes.contains(toggle)) return;
      const checked = toggle.getAttribute("aria-checked") !== "true";
      toggle.setAttribute("aria-checked", String(checked));
      toggle.setAttribute("aria-label", checked ? "Mark task incomplete" : "Mark task complete");
      toggle.textContent = checked ? "✓" : "";
      handleRichNotesInput();
    });
    ui.notesSourceToggle.addEventListener("click", () => setNotesSourceMode(!state.notesSourceMode));
    for (const button of ui.notesToolbar.querySelectorAll("[data-note-action]")) {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => applyNotesAction(button.dataset.noteAction));
    }
    document.addEventListener("selectionchange", updateNotesToolbarState);
    byId("new-session").addEventListener("click", openSessionDialog);
    byId("manage-collections").addEventListener("click", openEntryTaxonomy);
    byId("edit-entry-taxonomy").addEventListener("click", openEntryTaxonomy);
    byId("entry-taxonomy-form").addEventListener("submit", saveEntryTaxonomy);
    byId("collection-create-form").addEventListener("submit", (event) => void createTaxonomy("collection", event));
    byId("tag-create-form").addEventListener("submit", (event) => void createTaxonomy("tag", event));
    byId("check-microphone").addEventListener("click", () => void checkMicrophone());
    ui.recordingConsent.addEventListener("change", () => {
      byId("check-microphone").disabled = !ui.recordingConsent.checked;
      if (!ui.recordingConsent.checked) {
        releasePendingStream();
        ui.startRecordingSession.disabled = true;
        ui.microphoneStatus.textContent = "Confirm permission before checking the microphone.";
      }
    });
    ui.sessionStartForm.querySelectorAll('input[name="session-kind"]').forEach((radio) => {
      radio.addEventListener("change", () => selectSessionKind(radio.value));
    });
    ui.sessionStartStudent.addEventListener("change", () => {
      ui.newSessionStudentPanel.hidden = ui.sessionStartStudent.value !== "__new__";
      if (!ui.newSessionStudentPanel.hidden) ui.newSessionStudentName.focus();
      const student = state.studentProgressStudents.find((item) =>
        String(field(item, "id", "uuid")) === ui.sessionStartStudent.value,
      );
      if (student && !ui.sessionStartSubject.value.trim()) {
        ui.sessionStartSubject.value = String(field(student, "subjects") || "");
      }
    });
    ui.guideSourceScope.addEventListener("change", updateGuideSourceControls);
    ui.createNotesSession.addEventListener("click", () => void createNotesSession());
    ui.startRecordingSession.addEventListener("click", () => void createRecordingSession());
    ui.importRecordingSession.addEventListener("click", () => void createImportedSession());
    ui.recordingFile.addEventListener("change", () => {
      ui.importRecordingSession.disabled = !ui.recordingFile.files?.length;
    });
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => closeDialog(button.dataset.closeDialog));
    });
    ui.sessionDialog.addEventListener("close", () => {
      if (!window.tutoruxPendingRecordingStream) releasePendingStream();
    });
    ui.search.addEventListener("input", () => {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => void refreshJournal(), 220);
    });
    ui.timelineDate?.addEventListener("change", () => renderTimeline(state.sessions));
    ui.timelineDateClear?.addEventListener("click", () => {
      if (ui.timelineDate) ui.timelineDate.value = "";
      renderTimeline(state.sessions);
      ui.timelineDate?.focus();
    });
    for (const control of [ui.collectionFilter, ui.tagFilter, ui.fromFilter, ui.toFilter, ui.sessionFilter, ui.sort]) {
      control.addEventListener("change", () => void refreshJournal());
    }
    byId("clear-journal-filters").addEventListener("click", () => {
      ui.collectionFilter.value = "";
      ui.tagFilter.value = "";
      ui.fromFilter.value = "";
      ui.toFilter.value = "";
      ui.sessionFilter.value = "all";
      void refreshJournal();
    });
    byId("command-palette-open").addEventListener("click", openPalette);
    ui.paletteSearch.addEventListener("input", filterPalette);
    ui.paletteActions.addEventListener("click", (event) => {
      const button = event.target.closest("[data-command-action]");
      if (button) runPaletteAction(button.dataset.commandAction);
    });
    byId("session-complete").addEventListener("click", () => void transitionSession("complete"));
    byId("session-review").addEventListener("click", () => void transitionSession("review"));
    byId("session-resume").addEventListener("click", () => void transitionSession("resume"));
    byId("session-delete-open").addEventListener("click", () => void openSessionDeleteDialog());
    byId("session-delete-cancel").addEventListener("click", () => ui.sessionDeleteDialog.close());
    ui.sessionDeleteConfirm.addEventListener("click", () => void confirmSessionDelete());
    ui.sessionDeleteDialog.addEventListener("close", () => {
      state.sessionDeleteTarget = "";
      state.sessionDeleteScopeToken = "";
      ui.sessionDeleteConfirm.disabled = true;
    });
    byId("quick-marker").addEventListener("click", () => void addQuickMarker());
    byId("active-session").addEventListener("change", updateQuickMarkerAvailability);
    window.addEventListener("tutorux:add-passage", addPassageToNotes);
    window.addEventListener("tutorux:open-entry", (event) => {
      const { entryId, sessionId } = event.detail || {};
      if (!entryId) return;
      void openEntry(String(entryId)).then(() => {
        if (!sessionId) return;
        state.expandedSessionId = String(sessionId);
        renderTimeline(state.sessions);
        void showSessionMaterials(String(sessionId));
      });
    });
    window.addEventListener("tutorux:recording-state", (event) => {
      const detail = event.detail || {};
      state.recordingSessionId = detail.active ? String(detail.sessionId || "") : "";
      state.recordingStartedAt = detail.active ? Number(detail.startedAt || Date.now()) : 0;
      updateQuickMarkerAvailability();
      ui.topbarRecording.hidden = !detail.active;
      ui.topbarRecording.setAttribute("aria-label", detail.active ? "Microphone recording in progress" : "Not recording");
      const activeSession = state.sessions.find((item) => String(field(item, "id", "uuid")) === String(detail.sessionId));
      if (activeSession) renderSessionLifecycle(activeSession);
      for (const item of ui.timeline.querySelectorAll(".timeline-item")) {
        item.classList.toggle("is-recording", item.querySelector("summary .timeline-session-title")?.textContent === titleOf(activeSession));
      }
    });
    window.addEventListener("tutorux:entry-guide-error", (event) => {
      state.guideEntryScopeError = String(event.detail?.message || "The archive could not generate an entry-wide guide.");
      updateGuideSourceControls();
      showJournalError(state.guideEntryScopeError);
    });
    window.addEventListener("tutorux:archive-change", () => {
      window.clearTimeout(state.refreshTimer);
      void refreshStudentProgress();
      state.refreshTimer = window.setTimeout(() => {
        void refreshJournal();
        if (state.entryId && state.currentView === "entry") void loadEntry(state.entryId, true);
      }, 0);
    });
    for (const button of document.querySelectorAll('[data-view="journal"]')) {
      button.addEventListener("click", () => {
        showView("journal");
        void refreshJournal();
      });
    }
    document.addEventListener("keydown", (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      const target = event.target;
      const typing = target instanceof HTMLElement && (
        target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
      );
      const sessionContext = state.currentView === "sessions" ||
        (state.currentView === "entry" && Boolean(state.expandedSessionId || state.recordingSessionId));
      if (modifier && !event.altKey && !event.shiftKey && !event.repeat && sessionContext &&
          !document.querySelector("dialog[open]")) {
        const markerIndex = state.quickMarkerShortcuts.indexOf(event.key.toLocaleLowerCase());
        if (markerIndex >= 0) {
          event.preventDefault();
          void addQuickMarker(markerIndex);
          return;
        }
      }
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette();
        return;
      }
      if (modifier && event.key.toLowerCase() === "f" && state.currentView === "journal") {
        event.preventDefault();
        ui.search.focus();
        return;
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === "m" && state.currentView === "entry") {
        event.preventDefault();
        addTimestampedNote();
        return;
      }
      if (event.key === "Escape" && state.currentView === "entry" && !ui.sessionDialog.open && !ui.taxonomyDialog.open) {
        if (typing) return;
        returnToJournal();
        return;
      }
      if (!typing && !modifier && state.currentView === "journal" &&
          (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        const activeEntry = target instanceof HTMLElement ? target.closest(".journal-entry-open") : null;
        if (activeEntry) {
          const entries = [...ui.entries.querySelectorAll(".journal-entry-open")];
          const currentIndex = entries.indexOf(activeEntry);
          const nextIndex = Math.max(0, Math.min(entries.length - 1, currentIndex + (event.key === "ArrowDown" ? 1 : -1)));
          if (entries[nextIndex] && entries[nextIndex] !== activeEntry) {
            event.preventDefault();
            entries[nextIndex].focus();
          }
        }
      }
      if (!typing && !modifier && event.key.toLowerCase() === "n" && state.currentView === "journal") {
        event.preventDefault();
        openNewEntry();
      }
    });
  }

  function updateArchiveControls() {
    const enabled = bridge.archiveOpen();
    for (const id of ["new-entry", "new-session", "manage-collections", "edit-entry-taxonomy"]) {
      const control = byId(id);
      if (!control) continue;
      control.disabled = !enabled || (["new-session", "edit-entry-taxonomy"].includes(id) && !state.entryId);
    }
    updateNotesEditingState();
    updateQuickMarkerAvailability();
    updateGuideSourceControls();
  }

  function updateQuickMarkerAvailability() {
    const button = byId("quick-marker");
    if (!button) return;
    const selectedSession = Boolean(byId("active-session")?.value);
    button.disabled = !bridge.archiveOpen() || (!selectedSession && !state.recordingSessionId);
  }

  installListeners();
  byId("check-microphone").disabled = true;
  updateArchiveControls();
  window.addEventListener("tutorux:workspace-refresh", () => {
    updateArchiveControls();
    void refreshJournal();
  });
  window.addEventListener("tutorux:archive-change", updateArchiveControls);
  window.addEventListener("tutorux:archive-open", () => {
    state.entryId = "";
    state.entry = null;
    state.guideEntryScopeError = "";
    showView("journal");
    updateQuickMarkerAvailability();
    updateGuideSourceControls();
    void loadQuickMarkerShortcuts();
    void refreshStudentProgress();
    void refreshJournal();
  });
  void loadQuickMarkerShortcuts();
  void refreshJournal();
})();
