# Performance and size budgets

The release contract uses the same reference machine for every measurement.
Refresh the numbers with `tools/Measure-Tutorux.ps1` and `cmake --build <dir>
--target size`.

| Metric | Budget |
|---|---:|
| Cold start to interactive window, empty archive | under 1.2 s |
| Cold start to populated session | under 1.8 s |
| Private memory, empty archive picker | under 45 MB |
| Private memory, 1,000-session archive | under 100 MB |
| Working set, empty archive picker | under 140 MB |
| Application-owned threads | at most 8 |
| First paint after selecting a session | under 80 ms |
| Refresh after a note edit, 1,000 sessions | under 100 ms |
| 10,000-note scroll | virtualized, stable memory |
| Idle CPU | under 1% |
| Base portable executable | under 45 MB |
| Full one-file executable | under 65 MB |

## Current measured profile

- Full single-file Windows build: 56,732,334 bytes (56.7 MB), MinSizeRel, stripped,
  Slint software renderer, no interpreter, no testing backend, no system tray.
- Developer shared build: about 20.7 MB.
- Size gate: `cmake --build build/portable-min --target size` (65 MB limit).

The base profile below 45 MB still depends on optional native packs for PDF,
Whisper, and network providers. Those packs are not yet split out of the
one-file build, so the base budget is tracked as an open item rather than
claimed.

## Threads

The GUI owns one `TaskExecutor` with three workers, plus dedicated playback,
waveform, microphone-preflight, and command workers that are joined when they
complete. Completed threads are never retained in an unbounded vector.
