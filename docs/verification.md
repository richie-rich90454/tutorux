# Verification

Current verification is focused on the SQLite workspace store, the new SolidJS shell, and the desktop release path.

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
| `cargo test --lib` | 55 passed |
| `pnpm exec tauri build --no-bundle` | Pass |
| Release application smoke test | Pass; embedded assets loaded from `https://tauri.localhost` |

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
- encrypted workspace creation and passphrase-gated reopening.

Additional Rust tests cover the AI transport boundary, credentials, embedded GGUF metadata, Whisper parsing, synchronized capture, and desktop export.

## Runtime smoke checks

The following were exercised in the Tauri WebView during implementation:

- create/open a plain workspace;
- create an encrypted workspace;
- reopen an encrypted workspace through the unlock panel;
- change a workspace passphrase;
- create a student;
- start a session;
- add journal and observation records;
- add a transcript cue;
- generate and edit a study guide;
- import a material and preview text;
- create a recurring schedule and see generated sessions on Today;
- search across students and notes with `Ctrl+K`;
- verify database integrity;
- inspect Trash and restore a student;
- build and launch the release binary with embedded assets.

## Not yet automated

- Google Calendar and Outlook OAuth.
- Real spoken-audio UI transcription with a fixture.
- Cloud AI provider calls with real keys.
- Local GGUF generation with a real model.
- 100 GB synthetic workspace qualification.
- macOS/Linux device capture matrices.
- OCR.
- A dedicated Tauri UI automation suite.
