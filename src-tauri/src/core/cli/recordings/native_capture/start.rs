use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::core::archive::new_uuid;
use crate::core::cli::{
    cancellation, emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments,
};
use crate::platform::synchronized_audio::headless::{enumerate_devices, HeadlessDevice, HeadlessDevices};

use super::control_files::{WorkerControl, WORKER_ID_ENV};
use super::ffmpeg_capture::{FfmpegPlan, FfmpegTrack};
use super::start_options;
use super::worker::CaptureOutcome;
use super::{
    capture_worker, install_interrupt_handler, registry, select_application, select_device,
    CaptureCommand, CaptureConfig, CaptureSources, CaptureStatus, RegistryEntry, STOP_REQUESTED,
};
use crate::core::cli::recordings::ffmpeg::{self, FfmpegDevice};

enum Selected {
    Native(HeadlessDevice),
    Ffmpeg(FfmpegDevice),
}

pub fn run_start(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let options = start_options::parse(&args, path, context)?;
    if options.detach {
        return super::detach::run(&args, output, path, context, &options.session_id);
    }
    let native = enumerate_devices().ok();
    let mut ffmpeg_devices: Option<Result<Vec<FfmpegDevice>, String>> = None;
    let mut ffmpeg_executable = ffmpeg::resolve_executable(args.option("ffmpeg"));
    if args.options.contains_key("ffmpeg") && ffmpeg_executable.trim().is_empty() {
        return Err(CliError("--ffmpeg cannot be empty.".to_owned()).into());
    }

    let microphone = if options.needs_microphone {
        Some(select_source(
            &native,
            &mut ffmpeg_devices,
            &mut ffmpeg_executable,
            "microphone",
            options.microphone.as_deref().or(if options.needs_system || options.needs_application {
                None
            } else {
                options.device.as_deref()
            }),
        )?)
    } else {
        None
    };
    let system = if options.needs_system {
        Some(select_source(
            &native,
            &mut ffmpeg_devices,
            &mut ffmpeg_executable,
            "system-audio",
            options.playback.as_deref().or(if options.needs_microphone {
                None
            } else {
                options.device.as_deref()
            }),
        )?)
    } else {
        None
    };
    let application = if options.needs_application {
        let devices = native.as_ref().ok_or_else(|| {
            CliError(super::super::native_probe::application_limitation())
        })?;
        select_application(&devices.devices, options.application.as_deref().or(options.device.as_deref()))?
            .map(Selected::Native)
    } else {
        None
    };

    let mut sources = CaptureSources {
        microphone_id: None,
        system_id: None,
        application_id: None,
        ffmpeg: None,
    };
    let mut ffmpeg_tracks = Vec::new();
    let mut device_names = [String::new(), String::new(), String::new()];
    let mut device_ids = [None, None, None];
    for (index, selected) in [microphone, system, application].into_iter().enumerate() {
        let Some(selected) = selected else { continue };
        match selected {
            Selected::Native(device) => {
                device_names[index] = device.name.clone();
                device_ids[index] = Some(device.id.clone());
                match index {
                    0 => sources.microphone_id = Some(device.id),
                    1 => sources.system_id = Some(device.id),
                    _ => sources.application_id = Some(device.id),
                }
            }
            Selected::Ffmpeg(device) => {
                if index == 2 {
                    return Err(CliError(
                        "Per-application audio capture requires the native audio backend.".to_owned(),
                    )
                    .into());
                }
                device_names[index] = device.name.clone();
                device_ids[index] = Some(device.id.clone());
                ffmpeg_tracks.push(FfmpegTrack {
                    source: if index == 0 { "microphone" } else { "system-audio" },
                    device,
                });
            }
        }
    }
    if !ffmpeg_tracks.is_empty() {
        sources.ffmpeg = Some(FfmpegPlan {
            executable: ffmpeg_executable,
            tracks: ffmpeg_tracks,
        });
    }
    if sources.microphone_id.is_none()
        && sources.system_id.is_none()
        && sources.application_id.is_none()
        && sources.ffmpeg.is_none()
    {
        return Err(CliError("No audio input endpoint was selected.".to_owned()).into());
    }
    let session_id = options.session_id.clone();
    let config = CaptureConfig {
        session_id: session_id.clone(),
        take_id: new_uuid(),
        track_ids: [new_uuid(), new_uuid(), new_uuid()],
        device_names,
        microphone_device_id: device_ids[0].clone(),
        system_device_id: device_ids[1].clone(),
        application_device_id: device_ids[2].clone(),
        consent_at_us: crate::core::archive::now_us(),
        confirmed_by: options.confirmed_by,
        duration_seconds: options.duration_seconds,
        durability: options.durability,
        whisper: options.whisper,
    };
    let capture_id = new_uuid();
    let (commands, command_receiver) = mpsc::channel();
    let status = Arc::new(Mutex::new(CaptureStatus {
        state: "starting".to_owned(),
        message: "Preparing audio inputs.".to_owned(),
    }));
    let control = match std::env::var(WORKER_ID_ENV) {
        Ok(worker_id) if !worker_id.trim().is_empty() => {
            Some(WorkerControl::start(path, &session_id, worker_id.trim()).map_err(CliError)?)
        }
        _ => None,
    };
    let (ready_sender, ready_receiver) = mpsc::channel();
    let (result_sender, result_receiver) = mpsc::channel();
    let worker_status = Arc::clone(&status);
    let worker_path = path.to_path_buf();
    let worker_passphrase = context.passphrase().map(str::to_owned);
    let worker_capture_id = capture_id.clone();
    std::thread::Builder::new()
        .name("tutorux-cli-recording".to_owned())
        .spawn(move || {
            let result = capture_worker(
                &worker_path,
                worker_passphrase.as_deref(),
                &worker_capture_id,
                &sources,
                &config,
                command_receiver,
                &ready_sender,
                &worker_status,
                control,
            );
            let outcome = match result {
                Ok(outcome) => outcome,
                Err(error) => CaptureOutcome {
                    report: json!({
                        "sessionId": config.session_id,
                        "state": "failed",
                        "error": error,
                    }),
                    summary: format!("Recording failed: {error}"),
                    completed: false,
                },
            };
            if let Ok(mut value) = worker_status.lock() {
                value.state = outcome
                    .report
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("failed")
                    .to_owned();
                value.message = outcome.summary.clone();
            }
            let _ = result_sender.send(outcome);
        })
        .map_err(|_| CliError("The recording worker could not be started.".to_owned()))?;
    match ready_receiver.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(CliError(error).into()),
        Err(_) => {
            return Err(CliError(
                "The recording worker did not report a ready state within 30 seconds.".to_owned(),
            )
            .into())
        }
    }
    if let Ok(mut map) = registry().lock() {
        map.insert(
            session_id.clone(),
            RegistryEntry { commands },
        );
    }
    install_interrupt_handler();
    loop {
        match result_receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(outcome) => {
                if let Ok(mut map) = registry().lock() {
                    map.remove(&session_id);
                }
                emit(output, outcome.report, &outcome.summary, args.json());
                return Ok(if outcome.completed { 0 } else { 1 });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if cancellation::is_cancelled() {
                    if let Some(entry) = registry().lock().ok().and_then(|mut map| map.remove(&session_id)) {
                        let (sender, receiver) = mpsc::channel();
                        let _ = entry.commands.send(CaptureCommand::Stop(sender));
                        let _ = receiver.recv_timeout(Duration::from_secs(10));
                    }
                    return Err(CliError("Recording was cancelled.".to_owned()).into());
                }
                if STOP_REQUESTED.swap(false, Ordering::AcqRel) {
                    if let Some(entry) = registry().lock().ok().and_then(|mut map| map.remove(&session_id)) {
                        let (sender, receiver) = mpsc::channel();
                        let _ = entry.commands.send(CaptureCommand::Stop(sender));
                        let _ = receiver.recv_timeout(Duration::from_secs(10));
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if let Ok(mut map) = registry().lock() {
                    map.remove(&session_id);
                }
                return Err(CliError("The recording worker stopped unexpectedly.".to_owned()).into());
            }
        }
    }
}

fn select_source(
    native: &Option<HeadlessDevices>,
    ffmpeg_devices: &mut Option<Result<Vec<FfmpegDevice>, String>>,
    ffmpeg_executable: &mut String,
    source: &str,
    requested: Option<&str>,
) -> CliResult<Selected> {
    if let Some(devices) = native {
        if let Ok(Some(device)) = select_device(&devices.devices, source, requested) {
            return Ok(Selected::Native(device));
        }
    }
    if source == "application" {
        return Err(CliError(super::super::native_probe::application_limitation()).into());
    }
    let devices = ffmpeg_devices.get_or_insert_with(|| ffmpeg::enumerate(ffmpeg_executable.as_str()));
    let devices = match devices {
        Ok(devices) => devices.clone(),
        Err(error) => {
            return Err(CliError(format!(
                "No native {} device is available and FFmpeg could not list inputs: {error}",
                if source == "microphone" { "microphone" } else { "system-audio" }
            ))
            .into())
        }
    };
    let candidates: Vec<&FfmpegDevice> = devices
        .iter()
        .filter(|device| {
            if source == "microphone" {
                !ffmpeg::is_loopback(device)
            } else {
                ffmpeg::is_loopback(device)
            }
        })
        .collect();
    let selected = match requested.filter(|value| *value != "default") {
        Some(value) => devices
            .iter()
            .find(|device| device.id == value || device.name == value)
            .filter(|device| {
                if source == "microphone" {
                    !ffmpeg::is_loopback(device)
                } else {
                    ffmpeg::is_loopback(device)
                }
            })
            .ok_or_else(|| {
                CliError(if source == "system-audio" {
                    "No FFmpeg loopback input matches the selected system-audio device.".to_owned()
                } else {
                    format!("The selected microphone device '{value}' is not listed by FFmpeg.")
                })
            })?,
        None => candidates
            .iter()
            .find(|device| device.backend == ffmpeg::preferred_backend())
            .copied()
            .or_else(|| candidates.first().copied())
            .ok_or_else(|| {
                CliError(if source == "system-audio" {
                    "No FFmpeg loopback input is exposed on this host. Select a monitor or Stereo Mix device.".to_owned()
                } else {
                    "No microphone endpoint is available from the native backend or FFmpeg.".to_owned()
                })
            })?,
    };
    Ok(Selected::Ffmpeg(selected.clone()))
}
