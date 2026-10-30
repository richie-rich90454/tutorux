# CLI live audio recording

The TypeScript CLI can capture microphone, system-loopback, and application audio into an existing
session in a `.tux` archive. It prefers Tutorux's native audio helper for microphone and system audio,
then falls back to FFmpeg when the helper or selected native endpoint is unavailable. Capture appends
ordered audio checkpoints while recording. Stop a foreground capture with Ctrl+C; detached captures
also support `record status`, `record pause`, `record resume`, and `record stop`. An optional duration
limit is available. Tracks are saved at the source's native sample rate, channel count, and sample format.

`archive unlock <file.tux>` checks an encrypted archive with the passphrase named by
`--passphrase-env`; the CLI verifies it for that command and does not persist an unlocked state.

## Native helper and FFmpeg fallback

The desktop bundle includes Tutorux's native audio helper. For a standalone CLI, build it with
`npm run build:audio-helper` or set `TUTORUX_AUDIO_HELPER` to its executable path. The helper uses
Windows WASAPI, macOS CoreAudio, and Linux PipeWire for native microphone and system-audio capture.
It preserves the selected endpoint's sample rate, channel count, and supported sample format for the archive. Whisper windows are downmixed and resampled to 16 kHz mono only for transcription.

Install FFmpeg for fallback microphone/system-audio capture and for playback. The CLI invokes the
host's FFmpeg executable directly and does not bundle it. The default executable name is `ffmpeg`,
resolved through `PATH`. Use `--ffmpeg <executable>` to select another command or executable path.
The FFmpeg build must include the selected operating system's input backend.

`record import` accepts PCM WAV directly and can decode FLAC, MP3, and M4A with FFmpeg. Decoded
audio is staged in a private temporary directory and removed after the archive import completes. Choose another FFmpeg executable with
`--ffmpeg` when it is not available through `PATH`.

List native inputs, FFmpeg endpoints, and active application audio targets:

```sh
npm run cli -- record devices
npm run cli -- record devices --json
```

`record test` briefly opens the selected input and measures its signal without saving samples:

```sh
npm run cli -- record test --source microphone
npm run cli -- record test --source system-audio --playback <loopback-id>
npm run cli -- record test --source application --application <application-id>
npm run cli -- record test --source both --microphone <microphone-id> --application <application-id>
```

Start a microphone recording for a session in an existing archive:

```sh
npm run cli -- --archive Lesson.tux record start --session <session-uuid> --consent
```

The `record configure` microphone choice is used when `--microphone` or `--device` is omitted.
Native output loopback endpoints can be captured alone or beside the microphone as separate tracks:

```sh
npm run cli -- --archive Lesson.tux record start --session <session-uuid> --consent --source system-audio --playback <loopback-id>
npm run cli -- --archive Lesson.tux record start --session <session-uuid> --consent --source both --microphone <microphone-id> --playback <loopback-id>
```

For both tracks, Tutorux opens separate input streams and commits each track's PCM chunks through the
same ordered archive checkpoint queue. `record configure --playback <id>` supplies the saved
loopback selection when `--playback` is omitted. `--device <id>` is for one source; select both
tracks with `--microphone` and `--playback`. Live Whisper is limited to a single track. Passing
`--input-format pulse|alsa` selects FFmpeg for microphone input instead of the native helper.

The selected archive must already contain the session. To select a device, pass its ID or name from
`record devices` with `--device <id>`. The native helper and FFmpeg entries both show their backend.
The platform capture paths work as follows:

- **Windows:** Native microphone capture uses WASAPI and native system audio uses the selected
  output endpoint's loopback stream. Windows microphone privacy settings must allow microphone
  capture. If native capture is unavailable, FFmpeg DirectShow can record a listed microphone;
  fallback system audio requires a listed Stereo Mix or virtual loopback input with desktop output
  routed to it.
- **macOS:** Native microphone and output-loopback capture use CoreAudio. macOS may ask the terminal
  or application hosting the CLI for microphone access. FFmpeg AVFoundation is available as the
  microphone fallback, but it does not expose system loopback. CoreAudio duplex endpoints are
  omitted from native loopback choices so their microphone input is not mistaken for system output.
  Per-application capture uses ScreenCaptureKit and requires macOS 14 or newer plus Screen & System
  Audio Recording permission.
- **Linux:** Native microphone and loopback capture use PipeWire. System audio must be selected from
  an input exposed as a monitor or loopback source; the helper does not guess which source carries
  playback. FFmpeg can also use PulseAudio/PipeWire Pulse monitor sources. ALSA is available only
  through the FFmpeg microphone fallback and does not identify system playback. `record devices`
  lists endpoints, but only `record test` opens the stream and measures whether audio is present.

Application-specific audio capture uses the native helper: WASAPI process-loopback on Windows,
ScreenCaptureKit on macOS, and PipeWire process-loopback on Linux. Linux ALSA cannot identify audio
by application.

For example, to use an ALSA input on Linux:

```sh
npm run cli -- --archive Lesson.tux record start --session <session-uuid> --consent --input-format alsa --device default
```

## Consent and saved audio

`record start` refuses to begin without `--consent`. This flag records the user's confirmation time,
the selected source and device, the native-helper or FFmpeg capture backend, policy version, and the
confirmation label in the archive. The label defaults to `CLI user`; set it with `--confirmed-by <label>` (up to 256
single-line characters). This stores an acknowledgment and does not determine whether recording is
lawful in a particular place or circumstance.

Recording data is checkpointed into the selected archive while capture runs. A normal Ctrl+C stop
flushes pending audio and saves the recording. If capture or saving fails after samples have been
written, the CLI reports an interrupted recording and keeps the saved checkpoints available for
recovery. Reconcile an interrupted recording with:

```sh
npm run cli -- --archive Lesson.tux record recover --session <session-uuid>
```

`record test` opens the selected input for about 1.8 seconds and reports sample format, rate, channel
count, sample count, RMS, peak, and dBFS. It marks signal as detected when RMS is at least 0.001.
The probe measures audio in memory and does not save a recording. A stream can open successfully
while measuring silence; the host's routing configuration still determines whether a loopback input
receives system playback.

An optional maximum duration can be set with `--duration-seconds <seconds>` (1 second to 7 days).
`record start` accepts `--json` for a machine-readable result.

## Optional live local Whisper

To generate provisional transcript cues as audio is checkpointed, add a local whisper.cpp executable
and model and explicitly consent to processing the captured audio with them:

```sh
npm run cli -- --archive Lesson.tux record start --session <session-uuid> --consent \
  --live-transcribe --whisper <whisper-cli> --model <model-file> --consent-local-audio
```

The executable and model must be regular files. Tutorux invokes the selected executable on bounded
audio windows staged in a temporary directory, then removes those temporary files after each
invocation. Tutorux does not send this recording to a cloud transcription provider; the selected
executable is external software running on the host, so use an executable you trust. Cues are saved
as provisional and require tutor review. If a Whisper invocation fails, reaches its time limit, or
falls more than 8 MiB behind the recording, live transcription stops, recording continues, and the
transcription issue is reported separately. Waiting audio windows are released; audio checkpoints
continue to be saved in the archive.

Live transcription defaults to automatic language detection, five-second windows, and the executable's
default thread count. `--language <auto|code>`, `--window-seconds <1..27>`, and `--threads <1..64>`
are optional. `--diarize` passes whisper.cpp's `-tdrz` option to the selected executable; the build
must support that mode. It produces only speaker-turn boundaries and does not assign tutor or
student identities. Local Whisper processing requires the separate `--consent-local-audio` flag in
addition to recording's `--consent`.
