# Tutorux SQLite desktop rewrite

## Branch

`tauri-rewrite`

## Summary

This change replaces the custom `.tux` archive application with a desktop-first Tutorux built on SolidJS, Tauri 2, Rust, and SQLite.

One `.tutor` file now contains the workspace: students, sessions, schedule, recordings, transcripts, journal entries, observations, materials, evidence, goals, skills, guides, settings, and AI jobs. Storage is incremental SQLite instead of full-archive generation writes. Search is FTS5. Media is chunked and compressed. Encryption is optional SQLCipher.

## Why

The previous application had three major structural problems:

- a custom archive format coupled to a 7,000-line orchestration file;
- duplicate TypeScript and Rust domain paths;
- a browser/static and desktop product requiring two storage adapters.

The new architecture has one desktop UI, one Rust workspace store, one SQLite file, and one typed command boundary.

## Major changes

### Workspace and storage

- SQLite schema with typed tables and indexes.
- FTS5 global search.
- Chunked, content-addressed, zstd-compressed BLOB storage.
- Optional SQLCipher encryption, unlock, rekey, and encrypted backups.
- 90-day Trash with restore and purge.
- Manual verified backup.

### Desktop host

- Rust store command surface.
- Single-instance `.tutor` launch queue.
- Native menu renamed for workspaces.
- Native dialog and credential-store integration.
- Embedded Whisper model.
- Local GGUF inference.
- Reviewed cloud AI transport.
- Native synchronized capture primitives remain available.

### Frontend

- New `frontend/app` shell with hash routing and a workspace provider.
- New design system with flat teal surfaces, no gradients, no glass, no accent bars, and sentence-case labels.
- Today, Students, Sessions, Schedule, Materials, Guides, Evidence, Assistant, Archive, and Settings.
- Session detail tabs: Overview, Capture, Transcript, Notes, Materials, Evidence, Guide.
- Global `Ctrl/Cmd+K` search.
- Local recording and playback with optional system audio.
- Local Whisper transcription with language selection.
- Cloud and local AI tasks.
- Simple/Advanced mode.

### Removed

- Custom `.tux` archive engine.
- Browser edition and browser archive adapter.
- In-app command console.
- Standalone TypeScript CLI.
- Standalone Rust CLI and parity corpus.
- Audio helper binary.
- Legacy UI pages, domain modules, and tests.

## Verification

```text
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test:coverage
pnpm run build
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --lib
pnpm exec tauri build --no-bundle
```

All pass. The release desktop binary was launched and verified with embedded assets.

## Remaining work

- Calendar OAuth for Google, Outlook, and macOS Calendar.
- Reminders.
- OCR.
- Evidence graph.
- Session packages.
- Sanitized copies.
- Advanced archive repair/compaction/recovery UI.
- Multi-track mixer.
- 100 GB qualification.
- Mobile-qualified capture.
- Live provider/model/audio qualification with real credentials and fixtures.

## Risk

The storage and UI rewrite changes the workspace format completely. There is no `.tux` compatibility layer. The application has not been deployed, so this is intentional. Any existing `.tux` data would require a separate migration tool.
