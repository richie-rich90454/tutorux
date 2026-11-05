use std::path::Path;

use rusqlite::Connection;

use super::{
    backup,
    models::{BackupResult, MaintenanceResult},
};

fn file_bytes(path: &Path) -> i64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0)
}

pub fn compact(conn: &Connection, path: &Path) -> Result<MaintenanceResult, String> {
    let before_bytes = file_bytes(path);
    conn.execute_batch(
        "PRAGMA wal_checkpoint(TRUNCATE);
         VACUUM;
         PRAGMA optimize;",
    )
    .map_err(|error| format!("Could not compact the workspace: {error}"))?;
    let integrity = backup::integrity_check(conn)?;
    Ok(MaintenanceResult {
        before_bytes,
        after_bytes: file_bytes(path),
        integrity,
    })
}

pub fn reindex(conn: &Connection) -> Result<MaintenanceResult, String> {
    conn.execute_batch("REINDEX; PRAGMA optimize;")
        .map_err(|error| format!("Could not rebuild the workspace indexes: {error}"))?;
    let integrity = backup::integrity_check(conn)?;
    Ok(MaintenanceResult {
        before_bytes: 0,
        after_bytes: 0,
        integrity,
    })
}

pub fn recovery_copy(
    conn: &Connection,
    destination: &str,
    key: Option<&str>,
) -> Result<BackupResult, String> {
    backup::backup_workspace(conn, destination, key)
}

pub fn sanitized_copy(
    conn: &Connection,
    destination: &str,
    key: Option<&str>,
) -> Result<BackupResult, String> {
    let result = backup::backup_workspace(conn, destination, key)?;
    let target = Connection::open(destination)
        .map_err(|error| format!("Could not open the sanitized copy: {error}"))?;
    if let Some(key) = key {
        target
            .pragma_update(None, "key", key)
            .map_err(|_| "The sanitized copy encryption key could not be applied.".to_owned())?;
    }
    target
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             BEGIN IMMEDIATE;
             DELETE FROM evidence_links;
             DELETE FROM ai_jobs;
             DELETE FROM transcript_cues;
             DELETE FROM observations;
             DELETE FROM journal_entries;
             DELETE FROM recordings;
             DELETE FROM recording_chunks;
             DELETE FROM materials;
             DELETE FROM material_chunks;
             DELETE FROM progress_reports;
             DELETE FROM calendar_accounts;
             DELETE FROM blobs;
             UPDATE students SET
                 display_name = 'Student ' || substr(id, 1, 4),
                 notes = '',
                 goals = '[]';
             UPDATE sessions SET
                 title = 'Session ' || substr(id, 1, 4),
                 notes = '';
             UPDATE guides SET
                 title = 'Study guide ' || substr(id, 1, 4),
                 body = '[removed]',
                 source_ids = '[]';
             UPDATE evidence SET
                 statement = 'Evidence recorded',
                 source_id = '',
                 source_type = 'sanitized';
             UPDATE goals SET title = '[removed]', notes = '';
             UPDATE skill_ratings SET note = '';
             UPDATE meta SET value = value || ' (sanitized)' WHERE key = 'name';
             UPDATE meta SET value = '' WHERE key = 'description';
             DELETE FROM search_fts;
             INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
                 SELECT 'student', id, display_name, '', id, '' FROM students WHERE deleted_at IS NULL;
             INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
                 SELECT 'session', id, title, subject, COALESCE(student_id, ''), id
                 FROM sessions WHERE deleted_at IS NULL;
             INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
                 SELECT 'guide', id, title, body, COALESCE(student_id, ''),
                        COALESCE(session_id, '') FROM guides WHERE deleted_at IS NULL;
             INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
                 SELECT 'evidence', id, kind, statement, COALESCE(student_id, ''),
                        COALESCE(session_id, '') FROM evidence WHERE deleted_at IS NULL;
             COMMIT;
             VACUUM;",
        )
        .map_err(|error| format!("Could not sanitize the workspace copy: {error}"))?;
    let integrity = backup::integrity_check(&target)?;
    if integrity != "ok" {
        return Err(format!(
            "The sanitized copy failed its integrity check: {integrity}"
        ));
    }
    let bytes = std::fs::metadata(destination)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(result.bytes);
    Ok(BackupResult {
        path: result.path,
        bytes,
    })
}
