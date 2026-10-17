# Windows WASAPI capture

`record start --session UUID --consent` captures audio from the default Windows microphone endpoint.
Use `--source system-audio` to capture the default render endpoint through WASAPI loopback, or pass
an endpoint identifier from `record devices` with `--device ID`. `--duration-seconds N` sets an
optional positive duration. `--durability default|maximum|reduced-write` selects the commit
interval. Without a duration, press Ctrl+C to stop a foreground command or add `--detach` to run a
controllable background worker.

The consent flag is required on every capture command. `--confirmed-by LABEL` records the person or
authority that confirmed consent; it defaults to `not-specified` and accepts one line of at most 256
bytes. The session stores the selected source, endpoint identifier, consent time, confirmation label,
consent policy version, audio format, start time, and final state. `record devices` only queries
active MMDevice endpoints and does not open a capture stream.

## Storage and timeline

Capture uses the selected endpoint's shared-mode mix format when it is uncompressed PCM or 32-bit
IEEE float and has 1–8 channels at 8–384 kHz. Unsupported endpoint formats fail before capture
starts. Audio is stored as interleaved frames in raw, independently checksummed archive chunks of
about half a second, capped at 1 MiB. Each chunk and the session progress record are committed in one
archive transaction.

The default interval is 500 ms. Maximum durability commits at 100 ms intervals. Reduced-write mode
uses a 2 s target interval, still capped at 1 MiB per chunk, and prints a warning that recent
uncommitted audio may be lost if power fails.

Chunk `first_sample_index` and timeline fields follow WASAPI device positions. A positive difference
from the prior chunk is recorded in `gap_before_samples`; the missing frames are not fabricated as
silence. A device discontinuity flag or inaccurate timestamp is preserved as
`contains_device_discontinuity`, and the session's `recording_discontinuities` counter is advanced.
The session's `recording_samples` counts stored frames, while `recording_timeline_samples` includes
the final timeline position and any observed gaps.

## Failure handling

If the user stops capture, the final partial chunk is committed before the session is marked
completed. If a stream or archive error occurs, already committed chunks remain available and the
session becomes `interrupted` when it contains audio or `failed` before the first chunk. The returned
error includes the failure; the session counters describe the durable prefix.

After an interrupted capture, `record recover --session UUID` verifies the committed native chunks
and repairs the session's durable counters. A verified incomplete capture stays `interrupted`; valid
chunks are preserved when a later chunk is malformed or corrupt.

## Recording controls

Detached capture records one source per session. The worker owns the archive writer and exposes a
local control endpoint scoped to the archive path and session ID. The endpoint is protected for the
current user and is removed when the worker exits. Any Tutorux process can query or control it:

```text
tutorux --archive Tutorux.tux record start --session UUID --consent --detach
tutorux --archive Tutorux.tux record status --session UUID
tutorux --archive Tutorux.tux record pause --session UUID
tutorux --archive Tutorux.tux record resume --session UUID
tutorux --archive Tutorux.tux record stop --session UUID
```

Pause commits the current partial chunk before stopping the capture stream. Resume excludes paused
wall time from the recording duration and continues the same sample timeline. Stop commits pending
audio and marks the session completed. `record status` without a session lists active recordings
from the selected archive. `record configure` stores microphone and playback endpoint choices and the
durability policy in the selected archive. `record test` confirms that an endpoint is active; stream
initialization is probed without starting a capture. Native capture is currently available only on
Windows; WAV import and the detached-control IPC implementation are portable to supported desktop
builds. Synchronized microphone-plus-system capture is not implemented yet.
