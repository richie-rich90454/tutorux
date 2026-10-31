use super::application_audio::ApplicationAudioCapture;
use super::model::{FinishedTrack, SynchronizedAudioFinished, TrackSignal, WorkerSummary};
use super::support::parse_capture_id;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
};
use uuid::Uuid;

#[derive(Default)]
pub struct SynchronizedAudioCaptureState(pub(super) Mutex<HashMap<Uuid, Arc<CaptureSession>>>);

pub(super) struct CaptureSession {
    pub(super) microphone_stream: Mutex<Option<cpal::Stream>>,
    pub(super) system_stream: Mutex<Option<cpal::Stream>>,
    pub(super) application_capture: Mutex<Option<ApplicationAudioCapture>>,
    pub(super) worker: Mutex<Option<JoinHandle<WorkerSummary>>>,
    pub(super) signals: [Arc<TrackSignal>; 3],
    pub(super) discarded: Arc<AtomicBool>,
    pub(super) activated: AtomicBool,
    pub(super) pause_id: Arc<AtomicU64>,
    pub(super) microphone_sample_rate_hz: u32,
    pub(super) system_sample_rate_hz: u32,
    pub(super) application_audio_sample_rate_hz: u32,
}

pub(super) fn close_session(session: &CaptureSession, discard: bool) -> Result<WorkerSummary, String> {
    if discard {
        session.discarded.store(true, Ordering::Release);
    }
    let microphone = lock_stream(&session.microphone_stream)?.take();
    let system_audio = lock_stream(&session.system_stream)?.take();
    let application_audio = lock_application_capture(&session.application_capture)?.take();
    drop(microphone);
    drop(system_audio);
    if let Some(mut capture) = application_audio {
        if !capture.stop() && !discard {
            session.signals[2]
                .fail("The application-audio source did not stop within the supported timeout.");
        }
    }
    let worker = session
        .worker
        .lock()
        .map_err(|_| "Native audio capture worker state is unavailable.".to_owned())?
        .take();
    match worker {
        Some(worker) => worker
            .join()
            .map_err(|_| "The native audio delivery worker stopped unexpectedly.".to_owned()),
        None => Ok(WorkerSummary::default()),
    }
}

pub(super) fn finished_result(
    session: &CaptureSession,
    summary: WorkerSummary,
) -> SynchronizedAudioFinished {
    let microphone_failure = session.signals[0].failure_message();
    let system_failure = session.signals[1].failure_message();
    let application_audio_failure = session.signals[2].failure_message();
    let [microphone, system_audio, application_audio] = summary.tracks;
    SynchronizedAudioFinished {
        microphone: FinishedTrack {
            sample_rate_hz: if microphone.sample_rate_hz == 0 {
                session.microphone_sample_rate_hz
            } else {
                microphone.sample_rate_hz
            },
            channel_count: microphone.channel_count,
            sample_format: microphone.sample_format.to_owned(),
            sample_count: microphone.sample_count.to_string(),
            byte_count: microphone.byte_count.to_string(),
            chunk_count: microphone.chunk_count,
            discontinuity_count: microphone.discontinuity_count,
            failure: microphone_failure,
        },
        system_audio: FinishedTrack {
            sample_rate_hz: if system_audio.sample_rate_hz == 0 {
                session.system_sample_rate_hz
            } else {
                system_audio.sample_rate_hz
            },
            channel_count: system_audio.channel_count,
            sample_format: system_audio.sample_format.to_owned(),
            sample_count: system_audio.sample_count.to_string(),
            byte_count: system_audio.byte_count.to_string(),
            chunk_count: system_audio.chunk_count,
            discontinuity_count: system_audio.discontinuity_count,
            failure: system_failure,
        },
        application_audio: FinishedTrack {
            sample_rate_hz: if application_audio.sample_rate_hz == 0 {
                session.application_audio_sample_rate_hz
            } else {
                application_audio.sample_rate_hz
            },
            channel_count: application_audio.channel_count,
            sample_format: application_audio.sample_format.to_owned(),
            sample_count: application_audio.sample_count.to_string(),
            byte_count: application_audio.byte_count.to_string(),
            chunk_count: application_audio.chunk_count,
            discontinuity_count: application_audio.discontinuity_count,
            failure: application_audio_failure,
        },
    }
}
pub(super) fn get_session(
    state: &SynchronizedAudioCaptureState,
    capture_id: &str,
) -> Result<Arc<CaptureSession>, String> {
    let id = parse_capture_id(capture_id)?;
    state
        .0
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_owned())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "The synchronized capture has ended.".to_owned())
}

pub(super) fn lock_stream(
    stream: &Mutex<Option<cpal::Stream>>,
) -> Result<std::sync::MutexGuard<'_, Option<cpal::Stream>>, String> {
    stream
        .lock()
        .map_err(|_| "Native audio stream state is unavailable.".to_owned())
}

pub(super) fn lock_application_capture(
    capture: &Mutex<Option<ApplicationAudioCapture>>,
) -> Result<std::sync::MutexGuard<'_, Option<ApplicationAudioCapture>>, String> {
    capture
        .lock()
        .map_err(|_| "Native application-audio state is unavailable.".to_owned())
}
