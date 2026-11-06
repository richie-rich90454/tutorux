use super::capture::start_stream;
use super::model::{SynchronizedAudioFinished, TrackKind};
use super::session::{
    close_session, finished_result, get_session, lock_application_capture, lock_stream,
    SynchronizedAudioCaptureState,
};
use super::support::{device_error, main_window, parse_capture_id};
use cpal::traits::StreamTrait;
use std::sync::atomic::Ordering;
use tauri::WebviewWindow;

pub(super) fn activate(
    window: &WebviewWindow,
    state: &SynchronizedAudioCaptureState,
    capture_id: String,
) -> Result<(), String> {
    main_window(window)?;
    let session = get_session(state, &capture_id)?;
    if session.activated.load(Ordering::Acquire) {
        return Err("The synchronized capture has already started.".into());
    }
    let mut microphone = lock_stream(&session.microphone_stream)?;
    let mut system_audio = lock_stream(&session.system_stream)?;
    let application_capture = lock_application_capture(&session.application_capture)?;
    let microphone_started =
        start_stream(&mut microphone, TrackKind::Microphone, &session.signals[0]);
    let system_audio_started = start_stream(
        &mut system_audio,
        TrackKind::SystemAudio,
        &session.signals[1],
    );
    let application_audio_started = match application_capture.as_ref() {
        Some(capture) => match capture.start() {
            Ok(()) => true,
            Err(error) => {
                session.signals[2].fail(error);
                false
            }
        },
        None => false,
    };
    if !microphone_started && !system_audio_started && !application_audio_started {
        return Err("Neither audio source is available to start recording.".into());
    }
    // Opening a stream is not enough to start capture. Defer play() until the frontend has
    // durably committed the take and track metadata, then accept samples only from streams that
    // actually started successfully.
    if microphone_started {
        session.signals[0].arm();
    }
    if system_audio_started {
        session.signals[1].arm();
    }
    if application_audio_started {
        session.signals[2].arm();
    }
    session.activated.store(true, Ordering::Release);
    Ok(())
}

pub(super) fn pause(
    window: &WebviewWindow,
    state: &SynchronizedAudioCaptureState,
    capture_id: String,
    pause_id: u64,
) -> Result<(), String> {
    main_window(window)?;
    let session = get_session(state, &capture_id)?;
    if !session.activated.load(Ordering::Acquire) || pause_id == 0 {
        return Err("The synchronized capture cannot be paused now.".into());
    }
    let microphone = lock_stream(&session.microphone_stream)?;
    let system_audio = lock_stream(&session.system_stream)?;
    let application_capture = lock_application_capture(&session.application_capture)?;
    let mut paused_microphone = false;
    if let Some(stream) = microphone
        .as_ref()
        .filter(|_| session.signals[0].failure_message().is_none())
    {
        stream
            .pause()
            .map_err(|error| device_error("microphone", error))?;
        paused_microphone = true;
    }
    if let Some(stream) = system_audio
        .as_ref()
        .filter(|_| session.signals[1].failure_message().is_none())
    {
        if let Err(error) = stream.pause() {
            if paused_microphone {
                if let Some(stream) = microphone.as_ref() {
                    if let Err(rollback_error) = stream.play() {
                        session.signals[0].fail(device_error("microphone", rollback_error));
                    }
                }
            }
            return Err(device_error("system audio", error));
        }
    }
    let app_was_running =
        application_capture.is_some() && session.signals[2].failure_message().is_none();
    if app_was_running {
        if let Some(capture) = application_capture.as_ref() {
            if let Err(error) = capture.pause() {
                if paused_microphone {
                    if let Some(stream) = microphone.as_ref() {
                        if let Err(rollback_error) = stream.play() {
                            session.signals[0].fail(device_error("microphone", rollback_error));
                        }
                    }
                }
                if system_audio.is_some() && session.signals[1].failure_message().is_none() {
                    if let Some(stream) = system_audio.as_ref() {
                        if let Err(rollback_error) = stream.play() {
                            session.signals[1].fail(device_error("system audio", rollback_error));
                        }
                    }
                }
                return Err(error);
            }
        }
    }
    let system_was_running =
        system_audio.is_some() && session.signals[1].failure_message().is_none();
    if !paused_microphone && !system_was_running && !app_was_running {
        return Err("The synchronized capture has ended.".into());
    }
    session.pause_id.store(pause_id, Ordering::Release);
    Ok(())
}

pub(super) fn resume(
    window: &WebviewWindow,
    state: &SynchronizedAudioCaptureState,
    capture_id: String,
) -> Result<(), String> {
    main_window(window)?;
    let session = get_session(state, &capture_id)?;
    if !session.activated.load(Ordering::Acquire) {
        return Err("The synchronized capture has not started.".into());
    }
    let microphone = lock_stream(&session.microphone_stream)?;
    let system_audio = lock_stream(&session.system_stream)?;
    let application_capture = lock_application_capture(&session.application_capture)?;
    let mut resumed_microphone = false;
    if let Some(stream) = microphone
        .as_ref()
        .filter(|_| session.signals[0].failure_message().is_none())
    {
        session.signals[0].advance_stream_epoch();
        stream
            .play()
            .map_err(|error| device_error("microphone", error))?;
        resumed_microphone = true;
    }
    if let Some(stream) = system_audio
        .as_ref()
        .filter(|_| session.signals[1].failure_message().is_none())
    {
        session.signals[1].advance_stream_epoch();
        if let Err(error) = stream.play() {
            if resumed_microphone {
                if let Some(stream) = microphone.as_ref() {
                    if let Err(rollback_error) = stream.pause() {
                        session.signals[0].fail(device_error("microphone", rollback_error));
                    }
                }
            }
            return Err(device_error("system audio", error));
        }
    }
    let mut resumed_application_audio = false;
    if let Some(capture) = application_capture
        .as_ref()
        .filter(|_| session.signals[2].failure_message().is_none())
    {
        match capture.resume() {
            Ok(()) => resumed_application_audio = true,
            Err(error) => {
                if resumed_microphone {
                    if let Some(stream) = microphone.as_ref() {
                        if let Err(rollback_error) = stream.pause() {
                            session.signals[0].fail(device_error("microphone", rollback_error));
                        }
                    }
                }
                if system_audio.is_some() && session.signals[1].failure_message().is_none() {
                    if let Some(stream) = system_audio.as_ref() {
                        if let Err(rollback_error) = stream.pause() {
                            session.signals[1].fail(device_error("system audio", rollback_error));
                        }
                    }
                }
                return Err(error);
            }
        }
    }
    if !resumed_microphone
        && (system_audio.is_none() || session.signals[1].failure_message().is_some())
        && !resumed_application_audio
    {
        return Err("The synchronized capture has ended.".into());
    }
    if resumed_application_audio {
        session.signals[2].arm();
    }
    session.pause_id.store(0, Ordering::Release);
    Ok(())
}

pub(super) fn stop_source(
    window: &WebviewWindow,
    state: &SynchronizedAudioCaptureState,
    capture_id: String,
    track: String,
    message: String,
) -> Result<(), String> {
    main_window(window)?;
    let session = get_session(state, &capture_id)?;
    let reason = if message.trim().is_empty() {
        "The audio source stopped because archive writing could not keep up.".to_owned()
    } else {
        message
    };
    match track.as_str() {
        "microphone" | "system-audio" => {
            let index = if track == "microphone" { 0 } else { 1 };
            let stream = if index == 0 {
                &session.microphone_stream
            } else {
                &session.system_stream
            };
            session.signals[index].fail(reason);
            if let Some(stream) = lock_stream(stream)?.take() {
                let _ = stream.pause();
                drop(stream);
            }
        }
        "application-audio" => {
            session.signals[2].fail(reason);
            if let Some(mut capture) =
                lock_application_capture(&session.application_capture)?.take()
            {
                capture.stop();
            }
        }
        _ => return Err("The synchronized audio source is invalid.".into()),
    }
    Ok(())
}

pub(super) fn finish(
    window: &WebviewWindow,
    state: &SynchronizedAudioCaptureState,
    capture_id: String,
) -> Result<SynchronizedAudioFinished, String> {
    main_window(window)?;
    let id = parse_capture_id(&capture_id)?;
    let session = state
        .0
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_owned())?
        .remove(&id)
        .ok_or_else(|| "The synchronized capture has ended.".to_owned())?;
    let summary = close_session(&session, false)?;
    Ok(finished_result(&session, summary))
}

pub(super) fn discard(
    window: &WebviewWindow,
    state: &SynchronizedAudioCaptureState,
    capture_id: String,
) -> Result<(), String> {
    main_window(window)?;
    let id = parse_capture_id(&capture_id)?;
    let session = state
        .0
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_owned())?
        .remove(&id);
    if let Some(session) = session {
        close_session(&session, true)?;
    }
    Ok(())
}
