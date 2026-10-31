use super::transcript_audio::{field_u64, session_track_ids, track_chunk_keys};
use super::*;

fn detected_available_memory_mb() -> u64 {
    crate::diagnostics::available_system_memory_bytes()
        .ok()
        .map(|bytes| (bytes / 1_048_576).max(1))
        .unwrap_or(0)
}

fn memory_plan(threads: u64, model_memory: u64, available: u64) -> (u64, bool) {
    let estimated = model_memory
        .saturating_add(128)
        .saturating_add(threads.saturating_mul(16));
    let known = available != 0;
    (estimated, !known || estimated <= available)
}

fn minutes_for(duration_us: u64) -> f64 {
    let minutes = duration_us as f64 / 60_000_000.0;
    (minutes * 100.0).round() / 100.0
}

fn metadata_error() -> CoreError {
    CoreError::new(
        "audio_chunk_metadata_invalid",
        "Recording audio metadata is invalid.",
    )
}

fn track_stats(
    snapshot: &ArchiveSnapshot,
    session_id: &str,
    track_id: &str,
) -> std::result::Result<(usize, u64), CoreError> {
    let keys = track_chunk_keys(snapshot, session_id, track_id);
    if !keys.is_empty() {
        let key = keys.last().ok_or_else(metadata_error)?;
        let record = snapshot
            .get_record_by_index_key(key)?
            .ok_or_else(metadata_error)?;
        let rate = field_u64(&record, "sample_rate_hz").ok_or_else(metadata_error)?;
        let first = field_u64(&record, "first_sample_index").ok_or_else(metadata_error)?;
        let count = field_u64(&record, "sample_count").ok_or_else(metadata_error)?;
        if rate == 0 {
            return Err(metadata_error());
        }
        let frames = first.checked_add(count).ok_or_else(metadata_error)?;
        return Ok((keys.len(), frames.saturating_mul(1_000_000) / rate));
    }
    let chunks = snapshot.list_audio_chunk_metadata(session_id, track_id, false)?;
    let Some(record) = chunks.last() else {
        return Ok((0, 0));
    };
    let rate = field_u64(record, "sample_rate_hz").ok_or_else(metadata_error)?;
    let first = field_u64(record, "first_sample_index").ok_or_else(metadata_error)?;
    let count = field_u64(record, "sample_count").ok_or_else(metadata_error)?;
    if rate == 0 {
        return Err(metadata_error());
    }
    let frames = first.checked_add(count).ok_or_else(metadata_error)?;
    Ok((chunks.len(), frames.saturating_mul(1_000_000) / rate))
}

pub(crate) fn run_transcript_plan(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    snapshot: &ArchiveSnapshot,
) -> CliResult<i32> {
    let session_id = args.required_option("session")?.to_lowercase();
    let requested_track = match args.option("track") {
        Some(track) => {
            if !crate::core::format::valid_uuid(track.trim()) {
                return Err(CliError("--track must be a valid UUID.".to_owned()).into());
            }
            Some(track.trim().to_lowercase())
        }
        None => None,
    };
    let threads = parse_integer(args.option("threads"), "threads", 0, 0, 64)?;
    let model_memory = parse_integer(
        args.option("model-memory-mb"),
        "model-memory-mb",
        512,
        0,
        1_048_576,
    )?;
    let available_memory = match args.option("available-memory-mb") {
        Some(_) => parse_integer(
            args.option("available-memory-mb"),
            "available-memory-mb",
            0,
            0,
            1_048_576,
        )?,
        None => detected_available_memory_mb(),
    };
    let hardware = std::thread::available_parallelism()
        .map(|value| value.get() as u64)
        .unwrap_or(1)
        .max(1);
    let effective_threads = if threads == 0 {
        hardware.min(8)
    } else {
        threads
    };
    let (estimated_memory, feasible) =
        memory_plan(effective_threads, model_memory, available_memory);
    let session = require_live(snapshot, RecordType::SESSION, &session_id)?;
    let detailed = args.flag("detailed");
    let mut plans = Vec::new();
    let mut total_chunks = 0usize;
    let mut total_duration_us = 0u64;
    if detailed {
        for track_id in session_track_ids(snapshot, &session) {
            if requested_track
                .as_ref()
                .map(|requested| requested != &track_id)
                .unwrap_or(false)
            {
                continue;
            }
            let (chunk_count, duration_us) = track_stats(snapshot, &session_id, &track_id)?;
            total_chunks = total_chunks.saturating_add(chunk_count);
            total_duration_us = total_duration_us.saturating_add(duration_us);
            plans.push(json!({
                "track_id": track_id,
                "chunk_count": chunk_count,
                "duration_us": duration_us.to_string(),
                "estimated_minutes": minutes_for(duration_us),
            }));
        }
    }
    let summary_tracks = if plans.is_empty() {
        String::new()
    } else {
        format!(
            " {} track(s), {total_chunks} audio chunk(s), ~{:.1} minutes of audio.",
            plans.len(),
            minutes_for(total_duration_us)
        )
    };
    let mut result = json!({
        "session_id": session_id,
        "track_id": requested_track.clone().unwrap_or_default(),
        "duration_us": session.field("audio_duration_us").unwrap_or("0"),
        "threads": effective_threads,
        "model_memory_mb": model_memory,
        "estimated_memory_mb": estimated_memory,
        "available_memory_mb": available_memory,
        "available_known": available_memory != 0,
        "feasible": feasible,
    });
    if detailed {
        if let Value::Object(map) = &mut result {
            map.insert("track_count".to_owned(), json!(plans.len()));
            map.insert("chunk_count".to_owned(), json!(total_chunks));
            map.insert(
                "estimated_minutes".to_owned(),
                json!(minutes_for(total_duration_us)),
            );
            map.insert("tracks".to_owned(), Value::Array(plans));
        }
    }
    emit(
        output,
        result,
        &format!(
            "Transcription plan: {effective_threads} thread(s), {estimated_memory} MB estimated working memory{}.{summary_tracks}",
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

#[cfg(test)]
mod tests {
    use super::{memory_plan, minutes_for};

    #[test]
    fn memory_plan_matches_the_typescript_estimate() {
        let (estimated, feasible) = memory_plan(2, 256, 1024);
        assert_eq!(estimated, 416);
        assert!(feasible);
        assert!(!memory_plan(2, 1024, 1024).1);
        assert!(memory_plan(2, 1024, 0).1);
    }

    #[test]
    fn minutes_are_rounded_to_two_decimals() {
        assert_eq!(minutes_for(60_000_000), 1.0);
        assert_eq!(minutes_for(3_600_000_000), 60.0);
    }
}
