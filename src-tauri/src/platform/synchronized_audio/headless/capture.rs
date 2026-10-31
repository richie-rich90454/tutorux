use super::super::application_audio::ApplicationAudioCapture;
use super::super::capture::{build_capture_stream, sample_format_name, start_stream, validate_config};
use super::super::devices::{
    enumerate_devices, resolve_application_audio_target, resolve_device, system_audio_config,
};
use super::super::model::{
    PcmChunk, TrackKind, TrackSignal, APPLICATION_AUDIO_CHANNELS, APPLICATION_AUDIO_SAMPLE_RATE_HZ,
    MAX_QUEUED_CHUNKS_PER_TRACK,
};
use cpal::traits::{DeviceTrait, StreamTrait};
use std::sync::{
    mpsc::{self, Receiver, TryRecvError},
    Arc,
};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct HeadlessChunk {
    pub track: &'static str,
    pub sequence: u64,
    pub first_sample_index: u64,
    pub frame_count: u64,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub sample_format: &'static str,
    pub gap_before_samples: u64,
    pub contains_device_discontinuity: bool,
    pub pcm: Vec<u8>,
}

pub struct HeadlessCaptureStarted {
    pub capture_id: String,
    pub started_at_us: u64,
    pub microphone_sample_rate_hz: u32,
    pub microphone_channel_count: u16,
    pub microphone_sample_format: String,
    pub system_audio_sample_rate_hz: u32,
    pub system_audio_channel_count: u16,
    pub system_audio_sample_format: String,
    pub application_audio_sample_rate_hz: u32,
    pub application_audio_channel_count: u16,
    pub application_audio_sample_format: String,
    pub application_audio_device_id: Option<String>,
    pub application_audio_name: Option<String>,
    pub application_audio_process_id: Option<u32>,
    pub application_audio_backend: Option<String>,
    pub backend: String,
}

#[derive(Default, Clone)]
pub struct HeadlessTrackSummary {
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub sample_format: String,
    pub sample_count: u64,
    pub byte_count: u64,
    pub chunk_count: u64,
    pub discontinuity_count: u64,
    pub failure: Option<String>,
}

pub struct HeadlessFinished {
    pub microphone: HeadlessTrackSummary,
    pub system_audio: HeadlessTrackSummary,
    pub application_audio: HeadlessTrackSummary,
}

pub struct HeadlessCapture {
    id: String,
    microphone_stream: Option<cpal::Stream>,
    system_stream: Option<cpal::Stream>,
    application_capture: Option<ApplicationAudioCapture>,
    receivers: [Receiver<PcmChunk>; 3],
    signals: [Arc<TrackSignal>; 3],
    summaries: [HeadlessTrackSummary; 3],
    active: [bool; 3],
    started_at_us: u64,
    paused: bool,
}

pub fn begin_capture(
    capture_id: &str,
    microphone_device_id: Option<&str>,
    system_audio_device_id: Option<&str>,
    application_audio_device_id: Option<&str>,
) -> Result<(HeadlessCapture, HeadlessCaptureStarted), String> {
    if microphone_device_id.is_none()
        && system_audio_device_id.is_none()
        && application_audio_device_id.is_none()
    {
        return Err("Choose at least one native audio source.".to_owned());
    }
    if system_audio_device_id.is_some() && application_audio_device_id.is_some() {
        return Err("Choose either shared system audio or one application-audio source.".to_owned());
    }
    let devices = enumerate_devices()?;
    let (microphone_sender, microphone_receiver) = mpsc::sync_channel(MAX_QUEUED_CHUNKS_PER_TRACK);
    let (system_sender, system_receiver) = mpsc::sync_channel(MAX_QUEUED_CHUNKS_PER_TRACK);
    let (application_sender, application_receiver) =
        mpsc::sync_channel(MAX_QUEUED_CHUNKS_PER_TRACK);
    let signals = [
        Arc::new(TrackSignal::new()),
        Arc::new(TrackSignal::new()),
        Arc::new(TrackSignal::new()),
    ];
    let mut summaries = [
        HeadlessTrackSummary::default(),
        HeadlessTrackSummary::default(),
        HeadlessTrackSummary::default(),
    ];
    let mut active = [false; 3];

    let mut microphone_stream = None;
    if let Some(device_id) = microphone_device_id {
        if !devices
            .microphones
            .iter()
            .any(|device| device.device_id == device_id)
        {
            return Err("The selected microphone is no longer available.".to_owned());
        }
        let device = resolve_device(device_id)?;
        let config = device
            .default_input_config()
            .map_err(|error| format!("The selected microphone stream could not be opened: {error}"))?;
        validate_config(&config, "microphone")?;
        summaries[0] = summary_for(&config);
        active[0] = true;
        microphone_stream = Some(build_capture_stream(
            &device,
            config,
            TrackKind::Microphone,
            microphone_sender,
            Arc::clone(&signals[0]),
        )?);
    } else {
        drop(microphone_sender);
        signals[0].fail("Microphone capture was not requested.");
    }

    let mut system_stream = None;
    if let Some(device_id) = system_audio_device_id {
        if !devices
            .system_audio
            .iter()
            .any(|device| device.device_id == device_id)
        {
            return Err("The selected system-audio source is no longer available.".to_owned());
        }
        let device = resolve_device(device_id)?;
        let config = system_audio_config(&device)?;
        validate_config(&config, "system audio")?;
        summaries[1] = summary_for(&config);
        active[1] = true;
        system_stream = Some(build_capture_stream(
            &device,
            config,
            TrackKind::SystemAudio,
            system_sender,
            Arc::clone(&signals[1]),
        )?);
    } else {
        drop(system_sender);
        signals[1].fail("System-audio capture was not requested.");
    }

    let mut application_capture = None;
    let mut application_name = None;
    let mut application_process_id = None;
    let mut application_backend = None;
    if let Some(device_id) = application_audio_device_id {
        let target = resolve_application_audio_target(device_id, &devices.application_audio)?;
        application_name = Some(target.name.clone());
        application_process_id = Some(target.process_id);
        application_backend = Some(target.backend.to_owned());
        application_capture = Some(ApplicationAudioCapture::new(
            target,
            application_sender,
            Arc::clone(&signals[2]),
        )?);
        summaries[2] = HeadlessTrackSummary {
            sample_rate_hz: APPLICATION_AUDIO_SAMPLE_RATE_HZ,
            channel_count: APPLICATION_AUDIO_CHANNELS,
            sample_format: "pcm_f32le".to_owned(),
            ..HeadlessTrackSummary::default()
        };
        active[2] = true;
    } else {
        drop(application_sender);
        signals[2].fail("Application-audio capture was not requested.");
    }

    let mut capture = HeadlessCapture {
        id: capture_id.to_owned(),
        microphone_stream,
        system_stream,
        application_capture,
        receivers: [microphone_receiver, system_receiver, application_receiver],
        signals,
        summaries,
        active,
        started_at_us: now_unix_microseconds()?,
        paused: false,
    };
    capture.activate()?;
    let backend = microphone_device_id
        .map(|id| id.split_once(':').map_or("native", |(host, _)| host))
        .or_else(|| {
            system_audio_device_id
                .and_then(|id| id.split_once(':').map(|(host, _)| host))
        })
        .or(application_backend.as_deref())
        .unwrap_or("native")
        .to_owned();
    let started = HeadlessCaptureStarted {
        capture_id: capture.id.clone(),
        started_at_us: capture.started_at_us,
        microphone_sample_rate_hz: capture.summaries[0].sample_rate_hz,
        microphone_channel_count: capture.summaries[0].channel_count,
        microphone_sample_format: capture.summaries[0].sample_format.clone(),
        system_audio_sample_rate_hz: capture.summaries[1].sample_rate_hz,
        system_audio_channel_count: capture.summaries[1].channel_count,
        system_audio_sample_format: capture.summaries[1].sample_format.clone(),
        application_audio_sample_rate_hz: capture.summaries[2].sample_rate_hz,
        application_audio_channel_count: capture.summaries[2].channel_count,
        application_audio_sample_format: capture.summaries[2].sample_format.clone(),
        application_audio_device_id: application_audio_device_id.map(str::to_owned),
        application_audio_name: application_name,
        application_audio_process_id: application_process_id,
        application_audio_backend: application_backend,
        backend,
    };
    Ok((capture, started))
}

impl HeadlessCapture {
    fn activate(&mut self) -> Result<(), String> {
        let mut started_any = false;
        if self.active[0] {
            started_any |= start_stream(
                &mut self.microphone_stream,
                TrackKind::Microphone,
                &self.signals[0],
            );
        }
        if self.active[1] {
            started_any |= start_stream(
                &mut self.system_stream,
                TrackKind::SystemAudio,
                &self.signals[1],
            );
        }
        if let Some(capture) = self.application_capture.as_ref() {
            match capture.start() {
                Ok(()) => {
                    self.signals[2].arm();
                    started_any = true;
                }
                Err(error) => self.signals[2].fail(error),
            }
        }
        if !started_any {
            return Err("Neither audio source is available to start recording.".to_owned());
        }
        if self.active[0] && self.signals[0].failure_message().is_none() {
            self.signals[0].arm();
        }
        if self.active[1] && self.signals[1].failure_message().is_none() {
            self.signals[1].arm();
        }
        Ok(())
    }

    pub fn capture_id(&self) -> &str {
        &self.id
    }

    pub fn started_at_us(&self) -> u64 {
        self.started_at_us
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Drain queued chunks without blocking. Returns how many were delivered.
    pub fn drain(&mut self, sink: &mut dyn FnMut(HeadlessChunk)) -> usize {
        let mut delivered = 0usize;
        for index in 0..3 {
            loop {
                match self.receivers[index].try_recv() {
                    Ok(chunk) => {
                        accumulate_summary(&mut self.summaries[index], &chunk);
                        sink(HeadlessChunk {
                            track: chunk.track.as_str(),
                            sequence: chunk.sequence,
                            first_sample_index: chunk.first_sample_index,
                            frame_count: chunk.frame_count,
                            sample_rate_hz: chunk.sample_rate_hz,
                            channel_count: chunk.channel_count,
                            sample_format: chunk.sample_format,
                            gap_before_samples: chunk.gap_before_samples,
                            contains_device_discontinuity: chunk.contains_device_discontinuity,
                            pcm: chunk.pcm,
                        });
                        delivered += 1;
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => break,
                }
            }
        }
        delivered
    }

    pub fn pause(&mut self) -> Result<(), String> {
        if self.paused {
            return Ok(());
        }
        if self.active[0] && self.signals[0].failure_message().is_none() {
            if let Some(stream) = self.microphone_stream.as_ref() {
                stream
                    .pause()
                    .map_err(|error| format!("The microphone stream could not be paused: {error}"))?;
            }
        }
        if self.active[1] && self.signals[1].failure_message().is_none() {
            if let Some(stream) = self.system_stream.as_ref() {
                stream.pause().map_err(|error| {
                    format!("The system-audio stream could not be paused: {error}")
                })?;
            }
        }
        if self.active[2] && self.signals[2].failure_message().is_none() {
            if let Some(capture) = self.application_capture.as_ref() {
                capture.pause()?;
            }
        }
        self.paused = true;
        Ok(())
    }

    pub fn resume(&mut self) -> Result<(), String> {
        if !self.paused {
            return Ok(());
        }
        if self.active[0] && self.signals[0].failure_message().is_none() {
            if let Some(stream) = self.microphone_stream.as_ref() {
                self.signals[0].advance_stream_epoch();
                stream.play().map_err(|error| {
                    format!("The microphone stream could not be resumed: {error}")
                })?;
            }
        }
        if self.active[1] && self.signals[1].failure_message().is_none() {
            if let Some(stream) = self.system_stream.as_ref() {
                self.signals[1].advance_stream_epoch();
                stream.play().map_err(|error| {
                    format!("The system-audio stream could not be resumed: {error}")
                })?;
            }
        }
        if self.active[2] && self.signals[2].failure_message().is_none() {
            if let Some(capture) = self.application_capture.as_ref() {
                capture.resume()?;
                self.signals[2].arm();
            }
        }
        self.paused = false;
        Ok(())
    }

    pub fn finish(
        &mut self,
        sink: &mut dyn FnMut(HeadlessChunk),
    ) -> HeadlessFinished {
        drop(self.microphone_stream.take());
        drop(self.system_stream.take());
        if let Some(mut capture) = self.application_capture.take() {
            let _ = capture.stop();
        }
        // Give the device callbacks a moment to flush their final buffers.
        std::thread::sleep(std::time::Duration::from_millis(120));
        self.drain(sink);
        let failure = |index: usize| self.signals[index].failure_message();
        let mut result = HeadlessFinished {
            microphone: self.summaries[0].clone(),
            system_audio: self.summaries[1].clone(),
            application_audio: self.summaries[2].clone(),
        };
        result.microphone.failure = failure(0);
        result.system_audio.failure = failure(1);
        result.application_audio.failure = failure(2);
        result
    }
}

impl Drop for HeadlessCapture {
    fn drop(&mut self) {
        drop(self.microphone_stream.take());
        drop(self.system_stream.take());
        if let Some(mut capture) = self.application_capture.take() {
            let _ = capture.stop();
        }
    }
}

fn summary_for(config: &cpal::SupportedStreamConfig) -> HeadlessTrackSummary {
    HeadlessTrackSummary {
        sample_rate_hz: config.sample_rate(),
        channel_count: config.channels(),
        sample_format: sample_format_name(config.sample_format()).to_owned(),
        ..HeadlessTrackSummary::default()
    }
}

fn accumulate_summary(summary: &mut HeadlessTrackSummary, chunk: &PcmChunk) {
    summary.sample_rate_hz = chunk.sample_rate_hz;
    summary.channel_count = chunk.channel_count;
    summary.sample_format = chunk.sample_format.to_owned();
    summary.sample_count = summary.sample_count.saturating_add(chunk.frame_count);
    summary.byte_count = summary.byte_count.saturating_add(chunk.pcm.len() as u64);
    summary.chunk_count = summary.chunk_count.saturating_add(1);
    if chunk.contains_device_discontinuity {
        summary.discontinuity_count = summary.discontinuity_count.saturating_add(1);
    }
}

fn now_unix_microseconds() -> Result<u64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "The system clock is not available for recording metadata.".to_owned())?;
    u64::try_from(elapsed.as_micros())
        .map_err(|_| "The system clock is outside the supported recording range.".to_owned())
}
