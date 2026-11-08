# Contributing to Tutorux

Thanks for helping make Tutorux better. This project is a local-first desktop app, so changes should preserve the core rule: **lesson data stays on the user's device unless the user explicitly sends it somewhere.**

## Ways to contribute

- Report a reproducible bug.
- Propose a focused feature or workflow improvement.
- Improve documentation, screenshots, or accessibility.
- Add tests for a behavior that can regress.
- Qualify a platform, capture device, calendar provider, or AI provider with real hardware or credentials.

For security issues, do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- Node.js 22.13 or newer
- pnpm 12.14.0
- Rust stable 1.90 or newer
- Native Tauri prerequisites for your operating system
- WebView2 on Windows

```sh
pnpm install --frozen-lockfile
pnpm run pdfium:fetch
pnpm run desktop:dev
```

`pdfium:fetch` is required before compiling on macOS/Linux. The Windows runtime is checked in.

## Project layout

```text
frontend/
  api/                 typed Tauri client and native command mirrors
  app/                 shell, routing, workspace provider, welcome, search
  design-system/       shared UI primitives and tokens
  features/            Today, Students, Sessions, Schedule, Materials,
                       Guides, Evidence, Assistant, Archive, Settings
  shared/              pure helpers
src-tauri/
  src/store/           SQLite workspace, migrations, search, backup, salvage
  src/platform/        native capture and device handling
  src/ocr.rs           bundled OCR and PDF rendering
  src/transcription.rs local Whisper
  src/calendar.rs      OAuth, CalDAV, ICS parsing
```

Keep page logic in `frontend/features`. Features use `frontend/api/client.ts`, not Tauri internals. Do not duplicate persistent state in a global client store; the backend is the source of truth.

## Verification

Run the checks that match your change. A normal pull request should pass:

```sh
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test:coverage
pnpm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm run desktop:build
```

If you cannot run `desktop:build`, say so in the pull request and include the checks you did run.

## Pull requests

- Keep one pull request focused on one problem.
- Explain the user-facing change, not only the implementation.
- Add or update tests for behavior that can regress.
- Update docs when a command, setting, limitation, or qualification changes.
- Include screenshots for visible UI changes.
- Do not commit generated `dist/`, `release/`, `coverage/`, `node_modules/`, or `src-tauri/target/` files.
- Use conventional commit messages where practical: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `build:`, `ci:`, `chore:`.

## Data and privacy expectations

- Never upload workspace files, recordings, transcripts, student data, or credentials to a third-party service in a test or build script.
- Never log secrets, passphrases, tokens, or raw student content.
- Cloud AI requests must remain explicit, reviewed, and host-allowlisted.
- New persistence must use the SQLite workspace and preserve existing `.tutor` files through a migration.
- Encryption must preserve SQLCipher keys on close/backup boundaries.

## Licensing

By contributing, you agree that your contribution is licensed under GPL-3.0-only, the project license. Do not add dependencies with incompatible licenses. If you add a third-party asset, record its attribution in the README or the relevant resource directory.
