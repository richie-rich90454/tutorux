# Synchronized recording tracks

Tutorux can record microphone input and supported system-audio input simultaneously while keeping
the original streams as separate logical tracks. Each input is initialized before the shared start
gate opens. A failed input releases the gate for the available input, which continues recording
until the user stops it or the configured duration expires.

```text
tutorux --archive Tutorux.tux record start --session SESSION_ID --source both --consent \
    --microphone default --playback MONITOR_ID
```

Choose a visible application as the second track with `--application APP_DEVICE_ID` instead of
`--playback MONITOR_ID`. A single application track uses
`--source application --device APP_DEVICE_ID`. `record devices` lists the available application
IDs on supported native platforms.

The recording screen exposes microphone, system audio, or a selected application audio source.
Synchronized capture can retain microphone audio with either a system-audio or application-audio
track.
Device IDs are optional for the microphone when the operating system has a default input. Linux
requires an explicitly selected ALSA/PipeWire monitor for system audio. macOS 13 and newer exposes
ScreenCaptureKit as the `screen-capture-kit` system-audio device and requests the operating-system
permission. Windows uses the selected WASAPI render endpoint in loopback mode.

Track IDs are stored on the session and each track has an archive-backed metadata record with its
source, device, consent label, state, format, counters, and recovery result. Audio chunks remain
independently checksummed and indexed by session and track ID. The session summary reports aggregate
bytes and chunks while retaining the per-track counters and errors. Recovery validates each track
independently and preserves a valid track when its peer is missing or corrupt.

The two operating-system capture streams start from one readiness gate. Their hardware clocks can
drift independently; sample timestamps and discontinuities remain track-local so future playback
alignment does not alter the original audio.
