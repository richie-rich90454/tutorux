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
- Manual verified backups, compaction, reindexing, recovery copies, and sanitized copies.
- Session packages in `.tutorpkg` files.
- Per-user AI and calendar credentials in the OS credential store.

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
- Rust format, Clippy with all targets/features, and 71 library tests plus one ignored large-workspace test.
- Release build with embedded assets.
- Packaged smoke checks for workspace create/open, encryption, unlock, rekey, students, sessions, notes, transcript cues, guides, materials, recurring schedules, global search, integrity checks, Trash restore, evidence links/graph, OCR, session packages, reminders, archive maintenance, multi-track storage/mixer, file audio attachment, and mobile responsive layout.
- Real Whisper speech transcription and real printed-text OCR fixtures.
- 1 GiB synthetic workspace qualification with integrity `ok`.

## Missing or deferred

- Live Google/Microsoft OAuth and Apple CalDAV qualification with real accounts.
- Scanned PDF OCR (image OCR is implemented).
- Local GGUF generation with a real model.
- Live cloud AI provider calls with real keys.
- 100 GB qualification (1 GiB passes).
- Mobile hardware capture qualification.
- Physically corrupted SQLite row salvage; recovery copies healthy workspaces.
- Advanced calendar recurrence beyond daily/weekly/biweekly.
- Windows/macOS/Linux capture device matrices.

## Reference

- [Architecture](docs/ARCHITECTURE.md)
- [Workspace format](docs/archive-format/TUTOR-FORMAT.md)
- [TypeScript development](docs/development/TYPESCRIPT.md)
- [Verification](docs/verification.md)
- [Production readiness](docs/engineering/PRODUCTION-READINESS.md)
