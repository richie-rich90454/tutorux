# Performance design and baseline

The performance model changed with the SQLite rewrite. The application no longer serializes, verifies, or copies a whole custom archive on every save.

## Current measurements

Desktop frontend production build:

```text
index.html                  1.02 kB
CSS                        29.34 kB  (6.56 kB gzip)
vendor JS                  26.60 kB  (10.26 kB gzip)
main JS                   189.49 kB  (47.11 kB gzip)
fonts                      1.71 MB   (three local Noto Sans faces)
```

The frontend entry is small because the archive, domain, AI packaging, PDF, and audio engines were removed from the browser bundle.

## Why the new model is faster

- SQLite writes only changed pages, not a new archive image.
- Reads use indexed row queries and projections.
- FTS5 handles global search instead of scanning every record field.
- Compressed BLOB chunks are read on demand.
- The UI does not rebuild a 36-field workspace object after every mutation.
- Routes load only the active feature page.
- The command palette debounces search.

## Index coverage

The schema indexes:

- live students by name;
- live sessions by student and start time;
- sessions by time;
- schedule events by start and student;
- journal entries by session and student;
- observations by session and timestamp;
- transcript cues by session and timestamp;
- materials by session and student;
- recordings by session and start time;
- guides by student and session;
- evidence by student and session;
- goals and skills by student.

## Large-workspace targets

Targets for the pending 100 GB qualification:

- open workspace metadata in under 500 ms;
- session list and detail under 300 ms;
- transcript page under 100 ms;
- global search under 200 ms for common terms;
- recording start under 200 ms;
- normal memory use under 500 MB;
- no full-file copy during a normal commit;
- no crash at 100 GB.

These are design targets, not measured results. The current verification suite does not include a 100 GB synthetic workspace.

## Known bottlenecks

- `material_read` loads a preview into memory and is capped; large media has no streaming protocol yet.
- Full-audio Whisper decoding creates a 16 kHz mono WAV in memory.
- A recording import sends compressed audio bytes through IPC in one call.
- SQLite is serialized behind one writer mutex; long imports block other writes.
- The session detail view currently loads all cues up to a 10,000-row cap.

## Next performance work

- Add a Tauri custom media protocol with HTTP range support.
- Stream recording chunks from the capture worker directly into SQLite.
- Windowed Whisper transcription instead of one full WAV payload.
- Keyset pagination for transcript and material lists.
- Record 100 GB synthetic fixtures and add Rust benchmarks.
