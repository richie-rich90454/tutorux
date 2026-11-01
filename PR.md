# PR: Stabilize recording, modernize the UI, and ship a one-file Windows build

## Summary

This branch improves the desktop recording and transcription workflow, removes the reported desktop build warnings, splits large frontend code into smaller lazy-loaded chunks, and produces a standalone Windows executable alongside both installer formats. The desktop app now transcribes locally with a multilingual Whisper model embedded in the executable. The Record page has a clearer session-first flow, responsive recording controls, a full-width waveform, and a single in-app path from recording to reviewed transcript cues.

## Changes

### Recording and transcription

- Embedded the multilingual Whisper Base Q5_1 model (59,707,625 bytes) in the Rust desktop executable. It is included in the portable EXE and in both installer packages; desktop transcription does not download or extract a model.
- Replaced the desktop UI's external Whisper executable/model selection with in-process Whisper commands. Full-track and live transcription run offline, keep audio/model data in memory, support cancellation, save bounded windows incrementally, and mark generated cues provisional for review.
- Kept external Whisper executable/model options available to the separate CLI workflows.
- Made recoverable CPAL underrun/overrun and device-change notifications nonfatal so a recoverable callback gap does not stop an otherwise active recording. Device-unavailable errors remain fatal.
- Allowed WebAssembly compilation in the desktop Content Security Policy for the local cryptography runtime while continuing to block general JavaScript `eval`.
- Improved Record page session onboarding and grouping: create or select a session, record or import audio, recover saved takes, play and inspect its waveform, transcribe, then review/export cues. The Record destination is available in primary navigation.
- Corrected the audio-panel grid so waveform and playback controls use the available width rather than collapsing into a narrow card; added a no-horizontal-overflow geometry assertion.

### Interface and frontend build

- Added Tailwind CSS v4 with a Vite plugin and bridged the existing Tutorux theme tokens into Tailwind's theme. Updated the recording and transcription surfaces to use utility classes while preserving the established neutral/teal palette, light/dark themes, and flat backgrounds. No linear, radial, or other gradients remain in application styles.
- Improved responsive layouts and shared page surfaces, navigation, search, forms, and dialogs. Replaced native browser date/select treatments where they leaked inconsistent WebView styling; retained Tutorux-rendered playback controls.
- Configured Rolldown entry-aware splitting and kept the default 500 kB chunk warning threshold. Large page, PDF, and cryptography modules are split or lazy loaded; the desktop build no longer has an oversized application chunk.
- Disabled broken output source maps caused by the Tailwind build transform, reducing release output and removing the `SOURCEMAP_BROKEN` warning.
- Fixed CLI test setup to create temporary test workspaces under the project root so Windows hardlink-based parity cases work.
- Updated stale Playwright navigation selectors to match current Record, More, and archive navigation.

### Rust and packaging

- Restricted `run_command_console` to crate visibility so its `DesktopState` parameter does not leak through a public interface.
- Kept embedded model, transcription windows, and full-track WAV input in memory for the desktop Whisper path. Compressed-audio import uses uniquely named temporary files where FFmpeg requires a file and cleans them up; the desktop app does not create per-operation temporary directories.
- Updated `scripts/collect-release.mjs` to fail clearly when the desktop executable is missing and to copy that executable as `Tutorux_<version>_x64_portable.exe` in addition to collecting installer bundles.
- Documented archive-lock and detached-recording app state, WebView2 runtime requirements, compressed-import scratch files, CLI temp behavior, bundled Whisper licensing/source/hash, and release artifact roles.

## Verification

- `pnpm lint` — passed with no ESLint warnings or errors.
- `pnpm format:check` — passed.
- `pnpm typecheck` — passed.
- `pnpm test` — passed: 40 files and 246 tests.
- `pnpm exec playwright test --workers=1 --reporter=line` — passed: all 13 end-to-end tests, including recording playback and waveform geometry, encrypted archives, session packages, workspace flows, and the WebAssembly CSP check.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1` — passed: 180 tests, including embedded-model initialization/transcription and recoverable audio-capture errors. MSVC emitted one localized informational linker-stdout lint during the test link; the release application build emitted no Rust source warnings.
- `pnpm desktop:build` — passed on Windows. It typechecked and built the frontend, compiled the native desktop app, produced both installer bundles, and collected all three release artifacts. The initial sandboxed package attempt could not resolve GitHub while fetching WiX; the authorized network-enabled rerun completed successfully.

The final Vite desktop build emitted no chunk-size warning. The largest JavaScript chunk was the 431.01 kB PDF vendor chunk (129.98 kB gzip); the largest route chunk was the 167.41 kB transcript page (45.58 kB gzip). The initial UI's largest shared chunk was 151.45 kB. Lazy cryptography vendor chunks were 413.45 kB and 120.70 kB. These are emitted artifact sizes, not startup-time measurements.

## Windows release artifacts

`pnpm desktop:build` produced:

- `release/Tutorux_1.0.0_x64_en-US.msi` — 70,090,752 bytes.
- `release/Tutorux_1.0.0_x64-setup.exe` — 64,693,645 bytes.
- `release/Tutorux_1.0.0_x64_portable.exe` — 94,737,408 bytes, copied from `src-tauri/target/release/tutorux-desktop.exe`.

The portable file is a single desktop executable: its frontend assets and Whisper model are embedded, and it does not self-extract an application/model directory or require companion application files. Windows still needs the system WebView2 runtime. The app may use per-user application state; importing compressed formats uses temporary files directly under the OS temp location and removes them. Recording transcription itself creates no temporary files or directories.

The collected portable EXE matches the built desktop executable (SHA-256 `37b475b0cb17cfe8fb72499107df4d4e24a0dd7fec926697153374334754d67a`). The embedded model SHA-256 is `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`.

The model source and license attribution, size, and SHA-256 are recorded in `resources/whisper/README.md`. GGUF models and FFmpeg remain optional user-provided resources; the separate CLI is not part of the portable executable.
