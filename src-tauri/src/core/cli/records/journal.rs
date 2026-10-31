use super::*;

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

pub(crate) fn run_journal(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "create" => {
            let timestamp = now_us().to_string();
            let entry_id = crate::core::archive::new_uuid();
            let notes_id = crate::core::archive::new_uuid();
            let entry_date = match args.option("date") {
                Some(value) => {
                    if !valid_calendar_date(value) {
                        return Err(CoreError::new(
                            "journal_date_invalid",
                            "Choose a valid journal date.",
                        )
                        .into());
                    }
                    value.to_owned()
                }
                None => today_date(),
            };
            let mut records = vec![ArchiveRecord::new(
                RecordType::SETTINGS,
                &entry_id,
                [
                    ("record_role", "journal-entry".to_owned()),
                    (
                        "title",
                        args.option("title").unwrap_or("Untitled entry").to_owned(),
                    ),
                    (
                        "entry_date",
                        entry_date,
                    ),
                    (
                        "collection_ids",
                        option_id_list(&args, "collection-ids")?
                            .unwrap_or_default()
                            .join(","),
                    ),
                    (
                        "tag_ids",
                        option_id_list(&args, "tag-ids")?
                            .unwrap_or_default()
                            .join(","),
                    ),
                    ("notes_document_id", notes_id.clone()),
                    ("session_ids", String::new()),
                    ("study_guide_ids", String::new()),
                    ("attachment_ids", String::new()),
                    ("created_at_us", timestamp.clone()),
                    ("updated_at_us", timestamp.clone()),
                ],
            )];
            records.push(notes_document(
                &notes_id,
                &entry_id,
                "",
                &timestamp,
                args.option("notes").unwrap_or(""),
            ));
            if let Some(root) = journal_root_if_needed(&snapshot)? {
                records.push(root);
            }
            let saved = mutate(path, &snapshot, &records)?;
            let entry = saved
                .iter()
                .find(|record| record.field("record_role") == Some("journal-entry"))
                .cloned()
                .unwrap_or_else(|| records[0].clone());
            emit(
                output,
                plain(&entry),
                &format!(
                    "Created journal entry {} ({}).",
                    entry.field("title").unwrap_or(""),
                    entry.id
                ),
                args.json(),
            );
            Ok(0)
        }
        "update" => {
            let id = args.required_position(0, "journal entry ID")?.to_lowercase();
            let current = require_journal_entry(&snapshot, &id)?;
            if args.option("date").is_some() && args.flag("clear-date") {
                return Err(CliError("Choose either --date or --clear-date.".to_owned()).into());
            }
            let mut fields = current.fields.clone();
            let mut changed = false;
            for (option, field) in [
                ("title", "title"),
                ("date", "entry_date"),
                ("collection-ids", "collection_ids"),
                ("tag-ids", "tag_ids"),
            ] {
                if let Some(value) = args.option(option) {
                    let value = if field == "collection_ids" || field == "tag_ids" {
                        option_id_list(&args, option)?.unwrap_or_default().join(",")
                    } else if field == "entry_date" {
                        if !valid_calendar_date(value) {
                            return Err(CliError("Choose a valid journal date.".to_owned()).into());
                        }
                        value.to_owned()
                    } else {
                        value.to_owned()
                    };
                    fields.insert(field.to_owned(), value);
                    changed = true;
                }
            }
            if args.flag("clear-date") {
                fields.insert("entry_date".to_owned(), String::new());
                changed = true;
            }
            let mut changes = Vec::new();
            if changed {
                fields.insert("updated_at_us".to_owned(), timestamp_now());
                let mut updated = current.clone();
                updated.fields = fields;
                changes.push(updated);
            }
            if let Some(text) = args.option("notes") {
                let notes_id = current.field("notes_document_id").unwrap_or("");
                if !notes_id.is_empty() {
                    if let Some(mut notes) = snapshot.get_record(RecordType::SETTINGS, notes_id)? {
                        apply_note_text(&mut notes, text);
                        changes.push(notes);
                    }
                }
            }
            if changes.is_empty() {
                return Err(CliError("Provide a journal field to update.".to_owned()).into());
            }
            let saved = mutate(path, &snapshot, &changes)?;
            let entry = saved
                .iter()
                .find(|record| record.field("record_role") == Some("journal-entry"))
                .cloned()
                .unwrap_or(current);
            emit(output, plain(&entry), "Journal entry updated.", args.json());
            Ok(0)
        }
        "list" | "search" => journal_list(action, &snapshot, &args, output),
        "show" => {
            let id = args.required_position(0, "journal entry ID")?.to_lowercase();
            let entry = require_journal_entry(&snapshot, &id)?;
            let sessions: Vec<ArchiveRecord> = snapshot
                .list_records(RecordType::SESSION, false)?
                .into_iter()
                .filter(|session| {
                    !session.deleted()
                        && session.field("entry_id").map(str::to_lowercase).as_deref()
                            == Some(entry.id.as_str())
                })
                .collect();
            let session_ids: Vec<String> = sessions
                .iter()
                .map(|session| session.id.to_lowercase())
                .collect();
            let notes_id = entry.field("notes_document_id").unwrap_or("");
            let notes_text = if notes_id.is_empty() {
                String::new()
            } else {
                let document = snapshot
                    .get_record(RecordType::SETTINGS, notes_id)?
                    .ok_or_else(|| CliError("The entry's notes document was not found.".to_owned()))?;
                if document.field("record_role") != Some("journal-notes") || document.deleted() {
                    return Err(CliError("The entry's notes document was not found.".to_owned()).into());
                }
                if let Some(entry_id) = document.field("entry_id").filter(|value| !value.is_empty()) {
                    if entry_id.to_lowercase() != entry.id {
                        return Err(CliError(
                            "The entry's notes document points to a different journal entry.".to_owned(),
                        )
                        .into());
                    }
                }
                notes_text(&document)
            };
            let mut value = plain(&entry);
            if let Value::Object(map) = &mut value {
                map.insert("session_ids".to_owned(), Value::String(session_ids.join(",")));
                map.insert(
                    "session_count".to_owned(),
                    Value::String(session_ids.len().to_string()),
                );
                map.insert("notes_document_id".to_owned(), Value::String(notes_id.to_owned()));
                map.insert("notes_text".to_owned(), Value::String(notes_text));
            }
            emit(
                output,
                value,
                &format!(
                    "{} ({})",
                    entry.field("title").filter(|value| !value.is_empty()).unwrap_or("Journal entry"),
                    entry.id
                ),
                args.json(),
            );
            Ok(0)
        }
        "delete" => {
            let id = args.required_position(0, "journal entry ID")?.to_lowercase();
            let entry = require_journal_entry(&snapshot, &id)?;
            let sessions: Vec<ArchiveRecord> = snapshot
                .list_records(RecordType::SESSION, true)?
                .into_iter()
                .filter(|session| {
                    !session.deleted()
                        && session.field("entry_id").map(str::to_lowercase).as_deref()
                            == Some(entry.id.as_str())
                })
                .collect();
            let guides = snapshot.list_records(RecordType::GUIDE, true)?;
            let settings = snapshot.list_records(RecordType::SETTINGS, true)?;
            let notes_documents: Vec<&ArchiveRecord> = settings
                .iter()
                .filter(|record| record.field("record_role") == Some("journal-notes"))
                .collect();
            let mut linked_guides: BTreeSet<String> =
                split_ids(entry.field("study_guide_ids").unwrap_or("")).into_iter().collect();
            for guide in &guides {
                if !guide.deleted() && guide_references_entry(guide, &entry.id) {
                    linked_guides.insert(guide.id.to_lowercase());
                }
            }
            let linked_attachments = split_ids(entry.field("attachment_ids").unwrap_or("")).len();
            let additional_notes = notes_documents
                .iter()
                .filter(|document| {
                    !document.deleted()
                        && document
                            .field("entry_id")
                            .map(str::to_lowercase)
                            .as_deref()
                            == Some(entry.id.as_str())
                        && document.id != entry.field("notes_document_id").unwrap_or("")
                })
                .count();
            if !sessions.is_empty()
                || !linked_guides.is_empty()
                || linked_attachments > 0
                || additional_notes > 0
            {
                let mut reasons = Vec::new();
                if !sessions.is_empty() {
                    reasons.push(format!(
                        "{} linked session{}",
                        sessions.len(),
                        if sessions.len() == 1 { "" } else { "s" }
                    ));
                }
                if !linked_guides.is_empty() {
                    reasons.push(format!(
                        "{} linked or citing study guide{}",
                        linked_guides.len(),
                        if linked_guides.len() == 1 { "" } else { "s" }
                    ));
                }
                if linked_attachments > 0 {
                    reasons.push(format!(
                        "{linked_attachments} linked material{}",
                        if linked_attachments == 1 { "" } else { "s" }
                    ));
                }
                if additional_notes > 0 {
                    reasons.push(format!(
                        "{additional_notes} additional notes document{}",
                        if additional_notes == 1 { "" } else { "s" }
                    ));
                }
                let joined = match reasons.len() {
                    0 => "linked records".to_owned(),
                    1 => reasons[0].clone(),
                    2 => format!("{} and {}", reasons[0], reasons[1]),
                    _ => format!(
                        "{}, and {}",
                        reasons[..reasons.len() - 1].join(", "),
                        reasons.last().unwrap()
                    ),
                };
                return Err(CliError(format!(
                    "Remove or detach {joined} before moving this entry to Trash."
                ))
                .into());
            }
            let notes_id = entry.field("notes_document_id").unwrap_or("");
            let notes_document = if notes_id.is_empty() {
                None
            } else {
                settings.iter().find(|record| record.id == notes_id)
            };
            if let Some(document) = notes_document {
                if document.field("record_role") != Some("journal-notes") {
                    return Err(CliError(
                        "The entry’s linked notes document has an unexpected record type.".to_owned(),
                    )
                    .into());
                }
                if let Some(entry_id) = document.field("entry_id").filter(|value| !value.is_empty()) {
                    if entry_id.to_lowercase() != entry.id {
                        return Err(CliError(
                            "The entry’s notes document belongs to a different journal entry.".to_owned(),
                        )
                        .into());
                    }
                }
                if document.deleted()
                    && document.field("_trash_group_id").map(str::to_lowercase)
                        != Some(entry.id.clone())
                {
                    return Err(CliError(
                        "The entry’s notes document is already in a different Trash group.".to_owned(),
                    )
                    .into());
                }
            }
            let mut changes = vec![{
                let mut trashed = trash(&entry);
                trashed
                    .fields
                    .insert("_trash_group_id".to_owned(), entry.id.clone());
                trashed
            }];
            if let Some(document) = notes_document {
                if !document.deleted() {
                    let mut trashed = trash(document);
                    trashed
                        .fields
                        .insert("_trash_group_id".to_owned(), entry.id.clone());
                    changes.push(trashed);
                }
            }
            let saved = mutate(path, &snapshot, &changes)?;
            let result = saved
                .iter()
                .find(|record| record.id == entry.id)
                .cloned()
                .unwrap_or_else(|| changes[0].clone());
            emit(
                output,
                plain(&result),
                "Journal entry moved to Trash.",
                args.json(),
            );
            Ok(0)
        }
        "restore" => {
            let id = args.required_position(0, "journal entry ID")?.to_lowercase();
            let entry = require_journal_entry_at_any_state(&snapshot, &id)?;
            if !entry.deleted() {
                return Err(CliError("This journal entry is no longer in Trash.".to_owned()).into());
            }
            let settings = snapshot.list_records(RecordType::SETTINGS, true)?;
            let notes_id = entry.field("notes_document_id").unwrap_or("");
            if !notes_id.is_empty() {
                if let Some(linked) = settings.iter().find(|record| record.id == notes_id) {
                    if linked.field("record_role") != Some("journal-notes") {
                        return Err(CliError(
                            "The entry’s linked notes document has an unexpected record type.".to_owned(),
                        )
                        .into());
                    }
                    if !linked.deleted() {
                        return Err(CliError(
                            "The entry’s notes document is not in the same Trash group.".to_owned(),
                        )
                        .into());
                    }
                    if linked.field("_trash_group_id").map(str::to_lowercase)
                        != Some(entry.id.clone())
                    {
                        return Err(CliError(
                            "The entry’s notes document is stored in a different Trash group.".to_owned(),
                        )
                        .into());
                    }
                }
            }
            let mut changes = vec![restore(&entry)];
            for document in settings.iter().filter(|record| {
                record.field("record_role") == Some("journal-notes")
                    && record.deleted()
                    && record.field("_trash_group_id").map(str::to_lowercase)
                        == Some(entry.id.clone())
            }) {
                changes.push(restore(document));
            }
            let saved = mutate(path, &snapshot, &changes)?;
            let result = saved
                .iter()
                .find(|record| record.id == entry.id)
                .cloned()
                .unwrap_or_else(|| changes[0].clone());
            emit(
                output,
                plain(&result),
                "Journal entry restored from Trash.",
                args.json(),
            );
            Ok(0)
        }
        "document" => run_journal_document(&snapshot, &args, output, path),
        "collection" => run_journal_organizer("collection", &snapshot, &args, output, path),
        "tag" => run_journal_organizer("tag", &snapshot, &args, output, path),
        "entry" => {
            let Some(entry_action) = args.positionals.first().cloned() else {
                return Err(CliError("Choose a journal entry action.".to_owned()).into());
            };
            let mut forwarded = args.clone();
            forwarded.positionals.remove(0);
            run_journal(&entry_action, forwarded, output, path, context)
        }
        _ => Err(CliError(format!("journal {action} is not implemented in the Rust CLI yet.")).into()),
    }
}

