use super::super::model::{
    ApplicationAudioCounters, PcmChunk, TrackKind, TrackSignal, APPLICATION_AUDIO_CHANNELS,
    APPLICATION_AUDIO_SAMPLE_RATE_HZ, MAX_CAPTURE_CALLBACK_BYTES, MAX_DISCONTINUITY_SECONDS,
    MAX_QUEUED_CHUNKS_PER_TRACK,
};
use super::{ApplicationAudioTarget, NativeApplicationAudioStream};
use std::sync::{
    atomic::Ordering,
    mpsc::{SyncSender, TrySendError},
    Arc,
};

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(super) fn start_application_audio_stream(
    target: &ApplicationAudioTarget,
    _sender: SyncSender<PcmChunk>,
    _signal: Arc<TrackSignal>,
    _counters: Arc<ApplicationAudioCounters>,
) -> Result<NativeApplicationAudioStream, String> {
    let mut stream = flexaudio::open(flexaudio::StreamConfig {
        kind: flexaudio::SourceKind::ProcessLoopback,
        target_pid: Some(target.process_id),
        output: flexaudio::OutputFormat {
            sample_rate: APPLICATION_AUDIO_SAMPLE_RATE_HZ,
            channels: APPLICATION_AUDIO_CHANNELS,
        },
        ring_capacity_chunks: MAX_QUEUED_CHUNKS_PER_TRACK,
        silence_probe: false,
        ..Default::default()
    })
    .map_err(|error| format!("The selected application audio could not be opened: {error}"))?;
    stream
        .start()
        .map_err(|error| format!("The selected application audio could not be started: {error}"))?;
    Ok(NativeApplicationAudioStream(stream))
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(super) fn poll_process_audio(
    stream: &mut flexaudio::Stream,
    sender: &SyncSender<PcmChunk>,
    signal: &TrackSignal,
    counters: &ApplicationAudioCounters,
    expected_backend_frame_index: &mut Option<u64>,
) {
    while let Some(chunk) = stream.poll_chunk() {
        if !signal.accepting.load(Ordering::Acquire) {
            continue;
        }
        let channels = usize::from(APPLICATION_AUDIO_CHANNELS);
        let Some(frame_count) = usize::try_from(chunk.frames).ok() else {
            signal.fail("The application-audio backend returned an invalid PCM frame count.");
            continue;
        };
        if frame_count == 0 || frame_count.checked_mul(channels) != Some(chunk.data.len()) {
            signal.fail("The application-audio backend returned an incomplete PCM frame.");
            continue;
        }
        let Ok(frame_count_u64) = u64::try_from(frame_count) else {
            signal.fail("The application-audio backend exceeded its supported frame count.");
            continue;
        };
        let Some(next_backend_frame_index) = chunk.frame_index.checked_add(frame_count_u64) else {
            signal.fail("The application-audio backend exceeded its supported frame timeline.");
            continue;
        };
        let (gap_before_samples, contains_device_discontinuity) =
            match *expected_backend_frame_index {
                Some(expected) if chunk.frame_index > expected => {
                    (chunk.frame_index - expected, true)
                }
                Some(expected) => (0, chunk.frame_index != expected),
                None => (0, false),
            };
        if gap_before_samples
            > u64::from(APPLICATION_AUDIO_SAMPLE_RATE_HZ) * MAX_DISCONTINUITY_SECONDS
        {
            signal.fail(
                "The application-audio backend dropped more than the supported 10-second audio gap.",
            );
            continue;
        }
        *expected_backend_frame_index = Some(next_backend_frame_index);
        let mut pcm = Vec::with_capacity(chunk.data.len().saturating_mul(4));
        for sample in &chunk.data {
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        if pcm.len() > MAX_CAPTURE_CALLBACK_BYTES {
            signal.fail("The application-audio backend returned a chunk larger than the bounded queue supports.");
            continue;
        }
        let Some((sequence, previous_sample_index)) =
            counters.next(frame_count_u64.saturating_add(gap_before_samples))
        else {
            signal.fail("The application-audio track exceeded its supported sample timeline.");
            continue;
        };
        let Some(first_sample_index) = previous_sample_index.checked_add(gap_before_samples) else {
            signal.fail("The application-audio track exceeded its supported sample timeline.");
            continue;
        };
        let pcm = PcmChunk {
            track: TrackKind::ApplicationAudio,
            sequence,
            first_sample_index,
            frame_count: frame_count_u64,
            sample_rate_hz: APPLICATION_AUDIO_SAMPLE_RATE_HZ,
            channel_count: APPLICATION_AUDIO_CHANNELS,
            sample_format: "pcm_f32le",
            gap_before_samples,
            contains_device_discontinuity,
            pcm,
        };
        if let Err(error) = sender.try_send(pcm) {
            signal.fail(match error {
                TrySendError::Full(_) => {
                    "Application-audio delivery fell behind the bounded capture queue."
                }
                TrySendError::Disconnected(_) => "Application-audio delivery has ended.",
            });
            break;
        }
    }
    if let Some(error) = stream.terminal_error() {
        signal.fail(format!("The application-audio source stopped: {error}"));
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(super) fn stop_application_audio_stream(stream: &mut NativeApplicationAudioStream) {
    stream.0.stop();
}
