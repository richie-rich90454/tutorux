# TypeScript development guide

This guide covers the SolidJS, Vite, Tauri, Rust host, and CLI code.

## Toolchain

- Node.js 24+
- pnpm 10+
- Rust stable for desktop development and packaging
- On Linux, the Tauri WebKitGTK development libraries listed in `.github/workflows/tauri-cross-platform.yml`

Use the committed `pnpm-lock.yaml` for reproducible installs:

```sh
pnpm install --frozen-lockfile
```

## Web workflow

```sh
pnpm run dev
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run test:e2e
pnpm run build
pnpm run preview
```

The static build is written to `dist/`. Do not import `@tauri-apps/*` from a domain module or the browser adapter; Vite selects `frontend/platform/browser.ts` for the web build.

## Desktop workflow

```sh
pnpm run desktop:dev
pnpm run desktop:build
```

The desktop adapter is selected with Vite's `desktop` mode. The Rust host lives in `src-tauri/` and provides native file operations plus the narrowly scoped HTTP transport for the user's explicitly reviewed AI provider request. It validates the exact reviewed endpoint and request hash, applies provider-route and size limits, and returns response bytes; provider parsing and tutoring rules stay in TypeScript. Run `cargo check --manifest-path src-tauri/Cargo.toml` for a fast host check. The desktop executable links whisper.cpp and llama.cpp into one process; `src-tauri/vendor/whisper-rs-sys` prefixes whisper's ggml symbols so the two native runtimes can coexist. Build release bundles on each target OS; Tauri's native toolchain and WebView dependencies are host-specific.

## CLI workflow

```sh
pnpm run cli -- --help
pnpm run cli -- archive init Lesson.tux --name "Algebra"
pnpm run cli -- archive recover Lesson.tux --json
pnpm run cli -- archive recover Lesson.tux --apply --json
pnpm run cli -- archive compact Lesson.tux --preview --json
pnpm run cli -- archive compact Lesson.tux --json
pnpm run cli -- archive repair Lesson.tux --output Lesson-repaired.tux --confirm-sensitive --json
pnpm run cli -- archive sanitize Lesson.tux --output Lesson-sanitized.tux --include-students <uuid> --json
pnpm run cli -- archive sanitize Lesson.tux --output Lesson-sanitized.tux --include-students <uuid> --confirm-sensitive --expected-generation <generation> --expected-selection <sha256> --expected-output Lesson-sanitized.tux --expected-encrypted-output no --json
pnpm run cli -- --passphrase-env TUTORUX_SOURCE_PASSPHRASE archive sanitize Protected-Lesson.tux --output Protected-sanitized.tux --include-credentials --json
pnpm run cli -- archive sanitize Lesson.tux --output Encrypted-copy.tux --include-students <uuid> --confirm-sensitive --expected-generation <generation> --expected-selection <sha256> --expected-output Encrypted-copy.tux --expected-encrypted-output yes --new-passphrase-env TUTORUX_COPY_PASSPHRASE --json
pnpm run cli -- --passphrase-env TUTORUX_SOURCE_PASSPHRASE archive sanitize Protected-Lesson.tux --output Protected-sanitized.tux --include-credentials --confirm-sensitive --expected-generation <generation> --expected-selection <sha256> --expected-output Protected-sanitized.tux --expected-encrypted-output yes --new-passphrase-env TUTORUX_COPY_PASSPHRASE --json
pnpm run cli -- --archive Lesson.tux student create --name "Maya Ortiz"
pnpm run cli -- --archive Lesson.tux session list --json
```

For encrypted creation, set a passphrase in the process environment and name that variable on the CLI. In PowerShell:

```powershell
# Populate this variable from a secret manager or secure prompt; do not type the secret into a command.
pnpm run cli -- archive init Protected-Lesson.tux --name "Algebra" --new-passphrase-env TUTORUX_NEW_ARCHIVE_PASSPHRASE
pnpm run cli -- archive verify Protected-Lesson.tux --passphrase-env TUTORUX_NEW_ARCHIVE_PASSPHRASE --json
# Load a replacement phrase from your secret manager or secure prompt first.
pnpm run cli -- --passphrase-env TUTORUX_NEW_ARCHIVE_PASSPHRASE archive change-passphrase Protected-Lesson.tux --new-passphrase-env TUTORUX_ROTATED_ARCHIVE_PASSPHRASE
Remove-Item Env:TUTORUX_NEW_ARCHIVE_PASSPHRASE
Remove-Item Env:TUTORUX_ROTATED_ARCHIVE_PASSPHRASE
```

On macOS or Linux, inject the variable from a secret manager or secure prompt for the command session, then unset it when finished. Do not put the passphrase in an inline command or shell assignment that may be saved in history.

The CLI imports the same archive and domain modules as the UI. File paths are resolved by Node; archive reads are positional and bounded. `archive init` can create an encrypted archive with `--new-passphrase-env NAME`; encrypted access uses `--passphrase-env NAME`. `archive change-passphrase FILE --new-passphrase-env NAME` re-keys the archive after verifying the current passphrase. Passphrases stay out of command arguments and are not included in CLI output. Recovery inspects by default; `--recover-unpublished` or `--apply` publishes only a complete next generation after full record verification, and `--discard-tail` removes uncommitted bytes. Compaction applies by default, previews with `--preview`, rebuilds secondary indexes, preserves indexed history and stored payloads, optionally prunes unreferenced asset chunks, and supports unlocked encrypted archives. Recovery, repair, and compaction are available for encrypted archives after unlock. Repair creates a separate `.tux` copy from the newest fully verified published generation, may fall back to an earlier generation, and requires `--confirm-sensitive` because it can contain private student records and recordings. Sanitization first reports included record counts, encryption status, and a selection fingerprint; confirmation must repeat the same generation, selection, and output path. Encrypted sources always produce encrypted output, and `--new-passphrase-env NAME` can also encrypt output from an unencrypted source. Student/session and recording-track filters are supported, private annotations and generation logs are opt-in, and credentials are excluded unless `--include-credentials` is selected. Credential-inclusive copies require an encrypted source and destination; use `--new-passphrase-env NAME` for the destination phrase. Credential-looking values outside credential records are rejected when inclusion is requested. The CLI checkpoints bounded copy batches to a private disk-backed staging file, verifies the finished archive there, then publishes it atomically. Do not add a second archive serializer for CLI convenience.

CLI and desktop archive access share OS-level reader/writer locks, including across compaction, passphrase rotation, and atomic replacement. The standalone CLI requires the `tutorux-audio-helper` native executable for this coordination; build it with `pnpm run build:audio-helper` or set `TUTORUX_ARCHIVE_LOCK_HELPER` to the helper executable's path. If the helper cannot be found, archive commands stop with an explicit setup error rather than proceeding without a lock. The desktop executable does not use the CLI helper.

## Encryption boundary

`frontend/archive/crypto.ts` provides the v1 Argon2id13, XChaCha20-Poly1305, and HMAC primitives through `libsodium-wrappers-sumo`. A legacy-format fixture checks key-envelope, record, manifest, index-page, and commit interoperability; fixture provenance is recorded in `tests/fixtures/README.md`. The Solid UI runs passphrase derivation and key wrapping in a Web Worker. Unlock authenticates the commit, all index pages, and manifest before exposing records; record AEAD is checked when records are read, and full archive verification checks each current record. The UI and CLI can create encrypted archives and append authenticated edits to unlocked archives. The CLI accepts `--new-passphrase-env NAME` for encrypted creation and `--passphrase-env NAME` for encrypted access. `archive change-passphrase <file.tux> --new-passphrase-env NAME` creates a fresh data key, re-encrypts and verifies every retained record revision, then atomically replaces the archive. Earlier backup files remain protected by their original passphrase. Passphrase rotation is available in Preferences and the CLI. The CLI also writes encrypted sanitized outputs, uses a new destination phrase, and can explicitly retain credential records from encrypted sources. Recovery, repair, and compaction of encrypted archives are available after unlock.

## Session and journal documents

`frontend/DocumentEditor.tsx` edits archive-backed paragraph, heading, bullet-list, numbered-list, checklist, quote, and code blocks in session and journal notes. The editor supports the legacy format limit of 10,000 blocks and the 256 MiB archive record ceiling, preserving large note text and multibyte block IDs. The shared domain layer keeps stable block IDs and refuses to rewrite unknown block kinds or extra legacy block fields. Saving remains explicit with the parent record. The editor uses a UTF-16 piece table for search and replacement, supports document-wide undo/redo, optional autosave, and Markdown, HTML, DOCX, and print-to-PDF exports.

## Tests and performance

Vitest tests live under `tests/cli/` and `tests/frontend/` and use Node for byte-level and CLI behavior. Playwright tests live in `tests/e2e/` and exercise the browser application.

Run `pnpm run benchmark:archive` to measure generation creation and archive listing on the current machine. Record machine, runtime, archive size, and record count with the result. Record the machine and workload with each run; the report is a smoke baseline rather than a release budget.

## Updating dependencies

Use pnpm and update `pnpm-lock.yaml`. Keep `typescript` pinned to exactly `6.0.3` as requested. Other direct dependencies use current stable versions recorded in `package.json` and the lockfile; review the Vite web and Tauri desktop builds after any major update.
