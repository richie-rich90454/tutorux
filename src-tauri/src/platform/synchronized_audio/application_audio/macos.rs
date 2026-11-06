use super::super::model::{
    ApplicationAudioCounters, PcmChunk, TrackKind, TrackSignal, APPLICATION_AUDIO_CHANNELS,
    APPLICATION_AUDIO_SAMPLE_RATE_HZ, MAX_CAPTURE_CALLBACK_BYTES, MAX_CHANNELS,
};
use super::{ApplicationAudioTarget, NativeApplicationAudioStream};
use std::sync::{
    atomic::Ordering,
    mpsc::{SyncSender, TrySendError},
    Arc,
};

#[cfg(target_os = "macos")]
pub(super) fn start_application_audio_stream(
    target: &ApplicationAudioTarget,
    sender: SyncSender<PcmChunk>,
    signal: Arc<TrackSignal>,
    counters: Arc<ApplicationAudioCounters>,
) -> Result<NativeApplicationAudioStream, String> {
    use screencapturekit::prelude::*;
    use screencapturekit::stream::delegate_trait::StreamCallbacks;

    let content = SCShareableContent::get().map_err(|error| {
        format!(
            "ScreenCaptureKit could not list shareable apps. Grant Screen & System Audio Recording permission and restart Tutorux: {error}"
        )
    })?;
    let applications = content.applications();
    let application = applications
        .iter()
        .find(|application| application.process_id() == target.process_id as i32)
        .ok_or_else(|| "The selected application is no longer running.".to_owned())?;
    let display = content.displays().into_iter().next().ok_or_else(|| {
        "ScreenCaptureKit could not find a display for application audio capture.".to_owned()
    })?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_including_applications(&[application], &[])
        .build()
        .map_err(|error| format!("The selected application could not be filtered: {error}"))?;
    let configuration = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_sample_rate(APPLICATION_AUDIO_SAMPLE_RATE_HZ)
        .with_channel_count(u32::from(APPLICATION_AUDIO_CHANNELS));
    let stop_signal = Arc::clone(&signal);
    let delegate = StreamCallbacks::new().on_stop(move |error| {
        if let Some(error) = error {
            stop_signal.fail(format!(
                "ScreenCaptureKit stopped application audio: {error}"
            ));
        }
    });
    let mut stream = SCStream::new_with_delegate(&filter, &configuration, delegate)
        .map_err(|error| format!("The application-audio stream could not be created: {error}"))?;
    stream
        .add_output_handler(
            move |sample: CMSampleBuffer, _output_type: SCStreamOutputType| {
                receive_screen_capture_audio(sample, &sender, &signal, &counters);
            },
            SCStreamOutputType::Audio,
        )
        .map_err(|error| {
            format!("The application-audio handler could not be installed: {error}")
        })?;
    stream
        .start_capture()
        .map_err(|error| format!("The selected application audio could not be started: {error}"))?;
    Ok(NativeApplicationAudioStream(stream))
}

#[cfg(target_os = "macos")]
fn receive_screen_capture_audio(
    sample: screencapturekit::prelude::CMSampleBuffer,
    sender: &SyncSender<PcmChunk>,
    signal: &TrackSignal,
    counters: &ApplicationAudioCounters,
) {
    if !signal.accepting.load(Ordering::Acquire) {
        return;
    }
    let buffers = match sample.audio_buffer_list() {
        Ok(buffers) => buffers,
        Err(_) => {
            signal.fail("ScreenCaptureKit returned an unreadable application-audio buffer.");
            return;
        }
    };
    let mut channels = Vec::new();
    let mut channel_total = 0usize;
    for buffer in buffers.iter() {
        let channel_count = buffer.number_channels as usize;
        if channel_count == 0 || buffer.data().len() % 4 != 0 {
            signal.fail("ScreenCaptureKit returned an unsupported application-audio format.");
            return;
        }
        let samples: Vec<f32> = buffer
            .data()
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect();
        channel_total = channel_total.saturating_add(channel_count);
        if channel_total > usize::from(MAX_CHANNELS) {
            signal.fail("ScreenCaptureKit returned more application-audio channels than the archive supports.");
            return;
        }
        channels.push((channel_count, samples));
    }
    let frame_count = channels
        .iter()
        .map(|(channel_count, samples)| samples.len() / channel_count)
        .min()
        .unwrap_or_default();
    if frame_count == 0 || channel_total == 0 {
        if channel_total == 0 {
            signal.fail("ScreenCaptureKit returned no application-audio channels.");
        }
        return;
    }
    let Some(sample_value_count) = frame_count.checked_mul(channel_total) else {
        signal.fail("ScreenCaptureKit returned an application-audio buffer larger than the bounded queue supports.");
        return;
    };
    if sample_value_count > MAX_CAPTURE_CALLBACK_BYTES / 4 {
        signal.fail("ScreenCaptureKit returned a chunk larger than the bounded queue supports.");
        return;
    }
    let mut pcm = Vec::with_capacity(sample_value_count * 4);
    for frame in 0..frame_count {
        for (channel_count, samples) in &channels {
            let start = frame * channel_count;
            for sample in &samples[start..start + channel_count] {
                pcm.extend_from_slice(&sample.to_le_bytes());
            }
        }
    }
    let Ok(frame_count) = u64::try_from(frame_count) else {
        signal.fail("The application-audio track exceeded its supported frame count.");
        return;
    };
    let Some((sequence, first_sample_index)) = counters.next(frame_count) else {
        signal.fail("The application-audio track exceeded its supported sample timeline.");
        return;
    };
    let chunk = PcmChunk {
        track: TrackKind::ApplicationAudio,
        sequence,
        first_sample_index,
        frame_count,
        sample_rate_hz: APPLICATION_AUDIO_SAMPLE_RATE_HZ,
        channel_count: u16::try_from(channel_total).unwrap_or(APPLICATION_AUDIO_CHANNELS),
        sample_format: "pcm_f32le",
        gap_before_samples: 0,
        contains_device_discontinuity: false,
        pcm,
    };
    if let Err(error) = sender.try_send(chunk) {
        signal.fail(match error {
            TrySendError::Full(_) => {
                "Application-audio delivery fell behind the bounded capture queue."
            }
            TrySendError::Disconnected(_) => "Application-audio delivery has ended.",
        });
    }
}

#[cfg(target_os = "macos")]
pub(super) fn stop_application_audio_stream(stream: &mut NativeApplicationAudioStream) {
    if let Err(error) = stream.0.stop_capture() {
        // Capture may already have stopped after permission revocation or an app exit.
        let _ = error;
    }
}
