use rusqlite::{params, Connection};

use super::models::{now_ms, Reminder};

pub fn due_reminders(conn: &Connection, lead_minutes: i64) -> Result<Vec<Reminder>, String> {
    let lead_minutes = lead_minutes.clamp(0, 24 * 60);
    let now = now_ms();
    let until = now + lead_minutes * 60_000;
    let mut statement = conn
        .prepare(
            "SELECT id, 'schedule', title, COALESCE(student_name, ''), start_at FROM (
                 SELECT e.id, e.title, s.display_name AS student_name, e.start_at
                 FROM schedule_events e
                 LEFT JOIN students s ON s.id = e.student_id
                 WHERE e.deleted_at IS NULL AND e.start_at BETWEEN ?1 AND ?2
             )
             UNION ALL
             SELECT id, 'session', title, COALESCE(student_name, ''), start_at FROM (
                 SELECT s.id, s.title, st.display_name AS student_name,
                        COALESCE(s.scheduled_at, s.started_at) AS start_at
                 FROM sessions s
                 LEFT JOIN students st ON st.id = s.student_id
                 WHERE s.deleted_at IS NULL AND s.status = 'planned'
                   AND s.schedule_event_id IS NULL
                   AND COALESCE(s.scheduled_at, s.started_at) BETWEEN ?1 AND ?2
             )
             ORDER BY start_at",
        )
        .map_err(|error| format!("Could not read reminders: {error}"))?;
    let rows = statement
        .query_map(params![now, until], |row| {
            let start_at: i64 = row.get(4)?;
            Ok(Reminder {
                id: row.get(0)?,
                entity_type: row.get(1)?,
                title: row.get(2)?,
                student_name: row.get(3)?,
                start_at,
                minutes_until: ((start_at - now) / 60_000).max(0),
            })
        })
        .map_err(|error| format!("Could not read reminders: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read reminders: {error}"))
}
