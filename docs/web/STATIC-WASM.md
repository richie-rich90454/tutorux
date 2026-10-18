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
cmake --install build-wasm --component WebRuntime --prefix dist/tutorux-web
```

Publish the contents of `dist/tutorux-web/web` as a static site. GitHub Pages and other static hosts
must serve the generated JavaScript and WebAssembly files beside the page. The service worker caches
the application shell for offline launch. A secure origin is required for service workers and
browser file handles.

## Portable archive workflow

The browser edition opens and creates the same `.tux` archive format as the C++ command engine. It
does not create a separate browser database of students, sessions, notes, transcripts, or guides.
Edits go through the shared archive commands and are committed to the selected archive in the
WebAssembly filesystem.

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

Archive contents are loaded into the browser's WebAssembly filesystem and browser storage. The web
edition therefore depends on available memory and origin storage quota; very large archives may
exceed browser limits. The current browser file imports limit each transcript, WAV recording, or
asset file to 64 MiB to bound temporary memory use. Native archive workflows do not use this
browser-specific limit.

## Browser workflows

The static page currently provides these archive-backed workflows:

- Create, open, save, download, and recover a portable `.tux` archive.
- Create students and sessions, select a session, and edit its title and subject.
- Add, edit, prioritize, and timestamp tutor notes and lesson markers.
- Import plain text, SRT, or WebVTT transcript files; correct segment text and timestamps; and
  download transcript exports in plain text, SRT, WebVTT, or JSON.
- Capture microphone audio in secure browsers with explicit permission, and import WAV recordings
  into a selected session's durable audio track.
- Import session files and media, list them, verify content hashes, and download extracted copies.
- Create and download a manual AI handoff package in Markdown, JSON, or ZIP, then import an external
  JSON guide response as a proposed guide for tutor review.
- Generate a guide draft from archived session evidence, edit its title and blocks, add
  tutor-written sections, inspect source IDs, validate through approval, and download Markdown,
  HTML, PDF, or DOCX exports.
- Run shared CLI commands from the command console without invoking a shell.

Transcript, WAV recording, and asset imports pass user-selected files through the WebAssembly worker
to the shared C++ import commands. Browser microphone capture uses `MediaRecorder`, requires a
secure origin and an explicit permission confirmation, and saves the compressed audio as a
session-linked asset when stopped. Keep the page open during capture. Captures are limited to
64 MiB; if saving to the archive fails, the browser offers a separate audio download for recovery.
System-audio capture and background recording are unavailable. Other browser file imports are
limited to 64 MiB; external AI response files are limited to 16 MiB. Browser-side local model
provisioning is unavailable. Transcript editing works for transcript segments already in the
archive or imported from supported text formats.

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

Cloud AI providers may block direct requests from a browser origin through CORS policy. Browser
credentials are not stored by this page, and passphrases are held in memory only while the page is
open. Use the manual external-agent package flow when provider requests are blocked. Model-backed
transcription is not exposed by the browser workflows listed above; importing WAV files, capturing
microphone audio, editing or importing transcript text, and exporting PDF or DOCX are supported.
