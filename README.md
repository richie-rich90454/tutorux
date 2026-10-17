# Tutorux

Tutorux is a local-first tutoring workspace built around portable, directly mutable `.tux`
archives. The application core and command-line interface are written in C++23. The archive is
the authoritative store for students, sessions, notes, assets, evidence, guides, and settings.

## Build

Tutorux requires CMake 3.25 or newer, a C++23 compiler, libsodium 1.0.22, PoDoFo 1.1.2, and
libcurl 7.85 or newer for verified HTTPS provider requests. Static release builds link libcurl and
its selected TLS and protocol libraries into the executable.

C++ source formatting is defined in [`.clang-format`](.clang-format): 100-column limit, four-space
indentation, spaces only, and LLVM-derived C++ layout rules. JavaScript-specific Oxfmt options such
as arrow-parenthesis and trailing-comma policy do not apply to C++.
Pinned source commits and dependency hashes are recorded in
[`docs/dependencies/DEPENDENCY-PINS.md`](docs/dependencies/DEPENDENCY-PINS.md).

The release presets statically link the selected GUI, PDF, cryptography, and speech dependencies
into the executable. They run a post-link check for unresolved and non-system shared libraries.
Native operating-system libraries, graphics and audio facilities, and device drivers remain
supplied by the operating system. Use the host-specific preset for each target:

```powershell
cmake --preset portable-static-release
cmake --build --preset portable-static-release
ctest --preset portable-static-release
```

On Linux, use `portable-static-linux-release` or `portable-static-linux-debug`; on macOS, use
`portable-static-macos-release` or `portable-static-macos-debug`. These profiles require static
development archives for their third-party dependencies and must be built and qualified on each
target operating system and architecture. See
[`docs/dependencies/PORTABLE-STATIC-BUILDS.md`](docs/dependencies/PORTABLE-STATIC-BUILDS.md) for
the platform inputs and runtime boundary. The Windows UCRT64 package is the only platform package
verified in this workspace. Each preset pins fetched source tags and verifies their commit hashes.
Git and Rust are required for the pinned Slint build.

Install the static release as a self-contained application folder with its required notices and
licenses:

```powershell
cmake --install build-static --config Release --component Runtime --prefix dist/static-release
```

```powershell
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
ctest --test-dir build --output-on-failure
```

For a non-release development build, configure CMake directly. To build the pinned PoDoFo 1.1.2
source instead of using an installed package, add `-DTUTORUX_FETCH_PODOFO=ON`. This disables
PoDoFo's optional AFDKO and TIFF integrations and uses Windows GDI font search on Windows.

The Slint desktop interface is built with -DTUTORUX_BUILD_GUI=ON. To build Slint from its pinned
upstream source release, also pass -DTUTORUX_FETCH_SLINT=ON; this requires network access and
Rust. A preinstalled Slint C++ package can be selected with CMAKE_PREFIX_PATH.

Local speech recognition is optional. Provide a compatible whisper.cpp package and model, then
build with `-DTUTORUX_ENABLE_WHISPER=ON`; use `-DTUTORUX_FETCH_WHISPER=ON` to fetch the pinned
whisper.cpp v1.9.5 source during configuration. Models remain external to the archive. Generate
transcripts with `transcript generate --session UUID --model MODEL.ggml`; `transcript refine`
replaces earlier provisional Whisper output for the selected track and time range while preserving
human-corrected and verified segments. Audio is decoded from checksummed archive chunks in memory.
Select a default model with `model select --provider whisper --model MODEL_ID --path models/MODEL.bin`;
relative model paths are resolved beside the selected archive, and later transcription commands use
that archive selection when `--model` is omitted.

    cmake -S . -B build-gui -DTUTORUX_BUILD_GUI=ON -DTUTORUX_FETCH_SLINT=ON
    cmake --build build-gui --config Release

The current build includes the archive engine, student/session records, transcript import (plain
text, SubRip, and WebVTT) and revision editing, tutor annotations, content-addressed assets, evidence
records, manual and local AI packages, OpenAI-compatible model discovery and streamed generation
for OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together AI, xAI, Cerebras, SambaNova, NVIDIA NIM,
DeepInfra, Moonshot AI, Novita, Nebius AI Studio, SiliconFlow, MiniMax, Alibaba Cloud Model Studio,
custom compatible endpoints, Ollama, LM Studio, and llama.cpp server, plus Hugging Face Inference
Providers and native Anthropic Messages, Gemini GenerateContent, Cohere Chat v2, and Perplexity Agent
API protocols, session transfer archives, archive-backed PCM WAV imports and
recovery, Windows WASAPI microphone and system-audio capture with detached controls, and
PDF/DOCX/Markdown/HTML/JSON study-guide exports. Archive encryption uses libsodium's Argon2id and
XChaCha20-Poly1305 implementations. Other target provider adapters and synchronized multi-track
capture still need dedicated implementations. Commands report unavailable features directly instead
of simulating them.
The Slint workspace includes archive passphrase entry and an asynchronous command console that
dispatches the same archive-scoped CLI operations without invoking a shell.
Asset import uses bounded, immediate-folder reads and records signature-based MIME metadata; imported
content remains opaque and is never executed or automatically extracted.
Recording consent, full-archive copy confirmation, and imported-content handling are described in
[`docs/security/PORTABLE-PRIVACY.md`](docs/security/PORTABLE-PRIVACY.md).
The CTest suite covers archive reopen, immediate-level discovery, large-archive commit-locator
scanning, compaction with retained revisions, WAV import, session transfer, and full integrity
verification.
The static presets reject non-system shared runtime dependencies and install no third-party DLLs.
For a non-static MinGW development build, CMake scans and bundles its non-system DLL dependencies.
The `Runtime` install component creates a deployable folder without Slint's development headers and
libraries:

```powershell
cmake --install build-gui --config Release --component Runtime --prefix dist/tutorux-windows
```

## First commands

```text
tutorux help
tutorux archive discover --directory .
tutorux archive init My-Tutoring.tux --name "My Tutoring"
tutorux --archive My-Tutoring.tux student create --name "Alex" --grade "11"
tutorux --archive My-Tutoring.tux session create --student-id <id> \
  --subject "Honors English" --title "Rhetorical Analysis"
tutorux --archive My-Tutoring.tux annotation add --session <id> \
  --type explicit-instruction --priority high --at 00:16:10 \
  --text "Explain how the choice affects the audience."
```

Use `--json` for machine-readable command results. Read-only help and version commands never
create an archive. Discovery is limited to the selected directory's immediate file level.
The desktop app opens a sole valid archive automatically and leaves archive selection explicit when
multiple candidates are present. When no archive exists, it waits for the user to create one from the
workspace screen. Invalid candidates are never overwritten.

Import an existing uncompressed PCM or IEEE-float WAV recording with
`record import --session UUID --input FILE.wav`. Samples are appended as durable, individually
checksummed audio chunks. `record recover --session UUID` verifies committed chunks after an
interrupted import and marks the session completed only when the expected sample count and bytes are
present.

The no-key external-agent workflow exports a session with `ai package --session UUID --output FILE`
and imports a structured response with `ai import --session UUID --input FILE`. Imports preserve the
original response inside the archive, validate section and block structure plus source references,
and create a proposed guide for tutor review. Tutor instructions and AI recommendations remain
visibly labeled. BYOK requests show their protocol-specific request body, endpoint, and
authentication method before a separate package-hash confirmation. Details are in
[`docs/ai/EXTERNAL-RESPONSE-IMPORT.md`](docs/ai/EXTERNAL-RESPONSE-IMPORT.md) and
[`docs/ai/OPENAI-COMPATIBLE-PROVIDERS.md`](docs/ai/OPENAI-COMPATIBLE-PROVIDERS.md), with native
protocol details in [`docs/ai/NATIVE-PROTOCOLS.md`](docs/ai/NATIVE-PROTOCOLS.md).

On Windows, list active microphone and playback endpoints with `record devices`. Start an explicitly
consented foreground capture with `record start --session UUID --consent`; add `--detach` to run it
as a controllable background worker, then use `record status|pause|resume|stop --session UUID` from
another Tutorux process. Use `--microphone default` to explicitly choose the default microphone,
`--source system-audio` (or
`--system-audio`) to capture the default playback endpoint through WASAPI loopback, `--device ID`
to select an endpoint, `--duration-seconds N` to stop automatically, or
`--durability maximum|reduced-write` to change the default commit interval. Press Ctrl+C to finish
early. `--confirmed-by LABEL` records who confirmed consent (up to 256 bytes; defaults to
`not-specified`). Capture is committed in roughly half-second chunks by default, and WASAPI sample positions
and discontinuity flags are stored so a device gap remains visible in the audio timeline. Reduced-
write mode warns that recent uncommitted audio may be lost after power failure. Pause commits pending
audio and resume continues the same recording timeline. `record configure` saves endpoint choices and
durability settings in the selected archive;
`record test` validates the selected endpoint's shared-mode format and initializes a stream without
starting capture. Other platforms currently support WAV import but do not provide native recording.

Session transfer uses a self-verifying `.tux` package. It includes the session's related records,
their retained revision chains, and referenced asset blobs. Import assigns fresh identifiers and rewrites internal links;
it preserves the source student only when that student already exists in the destination archive.
Otherwise, it assigns the imported session to `anonymous` unless `--student-id` selects an existing
destination student. Export refuses to replace an existing file unless `--force` is supplied.

Full archive backups and copies require `--confirm-sensitive`. They can include student histories,
recordings, private annotations, and credentials; review the destination before confirming. Use
session transfer when only one session should leave the archive.

Enable encryption with `tutorux --passphrase-env TUTORUX_NEW_PASSPHRASE archive encrypt FILE.tux`.
Passphrases are read from environment variables so they do not appear in process arguments. Open an
encrypted archive with `--passphrase-env NAME`; rotate its passphrase with
`--passphrase-env OLD --new-passphrase-env NEW`. The desktop app accepts a passphrase when opening
an archive and keeps it in memory until it is forgotten or the app closes. Sensitive settings can
be stored only by explicitly using `settings set --key KEY --value-env NAME --store-credential`
against an encrypted archive; credential values are omitted from settings list/get results and
command output. `settings credential-list` returns key names without values.

## Archive format

The normative v1 binary format and compatibility rules are documented in
[`docs/archive-format/TUX-FORMAT-V1.md`](docs/archive-format/TUX-FORMAT-V1.md).
Unicode PDF layout and font selection are documented in
[`docs/guides/PDF-EXPORT.md`](docs/guides/PDF-EXPORT.md).
Session packages and WAV chunk import behavior are documented in
[`docs/archive-format/SESSION-PACKAGE-V1.md`](docs/archive-format/SESSION-PACKAGE-V1.md) and
[`docs/audio/WAV-IMPORT.md`](docs/audio/WAV-IMPORT.md).
Windows WASAPI recording behavior is documented in
[`docs/audio/WASAPI-CAPTURE.md`](docs/audio/WASAPI-CAPTURE.md).
Transcript formats, validation limits, and provenance behavior are documented in
[`docs/transcription/TRANSCRIPT-IMPORT.md`](docs/transcription/TRANSCRIPT-IMPORT.md).
Safe asset import behavior is documented in [`docs/assets/ASSET-IMPORT.md`](docs/assets/ASSET-IMPORT.md).
