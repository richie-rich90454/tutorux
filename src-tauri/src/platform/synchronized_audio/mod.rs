//! Native microphone, system-audio, and application-audio capture for the Tauri desktop host.
//!
//! Each source owns its stream, bounded callback queue, counters, and failure state. A failure or
//! a slow consumer on one source therefore does not stop the other source. Samples cross the
//! webview boundary as bounded, base64-encoded interleaved PCM chunks that keep the device's
//! channel count and a legacy-compatible sample-format label; the archive remains owned by the
//! frontend.

mod application_audio;
mod capture;
mod commands;
mod devices;
mod lifecycle;
mod model;
mod probe;
mod session;
mod support;
mod worker;

#[cfg(test)]
mod tests;

#[allow(unused_imports)]
pub use model::SynchronizedAudioDevice;
pub use model::{SynchronizedAudioDevices, SynchronizedAudioFinished, SynchronizedAudioStarted};
#[allow(unused_imports)]
pub use probe::ApplicationAudioProbeSummary;
pub use probe::inspect_application_audio_endpoints;
pub use session::SynchronizedAudioCaptureState;

pub(super) use devices::resolve_device;

use tauri::{State, WebviewWindow};

#[tauri::command]
pub fn list_synchronized_audio_devices(
    window: WebviewWindow,
) -> Result<SynchronizedAudioDevices, String> {
    commands::list_devices(&window)
}

#[tauri::command]
pub fn begin_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
    consent_confirmed: bool,
    consent_at_us: String,
    microphone_device_id: String,
    system_audio_device_id: Option<String>,
    application_audio_device_id: Option<String>,
) -> Result<SynchronizedAudioStarted, String> {
    commands::begin(
        &window,
        &state,
        capture_id,
        consent_confirmed,
        consent_at_us,
        microphone_device_id,
        system_audio_device_id,
        application_audio_device_id,
    )
}

#[tauri::command]
pub fn activate_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
) -> Result<(), String> {
    lifecycle::activate(&window, &state, capture_id)
}

#[tauri::command]
pub fn pause_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
    pause_id: u64,
) -> Result<(), String> {
    lifecycle::pause(&window, &state, capture_id, pause_id)
}

#[tauri::command]
pub fn resume_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
) -> Result<(), String> {
    lifecycle::resume(&window, &state, capture_id)
}

#[tauri::command]
pub fn stop_synchronized_audio_source(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
    track: String,
    message: String,
) -> Result<(), String> {
    lifecycle::stop_source(&window, &state, capture_id, track, message)
}

#[tauri::command]
pub fn finish_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
) -> Result<SynchronizedAudioFinished, String> {
    lifecycle::finish(&window, &state, capture_id)
}

#[tauri::command]
pub fn discard_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
) -> Result<(), String> {
    lifecycle::discard(&window, &state, capture_id)
}
