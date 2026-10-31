use super::super::devices::{enumerate_devices as enumerate_native_devices, resolve_device};
use super::super::model::{SynchronizedAudioDevice, APPLICATION_AUDIO_CHANNELS, APPLICATION_AUDIO_SAMPLE_RATE_HZ};
use super::super::devices::system_audio_config;
use cpal::traits::DeviceTrait;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadlessDevice {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub source: String,
    pub is_default: bool,
    pub process_id: Option<u32>,
    pub bundle_id: Option<String>,
    pub sample_format: Option<String>,
    pub sample_rate_hz: Option<u32>,
    pub channel_count: Option<u16>,
}

#[derive(Debug, Clone)]
pub struct HeadlessDevices {
    pub devices: Vec<HeadlessDevice>,
    pub system_audio_unavailable_reason: Option<String>,
    pub application_audio_unavailable_reason: Option<String>,
}

pub fn enumerate_devices() -> Result<HeadlessDevices, String> {
    let native = enumerate_native_devices()?;
    let mut devices = Vec::new();
    for device in native.microphones {
        devices.push(enrich(device));
    }
    for device in native.system_audio {
        devices.push(enrich(device));
    }
    for device in native.application_audio {
        devices.push(from_native(device, Some(APPLICATION_AUDIO_SAMPLE_RATE_HZ), Some(APPLICATION_AUDIO_CHANNELS)));
    }
    Ok(HeadlessDevices {
        devices,
        system_audio_unavailable_reason: native.system_audio_unavailable_reason,
        application_audio_unavailable_reason: native.application_audio_unavailable_reason,
    })
}

fn from_native(
    device: SynchronizedAudioDevice,
    sample_rate_hz: Option<u32>,
    channel_count: Option<u16>,
) -> HeadlessDevice {
    HeadlessDevice {
        id: device.device_id,
        name: device.label,
        backend: device.backend,
        source: device.source,
        is_default: device.is_default,
        process_id: device.process_id,
        bundle_id: device.bundle_id,
        sample_format: None,
        sample_rate_hz,
        channel_count,
    }
}

fn enrich(device: SynchronizedAudioDevice) -> HeadlessDevice {
    let is_application = device.source == "application-audio";
    let mut enriched = from_native(
        device,
        if is_application {
            Some(APPLICATION_AUDIO_SAMPLE_RATE_HZ)
        } else {
            None
        },
        if is_application {
            Some(APPLICATION_AUDIO_CHANNELS)
        } else {
            None
        },
    );
    if is_application {
        enriched.sample_format = Some("pcm_f32le".to_owned());
        return enriched;
    }
    if let Ok(device) = resolve_device(&enriched.id) {
        let config = if enriched.source == "system-audio" {
            system_audio_config(&device).ok()
        } else {
            device.default_input_config().ok()
        };
        if let Some(config) = config {
            enriched.sample_format = Some(sample_format_name(config.sample_format()).to_owned());
            enriched.sample_rate_hz = Some(config.sample_rate());
            enriched.channel_count = Some(config.channels());
        }
    }
    enriched
}

pub(super) fn sample_format_name(format: cpal::SampleFormat) -> &'static str {
    super::super::capture::sample_format_name(format)
}
