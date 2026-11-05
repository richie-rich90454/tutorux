use std::collections::HashMap;

use rusqlite::{params, Connection};

use super::repo::touch_workspace_public;

pub fn all_settings(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut statement = conn
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .map_err(|error| format!("Could not read settings: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not read settings: {error}"))?;
    let mut settings = HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|error| format!("Could not read settings: {error}"))?;
        settings.insert(key, value);
    }
    Ok(settings)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|error| format!("Could not save the setting: {error}"))?;
    touch_workspace_public(conn)
}

pub fn rename_workspace(conn: &Connection, name: &str, description: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a workspace name.".to_owned());
    }
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('name', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![name],
    )
    .map_err(|error| format!("Could not rename the workspace: {error}"))?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('description', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![description.trim()],
    )
    .map_err(|error| format!("Could not update the workspace description: {error}"))?;
    touch_workspace_public(conn)
}
