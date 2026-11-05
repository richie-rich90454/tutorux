# Tutorux handoff

## Current state

Tutorux is a desktop-first local workspace built with SolidJS, Tauri 2, Rust, and SQLite. The active branch is `tauri-rewrite`.

The frontend is a new shell and feature set under `frontend/app` and `frontend/features`. The workspace store is under `src-tauri/src/store`. The retired `.tux` archive engine, browser adapter, in-app console, and standalone CLI have been removed.

## Workspace

A workspace is one `.tutor` SQLite file.

- Optional SQLCipher encryption.
- FTS5 search.
- Content-addressed zstd-compressed BLOB chunks.
- 90-day Trash.
- Manual verified backups.
- Per-user AI credentials in the OS credential store.

## Main commands

```sh
pnpm install --frozen-lockfile
pnpm run desktop:dev
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test:coverage
pnpm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm exec tauri build --no-bundle
```

## Verified

- TypeScript typecheck, lint, format, coverage, and desktop frontend build.
- Rust format, Clippy with all targets/features, and 55 library tests.
- Release build with embedded assets.
- Manual smoke checks for workspace create/open, encryption, unlock, rekey, students, sessions, notes, transcript cues, guides, materials, recurring schedules, global search, integrity checks, and Trash restore.

## Missing or deferred

- Google Calendar, Outlook, and macOS Calendar OAuth. ICS import/export is implemented.
- Reminders/background notifications.
- OCR for scanned worksheets.
- Evidence graph view.
- Session package export/import.
- Sanitized copy.
- Advanced archive repair/compaction/recovery UI.
- Multi-track mixer UI.
- 100 GB qualification.
- Mobile-qualified capture.

## Reference

- [Architecture](docs/ARCHITECTURE.md)
- [Workspace format](docs/archive-format/TUTOR-FORMAT.md)
- [TypeScript development](docs/development/TYPESCRIPT.md)
- [Verification](docs/verification.md)
- [Production readiness](docs/engineering/PRODUCTION-READINESS.md)
