> **Migration reference:** This document describes behavior, implementation, or build details from the former C++/Slint application. It remains useful as a porting specification; current TypeScript coverage is tracked in [the feature inventory](../migration/feature-inventory.md). Historical build commands are not the active TypeScript workflow.

# Transcript import

`transcript import --session UUID --input FILE` imports plain text, SubRip (`.srt`), or WebVTT
(`.vtt`). Tutorux infers the format from the file extension. Use `--format text|srt|vtt` to select it
explicitly, or `--format auto` to use extension detection.

Export with `transcript export --session UUID --output FILE --format text|srt|vtt|json`. Text and
JSON exports preserve untimed segments. SRT and WebVTT export refuses the entire operation when any
selected segment lacks a valid positive-duration timestamp; it never silently drops those records.
Subtitle output includes speaker labels when available and normalizes cue line breaks. WebVTT text
escapes markup delimiters. JSON retains the complete stored segment fields and provenance; subtitle
formats preserve the timing and cue text their formats can represent.

Plain text creates one untimed segment for each non-empty line. The source line number is retained.
SubRip and WebVTT cues preserve start and end timestamps, multiline cue text, cue order, and cue IDs
when present. WebVTT header metadata and NOTE, STYLE, and REGION blocks are parsed as non-speech
metadata and are not made into transcript segments. Text and markup inside speech cues are retained
as provided.

The source must be a regular, non-symlink file no larger than 256 MiB. Lines and subtitle cues are
limited to 16 MiB. Text must be valid UTF-8 and cannot contain NUL or disallowed control bytes.
Subtitle timestamps are validated before records are written. Parsing uses a bounded line buffer,
and archive writes use batches of 128 segments. If an archive write fails after earlier batches have
committed, the error reports the number already imported.

Every imported segment is `provisional` until a tutor verifies or corrects it. Untimed text is
explicitly marked as not timestamped; no time is inferred. Transcript display, export, and guide
excerpts preserve cue ranges when the source provided them.

## Local speech recognition

Post-session recognition is provided by the optional whisper.cpp C API. Configure with
`-DTUTORUX_ENABLE_WHISPER=ON` and a package that exports the `whisper` CMake target, or add
`-DTUTORUX_FETCH_WHISPER=ON` to fetch the pinned v1.9.5 dependency. Tutorux does not download model
weights or place them in the archive. Pass the model path on each command:

```text
tutorux --archive Lessons.tux transcript generate --session UUID --model models/ggml-small.bin
tutorux --archive Lessons.tux transcript refine --session UUID --model models/ggml-small.bin \
  --track TRACK_UUID --start 00:10:00 --end 00:15:00 --language en
```

The backend streams the selected track's archive chunks, verifies sequence, format, timeline gaps,
and payload checksums, downmixes to mono, and converts supported PCM formats to 16 kHz float audio.
Audio windows are bounded to 27 seconds. Gaps flush the current window so missing samples are never
treated as silence. Audio is decoded and resampled in memory; no plaintext recording is extracted.
Each recognized segment stores its timestamp range, model filename, backend version, language,
track, run identifier, and `provisional` review state. No speaker identity is inferred.

`transcript generate` refuses to duplicate provisional local output for an overlapping range on the
same track. `transcript refine` creates a new run first and then soft-deletes only overlapping
provisional local Whisper records, recording which run superseded them. Human-corrected and
human-verified transcript records remain intact. A failed inference may leave already committed
segments as provisional and reports that partial result in its error.

When Tutorux is built without Whisper support, transcript generation returns
`transcription_unavailable` with the build option needed to enable it.
