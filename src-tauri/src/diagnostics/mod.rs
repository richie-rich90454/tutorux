mod audio;
mod metrics;

use audio::{enumerate_audio_endpoints, AudioEndpointDiagnostics};
use metrics::{collect_process_metrics, ProcessMetrics};
use serde::Serialize;
use std::time::Duration;
use tauri::WebviewWindow;

pub(crate) use metrics::available_system_memory_bytes;

const MAX_AUDIO_STREAM_PROBES: usize = 12;
const AUDIO_STREAM_PROBE_DURATION: Duration = Duration::from_millis(125);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDiagnostics {
    os: String,
    architecture: String,
    available_threads: Option<usize>,
    process_metrics: ProcessMetrics,
    audio_endpoints: AudioEndpointDiagnostics,
}

#[tauri::command]
pub async fn get_desktop_diagnostics(
    window: WebviewWindow,
    probe_audio_endpoints: bool,
) -> Result<DesktopDiagnostics, String> {
    if window.label() != "main" {
        return Err(
            "Desktop diagnostics are only available from the main application window.".into(),
        );
    }

    tauri::async_runtime::spawn_blocking(move || DesktopDiagnostics {
        os: std::env::consts::OS.to_owned(),
        architecture: std::env::consts::ARCH.to_owned(),
        available_threads: std::thread::available_parallelism().ok().map(usize::from),
        process_metrics: collect_process_metrics(),
        audio_endpoints: enumerate_audio_endpoints(probe_audio_endpoints),
    })
    .await
    .map_err(|_| "Desktop diagnostics stopped unexpectedly.".to_owned())
}
