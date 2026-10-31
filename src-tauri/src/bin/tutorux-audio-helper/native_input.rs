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

const MAX_QUEUED_CHUNKS: usize = 8;
const MAX_CALLBACK_FRAMES: usize = 128 * 1024;
const MIN_SAMPLE_RATE_HZ: u32 = 8_000;
const MAX_SAMPLE_RATE_HZ: u32 = 384_000;
const MAX_CHANNELS: u16 = 8;
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
    frame_count: u64,
    duration_ms: u64,
    rms: f64,
    peak: f64,
    dbfs: f64,
    signal_detected: bool,
    probe: &'static str,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureFormat {
    sample_format: &'static str,
    sample_rate_hz: u32,
    channel_count: u16,
    bytes_per_sample: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSummary {
    sample_format: &'static str,
    sample_rate_hz: u32,
    channel_count: u16,
    frame_count: u64,
    byte_count: u64,
}

#[derive(Default)]
struct ProbeMetrics {
    sample_count: u64,
    sum_squares: f64,
    peak: f64,
}

pub fn enumerate() -> Result<Vec<NativeCaptureDevice>, String> {
    let mut microphones = Vec::new();
    let mut system_audio = Vec::new();
    for host in hosts() {
        let backend = host.id().to_string();
        let default_microphone_id = host
            .default_input_device()
            .and_then(|device| device.id().ok());
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let default_output_id = host
            .default_output_device()
            .and_then(|device| device.id().ok());

        if let Ok(devices) = host.input_devices() {
            for device in devices {
                let Ok(id) = device.id() else { continue };
                let Ok(description) = device.description() else {
                    continue;
                };
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
                let Ok(description) = device.description() else {
                    continue;
                };
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
    let format = capture_format(&config).ok_or_else(|| {
        format!("The selected {source} device uses an unsupported sample format.")
    })?;
    announce_format(&format)?;
    let frame_bytes = usize::from(format.bytes_per_sample) * usize::from(format.channel_count);
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(MAX_QUEUED_CHUNKS);
    let terminal_error = Arc::new(Mutex::new(None::<String>));
    let callback_error = Arc::clone(&terminal_error);
    let stream = build_capture_stream(&device, config, format, sender, callback_error)?;
    let stop = Arc::new(AtomicBool::new(false));
    watch_for_stop(Arc::clone(&stop))?;
    stream
        .play()
        .map_err(|error| format!("The selected {source} stream could not be started: {error}"))?;

    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1024, stdout.lock());
    let mut frame_count = 0_u64;
    let mut byte_count = 0_u64;
    while !stop.load(Ordering::Acquire) {
        if let Some(error) = terminal_error.lock().ok().and_then(|error| error.clone()) {
            return Err(error);
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(pcm) => {
                write_pcm(&mut output, &pcm)?;
                frame_count = frame_count
                    .checked_add((pcm.len() / frame_bytes) as u64)
                    .ok_or_else(|| {
                        "The captured audio frame count exceeded its limit.".to_owned()
                    })?;
                byte_count = byte_count.checked_add(pcm.len() as u64).ok_or_else(|| {
                    "The captured audio byte count exceeded its limit.".to_owned()
                })?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "The selected {source} stream stopped unexpectedly."
                ));
            }
        }
    }
    drop(stream);
    while let Ok(pcm) = receiver.try_recv() {
        write_pcm(&mut output, &pcm)?;
        frame_count = frame_count
            .checked_add((pcm.len() / frame_bytes) as u64)
            .ok_or_else(|| "The captured audio frame count exceeded its limit.".to_owned())?;
        byte_count = byte_count
            .checked_add(pcm.len() as u64)
            .ok_or_else(|| "The captured audio byte count exceeded its limit.".to_owned())?;
    }
    output
        .flush()
        .map_err(|error| format!("Could not flush captured audio: {error}"))?;
    if frame_count == 0 {
        return Err(format!(
            "The selected {source} source returned no audio samples."
        ));
    }
    announce_summary(&CaptureSummary {
        sample_format: format.sample_format,
        sample_rate_hz: format.sample_rate_hz,
        channel_count: format.channel_count,
        frame_count,
        byte_count,
    });
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

fn build_capture_stream(
    device: &cpal::Device,
    config: cpal::SupportedStreamConfig,
    format: CaptureFormat,
    sender: SyncSender<Vec<u8>>,
    callback_error: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String> {
    let frame_bytes = usize::from(format.bytes_per_sample) * usize::from(format.channel_count);
    let error_signal = Arc::clone(&callback_error);
    device
        .build_input_stream_raw(
            config.config(),
            config.sample_format(),
            move |data: &Data, _info| {
                let pcm = match encode_capture(data, &format) {
                    Ok(pcm) => pcm,
                    Err(error) => {
                        set_terminal_error(&callback_error, &error);
                        return;
                    }
                };
                if pcm.len() % frame_bytes != 0 {
                    set_terminal_error(&callback_error, "The audio device returned an incomplete PCM frame.");
                    return;
                }
                if pcm.len() > MAX_CALLBACK_FRAMES.saturating_mul(frame_bytes) {
                    set_terminal_error(&callback_error, "The audio device returned a callback larger than the bounded capture queue supports.");
                    return;
                }
                if pcm.is_empty() {
                    return;
                }
                match sender.try_send(pcm) {
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

fn encode_capture(data: &Data, format: &CaptureFormat) -> Result<Vec<u8>, String> {
    let pcm = match data.sample_format() {
        SampleFormat::F32 => data
            .as_slice::<f32>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::F64 => data
            .as_slice::<f64>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::I8 => data
            .as_slice::<i8>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::I16 => data
            .as_slice::<i16>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::I24 => data
            .as_slice::<cpal::I24>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::I32 => data
            .as_slice::<i32>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::I64 => data
            .as_slice::<i64>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::U8 => data
            .as_slice::<u8>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::U16 => data
            .as_slice::<u16>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::U24 => data
            .as_slice::<cpal::U24>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::U32 => data
            .as_slice::<u32>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        SampleFormat::U64 => data
            .as_slice::<u64>()
            .map(|samples| encode_samples(samples, format.sample_format)),
        _ => None,
    };
    pcm.ok_or_else(|| "The audio device returned an unsupported sample format.".to_owned())
}

fn encode_samples<T>(samples: &[T], sample_format: &str) -> Vec<u8>
where
    T: Sample + SizedSample,
    f32: cpal::FromSample<T>,
    i16: cpal::FromSample<T>,
    i32: cpal::FromSample<T>,
    u8: cpal::FromSample<T>,
{
    let mut output = Vec::with_capacity(samples.len() * 4);
    match sample_format {
        "pcm_f32le" => {
            for sample in samples {
                output.extend_from_slice(&sample.to_sample::<f32>().to_le_bytes());
            }
        }
        "pcm_s16le" => {
            for sample in samples {
                output.extend_from_slice(&sample.to_sample::<i16>().to_le_bytes());
            }
        }
        "pcm_s24le" => {
            for sample in samples {
                let bytes = sample.to_sample::<i32>().to_le_bytes();
                output.extend_from_slice(&bytes[1..]);
            }
        }
        "pcm_s32le" => {
            for sample in samples {
                output.extend_from_slice(&sample.to_sample::<i32>().to_le_bytes());
            }
        }
        "pcm_u8" => {
            for sample in samples {
                output.push(sample.to_sample::<u8>());
            }
        }
        _ => {}
    }
    output
}

fn data_to_float_samples(data: &Data) -> Option<Vec<f32>> {
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
    Some(interleaved)
}

fn convert_samples<T: Sample + SizedSample>(samples: &[T]) -> Vec<f32>
where
    f32: cpal::FromSample<T>,
{
    samples
        .iter()
        .map(|sample| sample.to_sample::<f32>())
        .collect()
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

fn source_config(
    device: &cpal::Device,
    source: &str,
) -> Result<cpal::SupportedStreamConfig, String> {
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
    if !(MIN_SAMPLE_RATE_HZ..=MAX_SAMPLE_RATE_HZ).contains(&config.sample_rate()) {
        return Err(format!(
            "The selected {source} device uses an unsupported sample rate."
        ));
    }
    if config.channels() == 0 || config.channels() > MAX_CHANNELS {
        return Err(format!(
            "The selected {source} device uses an unsupported channel count."
        ));
    }
    if output_sample_format(config.sample_format()).is_none() {
        return Err(format!(
            "The selected {source} device uses an unsupported sample format."
        ));
    }
    Ok(())
}

fn capture_format(config: &cpal::SupportedStreamConfig) -> Option<CaptureFormat> {
    let (sample_format, bytes_per_sample) = output_sample_format(config.sample_format())?;
    Some(CaptureFormat {
        sample_format,
        sample_rate_hz: config.sample_rate(),
        channel_count: config.channels(),
        bytes_per_sample,
    })
}

fn output_sample_format(format: SampleFormat) -> Option<(&'static str, u16)> {
    match format {
        SampleFormat::F32 | SampleFormat::F64 => Some(("pcm_f32le", 4)),
        SampleFormat::I16 | SampleFormat::U16 => Some(("pcm_s16le", 2)),
        SampleFormat::I24 | SampleFormat::U24 => Some(("pcm_s24le", 3)),
        SampleFormat::I32 | SampleFormat::U32 | SampleFormat::I64 | SampleFormat::U64 => {
            Some(("pcm_s32le", 4))
        }
        SampleFormat::I8 | SampleFormat::U8 => Some(("pcm_u8", 1)),
        _ => None,
    }
}

fn announce_format(format: &CaptureFormat) -> Result<(), String> {
    let encoded = serde_json::to_string(format)
        .map_err(|error| format!("Could not describe the capture format: {error}"))?;
    eprintln!("tutorux-audio-helper: capture-format {encoded}");
    Ok(())
}

fn announce_summary(summary: &CaptureSummary) {
    if let Ok(encoded) = serde_json::to_string(summary) {
        eprintln!("tutorux-audio-helper: capture-summary {encoded}");
    }
}

fn set_terminal_error(signal: &Mutex<Option<String>>, message: &str) {
    if let Ok(mut error) = signal.lock() {
        if error.is_none() {
            *error = Some(message.to_owned());
        }
    }
}

fn write_pcm(output: &mut impl Write, pcm: &[u8]) -> Result<(), String> {
    output
        .write_all(pcm)
        .and_then(|()| output.flush())
        .map_err(|error| format!("Could not deliver captured audio to the CLI: {error}"))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_formats_keep_their_sample_width() {
        assert_eq!(
            output_sample_format(SampleFormat::F32),
            Some(("pcm_f32le", 4))
        );
        assert_eq!(
            output_sample_format(SampleFormat::F64),
            Some(("pcm_f32le", 4))
        );
        assert_eq!(
            output_sample_format(SampleFormat::I16),
            Some(("pcm_s16le", 2))
        );
        assert_eq!(
            output_sample_format(SampleFormat::U16),
            Some(("pcm_s16le", 2))
        );
        assert_eq!(
            output_sample_format(SampleFormat::I24),
            Some(("pcm_s24le", 3))
        );
        assert_eq!(
            output_sample_format(SampleFormat::I32),
            Some(("pcm_s32le", 4))
        );
        assert_eq!(output_sample_format(SampleFormat::U8), Some(("pcm_u8", 1)));
        assert_eq!(output_sample_format(SampleFormat::DsdU8), None);
    }

    #[test]
    fn interleaved_float_samples_are_not_downmixed() {
        let bytes = encode_samples(&[0.5_f32, -0.5_f32], "pcm_f32le");
        assert_eq!(
            bytes,
            [0.5_f32.to_le_bytes(), (-0.5_f32).to_le_bytes()].concat()
        );
    }

    #[test]
    fn sixteen_bit_samples_keep_channel_order() {
        let bytes = encode_samples(&[i16::MAX, i16::MIN], "pcm_s16le");
        assert_eq!(
            bytes,
            [i16::MAX.to_le_bytes(), i16::MIN.to_le_bytes()].concat()
        );
    }
}
