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
| Portable one-file executable | under 65 MB |
| Full one-file executable, including FFmpeg and llama.cpp | under 125 MB |

## Current measured profile

- Base single-file Windows build: 37,807,879 bytes (37.8 MB), MinSizeRel,
  stripped, Slint software renderer, no PoDoFo, no network transport, no
  Whisper, no interpreter, no testing backend, no system tray.
- Portable single-file Windows build: 62,497,500 bytes (62.5 MB), MinSizeRel, stripped,
  Whisper enabled, compressed audio and embedded llama.cpp disabled.
- Full single-file Windows build: 74,608,161 bytes (74.6 MB), Release, stripped, with FFmpeg,
  Whisper, and llama.cpp statically linked.
- Developer shared build: about 20.7 MB.
- Size gates: `build/base --target size` (45 MB), `build/portable --target size` (65 MB),
  and `build/windows-x64-static --target size` (125 MB). Debug configurations omit release-size
  tests because their unstripped binaries do not represent shipped artifacts.
- Windows network transport: WinHTTP with the platform trust store; no libcurl
  or OpenSSL in the Windows runtime.
- Optional engines: PoDoFo (PDF), WinHTTP (network), and whisper.cpp are
  compile-time profiles. The base excludes them; the full build includes them.

## Threads

The GUI owns one `TaskExecutor` with three workers, plus dedicated playback,
waveform, microphone-preflight, and command workers that are joined when they
complete. Completed threads are never retained in an unbounded vector.
