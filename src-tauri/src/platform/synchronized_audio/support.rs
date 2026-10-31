use std::time::{SystemTime, UNIX_EPOCH};
use tauri::WebviewWindow;
use uuid::Uuid;

pub(super) fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err(
            "Native audio capture is only available from the main application window.".into(),
        );
    }
    Ok(())
}

pub(super) fn parse_capture_id(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| "The synchronized capture identifier is invalid.".into())
}

pub(super) fn now_unix_microseconds() -> Result<u64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "The system clock is not available for recording metadata.".to_owned())?;
    u64::try_from(elapsed.as_micros())
        .map_err(|_| "The system clock is outside the supported recording range.".to_owned())
}

pub(super) fn device_error(source: &str, error: cpal::Error) -> String {
    let source = match source {
        "microphone" => "microphone",
        "system audio" | "system-audio" => "system audio",
        _ => "audio",
    };
    format!("The {source} capture failed: {error}")
}

pub(super) fn system_audio_unavailable_message() -> String {
    #[cfg(target_os = "windows")]
    {
        "Windows did not expose a usable WASAPI system-audio loopback device.".into()
    }
    #[cfg(target_os = "macos")]
    {
        "Native system-audio capture requires macOS 14.6 or newer, System Audio Recording permission, and a supported output-only device. Use shared-audio capture if no compatible device is available.".into()
    }
    #[cfg(target_os = "linux")]
    {
        "No system-audio loopback source was found. PipeWire is preferred; enable a monitor input or use the browser shared-audio capture path.".into()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "Native synchronized system-audio capture is not supported on this operating system.".into()
    }
}

pub(super) fn application_audio_unavailable_message() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "Per-application capture needs Windows build 20348 or newer and an active WASAPI audio session."
    }
    #[cfg(target_os = "macos")]
    {
        "Per-application capture needs macOS 14 or newer and Screen & System Audio Recording permission. Video is not saved."
    }
    #[cfg(target_os = "linux")]
    {
        "Per-application capture is available for active PipeWire output streams. ALSA alone cannot identify application audio."
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "Per-application audio capture is not supported on this operating system."
    }
}
