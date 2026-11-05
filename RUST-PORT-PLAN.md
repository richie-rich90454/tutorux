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
- Compaction, reindexing, recovery copies, and sanitized copies.
- Session package export/import.
- Multi-track recording storage and a local mixer.
- Evidence links and graph.
- Reminders.
- Image OCR with embedded models.
- Google/Microsoft OAuth and Apple CalDAV sync.
- Tauri command surface.
- Desktop release build.
- Embedded Whisper and local GGUF paths.
- Reviewed cloud AI transport.
- `.tutor` launch association and single-instance handoff.
- Real Whisper speech and OCR text fixtures.
- 1 GiB synthetic workspace qualification.

## Follow-up work

1. Add a streaming media protocol for large files.
2. Move recording chunk persistence into the native capture worker.
3. Add windowed Whisper transcription instead of one large WAV payload.
4. Add keyset pagination for transcripts and materials.
5. Add PDF page rendering for OCR.
6. Add salvage from physically corrupted SQLite files.
7. Add live qualification for OAuth/CalDAV accounts, cloud keys, and local GGUF models.
8. Add a 100 GB synthetic workload and Criterion benchmarks.
9. Qualify mobile hardware capture, macOS/Linux capture, and installer signing.

## Non-goals

- Reintroducing a custom `.tux` container.
- Reintroducing a browser workspace adapter.
- Reintroducing the in-app command console.
- Reintroducing the standalone CLI.
