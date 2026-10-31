use cpal::{
    traits::{DeviceTrait, StreamTrait},
    Data,
};
use serde::Serialize;
use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use super::device::{resolve_device, set_terminal_error, source_config, validate_config};
use super::encode::data_to_float_samples;

const SIGNAL_PROBE_DURATION: Duration = Duration::from_millis(1_800);
const SIGNAL_THRESHOLD_RMS: f64 = 0.001;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalProbe {
    id: String,
    name: String,
    backend: String,
    source: String,
    sample_format: String,
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
struct ProbeMetrics {
    sample_count: u64,
    sum_squares: f64,
    peak: f64,
}

pub(crate) fn probe(source: &str, device_id: &str) -> Result<(), String> {
    let descriptor = super::enumerate::enumerate()?
        .into_iter()
        .find(|candidate| candidate.source == source && candidate.id == device_id)
        .ok_or_else(|| format!("The selected {source} device is no longer available."))?;
    let device = resolve_device(source, device_id)?;
    let config = source_config(&device, source)?;
    validate_config(&config, source)?;
    let sample_format = format!("{:?}", config.sample_format());
    let sample_rate_hz = config.sample_rate();
    let channel_count = config.channels();
    let metrics = Arc::new(Mutex::new(ProbeMetrics::default()));
    let callback_metrics = Arc::clone(&metrics);
    let error_signal = Arc::new(Mutex::new(None::<String>));
    let callback_error = Arc::clone(&error_signal);
    let stream_error = Arc::clone(&error_signal);
    let stream = device
        .build_input_stream_raw(
            config.config(),
            config.sample_format(),
            move |data: &Data, _info| {
                let Some(samples) = data_to_float_samples(data) else {
                    set_terminal_error(
                        &callback_error,
                        "The device returned an unsupported sample format.",
                    );
                    return;
                };
                if let Ok(mut metrics) = callback_metrics.lock() {
                    for sample in samples {
                        let value = f64::from(sample).abs();
                        metrics.sample_count = metrics.sample_count.saturating_add(1);
                        metrics.sum_squares += value * value;
                        metrics.peak = metrics.peak.max(value);
                    }
                }
            },
            move |error| {
                set_terminal_error(
                    &stream_error,
                    &format!("The audio probe stream failed: {error}"),
                )
            },
            None,
        )
        .map_err(|error| format!("The selected {source} stream could not be opened: {error}"))?;
    stream
        .play()
        .map_err(|error| format!("The selected {source} stream could not be started: {error}"))?;
    let started = Instant::now();
    while started.elapsed() < SIGNAL_PROBE_DURATION {
        if let Some(error) = error_signal.lock().ok().and_then(|error| error.clone()) {
            return Err(error);
        }
        thread::sleep(Duration::from_millis(20));
    }
    drop(stream);
    if let Some(error) = error_signal.lock().ok().and_then(|error| error.clone()) {
        return Err(error);
    }
    let metrics = metrics
        .lock()
        .map_err(|_| "The audio signal probe could not read its measurements.".to_owned())?;
    if metrics.sample_count == 0 {
        return Err(format!(
            "The selected {source} stream opened but returned no samples."
        ));
    }
    let rms = (metrics.sum_squares / metrics.sample_count as f64).sqrt();
    let dbfs = if rms > 0.0 {
        20.0 * rms.log10()
    } else {
        -120.0
    };
    let report = SignalProbe {
        id: descriptor.id,
        name: descriptor.name,
        backend: descriptor.backend,
        source: descriptor.source,
        sample_format,
        sample_rate_hz,
        channel_count,
        sample_count: metrics.sample_count,
        frame_count: metrics.sample_count / u64::from(channel_count),
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        rms,
        peak: metrics.peak,
        dbfs,
        signal_detected: rms >= SIGNAL_THRESHOLD_RMS,
        probe: "native-stream-opened-and-signal-measured",
    };
    serde_json::to_writer(io::stdout().lock(), &report)
        .map_err(|error| format!("Could not write the signal-probe result: {error}"))?;
    io::stdout()
        .lock()
        .write_all(b"\n")
        .map_err(|error| format!("Could not finish the signal-probe result: {error}"))
}
