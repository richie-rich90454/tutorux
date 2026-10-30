# Tutorux Tauri Migration — Detailed Handoff

## Purpose of this handoff

Continue the active full migration of Tutorux from the C++23/Slint application to a native-feeling Tauri desktop application with a SolidJS frontend and a TypeScript CLI. This file is intentionally detailed so the next agent can resume without reconstructing the latest decisions from chat. The authoritative feature-by-feature comparison remains [`docs/migration/feature-inventory.md`](docs/migration/feature-inventory.md); read that before changing a feature area.

The user’s latest instruction was to finish the work already in flight and write this handoff for the next agent. The journal-linked session flow, guide parity work, diagnostics/theme work, Trash purge, and inventory reconciliation are finished in the shared working tree. Do not interpret this as permission to skip the remaining feature gap or the later debug pass.

## User requirements and decisions that carry forward

- Replace the application’s active C++/Slint stack with Tauri and SolidJS. Preserve the existing design language, colors, and favicons, and make the desktop application feel native.
- Ship Windows, macOS, and Linux together. Preserve a usable CLI alongside the desktop application.
- Use current npm dependency versions, with TypeScript fixed at exactly `6.0.3`.
- Prioritize porting all legacy features before debugging individual details. Do not run tests, builds, or typechecks until feature ports are complete; then do one purposeful debug/verification pass and avoid repeated checks without a relevant code change.
- Keep the implementation focused on the legacy behavior. Do not add broader destructive behavior without an explicit baseline match. In particular, Trash purge preserves unreferenced material content; optional asset pruning remains a separately reviewed archive-compaction choice.
- Use parallel subagents when useful, but only `gpt-6-luna` at `xhigh` reasoning. Do not use Terra.
- Commit every changed file separately with a detailed Conventional Commit. Use one PowerShell batch script to stage and commit the full file set; do not issue a long sequence of manual `git add` / `git commit` calls.
- The user asked to avoid premature stopping and unnecessary verification. Make a large, coherent feature slice, finish it, and hand off with exact remaining work.

## Repository and Git state

- Workspace: `C:\Users\rjian\Desktop\tutorux`
- Current branch: `tauri-rewrite`
- Legacy parity baseline selected by the user: commit `7c78774`
- HEAD before the current migration batch: `84ecd05 docs(migration): record the main-content skip link`
- Immediately before preparing this handoff/commit batch, the working tree showed **101 changed paths**: 59 tracked modifications and 42 untracked files. Most changes are from the ongoing migration, not just the latest handoff document. This is a historical snapshot; run `git status --short --untracked-files=all` and `git log -5 --oneline` before staging or assuming the batch is still pending.
- Include `HANDOFF.md` in the same per-file commit batch if the batch has not already been applied. If it has been committed, do not recommit it; commit only changes added after the current batch.
- The sandbox marks the repository’s `.git` directory read-only. The user has already authorized per-file commits, but staging may require one elevated PowerShell execution. If the platform blocks staging, request the required elevation once for the complete prepared batch rather than retrying individual files.
- npm metadata was refreshed with exact dependency versions and TypeScript `6.0.3`. `npm install` reported **three advisories (one high, two critical)**. Do not blindly upgrade or downgrade around them during the feature pass; review the advisory details in the later dependency/debug pass and preserve the TypeScript pin.
- Prior migration notes record a Windows `cargo check` stopping in `llama-cpp-sys-2`’s CMake/MSVC build before the Tutorux crate was checked. Do not repeat the same blocked command without a specific reason or a different strategy.

## Architecture map

- `frontend/`: SolidJS application pages, components, styles, domain workflows, archive format implementation, and browser/desktop platform adapters.
- `src-tauri/`: Tauri host, Rust commands, native audio, native diagnostics, credentials, and platform-specific desktop behavior.
- `cli/`: TypeScript CLI and reusable command/domain workflows. Keep it as a first-class shipped surface.
- `native-archive-lock/`: native cross-process archive lock support shared by host/CLI integrations.
- `native-audio-helper/`: native audio endpoint enumeration, capture, and probe helpers used by CLI and desktop integration.
- `scripts/`: build helpers for native audio and the command-console runtime.
- The Tauri shell already uses standard window decorations, native File/Edit/View menus and accelerators, native file dialogs, `.tux` file association metadata, and single-instance open routing. Preserve these desktop behaviors when changing window or command routing.
- Visual baseline and theme tokens are in `frontend/styles.css` and the feature-specific stylesheets. Tauri packaging retains the repository’s existing logo and ICO/PNG/ICNS icon artwork; do not replace the favicon/icon family as part of unrelated UI work.
- `ui/`, `src/`, `CMakeLists.txt`, and related C++/Slint files are the selected legacy comparison source. Keep them available while finishing parity and review. Remove the retired stack only after feature parity and the acceptance/debug pass are complete, consistent with the migration inventory’s final gate.
- `.github/workflows/tauri-cross-platform.yml`: Windows/macOS/Linux CI matrix. No current local build qualifies all three OSs; CI/package and hardware qualification still matter after feature ports.

## Work already in the shared tree

The migration is broad and already contains much more than this turn’s work. Consult the feature inventory for every row and its current evidence. The following are the latest completed slices and their important implementation points.

### CLI parity and local audio

- The TypeScript CLI has native microphone/system capture support through the native helper, FFmpeg fallback where available, detached recording controls, playback, recovery, separate synchronized tracks, and supported per-application capture. CLI capture writes archive-backed checkpoints rather than requiring the whole recording in memory.
- `record devices` enumerates native, FFmpeg, and supported application endpoints. `record test` opens a short input probe and reports measured signal levels without saving audio. `archive unlock` checks an encrypted archive with an environment-supplied passphrase and does not persist an unlocked state.
- `record import` accepts WAV and can use FFmpeg to decode FLAC, MP3, and M4A through bounded private temporary files. Decoded files are cleaned up, and source identity is rechecked before publication.
- `cli/main.ts`, `cli/live-recording.ts`, `cli/native-audio-helper.ts`, `cli/record-test.ts`, `cli/audio-import.ts`, `cli/record-playback.ts`, `cli/recording-control.ts`, `cli/archive-lock.ts`, and `docs/audio/CLI-LIVE-RECORDING.md` are useful entry points.
- CLI local GGUF inference already uses `node-llama-cpp` when an installed compatible runtime is available; it must not download or build a runtime automatically. `cli/whisper.ts` includes the current transcription helpers.

### Archive lifecycle and locking

- Archive open/read/write/maintenance paths use shared cross-process locking. `native-archive-lock/src/lib.rs` provides OS locking and lifetime ownership; the CLI integration is in `cli/archive-lock.ts`, the Node source adapter is in `frontend/archive/node-source.ts`, and the Tauri integration is in `src-tauri/src/archive_lock.rs`.
- The lock work covers archive path and opened-file handles, coordination around replacement staging/rename, and persistent per-user lock roots. Preserve these semantics for compaction, repair-copy, encryption changes, and save publication.
- The shared archive engine supports verified repair copies, recovery, compaction preview/apply, optional unreferenced-asset pruning, and secondary-index backfill. Compaction and repair paths are in `frontend/archive/archive.ts`, `frontend/ArchiveMaintenance.tsx`, and `cli/main.ts`.

### Recording, transcript, and material parity

- The desktop recorder supports explicit-consent microphone and shared-system-audio capture; independent input selection; bounded, ordered archive checkpoints; per-source failure isolation; pause/resume drain barriers; crash recovery; same-track take resume; and local live Whisper provisional cues after durable audio checkpoints.
- Application audio sources are implemented in the current native desktop path: Windows WASAPI process loopback (Windows build 20348+), macOS ScreenCaptureKit (macOS 14+ and Screen & System Audio Recording permission), and PipeWire process sources on Linux. ALSA alone cannot identify per-application audio sources. Do not change this to a product claim that all operating systems expose identical capture APIs.
- Microphone preflight opens a native CPAL/browser input meter before recording, gates record start until signal is observed, clears consent/selection when the device changes, and gives macOS permission-specific guidance. Relevant paths include `frontend/SynchronizedRecorder.tsx`, `frontend/domain/microphone-recording.ts`, and `src-tauri/src/platform/microphone_preflight.rs`.
- Track-level Trash/Restore now updates the take’s track ordering, session track list, primary-track fallback, waveform metadata, and grouped PCM chunks together. This is implemented in `frontend/domain/recording-takes.ts` and surfaced by `frontend/main.tsx` / `frontend/transcript.css`.
- Audio export presents separate ordinary WAV and gap-filled WAV actions. Ordinary export errors when timeline gaps are present; the gap-filled path explicitly writes silence. Small outputs retain RIFF; outputs beyond 4 GiB use the legacy-compatible RF64 layout. Relevant paths include `frontend/domain/audio.ts`, `frontend/domain/wav.ts`, `frontend/main.tsx`, and `frontend/transcript.css`.
- Material imports use incremental hashing and private staging, provide all/library/session filters, and keep the import destination independent from the current display filter. No legacy multi-select/bulk material actions were identified.

### Journal, sessions, guides, evidence, and Trash

- Journal Connections now filters linked sessions by UTC date, navigates to linked sessions, moves existing sessions into an entry, and creates a session directly in the selected entry. The entry-scoped form passes session mode, capture source, transcription language, guide template, subject/objectives, existing student selection, and optional new student name/grade; the new student and linked session are written together.
- Journal entry deletion checks the legacy relationship blockers (sessions, guides/source citations, materials, and extra notes), rechecks the reviewed state, and moves the entry with its primary notes into one recoverable Trash group. It restores together. Paths: `frontend/JournalRelations.tsx`, `frontend/domain/journal-trash.ts`, `frontend/journal-relations.css`, and `frontend/main.tsx`.
- The guide editor now supports section reorder, guide duplication, active-block body-text find/replace (excluding headings/citation metadata), a source-validation report, insertion of a tutor-authored example after a chosen block, and bounded guide-wide undo/redo with field changes grouped on blur. Paths: `frontend/GuidesPage.tsx`, `frontend/domain/guides.ts`, and `frontend/guides.css`.
- Approved evidence can be rejected to revoke approval through the existing review flow. Transcript candidates remain reviewable and use source-revision checks before approval.
- Solid Trash now previews permanent purge, lists active reference blockers, blocks purge when opaque newer-version records could contain uninspectable references, requires explicit confirmation, strips recovery metadata, removes deleted record revision chains, preserves unreferenced material content, and leaves the replacement snapshot dirty until the user saves. The superseded snapshot is locked after installing the replacement. Paths: `frontend/archive/archive.ts`, `frontend/main.tsx`, `frontend/styles.css`.
- The old CLI has no Trash purge command. Do not add one just to mirror this desktop-only action unless a real legacy CLI command is found.

### Diagnostics, privacy, theme, and inventory

- Tauri diagnostics expose uptime, CPU time, resident and peak memory, and available memory on Windows/macOS/Linux with per-metric error/unavailable reasons. macOS peak RSS uses `getrusage`.
- Audio diagnostic probing is separate opt-in. It opens supported microphone, system-output, and application streams for up to 125 ms each, with at most 12 endpoints total, discards sample buffers, and omits application/device names and PIDs from output. Unsupported probes explain why. Per-app enumeration requires supported Windows/macOS/PipeWire APIs and permissions; Linux ALSA-only systems cannot enumerate app endpoints.
- Preferences can run diagnostics in-app and export a local-only support report. `src-tauri/src/diagnostics.rs`, `src-tauri/src/platform/synchronized_audio.rs`, `frontend/DiagnosticsReport.tsx`, `frontend/diagnostics-report.css`, and the platform bridge types are key paths.
- Appearance is archive-scoped through the `ui.theme` setting and persisted with the archive settings transaction. The portable `system` option follows OS appearance. Browser local storage is only a fallback when the selected archive has no valid theme. Archive create/open/unlock/refresh paths apply the stored setting.
- `docs/migration/feature-inventory.md` was updated for the current ports and stale claims; `docs/ARCHITECTURE.md` also documents diagnostics/platform behavior. Continue correcting this document as actual legacy gaps are confirmed; do not mark rows verified just because implementations exist.

## Confirmed remaining feature work

### 1. CLI native endpoint diagnostics probe

This is the one confirmed actionable feature gap found in the latest bounded source sweep. Legacy `audioDiagnosticRows()` in `src/command/dispatcher.cpp` probes endpoints and returns endpoint format, sample rate, and channel count. The TypeScript implementation in `cli/diagnostics.ts` currently enumerates endpoints and returns `probe_state: "not-probed"` / a message that the CLI did not open a stream. The native desktop probe in `src-tauri/src/diagnostics.rs` and `src-tauri/src/platform/synchronized_audio.rs` is a reference, but the CLI should remain self-contained and report platform/helper limitations.

Suggested implementation sequence:

1. Read the exact legacy endpoint selection and row behavior near `src/command/dispatcher.cpp` lines 12546–12672, along with the complete relevant `cli/diagnostics.ts` functions and `native-audio-helper` CLI protocol.
2. Reuse the native helper path where supported (and its existing FFmpeg/OS fallback policy where appropriate) to query/open each selected endpoint sufficiently to report format/rate/channel results. Preserve clear per-endpoint failure or unsupported reasons. Keep sample data transient; do not persist or send audio.
3. Ensure endpoint names/IDs follow the privacy behavior documented for the desktop support report; do not introduce app names or process IDs into exported diagnostics.
4. Update `cli/main.ts` help and the exact CLI/settings inventory text. Do not run checks until the remaining confirmed ports are closed.

### 2. Legacy transcript cue Trash discrepancy

`ui/panes/transcript-page.slint` exposes a cue-level “Move to Trash” action, but the corresponding legacy C++ dispatcher has no implemented `transcript remove` action. The latest source audit treated that as a baseline inconsistency rather than a confirmed workflow. Do not silently invent semantics; first decide from the rest of the legacy `TranscriptService` whether a safe and intended recoverable deletion exists. If none exists, document why the Solid page does not expose the dead baseline control.

### 3. Broader archive header reconstruction

The inventory records that checksum-confirmed header/magic repair is supported into a verified copy, while broader header reconstruction remains. This is a separate archive maintenance feature area. Inspect the legacy workflow and current CLI/GUI before expanding it; do not weaken archive verification or overwrite protections to make recovery appear broader.

## Deferred debug, verification, and qualification

The feature-first gate remains active. Once the confirmed feature port(s) are complete, use a single planned debug pass; do not repeat the full suite for no reason. The pass should select the narrowest checks that jointly validate the frontend/CLI and Rust/Tauri boundary, then repair failures and rerun only the check affected by a fix.

Areas still needing validation/qualification include:

- npm advisory details and current exact dependency state while preserving TypeScript `6.0.3`.
- TypeScript/unit and CLI behavior for the new paths, including endpoint diagnostic reporting and Trash/purge edge cases.
- Tauri Rust command integration, native audio helper compilation, and Windows packaging.
- Cross-platform CI/package builds and real permission/device qualification on macOS and Linux (especially ScreenCaptureKit and PipeWire); the local environment alone cannot prove all three platforms.
- File association/open-with and single-instance behavior, desktop DPI, keyboard/screen-reader behavior, and the remaining accessibility review.
- Differential compatibility against baseline `7c78774` and real legacy archives, especially recovery, compaction, session packages, and compressed audio.
- The previous Windows `cargo check` was blocked before Tutorux code by the `llama-cpp-sys-2` CMake/MSVC build. Avoid repeating it unchanged; choose a targeted path that checks the native crate without needlessly rebuilding that dependency or report the blocker accurately.

The feature inventory contains prior test/Playwright claims. Those are historical notes from earlier work and should not be presented as a fresh pass of the current dirty tree.

## Commit requirements and sandbox constraint

The user explicitly asked for **one changed file per commit**, with detailed Conventional Commit messages, and one PowerShell batch script to handle each coherent set. Preserve this exactly:

1. The current 101-path worktree snapshot is ready for its own one-file-per-commit batch, including `HANDOFF.md`. Check live Git state first; the batch may already have been applied by the time the next agent resumes.
2. For the next coherent feature/debug slice, finish the feature change, run the requested focused debug checks only after the feature gate closes, fix material findings, then make a new per-file commit batch. Do not group multiple files into one commit.
3. Use one PowerShell script that reads changed paths (including untracked files), stages one path at a time, generates a detailed Conventional Commit subject/body for that specific file, and creates one commit per file.
4. Review the script’s target path and commit list before running. The current sandbox has `.git` read-only, so request one elevated run for the complete batch if needed. The user already authorized the commits; the escalation is an environment write boundary.
5. Confirm the final branch/HEAD and clean status after the batch. Do not push unless separately requested.

Commit messages should name the concrete file behavior, not say only “update file.” For large multi-feature files such as `frontend/main.tsx`, describe the specific workflows changed in the body. Keep generated messages Conventional (`feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`, `chore(deps): ...`, `ci(scope): ...`) and detailed enough to review history without opening every diff.

## Suggested skills for the next agent

- `requesting-code-review` or `code-review` after the feature pass and before the final commit batch, using baseline `7c78774` as the review point.
- `rust-best-practices` when touching the Rust host, audio helpers, OS locks, or platform-specific diagnostics.
- `frontend-design` or `design-taste-frontend` only when changing the Solid UI presentation; retain the established palette and native-app feel.
- `pnpm` is not applicable unless the repository’s package manager changes; the current user decision is npm.

## High-value references

- Full migration status and gap ledger: `docs/migration/feature-inventory.md`
- Product overview and cross-platform workflow: `README.md`
- Architecture and platform boundaries: `docs/ARCHITECTURE.md`
- Legacy feature dispatcher: `src/command/dispatcher.cpp`
- Legacy UI pages: `ui/panes/` and native UI glue: `src/gui/desktop.cpp`
- CLI implementation: `cli/main.ts`, `cli/diagnostics.ts`, `cli/live-recording.ts`, `cli/native-audio-helper.ts`
- Solid application shell and workflows: `frontend/main.tsx`, `frontend/JournalRelations.tsx`, `frontend/GuidesPage.tsx`, `frontend/ArchiveMaintenance.tsx`, `frontend/DiagnosticsReport.tsx`
- Archive and domain logic: `frontend/archive/archive.ts`, `frontend/domain/records.ts`, `frontend/domain/recording-takes.ts`, `frontend/domain/journal-trash.ts`, `frontend/domain/guides.ts`
- Native host and platform audio: `src-tauri/src/main.rs`, `src-tauri/src/diagnostics.rs`, `src-tauri/src/platform/synchronized_audio.rs`, `src-tauri/src/archive_lock.rs`
- Native helpers: `native-archive-lock/`, `native-audio-helper/`
- Exact npm dependencies and TS pin: `package.json`, `package-lock.json`
- Cross-platform workflow: `.github/workflows/tauri-cross-platform.yml`
