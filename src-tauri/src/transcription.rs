use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use uuid::Uuid;

const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;

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
) -> Result<WhisperOutput, String> {
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
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let status = command
        .status()
        .map_err(|_| "Could not start the selected Whisper executable.".to_owned())?;
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
    executable: String,
    model: String,
    wav: Vec<u8>,
    language: String,
) -> Result<WhisperOutput, String> {
    if window.label() != "main" {
        return Err("Transcription is only available from the main application window.".into());
    }
    tauri::async_runtime::spawn_blocking(move || transcribe(executable, model, wav, language))
        .await
        .map_err(|_| "The transcription task could not finish.".to_owned())?
}
