use super::devices::{enumerate_application_audio_devices, resolve_application_audio_target};
use super::model::{
    ApplicationAudioTarget, APPLICATION_AUDIO_CHANNELS, APPLICATION_AUDIO_SAMPLE_RATE_HZ,
};
use super::support::application_audio_unavailable_message;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::thread;
use std::time::Duration;

/// Inspect application-audio targets for the opt-in diagnostics report.
///
/// The returned values contain no application names, bundle IDs, or process IDs. Probe results
/// are anonymous, and each native stream is stopped after the requested short interval.
pub struct ApplicationAudioProbeSummary {
    pub endpoint_count: usize,
    pub probes: Vec<Option<Result<(), String>>>,
    pub unavailable_reason: Option<String>,
}

pub fn inspect_application_audio_endpoints(
    probe_requested: bool,
    maximum_listed: usize,
    maximum_probes: usize,
    probe_duration: Duration,
) -> ApplicationAudioProbeSummary {
    if !probe_requested {
        return ApplicationAudioProbeSummary {
            endpoint_count: 0,
            probes: Vec::new(),
            unavailable_reason: Some(
                "Per-application endpoint discovery and stream probes require explicit opt-in."
                    .to_owned(),
            ),
        };
    }
    let (devices, discovery_error) = enumerate_application_audio_devices();
    if devices.is_empty() {
        return ApplicationAudioProbeSummary {
            endpoint_count: 0,
            probes: Vec::new(),
            unavailable_reason: Some(if discovery_error.is_some() {
                format!(
                    "Per-application endpoint discovery failed. {}",
                    application_audio_unavailable_message()
                )
            } else {
                format!(
                    "No active per-application audio endpoints were found. {}",
                    application_audio_unavailable_message()
                )
            }),
        };
    }

    let endpoint_count = devices.len();
    let probes = devices
        .iter()
        .take(maximum_listed)
        .enumerate()
        .map(|(index, device)| {
            if index >= maximum_probes {
                return None;
            }
            let result = resolve_application_audio_target(&device.device_id, &devices)
                .and_then(|target| probe_application_audio_stream(&target, probe_duration));
            Some(result)
        })
        .collect();

    ApplicationAudioProbeSummary {
        endpoint_count,
        probes,
        unavailable_reason: None,
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn probe_application_audio_stream(
    target: &ApplicationAudioTarget,
    duration: Duration,
) -> Result<(), String> {
    let mut stream = flexaudio::open(flexaudio::StreamConfig {
        kind: flexaudio::SourceKind::ProcessLoopback,
        target_pid: Some(target.process_id),
        output: flexaudio::OutputFormat {
            sample_rate: APPLICATION_AUDIO_SAMPLE_RATE_HZ,
            channels: APPLICATION_AUDIO_CHANNELS,
        },
        ring_capacity_chunks: 1,
        silence_probe: false,
        ..Default::default()
    })
    .map_err(|_| {
        "The native per-application audio backend could not open this endpoint.".to_owned()
    })?;
    stream.start().map_err(|_| {
        "The native per-application audio backend could not start this endpoint.".to_owned()
    })?;

    let deadline = std::time::Instant::now() + duration;
    while std::time::Instant::now() < deadline {
        for _ in 0..4 {
            if stream.poll_chunk().is_none() {
                break;
            }
        }
        thread::sleep(Duration::from_millis(4));
    }
    stream.stop();
    Ok(())
}

#[cfg(target_os = "macos")]
fn probe_application_audio_stream(
    target: &ApplicationAudioTarget,
    duration: Duration,
) -> Result<(), String> {
    use screencapturekit::prelude::*;
    use screencapturekit::stream::delegate_trait::StreamCallbacks;

    let content = SCShareableContent::get().map_err(|_| {
        "ScreenCaptureKit could not inspect application audio. Check macOS 14+ and Screen & System Audio Recording permission."
            .to_owned()
    })?;
    let application = content
        .applications()
        .iter()
        .find(|application| application.process_id() == target.process_id as i32)
        .ok_or_else(|| {
            "The selected application is no longer available for audio capture.".to_owned()
        })?;
    let display = content.displays().into_iter().next().ok_or_else(|| {
        "ScreenCaptureKit did not expose a display for application audio.".to_owned()
    })?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_including_applications(&[application], &[])
        .build()
        .map_err(|_| {
            "ScreenCaptureKit could not create an application-audio probe filter.".to_owned()
        })?;
    let configuration = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_sample_rate(APPLICATION_AUDIO_SAMPLE_RATE_HZ)
        .with_channel_count(u32::from(APPLICATION_AUDIO_CHANNELS));
    let delegate = StreamCallbacks::new().on_stop(|_| {});
    let mut stream =
        SCStream::new_with_delegate(&filter, &configuration, delegate).map_err(|_| {
            "ScreenCaptureKit could not create an application-audio probe stream.".to_owned()
        })?;
    stream
        .add_output_handler(
            |_sample: CMSampleBuffer, _output_type: SCStreamOutputType| {},
            SCStreamOutputType::Audio,
        )
        .map_err(|_| {
            "ScreenCaptureKit could not install the discard-only audio probe.".to_owned()
        })?;
    stream
        .start_capture()
        .map_err(|_| "ScreenCaptureKit could not start the application-audio probe.".to_owned())?;
    thread::sleep(duration);
    stream.stop_capture().map_err(|_| {
        "ScreenCaptureKit could not stop the application-audio probe cleanly.".to_owned()
    })
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn probe_application_audio_stream(
    _target: &ApplicationAudioTarget,
    _duration: Duration,
) -> Result<(), String> {
    Err(application_audio_unavailable_message().to_owned())
}
