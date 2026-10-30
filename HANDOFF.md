# Tutorux Tauri migration — Handoff

## Current state

The rewrite is feature-complete. The SolidJS, TypeScript, Tauri, and Rust implementation is the only application in the repository. The retired C++/Slint sources, CMake build, legacy CI workflows, and obsolete documentation have been removed.

- Branch: `tauri-rewrite`
- Package manager: pnpm 12 (`pnpm-lock.yaml`)
- Formatter: oxfmt 0.75 (`.oxfmtrc.json`)
- Required TypeScript pin: `6.0.3`
- CLI entry point: `cli/main.ts`; command modules live in `cli/commands/`
- Desktop host: `src-tauri/src/`
- Native audio helper: `native-audio-helper/src/`

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

- `native-audio-helper` and `src-tauri` share the vendored `flexaudio-mic` patch so Linux resolves one ALSA sys crate.
- `src-tauri` pins `libc = "0.2.186"` because `flexaudio-os-macos` requires that exact version.
- `src-tauri/Cargo.toml` adds `windows-sys` for native process and memory diagnostics.
- The local Windows `cargo check`/desktop build still stops in `llama-cpp-sys-2` when its CMake build uses the Visual Studio 18 2026 generator from the MSYS2 CMake installation. This is a host toolchain mismatch, not a source error. CI must verify the desktop package on all three operating systems.
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
```

Latest passed checks: `pnpm run typecheck`, `pnpm run lint` (0 errors, 46 Solid reactivity warnings), `pnpm run format:check` (oxfmt), `pnpm run test` (39 files, 245 tests), `pnpm exec playwright test` (12/12), and `pnpm run build`. `pnpm audit` still reports advisories through `node-llama-cpp@3.22.2` -> `simple-git@3.36.0` / `@simple-git/argv-parser`; the suggested fix downgrades to `node-llama-cpp@2.0.0`, which is not acceptable. Track an upstream release instead of forcing an override.

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
- `native-audio-helper/src/` — CLI capture and probing
