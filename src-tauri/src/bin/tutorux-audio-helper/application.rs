use serde::Serialize;
use std::collections::HashSet;
use std::io::{self, Write};
use std::time::Duration;

pub(crate) const APPLICATION_SAMPLE_RATE_HZ: u32 = 48_000;
pub(crate) const APPLICATION_CHANNELS: u16 = 2;
pub(crate) const APPLICATION_SAMPLE_FORMAT: &str = "pcm_f32le";
pub(crate) const MAX_QUEUED_CHUNKS: usize = 8;
pub(crate) const MAX_FRAMES_PER_CHUNK: usize = 128 * 1024;
pub(crate) const APPLICATION_PROBE_DURATION: Duration = Duration::from_millis(1_800);
pub(crate) const MAX_APPLICATION_GAP_FRAMES: u64 = APPLICATION_SAMPLE_RATE_HZ as u64 * 10;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplicationCaptureFormat {
    sample_format: &'static str,
    sample_rate_hz: u32,
    channel_count: u16,
    bytes_per_sample: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplicationCaptureSummary {
    sample_format: &'static str,
    sample_rate_hz: u32,
    channel_count: u16,
    frame_count: u64,
    byte_count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplicationDevice {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) backend: String,
    pub(crate) process_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bundle_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationSignalProbe {
    id: String,
    name: String,
    backend: String,
    source: &'static str,
    sample_format: &'static str,
    sample_rate_hz: u32,
    channel_count: u16,
    sample_count: u64,
    frame_count: u64,
    duration_ms: u64,
    rms: f64,
    peak: f64,
    dbfs: f64,
    signal_detected: bool,
    probe: &'static str,
}

#[derive(Default)]
pub(crate) struct ProbeMetrics {
    sample_count: u64,
    sum_squares: f64,
    peak: f64,
}

impl ProbeMetrics {
    pub(crate) fn record(&mut self, sample: f32) {
        let value = f64::from(sample).abs();
        self.sample_count = self.sample_count.saturating_add(1);
        self.sum_squares += value * value;
        self.peak = self.peak.max(value);
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(crate) fn application_devices() -> Result<Vec<ApplicationDevice>, String> {
    let processes = flexaudio::processes().map_err(|error| {
        format!(
            "{} Process audio discovery failed: {error}",
            platform_limitation()
        )
    })?;
    let mut seen = HashSet::new();
    let mut devices = Vec::new();
    for process in processes {
        if !process.is_output_active.unwrap_or(false) || !seen.insert(process.pid) {
            continue;
        }
        let name = process.name.trim();
        if name.is_empty() {
            continue;
        }
        #[cfg(target_os = "windows")]
        let (prefix, backend) = ("wasapi-process", "wasapi-process-loopback");
        #[cfg(target_os = "linux")]
        let (prefix, backend) = ("pipewire-process", "pipewire-process-loopback");
        devices.push(ApplicationDevice {
            id: format!("{prefix}:{}", process.pid),
            name: format!("{} · process {}", name, process.pid),
            backend: backend.to_owned(),
            process_id: process.pid,
            bundle_id: None,
        });
    }
    devices.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then(left.process_id.cmp(&right.process_id))
    });
    Ok(devices)
}

#[cfg(target_os = "macos")]
pub(crate) fn application_devices() -> Result<Vec<ApplicationDevice>, String> {
    use screencapturekit::prelude::SCShareableContent;

    let content = SCShareableContent::get().map_err(|error| {
        format!(
            "ScreenCaptureKit could not list applications. Grant Screen & System Audio Recording permission and restart Tutorux: {error}"
        )
    })?;
    let mut seen = HashSet::new();
    let mut devices = Vec::new();
    for application in content.applications().iter() {
        let Ok(process_id) = u32::try_from(application.process_id()) else {
            continue;
        };
        if process_id == std::process::id() || !seen.insert(process_id) {
            continue;
        }
        let name = application.application_name().to_string();
        if name.trim().is_empty() {
            continue;
        }
        let raw_bundle_id = application.bundle_identifier().to_string();
        devices.push(ApplicationDevice {
            id: format!("screencapturekit-app:{process_id}"),
            name: format!("{} · process {process_id}", name.trim()),
            backend: "screencapturekit-app-audio".to_owned(),
            process_id,
            bundle_id: (!raw_bundle_id.trim().is_empty()).then_some(raw_bundle_id),
        });
    }
    devices.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then(left.process_id.cmp(&right.process_id))
    });
    Ok(devices)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub(crate) fn application_devices() -> Result<Vec<ApplicationDevice>, String> {
    Err("per-application audio capture is not supported on this operating system".to_owned())
}

pub(crate) fn write_application_probe(
    device: &ApplicationDevice,
    metrics: &ProbeMetrics,
    channel_count: u16,
    sample_format: &'static str,
    duration: Duration,
) -> Result<(), String> {
    let channels = u64::from(channel_count.max(1));
    let frame_count = metrics.sample_count / channels;
    if frame_count == 0 {
        return Err(
            "the selected application-audio stream opened but returned no samples".to_owned(),
        );
    }
    let rms = (metrics.sum_squares / metrics.sample_count as f64).sqrt();
    let dbfs = if rms > 0.0 {
        20.0 * rms.log10()
    } else {
        -120.0
    };
    let report = ApplicationSignalProbe {
        id: device.id.clone(),
        name: device.name.clone(),
        backend: device.backend.clone(),
        source: "application",
        sample_format,
        sample_rate_hz: APPLICATION_SAMPLE_RATE_HZ,
        channel_count,
        sample_count: frame_count,
        frame_count,
        duration_ms: u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        rms,
        peak: metrics.peak,
        dbfs,
        signal_detected: rms >= 0.001,
        probe: "native-stream-opened-and-signal-measured",
    };
    serde_json::to_writer(io::stdout().lock(), &report)
        .map_err(|error| format!("could not write the application-audio probe result: {error}"))?;
    io::stdout()
        .lock()
        .write_all(b"\n")
        .map_err(|error| format!("could not finish the application-audio probe result: {error}"))
}

pub(crate) fn application_probe_unavailable_reason() -> String {
    #[cfg(target_os = "windows")]
    {
        format!(
            "No active WASAPI application-audio session was found. {}",
            platform_limitation()
        )
    }
    #[cfg(target_os = "macos")]
    {
        format!(
            "No shareable ScreenCaptureKit application was found. {}",
            platform_limitation()
        )
    }
    #[cfg(target_os = "linux")]
    {
        format!(
            "No active PipeWire application output stream was found. {}",
            platform_limitation()
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        platform_limitation().to_owned()
    }
}

pub(crate) fn announce_application_format() -> Result<(), String> {
    let format = ApplicationCaptureFormat {
        sample_format: APPLICATION_SAMPLE_FORMAT,
        sample_rate_hz: APPLICATION_SAMPLE_RATE_HZ,
        channel_count: APPLICATION_CHANNELS,
        bytes_per_sample: 4,
    };
    let encoded = serde_json::to_string(&format)
        .map_err(|error| format!("could not describe the application audio format: {error}"))?;
    eprintln!("tutorux-audio-helper: capture-format {encoded}");
    Ok(())
}

pub(crate) fn announce_application_summary(frame_count: u64, byte_count: u64) {
    let summary = ApplicationCaptureSummary {
        sample_format: APPLICATION_SAMPLE_FORMAT,
        sample_rate_hz: APPLICATION_SAMPLE_RATE_HZ,
        channel_count: APPLICATION_CHANNELS,
        frame_count,
        byte_count,
    };
    if let Ok(encoded) = serde_json::to_string(&summary) {
        eprintln!("tutorux-audio-helper: capture-summary {encoded}");
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn platform_limitation() -> &'static str {
    "Application capture requires Windows 10 build 20348 or newer and an active WASAPI audio session."
}

#[cfg(target_os = "macos")]
pub(crate) fn platform_limitation() -> &'static str {
    "Application capture requires macOS 14 or newer and Screen & System Audio Recording permission."
}

#[cfg(target_os = "linux")]
pub(crate) fn platform_limitation() -> &'static str {
    "Application capture requires an active PipeWire output stream; ALSA cannot identify application audio."
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub(crate) fn platform_limitation() -> &'static str {
    "Per-application audio capture is not supported on this operating system."
}
