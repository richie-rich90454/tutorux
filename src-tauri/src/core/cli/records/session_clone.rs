use super::*;

fn copy_title(title: &str) -> String {
    let suffix = " (copy)";
    let mut prefix = String::new();
    for character in title.chars() {
        let mut candidate = prefix.clone();
        candidate.push(character);
        candidate.push_str(suffix);
        if candidate.len() > 240 {
            break;
        }
        prefix.push(character);
    }
    format!("{prefix}{suffix}")
}

fn required_title(value: &str) -> CliResult<String> {
    if value.len() > 240 {
        return Err(CliError("Session title must be 240 UTF-8 bytes or fewer.".to_owned()).into());
    }
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CliError("Session title is required.".to_owned()).into());
    }
    Ok(trimmed.to_owned())
}

pub(crate) fn session_clone(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let id = args.required_position(0, "session ID")?.to_lowercase();
    let source = require_live(snapshot, RecordType::SESSION, &id)?;
    let source_entry_id = source.field("entry_id").unwrap_or("").to_lowercase();
    let linked_entry = if source_entry_id.is_empty() {
        None
    } else {
        let entry = snapshot.get_record(RecordType::SETTINGS, &source_entry_id)?;
        match entry {
            Some(entry)
                if entry.field("record_role") == Some("journal-entry")
                    && entry.field("_deleted") != Some("true")
                    && entry.id.to_lowercase() == source_entry_id =>
            {
                Some(entry)
            }
            _ => {
                return Err(CoreError::new(
                    "session_entry_missing",
                    "The session’s linked journal entry could not be found.",
                )
                .into())
            }
        }
    };
    let session_type = args.option("type").unwrap_or("notes-only");
    if !matches!(
        session_type,
        "notes-only" | "record-audio" | "import-recording"
    ) {
        return Err(CoreError::new(
            "session_type_invalid",
            "Session type must be notes-only, record-audio, or import-recording.",
        )
        .into());
    }
    let timestamp = now_us().to_string();
    let title = match args.option("title") {
        Some(title) => required_title(title)?,
        None => copy_title(source.field("title").unwrap_or("Untitled session")),
    };
    let entry_id = if source_entry_id.is_empty() {
        crate::core::archive::new_uuid()
    } else {
        source_entry_id
    };
    let session_id = crate::core::archive::new_uuid();
    let notes_id = crate::core::archive::new_uuid();
    let mut fields: BTreeMap<String, String> = source
        .fields
        .iter()
        .filter(|(key, _)| {
            !key.starts_with("recording_")
                && !matches!(
                    key.as_str(),
                    "_deleted"
                        | "_trash_group_id"
                        | "_trash_session_group_id"
                        | "audio_import_state"
                        | "audio_import_track_id"
                        | "deleted_at_us"
                        | "last_completed_at_us"
                        | "resumed_at_us"
                        | "restored_at_us"
                        | "recording_track_count"
                )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    fields.insert("entry_id".to_owned(), entry_id.clone());
    fields.insert("notes_document_id".to_owned(), notes_id.clone());
    fields.insert("title".to_owned(), title.clone());
    fields.insert("session_state".to_owned(), "active".to_owned());
    fields.insert("session_type".to_owned(), session_type.to_owned());
    fields.insert("recording_source".to_owned(), "none".to_owned());
    fields.insert("recording_state".to_owned(), "not-started".to_owned());
    fields.insert("processing_state".to_owned(), "not-processed".to_owned());
    fields.insert("archived".to_owned(), "false".to_owned());
    fields.insert("created_at_us".to_owned(), timestamp.clone());
    fields.insert("started_at_us".to_owned(), timestamp.clone());
    fields.insert("ended_at_us".to_owned(), "0".to_owned());
    fields.insert("reviewed_at_us".to_owned(), "0".to_owned());
    fields.insert("updated_at_us".to_owned(), timestamp.clone());
    let mut cloned = source.clone();
    cloned.id = session_id.clone();
    cloned.revision = 0;
    cloned.previous_offset = 0;
    cloned.fields = fields;
    let mut records = vec![cloned];
    if let Some(entry) = linked_entry {
        let mut entry = entry;
        entry.fields.insert(
            "session_ids".to_owned(),
            merge_ids(entry.field("session_ids").unwrap_or(""), &session_id),
        );
        entry
            .fields
            .insert("updated_at_us".to_owned(), timestamp.clone());
        records.push(entry);
    } else {
        if let Some(root) = journal_root_if_needed(snapshot)? {
            records.push(root);
        }
        let entry_notes_id = crate::core::archive::new_uuid();
        records.push(ArchiveRecord::new(
            RecordType::SETTINGS,
            &entry_id,
            [
                ("record_role", "journal-entry".to_owned()),
                ("title", title),
                ("entry_date", today_date()),
                ("collection_ids", String::new()),
                ("tag_ids", String::new()),
                ("notes_document_id", entry_notes_id.clone()),
                ("session_ids", session_id.clone()),
                ("study_guide_ids", String::new()),
                ("attachment_ids", String::new()),
                ("created_at_us", timestamp.clone()),
                ("updated_at_us", timestamp.clone()),
            ],
        ));
        records.push(notes_document(
            &entry_notes_id,
            &entry_id,
            "",
            &timestamp,
            "",
        ));
    }
    records.push(notes_document(
        &notes_id,
        &entry_id,
        &session_id,
        &timestamp,
        "",
    ));
    let saved = mutate(path, snapshot, &records)?;
    let session = saved.first().cloned().unwrap_or_else(|| records[0].clone());
    emit(
        output,
        plain(&session),
        &format!(
            "Cloned session {id} as {} ({}).",
            session.field("title").unwrap_or(""),
            session.id
        ),
        args.json(),
    );
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_title_stays_within_240_bytes() {
        let title = "é".repeat(200);
        let copy = copy_title(&title);
        assert!(copy.len() <= 240);
        assert!(copy.ends_with(" (copy)"));
    }

    #[test]
    fn required_title_rejects_blank() {
        assert!(required_title("   ").is_err());
        assert_eq!(required_title("  Lesson ").ok().unwrap(), "Lesson");
    }
}
