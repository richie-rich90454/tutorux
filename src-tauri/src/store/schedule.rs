use chrono::{Datelike, Duration, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::{
    models::{now_ms, ScheduleEvent, ScheduleInput},
    repo::{get_session, reindex_public, touch_workspace_public},
};

fn schedule_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduleEvent> {
    Ok(ScheduleEvent {
        id: row.get(0)?,
        student_id: row.get(1)?,
        student_name: row.get(2)?,
        title: row.get(3)?,
        subject: row.get(4)?,
        start_at: row.get(5)?,
        duration_min: row.get(6)?,
        recurrence: row.get(7)?,
        location: row.get(8)?,
        notes: row.get(9)?,
        calendar_provider: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

const SCHEDULE_SELECT: &str = "SELECT e.id, e.student_id, COALESCE(s.display_name, ''), e.title,
    e.subject, e.start_at, e.duration_min, e.recurrence, e.location, e.notes,
    e.calendar_provider, e.created_at, e.updated_at
    FROM schedule_events e LEFT JOIN students s ON s.id = e.student_id";

pub fn list_schedule(
    conn: &Connection,
    from: Option<i64>,
    to: Option<i64>,
    limit: i64,
) -> Result<Vec<ScheduleEvent>, String> {
    let from = from.unwrap_or(0);
    let to = to.unwrap_or(i64::MAX / 2);
    let mut statement = conn
        .prepare(&format!(
            "{SCHEDULE_SELECT}
             WHERE e.deleted_at IS NULL AND e.start_at >= ?1 AND e.start_at <= ?2
             ORDER BY e.start_at ASC LIMIT ?3"
        ))
        .map_err(|error| format!("Could not read the schedule: {error}"))?;
    let rows = statement
        .query_map(params![from, to, limit.clamp(1, 2000)], schedule_row)
        .map_err(|error| format!("Could not read the schedule: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read the schedule: {error}"))
}

pub fn get_schedule(conn: &Connection, id: &str) -> Result<ScheduleEvent, String> {
    conn.query_row(
        &format!("{SCHEDULE_SELECT} WHERE e.id = ?1 AND e.deleted_at IS NULL"),
        params![id],
        schedule_row,
    )
    .optional()
    .map_err(|error| format!("Could not read the scheduled lesson: {error}"))?
    .ok_or_else(|| "The scheduled lesson could not be found.".to_owned())
}

pub fn create_schedule(
    conn: &mut Connection,
    input: &ScheduleInput,
) -> Result<ScheduleEvent, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Enter a title for the scheduled lesson.".to_owned());
    }
    if input.duration_min < 5 || input.duration_min > 720 {
        return Err("Lesson duration must be between 5 minutes and 12 hours.".to_owned());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let recurrence = normalized_recurrence(&input.recurrence);
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not start the schedule update: {error}"))?;
    transaction
        .execute(
            "INSERT INTO schedule_events (id, student_id, title, subject, start_at, duration_min,
             recurrence, location, notes, calendar_provider, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'internal', ?10, ?10)",
            params![
                id,
                input.student_id,
                title,
                input.subject.trim(),
                input.start_at,
                input.duration_min,
                recurrence,
                input.location.trim(),
                input.notes.trim(),
                now
            ],
        )
        .map_err(|error| format!("Could not create the scheduled lesson: {error}"))?;
    materialize_event(&transaction, &id)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not save the scheduled lesson: {error}"))?;
    touch_workspace_public(conn)?;
    get_schedule(conn, &id)
}

pub fn update_schedule(
    conn: &mut Connection,
    id: &str,
    input: &ScheduleInput,
) -> Result<ScheduleEvent, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Enter a title for the scheduled lesson.".to_owned());
    }
    let recurrence = normalized_recurrence(&input.recurrence);
    let now = now_ms();
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not start the schedule update: {error}"))?;
    let changed = transaction
        .execute(
            "UPDATE schedule_events SET student_id = ?2, title = ?3, subject = ?4, start_at = ?5,
             duration_min = ?6, recurrence = ?7, location = ?8, notes = ?9, updated_at = ?10
             WHERE id = ?1 AND deleted_at IS NULL",
            params![
                id,
                input.student_id,
                title,
                input.subject.trim(),
                input.start_at,
                input.duration_min,
                recurrence,
                input.location.trim(),
                input.notes.trim(),
                now
            ],
        )
        .map_err(|error| format!("Could not update the scheduled lesson: {error}"))?;
    if changed == 0 {
        return Err("The scheduled lesson could not be found.".to_owned());
    }
    transaction
        .execute(
            "DELETE FROM sessions WHERE schedule_event_id = ?1 AND deleted_at IS NULL
             AND COALESCE(started_at, ended_at) IS NULL",
            params![id],
        )
        .map_err(|error| format!("Could not refresh future sessions: {error}"))?;
    materialize_event(&transaction, id)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not save the scheduled lesson: {error}"))?;
    touch_workspace_public(conn)?;
    get_schedule(conn, id)
}

pub fn delete_schedule(conn: &Connection, id: &str) -> Result<(), String> {
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE schedule_events SET deleted_at = ?2, updated_at = ?2
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now],
        )
        .map_err(|error| format!("Could not cancel the scheduled lesson: {error}"))?;
    if changed == 0 {
        return Err("The scheduled lesson could not be found.".to_owned());
    }
    conn.execute(
        "UPDATE sessions SET deleted_at = ?2 WHERE schedule_event_id = ?1
         AND deleted_at IS NULL AND COALESCE(started_at, ended_at) IS NULL",
        params![id, now],
    )
    .map_err(|error| format!("Could not remove future sessions: {error}"))?;
    touch_workspace_public(conn)?;
    Ok(())
}

fn normalized_recurrence(value: &str) -> &str {
    match value {
        "daily" | "weekly" | "biweekly" | "monthly" => value,
        _ => "",
    }
}

fn occurrence(start_ms: i64, recurrence: &str, index: u32) -> Option<i64> {
    if index == 0 {
        return Some(start_ms);
    }
    let start = Utc.timestamp_millis_opt(start_ms).single()?;
    match recurrence {
        "daily" => Some((start + Duration::days(i64::from(index))).timestamp_millis()),
        "weekly" => Some((start + Duration::weeks(i64::from(index))).timestamp_millis()),
        "biweekly" => Some((start + Duration::weeks(i64::from(index) * 2)).timestamp_millis()),
        "monthly" => {
            let total_month = start.month0() as i32 + index as i32;
            let year = start.year() + total_month / 12;
            let month = (total_month % 12) as u32 + 1;
            let day = start.day();
            let date = chrono::NaiveDate::from_ymd_opt(year, month, day)
                .or_else(|| chrono::NaiveDate::from_ymd_opt(year, month, 28))?;
            let time = start.time();
            Some(
                Utc.from_utc_datetime(&date.and_time(time))
                    .timestamp_millis(),
            )
        }
        _ => None,
    }
}

pub fn materialize_sessions(conn: &mut Connection) -> Result<(), String> {
    let events: Vec<(String, i64, String)> = {
        let mut statement = conn
            .prepare(
                "SELECT id, start_at, recurrence FROM schedule_events
                 WHERE deleted_at IS NULL AND recurrence != ''",
            )
            .map_err(|error| format!("Could not read recurring lessons: {error}"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|error| format!("Could not read recurring lessons: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Could not read recurring lessons: {error}"))?
    };
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not expand recurring lessons: {error}"))?;
    let horizon = now_ms() + Duration::weeks(12).num_milliseconds();
    for (event_id, start_at, recurrence) in events {
        for index in 0..64 {
            let Some(slot) = occurrence(start_at, &recurrence, index) else {
                break;
            };
            if slot > horizon {
                break;
            }
            if slot < now_ms() - Duration::days(2).num_milliseconds() {
                continue;
            }
            insert_scheduled_session(&transaction, &event_id, slot)?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not expand recurring lessons: {error}"))
}

fn materialize_event(conn: &Connection, event_id: &str) -> Result<(), String> {
    let (start_at, recurrence): (i64, String) = conn
        .query_row(
            "SELECT start_at, recurrence FROM schedule_events WHERE id = ?1 AND deleted_at IS NULL",
            params![event_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Could not read the scheduled lesson: {error}"))?;
    if recurrence.is_empty() {
        insert_scheduled_session(conn, event_id, start_at)?;
        return Ok(());
    }
    let horizon = now_ms() + Duration::weeks(12).num_milliseconds();
    for index in 0..64 {
        let Some(slot) = occurrence(start_at, &recurrence, index) else {
            break;
        };
        if slot > horizon {
            break;
        }
        insert_scheduled_session(conn, event_id, slot)?;
    }
    Ok(())
}

fn insert_scheduled_session(
    conn: &Connection,
    event_id: &str,
    start_at: i64,
) -> Result<(), String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM sessions WHERE schedule_event_id = ?1 AND scheduled_at = ?2
             AND deleted_at IS NULL",
            params![event_id, start_at],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not check the scheduled session: {error}"))?;
    if existing.is_some() {
        return Ok(());
    }
    let (student_id, title, subject): (Option<String>, String, String) = conn
        .query_row(
            "SELECT student_id, title, subject FROM schedule_events WHERE id = ?1",
            params![event_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Could not read the scheduled lesson: {error}"))?;
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO sessions (id, student_id, schedule_event_id, title, subject, scheduled_at,
         status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'planned', ?7, ?7)",
        params![id, student_id, event_id, title, subject, start_at, now],
    )
    .map_err(|error| format!("Could not create the scheduled session: {error}"))?;
    reindex_public(
        conn,
        "session",
        &id,
        &title,
        &subject,
        student_id.as_deref().unwrap_or(""),
        &id,
    )?;
    Ok(())
}

pub fn start_scheduled_session(
    conn: &mut Connection,
    id: &str,
) -> Result<super::models::Session, String> {
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE sessions SET status = 'active', started_at = COALESCE(started_at, ?2),
             updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now],
        )
        .map_err(|error| format!("Could not start the session: {error}"))?;
    if changed == 0 {
        return Err("The session could not be found.".to_owned());
    }
    touch_workspace_public(conn)?;
    get_session(conn, id)
}
