# Synchronized recording tracks

Tutorux can record microphone input and supported system-audio input simultaneously while keeping
the original streams as separate logical tracks. Each input is initialized before the shared start
gate opens. A failed input releases the gate for the available input, which continues recording
until the user stops it or the configured duration expires.

```text
tutorux --archive Tutorux.tux record start --session SESSION_ID --source both --consent \
    --microphone default --playback MONITOR_ID
```

The recording screen exposes the same three choices: microphone, system audio, or both tracks.
Device IDs are optional for the microphone when the operating system has a default input. A
system-audio monitor must be selected explicitly on Linux and macOS. Windows uses the selected
WASAPI render endpoint in loopback mode.

Track IDs are stored on the session and each track has an archive-backed metadata record with its
source, device, consent label, state, format, counters, and recovery result. Audio chunks remain
independently checksummed and indexed by session and track ID. The session summary reports aggregate
bytes and chunks while retaining the per-track counters and errors. Recovery validates each track
independently and preserves a valid track when its peer is missing or corrupt.

The two operating-system capture streams start from one readiness gate. Their hardware clocks can
drift independently; sample timestamps and discontinuities remain track-local so future playback
alignment does not alter the original audio.
