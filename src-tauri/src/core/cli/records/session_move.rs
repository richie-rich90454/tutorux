use super::*;

fn same(left: &str, right: &str) -> bool {
    left.to_lowercase() == right.to_lowercase()
}

fn with_id(value: &str, id: &str, present: bool) -> String {
    let mut list: Vec<String> = split_ids(value)
        .into_iter()
        .filter(|item| !same(item, id))
        .collect();
    if present {
        list.push(id.to_lowercase());
    }
    list.join(",")
}

fn update(record: &ArchiveRecord, changes: &[(&str, String)]) -> ArchiveRecord {
    let mut updated = record.clone();
    for (key, value) in changes {
        updated.fields.insert((*key).to_owned(), value.clone());
    }
    updated
        .fields
        .insert("updated_at_us".to_owned(), now_us().to_string());
    updated
}

fn guide_failure(error: crate::core::cli::Failure) -> String {
    match error {
        crate::core::cli::Failure::Usage(message) => message,
        crate::core::cli::Failure::Core(error) => error.message,
    }
}

pub(crate) fn move_session_for_cli(
    entry: &ArchiveRecord,
    session: &ArchiveRecord,
    records: &[ArchiveRecord],
    guides: &[ArchiveRecord],
) -> CliResult<Vec<ArchiveRecord>> {
    if entry.field("record_role") != Some("journal-entry")
        || entry.field("_deleted") == Some("true")
        || session.record_type != RecordType::SESSION
        || session.field("_deleted") == Some("true")
    {
        return Err(CliError("Choose an active entry and session.".to_owned()).into());
    }
    let old_id = session.field("entry_id").unwrap_or("");
    let old = records.iter().find(|record| {
        record.record_type == RecordType::SETTINGS
            && record.field("record_role") == Some("journal-entry")
            && record.field("_deleted") != Some("true")
            && same(&record.id, old_id)
    });
    let related_guides: Vec<&ArchiveRecord> = guides
        .iter()
        .filter(|guide| {
            same(guide.field("session_id").unwrap_or(""), &session.id)
                && guide.field("_deleted") != Some("true")
        })
        .collect();
    let note_id = session.field("notes_document_id").unwrap_or("");
    let note = records.iter().find(|record| {
        record.record_type == RecordType::SETTINGS
            && same(&record.id, note_id)
            && record.field("_deleted") != Some("true")
    });
    if !note_id.is_empty()
        && note.is_none_or(|note| {
            note.field("record_role") != Some("journal-notes")
                || !same(note.field("session_id").unwrap_or(""), &session.id)
                || !same(note.field("entry_id").unwrap_or(""), old_id)
        })
    {
        return Err(CliError(
            "The session notes cannot be safely moved. Repair their ownership first.".to_owned(),
        )
        .into());
    }
    let moved_ids: BTreeSet<String> = related_guides
        .iter()
        .map(|guide| guide.id.to_lowercase())
        .collect();
    let mut changes: Vec<ArchiveRecord> = Vec::new();
    if let Some(old) = old.filter(|old| !same(&old.id, &entry.id)) {
        changes.push(update(
            old,
            &[
                (
                    "session_ids",
                    with_id(old.field("session_ids").unwrap_or(""), &session.id, false),
                ),
                (
                    "study_guide_ids",
                    split_ids(old.field("study_guide_ids").unwrap_or(""))
                        .into_iter()
                        .filter(|id| !moved_ids.contains(id))
                        .collect::<Vec<_>>()
                        .join(","),
                ),
            ],
        ));
    }
    let mut target_guides = entry.field("study_guide_ids").unwrap_or("").to_owned();
    for guide in &related_guides {
        target_guides = with_id(&target_guides, &guide.id, true);
    }
    let destination = update(
        entry,
        &[
            (
                "session_ids",
                with_id(entry.field("session_ids").unwrap_or(""), &session.id, true),
            ),
            ("study_guide_ids", target_guides),
        ],
    );
    let moved_session = update(session, &[("entry_id", entry.id.to_lowercase())]);
    changes.push(destination.clone());
    changes.push(moved_session.clone());
    if let Some(note) = note {
        changes.push(update(note, &[("entry_id", entry.id.to_lowercase())]));
    }
    for guide in &related_guides {
        changes.push(update(guide, &[("entry_id", entry.id.to_lowercase())]));
    }
    let replacements: BTreeMap<(u16, String), ArchiveRecord> = changes
        .iter()
        .map(|record| {
            (
                (record.record_type, record.id.to_lowercase()),
                record.clone(),
            )
        })
        .collect();
    let mut projected: Vec<ArchiveRecord> = records
        .iter()
        .map(|record| {
            replacements
                .get(&(record.record_type, record.id.to_lowercase()))
                .cloned()
                .unwrap_or_else(|| record.clone())
        })
        .collect();
    for change in &changes {
        if !projected.iter().any(|existing| {
            existing.record_type == change.record_type && same(&existing.id, &change.id)
        }) {
            projected.push(change.clone());
        }
    }
    let remaining_entry = old.and_then(|old| {
        changes
            .iter()
            .find(|record| record.record_type == RecordType::SETTINGS && same(&record.id, &old.id))
    });
    let entry_guides: Vec<&ArchiveRecord> = guides
        .iter()
        .filter(|guide| {
            guide.field("_deleted") != Some("true")
                && guide.field("session_id").unwrap_or("").is_empty()
                && !old_id.is_empty()
                && same(guide.field("entry_id").unwrap_or(""), old_id)
        })
        .collect();
    if !entry_guides.is_empty() && remaining_entry.is_none() {
        return Err(CliError(
            "The session's current journal entry is unavailable, so its guides cannot be checked."
                .to_owned(),
        )
        .into());
    }
    for guide in entry_guides.iter().chain(related_guides.iter()) {
        let is_session_guide = same(guide.field("session_id").unwrap_or(""), &session.id);
        let mut draft = guide_draft(guide);
        let scope = if is_session_guide {
            draft.entry_id = destination.id.clone();
            GuideScope {
                session: Some(moved_session.clone()),
                entry: Some(destination.clone()),
                records: projected.clone(),
            }
        } else {
            draft.entry_id = remaining_entry.expect("checked").id.clone();
            GuideScope {
                session: None,
                entry: Some(remaining_entry.expect("checked").clone()),
                records: projected.clone(),
            }
        };
        if let Err(error) = make_guide_record(&draft, &scope, Some(guide)) {
            return Err(CliError(format!(
                "Cannot move the session because guide “{}” would have invalid sources or content: {}",
                guide.field("title").filter(|title| !title.is_empty()).unwrap_or(&guide.id),
                guide_failure(error)
            ))
            .into());
        }
    }
    Ok(changes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY_A: &str = "00000000-0000-0000-0000-00000000000a";
    const ENTRY_B: &str = "00000000-0000-0000-0000-00000000000b";
    const SESSION: &str = "00000000-0000-0000-0000-000000000001";
    const NOTE: &str = "00000000-0000-0000-0000-00000000000c";
    const GUIDE: &str = "00000000-0000-0000-0000-000000000010";

    fn settings(id: &str, fields: &[(&str, String)]) -> ArchiveRecord {
        ArchiveRecord::new(RecordType::SETTINGS, id, fields.iter().cloned())
    }

    #[test]
    fn moving_a_session_relinks_guides_and_notes_without_orphans() {
        let entry_a = settings(
            ENTRY_A,
            &[
                ("record_role", "journal-entry".to_owned()),
                ("session_ids", SESSION.to_owned()),
                ("study_guide_ids", GUIDE.to_owned()),
                ("title", "Old entry".to_owned()),
            ],
        );
        let entry_b = settings(
            ENTRY_B,
            &[
                ("record_role", "journal-entry".to_owned()),
                ("session_ids", String::new()),
                ("study_guide_ids", String::new()),
                ("title", "New entry".to_owned()),
            ],
        );
        let session = ArchiveRecord::new(
            RecordType::SESSION,
            SESSION,
            [
                ("entry_id", ENTRY_A.to_owned()),
                ("notes_document_id", NOTE.to_owned()),
                ("title", "Session".to_owned()),
            ],
        );
        let note = settings(
            NOTE,
            &[
                ("record_role", "journal-notes".to_owned()),
                ("entry_id", ENTRY_A.to_owned()),
                ("session_id", SESSION.to_owned()),
            ],
        );
        let guide = ArchiveRecord::new(
            RecordType::GUIDE,
            GUIDE,
            [
                ("entry_id", ENTRY_A.to_owned()),
                ("session_id", SESSION.to_owned()),
                ("title", "Guide".to_owned()),
                ("template_id", "general".to_owned()),
                ("approval_state", "draft".to_owned()),
                ("section_count", "1".to_owned()),
                ("section.0.id", "section".to_owned()),
                ("section.0.heading", "Overview".to_owned()),
                ("section.0.block_count", "1".to_owned()),
                ("section.0.block.0.kind", "paragraph".to_owned()),
                ("section.0.block.0.text", "Session summary".to_owned()),
                ("section.0.block.0.source_ids", SESSION.to_owned()),
                ("section.0.block.0.stale", "false".to_owned()),
                ("section.0.block.0.origin", "tutor-authored".to_owned()),
            ],
        );
        let records = vec![
            entry_a.clone(),
            entry_b.clone(),
            session.clone(),
            note.clone(),
            guide.clone(),
        ];
        let changes = move_session_for_cli(&entry_b, &session, &records, &[guide])
            .ok()
            .unwrap();
        let find = |id: &str| {
            changes
                .iter()
                .find(|record| record.id == id)
                .cloned()
                .unwrap()
        };
        assert_eq!(find(ENTRY_A).field("session_ids"), Some(""));
        assert_eq!(find(ENTRY_A).field("study_guide_ids"), Some(""));
        assert_eq!(find(ENTRY_B).field("session_ids"), Some(SESSION));
        assert_eq!(find(ENTRY_B).field("study_guide_ids"), Some(GUIDE));
        assert_eq!(find(SESSION).field("entry_id"), Some(ENTRY_B));
        assert_eq!(find(NOTE).field("entry_id"), Some(ENTRY_B));
        assert_eq!(find(GUIDE).field("entry_id"), Some(ENTRY_B));
    }
}
