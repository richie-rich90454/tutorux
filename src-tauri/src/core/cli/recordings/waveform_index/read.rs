use crate::core::cli::{CliError, CliResult};
use crate::core::format::ArchiveRecord;

use super::{integer, sample_width, Bucket, MAGIC, MAX_BUCKETS};

pub(super) fn read(record: &ArchiveRecord) -> CliResult<Vec<Vec<Bucket>>> {
    if record.field("record_role") != Some("waveform-pyramid")
        || record.field("format_version") != Some("2")
    {
        return Err(CliError("Unsupported waveform index.".to_owned()).into());
    }
    if record.blob.len() < 12 || &record.blob[..8] != MAGIC {
        return Err(CliError("Invalid waveform index header.".to_owned()).into());
    }
    let total = integer(record, "timeline_frame_count", false)?;
    let level_count = u32::from_le_bytes([
        record.blob[8],
        record.blob[9],
        record.blob[10],
        record.blob[11],
    ]) as usize;
    if level_count == 0 || level_count > 14 {
        return Err(CliError("Invalid waveform level count.".to_owned()).into());
    }
    let mut levels: Vec<Vec<Bucket>> = Vec::with_capacity(level_count);
    let mut offset = 12usize;
    for level in 0..level_count {
        if offset + 4 > record.blob.len() {
            return Err(CliError("Truncated waveform index.".to_owned()).into());
        }
        let count = u32::from_le_bytes([
            record.blob[offset],
            record.blob[offset + 1],
            record.blob[offset + 2],
            record.blob[offset + 3],
        ]) as usize;
        offset += 4;
        if count == 0
            || count > MAX_BUCKETS as usize
            || offset + count * 21 > record.blob.len()
            || (level > 0 && count >= levels[level - 1].len())
        {
            return Err(CliError("Invalid waveform bucket count.".to_owned()).into());
        }
        let mut buckets = Vec::with_capacity(count);
        for _ in 0..count {
            let start_frame = u64::from_le_bytes(record.blob[offset..offset + 8].try_into().unwrap());
            let end_frame =
                u64::from_le_bytes(record.blob[offset + 8..offset + 16].try_into().unwrap());
            let minimum = i16::from_le_bytes([record.blob[offset + 16], record.blob[offset + 17]]);
            let maximum = i16::from_le_bytes([record.blob[offset + 18], record.blob[offset + 19]]);
            let gap = record.blob[offset + 20];
            offset += 21;
            if end_frame <= start_frame
                || minimum > maximum
                || gap > 1
                || start_frame
                    != buckets
                        .last()
                        .map(|bucket: &Bucket| bucket.end_frame)
                        .unwrap_or(0)
            {
                return Err(CliError("Invalid waveform bucket.".to_owned()).into());
            }
            buckets.push(Bucket {
                start_frame,
                end_frame,
                minimum,
                maximum,
                contains_gap: gap == 1,
            });
        }
        if buckets.last().map(|bucket| bucket.end_frame) != Some(total) {
            return Err(
                CliError("Waveform does not cover the complete recording.".to_owned()).into(),
            );
        }
        levels.push(buckets);
    }
    if offset != record.blob.len() {
        return Err(CliError("Unexpected waveform data.".to_owned()).into());
    }
    Ok(levels)
}

pub(super) fn is_current(record: &ArchiveRecord, chunks: &[ArchiveRecord]) -> bool {
    if record.field("record_role") != Some("waveform-pyramid")
        || record.field("format_version") != Some("2")
    {
        return false;
    }
    if chunks.is_empty() || chunks.len().to_string() != record.field("chunk_count").unwrap_or("") {
        return false;
    }
    let format = record.field("source_sample_format").unwrap_or("pcm_s16le");
    if sample_width(format).is_err() {
        return false;
    }
    let mut expected = 0u64;
    let mut stored = 0u64;
    let mut signature = String::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let Ok(sequence) = integer(chunk, "sequence_number", false) else {
            return false;
        };
        let Ok(start) = integer(chunk, "first_sample_index", false) else {
            return false;
        };
        let Ok(count) = integer(chunk, "sample_count", false) else {
            return false;
        };
        let Ok(gap) = integer(chunk, "gap_before_samples", true) else {
            return false;
        };
        if chunk.field("sample_format") != Some(format)
            || sequence != index as u64
            || count == 0
            || start != expected.saturating_add(gap)
            || chunk.field("sample_rate_hz") != record.field("sample_rate_hz")
            || chunk.field("channel_count") != record.field("channel_count")
        {
            return false;
        }
        signature.push_str(&format!(
            "{}:{}:{sequence}:{start}:{count}:{gap}\n",
            chunk.id.to_lowercase(),
            chunk.revision
        ));
        expected = start + count;
        stored += count;
    }
    if expected.to_string() != record.field("timeline_frame_count").unwrap_or("")
        || stored.to_string() != record.field("stored_frame_count").unwrap_or("")
    {
        return false;
    }
    hex::encode(crate::core::archive::sha256(signature.as_bytes()))
        == record.field("source_fingerprint").unwrap_or("")
}

