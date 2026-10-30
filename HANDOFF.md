# Tutorux Tauri Migration — Handoff

## Current state

The migration is feature-complete for the confirmed gaps in the previous handoff, and the TypeScript CLI has been modularized. The work was committed as one file per commit; the working tree is clean.

- Branch: `tauri-rewrite`
- Legacy parity baseline: `7c78774`
- Workspace: `C:\Users\rjian\Desktop\tutorux`
- Required npm pin: TypeScript `6.0.3`
- `cli/main.ts` is now a 300-line entry point. Command implementations live in `cli/commands/`, with every module under 500 lines.

Run the live Git state before committing:

```powershell
git status --short --untracked-files=all
git log -5 --oneline
```

## Completed this turn

### 1. CLI native endpoint diagnostics probe

- `native-audio-helper/src/native_input.rs` now includes `sampleFormat`, `sampleRateHz`, and `channelCount` in `inputs` output, read from the endpoint's default stream configuration without opening a stream.
- `cli/diagnostics.ts` now prefers the native helper for `diagnostics audio`, reports `probe_state: "ready"` with format/rate/channels, and falls back to host enumeration with an explicit per-endpoint `unsupported` reason when the helper is unavailable or its build predates these fields.
- Per-application endpoint names and process IDs are not added to diagnostics output. The support report still contains only audio counts and status.
- Verification: `npm run cli -- diagnostics audio --json` reports both microphone and system-audio endpoints as `ready` on this Windows host.

### 2. Legacy transcript cue Trash

- Confirmed the legacy desktop exposes a `remove-segment` callback but the C++ dispatcher implements no transcript remove or recoverable cue-deletion action.
- The Solid page intentionally does not expose a dead control. This is recorded in the transcript row of `docs/migration/feature-inventory.md`.

### 3. Broader archive header reconstruction

- The selected legacy baseline reconstructs only a checksum-damaged header whose remaining fields are intact.
- The TypeScript archive engine already implements that path and adds checksum-confirmed magic repair.
- Broader header reconstruction is not an outstanding legacy behavior; the inventory now states this explicitly. Archive verification and overwrite protections were not weakened.

### 4. CLI modularization

`cli/main.ts` now contains only the help text, IO setup, `executeCli`, and the process entry point. Modules under `cli/commands/`:

| Module | Responsibility |
|---|---|
| `shared.ts` | CLI types, errors, argument parsing, output, option helpers, lock context |
| `record-helpers.ts` | Record lookup, validation, and formatting helpers |
| `archive-io.ts` | Archive opening, mutation, atomic publication, staging |
| `archive-candidate.ts` | Read-only archive discovery and candidate inspection |
| `archive.ts` | Archive dispatcher |
| `archive-crypto.ts` | Init, encryption, passphrase rotation, backup |
| `archive-recovery.ts` | Recover, index backfill, compaction, rebuild, repair |
| `archive-sanitize.ts` | Reviewed sanitized copies |
| `archive-info.ts` | Archive info and verification |
| `runtime.ts` | Router for record/session/journal/AI/content commands |
| `recording-*.ts` | Audio sources, live recording, controls, playback, takes |
| `records-*.ts` | Student, session, progress, lifecycle, journal record actions |
| `ai-*.ts` | AI configuration, transport, package, generation |
| `guides.ts` / `guide-*.ts` | Guide CRUD, editing, inspection, shared helpers |
| `journal*.ts` | Journal documents, search, organizers |
| `transcripts.ts`, `annotations.ts`, `evidence.ts`, `assets.ts` | Content commands |
| `settings.ts`, `templates.ts`, `model.ts`, `diagnostics.ts` | Supporting commands |

Shared behavior was preserved; only imports and module boundaries moved. The refactor also fixed the unreachable `finally` in `publishStagedFileAtomically` and a lock-selection bug where a command-held `NodeFileArchiveSource` was not found during atomic replacement on Windows.

## Dependency repair

`native-audio-helper` previously could not resolve on Linux: `flexaudio-mic 0.8.1` requires `cpal 0.16`, while the helper requires `cpal 0.18`; both link the system ALSA library.

Resolution:

- `native-audio-helper/vendor/flexaudio-mic` vendors the 0.8.1 microphone backend with its `cpal` dependency raised to `0.18`.
- `native-audio-helper/Cargo.toml` patches `flexaudio-mic` to that local crate.
- The vendored backend was adapted to the `cpal 0.18` API (`Error`, `DeviceDescription`, direct `u32` sample rates, by-value stream configs).
- `native_input.rs` was updated for `cpal 0.18` sample-rate and conversion APIs.

Current validation on Windows: `cargo check` and `npm run build:audio-helper` pass. The vendored patch still needs a Linux and macOS build in CI or on real hardware.

## Verification already run

Do not repeat these without a relevant code change.

- `npm run typecheck` — passed both TypeScript projects.
- `npx vitest run` — 27 files, 175 tests passed.
- `npm run lint` — 0 errors; 40 pre-existing Solid reactivity warnings remain.
- `npm run format:check` — passed.
- `cargo check` in `native-audio-helper` — passed with no warnings.
- `npm run build:audio-helper` — release helper built and copied to `src-tauri/binaries`.
- `npm run cli -- diagnostics audio --json` — native probing verified on this Windows host.

## Still outstanding

These are qualification and differential items, not confirmed feature ports:

- Cross-platform CI/package builds and real permission/device qualification on macOS and Linux, especially ScreenCaptureKit, PipeWire, and the vendored `flexaudio-mic` patch.
- Playwright E2E was not rerun after the CLI/UI refactor. Unit, CLI, and type checks passed; the E2E surface still needs one run.
- Real legacy archives from baseline `7c78774` for recovery, compaction, sanitized copies, session packages, and compressed audio.
- File association/open-with, single-instance behavior, desktop DPI, keyboard/screen-reader review.
- npm advisory review; preserve TypeScript `6.0.3`.

## Commit requirements

The user requires one changed file per commit with detailed Conventional Commit messages. Use one PowerShell batch script that stages and commits each path separately. Do not group files. Do not push unless separately requested.

After the batch:

```powershell
git status --short
git log -5 --oneline
```

## High-value references

- `docs/migration/feature-inventory.md` — feature ledger and current gaps
- `cli/main.ts` — entry point only
- `cli/commands/` — command modules
- `cli/diagnostics.ts` — endpoint diagnostics fallback and native probe mapping
- `native-audio-helper/src/native_input.rs` — native endpoint configuration and capture
- `src-tauri/src/diagnostics.rs` — desktop diagnostics reference
- `frontend/archive/archive.ts` — archive engine and header repair
- `frontend/archive/node-source.ts` — active source registry and OS lock ownership
