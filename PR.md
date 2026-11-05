# Replace the custom archive application with a SQLite desktop workspace

## Branch and base

- Branch: `tauri-rewrite`
- Base: `main` at `7fbbe9e6bc58ef024eb8da5ccae05166fc62936e`
- Current diff: 3,598 commits, 1,294 files changed, +333,895 / −115,840 lines

This PR is large because it replaces the branch's prior custom `.tux` archive implementation, browser edition, CLI, console, and UI with the SQLite desktop application.

## Summary

Tutorux is now a desktop-first local tutoring workspace:

- SolidJS and TypeScript UI;
- Tauri 2 desktop shell;
- Rust workspace store;
- one portable `.tutor` SQLite database per workspace.

The workspace contains students, sessions, schedules, recordings, transcripts, journal entries, observations, materials, evidence, goals, skills, guides, settings, AI jobs, and Trash.

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
- Manual verified backup and integrity check.

### Desktop host

- Rust workspace command surface.
- Single-instance `.tutor` launch queue.
- Native menu renamed for workspaces.
- Native dialog and OS credential-store integration.
- Bundled Whisper transcription model.
- Local GGUF inference.
- Reviewed cloud AI transport with endpoint/body confirmation.
- Native synchronized capture primitives remain available for follow-up work.

### Frontend

- New `frontend/app` shell with hash routing, workspace provider, unlock flow, and native-menu listener.
- New design system with flat teal surfaces, no gradients, no glass, no accent bars, and sentence-case labels.
- Today, Students, Sessions, Schedule, Materials, Guides, Evidence, Assistant, Archive, and Settings.
- Session detail tabs: Overview, Capture, Transcript, Notes, Materials, Evidence, Guide.
- Student detail tabs: Overview, Sessions, Progress, Materials, Guides, Reports.
- Global `Ctrl/Cmd+K` search.
- Local microphone recording with optional system-audio mixing and playback.
- Local Whisper transcription with the Whisper language selector.
- Cloud AI and local GGUF tasks.
- Simple/Advanced mode.

### Documentation

- README, architecture, workspace format, TypeScript development, releasing, verification, privacy, performance, AI, feature inventory, production readiness, handoff, and PR documentation updated for the SQLite architecture.
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
| `cargo test --lib` | 55 passed |
| `pnpm exec tauri build --no-bundle` | Pass |
| `pnpm run desktop:build` | Pass; MSI 65.93 MiB, NSIS setup 60.88 MiB, portable EXE 87.86 MiB |
| `node scripts/collect-release.mjs --check-versions` | Pass; all manifests 1.0.0 |
| `pnpm audit --audit-level high` | No known vulnerabilities |
| Release application smoke test | Pass; embedded assets loaded from `https://tauri.localhost` |

### Release smoke test evidence

The packaged desktop binary was launched with WebView2 remote debugging and exercised end to end:

- all ten routes loaded with zero page errors (`today`, `students`, `sessions`, `schedule`, `materials`, `guides`, `evidence`, `assistant`, `archive`, `settings`);
- created a plain workspace;
- created a student through the UI;
- created a session through the UI;
- added a journal entry through the UI;
- verified the student, session, and journal entry through the Rust commands;
- global search returned the note with `Ctrl+K`;
- database integrity check returned `ok`;
- created and verified a plain workspace backup;
- created an encrypted workspace;
- rejected a wrong passphrase;
- unlocked the encrypted workspace;
- changed the passphrase and rejected the old one;
- created an encrypted backup;
- reopened the encrypted workspace with the new passphrase;
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
- [x] Create a recurring schedule and see generated sessions on Today.
- [x] Search with `Ctrl/Cmd+K`.
- [x] Run integrity check and restore a Trash item.
- [x] Build and launch the release binary with embedded assets.
- [x] Package the MSI, NSIS setup, and portable EXE with `pnpm run desktop:build`.

## Review order

1. `src-tauri/src/store/schema.rs` and `src-tauri/src/store/mod.rs`
2. `src-tauri/src/store/repo.rs`, `content.rs`, `schedule.rs`, `materials.rs`
3. `src-tauri/src/store/backup.rs`, `trash.rs`, `search.rs`
4. `frontend/api/client.ts` and `frontend/api/types.ts`
5. `frontend/app/workspace.tsx`, `router.ts`, `App.tsx`
6. `frontend/features/sessions/SessionDetailPage.tsx`
7. Remaining feature pages
8. Docs and CI workflow

## Remaining work

These are explicit follow-ups, not hidden omissions:

- Google Calendar, Outlook, and macOS Calendar OAuth.
- Reminders and background notifications.
- OCR for scanned worksheets.
- Evidence graph view.
- Session package export/import.
- Sanitized copies.
- Advanced archive repair/compaction/recovery UI.
- Multi-track mixer UI.
- 100 GB synthetic qualification.
- Mobile-qualified capture.
- Live provider/model/audio qualification with real credentials and fixtures.

## Risk

The storage format and desktop surface are intentionally breaking. The new SQLite store, encryption, backup, search, migration, release, and core workspace journeys are verified. The main residual risk is external qualification for live AI providers, real spoken audio, calendar OAuth, mobile capture, and 100 GB media workloads.
