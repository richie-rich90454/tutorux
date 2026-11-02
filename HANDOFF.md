# Tutorux Tauri migration — Handoff

## Current state

The GUI rewrite is feature-complete. The SolidJS, TypeScript, Tauri, and Rust implementation is the only application in the repository. The retired C++/Slint sources, CMake build, legacy CI workflows, and obsolete documentation have been removed. The in-app command console runs the Rust CLI router in-process.

- Branch: `tauri-rewrite`
- Package manager: pnpm 12 (`pnpm-lock.yaml`)
- Formatter: oxfmt 0.75 (`.oxfmtrc.json`)
- Required TypeScript pin: `6.0.3`
- CLI entry point: `src-tauri/src/bin/tutorux-cli/main.rs`; command modules live in `src-tauri/src/core/cli/`
- Desktop host: `src-tauri/src/`
- Rust package: `src-tauri/Cargo.toml` (desktop binary plus the feature-gated standalone `tutorux-audio-helper`)
- Vendored dependency patches: `src-tauri/vendor/flexaudio-mic`, `src-tauri/vendor/whisper-rs-sys`, and `src-tauri/vendor/whisper-rs`.
- Unit tests: `tests/frontend/`; Playwright: `tests/e2e/`; CLI contract corpus: `tests/rust-parity/`

## Rust core port

- Plan: `RUST-PORT-PLAN.md` (complete for the CLI adapter).
- One Rust core plus two adapters: the standalone `tutorux-cli` binary and the Tauri desktop host. The in-app console calls the Rust command router in-process, so it needs no Node runtime and no extraction.
- The retired TypeScript CLI is gone. Its command surface lives in `src-tauri/src/core/cli/`.
- Contract sources: `tests/rust-parity/` (218 registered capabilities), `tests/frontend/archive/`, `tests/fixtures/encrypted-v1.tux`, the audio fixtures, and `tests/e2e/`.
- Feature parity invariant: every core capability must be reachable from both adapters. No CLI-only or GUI-only features are allowed; the capability registry and adapter coverage tests enforce this.
- The desktop console and the standalone CLI share one command router.

## Completed parity work

### Archive

- Full semantic verification: dangling references, asset manifests and hashes, guide sources, credential placement, overlapping frames, secondary indexes, and revision lineage.
- Credential policy enforced by the writer; encrypted-only credential records.
- Immutable audio-chunk identity and `audio_chunk_index_version` propagation.
- Recovery inspection, missing-locator recovery, tail discard, forward locator scans, and discarded-region repair accounting.
- Compaction rebuilds secondary indexes and preserves opaque/forward-compatible records; applies by default with `--preview`.
- `archive info` metadata and header-only inspection, `archive open` alias, default archive names, and passphrase fallback.

### CLI

- Legacy flat record JSON, session package fields, benchmark scalar types, annotation split output, and document JSON.
- Journal reference-safe group deletion, notes restoration, `--clear-date`, entry defaults, and document `--text` replacement.
- Transcript streaming imports, default track/model resolution, and legacy result fields.
- Asset export overwrite, WAV/waveform JSON reports, native-rate capture metadata, durability policies, incremental Whisper commits, thread defaults, detected language, and live Whisper reuse.
- AI catalog TTL/capabilities, embedded model tests, GGUF inspection, legacy provider JSON, structured output, partial cancellation, error metadata, and imported responses.
- Template overrides, restore-defaults, and text/Markdown imports.

### UI and domain

- Note-block and evidence-edge Trash/restore, legacy session-group recovery, undated journal entries, journal root creation, and journal sort/date/session filters.
- Global quick markers, observation playback from timestamps, and guide section regeneration.
- Unknown guide block preservation, empty-section pruning, session template precedence, custom template names, secondary notes, approved-draft regeneration, image insertion, and export validation.
- Built-in template overrides and legacy section catalogs.
- Native-rate synchronized capture with channel/format metadata, gap and discontinuity markers, compressed desktop import, FFmpeg fallback, continuous cue playback, and waveform cache reuse.
- Multimodal AI attachments, Ollama model listing/reachability checks, and external response import.

## Dependency and build state

- The desktop host and the feature-gated standalone audio helper are one first-party Rust package in `src-tauri`; the vendored `flexaudio-mic` patch keeps Linux on one ALSA sys crate.
- `src-tauri` pins `libc = "0.2.186"` because `flexaudio-os-macos` requires that exact version.
- `src-tauri/Cargo.toml` adds `windows-sys` for native process and memory diagnostics and `dasp_sample` for microphone level conversion.
- `.cargo/config.toml` disables llama.cpp's optional OpenSSL discovery so MSVC does not ingest MSYS2 headers.
- `cargo check --locked --bins` and `cargo test --locked --features cli` are the Rust verification entry points; the CLI parity harness runs after the debug CLI and the audio-helper sidecar are built. `pnpm run desktop:build` produces MSI and NSIS installers containing only `tutorux-desktop.exe`; the desktop process has no runtime extraction, Node dependency, or helper sidecars.
- GGUF inference now runs in the desktop process. The vendored `whisper-rs-sys` prefixes whisper.cpp's `ggml`/`gguf` symbols so whisper.cpp and llama.cpp can link together without the retired `tutorux-embedded-ai` sidecar. The vendored `whisper-rs` binding calls the prefixed log setter.
- The Windows release binary uses the `windows` GUI subsystem, so it launches without an accompanying console window.
- The in-app command console runs in-process in the desktop executable; the standalone CLI is built from `src-tauri` with the `cli` feature.
- Only the system WebView is external. Whisper and GGUF models, FFmpeg, the standalone CLI runtime, and `.tux` archives remain user-supplied.
- macOS/Linux capture permissions, ScreenCaptureKit, PipeWire, real device matrices, DPI, screen-reader review, and installer signing remain release qualification work.

## Verification

Run with pnpm:

```sh
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run test:e2e
pnpm run build
pnpm run build:audio-helper
pnpm run desktop:build
node scripts/collect-release.mjs --check-versions
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo check --locked --manifest-path src-tauri/Cargo.toml --bins
cargo test --locked --manifest-path src-tauri/Cargo.toml --features cli
cargo test --locked --manifest-path src-tauri/Cargo.toml --features audio-helper --bin tutorux-audio-helper
```

Test inventory: `pnpm run test` collects 40 files and 248 tests; `pnpm exec playwright test --list` reports 15 tests in 6 files. CI runs those suites plus the Rust formatting, Clippy, unit, audio-helper, and CLI parity gates. `pnpm run desktop:build` produces MSI and NSIS installers; both contain only `tutorux-desktop.exe`. The release executable is a Windows GUI-subsystem binary and creates no application-data runtime directory. The in-process llama.cpp and whisper.cpp link was verified; real-model inference, live-microphone Whisper, and device matrices remain release qualification work. `pnpm audit` still reports advisories through `node-llama-cpp@3.22.2` -> `simple-git@3.36.0` / `@simple-git/argv-parser`; the suggested fix downgrades to `node-llama-cpp@2.0.0`, which is not acceptable. Track an upstream release instead of forcing an override.

## Commit requirements

One changed file per commit with a detailed Conventional Commit message. Do not group files. Do not push unless separately requested.

## High-value references

- `docs/migration/feature-inventory.md` — completed coverage and remaining release checks
- `docs/ARCHITECTURE.md` — current module boundaries
- `docs/archive-format/TUX-FORMAT-V1.md` — wire format, indexes, locking, and recovery
- `frontend/archive/archive.ts` — archive engine, verification, recovery, and maintenance
- `frontend/main.tsx` — workspace orchestration
- `src-tauri/src/core/cli/` — CLI command families
- `src-tauri/src/platform/` — native capture
- `src-tauri/src/bin/tutorux-audio-helper/` — CLI capture and probing
