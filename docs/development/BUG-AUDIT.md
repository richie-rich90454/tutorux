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

### Runtime and build

- The base profile exceeded 45 MB because it linked PoDoFo, libcurl/OpenSSL,
  and Whisper. The new `portable-base` profile excludes all three and measures
  37,994,319 bytes (38 MB).
- Windows provider traffic now uses WinHTTP and the Windows trust store instead
  of libcurl/OpenSSL.
- Empty audio timelines divided by zero while building a waveform. The
  waveform builder now returns an empty summary.
- Archive overview errors from student/session/settings/guide/annotation
  listings were silently treated as empty archives. They now surface as
  refresh errors.
- Request passphrases copied into the overview request are wiped after use.

## Remaining known gaps

- Most GUI commands still pass through the command dispatcher internally.
  `WorkspaceService` is the only fully typed, archive-backed service. The
  remaining domains have CLI-shaped adapters rather than independent service
  objects.
- The base/full split is compile-time. Dynamic native packs for PDF, network,
  and Whisper are not loaded at runtime; the base reports a typed unavailable
  error instead.
- The full guide editor is still an overlay reached from the Guides page. The
  Guides page itself is a first-class editor surface.
- Student progress evidence is still entered as advanced ids; there is no
  evidence picker yet.
- At 150% scaling the session inspector can paint below the recording transport;
  the page content and transport themselves stay aligned. This is the clearest
  remaining visual defect.
- ComboBox popups opened near the bottom of a ScrollArea can be clipped by the
  scroll viewport.
- DPI rendering was verified with 125%/150% headless snapshots. Physical
  multi-monitor DPI changes and mixed-DPI window moves were not exercised.
- Provider tests use loopback fixtures. Live external providers were not
  exercised on physical hardware.
- The full 67-gate release checklist is still not proven end to end; the
  automated CTest suite, layout matrix, size gates, and loopback transport
  tests are green.
