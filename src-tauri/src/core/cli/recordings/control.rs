use serde_json::json;

use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::error::CoreError;
use crate::core::format::{ArchiveRecord, RecordType};

use super::helpers::{open_unlocked, require_session, split_ids};

pub(super) fn configure(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    for name in ["microphone", "playback", "durability"] {
        if args.flag(name) {
            return Err(CliError(format!("--{name} requires a value.")).into());
        }
    }
    let microphone = args.option("microphone").map(str::to_owned);
    let playback = args.option("playback").map(str::to_owned);
    let durability = args.option("durability").map(str::to_owned);
    if microphone.as_deref() == Some("") {
        return Err(CliError("The '--microphone' device value cannot be empty.".to_owned()).into());
    }
    if playback.as_deref() == Some("") {
        return Err(CliError("The '--playback' device value cannot be empty.".to_owned()).into());
    }
    if let Some(value) = durability.as_deref() {
        if !matches!(value, "default" | "maximum" | "reduced-write") {
            return Err(CliError(
                "Durability must be 'default', 'maximum', or 'reduced-write'.".to_owned(),
            )
            .into());
        }
    }
    if !args.positionals.is_empty() {
        return Err(
            CliError("record configure does not accept positional arguments.".to_owned()).into(),
        );
    }

    let snapshot = open_unlocked(path, context)?;
    let settings = snapshot.list_records(RecordType::SETTINGS, false)?;
    let read = |key: &str| -> String {
        settings
            .iter()
            .find(|record| {
                record.field("record_role") == Some("setting") && record.field("key") == Some(key)
            })
            .and_then(|record| record.field("value"))
            .unwrap_or("default")
            .to_owned()
    };
    let configured_microphone = microphone
        .clone()
        .unwrap_or_else(|| read("recording.microphone_device_id"));
    let configured_playback = playback
        .clone()
        .unwrap_or_else(|| read("recording.playback_device_id"));
    let configured_durability = durability.clone().unwrap_or_else(|| read("recording.durability"));
    let configured = json!({
        "microphone_device_id": configured_microphone,
        "playback_device_id": configured_playback,
        "durability": configured_durability,
    });
    let mut changes: Vec<ArchiveRecord> = Vec::new();
    if let Some(value) = microphone.as_deref() {
        changes.push(crate::core::cli::records::make_setting_record(
            "recording.microphone_device_id",
            value,
            false,
        ));
    }
    if let Some(value) = playback.as_deref() {
        changes.push(crate::core::cli::records::make_setting_record(
            "recording.playback_device_id",
            value,
            false,
        ));
    }
    if let Some(value) = durability.as_deref() {
        changes.push(crate::core::cli::records::make_setting_record(
            "recording.durability",
            value,
            false,
        ));
    }
    if !changes.is_empty() {
        let next = snapshot.append_records(&changes)?;
        crate::core::cli::records::save_replacing(path, &next)?;
    }
    let message = format!(
        "Recording configuration saved in the active archive.\nMicrophone: {}\nPlayback: {}\nDurability: {}",
        configured["microphone_device_id"].as_str().unwrap_or("default"),
        configured["playback_device_id"].as_str().unwrap_or("default"),
        configured["durability"].as_str().unwrap_or("default"),
    );
    emit(output, configured, &message, args.json());
    Ok(0)
}

pub(super) fn recover(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    let session = require_session(&snapshot, &session_id)?;
    let has_tracks = !session.field("recording_track_id").unwrap_or("").is_empty()
        || !session.field("recording_track_ids").unwrap_or("").is_empty();
    if !has_tracks {
        let import_state = session.field("audio_import_state").unwrap_or("");
        if !["importing", "finalizing", "interrupted", "completed"]
            .contains(&import_state)
        {
            return Err(CoreError::new(
                "audio_recovery_unavailable",
                "This session has no recoverable WAV import metadata.",
            )
            .into());
        }
    }
    if has_tracks {
        let mut track_ids: Vec<String> = split_ids(session.field("recording_track_ids").unwrap_or(""));
        for id in split_ids(session.field("recording_track_id").unwrap_or("")) {
            if !track_ids.contains(&id) {
                track_ids.push(id);
            }
        }
        let mut tracks = Vec::new();
        let mut sample_count = 0u64;
        let mut chunk_count = 0u64;
        let mut byte_count = 0u64;
        let mut duration_us = 0u64;
        let mut all_completed = true;
        for track_id in &track_ids {
            let metadata = snapshot.get_record(RecordType::ASSET_METADATA, track_id)?;
            let source = match metadata.as_ref().and_then(|record| record.field("source")) {
                Some("microphone") => "microphone",
                Some("application-audio") => "application-audio",
                _ => "system-audio",
            };
            let device_id = metadata
                .as_ref()
                .and_then(|record| record.field("source_device_id").or_else(|| record.field("device_id")))
                .or_else(|| session.field("recording_device_id"))
                .unwrap_or("");
            let sample_format = metadata.as_ref().and_then(|record| record.field("sample_format"));
            let sample_rate = metadata
                .as_ref()
                .and_then(|record| record.field("sample_rate_hz"))
                .and_then(|value| value.parse::<u64>().ok());
            let channels = metadata
                .as_ref()
                .and_then(|record| record.field("channel_count"))
                .and_then(|value| value.parse::<u64>().ok());
            let channel_mask = metadata
                .as_ref()
                .and_then(|record| record.field("channel_mask"))
                .and_then(|value| value.parse::<u64>().ok());
            let valid_format = matches!(
                sample_format,
                Some("pcm_s16le") | Some("pcm_s24le") | Some("pcm_s32le") | Some("pcm_f32le")
            ) && sample_rate.map(|rate| (8_000..=384_000).contains(&rate)).unwrap_or(false)
                && channels.map(|count| (1..=8).contains(&count)).unwrap_or(false)
                && channel_mask.is_some();
            if !valid_format {
                all_completed = false;
                tracks.push(json!({
                    "trackId": track_id,
                    "source": source,
                    "deviceId": device_id,
                    "state": "failed",
                    "sampleCount": "0",
                    "timelineSamples": "0",
                    "chunkCount": "0",
                    "discontinuities": "0",
                    "durationUs": "0",
                    "byteCount": "0",
                    "errorCode": "audio_recovery_failed",
                    "errorMessage": "Recording format metadata is invalid.",
                }));
                continue;
            }
            let rate = sample_rate.unwrap_or(0);
            let mut track_samples = 0u64;
            let mut track_chunks = 0u64;
            let mut track_bytes = 0u64;
            for chunk in snapshot.list_records(RecordType::AUDIO_CHUNK, true)? {
                if chunk.field("track_id").map(str::to_lowercase).as_deref()
                    != Some(track_id.as_str())
                    || chunk.field("session_id").map(str::to_lowercase).as_deref()
                        != Some(session_id.as_str())
                {
                    continue;
                }
                track_samples = track_samples.saturating_add(
                    chunk
                        .field("sample_count")
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0),
                );
                track_chunks += 1;
                track_bytes = track_bytes.saturating_add(chunk.blob.len() as u64);
            }
            let track_duration = if rate == 0 {
                0
            } else {
                track_samples.saturating_mul(1_000_000) / rate
            };
            sample_count = sample_count.saturating_add(track_samples);
            chunk_count += track_chunks;
            byte_count = byte_count.saturating_add(track_bytes);
            duration_us = duration_us.max(track_duration);
            let completed = session.field("recording_state") == Some("completed") && track_chunks > 0;
            if !completed {
                all_completed = false;
            }
            let state = if completed {
                "completed"
            } else if track_chunks == 0 {
                "failed"
            } else {
                "interrupted"
            };
            let mut report = json!({
                "trackId": track_id,
                "source": source,
                "deviceId": device_id,
                "state": state,
                "sampleCount": track_samples.to_string(),
                "timelineSamples": track_samples.to_string(),
                "chunkCount": track_chunks.to_string(),
                "discontinuities": "0",
                "durationUs": track_duration.to_string(),
                "byteCount": track_bytes.to_string(),
            });
            if state == "failed" {
                if let serde_json::Value::Object(map) = &mut report {
                    map.insert("errorCode".to_owned(), serde_json::Value::String("audio_recovery_failed".to_owned()));
                    map.insert("errorMessage".to_owned(), serde_json::Value::String("No committed native audio chunk was available for recovery.".to_owned()));
                }
            }
            tracks.push(report);
        }
        let state = if all_completed {
            "completed"
        } else if chunk_count > 0 {
            "partial"
        } else {
            "failed"
        };
        emit(
            output,
            json!({
                "session_id": session_id,
                "state": state,
                "duration_us": duration_us.to_string(),
                "sample_count": sample_count.to_string(),
                "chunk_count": chunk_count.to_string(),
                "byte_count": byte_count.to_string(),
                "tracks": tracks,
            }),
            if all_completed {
                "Recovered all native recording tracks."
            } else {
                "Some native recording tracks could not be recovered."
            },
            args.json(),
        );
        return Ok(if all_completed { 0 } else { 2 });
    }
    emit(
        output,
        json!({
            "session_id": session_id,
            "status": "no-recovery-required",
            "recovered_chunks": 0,
        }),
        "No unfinished native recording was found for this session.",
        args.json(),
    );
    Ok(0)
}
