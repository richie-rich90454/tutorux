# Test report

Environment: Windows 11, Node 24, pnpm 12, Rust stable 1.97, Tauri 2. All browser execution used the repository's Playwright-managed headless Chromium, not the user's Chrome profile.

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm run typecheck` | PASS | `tsc` for app and node configs |
| `pnpm run lint` | PASS | ESLint, no warnings |
| `pnpm run format:check` | PASS | oxfmt over 298 files |
| `pnpm test` | PASS | 111 files, 2,130 tests |
| `pnpm run test:coverage` | PASS | 100% statements, branches, functions, lines |
| `pnpm exec playwright test --workers=2` | PASS | 36 tests, headless Chromium |
| `node scripts/e2e-coverage.mjs --check` | PASS | statements 48.72%, branches 35.21%, functions 58.99%, lines 48.92% (floors 48/34/58/48) |
| `cargo fmt --check` | PASS | after formatting |
| `cargo clippy --locked --offline --all-targets --all-features -D warnings` | PASS | no warnings |
| `cargo check --locked --offline --all-features --bins` | PASS | desktop and CLI targets |
| `cargo test --locked --offline --all-features` | PASS | 246 library tests + 8 audio-helper tests, 0 failed |
| Instrumented Rust coverage | PARTIAL | 59.83% lines / 54.72% functions; unreachable host/hardware categories and method are in `RUST-COVERAGE.md` |
| `node scripts/rust-parity/run.mjs` | PASS | 47/47 cases, 218 capabilities, 0 missing |
| `pnpm run build` | PASS | web build |
| `pnpm run build:desktop` | PASS | desktop Vite build |
| `pnpm run desktop:build` | PASS | MSI, NSIS and portable EXE rebuilt on Windows |
| `pnpm audit --audit-level high` | PASS | no known vulnerabilities |
| `pnpm run benchmark:archive` | PASS | 10,000 records: 4,622,032 bytes, 679.23 ms append, 174.48 ms list |
| `cargo audit` | NOT AVAILABLE | `cargo-audit` is not installed; global Rust tool installation is prohibited. An OSV batch scan of all 623 locked crates is recorded in `DEPENDENCY_AUDIT.md`. |

## Failures observed and resolved during the audit

1. `save_as_preserves_a_destination_that_appears_after_validation` failed after the first save-publication change because the new code treated a racing destination as a legitimate existing target. The publication check was narrowed to destinations known at preparation time; the regression now passes.
2. Two new compaction tests initially used incomplete manifest fixtures and failed validation. Fixtures were corrected to match the real empty-manifest shape.
3. The full Playwright suite initially failed 27 tests because the new archive-switch guard treated the open create dialog as an unrelated dialog. The guard now distinguishes the create action from unrelated modal state; the suite passes.
4. One browser transport test expected the CORS message while the test harness fires all timers immediately. Timeout detection now distinguishes an actual abort from an ordinary network failure.

## False positives / invalid assumptions

- The browser test harness stubs `window.setTimeout` to invoke callbacks immediately. That initially made every fetch failure look like a timeout. The product fix distinguishes the abort error from a generic network error; the test assumption was not changed.
- Several `unwrap`/`expect` occurrences in Rust are test code or proven fixed-width invariants and were not treated as defects.
- Diagnostic warnings from Vite about Tailwind sourcemaps are pre-existing build-tool warnings, not application failures.

## Coverage added

- Locator recovery boundary regression.
- Ambient desktop lock reuse for console writes.
- Duplicate BLOB alias compaction.
- Audio placeholder retention during pruning.
- Sanitize multibyte and oversized-count handling.
- Save recovery-copy retention and deleted-destination identity.
- FFmpeg executable-name restriction.
- Fixed-provider port restriction.
- Console recording rejection.
- Desktop export path/extension restrictions (behavioral tests).

## Not established headlessly

- Real capture hardware, permission prompts, device hot-swap behavior.
- macOS/Linux runtime and installer behavior.
- Signed/notarized release publication.
