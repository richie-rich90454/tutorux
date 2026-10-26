> **Migration reference:** This document describes behavior, implementation, or build details from the former C++/Slint application. It remains useful as a porting specification; current TypeScript coverage is tracked in [the feature inventory](../migration/feature-inventory.md). Historical build commands are not the active TypeScript workflow.

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

Microphone and system-audio capture can run as synchronized separate tracks. Microphone input uses
CoreAudio and may prompt for microphone access. On macOS 13 and newer, system audio uses
ScreenCaptureKit and the operating system's system-audio recording permission. `record devices`
lists the `screen-capture-kit` pseudo-device; select it with `--playback screen-capture-kit` (or
leave the system-audio device at its default). The backend captures system audio through Apple's
API and does not require a third-party virtual input driver. System-audio capture is unavailable on
macOS releases older than 13.

Per-application audio capture uses ScreenCaptureKit's app filter on macOS 14 and newer. The app
source list comes from ScreenCaptureKit's currently shareable applications and can prompt for the
operating system's screen and audio capture permission. Each `screencapturekit-app:PID` selection is
checked during preflight and again before streaming. Tutorux records the process ID, application
name, bundle identifier, consent source, and `screencapturekit` backend in the archive. The
existing `screen-capture-kit` device continues to capture system audio. App-filtered audio is
unavailable on macOS 13 and earlier. Start one app with
`record start --session UUID --consent --source application --device screencapturekit-app:PID`, or
pair it with the microphone using `--source both --application ID`.
