use super::package_journal::ensure_journal_links;
use super::*;

fn package_uuid(value: &str) -> Option<String> {
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

fn read_package_records(package: &ArchiveSnapshot) -> CliResult<Vec<ArchiveRecord>> {
    if !package.list_records(RecordType::STUDENT, true)?.is_empty() {
        return Err(
            CliError("Session packages cannot contain student profiles.".to_owned()).into(),
        );
    }
    // Packages contain current revisions, so direct records are the package.
    let mut records = Vec::new();
    for settings in package.list_records(RecordType::SETTINGS, true)? {
        if settings.id.to_lowercase() == package.header.id.to_lowercase() {
            continue;
        }
        if !matches!(
            settings.field("record_role"),
            Some("journal-entry") | Some("journal-notes")
        ) {
            return Err(
                CliError("Session packages cannot contain unrelated settings.".to_owned()).into(),
            );
        }
        records.push(settings);
    }
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
        records.extend(package.list_records(record_type, true)?);
    }
    Ok(records)
}

fn make_identifier_map(
    records: &[ArchiveRecord],
    source_session_id: &str,
    source_student_id: &str,
    mapped_student_id: Option<&str>,
) -> CliResult<BTreeMap<String, String>> {
    let mut types: BTreeMap<String, u16> = BTreeMap::new();
    let mut identifiers: BTreeMap<String, String> = BTreeMap::new();
    let mut generated: BTreeSet<String> = BTreeSet::new();
    for record in records {
        let old_id = record.id.to_lowercase();
        if let Some(existing) = types.get(&old_id) {
            if *existing != record.record_type {
                return Err(CliError(
                    "The package reuses a record UUID across different record types.".to_owned(),
                )
                .into());
            }
        }
        types.insert(old_id.clone(), record.record_type);
        if !identifiers.contains_key(&old_id) {
            let next_id = crate::core::archive::new_uuid();
            if !generated.insert(next_id.clone()) {
                return Err(CliError(
                    "Unable to assign unique imported record identifiers.".to_owned(),
                )
                .into());
            }
            identifiers.insert(old_id, next_id);
        }
    }
    let mut historical: BTreeSet<String> = records
        .iter()
        .filter(|record| record.record_type == RecordType::SESSION)
        .filter_map(|record| record.field("student_id"))
        .filter(|id| !id.is_empty() && *id != "anonymous")
        .map(str::to_lowercase)
        .collect();
    if !source_student_id.is_empty() && source_student_id != "anonymous" {
        historical.insert(source_student_id.to_lowercase());
    }
    let source_session = records
        .iter()
        .find(|record| {
            record.record_type == RecordType::SESSION
                && record.id.to_lowercase() == source_session_id
        })
        .ok_or_else(|| CliError("The package session record is missing.".to_owned()))?;
    let session_student = source_session
        .field("student_id")
        .unwrap_or("")
        .to_lowercase();
    if !session_student.is_empty() && session_student != "anonymous" {
        historical.insert(session_student);
    }
    for student in historical {
        if student.is_empty() || student == "anonymous" {
            continue;
        }
        if identifiers.contains_key(&student) {
            return Err(CliError(
                "A source student UUID conflicts with a session package record UUID.".to_owned(),
            )
            .into());
        }
        if let Some(mapped) = mapped_student_id {
            if generated.contains(&mapped.to_lowercase()) {
                return Err(CliError(
                    "The destination student UUID conflicts with an imported record UUID."
                        .to_owned(),
                )
                .into());
            }
            identifiers.insert(student, mapped.to_lowercase());
        } else {
            identifiers.insert(student, String::new());
        }
    }
    Ok(identifiers)
}

fn remap(value: &str, ids: &BTreeMap<String, String>) -> String {
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
            ids.get(&id)
                .cloned()
                .unwrap_or_else(|| part.trim().to_owned())
        })
        .collect::<Vec<_>>()
        .join(",")
}

pub(crate) fn import_session_package(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let positional = args.positionals.first().cloned();
    let option = args.option("input").map(str::to_owned);
    if positional.is_some() && option.is_some() {
        return Err(
            CliError("Choose either a package path or --input, not both.".to_owned()).into(),
        );
    }
    let package_path = resolve_path(
        positional
            .or(option)
            .ok_or_else(|| CliError("session import requires a package path.".to_owned()))?
            .as_str(),
    );
    if !package_path
        .extension()
        .map(|extension| extension.eq_ignore_ascii_case("tux"))
        .unwrap_or(false)
    {
        return Err(CliError("Session packages must use the .tux extension.".to_owned()).into());
    }
    let source = std::sync::Arc::new(crate::core::source::FileSource::open(&package_path)?);
    let package = ArchiveSnapshot::open(source)?;
    if package.locked() {
        return Err(CliError(
            "This session package is encrypted and cannot be imported here.".to_owned(),
        )
        .into());
    }
    let manifest = package
        .get_record(RecordType::SETTINGS, &package.header.id)?
        .ok_or_else(|| {
            CliError(
                "Input archive is not a supported Tutorux session transfer package.".to_owned(),
            )
        })?;
    if manifest.field("record_role") != Some("tutorux-session-package")
        || manifest.field("package_version") != Some("1")
    {
        return Err(CliError(
            "Input archive is not a supported Tutorux session transfer package.".to_owned(),
        )
        .into());
    }
    let records = read_package_records(&package)?;
    let session_ids: BTreeSet<String> = records
        .iter()
        .filter(|record| record.record_type == RecordType::SESSION)
        .map(|record| record.id.to_lowercase())
        .collect();
    if session_ids.len() != 1 {
        return Err(CliError(
            "A session transfer package must contain exactly one active session.".to_owned(),
        )
        .into());
    }
    let source_session_id = session_ids.into_iter().next().expect("checked");
    super::package_export::validate_session_records(&records, &source_session_id)?;
    let source_session = records
        .iter()
        .rev()
        .find(|record| {
            record.record_type == RecordType::SESSION
                && record.id.to_lowercase() == source_session_id
        })
        .cloned()
        .filter(|record| !record.deleted())
        .ok_or_else(|| {
            CliError(
                "A session transfer package must contain exactly one active session.".to_owned(),
            )
        })?;
    if manifest
        .field("source_session_id")
        .unwrap_or("")
        .to_lowercase()
        != source_session_id
    {
        return Err(CliError(
            "The package manifest does not match its contained session.".to_owned(),
        )
        .into());
    }
    let source_student = manifest
        .field("source_student_id")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| source_session.field("student_id").unwrap_or(""))
        .to_lowercase();
    let requested = args.option("student-id").map(str::to_owned);
    let candidate = requested.clone().unwrap_or_else(|| source_student.clone());
    let mapped_student = if package_uuid(&candidate).is_none() {
        if requested.is_some() {
            return Err(
                CliError("The selected destination student ID is invalid.".to_owned()).into(),
            );
        }
        None
    } else {
        let student = snapshot.get_record(RecordType::STUDENT, &candidate.to_lowercase())?;
        match student {
            Some(student) if !student.deleted() => Some(student.id.to_lowercase()),
            _ if requested.is_some() => {
                return Err(
                    CliError("The selected destination student does not exist.".to_owned()).into(),
                )
            }
            _ => None,
        }
    };
    let identifiers = make_identifier_map(
        &records,
        &source_session_id,
        &source_student,
        mapped_student.as_deref(),
    )?;
    let timestamp = now_us().to_string();
    let mut imported = Vec::new();
    let mut imported_session_id = String::new();
    for record in records {
        let old_id = record.id.to_lowercase();
        let Some(new_id) = identifiers.get(&old_id).cloned() else {
            continue;
        };
        let mut fields = BTreeMap::new();
        for (key, value) in &record.fields {
            let lower = key.to_lowercase();
            if lower == "session_id" && record.record_type == RecordType::ASSET_METADATA {
                fields.insert(
                    key.clone(),
                    identifiers
                        .get(&value.to_lowercase())
                        .cloned()
                        .unwrap_or_else(|| value.clone()),
                );
            } else if lower == "student_id" && record.record_type == RecordType::SESSION {
                fields.insert(
                    key.clone(),
                    mapped_student
                        .clone()
                        .unwrap_or_else(|| "anonymous".to_owned()),
                );
            } else if lower == "student_id" && identifiers.contains_key(&value.to_lowercase()) {
                fields.insert(
                    key.clone(),
                    identifiers
                        .get(&value.to_lowercase())
                        .cloned()
                        .filter(|id| !id.is_empty())
                        .unwrap_or_else(|| "anonymous".to_owned()),
                );
            } else if lower.ends_with("_id") || lower.ends_with("_ids") {
                fields.insert(key.clone(), remap(value, &identifiers));
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
    if imported_session_id.is_empty() {
        return Err(
            CliError("The package session identifier could not be remapped.".to_owned()).into(),
        );
    }
    let mut linked_by_key: BTreeMap<(u16, String), ArchiveRecord> =
        ensure_journal_links(snapshot, imported.clone(), &imported_session_id, &timestamp)?
            .into_iter()
            .map(|record| ((record.record_type, record.id.to_lowercase()), record))
            .collect();
    let mut records = Vec::with_capacity(imported.len() + linked_by_key.len());
    for mut record in imported {
        let key = (record.record_type, record.id.to_lowercase());
        if let Some(current) = linked_by_key.remove(&key) {
            record = current;
        }
        records.push(record);
    }
    records.extend(linked_by_key.into_values());
    let imported_record_count = records.len();
    let working = load(path, context)?;
    mutate(path, &working, &records)?;
    let working = load(path, context)?;
    let saved_session = working
        .get_record(RecordType::SESSION, &imported_session_id)?
        .ok_or_else(|| CliError("The imported package has no session record.".to_owned()))?;
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
