# Tutorux

Tutorux is a local-first tutoring workspace. It keeps student profiles, sessions, and teaching notes in portable `.tux` archives.

The active interface is a static Vite application built with SolidJS and TypeScript 6.0.3. The same frontend runs in a browser and in a thin Tauri 2 desktop shell. The existing green folio palette, Noto Sans typography, Tutorux logo, and favicon artwork are retained.

## Migration status

This repository is in the middle of a full rewrite. The SolidJS interface can create, open, search, save, and verify unencrypted v1 archives. It can also unlock encrypted v1 archives and verify their authenticated records; unlocked encrypted archives accept authenticated edits as new generations. Its current record workflows cover students and their session/progress history, sessions, journal entries with collections and tags, session-linked observations, transcript import/review/history/restore/export, timestamped playback from archive-backed audio tracks, archive-backed materials, source-checked evidence review with session graph links, and study-guide drafts from built-in or archive-backed custom templates. Transcript playback reads only the selected audio chunks and loads a bounded excerpt, while retaining support for existing PCM WAV sample formats. WAV files up to 256 MiB can be imported as checksummed archive tracks; adding audio to a session that already contains a track requires an explicit separate-track choice. The Transcripts view can rename takes and tracks, move a take with its audio into recoverable Trash, and restore the group. Full-track WAV exports stream verified PCM chunks and preserve timeline gaps. The transcript view can also capture microphone audio after explicit consent and save it as a session-linked material. Custom guide templates can be created, edited, imported, exported, and restored from Trash in the desktop and browser interfaces. Guide blocks are marked stale automatically when their cited archive sources change. Guides export as Markdown or print-ready HTML. The TypeScript CLI shares the archive engine and supports archive init/info/verify/recover/compact/repair and reviewed sanitize copies, the student/session/journal lifecycle and progress review, journal collection/tag management and entry links, session note edits, duplication, lifecycle transitions, and scope-confirmed grouped Trash/restore, annotation CRUD and prioritization, transcript import/search/correction/history/restore/split/merge/review/export, asset import/import-folder/list/show/verify/export/remove/restore and annotation/transcript links, evidence extraction/review/relationships, guide create/edit/review/Markdown export, template management with import/export, and recording take list/rename/Trash/restore plus track renaming, and session-package import/export.

The Solid interface and CLI can export a single-session `.tux` package with linked records and omitted student profiles and anonymized session student links, then import it with fresh record IDs and an optional destination learner link. The TypeScript implementation is **not yet a feature-complete replacement** for the former C++ application. Student profiles, session observations, study guides, and journal collections/tags can be moved to recoverable Trash. Session and journal notes use a shared archive-backed editor for typed blocks, retaining stable IDs; unknown legacy block types remain protected. The CLI requires a revision-bound scope token before deleting a session, moves its linked records into recoverable Trash, and restores the full group later. The desktop app previews the related-record counts before moving a session to Trash and restores the group from the shared Trash view. Journal labels can be assigned and filtered, and restoring an archived label restores its prior entry links. Session observations support timestamps, types, priorities, editing, revision history, and restoring an earlier version; the CLI also supports linking, splitting, and merging annotations. Materials can be imported in 8 MiB chunks, linked to a session, deduplicated, previewed for common image/audio/video/text formats, and exported after integrity checks. Transcript cues can link those materials, inspect and restore earlier versions, and be split or merged while preserving their text, time ranges, and links. PDF/DOCX text extraction is available for materials up to 16 MiB, with extracted text capped at 2 MiB; large-file streaming and broader asset operations remain. Evidence extraction, source review, approval, graph links, Solid evidence editing, and recoverable node-plus-edge Trash are available; the visual graph, contradiction summaries, asset-origin workflows, and broader evidence workflows remain. Local Whisper generation/refinement, transcript structural editing, native multitrack/system-audio recording, waveform and mixing tools, the AI CLI, PDF/DOCX guide exports, header repair, encrypted recovery/repair/compaction, and full asset-pruning compaction semantics, most CLI commands, and related desktop workflows remain to be ported. Encrypted CLI commands accept `--passphrase-env NAME` to keep the passphrase out of Tutorux command arguments. The CLI has a preview/apply compactor for unencrypted archives that preserves indexed revisions and payload bytes. The Solid UI can create and unlock encrypted v1 archives using worker-backed Argon2id, authenticates the commit, every index page, and the manifest, verifies encrypted records when read or during full verification, and appends edits as authenticated encrypted generations. Passphrase changes rebuild the archive with a fresh data key, re-encrypt every retained record revision, and remove earlier key envelopes from the new file. They are available in Preferences and the CLI; save the updated workspace to make the new passphrase active on disk. Reviewed sanitized copies can preserve archive encryption and may include existing encrypted credential records after an explicit opt-in. The desktop app can store API keys in the operating system credential store; browser use continues to store keys in encrypted archives. The native transport reads desktop keychain values directly in Rust without returning them to Solid. The original C++/Slint implementation is retained as a migration reference while those capabilities are unfinished. Do not use the new application as a replacement for existing production workflows that depend on those features.

See the [feature inventory](docs/migration/feature-inventory.md) for exact coverage and [architecture](docs/ARCHITECTURE.md) for the current module boundaries.

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
npm run cli -- archive init Lesson.tux --name "Algebra"
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
npm run cli -- --archive Lesson.tux session export <session-uuid> --output session.tux
npm run cli -- --archive Destination.tux session import session.tux --student-id <student-uuid>
npm run cli -- --archive Lesson.tux transcript export --session <uuid> --output lesson.vtt --format vtt
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
npm run cli -- --archive Lesson.tux evidence extract --session <uuid>
npm run cli -- --archive Lesson.tux evidence review --session <uuid> --json
npm run cli -- archive verify Lesson.tux --json
```

Session deletion first reports a revision-bound scope token, what will move to Trash, and which journal links will be detached. Copy that token into the confirmation command; restore brings the session group and its journal links back together.

New sessions start active and automatically create a dated journal entry. Use `--entry-id` to attach a CLI-created session to an existing journal entry.

Session lists are ordered newest first. Plain output shows each session; `--json` includes its lifecycle state, journal links, recording totals, and transcript cue count.

After installing the npm package, the `tutorux` executable points to the same TypeScript CLI entry point.

## Archive compatibility

The TypeScript archive layer reads and writes the existing v1 header, record frames, primary B+ tree, commit, and locator. It validates lengths and checksums before decoding. A Windows interoperability check has opened a `.tux` file created by the existing C++ binary, and the C++ CLI fully verifies TypeScript-appended, rotated, and sanitized encrypted generations, including credential-inclusive copies. The Solid UI can create and unlock encrypted v1 archives, authenticate their commit, index pages, and manifest, verify encrypted records on read, and append edits as authenticated generations. Encrypted archive creation is available in the UI and CLI; use `--new-passphrase-env NAME` with `archive init` to read a new archive passphrase from an environment variable. Encrypted recovery, repair, and compaction remain unsupported. The CLI accepts `--passphrase-env NAME` for encrypted verification and supported record commands. `archive change-passphrase <file.tux> --new-passphrase-env NAME` re-keys the archive after unlocking with the current `--passphrase-env`; it verifies every retained record revision with the fresh data key before atomically replacing the file. Previously saved backup files keep their original passphrase.

`archive recover` first previews a complete unpublished generation after checking its commit chain, index, manifest, and current records. Add `--apply` to atomically publish that generation; incomplete trailing bytes are discarded only after the validation succeeds.

`archive compact` previews a verified, unencrypted archive rewrite that collapses old generations and rebuilds its index while preserving every indexed record revision and stored payload byte. Add `--apply` to atomically replace the archive after checking that its file identity has not changed. It currently keeps all indexed asset blobs, including chunks that the C++ compactor can prune, and is available through the CLI only.

`archive repair` creates a separate `.tux` copy from the newest generation that passes full record verification. It can fall back to an earlier published generation when the latest generation has damaged records, compacts the copy, verifies it, and leaves the source untouched. Because the copy contains private student and recording data, the CLI requires `--confirm-sensitive`. Header repair and repair of encrypted archives remain unsupported.

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
