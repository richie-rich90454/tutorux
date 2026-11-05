# Production readiness

This replaces the retired custom-format production audit.

## Ready

- SQLite workspace create/open/close.
- Optional SQLCipher encryption, unlock, rekey, and encrypted backup.
- Students, sessions, journals, observations, cues, materials, guides, evidence, schedule, settings, and Trash.
- FTS5 search across the workspace.
- Manual verified backup and integrity check.
- Session capture with microphone and optional system audio.
- Local Whisper UI path and bundled model tests.
- Local GGUF selection/loading and cloud AI transport.
- Desktop release binary with embedded assets.
- `.tutor` file association and single-instance launch handoff.
- Removed legacy `.tux`, browser, CLI, and console surfaces.

## Verified commands

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

All pass as of the latest implementation pass. The release binary was launched and loaded embedded assets from `https://tauri.localhost`.

## External qualification required

- Cloud AI with real provider keys.
- Local GGUF with a real model file.
- Real spoken audio through the Whisper UI.
- Windows/macOS/Linux capture device matrices.
- 100 GB synthetic workspace.
- Installer signing and notarization.
- Mobile capture qualification.

## Known functional gaps

- Google Calendar, Outlook, and macOS Calendar OAuth.
- Reminders/background notifications.
- OCR for scanned worksheets.
- Evidence graph view.
- Session package export/import.
- Sanitized copy.
- Advanced archive repair/compaction/recovery in the UI.
- Multi-track mixer UI.

## Data safety

- All writes are SQLite transactions.
- WAL with `synchronous = FULL`.
- Encrypted workspaces use SQLCipher and zeroize the key on close.
- Backups are manual and verified.
- Trash retains deleted records for 90 days.
- No background sync or cloud workspace hosting exists.

## Release recommendation

The desktop core is usable for a single-tutor local workflow. Do not describe calendar OAuth, OCR, mobile capture, or 100 GB qualification as complete until those items are implemented and tested.
