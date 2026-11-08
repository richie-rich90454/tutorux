use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use super::{
    content::{
        list_cues, list_evidence, list_goals, list_guides, list_journal, list_observations,
        list_skills,
    },
    materials::list_materials,
    models::{now_ms, SessionDetail, StudentDetail, TodayData},
    recordings::list_recordings,
    repo::{
        get_session, get_student, list_recent_sessions, list_sessions, list_students,
        list_upcoming_sessions, workspace_summary,
    },
    schedule::{list_schedule, materialize_sessions},
};

pub fn today_data(conn: &mut Connection, path: &Path) -> Result<TodayData, String> {
    materialize_sessions(conn)?;
    let now = now_ms();
    let workspace = workspace_summary(conn, path)?;
    let upcoming = list_schedule(conn, Some(now - 3_600_000), Some(now + 7 * 86_400_000), 50)?;
    let upcoming_sessions =
        list_upcoming_sessions(conn, now - 3_600_000, now + 7 * 86_400_000, 50)?;
    let recent_sessions = list_recent_sessions(conn, now, 8)?;
    let students = list_students(conn, "")?;
    let unfinished_session = recent_sessions
        .iter()
        .find(|session| session.status == "active")
        .cloned();
    let backup_last_at = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'backup_last_at'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|value| value.parse::<i64>().ok());
    Ok(TodayData {
        workspace,
        upcoming,
        upcoming_sessions,
        recent_sessions,
        students,
        unfinished_session,
        backup_last_at,
    })
}

pub fn student_detail(conn: &Connection, id: &str) -> Result<StudentDetail, String> {
    let student = get_student(conn, id)?;
    Ok(StudentDetail {
        sessions: list_sessions(conn, Some(id), None, 500)?,
        goals: list_goals(conn, id)?,
        skills: list_skills(conn, id)?,
        evidence: list_evidence(conn, id, "")?,
        materials: list_materials(conn, "", id, "")?,
        guides: list_guides(conn, id, "")?,
        student,
    })
}

pub fn session_detail(conn: &Connection, id: &str) -> Result<SessionDetail, String> {
    let session = get_session(conn, id)?;
    Ok(SessionDetail {
        journal: list_journal(conn, id)?,
        observations: list_observations(conn, id)?,
        materials: list_materials(conn, id, "", "")?,
        recordings: list_recordings(conn, id)?,
        cues: list_cues(conn, id, 10_000)?,
        guides: list_guides(conn, "", id)?,
        evidence: list_evidence(conn, "", id)?,
        session,
    })
}
