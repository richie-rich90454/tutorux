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
| Compaction/reindex | Implemented | `VACUUM`, `REINDEX`, and `PRAGMA optimize` in Advanced Archive |
| Recovery copy | Implemented | Verified SQLite snapshot of a healthy workspace |
| Sanitized copy | Implemented | Removes private content and masks names |
| 90-day Trash | Implemented | Restore, permanent delete, empty Trash |
| Students | Implemented | Profiles, year, subjects, goals, notes |
| Student progress | Implemented | Goals, 0–5 skill ratings, evidence timeline, session history, printable report |
| Sessions | Implemented | Status, date, subject, notes, lifecycle |
| Session capture | Implemented | Mixed plus separate microphone/system tracks, local mixer, file attachment |
| Local Whisper | Implemented | Bundled model, language selector, full-track transcription, review cues; real speech fixture passes |
| Transcript editing | Implemented | Add, edit, delete, import SRT/VTT/text, export SRT/VTT |
| Session journal | Implemented | Session-scoped journal entries |
| Observations | Implemented | Type, priority, title, body |
| Materials | Implemented | Files, links, chunked storage, previews, FTS indexing |
| Image OCR | Implemented | Bundled Ocrs models for PNG, JPEG, WebP, BMP, TIFF, GIF; extracted text indexed |
| Scanned PDF OCR | Not implemented | Pages must be converted to images |
| Guides | Implemented | Create, edit, preview, Markdown/HTML/Word/text export, print/PDF, built-in templates |
| Evidence | Implemented | Records, approval, timeline, and linked graph |
| Session packages | Implemented | `.tutorpkg` export/import with ID and evidence-source remapping |
| Schedule | Implemented | One-off and recurring series materialize sessions, ICS import/export |
| Calendar OAuth | Implemented | Google and Microsoft PKCE OAuth; requires external app registration |
| Apple Calendar | Implemented | CalDAV with app-specific password; requires live account qualification |
| Reminders | Implemented | Desktop notifications while Tutorux is open, with configurable lead time |
| Today | Implemented | Upcoming sessions, continue card, recent sessions, students, onboarding checklist |
| Global search | Implemented | FTS5 over students, sessions, notes, cues, materials, guides, evidence |
| Assistant | Implemented | Cloud providers with consent; local GGUF with user-supplied model |
| Simple/Advanced | Implemented | Provider setup, graph, and maintenance controls hidden in Simple |
| Manual backup | Implemented | No automatic backup |
| Mobile layout | Implemented | Responsive routes checked at 390 px; file audio attachment available |
| Mobile hardware capture | Not qualified | No device matrix was available |
| Multi-track mixing | Implemented | Separate tracks with per-track gain and mute |
| 100 GB qualification | Not run | 1 GiB synthetic qualification passes |
| Browser edition | Retired | Desktop Tauri only |
| CLI/console | Retired | Removed with the custom archive engine |
