# Bug audit

This pass audited the desktop shell, archive overview, notebook autosave,
journal/session actions, guide selection, network transport, waveform
generation, and the base/full build profiles. The list below records what was
fixed and what remains.

## Fixed in this pass

### Data and state

- A failed asynchronous archive refresh left the previous archive path and
  selected archive visible. Refresh errors now clear the workspace view.
- Opening a metadata-only or locked archive after a normal archive left stale
  sessions, students, notes, and materials in the navigator. Both special
  archive views now clear the workspace first.
- Journal search reset to the unfiltered overview after every `entry list`,
  because the command completion always triggered a full refresh. List
  responses no longer trigger that refresh.
- Journal entry selection did not update the entry id used by update/delete.
  The list completion now updates it.
- Creating a session left the old session selected and briefly exposed a raw
  UUID in the session selection. The journal session id is now the pending
  selection and the raw label is gone.
- Showing a journal session did not store its id, so later confirmation
  actions used stale scope. The id is now stored.
- Selecting a different session left the previous transcript and evidence
  options in the panes. Those options are cleared and reloaded.
- Guide block options contained blocks from every guide. The overview now
  filters them to the selected guide.
- Selecting a guide did not load that guide's blocks. Guide selection now
  refreshes the overview and loads the first block.
- Multiline notes and transcripts lost line breaks because the UTF-8
  sanitizer replaced every control character with a space. Newlines are
  preserved; carriage returns normalize to line feeds.
- The command palette search field was one-way bound, so typing never filtered
  the list. It is now two-way bound and Enter runs the first matching action.
- The journal had no reachable confirmation controls for entry, collection,
  or tag deletion. Confirmation checkboxes are now present and reset when the
  target changes.
- The collection/tag organizer required raw UUIDs. It now uses the archive's
  collection and tag lists.

### Layout and interaction

- The journal screen was one long hand-built page with packed action rows and
  a nested scroll area. It is now a separate `JournalPage` with shared cards,
  wrapped action rows, labelled form fields, and one scroll owner.
- The session inspector could paint into the recording transport. The page,
  inspector, transport, and status line now have explicit height constraints;
  the inspector scrolls independently inside the content row.
- The guide editor, archive, export, AI, recording, consent, student, materials,
  and settings surfaces all use the same card/form/action primitives and wrap
  at narrow widths instead of drawing past their containers.
- Recording controls opened from the journal did not show the recording sheet.
  The action now selects the session and opens the panel.
- The active recording dock used mouse-only hit regions for Mark, Pause/Resume,
  and Stop. These actions now use the shared keyboard-focusable and accessible
  button component.
- The command palette and workspace overflow actions used mouse-only rows.
  They now use the shared focusable buttons, report an empty search, close the
  overflow menu with Escape, and keep the full palette inside the minimum window.
- The navigator archive menu also used mouse-only rows and mislabeled its trigger
  as session-specific. It now uses accessible buttons, has a truthful workspace
  label, and closes from Escape.
- Notebook note rows placed a full-size click target above the selected text
  editor, which could steal text clicks. The hit target now exists only on
  unselected rows; selecting a row also restores its kind, and rows expose an
  accessible select action and focus state.
- Session-title editing had no default accessibility action, and marker rows
  were mouse-only. The title now exposes an edit action and labelled editor;
  markers use labelled keyboard-accessible play buttons.
- Session-detail edits closed as soon as the async update was dispatched, so a
  failed save hid the user's changes. The inspector now stays open during save,
  keeps the draft on failure with a retry action, and closes only after a
  successful response for the same selected session and archive.
- Saving a marker cleared its selection before the backend replied, losing the
  edited time and text on failure. It now remains selected for retry; changing
  sessions resets marker drafts, and refreshed marker lists discard selections
  whose records were removed.
- Session detail controls previously stayed enabled in a read-only archive.
  The inspector now receives the archive's writability state and disables
  session and marker mutations while preserving marker playback.
- The consent and recording panels exposed an enabled Start button even when
  microphone preflight was not ready. Start is now disabled until the selected
  microphone has passed preflight, with the preflight result visible.
- Absolute session start timestamps were formatted as durations
  (`497983:48:38`). They now render as dates.
- The status line was clipped at the 900×560 minimum. It has a 28 px line box.
- The navigator's three tabs overflowed the 208 px compact width. It now has
  two rows of three and shorter type at compact width.
- Journal, Guides, and Settings were modal sheets. They are now first-class
  pages in the content area.
- The shared modal shell's focus scope did not wrap its content, so Escape
  stopped working after focus entered a field. The scope now wraps the body.
- Raw UUIDs were exposed in the journal session summary and draft-guide
  message. Student/template ids are resolved to registered labels and the
  draft-guide message no longer prints an id.
- Advanced id fields in the journal and student pages are hidden behind an
  explicit Advanced IDs control.
- Multiline editors now have a bordered, scrollable `TextArea` surface instead
  of invisible text fields.
- System theme is now selectable; the app resolves it from the Windows
  personalization setting and polls for changes.
- The shared `ComboBox` declared open/close callbacks without connecting them
  to its `PopupWindow`, leaving selectors across the app inert. Mouse, keyboard,
  and accessibility actions now open the popup; Escape closes it, and an empty
  model displays a safe blank value without opening an empty popup. Expanded and
  focus state now follow `PopupWindow.is-open`, so Escape and outside-click close
  update the accessible state instead of leaving a stale “expanded” flag. The
  navigation cursor now follows externally changed selections, and take/track
  selectors have accessible names. The layout gate exercises these states.
- The custom scrollbar divided by its maximum offset even when content fit in
  the viewport. Thumb position and drag travel now guard zero-range/zero-travel
  cases, disabled scrollbars ignore pointer and wheel input, and wheel changes
  emit the same `scrolled` callback as dragging.

### Runtime and build

- The base profile exceeded 45 MB because it linked PoDoFo, libcurl/OpenSSL,
  and Whisper. The new `portable-base` profile excludes all three and measures
  37,807,879 bytes (37.8 MB).
- Windows provider traffic now uses WinHTTP and the Windows trust store instead
  of libcurl/OpenSSL.
- Empty audio timelines divided by zero while building a waveform. The
  waveform builder now returns an empty summary.
- Archive overview errors from student/session/settings/guide/annotation
  listings were silently treated as empty archives. They now surface as
  refresh errors.
- Request passphrases copied into the overview request are wiped after use.

## Recording and waveform overhaul

- The session transport previously drew only a baseline and playhead even when
  a waveform index existed. It now loads cached min/max buckets from the
  selected take and track and renders the amplitude envelope, local gap marks,
  playhead, markers, seek position, zoom, and live input level.
- Tracks containing only zero samples now report a silent state. Buckets that
  contain both samples and a discontinuity keep their amplitude and mark the
  missing interval instead of suppressing the whole bucket.
- Capture and WAV import now create additive take metadata. Multiple sequential
  takes and synchronized tracks within a take are grouped without changing the
  archive format version. Older archives appear as a read-only synthesized
  take and are not rewritten just to add grouping.
- Recovering an interrupted native capture now updates the state and duration
  on each affected take while leaving other takes in that session unchanged.
- The recording panel now selects takes and tracks, renames a take, moves it to
  recoverable Trash, restores the last removed take, exposes partial recovery,
  and uses the selected track for playback and WAV export.
- The recording panel also renames tracks, moves one track to Trash, restores
  the most recent removal, and creates a linked stereo mixdown from two
  synchronized tracks without changing either source.
- The recording waveform seek area only responded to pointer clicks and was
  invisible to assistive technology. It now exposes a normalized slider value,
  accessible set/increment/decrement actions, a visible focus ring, and
  one-second arrow-key seeking (ten seconds with Shift).
- Materials render signed amplitude buckets for supported PCM WAV previews
  through the shared timeline component, and supported PCM WAV files play through
  the same native output backends as session recordings. The prior glyph preview
  is gone; unsupported formats show their unavailable state.
- The session dock shows a bounded rolling capture history, and recording
  selectors/actions wrap on compact widths. Inspector marker controls stay
  inside their pane; notebook formatting is collapsed until requested; guide
  and block selection stays visible while advanced guide tools are closed.
- Journal copy now distinguishes a teaching journal spanning lessons from the
  notes and recordings owned by one lesson, and removes a duplicate entry card.
- The green favicon artwork is embedded in the Windows executable and macOS
  app bundle, set on the Slint window, installed for Linux launchers, and shipped
  as browser, Apple-touch, and PWA icons at their platform sizes.
- The browser workspace now uses the same green action and focus palette as the
  desktop UI, with a matching dark green surface. Its service worker caches the
  ICO, SVG, touch, and PWA icons; the guide video is discoverable from Journal,
  included in web builds, and cached when the installed package contains it.
- Native installs include the guide beside the application, and the macOS app
  bundle carries a copy in its Resources folder.
- `RecordingService` provides structured waveform/take snapshots and typed
  rename/delete/restore requests for these UI actions. The CLI dispatcher
  remains available for command-line workflows.
- Preserved the green folio logo and aligned the application palette with its
  archival green (`#315B4A`), white pages, and recording red (`#E34D47`).

## Remaining known gaps

- Most GUI mutations still pass through command-shaped adapters. `WorkspaceService`
  and `RecordingService` provide structured archive-backed paths; transcript,
  marker, materials, journal, guide, and settings mutations still need typed
  request/result services.
- The base/full split is compile-time. Dynamic native packs for PDF, network,
  and Whisper are not loaded at runtime; the base reports a typed unavailable
  error instead.
- The full guide editor is still an overlay reached from the Guides page. The
  Guides page itself is a first-class editor surface.
- Student progress now has a picker filtered to evidence from the selected
  student's sessions. Verify cross-session requirements and mastery validation
  through the UI, and retain the raw ID field only under Advanced.
- Guide templates now have a reachable manager for loading, creating, editing,
  duplicating, importing/exporting, and moving custom templates to Trash.
  Guides can also be duplicated or moved to Trash, with guide-to-journal links
  snapshotted and restored.
- Native Windows file and folder pickers now cover archive open, transcript
  import, material file/folder import, recording import, and template import.
  Other platforms still require a native picker implementation.
- Transcript speaker assignment, timestamp editing, and previous-version
  restore are now reachable from the session transcript pane.
- Evidence can now be created with a transcript source, edited, reviewed,
  linked, unlinked, and restored as a group with its links. Orphan repair and
  broader graph visualization are still not implemented.
- The recording matrix in `GUI-CAPABILITY-MATRIX.md` tracks the remaining CRUD
  and interaction gaps, including typed mutation services, decoder-backed
  material audio playback, and full layout/recovery acceptance coverage.
- The session inspector shows a vertical scrollbar when its marker form extends
  below the visible pane, so lower controls remain discoverable while the
  inspector scrolls independently above the recording transport.
- The pinned Slint 1.18.1 `PopupWindow` automatically moves a popup above its
  anchor when it would extend past the window edge; the prior clipping note was
  inaccurate. Popup placement near scroll boundaries still needs visual
  coverage in the release screenshot matrix.
- DPI rendering was verified with 125%/150% headless snapshots. Physical
  multi-monitor DPI changes and mixed-DPI window moves were not exercised.
- Provider tests use loopback fixtures. Live external providers were not
  exercised on physical hardware.
- The full 67-gate release checklist is still not proven end to end; the
  automated CTest suite, layout matrix, size gates, and loopback transport
  tests are green.
