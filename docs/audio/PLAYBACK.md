# Archive audio playback

Audio playback streams committed PCM chunks directly from the selected `.tux` archive. It reads
only the selected range and does not extract a complete recording to a temporary file.

```text
tutorux --archive Tutorux.tux record play --session SESSION_ID
tutorux --archive Tutorux.tux record play --session SESSION_ID --track TRACK_ID
tutorux --archive Tutorux.tux record play --session SESSION_ID \
    --start-us 42000000 --duration-us 15000000
```

The command selects a track automatically when the session has one track. It requires `--track`
when a session contains multiple tracks. `--start-us` seeks to an absolute position on the selected
track timeline; `--duration-us` limits playback to a range. The equivalent `--start-frame` and
`--duration-frames` options are available when callers already have sample positions. A frame option
and a microsecond option cannot both be supplied for the same value.

Missing audio ranges are emitted as silence during playback and counted in `gap_frames_played` in
the JSON result. The waveform view labels buckets that overlap a missing range. The recording's
archive chunks remain unchanged.

`record waveform` stores a dedicated waveform-index record containing min/max buckets and
progressively coarser pyramid levels. The archive treats it as a derived index, not as an imported
asset. The index is reused while the track's format, chunk count, and timeline length remain
unchanged and the ordered audio chunk revision fingerprint matches. Appending, recovering, or editing
audio causes it to be rebuilt. Compaction preserves the cache without treating it as an asset-blob
reference.

The desktop transcript review can play a 30-second range beginning at the selected segment's
timestamp. Its Stop audio control requests cancellation between native output buffers. The command
line responds to Ctrl+C and returns exit code 130 when interrupted.

Native output uses the default operating-system playback endpoint: ALSA on Linux, Core Audio on
macOS, and WASAPI shared mode on Windows. The WebAssembly build sends PCM to browser Web Audio and
requires a user gesture that permits audio playback. Browser transcript rows expose timestamp
playback and a Stop audio control.
