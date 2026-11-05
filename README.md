# Tutorux

Tutorux is a local-first tutoring workspace for students, sessions, recordings, transcripts, notes, materials, evidence, progress, and study guides. A workspace is one portable `.tutor` file.

The application is a SolidJS and TypeScript interface running inside a Tauri 2 desktop shell. The workspace store is Rust and SQLite. The browser edition and the retired custom `.tux` archive engine are no longer part of the product.

## Requirements

- Node.js 22.13 or newer
- pnpm 12.14.0
- Rust stable 1.90 or newer
- The native Tauri prerequisites for your operating system
- The system WebView2 runtime on Windows

FFmpeg is optional and is not required by the new desktop workflow.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run desktop:dev
```

The desktop shell starts Vite on `127.0.0.1:1420` and opens the Tauri window.

Useful checks:

```sh
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run test:coverage
pnpm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

`pnpm run build` typechecks the frontend and produces the desktop frontend in `dist/`.

Build the desktop application without installers:

```sh
pnpm exec tauri build --no-bundle
```

The binary is written to `src-tauri/target/release/tutorux-desktop.exe` on Windows. `pnpm run desktop:build` performs the full Tauri packaging flow and writes release artifacts under `release/`.

## Workspace format

A `.tutor` workspace is a SQLite database with:

- typed tables for students, sessions, schedule events, journal entries, observations, transcript cues, materials, recordings, guides, evidence, goals, skills, settings, and AI jobs;
- an FTS5 index for global search;
- content-addressed compressed BLOB storage with deduplication;
- optional SQLCipher encryption;
- 90-day Trash recovery;
- manual verified backups.

Open and create `.tutor` files from the welcome screen. Encrypted workspaces prompt for the passphrase. Passphrase rotation is available in Settings after unlocking.

See [Architecture](docs/ARCHITECTURE.md) and [the workspace format](docs/archive-format/TUTOR-FORMAT.md).

## Features

- Today, Students, Sessions, Schedule, Materials, Guides, Evidence, Assistant, Archive, and Settings.
- Session detail with Overview, Capture, Transcript, Notes, Materials, Evidence, and Guide tabs.
- Microphone recording with optional system audio, separate microphone/system tracks, a local mixer, file-based audio import, and local Whisper transcription.
- Evidence records, approval, timelines, and a linked evidence graph.
- Cloud AI through reviewed native transports, plus local GGUF inference and an embedded Whisper model.
- Global FTS5 search with `Ctrl/Cmd+K`.
- Global goals, skill ratings, evidence timelines, and printable progress reports.
- ICS calendar import/export, recurring schedule-to-session materialization, reminder notifications, and Google/Microsoft/Apple CalDAV calendar sync.
- Image OCR with the bundled OCR engine for PNG, JPEG, WebP, BMP, TIFF, and GIF materials.
- Session packages (`.tutorpkg`) that transfer one session, its student, notes, evidence, guides, materials, and recordings.
- Archive compaction, search reindexing, recovery copies, and sanitized copies.
- Manual workspace backups that preserve encryption.
- Optional SQLCipher workspace encryption and OS credential-store AI/calendar credentials.

## Deliberate limits

- Google Calendar and Outlook OAuth require desktop OAuth client credentials from the provider. Apple Calendar uses CalDAV with an app-specific password. Live provider qualification is not included in the test environment.
- OCR reads image materials. Scanned PDF pages must be converted to images before OCR.
- The mobile layout is responsive and supports file-based audio attachment, but device-qualified mobile capture has not been run.
- Archive recovery creates a verified copy of a healthy workspace. It does not salvage individual rows from a physically corrupted SQLite file.
- The evidence graph shows links; automated graph analytics are not included.
- A 1 GiB synthetic workspace qualification passes. The full 100 GB qualification has not been run.
- Live cloud AI, local GGUF generation, OAuth calendar connections, and real capture-device matrices require external credentials, models, or hardware.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Workspace format](docs/archive-format/TUTOR-FORMAT.md)
- [TypeScript development](docs/development/TYPESCRIPT.md)
- [Releasing](docs/development/RELEASING.md)
- [Verification](docs/verification.md)
- [Portable privacy](docs/security/PORTABLE-PRIVACY.md)
- [Performance design](docs/performance/TYPESCRIPT-BASELINE.md)
- [AI integration](docs/ai/TYPESCRIPT-HANDOFF.md)
- [Feature inventory](docs/migration/feature-inventory.md)
- [Production readiness](docs/engineering/PRODUCTION-READINESS.md)

## License

Tutorux is licensed under GPL-3.0-only. See [LICENSE](LICENSE).

The bundled OCR models are from the Ocrs project, trained on the HierText dataset by Google Research, and licensed under CC BY-SA 4.0. The attribution is in [src-tauri/resources/ocr/LICENSE.md](src-tauri/resources/ocr/LICENSE.md).
