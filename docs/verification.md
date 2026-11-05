# Verification

Current verification covers the SQLite workspace store, the SolidJS shell, local inference/OCR/transcription, and the desktop release path.

## Last verified result

| Check | Result |
| --- | --- |
| `pnpm run typecheck` | Pass |
| `pnpm run lint` | Pass |
| `pnpm run format:check` | Pass |
| `pnpm run test:coverage` | Pass; 100% statements, branches, functions, and lines |
| `pnpm run build` | Pass; desktop frontend built |
| `cargo fmt --check` | Pass |
| `cargo clippy --all-targets --all-features -- -D warnings` | Pass |
| `cargo test --lib` | 71 passed, 1 ignored qualification test |
| `pnpm exec tauri build --no-bundle` | Pass |
| `pnpm run desktop:build` | Pass; MSI, NSIS setup, and portable EXE collected under `release/` |
| Release application smoke test | Pass; all ten routes, zero page errors |
| 1 GiB synthetic workspace qualification | Pass; integrity `ok` |
| Real Whisper speech fixture | Pass; JFK sample transcribed |
| Real OCR image fixture | Pass; printed text recognized |

## Frontend coverage

The coverage include list is intentionally limited to the pure modules with unit coverage:

- `frontend/app/router.ts`
- `frontend/shared/format.ts`

UI components are exercised through runtime smoke checks in the Tauri WebView. Adding a Vitest JSX test harness is recommended before expanding the pure-module surface.

## Store tests

`src-tauri/src/store/tests.rs` covers:

- student, session, journal, and observation creation;
- FTS5 search over journal content;
- recurring schedule materialization;
- material chunk import and readback;
- compressed blob round-trip;
- encrypted workspace creation and passphrase-gated reopening;
- evidence links and graph filtering;
- separate microphone/system/mixed recording tracks;
- session package export and import, including source-ID remapping;
- sanitized copies removing private content;
- reminder windows;
- a configurable large-workspace qualification.

Additional Rust tests cover the AI transport boundary, credentials, embedded GGUF metadata, calendar PKCE/ICS parsing, real Whisper speech transcription, real OCR text extraction, synchronized capture, and desktop export.

## Runtime smoke checks

The following were exercised in the Tauri WebView against the packaged 1.0.0 binary:

- create/open a plain workspace;
- create an encrypted workspace, reject a wrong passphrase, unlock, rekey, and reject the old passphrase;
- create manual backups for plain and encrypted workspaces;
- create a student and session through the UI;
- add journal, observation, and transcript content;
- create evidence, link it, and render the evidence graph;
- import an image material and run OCR; the fixture extracted `FRACTIONS`;
- import and export a `.tutorpkg` session package and read the imported material bytes;
- store mixed/microphone/system tracks, read a system track, and play the mixer;
- attach an audio file through the capture view;
- create a due schedule and receive it from `reminders_due`;
- compact the workspace, rebuild indexes, create a recovery copy, and create a sanitized copy;
- configure a calendar client ID and read the account status;
- search across students and notes with `Ctrl+K`;
- verify database integrity;
- inspect Trash and restore a student;
- load every route with zero page errors;
- check key routes at a 390 px mobile viewport with no horizontal overflow;
- build, package, and launch the release binary with embedded assets.

## Qualification commands

```sh
TUTORUX_QUALIFY_GB=1 cargo test --manifest-path src-tauri/Cargo.toml --lib store::tests::qualifies_a_large_workspace -- --ignored --nocapture
```

## Not yet automated

- Live Google, Microsoft, and Apple calendar connections with real accounts.
- Cloud AI provider calls with real keys.
- Local GGUF generation with a real model.
- 100 GB synthetic workspace qualification; only 1 GiB has been run.
- macOS/Linux device capture matrices.
- Mobile hardware capture; only the responsive viewport and file-attachment path were checked.
- Scanned PDF OCR; image materials are supported.
- Salvaging rows from a physically corrupted SQLite file.
- A dedicated Tauri UI automation suite.
