use super::*;

pub(crate) fn make_guide_record(
    draft: &GuideDraft,
    scope: &GuideScope,
    current: Option<&ArchiveRecord>,
) -> CliResult<ArchiveRecord> {
    if let Some(current) = current {
        if current.record_type != RecordType::GUIDE {
            return Err(CliError("Only a study guide can be updated here.".to_owned()).into());
        }
    }
    let session = scope.session.as_ref();
    let entry = scope.entry.as_ref();
    if let Some(session) = session {
        if session.record_type != RecordType::SESSION || session.field("_deleted") == Some("true") {
            return Err(
                CliError("Choose an active session for this study guide.".to_owned()).into(),
            );
        }
        if draft.session_id != session.id {
            return Err(CliError(
                "The selected session changed. Reopen the guide editor.".to_owned(),
            )
            .into());
        }
        if !draft.entry_id.is_empty()
            && draft.entry_id.to_lowercase()
                != session.field("entry_id").unwrap_or("").to_lowercase()
        {
            return Err(CliError(
                "The selected journal entry changed. Reopen the guide editor.".to_owned(),
            )
            .into());
        }
        if let Some(entry) = entry {
            if entry.id.to_lowercase() != session.field("entry_id").unwrap_or("").to_lowercase() {
                return Err(CliError(
                    "The selected session does not belong to this journal entry.".to_owned(),
                )
                .into());
            }
        }
    } else {
        let valid_entry = entry.is_some_and(|entry| {
            entry.record_type == RecordType::SETTINGS
                && entry.field("record_role") == Some("journal-entry")
                && entry.field("_deleted") != Some("true")
        });
        if !valid_entry {
            return Err(CliError(
                "Choose an active journal entry or session for this study guide.".to_owned(),
            )
            .into());
        }
        let entry = entry.expect("checked entry");
        if !draft.session_id.is_empty()
            || (!draft.entry_id.is_empty()
                && draft.entry_id.to_lowercase() != entry.id.to_lowercase())
        {
            return Err(CliError(
                "The selected journal entry changed. Reopen the guide editor.".to_owned(),
            )
            .into());
        }
    }

    clean_text(&draft.title, "Guide title", 240, false)?;
    let title = draft.title.trim();
    if title.is_empty() {
        return Err(CliError("Guide title is required.".to_owned()).into());
    }
    clean_text(&draft.template_id, "Template ID", 128, false)?;
    let template_id = if draft.template_id.trim().is_empty() {
        "general".to_owned()
    } else {
        draft.template_id.trim().to_owned()
    };
    if draft.sections.is_empty() {
        return Err(CliError("Add at least one section to the guide.".to_owned()).into());
    }
    if draft.sections.len() > 250 {
        return Err(CliError("A guide can contain at most 250 sections.".to_owned()).into());
    }
    let mut current_sections: BTreeMap<String, usize> = BTreeMap::new();
    if let Some(current) = current {
        let mut index = 0;
        while current.fields.contains_key(&format!("section.{index}.id")) {
            current_sections.insert(
                current
                    .field(&format!("section.{index}.id"))
                    .unwrap_or("")
                    .to_owned(),
                index,
            );
            index += 1;
        }
    }
    let mut sections = Vec::new();
    for (section_index, section) in draft.sections.iter().enumerate() {
        clean_text(
            &section.heading,
            &format!("Section {} heading", section_index + 1),
            256,
            false,
        )?;
        let heading = section.heading.trim();
        if heading.is_empty() {
            return Err(CliError("Every guide section needs a heading.".to_owned()).into());
        }
        if section.blocks.len() > 1_000 {
            return Err(CliError("A section can contain at most 1,000 blocks.".to_owned()).into());
        }
        let previous_index = current_sections
            .get(&section.id)
            .copied()
            .unwrap_or(section_index);
        let mut blocks = Vec::new();
        for (block_index, block) in section.blocks.iter().enumerate() {
            if block.kind.trim().is_empty() {
                return Err(CliError("Guide block kind is required.".to_owned()).into());
            }
            let block_prefix = format!("section.{previous_index}.block.{block_index}.");
            let previous_kind =
                current.and_then(|record| record.field(&format!("{block_prefix}kind")));
            let previous_unknown =
                previous_kind.is_some_and(|kind| !GUIDE_BLOCK_KINDS.contains(&kind));
            if let Some(current) = current {
                let kind_supported = GUIDE_BLOCK_KINDS.contains(&block.kind.as_str());
                let previous_changed = previous_unknown
                    && (block.kind != previous_kind.unwrap_or("")
                        || block.text
                            != current.field(&format!("{block_prefix}text")).unwrap_or("")
                        || block.source_ids.join(",")
                            != current
                                .field(&format!("{block_prefix}source_ids"))
                                .unwrap_or("")
                        || block.stale
                            != (current.field(&format!("{block_prefix}stale")) == Some("true"))
                        || block.origin
                            != current
                                .field(&format!("{block_prefix}origin"))
                                .filter(|value| !value.is_empty())
                                .unwrap_or("unknown"));
                if (!kind_supported && previous_kind != Some(block.kind.as_str()))
                    || previous_changed
                {
                    return Err(CliError(format!(
                        "Guide block kind “{}” is not supported.",
                        block.kind
                    ))
                    .into());
                }
            }
            clean_text(
                &block.text,
                &format!("Block {} text", block_index + 1),
                16 * 1024 * 1024,
                true,
            )?;
            let origin = if block.origin.is_empty() {
                "unknown".to_owned()
            } else {
                block.origin.clone()
            };
            let source_ids =
                parse_source_ids(&block.source_ids.join(","), &block.text, &block.kind)?;
            for source_id in &source_ids {
                if !is_guide_source_in_scope(source_id, scope) {
                    return Err(CliError(format!(
                        "Source {source_id} is missing or does not belong to this guide."
                    ))
                    .into());
                }
            }
            blocks.push(GuideBlock {
                kind: block.kind.clone(),
                text: block.text.clone(),
                source_ids,
                stale: block.stale,
                origin,
            });
        }
        sections.push(GuideSection {
            id: section.id.clone(),
            heading: heading.to_owned(),
            blocks,
        });
    }

    let mut fields = current
        .map(|record| record.fields.clone())
        .unwrap_or_default();
    let keys: Vec<String> = fields
        .keys()
        .filter(|key| is_guide_field_key(key))
        .cloned()
        .collect();
    for key in keys {
        fields.remove(&key);
    }
    let session_id = session
        .map(|session| session.id.to_lowercase())
        .unwrap_or_default();
    let entry_id = match session {
        Some(session) => session.field("entry_id").unwrap_or("").to_owned(),
        None => entry.expect("checked entry").id.clone(),
    };
    let timestamp = now_us().to_string();
    fields.insert("entry_id".to_owned(), entry_id);
    fields.insert("session_id".to_owned(), session_id);
    fields.insert("title".to_owned(), title.to_owned());
    fields.insert("template_id".to_owned(), template_id);
    fields.insert("approval_state".to_owned(), "draft".to_owned());
    fields.insert("updated_at_us".to_owned(), timestamp.clone());
    if !fields.contains_key("created_at_us") {
        fields.insert("created_at_us".to_owned(), timestamp);
    }
    let next_id = current
        .map(|record| record.id.clone())
        .unwrap_or_else(crate::core::archive::new_uuid);
    let revision = current.map(|record| record.revision).unwrap_or(0);
    let previous_offset = current.map(|record| record.previous_offset).unwrap_or(0);
    let blob = current
        .map(|record| record.blob.clone())
        .unwrap_or_default();
    let mut record = ArchiveRecord {
        record_type: RecordType::GUIDE,
        id: next_id,
        revision,
        previous_offset,
        fields,
        blob,
    };
    set_guide_sections(&mut record, &sections);
    Ok(record)
}

pub(crate) fn guide_records_with_entry_links(
    guide: &ArchiveRecord,
    previous: Option<&ArchiveRecord>,
    records: &[ArchiveRecord],
) -> CliResult<Vec<ArchiveRecord>> {
    if guide.record_type != RecordType::GUIDE {
        return Err(CliError("Only study guides can be linked here.".to_owned()).into());
    }
    let old_entry_id = previous
        .map(|record| record.field("entry_id").unwrap_or("").to_lowercase())
        .unwrap_or_default();
    let new_entry_id = guide.field("entry_id").unwrap_or("").to_lowercase();
    let live = guide.field("_deleted") != Some("true");
    let mut changes = vec![guide.clone()];
    let entry_ids: BTreeSet<String> = [old_entry_id, new_entry_id.clone()]
        .into_iter()
        .filter(|id| !id.is_empty())
        .collect();
    for entry_id in entry_ids {
        let should_link = live && entry_id == new_entry_id;
        let Some(entry) = records.iter().find(|record| {
            record.record_type == RecordType::SETTINGS
                && record.id.to_lowercase() == entry_id
                && record.field("record_role") == Some("journal-entry")
                && record.field("_deleted") != Some("true")
        }) else {
            if should_link {
                return Err(CliError(
                    "Restore the source journal entry before saving this guide.".to_owned(),
                )
                .into());
            }
            continue;
        };
        let existing: Vec<String> = entry
            .field("study_guide_ids")
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect();
        let contains = existing
            .iter()
            .any(|id| id.to_lowercase() == guide.id.to_lowercase());
        if contains == should_link {
            continue;
        }
        let next = if should_link {
            let mut list = existing;
            list.push(guide.id.to_lowercase());
            list.join(",")
        } else {
            existing
                .into_iter()
                .filter(|id| id.to_lowercase() != guide.id.to_lowercase())
                .collect::<Vec<_>>()
                .join(",")
        };
        let mut entry = entry.clone();
        entry.fields.insert("study_guide_ids".to_owned(), next);
        entry
            .fields
            .insert("updated_at_us".to_owned(), now_us().to_string());
        changes.push(entry);
    }
    Ok(changes)
}

pub(crate) fn approve_guide_record(record: &ArchiveRecord) -> CliResult<ArchiveRecord> {
    if record.record_type != RecordType::GUIDE {
        return Err(CliError("Only a study guide can be approved.".to_owned()).into());
    }
    if record.field("_deleted") == Some("true") {
        return Err(CliError("A guide in Trash cannot be approved.".to_owned()).into());
    }
    let stale: u64 = match record.field("stale_block_count").unwrap_or("0") {
        value if value.bytes().all(|byte| byte.is_ascii_digit()) => value
            .parse()
            .map_err(|_| CliError("The stale guide block count is invalid.".to_owned()))?,
        _ => return Err(CliError("The stale guide block count is invalid.".to_owned()).into()),
    };
    if stale > 0 {
        return Err(CliError(
            "Review every source-changed block before approving this guide.".to_owned(),
        )
        .into());
    }
    let mut updated = record.clone();
    let timestamp = now_us().to_string();
    updated
        .fields
        .insert("approval_state".to_owned(), "approved".to_owned());
    updated
        .fields
        .insert("approved_at_us".to_owned(), timestamp.clone());
    updated.fields.insert("updated_at_us".to_owned(), timestamp);
    Ok(updated)
}

pub(crate) fn guide_regeneration_target(
    record: Option<&ArchiveRecord>,
) -> CliResult<Option<ArchiveRecord>> {
    match record {
        None => Ok(None),
        Some(record) => {
            if record.record_type != RecordType::GUIDE {
                return Err(CliError("Only a study guide can be regenerated.".to_owned()).into());
            }
            if record.field("approval_state") == Some("approved") {
                Ok(None)
            } else {
                Ok(Some(record.clone()))
            }
        }
    }
}
