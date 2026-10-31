# Tutorux Tauri migration — Handoff

## Current state

The rewrite is feature-complete. The SolidJS, TypeScript, Tauri, and Rust implementation is the only application in the repository. The retired C++/Slint sources, CMake build, legacy CI workflows, and obsolete documentation have been removed.

- Branch: `tauri-rewrite`
- Package manager: pnpm 12 (`pnpm-lock.yaml`)
- Formatter: oxfmt 0.75 (`.oxfmtrc.json`)
- Required TypeScript pin: `6.0.3`
- CLI entry point: `cli/main.ts`; command modules live in `cli/commands/`
- Desktop host: `src-tauri/src/`
- Rust package: `src-tauri/Cargo.toml` (desktop binary plus the feature-gated standalone `tutorux-audio-helper`)
- Vendored dependency patches: `src-tauri/vendor/flexaudio-mic`, `src-tauri/vendor/whisper-rs-sys`, and `src-tauri/vendor/whisper-rs`.
- Unit tests: `tests/cli/` and `tests/frontend/`; Playwright: `tests/e2e/`

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
- `cargo check --bins` and `cargo test --bins` pass. `pnpm run desktop:build` produces MSI and NSIS installers containing only `tutorux-desktop.exe`; the desktop process has no runtime extraction, Node dependency, or helper sidecars.
- GGUF inference now runs in the desktop process. The vendored `whisper-rs-sys` prefixes whisper.cpp's `ggml`/`gguf` symbols so whisper.cpp and llama.cpp can link together without the retired `tutorux-embedded-ai` sidecar. The vendored `whisper-rs` binding calls the prefixed log setter.
- The Windows release binary uses the `windows` GUI subsystem, so it launches without an accompanying console window.
- The in-app command console is not part of the desktop executable; the standalone CLI remains available through `pnpm run cli` and `pnpm run build:audio-helper`.
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
cargo check --manifest-path src-tauri/Cargo.toml --bins
cargo test --manifest-path src-tauri/Cargo.toml --bins
```

Latest passed checks: `pnpm run typecheck`, `pnpm run lint` (0 errors, 46 Solid reactivity warnings), `pnpm run format:check` (oxfmt), `pnpm run test` (39 files, 245 tests), `pnpm exec playwright test` (12/12), `pnpm run build`, `cargo check --bins`, `cargo test --bins` (20 desktop tests) plus `cargo test --features audio-helper --bin tutorux-audio-helper` (5 tests), `pnpm run build:audio-helper`, and `pnpm run desktop:build` (MSI 12.1 MiB, NSIS 9.3 MiB). Both installers contain only `tutorux-desktop.exe`; the release executable is a Windows GUI-subsystem binary and creates no application-data runtime directory. The in-process llama.cpp and whisper.cpp link was verified; real-model inference, live-microphone Whisper, and device matrices remain release qualification work. `pnpm audit` still reports advisories through `node-llama-cpp@3.22.2` -> `simple-git@3.36.0` / `@simple-git/argv-parser`; the suggested fix downgrades to `node-llama-cpp@2.0.0`, which is not acceptable. Track an upstream release instead of forcing an override.

## Commit requirements

One changed file per commit with a detailed Conventional Commit message. Do not group files. Do not push unless separately requested.

## High-value references

- `docs/migration/feature-inventory.md` — completed coverage and remaining release checks
- `docs/ARCHITECTURE.md` — current module boundaries
- `docs/archive-format/TUX-FORMAT-V1.md` — wire format, indexes, locking, and recovery
- `frontend/archive/archive.ts` — archive engine, verification, recovery, and maintenance
- `frontend/main.tsx` — workspace orchestration
- `cli/commands/` — CLI command families
- `src-tauri/src/platform/` — native capture
- `src-tauri/src/bin/tutorux-audio-helper/` — CLI capture and probing
