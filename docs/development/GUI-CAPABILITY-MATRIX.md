# Desktop capability and CRUD matrix

This matrix compares the desktop Slint surface with the archive-backed C++
commands and services. A command existing in the CLI is not counted as a GUI
workflow. The `Status` column describes the checked-in desktop path after the
current recording and usability work.

| Domain / record | Create | Read / select | Update | Delete / recover | GUI gaps and verification needed |
| --- | --- | --- | --- | --- | --- |
| Students | New Student panel | Navigator profile and history | Profile fields and progress review | Confirmed Move to Trash; restore and explicit purge live in Trash | Evidence picker is now filtered to the selected student's sessions; verify cross-session and mastery validation in UI. |
| Sessions | Session-first quick create and journal create | Session navigator, inspector, journal relation picker | Title, student, subject, state, notes | Group-aware soft delete, dependency preview, grouped restore, and explicit purge | Verify every dependency group and selection refresh after restore or purge. |
| Journal entries | Journal form | Search, sort, collection/tag/date/session filters | Title/date/collection/tag, document relation | Confirmation, grouped soft-delete, and Trash restore/purge | Verify relation counts and notebook refresh after every mutation. |
| Journal collections and tags | Organizer create | Organizer pickers | Rename/description/color | Confirmation, relation snapshot, Trash restore, and purge | Verify multiple-entry relation restoration and stale journal searches. |
| Notes and document blocks | Session notebook and journal document | Session notebook / document view | Autosave, block kind/text, reorder | Block removal has one-step Undo; no user-facing Trash/restore for deleted documents or blocks | Conflict state needs a visible resolution flow; test persistence across archive reopen. |
| Recording takes | Native capture and WAV import create additive take records | Session transport chooses a take and its tracks; legacy sessions appear as a synthesized, read-only take | Rename through a typed `RecordingService` mutation | Move to Trash and one-step Undo restore through the typed service | Verify recover/reopen/package behavior, multitrack restore, and that every take action refreshes the selected take and waveform. |
| Recording tracks | Capture, synchronized capture, import | Track selector and real min/max waveform | No direct track metadata editor | No independent track delete/restore UI | Verify playback, export, gaps, markers, and cache invalidation for each selected track. |
| Recording transport | Start after consent / import | Persistent session dock, duration, markers, loading/error/silent/empty waveform states | Pause/resume/stop; click timeline to seek and play; zoom and pan | Discoverable partial recovery; take removal has immediate Undo | Verify live meter and playback position under device errors, cancellation, scaling, and small-window layouts. |
| Markers / annotations | Add from inspector or recording dock | Time and label list; marker positions over waveform | Select, edit time/text, save | Soft-delete and Trash restore/purge | Confirm keyboard/focus order and marker labels at multiple window widths. |
| Transcript segments | Native Windows picker, drag/drop, transcript generation | Session transcript list and segment selector | Correct text, speaker, timestamps, split, merge | Soft-delete, Trash restore, and previous-revision restore | Native browse is Windows-only; verify chronological merge, revision choice, and stale-load behavior. |
| Materials / assets | Native Windows file/folder picker, drag/drop, archive import | Session materials list and safe previews | No file metadata editor | Soft-delete plus Trash restore | Native browse is Windows-only; add a real decoder-backed audio player/waveform for imported audio assets and validate large/unsupported files. |
| Evidence nodes and links | Extract from a session or create from a selected transcript segment | Session evidence list and a student-filtered evidence picker | Edit title/type/content; edits return the item to review; approve/reject/verify; create and remove typed links | Evidence and its links move to Trash together; restoring the item restores its links | Repair an orphaned edge when one endpoint is unavailable; test focus order and large evidence lists. |
| Guides and templates | Create/generate/import; duplicate | Guides, editable blocks, and Guide Templates manager | Full block editor, find/replace, reorder; template fields | Guide/template delete moves to Trash; restore/purge in Trash | Verify action refresh, template import/export, and async selection behavior. |
| Settings and credentials | Settings panel | Archive settings and provider state | Preferences, shortcuts, connection credentials | Credential removal exists; Trash/restore scope needs review | Verify no secrets enter status output and ensure settings refresh on archive switches. |
| Archive transfer and maintenance | Archive create, session package export/import, sanitized copy | Archive panel and diagnostics | Recovery/repair/compact | Explicit archive maintenance purge is separate from record recovery | Preserve `.tux` compatibility; verify linked take metadata during transfer and selected-track sanitization. |

## Confirmed implementation in this pass

- Added a typed `RecordingService` snapshot that binds take/track choices to
  archive waveform buckets and returns explicit empty/error/unavailable states.
- Added additive `recording-take` metadata, linked track IDs, legacy grouping,
  and take state updates for single capture, synchronized capture, WAV import,
  and import recovery. The archive format version is unchanged.
- Fixed synchronized capture overwriting its group take metadata from each
  individual track worker.
- Wired the session transport to the selected take/track, signed waveform
  intensity, gaps, duration, marker positions, click-to-play, and live PCM peak
  telemetry. Live telemetry remains process-local and does not create archive
  revisions.
- Added transcript import, split, merge, and recoverable remove controls;
  added marker edit and recoverable remove controls; added material remove and
  immediate restore controls.
- Added evidence create from a selected transcript revision, edit and review
  controls, same-session typed linking, readable link selection, and recoverable
  removal. Removing an evidence item sends its links to Trash with it; restoring
  the item restores those links. Added dispatcher workflow coverage for create,
  edit, link, unlink, delete, and restore.
- Added recording take rename, Trash, and Undo restore controls. Legacy takes
  remain selectable but cannot be renamed or deleted because their synthetic
  IDs do not identify a persisted take record.
- Updated recovery to finalize the state and duration of each affected take,
  while leaving unrelated takes in the same session unchanged.
- Waveform buckets with both audio and missing intervals retain their audio
  peaks and mark the gap locally; tracks containing only zero samples now show
  an explicit silent state.
- Kept take metadata out of material lists, carried it in session packages,
  and pruned take-to-track links when sanitizing a selected-track copy.
- Kept the green folio logo as the design source. The desktop palette, icons,
  recording dock, and waveform use its archival green and recording red.

## Remaining acceptance work

1. Verify session/take/guide/journal group restore and permanent purge against
   reopened archives, including every relation snapshot and selected view.
2. Verify take rename/delete/restore and selected-track playback/export; add
   capture/recovery integration coverage for real linked tracks.
3. Add a native picker on non-Windows builds, decoder-backed material audio
   preview, evidence graph editing, and document/block restore where supported.
4. Replace command-shaped mutation adapters in the remaining domains with typed
   request/result services and field-level validation.
5. Exercise archive reopen, transfer, sanitization, recovery, Trash restore,
   waveform cache reuse/invalidation, and layout screenshots in both themes and
   at the supported window/DPI matrix.
