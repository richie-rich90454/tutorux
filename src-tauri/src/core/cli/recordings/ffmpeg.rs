use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const STDERR_LIMIT: usize = 32 * 1024;
const DECODE_TIMEOUT: Duration = Duration::from_secs(600);
const FFMPEG_RATE_HZ: u32 = 16_000;

#[derive(Clone, Debug)]
pub(super) struct FfmpegDevice {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) backend: String,
}

pub(super) fn resolve_executable(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            std::env::var("TUTORUX_FFMPEG")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "ffmpeg".to_owned())
}

pub(super) fn enumerate(executable: &str) -> Result<Vec<FfmpegDevice>, String> {
    if cfg!(windows) {
        let output = run_quick(
            executable,
            &[
                "-hide_banner",
                "-list_devices",
                "true",
                "-f",
                "dshow",
                "-i",
                "dummy",
            ],
        )?;
        let text = decode_text(&output.stderr);
        let lower = text.to_ascii_lowercase();
        let start = lower
            .find("directshow audio devices")
            .map(|index| audio_section_start(&text, index))
            .unwrap_or(0);
        let end = lower
            .find("directshow video devices")
            .filter(|index| *index > start)
            .unwrap_or(text.len());
        return Ok(unique(parse_dshow_audio(
            &text[start.min(text.len())..end.min(text.len())],
        )));
    }
    if cfg!(target_os = "macos") {
        let output = run_quick(
            executable,
            &[
                "-hide_banner",
                "-f",
                "avfoundation",
                "-list_devices",
                "true",
                "-i",
                "",
            ],
        )?;
        let text = decode_text(&output.stderr);
        let start = text
            .find("AVFoundation audio devices:")
            .map(|index| index + "AVFoundation audio devices:".len())
            .unwrap_or(text.len());
        let end = text
            .find("AVFoundation video devices:")
            .filter(|index| *index > start)
            .unwrap_or(text.len());
        let mut devices = Vec::new();
        for line in text[start.min(text.len())..end.min(text.len())].lines() {
            let line = line.trim();
            let Some(rest) = line.strip_prefix('[') else {
                continue;
            };
            let Some((index, name)) = rest.split_once(']') else {
                continue;
            };
            let name = name.trim();
            if index.is_empty() || name.is_empty() {
                continue;
            }
            devices.push(FfmpegDevice {
                id: index.to_owned(),
                name: name.to_owned(),
                backend: "avfoundation".to_owned(),
            });
        }
        return Ok(unique(devices));
    }
    let mut devices = Vec::new();
    let mut first_error = None;
    for backend in ["pulse", "alsa"] {
        match run_quick(executable, &["-hide_banner", "-sources", backend]) {
            Ok(output) => devices.extend(parse_sources(&decode_text(&output.stderr), backend)),
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    if devices.is_empty() {
        if let Some(error) = first_error {
            return Err(error);
        }
    }
    Ok(unique(devices))
}

fn audio_section_start(text: &str, index: usize) -> usize {
    text[index..]
        .find('\n')
        .map(|offset| index + offset + 1)
        .unwrap_or(text.len())
}

fn parse_dshow_audio(section: &str) -> Vec<FfmpegDevice> {
    let lines: Vec<&str> = section.lines().collect();
    let mut devices = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        let trimmed = lines[index].trim();
        let Some(quote) = trimmed.find('"') else {
            index += 1;
            continue;
        };
        let rest = &trimmed[quote + 1..];
        let Some(end) = rest.find('"') else {
            index += 1;
            continue;
        };
        let raw_name = rest[..end].trim();
        let after = rest[end + 1..].trim();
        if raw_name.is_empty()
            || raw_name.starts_with("@device_")
            || !after.contains("(audio)")
        {
            index += 1;
            continue;
        }
        let name = raw_name.to_owned();
        let mut id = name.clone();
        if let Some(next) = lines.get(index + 1) {
            let next = next.trim();
            if let Some(alternative) = next
                .split_once("Alternative name")
                .and_then(|(_, value)| quoted(value))
            {
                id = alternative.to_owned();
                index += 1;
            }
        }
        devices.push(FfmpegDevice {
            id,
            name,
            backend: "dshow".to_owned(),
        });
        index += 1;
    }
    devices
}

fn quoted(value: &str) -> Option<&str> {
    let quote = value.find('"')?;
    let rest = &value[quote + 1..];
    let end = rest.find('"')?;
    (end > 0).then(|| rest[..end].trim())
}

fn decode_text(bytes: &[u8]) -> String {
    if let Ok(value) = std::str::from_utf8(bytes) {
        return value.to_owned();
    }
    let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
    decoded.into_owned()
}

fn parse_sources(text: &str, backend: &str) -> Vec<FfmpegDevice> {
    let mut devices = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.ends_with(':') || trimmed.starts_with("Auto-detected") {
            continue;
        }
        let Some(open) = trimmed.rfind(" [") else {
            continue;
        };
        if !trimmed.ends_with(']') {
            continue;
        }
        let name = trimmed[..open].trim().trim_start_matches('*').trim();
        let id = trimmed[open + 2..trimmed.len() - 1].trim();
        if name.is_empty() || id.is_empty() || name == "=" || id == "=" {
            continue;
        }
        devices.push(FfmpegDevice {
            id: id.to_owned(),
            name: name.to_owned(),
            backend: backend.to_owned(),
        });
    }
    devices
}

fn unique(devices: Vec<FfmpegDevice>) -> Vec<FfmpegDevice> {
    let mut result: Vec<FfmpegDevice> = Vec::new();
    for device in devices {
        if !result.iter().any(|existing| existing.id == device.id) {
            result.push(device);
        }
    }
    result
}

fn run_quick(executable: &str, arguments: &[&str]) -> Result<std::process::Output, String> {
    let output = hidden_command(executable)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not start FFmpeg: {error}"))?;
    if output.status.success() || !output.stderr.is_empty() {
        return Ok(output);
    }
    Err(format!(
        "FFmpeg exited with code {:?} while listing devices.",
        output.status.code()
    ))
}

pub(super) fn preferred_backend() -> &'static str {
    if cfg!(windows) {
        "dshow"
    } else if cfg!(target_os = "macos") {
        "avfoundation"
    } else {
        "pulse"
    }
}

pub(super) fn is_loopback(device: &FfmpegDevice) -> bool {
    let lower = format!("{} {}", device.id, device.name).to_ascii_lowercase();
    lower.contains("monitor")
        || lower.contains("loopback")
        || lower.contains("stereo mix")
        || lower.contains("stereomix")
        || lower.contains("what u hear")
        || lower.contains("wave out mix")
}

pub(super) fn input_arguments(device: &FfmpegDevice) -> Vec<String> {
    match device.backend.as_str() {
        "dshow" => {
            let input = if device.id.starts_with('@') {
                format!("audio={}", device.id)
            } else {
                format!("audio=\"{}\"", device.id)
            };
            vec![
                "-f".to_owned(),
                "dshow".to_owned(),
                "-i".to_owned(),
                input,
            ]
        }
        "avfoundation" => vec![
            "-f".to_owned(),
            "avfoundation".to_owned(),
            "-i".to_owned(),
            format!(":{}", device.id),
        ],
        backend => vec![
            "-f".to_owned(),
            backend.to_owned(),
            "-i".to_owned(),
            device.id.clone(),
        ],
    }
}

pub(super) fn capture_arguments(device: &FfmpegDevice) -> Vec<String> {
    let mut args = vec![
        "-nostdin".to_owned(),
        "-hide_banner".to_owned(),
        "-loglevel".to_owned(),
        "error".to_owned(),
    ];
    args.extend(input_arguments(device));
    args.extend([
        "-vn".to_owned(),
        "-f".to_owned(),
        "s16le".to_owned(),
        "-ac".to_owned(),
        "1".to_owned(),
        "-ar".to_owned(),
        FFMPEG_RATE_HZ.to_string(),
        "pipe:1".to_owned(),
    ]);
    args
}

pub(super) fn spawn_capture(executable: &str, device: &FfmpegDevice) -> Result<Child, String> {
    hidden_command(executable)
        .args(capture_arguments(device))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start FFmpeg audio capture: {error}"))
}

pub(super) fn decode_to_wav(
    executable: &str,
    input: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let mut child = hidden_command(executable)
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
        ])
        .arg(input)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "-n",
        ])
        .arg(destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start FFmpeg audio decoding: {error}"))?;
    let stderr = child.stderr.take();
    let started = Instant::now();
    let mut timed_out = false;
    let mut status = None;
    loop {
        match child.try_wait() {
            Ok(Some(exit)) => {
                status = Some(exit);
                break;
            }
            Ok(None) if started.elapsed() > DECODE_TIMEOUT => {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                break;
            }
        }
    }
    let mut error = String::new();
    if let Some(pipe) = stderr {
        let mut bytes = Vec::new();
        let _ = pipe.take(STDERR_LIMIT as u64).read_to_end(&mut bytes);
        error = String::from_utf8_lossy(&bytes).trim().to_owned();
    }
    if timed_out {
        return Err("FFmpeg audio decoding exceeded the 10-minute time limit.".to_owned());
    }
    if !status.as_ref().map(|exit| exit.success()).unwrap_or(false) {
        return Err(if error.is_empty() {
            format!(
                "FFmpeg audio decoding exited with code {:?}.",
                status.as_ref().and_then(|exit| exit.code())
            )
        } else {
            error
        });
    }
    let metadata = std::fs::symlink_metadata(destination)
        .map_err(|_| "FFmpeg did not produce a valid decoded WAVE file.".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() < 12 {
        return Err("FFmpeg did not produce a valid decoded WAVE file.".to_owned());
    }
    Ok(())
}

pub(super) fn hidden_command(executable: &str) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}
