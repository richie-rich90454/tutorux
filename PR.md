# PR: Complete the Tutorux Tauri rewrite, Rust CLI parity, and production hardening

## Branch and base

- Branch: `tauri-rewrite`
- Base: `main` at `7fbbe9e6bc58ef024eb8da5ccae05166fc62936e`
- Before this final audit update: **2,904 commits**, **1,737 changed paths**, **+508,218 / −115,771** lines.
- This update adds a sequence of **single-file commits** (one file per commit), including this PR description, the code/test fixes, and the production audit records.

## Summary

This branch replaces the retired C++/Slint Tutorux application with a local-first application built from SolidJS, TypeScript, Vite, Tauri 2, and a Rust native core. The same archive engine, domain rules, and UI support both the static browser edition and the Windows/macOS/Linux desktop edition. The branch also ports the command-line surface to Rust, embeds offline Whisper transcription and GGUF inference in the desktop process, completes the recording/transcript/guide/AI workflows, and closes a production audit covering archive integrity, save publication, IPC boundaries, and data-loss paths.

The result is no longer a UI mockup or a partially ported shell. The application opens, edits, verifies, encrypts, repairs, compacts, saves, and reopens `.tux` archives; records and transcribes audio; imports and exports materials and documents; manages students, sessions, journal entries, notes, evidence, and guides; runs AI requests through reviewed native transports; and exposes the same domain capabilities through the standalone CLI and the in-app console.

## Why

The C++/Slint implementation was being retired, but Tutorux needed to retain its product behavior and local-first data guarantees. A browser-first UI alone would lose native file access, capture, offline transcription, and secure credential storage; a native-only rewrite would lose the portable browser edition and shared domain logic. This branch keeps one TypeScript domain/archive implementation, adds a thin platform contract, and places native resources, archive locks, capture, Whisper, and AI transport in Rust.

## Major changes

### 1. Migration foundation and application shell

- Removed the active dependency on the C++/Slint runtime and rebuilt the application around SolidJS, TypeScript, Vite, and Tauri 2.
- Added strict TypeScript configuration, shared formatting/linting, browser E2E harnesses, and cross-platform CI.
- Added the shared workspace shell, sidebar navigation, responsive layouts, command palette, native-feeling controls, date picker, media player, and accessibility states.
- Preserved the Tutorux product identity, icon, local-first behavior, and light/dark appearance system.

### 2. Shared `.tux` archive engine

- Implemented the complete v1 archive format in TypeScript: header, record frames, checksums, LZ4 payloads, index pages, commit roots, locators, and immutable generations.
- Added bounded byte sources, browser/memory/composite/desktop sources, streaming reads, and range validation.
- Implemented create, open, append, save, verify, history verification, repair, recovery, tail discard, compaction, backfill, rebuild, encryption, passphrase rotation, lock/unlock, sanitize, backup, and trash purge.
- Added corruption detection, overlapping-frame rejection, manifest/hash validation, citation validation, credential-placement checks, and recovery of complete unpublished generations.
- Added the Rust core implementation of the same archive and domain rules, used by the CLI and desktop host.

### 3. Domain and workflow parity

- Students, sessions, session lifecycle, cloning, archive visibility, session packages, notes, journal entries, organizers, collections, tags, and Trash/restore.
- Transcript import (text/SRT/VTT), correction, timestamps, speakers, split/merge, history, verification, search, export, and material links.
- Materials import, preview, export, hashing, waveform previews, placement, alias filtering, and Trash/restore.
- Evidence extraction, review, approval/rejection, graph edges, source links, and Trash/restore.
- Study guide templates, generation, editing, regeneration, section/block operations, versions, approvals, exports, and source validation.
- Student progress reviews and version history.
- AI package preparation, context selection, attachments, request confirmation, response import, provider configuration, credential policy, and job history.

### 4. Rust CLI and capability parity

- Added the standalone `tutorux-cli` binary and the in-app console, both using one Rust command router.
- Registered **218 capabilities** across archive, AI, annotations, assets, benchmarks, diagnostics, evidence, guides, journal, models, recordings, sessions, settings, students, templates, and transcripts.
- Added generation-guarded writes, transactional archive replacement, exclusive/shared archive locks, stale-image detection, passphrase safety gates, confirmation gates for destructive operations, and bounded cancellation checks.
- Added 47 golden contract cases covering **218/218 capabilities**, with 215 exercised by the corpus and 3 by cited Rust integration tests.
- Kept feature parity invariant: no CLI-only or GUI-only core capability.

### 5. Desktop host and Tauri integration

- Implemented authorized archive range reads, staged save publication, atomic no-replace moves, recovery copies, destination identity checks, native menus, single-instance `.tux` launch routing, and native export writes.
- Added native dialog/fs/single-instance plugins with least-privilege capability configuration and a Content Security Policy.
- Added main-window checks, path/extension validation, save-kind validation, startup/system-directory blocking, and credential boundaries.
- Added Windows WebView2 compatibility settings, high-DPI-safe layout, and true GUI-subsystem release binaries.
- Added encrypted archive reauthorization, save-conflict recovery, and protection against external in-place modifications.

### 6. Recording, capture, and transcription

- Added microphone, system-audio, and application capture for the desktop host, including WASAPI, CoreAudio, and Linux capture paths where supported.
- Added synchronized multi-track capture with native sample rates, channel counts, sample formats, gaps, discontinuities, pause/resume, checkpoints, and recovery.
- Added WAV import/recovery, streaming WAV/RF64 export, audio mixing, waveform indexing, and bounded preview/playback windows.
- Embedded the multilingual Whisper Base Q5_1 model in the desktop executable and added offline full-track and live transcription without extracting a model or requiring a Node runtime.
- Added provisional cue review, cancellation, incremental commits, cue refinement, and transcript editing.

### 7. AI providers and local inference

- Added reviewed native transports for OpenAI, Anthropic, Google Gemini, Cohere, Perplexity, Replicate, xAI, OpenRouter, Together, Fireworks, DeepInfra, Novita, Nebius, Groq, Cerebras, SambaNova, NVIDIA, DeepSeek, Mistral, Hugging Face, Moonshot, Z.AI, MiniMax, SiliconFlow, Alibaba Cloud, Baidu, Tencent Cloud, Volcengine, Bedrock, Azure OpenAI, Cloudflare Workers AI, AI21, OpenCode Zen, and OpenAI-compatible endpoints.
- Added fixed-host validation, loopback-only local endpoints, redirects disabled, bounded request/response sizes, request hashing and explicit outbound confirmation, and credential zeroization.
- Added Replicate prediction polling/cancellation, OpenAI-compatible streaming, Ollama model discovery, and external AI response import.
- Added in-process GGUF inspection and inference through `llama-cpp-2`, linked with the vendored whisper.cpp symbol namespace.

### 8. Documents, exports, and portability

- Added DOCX/PDF text extraction, DOCX export, PDF export with embedded images, HTML/Markdown/JSON exports, and transcript subtitle/text exports.
- Added browser downloads, File System Access API saves, desktop staged exports, and safe overwrite/recovery behavior.
- Added browser-static and Tauri desktop builds from the same source, with lazy route/vendor splitting and generated asset handling.
- Added portable `.tux` files, session packages, encrypted archives, and sanitized copies.

### 9. UI system, accessibility, and responsive behavior

- Moved component styling to Tailwind v4 utilities declared beside the components; removed the retired component CSS files.
- Added keyboard navigation, focus scoping, modal guardrails, accessible names, reduced-motion handling, screen-reader labels, date-picker semantics, and responsive layouts from phone to desktop widths.
- Added browser/desktop parity for navigation, dialogs, forms, transcript review, materials, guides, AI, archive health, settings, and Trash.
- Added visual regression/behavioral E2E coverage for width overflow, block action fit, empty states, dialogs, and primary-action inventories.

### 10. Production audit and reliability fixes

The 2026-11-04 audit is recorded in `docs/engineering/production-audit/`. It produced **26 confirmed findings**, all corrected:

- Archive recovery now finds locators straddling scan boundaries, so a crash tail cannot make the newest committed generation disappear.
- Compaction and encryption accept duplicate content-hash aliases used by audio placeholder manifests.
- Pruning retains placeholder blobs referenced by audio tracks and takes.
- Sanitized-copy guide parsing rejects oversized counts and cannot panic on a multibyte character boundary.
- The in-app console reuses the desktop archive lease instead of failing every write with `archive_locked`.
- Failed saves preserve the only recovery copy instead of deleting it.
- Deleted destinations and stale authorization tokens no longer block Save As or create false external-change conflicts.
- Crafted generation/revision values cannot overflow into panics or silently skip a commit.
- CLI writes revalidate the loaded archive image, so same-size in-place external changes are not silently overwritten.
- Fixed AI provider hosts reject non-default ports; custom OpenAI-compatible endpoints cannot use another provider's keychain key.
- The desktop CSP permits local Ollama discovery while preserving the strict remote-host allowlist.
- Save/export commands require the main window, restrict export file types, and reject system/startup destinations; FFmpeg must be named `ffmpeg`.
- Opening or creating another archive is refused while work is unsaved, a guide editor is open, or a dialog is open; accepted switches clear transient dialogs.
- Background recording/transcription checkpoints no longer close unrelated forms.
- Save completion cannot replace a newer workspace snapshot and mark newer work clean.
- “Save a copy” now performs Save As instead of overwriting the current archive.
- Locking an encrypted archive removes all record-derived state, including settings and AI jobs.
- Editing text alone keeps an untimestamped transcript cue untimestamped.
- Sanitized-copy selections survive snapshot updates and are pruned only when records disappear.
- Session-package cleanup cannot leave the UI permanently busy.
- AI response import preserves the detected template when “Auto” is selected.
- Browser AI errors distinguish timeout, offline, and CORS failures.
- The native recovery button is reactively disabled during browser capture.
- Console recording no longer launches the GUI instead of a worker; users are directed to the Record workspace.
- The pending single-instance launch queue is bounded.
- Asset verification enforces the 256 MiB material cap and duplicate BLOB aliases; the remaining memory ceiling is documented.

## Verification

All commands were run against the final working tree unless marked otherwise.

| Command | Result |
| --- | --- |
| `pnpm run typecheck` | PASS |
| `pnpm run lint` | PASS |
| `pnpm run format:check` | PASS |
| `pnpm run test:coverage` | PASS — **100% statements, branches, functions, lines**; 111 files, 2,130 tests |
| `pnpm exec playwright test --workers=2` | PASS — 35 tests, headless Chromium |
| `node scripts/e2e-coverage.mjs --check` | PASS — 48.57% statements / 35.13% branches / 58.79% functions / 48.80% lines |
| `cargo fmt --check` | PASS |
| `cargo clippy --locked --offline --all-targets --all-features -D warnings` | PASS |
| `cargo check --locked --offline --all-features --bins` | PASS |
| `cargo test --locked --offline --all-features` | PASS — 234 library tests + 8 audio-helper tests |
| `node scripts/rust-parity/run.mjs` | PASS — 47/47 cases, 218 capabilities, 0 missing |
| `pnpm run build` | PASS |
| `pnpm run build:desktop` | PASS |
| `pnpm run desktop:build` | PASS — MSI, NSIS and portable EXE rebuilt |
| `pnpm audit --audit-level high` | PASS — no known vulnerabilities |
| `pnpm run benchmark:archive` | PASS — 4,622,032 bytes, 679.23 ms append, 174.48 ms list for 10,000 records |

Regression coverage added in this audit includes locator-boundary recovery, ambient console locking, duplicate BLOB aliases, audio placeholder retention, sanitizer malformed input, save recovery-copy retention, deleted-destination identity, FFmpeg naming, provider ports, console recording rejection, unsaved-archive switching, and browser AI error classification.

## Release artifacts

`release/` contains Windows artifacts rebuilt from the audited tree:

- `Tutorux_1.0.0_x64_en-US.msi` — 70,189,056 bytes
- `Tutorux_1.0.0_x64-setup.exe` — 64,784,923 bytes
- `Tutorux_1.0.0_x64_portable.exe` — 95,105,024 bytes
- MSI SHA-256: `CB243B1034E9AB68BD5C0411A8C9E0CBB3FD5F7DD80D16AFD4A6D96ECDF94B02`
- NSIS SHA-256: `A91804747CE89D5A244A497686023ACD5D3D93E15D0829AB703671B8729EFE14`
- Portable SHA-256: `D32379C63CD03CEBFE082C0F4858E84370AB3410D2792AED1B50B9079E1B80B5`

The embedded Whisper model is `resources/whisper/ggml-base-q5_1.bin`, SHA-256 `422F1AE452ADE6F30A004D7E5C6A43195E4433BC370BF23FAC9CC591F01A8898`.

## Known limitations and remaining qualification work

- Real microphone, system-audio, application-capture, and device-matrix behavior was not exercised on physical hardware in this audit; deterministic fakes cover the state machines and native probe logic.
- macOS and Linux runtime behavior was not executed on this Windows host. Their platform-specific code compiles through shared Rust targets, but runtime qualification remains. Cross-platform installers are produced by CI, not this host.
- ScreenCaptureKit, PipeWire/ALSA, CoreAudio permissions, DPI, screen-reader review, and signed/notarized installers remain release qualification work.
- Registry CVE auditing beyond `pnpm audit` was not performed because `cargo-audit` is not installed and global tool installation is prohibited.
- Security residual: the in-app console intentionally exposes the CLI command surface, and desktop commands are callable by the main renderer. No XSS or remote-script path was found; every sensitive command validates the main window and file boundaries. A fully compromised renderer remains a trust boundary equal to the application process.
- The 2026-11-04 benchmark is a single non-warmed Windows sample: 10,000 records, 4,622,032-byte archive, 679.23 ms append, 174.48 ms list, 152,084,480-byte RSS delta. It is directional, not a cross-platform memory budget.
- Coverage thresholds are 100% for Vitest logic modules and a ratchet for browser E2E; `.tsx` rendering branches remain behaviorally covered rather than line-covered.

## Commit structure

Every changed file in this update is committed separately, as requested. The final branch contains the 2,904 migration commits plus the single-file audit/PR commits. No release was published, no remote was modified, and no user data or external service was touched.

## Review focus

1. Archive recovery and compaction semantics (`src-tauri/src/core/archive/open.rs`, `commit.rs`, `maintenance/*`).
2. Save publication and lock reentrancy (`desktop/save.rs`, `desktop/archive.rs`, `archive_lock_support.rs`, `console/session.rs`).
3. Archive-switch/save/dialog state transitions (`frontend/main.tsx`).
4. Desktop IPC and path boundaries (`desktop/*`, `audio_import.rs`, `tauri.conf.json`).
5. AI host/endpoint and credential rules (`ai_transport/validation.rs`, `core/cli/misc/ai/archive.rs`).
6. Sanitized-copy privacy behavior (`frontend/SanitizedCopy.tsx`).
