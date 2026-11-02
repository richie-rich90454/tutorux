# Tutorux

Tutorux is a local-first tutoring workspace. Student profiles, sessions, notes, transcripts, recordings, materials, evidence, and study guides live in portable `.tux` archives.

The application is a SolidJS and TypeScript interface running as a static Vite site or inside a Tauri 2 desktop shell. The same archive engine and domain rules serve the browser app and the desktop app; the standalone CLI uses the shared Rust core. Windows, macOS, and Linux are supported desktop targets.

## Requirements

- Node.js 22.13 or newer
- pnpm 12.14.0
- Rust stable and the native Tauri prerequisites for desktop builds
- FFmpeg on `PATH` for FLAC, MP3, and M4A import and for CLI recording fallback

## Development

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

Useful checks and builds:

```sh
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run test:e2e
pnpm run benchmark:archive
pnpm run build
pnpm run build:desktop
pnpm run desktop:dev
pnpm run desktop:build
```

`pnpm run build` produces the static site in `dist/`. `pnpm run desktop:build` typechecks, builds, packages, and collects the Tauri artifacts into `release/`. On Windows it produces an MSI installer, an NSIS setup installer, and `Tutorux_<version>_x64_portable.exe`. The portable EXE is the desktop executable with its frontend assets embedded; it does not unpack itself into a runtime directory or need companion application files. It still uses the installed system WebView2 runtime. Build release bundles on matching operating-system runners; one host does not cross-package all three desktop targets.

The desktop app uses per-user application state for archive locks and detached-recording controls. Whisper runs in process from the model embedded in the application executable; it does not download, extract, or write model files. Compressed-audio import uses uniquely named temporary files in the operating-system temp location and cleans them up; the desktop app does not create a temporary workspace directory. The standalone Rust CLI has its own temporary-file behavior and is not included in the portable EXE.

See [Desktop release builds](docs/development/RELEASING.md) for artifact names, runtime requirements, and the distinction between the portable desktop executable and the standalone CLI.

## Recording and transcripts

The **Record** workspace is a primary navigation destination. Create or select a tutoring session, confirm recording consent, then record from the microphone or import an audio file. Recordings stay linked to that session. Import an existing transcript as plain text, SubRip, or WebVTT, or create timestamped cues from the full recording with the bundled multilingual Whisper Base model. Desktop full-track and live transcription work offline without a separate executable or model file; generated cues remain provisional until reviewed.

Journal dates use the explicit `YYYY-MM-DD` format with an in-app calendar. Audio and video previews use Tutorux playback controls so their visible controls stay consistent across desktop and browser builds.

The desktop app relies on the system WebView (WebView2 on Windows). The bundled Whisper Base Q5_1 model is part of every desktop executable, including both installers and the portable EXE. GGUF model files and the user's `.tux` archives remain user-supplied; FFmpeg is used for compressed-audio import. The command-line interface is the standalone Rust `tutorux-cli` binary. Build it with `cargo build --manifest-path src-tauri/Cargo.toml --features cli --bin tutorux-cli`; it is not embedded in the desktop executable.

```sh
tutorux-cli --help
tutorux-cli archive discover --directory ./archives --json
tutorux-cli archive init Lesson.tux --name "Algebra foundations"
tutorux-cli archive encrypt Lesson.tux --new-passphrase-env TUTORUX_NEW_ARCHIVE_PASSPHRASE
tutorux-cli archive rename Lesson.tux --name "Algebra foundations"
tutorux-cli --passphrase-env TUTORUX_ARCHIVE_PASSPHRASE archive rename Lesson.tux --name "Algebra foundations"
tutorux-cli --archive Lesson.tux student create --name "Maya Ortiz" --grade 10
tutorux-cli --archive Lesson.tux session create --title "Fraction review" --subject Mathematics
tutorux-cli --archive Lesson.tux transcript import --session <uuid> --input lesson.srt
tutorux-cli --archive Lesson.tux transcript generate --session <uuid>
tutorux-cli --archive Lesson.tux asset import --input worksheet.pdf --session <uuid>
tutorux-cli archive verify Lesson.tux --full --json
```

For an encrypted archive, provide its current passphrase with `--passphrase-env NAME`. `archive rename` changes only the display name. `transcript generate` resolves the session's default track and selected local Whisper model when the corresponding options are omitted; pass `--consent-local-audio` when the host requires explicit confirmation.

Session deletion first reports a revision-bound scope token, what will move to Trash, and which journal links will be detached. Copy that token into the confirmation command; restore brings the session group and its journal links back together.

New sessions start active and automatically create a dated journal entry. Use `--entry-id` to attach a CLI-created session to an existing journal entry.

### CLI live audio recording

The CLI records microphone and supported system-loopback inputs at the source's native rate and channel count. It runs in the foreground; press Ctrl+C to stop and save. `record configure` stores microphone, playback, and durability preferences in the archive. Use `--source both` to save microphone and system audio as separate synchronized tracks. The CLI writes native-rate tracks and resamples only the Whisper window input to 16 kHz mono.

```sh
tutorux-cli --archive Lesson.tux record start --session <uuid> --consent --source microphone
tutorux-cli --archive Lesson.tux record start --session <uuid> --consent --source system-audio --playback <loopback-id>
tutorux-cli --archive Lesson.tux record start --session <uuid> --consent --source both --microphone <microphone-id> --playback <loopback-id>
tutorux-cli record devices
tutorux-cli --archive Lesson.tux record play --session <uuid> --track <uuid>
```

Device selection, platform backends, consent, optional local Whisper transcription, and the external FFmpeg requirement are covered in [the recording guide](docs/audio/CLI-LIVE-RECORDING.md).

## Archive compatibility

The archive layer reads and writes the v1 header, record frames, primary B+ tree, commit, locator, encrypted envelopes, BLOB chunks, and secondary indexes. It validates lengths, checksums, and commit authentication before decoding. Legacy-format fixtures under `tests/fixtures/` are used for cross-implementation compatibility tests.

The Solid UI and CLI can create and unlock encrypted v1 archives, authenticate their commit, index pages, and manifest, verify encrypted records on read, and append edits as authenticated generations. Encryption can be enabled on an open, fully published plaintext archive while preserving its ID and retained history. `archive change-passphrase` re-keys an archive after unlocking; previously saved backups keep their original passphrase.

`archive recover` inspects an archive by default. Add `--recover-unpublished` (or `--apply`) to publish a complete unpublished generation after full validation, or `--discard-tail` to remove uncommitted trailing bytes.

`archive compact` applies the rewrite by default and rebuilds secondary indexes while preserving retained revision history. Use `--preview` to inspect the result without replacing the file. It supports unlocked encrypted archives and can optionally prune unreferenced asset blobs.

`archive repair` creates a separate `.tux` copy from the newest generation that passes full verification. It falls back to an earlier published generation when the latest generation has damaged records, compacts the copy, verifies it, and leaves the source untouched. The CLI requires `--confirm-sensitive`. Header repair handles supported checksum or magic corruption.

`archive backup` (also `archive copy`) writes a byte-for-byte copy of a structurally openable archive, including encrypted archives, to a new destination. It requires `--confirm-sensitive` and preserves the original passphrase and bytes.

`archive sanitize` previews a new `.tux` copy, then requires `--confirm-sensitive` plus the preview's generation, selection fingerprint, output path, and encryption choice before creating it. Student, session, and recording-track filters are supported. Private annotations and generation logs are excluded by default. An encrypted source always produces an encrypted copy; `--include-credentials` keeps existing credential records only from an encrypted source and requires encrypted output. The CLI writes bounded staging batches, fully verifies the copy, then atomically publishes it.

The wire format is documented in [TUX-FORMAT-V1.md](docs/archive-format/TUX-FORMAT-V1.md) and [SESSION-PACKAGE-V1.md](docs/archive-format/SESSION-PACKAGE-V1.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [TypeScript development](docs/development/TYPESCRIPT.md)
- [Feature inventory](docs/migration/feature-inventory.md)
- [Archive format](docs/archive-format/TUX-FORMAT-V1.md)
- [Portable privacy](docs/security/PORTABLE-PRIVACY.md)
- [Performance baseline](docs/performance/TYPESCRIPT-BASELINE.md)
- [AI handoff](docs/ai/TYPESCRIPT-HANDOFF.md)

## License

Tutorux is licensed under GPL-3.0-only. See [LICENSE](LICENSE).
