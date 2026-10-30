use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
        Arc, Mutex, OnceLock,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::WebviewWindow;
use uuid::Uuid;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
use zeroize::Zeroizing;

const SAMPLE_RATE_HZ: u32 = 16_000;
const MIN_SOURCE_RATE_HZ: u32 = 8_000;
const MAX_SOURCE_RATE_HZ: u32 = 384_000;
const MAX_WINDOW_SECONDS: u32 = 27;
const MAX_THREADS: u32 = 64;
const MAX_AUDIO_CHUNK_BYTES: usize = 32 * 1024;
const MAX_PENDING_CUES: usize = 2_048;
const MAX_PENDING_CUE_TEXT_BYTES: usize = 2 * 1024 * 1024;
const WORK_QUEUE_CHUNKS: usize = 16;
const MAX_CUES_PER_POLL: usize = 128;

static LIVE_SESSIONS: OnceLock<Mutex<HashMap<Uuid, Arc<LiveWhisperHandle>>>> = OnceLock::new();

fn live_sessions() -> &'static Mutex<HashMap<Uuid, Arc<LiveWhisperHandle>>> {
    LIVE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LiveWhisperCue {
    pub sequence: String,
    pub start_time_us: String,
    pub end_time_us: String,
    pub window_start_us: String,
    pub text: String,
    pub language: String,
    pub model_name: String,
    pub backend_version: String,
    pub diarization_enabled: bool,
    pub speaker_turn_next: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveWhisperStarted {
    pub run_id: String,
    pub model_name: String,
    pub backend_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveWhisperPoll {
    pub run_id: String,
    pub status: String,
    pub error: Option<String>,
    pub model_name: String,
    pub backend_version: String,
    pub cues: Vec<LiveWhisperCue>,
}

struct LiveWhisperHandle {
    sender: SyncSender<WorkerMessage>,
    shared: Arc<Mutex<SharedOutput>>,
    cancelled: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl LiveWhisperHandle {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        let _ = self.sender.try_send(WorkerMessage::Cancel);
    }

    fn join(&self) {
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }

    fn detach(&self) {
        if let Ok(mut worker) = self.worker.lock() {
            drop(worker.take());
        }
    }

    fn finish(&self) -> Result<(), String> {
        let status = self
            .shared
            .lock()
            .map_err(|_| "Live transcription state is unavailable.".to_owned())?
            .status
            .clone();
        if is_terminal(&status) {
            self.join();
            return Ok(());
        }

        let (reply_tx, reply_rx) = mpsc::channel();
        if self
            .shared
            .lock()
            .map_err(|_| "Live transcription state is unavailable.".to_owned())?
            .status
            == "running"
        {
            if let Ok(mut shared) = self.shared.lock() {
                shared.status = "finishing".to_owned();
            }
        }
        self.sender
            .send(WorkerMessage::Finish(reply_tx))
            .map_err(|_| "Live transcription worker has stopped.".to_owned())?;
        reply_rx.recv().map_err(|_| {
            "Live transcription worker stopped before finishing its audio window.".to_owned()
        })?;
        self.join();
        Ok(())
    }

    fn enqueue(&self, chunk: QueuedAudioChunk) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("Live transcription has been cancelled.".to_owned());
        }
        let status = self
            .shared
            .lock()
            .map_err(|_| "Live transcription state is unavailable.".to_owned())?
            .status
            .clone();
        if status != "running" {
            return Err(match status.as_str() {
                "failed" => {
                    "Live transcription stopped; the recording continues and remains saved."
                        .to_owned()
                }
                "cancelled" => {
                    "Live transcription was cancelled; the recording continues and remains saved."
                        .to_owned()
                }
                _ => "Live transcription is no longer accepting microphone audio.".to_owned(),
            });
        }
        match self.sender.try_send(WorkerMessage::Chunk(chunk)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(WorkerMessage::Chunk(chunk))) => {
                drop(chunk);
                self.fail_backpressure();
                Err("Live Whisper fell behind the microphone. Transcription stopped; recording continues and remains saved.".to_owned())
            }
            Err(TrySendError::Full(_)) => {
                Err("Live Whisper is finishing and cannot accept microphone audio.".to_owned())
            }
            Err(TrySendError::Disconnected(_)) => {
                self.set_failed("Live transcription worker stopped unexpectedly; the recording continues and remains saved.");
                Err("Live transcription worker stopped unexpectedly; the recording continues and remains saved.".to_owned())
            }
        }
    }

    fn fail_backpressure(&self) {
        if let Ok(mut shared) = self.shared.lock() {
            if shared.status == "running" {
                shared.status = "failed".to_owned();
                shared.error = Some(
                    "Live Whisper fell behind the microphone. Transcription stopped; the recording continues and remains saved."
                        .to_owned(),
                );
            }
        }
        self.cancelled.store(true, Ordering::Release);
        let _ = self.sender.try_send(WorkerMessage::Cancel);
    }

    fn set_failed(&self, message: &str) {
        if let Ok(mut shared) = self.shared.lock() {
            if !is_terminal(&shared.status) {
                shared.status = "failed".to_owned();
                shared.error = Some(message.to_owned());
            }
        }
        self.cancelled.store(true, Ordering::Release);
        let _ = self.sender.try_send(WorkerMessage::Cancel);
    }
}

impl Drop for LiveWhisperHandle {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        let _ = self.sender.try_send(WorkerMessage::Cancel);
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

#[derive(Default)]
struct SharedOutput {
    status: String,
    error: Option<String>,
    model_name: String,
    backend_version: String,
    next_sequence: u64,
    cue_text_bytes: usize,
    cues: VecDeque<LiveWhisperCue>,
}

struct LiveWhisperOptions {
    model_path: PathBuf,
    model_name: String,
    language: String,
    window_seconds: u32,
    thread_count: u32,
    sample_rate_hz: u32,
    first_sample_index: u64,
    timeline_base_sample_index: u64,
    diarize_speaker_turns: bool,
}

struct QueuedAudioChunk {
    sequence: u64,
    first_sample_index: u64,
    sample_rate_hz: u32,
    samples: Zeroizing<Vec<u8>>,
}

enum WorkerMessage {
    Chunk(QueuedAudioChunk),
    Finish(mpsc::Sender<()>),
    Cancel,
}

struct Resampler {
    input_rate_hz: u32,
    processed_input_frames: u64,
    next_output_frame: u64,
    previous_sample: Option<f32>,
}

impl Resampler {
    fn new(input_rate_hz: u32) -> Self {
        Self {
            input_rate_hz,
            processed_input_frames: 0,
            next_output_frame: 0,
            previous_sample: None,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Result<Zeroizing<Vec<f32>>, String> {
        if bytes.is_empty() || bytes.len() % 2 != 0 {
            return Err("Live microphone audio is not aligned 16-bit PCM.".to_owned());
        }
        let frames = bytes.len() / 2;
        let frame_count = u64::try_from(frames).map_err(|_| "Live audio chunk is too large.")?;
        let end_frame = self
            .processed_input_frames
            .checked_add(frame_count)
            .ok_or_else(|| "Live audio timeline exceeded its supported range.".to_owned())?;
        let mut source = Zeroizing::new(Vec::with_capacity(frames));
        for sample in bytes.chunks_exact(2) {
            source.push(i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0);
        }

        let mut output = Zeroizing::new(Vec::new());
        loop {
            let numerator = (self.next_output_frame as u128)
                .checked_mul(self.input_rate_hz as u128)
                .ok_or_else(|| {
                    "Resampled audio position exceeded its supported range.".to_owned()
                })?;
            let left = u64::try_from(numerator / SAMPLE_RATE_HZ as u128)
                .map_err(|_| "Resampled audio position exceeded its supported range.")?;
            let remainder = numerator % SAMPLE_RATE_HZ as u128;
            if left >= end_frame || (remainder > 0 && left.saturating_add(1) >= end_frame) {
                break;
            }
            let left_value = self.sample_at(left, &source)?;
            let value = if remainder == 0 {
                left_value
            } else {
                let right_value = self.sample_at(left + 1, &source)?;
                let fraction = remainder as f32 / SAMPLE_RATE_HZ as f32;
                left_value * (1.0 - fraction) + right_value * fraction
            };
            output.push(value.clamp(-1.0, 1.0));
            self.next_output_frame = self.next_output_frame.checked_add(1).ok_or_else(|| {
                "Resampled audio position exceeded its supported range.".to_owned()
            })?;
        }
        self.previous_sample = source.last().copied();
        self.processed_input_frames = end_frame;
        source.fill(0.0);
        Ok(output)
    }

    fn sample_at(&self, frame: u64, current: &[f32]) -> Result<f32, String> {
        if frame < self.processed_input_frames {
            if frame + 1 == self.processed_input_frames {
                return self
                    .previous_sample
                    .ok_or_else(|| "Live audio resampler lost its boundary sample.".to_owned());
            }
            return Err("Live audio resampler received a discontinuous sample range.".to_owned());
        }
        let offset = usize::try_from(frame - self.processed_input_frames)
            .map_err(|_| "Live audio chunk exceeds the supported sample range.")?;
        current
            .get(offset)
            .copied()
            .ok_or_else(|| "Live audio resampler received an incomplete sample range.".to_owned())
    }
}

struct WindowProcessor {
    sample_limit: usize,
    samples: Vec<f32>,
    window_start_sample: u64,
}

impl WindowProcessor {
    fn new(
        window_seconds: u32,
        first_sample_index: u64,
        timeline_base_sample_index: u64,
        source_rate_hz: u32,
    ) -> Result<Self, String> {
        let sample_limit = usize::try_from(SAMPLE_RATE_HZ * window_seconds)
            .map_err(|_| "Whisper window is too large for this device.".to_owned())?;
        let offset = first_sample_index
            .checked_sub(timeline_base_sample_index)
            .ok_or_else(|| "Live audio starts before the selected track timeline.".to_owned())?;
        let timeline_offset_samples =
            u64::try_from((offset as u128 * SAMPLE_RATE_HZ as u128) / source_rate_hz as u128)
                .map_err(|_| "Live audio starts beyond the supported transcript timeline.")?;
        Ok(Self {
            sample_limit,
            samples: Vec::with_capacity(sample_limit),
            window_start_sample: timeline_offset_samples,
        })
    }

    fn consume(
        &mut self,
        context: &WhisperContext,
        state: &mut whisper_rs::WhisperState,
        options: &LiveWhisperOptions,
        model_name: &str,
        backend_version: &str,
        incoming: &[f32],
        cancelled: &Arc<AtomicBool>,
        shared: &Mutex<SharedOutput>,
    ) -> Result<(), String> {
        let mut cursor = 0;
        while cursor < incoming.len() {
            if cancelled.load(Ordering::Acquire) {
                return Ok(());
            }
            let available = self.sample_limit - self.samples.len();
            let count = available.min(incoming.len() - cursor);
            self.samples
                .extend_from_slice(&incoming[cursor..cursor + count]);
            cursor += count;
            if self.samples.len() == self.sample_limit {
                self.transcribe_window(
                    context,
                    state,
                    options,
                    model_name,
                    backend_version,
                    cancelled,
                    shared,
                )?;
            }
        }
        Ok(())
    }

    fn finish(
        &mut self,
        context: &WhisperContext,
        state: &mut whisper_rs::WhisperState,
        options: &LiveWhisperOptions,
        model_name: &str,
        backend_version: &str,
        cancelled: &Arc<AtomicBool>,
        shared: &Mutex<SharedOutput>,
    ) -> Result<(), String> {
        if !self.samples.is_empty() && !cancelled.load(Ordering::Acquire) {
            self.transcribe_window(
                context,
                state,
                options,
                model_name,
                backend_version,
                cancelled,
                shared,
            )?;
        }
        self.samples.fill(0.0);
        self.samples.clear();
        Ok(())
    }

    fn transcribe_window(
        &mut self,
        _context: &WhisperContext,
        state: &mut whisper_rs::WhisperState,
        options: &LiveWhisperOptions,
        model_name: &str,
        backend_version: &str,
        cancelled: &Arc<AtomicBool>,
        shared: &Mutex<SharedOutput>,
    ) -> Result<(), String> {
        if cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(options.thread_count as i32);
        params.set_no_context(true);
        params.set_translate(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        params.set_tdrz_enable(options.diarize_speaker_turns);
        let detect_language = options.language == "auto";
        params.set_language((!detect_language).then_some(options.language.as_str()));
        params.set_detect_language(detect_language);
        let abort_flag = Arc::clone(cancelled);
        params.set_abort_callback_safe(move || abort_flag.load(Ordering::Acquire));
        state.full(params, &self.samples).map_err(|error| {
            if cancelled.load(Ordering::Acquire) {
                "Live transcription was cancelled.".to_owned()
            } else {
                format!("Whisper failed to transcribe a live audio window: {error:?}")
            }
        })?;

        let window_start_us = samples_to_microseconds(self.window_start_sample)?;
        let window_duration_us = samples_to_microseconds(self.samples.len() as u64)?;
        let window_end_us = window_start_us
            .checked_add(window_duration_us)
            .ok_or_else(|| {
                "Live transcript timestamps exceeded their supported range.".to_owned()
            })?;
        let detected_language = if detect_language {
            whisper_rs::get_lang_str(state.full_lang_id_from_state()).unwrap_or("auto")
        } else {
            options.language.as_str()
        };
        let segment_count = state.full_n_segments();
        let mut window_cues = Vec::new();
        for index in 0..segment_count {
            let Some(segment) = state.get_segment(index) else {
                continue;
            };
            let text = segment
                .to_str_lossy()
                .map_err(|error| {
                    format!("Whisper returned unreadable text for a live cue: {error:?}")
                })?
                .trim()
                .to_owned();
            let relative_start_ticks = segment.start_timestamp();
            let relative_end_ticks = segment.end_timestamp();
            if text.is_empty()
                || relative_start_ticks < 0
                || relative_end_ticks <= relative_start_ticks
            {
                continue;
            }
            let relative_start_us = (relative_start_ticks as u64).saturating_mul(10_000);
            let relative_end_us = (relative_end_ticks as u64).saturating_mul(10_000);
            let start_time_us =
                window_start_us.saturating_add(relative_start_us.min(window_duration_us));
            let end_time_us =
                window_start_us.saturating_add(relative_end_us.min(window_duration_us));
            if start_time_us >= end_time_us || end_time_us > window_end_us {
                continue;
            }
            window_cues.push((
                start_time_us,
                end_time_us,
                text,
                options.diarize_speaker_turns && segment.next_segment_speaker_turn(),
            ));
        }
        window_cues.sort_by_key(|cue| (cue.0, cue.1));
        publish_cues(
            shared,
            window_cues,
            window_start_us,
            detected_language,
            model_name,
            backend_version,
            options.diarize_speaker_turns,
        )?;
        self.samples.fill(0.0);
        self.samples.clear();
        self.window_start_sample = self
            .window_start_sample
            .checked_add(self.sample_limit as u64)
            .ok_or_else(|| "Live transcript window exceeded its supported timeline.".to_owned())?;
        Ok(())
    }
}

impl Drop for WindowProcessor {
    fn drop(&mut self) {
        self.samples.fill(0.0);
    }
}

fn samples_to_microseconds(samples: u64) -> Result<u64, String> {
    let value = samples as u128 * 1_000_000u128 / SAMPLE_RATE_HZ as u128;
    u64::try_from(value)
        .map_err(|_| "Live transcript timestamps exceeded their supported range.".to_owned())
}

fn publish_cues(
    shared: &Mutex<SharedOutput>,
    cues: Vec<(u64, u64, String, bool)>,
    window_start_us: u64,
    language: &str,
    model_name: &str,
    backend_version: &str,
    diarization_enabled: bool,
) -> Result<(), String> {
    let mut output = shared
        .lock()
        .map_err(|_| "Live transcription output is unavailable.".to_owned())?;
    let pending_text_bytes = cues
        .iter()
        .fold(0usize, |total, cue| total.saturating_add(cue.2.len()));
    if output.cues.len().saturating_add(cues.len()) > MAX_PENDING_CUES
        || pending_text_bytes > MAX_PENDING_CUE_TEXT_BYTES.saturating_sub(output.cue_text_bytes)
    {
        output.status = "failed".to_owned();
        output.error = Some(
            "The live transcript queue reached its safety limit. Recording continues and remains saved."
                .to_owned(),
        );
        return Err("Live transcript queue reached its safety limit.".to_owned());
    }
    for (start_time_us, end_time_us, text, speaker_turn_next) in cues {
        let sequence = output.next_sequence;
        output.next_sequence = output
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| "Live transcript cue count exceeded its supported range.".to_owned())?;
        output.cue_text_bytes += text.len();
        output.cues.push_back(LiveWhisperCue {
            sequence: sequence.to_string(),
            start_time_us: start_time_us.to_string(),
            end_time_us: end_time_us.to_string(),
            window_start_us: window_start_us.to_string(),
            text,
            language: language.to_owned(),
            model_name: model_name.to_owned(),
            backend_version: backend_version.to_owned(),
            diarization_enabled,
            speaker_turn_next,
        });
    }
    Ok(())
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn set_terminal(shared: &Mutex<SharedOutput>, status: &str, error: Option<String>) {
    if let Ok(mut output) = shared.lock() {
        if !is_terminal(&output.status) {
            output.status = status.to_owned();
            output.error = error;
        }
    }
}

fn start_worker(
    options: LiveWhisperOptions,
    shared: Arc<Mutex<SharedOutput>>,
    cancelled: Arc<AtomicBool>,
    receiver: Receiver<WorkerMessage>,
    ready: mpsc::Sender<Result<(), String>>,
    handle: &LiveWhisperHandle,
) {
    let model_path = options.model_path.clone();
    let model_name = options.model_name.clone();
    let thread_shared = Arc::clone(&shared);
    let thread_cancelled = Arc::clone(&cancelled);
    let worker_ready = ready.clone();
    let spawn_result = thread::Builder::new()
        .name("tutorux-live-whisper".to_owned())
        .spawn(move || {
            let context = match WhisperContext::new_with_params(&model_path, WhisperContextParameters::default()) {
                Ok(context) => context,
                Err(error) => {
                    let message = format!("Could not load the selected Whisper model: {error:?}");
                    set_terminal(&thread_shared, "failed", Some(message.clone()));
                    let _ = worker_ready.send(Err(message));
                    return;
                }
            };
            if thread_cancelled.load(Ordering::Acquire) {
                set_terminal(&thread_shared, "cancelled", None);
                return;
            }
            let mut state = match context.create_state() {
                Ok(state) => state,
                Err(error) => {
                    let message = format!("Could not initialize the Whisper model state: {error:?}");
                    set_terminal(&thread_shared, "failed", Some(message.clone()));
                    let _ = worker_ready.send(Err(message));
                    return;
                }
            };
            if thread_cancelled.load(Ordering::Acquire) {
                set_terminal(&thread_shared, "cancelled", None);
                return;
            }
            let backend_version = format!("whisper.cpp {}", whisper_rs::get_whisper_version());
            let mut windows = match WindowProcessor::new(
                options.window_seconds,
                options.first_sample_index,
                options.timeline_base_sample_index,
                options.sample_rate_hz,
            ) {
                Ok(window) => window,
                Err(error) => {
                    let _ = worker_ready.send(Err(error.clone()));
                    set_terminal(&thread_shared, "failed", Some(error));
                    return;
                }
            };
            let mut resampler = Resampler::new(options.sample_rate_hz);
            let mut expected_sequence = 0u64;
            let mut expected_sample_index = options.first_sample_index;
            if let Ok(mut output) = thread_shared.lock() {
                output.model_name = model_name.clone();
                output.backend_version = backend_version.clone();
                output.status = "running".to_owned();
            }
            let _ = worker_ready.send(Ok(()));

            loop {
                let message = match receiver.recv() {
                    Ok(message) => message,
                    Err(_) => break,
                };
                match message {
                    WorkerMessage::Chunk(chunk) => {
                        if thread_cancelled.load(Ordering::Acquire) {
                            break;
                        }
                        if chunk.sequence != expected_sequence
                            || chunk.first_sample_index != expected_sample_index
                            || chunk.sample_rate_hz != options.sample_rate_hz
                        {
                            set_terminal(
                                &thread_shared,
                                "failed",
                                Some("Live microphone chunks arrived out of order or changed format. Recording continues and remains saved.".to_owned()),
                            );
                            thread_cancelled.store(true, Ordering::Release);
                            break;
                        }
                        let frame_count = (chunk.samples.len() / 2) as u64;
                        expected_sequence = match expected_sequence.checked_add(1) {
                            Some(value) => value,
                            None => {
                                set_terminal(&thread_shared, "failed", Some("Live microphone chunk count exceeded its supported range.".to_owned()));
                                thread_cancelled.store(true, Ordering::Release);
                                break;
                            }
                        };
                        expected_sample_index = match expected_sample_index.checked_add(frame_count) {
                            Some(value) => value,
                            None => {
                                set_terminal(&thread_shared, "failed", Some("Live microphone sample position exceeded its supported range.".to_owned()));
                                thread_cancelled.store(true, Ordering::Release);
                                break;
                            }
                        };
                        let resampled = match resampler.push(&chunk.samples) {
                            Ok(samples) => samples,
                            Err(error) => {
                                set_terminal(&thread_shared, "failed", Some(format!("{error} Recording continues and remains saved.")));
                                thread_cancelled.store(true, Ordering::Release);
                                break;
                            }
                        };
                        if let Err(error) = windows.consume(
                            &context,
                            &mut state,
                            &options,
                            &model_name,
                            &backend_version,
                            &resampled,
                            &thread_cancelled,
                            &thread_shared,
                        ) {
                            if !thread_cancelled.load(Ordering::Acquire) {
                                set_terminal(&thread_shared, "failed", Some(format!("{error} Recording continues and remains saved.")));
                                thread_cancelled.store(true, Ordering::Release);
                            }
                            break;
                        }
                    }
                    WorkerMessage::Finish(reply) => {
                        if !thread_cancelled.load(Ordering::Acquire) {
                            if let Err(error) = windows.finish(
                                &context,
                                &mut state,
                                &options,
                                &model_name,
                                &backend_version,
                                &thread_cancelled,
                                &thread_shared,
                            ) {
                                set_terminal(&thread_shared, "failed", Some(format!("{error} Recording continues and remains saved.")));
                            } else if !thread_cancelled.load(Ordering::Acquire) {
                                set_terminal(&thread_shared, "completed", None);
                            }
                        }
                        let _ = reply.send(());
                        break;
                    }
                    WorkerMessage::Cancel => break,
                }
            }
            windows.samples.fill(0.0);
            resampler.previous_sample = None;
            if thread_cancelled.load(Ordering::Acquire) {
                set_terminal(&thread_shared, "cancelled", None);
            }
        });
    match spawn_result {
        Ok(worker) => {
            if let Ok(mut slot) = handle.worker.lock() {
                *slot = Some(worker);
            }
        }
        Err(error) => {
            let message = format!("Could not start the live Whisper worker: {error}");
            if let Ok(mut output) = shared.lock() {
                output.status = "failed".to_owned();
                output.error = Some(message.clone());
            }
            let _ = ready.send(Err(message));
        }
    }
}

fn validate_language(language: &str) -> Result<String, String> {
    let value = language.trim().to_ascii_lowercase();
    if value.is_empty()
        || value.len() > 16
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
    {
        return Err("Enter a valid Whisper language code, or auto.".to_owned());
    }
    if value == "auto" || whisper_rs::get_lang_id(&value).is_some() {
        Ok(value)
    } else {
        Err("Whisper does not support that language code.".to_owned())
    }
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err(
            "Live transcription is only available from the main application window.".to_owned(),
        );
    }
    Ok(())
}

fn get_session(run_id: &str) -> Result<(Uuid, Arc<LiveWhisperHandle>), String> {
    let id = Uuid::parse_str(run_id)
        .map_err(|_| "The live transcription run is invalid or expired.".to_owned())?;
    let handle = live_sessions()
        .lock()
        .map_err(|_| "Live transcription state is unavailable.".to_owned())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "The live transcription run has ended.".to_owned())?;
    Ok((id, handle))
}

#[tauri::command]
pub async fn begin_live_whisper(
    window: WebviewWindow,
    model_path: String,
    language: String,
    window_seconds: u32,
    thread_count: u32,
    sample_rate_hz: u32,
    first_sample_index: String,
    timeline_base_sample_index: String,
    diarize_speaker_turns: bool,
) -> Result<LiveWhisperStarted, String> {
    main_window(&window)?;
    if window_seconds == 0 || window_seconds > MAX_WINDOW_SECONDS {
        return Err("Choose a live Whisper window between 1 and 27 seconds.".to_owned());
    }
    if thread_count == 0 || thread_count > MAX_THREADS {
        return Err("Choose between 1 and 64 Whisper worker threads.".to_owned());
    }
    if !(MIN_SOURCE_RATE_HZ..=MAX_SOURCE_RATE_HZ).contains(&sample_rate_hz) {
        return Err("The microphone sample rate is outside Whisper's supported range.".to_owned());
    }
    let language = validate_language(&language)?;
    let first_sample_index = first_sample_index
        .parse::<u64>()
        .map_err(|_| "The recording's initial sample position is invalid.".to_owned())?;
    let timeline_base_sample_index = timeline_base_sample_index
        .parse::<u64>()
        .map_err(|_| "The recording's timeline origin is invalid.".to_owned())?;
    if first_sample_index < timeline_base_sample_index {
        return Err("The recording starts before its transcript timeline.".to_owned());
    }
    let selected_path = Path::new(&model_path);
    let original_metadata = fs::symlink_metadata(selected_path)
        .map_err(|_| "Cannot inspect the selected Whisper model file.".to_owned())?;
    if original_metadata.file_type().is_symlink()
        || !original_metadata.is_file()
        || original_metadata.len() == 0
    {
        return Err(
            "Choose a non-empty, regular Whisper model file without a symbolic link.".to_owned(),
        );
    }
    let model_path = fs::canonicalize(selected_path)
        .map_err(|_| "Cannot open the selected Whisper model file.".to_owned())?;
    let model_name = model_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Whisper model")
        .to_owned();
    let run_id = Uuid::new_v4();
    let shared = Arc::new(Mutex::new(SharedOutput {
        status: "loading".to_owned(),
        model_name: model_name.clone(),
        ..SharedOutput::default()
    }));
    let cancelled = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::sync_channel(WORK_QUEUE_CHUNKS);
    let (ready_tx, ready_rx) = mpsc::channel();
    let handle = Arc::new(LiveWhisperHandle {
        sender,
        shared: Arc::clone(&shared),
        cancelled: Arc::clone(&cancelled),
        worker: Mutex::new(None),
    });
    {
        let mut sessions = live_sessions()
            .lock()
            .map_err(|_| "Live transcription state is unavailable.".to_owned())?;
        if !sessions.is_empty() {
            return Err("A live Whisper session is already active. Finish or cancel it before starting another.".to_owned());
        }
        sessions.insert(run_id, Arc::clone(&handle));
    }
    let options = LiveWhisperOptions {
        model_path,
        model_name,
        language,
        window_seconds,
        thread_count,
        sample_rate_hz,
        first_sample_index,
        timeline_base_sample_index,
        diarize_speaker_turns,
    };
    start_worker(
        options,
        Arc::clone(&shared),
        Arc::clone(&cancelled),
        receiver,
        ready_tx,
        &handle,
    );
    let ready_result = tauri::async_runtime::spawn_blocking(move || {
        ready_rx.recv_timeout(Duration::from_secs(600))
    })
    .await;
    let ready_result = match ready_result {
        Ok(result) => result,
        Err(_) => {
            if let Ok(mut sessions) = live_sessions().lock() {
                sessions.remove(&run_id);
            }
            handle.set_failed("The live Whisper model loader could not finish.");
            handle.detach();
            return Err("The live Whisper model loader could not finish.".to_owned());
        }
    };
    match ready_result {
        Ok(Ok(())) => {
            let output = shared
                .lock()
                .map_err(|_| "Live transcription state is unavailable.".to_owned())?;
            Ok(LiveWhisperStarted {
                run_id: run_id.to_string(),
                model_name: output.model_name.clone(),
                backend_version: output.backend_version.clone(),
            })
        }
        Ok(Err(error)) => {
            if let Ok(mut sessions) = live_sessions().lock() {
                sessions.remove(&run_id);
            }
            handle.cancel();
            handle.join();
            Err(error)
        }
        Err(RecvTimeoutError::Timeout) => {
            if let Ok(mut sessions) = live_sessions().lock() {
                sessions.remove(&run_id);
            }
            handle.set_failed("Whisper model loading exceeded the 10-minute startup limit.");
            handle.detach();
            Err("Whisper model loading exceeded the 10-minute startup limit.".to_owned())
        }
        Err(RecvTimeoutError::Disconnected) => {
            if let Ok(mut sessions) = live_sessions().lock() {
                sessions.remove(&run_id);
            }
            handle.cancel();
            handle.join();
            Err("The live Whisper worker stopped before its model finished loading.".to_owned())
        }
    }
}

#[tauri::command]
pub fn enqueue_live_whisper_audio(
    window: WebviewWindow,
    run_id: String,
    sequence: u64,
    first_sample_index: String,
    sample_rate_hz: u32,
    samples: Vec<u8>,
) -> Result<(), String> {
    main_window(&window)?;
    if samples.is_empty() || samples.len() > MAX_AUDIO_CHUNK_BYTES || samples.len() % 2 != 0 {
        return Err(
            "Live Whisper audio chunks must contain aligned 16-bit PCM under 32 KiB.".to_owned(),
        );
    }
    let (_, handle) = get_session(&run_id)?;
    let first_sample_index = first_sample_index
        .parse::<u64>()
        .map_err(|_| "The live microphone sample position is invalid.".to_owned())?;
    if !(MIN_SOURCE_RATE_HZ..=MAX_SOURCE_RATE_HZ).contains(&sample_rate_hz) {
        return Err(
            "The live microphone sample rate is outside Whisper's supported range.".to_owned(),
        );
    }
    handle.enqueue(QueuedAudioChunk {
        sequence,
        first_sample_index,
        sample_rate_hz,
        samples: Zeroizing::new(samples),
    })?;
    Ok(())
}

#[tauri::command]
pub fn poll_live_whisper(window: WebviewWindow, run_id: String) -> Result<LiveWhisperPoll, String> {
    main_window(&window)?;
    let (run_id, handle) = get_session(&run_id)?;
    let output = handle
        .shared
        .lock()
        .map_err(|_| "Live transcription output is unavailable.".to_owned())?;
    Ok(LiveWhisperPoll {
        run_id: run_id.to_string(),
        status: output.status.clone(),
        error: output.error.clone(),
        model_name: output.model_name.clone(),
        backend_version: output.backend_version.clone(),
        cues: output
            .cues
            .iter()
            .take(MAX_CUES_PER_POLL)
            .cloned()
            .collect(),
    })
}

#[tauri::command]
pub fn acknowledge_live_whisper_cues(
    window: WebviewWindow,
    run_id: String,
    through_sequence: String,
) -> Result<(), String> {
    main_window(&window)?;
    let (_, handle) = get_session(&run_id)?;
    let through_sequence = through_sequence
        .parse::<u64>()
        .map_err(|_| "The live transcript acknowledgement is invalid.".to_owned())?;
    let mut output = handle
        .shared
        .lock()
        .map_err(|_| "Live transcription output is unavailable.".to_owned())?;
    if through_sequence >= output.next_sequence {
        return Err("The live transcript acknowledgement is ahead of generated cues.".to_owned());
    }
    while output
        .cues
        .front()
        .and_then(|cue| cue.sequence.parse::<u64>().ok())
        .is_some_and(|sequence| sequence <= through_sequence)
    {
        if let Some(cue) = output.cues.pop_front() {
            output.cue_text_bytes = output.cue_text_bytes.saturating_sub(cue.text.len());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_live_whisper(window: WebviewWindow, run_id: String) -> Result<(), String> {
    main_window(&window)?;
    let (_, handle) = get_session(&run_id)?;
    handle.cancel();
    Ok(())
}

#[tauri::command]
pub async fn finish_live_whisper(window: WebviewWindow, run_id: String) -> Result<(), String> {
    main_window(&window)?;
    let (_, handle) = get_session(&run_id)?;
    tauri::async_runtime::spawn_blocking(move || handle.finish())
        .await
        .map_err(|_| "The live Whisper finalization task could not finish.".to_owned())?
}

#[tauri::command]
pub fn end_live_whisper(window: WebviewWindow, run_id: String) -> Result<(), String> {
    main_window(&window)?;
    let id = Uuid::parse_str(&run_id)
        .map_err(|_| "The live transcription run is invalid or expired.".to_owned())?;
    let handle = live_sessions()
        .lock()
        .map_err(|_| "Live transcription state is unavailable.".to_owned())?
        .remove(&id)
        .ok_or_else(|| "The live transcription run has already ended.".to_owned())?;
    handle.cancel();
    handle.join();
    Ok(())
}
