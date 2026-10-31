use serde_json::{json, Value};

use crate::platform::synchronized_audio::headless::{probe_input, HeadlessDevice, HeadlessProbe};

pub(super) fn probe_selected(source: &str, devices: &[HeadlessDevice], requested: Option<&str>) -> Value {
    let candidates: Vec<&HeadlessDevice> = devices
        .iter()
        .filter(|device| device.source == source)
        .collect();
    let selected = match requested {
        Some(value) if value != "default" => candidates
            .iter()
            .find(|device| device.id == value || device.name == value)
            .copied(),
        _ => candidates
            .iter()
            .find(|device| device.is_default)
            .copied()
            .or_else(|| (candidates.len() == 1).then(|| candidates[0])),
    };
    let Some(selected) = selected else {
        let limitation = if let Some(value) = requested.filter(|value| *value != "default") {
            format!("The selected {source} device '{value}' is not listed by the native audio backend.")
        } else if source == "system-audio" {
            system_limitation().to_owned()
        } else {
            microphone_limitation().to_owned()
        };
        return unavailable_probe(source, &limitation);
    };
    match probe_input(source, &selected.id) {
        Ok(probe) => probe_report(probe, source),
        Err(error) => json!({
            "available": false,
            "source": source,
            "device_id": selected.id,
            "device_name": selected.name,
            "backend": selected.backend,
            "probe": "native-stream-open-failed",
            "limitation": error,
        }),
    }
}

pub(super) fn probe_report(probe: HeadlessProbe, source: &str) -> Value {
    let mut report = json!({
        "available": true,
        "source": source,
        "device_id": probe.id,
        "device_name": probe.name,
        "backend": probe.backend,
        "sample_format": probe.sample_format,
        "sample_rate_hz": probe.sample_rate_hz,
        "channel_count": probe.channel_count,
        "sample_count": probe.sample_count,
        "duration_ms": probe.duration_ms,
        "rms": probe.rms,
        "peak": probe.peak,
        "dbfs": probe.dbfs,
        "signal_detected": probe.signal_detected,
        "probe": "native-stream-opened-and-signal-measured",
    });
    if !probe.signal_detected {
        report["limitation"] = json!(
            "The stream opened, but no signal above the detection threshold was measured."
        );
    }
    report
}

pub(super) fn unavailable_probe(source: &str, limitation: &str) -> Value {
    json!({
        "available": false,
        "source": source,
        "probe": "stream-not-opened",
        "limitation": limitation,
    })
}

pub(super) fn microphone_limitation() -> &'static str {
    "No microphone endpoint was available from the native audio backend. Check device support and operating-system microphone permissions."
}

pub(super) fn system_limitation() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "No native WASAPI output loopback was available."
    }
    #[cfg(target_os = "macos")]
    {
        "No CoreAudio output-loopback device was available."
    }
    #[cfg(target_os = "linux")]
    {
        "No PipeWire monitor/loopback input was available."
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "Native system-audio capture is not supported on this operating system."
    }
}

pub(super) fn application_limitation() -> String {
    #[cfg(target_os = "windows")]
    {
        "No active WASAPI application-audio sessions were found. Start playback in the target application and retry."
            .to_owned()
    }
    #[cfg(target_os = "macos")]
    {
        "No shareable applications were found. Check Screen & System Audio Recording permission and retry."
            .to_owned()
    }
    #[cfg(target_os = "linux")]
    {
        "No active PipeWire application-audio streams were found. ALSA cannot identify per-application audio."
            .to_owned()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "Per-application audio capture is not supported on this operating system.".to_owned()
    }
}

