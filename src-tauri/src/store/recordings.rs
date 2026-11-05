use rusqlite::{params, Connection};
use uuid::Uuid;

use super::{
    blob::{get_blob, put_blob, CHUNK_SIZE},
    models::{now_ms, Recording},
    repo::touch_workspace_public,
};

fn recording_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Recording> {
    Ok(Recording {
        id: row.get(0)?,
        session_id: row.get(1)?,
        title: row.get(2)?,
        source: row.get(3)?,
        sample_rate: row.get(4)?,
        channels: row.get(5)?,
        started_at: row.get(6)?,
        duration_us: row.get(7)?,
        byte_size: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub fn list_recordings(conn: &Connection, session_id: &str) -> Result<Vec<Recording>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, session_id, title, source, sample_rate, channels, started_at, duration_us,
             (SELECT COALESCE(SUM(original_size), 0) FROM recording_chunks c WHERE c.recording_id = r.id),
             created_at, updated_at
             FROM recordings r WHERE session_id = ?1 AND deleted_at IS NULL
             ORDER BY started_at DESC",
        )
        .map_err(|error| format!("Could not read recordings: {error}"))?;
    let rows = statement
        .query_map(params![session_id], recording_row)
        .map_err(|error| format!("Could not read recordings: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read recordings: {error}"))
}

#[expect(
    clippy::too_many_arguments,
    reason = "Recording metadata is persisted as one atomic operation."
)]
pub fn import_recording(
    conn: &mut Connection,
    session_id: &str,
    title: &str,
    source: &str,
    sample_rate: i64,
    channels: i64,
    duration_us: i64,
    bytes: &[u8],
) -> Result<Recording, String> {
    if bytes.is_empty() {
        return Err("The recording is empty.".to_owned());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO recordings (id, session_id, title, source, sample_rate, channels, started_at,
         duration_us, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?7, ?7)",
        params![
            id,
            session_id,
            if title.trim().is_empty() {
                "Session recording"
            } else {
                title.trim()
            },
            source.trim(),
            sample_rate,
            channels,
            now,
            duration_us.max(0)
        ],
    )
    .map_err(|error| format!("Could not create the recording: {error}"))?;
    for (chunk_index, chunk) in bytes.chunks(CHUNK_SIZE).enumerate() {
        let chunk_no = chunk_index as i64;
        let stored = put_blob(conn, chunk)?;
        conn.execute(
            "INSERT INTO recording_chunks (recording_id, track, chunk_no, start_us, sample_count,
             hash, original_size) VALUES (?1, 'mixed', ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                chunk_no,
                chunk_no * CHUNK_SIZE as i64 * 1_000_000
                    / (sample_rate.max(1) * channels.max(1) * 2),
                chunk.len() as i64 / 2,
                stored.hash,
                stored.original_size
            ],
        )
        .map_err(|error| format!("Could not store the recording chunk: {error}"))?;
    }
    touch_workspace_public(conn)?;
    conn.query_row(
        "SELECT id, session_id, title, source, sample_rate, channels, started_at, duration_us,
         (SELECT COALESCE(SUM(original_size), 0) FROM recording_chunks c WHERE c.recording_id = r.id),
         created_at, updated_at FROM recordings r WHERE id = ?1",
        params![id],
        recording_row,
    )
    .map_err(|error| format!("Could not read the saved recording: {error}"))
}

pub fn read_recording(conn: &Connection, id: &str) -> Result<Vec<u8>, String> {
    let mut statement = conn
        .prepare("SELECT hash FROM recording_chunks WHERE recording_id = ?1 ORDER BY chunk_no")
        .map_err(|error| format!("Could not read the recording: {error}"))?;
    let rows = statement
        .query_map(params![id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not read the recording: {error}"))?;
    let mut output = Vec::new();
    for row in rows {
        let hash = row.map_err(|error| format!("Could not read the recording: {error}"))?;
        output.extend_from_slice(&get_blob(conn, &hash)?);
    }
    Ok(output)
}

pub fn delete_recording(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE recordings SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now_ms()],
    )
    .map_err(|error| format!("Could not delete the recording: {error}"))?;
    touch_workspace_public(conn)
}
