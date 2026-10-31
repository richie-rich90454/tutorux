use super::model::{
    ApplicationAudioTarget, SynchronizedAudioDevice, SynchronizedAudioDevices,
    APPLICATION_AUDIO_DISCOVERY_RUNNING,
};
use super::support::{
    application_audio_unavailable_message, device_error, system_audio_unavailable_message,
};
use cpal::traits::{DeviceTrait, HostTrait};
use std::{
    str::FromStr,
    sync::{atomic::Ordering, mpsc},
    thread,
    time::Duration,
};

struct ApplicationAudioDiscoveryGuard;

impl Drop for ApplicationAudioDiscoveryGuard {
    fn drop(&mut self) {
        APPLICATION_AUDIO_DISCOVERY_RUNNING.store(false, Ordering::Release);
    }
}

pub(super) fn enumerate_devices() -> Result<SynchronizedAudioDevices, String> {
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
                let Ok(device_id) = device.id() else { continue };
                let Ok(description) = device.description() else {
                    continue;
                };
                #[cfg(target_os = "linux")]
                let is_monitor = is_linux_monitor_name(description.name());
                #[cfg(not(target_os = "linux"))]
                let is_monitor = false;
                if !is_monitor && device.default_input_config().is_ok() {
                    microphones.push(SynchronizedAudioDevice {
                        device_id: device_id.to_string(),
                        label: description.name().to_owned(),
                        backend: backend.clone(),
                        source: "microphone".into(),
                        is_default: Some(&device_id) == default_microphone_id.as_ref(),
                        process_id: None,
                        application_name: None,
                        bundle_id: None,
                    });
                }

                #[cfg(target_os = "linux")]
                if is_linux_monitor_name(description.name()) {
                    system_audio.push(SynchronizedAudioDevice {
                        device_id: device_id.to_string(),
                        label: format!("System audio · {}", description.name()),
                        backend: backend.clone(),
                        source: "system-audio".into(),
                        is_default: false,
                        process_id: None,
                        application_name: None,
                        bundle_id: None,
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
                // CoreAudio's loopback path is selected when the output endpoint has no input
                // channels. A duplex endpoint would otherwise silently record its input.
                #[cfg(target_os = "macos")]
                if device.supports_input() {
                    continue;
                }
                let Ok(device_id) = device.id() else { continue };
                let Ok(description) = device.description() else {
                    continue;
                };
                if device.default_output_config().is_ok() {
                    system_audio.push(SynchronizedAudioDevice {
                        device_id: device_id.to_string(),
                        label: format!("System audio · {}", description.name()),
                        backend: backend.clone(),
                        source: "system-audio".into(),
                        is_default: Some(&device_id) == default_output_id.as_ref(),
                        process_id: None,
                        application_name: None,
                        bundle_id: None,
                    });
                }
            }
        }
    }
    deduplicate_devices(&mut microphones);
    deduplicate_devices(&mut system_audio);
    let (application_audio, application_audio_unavailable_reason) =
        enumerate_application_audio_devices();
    let microphone_available = !microphones.is_empty();
    let system_audio_available = !system_audio.is_empty();
    let application_audio_available = !application_audio.is_empty();
    Ok(SynchronizedAudioDevices {
        microphones,
        system_audio,
        application_audio,
        microphone_available,
        system_audio_available,
        application_audio_available,
        system_audio_unavailable_reason: (!system_audio_available)
            .then(system_audio_unavailable_message),
        application_audio_unavailable_reason: if application_audio_available {
            None
        } else {
            application_audio_unavailable_reason
                .or_else(|| Some(application_audio_unavailable_message().to_owned()))
        },
    })
}

pub(super) fn enumerate_application_audio_devices() -> (Vec<SynchronizedAudioDevice>, Option<String>) {
    if APPLICATION_AUDIO_DISCOVERY_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return (
            Vec::new(),
            Some(
                "A previous application-audio discovery is still running; try again shortly."
                    .to_owned(),
            ),
        );
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name("tutorux-application-audio-discovery".into())
        .spawn(move || {
            let _guard = ApplicationAudioDiscoveryGuard;
            let _ = sender.send(enumerate_application_audio_devices_inner());
        });
    if worker.is_err() {
        APPLICATION_AUDIO_DISCOVERY_RUNNING.store(false, Ordering::Release);
        return (
            Vec::new(),
            Some("Application-audio discovery could not be started.".to_owned()),
        );
    }
    match receiver.recv_timeout(Duration::from_secs(4)) {
        Ok(result) => result,
        Err(_) => (
            Vec::new(),
            Some(
                "Application-audio discovery did not respond in time; refresh and try again."
                    .to_owned(),
            ),
        ),
    }
}
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn enumerate_application_audio_devices_inner() -> (Vec<SynchronizedAudioDevice>, Option<String>) {
    let processes = match flexaudio::processes() {
        Ok(processes) => processes,
        Err(error) => {
            return (
                Vec::new(),
                Some(format!(
                    "{} Details: {error}",
                    application_audio_unavailable_message()
                )),
            );
        }
    };
    let mut devices = Vec::new();
    let mut seen = std::collections::HashSet::new();
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
        devices.push(SynchronizedAudioDevice {
            device_id: format!("{prefix}:{}", process.pid),
            label: format!("{} · process {}", name, process.pid),
            backend: backend.to_owned(),
            source: "application-audio".to_owned(),
            is_default: false,
            process_id: Some(process.pid),
            application_name: Some(name.to_owned()),
            bundle_id: None,
        });
    }
    if devices.is_empty() {
        (
            devices,
            Some("No active application audio streams were found.".to_owned()),
        )
    } else {
        (devices, None)
    }
}

#[cfg(target_os = "macos")]
fn enumerate_application_audio_devices_inner() -> (Vec<SynchronizedAudioDevice>, Option<String>) {
    use screencapturekit::prelude::SCShareableContent;

    let content = match SCShareableContent::get() {
        Ok(content) => content,
        Err(error) => {
            return (
                Vec::new(),
                Some(format!(
                    "macOS application audio needs Screen & System Audio Recording permission and macOS 14 or newer. Details: {error}"
                )),
            );
        }
    };
    let current_process_id = std::process::id();
    let mut devices = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for application in content.applications().iter() {
        let process_id = application.process_id();
        let Ok(process_id) = u32::try_from(process_id) else {
            continue;
        };
        if process_id == current_process_id || !seen.insert(process_id) {
            continue;
        }
        let name = application.application_name().to_string();
        if name.trim().is_empty() {
            continue;
        }
        let raw_bundle_id = application.bundle_identifier().to_string();
        devices.push(SynchronizedAudioDevice {
            device_id: format!("screencapturekit-app:{process_id}"),
            label: format!("{} · process {}", name, process_id),
            backend: "screencapturekit-app-audio".to_owned(),
            source: "application-audio".to_owned(),
            is_default: false,
            process_id: Some(process_id),
            application_name: Some(name),
            bundle_id: (!raw_bundle_id.trim().is_empty()).then_some(raw_bundle_id),
        });
    }
    if devices.is_empty() {
        (
            devices,
            Some("No other shareable applications were found. macOS may require Screen & System Audio Recording permission.".to_owned()),
        )
    } else {
        (devices, None)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn enumerate_application_audio_devices_inner() -> (Vec<SynchronizedAudioDevice>, Option<String>) {
    (
        Vec::new(),
        Some(application_audio_unavailable_message().to_owned()),
    )
}

pub(super) fn resolve_application_audio_target(
    device_id: &str,
    devices: &[SynchronizedAudioDevice],
) -> Result<ApplicationAudioTarget, String> {
    let device = devices
        .iter()
        .find(|device| device.device_id == device_id && device.source == "application-audio")
        .ok_or_else(|| {
            "The selected application-audio source is no longer available.".to_owned()
        })?;
    let process_id = device.process_id.ok_or_else(|| {
        "The selected application has no available process identifier.".to_owned()
    })?;
    let backend = match device.backend.as_str() {
        "wasapi-process-loopback" => "wasapi-process-loopback",
        "pipewire-process-loopback" => "pipewire-process-loopback",
        "screencapturekit-app-audio" => "screencapturekit-app-audio",
        _ => return Err("The selected application-audio backend is unavailable.".to_owned()),
    };
    Ok(ApplicationAudioTarget {
        process_id,
        name: device
            .application_name
            .clone()
            .unwrap_or_else(|| device.label.clone()),
        bundle_id: device.bundle_id.clone(),
        backend,
    })
}

fn deduplicate_devices(devices: &mut Vec<SynchronizedAudioDevice>) {
    let mut seen = std::collections::HashSet::new();
    devices.retain(|device| seen.insert((device.backend.clone(), device.device_id.clone())));
}

pub(super) fn system_audio_config(
    device: &cpal::Device,
) -> Result<cpal::SupportedStreamConfig, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let config = device
        .default_output_config()
        .map_err(|error| device_error("system audio", error))?;

    #[cfg(target_os = "linux")]
    let config = device
        .default_input_config()
        .map_err(|error| device_error("system audio", error))?;

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let config = device
        .default_input_config()
        .map_err(|error| device_error("system audio", error))?;

    Ok(config)
}

pub(crate) fn resolve_device(value: &str) -> Result<cpal::Device, String> {
    let id = cpal::DeviceId::from_str(value)
        .map_err(|_| "The selected audio device identifier is invalid.".to_owned())?;
    #[cfg(target_os = "linux")]
    let host = cpal::host_from_id(id.host())
        .map_err(|error| format!("The selected audio backend is no longer available: {error}"))?;
    #[cfg(not(target_os = "linux"))]
    let host = cpal::default_host();
    host.device_by_id(&id)
        .ok_or_else(|| "The selected audio device is no longer available.".to_owned())
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
    let normalized = value.to_ascii_lowercase();
    normalized.contains("monitor") || normalized.contains("loopback")
}
