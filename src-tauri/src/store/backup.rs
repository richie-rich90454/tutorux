use std::{path::Path, time::Duration};

use rusqlite::{Connection, OpenFlags};

use super::models::BackupResult;

pub fn backup_workspace(
    conn: &Connection,
    destination: &str,
    key: Option<&str>,
) -> Result<BackupResult, String> {
    let path = Path::new(destination);
    if path.exists() {
        return Err("Choose a new backup file; that destination already exists.".to_owned());
    }
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            return Err("The backup folder does not exist.".to_owned());
        }
    }
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|error| format!("Could not prepare the backup: {error}"))?;
    let mut target = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|error| format!("Could not create the backup: {error}"))?;
    if let Some(key) = key {
        target
            .pragma_update(None, "key", key)
            .map_err(|_| "The backup encryption key could not be applied.".to_owned())?;
    }
    {
        let backup = rusqlite::backup::Backup::new(conn, &mut target)
            .map_err(|error| format!("Could not start the backup: {error}"))?;
        backup
            .run_to_completion(32, Duration::from_millis(10), None)
            .map_err(|error| format!("Could not write the backup: {error}"))?;
    }
    let check: String = target
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("Could not verify the backup: {error}"))?;
    if check != "ok" {
        return Err(format!("The backup failed its integrity check: {check}"));
    }
    let bytes = std::fs::metadata(path)
        .map(|meta| meta.len() as i64)
        .unwrap_or(0);
    Ok(BackupResult {
        path: path.to_string_lossy().into_owned(),
        bytes,
    })
}

pub fn integrity_check(conn: &Connection) -> Result<String, String> {
    conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("Could not check the workspace: {error}"))
}
