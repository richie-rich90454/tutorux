# Tutorux

Tutorux is a local-first tutoring workspace. It keeps student profiles, sessions, and teaching notes in portable `.tux` archives.

The active interface is a static Vite application built with SolidJS and TypeScript 6.0.3. The same frontend runs in a browser and in a thin Tauri 2 desktop shell. The existing green folio palette, Noto Sans typography, Tutorux logo, and favicon artwork are retained.

## Migration status

This repository is in the middle of a full rewrite. The SolidJS interface can create, open, search, save, and verify unencrypted v1 archives; its current record workflows cover students and their session/progress history, sessions, journal entries with collections and tags, session-linked observations, transcript import/review/history/restore/export, timestamped playback from archive-backed audio tracks, archive-backed materials, source-checked evidence review with session graph links, and study-guide drafts from built-in or archive-backed custom templates. Transcript playback reads only the selected audio chunks and loads a bounded excerpt, while retaining support for existing PCM WAV sample formats. WAV files up to 256 MiB can be imported as checksummed archive tracks; adding audio to a session that already contains a track requires an explicit separate-track choice. Full-track WAV exports stream verified PCM chunks and preserve timeline gaps. The transcript view can also capture microphone audio after explicit consent and save it as a session-linked material. Custom guide templates can be created, edited, imported, exported, and restored from Trash in the desktop and browser interfaces. Guide blocks are marked stale automatically when their cited archive sources change. Guides export as Markdown or print-ready HTML. The TypeScript CLI shares the archive engine and supports archive init/info/verify, the student/session/journal lifecycle and progress review, journal collection/tag management and entry links, session state changes and scope-confirmed grouped Trash/restore, annotation CRUD and prioritization, transcript import/search/correction/history/restore/split/merge/review/export, asset import/import-folder/list/show/verify/export/remove/restore and annotation/transcript links, evidence extraction/review/relationships, guide create/edit/review/Markdown export, and template management with import/export.

The TypeScript implementation is **not yet a feature-complete replacement** for the former C++ application. Student profiles, session observations, study guides, and journal collections/tags can be moved to recoverable Trash; session and journal entries can be edited while structured legacy notes remain protected. The CLI requires a revision-bound scope token before deleting a session, moves its linked records into recoverable Trash, and restores the full group later; the desktop UI does not yet expose this workflow. Journal labels can be assigned and filtered, and restoring an archived label restores its prior entry links. Session observations support timestamps, types, priorities, editing, revision history, and restoring an earlier version; the CLI also supports linking, splitting, and merging annotations. Materials can be imported in 8 MiB chunks, linked to a session, deduplicated, previewed for common image/audio/video/text formats, and exported after integrity checks. Transcript cues can link those materials, inspect and restore earlier versions, and be split or merged while preserving their text, time ranges, and links. Large-file streaming, PDF/DOCX text extraction, and broader asset operations remain. Evidence extraction, source review, approval, and graph links are available, while the visual graph, contradiction summaries, evidence editing in Solid, and broader evidence workflows remain. Local Whisper generation/refinement, transcript structural editing, native multitrack/system-audio recording, waveform and mixing tools, generated-guide workflows, PDF/DOCX guide exports, AI providers, archive encryption, archive recovery/compaction/transfer, most CLI commands, and related desktop workflows remain to be ported. The original C++/Slint implementation is retained as a migration reference while those capabilities are unfinished. Do not use the new application as a replacement for existing production workflows that depend on those features.

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
npm run cli -- --archive Lesson.tux student list --json
npm run cli -- --archive Lesson.tux student history <student-uuid> --json
npm run cli -- --archive Lesson.tux student progress <student-uuid> --json
npm run cli -- --archive Lesson.tux student progress-review <student-uuid> --skill "Equivalent fractions" --classification partial-improvement --evidence-ids <evidence-from-session-1>,<evidence-from-session-2> --reviewed-by "Tutor"
npm run cli -- --archive Lesson.tux transcript import --session <uuid> --input lesson.srt
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

After installing the npm package, the `tutorux` executable points to the same TypeScript CLI entry point.

## Archive compatibility

The TypeScript archive layer reads and writes the existing v1 header, record frames, primary B+ tree, commit, and locator. It validates lengths and checksums before decoding. A Windows interoperability check has opened a `.tux` file created by the existing C++ binary. Archive encryption is not implemented in TypeScript yet; encrypted archives remain locked and cannot be modified.

The v1 format description remains at [TUX-FORMAT-V1.md](docs/archive-format/TUX-FORMAT-V1.md). It describes the stable wire format, including behaviors that the rewrite has not implemented yet. Do not treat format documentation as evidence that every listed capability is present in the new application.

## Design and assets

The interface uses the repository’s archival green and warm paper surfaces, responsive workspace navigation, compact command palette, keyboard shortcuts, Noto Sans fonts, `web/assets/tutorux.svg`, and the existing ICO/PNG/ICNS artwork. Tauri uses the operating system’s standard decorated window, native File/Edit/View menus, native file dialogs, and `.tux` launch association while sharing the same SolidJS screens and TypeScript archive code as the browser build.

## License

Tutorux is licensed under GPL-3.0-only. See [LICENSE](LICENSE) and the third-party notices in the existing dependency documentation.
