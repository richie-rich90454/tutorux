//! Short, live microphone signal checks used before a recording starts.

use cpal::{
    traits::{DeviceTrait, StreamTrait},
    Data, Sample, SampleFormat, SizedSample,
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, WebviewWindow};
use uuid::Uuid;

const LEVEL_EVENT: &str = "microphone-preflight-level";
const PROBE_DURATION: Duration = Duration::from_millis(1_800);
const LEVEL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_CALLBACK_SAMPLES: usize = 262_144;
const SIGNAL_RMS_THRESHOLD: f64 = 0.001;

#[derive(Default)]
struct LevelAccumulator {
    total_samples: u64,
    total_peak: f64,
    total_squares: f64,
    interval_samples: u64,
    interval_peak: f64,
    interval_squares: f64,
}

impl LevelAccumulator {
    fn take_interval(&mut self) -> (u64, f64, f64) {
        let values = (
            self.interval_samples,
            self.interval_peak,
            self.interval_squares,
        );
        self.interval_samples = 0;
        self.interval_peak = 0.0;
        self.interval_squares = 0.0;
        values
    }

    fn summary(&self) -> (u64, f64, f64) {
        let rms = if self.total_samples == 0 {
            0.0
        } else {
            (self.total_squares / self.total_samples as f64).sqrt()
        };
        (self.total_samples, self.total_peak, rms)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MicrophonePreflightLevel {
    probe_id: String,
    elapsed_ms: u64,
    frames_in_interval: u64,
    frames_measured: u64,
    peak_level: f64,
    rms_level: f64,
    peak_dbfs: f64,
    rms_dbfs: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophonePreflightSummary {
    device_id: String,
    measured_duration_ms: u64,
    frames_measured: u64,
    peak_level: f64,
    rms_level: f64,
    peak_dbfs: f64,
    rms_dbfs: f64,
    signal_detected: bool,
}

/// Measure the selected input for 1.8 seconds and stream 100 ms level updates to the UI.
#[tauri::command]
pub async fn preflight_microphone(
    window: WebviewWindow,
    device_id: String,
    probe_id: String,
) -> Result<MicrophonePreflightSummary, String> {
    if window.label() != "main" {
        return Err(
            "Microphone preflight is only available from the main application window.".into(),
        );
    }
    if Uuid::parse_str(&probe_id).is_err() {
        return Err("The microphone preflight identifier is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        preflight_microphone_inner(window, device_id, probe_id)
    })
    .await
    .map_err(|_| "The microphone input check stopped unexpectedly.".to_owned())?
}

fn preflight_microphone_inner(
    window: WebviewWindow,
    device_id: String,
    probe_id: String,
) -> Result<MicrophonePreflightSummary, String> {
    let device = crate::platform::synchronized_audio::resolve_device(&device_id)?;
    let config = device
        .default_input_config()
        .map_err(|error| format!("The selected microphone could not be opened: {error}"))?;
    let channels = usize::from(config.channels());
    if channels == 0 {
        return Err("The selected microphone reported an invalid channel count.".into());
    }

    let levels = Arc::new(Mutex::new(LevelAccumulator::default()));
    let callback_levels = Arc::clone(&levels);
    let callback_error = Arc::new(Mutex::new(None::<String>));
    let error_slot = Arc::clone(&callback_error);
    let sample_format = config.sample_format();
    let stream = device
        .build_input_stream_raw(
            &config.config(),
            sample_format,
            move |data: &Data, _info| {
                let Ok(mut levels) = callback_levels.lock() else {
                    return;
                };
                if !accumulate_data(&mut levels, data) {
                    if let Ok(mut error) = error_slot.lock() {
                        error.get_or_insert_with(|| {
                            "The microphone returned a sample format or callback that cannot be measured.".into()
                        });
                    }
                }
            },
            move |error| {
                if let Ok(mut slot) = callback_error.lock() {
                    slot.get_or_insert_with(|| format!("Microphone capture failed: {error}"));
                }
            },
            None,
        )
        .map_err(|error| format!("The selected microphone could not be opened: {error}"))?;
    stream
        .play()
        .map_err(|error| format!("The selected microphone could not be started: {error}"))?;

    let started = Instant::now();
    while started.elapsed() < PROBE_DURATION {
        if let Some(error) = callback_error
            .lock()
            .map_err(|_| "Microphone preflight state is unavailable.".to_owned())?
            .clone()
        {
            return Err(error);
        }
        let elapsed = started.elapsed();
        let remaining = PROBE_DURATION.saturating_sub(elapsed);
        thread::sleep(remaining.min(LEVEL_INTERVAL));
        let elapsed = started.elapsed().min(PROBE_DURATION);
        let (sample_count, peak, squares) = levels
            .lock()
            .map_err(|_| "Microphone preflight state is unavailable.".to_owned())?
            .take_interval();
        let rms = if sample_count == 0 {
            0.0
        } else {
            (squares / sample_count as f64).sqrt()
        };
        let frames_measured = levels
            .lock()
            .map_err(|_| "Microphone preflight state is unavailable.".to_owned())?
            .total_samples
            / channels as u64;
        window
            .emit(
                LEVEL_EVENT,
                MicrophonePreflightLevel {
                    probe_id: probe_id.clone(),
                    elapsed_ms: elapsed.as_millis() as u64,
                    frames_in_interval: sample_count as u64 / channels as u64,
                    frames_measured,
                    peak_level: peak,
                    rms_level: rms,
                    peak_dbfs: level_to_dbfs(peak),
                    rms_dbfs: level_to_dbfs(rms),
                },
            )
            .map_err(|error| {
                format!("Microphone level updates could not reach the application: {error}")
            })?;
    }

    drop(stream);
    if let Some(error) = callback_error
        .lock()
        .map_err(|_| "Microphone preflight state is unavailable.".to_owned())?
        .clone()
    {
        return Err(error);
    }
    let (sample_count, peak, rms) = levels
        .lock()
        .map_err(|_| "Microphone preflight state is unavailable.".to_owned())?
        .summary();
    if sample_count == 0 {
        return Err(
            "The selected microphone opened but produced no samples during the check.".into(),
        );
    }

    Ok(MicrophonePreflightSummary {
        device_id,
        measured_duration_ms: started.elapsed().min(PROBE_DURATION).as_millis() as u64,
        frames_measured: sample_count / channels as u64,
        peak_level: peak,
        rms_level: rms,
        peak_dbfs: level_to_dbfs(peak),
        rms_dbfs: level_to_dbfs(rms),
        signal_detected: rms >= SIGNAL_RMS_THRESHOLD,
    })
}

fn level_to_dbfs(level: f64) -> f64 {
    if level > 0.0 {
        20.0 * level.log10()
    } else {
        -120.0
    }
}

fn accumulate_data(levels: &mut LevelAccumulator, data: &Data) -> bool {
    match data.sample_format() {
        SampleFormat::F32 => data
            .as_slice::<f32>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::F64 => data
            .as_slice::<f64>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::I8 => data
            .as_slice::<i8>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::I16 => data
            .as_slice::<i16>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::I24 => data
            .as_slice::<cpal::I24>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::I32 => data
            .as_slice::<i32>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::I64 => data
            .as_slice::<i64>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::U8 => data
            .as_slice::<u8>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::U16 => data
            .as_slice::<u16>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::U24 => data
            .as_slice::<cpal::U24>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::U32 => data
            .as_slice::<u32>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::U64 => data
            .as_slice::<u64>()
            .is_some_and(|samples| levels.add(samples)),
        SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32 => false,
        _ => false,
    }
}

impl LevelAccumulator {
    fn add<T: Sample + SizedSample>(&mut self, samples: &[T]) -> bool {
        if samples.len() > MAX_CALLBACK_SAMPLES {
            return false;
        }
        for sample in samples {
            let sample = sample.to_sample::<f64>();
            let sample = if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            let magnitude = sample.abs();
            self.total_peak = self.total_peak.max(magnitude);
            self.interval_peak = self.interval_peak.max(magnitude);
            self.total_squares += sample * sample;
            self.interval_squares += sample * sample;
            self.total_samples = self.total_samples.saturating_add(1);
            self.interval_samples = self.interval_samples.saturating_add(1);
        }
        true
    }
}
