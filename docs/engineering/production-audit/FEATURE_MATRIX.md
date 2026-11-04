# Tutorux feature matrix

Last audited: 2026-11-04. Status values: VERIFIED, FIXED, UNVERIFIED, BLOCKED.

| ID | Feature | Primary implementation | Adapter surface | Verification | Status |
| --- | --- | --- | --- | --- | --- |
| ARC-1 | `.tux` create/open/save/reopen/verify | `frontend/archive/*`, `src-tauri/src/core/archive/*` | browser pickers, Tauri archive commands | Vitest archive suites, Rust archive tests, Playwright workspace/archive tests, windowless Rust save flow | VERIFIED |
| ARC-2 | Encryption, passphrase rotation, lock/unlock, sanitize, compact, repair | `core/crypto.rs`, `core/maintenance/*`, `archive/sanitized-copy.ts` | archive UI, CLI, console | Rust maintenance/sanitize tests, Playwright encrypted archive + maintenance tests, CLI parity | VERIFIED |
| ARC-3 | Crash-tail recovery and locator scan | `core/archive/open.rs`, `core/archive/commit.rs` | CLI and desktop | locator boundary regression test, recovery tests, CLI parity | FIXED |
| ARC-4 | Audio placeholder manifests survive compaction | `core/maintenance/retained.rs`, `core/maintenance/rebuild.rs` | recording import, CLI | compaction/prune regression tests | FIXED |
| IPC-1 | Tauri command and event contracts | `src-tauri/src/host.rs`, `frontend/platform/tauri.ts` | all desktop workflows | command/argument comparison, Rust compilation, desktop unit tests | VERIFIED |
| IPC-2 | In-app command console writes to the open archive | `console/*`, `core/cli/archive/save.rs`, `archive_lock_support.rs` | Command console | ambient-lock regression test, CLI parity | FIXED |
| SES-1 | Students, sessions, journal, notes, tags, collections | `frontend/domain/*`, `src-tauri/src/core/cli/records/*` | UI, CLI, console | Vitest domain suites, Playwright lifecycle tests, 47 CLI cases | VERIFIED |
| REC-1 | Microphone/system/application capture | `platform/audio_capture.rs`, `platform/synchronized_audio/*`, `frontend/platform/*` | Record/Transcript UI | Rust capture tests with fakes, Vitest state-machine suites | VERIFIED (deterministic fakes) |
| REC-2 | Full-track transcription and live Whisper | `transcription.rs`, `live_transcription/*`, `WhisperTranscription.tsx` | desktop only | Rust model initialization/transcription tests, Vitest/Wisper unit suites | VERIFIED |
| TRN-1 | Transcript import, correction, split/merge, export | `frontend/domain/transcript.ts`, `audio/transcript-import.ts` | UI and CLI | Vitest transcript/import suites, Playwright audio tests, CLI parity | VERIFIED |
| ASSET-1 | Material import/export/preview/hash verification | `frontend/domain/assets*.ts`, `core/cli/records/assets*` | UI and CLI | Vitest asset suites, Playwright materials test, Rust verification tests | VERIFIED |
| AI-1 | Cloud AI transport, catalog, credentials | `src-tauri/src/ai_transport/*`, `frontend/ai/*` | AI workspace, CLI | Rust HTTP mock tests, Vitest AI suites, Playwright AI workspace tests | VERIFIED |
| AI-2 | Local Ollama and embedded GGUF | `embedded_ai/*`, `frontend/ai/ollama.ts` | AI workspace | Rust GGUF tests, Vitest provider tests, desktop CSP regression | FIXED (CSP) |
| GDE-1 | Guide generation, editing, versions, export | `frontend/domain/guides.ts`, `GuidesPage.tsx`, `core/cli/records/guide_*` | UI and CLI | Vitest guide suites, Playwright guide test, CLI parity | VERIFIED |
| SEC-1 | Save/export path, credential, AI, and executable boundaries | `desktop/{save,export,archive}.rs`, `audio_import.rs`, `credentials.rs`, `ai_transport`, `embedded_ai` | desktop IPC | main-window checks on every sensitive command, extension/startup-dir checks, FFmpeg basename check, Rust tests | FIXED |
| CLI-1 | Standalone CLI and capability registry | `src-tauri/src/bin/tutorux-cli`, `core/capability/*` | CLI and console | 47/47 contract cases, 218 capabilities, 0 missing | VERIFIED |
| WEB-1 | Static browser edition | `frontend/platform/browser.ts`, Vite web build | static hosting | Vitest browser adapter tests, Playwright web suite, `pnpm run build` | VERIFIED |
| PKG-1 | Desktop packaging configuration | `src-tauri/tauri.conf.json`, `scripts/build-desktop.mjs` | Windows/macOS/Linux bundles | MSI, NSIS and portable EXE rebuilt on Windows; configuration inspected | VERIFIED (Windows) |
