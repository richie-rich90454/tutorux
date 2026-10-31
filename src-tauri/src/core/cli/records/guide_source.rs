use super::*;

pub(crate) fn clean_text(
    value: &str,
    label: &str,
    maximum: usize,
    multiline: bool,
) -> CliResult<()> {
    if value.len() > maximum {
        return Err(CliError(format!("{label} must be {maximum} UTF-8 bytes or fewer.")).into());
    }
    for character in value.chars() {
        let code = character as u32;
        if code == 0x7f || (code < 0x20 && !matches!(code, 0x09) && !(multiline && code == 0x0a)) {
            return Err(
                CliError(format!("{label} contains unsupported control characters.")).into(),
            );
        }
    }
    Ok(())
}

pub(crate) fn is_archive_uuid(value: &str) -> bool {
    super::is_uuid(value)
}

pub(crate) fn parse_inline_sources(text: &str) -> (String, Vec<String>) {
    let mut output = String::with_capacity(text.len());
    let mut ids = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[source:") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 9..];
        let Some(end) = after.find("]]") else {
            output.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let id = after[..end].trim().to_lowercase();
        ids.push(id);
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    (output, ids)
}

pub(crate) fn replace_inline_sources(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("[[source:") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 9..];
        let Some(end) = after.find("]]") else {
            output.push_str(&rest[start..]);
            return output;
        };
        output.push_str(&format!("[source: {}]", &after[..end]));
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    output
}

pub(crate) fn validate_guide_table(value: &str) -> CliResult<()> {
    let rows: Vec<Vec<String>> = value
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.trim_start_matches('|')
                .trim_end_matches('|')
                .split('|')
                .map(|cell| cell.trim().to_owned())
                .collect()
        })
        .collect();
    let separator = |cell: &String| {
        let normalized = cell.trim_start_matches(':').trim_end_matches(':');
        normalized.len() >= 3 && normalized.chars().all(|character| character == '-')
    };
    let valid = rows.len() >= 2
        && !rows[0].is_empty()
        && rows[0].len() == rows[1].len()
        && rows[1].iter().all(separator)
        && rows[2..].iter().all(|row| row.len() == rows[0].len());
    if valid {
        Ok(())
    } else {
        Err(CliError(
            "A table needs a header row, a matching Markdown separator row, and consistent columns."
                .to_owned(),
        )
        .into())
    }
}

pub(crate) fn parse_guide_image_reference(text: &str) -> Option<(String, String)> {
    let rest = text.strip_prefix("![")?;
    let close = rest.find("](")?;
    let alternative = &rest[..close];
    let target = rest[close + 2..].strip_suffix(')')?;
    let asset_id = target.strip_prefix("asset:")?;
    if !is_archive_uuid(asset_id) {
        return None;
    }
    Some((
        asset_id.to_lowercase(),
        alternative.replace("\\]", "]").replace("\\\\", "\\"),
    ))
}

pub(crate) fn parse_source_ids(raw: &str, text: &str, kind: &str) -> CliResult<Vec<String>> {
    let mut ids: Vec<String> = raw
        .split([' ', ',', ';', '\t', '\n'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
        .collect();
    let (remaining, inline_ids) = parse_inline_sources(text);
    for id in inline_ids {
        if !is_archive_uuid(&id) {
            return Err(
                CliError("Inline sources must use valid archive record IDs.".to_owned()).into(),
            );
        }
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if remaining.contains("[[source:") {
        return Err(CliError(
            "An inline source reference needs a valid UUID and closing brackets.".to_owned(),
        )
        .into());
    }
    if kind == "table" {
        validate_guide_table(text)?;
    }
    if kind == "image" || kind == "figure" || text.starts_with("![") {
        let Some((asset_id, _)) = parse_guide_image_reference(text) else {
            return Err(CliError(
                "Image blocks must use one archive asset reference: ![description](asset:UUID)."
                    .to_owned(),
            )
            .into());
        };
        if !ids.contains(&asset_id) {
            ids.push(asset_id);
        }
    }
    for id in &ids {
        if !is_archive_uuid(id) {
            return Err(CliError(format!("Source ID “{id}” is not a valid UUID.")).into());
        }
    }
    let mut unique = Vec::new();
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    Ok(unique)
}

pub(crate) fn is_guide_source_in_scope(source_id: &str, scope: &GuideScope) -> bool {
    let target = source_id.to_lowercase();
    let entry_id = scope
        .entry
        .as_ref()
        .map(|entry| entry.id.to_lowercase())
        .unwrap_or_default();
    let sessions: Vec<&ArchiveRecord> = match &scope.session {
        Some(session) => vec![session],
        None => scope
            .records
            .iter()
            .filter(|candidate| {
                candidate.record_type == RecordType::SESSION
                    && candidate.field("_deleted") != Some("true")
                    && candidate
                        .field("entry_id")
                        .map(str::to_lowercase)
                        .as_deref()
                        == Some(entry_id.as_str())
            })
            .collect(),
    };
    let session_ids: BTreeSet<String> = sessions
        .iter()
        .map(|session| session.id.to_lowercase())
        .collect();
    let student_ids: BTreeSet<String> = sessions
        .iter()
        .filter_map(|session| session.field("student_id"))
        .map(str::to_lowercase)
        .filter(|id| !id.is_empty() && id != "anonymous")
        .collect();
    if session_ids.contains(&target) {
        return true;
    }
    let Some(record) = scope
        .records
        .iter()
        .find(|record| record.id.to_lowercase() == target)
    else {
        return false;
    };
    if record.field("_deleted") == Some("true") {
        return false;
    }
    match record.record_type {
        RecordType::SESSION => session_ids.contains(&record.id.to_lowercase()),
        RecordType::STUDENT => student_ids.contains(&record.id.to_lowercase()),
        RecordType::SETTINGS => {
            if record.field("record_role") != Some("journal-notes") {
                return false;
            }
            if let Some(session) = &scope.session {
                is_guide_notes_source(record, session, &scope.records)
            } else if let Some(entry) = &scope.entry {
                is_guide_notes_source_for_entry(record, entry, &scope.records)
            } else {
                false
            }
        }
        RecordType::ASSET_METADATA => {
            session_ids.contains(&record.field("session_id").unwrap_or("").to_lowercase())
                || student_ids.contains(&record.field("student_id").unwrap_or("").to_lowercase())
        }
        RecordType::TRANSCRIPT_SEGMENT | RecordType::ANNOTATION | RecordType::EVIDENCE_NODE => {
            session_ids.contains(&record.field("session_id").unwrap_or("").to_lowercase())
        }
        _ => false,
    }
}

pub(crate) fn is_guide_notes_source(
    record: &ArchiveRecord,
    session: &ArchiveRecord,
    records: &[ArchiveRecord],
) -> bool {
    if record.record_type != RecordType::SETTINGS
        || record.field("record_role") != Some("journal-notes")
        || record.field("_deleted") == Some("true")
    {
        return false;
    }
    let note_id = record.id.to_lowercase();
    let session_id = session.id.to_lowercase();
    let notes_session_id = record.field("session_id").unwrap_or("").to_lowercase();
    let entry_id = session.field("entry_id").unwrap_or("").to_lowercase();
    let notes_entry_id = record.field("entry_id").unwrap_or("").to_lowercase();
    if notes_session_id == session_id {
        return true;
    }
    if entry_id.is_empty() || notes_entry_id != entry_id {
        return false;
    }
    if notes_session_id.is_empty() {
        return records.iter().any(|candidate| {
            candidate.record_type == RecordType::SETTINGS
                && candidate.id.to_lowercase() == entry_id
                && candidate.field("record_role") == Some("journal-entry")
                && candidate.field("_deleted") != Some("true")
                && candidate
                    .field("notes_document_id")
                    .map(str::to_lowercase)
                    .as_deref()
                    == Some(note_id.as_str())
        });
    }
    records.iter().any(|candidate| {
        candidate.record_type == RecordType::SESSION
            && candidate.id.to_lowercase() == notes_session_id
            && candidate.field("_deleted") != Some("true")
            && candidate
                .field("entry_id")
                .map(str::to_lowercase)
                .as_deref()
                == Some(entry_id.as_str())
            && candidate
                .field("notes_document_id")
                .map(str::to_lowercase)
                .as_deref()
                == Some(note_id.as_str())
    })
}

pub(crate) fn is_guide_notes_source_for_entry(
    record: &ArchiveRecord,
    entry: &ArchiveRecord,
    records: &[ArchiveRecord],
) -> bool {
    if record.record_type != RecordType::SETTINGS
        || record.field("record_role") != Some("journal-notes")
        || record.field("_deleted") == Some("true")
        || entry.field("record_role") != Some("journal-entry")
        || entry.field("_deleted") == Some("true")
    {
        return false;
    }
    let entry_id = entry.id.to_lowercase();
    let note_id = record.id.to_lowercase();
    let session_id = record.field("session_id").unwrap_or("").to_lowercase();
    if !session_id.is_empty() {
        return records.iter().any(|candidate| {
            candidate.record_type == RecordType::SESSION
                && candidate.id.to_lowercase() == session_id
                && candidate.field("_deleted") != Some("true")
                && candidate
                    .field("entry_id")
                    .map(str::to_lowercase)
                    .as_deref()
                    == Some(entry_id.as_str())
        });
    }
    if record.field("entry_id").map(str::to_lowercase).as_deref() != Some(entry_id.as_str()) {
        return false;
    }
    entry
        .field("notes_document_id")
        .map(str::to_lowercase)
        .as_deref()
        == Some(note_id.as_str())
}

pub(crate) fn validate_guide_for_export(
    record: &ArchiveRecord,
    scope: Option<&GuideScope>,
) -> CliResult<()> {
    if record.record_type != RecordType::GUIDE {
        return Err(CliError("Only a study guide can be exported.".to_owned()).into());
    }
    let draft = guide_draft(record);
    clean_text(&draft.title, "Guide title", 240, false)?;
    if draft.title.trim().is_empty() {
        return Err(CliError("Cannot export a guide without a title.".to_owned()).into());
    }
    if draft.sections.is_empty() {
        return Err(CliError("A guide must contain at least one section.".to_owned()).into());
    }
    for (section_index, section) in draft.sections.iter().enumerate() {
        clean_text(
            &section.heading,
            &format!("Section {} heading", section_index + 1),
            256,
            false,
        )?;
        if section.heading.trim().is_empty() {
            return Err(CliError("Every guide section needs a heading.".to_owned()).into());
        }
        for (block_index, block) in section.blocks.iter().enumerate() {
            let kind = block.kind.trim();
            if !GUIDE_BLOCK_KINDS.contains(&kind) {
                return Err(CliError(format!(
                    "Guide block kind “{}” is not supported for export.",
                    block.kind
                ))
                .into());
            }
            clean_text(
                &block.text,
                &format!("Block {} text", block_index + 1),
                16 * 1024 * 1024,
                true,
            )?;
            if !GUIDE_BLOCK_ORIGINS.contains(&block.origin.as_str()) {
                return Err(CliError(format!(
                    "Guide block provenance “{}” is not supported for export.",
                    block.origin
                ))
                .into());
            }
            let source_ids = parse_source_ids(&block.source_ids.join(","), &block.text, kind)?;
            let Some(scope) = scope else { continue };
            if kind == "image" || kind == "figure" || block.text.starts_with("![") {
                if let Some((asset_id, _)) = parse_guide_image_reference(&block.text) {
                    let valid = scope.records.iter().any(|record| {
                        record.id.to_lowercase() == asset_id
                            && record.record_type == RecordType::ASSET_METADATA
                            && record.field("_deleted") != Some("true")
                            && matches!(
                                record.field("mime_type"),
                                Some(
                                    "image/png"
                                        | "image/jpeg"
                                        | "image/jpg"
                                        | "image/gif"
                                        | "image/webp"
                                )
                            )
                    });
                    if !valid {
                        return Err(CliError(format!(
                            "Guide image {asset_id} is missing or not a supported image."
                        ))
                        .into());
                    }
                }
            }
            for source_id in source_ids {
                if !is_guide_source_in_scope(&source_id, scope) {
                    return Err(CliError(format!(
                        "Source {source_id} is missing or does not belong to this guide."
                    ))
                    .into());
                }
            }
        }
    }
    Ok(())
}
