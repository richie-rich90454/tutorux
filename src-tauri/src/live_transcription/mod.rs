mod resampler;
mod session;
mod window;
mod worker;

use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{
        atomic::AtomicBool,
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::WebviewWindow;
use uuid::Uuid;
use zeroize::Zeroizing;

use session::{LiveWhisperHandle, LiveWhisperOptions, QueuedAudioChunk, SharedOutput};
use worker::start_worker;

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
