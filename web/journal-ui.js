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
    if (stateLabel) stateLabel.textContent = `${lifecycle[0]?.toUpperCase()}${lifecycle.slice(1)} session`;
    if (recordingLabel) {
      recordingLabel.textContent = state.recordingSessionId === id ? "Recording · microphone audio" : recordingSummary(session);
      recordingLabel.classList.toggle("is-recording", state.recordingSessionId === id);
    }
    if (complete) complete.hidden = lifecycle === "completed" || lifecycle === "reviewed";
    if (review) review.hidden = lifecycle !== "completed";
    if (resume) resume.hidden = !["completed", "reviewed"].includes(lifecycle);
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
    const title = `${titleOf(state.entry)} · Session ${state.sessions.length + 1}`;
    const response = await writeCommand([
      "session", "create", "--entry-id", state.entryId, "--type", kind, "--title", title,
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

  function insertMarkdown(before, after = before) {
    const area = ui.notes;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const selected = area.value.slice(start, end) || "text";
    const replacement = `${before}${selected}${after}`;
    area.setRangeText(replacement, start, end, "select");
    area.focus();
    scheduleNotesSave();
  }

  function prependMarkdown(prefix) {
    const area = ui.notes;
    const start = area.selectionStart;
    const lineStart = area.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    area.setRangeText(prefix, lineStart, lineStart, "end");
    area.focus();
    scheduleNotesSave();
  }

  function addPassageToNotes(event) {
    const { text, speaker, timestamp } = event.detail || {};
    const passage = String(text || "").trim();
    if (!passage || !state.entryId) {
      showJournalError("Open an entry and select a transcript passage first.");
      return;
    }
    const citation = [speaker, timestamp].filter(Boolean).join(" · ");
    const quote = passage.split("\n").map((line) => `> ${line}`).join("\n");
    const addition = `\n\n${quote}${citation ? `\n> — ${citation}` : ""}`;
    const at = ui.notes.selectionStart === ui.notes.selectionEnd ? ui.notes.value.length : ui.notes.selectionStart;
    ui.notes.setRangeText(addition, at, at, "end");
    ui.notes.focus();
    scheduleNotesSave();
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
    byId("new-entry").addEventListener("click", openNewEntry);
    byId("back-to-journal").addEventListener("click", returnToJournal);
    byId("entry-title-form").addEventListener("submit", saveEntryTitle);
    ui.entryDate.addEventListener("change", () => void saveEntryDate());
    byId("save-entry-notes").addEventListener("click", () => {
      window.clearTimeout(state.noteTimer);
      void saveNotes();
    });
    ui.notes.addEventListener("input", scheduleNotesSave);
    ui.notes.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        window.clearTimeout(state.noteTimer);
        void saveNotes();
      }
    });
    document.querySelectorAll("[data-note-wrap]").forEach((button) => {
      button.addEventListener("click", () => insertMarkdown(button.dataset.noteWrap, button.dataset.noteWrap));
    });
    document.querySelectorAll("[data-note-prefix]").forEach((button) => {
      button.addEventListener("click", () => prependMarkdown(button.dataset.notePrefix));
    });
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
    void refreshJournal();
  });
  void loadQuickMarkerShortcuts();
  void refreshJournal();
})();
