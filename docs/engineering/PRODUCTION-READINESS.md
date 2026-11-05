# Production readiness

This replaces the retired custom-format production audit.

## Ready

- SQLite workspace create/open/close.
- Optional SQLCipher encryption, unlock, rekey, and encrypted backup.
- Students, sessions, journals, observations, cues, materials, guides, evidence, schedule, settings, and Trash.
- FTS5 search across the workspace.
- Manual verified backup, integrity check, compaction, reindexing, recovery copies, and sanitized copies.
- Session capture with microphone and optional system audio, separate tracks, and a local mixer.
- Local Whisper with a real speech fixture and the bundled model.
- Local image OCR with embedded models and a real printed-text fixture.
- Local GGUF selection/loading and reviewed cloud AI transport.
- Google/Microsoft OAuth and Apple CalDAV calendar integration code with credential-store token storage.
- Reminder notifications with configurable lead time.
- `.tutorpkg` session packages with ID and evidence-source remapping.
- Evidence links and graph view.
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
pnpm run desktop:build
```

All pass as of the latest implementation pass. The packaged binary was launched, loaded embedded assets from `https://tauri.localhost`, and completed the route and workspace smoke test. `desktop:build` produced the MSI, NSIS setup, and portable EXE under `release/`.

The 1 GiB synthetic workspace qualification passed with integrity `ok`. Real Whisper speech and real OCR text fixtures pass.

## External qualification required

- Cloud AI with real provider keys.
- Local GGUF with a real model file.
- Live Google/Microsoft OAuth and Apple CalDAV accounts.
- Windows/macOS/Linux capture device matrices.
- 100 GB synthetic workspace.
- Installer signing and notarization.
- Mobile hardware capture.

## Known functional gaps

- Scanned PDF OCR; images are supported.
- Salvaging rows from a physically corrupted SQLite file; recovery copies healthy workspaces.
- Calendar recurrence beyond daily/weekly/biweekly CalDAV rules.
- Device-qualified mobile recording; responsive layout and file attachment are available.

## Data safety

- All writes are SQLite transactions.
- WAL with `synchronous = FULL`.
- Encrypted workspaces use SQLCipher and zeroize the key on close.
- Backups are manual and verified.
- Trash retains deleted records for 90 days.
- No background sync or cloud workspace hosting exists.
- Calendar tokens and client secrets live in the OS credential store, not in the workspace.

## Release recommendation

The desktop core is usable for a single-tutor local workflow. Do not describe live calendar connections, live cloud AI, local GGUF generation, mobile hardware capture, or 100 GB qualification as complete until those items are qualified with real accounts, models, devices, and storage.
