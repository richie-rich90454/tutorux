# Releasing Tutorux

Tutorux is a Tauri 2 desktop application. The frontend assets are embedded in the executable; the `.tutor` workspace remains a user file.

## Build prerequisites

- Node.js 22.13 or newer
- pnpm 12.14.0
- Rust stable 1.90 or newer
- Native Tauri build prerequisites for the target operating system
- WebView2 runtime on Windows

SQLCipher is built through `rusqlite` with bundled SQLCipher and vendored OpenSSL. The first release build is expensive; later builds reuse Cargo artifacts.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm run pdfium:fetch
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

`pnpm exec tauri build --no-bundle` writes:

```text
src-tauri/target/release/tutorux-desktop.exe   # Windows
src-tauri/target/release/tutorux-desktop       # macOS/Linux
```

Run `pnpm run desktop:build` for the full installer packaging flow. Artifacts are collected under `release/` by `scripts/collect-release.mjs`.

## File association

The desktop bundle registers `.tutor` files as Tutorux Workspaces. Opening a `.tutor` file while a second instance is running is handed to the running instance through the single-instance plugin and the launch queue.

## Workspace compatibility

- `.tutor` files are SQLite databases with `PRAGMA application_id = 0x54555452` and `PRAGMA user_version`.
- Schema changes must use migrations and preserve existing user data.
- Encrypted workspaces use SQLCipher. Backups must preserve encryption.
- Do not ship a build that silently changes the database schema without a migration.

## Release checklist

- [ ] TypeScript typecheck passes.
- [ ] ESLint passes.
- [ ] Formatting check passes.
- [ ] Frontend unit coverage is 100%.
- [ ] Frontend desktop build succeeds.
- [ ] Rust formatting passes.
- [ ] Clippy passes with all targets and features.
- [ ] Rust tests pass.
- [ ] `tauri build --no-bundle` succeeds and the release application opens with embedded assets.
- [ ] `pnpm run desktop:build` succeeds and writes the MSI, NSIS setup, and portable EXE to `release/`.
- [ ] Create, save, reopen, encrypt, unlock, rekey, and back up a workspace.
- [ ] Record audio, stop, play the mixer, attach an audio file, and transcribe real speech with the bundled Whisper model.
- [ ] Run OCR on a printed image and confirm the extracted text is searchable.
- [ ] Run OCR on a scanned PDF after `pnpm run pdfium:fetch` and confirm the extracted text is searchable.
- [ ] Export and import a `.tutorpkg` session package.
- [ ] Run compaction, reindexing, backup, recovery copy, and a sanitized copy.
- [ ] Verify reminders at the configured lead time.
- [ ] Connect Google, Microsoft, and Apple CalDAV accounts with real credentials and sync events.
- [ ] Run one cloud AI request with a real provider key and one local GGUF request.
- [ ] Verify `.tutor` file association and launch handoff.
- [ ] Confirm no browser build, `.tux` format, or CLI artifacts are produced.
- [ ] Confirm the OCR model attribution is included in the release.

## Known qualification gaps

- Google/Microsoft OAuth and Apple CalDAV require external accounts and are environment-gated.
- Mobile hardware capture, 100 GB stress qualification, and macOS/Linux device capture matrices remain environment-gated.
- Archive salvage copies readable rows; it cannot reconstruct physically destroyed SQLite pages.
- Linux/macOS native capture qualification still needs real device matrices.
