use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::open_archive;
use crate::platform::synchronized_audio::headless::{begin_capture, HeadlessChunk};

use super::writer::CaptureWriter;
use super::{
    CaptureCommand, CaptureConfig, CaptureStatus, STOP_REQUESTED,
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
    microphone_id: Option<&str>,
    system_id: Option<&str>,
    application_id: Option<&str>,
    config: &CaptureConfig,
    commands: mpsc::Receiver<CaptureCommand>,
    ready: &mpsc::Sender<Result<(), String>>,
    status: &Arc<Mutex<CaptureStatus>>,
) -> Result<CaptureOutcome, String> {
    let (mut capture, started) =
        begin_capture(capture_id, microphone_id, system_id, application_id)?;
    let snapshot = open_worker_archive(path, passphrase)?;
    let (mut writer, mut snapshot) = CaptureWriter::begin(&snapshot, config, &started)?;
    save_records(path, &snapshot)?;
    update_status(status, "recording", "Native audio capture is running.");
    let _ = ready.send(Ok(()));
    let started_at = Instant::now();
    let mut pending: Vec<HeadlessChunk> = Vec::new();
    let mut last_flush = Instant::now();
    let mut paused_at: Option<Instant> = None;
    let mut paused_duration = Duration::ZERO;
    let mut pause_count = 0u64;
    loop {
        capture.drain(&mut |chunk| pending.push(chunk));
        while let Ok(command) = commands.try_recv() {
            match command {
                CaptureCommand::Pause(reply) => {
                    let result = capture.pause();
                    if result.is_ok() && paused_at.is_none() {
                        paused_at = Some(Instant::now());
                        pause_count = pause_count.saturating_add(1);
                        update_status(status, "paused", "Recording is paused.");
                    }
                    let _ = reply.send(result);
                }
                CaptureCommand::Resume(reply) => {
                    let result = capture.resume();
                    if result.is_ok() {
                        if let Some(at) = paused_at.take() {
                            paused_duration = paused_duration.saturating_add(at.elapsed());
                        }
                        update_status(status, "recording", "Recording resumed.");
                    }
                    let _ = reply.send(result);
                }
                CaptureCommand::Stop(reply) => {
                    let _ = reply.send(());
                    break;
                }
            }
        }
        if STOP_REQUESTED.swap(false, Ordering::AcqRel) {
            break;
        }
        if config.duration_seconds > 0
            && started_at.elapsed() >= Duration::from_secs(config.duration_seconds)
        {
            break;
        }
        if pending.len() >= 64 || last_flush.elapsed() >= Duration::from_millis(750) {
            if !pending.is_empty() {
                snapshot = writer.write_chunks(&snapshot, &mut pending)?;
                save_records(path, &snapshot)?;
            }
            last_flush = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    update_status(status, "finalizing", "Saving native audio tracks.");
    let finished = capture.finish(&mut |chunk| pending.push(chunk));
    let snapshot = writer.write_chunks(&snapshot, &mut pending)?;
    let snapshot = writer.finish(&snapshot, &finished, pause_count, paused_duration)?;
    save_records(path, &snapshot)?;
    let summaries = [&finished.microphone, &finished.system_audio, &finished.application_audio];
    let (live_segments, live_boundaries, live_error) = match config.whisper.as_ref() {
        Some(request) => {
            let index = summaries
                .iter()
                .position(|summary| summary.sample_count > 0)
                .unwrap_or(0);
            match super::whisper::transcribe_capture(
                path,
                &snapshot,
                &config.session_id,
                &config.track_ids[index],
                &super::whisper::WhisperCapture {
                    executable: request.executable.clone(),
                    model: request.model.clone(),
                    language: request.language.clone(),
                    threads: request.threads,
                    diarize: request.diarize,
                },
            ) {
                Ok((segments, boundaries)) => (segments, boundaries, String::new()),
                Err(error) => (0, 0, error),
            }
        }
        None => (0, 0, String::new()),
    };
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

