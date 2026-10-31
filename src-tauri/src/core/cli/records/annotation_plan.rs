use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{emit, parse_integer, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{valid_uuid, RecordType};
use serde_json::json;

fn session_track_ids(session: &crate::core::format::ArchiveRecord, session_id: &str, assets: &[crate::core::format::ArchiveRecord]) -> Vec<String> {
    let mut track_ids: Vec<String> = Vec::new();
    let mut add = |value: &str| {
        let id = value.trim().to_lowercase();
        if valid_uuid(&id) && !track_ids.contains(&id) {
            track_ids.push(id);
        }
    };
    for field in ["recording_track_ids", "recording_track_id", "audio_import_track_id"] {
        for value in session.field(field).unwrap_or("").split(',') {
            add(value);
        }
    }
    for metadata in assets {
        if metadata.field("record_role") == Some("audio-track")
            && metadata
                .field("session_id")
                .map(str::to_lowercase)
                .as_deref()
                == Some(session_id)
        {
            add(metadata.field("track_id").filter(|value| !value.is_empty()).unwrap_or(&metadata.id));
        }
    }
    track_ids
}

pub(crate) fn run_annotation_plan(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
) -> CliResult<i32> {
    let session_id = args.required_option("session")?.trim().to_lowercase();
    if !valid_uuid(&session_id) {
        return Err(CliError("--session must be a valid UUID.".to_owned()).into());
    }
    let track_id = match args.option("track") {
        Some(value) => {
            let track = value.trim().to_lowercase();
            if !valid_uuid(&track) {
                return Err(CliError("--track must be a valid UUID.".to_owned()).into());
            }
            Some(track)
        }
        None => None,
    };
    let threads = parse_integer(args.option("threads"), "threads", 0, 1, 64)?;
    let model_memory = parse_integer(
        args.option("model-memory-mb"),
        "model-memory-mb",
        0,
        1,
        1_048_576,
    )?;
    let available_memory = parse_integer(
        args.option("available-memory-mb"),
        "available-memory-mb",
        0,
        1,
        1_048_576,
    )?;
    let hardware = std::thread::available_parallelism()
        .map(|value| value.get() as u64)
        .unwrap_or(1)
        .max(1);
    let session = match snapshot.get_record(RecordType::SESSION, &session_id)? {
        Some(record) if !record.deleted() => record,
        _ => {
            return Err(
                CliError(format!("Record {session_id} was not found in this archive.")).into(),
            )
        }
    };
    let mut workers = hardware.saturating_sub(1).max(1).min(if threads == 0 {
        hardware
    } else {
        threads
    });
    if model_memory == 0 || available_memory == 0 {
        workers = 1;
    } else {
        let memory_workers = available_memory / model_memory;
        if memory_workers == 0 {
            return Err(CliError(
                "The transcription model exceeds the available memory budget.".to_owned(),
            )
            .into());
        }
        workers = workers.min(memory_workers);
    }
    let assets = snapshot.list_records(RecordType::ASSET_METADATA, false)?;
    let tracks = session_track_ids(&session, &session_id, &assets)
        .into_iter()
        .filter(|id| track_id.as_ref().map_or(true, |selected| selected == id));
    let mut work = Vec::new();
    let mut count = 0u64;
    let mut estimated = 0u128;
    for track in tracks {
        let chunks = snapshot.list_audio_chunk_metadata(&session_id, &track, false)?;
        let mut duration = 0u128;
        for chunk in &chunks {
            let raw = chunk.field("timeline_end_us").unwrap_or("0");
            if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(CliError("Audio timeline metadata is invalid.".to_owned()).into());
            }
            let end: u128 = raw
                .parse()
                .map_err(|_| CliError("Audio timeline metadata is invalid.".to_owned()))?;
            duration = duration.max(end);
        }
        if duration == 0 {
            continue;
        }
        count += 1;
        let elapsed = duration.div_ceil(workers as u128);
        estimated = estimated.max(elapsed);
        if (duration + 29_999_999) / 30_000_000 > 100_000u128.saturating_sub(work.len() as u128)
        {
            return Err(
                CliError("Transcription plan exceeds the 100,000 work item limit.".to_owned())
                    .into(),
            );
        }
        let mut start = 0u128;
        while start < duration {
            let end = (start + 30_000_000).min(duration);
            work.push(json!({
                "work_id": format!("{session_id}:{track}:{start}"),
                "track_id": track,
                "start_time_us": start.to_string(),
                "end_time_us": end.to_string(),
                "priority": 2,
                "provisional": true,
            }));
            start += 30_000_000;
        }
    }
    if count == 0 {
        return Err(CliError(
            "The session has no audio chunks for the selected track.".to_owned(),
        )
        .into());
    }
    let summary = format!(
        "Transcription plan: {count} track(s), {} bounded work item(s), {workers} worker(s), estimated {estimated} µs elapsed.\n{}",
        work.len(),
        work.iter()
            .map(|item| format!(
                "  {} [{}, {})",
                item["track_id"].as_str().unwrap_or(""),
                item["start_time_us"].as_str().unwrap_or(""),
                item["end_time_us"].as_str().unwrap_or("")
            ))
            .collect::<Vec<_>>()
            .join("\n")
    );
    emit(
        output,
        json!({
            "session_id": session_id,
            "track_count": count,
            "chunk_count": work.len(),
            "worker_count": workers,
            "estimated_work_duration_us": estimated.to_string(),
            "work": work,
        }),
        &summary,
        args.json(),
    );
    Ok(0)
}
