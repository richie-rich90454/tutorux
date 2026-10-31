use super::*;

pub(crate) fn ensure_journal_links(
    destination: &ArchiveSnapshot,
    records: Vec<ArchiveRecord>,
    session_id: &str,
    timestamp: &str,
) -> CliResult<Vec<ArchiveRecord>> {
    let mut output: BTreeMap<(u16, String), ArchiveRecord> = records
        .into_iter()
        .map(|record| ((record.record_type, record.id.to_lowercase()), record))
        .collect();
    let session_key = (RecordType::SESSION, session_id.to_lowercase());
    let mut session = output
        .get(&session_key)
        .cloned()
        .ok_or_else(|| CliError("Imported session is missing from its package.".to_owned()))?;
    let mut session_fields = session.fields.clone();
    let mut settings: BTreeMap<String, ArchiveRecord> = destination
        .list_records(RecordType::SETTINGS, true)?
        .into_iter()
        .map(|record| (record.id.to_lowercase(), record))
        .collect();
    for record in output.values() {
        if record.record_type == RecordType::SETTINGS {
            settings.insert(record.id.to_lowercase(), record.clone());
        }
    }
    let mut entry_id = session.field("entry_id").unwrap_or("").to_lowercase();
    let mut entry = entry_id
        .is_empty()
        .then_some(None)
        .unwrap_or_else(|| settings.get(&entry_id).cloned());
    if entry
        .as_ref()
        .is_none_or(|entry| entry.deleted() || entry.field("record_role") != Some("journal-entry"))
    {
        entry_id = crate::core::archive::new_uuid();
        let entry_notes_id = crate::core::archive::new_uuid();
        let new_entry =
            make_journal_entry(&session, &entry_id, &entry_notes_id, session_id, timestamp);
        let entry_notes = make_journal_notes(&entry_notes_id, &entry_id, "", timestamp);
        output.insert((RecordType::SETTINGS, entry_id.clone()), new_entry.clone());
        output.insert(
            (RecordType::SETTINGS, entry_notes_id.clone()),
            entry_notes.clone(),
        );
        settings.insert(entry_id.clone(), new_entry.clone());
        settings.insert(entry_notes_id, entry_notes);
        session_fields.insert("entry_id".to_owned(), entry_id.clone());
        entry = Some(new_entry);
    } else if let Some(entry) = entry.as_mut() {
        let mut linked = split_ids(entry.field("session_ids").unwrap_or(""));
        if !linked.contains(&session_id.to_lowercase()) {
            linked.push(session_id.to_lowercase());
        }
        entry
            .fields
            .insert("session_ids".to_owned(), linked.join(","));
        entry
            .fields
            .insert("updated_at_us".to_owned(), timestamp.to_owned());
        output.insert(
            (RecordType::SETTINGS, entry.id.to_lowercase()),
            entry.clone(),
        );
    }
    let entry = entry.expect("entry exists");
    let entry_notes_id = entry
        .field("notes_document_id")
        .unwrap_or("")
        .to_lowercase();
    let entry_notes = settings.get(&entry_notes_id).cloned();
    if entry_notes.as_ref().is_none_or(|record| {
        record.deleted() || record.field("record_role") != Some("journal-notes")
    }) {
        let notes_id = crate::core::archive::new_uuid();
        let notes = make_journal_notes(&notes_id, &entry.id, "", timestamp);
        output.insert((RecordType::SETTINGS, notes_id.clone()), notes);
        let mut entry = entry.clone();
        entry
            .fields
            .insert("notes_document_id".to_owned(), notes_id);
        output.insert((RecordType::SETTINGS, entry.id.to_lowercase()), entry);
    }
    let session_notes_id = session
        .field("notes_document_id")
        .unwrap_or("")
        .to_lowercase();
    let session_notes = settings.get(&session_notes_id);
    let session_notes_valid = session_notes.is_some_and(|notes| {
        !notes.deleted()
            && notes.field("record_role") == Some("journal-notes")
            && notes.field("entry_id").map(str::to_lowercase).as_deref()
                == Some(entry.id.to_lowercase().as_str())
            && notes.field("session_id").map(str::to_lowercase).as_deref()
                == Some(session_id.to_lowercase().as_str())
    });
    if !session_notes_valid {
        let notes_id = crate::core::archive::new_uuid();
        output.insert(
            (RecordType::SETTINGS, notes_id.clone()),
            make_journal_notes(&notes_id, &entry.id, session_id, timestamp),
        );
        session_fields.insert("notes_document_id".to_owned(), notes_id);
    }
    session.fields = session_fields;
    output.insert(session_key, session);
    let has_root = settings
        .values()
        .any(|record| record.field("record_role") == Some("journal") && !record.deleted());
    if !has_root {
        let root = make_journal_root(timestamp);
        output.insert((RecordType::SETTINGS, root.id.to_lowercase()), root);
    }
    Ok(output.into_values().collect())
}

fn make_journal_entry(
    session: &ArchiveRecord,
    id: &str,
    notes_id: &str,
    session_id: &str,
    timestamp: &str,
) -> ArchiveRecord {
    ArchiveRecord::new(
        RecordType::SETTINGS,
        id,
        [
            ("record_role", "journal-entry".to_owned()),
            (
                "title",
                session
                    .field("title")
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Imported tutoring session")
                    .to_owned(),
            ),
            ("entry_date", today_date()),
            ("collection_ids", String::new()),
            ("tag_ids", String::new()),
            ("notes_document_id", notes_id.to_owned()),
            ("session_ids", session_id.to_owned()),
            ("study_guide_ids", String::new()),
            ("attachment_ids", String::new()),
            ("created_at_us", timestamp.to_owned()),
            ("updated_at_us", timestamp.to_owned()),
        ],
    )
}

fn make_journal_notes(
    id: &str,
    entry_id: &str,
    session_id: &str,
    timestamp: &str,
) -> ArchiveRecord {
    notes_document(id, entry_id, session_id, timestamp, "")
}

fn make_journal_root(timestamp: &str) -> ArchiveRecord {
    ArchiveRecord::new(
        RecordType::SETTINGS,
        crate::core::archive::new_uuid(),
        [
            ("record_role", "journal".to_owned()),
            ("title", "Tutorux journal".to_owned()),
            ("created_at_us", timestamp.to_owned()),
            ("updated_at_us", timestamp.to_owned()),
        ],
    )
}
