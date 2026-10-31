use super::*;

pub(crate) fn run_guide(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "create" | "generate" => {
            let session_id = args
                .option("session")
                .map(str::to_lowercase)
                .ok_or_else(|| CliError("--session is required.".to_owned()))?;
            require_live(&snapshot, RecordType::SESSION, &session_id)?;
            let record = make_guide(
                &snapshot,
                &session_id,
                args.option("template").unwrap_or("auto"),
                args.option("title").unwrap_or(""),
            )?;
            let saved = mutate(path, &snapshot, &[record])?;
            emit(output, plain(&saved[0]), "Study guide generated.", args.json());
            Ok(0)
        }
        "regenerate" => {
            let id = args.required_position(0, "guide ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::GUIDE, &id)?;
            let session_id = current.field("session_id").unwrap_or("").to_owned();
            let template = args.option("template").unwrap_or(current.field("template_id").unwrap_or("auto"));
            let regenerated = make_guide(
                &snapshot,
                &session_id,
                template,
                args.option("title").unwrap_or(current.field("title").unwrap_or("")),
            )?;
            let mut updated = regenerated;
            updated.id = current.id.clone();
            updated.fields.insert("revision".to_owned(), current.field("revision").unwrap_or("0").to_owned());
            updated.fields.insert("updated_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[updated])?;
            emit(output, plain(&saved[0]), "Study guide regenerated.", args.json());
            Ok(0)
        }
        "list" => {
            let mut records = snapshot.list_records(RecordType::GUIDE, args.flag("include-deleted"))?;
            if let Some(session) = args.option("session") {
                records.retain(|record| record.field("session_id").map(str::to_lowercase) == Some(session.to_lowercase()));
            }
            if let Some(entry) = args.option("entry-id") {
                records.retain(|record| record.field("entry_id").map(str::to_lowercase) == Some(entry.to_lowercase()));
            }
            emit(output, plain_array(&records), &format!("{} study guide(s).", records.len()), args.json());
            Ok(0)
        }
        "show" | "compare" | "validate" => {
            let id = args.required_position(0, "guide ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::GUIDE, &id)?;
            if action == "validate" {
                let index = parse_integer(args.option("revision"), "revision", 0, 0, 10_000)? as usize;
                let history = snapshot.get_record_history(RecordType::GUIDE, &id, index + 1)?;
                let record = history
                    .get(index)
                    .filter(|record| !record.deleted())
                    .ok_or_else(|| CliError("Study guide revision was not found.".to_owned()))?;
                let error = validate_guide(record).err().unwrap_or_default();
                let valid = error.is_empty();
                emit(
                    output,
                    json!({"guide_id": id, "revision": index, "valid": valid, "error": error}),
                    if valid {
                        "Guide structure and source references are valid."
                    } else {
                        "Guide validation failed."
                    },
                    args.json(),
                );
                return Ok(if valid { 0 } else { 2 });
            }
            if action == "compare" {
                let history = snapshot.get_record_history(RecordType::GUIDE, &id, 2)?;
                let current = history.first().ok_or_else(|| {
                    CliError("The guide needs a previous revision to compare.".to_owned())
                })?;
                let previous = history.get(1).ok_or_else(|| {
                    CliError("The guide needs a previous revision to compare.".to_owned())
                })?;
                emit(
                    output,
                    json!({
                        "current_title": current.field("title").unwrap_or(""),
                        "previous_title": previous.field("title").unwrap_or(""),
                        "current_revision": "0",
                        "previous_revision": "1",
                        "current_markdown": render_guide_markdown(current),
                        "previous_markdown": render_guide_markdown(previous),
                    }),
                    &format!(
                        "Revision 0: {}\nRevision 1: {}\n\n{}",
                        current.field("title").unwrap_or(""),
                        previous.field("title").unwrap_or(""),
                        render_guide_markdown(previous)
                    ),
                    args.json(),
                );
                return Ok(0);
            }
            if action == "show" {
                if args.json() {
                    emit(output, plain(&record), "", true);
                } else {
                    output.stdout(&render_guide_markdown(&record));
                }
                return Ok(0);
            }
            Ok(0)
        }
        "approve" | "trash" | "restore" => {
            let id = args.required_position(0, "guide ID")?.to_lowercase();
            let record = if action == "trash" {
                require_live(&snapshot, RecordType::GUIDE, &id)?
            } else {
                snapshot
                    .get_record(RecordType::GUIDE, &id)?
                    .ok_or_else(|| CliError(format!("Record {id} was not found in this archive.")))?
            };
            let updated = match action {
                "approve" => {
                    let mut updated = record;
                    updated
                        .fields
                        .insert("approval_state".to_owned(), "approved".to_owned());
                    updated
                        .fields
                        .insert("approved_at_us".to_owned(), timestamp_now());
                    updated
                        .fields
                        .insert("updated_at_us".to_owned(), timestamp_now());
                    updated.fields.remove("status");
                    updated
                }
                "trash" => {
                    let mut trashed = trash(&record);
                    trashed
                        .fields
                        .insert("_trash_group_id".to_owned(), record.id.clone());
                    trashed
                }
                _ => restore(&record),
            };
            let saved = mutate(path, &snapshot, &[updated])?;
            emit(output, plain(&saved[0]), "Study guide updated.", args.json());
            Ok(0)
        }
        "history" => {
            let id = args.required_position(0, "guide ID")?.to_lowercase();
            let history = snapshot.get_record_history(RecordType::GUIDE, &id, 10_000)?;
            emit(output, plain_array(&history), &format!("{} revision(s).", history.len()), args.json());
            Ok(0)
        }
        "update" => {
            let id = args.required_position(0, "guide ID")?.to_lowercase();
            let mut record = require_live(&snapshot, RecordType::GUIDE, &id)?;
            if let Some(title) = args.option("title") {
                record.fields.insert("title".to_owned(), title.to_owned());
            }
            record
                .fields
                .insert("updated_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[record])?;
            emit(output, plain(&saved[0]), "Study guide updated.", args.json());
            Ok(0)
        }
        "add-section" | "remove-section" | "move-section" | "add-block" | "update-block" | "remove-block" | "move-block" | "edit" => {
            let id = args.required_position(0, "guide ID")?.to_lowercase();
            let mut record = require_live(&snapshot, RecordType::GUIDE, &id)?;
            let mut sections = guide_sections(&record);
            let section_index = |name: &str, fallback: usize| -> CliResult<usize> {
                Ok(parse_integer(args.option(name), name, fallback as u64, 0, 100_000)? as usize)
            };
            match action {
                "add-section" => {
                    let heading = args.required_option("heading")?.to_owned();
                    let mut blocks = Vec::new();
                    if let Some(text) = args.option("text").filter(|value| !value.is_empty()) {
                        blocks.push(GuideBlock {
                            kind: "paragraph".to_owned(),
                            text: text.to_owned(),
                            source_ids: split_ids(args.option("sources").unwrap_or("")),
                            stale: false,
                            origin: "tutor-authored".to_owned(),
                        });
                    }
                    sections.push(GuideSection {
                        id: crate::core::archive::new_uuid(),
                        heading,
                        blocks,
                    });
                }
                "remove-section" => {
                    let index = section_index("section-index", 0)?;
                    if index >= sections.len() {
                        return Err(CliError("Section index is outside the guide.".to_owned()).into());
                    }
                    sections.remove(index);
                }
                "move-section" => {
                    let from = section_index("from", 0)?;
                    let to = section_index("to", 0)?;
                    if from >= sections.len() {
                        return Err(CliError("Section index is outside the guide.".to_owned()).into());
                    }
                    let section = sections.remove(from);
                    sections.insert(to.min(sections.len()), section);
                }
                "add-block" => {
                    let index = section_index("section-index", sections.len())?;
                    if index >= sections.len() {
                        return Err(CliError("Section index is outside the guide.".to_owned()).into());
                    }
                    let blocks = &mut sections[index].blocks;
                    let position = if args.option("block-index").is_some() {
                        section_index("block-index", blocks.len())?
                    } else {
                        blocks.len()
                    };
                    if position > blocks.len() {
                        return Err(CliError("Block index is outside the section.".to_owned()).into());
                    }
                    blocks.insert(
                        position,
                        GuideBlock {
                            kind: args.option("kind").unwrap_or("paragraph").to_owned(),
                            text: args
                                .option("text")
                                .ok_or_else(|| CliError("--text is required.".to_owned()))?
                                .to_owned(),
                            source_ids: split_ids(args.option("sources").unwrap_or("")),
                            stale: false,
                            origin: "tutor-authored".to_owned(),
                        },
                    );
                }
                "move-block" => {
                    let index = section_index("section-index", 0)?;
                    if index >= sections.len() {
                        return Err(CliError("Section index is outside the guide.".to_owned()).into());
                    }
                    let blocks = &mut sections[index].blocks;
                    let from = section_index("from", 0)?;
                    let to = section_index("to", 0)?;
                    if from >= blocks.len() || to >= blocks.len() {
                        return Err(CliError("Block index is outside the section.".to_owned()).into());
                    }
                    let block = blocks.remove(from);
                    blocks.insert(to, block);
                }
                "remove-block" => {
                    let index = section_index("section-index", 0)?;
                    if index >= sections.len() {
                        return Err(CliError("Section index is outside the guide.".to_owned()).into());
                    }
                    let blocks = &mut sections[index].blocks;
                    let block_index = section_index("block-index", blocks.len())?;
                    if block_index >= blocks.len() {
                        return Err(CliError("Block index is outside the section.".to_owned()).into());
                    }
                    blocks.remove(block_index);
                }
                "update-block" | "edit" => {
                    if let Some(title) = args.option("title") {
                        record.fields.insert("title".to_owned(), title.to_owned());
                    }
                    if let Some(index) = args.option("block-index") {
                        let section_index = section_index("section-index", 0)?;
                        if section_index >= sections.len() {
                            return Err(CliError("Section index is outside the guide.".to_owned()).into());
                        }
                        let block_index = parse_integer(Some(index), "block-index", 0, 0, 100_000)? as usize;
                        let block = sections[section_index]
                            .blocks
                            .get_mut(block_index)
                            .ok_or_else(|| CliError("Block index is outside the section.".to_owned()))?;
                        if let Some(text) = args.option("text") {
                            block.text = text.to_owned();
                            block.stale = false;
                            block.origin = "human-edited".to_owned();
                        }
                        if let Some(kind) = args.option("kind") {
                            block.kind = kind.to_owned();
                            block.stale = false;
                            if block.origin == "ai-generated" {
                                block.origin = "human-edited".to_owned();
                            }
                        }
                        if let Some(sources) = args.option("sources") {
                            block.source_ids = split_ids(sources);
                            block.stale = false;
                        }
                        if args.flag("clear-sources") {
                            block.source_ids.clear();
                            block.stale = false;
                        }
                        if args.flag("mark-reviewed") {
                            block.stale = false;
                        }
                    } else if let Some(index) = args.option("section-index") {
                        let index: usize = index
                            .parse()
                            .map_err(|_| CliError("--section-index must be an integer.".to_owned()))?;
                        if index >= sections.len() {
                            return Err(CliError("Section index is outside the guide.".to_owned()).into());
                        }
                        if let Some(heading) = args.option("heading") {
                            sections[index].heading = heading.to_owned();
                        }
                        if let Some(text) = args.option("text") {
                            if let Some(block) = sections[index].blocks.first_mut() {
                                block.text = text.to_owned();
                            } else {
                                sections[index].blocks.push(GuideBlock {
                                    kind: "paragraph".to_owned(),
                                    text: text.to_owned(),
                                    source_ids: Vec::new(),
                                    stale: false,
                                    origin: "tutor-authored".to_owned(),
                                });
                            }
                        }
                    }
                    if args.flag("mark-reviewed") {
                        record
                            .fields
                            .insert("reviewed_at_us".to_owned(), timestamp_now());
                    }
                }
                _ => {}
            }
            set_guide_sections(&mut record, &sections);
            record
                .fields
                .insert("updated_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[record])?;
            emit(output, plain(&saved[0]), "Study guide updated.", args.json());
            Ok(0)
        }
        "export" => {
            let id = args.required_position(0, "guide ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::GUIDE, &id)?;
            let destination = resolve_path(args.required_option("output")?);
            let format = args.option("format").unwrap_or("markdown").to_lowercase();
            if !["markdown", "md", "html", "json", "docx", "pdf"].contains(&format.as_str()) {
                return Err(CliError(
                    "Guide export format must be markdown, html, json, docx, or pdf.".to_owned(),
                )
                .into());
            }
            if matches!(format.as_str(), "docx" | "pdf") {
                return Err(CliError(
                    "DOCX and PDF guide export require the desktop application.".to_owned(),
                )
                .into());
            }
            if same_path_public(path, &destination) {
                return Err(CliError(
                    "Guide output cannot replace its source archive.".to_owned(),
                )
                .into());
            }
            if let Err(error) = validate_guide(&record) {
                return Err(CliError(error).into());
            }
            let text = guide_export_text(&record, if format == "md" { "markdown" } else { &format });
            write_file_atomically(&destination, text.as_bytes())?;
            emit(
                output,
                json!({"id": record.id, "output": output_path(&destination), "format": format}),
                &format!("Exported study guide to {}.", destination.display()),
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!("guide {action} is not implemented in the Rust CLI yet.")).into()),
    }
}

