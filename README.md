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
pnpm run pdfium:fetch
pnpm run desktop:dev
```

`pnpm run pdfium:fetch` downloads the platform PDFium runtime used for scanned-PDF OCR. `pnpm run desktop:build` fetches it automatically.

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

The binary is written to `src-tauri/target/release/tutorux-desktop.exe` on Windows. `pnpm run desktop:build` performs the full Tauri packaging flow and writes three release artifacts under `release/`: the MSI, the NSIS setup executable, and the portable executable. The portable executable embeds the PDFium runtime.

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
- Scanned-PDF OCR with bundled PDFium and hybrid embedded-text/raster extraction.
- Session packages (`.tutorpkg`) that transfer one session, its student, notes, evidence, guides, materials, and recordings.
- Archive compaction, search reindexing, recovery copies, sanitized copies, and best-effort row salvage.
- Manual workspace backups with backup-age health.
- Daily, weekly, biweekly, and monthly recurrence with interval and end-date support, including ICS `TZID` import.
- No-show attendance status and report attendance rates.
- Optional SQLCipher workspace encryption and OS credential-store AI/calendar credentials.

## Deliberate limits

- Google Calendar and Outlook OAuth require desktop OAuth client credentials from the provider. Apple Calendar uses CalDAV with an app-specific password. Live provider qualification is environment-gated.
- OCR reads image materials and PDF pages. Other formats must be converted first.
- The mobile layout is responsive and supports file-based audio attachment, but device-qualified mobile capture has not been run.
- Reminders fire while Tutorux is open; there is no OS-level background scheduler when the app is closed.
- Archive recovery copies every readable row and reports skipped rows. It cannot reconstruct bytes that no longer exist on disk or inside a destroyed SQLite page.
- The evidence graph shows links; automated graph analytics are not included.
- A 1 GiB synthetic workspace qualification passes. The full 100 GB qualification has not been run.
- Live cloud AI, local GGUF generation, OAuth calendar connections, and capture-device matrices require external credentials, models, or hardware.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Workspace format](docs/archive-format/TUTOR-FORMAT.md)
- [TypeScript development](docs/development/TYPESCRIPT.md)
- [Releasing](docs/development/RELEASING.md)
- [Verification](docs/verification.md)
- [Capture matrix](docs/verification/CAPTURE-MATRIX.md)
- [Portable privacy](docs/security/PORTABLE-PRIVACY.md)
- [Performance design](docs/performance/TYPESCRIPT-BASELINE.md)
- [AI integration](docs/ai/TYPESCRIPT-HANDOFF.md)
- [Feature inventory](docs/migration/feature-inventory.md)
- [Production readiness](docs/engineering/PRODUCTION-READINESS.md)

## License

Tutorux is licensed under GPL-3.0-only. See [LICENSE](LICENSE).

## Credits and third-party licenses

- **PDFium** — PDF rendering used for scanned-PDF OCR. Distributed by [pdfium-binaries](https://github.com/bblanchon/pdfium-binaries), licensed under BSD-3-Clause. The runtime is embedded in the portable executable. Attribution is in [src-tauri/resources/pdfium/LICENSE](src-tauri/resources/pdfium/LICENSE).
- **Ocrs** — local OCR engine and bundled detection/recognition models. Models are trained on the HierText dataset by Google Research and licensed under CC BY-SA 4.0. See [src-tauri/resources/ocr/LICENSE.md](src-tauri/resources/ocr/LICENSE.md).
- **Whisper / whisper.cpp** — local speech transcription engine, licensed under MIT. Tutorux uses the `whisper-rs` bindings and the bundled multilingual Whisper model.
- **llama.cpp** — local GGUF inference runtime, licensed under MIT. Tutorux uses the `llama-cpp-2` bindings.
- **SQLite and SQLCipher** — workspace storage and optional encryption. SQLite is public domain; SQLCipher is licensed under BSD-style terms.
- **Tauri** — desktop shell and native bridge, licensed under MIT or Apache-2.0.
- **SolidJS** — UI runtime, licensed under MIT.
- **Tailwind CSS** — styling engine, licensed under MIT.
- **Noto Sans** — bundled interface font, licensed under the SIL Open Font License 1.1. See [frontend/assets/fonts/OFL.txt](frontend/assets/fonts/OFL.txt).
- Other Rust and JavaScript dependencies retain their upstream licenses; the resolved dependency versions are recorded in `Cargo.lock` and `pnpm-lock.yaml`.
