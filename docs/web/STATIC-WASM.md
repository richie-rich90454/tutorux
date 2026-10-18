# Static WebAssembly edition

Tutorux Web is a static HTML, CSS, TypeScript, and generated JavaScript application. It sends
argument arrays to the C++ command dispatcher inside a WebAssembly worker. Commands do not invoke a
shell, and archive work does not block the page's main thread. The browser edition needs no Tutorux
server or hosted AI proxy.

## Build and publish

Install the Emscripten SDK and TypeScript compiler (`tsc`), build a static libsodium 1.0.22 for the
Emscripten target with the pinned upstream recipe, and set `EMSDK` and `TUTORUX_SODIUM_PREFIX`:

```sh
git clone --depth 1 --branch 1.0.22-RELEASE https://github.com/jedisct1/libsodium.git
cd libsodium
./dist-build/emscripten.sh --standard
export TUTORUX_SODIUM_PREFIX="$PWD/libsodium-js"
```

The archive encryption format uses libsodium; its static archive is linked into the generated
WebAssembly module. Then build and install the browser component:

```sh
cmake --preset portable-wasm-release
cmake --build --preset portable-wasm-release
cmake --install build/wasm --component WebRuntime --prefix dist/tutorux-web
```

Publish the contents of `dist/tutorux-web/web` as a static site. GitHub Pages and other static hosts
must serve the generated JavaScript and WebAssembly files beside the page. The service worker caches
the application shell for offline launch. A secure origin is required for service workers and
browser file handles.

## Portable archive workflow

The browser edition opens and creates the same `.tux` archive format as the C++ command engine. It
does not create a separate browser database of students, sessions, notes, transcripts, or guides.
Journal entries, student profiles, tutoring sessions, notes, transcripts, and guides go through the
shared command dispatcher and are committed to the selected archive in the WebAssembly filesystem.
The browser API is a thin transport over those commands; it does not define a second data model or
archive format.

When a browser supports the File System Access API, opening a selected archive retains its file
handle and Save archive writes the changed bytes back to that file. Other browsers use a file input
for opening and download the archive when the user selects Save archive. A newly created archive
can also be downloaded immediately.

For recovery, the browser stores a complete `.tux` snapshot in IndexedDB, keyed by the archive UUID,
and remembers the last active snapshot. Tutorux updates it after archive commands and attempts to
restore it on the next launch. Each worker serializes commands; browsers with the Web Locks API also
serialize access across tabs and reload the latest committed snapshot before each command. The page
shows when this browser copy was restored or updated and provides a separate Download recovery copy
action. Browser-managed storage can be cleared or evicted, even when the browser grants
persistent-storage permission. IndexedDB is a recovery aid; a downloaded `.tux` file is the
independent portable copy. If a retained archive cannot be opened, Tutorux leaves the entry in place
and offers the original bytes for download.

The appearance control follows the operating-system theme until the tutor chooses light or dark. A
chosen theme is saved as the archive-specific `ui.theme` setting; without an open archive, the
choice applies for the current page session only. Tutorux does not keep a global appearance setting.

When recovery inspection finds bytes after the latest committed generation, the browser shows the
committed generation, trailing byte count, candidate generation, and verification issues. Editing is
disabled until the tutor publishes a fully verified unpublished generation or explicitly discards
the incomplete tail. Encrypted candidates are verified only after the archive passphrase is supplied.
Inspection does not change archive bytes, and the browser keeps the resulting archive snapshot in
IndexedDB after an explicit recovery action.

Archive contents are loaded into the browser's WebAssembly filesystem and browser storage. The web
edition therefore depends on available memory and origin storage quota; very large archives may
exceed browser limits. The current browser file imports limit each transcript, WAV recording, or
asset file to 64 MiB to bound temporary memory use. Live microphone capture writes short WAV
segments in the worker and imports each segment into the active session as a separate
archive-native audio track. Native archive workflows do not use this browser-specific import limit.

Document text extraction uses the shared bounds described in [Safe asset import](../assets/ASSET-IMPORT.md).
DOCX text is extracted in the WebAssembly build. That build does not include the native PDF parser:
PDF bytes are still imported, and the asset metadata reports `text_extraction_status` as
`extractor-unavailable` when the file is within the extraction input limit. PDF preview remains a
separate browser feature. Files beyond the shared input limit report `size-limit`.

## Browser workflows

The static page currently provides these archive-backed workflows:

- Create, open, save, download, and recover a portable `.tux` archive.
- Follow the operating-system light or dark theme, or save an archive-specific appearance choice.
- Create student profiles and sessions, select a session, and edit its title and subject.
- Browse journal entries newest first, create and edit entries, filter them through the shared
  journal commands, and open an entry with its associated sessions.
- Create a notes-only, audio-recording, or imported-recording session for an entry, then review its
  chronological session timeline and lifecycle state.
- Add, edit, prioritize, and timestamp tutor notes and lesson markers.
- Import plain text, SRT, or WebVTT transcript files; correct segment text and timestamps; and
  download transcript exports in plain text, SRT, WebVTT, or JSON.
- Send one explicitly selected audio upload to a user-configured OpenAI-compatible transcription
  endpoint, review its timestamped provisional segments, and import them into the selected session.
- Capture microphone audio in secure browsers with explicit permission and commit it as a sequence
  of individually identifiable audio tracks in the selected session.
- Import session files and media, list them, verify content hashes, and download extracted copies.
- Drop lesson files anywhere in the page to add them to the open archive; files link to the selected
  session when one is active, and each failed file is reported separately.
- Create and download a manual AI handoff package in Markdown, JSON, multipart text, or ZIP, then import an external
  JSON guide response as a proposed guide for tutor review.
- Generate a guide draft from archived session evidence, edit its title and blocks, add
  tutor-written sections, inspect source IDs, validate through approval, and download Markdown,
  HTML, PDF, or DOCX exports.
- Run shared CLI commands from the command console without invoking a shell.

Transcript, WAV recording, and asset imports pass user-selected files through the WebAssembly worker
to the shared C++ import commands. Browser microphone capture uses AudioWorklet PCM blocks, requires
a secure origin and explicit permission confirmation, and checkpoints a new archive-native audio
track every 20 seconds. A seven-second pending-PCM limit stops capture if archive persistence falls
behind. Each completed segment is imported and removed from temporary worker storage before capture
continues; stopping capture imports the remaining segment. A tab or worker crash can still lose the
current segment and queued blocks, bounded to roughly 27 seconds at the configured checkpoint and
backlog limits. If a segment cannot be committed, Tutorux downloads a WAV recovery copy or retains
the WAV in page memory for the explicit recovery download action. Keep the page open during capture
and download the archive for an independent backup. System-audio capture and background recording
are unavailable. User-selected transcript, WAV, asset, and remote transcription files remain
limited to 64 MiB each;
external AI response files are limited to 16 MiB. Browser-side local model provisioning is
unavailable. Transcript editing works for transcript segments already in the archive or imported
from supported text formats.

The manual AI package is stored as an archive job and downloaded for use with an external agent.
ZIP packages contain verified session asset bytes; large ZIP handoffs use ordered UTF-8-safe JSON
parts. Importing a JSON response stores the original response and a proposed guide in
the archive. It does not approve the guide; review its content, warnings, and source references in
the guide editor before approval. Manual handoff exports do not send provider requests; the separate
`ai generate` command sends only after the normal outbound-content confirmation and provider CORS
checks.

Guide approval uses the shared archive validator. A guide with invalid or stale source references
must be reviewed and corrected before approval. The browser editor preserves the archive's
structured sections, blocks, source IDs, and revision history; exported files are user-requested
outputs, while the guide record remains in `.tux`.

Portable PDF export embeds 8-bit grayscale/RGB JPEG, PNG, GIF, and WebP guide images. PNG uses the
first image in the file and supports alpha, indexed color, and Adam7 interlacing. GIF and animated
WebP export their first frame. Decoded image alpha is preserved with a PDF soft mask. Decoding is
limited to 64 MiB of encoded data and 16 million output pixels per image; JPEG and the common opaque
8-bit RGB/grayscale PNG path are embedded directly without pixel decoding. Combined PDF image
streams are capped at 128 MiB.

The WebAssembly binary statically includes zlib 1.3.2, libpng 1.6.59, GIFLIB at the pinned commit
`061605081115bbfd7019bafc119a13b6f17fcf25` (including the upstream GIF control-extension bounds
fix), and libwebp 1.6.0. Their license notices are installed under `licenses/` with the WebRuntime
component; the WebP patent grant is included with its license.

### Journal WebAssembly command API

The WebAssembly module exposes the existing generic dispatcher and scoped entry points for browser
clients. All entry points accept the same JSON payload and call the same C++ command dispatcher:

```json
{
  "api": "journal.v1",
  "arguments": ["journal", "entry", "list", "--json"]
}
```

The generic `tutorux_web_dispatch_json` entry point accepts any supported command. Its object form
may include `api` to request a scoped API version. The scoped C exports are
`tutorux_web_journal_dispatch_json`, `tutorux_web_profile_dispatch_json`, and
`tutorux_web_session_dispatch_json`. Each accepts the same JSON string; scoped entry points reject
commands outside their group. Profile operations use the shared `student` command group because a
student profile is the archive's profile record. Every API also accepts the legacy top-level JSON
array of command strings.

The journal scope accepts `journal entry`, `journal collection`, and `journal tag` commands. For
example, an entry list may pass `--query`, `--collection-id`, `--tag-id`, `--from`, `--to`, or
`--has-sessions`; entry creation may pass `--title`, `--date`, `--collection-ids`, and `--tag-ids`.
The profile scope accepts `student` commands. The session scope accepts `session` commands,
including `session create --entry-id ID --type notes-only|record-audio|import-recording`,
`session list --entry-id ID`, and the start, complete, review, and resume lifecycle operations.
Command arrays use the same names and option rules as the native CLI; they are never interpreted by
a shell. Include `--json` in the command arguments when the client needs structured command output.

The result is JSON with `ok`, `exit_code`, and `output` on normal dispatcher completion, or
`ok`, `exit_code`, `error_code`, and `error` for a bridge-level error. Archive passphrases, when
needed, remain top-level JSON strings named `passphrase` and `newPassphrase`; the bridge bounds and
clears those in-memory copies after dispatch. Browser clients should invoke the API from the worker
so the existing path validation, cross-tab locking, archive synchronization, and IndexedDB
recovery snapshot remain in effect. A successful command response is followed by the worker's
existing archive snapshot persistence; a browser-storage failure is reported as
`archive_persistence_error` and the user should download the current archive before closing.

## Touch and iPad behavior

The page uses responsive layouts, touch-sized controls, native file inputs, and browser download
flows. iPadOS still applies its own file-picker, storage-quota, memory, and background-execution
policies. Keep the page in the foreground during large imports or exports and download an archive
copy before leaving a long editing session.

## Browser boundaries

The page uses a single-thread WebAssembly module and a standard Web Worker. It does not require
`SharedArrayBuffer`, a backend, or an embedded browser runtime. The C++ HTTP transport uses the
browser Fetch API through Emscripten Asyncify, so provider calls work only when the provider allows
the page's origin through CORS. Unsupported commands return the command engine's error rather than
reporting success.

Cloud AI providers may block direct requests from a browser origin through CORS policy. Browser API
keys remain in page memory only until an upload attempt completes or the page closes, then are
cleared; they are not stored by this page. Passphrases are held in memory only while the page is
open. Use manual transcript import or the external AI-package flow when provider requests are
blocked.

The WebAssembly build does not include whisper.cpp or the embedded llama.cpp runtime, so it cannot
run local speech recognition. Remote transcription is available for one user-selected MP3, MP4,
MPEG, MPGA, M4A, WAV, or WebM file at a time through an OpenAI-compatible
`/audio/transcriptions` endpoint. The endpoint base URL, model, and optional API key are entered in
the page and held in memory only; they are not saved in the archive, IndexedDB, browser storage, or
logs. The API key is sent in the request's `Authorization` header. HTTPS is required, except HTTP
to localhost or an IP loopback address. URL credentials, query strings, and fragments are rejected.

Before each upload, Tutorux shows the selected filename, media type, byte count, endpoint, and model,
explains that the selected audio and entered key leave the device, and requires a fresh confirmation.
The request sends only that audio file, the model, and the key header; it does not attach archive
contents, prior transcripts, tutor notes, or other files. The provider may process or retain the
upload under its own terms. The request can be canceled. A canceled request may already have
delivered audio to the provider, but Tutorux does not import its returned transcript. Successful
responses must contain ordered, timestamped segments and are passed through the existing WebVTT
transcript-import command as provisional records in the session selected when the request began.
Review or correct these segments before using them as evidence.

Providers must allow the page's origin through CORS and return the OpenAI-compatible verbose JSON
segment response. CORS, authentication, endpoint, model, and response-format failures are reported
without printing the API key or audio. Tutorux recommends manual transcript import or the external
AI-package workflow when a provider request cannot be completed. The page never requires a hosted
proxy.

Browser support depends on the APIs available at the deployment origin. Microphone capture and
service-worker installation require a secure context; in-place archive save is available only in
browsers that implement the File System Access API, while other browsers use file input and archive
download. Storage quota, memory, permission prompts, background execution, and file-picker behavior
vary by browser and operating system. iPadOS applies its own limits. A tested browser-version matrix
has not yet been published or release-qualified. CI builds the static WebAssembly package and reports
its size and dependency inventory, but the WASM preset disables CTest and no browser automation is
currently part of release qualification.
