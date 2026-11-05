# `.tutor` workspace format

A `.tutor` file is a SQLite database. There is no custom container, custom B+ tree, or custom commit locator.

## Identification

```sql
PRAGMA application_id = 0x54555452;  -- "TUTR"
PRAGMA user_version = 1;
```

`application_id` identifies a Tutorux workspace. `user_version` is the schema migration version.

## Connection settings

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA page_size = 16384;
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
```

WAL allows incremental writes and crash recovery. A clean close checkpoints the WAL. While the workspace is open, `-wal` and `-shm` sidecars may exist beside the `.tutor` file.

## Tables

### Workspace

- `meta(key, value)` — name, description, created/updated timestamps, encryption flag.
- `settings(key, value)` — UI and behavior preferences.

### People and sessions

- `students(id, display_name, year, subjects, goals, notes, archived, deleted_at, timestamps)`
- `sessions(id, student_id, schedule_event_id, title, subject, scheduled_at, started_at, ended_at, status, notes, deleted_at, timestamps)`
- `journal_entries(id, session_id, student_id, entry_date, title, body, deleted_at, timestamps)`
- `observations(id, session_id, student_id, kind, priority, start_us, end_us, title, body, deleted_at, timestamps)`
- `skill_ratings(id, student_id, skill, rating, note, updated_at)`
- `goals(id, student_id, title, status, target_date, notes, updated_at)`
- `progress_reports(id, student_id, title, period_start, period_end, body, timestamps)`

### Schedule

- `schedule_events(id, student_id, title, subject, start_at, duration_min, recurrence, location, notes, calendar_provider, calendar_account_id, external_id, external_etag, deleted_at, timestamps)`
- `calendar_accounts(id, provider, account_email, credential_key, sync_cursor, deleted_at, timestamps)`

Recurring events materialize future session rows. The unique index on `(schedule_event_id, scheduled_at)` prevents duplicate occurrences.

### Capture and transcripts

- `recordings(id, session_id, title, source, sample_rate, channels, started_at, duration_us, deleted_at, timestamps)`
- `recording_chunks(recording_id, track, chunk_no, start_us, sample_count, hash, original_size)`
- `transcript_cues(id, session_id, start_us, end_us, speaker, body, verified, deleted_at, timestamps)`

Recording chunks reference compressed blobs.

### Materials

- `materials(id, session_id, student_id, kind, filename, mime_type, byte_size, hash, source_url, title, notes, status, extracted_text, deleted_at, timestamps)`
- `material_chunks(material_id, chunk_no, hash, original_size)`

### Guides and evidence

- `guides(id, student_id, session_id, title, status, body, source_ids, deleted_at, timestamps)`
- `guide_revisions(id, guide_id, title, body, created_at)`
- `evidence(id, student_id, session_id, source_type, source_id, kind, statement, status, deleted_at, timestamps)`
- `evidence_links(id, from_id, to_id, relationship, created_at)`

### AI

- `ai_jobs(id, session_id, student_id, task, provider, model, status, request_json, response_text, error, created_at, completed_at)`

## Blob store

```sql
blobs(hash TEXT PRIMARY KEY, codec INTEGER, original_size INTEGER,
      stored_size INTEGER, data BLOB)
```

- SHA-256 of the uncompressed bytes is the identity.
- Codec `0` is raw; codec `1` is zstd.
- Chunks are 4 MiB by default.
- Identical chunks are stored once.
- Material and recording chunk rows reference blob hashes.

Already-compressed media is stored raw and deduplicated. The application does not attempt to recompress JPEG, MP4, PDF, DOCX, XLSX, or ZIP data.

## Search

`search_fts` is an FTS5 table:

```sql
search_fts(entity_type UNINDEXED, entity_id UNINDEXED, title, body,
           student_id UNINDEXED, session_id UNINDEXED,
           tokenize = 'unicode61 remove_diacritics 2')
```

Each entity mutation deletes and reinserts its row. FTS5 `rank` orders results, and `snippet()` supplies preview text.

## Encryption

Optional SQLCipher encrypts the whole database, including indexes and blobs.

- Create with a passphrase or leave encryption off.
- Open requires the passphrase.
- Change passphrase uses SQLCipher `PRAGMA rekey`.
- Backup applies the same key to the destination.
- The key is held in memory only for the open workspace and is zeroized on close.

## Backup

Manual backup uses SQLite's online backup API, then runs `PRAGMA integrity_check`. For encrypted workspaces the destination is created with the same key.

## Migrations

Every schema change must:

1. increment `user_version`;
2. run inside a transaction;
3. preserve existing rows;
4. be covered by a Rust integration test.

The current schema version is `1`. There is no legacy `.tux` importer; that format was retired before deployment.
