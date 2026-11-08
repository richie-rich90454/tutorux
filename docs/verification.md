# Verification

Current verification covers the SQLite workspace store, the SolidJS shell, local inference/OCR/transcription, calendar parsing, recovery, and the desktop release path.

## Last verified result

| Check | Result |
| --- | --- |
| `pnpm run typecheck` | Pass |
| `pnpm run lint` | Pass |
| `pnpm run format:check` | Pass |
| `pnpm run test:coverage` | Pass; 100% of the covered modules |
| `pnpm run build` | Pass |
| `cargo check --lib` | Pass |
| `cargo test --lib` | 78 passed, 3 ignored, 0 failed |
| `pnpm exec tauri build --no-bundle` | Pass; release binary built in this pass |
| `pnpm run desktop:build` | Pass; exactly MSI, NSIS setup, and single-file portable EXE under `release/` |
| Release startup smoke test | Pass; stale temporary workspace ignored and cleared, Welcome shown |
| 1 GiB synthetic workspace qualification | Pass; integrity `ok` |
| Real Whisper speech fixture | Pass; JFK sample transcribed |
| Real OCR image fixture | Pass; printed text recognized |
| Rendered PDF OCR | Pass; generated page recognized |
| Scanned PDF fixture | Environment-gated; requires PDFium and `TUTORUX_PDF_FIXTURE` |

## Frontend coverage

Coverage thresholds intentionally cover the pure modules with unit tests:

- `frontend/app/router.ts`
- `frontend/app/workspace-path.ts`
- `frontend/shared/attendance.ts`
- `frontend/shared/format.ts`

This is not full frontend coverage. UI components are exercised through runtime smoke checks in the Tauri WebView. A Vitest JSX harness is the next step before expanding the covered surface.

## Store tests

`src-tauri/src/store/tests.rs` covers:

- student, session, journal, and observation creation;
- FTS5 search over journal content;
- recurring schedule materialization with interval and end dates;
- overlapping schedule conflict detection;
- schema migration from version 1 to version 2;
- material chunk import and readback;
- compressed blob round-trip;
- encrypted workspace creation and passphrase-gated reopening;
- evidence links and graph filtering;
- separate microphone/system/mixed recording tracks;
- session package export and import, including source-ID remapping;
- sanitized copies removing private content;
- best-effort salvage of readable rows into a new workspace;
- reminder windows;
- a configurable large-workspace qualification.

Additional Rust tests cover the AI transport boundary, credentials, embedded GGUF metadata, calendar PKCE/callback/ICS parsing and timezones, real Whisper speech transcription, real OCR text extraction, synchronized capture, desktop export, and PDF OCR plumbing.

## Runtime smoke checks

The following are exercised manually against a packaged binary:

- create/open a plain workspace;
- confirm a remembered temporary workspace from a smoke run is ignored and cleared (verified against the release binary in this pass);
- create an encrypted workspace, reject a wrong passphrase, unlock, rekey, and reject the old passphrase;
- create manual backups for plain and encrypted workspaces and confirm the backup age in Today;
- create a student and session through the UI;
- add journal, observation, and transcript content;
- create evidence, link it, and render the evidence graph;
- import an image material and run OCR; the fixture extracted `FRACTIONS`;
- import a scanned PDF after `pnpm run pdfium:fetch` and confirm extracted text is searchable;
- import and export a `.tutorpkg` session package and read the imported material bytes;
- store mixed/microphone/system tracks, read a system track, and play the mixer;
- attach an audio file through the capture view;
- create a due schedule and receive it from `reminders_due`;
- create an overlapping lesson and confirm the warning allows an explicit override;
- mark a session as a no-show and confirm the attendance rate excludes it from completed lessons;
- schedule the next lesson from a completed session;
- import an ICS file with `TZID`, `RRULE`, `INTERVAL`, and `UNTIL` and confirm the series is preserved;
- compact the workspace, rebuild indexes, create a recovery copy, and create a sanitized copy;
- repair a damaged workspace copy and inspect the salvage report;
- configure a calendar client ID and read the account status;
- search across students and notes with `Ctrl+K`;
- verify database integrity;
- inspect Trash and restore a student;
- load every route with zero page errors;
- check key routes at a 390 px mobile viewport with no horizontal overflow;
- build, package, and launch the release binary with embedded assets.

Smoke runs use the same WebView profile as the packaged application. Tutorux now ignores remembered workspaces inside the OS temporary directory; run smoke tests with a clean profile or clear `tutorux.lastWorkspace` when testing with non-temporary paths.

## Qualification commands

```sh
TUTORUX_QUALIFY_GB=1 cargo test --manifest-path src-tauri/Cargo.toml --lib store::tests::qualifies_a_large_workspace -- --ignored --nocapture
pnpm run qualify:large -- 100
pnpm run pdfium:fetch
TUTORUX_PDF_FIXTURE=C:\fixtures\scanned.pdf cargo test --manifest-path src-tauri/Cargo.toml --lib ocr::tests::reads_a_scanned_pdf_fixture -- --ignored --nocapture
TUTORUX_GGUF_MODEL=C:\models\model.gguf cargo test --manifest-path src-tauri/Cargo.toml --lib embedded_ai::headless::tests::generates_text_from_a_real_gguf -- --ignored --nocapture
```

## Environment-gated verification

- Live Google, Microsoft, and Apple calendar connections with real accounts.
- Cloud AI provider calls with real keys.
- Local GGUF generation with a real model.
- 100 GB synthetic workspace qualification; only 1 GiB has been run.
- macOS/Linux/Windows device capture matrices; see `docs/verification/CAPTURE-MATRIX.md`.
- Mobile hardware capture; the responsive viewport and file-attachment path are implemented.
- A dedicated Tauri UI automation suite.
