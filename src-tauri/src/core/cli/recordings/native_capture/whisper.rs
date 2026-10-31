use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::time::Duration;

use crate::core::archive::{new_uuid, now_us, ArchiveSnapshot};
use crate::core::format::{ArchiveRecord, RecordType};
use super::whisper_wav::{build_wav, sample_width};
use crate::transcription::{parse_whisper_json, transcribe_wav};

const QUEUE_WINDOWS: usize = 4;
const MAX_PCM_BYTES: usize = 32 * 1024 * 1024;

pub(super) struct WhisperCapture {
    pub executable: String,
    pub model: String,
    pub language: String,
    pub threads: Option<u32>,
    pub diarize: bool,
    pub window_seconds: u32,
}

struct WindowJob {
    pcm: Vec<u8>,
    first_sample_index: u64,
    sample_rate_hz: u32,
    channel_count: u16,
    sample_format: String,
}

pub(crate) struct WindowResult {
    pub records: Vec<ArchiveRecord>,
    pub segment_count: usize,
    pub boundary_count: usize,
}

pub(super) struct LiveTranscriber {
    session_id: String,
    track_source: &'static str,
    sender: Option<SyncSender<WindowJob>>,
    results: Receiver<Result<WindowResult, String>>,
    worker: Option<std::thread::JoinHandle<()>>,
    pending: Vec<u8>,
    pending_start: Option<u64>,
    frame_bytes: usize,
    window_bytes: usize,
    sample_rate_hz: u32,
    channel_count: u16,
    sample_format: String,
    error: Option<String>,
    segments: usize,
    boundaries: usize,
}

impl LiveTranscriber {
    pub(super) fn new(
        path: &Path,
        request: WhisperCapture,
        session_id: &str,
        track_id: &str,
        track_source: &'static str,
        sample_rate_hz: u32,
        channel_count: u16,
        sample_format: &str,
    ) -> Self {
        let request = Arc::new(request);
        let session_id = session_id.to_owned();
        let track_id = track_id.to_owned();
        let (sender, receiver) = mpsc::sync_channel(QUEUE_WINDOWS);
        let (result_sender, results) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_request = Arc::clone(&request);
        let worker_session = session_id.clone();
        let worker_track = track_id.clone();
        let worker_cancelled = Arc::clone(&cancelled);
        let worker_path = path.to_path_buf();
        let worker = std::thread::Builder::new()
            .name("tutorux-live-whisper".to_owned())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    if worker_cancelled.load(Ordering::Acquire) {
                        break;
                    }
                    let result = transcribe_window(
                        &worker_path,
                        &worker_request,
                        &worker_session,
                        &worker_track,
                        job,
                        &worker_cancelled,
                    );
                    let failed = result.is_err();
                    if result_sender.send(result).is_err() {
                        break;
                    }
                    if failed {
                        break;
                    }
                }
            })
            .ok();
        let frame_bytes = sample_width(sample_format)
            .saturating_mul(usize::from(channel_count))
            .max(1);
        let window_bytes = (request.window_seconds as usize)
            .saturating_mul(sample_rate_hz as usize)
            .saturating_mul(frame_bytes);
        Self {
            session_id,
            track_source,
            sender: Some(sender),
            results,
            worker,
            pending: Vec::new(),
            pending_start: None,
            frame_bytes,
            window_bytes: window_bytes.max(frame_bytes),
            sample_rate_hz,
            channel_count,
            sample_format: sample_format.to_owned(),
            error: None,
            segments: 0,
            boundaries: 0,
        }
    }

    pub(super) fn push(
        &mut self,
        track: &str,
        pcm: &[u8],
        first_sample_index: u64,
        sample_rate_hz: u32,
        channel_count: u16,
        sample_format: &str,
    ) {
        if self.error.is_some() || track != self.track_source {
            return;
        }
        if self.pending_start.is_none() {
            self.pending_start = Some(first_sample_index);
        } else if let Some(start) = self.pending_start {
            let expected = start.saturating_add((self.pending.len() / self.frame_bytes) as u64);
            if first_sample_index > expected {
                let missing = (first_sample_index - expected) as usize;
                if missing.saturating_mul(self.frame_bytes) > MAX_PCM_BYTES {
                    self.error = Some(
                        "The live Whisper window contained an unusable audio gap.".to_owned(),
                    );
                    return;
                }
                self.pending
                    .extend(std::iter::repeat(0u8).take(missing.saturating_mul(self.frame_bytes)));
            }
        }
        self.pending.extend_from_slice(pcm);
        while self.pending.len() >= self.window_bytes {
            let window: Vec<u8> = self.pending.drain(..self.window_bytes).collect();
            let start = self.pending_start.unwrap_or(first_sample_index);
            if let Err(error) = self.send(WindowJob {
                pcm: window,
                first_sample_index: start,
                sample_rate_hz,
                channel_count,
                sample_format: sample_format.to_owned(),
            }) {
                self.error = Some(error);
                self.pending.clear();
                return;
            }
            self.pending_start = Some(
                start.saturating_add((self.window_bytes / self.frame_bytes) as u64),
            );
        }
    }

    fn send(&mut self, job: WindowJob) -> Result<(), String> {
        let Some(sender) = self.sender.as_ref() else {
            return Ok(());
        };
        match sender.try_send(job) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => Err(
                "The local Whisper backlog exceeded the bounded capture queue; recording continues without live transcription."
                    .to_owned(),
            ),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                Err("The live Whisper worker stopped unexpectedly.".to_owned())
            }
        }
    }

    pub(super) fn flush(&mut self) {
        if self.error.is_some() {
            return;
        }
        let aligned = self.pending.len() - (self.pending.len() % self.frame_bytes);
        if aligned == 0 {
            return;
        }
        let window: Vec<u8> = self.pending.drain(..aligned).collect();
        let start = self.pending_start.unwrap_or(0);
        if let Some(sender) = self.sender.as_ref() {
            let _ = sender.send(WindowJob {
                pcm: window,
                first_sample_index: start,
                sample_rate_hz: self.sample_rate_hz,
                channel_count: self.channel_count,
                sample_format: self.sample_format.clone(),
            });
        }
        self.pending.clear();
        self.pending_start = None;
    }

    pub(super) fn drain_results(
        &mut self,
        snapshot: &ArchiveSnapshot,
    ) -> Result<(ArchiveSnapshot, bool), String> {
        let mut current = snapshot.clone();
        let mut changed = false;
        while let Ok(result) = self.results.try_recv() {
            match result {
                Ok(result) => {
                    if !result.records.is_empty() {
                        let mut records = result.records;
                        records.push(self.processing_record(&current));
                        current = current
                            .append_records(&records)
                            .map_err(|error| error.message)?;
                        changed = true;
                    }
                    self.segments = self.segments.saturating_add(result.segment_count);
                    self.boundaries = self.boundaries.saturating_add(result.boundary_count);
                }
                Err(error) => self.error = Some(error),
            }
        }
        Ok((current, changed))
    }

    pub(super) fn finish(
        &mut self,
        snapshot: &ArchiveSnapshot,
    ) -> Result<(ArchiveSnapshot, bool), String> {
        self.flush();
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let (mut current, mut changed) = self.drain_results(snapshot)?;
        if self.error.is_none() {
            while let Ok(result) = self.results.recv_timeout(Duration::from_millis(50)) {
                match result {
                    Ok(result) => {
                        if !result.records.is_empty() {
                            let mut records = result.records;
                            records.push(self.processing_record(&current));
                            current = current
                                .append_records(&records)
                                .map_err(|error| error.message)?;
                            changed = true;
                        }
                        self.segments = self.segments.saturating_add(result.segment_count);
                        self.boundaries = self.boundaries.saturating_add(result.boundary_count);
                    }
                    Err(error) => self.error = Some(error),
                }
            }
        }
        Ok((current, changed))
    }

    pub(super) fn counts(&self) -> (usize, usize) {
        (self.segments, self.boundaries)
    }

    pub(super) fn error(&self) -> String {
        self.error.clone().unwrap_or_default()
    }

    fn processing_record(&self, snapshot: &ArchiveSnapshot) -> ArchiveRecord {
        let mut session = snapshot
            .get_record(RecordType::SESSION, &self.session_id)
            .ok()
            .flatten()
            .unwrap_or_else(|| {
                ArchiveRecord::new(
                    RecordType::SESSION,
                    &self.session_id,
                    std::iter::empty::<(&str, &str)>(),
                )
            });
        session
            .fields
            .insert("processing_state".to_owned(), "review-required".to_owned());
        session.fields.insert(
            "processing_detail".to_owned(),
            "Live local Whisper cues are provisional and ready for tutor review.".to_owned(),
        );
        session
            .fields
            .insert("processing_updated_at_us".to_owned(), now_us().to_string());
        session
    }
}

fn transcribe_window(
    _path: &Path,
    request: &WhisperCapture,
    session_id: &str,
    track_id: &str,
    job: WindowJob,
    cancelled: &Arc<AtomicBool>,
) -> Result<WindowResult, String> {
    if job.pcm.len() > MAX_PCM_BYTES {
        return Err("The live Whisper window exceeded the bounded transcription queue.".to_owned());
    }
    let wav = build_wav(&job.pcm, job.sample_rate_hz, job.channel_count, &job.sample_format)?;
    let output = transcribe_wav(
        &request.executable,
        &request.model,
        wav,
        &request.language,
        request.diarize,
        request.threads,
        Arc::clone(cancelled),
    )?;
    let cues = parse_whisper_json(&output.json)?;
    let start_us = (job.first_sample_index as u128)
        .saturating_mul(1_000_000)
        / u128::from(job.sample_rate_hz.max(1));
    let frame_us = (u128::from(job.sample_rate_hz.max(1)) as u128).max(1);
    let window_frames = (job.pcm.len() / (sample_width(&job.sample_format).max(1) * usize::from(job.channel_count.max(1)))) as u128;
    let end_us = start_us + (window_frames.saturating_mul(1_000_000) / frame_us);
    let language = detected_language(&output.json).unwrap_or_else(|| request.language.clone());
    let model_name = Path::new(&request.model)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Whisper model")
        .to_owned();
    let run_id = new_uuid();
    let created_at = now_us().to_string();
    let mut records = Vec::new();
    let mut boundaries = 0usize;
    for cue in cues {
        if request.diarize && cue.speaker_turn_next.is_none() {
            return Err("Whisper did not return speaker-turn boundaries. Use a compatible whisper.cpp executable and TDRZ model, or turn off tiny diarization.".to_owned());
        }
        let from = start_us.saturating_add(u128::try_from(cue.start_us).unwrap_or(0));
        let to = start_us.saturating_add(u128::try_from(cue.end_us).unwrap_or(0));
        if from >= end_us || to > end_us {
            continue;
        }
        let mut record = ArchiveRecord::new(
            RecordType::TRANSCRIPT_SEGMENT,
            new_uuid(),
            [
                ("session_id", session_id.to_owned()),
                ("start_time_us", from.to_string()),
                ("end_time_us", to.to_string()),
                ("text", cue.text),
                ("verification_state", "provisional".to_owned()),
                ("timestamp_state", "timestamped".to_owned()),
                ("origin", "local-whisper".to_owned()),
                ("source_audio_track_id", track_id.to_owned()),
                ("source_model", model_name.clone()),
                ("source_backend_version", "whisper.cpp CLI".to_owned()),
                ("source_run_id", run_id.clone()),
                ("source_window_start_us", start_us.to_string()),
                ("language", language.clone()),
                ("created_at_us", created_at.clone()),
            ],
        );
        if request.diarize {
            if cue.speaker_turn_next == Some(true) {
                boundaries += 1;
            }
            record.fields.insert(
                "speaker_turn_next".to_owned(),
                cue.speaker_turn_next.unwrap_or(false).to_string(),
            );
            record
                .fields
                .insert("speaker_identity_state".to_owned(), "unassigned".to_owned());
            record
                .fields
                .insert("diarization_enabled".to_owned(), "true".to_owned());
            record.fields.insert(
                "diarization_scope".to_owned(),
                "experimental-speaker-turn-boundaries-only".to_owned(),
            );
            record
                .fields
                .insert("diarization_method".to_owned(), "whisper.cpp-tinydiarize".to_owned());
            record.fields.insert(
                "diarization_model_requirement".to_owned(),
                "TDRZ-compatible Whisper model required".to_owned(),
            );
        }
        records.push(record);
    }
    Ok(WindowResult {
        segment_count: records.len(),
        boundary_count: boundaries,
        records,
    })
}

fn detected_language(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let language = value.get("result")?.get("language")?.as_str()?;
    let valid = !language.is_empty()
        && language.len() <= 16
        && language
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b'-');
    valid.then(|| language.to_owned())
}
