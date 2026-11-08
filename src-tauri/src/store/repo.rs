use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::{
    models::*,
    schema::{SCHEMA_SQL, WORKSPACE_APPLICATION_ID, WORKSPACE_SCHEMA_VERSION},
};

pub fn now_ms() -> i64 {
    unix_ms()
}

pub fn apply_connection_pragmas(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA busy_timeout = 5000;
         PRAGMA wal_autocheckpoint = 1000;
         PRAGMA temp_store = MEMORY;",
    )
    .map_err(|error| format!("Could not configure the workspace database: {error}"))
}

pub fn initialize_workspace(
    conn: &Connection,
    name: &str,
    description: &str,
    encrypted: bool,
) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA page_size = 16384;
         PRAGMA auto_vacuum = INCREMENTAL;",
    )
    .map_err(|error| format!("Could not configure the workspace file: {error}"))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|error| format!("Could not create the workspace schema: {error}"))?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('name', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![name],
    )
    .map_err(|error| format!("Could not name the workspace: {error}"))?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('description', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![description],
    )
    .map_err(|error| format!("Could not describe the workspace: {error}"))?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('created_at', ?1)
         ON CONFLICT(key) DO NOTHING",
        params![now.to_string()],
    )
    .map_err(|error| format!("Could not record the workspace creation time: {error}"))?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('updated_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![now.to_string()],
    )
    .map_err(|error| format!("Could not record the workspace update time: {error}"))?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('encrypted', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![if encrypted { "true" } else { "false" }],
    )
    .map_err(|error| format!("Could not record the workspace encryption state: {error}"))?;
    conn.pragma_update(None, "application_id", WORKSPACE_APPLICATION_ID)
        .map_err(|error| format!("Could not mark the workspace file: {error}"))?;
    conn.pragma_update(None, "user_version", WORKSPACE_SCHEMA_VERSION)
        .map_err(|error| format!("Could not version the workspace file: {error}"))?;
    Ok(())
}

pub fn verify_workspace_identity(conn: &Connection) -> Result<(), String> {
    let application_id: i64 = conn
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|error| format!("Could not read the workspace identifier: {error}"))?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Could not read the workspace version: {error}"))?;
    if application_id == 0 && version == 0 {
        return Err("The selected file is not a Tutorux workspace.".to_owned());
    }
    if application_id != WORKSPACE_APPLICATION_ID {
        return Err("The selected file belongs to a different application.".to_owned());
    }
    if version <= 0 || version > WORKSPACE_SCHEMA_VERSION {
        return Err(format!(
            "This workspace uses schema version {version}; this build supports up to {WORKSPACE_SCHEMA_VERSION}."
        ));
    }
    Ok(())
}

fn meta_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("Could not read workspace metadata: {error}"))
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|error| format!("Could not update workspace metadata: {error}"))?;
    Ok(())
}

fn touch_workspace(conn: &Connection) -> Result<(), String> {
    set_meta(conn, "updated_at", &now_ms().to_string())
}

pub fn workspace_summary(conn: &Connection, path: &Path) -> Result<WorkspaceSummary, String> {
    let name = meta_value(conn, "name")?.unwrap_or_else(|| "Untitled workspace".to_owned());
    let description = meta_value(conn, "description")?.unwrap_or_default();
    let created_at = meta_value(conn, "created_at")?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let updated_at = meta_value(conn, "updated_at")?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(created_at);
    let encrypted = meta_value(conn, "encrypted")?.as_deref() == Some("true");
    let student_count = count_live(conn, "students")?;
    let session_count = count_live(conn, "sessions")?;
    let material_count = count_live(conn, "materials")?;
    let size_bytes = std::fs::metadata(path)
        .map(|meta| meta.len() as i64)
        .unwrap_or(0);
    Ok(WorkspaceSummary {
        path: path.to_string_lossy().into_owned(),
        name,
        description,
        created_at,
        updated_at,
        student_count,
        session_count,
        material_count,
        encrypted,
        schema_version: WORKSPACE_SCHEMA_VERSION,
        size_bytes,
    })
}

fn count_live(conn: &Connection, table: &str) -> Result<i64, String> {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE deleted_at IS NULL"),
        [],
        |row| row.get(0),
    )
    .map_err(|error| format!("Could not count workspace records: {error}"))
}

fn json_list(value: &str) -> Vec<String> {
    parse_json_array(value)
}

fn reindex(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    title: &str,
    body: &str,
    student_id: &str,
    session_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM search_fts WHERE entity_type = ?1 AND entity_id = ?2",
        params![entity_type, entity_id],
    )
    .map_err(|error| format!("Could not update the search index: {error}"))?;
    conn.execute(
        "INSERT INTO search_fts (entity_type, entity_id, title, body, student_id, session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![entity_type, entity_id, title, body, student_id, session_id],
    )
    .map_err(|error| format!("Could not update the search index: {error}"))?;
    Ok(())
}

fn remove_index(conn: &Connection, entity_type: &str, entity_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM search_fts WHERE entity_type = ?1 AND entity_id = ?2",
        params![entity_type, entity_id],
    )
    .map_err(|error| format!("Could not update the search index: {error}"))?;
    Ok(())
}

pub(crate) fn reindex_public(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    title: &str,
    body: &str,
    student_id: &str,
    session_id: &str,
) -> Result<(), String> {
    reindex(
        conn,
        entity_type,
        entity_id,
        title,
        body,
        student_id,
        session_id,
    )
}

pub(crate) fn touch_workspace_public(conn: &Connection) -> Result<(), String> {
    touch_workspace(conn)
}

fn student_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Student> {
    Ok(Student {
        id: row.get(0)?,
        display_name: row.get(1)?,
        year: row.get(2)?,
        subjects: json_list(&row.get::<_, String>(3)?),
        goals: json_list(&row.get::<_, String>(4)?),
        notes: row.get(5)?,
        archived: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        session_count: row.get(9)?,
        last_session_at: row.get(10)?,
    })
}

const STUDENT_SELECT: &str = "SELECT s.id, s.display_name, s.year, s.subjects, s.goals, s.notes,
    s.archived, s.created_at, s.updated_at,
    (SELECT COUNT(*) FROM sessions x WHERE x.student_id = s.id AND x.deleted_at IS NULL),
    (SELECT MAX(COALESCE(x.started_at, x.scheduled_at)) FROM sessions x
      WHERE x.student_id = s.id AND x.deleted_at IS NULL)
    FROM students s";

pub fn list_students(conn: &Connection, query: &str) -> Result<Vec<Student>, String> {
    let needle = format!("%{}%", query.trim().to_lowercase());
    let mut statement = conn
        .prepare(&format!(
            "{STUDENT_SELECT}
             WHERE s.deleted_at IS NULL AND s.archived = 0
               AND (?1 = '%%' OR lower(s.display_name) LIKE ?1 OR lower(s.subjects) LIKE ?1)
             ORDER BY s.display_name COLLATE NOCASE"
        ))
        .map_err(|error| format!("Could not read students: {error}"))?;
    let rows = statement
        .query_map(params![needle], student_row)
        .map_err(|error| format!("Could not read students: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read students: {error}"))
}

pub fn get_student(conn: &Connection, id: &str) -> Result<Student, String> {
    conn.query_row(
        &format!("{STUDENT_SELECT} WHERE s.id = ?1 AND s.deleted_at IS NULL"),
        params![id],
        student_row,
    )
    .optional()
    .map_err(|error| format!("Could not read the student: {error}"))?
    .ok_or_else(|| "The student could not be found.".to_owned())
}

pub fn create_student(conn: &Connection, input: &StudentInput) -> Result<Student, String> {
    let name = input.display_name.trim();
    if name.is_empty() {
        return Err("Enter a student name.".to_owned());
    }
    if name.len() > 200 {
        return Err("Student names must be 200 characters or fewer.".to_owned());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO students (id, display_name, year, subjects, goals, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            id,
            name,
            input.year.trim(),
            json_array(&input.subjects),
            json_array(&input.goals),
            input.notes.trim(),
            now
        ],
    )
    .map_err(|error| format!("Could not create the student: {error}"))?;
    reindex(
        conn,
        "student",
        &id,
        name,
        &format!("{} {}", input.year, input.notes),
        &id,
        "",
    )?;
    touch_workspace(conn)?;
    get_student(conn, &id)
}

pub fn update_student(
    conn: &Connection,
    id: &str,
    input: &StudentInput,
) -> Result<Student, String> {
    let name = input.display_name.trim();
    if name.is_empty() {
        return Err("Enter a student name.".to_owned());
    }
    let changed = conn
        .execute(
            "UPDATE students SET display_name = ?2, year = ?3, subjects = ?4, goals = ?5,
             notes = ?6, updated_at = ?7 WHERE id = ?1 AND deleted_at IS NULL",
            params![
                id,
                name,
                input.year.trim(),
                json_array(&input.subjects),
                json_array(&input.goals),
                input.notes.trim(),
                now_ms()
            ],
        )
        .map_err(|error| format!("Could not update the student: {error}"))?;
    if changed == 0 {
        return Err("The student could not be found.".to_owned());
    }
    reindex(
        conn,
        "student",
        id,
        name,
        &format!("{} {}", input.year, input.notes),
        id,
        "",
    )?;
    touch_workspace(conn)?;
    get_student(conn, id)
}

pub fn delete_student(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE students SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now],
        )
        .map_err(|error| format!("Could not move the student to trash: {error}"))?;
    if changed == 0 {
        return Err("The student could not be found.".to_owned());
    }
    remove_index(conn, "student", id)?;
    touch_workspace(conn)?;
    Ok(())
}

fn session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        student_id: row.get(1)?,
        student_name: row.get(2)?,
        title: row.get(3)?,
        subject: row.get(4)?,
        scheduled_at: row.get(5)?,
        started_at: row.get(6)?,
        ended_at: row.get(7)?,
        status: row.get(8)?,
        notes: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        journal_count: row.get(12)?,
        observation_count: row.get(13)?,
        material_count: row.get(14)?,
        cue_count: row.get(15)?,
        guide_count: row.get(16)?,
        recording_count: row.get(17)?,
    })
}

const SESSION_SELECT: &str = "SELECT s.id, s.student_id, COALESCE(st.display_name, ''), s.title,
    s.subject, s.scheduled_at, s.started_at, s.ended_at, s.status, s.notes, s.created_at, s.updated_at,
    (SELECT COUNT(*) FROM journal_entries x WHERE x.session_id = s.id AND x.deleted_at IS NULL),
    (SELECT COUNT(*) FROM observations x WHERE x.session_id = s.id AND x.deleted_at IS NULL),
    (SELECT COUNT(*) FROM materials x WHERE x.session_id = s.id AND x.deleted_at IS NULL),
    (SELECT COUNT(*) FROM transcript_cues x WHERE x.session_id = s.id AND x.deleted_at IS NULL),
    (SELECT COUNT(*) FROM guides x WHERE x.session_id = s.id AND x.deleted_at IS NULL),
    (SELECT COUNT(*) FROM recordings x WHERE x.session_id = s.id AND x.deleted_at IS NULL)
    FROM sessions s LEFT JOIN students st ON st.id = s.student_id";

pub fn list_sessions(
    conn: &Connection,
    student_id: Option<&str>,
    status: Option<&str>,
    limit: i64,
) -> Result<Vec<Session>, String> {
    let student_filter = student_id.unwrap_or("");
    let status_filter = status.unwrap_or("");
    let mut statement = conn
        .prepare(&format!(
            "{SESSION_SELECT}
             WHERE s.deleted_at IS NULL
               AND (?1 = '' OR s.student_id = ?1)
               AND (?2 = '' OR s.status = ?2)
             ORDER BY COALESCE(s.started_at, s.scheduled_at, s.created_at) DESC
             LIMIT ?3"
        ))
        .map_err(|error| format!("Could not read sessions: {error}"))?;
    let rows = statement
        .query_map(
            params![student_filter, status_filter, limit.clamp(1, 1000)],
            session_row,
        )
        .map_err(|error| format!("Could not read sessions: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read sessions: {error}"))
}

pub fn list_recent_sessions(
    conn: &Connection,
    now: i64,
    limit: i64,
) -> Result<Vec<Session>, String> {
    let mut statement = conn
        .prepare(&format!(
            "{SESSION_SELECT}
             WHERE s.deleted_at IS NULL
               AND (s.started_at IS NOT NULL OR s.scheduled_at <= ?1)
               AND s.status IN ('active', 'completed', 'no_show')
             ORDER BY COALESCE(s.started_at, s.scheduled_at, s.created_at) DESC
             LIMIT ?2"
        ))
        .map_err(|error| format!("Could not read recent sessions: {error}"))?;
    let rows = statement
        .query_map(params![now, limit.clamp(1, 1000)], session_row)
        .map_err(|error| format!("Could not read recent sessions: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read recent sessions: {error}"))
}

pub fn list_upcoming_sessions(
    conn: &Connection,
    from: i64,
    to: i64,
    limit: i64,
) -> Result<Vec<Session>, String> {
    let mut statement = conn
        .prepare(&format!(
            "{SESSION_SELECT}
             WHERE s.deleted_at IS NULL AND s.scheduled_at IS NOT NULL
               AND s.scheduled_at >= ?1 AND s.scheduled_at <= ?2
               AND s.status IN ('planned', 'active')
             ORDER BY s.scheduled_at ASC LIMIT ?3"
        ))
        .map_err(|error| format!("Could not read upcoming sessions: {error}"))?;
    let rows = statement
        .query_map(params![from, to, limit.clamp(1, 1000)], session_row)
        .map_err(|error| format!("Could not read upcoming sessions: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read upcoming sessions: {error}"))
}

pub fn get_session(conn: &Connection, id: &str) -> Result<Session, String> {
    conn.query_row(
        &format!("{SESSION_SELECT} WHERE s.id = ?1 AND s.deleted_at IS NULL"),
        params![id],
        session_row,
    )
    .optional()
    .map_err(|error| format!("Could not read the session: {error}"))?
    .ok_or_else(|| "The session could not be found.".to_owned())
}

pub fn create_session(conn: &Connection, input: &SessionInput) -> Result<Session, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Enter a session title.".to_owned());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO sessions (id, student_id, title, subject, scheduled_at, started_at, ended_at, status, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            input.student_id,
            title,
            input.subject.trim(),
            input.scheduled_at,
            input.started_at,
            input.ended_at,
            normalized_session_status(&input.status),
            input.notes.trim(),
            now
        ],
    )
    .map_err(|error| format!("Could not create the session: {error}"))?;
    reindex(
        conn,
        "session",
        &id,
        title,
        &format!("{} {}", input.subject, input.notes),
        input.student_id.as_deref().unwrap_or(""),
        &id,
    )?;
    touch_workspace(conn)?;
    get_session(conn, &id)
}

fn normalized_session_status(value: &str) -> &str {
    match value {
        "planned" | "active" | "completed" | "cancelled" | "no_show" => value,
        _ => "planned",
    }
}

pub fn update_session(
    conn: &Connection,
    id: &str,
    input: &SessionInput,
) -> Result<Session, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Enter a session title.".to_owned());
    }
    let changed = conn
        .execute(
            "UPDATE sessions SET student_id = ?2, title = ?3, subject = ?4, scheduled_at = ?5,
             started_at = ?6, ended_at = ?7, status = ?8, notes = ?9, updated_at = ?10
             WHERE id = ?1 AND deleted_at IS NULL",
            params![
                id,
                input.student_id,
                title,
                input.subject.trim(),
                input.scheduled_at,
                input.started_at,
                input.ended_at,
                normalized_session_status(&input.status),
                input.notes.trim(),
                now_ms()
            ],
        )
        .map_err(|error| format!("Could not update the session: {error}"))?;
    if changed == 0 {
        return Err("The session could not be found.".to_owned());
    }
    reindex(
        conn,
        "session",
        id,
        title,
        &format!("{} {}", input.subject, input.notes),
        input.student_id.as_deref().unwrap_or(""),
        id,
    )?;
    touch_workspace(conn)?;
    get_session(conn, id)
}

pub fn delete_session(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE sessions SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now],
        )
        .map_err(|error| format!("Could not move the session to trash: {error}"))?;
    if changed == 0 {
        return Err("The session could not be found.".to_owned());
    }
    remove_index(conn, "session", id)?;
    touch_workspace(conn)?;
    Ok(())
}
