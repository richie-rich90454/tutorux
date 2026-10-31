use cpal::{
    traits::{DeviceTrait, HostTrait},
    SampleFormat,
};
use serde::Serialize;
use std::str::FromStr;
use std::sync::Mutex;

const MIN_SAMPLE_RATE_HZ: u32 = 8_000;
const MAX_SAMPLE_RATE_HZ: u32 = 384_000;
const MAX_CHANNELS: u16 = 8;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeCaptureDevice {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub source: String,
    pub is_default: bool,
    pub sample_format: String,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CaptureFormat {
    pub sample_format: &'static str,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub bytes_per_sample: u16,
}

pub(super) fn resolve_device(source: &str, device_id: &str) -> Result<cpal::Device, String> {
    let descriptor = super::enumerate::enumerate()?
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

pub(super) fn source_config(
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

pub(super) fn validate_config(
    config: &cpal::SupportedStreamConfig,
    source: &str,
) -> Result<(), String> {
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

pub(super) fn capture_format(config: &cpal::SupportedStreamConfig) -> Option<CaptureFormat> {
    let (sample_format, bytes_per_sample) = output_sample_format(config.sample_format())?;
    Some(CaptureFormat {
        sample_format,
        sample_rate_hz: config.sample_rate(),
        channel_count: config.channels(),
        bytes_per_sample,
    })
}

pub(super) fn output_sample_format(format: SampleFormat) -> Option<(&'static str, u16)> {
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

pub(super) fn set_terminal_error(signal: &Mutex<Option<String>>, message: &str) {
    if let Ok(mut error) = signal.lock() {
        if error.is_none() {
            *error = Some(message.to_owned());
        }
    }
}
