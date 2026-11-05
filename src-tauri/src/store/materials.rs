use std::{fs::File, io::Read, path::Path};

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    blob::{get_blob, put_blob, CHUNK_SIZE},
    models::{now_ms, LinkInput, Material},
    repo::{reindex_public, touch_workspace_public},
};

fn material_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Material> {
    Ok(Material {
        id: row.get(0)?,
        session_id: row.get(1)?,
        student_id: row.get(2)?,
        kind: row.get(3)?,
        filename: row.get(4)?,
        mime_type: row.get(5)?,
        byte_size: row.get(6)?,
        hash: row.get(7)?,
        source_url: row.get(8)?,
        title: row.get(9)?,
        notes: row.get(10)?,
        status: row.get(11)?,
        extracted_text: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

const MATERIAL_SELECT: &str = "SELECT id, session_id, student_id, kind, filename, mime_type,
    byte_size, hash, source_url, title, notes, status, extracted_text, created_at, updated_at
    FROM materials";

pub fn list_materials(
    conn: &Connection,
    session_id: &str,
    student_id: &str,
    query: &str,
) -> Result<Vec<Material>, String> {
    let needle = format!("%{}%", query.trim().to_lowercase());
    let mut statement = conn
        .prepare(&format!(
            "{MATERIAL_SELECT} WHERE deleted_at IS NULL
             AND (?1 = '' OR session_id = ?1)
             AND (?2 = '' OR student_id = ?2)
             AND (?3 = '%%' OR lower(filename) LIKE ?3 OR lower(title) LIKE ?3 OR lower(notes) LIKE ?3)
             ORDER BY created_at DESC"
        ))
        .map_err(|error| format!("Could not read materials: {error}"))?;
    let rows = statement
        .query_map(params![session_id, student_id, needle], material_row)
        .map_err(|error| format!("Could not read materials: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read materials: {error}"))
}

pub fn get_material(conn: &Connection, id: &str) -> Result<Material, String> {
    conn.query_row(
        &format!("{MATERIAL_SELECT} WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        material_row,
    )
    .optional()
    .map_err(|error| format!("Could not read the material: {error}"))?
    .ok_or_else(|| "The material could not be found.".to_owned())
}

fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "csv" => "text/csv",
        "txt" | "md" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

pub fn import_material_file(
    conn: &mut Connection,
    path: &str,
    session_id: Option<String>,
    student_id: Option<String>,
) -> Result<Material, String> {
    let source = Path::new(path);
    if !source.is_file() {
        return Err("The selected material is not a readable file.".to_owned());
    }
    let metadata = std::fs::metadata(source)
        .map_err(|error| format!("Could not inspect the material: {error}"))?;
    let filename = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Material")
        .to_owned();
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO materials (id, session_id, student_id, kind, filename, mime_type, byte_size,
         title, notes, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'file', ?4, ?5, ?6, ?4, '', 'importing', ?7, ?7)",
        params![
            id,
            session_id,
            student_id,
            filename,
            guess_mime(source),
            metadata.len() as i64,
            now
        ],
    )
    .map_err(|error| format!("Could not create the material: {error}"))?;
    reindex_public(
        conn,
        "material",
        &id,
        &filename,
        "",
        student_id.as_deref().unwrap_or(""),
        session_id.as_deref().unwrap_or(""),
    )?;

    let mut file =
        File::open(source).map_err(|error| format!("Could not open the material: {error}"))?;
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut chunk_no: i64 = 0;
    let mut hasher = Sha256::new();
    let mut total: i64 = 0;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read the material: {error}"))?;
        if read == 0 {
            break;
        }
        let bytes = &buffer[..read];
        hasher.update(bytes);
        total += read as i64;
        let stored = put_blob(conn, bytes)?;
        conn.execute(
            "INSERT INTO material_chunks (material_id, chunk_no, hash, original_size)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, chunk_no, stored.hash, stored.original_size],
        )
        .map_err(|error| format!("Could not record the material chunk: {error}"))?;
        chunk_no += 1;
    }
    let hash = format!("{:x}", hasher.finalize());
    conn.execute(
        "UPDATE materials SET hash = ?2, byte_size = ?3, status = 'ready', updated_at = ?4
         WHERE id = ?1",
        params![id, hash, total, now_ms()],
    )
    .map_err(|error| format!("Could not finalize the material: {error}"))?;
    touch_workspace_public(conn)?;
    get_material(conn, &id)
}

pub fn create_link(conn: &Connection, input: &LinkInput) -> Result<Material, String> {
    let url = input.url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Enter a valid http or https link.".to_owned());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let title = if input.title.trim().is_empty() {
        url.to_owned()
    } else {
        input.title.trim().to_owned()
    };
    conn.execute(
        "INSERT INTO materials (id, session_id, student_id, kind, filename, mime_type, source_url,
         title, notes, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'link', ?4, 'text/uri-list', ?4, ?4, ?5, 'ready', ?6, ?6)",
        params![
            id,
            input.session_id,
            input.student_id,
            url,
            input.notes.trim(),
            now
        ],
    )
    .map_err(|error| format!("Could not save the link: {error}"))?;
    reindex_public(
        conn,
        "material",
        &id,
        &title,
        input.notes.trim(),
        input.student_id.as_deref().unwrap_or(""),
        input.session_id.as_deref().unwrap_or(""),
    )?;
    touch_workspace_public(conn)?;
    get_material(conn, &id)
}

pub fn update_material(
    conn: &Connection,
    id: &str,
    title: &str,
    notes: &str,
) -> Result<Material, String> {
    let changed = conn
        .execute(
            "UPDATE materials SET title = ?2, notes = ?3, updated_at = ?4
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, title.trim(), notes.trim(), now_ms()],
        )
        .map_err(|error| format!("Could not update the material: {error}"))?;
    if changed == 0 {
        return Err("The material could not be found.".to_owned());
    }
    let material = get_material(conn, id)?;
    reindex_public(
        conn,
        "material",
        id,
        &material.title,
        &format!("{} {}", material.notes, material.extracted_text),
        material.student_id.as_deref().unwrap_or(""),
        material.session_id.as_deref().unwrap_or(""),
    )?;
    touch_workspace_public(conn)?;
    Ok(material)
}

pub fn delete_material(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE materials SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now_ms()],
        )
        .map_err(|error| format!("Could not move the material to trash: {error}"))?;
    if changed == 0 {
        return Err("The material could not be found.".to_owned());
    }
    touch_workspace_public(conn)?;
    Ok(())
}

pub fn read_material(conn: &Connection, id: &str, maximum_bytes: usize) -> Result<Vec<u8>, String> {
    let material = get_material(conn, id)?;
    if material.kind == "link" {
        return Err("A link cannot be read as a file.".to_owned());
    }
    if material.byte_size as usize > maximum_bytes {
        return Err(format!(
            "This material is too large to preview in memory. It is {} bytes; the preview limit is {} bytes.",
            material.byte_size, maximum_bytes
        ));
    }
    let mut statement = conn
        .prepare(
            "SELECT hash, original_size FROM material_chunks
             WHERE material_id = ?1 ORDER BY chunk_no",
        )
        .map_err(|error| format!("Could not read material chunks: {error}"))?;
    let chunks = statement
        .query_map(params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| format!("Could not read material chunks: {error}"))?;
    let mut output = Vec::with_capacity(material.byte_size.max(0) as usize);
    for chunk in chunks {
        let (hash, size) =
            chunk.map_err(|error| format!("Could not read material chunks: {error}"))?;
        let bytes = get_blob(conn, &hash)?;
        if bytes.len() != size as usize {
            return Err("A material chunk is damaged.".to_owned());
        }
        output.extend_from_slice(&bytes);
    }
    Ok(output)
}

pub fn material_text_for_search(
    conn: &mut Connection,
    material_id: &str,
    text: &str,
) -> Result<(), String> {
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not update material text: {error}"))?;
    transaction
        .execute(
            "UPDATE materials SET extracted_text = ?2, updated_at = ?3 WHERE id = ?1",
            params![material_id, text, now_ms()],
        )
        .map_err(|error| format!("Could not store extracted text: {error}"))?;
    let material = get_material(&transaction, material_id)?;
    reindex_public(
        &transaction,
        "material",
        material_id,
        &material.title,
        &format!("{} {}", material.notes, text),
        material.student_id.as_deref().unwrap_or(""),
        material.session_id.as_deref().unwrap_or(""),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Could not save extracted text: {error}"))
}
