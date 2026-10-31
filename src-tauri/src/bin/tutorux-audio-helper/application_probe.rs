use std::time::{Duration, Instant};
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::thread;
#[cfg(target_os = "macos")]
use std::thread;

#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex};

use crate::application::{
    application_probe_unavailable_reason, write_application_probe, ApplicationDevice,
    ProbeMetrics, APPLICATION_CHANNELS, APPLICATION_PROBE_DURATION, APPLICATION_SAMPLE_FORMAT,
    APPLICATION_SAMPLE_RATE_HZ,
};
#[cfg(any(target_os = "windows", target_os = "linux"))]
use crate::application::{MAX_FRAMES_PER_CHUNK, MAX_QUEUED_CHUNKS};
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
use crate::application::platform_limitation;

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(crate) fn probe_application_audio(device: &ApplicationDevice) -> Result<(), String> {
    let mut stream = flexaudio::open(flexaudio::StreamConfig {
        kind: flexaudio::SourceKind::ProcessLoopback,
        target_pid: Some(device.process_id),
        output: flexaudio::OutputFormat {
            sample_rate: APPLICATION_SAMPLE_RATE_HZ,
            channels: APPLICATION_CHANNELS,
        },
        ring_capacity_chunks: MAX_QUEUED_CHUNKS,
        silence_probe: false,
        ..Default::default()
    })
    .map_err(|error| {
        format!(
            "{} Details: {error}",
            application_probe_unavailable_reason()
        )
    })?;
    stream.start().map_err(|error| {
        format!(
            "The native per-application audio backend could not start this endpoint. Details: {error}"
        )
    })?;

    let started = Instant::now();
    let mut metrics = ProbeMetrics::default();
    while started.elapsed() < APPLICATION_PROBE_DURATION {
        while let Some(chunk) = stream.poll_chunk() {
            let frame_count = usize::try_from(chunk.frames)
                .map_err(|_| "the application-audio backend returned an invalid frame count")?;
            if frame_count == 0
                || frame_count > MAX_FRAMES_PER_CHUNK
                || frame_count.checked_mul(usize::from(APPLICATION_CHANNELS))
                    != Some(chunk.data.len())
            {
                stream.stop();
                return Err(
                    "the application-audio backend returned an incomplete PCM frame".to_owned(),
                );
            }
            for sample in &chunk.data {
                metrics.record(*sample);
            }
        }
        if let Some(error) = stream.terminal_error() {
            stream.stop();
            return Err(format!(
                "the selected application-audio source stopped: {error}"
            ));
        }
        thread::sleep(Duration::from_millis(4));
    }
    stream.stop();
    write_application_probe(
        device,
        &metrics,
        APPLICATION_CHANNELS,
        APPLICATION_SAMPLE_FORMAT,
        started.elapsed(),
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn probe_application_audio(device: &ApplicationDevice) -> Result<(), String> {
    use screencapturekit::{prelude::*, stream::delegate_trait::StreamCallbacks};

    let content = SCShareableContent::get().map_err(|error| {
        format!(
            "{} Details: {error}",
            application_probe_unavailable_reason()
        )
    })?;
    let application = content
        .applications()
        .iter()
        .find(|application| application.process_id() == device.process_id as i32)
        .ok_or_else(|| "the selected application is no longer running".to_owned())?;
    let display = content.displays().into_iter().next().ok_or_else(|| {
        "ScreenCaptureKit could not find a display for application audio".to_owned()
    })?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_including_applications(&[application], &[])
        .build()
        .map_err(|error| format!("the selected application could not be filtered: {error}"))?;
    let configuration = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_sample_rate(APPLICATION_SAMPLE_RATE_HZ)
        .with_channel_count(u32::from(APPLICATION_CHANNELS));
    let delegate = StreamCallbacks::new().on_stop(|_| {});
    let metrics = Arc::new(Mutex::new(ProbeMetrics::default()));
    let channel_count = Arc::new(Mutex::new(APPLICATION_CHANNELS));
    let callback_metrics = Arc::clone(&metrics);
    let callback_channels = Arc::clone(&channel_count);
    let mut stream = SCStream::new_with_delegate(&filter, &configuration, delegate)
        .map_err(|error| format!("the application-audio stream could not be created: {error}"))?;
    stream
        .add_output_handler(
            move |sample: CMSampleBuffer, _output_type: SCStreamOutputType| {
                let Ok(buffers) = sample.audio_buffer_list() else {
                    return;
                };
                let total: u16 = buffers
                    .iter()
                    .map(|buffer| buffer.number_channels as u16)
                    .sum();
                if total == 0 || total > APPLICATION_CHANNELS {
                    return;
                }
                if let Ok(mut channels) = callback_channels.lock() {
                    *channels = total;
                }
                if let Ok(mut metrics) = callback_metrics.lock() {
                    for buffer in buffers.iter() {
                        if buffer.data().len() % 4 != 0 {
                            continue;
                        }
                        for bytes in buffer.data().chunks_exact(4) {
                            metrics.record(f32::from_le_bytes([
                                bytes[0], bytes[1], bytes[2], bytes[3],
                            ]));
                        }
                    }
                }
            },
            SCStreamOutputType::Audio,
        )
        .map_err(|error| {
            format!("the application-audio handler could not be installed: {error}")
        })?;
    stream
        .start_capture()
        .map_err(|error| format!("the selected application audio could not be started: {error}"))?;
    let started = Instant::now();
    thread::sleep(APPLICATION_PROBE_DURATION);
    let _ = stream.stop_capture();
    let metrics = metrics
        .lock()
        .map_err(|_| "the application-audio probe could not read its measurements".to_owned())?;
    let channels = *channel_count
        .lock()
        .map_err(|_| "the application-audio probe could not read its channel count".to_owned())?;
    write_application_probe(
        device,
        &metrics,
        channels,
        APPLICATION_SAMPLE_FORMAT,
        started.elapsed(),
    )
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub(crate) fn probe_application_audio(_device: &ApplicationDevice) -> Result<(), String> {
    Err(platform_limitation().to_owned())
}
