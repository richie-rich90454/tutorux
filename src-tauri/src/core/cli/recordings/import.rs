use serde_json::json;

use crate::core::archive::{new_uuid, now_us};
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::error::CoreError;
use crate::core::format::{ArchiveRecord, RecordType};

use super::helpers::{open_unlocked, require_session};

pub(super) fn record_import(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    require_session(&snapshot, &session_id)?;
    let input = crate::core::cli::resolve_path(args.required_option("input")?);
    let bytes = std::fs::read(&input).map_err(|error| {
        CoreError::new("audio_import_failed", format!("Could not read audio: {error}"))
    })?;
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(CliError(
            "The Rust audio importer currently accepts uncompressed RIFF/WAVE files; convert other formats with FFmpeg first."
                .to_owned(),
        )
        .into());
    }
    let mut cursor = 12usize;
    let mut channels = 1u16;
    let mut sample_rate = 8000u32;
    let mut bits = 16u16;
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
            channels = u16::from_le_bytes([bytes[cursor + 2], bytes[cursor + 3]]);
            sample_rate = u32::from_le_bytes([
                bytes[cursor + 4],
                bytes[cursor + 5],
                bytes[cursor + 6],
                bytes[cursor + 7],
            ]);
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
    let track_id = new_uuid();
    let take_id = new_uuid();
    let chunk_id = new_uuid();
    let track_blob_id = new_uuid();
    let take_blob_id = new_uuid();
    let timestamp = now_us().to_string();
    let filename = input
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("recording.wav");
    let sample_count = data.len() as u64 / u64::from(channels) / u64::from(bits / 8);
    let mut chunk = ArchiveRecord::new(
        RecordType::AUDIO_CHUNK,
        &chunk_id,
        [
            ("session_id", session_id.clone()),
            ("track_id", track_id.clone()),
            ("sequence_number", "0".to_owned()),
            ("first_sample_index", "0".to_owned()),
            ("sample_count", sample_count.to_string()),
            ("sample_rate_hz", sample_rate.to_string()),
            ("channel_count", channels.to_string()),
            ("sample_format", if bits == 32 { "pcm_s32le" } else { "pcm_s16le" }.to_owned()),
            ("codec", "none".to_owned()),
            (
                "payload_checksum",
                crate::core::format::crc32(&data).to_string(),
            ),
            ("created_at_us", timestamp.clone()),
        ],
    );
    chunk.blob = data;
    let track = ArchiveRecord::new(
        RecordType::ASSET_METADATA,
        &track_id,
        [
            ("record_role", "audio-track".to_owned()),
            ("blob_id", track_blob_id.clone()),
            ("session_id", session_id.clone()),
            ("track_id", track_id.clone()),
            ("recording_take_id", take_id.clone()),
            ("label", filename.to_owned()),
            ("state", "completed".to_owned()),
            ("created_at_us", timestamp.clone()),
        ],
    );
    let take = ArchiveRecord::new(
        RecordType::ASSET_METADATA,
        &take_id,
        [
            ("record_role", "recording-take".to_owned()),
            ("blob_id", take_blob_id.clone()),
            ("session_id", session_id.clone()),
            ("track_ids", track_id.clone()),
            ("label", "Imported audio".to_owned()),
            ("state", "completed".to_owned()),
            ("created_at_us", timestamp.clone()),
        ],
    );
    let mut session = require_session(&snapshot, &session_id)?;
    session
        .fields
        .insert("recording_track_ids".to_owned(), track_id.clone());
    session
        .fields
        .insert("recording_track_id".to_owned(), track_id.clone());
    session
        .fields
        .insert("recording_track_count".to_owned(), "1".to_owned());
    session
        .fields
        .insert("recording_state".to_owned(), "completed".to_owned());
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
            "chunk_id": chunk_id,
            "sample_rate_hz": sample_rate.to_string(),
            "channel_count": channels.to_string(),
            "sample_count": sample_count.to_string(),
            "status": "imported",
        }),
        &format!("Imported recording into session {session_id}."),
        args.json(),
    );
    Ok(0)
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
