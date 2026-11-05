# Rust storage plan

The custom archive engine and CLI port are retired. Rust now owns the SQLite workspace store and the native desktop services.

## Completed

- SQLite schema and migrations.
- Workspace create/open/close.
- Student, session, journal, observation, schedule, material, recording, transcript, guide, evidence, goal, skill, AI job, settings, and Trash tables.
- FTS5 search.
- Chunked zstd compression and content deduplication.
- Optional SQLCipher encryption.
- Passphrase unlock and rekey.
- Encrypted backup and integrity check.
- Tauri command surface.
- Desktop release build.
- Embedded Whisper and local GGUF paths.
- Reviewed cloud AI transport.
- `.tutor` launch association and single-instance handoff.

## Follow-up work

1. Add a streaming media protocol for large files.
2. Move recording chunk persistence into the native capture worker.
3. Add windowed Whisper transcription instead of one large WAV payload.
4. Add keyset pagination for transcripts and materials.
5. Add repair, compaction, and recovery UI for SQLite maintenance.
6. Add sanitized workspace copies.
7. Add session package import/export.
8. Add Google/Outlook/macOS Calendar OAuth.
9. Add reminders.
10. Add OCR.
11. Add a 100 GB synthetic workload and Criterion benchmarks.
12. Qualify macOS/Linux capture and installer signing.

## Non-goals

- Reintroducing a custom `.tux` container.
- Reintroducing a browser workspace adapter.
- Reintroducing the in-app command console.
- Reintroducing the standalone CLI.
