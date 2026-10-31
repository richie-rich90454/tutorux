use super::*;

#[path = "asset_import.rs"]
mod asset_import;
#[path = "asset_import_actions.rs"]
mod asset_import_actions;
#[path = "asset_verify.rs"]
mod asset_verify;
#[path = "ordered_json.rs"]
mod ordered_json;
pub(crate) use asset_import::*;
pub(crate) use asset_verify::*;

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

fn edit_material(
    record: &ArchiveRecord,
    filename: &str,
    description: &str,
) -> CliResult<ArchiveRecord> {
    let name = filename.trim();
    let invalid = |value: &str, multiline: bool| {
        value.chars().any(|character| {
            let code = character as u32;
            code == 0x7f || (code < 0x20 && !(multiline && (code == 0x09 || code == 0x0a)))
        })
    };
    if name.is_empty() || name.len() > 1024 || invalid(name, false) {
        return Err(CliError(
            "Use a file name of up to 1024 bytes without control characters.".to_owned(),
        )
        .into());
    }
    if description.len() > 16_384 || invalid(description, true) {
        return Err(CliError(
            "The description is too long or contains unsupported characters.".to_owned(),
        )
        .into());
    }
    let mut updated = record.clone();
    updated
        .fields
        .insert("filename".to_owned(), name.to_owned());
    updated
        .fields
        .insert("description".to_owned(), description.to_owned());
    updated
        .fields
        .insert("updated_at_us".to_owned(), timestamp_now());
    Ok(updated)
}

pub(crate) fn run_asset(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let mut snapshot = load(path, context)?;
    match action {
        "add" | "import" | "import-folder" => asset_import_actions::run_asset_import(
            action,
            &args,
            output,
            path,
            context,
            &mut snapshot,
        ),
        "list" => {
            let mut records =
                snapshot.list_records(RecordType::ASSET_METADATA, args.flag("include-deleted"))?;
            if let Some(session) = args.option("session") {
                let session = session.to_lowercase();
                records.retain(|record| {
                    record.field("session_id").map(str::to_lowercase).as_deref()
                        == Some(session.as_str())
                });
            }
            records.retain(|record| {
                !matches!(
                    record.field("record_role"),
                    Some("audio-track")
                        | Some("recording-take")
                        | Some("waveform-pyramid")
                        | Some("sparse-timestamp-seek-index")
                        | Some("asset-blob-manifest")
                        | Some("asset-blob-chunk")
                )
            });
            let count = records.len();
            if args.json() {
                output.stdout(&ordered_json::records_json(&records));
                return Ok(0);
            }
            emit(
                output,
                plain_array(&records),
                if count == 0 {
                    "No materials."
                } else if count == 1 {
                    "1 material."
                } else {
                    return emit_materials(output, records, count, args.json());
                },
                args.json(),
            );
            Ok(0)
        }
        "show" | "preview" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            emit(
                output,
                plain(&record),
                &format!("Material {id}."),
                args.json(),
            );
            Ok(0)
        }
        "update" | "history" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            if action == "history" {
                let limit = parse_integer(args.option("limit"), "limit", 100, 1, 10_000)? as usize;
                let history =
                    snapshot.get_record_history(RecordType::ASSET_METADATA, &id, limit)?;
                let rows: Vec<Value> = history
                    .iter()
                    .enumerate()
                    .map(|(index, record)| {
                        let mut value = plain(record);
                        if let Value::Object(map) = &mut value {
                            map.insert("history_index".to_owned(), Value::Number(index.into()));
                        }
                        value
                    })
                    .collect();
                let summary = history
                    .iter()
                    .enumerate()
                    .map(|(index, record)| {
                        format!(
                            "{index}  revision {}  {}",
                            record.revision,
                            record.field("filename").unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if args.json() {
                    emit(output, Value::Array(rows), &summary, true);
                } else if summary.is_empty() {
                    output.stdout("No material history.");
                } else {
                    output.stdout(&summary);
                }
                return Ok(0);
            }
            if !args.option("filename").is_some() && !args.option("description").is_some() {
                return Err(CliError(
                    "Provide --filename or --description to update material details.".to_owned(),
                )
                .into());
            }
            let changed = edit_material(
                &current,
                args.option("filename")
                    .unwrap_or(current.field("filename").unwrap_or("")),
                args.option("description")
                    .unwrap_or(current.field("description").unwrap_or("")),
            )?;
            let saved = mutate(path, &snapshot, &[changed])?;
            emit(
                output,
                plain(&saved[0]),
                "Material details updated.",
                args.json(),
            );
            Ok(0)
        }
        "restore" if args.flag("revision") => {
            Err(CliError("--revision requires a history index.".to_owned()).into())
        }
        "restore" if args.option("revision").is_some() => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            let index = parse_integer(args.option("revision"), "revision", 0, 0, 10_000)? as usize;
            let revision = snapshot
                .get_record_history(RecordType::ASSET_METADATA, &id, index + 1)?
                .get(index)
                .cloned()
                .filter(|record| !record.deleted())
                .ok_or_else(|| {
                    CliError("That material revision is unavailable or deleted.".to_owned())
                })?;
            let changed = edit_material(
                &current,
                revision.field("filename").unwrap_or(""),
                revision.field("description").unwrap_or(""),
            )?;
            let saved = mutate(path, &snapshot, &[changed])?;
            emit(
                output,
                plain(&saved[0]),
                &format!("Material details restored from history index {index}."),
                args.json(),
            );
            Ok(0)
        }
        "remove" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            let mut fields = current.fields.clone();
            fields.insert("_deleted".to_owned(), "true".to_owned());
            let mut removed = current;
            removed.fields = fields;
            let saved = mutate(path, &snapshot, &[removed])?;
            emit(
                output,
                plain(&saved[0]),
                "Material reference removed; immutable blob remains until archive compaction.",
                args.json(),
            );
            Ok(0)
        }
        "restore" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let current = snapshot
                .get_record(RecordType::ASSET_METADATA, &id)?
                .ok_or_else(|| CliError(format!("Record {id} was not found in this archive.")))?;
            if !current.deleted() {
                return Err(CliError("Material is not in Trash.".to_owned()).into());
            }
            let mut restored = current;
            restored.fields.remove("_deleted");
            restored
                .fields
                .insert("restored_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[restored])?;
            emit(
                output,
                plain(&saved[0]),
                "Material restored from Trash.",
                args.json(),
            );
            Ok(0)
        }
        "verify" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            let valid = verify_asset(&snapshot, &record)?;
            emit(
                output,
                json!({"asset_id": record.id, "valid": valid, "sha256": record.field("content_hash").unwrap_or("")}),
                if valid {
                    "Asset content hash is valid."
                } else {
                    "Asset content hash mismatch."
                },
                args.json(),
            );
            Ok(if valid { 0 } else { 2 })
        }
        "extract" | "export" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            let destination = resolve_path(args.required_option("output")?);
            if same_path_public(path, &destination) {
                return Err(CliError(
                    "Material output cannot replace its source archive.".to_owned(),
                )
                .into());
            }
            let bytes = read_asset_bytes(&snapshot, &record)?;
            write_file_atomically(&destination, &bytes)?;
            emit(
                output,
                json!({
                    "id": record.id,
                    "output": output_path(&destination),
                    "bytes": bytes.len(),
                }),
                &format!(
                    "Exported {} to {}.",
                    record.field("filename").unwrap_or(&record.id),
                    destination.display()
                ),
                args.json(),
            );
            Ok(0)
        }
        "link" | "unlink" => {
            let asset_id = args.required_position(0, "material ID")?.to_lowercase();
            let target = args.required_option("to")?.to_lowercase();
            let target_id = args.required_option("target-id")?.to_lowercase();
            let record_type = match target.as_str() {
                "annotation" => RecordType::ANNOTATION,
                "transcript" => RecordType::TRANSCRIPT_SEGMENT,
                _ => {
                    return Err(CliError(
                        "Assets can currently link to annotations or transcript segments."
                            .to_owned(),
                    )
                    .into())
                }
            };
            let asset = require_live(&snapshot, RecordType::ASSET_METADATA, &asset_id)?;
            let mut current = require_live(&snapshot, record_type, &target_id)?;
            let asset_session = asset.field("session_id").unwrap_or("");
            let target_session = current.field("session_id").unwrap_or("");
            if !asset_session.is_empty() && asset_session != target_session {
                return Err(CliError(
                    "An asset cannot link to a record from a different session.".to_owned(),
                )
                .into());
            }
            let canonical = asset.id.to_lowercase();
            let mut linked: Vec<String> = current
                .field("linked_asset_ids")
                .unwrap_or("")
                .split(',')
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .collect();
            let existing = linked.iter().position(|id| id.to_lowercase() == canonical);
            if action == "link" && existing.is_none() {
                linked.push(canonical);
            }
            if action == "unlink" {
                if let Some(index) = existing {
                    linked.remove(index);
                }
            }
            current
                .fields
                .insert("linked_asset_ids".to_owned(), linked.join(","));
            if record_type == RecordType::TRANSCRIPT_SEGMENT {
                current
                    .fields
                    .insert("human_edited_at_us".to_owned(), timestamp_now());
            } else {
                current
                    .fields
                    .insert("updated_at_us".to_owned(), timestamp_now());
            }
            let saved = mutate(path, &snapshot, &[current])?;
            emit(
                output,
                plain(&saved[0]),
                if action == "link" {
                    "Asset linked to target."
                } else {
                    "Asset unlinked from target."
                },
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!(
            "asset {action} is not implemented in the Rust CLI yet."
        ))
        .into()),
    }
}

fn emit_materials(
    output: &mut dyn CliOutput,
    records: Vec<ArchiveRecord>,
    count: usize,
    json: bool,
) -> CliResult<i32> {
    emit(
        output,
        plain_array(&records),
        &format!("{count} materials."),
        json,
    );
    Ok(0)
}
