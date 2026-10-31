use super::*;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

pub(crate) fn create_session_records(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
) -> CliResult<Vec<ArchiveRecord>> {
    let student_id = args
        .option("student")
        .or_else(|| args.option("student-id"))
        .unwrap_or("")
        .to_lowercase();
    if !student_id.is_empty() {
        require_live(snapshot, RecordType::STUDENT, &student_id)?;
    }
    let linked_entry = match args.option("entry-id") {
        Some(id) => Some(require_journal_entry(snapshot, &id.to_lowercase())?),
        None => {
            if args.flag("entry-id") {
                return Err(CliError("--entry-id requires a journal entry UUID.".to_owned()).into());
            }
            None
        }
    };
    let timestamp = now_us().to_string();
    let session_id = crate::core::archive::new_uuid();
    let notes_id = crate::core::archive::new_uuid();
    let entry_id = linked_entry
        .as_ref()
        .map(|entry| entry.id.clone())
        .unwrap_or_else(crate::core::archive::new_uuid);
    let session_type = args.option("type").unwrap_or("notes-only");
    if !matches!(session_type, "notes-only" | "record-audio" | "import-recording") {
        return Err(CoreError::new(
            "session_type_invalid",
            "Session type must be notes-only, record-audio, or import-recording.",
        )
        .into());
    }
    let language = args.option("language").unwrap_or("auto");
    let valid_language = language == "auto"
        || (language.len() >= 2
            && language.len() <= 32
            && language
                .split('-')
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric())));
    if !valid_language {
        return Err(CoreError::new(
            "session_language_invalid",
            "Use auto or a language code such as en or zh-Hant.",
        )
        .into());
    }
    let recording_source = args.option("recording-source").unwrap_or(match session_type {
        "record-audio" => "microphone",
        "import-recording" => "imported-file",
        _ => "none",
    });
    if !["none", "microphone", "system-audio", "both", "application", "imported-file"]
        .contains(&recording_source)
    {
        return Err(CoreError::new(
            "session_recording_source_invalid",
            "Choose none, microphone, system-audio, both, application, or imported-file.",
        )
        .into());
    }
    let guide_template = args.option("guide-template").unwrap_or("");
    if guide_template.len() > 128 || guide_template.chars().any(char::is_control) {
        return Err(CoreError::new(
            "session_guide_template_invalid",
            "The guide template ID is too long or contains control characters.",
        )
        .into());
    }
    let title = args.option("title").unwrap_or("Untitled session").to_owned();
    let mut records = vec![ArchiveRecord::new(
        RecordType::SESSION,
        &session_id,
        [
            (
                "student_id",
                if student_id.is_empty() {
                    "anonymous".to_owned()
                } else {
                    student_id
                },
            ),
            ("entry_id", entry_id.clone()),
            ("notes_document_id", notes_id.clone()),
            ("subject", args.option("subject").unwrap_or("").to_owned()),
            ("title", title.clone()),
            (
                "learning_objectives",
                args.option("objectives")
                    .or_else(|| args.option("learning-objectives"))
                    .unwrap_or("")
                    .to_owned(),
            ),
            ("session_type", session_type.to_owned()),
            ("session_state", "active".to_owned()),
            (
                "transcription_language",
                language.to_owned(),
            ),
            (
                "guide_template_id",
                guide_template.to_owned(),
            ),
            ("recording_source", recording_source.to_owned()),
            ("started_at_us", timestamp.clone()),
            ("ended_at_us", "0".to_owned()),
            ("reviewed_at_us", "0".to_owned()),
            ("recording_state", "not-started".to_owned()),
            ("processing_state", "not-processed".to_owned()),
            ("archived", "false".to_owned()),
            ("created_at_us", timestamp.clone()),
            ("updated_at_us", timestamp.clone()),
        ],
    )];
    if let Some(mut entry) = linked_entry {
        entry
            .fields
            .insert("session_ids".to_owned(), merge_ids(entry.field("session_ids").unwrap_or(""), &session_id));
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
        args.option("notes").unwrap_or(""),
    ));
    Ok(records)
}

pub(crate) fn session_audio_track_ids(snapshot: &ArchiveSnapshot, session: &ArchiveRecord) -> Result<Vec<String>> {
    let mut track_ids: Vec<String> = split_ids(session.field("recording_track_ids").unwrap_or(""));
    for key in ["recording_track_id", "audio_import_track_id"] {
        for id in split_ids(session.field(key).unwrap_or("")) {
            if !track_ids.contains(&id) {
                track_ids.push(id);
            }
        }
    }
    let session_id = session.id.to_lowercase();
    for record in snapshot.list_records(RecordType::ASSET_METADATA, false)? {
        if record.field("record_role") == Some("audio-track")
            && record.field("session_id").map(str::to_lowercase).as_deref()
                == Some(session_id.as_str())
        {
            let id = record.id.to_lowercase();
            if !track_ids.contains(&id) {
                track_ids.push(id);
            }
        }
    }
    Ok(track_ids)
}

pub(crate) fn session_audio_chunks(
    snapshot: &ArchiveSnapshot,
    session: &ArchiveRecord,
    include_deleted: bool,
) -> Result<Vec<ArchiveRecord>> {
    let track_ids = session_audio_track_ids(snapshot, session)?;
    let session_id = session.id.to_lowercase();
    let mut chunks = Vec::new();
    for track_id in track_ids {
        for chunk in snapshot.list_records(RecordType::AUDIO_CHUNK, include_deleted)? {
            if chunk.field("track_id").map(str::to_lowercase).as_deref() == Some(track_id.as_str())
                && chunk.field("session_id").map(str::to_lowercase).as_deref()
                    == Some(session_id.as_str())
            {
                chunks.push(chunk);
            }
        }
    }
    Ok(chunks)
}

pub(crate) fn mark_session_trashed(record: &ArchiveRecord, group: &str, timestamp: &str) -> ArchiveRecord {
    let mut updated = record.clone();
    updated
        .fields
        .insert("_deleted".to_owned(), "true".to_owned());
    updated
        .fields
        .insert("_trash_group_id".to_owned(), group.to_owned());
    updated
        .fields
        .insert("deleted_at_us".to_owned(), timestamp.to_owned());
    updated
        .fields
        .insert("updated_at_us".to_owned(), timestamp.to_owned());
    updated
}

pub(crate) fn restore_grouped_record(record: &ArchiveRecord, timestamp: &str) -> ArchiveRecord {
    let mut updated = record.clone();
    updated.fields.remove("_deleted");
    updated.fields.remove("deleted_at_us");
    updated.fields.remove("_trash_group_id");
    updated
        .fields
        .insert("restored_at_us".to_owned(), timestamp.to_owned());
    updated
        .fields
        .insert("updated_at_us".to_owned(), timestamp.to_owned());
    updated
}

pub(crate) fn session_scope_token(records: &[ArchiveRecord]) -> String {
    let mut parts: Vec<String> = records
        .iter()
        .map(|record| {
            format!(
                "{}:{}:{}\n",
                record.record_type,
                record.id.to_lowercase(),
                record.revision
            )
        })
        .collect();
    parts.sort();
    sha256_hex(parts.concat().as_bytes())
}

