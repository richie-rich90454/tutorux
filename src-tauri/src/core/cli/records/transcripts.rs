use super::*;

#[path = "transcript_audio.rs"]
mod transcript_audio;

#[path = "transcript_cues.rs"]
mod transcript_cues;

#[path = "transcript_plan.rs"]
mod transcript_plan;

#[path = "transcript_whisper.rs"]
mod transcript_whisper;

use transcript_plan::run_transcript_plan;
use transcript_whisper::run_transcript_transcription;

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
            run_transcript_transcription(action, &snapshot, &args, output, path)
        }
        "plan" => run_transcript_plan(&args, output, &snapshot),
        _ => Err(CliError(format!(
            "transcript {action} is not implemented in the Rust CLI yet."
        ))
        .into()),
    }
}
