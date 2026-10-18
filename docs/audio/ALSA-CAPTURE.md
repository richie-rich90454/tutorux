# Linux audio capture

Linux builds use ALSA's PCM API to record microphone input directly into the selected `.tux`
archive. Tutorux configures signed 16-bit little-endian interleaved PCM, requests a 48 kHz input
rate, and accepts the rate and channel count selected by the device when they remain within the
archive format's supported bounds.

`record devices` lists ALSA PCM input hints and the ALSA `default` endpoint. When the optional
PipeWire backend is enabled, it also lists PipeWire microphones, output sink monitors, and active
application output streams. Select an endpoint with `record start --device DEVICE_ID --consent`;
omitting the device selects ALSA `default`. PipeWire IDs use the `pipewire:` prefix and refer to
currently enumerated nodes, so refresh the device list after an endpoint changes. Capture writes
bounded, checksummed chunks to the archive. Pause commits the current chunk before stopping the
stream, and a device overrun or discontinuity remains visible in the recording metadata.

Microphone and system-audio monitor inputs can run as synchronized separate tracks. Select a
machine-specific ALSA loopback or PipeWire sink monitor explicitly with `--playback DEVICE_ID`;
Tutorux does not guess that an output device is safe to record. PipeWire application capture is
available only for active application output streams and never captures every application on the
system. The PipeWire service, session permissions, and an available monitor or application stream
are operating-system prerequisites.

Linux builds require ALSA development headers and libraries. Dynamic builds can enable PipeWire
when `libpipewire-0.3` version 0.3.60 or newer is available. Static builds enable it only when a
static PipeWire client library and its static dependency closure are available; otherwise CMake
reports the omission and retains ALSA support. An ALSA or PipeWire monitor remains a system-mix
source and is never treated as an application source.
