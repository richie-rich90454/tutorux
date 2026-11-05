# Replace the custom archive application with a SQLite desktop workspace

## Branch and base

- Branch: `tauri-rewrite`
- Base: `main` at `7fbbe9e6bc58ef024eb8da5ccae05166fc62936e`
- Current diff: 3,647 commits, 1,305 files changed, +338,985 / −115,840 lines

This PR replaces the branch's prior custom `.tux` archive implementation, browser edition, CLI, console, and UI with the SQLite desktop application and its follow-up feature set.

## Summary

Tutorux is now a desktop-first local tutoring workspace:

- SolidJS and TypeScript UI;
- Tauri 2 desktop shell;
- Rust workspace store;
- one portable `.tutor` SQLite database per workspace.

The workspace contains students, sessions, schedules, recordings, transcripts, journal entries, observations, materials, evidence, goals, skills, guides, settings, AI jobs, calendar accounts, and Trash.

There is one storage implementation and one typed command boundary. The browser edition and the duplicate TypeScript/Rust archive paths are gone.

## Why

The prior branch had structural problems that could not be fixed by polishing the UI:

- a bespoke archive format coupled to a 7,000-line orchestration file;
- full-archive generation writes for normal edits;
- duplicate TypeScript and Rust persistence paths;
- a browser adapter and a desktop adapter with different storage constraints;
- entity-list navigation that forced users to leave a session to reach its transcript, observations, materials, or guide.

The new model is task- and entity-centric: Students and Sessions are hubs; the session owns capture, transcript, notes, materials, evidence, and guide. Storage is incremental SQLite with FTS5 and chunked media.

## Major changes

### Workspace and storage

- SQLite schema with typed tables and indexes.
- `application_id` and schema version migrations.
- FTS5 global search.
- Content-addressed, zstd-compressed 4 MiB BLOB chunks with deduplication.
- Optional SQLCipher encryption, passphrase unlock, and rekey.
- Encrypted backup through the SQLite online backup API.
- 90-day Trash with restore, permanent delete, and empty.
- Manual verified backup, integrity check, compaction, reindexing, recovery copies, and sanitized copies.
- Portable `.tutorpkg` session packages with ID and evidence-source remapping.

### Capture and transcript

- Microphone recording with optional system audio.
- Mixed, microphone, and system tracks stored separately when available.
- Local Web Audio mixer with per-track gain and mute.
- File-based audio attachment for mobile or unavailable microphones.
- Local Whisper transcription with the bundled model and language selector.
- Real speech fixture transcription regression test.
- SRT/VTT/text transcript import and export.

### Evidence and AI

- Evidence records, approval, timeline, and linked graph view.
- Goals, 0-5 skill ratings, and printable progress reports.
- Cloud AI through reviewed native transports with request preview and consent.
- Local GGUF model inspection, loading, and streamed generation.
- Local image OCR with embedded Ocrs models for PNG, JPEG, WebP, BMP, TIFF, and GIF.
- OCR text is stored and indexed for search.

### Calendar and reminders

- Google Calendar OAuth 2.0 with PKCE and a loopback callback.
- Microsoft Outlook OAuth 2.0 with PKCE and paged Graph results.
- Apple Calendar through CalDAV with an app-specific password.
- Calendar events upsert into the local schedule by external ID.
- Calendar tokens, client secrets, and CalDAV passwords stay in the OS credential store.
- Desktop reminder notifications with a configurable lead time.
- ICS import/export remains available.

### Desktop host

- Rust workspace, calendar, OCR, and maintenance command surface.
- Single-instance `.tutor` launch queue.
- Native menu renamed for workspaces.
- Native dialog, notification, and OS credential-store integration.
- Bundled Whisper and OCR models.
- Local GGUF inference.
- Reviewed cloud AI transport with endpoint/body confirmation.
- Native synchronized capture primitives remain available for follow-up work.

### Frontend

- New `frontend/app` shell with hash routing, workspace provider, unlock flow, reminder watcher, and native-menu listener.
- New design system with flat teal surfaces, no gradients, no glass, no accent bars, and sentence-case labels.
- Today, Students, Sessions, Schedule, Materials, Guides, Evidence, Assistant, Archive, and Settings.
- Session detail tabs: Overview, Capture, Transcript, Notes, Materials, Evidence, Guide.
- Student detail tabs: Overview, Sessions, Progress, Materials, Guides, Reports.
- Global `Ctrl/Cmd+K` search.
- Evidence graph and link editor.
- Session package export/import actions.
- Archive maintenance and sanitized-copy controls.
- Calendar setup and account sync in Settings.
- Simple/Advanced mode.

### Documentation

- README, architecture, workspace format, TypeScript development, releasing, verification, privacy, performance, AI, feature inventory, production readiness, handoff, and PR documentation updated for the SQLite architecture and the follow-up features.
- OCR model attribution added.
- Obsolete `.tux`, CLI recording, and historical production-audit documents removed.

### Removed

- Custom `.tux` archive engine.
- Browser edition and browser archive adapter.
- In-app command console.
- Standalone TypeScript CLI.
- Standalone Rust CLI, audio helper, and Rust parity corpus.
- Legacy UI pages, domain modules, fixture corpus, and E2E suite tied to the old DOM.

## Breaking changes

- Workspace file extension is `.tutor`.
- The custom `.tux` format is not read or written.
- The browser application is retired.
- The `tutorux-cli` and `tutorux-audio-helper` binaries are retired.
- The desktop executable is the only supported adapter.

The product has not been deployed, so no user migration path is required. Any existing `.tux` data would need a separate migration tool.

## Verification

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test:coverage
pnpm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm exec tauri build --no-bundle
pnpm run desktop:build
node scripts/collect-release.mjs --check-versions
pnpm audit --audit-level high
```

Current results:

| Check | Result |
| --- | --- |
| `pnpm run typecheck` | Pass |
| `pnpm run lint` | Pass |
| `pnpm run format:check` | Pass |
| `pnpm run test:coverage` | Pass; 100% statements, branches, functions, and lines |
| `pnpm run build` | Pass |
| `cargo fmt --check` | Pass |
| `cargo clippy --all-targets --all-features -- -D warnings` | Pass |
| `cargo test --lib` | 71 passed, 1 ignored large-workspace test |
| `pnpm exec tauri build --no-bundle` | Pass |
| `pnpm run desktop:build` | Pass; MSI, NSIS setup, and portable EXE under `release/` |
| `node scripts/collect-release.mjs --check-versions` | Pass; all manifests 1.0.0 |
| `pnpm audit --audit-level high` | No known vulnerabilities |
| Release application smoke test | Pass; all ten routes, zero page errors |
| 1 GiB workspace qualification | Pass; integrity `ok` |
| Real Whisper speech fixture | Pass |
| Real OCR image fixture | Pass; extracted `FRACTIONS` |

### Release smoke test evidence

The packaged desktop binary was launched with WebView2 remote debugging and exercised end to end:

- all ten routes loaded with zero page errors (`today`, `students`, `sessions`, `schedule`, `materials`, `guides`, `evidence`, `assistant`, `archive`, `settings`);
- created a plain workspace and an encrypted workspace;
- created students and sessions through the UI;
- added journal entries through the UI;
- created evidence records and an evidence link; the graph rendered;
- imported an image material and ran OCR, extracting `FRACTIONS`;
- imported and exported a `.tutorpkg` session package and read imported material bytes;
- stored mixed/microphone/system tracks and played the mixer;
- attached an audio file through the capture view;
- created a due schedule and read it from `reminders_due`;
- compacted the workspace, rebuilt indexes, and created recovery and sanitized copies;
- configured a calendar client ID and read its status;
- searched with `Ctrl+K`;
- verified database integrity;
- checked key routes at a 390 px viewport with no horizontal overflow;
- rejected a wrong workspace passphrase, unlocked, rekeyed, rejected the old passphrase, and created an encrypted backup;
- closed the workspace cleanly.

`pnpm run desktop:build` produced and collected the MSI, NSIS setup, and portable EXE under `release/`.

## Manual QA checklist

- [x] Create/open plain workspace.
- [x] Create encrypted workspace.
- [x] Reject a wrong passphrase.
- [x] Reopen encrypted workspace through the unlock panel.
- [x] Change passphrase and reject the old one.
- [x] Create and verify plain and encrypted backups.
- [x] Create student, session, journal, observation, transcript cue.
- [x] Generate and edit a study guide.
- [x] Import a material and preview text.
- [x] Run image OCR and search the extracted text.
- [x] Create and link evidence; render the graph.
- [x] Export/import a session package.
- [x] Store separate recording tracks and play the mixer.
- [x] Attach an audio file through the capture view.
- [x] Create a recurring schedule and see generated sessions on Today.
- [x] Query a due lesson through the reminder command.
- [x] Compact, reindex, and create recovery and sanitized copies.
- [x] Configure a calendar client ID.
- [x] Search with `Ctrl/Cmd+K`.
- [x] Run integrity check and restore a Trash item.
- [x] Check key routes at a mobile viewport without horizontal overflow.
- [x] Build and launch the release binary with embedded assets.
- [x] Package the MSI, NSIS setup, and portable EXE with `pnpm run desktop:build`.

## Review order

1. `src-tauri/src/store/schema.rs` and `src-tauri/src/store/mod.rs`
2. `src-tauri/src/store/repo.rs`, `content.rs`, `schedule.rs`, `materials.rs`, `recordings.rs`
3. `src-tauri/src/store/backup.rs`, `maintenance.rs`, `packages.rs`, `reminders.rs`, `trash.rs`, `search.rs`
4. `src-tauri/src/calendar.rs` and `src-tauri/src/ocr.rs`
5. `frontend/api/client.ts` and `frontend/api/types.ts`
6. `frontend/app/workspace.tsx`, `router.ts`, `App.tsx`, `ReminderWatcher.tsx`
7. `frontend/features/sessions/SessionDetailPage.tsx`
8. Remaining feature pages
9. Docs, OCR model attribution, and CI workflow

## Remaining work

These are explicit follow-ups, not hidden omissions:

- Live Google/Microsoft OAuth and Apple CalDAV qualification with real accounts.
- Live cloud AI provider calls with real keys.
- Local GGUF generation with a real model.
- Scanned PDF OCR; image OCR is implemented.
- 100 GB synthetic qualification; 1 GiB passes.
- Mobile hardware capture qualification; responsive layout and file attachment are implemented.
- Windows/macOS/Linux capture device matrices.
- Salvaging rows from a physically corrupted SQLite file; recovery copies healthy workspaces.
- Calendar recurrence beyond daily/weekly/biweekly CalDAV rules.

## Risk

The storage format and desktop surface are intentionally breaking. The SQLite store, encryption, backup, search, migration, release, OCR, Whisper, packages, archive maintenance, evidence graph, reminders, and core workspace journeys are verified. The main residual risk is external qualification for live AI providers, local GGUF models, calendar accounts, mobile hardware, and 100 GB media workloads.
