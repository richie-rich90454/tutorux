use std::path::Path;

use serde_json::json;

use crate::core::archive::{new_uuid, now_us, ArchiveSnapshot};
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{ArchiveRecord, RecordType};

use super::helpers::{open_unlocked, require_session, session_chunks};
use super::mix_source::Source;
use super::waveform_index;

const BLOCK_FRAMES: usize = 2048;
const CHUNKS_PER_COMMIT: usize = 16;

pub(super) fn mix(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    require_session(&snapshot, &session_id)?;
    let take_id = crate::core::cli::validate_uuid(args.required_option("take")?, "--take")?;
    let raw_tracks = args.required_option("tracks")?;
    let mut track_ids = Vec::new();
    for id in raw_tracks.split(',') {
        let id = id.trim();
        if id.is_empty() || !crate::core::format::valid_uuid(id) {
            return Err(CliError("--take and --tracks require valid UUIDs.".to_owned()).into());
        }
        track_ids.push(id.to_lowercase());
    }
    if track_ids.len() < 2
        || track_ids.len() > 8
        || track_ids.iter().collect::<std::collections::BTreeSet<_>>().len() != track_ids.len()
    {
        return Err(CliError("Select between two and eight distinct tracks.".to_owned()).into());
    }
    let label = args.option("label").unwrap_or("Mixdown").trim().to_owned();
    let label = if label.is_empty() { "Mixdown".to_owned() } else { label };
    if label.len() > 120 || label.contains(['\r', '\n', '\0']) {
        return Err(CliError(
            "Mix name must fit on one line and contain at most 120 bytes.".to_owned(),
        )
        .into());
    }
    let take = snapshot
        .get_record(RecordType::ASSET_METADATA, &take_id)?
        .filter(|record| record.field("record_role") == Some("recording-take"))
        .filter(|record| record.field("session_id").map(str::to_lowercase).as_deref() == Some(&session_id))
        .ok_or_else(|| CliError("Choose a saved take in this session.".to_owned()))?;
    let linked = take
        .field("track_ids")
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    let mut sources = Vec::with_capacity(track_ids.len());
    for id in &track_ids {
        let track = snapshot
            .get_record(RecordType::ASSET_METADATA, id)?
            .ok_or_else(|| CliError("Every selected track must belong to the chosen take.".to_owned()))?;
        if !linked.contains(id)
            || track.field("record_role") != Some("audio-track")
            || track.field("session_id").map(str::to_lowercase).as_deref() != Some(&session_id)
            || track.field("recording_take_id").map(str::to_lowercase).as_deref() != Some(&take_id)
        {
            return Err(CliError("Every selected track must belong to the chosen take.".to_owned()).into());
        }
        let chunks = session_chunks(&snapshot, &session_id, Some(id))?;
        if chunks.is_empty() {
            return Err(CliError("A selected track has no saved audio.".to_owned()).into());
        }
        let rate = chunks[0]
            .field("sample_rate_hz")
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| CliError("A selected track has an invalid timeline.".to_owned()))?;
        let channels = chunks[0]
            .field("channel_count")
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| CliError("A selected track has an invalid timeline.".to_owned()))?;
        let format = chunks[0].field("sample_format").unwrap_or("pcm_s16le").to_owned();
        let width = match format.as_str() {
            "pcm_u8" => 1,
            "pcm_s16le" => 2,
            "pcm_s24le" => 3,
            "pcm_s32le" | "pcm_f32le" => 4,
            _ => return Err(CliError("Unsupported source audio format.".to_owned()).into()),
        };
        let mut expected = 0u64;
        let mut gaps = Vec::new();
        for (index, chunk) in chunks.iter().enumerate() {
            let sequence = integer(chunk, "sequence_number");
            let first = integer(chunk, "first_sample_index");
            let count = integer(chunk, "sample_count");
            let gap = integer(chunk, "gap_before_samples");
            if sequence != index as u64
                || first != expected.saturating_add(gap)
                || count == 0
                || chunk.field("sample_rate_hz").and_then(|value| value.parse::<u32>().ok()) != Some(rate)
                || chunk.field("channel_count").and_then(|value| value.parse::<u16>().ok()) != Some(channels)
                || chunk.field("sample_format") != Some(format.as_str())
            {
                return Err(CliError("A selected track has an invalid timeline.".to_owned()).into());
            }
            if gap > 0 {
                gaps.push((expected, first));
            }
            expected = first.saturating_add(count);
        }
        let total_frames = expected;
        sources.push(Source::new(
            rate,
            channels,
            format,
            width,
            total_frames,
            gaps,
            chunks,
        ));
    }
    let target_rate = sources.iter().map(|source| source.rate).max().unwrap_or(48_000);
    let duration_us = sources
        .iter()
        .map(|source| (u128::from(source.total_frames) * 1_000_000) / u128::from(source.rate))
        .max()
        .unwrap_or(0);
    let frames = ((duration_us * u128::from(target_rate)) / 1_000_000) as u64;
    if frames == 0 {
        return Err(CliError("The selected audio is too long to mix.".to_owned()).into());
    }
    let track_id = new_uuid();
    let timestamp = now_us().to_string();
    let mut snapshot = snapshot;
    snapshot = append(
        path,
        &snapshot,
        &[
            track_record(&session_id, &take_id, &track_id, &track_ids, &label, target_rate, 0, 0, 0, "mixing", &timestamp),
            take_record(&take, &linked, &track_id, &timestamp),
            session_record(
                &snapshot
                    .get_record(RecordType::SESSION, &session_id)?
                    .ok_or_else(|| CliError("Session was not found in this archive.".to_owned()))?,
                &track_id,
                &timestamp,
            ),
        ],
    )?;
    let result = mix_frames(
        path,
        &snapshot,
        &mut sources,
        &session_id,
        &track_id,
        &track_ids,
        &label,
        target_rate,
        frames,
    );
    match result {
        Ok((snapshot_after, chunk_count)) => {
            let waveform = waveform_index::build(&snapshot_after, &session_id, &track_id)?;
            let final_track = track_record(
                &session_id, &take_id, &track_id, &track_ids, &label, target_rate, frames,
                duration_us as u64, chunk_count, "completed", &now_us().to_string(),
            );
            let take = snapshot_after
                .get_record(RecordType::ASSET_METADATA, &take_id)?
                .ok_or_else(|| CliError("Choose a saved take in this session.".to_owned()))?;
            let session = snapshot_after
                .get_record(RecordType::SESSION, &session_id)?
                .ok_or_else(|| CliError("Session was not found in this archive.".to_owned()))?;
            append(
                path,
                &snapshot_after,
                &[
                    waveform,
                    final_track,
                    take_record(&take, &linked, &track_id, &now_us().to_string()),
                    session_record(&session, &track_id, &now_us().to_string()),
                ],
            )?;
            emit(
                output,
                json!({
                    "session_id": session_id,
                    "take_id": take_id,
                    "track_id": track_id,
                    "sample_format": "pcm_s16le",
                    "sample_rate_hz": target_rate,
                    "channel_count": 2,
                    "frame_count": frames,
                    "duration_us": duration_us.to_string(),
                    "chunk_count": chunk_count,
                }),
                &format!("Created mixdown track {track_id}."),
                args.json(),
            );
            Ok(0)
        }
        Err((error, current, chunk_count)) => {
            let state = if chunk_count > 0 { "partial" } else { "failed" };
            let _ = append(
                path,
                &current,
                &[track_record(
                    &session_id, &take_id, &track_id, &track_ids, &label, target_rate, frames,
                    duration_us as u64, chunk_count, state, &now_us().to_string(),
                )],
            );
            Err(error.into())
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn mix_frames(
    path: &Path,
    snapshot: &ArchiveSnapshot,
    sources: &mut [Source],
    session_id: &str,
    track_id: &str,
    track_ids: &[String],
    label: &str,
    target_rate: u32,
    frames: u64,
) -> Result<(ArchiveSnapshot, u64), (CliError, ArchiveSnapshot, u64)> {
    let mut active: Vec<i16> = Vec::with_capacity(BLOCK_FRAMES * 2);
    let mut active_start = 0u64;
    let mut active_gap = 0u64;
    let mut pending_gap = 0u64;
    let mut sequence = 0u64;
    let mut batch: Vec<ArchiveRecord> = Vec::new();
    let mut current = snapshot.clone();
    let flush = |active: &mut Vec<i16>, active_start: u64, active_gap: u64, sequence: &mut u64, batch: &mut Vec<ArchiveRecord>| {
        if active.is_empty() {
            return;
        }
        let count = active.len() / 2;
        let mut bytes = Vec::with_capacity(active.len() * 2);
        for sample in active.iter() {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        let mut chunk = ArchiveRecord::new(
            RecordType::AUDIO_CHUNK,
            new_uuid(),
            [
                ("session_id", session_id.to_owned()),
                ("track_id", track_id.to_owned()),
                ("sequence_number", sequence.to_string()),
                ("first_sample_index", active_start.to_string()),
                ("sample_count", count.to_string()),
                ("gap_before_samples", active_gap.to_string()),
                (
                    "timeline_start_us",
                    ((u128::from(active_start) * 1_000_000) / u128::from(target_rate)).to_string(),
                ),
                (
                    "timeline_end_us",
                    ((u128::from(active_start + count as u64) * 1_000_000) / u128::from(target_rate)).to_string(),
                ),
                ("sample_format", "pcm_s16le".to_owned()),
                ("sample_rate_hz", target_rate.to_string()),
                ("channel_count", "2".to_owned()),
                ("channel_mask", "3".to_owned()),
                ("codec", "none".to_owned()),
                ("source", "mixdown".to_owned()),
                ("payload_checksum", crate::core::format::crc32(&bytes).to_string()),
            ],
        );
        chunk.blob = bytes;
        batch.push(chunk);
        *sequence += 1;
        active.clear();
    };
    for frame in 0..frames {
        let mut left = 0i64;
        let mut right = 0i64;
        let mut contributors = 0i64;
        for source in sources.iter_mut() {
            let source_frame = ((u128::from(frame) * u128::from(source.rate)) / u128::from(target_rate)) as u64;
            if source_frame >= source.total_frames {
                continue;
            }
            let Some(samples) = source.sample_at(source_frame) else {
                continue;
            };
            let mut l = i64::from(samples[0]);
            let mut r = if source.channels == 1 { l } else { i64::from(samples[1]) };
            if source.channels > 2 {
                let extra = samples[2..].iter().map(|value| i64::from(*value)).sum::<i64>()
                    / i64::from(source.channels - 2);
                l = (l + extra) / 2;
                r = (r + extra) / 2;
            }
            left += l;
            right += r;
            contributors += 1;
        }
        if contributors == 0 {
            flush(&mut active, active_start, active_gap, &mut sequence, &mut batch);
            commit_batch(path, &mut current, &mut batch)
                .map_err(|error| (error, current.clone(), sequence))?;
            pending_gap = pending_gap.saturating_add(1);
            continue;
        }
        if active.is_empty() {
            active_start = frame;
            active_gap = pending_gap;
            pending_gap = 0;
        }
        active.push((left / contributors) as i16);
        active.push((right / contributors) as i16);
        if active.len() >= BLOCK_FRAMES * 2 {
            flush(&mut active, active_start, active_gap, &mut sequence, &mut batch);
            commit_batch(path, &mut current, &mut batch)
                .map_err(|error| (error, current.clone(), sequence))?;
        }
    }
    flush(&mut active, active_start, active_gap, &mut sequence, &mut batch);
    flush_batch(path, &mut current, &mut batch)
        .map_err(|error| (error, current.clone(), sequence))?;
    if sequence == 0 {
        return Err((
            CliError("The chosen tracks have no overlapping saved audio.".to_owned()),
            current,
            0,
        ));
    }
    let _ = (session_id, track_ids, label);
    Ok((current, sequence))
}

fn commit_batch(
    path: &Path,
    current: &mut ArchiveSnapshot,
    batch: &mut Vec<ArchiveRecord>,
) -> Result<(), CliError> {
    if batch.len() < CHUNKS_PER_COMMIT {
        return Ok(());
    }
    flush_batch(path, current, batch)
}

fn flush_batch(
    path: &Path,
    current: &mut ArchiveSnapshot,
    batch: &mut Vec<ArchiveRecord>,
) -> Result<(), CliError> {
    if batch.is_empty() {
        return Ok(());
    }
    let next = current
        .append_records(batch)
        .map_err(|error| CliError(error.message))?;
    crate::core::cli::records::save_replacing(path, &next).map_err(|error| {
        CliError(match error {
            crate::core::cli::Failure::Usage(message) => message,
            crate::core::cli::Failure::Core(error) => error.message,
        })
    })?;
    *current = next;
    batch.clear();
    Ok(())
}

fn append(
    path: &Path,
    snapshot: &ArchiveSnapshot,
    records: &[ArchiveRecord],
) -> CliResult<ArchiveSnapshot> {
    let next = snapshot.append_records(records)?;
    crate::core::cli::records::save_replacing(path, &next)?;
    Ok(next)
}

fn integer(record: &ArchiveRecord, name: &str) -> u64 {
    record
        .field(name)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

fn track_record(
    session_id: &str,
    take_id: &str,
    track_id: &str,
    source_track_ids: &[String],
    label: &str,
    rate: u32,
    frames: u64,
    duration_us: u64,
    chunk_count: u64,
    state: &str,
    timestamp: &str,
) -> ArchiveRecord {
    ArchiveRecord::new(
        RecordType::ASSET_METADATA,
        track_id,
        [
            ("record_role", "audio-track".to_owned()),
            ("session_id", session_id.to_owned()),
            ("track_id", track_id.to_owned()),
            ("recording_take_id", take_id.to_owned()),
            ("source", "mixdown".to_owned()),
            ("source_track_ids", source_track_ids.join(",")),
            ("label", label.to_owned()),
            ("state", state.to_owned()),
            ("sample_rate_hz", rate.to_string()),
            ("sample_format", "pcm_s16le".to_owned()),
            ("channel_count", "2".to_owned()),
            ("channel_mask", "3".to_owned()),
            ("sample_count", frames.to_string()),
            ("timeline_sample_count", frames.to_string()),
            ("chunk_count", chunk_count.to_string()),
            ("duration_us", duration_us.to_string()),
            ("updated_at_us", timestamp.to_owned()),
        ],
    )
}

fn take_record(
    take: &ArchiveRecord,
    linked: &[String],
    track_id: &str,
    timestamp: &str,
) -> ArchiveRecord {
    let mut record = take.clone();
    record.fields.insert(
        "track_ids".to_owned(),
        linked
            .iter()
            .cloned()
            .chain(std::iter::once(track_id.to_owned()))
            .collect::<Vec<_>>()
            .join(","),
    );
    record
        .fields
        .insert("updated_at_us".to_owned(), timestamp.to_owned());
    record
}

fn session_record(session: &ArchiveRecord, track_id: &str, timestamp: &str) -> ArchiveRecord {
    let mut record = session.clone();
    let mut tracks: Vec<String> = ["recording_track_ids", "recording_track_id", "audio_import_track_id"]
        .iter()
        .flat_map(|key| {
            record
                .field(key)
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect();
    if !tracks.iter().any(|id| id == track_id) {
        tracks.push(track_id.to_owned());
    }
    record
        .fields
        .insert("recording_track_ids".to_owned(), tracks.join(","));
    record
        .fields
        .insert("recording_track_count".to_owned(), tracks.len().to_string());
    record
        .fields
        .insert("updated_at_us".to_owned(), timestamp.to_owned());
    record
}
