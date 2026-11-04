# Rust coverage audit

Date: 2026-11-04. Coverage was measured with the installed Rust `llvm-tools` component and the repository test suite; no global tools were installed.

## Method

```powershell
$env:RUSTFLAGS = "-Cinstrument-coverage"
$env:LLVM_PROFILE_FILE = "src-tauri/target/coverage/default-%p-%m.profraw"
cargo test --locked --offline --all-features -j 2 --manifest-path src-tauri/Cargo.toml

$env:LLVM_PROFILE_FILE = "src-tauri/target/coverage/cli-%p-%m.profraw"
cargo build --locked --offline --features cli --bin tutorux-cli -j 2 --manifest-path src-tauri/Cargo.toml
node scripts/rust-parity/run.mjs --no-summary --no-report
```

Profiles were merged with the rustup `llvm-profdata` and reported with `llvm-cov report` over the test executables plus `tutorux-cli.exe`.

## Result

- Rust library tests: **246 pass**.
- Audio-helper tests: **8 pass**.
- CLI parity: **47/47 cases**, **218/218 capabilities**.
- Measured first-party Rust line coverage: **59.83%** (51,243 lines, 20,584 missed); function coverage **54.72%**.

This is not 100% and is not reported as 100%.

## Why the remainder is not reachable in this environment

| Area | Approximate uncovered code | Blocker |
| --- | --- | --- |
| Tauri command wrappers and desktop host lifecycle | 5,000+ lines | Requires an initialized Tauri runtime, application window, webview, or native menu. Launching those is prohibited by the assignment. |
| Native capture backends (WASAPI/CoreAudio/PipeWire, application audio, preflight) | 3,000+ lines | Requires physical audio devices, permissions, and visible platform dialogs. |
| FFmpeg/FFplay process wrappers and native capture workers | 4,000+ lines | Requires external executables or detached processes; unit tests cover argument/timeline/codec helpers only. |
| Live Whisper session/worker and embedded GGUF inference | 2,500+ lines | Requires long-running model sessions or large model assets; the embedded inference smoke test covers initialization/transcription only. |
| GUI-only diagnostic probes and host menus | 1,500+ lines | Requires a desktop window or platform probes. |
| Remaining CLI command error branches | 4,000+ lines | Some are destructive or hardware-bound; the 47-case corpus covers the supported success/error contract, not every defensive branch. |

## Added tests in this pass

- Playback selection across multiple tracks in one session.
- Playback timeline validation, gap handling, microsecond/frame conversion, bounded numeric parsing.
- Audio chunk metadata listing by session/track, sequence ordering, deleted chunks, and invalid identities.
- Mix-source PCM decoding for every supported sample width, chunk-boundary reads, gaps, and clamping.
- Main-window label guard.
- Native limitation message coverage.

## Classification

- **VERIFIED:** all 246 library and 8 helper tests pass; the recording playback and multiple-recording paths added here are covered by Rust tests and Playwright.
- **PARTIAL:** Rust line coverage is 59.83%; reaching 100% is not possible under the no-window/no-hardware rules without replacing native integrations with mocks that would no longer verify the shipped boundary.
- **NOT A BUG CLAIM:** uncovered code is not assumed correct. It is either covered by contract/behavior tests without line instrumentation or explicitly recorded here as unmeasured.
