use super::model::{
    PcmChunk, TrackKind, TrackSignal, DISCONTINUITY_TOLERANCE_DIVISOR, MAX_CAPTURE_CALLBACK_BYTES,
    MAX_CHANNELS, MAX_DISCONTINUITY_SECONDS, MAX_SAMPLE_RATE_HZ, MIN_SAMPLE_RATE_HZ,
};
use super::support::device_error;
use cpal::{
    traits::{DeviceTrait, StreamTrait},
    Data, Sample, SampleFormat, SizedSample, StreamInstant,
};
use std::sync::{
    atomic::Ordering,
    mpsc::{SyncSender, TrySendError},
    Arc,
};

pub(super) fn start_stream(
    stream: &mut Option<cpal::Stream>,
    track: TrackKind,
    signal: &TrackSignal,
) -> bool {
    let result = match stream.as_ref() {
        Some(stream) => {
            signal.advance_stream_epoch();
            stream.play()
        }
        None => return false,
    };
    match result {
        Ok(()) => true,
        Err(error) => {
            signal.fail(device_error(track.as_str(), error));
            stream.take();
            false
        }
    }
}

pub(super) fn build_capture_stream(
    device: &cpal::Device,
    config: cpal::SupportedStreamConfig,
    track: TrackKind,
    sender: SyncSender<PcmChunk>,
    signal: Arc<TrackSignal>,
) -> Result<cpal::Stream, String> {
    let channels = usize::from(config.channels());
    let sample_rate_hz = config.sample_rate();
    let sample_format = config.sample_format();
    let mut sequence = 0u64;
    let mut first_sample_index = 0u64;
    let mut discontinuity = DiscontinuityTracker::new(sample_rate_hz);
    let callback_signal = Arc::clone(&signal);
    let error_signal = Arc::clone(&signal);
    device
        .build_input_stream_raw(
            config.config(),
            sample_format,
            move |data: &Data, info: &cpal::InputCallbackInfo| {
                if !callback_signal.accepting.load(Ordering::Acquire) {
                    return;
                }
                let Some((pcm, sample_format)) = encode_pcm(data, channels) else {
                    callback_signal
                        .fail("The audio device returned a sample format that cannot be recorded.");
                    return;
                };
                let bytes_per_frame = data
                    .sample_format()
                    .sample_size()
                    .saturating_mul(channels);
                if bytes_per_frame == 0 || data.bytes().len() % bytes_per_frame != 0 {
                    callback_signal.fail("The audio device returned an incomplete PCM frame.");
                    return;
                }
                let frame_count = (data.bytes().len() / bytes_per_frame) as u64;
                if frame_count == 0 {
                    return;
                }
                if pcm.len() > MAX_CAPTURE_CALLBACK_BYTES {
                    callback_signal.fail(
                        "The audio device returned a callback larger than the bounded capture queue supports.",
                    );
                    return;
                }
                let epoch = callback_signal.stream_epoch.load(Ordering::Acquire);
                let Some((gap_before_samples, contains_device_discontinuity)) =
                    discontinuity.observe(info.timestamp().callback, frame_count, epoch)
                else {
                    callback_signal.fail(
                        "The audio device dropped more than the supported 10-second audio gap.",
                    );
                    return;
                };
                let Some(next_sample_index) = first_sample_index
                    .checked_add(gap_before_samples)
                    .and_then(|start| start.checked_add(frame_count))
                else {
                    callback_signal.fail("The audio track exceeded its supported sample timeline.");
                    return;
                };
                let Some(chunk_first_sample_index) =
                    first_sample_index.checked_add(gap_before_samples)
                else {
                    callback_signal.fail("The audio track exceeded its supported sample timeline.");
                    return;
                };
                let Some(next_sequence) = sequence.checked_add(1) else {
                    callback_signal.fail("The audio track exceeded its supported chunk count.");
                    return;
                };
                let chunk = PcmChunk {
                    track,
                    sequence,
                    first_sample_index: chunk_first_sample_index,
                    frame_count,
                    sample_rate_hz,
                    channel_count: config.channels(),
                    sample_format,
                    gap_before_samples,
                    contains_device_discontinuity,
                    pcm,
                };
                match sender.try_send(chunk) {
                    Ok(()) => {
                        first_sample_index = next_sample_index;
                        sequence = next_sequence;
                    }
                    Err(TrySendError::Full(_)) => {
                        callback_signal.fail(format!(
                            "{} capture delivery fell behind. The other audio track can continue.",
                            if track == TrackKind::Microphone {
                                "Microphone"
                            } else if track == TrackKind::SystemAudio {
                                "System audio"
                            } else {
                                "Application audio"
                            }
                        ));
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        callback_signal.accepting.store(false, Ordering::Release);
                    }
                }
            },
            move |error| {
                error_signal.fail(device_error(track.as_str(), error));
            },
            None,
        )
        .map_err(|error| device_error(track.as_str(), error))
}

pub(super) struct DiscontinuityTracker {
    sample_rate_hz: u32,
    epoch: u64,
    anchor: Option<StreamInstant>,
    frames_seen: u64,
}

impl DiscontinuityTracker {
    pub(super) fn new(sample_rate_hz: u32) -> Self {
        Self {
            sample_rate_hz,
            epoch: 0,
            anchor: None,
            frames_seen: 0,
        }
    }

    /// Returns the missing frames before this callback and whether the callback timeline jumped.
    /// `None` when the gap exceeds the bounded recovery window.
    pub(super) fn observe(&mut self, at: StreamInstant, frames: u64, epoch: u64) -> Option<(u64, bool)> {
        if self.anchor.is_none() || self.epoch != epoch {
            self.epoch = epoch;
            self.anchor = Some(at);
            self.frames_seen = frames;
            return Some((0, false));
        }
        let Some(anchor) = self.anchor else {
            return Some((0, false));
        };
        let Some(elapsed) = at.checked_duration_since(anchor) else {
            self.anchor = Some(at);
            self.frames_seen = frames;
            return Some((0, false));
        };
        let projected = elapsed.as_secs_f64() * f64::from(self.sample_rate_hz);
        let lag = projected - self.frames_seen as f64;
        let tolerance = f64::from((self.sample_rate_hz / DISCONTINUITY_TOLERANCE_DIVISOR).max(1));
        let gap = if lag > tolerance {
            lag.round() as u64
        } else {
            0
        };
        if gap > u64::from(self.sample_rate_hz) * MAX_DISCONTINUITY_SECONDS {
            return None;
        }
        self.frames_seen = self.frames_seen.saturating_add(frames).saturating_add(gap);
        Some((gap, gap > 0))
    }
}

fn encode_pcm(data: &Data, channels: usize) -> Option<(Vec<u8>, &'static str)> {
    if channels == 0 {
        return None;
    }
    match data.sample_format() {
        SampleFormat::F32 => Some((encode_f32(data.as_slice::<f32>()?), "pcm_f32le")),
        SampleFormat::F64 => Some((
            encode_f32(&convert_to_f32(data.as_slice::<f64>()?)),
            "pcm_f32le",
        )),
        SampleFormat::I16 => Some((encode_i16(data.as_slice::<i16>()?), "pcm_s16le")),
        SampleFormat::I8 => Some((
            encode_i16(&convert_to_i16(data.as_slice::<i8>()?)),
            "pcm_s16le",
        )),
        SampleFormat::U16 => Some((
            encode_i16(&convert_to_i16(data.as_slice::<u16>()?)),
            "pcm_s16le",
        )),
        SampleFormat::I32 => Some((encode_i32(data.as_slice::<i32>()?), "pcm_s32le")),
        SampleFormat::I24 => Some((
            encode_i32(&convert_to_i32(data.as_slice::<cpal::I24>()?)),
            "pcm_s32le",
        )),
        SampleFormat::U24 => Some((
            encode_i32(&convert_to_i32(data.as_slice::<cpal::U24>()?)),
            "pcm_s32le",
        )),
        SampleFormat::I64 => Some((
            encode_i32(&convert_to_i32(data.as_slice::<i64>()?)),
            "pcm_s32le",
        )),
        SampleFormat::U32 => Some((
            encode_i32(&convert_to_i32(data.as_slice::<u32>()?)),
            "pcm_s32le",
        )),
        SampleFormat::U64 => Some((
            encode_i32(&convert_to_i32(data.as_slice::<u64>()?)),
            "pcm_s32le",
        )),
        SampleFormat::U8 => Some((data.as_slice::<u8>()?.to_vec(), "pcm_u8")),
        SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32 => None,
        _ => None,
    }
}

pub(super) fn encode_f32(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len().saturating_mul(4));
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

pub(super) fn encode_i16(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len().saturating_mul(2));
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

fn encode_i32(samples: &[i32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len().saturating_mul(4));
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

fn convert_to_f32<T: Sample + SizedSample>(samples: &[T]) -> Vec<f32>
where
    f32: cpal::FromSample<T>,
{
    samples
        .iter()
        .map(|sample| sample.to_sample::<f32>())
        .collect()
}

fn convert_to_i16<T: Sample + SizedSample>(samples: &[T]) -> Vec<i16>
where
    i16: cpal::FromSample<T>,
{
    samples
        .iter()
        .map(|sample| sample.to_sample::<i16>())
        .collect()
}

fn convert_to_i32<T: Sample + SizedSample>(samples: &[T]) -> Vec<i32>
where
    i32: cpal::FromSample<T>,
{
    samples
        .iter()
        .map(|sample| sample.to_sample::<i32>())
        .collect()
}

pub(super) fn sample_format_name(format: SampleFormat) -> &'static str {
    match format {
        SampleFormat::F32 | SampleFormat::F64 => "pcm_f32le",
        SampleFormat::I16 | SampleFormat::I8 | SampleFormat::U16 => "pcm_s16le",
        SampleFormat::I32
        | SampleFormat::I24
        | SampleFormat::U24
        | SampleFormat::I64
        | SampleFormat::U32
        | SampleFormat::U64 => "pcm_s32le",
        SampleFormat::U8 => "pcm_u8",
        SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32 => "unsupported",
        _ => "pcm_s16le",
    }
}

pub(super) fn validate_config(config: &cpal::SupportedStreamConfig, source: &str) -> Result<(), String> {
    let rate = config.sample_rate();
    if !(MIN_SAMPLE_RATE_HZ..=MAX_SAMPLE_RATE_HZ).contains(&rate) {
        return Err(format!(
            "The {source} device selected an unsupported sample rate."
        ));
    }
    if config.channels() == 0 || config.channels() > MAX_CHANNELS {
        return Err(format!(
            "The {source} device selected an unsupported channel count."
        ));
    }
    Ok(())
}
