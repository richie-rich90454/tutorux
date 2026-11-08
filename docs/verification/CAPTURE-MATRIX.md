# Capture qualification matrix

This matrix records the hardware qualifications for microphone and system-audio capture. Code paths, preflight checks, and failure handling are implemented; each row is completed on real hardware before release claims are made.

## Preflight

1. Open a session and go to Capture.
2. Run the microphone preflight from the capture panel or the diagnostics command.
3. Confirm the device list shows the expected input and system-audio source.
4. Record at least 20 seconds with the microphone, then with system audio enabled.
5. Stop, play the mixer, and confirm both tracks are present.
6. Import a file-based audio fallback and confirm playback.

## Matrix

| Platform | Device or source | Preflight | Microphone track | System track | Mixer | File attachment | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Windows 11 | Built-in microphone | Pending | Pending | Pending | Pending | Pending | Not qualified |
| Windows 11 | USB headset microphone | Pending | Pending | Pending | Pending | Pending | Not qualified |
| Windows 11 | Applications/system audio | Pending | — | Pending | Pending | Pending | Not qualified |
| macOS 14+ | Built-in microphone | Pending | Pending | Pending | Pending | Pending | Not qualified |
| macOS 14+ | ScreenCaptureKit application audio | Pending | — | Pending | Pending | Pending | Not qualified |
| Linux (PipeWire) | PipeWire microphone | Pending | Pending | Pending | Pending | Pending | Not qualified |
| Linux (PipeWire) | PipeWire monitor source | Pending | — | Pending | Pending | Pending | Not qualified |
| iOS | Real device, file attachment | Pending | — | — | — | Pending | Not qualified |
| Android | Real device, file attachment | Pending | — | — | — | Pending | Not qualified |

## Expected failure handling

- Missing microphone permission: a clear permission error, no empty recording saved.
- Removed or changed device during capture: the session recovers to a new device epoch and keeps the recording.
- Unsupported system-audio source: microphone-only recording remains usable.
- Interrupted recording: the stored chunks remain attached to the session; the user can retry.
