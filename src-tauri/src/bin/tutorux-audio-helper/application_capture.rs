use std::{
    io::{self, BufWriter, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
#[cfg(target_os = "macos")]
use std::sync::mpsc::{self, TrySendError};
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::thread;

use crate::application::{
    announce_application_format, announce_application_summary, ApplicationDevice,
    APPLICATION_CHANNELS, APPLICATION_SAMPLE_RATE_HZ,
};
use crate::capture_io::{
    application_frame_bytes, watch_for_stop, write_f32le, write_silence_frames,
};

#[cfg(any(target_os = "windows", target_os = "linux"))]
use crate::application::{
    MAX_APPLICATION_GAP_FRAMES, MAX_FRAMES_PER_CHUNK, MAX_QUEUED_CHUNKS,
};
#[cfg(target_os = "macos")]
use crate::application::{MAX_FRAMES_PER_CHUNK, MAX_QUEUED_CHUNKS};

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(crate) fn capture_application_audio(device: &ApplicationDevice) -> Result<(), String> {
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
    .map_err(|error| format!("the selected application audio could not be opened: {error}"))?;
    stream
        .start()
        .map_err(|error| format!("the selected application audio could not be started: {error}"))?;

    announce_application_format()?;
    let stop = Arc::new(AtomicBool::new(false));
    watch_for_stop(Arc::clone(&stop))?;
    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1024, stdout.lock());
    let mut expected_frame_index = None;
    let mut frame_count_written = 0_u64;
    let mut byte_count_written = 0_u64;
    while !stop.load(Ordering::Acquire) {
        while let Some(chunk) = stream.poll_chunk() {
            let frame_count = usize::try_from(chunk.frames)
                .map_err(|_| "the application-audio backend returned an invalid frame count")?;
            if frame_count == 0
                || frame_count > MAX_FRAMES_PER_CHUNK
                || frame_count.checked_mul(usize::from(APPLICATION_CHANNELS))
                    != Some(chunk.data.len())
            {
                return Err(
                    "the application-audio backend returned an incomplete PCM frame".into(),
                );
            }
            let (gap_before_samples, contains_device_discontinuity) = match expected_frame_index {
                Some(expected) if chunk.frame_index > expected => {
                    (chunk.frame_index - expected, true)
                }
                Some(expected) => (0, chunk.frame_index != expected),
                None => (0, false),
            };
            if gap_before_samples > MAX_APPLICATION_GAP_FRAMES {
                return Err(
                    "the application-audio backend dropped more than the supported 10-second audio gap"
                        .to_owned(),
                );
            }
            if contains_device_discontinuity {
                let _ = writeln!(
                    io::stderr().lock(),
                    "tutorux-audio-helper: application-audio gap of {gap_before_samples} frames"
                );
            }
            if gap_before_samples > 0 {
                write_silence_frames(&mut output, gap_before_samples, application_frame_bytes())?;
            }
            expected_frame_index = Some(
                chunk
                    .frame_index
                    .checked_add(frame_count as u64)
                    .ok_or_else(|| {
                        "the application-audio timeline exceeded its limit".to_owned()
                    })?,
            );
            write_f32le(&mut output, &chunk.data)?;
            frame_count_written = frame_count_written
                .checked_add(frame_count as u64)
                .and_then(|count| count.checked_add(gap_before_samples))
                .ok_or_else(|| "the capture frame count exceeded its limit".to_owned())?;
            byte_count_written = byte_count_written
                .checked_add(
                    (frame_count as u64)
                        .checked_add(gap_before_samples)
                        .and_then(|count| count.checked_mul(application_frame_bytes() as u64))
                        .ok_or_else(|| "the capture byte count exceeded its limit".to_owned())?,
                )
                .ok_or_else(|| "the capture byte count exceeded its limit".to_owned())?;
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
    output
        .flush()
        .map_err(|error| format!("could not flush captured audio: {error}"))?;
    if frame_count_written == 0 {
        return Err("the selected application produced no audio samples".to_owned());
    }
    announce_application_summary(frame_count_written, byte_count_written);
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_application_audio(device: &ApplicationDevice) -> Result<(), String> {
    use screencapturekit::{prelude::*, stream::delegate_trait::StreamCallbacks};

    let content = SCShareableContent::get().map_err(|error| {
        format!("ScreenCaptureKit could not list applications. Check recording permission: {error}")
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
    let (sender, receiver) = mpsc::sync_channel::<Vec<f32>>(MAX_QUEUED_CHUNKS);
    let callback_failed = Arc::new(AtomicBool::new(false));
    let failure_signal = Arc::clone(&callback_failed);
    let delegate = StreamCallbacks::new().on_stop(move |error| {
        if error.is_some() {
            failure_signal.store(true, Ordering::Release);
        }
    });
    let mut stream = SCStream::new_with_delegate(&filter, &configuration, delegate)
        .map_err(|error| format!("the application-audio stream could not be created: {error}"))?;
    let callback_failed = Arc::clone(&callback_failed);
    stream
        .add_output_handler(
            move |sample: CMSampleBuffer, _output_type: SCStreamOutputType| {
                match screen_capture_audio_interleaved(sample) {
                    Ok(samples) if !samples.is_empty() => match sender.try_send(samples) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                            callback_failed.store(true, Ordering::Release);
                        }
                    },
                    Ok(_) => {}
                    Err(()) => callback_failed.store(true, Ordering::Release),
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
    announce_application_format()?;

    let stop = Arc::new(AtomicBool::new(false));
    watch_for_stop(Arc::clone(&stop))?;
    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1024, stdout.lock());
    let mut frame_count_written = 0_u64;
    while !stop.load(Ordering::Acquire) {
        if callback_failed.load(Ordering::Acquire) {
            let _ = stream.stop_capture();
            return Err(
                "ScreenCaptureKit audio delivery stopped or fell behind its bounded queue"
                    .to_owned(),
            );
        }
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(samples) => {
                write_f32le(&mut output, &samples)?;
                frame_count_written = frame_count_written
                    .checked_add((samples.len() / usize::from(APPLICATION_CHANNELS)) as u64)
                    .ok_or_else(|| "the capture frame count exceeded its limit".to_owned())?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = stream.stop_capture();
                return Err("ScreenCaptureKit audio delivery ended unexpectedly".to_owned());
            }
        }
    }
    let _ = stream.stop_capture();
    output
        .flush()
        .map_err(|error| format!("could not flush captured audio: {error}"))?;
    if frame_count_written == 0 {
        return Err("the selected application produced no audio samples".to_owned());
    }
    announce_application_summary(
        frame_count_written,
        frame_count_written * application_frame_bytes() as u64,
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn screen_capture_audio_interleaved(
    sample: screencapturekit::prelude::CMSampleBuffer,
) -> Result<Vec<f32>, ()> {
    let buffers = sample.audio_buffer_list().map_err(|_| ())?;
    let mut channels = Vec::new();
    for buffer in buffers.iter() {
        let channel_count = buffer.number_channels as usize;
        if channel_count == 0 || buffer.data().len() % 4 != 0 {
            return Err(());
        }
        let samples: Vec<f32> = buffer
            .data()
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect();
        if samples.len() > MAX_FRAMES_PER_CHUNK * usize::from(APPLICATION_CHANNELS) {
            return Err(());
        }
        channels.push((channel_count, samples));
    }
    let frame_count = channels
        .iter()
        .map(|(channel_count, samples)| samples.len() / channel_count)
        .min()
        .unwrap_or_default();
    let channel_total: usize = channels.iter().map(|(count, _)| *count).sum();
    if frame_count > MAX_FRAMES_PER_CHUNK || channel_total != usize::from(APPLICATION_CHANNELS) {
        return Err(());
    }
    let mut interleaved = Vec::with_capacity(frame_count * channel_total);
    for frame in 0..frame_count {
        for (channel_count, samples) in &channels {
            let start = frame * channel_count;
            interleaved.extend_from_slice(&samples[start..start + channel_count]);
        }
    }
    Ok(interleaved)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub(crate) fn capture_application_audio(_device: &ApplicationDevice) -> Result<(), String> {
    Err("per-application audio capture is not supported on this operating system".to_owned())
}
