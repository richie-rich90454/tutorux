mod audio;
mod metrics;

use audio::{enumerate_audio_endpoints, AudioEndpointDiagnostics};
use metrics::{
    collect_process_metrics, metric_available, metric_string, total_system_memory_bytes,
    ProcessMetrics,
};
use serde::Serialize;
use serde_json::{json, Value};
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

/// Process and system counters for the CLI benchmark and diagnostics commands.
pub fn headless_system_snapshot() -> Value {
    let metrics = collect_process_metrics();
    json!({
        "operating_system": operating_system_name(),
        "architecture": architecture_name(),
        "process_uptime_us": metric_string(&metrics.uptime_microseconds),
        "process_cpu_time_us": metric_string(&metrics.cpu_time_microseconds),
        "process_cpu_available": metric_available(&metrics.cpu_time_microseconds),
        "resident_memory_bytes": metric_string(&metrics.resident_memory_bytes),
        "peak_resident_memory_bytes": metric_string(&metrics.peak_resident_memory_bytes),
        "resident_memory_available": metric_available(&metrics.resident_memory_bytes),
        "available_memory_bytes": metric_string(&metrics.available_memory_bytes),
        "available_memory_available": metric_available(&metrics.available_memory_bytes),
        "hardware_threads": std::thread::available_parallelism()
            .map(|value| value.get().to_string())
            .unwrap_or_else(|_| "1".to_owned()),
    })
}

pub fn headless_host_summary() -> Value {
    json!({
        "platform": node_platform_name(),
        "os_release": "",
        "cpu_count": std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(1),
        "total_memory_bytes": total_system_memory_bytes().unwrap_or(0),
    })
}

pub fn headless_audio_diagnostics(probe_streams: bool) -> Value {
    serde_json::to_value(enumerate_audio_endpoints(probe_streams)).unwrap_or(Value::Null)
}

fn operating_system_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        "freebsd" => "FreeBSD",
        "android" => "Android",
        _ => "Unknown",
    }
}

fn architecture_name() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "arm64",
        "x86" => "x86",
        "arm" => "arm",
        other => other,
    }
}

fn node_platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}
