use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::open_archive;
use crate::platform::synchronized_audio::headless::{
    begin_capture, HeadlessCapture, HeadlessCaptureStarted, HeadlessChunk, HeadlessFinished,
    HeadlessTrackSummary,
};

use super::control_files::{ControlRequest, WorkerControl};
use super::ffmpeg_capture::FfmpegCapture;
use super::whisper::{LiveTranscriber, WhisperCapture};
use super::writer::CaptureWriter;
use super::{
    CaptureCommand, CaptureConfig, CaptureSources, CaptureStatus, STOP_REQUESTED,
};

pub(super) struct CaptureOutcome {
    pub(super) report: Value,
    pub(super) summary: String,
    pub(super) completed: bool,
}

pub(super) fn capture_worker(
    path: &Path,
    passphrase: Option<&str>,
    capture_id: &str,
    sources: &CaptureSources,
    config: &CaptureConfig,
    commands: mpsc::Receiver<CaptureCommand>,
    ready: &mpsc::Sender<Result<(), String>>,
    status: &Arc<Mutex<CaptureStatus>>,
    mut control: Option<WorkerControl>,
) -> Result<CaptureOutcome, String> {
    let result = capture_run(
        path,
        passphrase,
        capture_id,
        sources,
        config,
        commands,
        ready,
        status,
        &mut control,
    );
    if let Some(control) = control.as_mut() {
        match &result {
            Ok(outcome) => control.finish(
                outcome
                    .report
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("failed"),
                &outcome.summary,
            ),
            Err(error) => control.finish("failed", error),
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn capture_run(
    path: &Path,
    passphrase: Option<&str>,
    capture_id: &str,
    sources: &CaptureSources,
    config: &CaptureConfig,
    commands: mpsc::Receiver<CaptureCommand>,
    ready: &mpsc::Sender<Result<(), String>>,
    status: &Arc<Mutex<CaptureStatus>>,
    control: &mut Option<WorkerControl>,
) -> Result<CaptureOutcome, String> {
    let (mut native, native_started) = if sources.microphone_id.is_some()
        || sources.system_id.is_some()
        || sources.application_id.is_some()
    {
        let (capture, started) = begin_capture(
            capture_id,
            sources.microphone_id.as_deref(),
            sources.system_id.as_deref(),
            sources.application_id.as_deref(),
        )?;
        (Some(capture), Some(started))
    } else {
        (None, None)
    };
    let mut ffmpeg = match sources.ffmpeg.as_ref() {
        Some(plan) if !plan.tracks.is_empty() => Some(FfmpegCapture::start(plan)?),
        _ => None,
    };
    if native.is_none() && ffmpeg.is_none() {
        return Err("No audio capture backend is available for this recording.".to_owned());
    }
    let started = match native_started {
        Some(started) => started_with_ffmpeg(started, sources.ffmpeg.as_ref()),
        None => ffmpeg_started(capture_id, sources),
    };
    let snapshot = open_worker_archive(path, passphrase)?;
    let (mut writer, mut snapshot) = CaptureWriter::begin(&snapshot, config, &started)?;
    save_records(path, &snapshot)?;
    update_status(status, "recording", "Native audio capture is running.");
    if let Some(control) = control.as_mut() {
        control.write("recording", "Audio capture is active.")?;
    }
    let _ = ready.send(Ok(()));
    let live_track = live_track(config, &started);
    if let (Some((index, _)), Some(whisper)) = (live_track, config.whisper.as_ref()) {
        let (rate, channels, format) = started_format(&started, index);
        let width: usize = match format.as_str() {
            "pcm_u8" => 1,
            "pcm_s16le" => 2,
            "pcm_s24le" => 3,
            _ => 4,
        };
        let window_bytes = (whisper.window_seconds as usize)
            .saturating_mul(rate as usize)
            .saturating_mul(width.saturating_mul(usize::from(channels)));
        if window_bytes == 0 || window_bytes > 32 * 1024 * 1024 {
            return Err(
                "The live Whisper window exceeds the bounded capture queue; reduce --window-seconds."
                    .to_owned(),
            );
        }
    }
    let mut live = live_track.map(|(index, source)| {
        let (rate, channels, format) = started_format(&started, index);
        LiveTranscriber::new(
            path,
            WhisperCapture {
                executable: config.whisper.as_ref().map(|w| w.executable.clone()).unwrap_or_default(),
                model: config.whisper.as_ref().map(|w| w.model.clone()).unwrap_or_default(),
                language: config.whisper.as_ref().map(|w| w.language.clone()).unwrap_or_default(),
                threads: config.whisper.as_ref().and_then(|w| w.threads),
                diarize: config.whisper.as_ref().map(|w| w.diarize).unwrap_or(false),
                window_seconds: config.whisper.as_ref().map(|w| w.window_seconds).unwrap_or(27),
            },
            &config.session_id,
            &config.track_ids[index],
            source,
            rate,
            channels,
            &format,
        )
    });
    let started_at = Instant::now();
    let mut paused_duration = Duration::ZERO;
    let mut paused_at: Option<Instant> = None;
    let mut pause_count = 0u64;
    let mut paused = false;
    let mut pending: Vec<HeadlessChunk> = Vec::new();
    let mut last_flush = Instant::now();
    loop {
        if !paused {
            let mut feed = |chunk: HeadlessChunk| {
                if let Some(live) = live.as_mut() {
                    live.push(
                        chunk.track,
                        &chunk.pcm,
                        chunk.first_sample_index,
                        chunk.sample_rate_hz,
                        chunk.channel_count,
                        chunk.sample_format,
                    );
                }
                pending.push(chunk);
            };
            if let Some(capture) = native.as_mut() {
                capture.drain(&mut feed);
            }
            if let Some(capture) = ffmpeg.as_mut() {
                capture.drain(&mut feed);
            }
        }
        while let Ok(CaptureCommand::Stop(reply)) = commands.try_recv() {
            let _ = reply.send(());
            break;
        }
        if let Some(control) = control.as_mut() {
            match control.poll() {
                ControlRequest::Pause if !paused => {
                    let result = native
                        .as_mut()
                        .map(HeadlessCapture::pause)
                        .unwrap_or(Ok(()))
                        .and_then(|()| ffmpeg.as_mut().map(|value| value.pause()).unwrap_or(Ok(())));
                    if result.is_ok() {
                        paused = true;
                        paused_at = Some(Instant::now());
                        pause_count = pause_count.saturating_add(1);
                        update_status(status, "paused", "Recording is paused.");
                        let _ = control.write("paused", "Audio capture is paused.");
                    } else if let Err(error) = result {
                        let _ = control.write("recording", &error);
                    }
                }
                ControlRequest::Resume if paused => {
                    let result = native
                        .as_mut()
                        .map(HeadlessCapture::resume)
                        .unwrap_or(Ok(()))
                        .and_then(|()| ffmpeg.as_mut().map(|value| value.resume()).unwrap_or(Ok(())));
                    if result.is_ok() {
                        if let Some(at) = paused_at.take() {
                            paused_duration = paused_duration.saturating_add(at.elapsed());
                        }
                        paused = false;
                        update_status(status, "recording", "Recording resumed.");
                        let _ = control.write("recording", "Audio capture resumed.");
                    } else if let Err(error) = result {
                        let _ = control.write("paused", &error);
                    }
                }
                ControlRequest::Stop => break,
                _ => {}
            }
            control.heartbeat();
        }
        if STOP_REQUESTED.swap(false, Ordering::AcqRel) {
            break;
        }
        let active = started_at
            .elapsed()
            .saturating_sub(paused_duration)
            .saturating_sub(paused_at.as_ref().map(Instant::elapsed).unwrap_or_default());
        if config.duration_seconds > 0 && active >= Duration::from_secs(config.duration_seconds) {
            break;
        }
        if pending.len() >= 64 || last_flush.elapsed() >= Duration::from_millis(750) {
            if !pending.is_empty() {
                snapshot = writer.write_chunks(&snapshot, &mut pending)?;
                save_records(path, &snapshot)?;
            }
            last_flush = Instant::now();
        }
        if let Some(live) = live.as_mut() {
            let (next, changed) = live.drain_results(&snapshot)?;
            snapshot = next;
            if changed {
                save_records(path, &snapshot)?;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    update_status(status, "finalizing", "Saving native audio tracks.");
    if let Some(control) = control.as_mut() {
        let _ = control.write("finalizing", "Saving the recording and closing the capture processes.");
    }
    let mut finished = if let Some(capture) = native.as_mut() {
        capture.finish(&mut |chunk| pending.push(chunk))
    } else {
        HeadlessFinished {
            microphone: HeadlessTrackSummary::default(),
            system_audio: HeadlessTrackSummary::default(),
            application_audio: HeadlessTrackSummary::default(),
        }
    };
    if let Some(capture) = ffmpeg.as_mut() {
        merge_finished(&mut finished, capture.finish(&mut |chunk| pending.push(chunk)));
    }
    snapshot = writer.write_chunks(&snapshot, &mut pending)?;
    if let Some(live) = live.as_mut() {
        let (next, changed) = live.finish(&snapshot)?;
        snapshot = next;
        if changed {
            save_records(path, &snapshot)?;
        }
    }
    let (live_segments, live_boundaries, live_error) = live
        .as_ref()
        .map(|live| {
            let (segments, boundaries) = live.counts();
            (segments, boundaries, live.error())
        })
        .unwrap_or((0, 0, String::new()));
    if config.whisper.is_some() {
        if let Some(session) = snapshot
            .get_record(crate::core::format::RecordType::SESSION, &config.session_id)
            .map_err(|error| error.message)?
        {
            writer.merge_session(&session);
        }
    }
    let mut snapshot = writer.finish(&snapshot, &finished, pause_count, paused_duration)?;
    if config.whisper.is_some() {
        snapshot = apply_processing_state(&snapshot, &config.session_id, &live_error)?;
    }
    save_records(path, &snapshot)?;
    let mut report = writer.report(config, &finished);
    if report["source"].as_str() != Some("both") {
        report["liveTranscriptSegmentCount"] = json!(live_segments);
        report["liveSpeakerTurnBoundaryCount"] = json!(live_boundaries);
        report["liveTranscriptionError"] = json!(live_error);
    }
    let completed = report["state"].as_str() == Some("completed");
    let summary = if report["source"].as_str() == Some("both") {
        format!(
            "Synchronized recording {}: {} microseconds across {} separate tracks and {} checkpoints.",
            report["state"].as_str().unwrap_or("failed"),
            report["durationUs"].as_str().unwrap_or("0"),
            report["tracks"].as_array().map_or(0, Vec::len),
            report["chunkCount"].as_u64().unwrap_or(0)
        )
    } else {
        format!(
            "Recording {}: {} microseconds saved in {} checkpoint(s).",
            report["state"].as_str().unwrap_or("failed"),
            report["durationUs"].as_str().unwrap_or("0"),
            report["chunkCount"].as_u64().unwrap_or(0)
        )
    };
    Ok(CaptureOutcome {
        report,
        summary,
        completed,
    })
}

fn apply_processing_state(
    snapshot: &ArchiveSnapshot,
    session_id: &str,
    live_error: &str,
) -> Result<ArchiveSnapshot, String> {
    let Some(mut session) = snapshot
        .get_record(crate::core::format::RecordType::SESSION, session_id)
        .map_err(|error| error.message)?
    else {
        return Ok(snapshot.clone());
    };
    session
        .fields
        .insert("processing_state".to_owned(), "review-required".to_owned());
    session.fields.insert(
        "processing_detail".to_owned(),
        if live_error.is_empty() {
            "Live local Whisper cues are provisional and ready for tutor review.".to_owned()
        } else {
            format!("Recording saved with partial live transcription: {live_error}")
        },
    );
    session.fields.insert(
        "processing_updated_at_us".to_owned(),
        crate::core::archive::now_us().to_string(),
    );
    snapshot
        .append_records(&[session])
        .map_err(|error| error.message)
}

fn live_track(config: &CaptureConfig, started: &HeadlessCaptureStarted) -> Option<(usize, &'static str)> {
    config.whisper.as_ref()?;
    if started.microphone_sample_rate_hz > 0 {
        Some((0, "microphone"))
    } else if started.system_audio_sample_rate_hz > 0 {
        Some((1, "system-audio"))
    } else if started.application_audio_sample_rate_hz > 0 {
        Some((2, "application-audio"))
    } else {
        None
    }
}

fn started_format(
    started: &HeadlessCaptureStarted,
    index: usize,
) -> (u32, u16, String) {
    match index {
        0 => (
            started.microphone_sample_rate_hz,
            started.microphone_channel_count,
            started.microphone_sample_format.clone(),
        ),
        1 => (
            started.system_audio_sample_rate_hz,
            started.system_audio_channel_count,
            started.system_audio_sample_format.clone(),
        ),
        _ => (
            started.application_audio_sample_rate_hz,
            started.application_audio_channel_count,
            started.application_audio_sample_format.clone(),
        ),
    }
}

fn merge_finished(target: &mut HeadlessFinished, other: HeadlessFinished) {
    merge_summary(&mut target.microphone, other.microphone);
    merge_summary(&mut target.system_audio, other.system_audio);
    merge_summary(&mut target.application_audio, other.application_audio);
}

fn merge_summary(target: &mut HeadlessTrackSummary, other: HeadlessTrackSummary) {
    if other.sample_rate_hz > 0 {
        target.sample_rate_hz = other.sample_rate_hz;
        target.channel_count = other.channel_count;
        target.sample_format = other.sample_format;
    }
    target.sample_count = target.sample_count.saturating_add(other.sample_count);
    target.byte_count = target.byte_count.saturating_add(other.byte_count);
    target.chunk_count = target.chunk_count.saturating_add(other.chunk_count);
    target.discontinuity_count = target
        .discontinuity_count
        .saturating_add(other.discontinuity_count);
    if other.failure.is_some() {
        target.failure = other.failure;
    }
}

fn update_status(status: &Arc<Mutex<CaptureStatus>>, state: &str, message: &str) {
    if let Ok(mut value) = status.lock() {
        value.state = state.to_owned();
        value.message = message.to_owned();
    }
}

fn open_worker_archive(path: &Path, passphrase: Option<&str>) -> Result<ArchiveSnapshot, String> {
    let snapshot = open_archive(path, passphrase).map_err(|error| error.message)?;
    if snapshot.locked() {
        return Err("This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned());
    }
    Ok(snapshot)
}

pub(super) fn save_records(path: &Path, snapshot: &ArchiveSnapshot) -> Result<(), String> {
    crate::core::cli::records::save_replacing(path, snapshot).map_err(|error| match error {
        crate::core::cli::Failure::Usage(message) => message,
        crate::core::cli::Failure::Core(error) => error.message,
    })
}

fn started_with_ffmpeg(
    mut started: HeadlessCaptureStarted,
    plan: Option<&super::ffmpeg_capture::FfmpegPlan>,
) -> HeadlessCaptureStarted {
    if let Some(plan) = plan.filter(|plan| !plan.tracks.is_empty()) {
        if started.backend.is_empty() || started.backend == "ffmpeg-cli" {
            started.backend = "ffmpeg-cli".to_owned();
        } else {
            started.backend = format!("{}+ffmpeg-cli", started.backend);
        }
        for track in &plan.tracks {
            match track.source {
                "microphone" => {
                    started.microphone_sample_rate_hz = 16_000;
                    started.microphone_channel_count = 1;
                    started.microphone_sample_format = "pcm_s16le".to_owned();
                }
                "system-audio" => {
                    started.system_audio_sample_rate_hz = 16_000;
                    started.system_audio_channel_count = 1;
                    started.system_audio_sample_format = "pcm_s16le".to_owned();
                }
                _ => {}
            }
        }
    }
    started
}

fn ffmpeg_started(capture_id: &str, sources: &CaptureSources) -> HeadlessCaptureStarted {
    let started = HeadlessCaptureStarted {
        capture_id: capture_id.to_owned(),
        started_at_us: crate::core::archive::now_us(),
        microphone_sample_rate_hz: 0,
        microphone_channel_count: 0,
        microphone_sample_format: String::new(),
        system_audio_sample_rate_hz: 0,
        system_audio_channel_count: 0,
        system_audio_sample_format: String::new(),
        application_audio_sample_rate_hz: 0,
        application_audio_channel_count: 0,
        application_audio_sample_format: String::new(),
        application_audio_device_id: None,
        application_audio_name: None,
        application_audio_process_id: None,
        application_audio_backend: None,
        backend: "ffmpeg-cli".to_owned(),
    };
    started_with_ffmpeg(started, sources.ffmpeg.as_ref())
}
