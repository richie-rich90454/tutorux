# Tutorux handoff

## Current state

Tutorux is a desktop-first local workspace built with SolidJS, Tauri 2, Rust, and SQLite. The current branch is `main`.

The frontend is a shell and feature set under `frontend/app` and `frontend/features`. The workspace store is under `src-tauri/src/store`. The retired `.tux` archive engine, browser adapter, in-app console, and standalone CLI have been removed.

## Workspace

A workspace is one `.tutor` SQLite file.

- Optional SQLCipher encryption.
- FTS5 search.
- Content-addressed zstd-compressed BLOB chunks.
- 90-day Trash.
- Manual verified backups with backup-age health.
- Compaction, reindexing, recovery copies, sanitized copies, and best-effort row salvage.
- Session packages in `.tutorpkg` files.
- Per-user AI and calendar credentials in the OS credential store.
- Daily, weekly, biweekly, and monthly recurrence with interval and end-date support.
- Image and scanned-PDF OCR through bundled PDFium and the embedded OCR models.

The Windows PDFium runtime is committed for reproducible Windows builds. Other platforms fetch it with `pnpm run pdfium:fetch`. The executable embeds the runtime; no separate PDFium DLL is shipped in `release/`.

## Main commands

```sh
pnpm install --frozen-lockfile
pnpm run pdfium:fetch
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
pnpm run qualify:large -- 100
```

`pnpm run desktop:build` embeds the PDFium runtime into the application and collects exactly three artifacts under `release/`: the MSI, the NSIS setup, and the portable EXE.

## Verified locally

- TypeScript typecheck, lint, format, frontend tests, and desktop frontend build.
- Rust format, Clippy with all targets/features, and the library test suite.
- Rust library tests: 81 total, 3 ignored or environment-gated, 78 passing by default.
- Frontend coverage thresholds cover `frontend/app/router.ts`, `frontend/app/workspace-path.ts`, `frontend/shared/attendance.ts`, and `frontend/shared/format.ts`. This is not full frontend coverage.
- Release binary with embedded assets built in this pass.
- Release binary launched against the existing WebView profile: the remembered temporary smoke workspace was ignored, `tutorux.lastWorkspace` was cleared, and the Welcome screen rendered.
- Packaged smoke checks are run manually against the release binary. Smoke runs leave a temporary workspace in the WebView profile; Tutorux now ignores and clears remembered workspaces inside the OS temporary directory, so a packaged build opens the Welcome screen instead of a stale smoke workspace.
- Real Whisper speech transcription and real printed-text OCR fixtures.
- ICS recurrence, timezone, OAuth callback, schema migration, schedule conflict, and attendance tests.
- 1 GiB synthetic workspace qualification with integrity `ok`.

## Environment-gated qualifications

These are implemented code paths with deterministic local tests. The final live proof needs the listed environment. They are not open code gaps.

| Qualification | Code status | Command or runbook | Required environment | Expected evidence |
| --- | --- | --- | --- | --- |
| Google/Microsoft OAuth | Implemented with PKCE, loopback callback, token refresh, and mock callback tests | Settings → Calendars, then `pnpm run desktop:dev` and connect | Desktop OAuth client ID and secret from the provider console | Account appears with an event count; sync reports created/updated/removed |
| Apple CalDAV | Implemented with app-specific password and ICS recurrence/timezone parsing | Settings → Calendars → Apple Calendar | CalDAV URL, Apple ID, app-specific password | Account appears and sync reports event counts |
| Live cloud AI | Implemented with reviewed host allowlists and mock HTTP tests | Settings → Assistant provider, then run one reviewed request | Real provider key | Streamed response appears; no key is written into the workspace |
| Local GGUF | Implemented with bounded token/memory controls | `TUTORUX_GGUF_MODEL=C:\models\model.gguf cargo test --manifest-path src-tauri/Cargo.toml --lib embedded_ai::headless::tests::generates_text_from_a_real_gguf -- --ignored --nocapture` | A compatible GGUF model and enough RAM | Test emits at least one token and non-empty text |
| Scanned PDF OCR | Implemented with bundled PDFium and hybrid embedded-text/raster OCR | `pnpm run pdfium:fetch`, then `TUTORUX_PDF_FIXTURE=C:\fixtures\scanned.pdf cargo test --manifest-path src-tauri/Cargo.toml --lib ocr::tests::reads_a_scanned_pdf_fixture -- --ignored --nocapture` | PDFium runtime and a scanned PDF fixture | Extracted text contains the fixture phrase |
| 100 GB workspace | Scripted qualification with free-space guard | `pnpm run qualify:large -- 100` | About 120 GiB free and a long-running window | Integrity `ok`, recorded size and duration |
| Windows capture matrix | Implemented capture path; matrix documented | `docs/verification/CAPTURE-MATRIX.md` | Windows microphone and system-audio device | Microphone/system tracks recorded and mixed |
| macOS capture matrix | Implemented with ScreenCaptureKit; matrix documented | `docs/verification/CAPTURE-MATRIX.md` | macOS 14+ and capture permission | Microphone/system tracks recorded and mixed |
| Linux capture matrix | Implemented with PipeWire; matrix documented | `docs/verification/CAPTURE-MATRIX.md` | PipeWire/WirePlumber and a microphone | Microphone/system tracks recorded and mixed |
| Mobile hardware capture | Responsive layout and file attachment are implemented; hardware capture is not qualified | `docs/verification/CAPTURE-MATRIX.md` | Real iOS/Android device | Capture or file attachment path verified on hardware |

## Physical recovery limits

`workspace_salvage` copies every readable row into a new workspace, skips unreadable rows, rebuilds search, and reports copied/skipped counts. It cannot reconstruct bytes that no longer exist on disk or inside a destroyed SQLite page. That is a physical limit, not a missing code path.

## Reference

- [Architecture](docs/ARCHITECTURE.md)
- [Workspace format](docs/archive-format/TUTOR-FORMAT.md)
- [TypeScript development](docs/development/TYPESCRIPT.md)
- [Verification](docs/verification.md)
- [Capture matrix](docs/verification/CAPTURE-MATRIX.md)
- [Production readiness](docs/engineering/PRODUCTION-READINESS.md)
