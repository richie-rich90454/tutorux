use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;

use serde_json::json;

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{ArchiveRecord, RecordType};

use super::helpers::{open_unlocked, require_session, session_chunks};
use super::native_capture::{install_interrupt_handler, STOP_REQUESTED};

const STDERR_LIMIT: usize = 32 * 1024;

pub(super) fn play(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    if !args.positionals.is_empty() {
        return Err(CliError("record play does not accept positional arguments.".to_owned()).into());
    }
    let option_value = |name: &str| -> CliResult<Option<String>> {
        if args.flags.contains(name) {
            return Err(CliError(format!("--{name} requires a value.")).into());
        }
        match args.option(name) {
            Some("") => Err(CliError(format!("--{name} cannot be empty.")).into()),
            Some(value) => Ok(Some(value.to_owned())),
            None => Ok(None),
        }
    };
    let session_id = crate::core::cli::validate_uuid(
        args.required_option("session")?,
        "--session",
    )?;
    let requested_track = option_value("track")?;
    let track_id = match requested_track.as_deref() {
        Some(value) => Some(crate::core::cli::validate_uuid(value, "--track")?),
        None => None,
    };
    let start_frame = playback_unsigned(&args, "start-frame")?;
    let start_us = playback_unsigned(&args, "start-us")?;
    let duration_frames = playback_unsigned(&args, "duration-frames")?;
    let duration_us = playback_unsigned(&args, "duration-us")?;
    if (start_frame.is_some() && start_us.is_some())
        || (duration_frames.is_some() && duration_us.is_some())
    {
        return Err(CliError(
            "Choose either a frame or microsecond value for each playback position.".to_owned(),
        )
        .into());
    }
    if duration_frames == Some(0) {
        return Err(CliError("Playback duration must be greater than zero.".to_owned()).into());
    }
    let ffplay = option_value("ffplay")?.unwrap_or_else(|| "ffplay".to_owned());
    let snapshot = open_unlocked(path, context)?;
    require_session(&snapshot, &session_id)?;
    let selected_track = match track_id {
        Some(track) => track,
        None => {
            let tracks = session_track_ids(&snapshot, &session_id)?;
            match tracks.as_slice() {
                [] => {
                    return Err(
                        CliError("The selected session contains no audio tracks.".to_owned()).into(),
                    )
                }
                [only] => only.clone(),
                _ => {
                    return Err(CliError(
                        "This session has multiple audio tracks. Select one explicitly.".to_owned(),
                    )
                    .into())
                }
            }
        }
    };
    let chunks = session_chunks(&snapshot, &session_id, Some(&selected_track))?;
    if chunks.is_empty() {
        return Err(
            CliError("The selected session track has no committed audio chunks.".to_owned()).into(),
        );
    }
    let first = &chunks[0];
    let sample_format = first.field("sample_format").unwrap_or("");
    if sample_format != "pcm_s16le" {
        return Err(CliError(
            "Playback currently requires signed 16-bit little-endian PCM audio.".to_owned(),
        )
        .into());
    }
    let sample_rate = first
        .field("sample_rate_hz")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (8_000..=384_000).contains(value))
        .ok_or_else(|| CliError("The selected track has an invalid sample rate.".to_owned()))?;
    let channels = first
        .field("channel_count")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| CliError("The selected track has an invalid channel count.".to_owned()))?;
    let timeline = validate_timeline(&chunks, sample_rate, channels)?;
    let start_frame = start_frame.unwrap_or_else(|| {
        start_us
            .map(|value| microseconds_to_frames(value, sample_rate))
            .unwrap_or(0)
    });
    let maximum_frames = match (duration_frames, duration_us) {
        (Some(value), _) => Some(value),
        (None, Some(value)) => Some(microseconds_to_frames(value, sample_rate)),
        (None, None) => None,
    };
    if maximum_frames == Some(0) {
        return Err(CliError(
            "The requested playback duration is shorter than one audio frame.".to_owned(),
        )
        .into());
    }
    if start_frame > timeline {
        return Err(CliError(
            "The requested seek position is beyond the end of the audio track.".to_owned(),
        )
        .into());
    }
    let remaining = timeline - start_frame;
    let played_frames = match maximum_frames {
        Some(maximum) if maximum < remaining => maximum,
        _ => remaining,
    };
    let end_frame = start_frame + played_frames;
    let gap_frames_played: u64 = chunks
        .iter()
        .map(|chunk| {
            let first_frame = field_u64(chunk, "first_sample_index");
            let gap = field_u64(chunk, "gap_before_samples");
            let gap_start = first_frame.saturating_sub(gap);
            let overlap_start = gap_start.max(start_frame);
            let overlap_end = first_frame.min(end_frame);
            overlap_end.saturating_sub(overlap_start)
        })
        .sum();
    let (completed, cancelled, submitted, error) = if played_frames == 0 {
        (true, false, 0, String::new())
    } else {
        play_pcm(&ffplay, &chunks, start_frame, end_frame, sample_rate, channels)?
    };
    if !error.is_empty() {
        return Err(CliError(error).into());
    }
    let exit_status = if !completed {
        if cancelled {
            130
        } else {
            1
        }
    } else {
        0
    };
    let played = if completed { played_frames } else { submitted };
    let duration_us = played
        .saturating_mul(1_000_000)
        .checked_div(u64::from(sample_rate))
        .unwrap_or(0);
    let gap = if completed {
        json!(gap_frames_played.to_string())
    } else {
        json!(null)
    };
    let report = json!({
        "session_id": session_id,
        "track_id": selected_track,
        "sample_rate_hz": sample_rate.to_string(),
        "channel_count": channels.to_string(),
        "start_frame": start_frame.to_string(),
        "timeline_frame_count": timeline.to_string(),
        "played_frames": played.to_string(),
        "frames_submitted_to_player": submitted.to_string(),
        "gap_frames_played": gap,
        "duration_us": duration_us.to_string(),
        "completed": completed,
    });
    let summary = if completed {
        format!("Played {played_frames} frame(s) from track {selected_track}.")
    } else if cancelled {
        format!("Playback stopped after submitting {submitted} frame(s) to ffplay. The player may have buffered additional audio.")
    } else {
        format!("Playback stopped after submitting {submitted} frame(s) to ffplay.")
    };
    emit(output, report, &summary, args.json());
    Ok(exit_status)
}

fn session_track_ids(snapshot: &ArchiveSnapshot, session_id: &str) -> CliResult<Vec<String>> {
    let mut tracks = std::collections::BTreeSet::new();
    for chunk in snapshot.list_records(RecordType::AUDIO_CHUNK, false)? {
        if chunk.field("session_id").map(str::to_lowercase).as_deref()
            != Some(session_id)
        {
            continue;
        }
        if let Some(track) = chunk.field("track_id").filter(|value| !value.is_empty()) {
            tracks.insert(track.to_lowercase());
        }
    }
    Ok(tracks.into_iter().collect())
}

fn field_u64(record: &ArchiveRecord, name: &str) -> u64 {
    record
        .field(name)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

fn validate_timeline(chunks: &[ArchiveRecord], rate: u32, channels: u16) -> CliResult<u64> {
    let mut expected_frame = 0u64;
    for (index, chunk) in chunks.iter().enumerate() {
        let sequence = field_u64(chunk, "sequence_number");
        let gap = field_u64(chunk, "gap_before_samples");
        let first = field_u64(chunk, "first_sample_index");
        let count = field_u64(chunk, "sample_count");
        if sequence != index as u64
            || chunk.field("sample_rate_hz").and_then(|value| value.parse::<u32>().ok()) != Some(rate)
            || chunk.field("channel_count").and_then(|value| value.parse::<u16>().ok()) != Some(channels)
            || chunk.field("sample_format") != Some("pcm_s16le")
            || first != expected_frame.saturating_add(gap)
        {
            return Err(CliError(
                "Audio chunks contain duplicate sequence numbers or an invalid timeline.".to_owned(),
            )
            .into());
        }
        expected_frame = first.saturating_add(count);
    }
    Ok(expected_frame)
}

fn playback_unsigned(args: &ParsedArguments, name: &str) -> CliResult<Option<u64>> {
    if args.flags.contains(name) {
        return Err(CliError(format!("--{name} requires a non-negative integer.")).into());
    }
    let Some(value) = args.option(name) else {
        return Ok(None);
    };
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CliError(format!("--{name} must be a non-negative integer.")).into());
    }
    value.parse::<u64>().map(Some).map_err(|_| {
        CliError(format!("--{name} exceeds the supported playback range.")).into()
    })
}

fn microseconds_to_frames(value: u64, rate: u32) -> u64 {
    ((u128::from(value) * u128::from(rate)) / 1_000_000) as u64
}

fn play_pcm(
    executable: &str,
    chunks: &[ArchiveRecord],
    start_frame: u64,
    end_frame: u64,
    rate: u32,
    channels: u16,
) -> CliResult<(bool, bool, u64, String)> {
    let mut command = Command::new(executable);
    command
        .args([
            "-nodisp",
            "-autoexit",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            &rate.to_string(),
            "-ch_layout",
            &channels.to_string(),
            "-i",
            "pipe:0",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let detail = if error.kind() == std::io::ErrorKind::NotFound {
                format!("{error}. Install an FFmpeg build that includes ffplay or pass its path with --ffplay.")
            } else {
                error.to_string()
            };
            return Err(CliError(format!("Could not start ffplay: {detail}")).into());
        }
    };
    install_interrupt_handler();
    let mut stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.take(STDERR_LIMIT as u64).read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).trim().to_owned()
    });
    let block_align = u64::from(channels) * 2;
    let mut submitted = 0u64;
    let mut cancelled = false;
    let mut write_error: Option<String> = None;
    {
        let stdin = child.stdin.as_mut();
        let input = match stdin {
            Some(input) => input,
            None => {
                let _ = child.kill();
                return Err(CliError("Could not stream audio to ffplay.".to_owned()).into());
            }
        };
        for chunk in chunks {
            if STOP_REQUESTED.swap(false, Ordering::AcqRel) {
                cancelled = true;
                break;
            }
            let first = field_u64(chunk, "first_sample_index");
            let gap = field_u64(chunk, "gap_before_samples");
            let count = field_u64(chunk, "sample_count");
            let gap_start = first.saturating_sub(gap);
            let gap_overlap_start = gap_start.max(start_frame);
            let gap_overlap_end = first.min(end_frame);
            if gap_overlap_end > gap_overlap_start {
                let frames = gap_overlap_end - gap_overlap_start;
                if let Err(error) = write_zeros(input, frames * block_align) {
                    write_error = Some(error);
                    break;
                }
                submitted = submitted.saturating_add(frames);
            }
            let overlap_start = first.max(start_frame);
            let overlap_end = first.saturating_add(count).min(end_frame);
            if overlap_start >= overlap_end {
                continue;
            }
            let offset = ((overlap_start - first) * block_align) as usize;
            let length = ((overlap_end - overlap_start) * block_align) as usize;
            if offset + length > chunk.blob.len() {
                write_error = Some(
                    "The selected recording produced an incomplete audio frame.".to_owned(),
                );
                break;
            }
            if let Err(error) = input.write_all(&chunk.blob[offset..offset + length]) {
                write_error = Some(error.to_string());
                break;
            }
            submitted = submitted.saturating_add(overlap_end - overlap_start);
        }
        if !cancelled && write_error.is_none() {
            let _ = input.flush();
        }
    }
    drop(child.stdin.take());
    if cancelled || write_error.is_some() {
        terminate(&mut child);
    }
    let status = wait_for(&mut child);
    let stderr = stderr_reader.join().unwrap_or_default();
    if let Some(error) = write_error {
        return Ok((false, cancelled, submitted, format!("Audio stream failed: {error}")));
    }
    if cancelled {
        return Ok((false, true, submitted, String::new()));
    }
    match status {
        Some(status) if status.success() => Ok((true, false, submitted, String::new())),
        Some(status) => Ok((
            false,
            false,
            submitted,
            format!(
                "ffplay exited with code {:?}{}",
                status.code(),
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {stderr}")
                }
            ),
        )),
        None => Ok((false, false, submitted, "ffplay did not exit.".to_owned())),
    }
}

fn write_zeros(input: &mut impl Write, bytes: u64) -> Result<(), String> {
    let chunk = vec![0u8; 64 * 1024];
    let mut remaining = bytes;
    while remaining > 0 {
        let count = remaining.min(chunk.len() as u64) as usize;
        input
            .write_all(&chunk[..count])
            .map_err(|error| error.to_string())?;
        remaining -= count as u64;
    }
    Ok(())
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = libc::kill(child.id() as libc::pid_t, libc::SIGINT);
        let started = std::time::Instant::now();
        while started.elapsed() < std::time::Duration::from_secs(3) {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    let _ = child.kill();
}

fn wait_for(child: &mut Child) -> Option<std::process::ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return child.wait().ok(),
        }
    }
}
