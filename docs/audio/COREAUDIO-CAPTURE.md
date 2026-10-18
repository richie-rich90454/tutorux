# macOS CoreAudio capture

macOS builds record the selected microphone through an Audio Queue input stream. The callback only
copies bounded sample buffers into a fixed-capacity queue; the capture worker appends checksummed
PCM chunks and recording state to the selected `.tux` archive. The stream uses signed 16-bit
little-endian mono PCM at 48 kHz, and device identifiers are CoreAudio device IDs shown by
`record devices`.

Capture requires explicit consent. Pause commits buffered samples before pausing the input queue,
and resume continues the same archive track. The native CoreAudio frameworks are supplied by
macOS. The static application preset links Tutorux's third-party code statically while using these
operating-system frameworks.

Microphone and system-audio capture can run as synchronized separate tracks. macOS does not expose
a universal output-loopback device, so select an explicitly configured virtual audio input with
`--playback DEVICE_ID`; Tutorux does not select one automatically.
