use chrono::{Datelike, Duration, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::{
    models::{now_ms, ScheduleConflict, ScheduleEvent, ScheduleInput},
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
        recurrence_interval: row.get(8)?,
        recurrence_until: row.get(9)?,
        location: row.get(10)?,
        notes: row.get(11)?,
        calendar_provider: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

const SCHEDULE_SELECT: &str = "SELECT e.id, e.student_id, COALESCE(s.display_name, ''), e.title,
    e.subject, e.start_at, e.duration_min, e.recurrence, e.recurrence_interval,
    e.recurrence_until, e.location, e.notes, e.calendar_provider, e.created_at, e.updated_at
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
    let (recurrence, interval, until) = validated_recurrence(input)?;
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not start the schedule update: {error}"))?;
    transaction
        .execute(
            "INSERT INTO schedule_events (id, student_id, title, subject, start_at, duration_min,
             recurrence, recurrence_interval, recurrence_until, location, notes, calendar_provider,
             created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'internal', ?12, ?12)",
            params![
                id,
                input.student_id,
                title,
                input.subject.trim(),
                input.start_at,
                input.duration_min,
                recurrence,
                interval,
                until,
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
    if input.duration_min < 5 || input.duration_min > 720 {
        return Err("Lesson duration must be between 5 minutes and 12 hours.".to_owned());
    }
    let (recurrence, interval, until) = validated_recurrence(input)?;
    let now = now_ms();
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not start the schedule update: {error}"))?;
    let changed = transaction
        .execute(
            "UPDATE schedule_events SET student_id = ?2, title = ?3, subject = ?4, start_at = ?5,
             duration_min = ?6, recurrence = ?7, recurrence_interval = ?8, recurrence_until = ?9,
             location = ?10, notes = ?11, updated_at = ?12
             WHERE id = ?1 AND deleted_at IS NULL",
            params![
                id,
                input.student_id,
                title,
                input.subject.trim(),
                input.start_at,
                input.duration_min,
                recurrence,
                interval,
                until,
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

fn validated_recurrence(input: &ScheduleInput) -> Result<(&str, i64, Option<i64>), String> {
    if !(1..=52).contains(&input.recurrence_interval) {
        return Err("Repeat interval must be between 1 and 52.".to_owned());
    }
    let recurrence = normalized_recurrence(&input.recurrence);
    let until = if recurrence.is_empty() {
        None
    } else {
        input.recurrence_until
    };
    if until.is_some_and(|limit| limit < input.start_at) {
        return Err("The repeat end date cannot be before the lesson starts.".to_owned());
    }
    Ok((recurrence, input.recurrence_interval, until))
}

fn occurrence(
    start_ms: i64,
    recurrence: &str,
    interval: i64,
    until: Option<i64>,
    index: u32,
) -> Option<i64> {
    if recurrence.is_empty() {
        return (index == 0).then_some(start_ms);
    }
    let start = Utc.timestamp_millis_opt(start_ms).single()?;
    let step = index as i32 * interval.max(1) as i32;
    let slot = match recurrence {
        "daily" => (start + Duration::days(i64::from(step))).timestamp_millis(),
        "weekly" => (start + Duration::weeks(i64::from(step))).timestamp_millis(),
        "biweekly" => (start + Duration::weeks(i64::from(step) * 2)).timestamp_millis(),
        "monthly" => {
            let total_month = start.month0() as i32 + step;
            let year = start.year() + total_month / 12;
            let month = (total_month % 12) as u32 + 1;
            let day = start.day();
            let date = chrono::NaiveDate::from_ymd_opt(year, month, day)
                .or_else(|| chrono::NaiveDate::from_ymd_opt(year, month, 28))?;
            let time = start.time();
            Utc.from_utc_datetime(&date.and_time(time))
                .timestamp_millis()
        }
        _ => return None,
    };
    if until.is_some_and(|limit| slot > limit) {
        return None;
    }
    Some(slot)
}

pub fn find_conflicts(
    conn: &Connection,
    input: &ScheduleInput,
    ignore_id: Option<&str>,
) -> Result<Vec<ScheduleConflict>, String> {
    if input.duration_min < 5 || input.duration_min > 720 {
        return Err("Lesson duration must be between 5 minutes and 12 hours.".to_owned());
    }
    let (recurrence, interval, until) = validated_recurrence(input)?;
    let horizon = input.start_at + Duration::weeks(26).num_milliseconds();
    let mut input_slots = Vec::new();
    for index in 0..64 {
        let Some(slot) = occurrence(input.start_at, recurrence, interval, until, index) else {
            break;
        };
        if slot > horizon {
            break;
        }
        input_slots.push(slot);
    }
    let duration_ms = input.duration_min * 60_000;
    let mut statement = conn
        .prepare(
            "SELECT id, student_id, COALESCE((SELECT display_name FROM students s
                WHERE s.id = e.student_id), ''), title, start_at, duration_min, recurrence,
                recurrence_interval, recurrence_until
             FROM schedule_events e
             WHERE e.deleted_at IS NULL AND e.start_at <= ?1
             ORDER BY e.start_at ASC LIMIT 2000",
        )
        .map_err(|error| format!("Could not read the schedule: {error}"))?;
    let rows = statement
        .query_map(params![horizon], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<i64>>(8)?,
            ))
        })
        .map_err(|error| format!("Could not read the schedule: {error}"))?;
    let mut conflicts = Vec::new();
    for row in rows {
        let (
            event_id,
            student_id,
            student_name,
            title,
            start_at,
            duration,
            event_recurrence,
            event_interval,
            event_until,
        ) = row.map_err(|error| format!("Could not read the schedule: {error}"))?;
        if ignore_id == Some(event_id.as_str()) {
            continue;
        }
        let event_horizon = horizon.max(start_at);
        for index in 0..64 {
            let Some(event_start) = occurrence(
                start_at,
                &event_recurrence,
                event_interval,
                event_until,
                index,
            ) else {
                break;
            };
            if event_start > event_horizon {
                break;
            }
            let event_end = event_start + duration * 60_000;
            let overlaps = input_slots.iter().any(|slot| {
                let slot_end = slot + duration_ms;
                *slot < event_end && event_start < slot_end
            });
            if overlaps {
                conflicts.push(ScheduleConflict {
                    event_id,
                    title,
                    student_name,
                    start_at: event_start,
                    end_at: event_end,
                    same_student: input.student_id.is_some() && input.student_id == student_id,
                });
                break;
            }
        }
    }
    conflicts.sort_by_key(|conflict| conflict.start_at);
    Ok(conflicts)
}

pub fn materialize_sessions(conn: &mut Connection) -> Result<(), String> {
    let events: Vec<(String, i64, String, i64, Option<i64>)> = {
        let mut statement = conn
            .prepare(
                "SELECT id, start_at, recurrence, recurrence_interval, recurrence_until
                 FROM schedule_events WHERE deleted_at IS NULL AND recurrence != ''",
            )
            .map_err(|error| format!("Could not read recurring lessons: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .map_err(|error| format!("Could not read recurring lessons: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Could not read recurring lessons: {error}"))?
    };
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not expand recurring lessons: {error}"))?;
    let horizon = now_ms() + Duration::weeks(12).num_milliseconds();
    for (event_id, start_at, recurrence, interval, until) in events {
        for index in 0..64 {
            let Some(slot) = occurrence(start_at, &recurrence, interval, until, index) else {
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
    let (start_at, recurrence, interval, until): (i64, String, i64, Option<i64>) = conn
        .query_row(
            "SELECT start_at, recurrence, recurrence_interval, recurrence_until
             FROM schedule_events WHERE id = ?1 AND deleted_at IS NULL",
            params![event_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| format!("Could not read the scheduled lesson: {error}"))?;
    if recurrence.is_empty() {
        insert_scheduled_session(conn, event_id, start_at)?;
        return Ok(());
    }
    let horizon = now_ms() + Duration::weeks(12).num_milliseconds();
    for index in 0..64 {
        let Some(slot) = occurrence(start_at, &recurrence, interval, until, index) else {
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
