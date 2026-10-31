use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};
use uuid::Uuid;

const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;
static RUNS: OnceLock<Mutex<HashMap<Uuid, Arc<AtomicBool>>>> = OnceLock::new();

fn runs() -> &'static Mutex<HashMap<Uuid, Arc<AtomicBool>>> {
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Transcription is only available from the main application window.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn begin_whisper_run(window: tauri::WebviewWindow) -> Result<String, String> {
    main_window(&window)?;
    let mut state = runs()
        .lock()
        .map_err(|_| "Transcription state is unavailable.".to_owned())?;
    if state.len() >= 4 {
        return Err("Too many transcription jobs are active.".into());
    }
    let id = Uuid::new_v4();
    state.insert(id, Arc::new(AtomicBool::new(false)));
    Ok(id.to_string())
}

#[tauri::command]
pub fn cancel_whisper_run(window: tauri::WebviewWindow, run_id: String) -> Result<(), String> {
    main_window(&window)?;
    let id = Uuid::parse_str(&run_id).map_err(|_| "Invalid transcription job.".to_owned())?;
    let state = runs()
        .lock()
        .map_err(|_| "Transcription state is unavailable.".to_owned())?;
    if let Some(cancelled) = state.get(&id) {
        cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub fn end_whisper_run(window: tauri::WebviewWindow, run_id: String) -> Result<(), String> {
    main_window(&window)?;
    let id = Uuid::parse_str(&run_id).map_err(|_| "Invalid transcription job.".to_owned())?;
    if let Some(cancelled) = runs()
        .lock()
        .map_err(|_| "Transcription state is unavailable.".to_owned())?
        .remove(&id)
    {
        cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperOutput {
    pub json: String,
    pub model_name: String,
}

struct TemporaryDirectory(PathBuf);

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn regular_file(path: &str, label: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path).map_err(|_| format!("Cannot open the selected {label}."))?;
    if !path.is_file() {
        return Err(format!("The selected {label} is not a regular file."));
    }
    Ok(path)
}

fn transcribe(
    executable: String,
    model: String,
    wav: Vec<u8>,
    language: String,
    diarize_speaker_turns: bool,
    threads: u32,
    cancelled: Arc<AtomicBool>,
) -> Result<WhisperOutput, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("Transcription cancelled.".into());
    }
    if wav.len() < 44
        || wav.len() > MAX_AUDIO_BYTES
        || &wav[..4] != b"RIFF"
        || &wav[8..12] != b"WAVE"
    {
        return Err("The audio preview must be a WAV file of at most 32 MiB.".into());
    }
    if language.is_empty()
        || language.len() > 16
        || !language
            .bytes()
            .all(|c| c.is_ascii_alphabetic() || c == b'-')
    {
        return Err("Enter a valid Whisper language code, or auto.".into());
    }
    let executable = regular_file(&executable, "Whisper executable")?;
    let model = regular_file(&model, "Whisper model")?;
    let model_name = model
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Whisper model")
        .to_owned();
    let directory = std::env::temp_dir().join(format!("tutorux-whisper-{}", Uuid::new_v4()));
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder
        .create(&directory)
        .map_err(|_| "Could not create a temporary transcription workspace.".to_owned())?;
    let directory = TemporaryDirectory(directory);
    let audio = directory.0.join("audio.wav");
    let output = directory.0.join("transcript");
    fs::write(&audio, wav).map_err(|_| "Could not prepare audio for transcription.".to_owned())?;
    let mut command = Command::new(executable);
    command
        .arg("-m")
        .arg(model)
        .arg("-f")
        .arg(audio)
        .arg("-l")
        .arg(language)
        .arg("-oj")
        .arg("-of")
        .arg(&output)
        .arg("-np")
        .arg("-t")
        .arg(threads.to_string());
    if diarize_speaker_turns {
        command.arg("-tdrz");
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the selected Whisper executable.".to_owned())?;
    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Transcription cancelled.".into());
        }
        match child
            .try_wait()
            .map_err(|_| "Could not monitor transcription.".to_owned())?
        {
            Some(status) => break status,
            None => thread::sleep(Duration::from_millis(150)),
        }
    };
    if !status.success() {
        return Err("Whisper could not transcribe this audio. Check that the executable and model are compatible.".into());
    }
    let json_path = Path::new(&output).with_extension("json");
    let metadata =
        fs::metadata(&json_path).map_err(|_| "Whisper did not produce a transcript.".to_owned())?;
    if !metadata.is_file() || metadata.len() > MAX_OUTPUT_BYTES {
        return Err("Whisper output is too large or invalid.".into());
    }
    let json =
        fs::read_to_string(json_path).map_err(|_| "Could not read Whisper output.".to_owned())?;
    Ok(WhisperOutput { json, model_name })
}

#[tauri::command]
pub async fn transcribe_whisper(
    window: tauri::WebviewWindow,
    run_id: String,
    executable: String,
    model: String,
    wav: Vec<u8>,
    language: String,
    diarize_speaker_turns: bool,
) -> Result<WhisperOutput, String> {
    main_window(&window)?;
    let id = Uuid::parse_str(&run_id).map_err(|_| "Invalid transcription job.".to_owned())?;
    let cancelled = runs()
        .lock()
        .map_err(|_| "Transcription state is unavailable.".to_owned())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "Transcription job has ended.".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        transcribe(
            executable,
            model,
            wav,
            language,
            diarize_speaker_turns,
            default_threads(),
            cancelled,
        )
    })
    .await
    .map_err(|_| "The transcription task could not finish.".to_owned())?
}

fn default_threads() -> u32 {
    std::thread::available_parallelism()
        .map(|value| u32::try_from(value.get()).unwrap_or(8).clamp(1, 8))
        .unwrap_or(4)
}

/// Run one WAV file through whisper.cpp without a Tauri window.
pub fn transcribe_wav(
    executable: &str,
    model: &str,
    wav: Vec<u8>,
    language: &str,
    diarize_speaker_turns: bool,
    threads: Option<u32>,
    cancelled: Arc<AtomicBool>,
) -> Result<WhisperOutput, String> {
    let threads = threads.unwrap_or_else(default_threads);
    if !(1..=64).contains(&threads) {
        return Err("The Whisper thread count must be an integer from 1 through 64.".to_owned());
    }
    transcribe(
        executable.to_owned(),
        model.to_owned(),
        wav,
        language.to_owned(),
        diarize_speaker_turns,
        threads,
        cancelled,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhisperCue {
    pub start_us: i64,
    pub end_us: i64,
    pub text: String,
    pub speaker_turn_next: Option<bool>,
}

/// Parse whisper.cpp `-oj` output into bounded cue offsets.
pub fn parse_whisper_json(json: &str) -> Result<Vec<WhisperCue>, String> {    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "Whisper returned an invalid transcript.".to_owned())?;
    let transcription = parsed
        .get("transcription")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Whisper returned an invalid transcript.".to_owned())?;
    let mut cues = Vec::with_capacity(transcription.len());
    for value in transcription {
        let text = value
            .get("text")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Whisper returned an invalid segment.".to_owned())?;
        let offsets = value
            .get("offsets")
            .ok_or_else(|| "Whisper returned an invalid segment.".to_owned())?;
        let from = offsets
            .get("from")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| "Whisper returned an invalid segment.".to_owned())?;
        let to = offsets
            .get("to")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| "Whisper returned an invalid segment.".to_owned())?;
        if from < 0 || to <= from || text.len() > 1_000_000 {
            return Err("Whisper returned an invalid segment.".to_owned());
        }
        if text.trim().is_empty() {
            continue;
        }
        cues.push(WhisperCue {
            start_us: from.saturating_mul(1_000),
            end_us: to.saturating_mul(1_000),
            text: text.to_owned(),
            speaker_turn_next: value
                .get("speaker_turn_next")
                .and_then(serde_json::Value::as_bool),
        });
    }
    Ok(cues)
}


#[cfg(test)]
mod tests {
    use super::parse_whisper_json;

    #[test]
    fn parses_bounded_whisper_offsets_into_microseconds() {
        let cues = parse_whisper_json(
            r#"{"transcription":[{"offsets":{"from":1500,"to":2750},"text":" Hello ","speaker_turn_next":true},{"offsets":{"from":2750,"to":4000},"text":"   "}]}"#,
        )
        .expect("valid whisper json");
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].start_us, 1_500_000);
        assert_eq!(cues[0].end_us, 2_750_000);
        assert_eq!(cues[0].speaker_turn_next, Some(true));
    }

    #[test]
    fn rejects_invalid_whisper_segments() {
        assert!(parse_whisper_json("{}").is_err());
        assert!(parse_whisper_json(r#"{"transcription":[{"offsets":{"from":5,"to":5},"text":"x"}]}"#).is_err());
        assert!(parse_whisper_json(r#"{"transcription":[{"offsets":{"from":0,"to":5},"text":42}]}"#).is_err());
    }
}
