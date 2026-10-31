use serde_json::{json, Value};

use crate::core::cli::{emit, parse_integer, CliContext, CliOutput, CliResult, ParsedArguments};

use super::helpers::{open_unlocked, require_session, select_track, session_chunks};

fn each_sample(bytes: &[u8], sample_format: &str, mut visit: impl FnMut(i64)) {
    match sample_format {
        "pcm_f32le" => {
            for chunk in bytes.chunks_exact(4) {
                let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                visit((value * 32768.0).round() as i64);
            }
        }
        "pcm_u8" => {
            for value in bytes {
                visit(i64::from(*value) * 256 - 32768);
            }
        }
        "pcm_s24le" => {
            for chunk in bytes.chunks_exact(3) {
                let raw = (i32::from(chunk[0]) | (i32::from(chunk[1]) << 8) | (i32::from(chunk[2]) << 16)) << 8;
                visit(i64::from(raw >> 8));
            }
        }
        "pcm_s32le" => {
            for chunk in bytes.chunks_exact(4) {
                let value = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                visit(i64::from(value >> 16));
            }
        }
        _ => {
            for chunk in bytes.chunks_exact(2) {
                visit(i64::from(i16::from_le_bytes([chunk[0], chunk[1]])));
            }
        }
    }
}

pub(super) fn record_waveform(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    let session = require_session(&snapshot, &session_id)?;
    let track = select_track(&snapshot, &session, args.option("track"))?;
    let buckets = parse_integer(args.option("buckets"), "buckets", 512, 1, 8192)? as usize;
    let chunks = session_chunks(&snapshot, &session_id, Some(&track))?;
    let sample_rate = chunks
        .first()
        .and_then(|record| record.field("sample_rate_hz"))
        .unwrap_or("0")
        .to_owned();
    let channels = chunks
        .first()
        .and_then(|record| record.field("channel_count"))
        .unwrap_or("1")
        .to_owned();
    let mut samples: Vec<(String, i64)> = Vec::new();
    let mut total = 0usize;
    for chunk in &chunks {
        let track_id = chunk.field("track_id").unwrap_or("").to_owned();
        let sample_format = chunk.field("sample_format").unwrap_or("pcm_s16le");
        let mut count = 0usize;
        each_sample(&chunk.blob, sample_format, |value| {
            samples.push((track_id.clone(), value));
            count += 1;
        });
        total += count;
    }
    let bucket_size = if total == 0 { 1 } else { total.div_ceil(buckets) };
    let mut rows = Vec::new();
    let mut index = 0usize;
    let mut bucket = 0usize;
    while index < samples.len() {
        let end = (index + bucket_size).min(samples.len());
        let slice = &samples[index..end];
        let min = slice.iter().map(|(_, value)| *value).min().unwrap_or(0);
        let max = slice.iter().map(|(_, value)| *value).max().unwrap_or(0);
        rows.push(json!({
            "track_id": slice.first().map(|(track, _)| track.clone()).unwrap_or_default(),
            "sample_rate_hz": sample_rate,
            "channel_count": channels,
            "bucket": bucket.to_string(),
            "start_frame": index.to_string(),
            "end_frame": end.to_string(),
            "minimum": min.to_string(),
            "maximum": max.to_string(),
            "contains_gap": "false",
        }));
        index = end;
        bucket += 1;
    }
    emit(output, Value::Array(rows), "Recording waveform generated.", args.json());
    Ok(0)
}
