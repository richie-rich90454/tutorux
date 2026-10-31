use serde_json::json;

use crate::core::archive::{new_uuid, ArchiveSnapshot};
use crate::core::cli::{
    emit, parse_integer, CliContext, CliError, CliOutput, CliResult, ParsedArguments,
};
use crate::core::format::{ArchiveRecord, RecordType};

use super::helpers::{open_unlocked, require_session, select_track, session_chunks};

const MAX_BUCKETS: u64 = 8192;
const MAGIC: &[u8; 8] = b"TUXWFP2\0";

struct Bucket {
    start_frame: u64,
    end_frame: u64,
    minimum: i16,
    maximum: i16,
    contains_gap: bool,
}

fn sample_width(format: &str) -> CliResult<usize> {
    match format {
        "pcm_u8" => Ok(1),
        "pcm_s16le" => Ok(2),
        "pcm_s24le" => Ok(3),
        "pcm_s32le" | "pcm_f32le" => Ok(4),
        _ => Err(CliError("The recording sample format cannot be indexed.".to_owned()).into()),
    }
}

fn sample_to_pcm16(bytes: &[u8], format: &str) -> i16 {
    let scaled = match format {
        "pcm_u8" => (f64::from(bytes[0]) - 128.0) / 128.0,
        "pcm_s16le" => f64::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32768.0,
        "pcm_s24le" => {
            let raw = i32::from(bytes[0]) | (i32::from(bytes[1]) << 8) | (i32::from(bytes[2]) << 16);
            let signed = if raw & 0x80_0000 != 0 { raw | !0xff_ffff } else { raw };
            f64::from(signed) / 8_388_608.0
        }
        "pcm_s32le" => {
            let raw = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            f64::from(raw) / 2_147_483_648.0
        }
        "pcm_f32le" => f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
            .clamp(-1.0, 1.0) as f64,
        _ => 0.0,
    };
    if scaled <= -1.0 {
        return -32768;
    }
    if scaled >= 1.0 {
        return 32767;
    }
    (scaled * 32768.0).round().clamp(-32768.0, 32767.0) as i16
}

fn integer(record: &ArchiveRecord, name: &str, optional: bool) -> CliResult<u64> {
    let value = record
        .field(name)
        .unwrap_or(if optional { "0" } else { "" });
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(
            CliError(format!("Invalid waveform source metadata: {name}.")).into(),
        );
    }
    value
        .parse::<u64>()
        .map_err(|_| CliError(format!("Invalid waveform source metadata: {name}.")).into())
}

fn build(
    snapshot: &ArchiveSnapshot,
    session_id: &str,
    track_id: &str,
) -> CliResult<ArchiveRecord> {
    let chunks = session_chunks(snapshot, session_id, Some(track_id))?;
    if chunks.is_empty() {
        return Err(CliError("The selected track has no audio chunks.".to_owned()).into());
    }
    let format = chunks[0].field("sample_format").unwrap_or("").to_owned();
    let width = sample_width(&format)?;
    let rate = integer(&chunks[0], "sample_rate_hz", false)?;
    let channels = integer(&chunks[0], "channel_count", false)?;
    if channels == 0 {
        return Err(CliError("The audio track has inconsistent timeline metadata.".to_owned()).into());
    }
    let mut timeline = 0u64;
    let mut stored = 0u64;
    let mut signatures = String::new();
    let mut gaps: Vec<(u128, u128)> = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let sequence = integer(chunk, "sequence_number", false)?;
        let start = integer(chunk, "first_sample_index", false)?;
        let count = integer(chunk, "sample_count", false)?;
        let gap = integer(chunk, "gap_before_samples", true)?;
        if sequence != index as u64
            || u128::from(start) != u128::from(timeline) + u128::from(gap)
            || count == 0
            || integer(chunk, "sample_rate_hz", false)? != rate
            || integer(chunk, "channel_count", false)? != channels
            || chunk.field("sample_format") != Some(format.as_str())
        {
            return Err(
                CliError("The audio track has inconsistent timeline metadata.".to_owned()).into(),
            );
        }
        if gap > 0 {
            gaps.push((u128::from(timeline), u128::from(start)));
        }
        timeline = start
            .checked_add(count)
            .ok_or_else(|| CliError("The audio timeline is too large to index.".to_owned()))?;
        stored = stored
            .checked_add(count)
            .ok_or_else(|| CliError("The audio timeline is too large to index.".to_owned()))?;
        let revision = if chunk.revision == 0 { 1 } else { chunk.revision };
        signatures.push_str(&format!(
            "{}:{revision}:{sequence}:{start}:{count}:{gap}\n",
            chunk.id.to_lowercase()
        ));
    }
    if timeline == 0 || timeline > 9_007_199_254_740_991 {
        return Err(CliError("The audio timeline is too large to index.".to_owned()).into());
    }
    let count = timeline.min(MAX_BUCKETS) as usize;
    if count == 0 {
        return Err(CliError("The audio track is empty.".to_owned()).into());
    }
    let timeline_u128 = u128::from(timeline);
    let mut base = Vec::with_capacity(count);
    let mut gap_index = 0usize;
    for index in 0..count {
        let start_frame = (timeline_u128 * index as u128 / count as u128) as u64;
        let end_frame = (timeline_u128 * (index + 1) as u128 / count as u128) as u64;
        while gap_index < gaps.len() && gaps[gap_index].1 <= u128::from(start_frame) {
            gap_index += 1;
        }
        base.push(Bucket {
            start_frame,
            end_frame,
            minimum: 32767,
            maximum: -32768,
            contains_gap: gap_index < gaps.len()
                && gaps[gap_index].0 < u128::from(end_frame),
        });
    }

    let stride = channels as usize * width;
    let mut frame = 0u64;
    let mut bucket_index = 0usize;
    let mut visit = |samples: &[u8], bucket_index: &mut usize, frame: &mut u64| {
        for offset in (0..samples.len()).step_by(stride) {
            while *bucket_index + 1 < count
                && *frame >= base[*bucket_index].end_frame
            {
                *bucket_index += 1;
            }
            let bucket = &mut base[*bucket_index];
            for channel in 0..channels as usize {
                let at = offset + channel * width;
                let sample = sample_to_pcm16(&samples[at..at + width], &format);
                bucket.minimum = bucket.minimum.min(sample);
                bucket.maximum = bucket.maximum.max(sample);
            }
            *frame += 1;
        }
    };
    for chunk in &chunks {
        let gap = integer(chunk, "gap_before_samples", true)?;
        if gap > 0 {
            let silence = vec![0u8; stride];
            for _ in 0..gap {
                visit(&silence, &mut bucket_index, &mut frame);
            }
        }
        if chunk.blob.len() % stride != 0 {
            return Err(
                CliError("The audio stream contains an incomplete frame.".to_owned()).into(),
            );
        }
        visit(&chunk.blob, &mut bucket_index, &mut frame);
    }
    if frame != timeline {
        return Err(CliError(
            "The audio stream ended before the complete waveform was read.".to_owned(),
        )
        .into());
    }

    let mut levels: Vec<Vec<Bucket>> = vec![base];
    while levels.last().map_or(0, Vec::len) > 1 {
        let previous = levels.last().expect("waveform level");
        let mut next = Vec::with_capacity(previous.len().div_ceil(2));
        let mut index = 0usize;
        while index < previous.len() {
            let left = &previous[index];
            match previous.get(index + 1) {
                Some(right) => next.push(Bucket {
                    start_frame: left.start_frame,
                    end_frame: right.end_frame,
                    minimum: left.minimum.min(right.minimum),
                    maximum: left.maximum.max(right.maximum),
                    contains_gap: left.contains_gap || right.contains_gap,
                }),
                None => next.push(Bucket {
                    start_frame: left.start_frame,
                    end_frame: left.end_frame,
                    minimum: left.minimum,
                    maximum: left.maximum,
                    contains_gap: left.contains_gap,
                }),
            }
            index += 2;
        }
        levels.push(next);
    }

    let size = 12
        + levels
            .iter()
            .map(|level| 4 + level.len() * 21)
            .sum::<usize>();
    let mut blob = vec![0u8; size];
    blob[..8].copy_from_slice(MAGIC);
    blob[8..12].copy_from_slice(&(levels.len() as u32).to_le_bytes());
    let mut offset = 12usize;
    for level in &levels {
        blob[offset..offset + 4].copy_from_slice(&(level.len() as u32).to_le_bytes());
        offset += 4;
        for bucket in level {
            blob[offset..offset + 8].copy_from_slice(&bucket.start_frame.to_le_bytes());
            blob[offset + 8..offset + 16].copy_from_slice(&bucket.end_frame.to_le_bytes());
            blob[offset + 16..offset + 18].copy_from_slice(&bucket.minimum.to_le_bytes());
            blob[offset + 18..offset + 20].copy_from_slice(&bucket.maximum.to_le_bytes());
            blob[offset + 20] = u8::from(bucket.contains_gap);
            offset += 21;
        }
    }
    let fingerprint = hex::encode(crate::core::archive::sha256(signatures.as_bytes()));
    let previous = snapshot
        .list_records(RecordType::WAVEFORM_INDEX, false)?
        .into_iter()
        .find(|record| {
            record.field("record_role") == Some("waveform-pyramid")
                && record
                    .field("session_id")
                    .map(str::to_lowercase)
                    .as_deref()
                    == Some(session_id)
                && record
                    .field("track_id")
                    .map(str::to_lowercase)
                    .as_deref()
                    == Some(track_id)
        });
    let id = previous
        .as_ref()
        .map(|record| record.id.clone())
        .unwrap_or_else(new_uuid);
    let mut record = ArchiveRecord::new(
        RecordType::WAVEFORM_INDEX,
        id,
        [
            ("record_role", "waveform-pyramid".to_owned()),
            ("format_version", "2".to_owned()),
            ("source_fingerprint", fingerprint),
            ("session_id", session_id.to_lowercase()),
            ("track_id", track_id.to_lowercase()),
            ("sample_rate_hz", rate.to_string()),
            ("channel_count", channels.to_string()),
            ("source_sample_format", format),
            ("stored_frame_count", stored.to_string()),
            ("timeline_frame_count", timeline.to_string()),
            ("chunk_count", chunks.len().to_string()),
            ("level_count", levels.len().to_string()),
            ("base_bucket_count", levels[0].len().to_string()),
        ],
    );
    record.blob = blob;
    Ok(record)
}

mod read;

use read::{is_current, read};

pub(super) fn run(
    action: &str,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    let session = require_session(&snapshot, &session_id)?;
    let track_id = select_track(&snapshot, &session, args.option("track"))?;
    if action == "waveform-index-build" {
        let index = build(&snapshot, &session_id, &track_id)?;
        let level_count = index.field("level_count").unwrap_or("0").to_owned();
        let result = json!({
            "id": index.id,
            "session_id": session_id,
            "track_id": track_id,
            "level_count": level_count,
            "base_bucket_count": index.field("base_bucket_count").unwrap_or("0"),
            "timeline_frame_count": index.field("timeline_frame_count").unwrap_or("0"),
            "source_fingerprint": index.field("source_fingerprint").unwrap_or(""),
        });
        let next = snapshot.append_records(&[index])?;
        crate::core::cli::records::save_replacing(path, &next)?;
        emit(
            output,
            result,
            &format!("Built waveform index for track {track_id} with {level_count} levels."),
            args.json(),
        );
        return Ok(0);
    }
    let index = snapshot
        .list_records(RecordType::WAVEFORM_INDEX, false)?
        .into_iter()
        .find(|record| {
            record.field("record_role") == Some("waveform-pyramid")
                && record
                    .field("session_id")
                    .map(str::to_lowercase)
                    .as_deref()
                    == Some(session_id.as_str())
                && record
                    .field("track_id")
                    .map(str::to_lowercase)
                    .as_deref()
                    == Some(track_id.as_str())
        })
        .ok_or_else(|| {
            CliError("This track has no saved waveform index. Build one first.".to_owned())
        })?;
    let levels = read(&index)?;
    let level = parse_integer(
        args.option("level"),
        "level",
        0,
        0,
        levels.len().saturating_sub(1) as u64,
    )? as usize;
    let chunks = session_chunks(&snapshot, &session_id, Some(&track_id))?;
    let current = is_current(&index, &chunks);
    let buckets: Vec<_> = levels[level]
        .iter()
        .map(|bucket| {
            json!({
                "start_frame": bucket.start_frame.to_string(),
                "end_frame": bucket.end_frame.to_string(),
                "minimum": bucket.minimum,
                "maximum": bucket.maximum,
                "contains_gap": bucket.contains_gap,
            })
        })
        .collect();
    let message = format!(
        "Waveform index for track {track_id}: level {} of {}, {} buckets{}.",
        level + 1,
        levels.len(),
        buckets.len(),
        if current {
            ""
        } else {
            " (source changed; rebuild recommended)"
        }
    );
    emit(
        output,
        json!({
            "id": index.id,
            "session_id": session_id,
            "track_id": track_id,
            "level": level,
            "level_count": levels.len(),
            "current": current,
            "buckets": buckets,
        }),
        &message,
        args.json(),
    );
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_conversion_matches_preview_scaling() {
        assert_eq!(sample_to_pcm16(&[0x00, 0x80], "pcm_s16le"), -32768);
        assert_eq!(sample_to_pcm16(&[0x00, 0x00], "pcm_s16le"), 0);
        assert_eq!(sample_to_pcm16(&[0xff, 0x7f], "pcm_s16le"), 32767);
        assert_eq!(sample_to_pcm16(&[0], "pcm_u8"), -32768);
        assert_eq!(sample_to_pcm16(&[128], "pcm_u8"), 0);
        assert_eq!(sample_to_pcm16(&1.0f32.to_le_bytes(), "pcm_f32le"), 32767);
        assert_eq!(sample_to_pcm16(&(-1.0f32).to_le_bytes(), "pcm_f32le"), -32768);
    }

    #[test]
    fn read_validates_bucket_coverage() {
        let mut blob = vec![0u8; 12 + 4 + 21];
        blob[..8].copy_from_slice(MAGIC);
        blob[8..12].copy_from_slice(&1u32.to_le_bytes());
        blob[12..16].copy_from_slice(&1u32.to_le_bytes());
        blob[16..24].copy_from_slice(&0u64.to_le_bytes());
        blob[24..32].copy_from_slice(&10u64.to_le_bytes());
        blob[32..34].copy_from_slice(&(-5i16).to_le_bytes());
        blob[34..36].copy_from_slice(&5i16.to_le_bytes());
        let mut record = ArchiveRecord::new(
            RecordType::WAVEFORM_INDEX,
            "waveform",
            [
                ("record_role", "waveform-pyramid"),
                ("format_version", "2"),
                ("timeline_frame_count", "10"),
            ],
        );
        record.blob = blob;
        let Ok(levels) = read(&record) else {
            panic!("valid index");
        };
        assert_eq!(levels[0][0].end_frame, 10);
        record.blob = vec![0u8; 12];
        assert!(read(&record).is_err());
    }
}
