# Linux ALSA capture

Linux builds use ALSA's PCM API to record microphone input directly into the selected `.tux`
archive. Tutorux configures signed 16-bit little-endian interleaved PCM, requests a 48 kHz input
rate, and accepts the rate and channel count selected by the device when they remain within the
archive format's supported bounds.

`record devices` lists ALSA PCM input hints and always offers the ALSA `default` endpoint. Select a
device with `record start --device DEVICE_ID --consent`; omitting the device selects `default`.
Capture writes bounded, checksummed chunks to the archive. Pause commits the current chunk before
stopping the PCM stream, resume prepares the stream again, and an ALSA overrun is recorded as a
device discontinuity.

Microphone and system-audio monitor inputs can run as synchronized separate tracks. Select a
machine-specific ALSA loopback or PipeWire monitor explicitly with `--playback DEVICE_ID`; Tutorux
does not guess that an output device is safe to record or capture every application on the system.
Linux builds require ALSA development headers and libraries. Static release builds require the
static ALSA archive and link it into the executable.
