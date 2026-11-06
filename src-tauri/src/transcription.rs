use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
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
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;
pub const EMBEDDED_WHISPER_MODEL_NAME: &str = "Whisper Base multilingual (Q5_1)";
pub static EMBEDDED_WHISPER_MODEL: &[u8] =
    include_bytes!("../../resources/whisper/ggml-base-q5_1.bin");
static RUNS: OnceLock<Mutex<HashMap<Uuid, Arc<AtomicBool>>>> = OnceLock::new();
static EMBEDDED_CONTEXT: OnceLock<WhisperContext> = OnceLock::new();
static EMBEDDED_CONTEXT_INIT: Mutex<()> = Mutex::new(());

pub fn embedded_whisper_context() -> Result<&'static WhisperContext, String> {
    if let Some(context) = EMBEDDED_CONTEXT.get() {
        return Ok(context);
    }
    // Only a successful load is cached. A failed or abandoned (timed-out) load must not pin an
    // error or a partially initialized model into the process for every later attempt.
    let _guard = EMBEDDED_CONTEXT_INIT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(context) = EMBEDDED_CONTEXT.get() {
        return Ok(context);
    }
    let context = WhisperContext::new_from_buffer_with_params(
        EMBEDDED_WHISPER_MODEL,
        WhisperContextParameters::default(),
    )
    .map_err(|error| format!("The bundled Whisper model could not be loaded: {error:?}"))?;
    Ok(EMBEDDED_CONTEXT.get_or_init(|| context))
}

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

struct TemporaryFiles {
    audio: PathBuf,
    _directory: tempfile::TempDir,
}

impl TemporaryFiles {
    fn audio_path(&self) -> &Path {
        &self.audio
    }
}

fn create_temporary_transcription_files() -> Result<(TemporaryFiles, File, PathBuf), String> {
    let directory = tempfile::Builder::new()
        .prefix("tutorux-whisper-")
        .tempdir_in(std::env::temp_dir())
        .map_err(|_| "Could not create a private transcription directory.".to_owned())?;
    let audio = directory.path().join("audio.wav");
    let output = directory.path().join("transcript");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&audio)
        .map_err(|_| "Could not create temporary transcription files.".to_owned())?;
    Ok((
        TemporaryFiles {
            audio,
            _directory: directory,
        },
        file,
        output,
    ))
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
    let (temporary_files, mut audio_file, output) = create_temporary_transcription_files()?;
    audio_file
        .write_all(&wav)
        .map_err(|_| "Could not prepare audio for transcription.".to_owned())?;
    drop(audio_file);
    let mut command = Command::new(executable);
    command
        .arg("-m")
        .arg(model)
        .arg("-f")
        .arg(temporary_files.audio_path())
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

fn whisper_pcm_samples(wav: &[u8]) -> Result<Vec<f32>, String> {
    if wav.len() < 44
        || wav.len() > MAX_AUDIO_BYTES
        || &wav[..4] != b"RIFF"
        || &wav[8..12] != b"WAVE"
    {
        return Err("Whisper audio must be a bounded PCM WAV file.".to_owned());
    }
    let mut offset = 12usize;
    let mut format = None;
    let mut data = None;
    while offset + 8 <= wav.len() {
        let id = &wav[offset..offset + 4];
        let size = u32::from_le_bytes([
            wav[offset + 4],
            wav[offset + 5],
            wav[offset + 6],
            wav[offset + 7],
        ]) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(size)
            .ok_or_else(|| "The WAV file is invalid.".to_owned())?;
        if end > wav.len() {
            return Err("The WAV file is truncated.".to_owned());
        }
        if id == b"fmt " && size >= 16 {
            format = Some((
                u16::from_le_bytes([wav[start], wav[start + 1]]),
                u16::from_le_bytes([wav[start + 2], wav[start + 3]]),
                u32::from_le_bytes([
                    wav[start + 4],
                    wav[start + 5],
                    wav[start + 6],
                    wav[start + 7],
                ]),
                u16::from_le_bytes([wav[start + 14], wav[start + 15]]),
            ));
        } else if id == b"data" {
            data = Some((start, size));
        }
        if format.is_some() && data.is_some() {
            break;
        }
        offset = end + (size % 2);
    }
    let Some((audio_format, channels, sample_rate, bits_per_sample)) = format else {
        return Err("The WAV file does not contain a PCM format chunk.".to_owned());
    };
    let Some((data_start, data_len)) = data else {
        return Err("The WAV file does not contain audio samples.".to_owned());
    };
    if audio_format != 1
        || channels != 1
        || sample_rate != 16_000
        || bits_per_sample != 16
        || data_len == 0
        || !data_len.is_multiple_of(2)
    {
        return Err("Whisper audio must contain 16 kHz mono 16-bit PCM samples.".to_owned());
    }
    Ok(wav[data_start..data_start + data_len]
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32_768.0)
        .collect())
}

fn transcribe_embedded(
    wav: Vec<u8>,
    language: String,
    cancelled: Arc<AtomicBool>,
) -> Result<WhisperOutput, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("Transcription cancelled.".to_owned());
    }
    if language.is_empty()
        || language.len() > 16
        || !language
            .bytes()
            .all(|character| character.is_ascii_alphabetic() || character == b'-')
    {
        return Err("Enter a valid Whisper language code, or auto.".to_owned());
    }
    let mut samples = whisper_pcm_samples(&wav)?;
    let context = embedded_whisper_context()?;
    let mut state = context
        .create_state()
        .map_err(|error| format!("Whisper could not initialize its model state: {error:?}"))?;
    let detect_language = language.eq_ignore_ascii_case("auto");
    let mut parameters = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    parameters.set_n_threads(default_threads() as i32);
    parameters.set_no_context(true);
    parameters.set_translate(false);
    parameters.set_print_progress(false);
    parameters.set_print_realtime(false);
    parameters.set_print_timestamps(false);
    parameters.set_print_special(false);
    parameters.set_language((!detect_language).then_some(language.as_str()));
    parameters.set_detect_language(detect_language);
    let abort_flag = Arc::clone(&cancelled);
    parameters.set_abort_callback_safe(move || abort_flag.load(Ordering::Acquire));
    let full_result = state.full(parameters, &samples);
    samples.fill(0.0);
    full_result.map_err(|error| {
        if cancelled.load(Ordering::Acquire) {
            "Transcription cancelled.".to_owned()
        } else {
            format!("The bundled Whisper model could not transcribe this audio: {error:?}")
        }
    })?;
    if cancelled.load(Ordering::Acquire) {
        return Err("Transcription cancelled.".to_owned());
    }

    let detected_language = if detect_language {
        whisper_rs::get_lang_str(state.full_lang_id_from_state()).unwrap_or("auto")
    } else {
        language.as_str()
    };
    let transcription = state
        .as_iter()
        .filter_map(|segment| {
            let text = segment.to_str_lossy().ok()?.trim().to_owned();
            let start = segment.start_timestamp();
            let end = segment.end_timestamp();
            if text.is_empty() || start < 0 || end <= start {
                return None;
            }
            Some(serde_json::json!({
                "offsets": { "from": start.saturating_mul(10), "to": end.saturating_mul(10) },
                "text": text,
            }))
        })
        .collect::<Vec<_>>();
    let json = serde_json::to_string(&serde_json::json!({
        "result": { "language": detected_language },
        "transcription": transcription,
    }))
    .map_err(|_| "Whisper could not format its transcript.".to_owned())?;
    Ok(WhisperOutput {
        json,
        model_name: EMBEDDED_WHISPER_MODEL_NAME.to_owned(),
    })
}

#[tauri::command]
pub async fn transcribe_whisper(
    window: tauri::WebviewWindow,
    run_id: String,
    wav: Vec<u8>,
    language: String,
) -> Result<WhisperOutput, String> {
    main_window(&window)?;
    let id = Uuid::parse_str(&run_id).map_err(|_| "Invalid transcription job.".to_owned())?;
    let cancelled = runs()
        .lock()
        .map_err(|_| "Transcription state is unavailable.".to_owned())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "Transcription job has ended.".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || transcribe_embedded(wav, language, cancelled))
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
pub fn parse_whisper_json(json: &str) -> Result<Vec<WhisperCue>, String> {
    let parsed: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| "Whisper returned an invalid transcript.".to_owned())?;
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
    use super::{
        embedded_whisper_context, parse_whisper_json, transcribe_embedded, EMBEDDED_WHISPER_MODEL,
        EMBEDDED_WHISPER_MODEL_NAME,
    };
    use std::sync::{atomic::AtomicBool, Arc};

    fn silence_wav(duration_seconds: u32) -> Vec<u8> {
        let sample_count = duration_seconds * 16_000;
        let data_bytes = sample_count * 2;
        let mut wav = Vec::with_capacity((44 + data_bytes) as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&32_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());
        wav.resize((44 + data_bytes) as usize, 0);
        wav
    }

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
        assert!(parse_whisper_json(
            r#"{"transcription":[{"offsets":{"from":5,"to":5},"text":"x"}]}"#
        )
        .is_err());
        assert!(parse_whisper_json(
            r#"{"transcription":[{"offsets":{"from":0,"to":5},"text":42}]}"#
        )
        .is_err());
    }

    #[test]
    fn embedded_model_is_packaged_and_initializes_without_external_files() {
        assert_eq!(EMBEDDED_WHISPER_MODEL.len(), 59_707_625);
        let context = embedded_whisper_context().expect("bundled Whisper model loads");
        context.create_state().expect("Whisper state initializes");
    }

    #[test]
    fn embedded_model_transcribes_bounded_pcm_without_temp_files() {
        let output = transcribe_embedded(
            silence_wav(1),
            "auto".to_owned(),
            Arc::new(AtomicBool::new(false)),
        )
        .expect("bundled model transcribes its input");
        assert_eq!(output.model_name, EMBEDDED_WHISPER_MODEL_NAME);
        let parsed: serde_json::Value =
            serde_json::from_str(&output.json).expect("native transcription emits JSON");
        assert!(parsed["transcription"].is_array());
    }

    #[test]
    fn embedded_model_transcribes_clear_speech() {
        let wav = include_bytes!("../tests/fixtures/jfk.wav").to_vec();
        let output = transcribe_embedded(wav, "en".to_owned(), Arc::new(AtomicBool::new(false)))
            .expect("bundled model transcribes speech");
        let parsed: serde_json::Value =
            serde_json::from_str(&output.json).expect("native transcription emits JSON");
        let text = parsed["transcription"]
            .as_array()
            .expect("transcription array")
            .iter()
            .filter_map(|segment| segment["text"].as_str())
            .collect::<String>()
            .to_lowercase();
        assert!(text.contains("country"), "transcript was {text:?}");
    }
}
