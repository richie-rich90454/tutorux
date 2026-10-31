use super::*;

#[path = "session_move.rs"]
mod session_move;

fn canonical_uuid(value: &str) -> Option<String> {
    let hex: String = value
        .chars()
        .filter(|character| *character != '-')
        .collect::<String>()
        .to_lowercase();
    if hex.len() != 32 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

pub(crate) fn update_session(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let id = args.required_position(0, "session ID")?.to_lowercase();
    let mut current = require_live(&snapshot, RecordType::SESSION, &id)?;
    let metadata_options = [
        "title",
        "subject",
        "objectives",
        "learning-objectives",
        "student-id",
        "entry-id",
        "notes",
    ];
    if !metadata_options
        .iter()
        .any(|option| args.option(option).is_some())
    {
        return Err(CliError("Provide a session field to update.".to_owned()).into());
    }
    let clean = |value: &str, label: &str, maximum: usize, multiline: bool| -> CliResult<String> {
        if value.len() > maximum {
            return Err(
                CliError(format!("{label} must be {maximum} UTF-8 bytes or fewer.")).into(),
            );
        }
        if value.chars().any(|character| {
            let code = character as u32;
            code == 0x7f || (code < 0x20 && !(multiline && (code == 0x09 || code == 0x0a)))
        }) {
            return Err(
                CliError(format!("{label} contains unsupported control characters.")).into(),
            );
        }
        Ok(value.trim().to_owned())
    };
    let student_id = args
        .option("student-id")
        .map(str::to_lowercase)
        .unwrap_or_else(|| {
            current
                .field("student_id")
                .unwrap_or("anonymous")
                .to_owned()
        });
    if args.option("student-id").is_some() && student_id != "anonymous" {
        require_live(&snapshot, RecordType::STUDENT, &student_id)?;
    }
    let title = clean(
        args.option("title")
            .unwrap_or(current.field("title").unwrap_or("Untitled session")),
        "Session title",
        240,
        false,
    )?;
    if title.is_empty() {
        return Err(CliError("Session title is required.".to_owned()).into());
    }
    let subject = clean(
        args.option("subject")
            .unwrap_or(current.field("subject").unwrap_or("")),
        "Subject",
        200,
        false,
    )?;
    let objectives = clean(
        args.option("objectives")
            .or_else(|| args.option("learning-objectives"))
            .unwrap_or(current.field("learning_objectives").unwrap_or("")),
        "Learning objectives",
        4_000,
        true,
    )?;
    let timestamp = timestamp_now();
    current.fields.insert(
        "student_id".to_owned(),
        if student_id.is_empty() {
            "anonymous".to_owned()
        } else {
            student_id
        },
    );
    current.fields.insert("subject".to_owned(), subject);
    current.fields.insert("title".to_owned(), title);
    current
        .fields
        .insert("learning_objectives".to_owned(), objectives);
    current
        .fields
        .insert("updated_at_us".to_owned(), timestamp.clone());
    let mut changes = vec![current.clone()];
    if let Some(text) = args.option("notes") {
        let notes_id = current.field("notes_document_id").unwrap_or("").to_owned();
        let existing = if notes_id.is_empty() {
            None
        } else {
            snapshot.get_record(RecordType::SETTINGS, &notes_id)?
        };
        let fallback_notes_id = if notes_id.is_empty() {
            crate::core::archive::new_uuid()
        } else {
            notes_id.clone()
        };
        let mut notes = match existing {
            Some(notes)
                if notes.field("record_role") == Some("journal-notes")
                    && notes.field("_deleted") != Some("true") =>
            {
                notes
            }
            _ => notes_document(
                &fallback_notes_id,
                current.field("entry_id").unwrap_or(""),
                &current.id,
                &timestamp,
                "",
            ),
        };
        apply_note_text(&mut notes, text);
        notes.fields.insert(
            "entry_id".to_owned(),
            current.field("entry_id").unwrap_or("").to_owned(),
        );
        notes
            .fields
            .insert("session_id".to_owned(), current.id.to_lowercase());
        notes
            .fields
            .insert("updated_at_us".to_owned(), timestamp.clone());
        current
            .fields
            .insert("notes_document_id".to_owned(), notes.id.clone());
        changes[0] = current.clone();
        changes.push(notes);
    }
    if let Some(destination_id) = args.option("entry-id") {
        let canonical = canonical_uuid(destination_id)
            .ok_or_else(|| CliError("--entry-id must be a valid UUID.".to_owned()))?;
        let destination = require_live(&snapshot, RecordType::SETTINGS, &canonical)?;
        if destination.field("record_role") != Some("journal-entry") {
            return Err(CliError("Destination journal entry was not found.".to_owned()).into());
        }
        if current.field("entry_id").map(str::to_lowercase).as_deref() != Some(canonical.as_str()) {
            let mut projected = guide_source_records(&snapshot)?;
            for record in &changes {
                if let Some(existing) = projected.iter_mut().find(|existing| {
                    existing.record_type == record.record_type
                        && existing.id.to_lowercase() == record.id.to_lowercase()
                }) {
                    *existing = record.clone();
                } else {
                    projected.push(record.clone());
                }
            }
            let guides = snapshot.list_records(RecordType::GUIDE, false)?;
            let moved =
                session_move::move_session_for_cli(&destination, &current, &projected, &guides)?;
            let moved_keys: BTreeSet<(u16, String)> = moved
                .iter()
                .map(|record| (record.record_type, record.id.to_lowercase()))
                .collect();
            let mut merged: Vec<ArchiveRecord> = moved
                .iter()
                .filter(|record| record.record_type == RecordType::SESSION)
                .cloned()
                .collect();
            merged.extend(
                moved
                    .iter()
                    .filter(|record| record.record_type != RecordType::SESSION)
                    .cloned(),
            );
            merged.extend(changes.into_iter().filter(|record| {
                !moved_keys.contains(&(record.record_type, record.id.to_lowercase()))
            }));
            changes = merged;
        }
    }
    let saved = mutate(path, &snapshot, &changes)?;
    let session = saved
        .iter()
        .find(|record| record.record_type == RecordType::SESSION)
        .cloned()
        .unwrap_or(current);
    emit(
        output,
        plain(&session),
        &format!(
            "Updated session {} ({}).",
            session.field("title").unwrap_or(""),
            session.id
        ),
        args.json(),
    );
    Ok(0)
}
