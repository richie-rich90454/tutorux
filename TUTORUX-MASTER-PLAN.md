# Tutorux Master Plan

**Status:** authoritative implementation plan  
**Date:** 2026-10-23  
**Working tree:** `C:\Users\rjian\Desktop\tutorux`  
**Primary target:** Windows x86-64 portable desktop release  
**Secondary targets:** Linux and macOS source builds, using the same Slint UI and core  
**Paused by explicit instruction:** static WebAssembly edition only

This plan is intentionally exhaustive. It preserves every existing feature, every command family, every archive capability, and every release gate. Nothing is deleted. Features may be relocated, grouped, deferred behind a Developer section, or loaded on demand, but they remain available.

---

## 0. How to use this plan

1. Read the non-negotiables.
2. Execute phases in order. Do not start screen redesign before the data path and shell are fixed.
3. Treat the acceptance gates in section 14 as the release contract.
4. Keep the existing `REFERENCE.md` as the product specification. Where this plan is stricter, this plan wins for engineering execution; where it contradicts `REFERENCE.md`, stop and resolve explicitly.
5. No feature is considered done until it has a real test, a failure state, and a place in the UI that a normal user can understand.
6. No size or performance claim is accepted without a measured artifact.

---

## 1. Non-negotiables

### 1.1 Product and technology

- Native C++23 application.
- Slint desktop UI. No Qt, Electron, Tauri, browser engine, or embedded WebView.
- One portable Windows executable for the primary release.
- `.tux` remains the single authoritative archive.
- No sidecar database, no AppData state, no global cache, no extracted workspace.
- All existing commands remain available.
- All existing GUI capabilities remain available.
- No fake or placeholder UI data.
- No fake tests.
- No functionality removed to make the UI prettier or the binary smaller.

### 1.2 Design

- Exact 5 px radius on rounded product surfaces.
- Noto Sans family, embedded.
- Sentence case for interface labels.
- Blue, black, white, and red as the core identity.
- Light and dark mode must both be first-class, not an afterthought.
- Every interactive element needs rest, hover, pressed, focused, disabled, and read-only states where applicable.
- No overflow at supported window sizes.
- No clipped controls.
- No invisible text.
- No unselectable output.
- No raw UUID or CLI syntax in the primary workflow.
- Motion must be consistent, subtle, and responsive. Motion must never be used to hide a slow data path.

### 1.3 Quality

- Every core feature has a CLI path and a GUI path.
- Every destructive action has review and confirmation.
- Every error is mapped to a user-readable message.
- Every archive write is transactional and recoverable.
- Every screen has loading, empty, error, and populated states.
- Every supported window size has a screenshot test.
- Every release has a size, memory, startup, and thread budget.
- CI is re-enabled before release.
- WASM remains paused; it is the only permitted feature area excluded from this release cycle.

---

## 2. Definition of success

Tutorux is done when all of the following are true.

### 2.1 Functional parity

- The complete matrix in section 13 passes.
- Every command listed by `tutorux --help` works and is covered by an integration test.
- Every GUI action maps to a service operation, not to a parsed command string.
- Session package export/import, archive copy, sanitized copy, encryption, recovery, and verification all pass on real archives.
- Recording, transcript, evidence, guide, materials, AI, export, and student workflows work end to end.
- No known data-loss defect remains.

### 2.2 Visual quality

- 1024×768, 1280×800, 1440×900, and 1600×1000 at 100%, 125%, and 150% scaling show no overflow or clipping.
- The README screenshot is a correct representation of the current UI.
- The notebook never runs under the inspector.
- The bottom transport and status bar never fall below the viewport.
- The inspector never renders blank while a session is selected.
- Every hover state has readable contrast.
- Dark mode has no white-on-white, black-on-black, or invisible icon states.
- Disabled controls look disabled and do not animate into active states.
- Text that a user may need to copy is selectable.
- Dialogs trap focus and return focus on close.

### 2.3 Performance

Measured on the same reference machine and archive after each phase:

| Metric | Target |
|---|---:|
| Cold start to interactive window, empty archive | under 1.2 s |
| Cold start to populated session | under 1.8 s |
| Private memory, empty archive picker | under 45 MB |
| Private memory, 1,000-session archive | under 100 MB |
| Working set, empty archive picker | under 140 MB |
| Application-owned threads | at most 8 |
| First paint after selecting a session | under 80 ms |
| Refresh after a note edit | under 100 ms for 1,000 sessions |
| Scroll of 10,000 notes | no full-list allocation, stable memory |
| Idle CPU | under 1% |
| Binary size, base portable executable | under 45 MB |
| Binary size, one-file all-features build | under 65 MB |

The current measured baseline is worse in several areas: about 179 MB working set, 65 MB private memory idle, 4.7 GB virtual, 28 total threads, 93.9 MB binary, and no GUI test coverage. The plan treats those numbers as defects, not as the target.

### 2.4 Quality gates

- `ctest` passes all suites.
- GUI screenshot and interaction suites pass.
- Size budget passes.
- Memory budget passes.
- Thread count passes.
- ASan/UBSan suites pass on the core.
- No compiler warnings in the release build.
- CI is green on Windows.
- Linux and macOS qualification are recorded separately and not claimed until they pass.

---

## 3. Current-state audit

This section records the problems the plan exists to solve. It is not a wish list.

### 3.1 Measured runtime facts

| Case | Working set | Private | Virtual | Threads | Handles |
|---|---:|---:|---:|---:|---:|
| Empty archive picker | 178.8 MB | 65.4 MB | 4.70 GB | 28 | 373 |
| Probe archive open | 179.4 MB | 102.6 MB | 4.68 GB | 28 | 390 |
| Dev shared build, empty | 182.2 MB | 65.2 MB | 4.71 GB | 28 | 371 |

The module list included approximately 82 MB `igc64.dll`, 21 MB `igxelpgicd64.dll`, and 3.5 MB `igdgmm64.dll` from the Intel OpenGL driver, plus the mapped executable. That explains much of the working set, but it does not excuse the application-level growth risks below.

### 3.2 Bundle-size facts

- `dist/Tutorux.exe`: 93.9 MB.
- Static Slint library: 92.3 MB (`build/portable/_deps/slint-build/libslint_cpp.a`).
- PoDoFo static libraries: 18.1 MB.
- OpenSSL static libraries: 10.9 MB.
- Whisper/ggml: 4.3 MB.
- Debug sections in the release executable: about 4.5 MB.
- `SLINT_FEATURE_INTERPRETER=ON`.
- `SLINT_FEATURE_TESTING=ON`.
- `SLINT_FEATURE_SYSTEM_TRAY=ON`.
- `SLINT_FEATURE_RENDERER_FEMTOVG=ON`.
- `SLINT_FEATURE_RENDERER_SOFTWARE=ON`.
- `libgomp` is pulled in through the Whisper/ggml link.
- The final executable is copied to `dist/` without stripping.

### 3.3 UI facts

- `ui/app-window.slint` is 2,455 lines.
- `MainWindow` exposes roughly 281 property/callback declarations.
- `src/gui/desktop.cpp` registers about 120 UI handlers.
- There are 15 distinct font sizes.
- There are 52 hardcoded color literals outside the central token definitions.
- There are zero `ListView` uses.
- There are eight `for` loops that materialize all rows or options.
- There are only eight `animate` declarations.
- The preferred window is 1600×930 with a 940×600 minimum.
- The `docs/images/workspace.png` screenshot shows the notebook text reaching the inspector boundary and an underfilled inspector.
- The 1280×800 screenshot shows the notebook text clipped and the bottom area clipped by the screen.
- The guide editor and journal tools are modal forms with flat action hierarchies.
- Raw IDs and CLI syntax appear in user-facing fields.

### 3.4 Data and threading facts

- `loadWorkspaceSnapshot` in `src/gui/desktop.cpp:1930` runs six CLI list/snapshot commands, another `Archive::open`, multiple full record lists, and a document command for one refresh.
- `session list --json` loads every transcript segment to count segments (`src/command/dispatcher.cpp:3243`).
- `BackgroundTasks` stores every spawned `std::thread` in a vector and joins only when the window exits (`src/gui/desktop.cpp:1803-1835`, `7253-7259`).
- `commandThreads` has the same unbounded retention pattern.
- A `std::thread` that has completed still holds its OS handle and reserved stack until joined.
- The notebook autosave timer is bound to shared `selected-block`/`block-text` state and can target the wrong block if selection changes before the 900 ms timer fires.

### 3.5 Quality facts

- 27 test suites pass.
- Last measured core coverage was 58.9% lines and 78.9% functions.
- There is no test that launches the GUI.
- There is no screenshot regression test.
- There is no memory, thread, binary-size, or interaction-state test.
- `.github/workflows` and `.github/dependabot.yml` are renamed to `.disabled`.
- The README describes a 1.0 product, but the visual and performance acceptance gates are not automated.

---

## 4. Root causes

### 4.1 The UI is a CLI adapter

`desktop.cpp` assembles command argument vectors, calls `dispatchWithSecrets`, parses output strings, and updates dozens of independent Slint properties. It even scrapes output to recover IDs in places.

This creates:

- raw IDs and CLI language in the UI;
- inconsistent error handling;
- a full reload after almost every action;
- duplicated state;
- races between refreshes;
- no typed contract for the UI;
- no way to apply a small patch after a command.

### 4.2 No view-model architecture

`MainWindow` is a flat bag of strings, booleans, and callback parameters. A selection is often a display string containing a label and UUID. Invalid states are representable, and every screen change reaches across `app-window.slint`, `desktop.cpp`, and the dispatcher.

### 4.3 Eager data loading

Every refresh opens the archive repeatedly and loads all records for each list. There is no pagination, no index count, no read model, and no incremental patch. This is the main performance and memory defect.

### 4.4 Hand-built widget behavior

`ScrollArea`, `Button`, `LineEdit`, `ComboBox`, `CheckBox`, menus, dialogs, and the guide editor are custom. Some are good, but they do not share one state model. Hover/disabled precedence, scrollbar geometry, text selection, focus trapping, and keyboard behavior vary.

### 4.5 No visual test loop

Because no test renders the UI, a change can clip text, hide an inspector, or break dark mode without failing anything. A 27-suite test collection with no GUI test is not a UI quality gate.

### 4.6 Static dependency policy without a budget

Every optional engine is linked into the main binary, debug sections survive, and Slint is built with development features. No budget exists to reject growth.

### 4.7 Feature surfaces without information architecture

Journal entries, sessions, notes documents, markers, assets, evidence, guides, AI jobs, recordings, templates, settings, and diagnostics each got a form. Nothing was grouped into a product-level navigation model.

---

## 5. Target architecture

### 5.1 Layers

```text
┌─────────────────────────────────────────────┐
│ Slint views                                  │
│ shell, pages, overlays, reusable components  │
└──────────────────────┬──────────────────────┘
                       │ typed properties / callbacks
┌──────────────────────▼──────────────────────┐
│ UI controllers                               │
│ page state, selection, commands, validation  │
└──────────────────────┬──────────────────────┘
                       │ typed DTOs and patches
┌──────────────────────▼──────────────────────┐
│ Application services                         │
│ WorkspaceService, SessionService, ...        │
└──────────────────────┬──────────────────────┘
                       │ domain operations
┌──────────────────────▼──────────────────────┐
│ Domain + archive engine                      │
│ typed records, indexes, transactions         │
└─────────────────────────────────────────────┘
```

The CLI is a second adapter over the same application services. It is not the implementation behind the GUI.

### 5.2 Service contracts

Create:

- `WorkspaceService`
  - `openArchive(path, passphrase)`;
  - `snapshotOverview(generation, page, filter)`;
  - `watchGeneration()`;
  - `closeArchive()`;
  - `archiveInfo()`.
- `SessionService`
  - create, list page, show, update, clone, archive, start, complete, review, resume, delete preview/confirm, recover, export package, import package.
- `JournalService`
  - entries, collections, tags, search, timeline, notes documents, blocks, formatting, revisions.
- `StudentService`
  - create, list, show, update, delete, history, progress, progress review.
- `TranscriptService`
  - import, show page, search, export, correct, timestamp, split, merge, speaker, verify, history, restore, generate, refine, plan.
- `AnnotationService`
  - create, list, show, history, update, prioritize, merge, split, link, unlink, remove, duplicate.
- `AssetService`
  - add, import folder, list, preview, verify, extract, remove, link, unlink.
- `EvidenceService`
  - extract, list, show, graph, approve, reject, verify.
- `GuideService`
  - generate, list, show, edit, compare, validate, approve, regenerate, sections, blocks, export.
- `TemplateService`
  - create, list, show, update, import, export, delete.
- `RecordingService`
  - devices, preflight, consent, start, pause, resume, stop, status, recover, import WAV, export WAV, play, waveform.
- `AiService`
  - providers, models, capabilities, context, package, import, generate, jobs, cancel, configure, test, estimate.
- `SettingsService`
  - get, set, list, reset, import, copy, credentials.
- `DiagnosticsService`
  - run, archive, audio, graphics, providers, network, report.
- `PackageService`
  - session export/import, archive copy, sanitized copy, backup.
- `BenchmarkService`
  - startup, memory, CPU, audio, indexing, rendering, export.

### 5.3 Write model

Commands return typed results:

```text
Result<T> {
  success;
  value T;
  warnings[];
  affectedIds[];
  newGeneration;
}
```

The UI applies a patch:

```text
WorkspacePatch {
  sessionsAdded;
  sessionsUpdated;
  sessionsRemoved;
  selectedSession;
  statusMessage;
  generation;
}
```

No UI code parses stdout. No UI code calls `selectionId` to recover a UUID from a label.

### 5.4 Archive access

- One `Archive` handle per active workspace.
- One read/write mutex at the service boundary.
- Short read transactions; no full archive scan for overview.
- Index-backed queries for every list.
- A single writer for GUI commands and recording worker.
- Read-only snapshots may run in parallel only if archive locking proves safe.
- No command opens the same archive independently while the workspace service owns it.
- Passphrases exist only in memory and are wiped after use.

### 5.5 Threading

- One bounded `TaskExecutor` with 2–4 workers.
- `std::jthread` workers with a queue.
- A generation token per workspace/view.
- Cancellation checked before and during archive reads.
- Stale work is cancelled, not merely ignored on completion.
- No vector of completed threads.
- Playback and recording use their own dedicated workers, not the general executor.
- UI updates happen only through `slint::invoke_from_event_loop`.
- A thread is joined or returned to the pool as soon as its task completes.

### 5.6 Error model

Map errors to typed categories:

- validation;
- permission/lock;
- archive corruption;
- unavailable device;
- unavailable model;
- provider/network;
- confirmation required;
- unsupported operation;
- internal.

Each category has a user-facing title, body, and recovery action. Raw diagnostic detail goes to a collapsible “Details” area and logs.

### 5.7 Logging and diagnostics

- Bounded in-memory diagnostics buffer.
- Structured event fields: time, category, operation, duration, bytes, record count.
- No secrets, no archive contents, no provider payloads in logs by default.
- A user-triggered JSON report can include redacted state, versions, and performance counters.

---

## 6. UI and UX blueprint

### 6.1 Application shell

```text
┌────────────────────────────────────────────────────────────┐
│ Top bar: archive, breadcrumb, command palette, window menu │
├──────────────┬───────────────────────────────┬─────────────┤
│ Navigator    │ Main page                     │ Inspector   │
│              │                               │             │
│ Journal      │ Page header                   │ Context     │
│ Sessions     │ Tabs or content               │ Sources     │
│ Students     │                               │ Details     │
│ Materials    │                               │ Actions     │
│ Guides       │                               │             │
│ Settings     │                               │             │
├──────────────┴───────────────────────────────┴─────────────┤
│ Status / transport strip                                   │
└────────────────────────────────────────────────────────────┘
```

Rules:

- Navigator expands to 264 px at 1440+ and collapses to a rail/drawer below 1100 px.
- Inspector is 260–284 px at 1440+ and collapses below 1280 px.
- Main content gets `horizontal-stretch: 1` and `min-width: 0`.
- Main content is always clipped to its pane; text must wrap, never bleed under the inspector.
- Transport appears only when relevant; when inactive it is a compact 56 px strip.
- Status is a compact line, not a full-width banner over content.

### 6.2 Navigation model

Primary areas:

1. **Journal** — the home view.
2. **Sessions** — sessions, notebook, transcript, recording, guide.
3. **Students** — profiles and progress.
4. **Materials** — asset library.
5. **Guides** — guide list and full editor.
6. **Settings** — appearance, shortcuts, archive, diagnostics, developer.

Contextual areas:

- Recording is a session action and a transport, not a separate top-level app.
- AI is a tool within the current session or guide.
- Console, raw IDs, JSON, and provider internals live under **Settings → Developer**.
- Every legacy screen remains reachable.

### 6.3 Journal page

- Left: entries list, date grouping, title, session count.
- Right: selected entry details, sessions, timeline, notes.
- Top: search, filter, sort, “New entry”.
- Empty state: one action, “New entry”, with one sentence.
- No dropdown selection of entries.
- No raw UUIDs.
- No modal form for normal editing.

### 6.4 Sessions page

Header:

- title, student, date, state, recording state;
- one edit affordance;
- tabs: Notebook, Transcript, Study guide, Recording.

Notebook:

- document canvas centered with a readable measure;
- block rows with inline editing;
- one Add note action;
- one type picker per selected block;
- save state shown in the header;
- no duplicate Add note block / Add note actions;
- flush-before-selection-change autosave;
- empty blocks save correctly;
- undo/redo for text edits where supported.

Transcript:

- segment list with timestamp, speaker, state, search;
- selectable text;
- one correction panel;
- split/merge/speaker/verify actions in a context menu or inspector;
- source and revision visible.

Study guide:

- sections and blocks as a document;
- source pills under each block;
- stale-source state;
- full editor opens as a page, not a modal wall;
- export in a menu;
- approval is a reviewed state, not a random button.

Recording:

- consent, device, source, preflight, level, start/pause/resume/stop;
- one transport;
- waveform;
- markers;
- recovery;
- no black transport when inactive.

### 6.5 Students page

- list on the left, profile and progress on the right;
- edit/save in a single surface;
- progress review with evidence picker;
- preferred guide template picker;
- no raw IDs.

### 6.6 Materials page

- grid/list with thumbnails when available;
- type, size, source, session;
- preview panel;
- drag-and-drop;
- one import action;
- verify/extract/link in a context menu.

### 6.7 Guides page

- list of guides with session, template, approval state, updated time;
- full editor page;
- outline, canvas, sources inspector;
- revision compare;
- validate sources;
- approve;
- export menu;
- table and image blocks rendered as first-class blocks.

### 6.8 Settings page

- Appearance: light/dark/system, density.
- Shortcuts: marker shortcuts, command palette.
- Archive: verification, backup, copy, sanitize, compact, encryption, recovery.
- Diagnostics: run, report, performance.
- Developer: command console, raw IDs, provider debug data.

### 6.9 First launch

- If no archive: one clear “Open archive” / “Create archive” choice.
- One archive: open directly.
- Multiple archives: explicit picker with names, health, and paths.
- No hidden new archive creation when opening an existing archive.
- No workspace extraction.

---

## 7. Design system

### 7.1 Typography

One family: Noto Sans.

Scale:

| Token | Size | Use |
|---|---:|---|
| `caption` | 12 px | metadata, labels, helper text |
| `body` | 14 px | normal text and controls |
| `title` | 16 px | section headings |
| `display` | 28 px | page title only |
| `metric` | 24 px | numeric recording/time display |

Weights:

- 400 regular;
- 600 semibold;
- 700 bold for display only.

Rules:

- Sentence case everywhere.
- No 10.5, 11.5, 12.5, 13.5, 15, 17, 18, 24, 29, and 30 px one-offs.
- No hardcoded line heights except the base body line height.
- All long text wraps; all truncated text has a tooltip or accessible label.

### 7.2 Spacing

Use only:

- 4 px;
- 8 px;
- 12 px;
- 16 px;
- 24 px;
- 32 px.

Panel padding: 24 px. Compact row padding: 8–12 px. Control height: 36 px. Header height: 56 or 64 px. Dialog padding: 24 px.

### 7.3 Color

The identity remains white, black, blue, and red. Semantic colors need accessible redundancy.

Light:

| Token | Value |
|---|---|
| `canvas` | `#FFFFFF` |
| `surface` | `#FFFFFF` |
| `surface-inset` | `#F7F9FC` |
| `surface-hover` | `#F3F6FC` |
| `ink` | `#000000` |
| `body` | `#26313F` |
| `muted` | `#4F5B6B` |
| `faint` | `#5F6B7A` |
| `line` | `#DFE4ED` |
| `accent` | `#2554C7` |
| `accent-hover` | `#1F48B0` |
| `accent-press` | `#1A3C93` |
| `accent-soft` | `#EEF3FF` |
| `on-accent` | `#FFFFFF` |
| `danger` | `#BC303B` |
| `danger-soft` | `#FDF1F2` |
| `danger-line` | `#E8A6AC` |

Dark:

| Token | Value |
|---|---|
| `canvas` | `#0F1115` |
| `surface` | `#16181D` |
| `surface-inset` | `#111318` |
| `surface-hover` | `#1D2026` |
| `ink` | `#F2F4F8` |
| `body` | `#D5DBE5` |
| `muted` | `#A7B0BD` |
| `faint` | `#8B94A3` |
| `line` | `#262A32` |
| `line-strong` | `#363B45` |
| `accent` | `#4F7CFF` |
| `accent-hover` | `#6A8FFF` |
| `accent-press` | `#3F66D9` |
| `accent-soft` | `#1C2440` |
| `on-accent` | `#FFFFFF` |
| `danger` | `#F97066` |
| `danger-soft` | `#2C1614` |
| `danger-line` | `#7A2F28` |

Rules:

- Success and warning must not be green/amber unless the palette rule is explicitly relaxed. Prefer neutral labels plus icon/word, or blue for success and red for warning/error.
- Every foreground/background pair must meet WCAG AA for its size.
- `faint` is not used for body copy or essential controls.
- Disabled text uses a dedicated `disabled-text` token, not `faint`.
- `on-accent`, `on-danger`, and `on-surface` are tokens, never hardcoded.

### 7.4 Shape and elevation

- One radius: 5 px.
- One border: 1 px.
- One focus ring: 2 px, offset by 1 px.
- One elevation: hairline border plus optional subtle shadow only on overlays.
- No pill-shaped buttons, no glass effects, no random shadows.
- Circular dots and status indicators are the only non-5 px shapes, and only when semantically circular.

### 7.5 Interaction states

Every control must define:

| State | Behavior |
|---|---|
| Rest | token-driven surface and label |
| Hover | 120 ms background/border transition; darker or tinted, never white on white |
| Press | 80 ms press color; no layout shift |
| Focus | 2 px focus ring, visible on both themes |
| Disabled | neutral fill, muted text, no hover or press response |
| Busy | spinner and disabled actions; no duplicate submissions |
| Read-only | selectable text, no edit affordance |

No state may rely on color alone. Icons and labels remain legible in both themes.

### 7.6 Motion

Use one motion system:

| Interaction | Duration |
|---|---:|
| Hover | 120 ms |
| Press | 80 ms |
| Selection | 160 ms |
| Expander | 180 ms |
| Overlay | 180 ms |
| Page switch | 180 ms opacity only |

Easing: ease-out. Never animate width, height, or layout position for content that can contain text; it causes text reflow and jank. Animate opacity, background color, border color, and small transforms.

Add a “Reduce motion” preference. When enabled, all durations become zero except essential progress indicators.

### 7.7 Pointer, keyboard, and accessibility

- Pointer cursor on every clickable control.
- Hand cursor on links, default on text.
- Tab order follows visual order.
- Enter activates buttons and default actions.
- Space toggles checkboxes.
- Escape closes the top overlay.
- Arrow keys navigate lists and combo boxes.
- Ctrl+K opens the command palette.
- Ctrl+S saves the current block or form.
- Focus is trapped in dialogs and restored on close.
- Accessible role, label, value, checked, expanded, disabled, and read-only are set for custom controls.
- Screen-reader labels match visible labels.
- All text that can be read can be selected or copied.

### 7.8 Empty, loading, error, and success states

Every data page has:

- loading skeleton or “Loading…” with a stable layout;
- empty state with one action;
- error state with a title, explanation, and retry;
- success state that does not steal focus;
- offline state where applicable.

No giant blank panel without an explanation. No raw exception text. No toast that disappears before it can be read.

---

## 8. Slint implementation standards

### 8.1 Use Slint primitives correctly

Mandatory:

- `ListView` for sessions, students, materials, notes, markers, guide blocks, journal entries, and large option sets.
- `ScrollView` for scrollable pages; if a custom scrollbar is required, build it on top of the standard behavior, not instead of it.
- `TextEdit` for the guide editor, transcript text, diagnostics, and read-only logs.
- `MenuBar` or `PopupWindow` for real menus.
- `PopupWindow` or the Slint usecases modal pattern for dialogs.
- `FocusScope` for keyboard focus and focus trapping.
- `TouchArea` for hit targets, with correct enabled and cursor state.
- `animate` for color/opacity only.
- `@tr` for user-facing strings.

### 8.2 Component library

Create a small, tested component set:

```text
ui/
  shell.slint
  tokens.slint
  components/
    AppButton.slint
    AppIconButton.slint
    AppTextField.slint
    AppTextArea.slint
    AppComboBox.slint
    AppCheckbox.slint
    AppTabs.slint
    AppDialog.slint
    AppMenu.slint
    AppTooltip.slint
    AppScroller.slint
    AppEmptyState.slint
    AppErrorState.slint
    AppSkeleton.slint
    AppPropertyRow.slint
  pages/
    journal-page.slint
    sessions-page.slint
    session-inspector.slint
    notebook-page.slint
    transcript-page.slint
    recording-page.slint
    study-guide-page.slint
    students-page.slint
    materials-page.slint
    guides-page.slint
    settings-page.slint
    developer-page.slint
  overlays/
    confirm-dialog.slint
    command-palette.slint
    archive-dialog.slint
    export-dialog.slint
  models/
```

No page may define a new button, text field, scrollbar, or combo box.

### 8.3 State shape

Each page gets one typed state object:

```text
JournalPageState {
  loading;
  error;
  entries : [EntrySummary];
  selectedEntryId;
  query;
  filter;
  sort;
  page;
}
```

Slint receives one `JournalPageModel` and emits typed intents:

- `selectEntry(id)`;
- `createEntry(form)`;
- `updateEntry(id, patch)`;
- `deleteEntry(id, confirmation)`;
- `search(query, filter, sort, page)`.

The page never receives a raw JSON string.

### 8.4 Layout rules

- Use `HorizontalLayout`/`VerticalLayout`/`GridLayout`; no absolute positioning for content.
- Use `min-width: 0` on flexible text containers.
- Set `clip: true` on panes only, not on cards inside them.
- Text uses `wrap: word-wrap` or `overflow: elide` deliberately.
- Every fixed-width element has a documented reason.
- No control may rely on the parent being exactly 1600 px.
- Test logical widths, not physical pixels.

### 8.5 Theme switching

- All colors come from `Theme`.
- Theme mode is applied at the window root.
- Settings change is immediate and persists to the archive.
- The theme switch does not remount the page or reload data.
- A screenshot test renders every page in light and dark.
- No hardcoded `#ffffff`, `#000000`, or `#14171c` outside tokens.

### 8.6 Text selection

- `ScrollText` is replaced by a read-only `TextEdit` or a selectable text block.
- Add a Copy action for output panels.
- Context menus support Cut/Copy/Paste/Select All where appropriate.
- Guide and transcript text behaves like a native document, not a screenshot.

### 8.7 Internationalization

- Wrap all strings in `@tr`.
- Use sentence case.
- Do not build sentences by concatenating fragments; use complete translated messages.
- Dates use locale-aware formatting.
- Numeric/time formatting uses locale rules.
- Right-to-left layouts must not break; test at least one RTL locale if supported.

---

## 9. Data and performance implementation

### 9.1 Workspace snapshot

Replace `loadWorkspaceSnapshot` with one service call that:

- opens the archive once;
- reads the manifest and commit generation;
- queries paged/indexed summaries;
- returns typed DTOs;
- does not run CLI commands;
- does not parse JSON;
- does not load full recordings or asset blobs;
- returns counts from indexes or maintained fields.

No UI refresh may call `student list`, `session list`, `journal entry list`, `collection list`, `tag list`, or `template list` through the command dispatcher.

### 9.2 Pagination and indexes

- Sessions: page size 100, index by date/student.
- Journal entries: page size 50, index by date/title/collection/tag.
- Students: page size 100, alphabetical.
- Materials: page size 100, type/date.
- Transcript: page size 200 segments.
- Guide blocks: load only the selected guide.
- Search results: server-side filtering and pagination.
- Counts: maintained counters or index counts, never full scans.

### 9.3 Incremental patches

After a command:

- create returns the new row plus new generation;
- update returns the changed row fields;
- delete returns the removed ID;
- bulk operations return affected IDs and counts.

The UI updates the model in place. It does not rebuild the entire workspace.

### 9.4 Caching

- Cache overview summaries by archive generation.
- Cache selected session detail by session ID and revision.
- Invalidate on generation change.
- Do not cache passphrases, secrets, decrypted blobs, or provider credentials.
- Keep caches bounded; evict via LRU.

### 9.5 Threading

Replace:

- `BackgroundTasks`;
- `commandThreads`;
- ad hoc playback threads;

with:

- `TaskExecutor` (2–4 workers);
- `CancellationSource` per view generation;
- `RecordingWorker`;
- `PlaybackWorker`.

Rules:

- No completed thread remains in a container.
- No task launches if a newer generation has superseded it.
- Long archive reads check cancellation between pages.
- `join` happens at shutdown only for workers that are still active.
- Thread count metric is exposed to diagnostics.

### 9.6 Memory

- No full audio buffers in the UI.
- Asset previews are capped and streamed.
- Transcript pages are bounded.
- Models are replaced or updated, not duplicated.
- Raw command output is not retained after the operation unless the user opens Developer Console.
- Secret strings are wiped after use.
- Add a soak test: 100 refreshes and 100 commands; private memory must not grow more than 10%.

### 9.7 Reference scenarios

Benchmark against:

- empty archive;
- one student, one session;
- 100 students, 1,000 sessions, 10,000 notes;
- 4-hour recording;
- 10,000 transcript segments;
- 1,000 guide blocks;
- 100 MB asset;
- archive with 10,000 revisions;
- sanitized copy and package export.

Store results in CI artifacts.

---

## 10. Bundle-size plan

### 10.1 Current contributors

- Slint static runtime.
- PoDoFo and its large font/XML/image closure.
- OpenSSL and libcurl closure.
- Whisper/ggml and libgomp.
- Podofo/freetype/harfbuzz/glib/pcre/brotli.
- Unstripped debug sections.
- Four embedded font files.
- Image decoders (PNG/WebP/GIF).

### 10.2 Target profiles

#### Profile A: `release-min`

Purpose: smallest usable desktop app.

Includes:

- Slint desktop;
- archive engine and encryption;
- students, sessions, journals, notes;
- transcript text/SRT/VTT import and editing;
- guide editing and Markdown/HTML/JSON export;
- materials;
- settings;
- CLI;
- optional PDF/DOCX/Whisper loaded as native packs.

Excludes from the executable:

- PoDoFo;
- libcurl/OpenSSL;
- Whisper/ggml;
- FFmpeg;
- llama.cpp;
- debug symbols;
- unused Slint features.

Target: 35–45 MB.

#### Profile B: `release-full`

Purpose: single portable executable with every feature in one file.

Includes all Profile A features plus:

- PDF export;
- DOCX export;
- Whisper;
- network providers;
- optional codec support.

Target: 55–65 MB. This is the honest minimum for one file with all engines. A 20 MB all-features build is not credible.

#### Profile C: `release-dev`

Purpose: fast local iteration.

- shared Slint;
- tests;
- no stripping;
- no size gate.

Not shipped.

### 10.3 Build flags

- `CMAKE_BUILD_TYPE=MinSizeRel` for release.
- `-Os` (or `-Oz` where supported) instead of `-O3`.
- LTO enabled.
- `-ffunction-sections -fdata-sections`.
- `-Wl,--gc-sections`.
- `-s` and `strip --strip-unneeded` for final PNG/PE.
- Cargo/Slint:
  - `opt-level = "z"`;
  - `lto = "fat"`;
  - `codegen-units = 1`;
  - `strip = "symbols"`;
  - test `panic = "abort"`; revert if Slint requires unwinding.
- Disable `SLINT_FEATURE_INTERPRETER`.
- Disable `SLINT_FEATURE_TESTING`.
- Disable `SLINT_FEATURE_SYSTEM_TRAY`.
- Disable `SLINT_FEATURE_LIVE_PREVIEW`.
- Choose one renderer for production.
- Keep accessibility.

### 10.4 Dependency removal

- **PoDoFo:** replace with the existing custom PDF writer or a minimal PDF writer. Extend the existing `pdf_export_wasm.cpp` logic for desktop. Remove `podofo`, `libxml2`, `glib`, `harfbuzz`, `graphite2`, `pcre2`, brotli, and duplicate image decoders where possible.
- **libcurl/OpenSSL:** use WinHTTP/SChannel on Windows and platform APIs elsewhere. Keep provider behavior and timeouts. This removes OpenSSL, libssh2, nghttp2, ngtcp2, psl, unistring, idn2, zstd, and related licensing/security surface.
- **Whisper:** make it a native optional pack loaded only for transcription. This removes `ggml`, `libgomp`, and OpenMP threads from the idle GUI.
- **FFmpeg:** optional pack only; never in the base.
- **llama.cpp:** optional pack only; never in the base.
- **Image formats:** one decoder path per platform where possible.
- **Fonts:** retain Noto Sans; consider a variable font or two weights after the type scale is reduced. Do not subset in a way that breaks multilingual content.

### 10.5 Size acceptance

Add a `size` target and CI check:

```text
Base TS limit: 45,000,000 bytes
Full TS limit: 65,000,000 bytes
```

Fail on regression. Record:
- `.text`;
- `.rdata`;
- `.data`;
- debug sections;
- largest linked libraries;
- compressed installer size if applicable.

No UPX. No runtime self-extraction. No hidden pack download without user consent.

---

## 11. Testing strategy

### 11.1 Core and integration

Preserve and extend the existing suites:

- archive format, indexes, compression, encryption, locking, recovery, compaction;
- session packages;
- students, sessions, journal, annotations, transcripts, evidence, guides, templates, settings;
- audio import/export, timeline, waveform, multitrack;
- PDF/DOCX/HTML/Markdown;
- AI protocol fixtures;
- sanitized copy;
- diagnostics and benchmarks;
- CLI matrix.

### 11.2 GUI tests

Add a headless GUI test harness:

- launch `MainWindow` with a test archive;
- render at 1024×768, 1280×800, 1440×900, 1600×1000;
- capture light and dark images;
- compare against approved golden images with a tolerance;
- assert no text is clipped at panel boundaries;
- assert inspector is populated when a session is selected;
- assert dialog focus is trapped;
- assert primary/secondary/ghost/danger hover states;
- assert disabled controls do not change on hover;
- assert text is selectable;
- assert list virtualization (row count stays bounded).

### 11.3 Interaction tests

- hover every button variant;
- press/hold;
- keyboard Tab/Enter/Space/Escape;
- combo box open/close/arrow selection;
- text selection/copy/paste;
- drag-and-drop file import;
- window resize while a dialog is open;
- theme switch while a dialog is open;
- long text, empty text, and Unicode;
- 150% DPI.

### 11.4 Performance tests

- startup;
- workspace snapshot;
- 100 rapid session selections;
- 100 note edits;
- 1,000 session list scroll;
- 10,000 transcript segment search;
- recording start/stop;
- memory after 100 commands;
- thread count before/after tasks;
- binary size.

### 11.5 Security tests

- archive encryption/passphrase rotation;
- credential storage;
- sanitized copy selection;
- import path traversal;
- asset MIME and size limits;
- AI output and prompt injection boundaries;
- no plaintext credentials in sanitized copies;
- no path escapes from `.tux` assets.

### 11.6 Fuzzing and sanitizers

- JSON parser fuzzing.
- Archive frame/index parser fuzzing.
- Transcript import fuzzing.
- WAV parser fuzzing.
- ASan/UBSan on core suites.
- TSan or targeted race tests for executor/cancellation.

### 11.7 Coverage

- 100% of user-visible feature families have at least one end-to-end test.
- Deterministic core: target 90% line and 95% branch coverage.
- GUI controllers: target 80% branch coverage through headless tests.
- Hardware/live-provider paths: documented qualification matrix; no fake tests.
- Measure and publish the real number; do not claim 100% through exclusions.

### 11.8 CI

Re-enable:

- format check;
- compile warnings as errors;
- core tests;
- GUI tests;
- size check;
- memory check;
- ASan/UBSan;
- Windows release build;
- Linux/macOS compile jobs;
- dependency pin monitor;
- release qualification.

---

## 12. Release acceptance checklist

Every item below must have an owner, a test, and a pass result. This preserves the existing 31-gate checklist and adds the new quality bar.

### 12.1 Original release gates

1. Executable runs without a programming runtime or separate service.
2. GUI contains no Qt, Electron, Tauri, or embedded browser.
3. Every core GUI operation is accessible through the CLI.
4. Code follows the C++23 composition/no-application-inheritance standard.
5. Archive discovery scans only the immediate selected directory.
6. No archive causes initialization of a new portable `.tux` workspace.
7. One archive opens directly; multiple archives show an explicit selector.
8. All persistent workspace data is inside single-file `.tux` archives.
9. No persistent extracted workspace, sidecar database, or global configuration is required.
10. No application-managed AppData, XDG, home, global cache, or system directory is created.
11. Archive updates do not rewrite unrelated complete recordings.
12. Archive recovery passes interrupted-write and power-failure simulations.
13. Archive compaction preserves all live records and revision history.
14. Windows, macOS, and Linux pass the defined feature matrix.
15. Full-session audio recording and recovery tests pass.
16. Local transcription works with user-provisioned models.
17. Tutor annotations remain timestamped and editable.
18. Image, document, audio, and video assets import safely.
19. Evidence records preserve valid source relationships.
20. BYOK generation supports tested provider protocols and dynamic models.
21. External chat-agent prompt export and response import work without an API key.
22. Ollama and llama.cpp are supported without bundled LLM weights.
23. Model and asset compatibility are checked before requests.
24. Guides distinguish explicit tutor instructions from AI recommendations.
25. Guide editing, revisions, source inspection, and approval work.
26. PDF, DOCX, HTML, and Markdown exports pass fidelity tests.
27. Idle CPU, memory, startup, binary size, and responsiveness are benchmarked.
28. Security tests cover archives, credentials, imported assets, and AI output.
29. No known critical data-loss, security, or memory-safety defect remains.
30. Static WASM edition operates without a mandatory backend. **Paused by explicit instruction.**
31. Documentation covers commands, formats, algorithms, security, and limitations.

### 12.2 New UI gates

32. No overflow at 1024×768, 1280×800, 1440×900, or 1600×1000.
33. Light mode screenshot passes all screens.
34. Dark mode screenshot passes all screens.
35. Every hover state has readable contrast.
36. Disabled controls do not respond to hover.
37. The notebook never clips under the inspector.
38. The bottom transport/status is always reachable.
39. The session inspector is populated whenever a session is selected.
40. Long output is selectable and copyable.
41. Dialogs trap and restore focus.
42. All long lists use `ListView`.
43. No raw UUID or CLI syntax in primary UI.
44. No duplicate primary action in a page region.
45. No page uses more than the approved type scale.
46. No hardcoded color outside the theme token file.
47. The README screenshot matches the current build.
48. Theme switching does not reload the archive.

### 12.3 New performance gates

49. Empty picker private memory under 45 MB.
50. 1,000-session archive private memory under 100 MB.
51. No more than 8 application-owned threads.
52. Session selection first paint under 80 ms.
53. 1,000-session refresh under 100 ms.
54. 10,000-note list is virtualized and stable.
55. 100-action soak does not grow private memory by more than 10%.
56. Base binary under 45 MB.
57. Full single-file binary under 65 MB.

### 12.4 New correctness gates

58. Notebook selection change flushes the pending save before loading the next block.
59. Empty block text persists.
60. No command opens the archive twice in one overview refresh.
61. No transcript full scan in the session-list path.
62. No `archiveCommand` call from a UI controller.
63. No GUI parsing of human-readable command output.
64. No stale snapshot overwrites a newer selection.
65. All errors map to user-readable messages.
66. Every destructive action has preview and confirmation.
67. Every feature in section 13 remains reachable.

---

## 13. Feature preservation matrix

This matrix is the “nothing removed” contract.

### 13.1 Archive

- Create archive.
- Open archive.
- Discover archives in the immediate directory.
- One archive auto-open.
- Multiple archive chooser.
- Archive info/status.
- Verify quick/full.
- Backup/copy.
- Sanitized copy preview.
- Sanitized copy confirm.
- Include/exclude students, sessions, tracks.
- Include/exclude recordings.
- Include/exclude private annotations.
- Include/exclude generation logs.
- Include/exclude credentials.
- Archive encryption.
- Change passphrase.
- Forget passphrase.
- Recovery inspection.
- Recover unpublished commit.
- Discard uncommitted tail.
- Header repair copy.
- Compact.
- Metadata-only and locked archive states.
- File locking and sharing behavior.

### 13.2 Students

- Create.
- List.
- Show.
- Update name, grade, subjects, objectives, difficulties, notes.
- Preferred guide template.
- Delete.
- History.
- Progress.
- Progress review with evidence and classification.
- Cross-session evidence rules.
- Student picker in sessions.
- Unassign student.

### 13.3 Sessions

- Create notes-only.
- Create record-audio.
- Create import-recording.
- Attach to journal entry.
- List.
- Show.
- Update title, subject, objectives, state.
- Clone.
- Archive.
- Start.
- Complete.
- Review.
- Resume.
- Delete dry-run.
- Delete confirm with scope token.
- Recover capture/WAV.
- Export session package.
- Import session package.
- Multi-archive package flow.
- Session source: microphone, system audio, application audio.
- Language selection.
- Guide template selection.
- Timeline.
- Markers.
- Session notes.

### 13.4 Journal

- Entries create/list/show/update/delete.
- Search.
- Collections create/list/show/update/delete.
- Tags create/list/show/update/delete.
- Date filters.
- Session filters.
- Timeline.
- Entry sessions.
- Notes document show.
- Notes block add/update/remove/move.
- Block kinds: paragraph, heading, bulleted list, numbered list, checklist, quote, code.
- Inline formatting: bold, italic, strike, code, link.
- Autosave.
- Save status.
- Revision history.
- Source linking.

### 13.5 Transcript

- Import text.
- Import SRT.
- Import VTT.
- Optional Whisper generation.
- List/show.
- Search.
- Export text/SRT/VTT/JSON.
- Correct text.
- Timestamp.
- Split.
- Merge.
- Speaker assign/unknown.
- Verify.
- History.
- Restore.
- Plan resources.
- Generate.
- Refine.
- Source cues.
- Provisional/human-verified state.
- Full-scan counts replaced with indexed counts in navigation.

### 13.6 Annotations and evidence

- Add annotation.
- List.
- Show.
- History.
- Update.
- Prioritize.
- Merge.
- Split.
- Link to asset/evidence/transcript.
- Unlink.
- Remove.
- Duplicate if present.
- Timestamped markers.
- Evidence extraction.
- Evidence list.
- Evidence show.
- Evidence graph.
- Approve.
- Reject with reason.
- Verify.
- Source relationships.
- Contradiction relationships.
- Evidence revision state.
- Progress review source rules.

### 13.7 Materials

- Add file.
- Import folder.
- List.
- Show.
- Preview image.
- Preview text/document.
- Preview waveform.
- Preview native image.
- MIME detection.
- Verify content hash.
- Extract.
- Remove.
- Link to annotation.
- Link to transcript.
- Unlink.
- Drag-and-drop import.
- Size limits.
- Unsupported media fallback.
- Chunked asset blobs.
- Content-addressed storage.

### 13.8 Guides and templates

- Generate from session.
- Generate from journal entry.
- List.
- Show.
- Edit title.
- Edit block text.
- Change block kind.
- Add block.
- Remove block.
- Move block.
- Move section.
- Add example.
- Regenerate section.
- Validate sources.
- Inspect source.
- Compare revisions.
- Approve.
- Export Markdown.
- Export HTML.
- Export JSON.
- Export PDF.
- Export DOCX.
- Images and tables.
- Stale source handling.
- Inline source references.
- AI recommendation vs tutor instruction labels.
- Guide source index.
- Guide revision history.
- Templates create/list/show/update/import/export/delete.

### 13.9 Recording and playback

- Enumerate devices.
- Microphone.
- System audio.
- Application audio.
- Preflight.
- Input level.
- Consent.
- Start.
- Pause.
- Resume.
- Stop.
- Status.
- Recover capture.
- Import WAV.
- Export WAV.
- Play.
- Seek.
- Waveform.
- Multitrack.
- Synchronized timeline.
- Interrupted capture recovery.
- Recording worker IPC.
- Crash-safe commits.
- Audio duration and markers.

### 13.10 AI

- Provider list.
- Model list.
- Model discovery.
- Capabilities.
- Configure.
- Test.
- Context preview.
- Package for external agent.
- Import external response.
- Generate.
- Refine.
- Jobs.
- Cancel.
- Estimate.
- Manual mode.
- OpenAI-compatible providers.
- Native Anthropic.
- Native Gemini.
- Native Cohere.
- Native Perplexity.
- Native OpenAI Responses.
- Ollama.
- llama.cpp server.
- Optional embedded llama.cpp.
- Dynamic model compatibility.
- Confirmation hash.
- Sensitive-content warning.
- No bundled weights.
- Provider credentials.
- Local loopback endpoint restrictions.
- HTTPS validation for remote endpoints.
- Response size/content validation.

### 13.11 Diagnostics and benchmarks

- Run diagnostics.
- Archive diagnostics.
- Audio diagnostics.
- Graphics diagnostics.
- Provider diagnostics.
- Network diagnostics.
- Report export.
- Startup benchmark.
- Memory benchmark.
- CPU benchmark.
- Audio benchmark.
- Indexing benchmark.
- Rendering benchmark.
- Export benchmark.
- Performance counters in UI.
- Bounded logs.
- Redacted support report.

### 13.12 Settings and CLI

- Settings list/get/set/reset.
- Settings import.
- Copy settings from another archive.
- Credential list/remove.
- Theme setting.
- Marker shortcuts.
- CLI help.
- JSON output.
- Progress output.
- Cancellation.
- All command families.
- Developer console as an advanced surface, not the primary UI.

### 13.13 GUI and platform

- First launch.
- No archives.
- One archive.
- Multiple archives.
- Archive locked/unlocked.
- Recovery panel.
- Sanitized copy panel.
- Export panel.
- New session.
- New student.
- Settings.
- Developer console.
- Recording consent.
- Recording panel.
- AI panel.
- Archive panel.
- Journal tools.
- Guide editor.
- Theme switching.
- Keyboard shortcuts.
- Drag-and-drop.
- Window resizing.
- DPI scaling.
- Windows packaging.
- Linux/macOS source builds.
- WASM source paused, not deleted.

---

## 14. Implementation phases

### Phase 0: Baseline and guardrails (2–3 days)

Goals:

- freeze feature work;
- capture current screenshots at all sizes/modes;
- build screenshot harness;
- create memory/thread/size measurement scripts;
- add CI jobs in disabled mode locally;
- commit a baseline report.

Tasks:

- Add `tests/gui_visual_test.cpp` or equivalent.
- Add `tests/performance_budget_test.cpp`.
- Add `tests/size_report.cmake`.
- Capture `docs/images` fresh at 1024, 1280, 1440, 1600.
- Add README warning if needed until fixed.
- Record current failures in a checklist.

Exit:

- Reproducible screenshots and metrics.
- A failing test that proves the overflows and blank inspector.

### Phase 1: Data path and threading (5–7 days)

Goals:

- one archive open per refresh;
- typed overview;
- bounded executor;
- no stale snapshot races;
- notebook autosave correctness.

Tasks:

- Add application service layer.
- Add `WorkspaceService`, DTOs, patch result.
- Remove CLI calls from `loadWorkspaceSnapshot`.
- Add `TaskExecutor` and cancellation.
- Remove unbounded `BackgroundTasks` and `commandThreads`.
- Implement one archive handle per workspace.
- Add indexed counts and pagination.
- Fix notebook save snapshot.
- Add tests for thread count, 100 commands, 1,000 sessions, autosave selection change.

Exit:

- Overview refresh under 100 ms on reference archive.
- No thread growth.
- No full transcript scan for session list.
- Autosave tests pass.

### Phase 2: Shell and responsive layout (4–6 days)

Goals:

- no overflow;
- no clipped transport;
- no blank inspector;
- proper breakpoints.

Tasks:

- Replace absolute center/inspector layout with `HorizontalLayout`.
- Set default 1280×800 and min 900×560.
- Add navigator/inspector collapse.
- Add responsive page padding.
- Fix notebook width and wrapping.
- Fix bottom transport/status layout.
- Fix `SessionInspector` population.
- Add screenshot tests at 1024/1280/1440/1600 and 125%/150%.
- Verify light/dark.

Exit:

- All layout gates pass.
- README screenshot regenerated.

### Phase 3: Design system and component state (5–7 days)

Goals:

- elegant, consistent interaction;
- perfect light/dark;
- no hover bugs.

Tasks:

- Replace ad hoc fonts with the four-step scale.
- Add `on-accent`, `on-danger`, `on-surface`, disabled tokens.
- Replace green/amber statuses if palette rule is strict.
- Rewrite `AppButton` with a single computed state model.
- Rewrite transport Stop hover and other hardcoded states.
- Add hover/focus/press/disabled/busy to every control.
- Add pointer cursor and tooltips.
- Add motion tokens and apply consistently.
- Remove hardcoded colors.
- Replace `ScrollText` with selectable text.
- Add copy actions.
- Add dialog focus trap.
- Add empty/loading/error components.
- Add screenshots for every state.

Exit:

- Interaction state matrix passes.
- No inaccessible contrast.
- Both themes visually complete.
- No hover causes invisible text.

### Phase 4: Page architecture and UX (8–12 days)

Goals:

- replace modal/forms with pages;
- remove raw IDs from primary UI;
- preserve all features.

Tasks:

- Build shell navigation.
- Journal list/detail page.
- Sessions page with tabs.
- Full guide editor page.
- Students page.
- Materials page.
- Guides page.
- Settings page.
- Developer page.
- Archive/sanitization/recovery flows.
- Recording page/transport.
- AI page/panel.
- Command palette.
- Migrate raw IDs and console.

Exit:

- All features reachable in two clicks from their area.
- No raw UUID in normal workflow.
- No duplicate primary actions.
- All screens have empty/loading/error.

### Phase 5: Lists, caching, and visual performance (4–6 days)

Goals:

- smooth scrolling;
- stable memory;
- no full-list allocation.

Tasks:

- Replace all long `for` lists with `ListView`.
- Add model filtering.
- Add pagination.
- Add incremental patches.
- Add selected-item caching.
- Remove per-refresh model recreation.
- Add scroll benchmarks.

Exit:

- 10,000-note scroll stable.
- 1,000-session list stable.
- No full snapshot on selection.

### Phase 6: Bundle reduction (6–10 days)

Goals:

- under 45 MB base;
- under 65 MB full single exe.

Tasks:

- strip and MinSizeRel.
- disable Slint release features.
- Cargo size profile.
- remove PoDoFo using custom PDF.
- platform HTTP/TLS.
- lazy Whisper package.
- remove debug/unused dependencies.
- add size CI.
- produce profile matrix.

Exit:

- Size budgets pass.
- Functionality matrix unchanged.
- Startup/memory measured.

### Phase 7: Hardening and release (5–7 days)

Tasks:

- full feature matrix.
- security tests.
- ASan/UBSan.
- 100-action soak.
- long recording test.
- package/import tests.
- screenshot goldens.
- CI re-enabled.
- README screenshots updated.
- release qualification.

Exit:

- All 67 gates pass.
- Only WASM paused.
- Artifact signed/stripped where applicable.
- Release notes state measured limits.

---

## 15. Risks and mitigation

### Risk: Slint custom text editor is not mature enough

Mitigation: use built-in read-only `TextEdit` for output; keep the piece-table editor only where rich block editing requires it; add extensive tests; do not build a browser editor.

### Risk: one-file size versus optional engines

Mitigation: define two release profiles. Base under 45 MB with native packs; all-features single file under 65 MB. State the tradeoff explicitly.

### Risk: removing PoDoFo breaks PDF fidelity

Mitigation: port export tests first; compare PDF output page count, text, images, tables, unicode; keep PoDoFo available only in a `full-pdf` development profile until parity is proven.

### Risk: platform HTTP changes provider behavior

Mitigation: keep the transport interface; test all providers against loopback fixtures; test timeouts, TLS, redirects, and streaming.

### Risk: async UI changes introduce races

Mitigation: typed generation tokens, cancellation, no stale apply, headless tests with artificial latency.

### Risk: navigation redesign hides features

Mitigation: feature preservation matrix and a “find any action” command palette; automate a reachability test for every command.

### Risk: dark mode still has hardcoded colors

Mitigation: fail CI on new color literals outside `theme.slint`; screenshot every page in both modes.

### Risk: size work causes performance regressions

Mitigation: benchmark `-Os` versus `-O2` per module; keep compute-heavy modules at `-O2` if needed; measure, do not guess.

---

## 16. File-level target map

```text
src/
  application/
    workspace-service.cpp/.hpp
    session-service.cpp/.hpp
    journal-service.cpp/.hpp
    student-service.cpp/.hpp
    transcript-service.cpp/.hpp
    annotation-service.cpp/.hpp
    asset-service.cpp/.hpp
    evidence-service.cpp/.hpp
    guide-service.cpp/.hpp
    template-service.cpp/.hpp
    recording-service.cpp/.hpp
    ai-service.cpp/.hpp
    settings-service.cpp/.hpp
    diagnostics-service.cpp/.hpp
    package-service.cpp/.hpp
    task-executor.cpp/.hpp
    workspace-snapshot.cpp/.hpp
    workspace-patch.cpp/.hpp
  gui/
    desktop.cpp                 (thin composition root)
    controllers/
      journal-controller.cpp
      sessions-controller.cpp
      students-controller.cpp
      materials-controller.cpp
      guides-controller.cpp
      settings-controller.cpp
      recording-controller.cpp
      ai-controller.cpp
ui/
  shell.slint
  tokens.slint
  components/
  pages/
  overlays/
  models/
tests/
  ui/
    screenshot_test.cpp
    interaction_test.cpp
    layout_test.cpp
    theme_test.cpp
  performance/
    memory_test.cpp
    thread_test.cpp
    startup_test.cpp
  size/
    size_report.cmake
```

Keep `src/command/dispatcher.cpp` as the CLI adapter. Split it by command family only after services exist. Do not move all logic at once.

---

## 17. Documentation updates

Update:

- `README.md` with the new screenshots, run/build instructions, performance and size status, and the optional-pack model.
- `docs/archive-format/` only if behavior changes.
- `docs/audio/` for recording/transport UI.
- `docs/guides/` for the new editor.
- `docs/ai/` for platform HTTP and provider setup.
- `docs/dependencies/` for the dependency reduction.
- `docs/diagnostics/` for new budgets.
- `REFERENCE.md` release checklist: check off only after tests pass.
- Add `docs/design/SYSTEM.md` and `docs/design/MOTION.md`.
- Add `docs/performance/BUDGETS.md`.
- Add `docs/development/UI-TESTING.md`.

---

## 18. Final release decision

The release candidate is approved only when:

- Every non-WASM gate in section 12 passes.
- The full feature matrix in section 13 is reachable.
- The measured metrics in section 2.3 pass.
- The binary is stripped and under the selected budget.
- CI is green.
- The README screenshot and claims match the build.
- The only paused area is the static WASM edition, as explicitly allowed.

Until then, the application is a strong engineering preview, not a polished 1.0.

---

## 19. Plan rule

If an implementation step would remove a capability, stop. Relocate it, hide it under Developer, put it behind an optional native pack, or rewrite its implementation. Do not delete it from the product.

---

## 20. Appendix A: exact CLI preservation inventory

The CLI remains the complete authoritative command interface. The GUI is a second adapter over the same services. The following command families and operations are preserved.

### Global

- `--archive FILE`
- `--directory DIR`
- `--passphrase-env NAME`
- `--new-passphrase-env NAME`
- `--source-passphrase-env NAME`
- `--json`
- `--quiet`
- `--verbose`
- `--no-color`
- `--help`
- `--version`

### Archive

- `archive discover [--directory DIR]`
- `archive init FILE --name NAME`
- `archive list`
- `archive info [FILE]`
- `archive verify [FILE] [--full]`
- `archive backup FILE --output FILE --confirm-sensitive`
- `archive copy FILE --output FILE --confirm-sensitive`
- `archive sanitize FILE --output COPY.tux [selection options]`
  - preview first;
  - confirm with `--confirm-sensitive --expected-generation N --expected-selection SHA256 --expected-output FILE`;
  - include/exclude students;
  - include/exclude sessions;
  - include/exclude recording tracks;
  - include recordings;
  - include private annotations;
  - include generation logs;
  - include credentials;
  - new passphrase environment.
- `archive repair FILE --output COPY.tux --confirm-sensitive`
- `archive compact`
- `archive recover [FILE]`
  - inspect only;
  - `--recover-unpublished`;
  - `--discard-tail`.
- `archive encrypt FILE`
- `archive unlock FILE`
- `archive change-passphrase FILE --new-passphrase-env NAME`

### Student

- `student create --name NAME [--grade GRADE] [--subjects LIST] [--demonstrated-improvements TEXT] [--preferred-guide-template ID]`
- `student list`
- `student show ID`
- `student update ID [FIELDS]`
- `student delete ID`
- `student history ID`
- `student progress ID`
- `student progress-review ID --skill SKILL --classification CLASS --evidence-ids UUID,... --reviewed-by NAME [--note TEXT]`
- `progress-edit` alias for `progress-review`
- classifications:
  - `newly-observed`;
  - `recurring`;
  - `partial-improvement`;
  - `demonstrated-mastery`;
  - `unverified-improvement`;
  - `not-revisited`.

### Journal

- `journal entry list [--query TEXT] [--collection-id UUID] [--tag-id UUID] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--has-sessions true|false]`
- `journal entry create [--title TITLE] [--date YYYY-MM-DD] [--collection-ids UUID,...] [--tag-ids UUID,...]`
- `journal entry show ID`
- `journal entry update ID [FIELDS] [--date YYYY-MM-DD|--clear-date]`
- `journal entry delete ID`
- `journal collection list|create|show|update|delete`
- `journal tag list|create|show|update|delete`
- `journal search --query TEXT [--collection-id UUID] [--tag-id UUID] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--has-sessions true|false]`
- `journal document show ID [--revision N]`
- `journal document update ID --text TEXT [--block-id ID]`
- `journal document add-block ID --kind KIND --text TEXT [--block-index N]`
- `journal document remove-block ID --block-id ID`
- `journal document move-block ID --from N --to N`

### Session

- `session create [--entry-id UUID] [--type notes-only|record-audio|import-recording] [--student-id UUID] [--subject SUBJECT] [--title TITLE] [--language auto|CODE] [--guide-template ID] [--recording-source SOURCE]`
- `session list [--entry-id UUID] [--from YYYY-MM-DD] [--to YYYY-MM-DD]`
- `session show ID`
- `session update ID`
- `session clone ID`
- `session archive ID`
- `session start ID`
- `session complete ID`
- `session review ID`
- `session resume ID`
- `session delete ID [--dry-run]`
- `session delete ID --confirm-scope --scope-token TOKEN`
- `session recover --session UUID`
- `session export ID --output PACKAGE.tux [--force]`
- `session import PACKAGE.tux [--student-id UUID]`

### Annotation

- `annotation add --session UUID --type TYPE --at HH:MM:SS --text TEXT [--priority PRIORITY]`
- `annotation list [--session UUID]`
- `annotation show ID`
- `annotation history ID [--limit N]`
- `annotation restore ID --revision N`
- `annotation update ID [--text TEXT] [--start TIME] [--end TIME]`
- `annotation remove ID`
- `annotation prioritize ID --priority PRIORITY`
- `annotation merge ID ID... [--separator TEXT]`
- `annotation split ID --before TEXT --after TEXT [--at TIME]`
- `annotation link ID --to asset|evidence --target-id ID`
- `annotation unlink ID --to TYPE --target-id ID`

### Transcript

- `transcript import --session UUID --input FILE [--format auto|text|srt|vtt]`
- `transcript plan --session UUID [--track UUID] [--threads N] [--model-memory-mb N] [--available-memory-mb N]`
- `transcript generate --session UUID [--model FILE] [--track UUID] [--language auto|CODE] [--start TIME --end TIME] [--threads N] [--diarize]`
- `transcript refine --session UUID [--model FILE] [--track UUID] [--diarize]`
- `transcript show --session UUID`
- `transcript search --session UUID --query TEXT`
- `transcript history ID [--limit N]`
- `transcript export --session UUID --output FILE [--format text|srt|vtt|json]`
- `transcript restore ID --revision N`
- `transcript correct SEGMENT_ID --text TEXT`
- `transcript timestamp ID --start TIME --end TIME`
- `transcript split ID --before TEXT --after TEXT [--at TIME]`
- `transcript merge ID ID... [--separator TEXT]`
- `transcript speaker ID (--name NAME|--unknown)`
- `transcript verify ID [--state STATE]`

### Asset

- `asset add FILE [--session UUID]`
- `asset import-folder DIR`
- `asset list`
- `asset show ID`
- `asset verify ID`
- `asset extract ID --output FILE`
- `asset remove ID`
- `asset link ID --to annotation|transcript --target-id ID`
- `asset unlink ID --to TYPE --target-id ID`

### Evidence

- `evidence extract --session UUID`
- `evidence graph --session UUID`
- `evidence list [--session UUID]`
- `evidence show ID`
- `evidence approve ID`
- `evidence reject ID`
- `evidence verify ID`

### AI

- `ai providers`
- `ai models --provider ID [--refresh|--refresh-if-stale [--api-key-env NAME]]`
- `ai context --session UUID [--token-budget N] [--max-item-tokens N]`
- `ai test --provider ID [--api-key-env NAME]`
- `ai capabilities --provider ID --model ID`
- `ai estimate --provider ollama --model ID --job JOB_ID`
- `ai configure --provider PROVIDER [--endpoint URL] [--model ID]`
  - providers:
    - openai;
    - openrouter;
    - groq;
    - deepseek;
    - mistral;
    - together;
    - xai;
    - cerebras;
    - fireworks;
    - sambanova;
    - nvidia;
    - deepinfra;
    - moonshot;
    - novita;
    - nebius;
    - siliconflow;
    - minimax;
    - alibaba-cloud;
    - baidu;
    - tencent-cloud;
    - volcengine;
    - bedrock;
    - azure-openai;
    - cloudflare-workers-ai;
    - ai21;
    - zai;
    - opencode-go;
    - anthropic;
    - google-gemini;
    - cohere;
    - perplexity;
    - openai-compatible;
    - ollama;
    - lm-studio;
    - llama.cpp-server.
- `ai package --session UUID [--template ID|auto] [--mode manual|local] [--format json|markdown|parts|zip] [--output FILE] [--confirm-sensitive for ZIP asset exports]`
- `ai generate --job JOB_ID --provider ID [--model ID] [--api-key-env NAME] [--max-tokens N] [--context-tokens N] [--threads N] [--gpu-layers N] [--confirm-outbound --confirm-hash SHA256]`
- `ai import --session UUID --input FILE [--template ID]`
- `ai jobs`
- `ai cancel JOB_ID`
- local generation with loopback endpoint;
- optional embedded GGUF inference with explicitly selected model;
- no bundled LLM weights.

### Guide

- `guide create --session UUID [--title TITLE] [--template ID]`
- `guide generate --session UUID|--entry-id UUID [--template ID|auto]`
- `guide list`
- `guide show ID [--revision N]`
- `guide edit ID [--title TITLE] [--section-index N --block-index N --text TEXT|--kind KIND|--sources UUID,...|--mark-reviewed|--clear-sources]`
- `guide regenerate ID [--section-index N]`
- `guide regenerate --session UUID|--entry-id UUID [--template ID]`
- `guide section ID --heading TITLE --text TEXT`
- `guide approve ID`
- `guide validate ID`
- `guide move-section ID --from N --to N`
- `guide add-block ID --section-index N --kind KIND --text TEXT [--block-index N] [--sources UUID,...]`
- `guide remove-block ID --section-index N --block-index N`
- `guide move-block ID --section-index N --from N --to N`
- `guide export ID --format markdown|html|json|docx|pdf --output FILE`

### Template and settings

- `template list`
- `template create --name NAME [--subject SUBJECT] [--description TEXT] [--sections "HEADING;HEADING;..."] [--body TEXT]`
- `template update ID [TEMPLATE FIELDS]`
- `template import [--name NAME] --input FILE`
- `template export ID --output FILE`
- `template delete ID`
- `settings list`
- `settings get KEY`
- `settings set --key KEY --value VALUE`
- `settings reset [--key KEY]`
- `settings import --input FILE`
- `settings copy-to-archive --source-archive FILE [--key KEY]`
- `settings credential-list`
- `settings credential-remove --key KEY`
- sensitive settings:
  - `--value-env NAME`;
  - `--store-credential` on encrypted archives.

### Model and recording

- `model list`
- `model inspect`
- `model select`
- `model verify`
- `model remove-reference`
- `record import --session UUID --input FILE [--additional-track] [--capture-source browser-microphone|browser-system-audio --capture-consent-at-us US --consent]`
- `record export-wav --session UUID --output FILE.wav [--track UUID] [--fill-gaps] [--overwrite]`
- `record play --session UUID [--track UUID] [--start-us N] [--duration-us N]`
- `record waveform --session UUID [--track UUID] [--buckets N]`
- `record recover --session UUID`
- `record devices [--json]`
- `record test [--source microphone|system-audio|application|both] [--device ID] [--microphone ID] [--playback ID|--application ID]`
- `record configure [--microphone default|ID] [--playback default|ID] [--durability default|maximum|reduced-write]`
- `record start --session UUID --consent [--source microphone|system-audio|application|both] [--microphone default|ID] [--playback default|ID] [--application ID] [--system-audio] [--device ID] [--duration-seconds N] [--durability default|maximum|reduced-write] [--confirmed-by LABEL] [--detach] [--live-transcribe --model FILE [--language auto|CODE] [--threads N] [--window-seconds 1..27] [--diarize]]`
- `record status --session UUID`
- `record pause --session UUID`
- `record resume --session UUID`
- `record stop --session UUID`

### Diagnostics and benchmarks

- `diagnostics run`
- `diagnostics archive [--full]`
- `diagnostics audio`
- `diagnostics graphics`
- `diagnostics providers`
- `diagnostics network --provider ID`
- `diagnostics report --output FILE [--full]`
- `benchmark startup`
- `benchmark memory`
- `benchmark cpu`
- `benchmark audio`
- `benchmark indexing`
- `benchmark rendering`
- `benchmark export --guide ID|full`

### Preservation rule

Every item above must remain callable through the CLI. Every one must also have an equivalent GUI route or Developer route. No command may be deleted, renamed without an alias, or made inaccessible merely because the UI is being redesigned.

---

## 21. Appendix B: known defect register

| ID | Defect | Evidence | Required fix | Test |
|---|---|---|---|---|
| L1 | Notebook clips under inspector at 1280 | `docs/images/workspace.png`, `size-1280.png`; `app-window.slint:851`, `928`; `notebook.slint:46` | Replace absolute center/inspector layout with flexible `HorizontalLayout`; min-width 0; responsive breakpoints | 1024/1280/1440/1600 screenshots |
| L2 | Bottom transport/status falls below viewport | 1280×800 capture; 1600×930 preferred | Lower preferred height; compact inactive transport; test 768-high screens | Window-size screenshot test |
| L3 | Inspector blank while header populated | Release capture vs 1280 capture | One typed session detail model; apply session + inspector atomically | Selected-session snapshot test |
| V1 | Disabled/hovered button changes surface | `theme.slint:163-174` hover not gated by `enabled` | Single computed state model; hover only when enabled | Hover disabled button test |
| V2 | Transport Stop hover text becomes unreadable | `transport.slint:188-202`: dark hover plus black text | Tokenized hover foreground or light hover surface | Contrast test |
| V3 | Tabs have no hover state | `theme.slint:986+` `TabButton` | Add hover color/underline, animate color | Interaction test |
| V4 | Raw UUID fields in normal UI | `app-window.slint:1251,1309,1533,1720,2141` | Pickers, chips, asset browser, date picker; move IDs to Developer | UX review + GUI test |
| V5 | Duplicate actions | notebook add-note pair; guide headings/actions | One primary action per region | DOM/screenshot review |
| V6 | 15 font sizes | theme/UI audit | Four-step type scale | Screenshot + code lint |
| V7 | Hardcoded palette colors | `transport.slint`, `theme.slint:140,293,383,863` | Tokenize all colors | Hex-literal CI lint |
| V8 | Output is not selectable | `theme.slint:578` uses `Text` | Read-only `TextEdit` or copy action | Copy test |
| V9 | Modal focus not trapped | `PanelShell` hands focus to background | Add focus trap and restore | Keyboard test |
| V10 | Missing loading/error states | guide editor blank, journal empty | Add skeleton/error/empty components | State screenshots |
| D1 | Autosave race/data loss | `notebook.slint:26` shares selection and text | Snapshot pending save; flush before selection | Edit A/select B test |
| D2 | Full archive reload per refresh | `desktop.cpp:1930`; six CLI calls + open + lists | `WorkspaceService` and typed snapshot | Refresh benchmark |
| D3 | Unbounded thread retention | `desktop.cpp:1803-1835`, `6732`, `7253-7259` | Bounded executor, cancellation, reaping | 100-command thread test |
| D4 | Transcript full scan in session list | `dispatcher.cpp:3243` | Index count or maintained field | 10k transcript benchmark |
| D5 | UI parses command output / recovers IDs from text | `desktop.cpp:5064-5071` | Typed command results | Code review + test |
| B1 | Release not stripped | `objdump` debug sections; `CMakeLists.txt:1059` | `-s`/strip; size gate | Size test |
| B2 | Static binary 94 MB | library inventory | feature trim, dependency replacement, optional packs | Size budget |
| T1 | No GUI/visual/memory tests | 27 CLI tests, no UI; CI disabled | Add tests and re-enable CI | CI green |
| T2 | Theme not tested | hardcoded colors; no dark screenshots | Token audit + screenshots | Light/dark goldens |

---

## 22. Appendix C: screen migration map

| Existing surface | New primary location | Preserved advanced surface |
|---|---|---|
| First launch / archive picker | First-launch route | Archive dialog |
| Journal tools | Journal page | Developer command console |
| Entry notes/document forms | Journal page inline editor | Document revision inspector |
| Session summary + notebook | Sessions page | Session detail inspector |
| Session inspector | Right inspector | Full session details drawer |
| Transcript pane | Sessions → Transcript tab | Revision history and source inspector |
| Study guide pane | Sessions → Study guide tab | Full guide editor page |
| Guide editor modal | Guides page | Advanced block inspector |
| Materials page | Materials page | Asset verify/extract tools |
| Student page | Students page | Progress history |
| Recording panel | Sessions → Recording tab + transport | Device diagnostics |
| AI panel | AI workspace | Developer provider console |
| Archive panel | Settings → Archive | Developer archive inspector |
| Settings panel | Settings page | Developer settings |
| Console panel | Developer → Console | CLI |
| Export panel | Page action menu / Export dialog | Developer export |
| New session/new student | Dialog with one primary action | Developer raw IDs |
| Template tools | Guides → Templates | Template import/export |
| Recovery/sanitized copy | Settings → Archive | Advanced copy details |

Every existing surface has a destination. No functionality is removed.

---

## 23. Appendix D: proof of preservation

A release candidate is blocked if any of these checks fail:

- `tutorux --help` contains every command family listed in Appendix A.
- The CLI matrix test exercises every command family.
- The feature matrix in section 13 has a GUI route and a CLI route.
- The GUI reachability test finds every page/action.
- The screenshot matrix covers every primary page in both themes.
- The archive compatibility test opens old `.tux` archives.
- The session package test round-trips all supported record families.
- No feature is marked “removed”; only “moved”, “paused”, or “optional pack”.
- The only paused feature is WASM, by explicit user instruction.
