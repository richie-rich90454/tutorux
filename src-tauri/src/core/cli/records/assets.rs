use super::*;

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

pub(crate) const ASSET_CHUNK_BYTES: usize = 8 * 1024 * 1024;

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    crate::core::archive::sha256(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn guess_mime(filename: &str) -> &'static str {
    match filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "txt" | "md" => "text/plain",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

pub(crate) fn import_asset(
    snapshot: &ArchiveSnapshot,
    bytes: &[u8],
    filename: &str,
    session_id: &str,
    _description: &str,
) -> Result<Vec<ArchiveRecord>> {
    let content_hash = sha256_hex(bytes);
    let existing_blob = snapshot
        .get_record_by_index_key(&format!("BLOB:{content_hash}"))?;
    let timestamp = now_us().to_string();
    let mut records = Vec::new();
    let blob_id;
    let mut chunk_count = bytes.len().div_ceil(ASSET_CHUNK_BYTES).max(1);
    if let Some(existing) = existing_blob {
        blob_id = existing.id.clone();
        if existing.field("record_role") == Some("asset-blob-manifest") {
            chunk_count = existing
                .field("chunk_count")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(chunk_count);
        }
    } else {
        blob_id = crate::core::archive::new_uuid();
        let mut chunk_ids = Vec::new();
        for (index, chunk) in bytes.chunks(ASSET_CHUNK_BYTES).enumerate() {
            let chunk_id = crate::core::archive::new_uuid();
            chunk_ids.push(chunk_id.clone());
            let mut record = ArchiveRecord::new(
                RecordType::ASSET_BLOB,
                chunk_id,
                [
                    ("record_role", "asset-blob-chunk".to_owned()),
                    ("manifest_id", blob_id.clone()),
                    ("chunk_index", index.to_string()),
                    ("byte_size", chunk.len().to_string()),
                ],
            );
            record.blob = chunk.to_vec();
            records.push(record);
        }
        records.push(ArchiveRecord::new(
            RecordType::ASSET_BLOB,
            &blob_id,
            [
                ("record_role", "asset-blob-manifest".to_owned()),
                ("content_hash", content_hash.clone()),
                ("byte_size", bytes.len().to_string()),
                ("chunk_count", chunk_count.to_string()),
                ("chunk_ids", chunk_ids.join(",")),
            ],
        ));
    }
    let mut fields = BTreeMap::new();
    fields.insert("filename".to_owned(), filename.to_owned());
    fields.insert("mime_type".to_owned(), guess_mime(filename).to_owned());
    fields.insert("byte_size".to_owned(), bytes.len().to_string());
    fields.insert("content_hash".to_owned(), content_hash);
    fields.insert("blob_id".to_owned(), blob_id);
    fields.insert("blob_count".to_owned(), chunk_count.to_string());
    fields.insert("origin".to_owned(), "user-import".to_owned());
    fields.insert("created_at_us".to_owned(), timestamp);
    if !session_id.is_empty() {
        fields.insert("session_id".to_owned(), session_id.to_owned());
    }
    let metadata = ArchiveRecord {
        record_type: RecordType::ASSET_METADATA,
        id: crate::core::archive::new_uuid(),
        revision: 0,
        previous_offset: 0,
        fields,
        blob: Vec::new(),
    };
    records.push(metadata);
    Ok(records)
}

pub(crate) fn asset_blob_records(
    snapshot: &ArchiveSnapshot,
    metadata: &ArchiveRecord,
) -> Result<Vec<ArchiveRecord>> {
    let blob_id = metadata.field("blob_id").unwrap_or("");
    let blob = snapshot
        .get_record(RecordType::ASSET_BLOB, blob_id)?
        .ok_or_else(|| CoreError::new("asset_blob_missing", "Material content blob is missing."))?;
    if blob.field("record_role") == Some("asset-blob-manifest") {
        let mut records = Vec::new();
        for chunk_id in blob.field("chunk_ids").unwrap_or("").split(',') {
            if chunk_id.is_empty() {
                continue;
            }
            let chunk = snapshot
                .get_record(RecordType::ASSET_BLOB, chunk_id.trim())?
                .ok_or_else(|| CoreError::new("asset_chunk_missing", "A material chunk is missing."))?;
            records.push(chunk);
        }
        Ok(records)
    } else {
        Ok(vec![blob])
    }
}

pub(crate) fn read_asset_bytes(snapshot: &ArchiveSnapshot, metadata: &ArchiveRecord) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    for chunk in asset_blob_records(snapshot, metadata)? {
        output.extend_from_slice(&chunk.blob);
    }
    let expected = sha256_hex(&output);
    if metadata.field("content_hash").map(str::to_lowercase) != Some(expected) {
        return err_hash_mismatch();
    }
    Ok(output)
}

pub(crate) fn err_hash_mismatch() -> Result<Vec<u8>> {
    Err(CoreError::new(
        "asset_hash_mismatch",
        "Material content hash does not match its metadata.",
    ))
}

pub(crate) fn run_asset(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "add" | "import" => {
            let input = resolve_path(
                args.positionals
                    .first()
                    .map(String::as_str)
                    .or(args.option("input"))
                    .ok_or_else(|| CliError("Material file path is required.".to_owned()))?,
            );
            let bytes = std::fs::read(&input).map_err(|error| {
                CoreError::new("asset_read_failed", format!("Could not read material: {error}"))
            })?;
            let filename = input
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("material");
            let session_id = args.option("session").unwrap_or("").to_lowercase();
            if !session_id.is_empty() {
                require_live(&snapshot, RecordType::SESSION, &session_id)?;
            }
            let records = import_asset(
                &snapshot,
                &bytes,
                filename,
                &session_id,
                args.option("description").unwrap_or(""),
            )?;
            let saved = mutate(path, &snapshot, &records)?;
            let metadata: Vec<Value> = saved
                .iter()
                .filter(|record| record.record_type == RecordType::ASSET_METADATA)
                .map(plain)
                .collect();
            emit(
                output,
                Value::Array(metadata),
                "Material imported.",
                args.json(),
            );
            Ok(0)
        }
        "import-folder" => {
            let directory = resolve_path(args.required_position(0, "material directory")?);
            let session_id = args.option("session").unwrap_or("").to_lowercase();
            let mut records = Vec::new();
            let mut imported = 0;
            let mut entries: Vec<std::path::PathBuf> = std::fs::read_dir(&directory)
                .map_err(|_| CliError("Material directory is unavailable.".to_owned()))?
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .collect();
            entries.sort();
            for entry in entries {
                let bytes = std::fs::read(&entry).map_err(|error| {
                    CoreError::new("asset_read_failed", format!("Could not read material: {error}"))
                })?;
                let filename = entry
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("material");
                records.extend(import_asset(&snapshot, &bytes, filename, &session_id, "")?);
                imported += 1;
            }
            let saved = mutate(path, &snapshot, &records)?;
            let metadata: Vec<Value> = saved
                .iter()
                .filter(|record| record.record_type == RecordType::ASSET_METADATA)
                .map(plain)
                .collect();
            emit(
                output,
                Value::Array(metadata),
                &format!("Imported {imported} material file(s)."),
                args.json(),
            );
            Ok(0)
        }
        "list" => {
            let mut records = snapshot.list_records(RecordType::ASSET_METADATA, args.flag("include-deleted"))?;
            if let Some(session) = args.option("session") {
                records.retain(|record| record.field("session_id").map(str::to_lowercase) == Some(session.to_lowercase()));
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
            emit(output, plain_array(&records), &format!("{} material(s).", records.len()), args.json());
            Ok(0)
        }
        "show" | "preview" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            emit(output, plain(&record), "Material.", args.json());
            Ok(0)
        }
        "verify" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            let valid = read_asset_bytes(&snapshot, &record).is_ok();
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
        "update" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let mut record = require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            if matches!(
                record.field("record_role"),
                Some("audio-track")
                    | Some("recording-take")
                    | Some("waveform-pyramid")
                    | Some("sparse-timestamp-seek-index")
                    | Some("asset-blob-manifest")
                    | Some("asset-blob-chunk")
            ) {
                return Err(CliError(
                    "Choose a material, rather than an internal recording or asset record.".to_owned(),
                )
                .into());
            }
            let mut changed = false;
            if let Some(filename) = args.option("filename") {
                let name = filename.trim();
                if name.is_empty()
                    || name.len() > 1024
                    || name.chars().any(|character| character as u32 == 0x7f || (character as u32) < 0x20)
                {
                    return Err(CliError(
                        "Use a file name of up to 1024 bytes without control characters.".to_owned(),
                    )
                    .into());
                }
                record.fields.insert("filename".to_owned(), name.to_owned());
                changed = true;
            }
            if let Some(description) = args.option("description") {
                if description.len() > 16_384
                    || description.chars().any(|character| {
                        let code = character as u32;
                        code == 0x7f || (code < 0x20 && !(code == 0x09 || code == 0x0a))
                    })
                {
                    return Err(CliError(
                        "The description is too long or contains unsupported characters.".to_owned(),
                    )
                    .into());
                }
                record
                    .fields
                    .insert("description".to_owned(), description.to_owned());
                changed = true;
            }
            if !changed {
                return Err(CliError(
                    "Provide --filename or --description to update material details.".to_owned(),
                )
                .into());
            }
            record.fields.insert("updated_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[record])?;
            emit(output, plain(&saved[0]), "Material details updated.", args.json());
            Ok(0)
        }
        "remove" | "restore" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let current = if action == "remove" {
                require_live(&snapshot, RecordType::ASSET_METADATA, &id)?
            } else {
                snapshot
                    .get_record(RecordType::ASSET_METADATA, &id)?
                    .ok_or_else(|| CliError(format!("Record {id} was not found in this archive.")))?
            };
            let mut fields = current.fields.clone();
            if action == "remove" {
                fields.insert("_deleted".to_owned(), "true".to_owned());
            } else {
                if current.field("_deleted") != Some("true") {
                    return Err(CliError("Material is not in Trash.".to_owned()).into());
                }
                fields.remove("_deleted");
                fields.insert("restored_at_us".to_owned(), timestamp_now());
            }
            let mut updated = current;
            updated.fields = fields;
            let saved = mutate(path, &snapshot, &[updated])?;
            emit(
                output,
                plain(&saved[0]),
                if action == "remove" {
                    "Material reference removed; immutable blob remains until archive compaction."
                } else {
                    "Material restored from Trash."
                },
                args.json(),
            );
            Ok(0)
        }
        "history" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let limit = parse_integer(args.option("limit"), "limit", 100, 1, 10_000)? as usize;
            let history = snapshot.get_record_history(RecordType::ASSET_METADATA, &id, limit)?;
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
            emit(output, Value::Array(rows), &format!("{} revision(s).", history.len()), args.json());
            Ok(0)
        }
        "extract" | "export" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            let destination = resolve_path(args.required_option("output")?);
            let bytes = read_asset_bytes(&snapshot, &record)?;
            write_file_atomically(&destination, &bytes)?;
            emit(
                output,
                json!({
                    "id": record.id,
                    "output": output_path(&destination),
                    "bytes": bytes.len(),
                }),
                &format!("Exported {} to {}.", record.field("filename").unwrap_or(&record.id), destination.display()),
                args.json(),
            );
            Ok(0)
        }
        "link" | "unlink" => {
            let id = args.required_position(0, "material ID")?.to_lowercase();
            let target = args.required_option("to")?.to_lowercase();
            let target_id = args.required_option("target-id")?.to_lowercase();
            let (record_type, field) = match target.as_str() {
                "annotation" => (RecordType::ANNOTATION, "linked_asset_ids"),
                "transcript" => (RecordType::TRANSCRIPT_SEGMENT, "linked_asset_ids"),
                _ => return Err(CliError("--to must be annotation or transcript.".to_owned()).into()),
            };
            require_live(&snapshot, RecordType::ASSET_METADATA, &id)?;
            let mut current = require_live(&snapshot, record_type, &target_id)?;
            let value = if action == "link" {
                merge_ids(current.field(field).unwrap_or(""), &id)
            } else {
                remove_ids(current.field(field).unwrap_or(""), &id)
            };
            current.fields.insert(field.to_owned(), value);
            if record_type == RecordType::TRANSCRIPT_SEGMENT {
                current
                    .fields
                    .insert("human_edited_at_us".to_owned(), timestamp_now());
            } else {
                current.fields.insert("updated_at_us".to_owned(), timestamp_now());
            }
            let saved = mutate(path, &snapshot, &[current])?;
            emit(output, plain(&saved[0]), "Material link updated.", args.json());
            Ok(0)
        }
        _ => Err(CliError(format!("asset {action} is not implemented in the Rust CLI yet.")).into()),
    }
}

