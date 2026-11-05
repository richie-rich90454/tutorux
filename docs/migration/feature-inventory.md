# Feature inventory

This is the current state of the SQLite/Tauri rewrite.

| Area | Status | Notes |
| --- | --- | --- |
| Workspace create/open | Implemented | `.tutor` SQLite file, optional SQLCipher passphrase |
| Workspace rename | Implemented | Name and description in Settings |
| Workspace close | Implemented | SQLCipher key zeroized |
| Optional encryption | Implemented | Create-time passphrase, unlock prompt, rekey in Settings |
| Encrypted backup | Implemented | SQLite backup preserves the key |
| Integrity check | Implemented | `PRAGMA integrity_check` from Archive |
| 90-day Trash | Implemented | Restore, permanent delete, empty Trash |
| Students | Implemented | Profiles, year, subjects, goals, notes |
| Student progress | Implemented | Goals, 0–5 skill ratings, evidence timeline, session history, printable report |
| Sessions | Implemented | Status, date, subject, notes, lifecycle |
| Session capture | Implemented | Microphone + optional system audio mixed via Web Audio; local playback |
| Local Whisper | Implemented | Bundled model, language selector, full-track transcription, review cues |
| Transcript editing | Implemented | Add, edit, delete, import SRT/VTT/text, export SRT/VTT |
| Session journal | Implemented | Session-scoped journal entries |
| Observations | Implemented | Type, priority, title, body |
| Materials | Implemented | Files, links, chunked storage, previews, FTS indexing |
| Guides | Implemented | Create, edit, preview, Markdown/HTML/Word/text export, print/PDF, built-in templates |
| Evidence | Implemented | Records, approval, timeline; graph view not implemented |
| Schedule | Implemented | One-off and recurring series materialize sessions, ICS import/export |
| Today | Implemented | Upcoming sessions, continue card, recent sessions, students, onboarding checklist |
| Global search | Implemented | FTS5 over students, sessions, notes, cues, materials, guides, evidence |
| Assistant | Implemented | Cloud providers with consent; local GGUF with user-supplied model |
| Simple/Advanced | Implemented | Provider setup and advanced archive controls hidden in Simple |
| Manual backup | Implemented | No automatic backup |
| Calendar OAuth | Not implemented | Google/Outlook/macOS Calendar require OAuth client registration |
| Reminders | Not implemented | No background notification scheduler |
| OCR | Deferred | Scanned worksheets are stored but not searchable |
| Mobile-qualified capture | Deferred | Layout is responsive; mobile capture is not qualified |
| Evidence graph | Not implemented | Evidence records and timeline exist |
| Session packages | Not implemented | Export/import not exposed |
| Sanitized copy | Not implemented | Advanced archive copy not exposed |
| Repair/compact/recover | Not implemented in UI | Legacy custom-format tools were removed |
| Multi-track mixing | Partial | Default mixed capture; separate-track mixing not exposed |
| Browser edition | Retired | Desktop Tauri only |
| CLI/console | Retired | Removed with the custom archive engine |
