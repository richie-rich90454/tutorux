use crate::platform::synchronized_audio::inspect_application_audio_endpoints;
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Data,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    thread,
};

use super::{AUDIO_STREAM_PROBE_DURATION, MAX_AUDIO_STREAM_PROBES};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AudioEndpointDiagnostics {
    probe_scope: &'static str,
    microphones: EndpointAvailability,
    system_audio: EndpointAvailability,
    application_audio: EndpointAvailability,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EndpointAvailability {
    available: bool,
    count: usize,
    truncated_count: usize,
    probes: Vec<AudioEndpointProbe>,
    unavailable_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioEndpointProbe {
    state: &'static str,
    sample_format: Option<String>,
    sample_rate_hz: Option<u32>,
    channel_count: Option<u16>,
    unavailable_reason: Option<String>,
}

#[derive(Clone, Copy)]
enum EndpointProbeMode {
    ConfigurationOnly,
    OpenStream,
    LimitReached,
}

fn next_probe_mode(requested: bool, started: &mut usize) -> EndpointProbeMode {
    if !requested {
        return EndpointProbeMode::ConfigurationOnly;
    }
    if *started >= MAX_AUDIO_STREAM_PROBES {
        return EndpointProbeMode::LimitReached;
    }
    *started += 1;
    EndpointProbeMode::OpenStream
}

pub(super) fn enumerate_audio_endpoints(probe_streams: bool) -> AudioEndpointDiagnostics {
    let mut microphone_keys = HashSet::new();
    let mut system_audio_keys = HashSet::new();
    let mut microphone_probes = Vec::new();
    let mut system_audio_probes = Vec::new();
    let mut stream_probe_count = 0;

    for host in hosts() {
        let backend = host.id().to_string();

        if let Ok(devices) = host.input_devices() {
            for device in devices {
                let key = endpoint_key(&backend, &device);
                #[cfg(target_os = "linux")]
                let is_monitor = device
                    .description()
                    .ok()
                    .as_ref()
                    .is_some_and(|description| is_linux_monitor_name(description.name()));
                #[cfg(not(target_os = "linux"))]
                let is_monitor = false;

                let (seen, probes) = if is_monitor {
                    (&mut system_audio_keys, &mut system_audio_probes)
                } else {
                    (&mut microphone_keys, &mut microphone_probes)
                };
                if key.as_ref().is_some_and(|key| !seen.insert(key.clone())) {
                    continue;
                }
                let mode = next_probe_mode(probe_streams, &mut stream_probe_count);
                probes.push(probe_input_endpoint(&device, mode));
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
                let key = endpoint_key(&backend, &device);
                if key
                    .as_ref()
                    .is_some_and(|key| !system_audio_keys.insert(key.clone()))
                {
                    continue;
                }
                let mode = next_probe_mode(probe_streams, &mut stream_probe_count);
                system_audio_probes.push(probe_output_endpoint(&device, mode));
            }
        }
    }

    let remaining_probe_slots = if probe_streams {
        MAX_AUDIO_STREAM_PROBES.saturating_sub(stream_probe_count)
    } else {
        0
    };
    let application_audio = inspect_application_audio_endpoints(
        probe_streams,
        MAX_AUDIO_STREAM_PROBES,
        remaining_probe_slots,
        AUDIO_STREAM_PROBE_DURATION,
    );
    let application_endpoint_count = application_audio.endpoint_count;
    let application_unavailable_reason = application_audio.unavailable_reason;
    let application_probes = application_audio
        .probes
        .into_iter()
        .map(|result| match result {
            Some(Ok(())) => AudioEndpointProbe {
                state: "stream-opened",
                sample_format: Some("normalized PCM".to_owned()),
                sample_rate_hz: Some(48_000),
                channel_count: Some(2),
                unavailable_reason: None,
            },
            Some(Err(reason)) => AudioEndpointProbe {
                state: "unavailable",
                sample_format: Some("normalized PCM".to_owned()),
                sample_rate_hz: Some(48_000),
                channel_count: Some(2),
                unavailable_reason: Some(reason),
            },
            None => AudioEndpointProbe {
                state: "not-probed",
                sample_format: Some("normalized PCM".to_owned()),
                sample_rate_hz: Some(48_000),
                channel_count: Some(2),
                unavailable_reason: Some(if !probe_streams {
                    "Per-application endpoints were enumerated, but native stream probes require explicit opt-in."
                        .to_owned()
                } else {
                    "The bounded report probe limit was reached; this endpoint was listed but its stream was not opened."
                        .to_owned()
                }),
            },
        })
        .collect();
    let application_truncated_count =
        application_endpoint_count.saturating_sub(MAX_AUDIO_STREAM_PROBES);
    let application_unavailable_reason = application_unavailable_reason.or_else(|| {
        if application_endpoint_count == 0 {
            None
        } else if remaining_probe_slots == 0 {
            Some("No per-application endpoint was opened because the shared diagnostic probe limit was reached.".to_owned())
        } else {
            None
        }
    });
    let application_audio = endpoint_availability(
        application_probes,
        "per-application audio",
        application_truncated_count,
        application_unavailable_reason,
    );

    AudioEndpointDiagnostics {
        probe_scope: if probe_streams {
            "explicit opt-in: supported microphone, system-audio, and per-application endpoints are opened briefly; callback samples are discarded and no audio is saved"
        } else {
            "configuration-only; no audio stream or per-application endpoint discovery was started"
        },
        microphones: endpoint_availability(microphone_probes, "microphone", 0, None),
        system_audio: endpoint_availability(system_audio_probes, "system-audio", 0, None),
        application_audio,
    }
}

fn probe_input_endpoint(device: &cpal::Device, mode: EndpointProbeMode) -> AudioEndpointProbe {
    match device.default_input_config() {
        Ok(config) => endpoint_probe_result(&config, mode, device),
        Err(_) => AudioEndpointProbe {
            state: "unavailable",
            sample_format: None,
            sample_rate_hz: None,
            channel_count: None,
            unavailable_reason: Some(
                "The endpoint did not provide a supported input configuration.".into(),
            ),
        },
    }
}

fn probe_output_endpoint(device: &cpal::Device, mode: EndpointProbeMode) -> AudioEndpointProbe {
    match device.default_output_config() {
        Ok(config) => endpoint_probe_result(&config, mode, device),
        Err(_) => AudioEndpointProbe {
            state: "unavailable",
            sample_format: None,
            sample_rate_hz: None,
            channel_count: None,
            unavailable_reason: Some(
                "The endpoint did not provide a supported output configuration.".into(),
            ),
        },
    }
}

fn endpoint_probe_result(
    config: &cpal::SupportedStreamConfig,
    mode: EndpointProbeMode,
    device: &cpal::Device,
) -> AudioEndpointProbe {
    let state = match mode {
        EndpointProbeMode::ConfigurationOnly => "configuration-ready",
        EndpointProbeMode::LimitReached => "not-probed",
        EndpointProbeMode::OpenStream => match open_discarding_probe_stream(device, config) {
            Ok(()) => "stream-opened",
            Err(_) => "unavailable",
        },
    };
    let unavailable_reason = match state {
        "not-probed" => Some(
            "The bounded report probe limit was reached; this endpoint's configuration is listed but its stream was not opened."
                .into(),
        ),
        "unavailable" => Some(
            "The native audio backend could not open this endpoint for the brief capture probe. Check device availability and operating-system audio permissions."
                .into(),
        ),
        _ => None,
    };
    AudioEndpointProbe {
        state,
        sample_format: Some(format!("{:?}", config.sample_format())),
        sample_rate_hz: Some(config.sample_rate()),
        channel_count: Some(config.channels()),
        unavailable_reason,
    }
}

fn open_discarding_probe_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
) -> Result<(), String> {
    let callback_failed = Arc::new(Mutex::new(false));
    let error_callback_failed = Arc::clone(&callback_failed);
    let stream_config = config.config();
    let stream = device
        .build_input_stream_raw(
            stream_config,
            config.sample_format(),
            |_data: &Data, _info| {},
            move |_error| {
                if let Ok(mut failed) = error_callback_failed.lock() {
                    *failed = true;
                }
            },
            None,
        )
        .map_err(|_| "The native audio backend refused to build the probe stream.".to_owned())?;
    stream
        .play()
        .map_err(|_| "The native audio backend refused to start the probe stream.".to_owned())?;
    thread::sleep(AUDIO_STREAM_PROBE_DURATION);
    drop(stream);
    if callback_failed.lock().map(|failed| *failed).unwrap_or(true) {
        return Err("The native audio probe stream reported an asynchronous error.".into());
    }
    Ok(())
}

fn endpoint_availability(
    probes: Vec<AudioEndpointProbe>,
    kind: &str,
    truncated_count: usize,
    unavailable_reason: Option<String>,
) -> EndpointAvailability {
    let count = probes
        .iter()
        .filter(|probe| matches!(probe.state, "configuration-ready" | "stream-opened"))
        .count();
    EndpointAvailability {
        available: count > 0,
        count,
        truncated_count,
        unavailable_reason: if count == 0 {
            unavailable_reason.or_else(|| {
                Some(if probes.is_empty() {
                    format!("No compatible {kind} endpoints were enumerated on this audio backend.")
                } else if kind == "per-application audio" {
                    "No enumerated per-application endpoint could be opened for a native stream probe."
                        .to_owned()
                } else {
                    format!("No enumerated {kind} endpoint provided a supported audio configuration.")
                })
            })
        } else {
            unavailable_reason
        },
        probes,
    }
}

fn endpoint_key(backend: &str, device: &cpal::Device) -> Option<(String, String)> {
    device
        .id()
        .ok()
        .map(|device_id| (backend.to_owned(), device_id.to_string()))
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
