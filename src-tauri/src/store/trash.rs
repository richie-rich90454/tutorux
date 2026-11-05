use rusqlite::{params, Connection};

use super::{models::TrashItem, repo::touch_workspace_public};

const TRASH_DAYS: i64 = 90;

fn table_for(entity_type: &str) -> Option<&'static str> {
    match entity_type {
        "student" => Some("students"),
        "session" => Some("sessions"),
        "journal" => Some("journal_entries"),
        "observation" => Some("observations"),
        "material" => Some("materials"),
        "guide" => Some("guides"),
        "evidence" => Some("evidence"),
        "schedule" => Some("schedule_events"),
        _ => None,
    }
}

pub fn list_trash(conn: &Connection) -> Result<Vec<TrashItem>, String> {
    let cutoff = super::models::now_ms() - TRASH_DAYS * 86_400_000;
    conn.query_row("SELECT 1", [], |_| Ok(()))
        .map_err(|error| format!("Could not read trash: {error}"))?;
    let sql = "
        SELECT 'student', id, display_name, deleted_at, '', id FROM students
          WHERE deleted_at IS NOT NULL AND deleted_at >= ?1
        UNION ALL
        SELECT 'session', id, title, deleted_at, id, COALESCE(student_id, '') FROM sessions
          WHERE deleted_at IS NOT NULL AND deleted_at >= ?1
        UNION ALL
        SELECT 'journal', id, CASE WHEN title = '' THEN entry_date ELSE title END, deleted_at,
          COALESCE(session_id, ''), COALESCE(student_id, '') FROM journal_entries
          WHERE deleted_at IS NOT NULL AND deleted_at >= ?1
        UNION ALL
        SELECT 'observation', id, title, deleted_at, COALESCE(session_id, ''),
          COALESCE(student_id, '') FROM observations
          WHERE deleted_at IS NOT NULL AND deleted_at >= ?1
        UNION ALL
        SELECT 'material', id, filename, deleted_at, COALESCE(session_id, ''),
          COALESCE(student_id, '') FROM materials
          WHERE deleted_at IS NOT NULL AND deleted_at >= ?1
        UNION ALL
        SELECT 'guide', id, title, deleted_at, COALESCE(session_id, ''),
          COALESCE(student_id, '') FROM guides
          WHERE deleted_at IS NOT NULL AND deleted_at >= ?1
        UNION ALL
        SELECT 'evidence', id, statement, deleted_at, COALESCE(session_id, ''),
          COALESCE(student_id, '') FROM evidence
          WHERE deleted_at IS NOT NULL AND deleted_at >= ?1
        UNION ALL
        SELECT 'schedule', id, title, deleted_at, '',
          COALESCE(student_id, '') FROM schedule_events
          WHERE deleted_at IS NOT NULL AND deleted_at >= ?1
        ORDER BY deleted_at DESC";
    let mut statement = conn
        .prepare(sql)
        .map_err(|error| format!("Could not read trash: {error}"))?;
    let rows = statement
        .query_map(params![cutoff], |row| {
            Ok(TrashItem {
                entity_type: row.get(0)?,
                entity_id: row.get(1)?,
                title: row.get(2)?,
                deleted_at: row.get(3)?,
                session_id: row.get(4)?,
                student_id: row.get(5)?,
            })
        })
        .map_err(|error| format!("Could not read trash: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read trash: {error}"))
}

pub fn restore_trash(conn: &Connection, entity_type: &str, id: &str) -> Result<(), String> {
    let table = table_for(entity_type).ok_or_else(|| "Unknown trash item.".to_owned())?;
    let changed = conn
        .execute(
            &format!(
                "UPDATE {table} SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL"
            ),
            params![id],
        )
        .map_err(|error| format!("Could not restore the item: {error}"))?;
    if changed == 0 {
        return Err("The trash item could not be found.".to_owned());
    }
    touch_workspace_public(conn)?;
    Ok(())
}

pub fn delete_trash_item(conn: &Connection, entity_type: &str, id: &str) -> Result<(), String> {
    let table = table_for(entity_type).ok_or_else(|| "Unknown trash item.".to_owned())?;
    conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])
        .map_err(|error| format!("Could not delete the item permanently: {error}"))?;
    touch_workspace_public(conn)?;
    Ok(())
}

pub fn empty_trash(conn: &Connection) -> Result<(), String> {
    for table in [
        "evidence",
        "guides",
        "materials",
        "observations",
        "journal_entries",
        "sessions",
        "schedule_events",
        "students",
    ] {
        conn.execute(
            &format!("DELETE FROM {table} WHERE deleted_at IS NOT NULL"),
            [],
        )
        .map_err(|error| format!("Could not empty the trash: {error}"))?;
    }
    touch_workspace_public(conn)?;
    Ok(())
}

pub fn purge_expired(conn: &Connection) -> Result<usize, String> {
    let cutoff = super::models::now_ms() - TRASH_DAYS * 86_400_000;
    let mut purged = 0usize;
    for table in [
        "evidence",
        "guides",
        "materials",
        "observations",
        "journal_entries",
        "sessions",
        "schedule_events",
        "students",
    ] {
        purged += conn
            .execute(
                &format!("DELETE FROM {table} WHERE deleted_at IS NOT NULL AND deleted_at < ?1"),
                params![cutoff],
            )
            .map_err(|error| format!("Could not purge expired trash: {error}"))?;
    }
    if purged > 0 {
        touch_workspace_public(conn)?;
    }
    Ok(purged)
}
