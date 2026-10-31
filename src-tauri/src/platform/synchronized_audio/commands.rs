use super::application_audio::ApplicationAudioCapture;
use super::capture::{build_capture_stream, sample_format_name, validate_config};
use super::devices::{
    enumerate_devices, resolve_application_audio_target, resolve_device, system_audio_config,
};
use super::model::{
    SynchronizedAudioDevices, SynchronizedAudioStarted, TrackKind, TrackSignal,
    APPLICATION_AUDIO_CHANNELS, APPLICATION_AUDIO_SAMPLE_RATE_HZ, MAX_QUEUED_CHUNKS_PER_TRACK,
};
use super::session::{CaptureSession, SynchronizedAudioCaptureState};
use super::support::{
    application_audio_unavailable_message, device_error, main_window, now_unix_microseconds,
    system_audio_unavailable_message,
};
use super::worker::emit_audio_chunks;
use cpal::traits::DeviceTrait;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64},
        mpsc, Arc, Mutex,
    },
    thread,
};
use tauri::WebviewWindow;
use uuid::Uuid;

pub(super) fn list_devices(window: &WebviewWindow) -> Result<SynchronizedAudioDevices, String> {
    main_window(window)?;
    enumerate_devices()
}

pub(super) fn begin(
    window: &WebviewWindow,
    state: &SynchronizedAudioCaptureState,
    capture_id: String,
    consent_confirmed: bool,
    consent_at_us: String,
    microphone_device_id: String,
    system_audio_device_id: Option<String>,
    application_audio_device_id: Option<String>,
) -> Result<SynchronizedAudioStarted, String> {
    main_window(window)?;
    if !consent_confirmed {
        return Err(
            "Confirm that everyone being recorded has agreed before starting capture.".into(),
        );
    }
    let consent_at = consent_at_us
        .parse::<u64>()
        .map_err(|_| "The recording consent timestamp is invalid.".to_owned())?;
    let id = Uuid::parse_str(&capture_id)
        .map_err(|_| "The synchronized capture identifier is invalid.".to_owned())?;
    let devices = enumerate_devices()?;
    if !devices
        .microphones
        .iter()
        .any(|device| device.device_id == microphone_device_id)
    {
        return Err("The selected microphone is no longer available.".into());
    }
    let system_audio_device_id =
        system_audio_device_id.filter(|device_id| !device_id.trim().is_empty());
    let application_audio_device_id =
        application_audio_device_id.filter(|device_id| !device_id.trim().is_empty());
    if system_audio_device_id.is_some() && application_audio_device_id.is_some() {
        return Err("Choose either shared system audio or one application-audio source.".into());
    }
    let application_audio_target = application_audio_device_id
        .as_deref()
        .map(|device_id| resolve_application_audio_target(device_id, &devices.application_audio))
        .transpose()?;
    let mut captures = state
        .0
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_owned())?;
    if captures.contains_key(&id) {
        return Err("This synchronized capture identifier is already in use.".into());
    }
    if !captures.is_empty() {
        return Err("A synchronized audio recording is already active.".into());
    }

    let request_at_us = now_unix_microseconds()?;
    if consent_at > request_at_us {
        return Err("The consent timestamp is later than the recording start.".into());
    }
    let (microphone_sender, microphone_receiver) = mpsc::sync_channel(MAX_QUEUED_CHUNKS_PER_TRACK);
    let (system_sender, system_receiver) = mpsc::sync_channel(MAX_QUEUED_CHUNKS_PER_TRACK);
    let (application_sender, application_receiver) =
        mpsc::sync_channel(MAX_QUEUED_CHUNKS_PER_TRACK);
    let signals = [
        Arc::new(TrackSignal::new()),
        Arc::new(TrackSignal::new()),
        Arc::new(TrackSignal::new()),
    ];

    let (
        microphone_stream,
        microphone_sample_rate_hz,
        microphone_channel_count,
        microphone_sample_format,
    ) = match resolve_device(&microphone_device_id).and_then(|device| {
        let config = device
            .default_input_config()
            .map_err(|error| device_error("microphone", error))?;
        validate_config(&config, "microphone")?;
        let sample_rate_hz = config.sample_rate();
        let stream = build_capture_stream(
            &device,
            config.clone(),
            TrackKind::Microphone,
            microphone_sender,
            Arc::clone(&signals[0]),
        )?;
        Ok((
            stream,
            sample_rate_hz,
            config.channels(),
            sample_format_name(config.sample_format()),
        ))
    }) {
        Ok((stream, sample_rate_hz, channel_count, sample_format)) => {
            (Some(stream), sample_rate_hz, channel_count, sample_format)
        }
        Err(error) => {
            signals[0].fail(error);
            (None, 0, 0, "")
        }
    };
    let (system_stream, system_sample_rate_hz, system_channel_count, system_sample_format) =
        match system_audio_device_id {
            Some(device_id) => match enumerate_devices()
                .and_then(|devices| {
                    if !devices
                        .system_audio
                        .iter()
                        .any(|device| device.device_id == device_id)
                    {
                        return Err(
                            "The selected system-audio source is no longer available.".into()
                        );
                    }
                    resolve_device(&device_id)
                })
                .and_then(|device| {
                    // WASAPI and CoreAudio expose system loopback by opening a render endpoint as an
                    // input stream. PipeWire exposes the monitor as an ordinary input device instead.
                    let config = system_audio_config(&device)?;
                    validate_config(&config, "system audio")?;
                    let sample_rate_hz = config.sample_rate();
                    let stream = build_capture_stream(
                        &device,
                        config.clone(),
                        TrackKind::SystemAudio,
                        system_sender,
                        Arc::clone(&signals[1]),
                    )?;
                    Ok((
                        stream,
                        sample_rate_hz,
                        config.channels(),
                        sample_format_name(config.sample_format()),
                    ))
                }) {
                Ok((stream, sample_rate_hz, channel_count, sample_format)) => {
                    (Some(stream), sample_rate_hz, channel_count, sample_format)
                }
                Err(error) => {
                    signals[1].fail(error);
                    (None, 0, 0, "")
                }
            },
            None => {
                drop(system_sender);
                signals[1].fail(system_audio_unavailable_message());
                (None, 0, 0, "")
            }
        };

    let (application_capture, application_audio_sample_rate_hz) =
        if let Some(target) = application_audio_target.clone() {
            let capture =
                ApplicationAudioCapture::new(target, application_sender, Arc::clone(&signals[2]))?;
            (Some(capture), APPLICATION_AUDIO_SAMPLE_RATE_HZ)
        } else {
            drop(application_sender);
            signals[2].fail(application_audio_unavailable_message());
            (None, 0)
        };

    let worker_signals = [
        Arc::clone(&signals[0]),
        Arc::clone(&signals[1]),
        Arc::clone(&signals[2]),
    ];
    let discarded = Arc::new(AtomicBool::new(false));
    let worker_discarded = Arc::clone(&discarded);
    let pause_id = Arc::new(AtomicU64::new(0));
    let worker_pause_id = Arc::clone(&pause_id);
    let worker_window = window.clone();
    let worker_capture_id = capture_id.clone();
    let worker = thread::Builder::new()
        .name("tutorux-native-audio-events".into())
        .spawn(move || {
            emit_audio_chunks(
                worker_window,
                worker_capture_id,
                [microphone_receiver, system_receiver, application_receiver],
                worker_signals,
                worker_discarded,
                worker_pause_id,
            )
        })
        .map_err(|_| "The native audio delivery worker could not be started.".to_owned())?;

    let started_at_us = match now_unix_microseconds() {
        Ok(value) => value,
        Err(error) => {
            drop(system_stream);
            drop(microphone_stream);
            drop(application_capture);
            let _ = worker.join();
            return Err(error);
        }
    };
    let backend = microphone_device_id
        .split_once(':')
        .map_or("native", |(host, _)| host)
        .to_owned();
    let started = SynchronizedAudioStarted {
        capture_id: capture_id.clone(),
        started_at_us: started_at_us.to_string(),
        consent_at_us: consent_at_us.clone(),
        microphone_sample_rate_hz,
        microphone_channel_count,
        microphone_sample_format: microphone_sample_format.to_owned(),
        system_audio_sample_rate_hz: system_sample_rate_hz,
        system_audio_channel_count: system_channel_count,
        system_audio_sample_format: system_sample_format.to_owned(),
        application_audio_sample_rate_hz,
        application_audio_channel_count: if application_audio_target.is_some() {
            APPLICATION_AUDIO_CHANNELS
        } else {
            0
        },
        application_audio_sample_format: if application_audio_target.is_some() {
            "pcm_f32le".to_owned()
        } else {
            String::new()
        },
        application_audio_device_id: application_audio_device_id.clone(),
        application_audio_name: application_audio_target
            .as_ref()
            .map(|target| target.name.clone()),
        application_audio_process_id: application_audio_target
            .as_ref()
            .map(|target| target.process_id),
        application_audio_bundle_id: application_audio_target
            .as_ref()
            .and_then(|target| target.bundle_id.clone()),
        application_audio_backend: application_audio_target
            .as_ref()
            .map(|target| target.backend.to_owned()),
        backend,
    };
    let session = Arc::new(CaptureSession {
        microphone_stream: Mutex::new(microphone_stream),
        system_stream: Mutex::new(system_stream),
        application_capture: Mutex::new(application_capture),
        worker: Mutex::new(Some(worker)),
        signals,
        discarded,
        activated: AtomicBool::new(false),
        pause_id,
        microphone_sample_rate_hz,
        system_sample_rate_hz,
        application_audio_sample_rate_hz,
    });
    captures.insert(id, session);
    Ok(started)
}
