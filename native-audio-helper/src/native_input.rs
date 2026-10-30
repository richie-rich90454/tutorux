//! Native microphone and system-output capture for the standalone CLI helper.

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Data, Sample, SampleFormat, SizedSample,
};
use serde::Serialize;
use std::{
    io::{self, BufWriter, Write},
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const OUTPUT_SAMPLE_RATE_HZ: u32 = 16_000;
const MAX_QUEUED_CHUNKS: usize = 8;
const MAX_CALLBACK_FRAMES: usize = 128 * 1024;
const SIGNAL_PROBE_DURATION: Duration = Duration::from_millis(1_800);
const SIGNAL_THRESHOLD_RMS: f64 = 0.001;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCaptureDevice {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub source: String,
    pub is_default: bool,
    pub sample_format: String,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
}

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

struct Resampler {
    source_step: f64,
    next_output_position: f64,
    input_index: u64,
    previous: Option<f32>,
}

impl Resampler {
    fn new(source_rate_hz: u32) -> Result<Self, String> {
        if source_rate_hz == 0 {
            return Err("The selected audio device reported an invalid sample rate.".to_owned());
        }
        Ok(Self {
            source_step: f64::from(source_rate_hz) / f64::from(OUTPUT_SAMPLE_RATE_HZ),
            next_output_position: 0.0,
            input_index: 0,
            previous: None,
        })
    }

    fn process(&mut self, samples: &[f32]) -> Result<Vec<i16>, String> {
        let estimated_len = ((samples.len() as f64 / self.source_step).ceil() as usize)
            .saturating_add(2)
            .min(MAX_CALLBACK_FRAMES);
        let mut output = Vec::with_capacity(estimated_len);
        for &sample in samples {
            if !sample.is_finite() {
                return Err("The selected audio device returned a non-finite sample.".to_owned());
            }
            let current_index = self.input_index;
            if let Some(previous) = self.previous {
                while self.next_output_position <= current_index as f64 {
                    let fraction = (self.next_output_position - current_index.saturating_sub(1) as f64)
                        .clamp(0.0, 1.0) as f32;
                    output.push(float_to_i16(previous + (sample - previous) * fraction));
                    self.next_output_position += self.source_step;
                }
            } else {
                output.push(float_to_i16(sample));
                self.next_output_position += self.source_step;
            }
            self.previous = Some(sample);
            self.input_index = self
                .input_index
                .checked_add(1)
                .ok_or_else(|| "The audio input timeline exceeded its supported limit.".to_owned())?;
        }
        if output.len() > MAX_CALLBACK_FRAMES {
            return Err("The audio callback exceeded the bounded capture queue.".to_owned());
        }
        Ok(output)
    }
}

pub fn enumerate() -> Result<Vec<NativeCaptureDevice>, String> {
    let mut microphones = Vec::new();
    let mut system_audio = Vec::new();
    for host in hosts() {
        let backend = host.id().to_string();
        let default_microphone_id = host.default_input_device().and_then(|device| device.id().ok());
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let default_output_id = host.default_output_device().and_then(|device| device.id().ok());

        if let Ok(devices) = host.input_devices() {
            for device in devices {
                let Ok(id) = device.id() else { continue };
                let Ok(description) = device.description() else { continue };
                let name = description.name().trim();
                if name.is_empty() {
                    continue;
                }
                #[cfg(target_os = "linux")]
                if is_linux_monitor_name(name) {
                    if let Ok(config) = device.default_input_config() {
                        system_audio.push(NativeCaptureDevice {
                            id: id.to_string(),
                            name: format!("System audio · {name}"),
                            backend: backend.clone(),
                            source: "system-audio".to_owned(),
                            is_default: false,
                            sample_format: format!("{:?}", config.sample_format()),
                            sample_rate_hz: config.sample_rate(),
                            channel_count: config.channels(),
                        });
                    }
                    continue;
                }
                if let Ok(config) = device.default_input_config() {
                    microphones.push(NativeCaptureDevice {
                        id: id.to_string(),
                        name: name.to_owned(),
                        backend: backend.clone(),
                        source: "microphone".to_owned(),
                        is_default: Some(&id) == default_microphone_id.as_ref(),
                        sample_format: format!("{:?}", config.sample_format()),
                        sample_rate_hz: config.sample_rate(),
                        channel_count: config.channels(),
                    });
                }
            }
        }

        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Ok(devices) = host.output_devices() {
            for device in devices {
                if !device.supports_output() {
                    continue;
                }
                #[cfg(target_os = "macos")]
                if device.supports_input() {
                    continue;
                }
                let Ok(id) = device.id() else { continue };
                let Ok(description) = device.description() else { continue };
                let name = description.name().trim();
                let Ok(config) = device.default_output_config() else {
                    continue;
                };
                if name.is_empty() {
                    continue;
                }
                system_audio.push(NativeCaptureDevice {
                    id: id.to_string(),
                    name: format!("System audio · {name}"),
                    backend: backend.clone(),
                    source: "system-audio".to_owned(),
                    is_default: Some(&id) == default_output_id.as_ref(),
                    sample_format: format!("{:?}", config.sample_format()),
                    sample_rate_hz: config.sample_rate(),
                    channel_count: config.channels(),
                });
            }
        }
    }
    microphones.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    system_audio.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    microphones.dedup_by(|left, right| left.backend == right.backend && left.id == right.id);
    system_audio.dedup_by(|left, right| left.backend == right.backend && left.id == right.id);
    microphones.extend(system_audio);
    Ok(microphones)
}

pub fn capture(source: &str, device_id: &str) -> Result<(), String> {
    let device = resolve_device(source, device_id)?;
    let config = source_config(&device, source)?;
    validate_config(&config, source)?;
    let channels = usize::from(config.channels());
    let sample_rate_hz = config.sample_rate();
    let (sender, receiver) = mpsc::sync_channel::<Vec<i16>>(MAX_QUEUED_CHUNKS);
    let terminal_error = Arc::new(Mutex::new(None::<String>));
    let callback_error = Arc::clone(&terminal_error);
    let stream = build_capture_stream(&device, config, channels, sample_rate_hz, sender, callback_error)?;
    let stop = Arc::new(AtomicBool::new(false));
    watch_for_stop(Arc::clone(&stop))?;
    stream
        .play()
        .map_err(|error| format!("The selected {source} stream could not be started: {error}"))?;

    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1024, stdout.lock());
    let mut samples_written = 0_u64;
    while !stop.load(Ordering::Acquire) {
        if let Some(error) = terminal_error.lock().ok().and_then(|error| error.clone()) {
            return Err(error);
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(samples) => {
                write_s16le(&mut output, &samples)?;
                samples_written = samples_written
                    .checked_add(samples.len() as u64)
                    .ok_or_else(|| "The captured audio sample count exceeded its limit.".to_owned())?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!("The selected {source} stream stopped unexpectedly."));
            }
        }
    }
    drop(stream);
    while let Ok(samples) = receiver.try_recv() {
        write_s16le(&mut output, &samples)?;
        samples_written = samples_written
            .checked_add(samples.len() as u64)
            .ok_or_else(|| "The captured audio sample count exceeded its limit.".to_owned())?;
    }
    output
        .flush()
        .map_err(|error| format!("Could not flush captured audio: {error}"))?;
    if samples_written == 0 {
        return Err(format!("The selected {source} source returned no audio samples."));
    }
    Ok(())
}

pub fn probe(source: &str, device_id: &str) -> Result<(), String> {
    let descriptor = enumerate()?
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
                let Some(samples) = data_to_mono_float(data, usize::from(channel_count)) else {
                    set_terminal_error(&callback_error, "The device returned an unsupported sample format.");
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
            move |error| set_terminal_error(&stream_error, &format!("The audio probe stream failed: {error}")),
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
        return Err(format!("The selected {source} stream opened but returned no samples."));
    }
    let rms = (metrics.sum_squares / metrics.sample_count as f64).sqrt();
    let dbfs = if rms > 0.0 { 20.0 * rms.log10() } else { -120.0 };
    let report = SignalProbe {
        id: descriptor.id,
        name: descriptor.name,
        backend: descriptor.backend,
        source: descriptor.source,
        sample_format,
        sample_rate_hz,
        channel_count,
        sample_count: metrics.sample_count,
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

fn build_capture_stream(
    device: &cpal::Device,
    config: cpal::SupportedStreamConfig,
    channels: usize,
    sample_rate_hz: u32,
    sender: SyncSender<Vec<i16>>,
    callback_error: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String> {
    let mut resampler = Resampler::new(sample_rate_hz)?;
    let error_signal = Arc::clone(&callback_error);
    device
        .build_input_stream_raw(
            config.config(),
            config.sample_format(),
            move |data: &Data, _info| {
                let Some(samples) = data_to_mono_float(data, channels) else {
                    set_terminal_error(&callback_error, "The audio device returned an unsupported sample format.");
                    return;
                };
                if samples.len() > MAX_CALLBACK_FRAMES {
                    set_terminal_error(&callback_error, "The audio device returned a callback larger than the bounded capture queue supports.");
                    return;
                }
                let samples = match resampler.process(&samples) {
                    Ok(samples) => samples,
                    Err(error) => {
                        set_terminal_error(&callback_error, &error);
                        return;
                    }
                };
                if samples.is_empty() {
                    return;
                }
                match sender.try_send(samples) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => set_terminal_error(&callback_error, "Audio delivery fell behind the bounded capture queue."),
                    Err(TrySendError::Disconnected(_)) => set_terminal_error(&callback_error, "The CLI stopped reading captured audio."),
                }
            },
            move |error| set_terminal_error(&error_signal, &format!("The audio capture stream failed: {error}")),
            None,
        )
        .map_err(|error| format!("The selected audio stream could not be opened: {error}"))
}

fn data_to_mono_float(data: &Data, channels: usize) -> Option<Vec<f32>> {
    if channels == 0 {
        return None;
    }
    let interleaved = match data.sample_format() {
        SampleFormat::F32 => data.as_slice::<f32>().map(convert_samples),
        SampleFormat::F64 => data.as_slice::<f64>().map(convert_samples),
        SampleFormat::I8 => data.as_slice::<i8>().map(convert_samples),
        SampleFormat::I16 => data.as_slice::<i16>().map(convert_samples),
        SampleFormat::I24 => data.as_slice::<cpal::I24>().map(convert_samples),
        SampleFormat::I32 => data.as_slice::<i32>().map(convert_samples),
        SampleFormat::I64 => data.as_slice::<i64>().map(convert_samples),
        SampleFormat::U8 => data.as_slice::<u8>().map(convert_samples),
        SampleFormat::U16 => data.as_slice::<u16>().map(convert_samples),
        SampleFormat::U24 => data.as_slice::<cpal::U24>().map(convert_samples),
        SampleFormat::U32 => data.as_slice::<u32>().map(convert_samples),
        SampleFormat::U64 => data.as_slice::<u64>().map(convert_samples),
        SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32 => None,
        _ => None,
    }?;
    if interleaved.len() % channels != 0 {
        return None;
    }
    Some(
        interleaved
            .chunks_exact(channels)
            .map(|frame| frame.iter().copied().sum::<f32>() / channels as f32)
            .collect(),
    )
}

fn convert_samples<T: Sample + SizedSample>(samples: &[T]) -> Vec<f32>
where
    f32: cpal::FromSample<T>,
{
    samples.iter().map(|sample| sample.to_sample::<f32>()).collect()
}

fn resolve_device(source: &str, device_id: &str) -> Result<cpal::Device, String> {
    let descriptor = enumerate()?
        .into_iter()
        .find(|candidate| candidate.source == source && candidate.id == device_id)
        .ok_or_else(|| format!("The selected {source} device is no longer available."))?;
    let id = cpal::DeviceId::from_str(&descriptor.id)
        .map_err(|_| "The selected audio device identifier is invalid.".to_owned())?;
    #[cfg(target_os = "linux")]
    let host = cpal::host_from_id(id.host())
        .map_err(|error| format!("The selected audio backend is no longer available: {error}"))?;
    #[cfg(not(target_os = "linux"))]
    let host = cpal::default_host();
    host.device_by_id(&id)
        .ok_or_else(|| format!("The selected {source} device is no longer available."))
}

fn source_config(device: &cpal::Device, source: &str) -> Result<cpal::SupportedStreamConfig, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    if source == "system-audio" {
        return device
            .default_output_config()
            .map_err(|error| format!("The selected system-audio format is unavailable: {error}"));
    }
    device
        .default_input_config()
        .map_err(|error| format!("The selected {source} format is unavailable: {error}"))
}

fn validate_config(config: &cpal::SupportedStreamConfig, source: &str) -> Result<(), String> {
    if !(8_000..=192_000).contains(&config.sample_rate()) {
        return Err(format!("The selected {source} device uses an unsupported sample rate."));
    }
    if config.channels() == 0 || config.channels() > 32 {
        return Err(format!("The selected {source} device uses an unsupported channel count."));
    }
    Ok(())
}

fn set_terminal_error(signal: &Mutex<Option<String>>, message: &str) {
    if let Ok(mut error) = signal.lock() {
        if error.is_none() {
            *error = Some(message.to_owned());
        }
    }
}

fn write_s16le(output: &mut impl Write, samples: &[i16]) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    output
        .write_all(&bytes)
        .and_then(|()| output.flush())
        .map_err(|error| format!("Could not deliver captured audio to the CLI: {error}"))
}

fn float_to_i16(value: f32) -> i16 {
    let clipped = if value.is_finite() { value.clamp(-1.0, 1.0) } else { 0.0 };
    if clipped <= -1.0 {
        i16::MIN
    } else {
        (clipped * f32::from(i16::MAX)).round() as i16
    }
}

fn watch_for_stop(stop: Arc<AtomicBool>) -> Result<(), String> {
    thread::Builder::new()
        .name("tutorux-audio-helper-control".to_owned())
        .spawn(move || {
            let mut command = String::new();
            let _ = io::stdin().read_line(&mut command);
            stop.store(true, Ordering::Release);
        })
        .map(|_| ())
        .map_err(|error| format!("Could not start the capture control channel: {error}"))
}

fn hosts() -> Vec<cpal::Host> {
    #[cfg(target_os = "linux")]
    {
        cpal::available_hosts()
            .into_iter()
            .filter_map(|id| cpal::host_from_id(id).ok())
            .collect()
    }
    #[cfg(not(target_os = "linux"))]
    {
        vec![cpal::default_host()]
    }
}

#[cfg(target_os = "linux")]
fn is_linux_monitor_name(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.contains("monitor") || value.contains("loopback") || value.ends_with(".mon")
}
