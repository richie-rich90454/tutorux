use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

pub(super) const MAX_QUEUED_CHUNKS_PER_TRACK: usize = 8;
pub(super) const MAX_CAPTURE_CALLBACK_BYTES: usize = 256 * 1024;
pub(super) const MAX_SAMPLE_RATE_HZ: u32 = 384_000;
pub(super) const MIN_SAMPLE_RATE_HZ: u32 = 8_000;
pub(super) const MAX_CHANNELS: u16 = 8;
pub(super) const MAX_DISCONTINUITY_SECONDS: u64 = 10;
pub(super) const DISCONTINUITY_TOLERANCE_DIVISOR: u32 = 200;
pub(super) const CHUNK_EVENT: &str = "synchronized-audio-chunk";
pub(super) const FAILURE_EVENT: &str = "synchronized-audio-source-failed";
pub(super) const PAUSE_DRAINED_EVENT: &str = "synchronized-audio-pause-drained";
pub(super) const APPLICATION_AUDIO_SAMPLE_RATE_HZ: u32 = 48_000;
pub(super) const APPLICATION_AUDIO_CHANNELS: u16 = 2;
pub(super) static APPLICATION_AUDIO_DISCOVERY_RUNNING: AtomicBool = AtomicBool::new(false);

pub(super) struct TrackSignal {
    pub(super) accepting: AtomicBool,
    pub(super) failure_sent: AtomicBool,
    pub(super) failure: Mutex<Option<String>>,
    pub(super) stream_epoch: AtomicU64,
}

impl TrackSignal {
    pub(super) fn new() -> Self {
        Self {
            accepting: AtomicBool::new(false),
            failure_sent: AtomicBool::new(false),
            failure: Mutex::new(None),
            stream_epoch: AtomicU64::new(0),
        }
    }

    pub(super) fn fail(&self, message: impl Into<String>) {
        self.accepting.store(false, Ordering::Release);
        if let Ok(mut failure) = self.failure.lock() {
            if failure.is_none() {
                *failure = Some(message.into());
            }
        }
    }

    pub(super) fn failure_message(&self) -> Option<String> {
        self.failure.lock().ok()?.clone()
    }

    pub(super) fn arm(&self) {
        if self.failure_message().is_none() {
            self.accepting.store(true, Ordering::Release);
        }
    }

    pub(super) fn advance_stream_epoch(&self) -> u64 {
        self.stream_epoch
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum TrackKind {
    Microphone,
    SystemAudio,
    ApplicationAudio,
}

impl TrackKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::SystemAudio => "system-audio",
            Self::ApplicationAudio => "application-audio",
        }
    }
}

pub(super) struct PcmChunk {
    pub(super) track: TrackKind,
    pub(super) sequence: u64,
    pub(super) first_sample_index: u64,
    pub(super) frame_count: u64,
    pub(super) sample_rate_hz: u32,
    pub(super) channel_count: u16,
    pub(super) sample_format: &'static str,
    pub(super) gap_before_samples: u64,
    pub(super) contains_device_discontinuity: bool,
    pub(super) pcm: Vec<u8>,
}

#[derive(Clone)]
pub(super) struct ApplicationAudioTarget {
    pub(super) process_id: u32,
    pub(super) name: String,
    pub(super) bundle_id: Option<String>,
    pub(super) backend: &'static str,
}

pub(super) struct ApplicationAudioCounters {
    pub(super) sequence: AtomicU64,
    pub(super) first_sample_index: AtomicU64,
}

impl ApplicationAudioCounters {
    pub(super) fn new() -> Self {
        Self {
            sequence: AtomicU64::new(0),
            first_sample_index: AtomicU64::new(0),
        }
    }

    pub(super) fn next(&self, frame_count: u64) -> Option<(u64, u64)> {
        let sequence = self
            .sequence
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .ok()?;
        let first_sample_index = self
            .first_sample_index
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(frame_count)
            })
            .ok()?;
        Some((sequence, first_sample_index))
    }
}
#[derive(Default)]
pub(super) struct TrackSummary {
    pub(super) sample_rate_hz: u32,
    pub(super) sample_count: u64,
    pub(super) byte_count: u64,
    pub(super) chunk_count: u64,
    pub(super) channel_count: u16,
    pub(super) sample_format: &'static str,
    pub(super) discontinuity_count: u64,
}

#[derive(Default)]
pub(super) struct WorkerSummary {
    pub(super) tracks: [TrackSummary; 3],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynchronizedAudioDevice {
    pub(super) device_id: String,
    pub(super) label: String,
    pub(super) backend: String,
    pub(super) source: String,
    pub(super) is_default: bool,
    pub(super) process_id: Option<u32>,
    pub(super) application_name: Option<String>,
    pub(super) bundle_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynchronizedAudioDevices {
    pub(super) microphones: Vec<SynchronizedAudioDevice>,
    pub(super) system_audio: Vec<SynchronizedAudioDevice>,
    pub(super) application_audio: Vec<SynchronizedAudioDevice>,
    pub(super) microphone_available: bool,
    pub(super) system_audio_available: bool,
    pub(super) application_audio_available: bool,
    pub(super) system_audio_unavailable_reason: Option<String>,
    pub(super) application_audio_unavailable_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynchronizedAudioStarted {
    pub(super) capture_id: String,
    pub(super) started_at_us: String,
    pub(super) consent_at_us: String,
    pub(super) microphone_sample_rate_hz: u32,
    pub(super) microphone_channel_count: u16,
    pub(super) microphone_sample_format: String,
    pub(super) system_audio_sample_rate_hz: u32,
    pub(super) system_audio_channel_count: u16,
    pub(super) system_audio_sample_format: String,
    pub(super) application_audio_sample_rate_hz: u32,
    pub(super) application_audio_channel_count: u16,
    pub(super) application_audio_sample_format: String,
    pub(super) application_audio_device_id: Option<String>,
    pub(super) application_audio_name: Option<String>,
    pub(super) application_audio_process_id: Option<u32>,
    pub(super) application_audio_bundle_id: Option<String>,
    pub(super) application_audio_backend: Option<String>,
    pub(super) backend: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SynchronizedAudioChunkEvent {
    pub(super) capture_id: String,
    pub(super) track: String,
    pub(super) sequence: u64,
    pub(super) first_sample_index: String,
    pub(super) frame_count: String,
    pub(super) sample_rate_hz: u32,
    pub(super) channel_count: u16,
    pub(super) sample_format: &'static str,
    pub(super) gap_before_samples: String,
    pub(super) contains_device_discontinuity: bool,
    pub(super) pcm_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SynchronizedAudioFailureEvent {
    pub(super) capture_id: String,
    pub(super) track: String,
    pub(super) message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SynchronizedAudioPauseDrainedEvent {
    pub(super) capture_id: String,
    pub(super) pause_id: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FinishedTrack {
    pub(super) sample_rate_hz: u32,
    pub(super) channel_count: u16,
    pub(super) sample_format: String,
    pub(super) sample_count: String,
    pub(super) byte_count: String,
    pub(super) chunk_count: u64,
    pub(super) discontinuity_count: u64,
    pub(super) failure: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynchronizedAudioFinished {
    pub(super) microphone: FinishedTrack,
    pub(super) system_audio: FinishedTrack,
    pub(super) application_audio: FinishedTrack,
}
