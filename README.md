# Tutorux

Tutorux is a local-first tutoring workspace. It keeps student profiles, sessions, and teaching notes in portable `.tux` archives.

The active interface is a static Vite application built with SolidJS and TypeScript 6.0.3. The same frontend runs in a browser and in a thin Tauri 2 desktop shell. The existing green folio palette, Noto Sans typography, Tutorux logo, and favicon artwork are retained.

## Migration status

The TypeScript and SolidJS frontend with a Tauri 2 desktop host is the active rewrite target. The feature inventory is the source of truth for ported workflows, known gaps, and verification status. The current application covers broad archive, learner, session, journal, notes, transcript, audio, materials, evidence, guide, AI, settings, and CLI workflows, while some legacy behaviors and cross-platform checks remain open.

The C++/Slint implementation remains in the repository as the migration reference until the inventory and cross-platform acceptance gates are complete. Legacy design and format documents describe original behavior; they do not establish that the replacement has parity.

See the [feature inventory](docs/migration/feature-inventory.md) for exact coverage and [architecture](docs/ARCHITECTURE.md) for current module boundaries.

## Platforms

The target desktop platforms are **Windows, macOS, and Linux**. Tauri packaging is configured for all standard bundle targets, and CI builds the desktop app on each operating system. This checkout has been built and browser-verified on Windows; macOS and Linux builds must be confirmed by the cross-platform CI matrix before a release is described as qualified on those systems.

The Vite site is static and does not require a server at runtime. In browsers with the File System Access API, Tutorux can read and write the selected archive directly. Other browsers use a file picker and download flow; that fallback currently limits export to 512 MiB.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
- Rust stable and the native Tauri prerequisites for desktop builds

## Development

```sh
npm ci
npm run dev
```

Useful checks and builds:

```sh
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run test:e2e
npm run benchmark:archive
npm run build
npm run build:desktop
npm run desktop:dev
npm run desktop:build
```

`npm run build` produces the static site in `dist/`. `npm run desktop:build` packages the Tauri application for the host operating system. Cross-platform release packages are built on their matching operating-system runners; one host does not cross-package all three desktop targets.

The retained CLI can be run locally with:

```sh
npm run cli -- --help
npm run cli -- archive discover --directory ./archives --json
npm run cli -- archive init Lesson.tux --name "Algebra"
npm run cli -- archive encrypt Lesson.tux --new-passphrase-env TUTORUX_NEW_ARCHIVE_PASSPHRASE
npm run cli -- archive rename Lesson.tux --name "Algebra foundations"
npm run cli -- --passphrase-env TUTORUX_ARCHIVE_PASSPHRASE archive rename Lesson.tux --name "Algebra foundations"
npm run cli -- --archive Lesson.tux student create --name "Maya Ortiz" --grade 10
npm run cli -- --archive Lesson.tux student list
npm run cli -- --archive Lesson.tux student list --json
npm run cli -- --archive Lesson.tux student show <student-uuid> --json
npm run cli -- --archive Lesson.tux student history <student-uuid> --json
npm run cli -- --archive Lesson.tux student progress <student-uuid> --json
npm run cli -- --archive Lesson.tux student progress-review <student-uuid> --skill "Equivalent fractions" --classification partial-improvement --evidence-ids <evidence-from-session-1>,<evidence-from-session-2> --reviewed-by "Tutor"
npm run cli -- --archive Lesson.tux session create --title "Fraction review" --subject Mathematics --student <student-uuid>
npm run cli -- --archive Lesson.tux session create --title "Fraction review" --subject Mathematics --entry-id <journal-entry-uuid>
npm run cli -- --archive Lesson.tux session update <session-uuid> --notes "Revisit equivalent fractions next time"
npm run cli -- --archive Lesson.tux session clone <session-uuid> [--title "Practice copy"] [--type notes-only]
npm run cli -- --archive Lesson.tux session start <session-uuid>
npm run cli -- --archive Lesson.tux session complete <session-uuid>
npm run cli -- --archive Lesson.tux session review <session-uuid>
npm run cli -- --archive Lesson.tux session resume <session-uuid>
npm run cli -- --archive Lesson.tux session delete <session-uuid> --dry-run --json
npm run cli -- --archive Lesson.tux session delete <session-uuid> --confirm-scope --scope-token <scope-token>
npm run cli -- --archive Lesson.tux session restore <session-uuid>
npm run cli -- --archive Lesson.tux session archive <session-uuid>
npm run cli -- --archive Lesson.tux session list --archived --json
npm run cli -- --archive Lesson.tux session list --student-id <student-uuid> --from 2026-01-01 --to 2026-01-31 --json
npm run cli -- --archive Lesson.tux session list --entry-id <journal-entry-uuid> --unarchived --json
npm run cli -- --archive Lesson.tux session unarchive <session-uuid>
npm run cli -- --archive Lesson.tux session show <session-uuid> --json
npm run cli -- --archive Lesson.tux session verify <session-uuid> --json
npm run cli -- archive recover Lesson.tux --json
npm run cli -- archive recover Lesson.tux --apply --json
npm run cli -- archive compact Lesson.tux --json
npm run cli -- archive compact Lesson.tux --apply --json
npm run cli -- archive repair Lesson.tux --output Lesson-repaired.tux --confirm-sensitive --json
npm run cli -- --archive Lesson.tux transcript import --session <uuid> --input lesson.srt
npm run cli -- --archive Lesson.tux transcript search --session <uuid> --query "quadratic formula"
npm run cli -- --archive Lesson.tux transcript generate --session <uuid> --track <track-uuid> --whisper <executable> --model <model-file> --consent-local-audio
npm run cli -- --archive Lesson.tux session export <session-uuid> --output session.tux
npm run cli -- --archive Destination.tux session import session.tux --student-id <student-uuid>
npm run cli -- --archive Lesson.tux transcript export --session <uuid> --output lesson.vtt --format vtt
npm run cli -- --archive Lesson.tux transcript split <cue-uuid> --before "Hello" --after ", world." --at 00:00:02
npm run cli -- --archive Lesson.tux transcript merge <first-cue-uuid> <second-cue-uuid> --separator " "
npm run cli -- --archive Lesson.tux transcript speaker <cue-uuid> --speaker "Tutor"
npm run cli -- --archive Lesson.tux transcript history <cue-uuid> --limit 100
npm run cli -- --archive Lesson.tux annotation add --session <uuid> --type important-concept --at 00:01:20 --text "Scale both parts by the same factor"
npm run cli -- --archive Lesson.tux asset import --input worksheet.pdf --session <uuid>
npm run cli -- --archive Lesson.tux asset import --input recording.webm --session <uuid> --capture-source browser-microphone --consent
npm run cli -- --archive Lesson.tux asset import-folder worksheets --session <uuid>
npm run cli -- --archive Lesson.tux asset list --json
npm run cli -- --archive Lesson.tux asset list --session <uuid> --json
npm run cli -- --archive Lesson.tux asset show <material-uuid> --json
npm run cli -- --archive Lesson.tux asset verify <material-uuid> --json
npm run cli -- --archive Lesson.tux asset export <material-uuid> --output worksheet-copy.pdf
npm run cli -- --archive Lesson.tux asset remove <material-uuid>
npm run cli -- --archive Lesson.tux asset list --include-deleted --json
npm run cli -- --archive Lesson.tux asset restore <material-uuid>
npm run cli -- --archive Lesson.tux asset link <material-uuid> --to annotation --target-id <annotation-uuid>
npm run cli -- --archive Lesson.tux asset unlink <material-uuid> --to transcript --target-id <transcript-segment-uuid>
npm run cli -- --archive Lesson.tux record configure --microphone default --playback default --durability maximum
npm run cli -- --archive Lesson.tux record configure
npm run cli -- --archive Lesson.tux evidence extract --session <uuid>
npm run cli -- --archive Lesson.tux evidence review --session <uuid> --json
npm run cli -- --archive Lesson.tux ai estimate --provider ollama --job <package-job-uuid> --model <model-id> --json
npm run cli -- archive backup Lesson.tux --output Lesson-backup.tux --confirm-sensitive
npm run cli -- archive verify Lesson.tux --json
```

For an encrypted archive, provide its current passphrase with `--passphrase-env NAME`; `archive rename` changes only the archive's display name. `transcript generate` is an alias for `transcript transcribe` and follows the same local executable and audio-consent requirements.

Session deletion first reports a revision-bound scope token, what will move to Trash, and which journal links will be detached. Copy that token into the confirmation command; restore brings the session group and its journal links back together.

New sessions start active and automatically create a dated journal entry. Use `--entry-id` to attach a CLI-created session to an existing journal entry.

Session lists are ordered newest first. Plain output shows each session; `--json` includes its lifecycle state, journal links, recording totals, and transcript cue count.

### CLI live audio recording

The TypeScript CLI records microphone audio and supported system-loopback inputs into an existing session. It runs in the foreground; press Ctrl+C to stop and save. `record configure` stores microphone, playback, and durability preferences in the selected archive. Use `--source both` to save microphone and system audio as separate synchronized tracks. The FFmpeg CLI cannot isolate one application's audio; macOS system loopback is also unavailable on this CLI path. Device selection, platform backends, explicit recording consent, optional local Whisper transcription, and the host-installed FFmpeg requirement are covered in [the recording guide](docs/audio/CLI-LIVE-RECORDING.md).

```sh
npm run cli -- --archive Lesson.tux record start --session <session-uuid> --consent --source microphone
npm run cli -- --archive Lesson.tux record start --session <session-uuid> --consent --source system-audio --playback <loopback-id>
npm run cli -- --archive Lesson.tux record start --session <session-uuid> --consent --source both --microphone <microphone-id> --playback <loopback-id>
```

Inspect FFmpeg-visible audio input candidates without opening an audio stream, and play an archived track through the host's `ffplay` audio output:

```sh
npm run cli -- record test --source microphone
npm run cli -- record test --source both --microphone default --playback default
npm run cli -- --archive Lesson.tux record play --session <session-uuid> --track <track-uuid>
npm run cli -- --archive Lesson.tux record play --session <session-uuid> --start-us 30000000 --duration-us 10000000
```

`record test` is enumeration-only: it never starts capture and does not prove that a stream opens or that playback is routed to a virtual loopback input. `record start` attempts the selected microphone or listed system-loopback source and checkpoints samples in order. `record play` requires the host's FFmpeg distribution to include `ffplay`; it streams the selected archive range directly to the player and leaves the archive unchanged. When a session contains multiple tracks, pass `--track` explicitly.

After installing the npm package, the `tutorux` executable points to the same TypeScript CLI entry point.

## Archive compatibility

The TypeScript archive layer reads and writes the existing v1 header, record frames, primary B+ tree, commit, and locator. It validates lengths and checksums before decoding. A Windows interoperability check has opened a `.tux` file created by the existing C++ binary, and the C++ CLI fully verifies TypeScript-appended, rotated, and sanitized encrypted generations, including credential-inclusive copies. The Solid UI can create and unlock encrypted v1 archives, authenticate their commit, index pages, and manifest, verify encrypted records on read, and append edits as authenticated generations. It can also enable encryption on an open, fully published plaintext archive while preserving its ID and retained record history; save the workspace to write that verified encrypted replacement to disk. Encrypted archive creation is available in the UI and CLI; use `--new-passphrase-env NAME` with `archive init` to create an encrypted archive or `archive encrypt <file.tux>` to encrypt an existing, fully published plaintext archive in place. The CLI stages a replacement, reopens it with the new passphrase, verifies the complete record and revision history, and preserves the archive ID before replacing the source. Encrypted recovery, repair, and compaction are available after unlocking and authenticating the archive. Compaction buffers protected frames, and repair requires a structurally openable archive with a key that authenticates the selected generation. The CLI accepts `--passphrase-env NAME` for encrypted verification and supported record commands. `archive change-passphrase <file.tux> --new-passphrase-env NAME` re-keys the archive after unlocking with the current `--passphrase-env`; it verifies every retained record revision with the fresh data key before atomically replacing the file. Previously saved backup files keep their original passphrase.

`archive recover` first previews a complete unpublished generation after checking its commit chain, index, manifest, and current records. Add `--apply` to atomically publish that generation; incomplete trailing bytes are discarded only after the validation succeeds.

`archive compact` previews and applies an archive rewrite that collapses old generations and rebuilds its index while preserving retained revision history. It supports unlocked encrypted archives and can optionally prune unreferenced asset blobs; the rewritten archive is verified before publication.

`archive repair` creates a separate `.tux` copy from the newest generation that passes full record verification. It can fall back to an earlier published generation when the latest generation has damaged records, compacts the copy, verifies it, and leaves the source untouched. Because the copy contains private student and recording data, the CLI requires `--confirm-sensitive`. Header repair handles supported checksum or magic corruption, and encrypted repair requires unlocking and authenticating the selected generation.

`archive backup` (also available as `archive copy`) writes a byte-for-byte copy of a structurally openable archive, including encrypted archives, to a new destination. It requires `--confirm-sensitive`, preserves the original passphrase and all archive bytes, and refuses to overwrite the source or an existing destination.

`archive sanitize` previews a new `.tux` copy, then requires `--confirm-sensitive` plus the preview's generation, selection fingerprint, output path, and encryption choice before creating it. Student, session, and recording-track filters are supported. Private annotations and generation logs are excluded by default. An encrypted source always produces an encrypted copy; `--include-credentials` can retain existing credential records only from an encrypted source, and credential-inclusive copies also require encrypted output. Supply the destination phrase with `--new-passphrase-env NAME` when confirming; the same option can encrypt a copy of an unencrypted source. Credential-looking values outside credential records are rejected when credential inclusion is requested. The CLI writes bounded archive batches to a private staging file, fully verifies the staged copy, then atomically publishes it. The source stays unchanged, the destination must be new, and unknown extension record types are omitted.

```sh
npm run cli -- archive sanitize Lesson.tux --output Lesson-sanitized.tux --include-students <uuid> --json
npm run cli -- archive sanitize Lesson.tux --output Lesson-sanitized.tux --include-students <uuid> --confirm-sensitive --expected-generation <generation> --expected-selection <sha256> --expected-output Lesson-sanitized.tux --expected-encrypted-output no --json
npm run cli -- --passphrase-env TUTORUX_SOURCE_PASSPHRASE archive sanitize Protected-Lesson.tux --output Protected-sanitized.tux --include-credentials --json
npm run cli -- --passphrase-env TUTORUX_SOURCE_PASSPHRASE archive sanitize Protected-Lesson.tux --output Protected-sanitized.tux --include-credentials --confirm-sensitive --expected-generation <generation> --expected-selection <sha256> --expected-output Protected-sanitized.tux --expected-encrypted-output yes --new-passphrase-env TUTORUX_COPY_PASSPHRASE --json
```

The v1 format description remains at [TUX-FORMAT-V1.md](docs/archive-format/TUX-FORMAT-V1.md). It describes the stable wire format, including behaviors that the rewrite has not implemented yet. Do not treat format documentation as evidence that every listed capability is present in the new application.

## Design and assets

The interface uses the repository’s archival green and warm paper surfaces, responsive workspace navigation, compact command palette, keyboard shortcuts, Noto Sans fonts, `web/assets/tutorux.svg`, and the existing ICO/PNG/ICNS artwork. Tauri uses the operating system’s standard decorated window, native File/Edit/View menus, native file dialogs, single-instance `.tux` launch routing, and existing-window focus while sharing the same SolidJS screens and TypeScript archive code as the browser build.

## License

Tutorux is licensed under GPL-3.0-only. See [LICENSE](LICENSE) and the third-party notices in the existing dependency documentation.
