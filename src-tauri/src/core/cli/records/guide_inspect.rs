use super::super::*;
use super::{read_guide_entry_scope, read_guide_scope};

fn same_path(left: &std::path::Path, right: &std::path::Path) -> bool {
    super::super::same_path_public(left, right)
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

fn failure_message(error: crate::core::cli::Failure) -> String {
    match error {
        crate::core::cli::Failure::Usage(message) => message,
        crate::core::cli::Failure::Core(error) => error.message,
    }
}

pub(crate) fn run_guide_inspect(
    action: &str,
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let id = args.required_position(0, "study guide ID")?.to_lowercase();
    match action {
        "validate" => {
            let index = parse_integer(args.option("revision"), "revision", 0, 0, 10_000)? as usize;
            let history = snapshot.get_record_history(RecordType::GUIDE, &id, index + 1)?;
            let record = history
                .get(index)
                .filter(|record| !record.deleted())
                .ok_or_else(|| CliError("Study guide revision was not found.".to_owned()))?;
            let error = (|| -> CliResult<()> {
                let draft = guide_draft(record);
                let scope = if !draft.session_id.is_empty() {
                    read_guide_scope(snapshot, &draft.session_id)?
                } else {
                    read_guide_entry_scope(snapshot, &draft.entry_id)?
                };
                make_guide_record(&draft, &scope, Some(record))?;
                validate_guide_for_export(record, Some(&scope))?;
                Ok(())
            })()
            .err()
            .map(failure_message)
            .unwrap_or_default();
            let valid = error.is_empty();
            let message = if valid {
                "Guide structure and source references are valid.".to_owned()
            } else {
                format!("Guide validation failed: {error}")
            };
            emit(
                output,
                json!({"guide_id": id, "revision": index, "valid": valid, "error": error}),
                &message,
                args.json(),
            );
            Ok(if valid { 0 } else { 2 })
        }
        "compare" => {
            let history = snapshot.get_record_history(RecordType::GUIDE, &id, 2)?;
            let current = history.first().ok_or_else(|| {
                CliError("The guide needs a previous revision to compare.".to_owned())
            })?;
            let previous = history.get(1).ok_or_else(|| {
                CliError("The guide needs a previous revision to compare.".to_owned())
            })?;
            let result = json!({
                "current_title": current.field("title").unwrap_or(""),
                "previous_title": previous.field("title").unwrap_or(""),
                "current_revision": "0",
                "previous_revision": "1",
                "current_markdown": render_guide_markdown(current),
                "previous_markdown": render_guide_markdown(previous),
            });
            emit(
                output,
                result,
                &format!(
                    "Revision 0: {}\nRevision 1: {}\n\n{}",
                    current.field("title").unwrap_or(""),
                    previous.field("title").unwrap_or(""),
                    render_guide_markdown(previous)
                ),
                args.json(),
            );
            Ok(0)
        }
        "show" => {
            let record = require_live(snapshot, RecordType::GUIDE, &id)?;
            if args.json() {
                emit(output, plain(&record), "", true);
            } else {
                output.stdout(&render_guide_markdown(&record));
            }
            Ok(0)
        }
        "export" => {
            let format = args.option("format").unwrap_or("markdown").to_lowercase();
            if !["markdown", "md", "html", "json", "docx", "pdf"].contains(&format.as_str()) {
                return Err(CliError(
                    "Guide export format must be markdown, html, json, docx, or pdf.".to_owned(),
                )
                .into());
            }
            let index = parse_integer(args.option("revision"), "revision", 0, 0, 10_000)? as usize;
            let record = if index == 0 {
                require_live(snapshot, RecordType::GUIDE, &id)?
            } else {
                snapshot
                    .get_record_history(RecordType::GUIDE, &id, index + 1)?
                    .get(index)
                    .cloned()
                    .ok_or_else(|| {
                        CliError(format!("Guide history index {index} was not found."))
                    })?
            };
            let mut images: BTreeMap<String, GuideExportImage> = BTreeMap::new();
            if matches!(format.as_str(), "html" | "docx" | "pdf") {
                for asset_id in guide_image_ids(&record)? {
                    let metadata = require_live(snapshot, RecordType::ASSET_METADATA, &asset_id)?;
                    let mime_type = metadata.field("mime_type").unwrap_or("");
                    if !matches!(
                        mime_type,
                        "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp"
                    ) {
                        return Err(CliError(format!(
                            "Guide image {asset_id} has an unsupported image format."
                        ))
                        .into());
                    }
                    images.insert(
                        asset_id.clone(),
                        GuideExportImage {
                            mime_type: mime_type.to_owned(),
                            bytes: read_asset_bytes(snapshot, &metadata)?,
                        },
                    );
                }
            }
            let draft = guide_draft(&record);
            let scope = if !draft.session_id.is_empty() {
                read_guide_scope(snapshot, &draft.session_id)?
            } else {
                read_guide_entry_scope(snapshot, &draft.entry_id)?
            };
            validate_guide_for_export(&record, Some(&scope))?;
            let destination = resolve_path(args.required_option("output")?);
            if same_path(path, &destination) {
                return Err(
                    CliError("Guide output cannot replace its source archive.".to_owned()).into(),
                );
            }
            let contents: Vec<u8> = match format.as_str() {
                "docx" => render_guide_docx(&record, &images)?,
                "pdf" => render_guide_pdf(&record)?,
                "html" => render_guide_html(&record, &images)?.into_bytes(),
                "json" => serialize_guide_json(&record).into_bytes(),
                _ => render_guide_markdown(&record).into_bytes(),
            };
            write_file_atomically(&destination, &contents)?;
            emit(
                output,
                json!({
                    "id": record.id,
                    "output": output_path(&destination),
                    "format": format,
                }),
                &format!("Exported study guide to {}.", destination.display()),
                args.json(),
            );
            Ok(0)
        }
        "history" => {
            let limit = parse_integer(args.option("limit"), "limit", 100, 1, 10_000)? as usize;
            let history = snapshot.get_record_history(RecordType::GUIDE, &id, limit)?;
            emit(
                output,
                plain_array(&history),
                &format!(
                    "{} guide revision{}.",
                    history.len(),
                    if history.len() == 1 { "" } else { "s" }
                ),
                args.json(),
            );
            Ok(0)
        }
        "trash" | "delete" | "restore" => {
            let record = snapshot
                .get_record(RecordType::GUIDE, &id)?
                .ok_or_else(|| CliError(format!("Study guide {id} was not found.")))?;
            if action == "restore" {
                if !record.deleted() {
                    return Err(CliError(format!("Study guide {id} is not in Trash.")).into());
                }
            } else if record.deleted() {
                return Err(CliError(format!("Study guide {id} was not found.")).into());
            }
            let changed = if action == "restore" {
                restore(&record)
            } else {
                let mut trashed = trash(&record);
                trashed
                    .fields
                    .insert("_trash_group_id".to_owned(), record.id.clone());
                trashed
            };
            let entries = snapshot.list_records(RecordType::SETTINGS, true)?;
            let changes = guide_records_with_entry_links(&changed, Some(&record), &entries)?;
            let saved = save_guide(path, snapshot, &changes)?;
            emit(
                output,
                json!({"id": saved.id, "deleted": action != "restore"}),
                if action == "restore" {
                    "Study guide restored."
                } else {
                    "Study guide moved to Trash."
                },
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!(
            "guide {action} is not implemented in the Rust CLI yet."
        ))
        .into()),
    }
}
