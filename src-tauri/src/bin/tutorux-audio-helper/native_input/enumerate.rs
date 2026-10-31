use cpal::traits::{DeviceTrait, HostTrait};

use super::device::NativeCaptureDevice;

pub(crate) fn enumerate() -> Result<Vec<NativeCaptureDevice>, String> {
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
