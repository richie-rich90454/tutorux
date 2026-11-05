pub mod backup;
pub mod blob;
pub mod content;
pub mod materials;
pub mod models;
pub mod recordings;
pub mod repo;
pub mod schedule;
pub mod schema;
pub mod search;
pub mod settings;
pub mod today;
pub mod trash;

#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use rusqlite::Connection;
use tauri::{State, WebviewWindow};
use zeroize::Zeroizing;

use models::*;

pub struct WorkspaceDb {
    pub path: PathBuf,
    pub conn: Connection,
    pub key: Option<Zeroizing<String>>,
}

#[derive(Default)]
pub struct WorkspaceState(pub Mutex<Option<WorkspaceDb>>);

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Workspace access is only available from the main window.".to_owned());
    }
    Ok(())
}

fn ensure_extension(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("tutor"))
    {
        Ok(())
    } else {
        Err("Tutorux workspaces must use the .tutor extension.".to_owned())
    }
}

fn with_db<T>(
    state: &State<'_, WorkspaceState>,
    action: impl FnOnce(&mut WorkspaceDb) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_owned())?;
    let db = guard
        .as_mut()
        .ok_or_else(|| "Open or create a workspace first.".to_owned())?;
    action(db)
}

fn with_conn<T>(
    state: &State<'_, WorkspaceState>,
    action: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    with_db(state, |db| action(&db.conn))
}

fn set_key(conn: &Connection, key: &str) -> Result<(), String> {
    conn.pragma_update(None, "key", key)
        .map_err(|_| "The workspace encryption key could not be applied.".to_owned())
}

fn database_has_plain_sqlite_header(path: &Path) -> bool {
    let mut header = [0u8; 16];
    std::fs::File::open(path)
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut header))
        .map(|()| &header == b"SQLite format 3\0")
        .unwrap_or(false)
}

fn verify_readable(conn: &Connection) -> Result<(), String> {
    conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })
    .map(|_| ())
    .map_err(|_| {
        "The workspace could not be opened. Check the passphrase and try again.".to_owned()
    })
}

#[tauri::command]
pub fn workspace_create(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    path: String,
    name: String,
    description: String,
    passphrase: Option<String>,
) -> Result<WorkspaceSummary, String> {
    main_window(&window)?;
    let path = PathBuf::from(path);
    ensure_extension(&path)?;
    if path.exists() {
        return Err(
            "A file already exists at that location. Choose a new workspace file.".to_owned(),
        );
    }
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            return Err("The selected folder does not exist.".to_owned());
        }
    }
    let passphrase = passphrase.filter(|value| !value.trim().is_empty());
    if passphrase.as_ref().is_some_and(|value| value.len() < 12) {
        return Err("Use a passphrase of at least 12 characters.".to_owned());
    }
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_owned())?;
    let conn = Connection::open(&path)
        .map_err(|error| format!("Could not create the workspace file: {error}"))?;
    if let Some(key) = passphrase.as_deref() {
        set_key(&conn, key)?;
    }
    repo::apply_connection_pragmas(&conn)?;
    repo::initialize_workspace(&conn, name.trim(), description.trim(), passphrase.is_some())?;
    let summary = repo::workspace_summary(&conn, &path)?;
    *guard = Some(WorkspaceDb {
        path,
        conn,
        key: passphrase.map(Zeroizing::new),
    });
    Ok(summary)
}

#[tauri::command]
pub fn workspace_open(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    path: String,
    passphrase: Option<String>,
) -> Result<WorkspaceSummary, String> {
    main_window(&window)?;
    let path = PathBuf::from(path);
    ensure_extension(&path)?;
    if !path.is_file() {
        return Err("The selected workspace file does not exist.".to_owned());
    }
    let plain = database_has_plain_sqlite_header(&path);
    let passphrase = passphrase.filter(|value| !value.trim().is_empty());
    if !plain && passphrase.is_none() {
        return Err("This workspace is encrypted. Enter its passphrase to open it.".to_owned());
    }
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_owned())?;
    let conn = Connection::open(&path)
        .map_err(|error| format!("Could not open the workspace: {error}"))?;
    if let Some(key) = passphrase.as_deref() {
        set_key(&conn, key)?;
    }
    verify_readable(&conn)?;
    repo::apply_connection_pragmas(&conn)?;
    repo::verify_workspace_identity(&conn)?;
    let summary = repo::workspace_summary(&conn, &path)?;
    if let Some(previous) = guard.take() {
        let _ = previous
            .conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    *guard = Some(WorkspaceDb {
        path,
        conn,
        key: passphrase.map(Zeroizing::new),
    });
    Ok(summary)
}

#[tauri::command]
pub fn workspace_close(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    main_window(&window)?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "The workspace state is unavailable.".to_owned())?;
    if let Some(db) = guard.take() {
        db.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|error| format!("Could not close the workspace cleanly: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_summary(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<WorkspaceSummary, String> {
    main_window(&window)?;
    with_db(&state, |db| repo::workspace_summary(&db.conn, &db.path))
}

#[tauri::command]
pub fn workspace_rename(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    name: String,
    description: String,
) -> Result<WorkspaceSummary, String> {
    main_window(&window)?;
    with_db(&state, |db| {
        settings::rename_workspace(&db.conn, &name, &description)?;
        repo::workspace_summary(&db.conn, &db.path)
    })
}

#[tauri::command]
pub fn workspace_rekey(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    new_passphrase: String,
) -> Result<WorkspaceSummary, String> {
    main_window(&window)?;
    if new_passphrase.len() < 12 {
        return Err("Use a passphrase of at least 12 characters.".to_owned());
    }
    with_db(&state, |db| {
        if db.key.is_none() {
            return Err("This workspace is not encrypted.".to_owned());
        }
        db.conn
            .pragma_update(None, "rekey", &new_passphrase)
            .map_err(|_| "The workspace passphrase could not be changed.".to_owned())?;
        db.key = Some(Zeroizing::new(new_passphrase));
        repo::workspace_summary(&db.conn, &db.path)
    })
}

#[tauri::command]
pub fn today_data(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<TodayData, String> {
    main_window(&window)?;
    with_db(&state, |db| today::today_data(&mut db.conn, &db.path))
}

#[tauri::command]
pub fn students_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    query: String,
) -> Result<Vec<Student>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| repo::list_students(conn, &query))
}

#[tauri::command]
pub fn student_get(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<Student, String> {
    main_window(&window)?;
    with_conn(&state, |conn| repo::get_student(conn, &id))
}

#[tauri::command]
pub fn student_create(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    input: StudentInput,
) -> Result<Student, String> {
    main_window(&window)?;
    with_conn(&state, |conn| repo::create_student(conn, &input))
}

#[tauri::command]
pub fn student_update(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
    input: StudentInput,
) -> Result<Student, String> {
    main_window(&window)?;
    with_conn(&state, |conn| repo::update_student(conn, &id, &input))
}

#[tauri::command]
pub fn student_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| repo::delete_student(conn, &id))
}

#[tauri::command]
pub fn student_detail(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<StudentDetail, String> {
    main_window(&window)?;
    with_conn(&state, |conn| today::student_detail(conn, &id))
}

#[tauri::command]
pub fn sessions_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    student_id: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<Session>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        repo::list_sessions(
            conn,
            student_id.as_deref(),
            status.as_deref(),
            limit.unwrap_or(500),
        )
    })
}

#[tauri::command]
pub fn session_get(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<Session, String> {
    main_window(&window)?;
    with_conn(&state, |conn| repo::get_session(conn, &id))
}

#[tauri::command]
pub fn session_create(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    input: SessionInput,
) -> Result<Session, String> {
    main_window(&window)?;
    with_conn(&state, |conn| repo::create_session(conn, &input))
}

#[tauri::command]
pub fn session_update(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
    input: SessionInput,
) -> Result<Session, String> {
    main_window(&window)?;
    with_conn(&state, |conn| repo::update_session(conn, &id, &input))
}

#[tauri::command]
pub fn session_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| repo::delete_session(conn, &id))
}

#[tauri::command]
pub fn session_start(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<Session, String> {
    main_window(&window)?;
    with_db(&state, |db| {
        schedule::start_scheduled_session(&mut db.conn, &id)
    })
}

#[tauri::command]
pub fn session_detail(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<SessionDetail, String> {
    main_window(&window)?;
    with_conn(&state, |conn| today::session_detail(conn, &id))
}

#[tauri::command]
pub fn schedule_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    from: Option<i64>,
    to: Option<i64>,
) -> Result<Vec<ScheduleEvent>, String> {
    main_window(&window)?;
    with_db(&state, |db| {
        schedule::materialize_sessions(&mut db.conn)?;
        schedule::list_schedule(&db.conn, from, to, 1000)
    })
}

#[tauri::command]
pub fn schedule_create(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    input: ScheduleInput,
) -> Result<ScheduleEvent, String> {
    main_window(&window)?;
    with_db(&state, |db| schedule::create_schedule(&mut db.conn, &input))
}

#[tauri::command]
pub fn schedule_update(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
    input: ScheduleInput,
) -> Result<ScheduleEvent, String> {
    main_window(&window)?;
    with_db(&state, |db| {
        schedule::update_schedule(&mut db.conn, &id, &input)
    })
}

#[tauri::command]
pub fn schedule_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| schedule::delete_schedule(conn, &id))
}

#[tauri::command]
pub fn journal_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    session_id: Option<String>,
) -> Result<Vec<JournalEntry>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        content::list_journal(conn, session_id.as_deref().unwrap_or(""))
    })
}

#[tauri::command]
pub fn journal_create(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    input: JournalInput,
) -> Result<JournalEntry, String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::create_journal(conn, &input))
}

#[tauri::command]
pub fn journal_update(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
    input: JournalInput,
) -> Result<JournalEntry, String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::update_journal(conn, &id, &input))
}

#[tauri::command]
pub fn journal_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::delete_journal(conn, &id))
}

#[tauri::command]
pub fn observations_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    session_id: Option<String>,
) -> Result<Vec<Observation>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        content::list_observations(conn, session_id.as_deref().unwrap_or(""))
    })
}

#[tauri::command]
pub fn observation_create(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    input: ObservationInput,
) -> Result<Observation, String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::create_observation(conn, &input))
}

#[tauri::command]
pub fn observation_update(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
    input: ObservationInput,
) -> Result<Observation, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        content::update_observation(conn, &id, &input)
    })
}

#[tauri::command]
pub fn observation_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::delete_observation(conn, &id))
}

#[tauri::command]
pub fn cues_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    session_id: String,
    limit: Option<i64>,
) -> Result<Vec<TranscriptCue>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        content::list_cues(conn, &session_id, limit.unwrap_or(10_000))
    })
}

#[tauri::command]
pub fn cue_create(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    input: TranscriptCueInput,
) -> Result<TranscriptCue, String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::create_cue(conn, &input))
}

#[tauri::command]
pub fn cue_update(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
    input: TranscriptCueInput,
) -> Result<TranscriptCue, String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::update_cue(conn, &id, &input))
}

#[tauri::command]
pub fn cue_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::delete_cue(conn, &id))
}

#[tauri::command]
pub fn materials_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    session_id: Option<String>,
    student_id: Option<String>,
    query: Option<String>,
) -> Result<Vec<Material>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        materials::list_materials(
            conn,
            session_id.as_deref().unwrap_or(""),
            student_id.as_deref().unwrap_or(""),
            query.as_deref().unwrap_or(""),
        )
    })
}

#[tauri::command]
pub fn material_import(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    path: String,
    session_id: Option<String>,
    student_id: Option<String>,
) -> Result<Material, String> {
    main_window(&window)?;
    with_db(&state, |db| {
        materials::import_material_file(&mut db.conn, &path, session_id, student_id)
    })
}

#[tauri::command]
pub fn material_link(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    input: LinkInput,
) -> Result<Material, String> {
    main_window(&window)?;
    with_conn(&state, |conn| materials::create_link(conn, &input))
}

#[tauri::command]
pub fn material_update(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
    title: String,
    notes: String,
) -> Result<Material, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        materials::update_material(conn, &id, &title, &notes)
    })
}

#[tauri::command]
pub fn material_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| materials::delete_material(conn, &id))
}

#[tauri::command]
pub fn material_read(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
    maximum_bytes: Option<usize>,
) -> Result<Vec<u8>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        materials::read_material(conn, &id, maximum_bytes.unwrap_or(64 * 1024 * 1024))
    })
}

#[tauri::command]
pub fn recordings_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    session_id: String,
) -> Result<Vec<Recording>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        recordings::list_recordings(conn, &session_id)
    })
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri provides command inputs and injected window/state handles as individual parameters."
)]
pub fn recording_import(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    session_id: String,
    title: String,
    source: String,
    sample_rate: i64,
    channels: i64,
    duration_us: i64,
    bytes: Vec<u8>,
) -> Result<Recording, String> {
    main_window(&window)?;
    with_db(&state, |db| {
        recordings::import_recording(
            &mut db.conn,
            &session_id,
            &title,
            &source,
            sample_rate,
            channels,
            duration_us,
            &bytes,
        )
    })
}

#[tauri::command]
pub fn recording_read(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<Vec<u8>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| recordings::read_recording(conn, &id))
}

#[tauri::command]
pub fn recording_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| recordings::delete_recording(conn, &id))
}

#[tauri::command]
pub fn guides_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    student_id: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<Guide>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        content::list_guides(
            conn,
            student_id.as_deref().unwrap_or(""),
            session_id.as_deref().unwrap_or(""),
        )
    })
}

#[tauri::command]
pub fn guide_get(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<Guide, String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::get_guide(conn, &id))
}

#[tauri::command]
pub fn guide_create(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    input: GuideInput,
) -> Result<Guide, String> {
    main_window(&window)?;
    with_db(&state, |db| content::create_guide(&mut db.conn, &input))
}

#[tauri::command]
pub fn guide_update(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
    input: GuideInput,
) -> Result<Guide, String> {
    main_window(&window)?;
    with_db(&state, |db| {
        content::update_guide(&mut db.conn, &id, &input)
    })
}

#[tauri::command]
pub fn guide_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::delete_guide(conn, &id))
}

#[tauri::command]
pub fn evidence_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    student_id: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<Evidence>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        content::list_evidence(
            conn,
            student_id.as_deref().unwrap_or(""),
            session_id.as_deref().unwrap_or(""),
        )
    })
}

#[tauri::command]
pub fn evidence_create(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    input: EvidenceInput,
) -> Result<Evidence, String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::create_evidence(conn, &input))
}

#[tauri::command]
pub fn evidence_update(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
    input: EvidenceInput,
) -> Result<Evidence, String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::update_evidence(conn, &id, &input))
}

#[tauri::command]
pub fn evidence_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::delete_evidence(conn, &id))
}

#[tauri::command]
pub fn goals_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    student_id: String,
) -> Result<Vec<Goal>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::list_goals(conn, &student_id))
}

#[tauri::command]
pub fn goal_upsert(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: Option<String>,
    input: GoalInput,
) -> Result<Goal, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        content::upsert_goal(conn, id.as_deref(), &input)
    })
}

#[tauri::command]
pub fn goal_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::delete_goal(conn, &id))
}

#[tauri::command]
pub fn skills_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    student_id: String,
) -> Result<Vec<SkillRating>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::list_skills(conn, &student_id))
}

#[tauri::command]
pub fn skill_upsert(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: Option<String>,
    input: SkillRatingInput,
) -> Result<SkillRating, String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        content::upsert_skill(conn, id.as_deref(), &input)
    })
}

#[tauri::command]
pub fn skill_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| content::delete_skill(conn, &id))
}

#[tauri::command]
pub fn search_global(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    main_window(&window)?;
    with_conn(&state, |conn| search::search(conn, &query, 60))
}

#[tauri::command]
pub fn trash_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<TrashItem>, String> {
    main_window(&window)?;
    with_conn(&state, trash::list_trash)
}

#[tauri::command]
pub fn trash_restore(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    entity_type: String,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| trash::restore_trash(conn, &entity_type, &id))
}

#[tauri::command]
pub fn trash_delete(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    entity_type: String,
    id: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| {
        trash::delete_trash_item(conn, &entity_type, &id)
    })
}

#[tauri::command]
pub fn trash_empty(window: WebviewWindow, state: State<'_, WorkspaceState>) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, trash::empty_trash)
}

#[tauri::command]
pub fn trash_purge_expired(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<usize, String> {
    main_window(&window)?;
    with_conn(&state, trash::purge_expired)
}

#[tauri::command]
pub fn settings_all(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<HashMap<String, String>, String> {
    main_window(&window)?;
    with_conn(&state, settings::all_settings)
}

#[tauri::command]
pub fn setting_set(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    key: String,
    value: String,
) -> Result<(), String> {
    main_window(&window)?;
    with_conn(&state, |conn| settings::set_setting(conn, &key, &value))
}

#[tauri::command]
pub fn backup_create(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    path: String,
) -> Result<BackupResult, String> {
    main_window(&window)?;
    with_db(&state, |db| {
        backup::backup_workspace(&db.conn, &path, db.key.as_deref().map(String::as_str))
    })
}

#[tauri::command]
pub fn workspace_check(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<String, String> {
    main_window(&window)?;
    with_conn(&state, backup::integrity_check)
}
