pub const WORKSPACE_APPLICATION_ID: i64 = 0x5455_5452;
pub const WORKSPACE_SCHEMA_VERSION: i64 = 2;

pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    year TEXT NOT NULL DEFAULT '',
    subjects TEXT NOT NULL DEFAULT '[]',
    goals TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS students_live_name ON students(display_name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
    schedule_event_id TEXT REFERENCES schedule_events(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    scheduled_at INTEGER,
    started_at INTEGER,
    ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'planned',
    notes TEXT NOT NULL DEFAULT '',
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_student_time ON sessions(student_id, started_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_time ON sessions(started_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_schedule_slot ON sessions(schedule_event_id, scheduled_at) WHERE schedule_event_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS schedule_events (
    id TEXT PRIMARY KEY,
    student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    start_at INTEGER NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 60,
    recurrence TEXT NOT NULL DEFAULT '',
    recurrence_interval INTEGER NOT NULL DEFAULT 1,
    recurrence_until INTEGER,
    location TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    calendar_provider TEXT NOT NULL DEFAULT 'internal',
    calendar_account_id TEXT,
    external_id TEXT,
    external_etag TEXT,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS schedule_start ON schedule_events(start_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS schedule_student ON schedule_events(student_id, start_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS calendar_accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    account_email TEXT NOT NULL DEFAULT '',
    credential_key TEXT NOT NULL,
    sync_cursor TEXT NOT NULL DEFAULT '',
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
    entry_date TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS journal_session ON journal_entries(session_id, entry_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS journal_student ON journal_entries(student_id, entry_date DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'general-note',
    priority TEXT NOT NULL DEFAULT 'normal',
    start_us INTEGER NOT NULL DEFAULT 0,
    end_us INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS observations_session_time ON observations(session_id, start_us) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS transcript_cues (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_us INTEGER NOT NULL,
    end_us INTEGER NOT NULL,
    speaker TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cues_session_time ON transcript_cues(session_id, start_us) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS cues_search ON transcript_cues(session_id, start_us);

CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'file',
    filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    byte_size INTEGER NOT NULL DEFAULT 0,
    hash TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ready',
    extracted_text TEXT NOT NULL DEFAULT '',
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS materials_session ON materials(session_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS materials_student ON materials(student_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS material_chunks (
    material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    chunk_no INTEGER NOT NULL,
    hash TEXT NOT NULL,
    original_size INTEGER NOT NULL,
    PRIMARY KEY (material_id, chunk_no)
) STRICT;

CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,
    codec INTEGER NOT NULL DEFAULT 0,
    original_size INTEGER NOT NULL,
    stored_size INTEGER NOT NULL,
    data BLOB NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'microphone+system',
    sample_rate INTEGER NOT NULL DEFAULT 0,
    channels INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    duration_us INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS recordings_session ON recordings(session_id, started_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS recording_chunks (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    track TEXT NOT NULL,
    chunk_no INTEGER NOT NULL,
    start_us INTEGER NOT NULL,
    sample_count INTEGER NOT NULL,
    hash TEXT NOT NULL,
    original_size INTEGER NOT NULL,
    PRIMARY KEY (recording_id, track, chunk_no)
) STRICT;

CREATE TABLE IF NOT EXISTS guides (
    id TEXT PRIMARY KEY,
    student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    body TEXT NOT NULL DEFAULT '',
    source_ids TEXT NOT NULL DEFAULT '[]',
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS guides_student ON guides(student_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS guides_session ON guides(session_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS guide_revisions (
    id TEXT PRIMARY KEY,
    guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL DEFAULT 'session',
    source_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'observation',
    statement TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS evidence_student ON evidence(student_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS evidence_session ON evidence(session_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS evidence_links (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL DEFAULT 'supports',
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS skill_ratings (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    skill TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS skill_student ON skill_ratings(student_id, skill);

CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    target_date TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS goals_student ON goals(student_id, status);

CREATE TABLE IF NOT EXISTS progress_reports (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    period_start TEXT NOT NULL DEFAULT '',
    period_end TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS ai_jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
    task TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    request_json TEXT NOT NULL DEFAULT '{}',
    response_text TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    completed_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    entity_type UNINDEXED,
    entity_id UNINDEXED,
    title,
    body,
    student_id UNINDEXED,
    session_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);
"#;

pub fn migrate_workspace(conn: &rusqlite::Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Could not read the workspace version: {error}"))?;
    if version >= WORKSPACE_SCHEMA_VERSION {
        return Ok(());
    }
    if version < 2 {
        conn.execute_batch(&format!(
            "BEGIN IMMEDIATE;
             ALTER TABLE schedule_events ADD COLUMN recurrence_interval INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE schedule_events ADD COLUMN recurrence_until INTEGER;
             PRAGMA user_version = {WORKSPACE_SCHEMA_VERSION};
             COMMIT;"
        ))
        .map_err(|error| format!("Could not upgrade the workspace schema: {error}"))?;
    }
    Ok(())
}
