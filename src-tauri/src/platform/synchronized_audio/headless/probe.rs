use super::super::application_audio::ApplicationAudioCapture;
use super::super::capture::{build_capture_stream, sample_format_name, validate_config};
use super::super::devices::{
    enumerate_application_audio_devices, resolve_application_audio_target, resolve_device,
    system_audio_config,
};
use super::super::model::{PcmChunk, TrackKind, TrackSignal, APPLICATION_AUDIO_CHANNELS};
use super::device::{enumerate_devices, HeadlessDevice};
use cpal::traits::{DeviceTrait, StreamTrait};
use std::sync::{
    mpsc::{self, Receiver, TryRecvError},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

const PROBE_DURATION: Duration = Duration::from_millis(1_800);
const SIGNAL_THRESHOLD_RMS: f64 = 0.001;

#[derive(Debug, Clone)]
pub struct HeadlessProbe {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub source: String,
    pub sample_format: String,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub sample_count: u64,
    pub duration_ms: u64,
    pub rms: f64,
    pub peak: f64,
    pub dbfs: f64,
    pub signal_detected: bool,
}

pub fn probe_input(source: &str, device_id: &str) -> Result<HeadlessProbe, String> {
    let devices = enumerate_devices()?;
    let descriptor = devices
        .devices
        .into_iter()
        .find(|device| device.source == source && device.id == device_id)
        .ok_or_else(|| format!("The selected {source} device is no longer available."))?;
    let device = resolve_device(device_id)?;
    let config = if source == "system-audio" {
        system_audio_config(&device)?
    } else {
        device
            .default_input_config()
            .map_err(|error| format!("The selected microphone stream could not be opened: {error}"))?
    };
    validate_config(&config, source)?;
    let rate = config.sample_rate();
    let channels = config.channels();
    let format = sample_format_name(config.sample_format());
    let signal = Arc::new(TrackSignal::new());
    let (sender, receiver) = mpsc::sync_channel::<PcmChunk>(64);
    let kind = if source == "system-audio" {
        TrackKind::SystemAudio
    } else {
        TrackKind::Microphone
    };
    let stream = build_capture_stream(&device, config, kind, sender, Arc::clone(&signal))?;
    signal.arm();
    stream
        .play()
        .map_err(|error| format!("The selected {source} stream could not be started: {error}"))?;
    let started = Instant::now();
    let metrics = collect_metrics(&receiver, &signal, PROBE_DURATION);
    drop(stream);
    let metrics = metrics?;
    if metrics.frame_count == 0 {
        return Err(format!(
            "The selected {source} stream opened but returned no samples."
        ));
    }
    Ok(report(descriptor, format, rate, channels, metrics, started))
}

pub fn probe_application(device_id: &str) -> Result<HeadlessProbe, String> {
    let (devices, _) = enumerate_application_audio_devices();
    let descriptor = devices
        .iter()
        .find(|device| device.device_id == device_id)
        .ok_or_else(|| "The selected application-audio source is no longer available.".to_owned())?;
    let target = resolve_application_audio_target(device_id, &devices)?;
    let signal = Arc::new(TrackSignal::new());
    let (sender, receiver) = mpsc::sync_channel::<PcmChunk>(64);
    let mut capture = ApplicationAudioCapture::new(target, sender, Arc::clone(&signal))?;
    signal.arm();
    capture.start()?;
    let started = Instant::now();
    let metrics = collect_metrics(&receiver, &signal, PROBE_DURATION);
    let _ = capture.stop();
    let metrics = metrics?;
    if metrics.frame_count == 0 {
        return Err("The application stream opened but returned no samples.".to_owned());
    }
    let device = HeadlessDevice {
        id: descriptor.device_id.clone(),
        name: descriptor.label.clone(),
        backend: descriptor.backend.clone(),
        source: descriptor.source.clone(),
        is_default: descriptor.is_default,
        process_id: descriptor.process_id,
        bundle_id: descriptor.bundle_id.clone(),
        sample_format: Some("pcm_f32le".to_owned()),
        sample_rate_hz: Some(super::super::model::APPLICATION_AUDIO_SAMPLE_RATE_HZ),
        channel_count: Some(APPLICATION_AUDIO_CHANNELS),
    };
    Ok(report(
        device,
        "pcm_f32le",
        super::super::model::APPLICATION_AUDIO_SAMPLE_RATE_HZ,
        APPLICATION_AUDIO_CHANNELS,
        metrics,
        started,
    ))
}

#[derive(Default)]
struct ProbeMetrics {
    frame_count: u64,
    sum_squares: f64,
    peak: f64,
}

fn collect_metrics(
    receiver: &Receiver<PcmChunk>,
    signal: &TrackSignal,
    duration: Duration,
) -> Result<ProbeMetrics, String> {
    let started = Instant::now();
    let mut metrics = ProbeMetrics::default();
    while started.elapsed() < duration {
        if let Some(error) = signal.failure_message() {
            return Err(error);
        }
        loop {
            match receiver.try_recv() {
                Ok(chunk) => accumulate(&mut metrics, &chunk.pcm, chunk.sample_format, chunk.channel_count),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    while let Ok(chunk) = receiver.try_recv() {
        accumulate(&mut metrics, &chunk.pcm, chunk.sample_format, chunk.channel_count);
    }
    if let Some(error) = signal.failure_message() {
        return Err(error);
    }
    Ok(metrics)
}

fn accumulate(metrics: &mut ProbeMetrics, pcm: &[u8], format: &str, channels: u16) {
    let channels = usize::from(channels.max(1));
    let width = bytes_per_sample(format);
    if width == 0 {
        return;
    }
    for frame in pcm.chunks(width * channels) {
        if frame.len() < width * channels {
            break;
        }
        metrics.frame_count = metrics.frame_count.saturating_add(1);
        for sample in frame.chunks(width) {
            let Some(value) = sample_to_f32(sample, format) else {
                return;
            };
            let value = f64::from(value).abs();
            metrics.sum_squares += value * value;
            metrics.peak = metrics.peak.max(value);
        }
    }
}

fn report(
    device: HeadlessDevice,
    sample_format: &str,
    sample_rate_hz: u32,
    channel_count: u16,
    metrics: ProbeMetrics,
    started: Instant,
) -> HeadlessProbe {
    let samples = metrics.frame_count.saturating_mul(u64::from(channel_count.max(1)));
    let rms = if samples == 0 {
        0.0
    } else {
        (metrics.sum_squares / samples as f64).sqrt()
    };
    let dbfs = if rms > 0.0 { 20.0 * rms.log10() } else { -120.0 };
    HeadlessProbe {
        id: device.id,
        name: device.name,
        backend: device.backend,
        source: device.source,
        sample_format: sample_format.to_owned(),
        sample_rate_hz,
        channel_count,
        sample_count: samples,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        rms,
        peak: metrics.peak,
        dbfs,
        signal_detected: rms >= SIGNAL_THRESHOLD_RMS,
    }
}

fn bytes_per_sample(format: &str) -> usize {
    match format {
        "pcm_u8" => 1,
        "pcm_s16le" => 2,
        "pcm_s24le" => 3,
        "pcm_s32le" | "pcm_f32le" => 4,
        _ => 0,
    }
}

fn sample_to_f32(sample: &[u8], format: &str) -> Option<f32> {
    match format {
        "pcm_u8" => Some((f32::from(sample[0]) - 128.0) / 128.0),
        "pcm_s16le" => Some(f32::from(i16::from_le_bytes([sample[0], sample[1]])) / 32_768.0),
        "pcm_s24le" => {
            let raw = i32::from(sample[0]) | (i32::from(sample[1]) << 8) | (i32::from(sample[2]) << 16);
            let value = (raw << 8) >> 8;
            Some(value as f32 / 8_388_608.0)
        }
        "pcm_s32le" => Some(
            i32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]) as f32
                / 2_147_483_648.0,
        ),
        "pcm_f32le" => Some(f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{sample_to_f32, ProbeMetrics};

    #[test]
    fn decodes_supported_native_pcm_widths() {
        assert!((sample_to_f32(&[0x00, 0x00, 0x00, 0x40], "pcm_f32le").unwrap() - 2.0).abs() < 0.001);
        assert!((sample_to_f32(&[0x00, 0x40], "pcm_s16le").unwrap() - 0.5).abs() < 0.001);
        assert!((sample_to_f32(&[0x00, 0x00, 0x40], "pcm_s24le").unwrap() - 0.5).abs() < 0.001);
        assert!((sample_to_f32(&[192], "pcm_u8").unwrap() - 0.5).abs() < 0.001);
        assert!(sample_to_f32(&[0; 4], "unknown").is_none());
    }

    #[test]
    fn probe_metrics_start_empty() {
        let metrics = ProbeMetrics::default();
        assert_eq!(metrics.frame_count, 0);
        assert_eq!(metrics.peak, 0.0);
    }
}
