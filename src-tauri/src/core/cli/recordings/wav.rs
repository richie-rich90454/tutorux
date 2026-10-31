use serde_json::json;

use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};

use super::helpers::{open_unlocked, require_session, select_track, session_chunks};

fn write_wav(sample_rate: u32, channels: u16, bits: u16, data: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(44 + data.len());
    output.extend_from_slice(b"RIFF");
    output.extend_from_slice(&((36 + data.len()) as u32).to_le_bytes());
    output.extend_from_slice(b"WAVEfmt ");
    output.extend_from_slice(&16u32.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&channels.to_le_bytes());
    output.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * u32::from(channels) * u32::from(bits / 8);
    output.extend_from_slice(&byte_rate.to_le_bytes());
    output.extend_from_slice(&(channels * (bits / 8)).to_le_bytes());
    output.extend_from_slice(&bits.to_le_bytes());
    output.extend_from_slice(b"data");
    output.extend_from_slice(&(data.len() as u32).to_le_bytes());
    output.extend_from_slice(data);
    output
}

pub(super) fn record_export_wav(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    let session = require_session(&snapshot, &session_id)?;
    let track = select_track(&snapshot, &session, args.option("track"))?;
    let chunks = session_chunks(&snapshot, &session_id, Some(&track))?;
    if chunks.is_empty() {
        return Err(CliError("Select an available audio track for this session.".to_owned()).into());
    }
    let sample_rate = chunks
        .first()
        .and_then(|record| record.field("sample_rate_hz"))
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let channels = chunks
        .first()
        .and_then(|record| record.field("channel_count"))
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(1);
    let sample_format = chunks
        .first()
        .and_then(|record| record.field("sample_format"))
        .unwrap_or("pcm_s16le");
    let bits = if sample_format == "pcm_f32le" { 32 } else { 16 };
    let has_gaps = chunks.iter().any(|chunk| {
        chunk
            .field("gap_before_samples")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            > 0
    });
    if has_gaps && !args.flag("fill-gaps") {
        return Err(CliError(
            "This recording contains gaps. Use --fill-gaps to insert silence explicitly."
                .to_owned(),
        )
        .into());
    }
    let block_align = u64::from(channels) * u64::from(bits / 8);
    let mut data = Vec::new();
    let mut sample_count = 0u64;
    for chunk in &chunks {
        let gap = chunk
            .field("gap_before_samples")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        if gap > 0 {
            let silence = gap.saturating_mul(block_align);
            data.extend(std::iter::repeat(0u8).take(silence as usize));
            sample_count = sample_count.saturating_add(gap);
        }
        data.extend_from_slice(&chunk.blob);
        sample_count += chunk
            .field("sample_count")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
    }
    let destination = crate::core::cli::resolve_path(args.required_option("output")?);
    if destination.exists() && !args.flag("overwrite") {
        return Err(CliError(format!(
            "Output already exists: {}",
            destination.display()
        ))
        .into());
    }
    let wav = write_wav(sample_rate, channels, bits, &data);
    crate::core::cli::write_file_atomically(&destination, &wav)?;
    let duration_us = if sample_rate == 0 {
        0
    } else {
        sample_count.saturating_mul(1_000_000) / u64::from(sample_rate)
    };
    emit(
        output,
        json!({
            "session_id": session_id,
            "track_id": track,
            "destination": crate::core::cli::records::output_path(&destination),
            "sample_format": sample_format,
            "sample_rate_hz": sample_rate.to_string(),
            "channel_count": channels.to_string(),
            "sample_count": sample_count.to_string(),
            "chunk_count": chunks.len().to_string(),
            "duration_us": duration_us.to_string(),
            "data_bytes": data.len().to_string(),
            "container": "RIFF/WAVE",
            "inserted_silence_for_gaps": if has_gaps { "true" } else { "false" },
        }),
        &format!("Exported audio track {track} to {}.", destination.display()),
        args.json(),
    );
    Ok(0)
}
