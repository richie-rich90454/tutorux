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
            let metadata = std::fs::symlink_metadata(&input).map_err(|_| {
                CliError("Transcript input must be a regular, non-symlink file.".to_owned())
            })?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(CliError(
                    "Transcript input must be a regular, non-symlink file.".to_owned(),
                )
                .into());
            }
            if metadata.len() > 256 * 1024 * 1024 {
                return Err(CliError(
                    "Transcript source exceeds the configured 256 MiB limit.".to_owned(),
                )
                .into());
            }
            let text = std::fs::read_to_string(&input).map_err(|error| {
                CoreError::new(
                    "transcript_read_failed",
                    format!("Could not read transcript: {error}"),
                )
            })?;
            let format = args.option("format").unwrap_or("auto");
            let format = if format == "auto" {
                match input
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "srt" => "srt",
                    "vtt" => "vtt",
                    _ => "text",
                }
            } else {
                format
            };
            if !matches!(format, "text" | "srt" | "vtt") {
                return Err(CliError(
                    "Transcript format must be auto, text, srt, or vtt.".to_owned(),
                )
                .into());
            }
            let cues = parse_transcript_source(&text, format)?;
            let filename = input
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("transcript");
            let records = make_transcript_records(&session_id, &cues, format, filename);
            let imported_count = records.len();
            if !records.is_empty() {
                mutate(path, &snapshot, &records)?;
                let fresh = load(path, context)?;
                if let Some(mut session) = fresh.get_record(RecordType::SESSION, &session_id)? {
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
                    mutate(path, &fresh, &[session])?;
                }
            }
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
                .filter(|record| {
                    record.field("session_id").map(str::to_lowercase) == Some(session_id.clone())
                })
                .collect();
            if action == "search" {
                let query = args.option("query").ok_or_else(|| {
                    CliError("--query is required for transcript search.".to_owned())
                })?;
                records.retain(|record| record.field("text").unwrap_or("").contains(query));
            }
            transcript_sort(&mut records);
            if action == "export" {
                let destination = resolve_path(args.required_option("output")?);
                let format = args.option("format").unwrap_or("text");
                if !matches!(format, "text" | "srt" | "vtt" | "json") {
                    return Err(CliError(
                        "Transcript export format must be text, srt, vtt, or json.".to_owned(),
                    )
                    .into());
                }
                write_file_atomically(
                    &destination,
                    transcript_export(&records, format)?.as_bytes(),
                )?;
                emit(
                    output,
                    json!({"output": output_path(&destination), "format": format, "segment_count": records.len().to_string()}),
                    &format!("Exported {format} transcript to {}.", destination.display()),
                    args.json(),
                );
                return Ok(0);
            }
            if args.json() {
                emit(
                    output,
                    Value::Array(records.iter().map(transcript_json).collect()),
                    &format!("{} transcript segment(s).", records.len()),
                    true,
                );
            } else {
                let lines: Vec<String> = records
                    .iter()
                    .map(|record| {
                        format!(
                            "[{}] {}",
                            transcript_time_range(record),
                            record.field("text").unwrap_or("")
                        )
                    })
                    .collect();
                let text = if lines.is_empty() {
                    "No transcript segments found.".to_owned()
                } else {
                    lines.join("\n")
                };
                output.stdout(&text);
            }
            Ok(0)
        }
        "correct" | "timestamp" | "verify" | "speaker" | "split" | "merge" | "history"
        | "restore" => run_transcript_edit(action, &snapshot, &args, output, path),
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
            if let Some(track) = args.option("track") {
                if !is_uuid(&track.to_lowercase()) {
                    return Err(CliError("--track must be a valid UUID.".to_owned()).into());
                }
            }
            let threads = parse_integer(args.option("threads"), "threads", 0, 0, 64)?;
            let model_memory = parse_integer(
                args.option("model-memory-mb"),
                "model-memory-mb",
                512,
                0,
                1_048_576,
            )?;
            let available_memory = parse_integer(
                args.option("available-memory-mb"),
                "available-memory-mb",
                0,
                0,
                1_048_576,
            )?;
            let hardware = std::thread::available_parallelism()
                .map(|value| value.get() as u64)
                .unwrap_or(1)
                .max(1);
            let effective_threads = if threads == 0 {
                hardware.min(8)
            } else {
                threads
            };
            let estimated_memory = model_memory + 128 + effective_threads * 16;
            let feasible = available_memory == 0 || estimated_memory <= available_memory;
            let session = require_live(&snapshot, RecordType::SESSION, &session_id)?;
            emit(
                output,
                json!({
                    "session_id": session_id,
                    "track_id": args.option("track").unwrap_or("").to_lowercase(),
                    "duration_us": session.field("audio_duration_us").unwrap_or("0"),
                    "threads": effective_threads,
                    "model_memory_mb": model_memory,
                    "estimated_memory_mb": estimated_memory,
                    "available_memory_mb": available_memory,
                    "available_known": available_memory != 0,
                    "feasible": feasible,
                }),
                &format!(
                    "Transcription plan: {effective_threads} thread(s), {estimated_memory} MB estimated working memory{}.",
                    if available_memory == 0 {
                        "; available memory not supplied".to_owned()
                    } else {
                        format!(
                            ", {} the available {available_memory} MB",
                            if feasible { "within" } else { "above" }
                        )
                    }
                ),
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!(
            "transcript {action} is not implemented in the Rust CLI yet."
        ))
        .into()),
    }
}
