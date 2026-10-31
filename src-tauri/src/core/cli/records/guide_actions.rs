use super::super::*;
use super::{read_guide_context, read_guide_entry_scope, read_guide_scope};

fn guide_index(raw: Option<&str>, name: &str, length: usize) -> CliResult<usize> {
    let value = parse_integer(raw, name, 0, 0, length.saturating_sub(1) as u64)?;
    if value as usize >= length {
        return Err(CliError(format!("--{name} is outside the available range.")).into());
    }
    Ok(value as usize)
}

fn source_list(value: &str) -> Vec<String> {
    value
        .split([' ', ',', ';', '\t', '\n'])
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn save_guide(
    path: &std::path::Path,
    snapshot: &ArchiveSnapshot,
    changes: &[ArchiveRecord],
) -> CliResult<ArchiveRecord> {
    let saved = mutate(path, snapshot, changes)?;
    saved
        .iter()
        .find(|record| record.record_type == RecordType::GUIDE)
        .cloned()
        .or_else(|| changes.first().cloned())
        .ok_or_else(|| CliError("Study guide update produced no record.".to_owned()).into())
}

pub(crate) fn guide_create(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let session_id = args.required_option("session")?.to_lowercase();
    let scope = read_guide_scope(snapshot, &session_id)?;
    let session = scope.session.as_ref().expect("session scope");
    let mut draft = match args.option("template") {
        None => create_guide_draft(session, None),
        Some(requested) => {
            let template = resolve_guide_templates(&scope.records)
                .into_iter()
                .find(|candidate| {
                    candidate.id.to_lowercase() == requested.to_lowercase()
                        || candidate.name.to_lowercase() == requested.to_lowercase()
                })
                .ok_or_else(|| CliError(format!("Template “{requested}” was not found.")))?;
            create_guide_draft_from_sections(session, &template.id, &template.sections)
        }
    };
    if let Some(title) = args.option("title") {
        draft.title = title.to_owned();
    }
    let record = make_guide_record(&draft, &scope, None)?;
    let changes = guide_records_with_entry_links(&record, None, &scope.records)?;
    let saved = save_guide(path, snapshot, &changes)?;
    emit(
        output,
        plain(&saved),
        &format!(
            "Created study guide {} ({}).",
            saved.field("title").unwrap_or(""),
            saved.id
        ),
        args.json(),
    );
    Ok(0)
}

pub(crate) fn guide_generate(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let session_id = args.option("session").map(str::to_lowercase);
    let entry_id = args.option("entry-id").map(str::to_lowercase);
    if session_id.is_some() == entry_id.is_some() {
        return Err(CliError("Provide exactly one of --session or --entry-id.".to_owned()).into());
    }
    let scope = match (&session_id, &entry_id) {
        (Some(session_id), _) => read_guide_scope(snapshot, session_id)?,
        (_, Some(entry_id)) => read_guide_entry_scope(snapshot, entry_id)?,
        _ => unreachable!("checked above"),
    };
    let template = args.option("template").unwrap_or("auto");
    let mut draft = match (&scope.session, &scope.entry) {
        (Some(session), _) => generate_guide_draft_from_session(
            session,
            template,
            &scope.records,
            args.flag("include-entry-evidence"),
        )?,
        (_, Some(entry)) => generate_guide_draft_from_entry(entry, template, &scope.records)?,
        _ => unreachable!("scope requires a session or entry"),
    };
    if let Some(title) = args.option("title") {
        draft.title = title.to_owned();
    }
    let record = make_guide_record(&draft, &scope, None)?;
    let changes = guide_records_with_entry_links(&record, None, &scope.records)?;
    let saved = save_guide(path, snapshot, &changes)?;
    emit(
        output,
        plain(&saved),
        &format!(
            "Generated study guide {} ({}).",
            saved.field("title").unwrap_or(""),
            saved.id
        ),
        args.json(),
    );
    Ok(0)
}

fn update_block(block: &mut GuideBlock, args: &ParsedArguments) -> CliResult<()> {
    if args.flag("clear-sources") && args.option("sources").is_some() {
        return Err(CliError("Choose --sources or --clear-sources, not both.".to_owned()).into());
    }
    if let Some(text) = args.option("text") {
        block.text = text.to_owned();
        block.stale = false;
        block.origin = "human-edited".to_owned();
    }
    if let Some(kind) = args.option("kind") {
        if !GUIDE_BLOCK_KINDS.contains(&kind) {
            return Err(CliError(format!("Guide block kind “{kind}” is not supported.")).into());
        }
        block.kind = kind.to_owned();
        block.stale = false;
        if block.origin == "ai-generated" {
            block.origin = "human-edited".to_owned();
        }
    }
    if let Some(sources) = args.option("sources") {
        block.source_ids = source_list(sources);
        block.stale = false;
    }
    if args.flag("clear-sources") {
        block.source_ids.clear();
        block.stale = false;
    }
    if args.flag("mark-reviewed") {
        block.stale = false;
    }
    Ok(())
}

fn includes_entry_notes(
    draft: &GuideDraft,
    current: &ArchiveRecord,
    records: &[ArchiveRecord],
) -> bool {
    let entry_id = current.field("entry_id").unwrap_or("").to_lowercase();
    let entry_notes: BTreeSet<String> = records
        .iter()
        .filter(|record| {
            record.record_type == RecordType::SETTINGS
                && record.field("record_role") == Some("journal-notes")
                && record.field("entry_id").unwrap_or("").to_lowercase() == entry_id
                && record.field("session_id").unwrap_or("").to_lowercase()
                    != draft.session_id.to_lowercase()
        })
        .map(|record| record.id.to_lowercase())
        .collect();
    draft.sections.iter().any(|section| {
        section.blocks.iter().any(|block| {
            block
                .source_ids
                .iter()
                .any(|source| entry_notes.contains(&source.to_lowercase()))
        })
    })
}

pub(crate) fn guide_edit(
    action: &str,
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let id = args.required_position(0, "guide ID")?.to_lowercase();
    let (current, mut draft, scope) = read_guide_context(snapshot, &id)?;

    if action == "regenerate" {
        let include_entry_evidence = args.flag("include-entry-evidence")
            || (!args.flag("session-only")
                && includes_entry_notes(&draft, &current, &scope.records));
        let template = args.option("template").unwrap_or(&draft.template_id);
        let regenerated = match (&scope.session, &scope.entry) {
            (Some(session), _) => generate_guide_draft_from_session(
                session,
                template,
                &scope.records,
                include_entry_evidence,
            )?,
            (_, Some(entry)) => generate_guide_draft_from_entry(entry, template, &scope.records)?,
            _ => unreachable!("scope requires a session or entry"),
        };
        let mut replacement = regenerated;
        if let Some(raw) = args.option("section-index") {
            let index = guide_index(Some(raw), "section-index", draft.sections.len())?;
            let selected = &draft.sections[index];
            let matching = replacement
                .sections
                .iter()
                .find(|section| {
                    section.heading.trim().to_lowercase() == selected.heading.trim().to_lowercase()
                })
                .ok_or_else(|| {
                    CliError("No current evidence maps to the selected guide section.".to_owned())
                })?;
            let mut merged = draft.clone();
            merged.sections[index].blocks = matching.blocks.clone();
            replacement = merged;
        }
        replacement.title = args.option("title").unwrap_or(&draft.title).to_owned();
        let previous = guide_regeneration_target(Some(&current))?;
        let updated = make_guide_record(&replacement, &scope, previous.as_ref())?;
        let changes = guide_records_with_entry_links(&updated, previous.as_ref(), &scope.records)?;
        let saved = save_guide(path, snapshot, &changes)?;
        emit(
            output,
            plain(&saved),
            &format!("Regenerated study guide {}.", saved.id),
            args.json(),
        );
        return Ok(0);
    }
    if action == "approve" {
        let checked = make_guide_record(&draft, &scope, Some(&current))?;
        let approved = approve_guide_record(&checked)?;
        let changes = guide_records_with_entry_links(&approved, Some(&current), &scope.records)?;
        let saved = save_guide(path, snapshot, &changes)?;
        emit(
            output,
            plain(&saved),
            &format!("Approved study guide {}.", saved.id),
            args.json(),
        );
        return Ok(0);
    }
    if action == "duplicate" {
        draft.title = format!("{} (copy)", draft.title);
        let duplicated = make_guide_record(&draft, &scope, None)?;
        let changes = guide_records_with_entry_links(&duplicated, None, &scope.records)?;
        let saved = save_guide(path, snapshot, &changes)?;
        emit(
            output,
            plain(&saved),
            &format!("Duplicated study guide {}.", saved.id),
            args.json(),
        );
        return Ok(0);
    }

    if action == "update" || action == "edit" {
        let mut changed = false;
        if let Some(title) = args.option("title") {
            draft.title = title.to_owned();
            changed = true;
        }
        if let Some(heading) = args.option("heading") {
            let index = guide_index(
                args.option("section-index"),
                "section-index",
                draft.sections.len(),
            )?;
            draft.sections[index].heading = heading.to_owned();
            changed = true;
        }
        let editing_block = ["text", "kind", "sources"]
            .iter()
            .any(|option| args.option(option).is_some())
            || args.flag("clear-sources")
            || args.flag("mark-reviewed");
        if editing_block {
            let section_index = guide_index(
                args.option("section-index"),
                "section-index",
                draft.sections.len(),
            )?;
            let section = &mut draft.sections[section_index];
            let block_index = guide_index(
                args.option("block-index"),
                "block-index",
                section.blocks.len(),
            )?;
            update_block(&mut section.blocks[block_index], args)?;
            changed = true;
        }
        if args.option("approval-state").is_some() {
            changed = true;
        }
        if !changed {
            return Err(CliError(
                "Provide a title, heading, block, or approval-state change to update a guide."
                    .to_owned(),
            )
            .into());
        }
    } else if action == "add-section" || action == "section" {
        let heading = args.required_option("heading")?.to_owned();
        let mut blocks = Vec::new();
        if let Some(text) = args.option("text") {
            let kind = args.option("kind").unwrap_or("paragraph");
            if !GUIDE_BLOCK_KINDS.contains(&kind) {
                return Err(
                    CliError(format!("Guide block kind “{kind}” is not supported.")).into(),
                );
            }
            blocks.push(GuideBlock {
                kind: kind.to_owned(),
                text: text.to_owned(),
                source_ids: source_list(args.option("sources").unwrap_or("")),
                stale: false,
                origin: "tutor-authored".to_owned(),
            });
        }
        draft.sections.push(GuideSection {
            id: crate::core::archive::new_uuid(),
            heading,
            blocks,
        });
    } else if action == "remove-section" {
        let index = guide_index(
            args.option("section-index"),
            "section-index",
            draft.sections.len(),
        )?;
        draft.sections.remove(index);
    } else if action == "move-section" {
        let from = guide_index(args.option("from"), "from", draft.sections.len())?;
        let to = guide_index(args.option("to"), "to", draft.sections.len())?;
        let section = draft.sections.remove(from);
        draft.sections.insert(to, section);
    } else if action == "add-block" {
        let section_index = guide_index(
            args.option("section-index"),
            "section-index",
            draft.sections.len(),
        )?;
        let section = &mut draft.sections[section_index];
        let index = match args.option("block-index") {
            Some(raw) => {
                parse_integer(Some(raw), "block-index", 0, 0, section.blocks.len() as u64)? as usize
            }
            None => section.blocks.len(),
        };
        let kind = args.option("kind").unwrap_or("paragraph");
        if !GUIDE_BLOCK_KINDS.contains(&kind) {
            return Err(CliError(format!("Guide block kind “{kind}” is not supported.")).into());
        }
        section.blocks.insert(
            index,
            GuideBlock {
                kind: kind.to_owned(),
                text: args.required_option("text")?.to_owned(),
                source_ids: source_list(args.option("sources").unwrap_or("")),
                stale: false,
                origin: "tutor-authored".to_owned(),
            },
        );
    } else if action == "move-block" {
        let section_index = guide_index(
            args.option("section-index"),
            "section-index",
            draft.sections.len(),
        )?;
        let section = &mut draft.sections[section_index];
        let from = guide_index(args.option("from"), "from", section.blocks.len())?;
        let to = guide_index(args.option("to"), "to", section.blocks.len())?;
        let block = section.blocks.remove(from);
        section.blocks.insert(to, block);
    } else if action == "remove-block" {
        let section_index = guide_index(
            args.option("section-index"),
            "section-index",
            draft.sections.len(),
        )?;
        let section = &mut draft.sections[section_index];
        let block_index = guide_index(
            args.option("block-index"),
            "block-index",
            section.blocks.len(),
        )?;
        section.blocks.remove(block_index);
    } else if action == "update-block" {
        let section_index = guide_index(
            args.option("section-index"),
            "section-index",
            draft.sections.len(),
        )?;
        let section = &mut draft.sections[section_index];
        let block_index = guide_index(
            args.option("block-index"),
            "block-index",
            section.blocks.len(),
        )?;
        update_block(&mut section.blocks[block_index], args)?;
        if ["text", "kind", "sources"]
            .iter()
            .all(|option| args.option(option).is_none())
            && !args.flag("mark-reviewed")
            && !args.flag("clear-sources")
        {
            return Err(CliError(
                "Provide --text, --kind, --sources, or --mark-reviewed.".to_owned(),
            )
            .into());
        }
    } else {
        return Err(CliError(format!(
            "guide {action} is not implemented in the Rust CLI yet."
        ))
        .into());
    }

    let mut updated = make_guide_record(&draft, &scope, Some(&current))?;
    if let Some(state) = args.option("approval-state") {
        if !["draft", "proposed", "approved"].contains(&state) {
            return Err(CliError(
                "--approval-state must be draft, proposed, or approved.".to_owned(),
            )
            .into());
        }
        updated
            .fields
            .insert("approval_state".to_owned(), state.to_owned());
    }
    let changes = guide_records_with_entry_links(&updated, Some(&current), &scope.records)?;
    let saved = save_guide(path, snapshot, &changes)?;
    emit(
        output,
        plain(&saved),
        &format!("Study guide {} updated.", saved.id),
        args.json(),
    );
    Ok(0)
}
