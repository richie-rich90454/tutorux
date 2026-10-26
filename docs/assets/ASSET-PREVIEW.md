> **Migration reference:** This document describes behavior, implementation, or build details from the former C++/Slint application. It remains useful as a porting specification; current TypeScript coverage is tracked in [the feature inventory](../migration/feature-inventory.md). Historical build commands are not the active TypeScript workflow.

# Browser asset previews

The WebAssembly journal previews an asset only after the user opens its session and selects
**Preview**. Tutorux extracts the selected asset to the browser worker's temporary in-memory
workspace, verifies it through the archive extraction path, reads the bytes, and removes that
temporary file in a `finally` cleanup. The preview does not create a persistent extracted file or
change the archive. Closing a preview or refreshing the asset list revokes its object URL and drops
the rendered content.

Supported previews use the asset's recorded MIME type and a conservative allowlist:

| Preview | Accepted formats | Maximum bytes |
| --- | --- | ---: |
| Image | PNG, JPEG, GIF, WebP, BMP | 12 MiB |
| PDF | PDF | 16 MiB |
| Text | Plain text and files ending in `.txt`, `.md`, `.markdown`, `.csv`, `.json`, or `.log` | 1 MiB |
| Audio | WAV, MP3, FLAC, Ogg, MP4 audio, WebM audio | 24 MiB |
| Video | MP4, WebM | 24 MiB |

Text is decoded as UTF-8 and inserted as text, never interpreted as HTML. Its display is capped at
100,000 characters. SVG, TIFF, Office documents, Matroska, unknown types, invalid UTF-8 text, empty
assets, and assets above their preview limit remain available through **Download file** but are not
rendered inline. Browser codec support differs; an accepted audio or video type may still show a
playback error. PDF display also depends on the browser's built-in PDF viewer.

Preview errors, size-limit messages, loading state, and unsupported formats are exposed as visible
status text for assistive technology. The archive's full asset size limit is separate from these
browser preview limits. Browser imports are limited to 64 MiB per file; native imports can exceed
that and remain stored as opaque archive bytes.
