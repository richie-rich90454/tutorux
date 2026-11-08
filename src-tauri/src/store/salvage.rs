use std::collections::HashMap;
use std::path::Path;

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, OpenFlags};

use super::{backup, models::SalvageReport, repo, settings};

const SKIPPED_TABLES: &[&str] = &["search_fts"];

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

pub fn salvage_workspace(source_path: &Path, destination: &str) -> Result<SalvageReport, String> {
    if Path::new(destination).exists() {
        return Err("Choose a new recovery file; that destination already exists.".to_owned());
    }
    if let Some(parent) = Path::new(destination).parent() {
        if !parent.exists() {
            return Err("The destination folder does not exist.".to_owned());
        }
    }
    let mut header = [0u8; 16];
    std::fs::File::open(source_path)
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut header))
        .map_err(|error| format!("The damaged workspace could not be read: {error}"))?;
    if &header != b"SQLite format 3\0" {
        return Err(
            "Only unencrypted SQLite workspaces can be salvaged. Open an encrypted workspace first."
                .to_owned(),
        );
    }
    let source = Connection::open_with_flags(
        source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("The damaged workspace could not be opened: {error}"))?;
    let destination_connection = Connection::open(destination)
        .map_err(|error| format!("The recovery file could not be created: {error}"))?;
    repo::apply_connection_pragmas(&destination_connection)?;
    repo::initialize_workspace(
        &destination_connection,
        "Recovered workspace",
        "Best-effort recovery",
        false,
    )?;
    destination_connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|error| format!("The recovery file could not be prepared: {error}"))?;

    let mut tables = HashMap::new();
    let mut warnings = Vec::new();
    let mut copied_rows = 0i64;
    let mut skipped_rows = 0i64;
    let names: Vec<String> = {
        let mut statement = source
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .map_err(|error| format!("The damaged workspace could not be inspected: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("The damaged workspace could not be inspected: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("The damaged workspace could not be inspected: {error}"))?
    };
    for table in names {
        if SKIPPED_TABLES.contains(&table.as_str()) || table.starts_with("search_fts_") {
            continue;
        }
        match copy_table(&source, &destination_connection, &table) {
            Ok((copied, skipped)) => {
                copied_rows += copied;
                skipped_rows += skipped;
                tables.insert(table, copied);
            }
            Err(error) => {
                warnings.push(format!("{table}: {error}"));
                tables.insert(table, 0);
            }
        }
    }
    destination_connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("The recovery file could not be finalized: {error}"))?;
    rebuild_search(&destination_connection)
        .map_err(|error| format!("The recovered search index could not be rebuilt: {error}"))?;
    let _ = settings::rename_workspace(
        &destination_connection,
        "Recovered workspace",
        "Best-effort recovery",
    );
    let integrity = backup::integrity_check(&destination_connection)?;
    Ok(SalvageReport {
        path: destination.to_owned(),
        copied_rows,
        skipped_rows,
        tables,
        warnings,
        integrity,
    })
}

fn copy_table(
    source: &Connection,
    destination: &Connection,
    table: &str,
) -> Result<(i64, i64), String> {
    let quoted = quote(table);
    let mut statement = source
        .prepare(&format!("SELECT * FROM {quoted}"))
        .map_err(|error| format!("could not read rows: {error}"))?;
    let columns: Vec<String> = statement.column_names().map(str::to_owned).collect();
    if columns.is_empty() {
        return Ok((0, 0));
    }
    let names = columns
        .iter()
        .map(|name| quote(name))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=columns.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let insert = format!("INSERT OR IGNORE INTO {quoted} ({names}) VALUES ({placeholders})");
    let mut copied = 0i64;
    let mut skipped = 0i64;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("could not read rows: {error}"))?;
    loop {
        let row = match rows.next() {
            Ok(Some(row)) => row,
            Ok(None) => break,
            Err(error) => return Err(format!("a corrupt row could not be read: {error}")),
        };
        let mut values = Vec::with_capacity(columns.len());
        let mut broken = false;
        for index in 0..columns.len() {
            match row.get::<_, Value>(index) {
                Ok(value) => values.push(value),
                Err(_) => {
                    broken = true;
                    break;
                }
            }
        }
        if broken {
            skipped += 1;
            continue;
        }
        match destination.execute(&insert, params_from_iter(values)) {
            Ok(_) => copied += 1,
            Err(_) => skipped += 1,
        }
    }
    Ok((copied, skipped))
}

fn rebuild_search(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM search_fts;
         INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
             SELECT 'student', id, display_name, '', id, '' FROM students WHERE deleted_at IS NULL;
         INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
             SELECT 'session', id, title, subject, COALESCE(student_id, ''), id
             FROM sessions WHERE deleted_at IS NULL;
         INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
             SELECT 'journal', id, title, body, COALESCE(student_id, ''), COALESCE(session_id, '')
             FROM journal_entries WHERE deleted_at IS NULL;
         INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
             SELECT 'observation', id, title, body, COALESCE(student_id, ''), COALESCE(session_id, '')
             FROM observations WHERE deleted_at IS NULL;
         INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
             SELECT 'transcript', id, '', body, '', session_id
             FROM transcript_cues WHERE deleted_at IS NULL;
         INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
             SELECT 'material', id, title, extracted_text, COALESCE(student_id, ''),
                    COALESCE(session_id, '') FROM materials WHERE deleted_at IS NULL;
         INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
             SELECT 'guide', id, title, body, COALESCE(student_id, ''), COALESCE(session_id, '')
             FROM guides WHERE deleted_at IS NULL;
         INSERT INTO search_fts(entity_type, entity_id, title, body, student_id, session_id)
             SELECT 'evidence', id, kind, statement, COALESCE(student_id, ''),
                    COALESCE(session_id, '') FROM evidence WHERE deleted_at IS NULL;",
    )
    .map_err(|error| format!("could not rebuild full-text search: {error}"))?;
    Ok(())
}
