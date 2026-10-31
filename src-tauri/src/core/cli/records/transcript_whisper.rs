use super::transcript_audio::{frame_to_us, read_error, session_track_ids, TrackLayout};
use super::transcript_cues::{build_changes, transcribe_windows, RecordOptions};
use super::*;
use crate::core::cli::cancellation;
use crate::transcription::transcribe_wav;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const WINDOW_SECONDS: u64 = 20;

fn default_threads() -> u32 {
    std::thread::available_parallelism()
        .map(|value| u32::try_from(value.get()).unwrap_or(8).clamp(1, 8))
        .unwrap_or(4)
}

fn model_path(archive: &Path, raw: &str) -> PathBuf {
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        return candidate.to_path_buf();
    }
    let archive = resolve_path(&archive.to_string_lossy());
    archive
        .parent()
        .map(|parent| parent.join(candidate))
        .unwrap_or_else(|| candidate.to_path_buf())
}

fn validate_language(language: &str) -> CliResult<()> {
    if language.is_empty()
        || language.len() > 16
        || !language
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
    {
        return Err(
            CliError("The Whisper language must be a language code or auto.".to_owned()).into(),
        );
    }
    Ok(())
}

pub(crate) fn run_transcript_transcription(
    action: &str,
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
) -> CliResult<i32> {
    let session_id = args.required_option("session")?.to_lowercase();
    let session = require_live(snapshot, RecordType::SESSION, &session_id)?;
    let tracks = session_track_ids(snapshot, &session);
    if tracks.is_empty() {
        return Err(CliError("The session has no recorded audio track.".to_owned()).into());
    }
    let track_id = match args.option("track") {
        Some(raw) => {
            let requested = raw.trim().to_lowercase();
            if !crate::core::format::valid_uuid(&requested) {
                return Err(CliError("--track must be a valid UUID.".to_owned()).into());
            }
            if !tracks.contains(&requested) {
                return Err(CliError(
                    "--track must select an audio track in this session.".to_owned(),
                )
                .into());
            }
            requested
        }
        None => tracks[0].clone(),
    };
    if !args.flag("consent-local-audio") {
        return Err(CliError(
            "Use --consent-local-audio to authorize local Whisper processing.".to_owned(),
        )
        .into());
    }
    let whisper = args.required_option("whisper")?.to_owned();
    let model = model_path(path, args.required_option("model")?);
    let model_text = model.to_string_lossy().to_string();
    let model_name = model
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Whisper model")
        .to_owned();
    let language = args.option("language").unwrap_or("auto").to_owned();
    validate_language(&language)?;
    if args.flag("threads") {
        return Err(CliError("--threads requires a value.".to_owned()).into());
    }
    let threads = match args.option("threads") {
        Some(_) => parse_integer(args.option("threads"), "threads", 1, 1, 64)?,
        None => 0,
    };
    let threads = if threads == 0 {
        default_threads()
    } else {
        u32::try_from(threads).unwrap_or(default_threads())
    };
    let start_us = if args.flag("start") {
        return Err(CliError("--start requires a value.".to_owned()).into());
    } else {
        args.option("start")
            .map(parse_transcript_timestamp)
            .transpose()?
            .unwrap_or(0)
    };
    let end_us = if args.flag("end") {
        return Err(CliError("--end requires a value.".to_owned()).into());
    } else {
        args.option("end")
            .map(parse_transcript_timestamp)
            .transpose()?
    };
    let layout = TrackLayout::load(snapshot, &session_id, &track_id)
        .map_err(|message| CoreError::new("transcription_failed", message))?;
    let rate = u64::from(layout.sample_rate);
    let start_frame = ((start_us.max(0) as u128) * u128::from(rate) / 1_000_000) as u64;
    let end_frame = match end_us {
        Some(end) => {
            let requested = ((end.max(0) as u128 * u128::from(rate) + 999_999) / 1_000_000) as u64;
            requested.min(layout.frames)
        }
        None => layout.frames,
    };
    if start_frame >= end_frame {
        return Err(CoreError::new(
            "transcription_range_empty",
            "The selected recording range is empty.",
        )
        .into());
    }
    let json = args.json();
    cancellation::check("Transcription")?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut engine = |wav: Vec<u8>| -> std::result::Result<String, String> {
        if cancellation::is_cancelled() {
            cancelled.store(true, Ordering::Release);
            return Err("Transcription was cancelled.".to_owned());
        }
        transcribe_wav(
            &whisper,
            &model_text,
            wav,
            &language,
            false,
            Some(threads),
            Arc::clone(&cancelled),
        )
        .map(|result| result.json)
    };
    let mut read = |id: &str| -> std::result::Result<Vec<u8>, String> {
        snapshot
            .get_record(RecordType::AUDIO_CHUNK, id)
            .map_err(|error| error.message)?
            .map(|record| record.blob)
            .ok_or_else(read_error)
    };
    let windows = {
        let mut progress = |index: usize| {
            if !json {
                output.stderr(&format!("Processed audio window {index}."));
            }
        };
        transcribe_windows(
            &layout,
            start_frame,
            end_frame,
            &mut read,
            &mut engine,
            &mut progress,
        )
    }
    .map_err(|message| -> crate::core::cli::Failure {
        if cancellation::is_cancelled() {
            CliError("Transcription was cancelled.".to_owned()).into()
        } else {
            CoreError::new("transcription_failed", message).into()
        }
    })?;
    let (windows, detected) = windows;
    let language = detected.unwrap_or(language);
    let existing = snapshot.list_records(RecordType::TRANSCRIPT_SEGMENT, false)?;
    let options = RecordOptions {
        session_id: session_id.clone(),
        track_id: track_id.clone(),
        run_id: crate::core::archive::new_uuid(),
        created_at: now_us().to_string(),
        model_name: model_name.clone(),
        language: language.clone(),
        refine: action == "refine",
        diarize: args.flag("diarize"),
    };
    let (mut changes, counts) = build_changes(&existing, &windows, &options)
        .map_err(|message| CoreError::new("transcription_failed", message))?;
    if counts.generated > 0 || counts.superseded > 0 || counts.skipped > 0 {
        let mut updated = session;
        updated
            .fields
            .insert("processing_state".to_owned(), "review-required".to_owned());
        updated.fields.insert(
            "processing_detail".to_owned(),
            "Local transcription is provisional and ready for tutor review.".to_owned(),
        );
        updated
            .fields
            .insert("processing_updated_at_us".to_owned(), timestamp_now());
        changes.push(updated);
    }
    if !changes.is_empty() {
        mutate(path, snapshot, &changes)?;
    }
    let audio_duration_us = frame_to_us(layout.frames, layout.sample_rate).to_string();
    let diarization = args.flag("diarize");
    let windows_count = windows.len();
    let summary = format!(
        "Generated {} provisional cue(s), replaced {}, skipped {}.{} Review generated cues before reuse.",
        counts.generated,
        counts.superseded,
        counts.skipped,
        if diarization {
            format!(
                " Tiny diarization marked {} speaker-turn boundaries; assign speaker identities manually.",
                counts.boundaries
            )
        } else {
            String::new()
        }
    );
    emit(
        output,
        json!({
            "session_id": session_id,
            "track_id": track_id,
            "created_segment_count": counts.generated.to_string(),
            "superseded_segment_count": counts.superseded.to_string(),
            "preserved_human_segment_count": counts.skipped.to_string(),
            "diarization_enabled": if diarization { "true" } else { "false" },
            "diarization_scope": if diarization {
                "experimental-speaker-turn-boundaries-only"
            } else {
                "disabled"
            },
            "diarization_model_requirement": "not-applicable",
            "speaker_turn_boundary_count": counts.boundaries.to_string(),
            "audio_duration_us": audio_duration_us,
            "model": model_name.clone(),
            "language": language.clone(),
            "backend": "whisper.cpp-cli",
            "threads": threads,
            "verification_state": "provisional",
            "generated": counts.generated,
            "superseded": counts.superseded,
            "skipped": counts.skipped,
            "segment_count": counts.generated,
            "speaker_turn_boundaries": counts.boundaries,
            "windows": windows_count,
            "diagnostics": {
                "executable": output_path(Path::new(&whisper)),
                "model": model_name,
                "language": language,
                "threads": threads,
                "sample_rate_hz": layout.sample_rate,
                "channel_count": layout.channels,
                "sample_format": layout.format,
                "audio_window_seconds": WINDOW_SECONDS,
                "window_count": windows_count,
            },
        }),
        &summary,
        json,
    );
    Ok(0)
}
