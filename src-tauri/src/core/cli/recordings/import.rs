use serde_json::json;

use crate::core::archive::{new_uuid, now_us};
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{ArchiveRecord, RecordType};

use super::ffmpeg;
use super::helpers::{open_unlocked, require_session, session_track_ids};

struct WaveData {
    sample_format: String,
    sample_rate_hz: u32,
    channel_count: u16,
    sample_count: u64,
    data: Vec<u8>,
}

pub(super) fn record_import(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    let session = require_session(&snapshot, &session_id)?;
    let existing_tracks = session_track_ids(&snapshot, &session);
    if !existing_tracks.is_empty() && !args.flags.contains("additional-track") {
        return Err(CliError(
            "Choose 'keep existing tracks' to add this WAV as a separate audio track.".to_owned(),
        )
        .into());
    }
    let input = crate::core::cli::resolve_path(args.required_option("input")?);
    let metadata = std::fs::symlink_metadata(&input)
        .map_err(|_| CliError("Audio source file could not be opened.".to_owned()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CliError("Audio source must be a regular, non-symlink file.".to_owned()).into());
    }
    if args.flags.contains("ffmpeg") {
        return Err(CliError("--ffmpeg requires an executable path.".to_owned()).into());
    }
    if args.option("ffmpeg").is_some_and(|value| value.trim().is_empty()) {
        return Err(CliError("--ffmpeg cannot be empty.".to_owned()).into());
    }
    let filename = input
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("recording.wav")
        .to_owned();
    let extension = input
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let (source_codec, decoded, workspace) = match extension.as_str() {
        "wav" | "wave" => (String::new(), input.clone(), None),
        "flac" | "mp3" | "m4a" => {
            let workspace = tempfile::Builder::new()
                .prefix("tutorux-audio-import-")
                .tempdir()
                .map_err(|error| CliError(format!("Could not create an import workspace: {error}")))?;
            let decoded = workspace.path().join("decoded.wav");
            let executable = ffmpeg::resolve_executable(args.option("ffmpeg"));
            ffmpeg::decode_to_wav(&executable, &input, &decoded).map_err(CliError)?;
            (extension.clone(), decoded, Some(workspace))
        }
        _ => {
            return Err(CliError(
                "Audio import supports WAV, FLAC, MP3, and M4A sources.".to_owned(),
            )
            .into())
        }
    };
    let wave = read_wave(&decoded)?;
    drop(workspace);
    let timestamp = now_us().to_string();
    let track_id = new_uuid();
    let take_id = new_uuid();
    let chunk_id = new_uuid();
    let track_blob_id = new_uuid();
    let take_blob_id = new_uuid();
    let duration_us = (u128::from(wave.sample_count) * 1_000_000 / u128::from(wave.sample_rate_hz)) as u64;
    let byte_count = wave.data.len() as u64;
    let mut chunk = ArchiveRecord::new(
        RecordType::AUDIO_CHUNK,
        &chunk_id,
        [
            ("session_id", session_id.clone()),
            ("track_id", track_id.clone()),
            ("sequence_number", "0".to_owned()),
            ("first_sample_index", "0".to_owned()),
            ("sample_count", wave.sample_count.to_string()),
            ("gap_before_samples", "0".to_owned()),
            ("timeline_start_us", "0".to_owned()),
            ("timeline_end_us", duration_us.to_string()),
            ("sample_rate_hz", wave.sample_rate_hz.to_string()),
            ("channel_count", wave.channel_count.to_string()),
            ("channel_mask", "0".to_owned()),
            ("sample_format", wave.sample_format.clone()),
            ("codec", "none".to_owned()),
            (
                "payload_checksum",
                crate::core::format::crc32(&wave.data).to_string(),
            ),
            ("created_at_us", timestamp.clone()),
        ],
    );
    chunk.blob = wave.data;
    let track = ArchiveRecord::new(
        RecordType::ASSET_METADATA,
        &track_id,
        [
            ("record_role", "audio-track".to_owned()),
            ("blob_id", track_blob_id.clone()),
            ("session_id", session_id.clone()),
            ("track_id", track_id.clone()),
            ("recording_take_id", take_id.clone()),
            ("label", filename.clone()),
            ("source", "imported-file".to_owned()),
            ("state", "completed".to_owned()),
            ("message", String::new()),
            ("sample_format", wave.sample_format.clone()),
            ("sample_rate_hz", wave.sample_rate_hz.to_string()),
            ("channel_count", wave.channel_count.to_string()),
            ("channel_mask", "0".to_owned()),
            ("sample_count", wave.sample_count.to_string()),
            ("timeline_sample_count", wave.sample_count.to_string()),
            ("duration_us", duration_us.to_string()),
            ("chunk_count", "1".to_owned()),
            ("byte_count", byte_count.to_string()),
            ("source_filename", filename.clone()),
            ("created_at_us", timestamp.clone()),
            ("updated_at_us", timestamp.clone()),
        ],
    );
    let take = ArchiveRecord::new(
        RecordType::ASSET_METADATA,
        &take_id,
        [
            ("record_role", "recording-take".to_owned()),
            ("blob_id", take_blob_id.clone()),
            ("session_id", session_id.clone()),
            ("label", filename.clone()),
            ("source", "imported-file".to_owned()),
            ("state", "completed".to_owned()),
            ("track_ids", track_id.clone()),
            ("started_at_us", timestamp.clone()),
            ("ended_at_us", timestamp.clone()),
            ("duration_us", duration_us.to_string()),
            ("created_at_us", timestamp.clone()),
            ("updated_at_us", timestamp.clone()),
        ],
    );
    let mut linked = existing_tracks;
    let had_prior_tracks = !linked.is_empty();
    if !linked.iter().any(|id| id == &track_id) {
        linked.push(track_id.clone());
    }
    let mut session = session;
    session
        .fields
        .insert("recording_track_ids".to_owned(), linked.join(","));
    session
        .fields
        .insert("recording_track_count".to_owned(), linked.len().to_string());
    session
        .fields
        .entry("recording_track_id".to_owned())
        .or_insert_with(|| track_id.clone());
    if !had_prior_tracks {
        session.fields.insert("recording_source".to_owned(), "imported-file".to_owned());
        session.fields.insert("recording_sample_format".to_owned(), wave.sample_format.clone());
        session
            .fields
            .insert("recording_sample_rate_hz".to_owned(), wave.sample_rate_hz.to_string());
        session
            .fields
            .insert("recording_channel_count".to_owned(), wave.channel_count.to_string());
        session
            .fields
            .insert("recording_started_at_us".to_owned(), timestamp.clone());
        session
            .fields
            .insert("recording_samples".to_owned(), wave.sample_count.to_string());
        session.fields.insert(
            "recording_timeline_samples".to_owned(),
            wave.sample_count.to_string(),
        );
        session
            .fields
            .insert("recording_bytes".to_owned(), byte_count.to_string());
        session
            .fields
            .insert("recording_audio_chunks".to_owned(), "1".to_owned());
        session
            .fields
            .insert("recording_duration_us".to_owned(), duration_us.to_string());
    } else {
        let chunks = session
            .field("recording_audio_chunks")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_add(1);
        let bytes = session
            .field("recording_bytes")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_add(byte_count);
        let prior_duration = session
            .field("recording_duration_us")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        session
            .fields
            .insert("recording_audio_chunks".to_owned(), chunks.to_string());
        session
            .fields
            .insert("recording_bytes".to_owned(), bytes.to_string());
        if duration_us > prior_duration {
            session
                .fields
                .insert("recording_duration_us".to_owned(), duration_us.to_string());
        }
    }
    session.fields.insert("audio_import_track_id".to_owned(), track_id.clone());
    session.fields.insert("audio_import_take_id".to_owned(), take_id.clone());
    session
        .fields
        .insert("audio_import_expected_chunks".to_owned(), "1".to_owned());
    session
        .fields
        .insert("audio_import_expected_samples".to_owned(), wave.sample_count.to_string());
    session
        .fields
        .insert("audio_import_expected_bytes".to_owned(), byte_count.to_string());
    session
        .fields
        .insert("audio_import_sample_rate_hz".to_owned(), wave.sample_rate_hz.to_string());
    session
        .fields
        .insert("audio_import_channel_count".to_owned(), wave.channel_count.to_string());
    session.fields.insert("audio_import_sample_format".to_owned(), wave.sample_format.clone());
    session
        .fields
        .insert("audio_import_source_codec".to_owned(), source_codec.clone());
    session
        .fields
        .insert("audio_import_bytes".to_owned(), byte_count.to_string());
    session
        .fields
        .insert("audio_chunks_imported".to_owned(), "1".to_owned());
    session
        .fields
        .insert("audio_samples_imported".to_owned(), wave.sample_count.to_string());
    session.fields.insert("audio_import_state".to_owned(), "completed".to_owned());
    session
        .fields
        .insert("updated_at_us".to_owned(), timestamp.clone());
    let empty_hash = hex::encode(crate::core::archive::sha256(&[]));
    let track_blob = empty_asset_blob(&track_blob_id, &empty_hash, &timestamp);
    let take_blob = empty_asset_blob(&take_blob_id, &empty_hash, &timestamp);
    let next = snapshot.append_records(&[session, chunk, track, take, track_blob, take_blob])?;
    crate::core::cli::records::save_replacing(path, &next)?;
    emit(
        output,
        json!({
            "session_id": session_id,
            "track_id": track_id,
            "take_id": take_id,
            "sample_format": wave.sample_format,
            "sample_rate_hz": wave.sample_rate_hz,
            "channel_count": wave.channel_count,
            "sample_count": wave.sample_count.to_string(),
            "chunk_count": 1,
            "duration_us": duration_us.to_string(),
            "byte_count": byte_count,
            "state": "completed",
        }),
        &format!("Imported 1 audio chunks as track {track_id}."),
        args.json(),
    );
    Ok(0)
}

fn read_wave(path: &std::path::Path) -> CliResult<WaveData> {
    let bytes = std::fs::read(path)
        .map_err(|_| CliError("Audio source file could not be opened.".to_owned()))?;
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(CliError("The WAV file has an invalid header.".to_owned()).into());
    }
    let mut cursor = 12usize;
    let mut channels = 1u16;
    let mut rate = 8_000u32;
    let mut bits = 16u16;
    let mut format_tag = 1u16;
    let mut block_align = 2u16;
    let mut data = Vec::new();
    while cursor + 8 <= bytes.len() {
        let id = &bytes[cursor..cursor + 4];
        let length = u32::from_le_bytes([
            bytes[cursor + 4],
            bytes[cursor + 5],
            bytes[cursor + 6],
            bytes[cursor + 7],
        ]) as usize;
        cursor += 8;
        if id == b"fmt " && cursor + 16 <= bytes.len() {
            format_tag = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]);
            channels = u16::from_le_bytes([bytes[cursor + 2], bytes[cursor + 3]]);
            rate = u32::from_le_bytes([
                bytes[cursor + 4],
                bytes[cursor + 5],
                bytes[cursor + 6],
                bytes[cursor + 7],
            ]);
            block_align = u16::from_le_bytes([bytes[cursor + 12], bytes[cursor + 13]]);
            bits = u16::from_le_bytes([bytes[cursor + 14], bytes[cursor + 15]]);
        } else if id == b"data" {
            let end = (cursor + length).min(bytes.len());
            data.extend_from_slice(&bytes[cursor..end]);
            break;
        }
        cursor += length + (length % 2);
    }
    if data.is_empty() {
        return Err(CliError("The WAV file contains no sample data.".to_owned()).into());
    }
    if channels == 0 || rate == 0 || !(8_000..=384_000).contains(&rate) {
        return Err(CliError("The WAV file has invalid audio metadata.".to_owned()).into());
    }
    let sample_format = match (format_tag, bits) {
        (1, 8) => "pcm_u8",
        (1, 16) => "pcm_s16le",
        (1, 24) => "pcm_s24le",
        (1, 32) => "pcm_s32le",
        (3, 32) => "pcm_f32le",
        _ => {
            return Err(CliError(
                "The WAV file uses an unsupported sample format.".to_owned(),
            )
            .into())
        }
    };
    let width = usize::from(bits / 8);
    let stride = if block_align > 0 {
        usize::from(block_align)
    } else {
        usize::from(channels) * width
    };
    if stride == 0 {
        return Err(CliError("The WAV file has invalid audio metadata.".to_owned()).into());
    }
    let aligned = data.len() - (data.len() % stride);
    data.truncate(aligned);
    let sample_count = (aligned / stride) as u64;
    Ok(WaveData {
        sample_format: sample_format.to_owned(),
        sample_rate_hz: rate,
        channel_count: channels,
        sample_count,
        data,
    })
}

fn empty_asset_blob(id: &str, content_hash: &str, timestamp: &str) -> ArchiveRecord {
    ArchiveRecord::new(
        RecordType::ASSET_BLOB,
        id,
        [
            ("record_role", "asset-blob-manifest".to_owned()),
            ("byte_size", "0".to_owned()),
            ("content_hash", content_hash.to_owned()),
            ("chunk_count", "0".to_owned()),
            ("chunk_ids", String::new()),
            ("created_at_us", timestamp.to_owned()),
            ("updated_at_us", timestamp.to_owned()),
        ],
    )
}
