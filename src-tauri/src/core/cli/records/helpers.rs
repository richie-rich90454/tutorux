use super::*;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub(crate) fn load(path: &std::path::Path, context: &CliContext) -> CliResult<ArchiveSnapshot> {
    let snapshot = open_archive(path, context.passphrase())?;
    if snapshot.locked() {
        return Err(CliError(
            "This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned(),
        )
        .into());
    }
    Ok(snapshot)
}

pub(crate) fn save_replacing(path: &std::path::Path, snapshot: &ArchiveSnapshot) -> CliResult<()> {
    let bytes = snapshot.source.read(0, snapshot.source.size() as usize)?;
    crate::core::cli::archive::save::save_bytes(path, &bytes)?;
    Ok(())
}

pub(crate) fn mutate(
    path: &std::path::Path,
    snapshot: &ArchiveSnapshot,
    changes: &[ArchiveRecord],
) -> CliResult<Vec<ArchiveRecord>> {
    let mut normalised = Vec::with_capacity(changes.len());
    for change in changes {
        let mut record = change.clone();
        record.revision = 0;
        record.previous_offset = 0;
        normalised.push(record);
    }
    let next = snapshot.append_records(&normalised)?;
    save_replacing(path, &next)?;
    let mut saved = Vec::new();
    for change in &normalised {
        if let Some(record) = next.get_record(change.record_type, &change.id)? {
            saved.push(record);
        }
    }
    Ok(saved)
}

pub(crate) fn plain(record: &ArchiveRecord) -> Value {
    let mut value = Map::new();
    value.insert("id".to_owned(), Value::String(record.id.clone()));
    value.insert(
        "type".to_owned(),
        Value::String(record_type_name(record.record_type).to_owned()),
    );
    value.insert(
        "revision".to_owned(),
        Value::String(record.revision.to_string()),
    );
    for (name, field) in &record.fields {
        value.insert(name.clone(), Value::String(field.clone()));
    }
    Value::Object(value)
}

pub(crate) fn plain_array(records: &[ArchiveRecord]) -> Value {
    Value::Array(records.iter().map(plain).collect())
}

pub(crate) fn require_live(
    snapshot: &ArchiveSnapshot,
    record_type: u16,
    id: &str,
) -> CliResult<ArchiveRecord> {
    match snapshot.get_record(record_type, id)? {
        Some(record) if !record.deleted() => Ok(record),
        _ => Err(CliError(format!(
            "Record {id} was not found in this archive."
        ))
        .into()),
    }
}

pub(crate) fn trash(record: &ArchiveRecord) -> ArchiveRecord {
    let mut updated = record.clone();
    let timestamp = now_us().to_string();
    updated.fields.insert("_deleted".to_owned(), "true".to_owned());
    updated
        .fields
        .insert("deleted_at_us".to_owned(), timestamp.clone());
    updated.fields.insert("updated_at_us".to_owned(), timestamp);
    if updated.record_type == RecordType::SESSION {
        let id = updated.id.clone();
        updated
            .fields
            .insert("_trash_group_id".to_owned(), id);
    }
    updated
}

pub(crate) fn restore(record: &ArchiveRecord) -> ArchiveRecord {
    let mut updated = record.clone();
    let timestamp = now_us().to_string();
    updated.fields.remove("_deleted");
    updated.fields.remove("deleted_at_us");
    updated.fields.remove("_trash_group_id");
    updated
        .fields
        .insert("restored_at_us".to_owned(), timestamp.clone());
    updated.fields.insert("updated_at_us".to_owned(), timestamp);
    updated
}

pub(crate) fn today_date() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0) as i64;
    civil_date(seconds.div_euclid(86_400))
}

pub(crate) fn civil_date(days: i64) -> String {
    // Howard Hinnant's civil-from-days algorithm.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

pub(crate) fn split_ids(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
        .collect()
}

pub(crate) fn merge_ids(existing: &str, id: &str) -> String {
    let mut ids: BTreeSet<String> = split_ids(existing).into_iter().collect();
    ids.insert(id.to_lowercase());
    ids.into_iter().collect::<Vec<_>>().join(",")
}

pub(crate) fn remove_ids(existing: &str, id: &str) -> String {
    split_ids(existing)
        .into_iter()
        .filter(|value| value != &id.to_lowercase())
        .collect::<Vec<_>>()
        .join(",")
}

pub(crate) fn notes_document(
    id: &str,
    entry_id: &str,
    session_id: &str,
    timestamp: &str,
    text: &str,
) -> ArchiveRecord {
    let mut record = ArchiveRecord::new(
        RecordType::SETTINGS,
        id,
        [
            ("record_role", "journal-notes"),
            ("entry_id", entry_id),
            ("session_id", session_id),
            ("created_at_us", timestamp),
            ("updated_at_us", timestamp),
        ],
    );
    apply_note_text(&mut record, text);
    record
}

pub(crate) fn note_blocks(record: &ArchiveRecord) -> Vec<(String, String, String)> {
    let count = record
        .field("block_count")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut blocks = Vec::new();
    for index in 0..count {
        let prefix = format!("block.{index}.");
        let Some(id) = record.field(&format!("{prefix}id")) else {
            continue;
        };
        let kind = record
            .field(&format!("{prefix}kind"))
            .unwrap_or("paragraph");
        let text = record.field(&format!("{prefix}text")).unwrap_or("");
        blocks.push((id.to_owned(), kind.to_owned(), text.to_owned()));
    }
    blocks
}

pub(crate) fn apply_note_text(record: &mut ArchiveRecord, text: &str) {
    let existing = note_blocks(record);
    let keys: Vec<String> = record
        .fields
        .keys()
        .filter(|key| key.starts_with("block."))
        .cloned()
        .collect();
    for key in keys {
        record.fields.remove(&key);
    }
    let blocks: Vec<(String, String, String)> = if text.is_empty() {
        Vec::new()
    } else {
        vec![(
            existing
                .first()
                .map(|(id, _, _)| id.clone())
                .unwrap_or_else(crate::core::archive::new_uuid),
            "paragraph".to_owned(),
            text.to_owned(),
        )]
    };
    apply_blocks(record, &blocks);
}

pub(crate) fn reconcile_note_blocks(existing: &[(String, String, String)], text: &str) -> Vec<(String, String, String)> {
    let mut paragraphs: Vec<String> = Vec::new();
    if !text.is_empty() {
        let bytes: Vec<char> = text.chars().collect();
        let mut paragraph_start = 0usize;
        let mut index = 0usize;
        while index < bytes.len() {
            if bytes[index] != '\n' {
                index += 1;
                continue;
            }
            let mut next_line = index + 1;
            while next_line < bytes.len() && matches!(bytes[next_line], ' ' | '\t' | '\r') {
                next_line += 1;
            }
            if next_line >= bytes.len() || bytes[next_line] != '\n' {
                index += 1;
                continue;
            }
            if index > paragraph_start {
                paragraphs.push(bytes[paragraph_start..index].iter().collect());
            }
            index = next_line + 1;
            while index < bytes.len() && bytes[index] == '\n' {
                index += 1;
            }
            paragraph_start = index;
        }
        if paragraph_start < bytes.len() {
            paragraphs.push(bytes[paragraph_start..].iter().collect());
        }
    }
    let mut existing_by_text: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, (_, _, block_text)) in existing.iter().enumerate() {
        existing_by_text
            .entry(block_text.clone())
            .or_default()
            .push(index);
    }
    let mut used = BTreeSet::new();
    let mut matches: Vec<Option<usize>> = paragraphs
        .iter()
        .map(|paragraph| {
            let index = existing_by_text
                .get(paragraph)
                .and_then(|candidates| candidates.iter().copied().find(|index| !used.contains(index)));
            if let Some(index) = index {
                used.insert(index);
            }
            index
        })
        .collect();
    let unmatched_existing: Vec<usize> = (0..existing.len()).filter(|index| !used.contains(index)).collect();
    let unmatched_paragraphs: Vec<usize> = matches
        .iter()
        .enumerate()
        .filter(|(_, value)| value.is_none())
        .map(|(index, _)| index)
        .collect();
    for (paragraph, existing_index) in unmatched_paragraphs
        .iter()
        .zip(unmatched_existing.iter())
    {
        matches[*paragraph] = Some(*existing_index);
    }
    paragraphs
        .into_iter()
        .enumerate()
        .map(|(index, paragraph)| match matches[index] {
            Some(existing_index) => {
                let (id, kind, _) = existing[existing_index].clone();
                (id, kind, paragraph)
            }
            None => (
                crate::core::archive::new_uuid(),
                "paragraph".to_owned(),
                paragraph,
            ),
        })
        .collect()
}

pub(crate) fn notes_text(record: &ArchiveRecord) -> String {
    note_blocks(record)
        .into_iter()
        .map(|(_, _, text)| text)
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn journal_root_if_needed(snapshot: &ArchiveSnapshot) -> Result<Option<ArchiveRecord>> {
    let roots = snapshot.list_records(RecordType::SETTINGS, false)?;
    if roots
        .iter()
        .any(|record| record.field("record_role") == Some("journal"))
    {
        return Ok(None);
    }
    let timestamp = now_us().to_string();
    Ok(Some(ArchiveRecord::new(
        RecordType::SETTINGS,
        crate::core::archive::new_uuid(),
        [
            ("record_role", "journal".to_owned()),
            ("title", "Tutorux journal".to_owned()),
            ("created_at_us", timestamp.clone()),
            ("updated_at_us", timestamp),
        ],
    )))
}

pub(crate) fn output_path(path: &std::path::Path) -> String {
    let text = path.display().to_string();
    if cfg!(windows) {
        text.replace('/', "\\")
    } else {
        text
    }
}

pub(crate) fn require_journal_entry(snapshot: &ArchiveSnapshot, id: &str) -> CliResult<ArchiveRecord> {
    let record = require_live(snapshot, RecordType::SETTINGS, id)?;
    if record.field("record_role") != Some("journal-entry") {
        return Err(CliError(format!(
            "Journal entry {id} was not found in this archive."
        ))
        .into());
    }
    Ok(record)
}

pub(crate) fn require_journal_entry_at_any_state(
    snapshot: &ArchiveSnapshot,
    id: &str,
) -> CliResult<ArchiveRecord> {
    let record = snapshot
        .get_record(RecordType::SETTINGS, id)?
        .ok_or_else(|| CliError(format!("Record {id} was not found in this archive.")))?;
    if record.field("record_role") != Some("journal-entry") {
        return Err(CliError(format!(
            "Journal entry {id} was not found in this archive."
        ))
        .into());
    }
    Ok(record)
}

pub(crate) fn guide_references_entry(guide: &ArchiveRecord, entry_id: &str) -> bool {
    if guide.field("entry_id").map(str::to_lowercase).as_deref() == Some(entry_id) {
        return true;
    }
    for (key, value) in &guide.fields {
        if key.starts_with("section.") && key.ends_with(".source_ids") {
            if split_ids(value).iter().any(|id| id == entry_id) {
                return true;
            }
        } else if key.starts_with("section.") && key.ends_with(".text") {
            let mut rest = value.as_str();
            while let Some(start) = rest.to_lowercase().find("[[source:") {
                let after = &rest[start + 9..];
                let Some(end) = after.find("]]") else { break };
                if after[..end].trim().to_lowercase() == entry_id {
                    return true;
                }
                rest = &after[end + 2..];
            }
        }
    }
    false
}

