use rusqlite::{params, Connection};

use super::models::SearchHit;

fn fts_query(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split_whitespace()
        .filter_map(|word| {
            let cleaned: String = word
                .chars()
                .filter(|character| character.is_alphanumeric() || *character == '-')
                .collect();
            if cleaned.is_empty() {
                None
            } else {
                Some(format!("\"{}\"*", cleaned.replace('"', "")))
            }
        })
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" AND "))
    }
}

pub fn search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SearchHit>, String> {
    let Some(query) = fts_query(query) else {
        return Ok(Vec::new());
    };
    let mut statement = conn
        .prepare(
            "SELECT entity_type, entity_id, title,
                    snippet(search_fts, 3, '', '', '…', 16),
                    student_id, session_id
             FROM search_fts
             WHERE search_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )
        .map_err(|error| format!("Could not search the workspace: {error}"))?;
    let rows = statement
        .query_map(params![query, limit.clamp(1, 200)], |row| {
            Ok(SearchHit {
                entity_type: row.get(0)?,
                entity_id: row.get(1)?,
                title: row.get(2)?,
                snippet: row.get(3)?,
                student_id: row.get(4)?,
                session_id: row.get(5)?,
            })
        })
        .map_err(|error| format!("Could not search the workspace: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not search the workspace: {error}"))
}
