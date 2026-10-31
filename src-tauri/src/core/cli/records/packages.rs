use super::*;

// ---------------------------------------------------------------------------
// Session packages
// ---------------------------------------------------------------------------

pub(crate) fn run_session_export(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let session_id = args.required_position(0, "session ID")?.to_lowercase();
    let destination = resolve_path(args.required_option("output")?);
    if !destination
        .extension()
        .map(|extension| extension.eq_ignore_ascii_case("tux"))
        .unwrap_or(false)
    {
        return Err(CliError("Session packages must use the .tux extension.".to_owned()).into());
    }
    if same_path_public(path, &destination) {
        return Err(CliError(
            "Session package output must be a separate file.".to_owned(),
        )
        .into());
    }
    if destination.exists() && !args.flag("force") {
        return Err(CliError(format!(
            "Session package already exists: {}",
            destination.display()
        ))
        .into());
    }
    let session = require_live(snapshot, RecordType::SESSION, &session_id)?;
    let timestamp = now_us();
    let bytes = create_archive_bytes(
        "Tutorux session transfer",
        &format!("Portable transfer package for session {session_id}"),
        timestamp,
    )?;
    let mut package = ArchiveSnapshot::open_bytes(bytes)?;
    let manifest = package
        .get_record(RecordType::SETTINGS, &package.header.id)?
        .ok_or_else(|| CliError("The new package archive is missing its manifest.".to_owned()))?;
    let mut manifest_fields = manifest.fields.clone();
    manifest_fields.insert(
        "record_role".to_owned(),
        "tutorux-session-package".to_owned(),
    );
    manifest_fields.insert("package_version".to_owned(), "1".to_owned());
    manifest_fields.insert("source_session_id".to_owned(), session.id.clone());
    let source_student = session.field("student_id").unwrap_or("anonymous");
    if source_student != "anonymous" && !source_student.is_empty() {
        manifest_fields.insert("source_student_id".to_owned(), source_student.to_lowercase());
    }
    let mut manifest = manifest;
    manifest.fields = manifest_fields;
    let mut records = vec![manifest];
    let mut seen: BTreeSet<(u16, String)> = BTreeSet::new();
    let mut add = |record: ArchiveRecord, records: &mut Vec<ArchiveRecord>| {
        if seen.insert((record.record_type, record.id.to_lowercase())) {
            records.push(record);
        }
    };
    add(session.clone(), &mut records);
    let mut asset_ids: BTreeSet<String> = BTreeSet::new();
    let mut evidence_ids: BTreeSet<String> = BTreeSet::new();
    for record_type in [
        RecordType::AUDIO_CHUNK,
        RecordType::TRANSCRIPT_SEGMENT,
        RecordType::ANNOTATION,
        RecordType::ASSET_METADATA,
        RecordType::EVIDENCE_NODE,
        RecordType::GUIDE,
        RecordType::AI_JOB,
    ] {
        for record in snapshot.list_records(record_type, true)? {
            if record.field("session_id").map(str::to_lowercase).as_deref()
                != Some(session_id.as_str())
            {
                continue;
            }
            if record.record_type == RecordType::EVIDENCE_NODE {
                evidence_ids.insert(record.id.to_lowercase());
            }
            if record.record_type == RecordType::ASSET_METADATA
                && !matches!(
                    record.field("record_role"),
                    Some("audio-track")
                        | Some("recording-take")
                        | Some("waveform-pyramid")
                        | Some("sparse-timestamp-seek-index")
                        | Some("asset-blob-manifest")
                        | Some("asset-blob-chunk")
                )
            {
                asset_ids.insert(record.id.to_lowercase());
            }
            for key in ["linked_asset_ids", "source_asset_ids"] {
                for id in split_ids(record.field(key).unwrap_or("")) {
                    asset_ids.insert(id);
                }
            }
            add(record, &mut records);
        }
    }
    for edge in snapshot.list_records(RecordType::EVIDENCE_EDGE, true)? {
        if edge.field("session_id").map(str::to_lowercase).as_deref()
            == Some(session_id.as_str())
            || (evidence_ids.contains(&edge.field("from_id").unwrap_or("").to_lowercase())
                && evidence_ids.contains(&edge.field("to_id").unwrap_or("").to_lowercase()))
        {
            add(edge, &mut records);
        }
    }
    let mut blob_ids: BTreeSet<String> = BTreeSet::new();
    for asset in snapshot.list_records(RecordType::ASSET_METADATA, true)? {
        if !asset_ids.contains(&asset.id.to_lowercase()) {
            continue;
        }
        if let Some(blob_id) = asset.field("blob_id") {
            blob_ids.insert(blob_id.to_lowercase());
        }
        add(asset, &mut records);
    }
    let package_blobs = snapshot.list_records(RecordType::ASSET_BLOB, true)?;
    for blob in &package_blobs {
        if !blob_ids.contains(&blob.id.to_lowercase()) {
            continue;
        }
        add(blob.clone(), &mut records);
        if blob.field("record_role") == Some("asset-blob-manifest") {
            for chunk_id in split_ids(blob.field("chunk_ids").unwrap_or("")) {
                if let Some(chunk) = package_blobs
                    .iter()
                    .find(|record| record.id.to_lowercase() == chunk_id)
                {
                    add(chunk.clone(), &mut records);
                }
            }
        }
    }
    package = package.append_records(&records)?;
    let package_bytes = package.source.read(0, package.source.size() as usize)?;
    if args.flag("force") {
        write_file_atomically(&destination, &package_bytes)?;
    } else {
        write_new_file(&destination, &package_bytes)?;
    }
    emit(
        output,
        json!({
            "session_id": session.id,
            "output": output_path(&destination),
            "status": "exported",
            "path": output_path(&destination),
            "bytes": package_bytes.len().to_string(),
            "created": true,
        }),
        &format!(
            "Exported session package for {} to {}.",
            session.id,
            destination.display()
        ),
        args.json(),
    );
    Ok(0)
}

pub(crate) fn remap_reference(value: &str, ids: &BTreeMap<String, String>) -> String {
    if value.is_empty() {
        return value.to_owned();
    }
    let trimmed = value.trim().to_lowercase();
    if let Some(mapped) = ids.get(&trimmed) {
        return mapped.clone();
    }
    value
        .split(',')
        .map(|part| {
            let id = part.trim().to_lowercase();
            ids.get(&id).cloned().unwrap_or_else(|| part.trim().to_owned())
        })
        .collect::<Vec<_>>()
        .join(",")
}

pub(crate) fn run_session_import(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let positional = args.positionals.first().cloned();
    let option = args.option("input").map(str::to_owned);
    if positional.is_some() && option.is_some() {
        return Err(CliError("Choose either a package path or --input, not both.".to_owned()).into());
    }
    let package_path = resolve_path(
        positional
            .or(option)
            .ok_or_else(|| CliError("session import requires a package path.".to_owned()))?
            .as_str(),
    );
    let package_source = std::sync::Arc::new(crate::core::source::FileSource::open(&package_path)?);
    let package = ArchiveSnapshot::open(package_source)?;
    if package.locked() {
        return Err(CliError(
            "This session package is encrypted and cannot be imported here.".to_owned(),
        )
        .into());
    }
    let mut records: Vec<ArchiveRecord> = Vec::new();
    let mut seen: BTreeSet<(u16, String)> = BTreeSet::new();
    for record_type in [
        RecordType::SESSION,
        RecordType::AUDIO_CHUNK,
        RecordType::TRANSCRIPT_SEGMENT,
        RecordType::ANNOTATION,
        RecordType::ASSET_METADATA,
        RecordType::ASSET_BLOB,
        RecordType::EVIDENCE_NODE,
        RecordType::EVIDENCE_EDGE,
        RecordType::GUIDE,
        RecordType::AI_JOB,
    ] {
        for record in package.list_records(record_type, true)? {
            if seen.insert((record.record_type, record.id.to_lowercase())) {
                records.push(record);
            }
        }
    }
    let source_sessions: Vec<&ArchiveRecord> = records
        .iter()
        .filter(|record| record.record_type == RecordType::SESSION)
        .collect();
    if source_sessions.len() != 1 || source_sessions[0].deleted() {
        return Err(CliError(
            "A session transfer package must contain exactly one active session.".to_owned(),
        )
        .into());
    }
    let source_session = source_sessions[0].clone();
    let source_session_id = source_session.id.to_lowercase();
    let requested_student = args.option("student-id").map(str::to_lowercase);
    let source_student = source_session.field("student_id").unwrap_or("anonymous").to_lowercase();
    let mapped_student = if !source_student.is_empty() && source_student != "anonymous" {
        match snapshot.get_record(RecordType::STUDENT, &source_student)? {
            Some(student) if !student.deleted() => Some(student.id.to_lowercase()),
            _ => None,
        }
    } else {
        None
    };
    if let Some(requested) = &requested_student {
        match snapshot.get_record(RecordType::STUDENT, requested)? {
            Some(student) if !student.deleted() => {}
            _ => {
                return Err(CliError(
                    "The selected destination student does not exist.".to_owned(),
                )
                .into())
            }
        }
    }
    let destination_student = requested_student.clone().or(mapped_student);
    let mut identifiers: BTreeMap<String, String> = BTreeMap::new();
    for record in &records {
        identifiers
            .entry(record.id.to_lowercase())
            .or_insert_with(crate::core::archive::new_uuid);
    }
    if let Some(student) = &destination_student {
        identifiers.insert(source_student.clone(), student.clone());
    }
    let timestamp = now_us().to_string();
    let mut imported = Vec::new();
    let mut imported_session_id = String::new();
    for record in records {
        let old_id = record.id.to_lowercase();
        let Some(new_id) = identifiers.get(&old_id).cloned() else { continue };
        let mut fields = BTreeMap::new();
        for (key, value) in &record.fields {
            let lower_key = key.to_lowercase();
            if lower_key == "student_id" {
                let mapped = if value.to_lowercase() == source_student {
                    destination_student.clone()
                } else {
                    identifiers.get(&value.to_lowercase()).cloned()
                };
                fields.insert(key.clone(), mapped.unwrap_or_else(|| "anonymous".to_owned()));
            } else if lower_key == "session_id" && record.record_type == RecordType::ASSET_METADATA {
                fields.insert(
                    key.clone(),
                    identifiers
                        .get(&value.to_lowercase())
                        .cloned()
                        .unwrap_or_else(|| value.clone()),
                );
            } else if lower_key.ends_with("_id") || lower_key.ends_with("_ids") {
                fields.insert(key.clone(), remap_reference(value, &identifiers));
            } else {
                fields.insert(key.clone(), value.clone());
            }
        }
        if record.record_type == RecordType::SESSION && old_id == source_session_id {
            fields.insert("imported_at_us".to_owned(), timestamp.clone());
            fields.remove("_deleted");
            imported_session_id = new_id.clone();
        }
        imported.push(ArchiveRecord {
            record_type: record.record_type,
            id: new_id,
            revision: 0,
            previous_offset: 0,
            fields,
            blob: record.blob.clone(),
        });
    }
    let session_index = imported
        .iter()
        .position(|record| record.record_type == RecordType::SESSION)
        .ok_or_else(|| CliError("The package session record is missing.".to_owned()))?;
    let mut session = imported[session_index].clone();
    let mut changes = imported;
    let journal_root_exists = snapshot
        .list_records(RecordType::SETTINGS, false)?
        .iter()
        .any(|record| record.field("record_role") == Some("journal"));
    let entry_id = session
        .field("entry_id")
        .map(str::to_lowercase)
        .filter(|id| !id.is_empty())
        .unwrap_or_default();
    let existing_entry = if entry_id.is_empty() {
        None
    } else {
        changes
            .iter()
            .find(|record| record.record_type == RecordType::SETTINGS && record.id == entry_id)
            .cloned()
    };
    let entry = if let Some(mut entry) = existing_entry {
        entry.fields.insert(
            "session_ids".to_owned(),
            merge_ids(entry.field("session_ids").unwrap_or(""), &imported_session_id),
        );
        entry
            .fields
            .insert("updated_at_us".to_owned(), timestamp.clone());
        let notes_id = entry.field("notes_document_id").unwrap_or("").to_owned();
        if notes_id.is_empty()
            || !changes.iter().any(|record| record.id == notes_id)
        {
            let notes = notes_document(
                &crate::core::archive::new_uuid(),
                &entry.id,
                "",
                &timestamp,
                "",
            );
            entry
                .fields
                .insert("notes_document_id".to_owned(), notes.id.clone());
            changes.push(notes);
        }
        entry
    } else {
        let entry_id = if entry_id.is_empty() {
            crate::core::archive::new_uuid()
        } else {
            crate::core::archive::new_uuid()
        };
        let entry_notes_id = crate::core::archive::new_uuid();
        let entry = ArchiveRecord::new(
            RecordType::SETTINGS,
            &entry_id,
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
                ("notes_document_id", entry_notes_id.clone()),
                ("session_ids", imported_session_id.clone()),
                ("study_guide_ids", String::new()),
                ("attachment_ids", String::new()),
                ("created_at_us", timestamp.clone()),
                ("updated_at_us", timestamp.clone()),
            ],
        );
        session
            .fields
            .insert("entry_id".to_owned(), entry_id.clone());
        changes.push(entry.clone());
        changes.push(notes_document(
            &entry_notes_id,
            &entry_id,
            "",
            &timestamp,
            "",
        ));
        entry
    };
    let session_notes_id = session.field("notes_document_id").unwrap_or("").to_owned();
    let session_notes_valid = !session_notes_id.is_empty()
        && changes.iter().any(|record| {
            record.id == session_notes_id
                && record.field("record_role") == Some("journal-notes")
                && record.field("entry_id") == Some(entry.id.as_str())
                && record.field("session_id") == Some(imported_session_id.as_str())
        });
    if !session_notes_valid {
        let notes = notes_document(
            &crate::core::archive::new_uuid(),
            &entry.id,
            &imported_session_id,
            &timestamp,
            "",
        );
        session
            .fields
            .insert("notes_document_id".to_owned(), notes.id.clone());
        changes.push(notes);
    }
    if !journal_root_exists {
        changes.push(ArchiveRecord::new(
            RecordType::SETTINGS,
            crate::core::archive::new_uuid(),
            [
                ("record_role", "journal".to_owned()),
                ("title", "Tutorux journal".to_owned()),
                ("created_at_us", timestamp.clone()),
                ("updated_at_us", timestamp.clone()),
            ],
        ));
    }
    session.fields.insert("updated_at_us".to_owned(), timestamp.clone());
    changes[session_index] = session.clone();
    let imported_record_count = changes.len();
    let saved = mutate(path, snapshot, &changes)?;
    let saved_session = saved
        .iter()
        .find(|record| record.record_type == RecordType::SESSION)
        .cloned()
        .unwrap_or(session);
    emit(
        output,
        json!({
            "session": plain(&saved_session),
            "session_id": saved_session.id,
            "entry_id": saved_session.field("entry_id").unwrap_or(""),
            "notes_document_id": saved_session.field("notes_document_id").unwrap_or(""),
            "student_id": args.option("student-id").unwrap_or("preserved-or-anonymous"),
            "status": "imported",
            "imported_records": imported_record_count,
        }),
        &format!(
            "Imported session {} ({}).",
            saved_session.field("title").unwrap_or("Tutoring session"),
            saved_session.id
        ),
        args.json(),
    );
    Ok(0)
}

pub(crate) fn same_path_public(left: &std::path::Path, right: &std::path::Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    if cfg!(windows) {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}




