use super::*;

pub(crate) fn run_transcript(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "import" => {
            let session_id = args.required_option("session")?.to_lowercase();
            require_live(&snapshot, RecordType::SESSION, &session_id)?;
            let input = resolve_path(
                args.option("input")
                    .map(str::to_owned)
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| CliError("--input is required.".to_owned()))?
                    .as_str(),
            );
            let text = std::fs::read_to_string(&input).map_err(|error| {
                CoreError::new("transcript_read_failed", format!("Could not read transcript: {error}"))
            })?;
            let format = args.option("format").unwrap_or("auto");
            let format = if format == "auto" {
                match input.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
                    "srt" => "srt",
                    "vtt" => "vtt",
                    _ => "text",
                }
            } else {
                format
            };
            if !matches!(format, "text" | "srt" | "vtt") {
                return Err(CliError("Transcript format must be auto, text, srt, or vtt.".to_owned()).into());
            }
            let cues = parse_transcript_source(&text, format)?;
            let filename = input.file_name().and_then(|value| value.to_str()).unwrap_or("transcript");
            let mut records = make_transcript_records(&session_id, &cues, format, filename);
            if !records.is_empty() {
                if let Some(mut session) = snapshot.get_record(RecordType::SESSION, &session_id)? {
                    session
                        .fields
                        .insert("processing_state".to_owned(), "review-required".to_owned());
                    session.fields.insert(
                        "processing_detail".to_owned(),
                        "Imported transcript is provisional and ready for tutor review.".to_owned(),
                    );
                    session
                        .fields
                        .insert("processing_updated_at_us".to_owned(), timestamp_now());
                    records.push(session);
                }
            }
            let saved = mutate(path, &snapshot, &records)?;
            let imported_count = saved
                .iter()
                .filter(|record| record.record_type == RecordType::TRANSCRIPT_SEGMENT)
                .count();
            emit(
                output,
                json!({
                    "session_id": session_id,
                    "source_format": format,
                    "imported_segment_count": imported_count.to_string(),
                    "verification_state": "provisional",
                }),
                &format!(
                    "Imported {imported_count} transcript segment(s) from {format}; all imported text is provisional pending tutor review."
                ),
                args.json(),
            );
            Ok(0)
        }
        "show" | "search" | "export" => {
            let session_id = args.required_option("session")?.to_lowercase();
            require_live(&snapshot, RecordType::SESSION, &session_id)?;
            let mut records: Vec<ArchiveRecord> = snapshot
                .list_records(RecordType::TRANSCRIPT_SEGMENT, args.flag("include-deleted"))?
                .into_iter()
                .filter(|record| record.field("session_id").map(str::to_lowercase) == Some(session_id.clone()))
                .collect();
            if action == "search" {
                let query = args
                    .option("query")
                    .ok_or_else(|| CliError("--query is required for transcript search.".to_owned()))?;
                records.retain(|record| record.field("text").unwrap_or("").contains(query));
            }
            transcript_sort(&mut records);
            if action == "export" {
                let destination = resolve_path(args.required_option("output")?);
                let format = args.option("format").unwrap_or("text");
                if !matches!(format, "text" | "srt" | "vtt" | "json") {
                    return Err(CliError("Transcript export format must be text, srt, vtt, or json.".to_owned()).into());
                }
                write_file_atomically(&destination, transcript_export(&records, format)?.as_bytes())?;
                emit(
                    output,
                    json!({"output": output_path(&destination), "format": format, "segment_count": records.len().to_string()}),
                    &format!("Exported {format} transcript to {}.", destination.display()),
                    args.json(),
                );
                return Ok(0);
            }
            emit(
                output,
                plain_array(&records),
                &format!("{} transcript segment(s).", records.len()),
                args.json(),
            );
            Ok(0)
        }
        "correct" | "timestamp" | "verify" | "speaker" | "split" | "merge" | "history" | "restore" => run_transcript_edit(action, &snapshot, &args, output, path),
        "transcribe" | "generate" | "refine" => {
            let session_id = args.required_option("session")?.to_lowercase();
            require_live(&snapshot, RecordType::SESSION, &session_id)?;
            let has_audio = snapshot
                .list_records(RecordType::AUDIO_CHUNK, false)?
                .iter()
                .any(|record| {
                    record.field("session_id").map(str::to_lowercase) == Some(session_id.clone())
                });
            if !has_audio {
                return Err(CliError("The session has no recorded audio track.".to_owned()).into());
            }
            if args.option("whisper").is_none() || args.option("model").is_none() {
                return Err(CliError(
                    "Whisper model and executable are required for transcription.".to_owned(),
                )
                .into());
            }
            Err(CliError(
                "Whisper transcription runs through the native desktop backend; use the desktop workspace or the bundled audio helper."
                    .to_owned(),
            )
            .into())
        }
        "plan" => {
            let session_id = args.required_option("session")?.to_lowercase();
            require_live(&snapshot, RecordType::SESSION, &session_id)?;
            let threads = parse_integer(args.option("threads"), "threads", 4, 1, 64)?;
            emit(
                output,
                json!({
                    "session_id": session_id,
                    "threads": threads.to_string(),
                    "model_memory_mb": args.option("model-memory-mb").unwrap_or("0"),
                    "available_memory_mb": args.option("available-memory-mb").unwrap_or("0"),
                    "status": "ready",
                }),
                "Transcription plan prepared.",
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!("transcript {action} is not implemented in the Rust CLI yet.")).into()),
    }
}

