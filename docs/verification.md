# Verification status

Last verified: 2026-11-03 · Windows 11 · Node 24 · pnpm 12 · Rust stable

## Scope

Measured coverage applies to every first-party TypeScript module under `frontend/` (`frontend/**/*.ts`, including `frontend/platform/tauri.ts`). Declaration files are the only exclusion. There are no coverage-ignore comments, file exclusions, skipped tests, or test-only production branches.

React-style `.tsx` SolidJS components and `index.html` are presentation code exercised by the Playwright end-to-end suite (`tests/e2e`, 22 tests) and the static Tailwind-class guard. Their rendering branches are not line-measured; this is the one remaining coverage limitation.

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm run typecheck` | pass |
| `pnpm run lint` | pass |
| `pnpm run format:check` | pass |
| `pnpm run test:coverage` | **100% statements, branches, functions, lines** |
| `pnpm exec vitest run` | 111 files, 2127 tests pass |
| `pnpm exec playwright test` | 22 pass |
| `cargo fmt --check` | pass |
| `cargo clippy --all-targets --all-features --locked -D warnings` | pass |
| `cargo test --all-features --locked` | 215 lib + 7 helper pass |
| `node scripts/rust-parity/run.mjs` | 47/47 cases, 218 capabilities, 0 missing |
| `pnpm audit --audit-level high` | no known vulnerabilities |
| `pnpm run build` | pass |
| `pnpm run desktop:build` | MSI, NSIS, portable EXE built |

Coverage totals from the last run: 15,258 statements, 11,446 branches, 1,844 functions, 13,863 lines, all covered. Thresholds are enforced in `vite.config.ts` and CI runs `pnpm run test:coverage`.

## Action traceability

| Area | Primary verification |
| --- | --- |
| Archive create/open/save/reopen, corruption, repair, compaction, encryption/re-key, trash purge, recovery | `tests/frontend/archive/*` (26 files), `archive-fuzz.test.ts` (1,000 mutations + 500 random streams) |
| Archive/CLI contract | `tests/rust-parity/corpus/*`, `src-tauri/src/core/capability/registry.rs`, Rust tests |
| Session and record lifecycle, student progress, guides, journal, evidence | `tests/frontend/domain/{records,session-*,student-progress,guides,evidence,journal-trash}*` |
| Recording state machine, microphone/system audio, waveform, native recovery | `tests/frontend/domain/{synchronized-recording,microphone-recording,native-recording-recovery,waveform-index}*`, `tests/frontend/platform/synchronized-audio*` |
| WAV parsing/recovery, audio mixing, asset streaming | `tests/frontend/domain/{wav,wav-recovery,audio,audio-mix,assets,assets-stream,asset-waveform}*` |
| DOCX/PDF extraction and export | `tests/frontend/domain/{document-text,guide-pdf,guide-export,document-export}*` |
| AI providers, request/response, budgets, cancellation, attachment integrity | `tests/frontend/ai/*` (16 files) |
| Keyboard shortcuts, markdown editing, piece table undo/redo | `tests/frontend/domain/{keyboard-shortcuts,markdown-shortcuts,piece-table}*`, `piece-table.property.test.ts` |
| Desktop adapter (Tauri commands, checkpointing, exports) | `tests/frontend/platform/tauri.test.ts` |
| Browser adapter, audio capture, embedded AI, compressed import | `tests/frontend/platform/*` |
| UI actions, navigation, dialogs, responsive layout, date picker | `tests/e2e/*`, `tests/frontend/tailwind-classes.test.ts` |

## Dead-code removals

Coverage closure required removing branches that could not execute. Each removal relies on an invariant enforced earlier in the same call path; no trust-boundary validation reachable from untrusted archive, document, or provider data was removed (those are covered by fixtures).

Representative removals:

- `archive/archive.ts` — duplicate commit/revision lineage checks in `verifyArchiveHistory` (already enforced by `verifyArchiveFull`), index writer shape checks guaranteed by `encodeIndexPage`, source-wrapper bounds already validated by the composite wrapper, UUID encoding fallbacks for internally generated IDs.
- `archive/format.ts` — LZ4 generation wrap replaced with a monotonic counter; decoder growth check unreachable because callers clamp the target.
- `domain/audio.ts`, `document-text.ts`, `wav.ts` — format switches made exhaustive over validated unions; manual bounds checks replaced with native `DataView` range errors.
- `domain/session-packages.ts`, `student-progress.ts`, `synchronized-recording.ts` — guards that restated an upstream validation on the same data.
- `ai/request.ts`, `replicate.ts`, `response.ts` — provider dispatch converted to maps with the provider validated at the preview boundary; duplicate size checks removed where the same declared sizes were already summed.
- `platform/tauri.ts` — `split(".").at(-1)` fallbacks, which cannot be undefined.

## Defects found and corrected during this pass

1. The manifest-attachment test claimed to exercise metadata without `record_role` but passed the unmodified record array to the snapshot; the modified record is now substituted before the preview, and the fallback branch is genuinely executed.
2. The browser PDF.js branch could not execute under the Node transform because the module-level `let` was constant-folded. The worker source now lives in a small state object, so both the Node legacy build and the browser build are exercised.
3. The PDF page-limit and worker-source branches had no tests; both now have behavioral tests (513-page fixture, browser fixture with a mocked PDF.js module).

## Unverified environment

- macOS and Linux CI jobs were not run locally; only Windows artifacts were built.
- Real microphone, system-audio capture, and Whisper hardware were not exercised; the suites use deterministic browser/device fakes.
- Signing and notarization still require repository secrets; tagged releases fail fast without them.
- `.tsx` rendering branches are covered behaviorally by E2E, not by line coverage.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test:coverage
pnpm exec playwright test
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features --locked
node scripts/rust-parity/run.mjs
```
