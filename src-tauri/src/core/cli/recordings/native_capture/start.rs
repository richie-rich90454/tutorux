use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::core::archive::{new_uuid, now_us};
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::platform::synchronized_audio::headless::enumerate_devices;

use super::{
    capture_worker, install_interrupt_handler, is_archive_active, open_ready, registry,
    require_session, select_application, select_device, CaptureCommand, CaptureConfig,
    CaptureStatus, RegistryEntry, WhisperRequest, DEFAULT_DURATION_SECONDS, MAX_DURATION_SECONDS,
    STOP_REQUESTED,
};
use super::worker::CaptureOutcome;

pub fn run_start(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    if !args.positionals.is_empty() {
        return Err(CliError("record start does not accept positional arguments.".to_owned()).into());
    }
    if !args.flags.contains("consent") {
        return Err(CliError("Recording requires explicit confirmation with --consent.".to_owned()).into());
    }
    for name in [
        "source",
        "device",
        "microphone",
        "playback",
        "application",
        "language",
        "threads",
        "window-seconds",
        "confirmed-by",
        "duration-seconds",
    ] {
        if args.flags.contains(name) {
            return Err(CliError(format!("--{name} requires a value.")).into());
        }
    }
    if args.options.contains_key("system-audio") {
        return Err(CliError("--system-audio is a flag and does not accept a value.".to_owned()).into());
    }
    if args.options.contains_key("input-format") {
        return Err(CliError(
            "The Rust recording backend does not accept --input-format; native device identifiers select the backend."
                .to_owned(),
        )
        .into());
    }
    if args.flags.contains("detach") {
        output.stderr(
            "Detached recording workers are not available in this build; recording in the foreground.",
        );
    }
    let source = args
        .option("source")
        .unwrap_or(if args.flags.contains("system-audio") {
            "system-audio"
        } else {
            "microphone"
        });
    if !["microphone", "system-audio", "loopback", "both", "application"].contains(&source) {
        return Err(CliError(
            "Recording source must be 'microphone', 'system-audio', 'application', or 'both'."
                .to_owned(),
        )
        .into());
    }
    let source = if source == "loopback" { "system-audio" } else { source };
    let device = args.option("device").map(str::to_owned);
    let microphone_request = args.option("microphone").map(str::to_owned);
    let playback_request = args.option("playback").map(str::to_owned);
    let application_request = args.option("application").map(str::to_owned);
    if [
        device.as_deref(),
        microphone_request.as_deref(),
        playback_request.as_deref(),
        application_request.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.trim().is_empty())
    {
        return Err(CliError("A device option cannot be empty.".to_owned()).into());
    }
    if source == "system-audio" && microphone_request.is_some() {
        return Err(CliError(
            "Use --microphone only when the microphone source is enabled.".to_owned(),
        )
        .into());
    }
    if source == "microphone" && playback_request.is_some() {
        return Err(CliError(
            "Use --playback only when system-audio capture is enabled.".to_owned(),
        )
        .into());
    }
    let (needs_microphone, needs_system, needs_application) = match source {
        "both" => {            if application_request.is_some() && args.flags.contains("system-audio") {
                return Err(CliError(
                    "Choose one synchronized secondary track with '--application' or '--system-audio'."
                        .to_owned(),
                )
                .into());
            }
            if application_request.is_some() && playback_request.is_some() {
                return Err(CliError(
                    "Select one synchronized secondary track with '--application' or '--playback'."
                        .to_owned(),
                )
                .into());
            }
            (true, application_request.is_none(), application_request.is_some())
        }
        "microphone" => {
            if application_request.is_some() {
                return Err(CliError(
                    "Use --application only with --source application or --source both.".to_owned(),
                )
                .into());
            }
            (true, args.flags.contains("system-audio"), false)
        }
        "application" => {
            if args.flags.contains("system-audio")
                || microphone_request.is_some()
                || playback_request.is_some()
            {
                return Err(CliError(
                    "Application-only capture accepts --device or --application, not microphone or system-audio selectors."
                        .to_owned(),
                )
                .into());
            }
            (false, false, true)
        }
        _ => (false, true, false),
    };
    if needs_microphone && (needs_system || needs_application) && device.is_some() {
        return Err(CliError(
            "Use source-specific selectors to choose synchronized inputs; --device is only for one source."
                .to_owned(),
        )
        .into());
    }
    if device.is_some()
        && (microphone_request.is_some()
            || playback_request.is_some()
            || application_request.is_some())
    {
        return Err(CliError(
            "Choose --device or source-specific audio selectors, not both.".to_owned(),
        )
        .into());
    }

    let live = args.flags.contains("live-transcribe");
    let diarize = args.flags.contains("diarize");
    if diarize && !live {
        return Err(CliError("Use --diarize with --live-transcribe.".to_owned()).into());
    }
    let whisper_options = ["whisper", "model", "language", "threads", "window-seconds"]
        .iter()
        .any(|name| args.options.contains_key(*name));
    if !live && (whisper_options || args.flags.contains("consent-local-audio")) {
        return Err(CliError("Whisper options require --live-transcribe.".to_owned()).into());
    }
    if live && !args.flags.contains("consent-local-audio") {
        return Err(CliError(
            "Use --consent-local-audio to authorize local Whisper processing during recording."
                .to_owned(),
        )
        .into());
    }
    if live && needs_microphone && (needs_system || needs_application) {
        return Err(CliError(
            "Live transcription requires one captured track. Start a single source or transcribe the synchronized tracks after recording."
                .to_owned(),
        )
        .into());
    }
    let whisper = if live {
        let language = args.option("language").unwrap_or("auto").to_owned();
        if language.is_empty()
            || language.len() > 16
            || !language.bytes().all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
        {
            return Err(CliError("Enter a valid Whisper language code, or auto.".to_owned()).into());
        }
        Some(WhisperRequest {
            executable: args.required_option("whisper")?.to_owned(),
            model: args.required_option("model")?.to_owned(),
            language,
            threads: match args.option("threads") {
                Some(value) => Some(
                    value
                        .parse::<u32>()
                        .ok()
                        .filter(|value| (1..=64).contains(value))
                        .ok_or_else(|| {
                            CliError("--threads must be an integer from 1 through 64.".to_owned())
                        })?,
                ),
                None => None,
            },
            diarize,
        })
    } else {
        None
    };
    let duration_seconds = match args.option("duration-seconds") {
        Some(value) => value
            .parse::<u64>()
            .ok()
            .filter(|value| (1..=MAX_DURATION_SECONDS).contains(value))
            .ok_or_else(|| {
                CliError("--duration-seconds must be an integer from 1 through 604800.".to_owned())
            })?,
        None => DEFAULT_DURATION_SECONDS,
    };
    let confirmed_by = args.option("confirmed-by").unwrap_or("CLI user").trim().to_owned();
    if confirmed_by.is_empty()
        || confirmed_by.len() > 256
        || confirmed_by.contains(['\r', '\n', '\0'])
    {
        return Err(CliError(
            "--confirmed-by must be a non-empty, single-line label up to 256 characters."
                .to_owned(),
        )
        .into());
    }
    let session_id = crate::core::cli::validate_uuid(
        args.required_option("session")?,
        "--session",
    )?;
    let snapshot = open_ready(path, context)?;
    let session = require_session(&snapshot, &session_id)?;
    if is_archive_active(session.field("recording_state").unwrap_or("")) {
        return Err(CliError(format!(
            "Session {session_id} already has an active recording state. Check record status or recover the saved take before starting another recording."
        ))
        .into());
    }
    let devices = enumerate_devices().map_err(|error| CliError(error))?;
    let microphone_device = if needs_microphone {
        select_device(
            &devices.devices,
            "microphone",
            microphone_request.as_deref().or(if needs_system || needs_application {
                None
            } else {
                device.as_deref()
            }),
        )?
    } else {
        None
    };
    let system_device = if needs_system {
        select_device(
            &devices.devices,
            "system-audio",
            playback_request.as_deref().or(if needs_microphone {
                None
            } else {
                device.as_deref()
            }),
        )?
    } else {
        None
    };
    let application_device = if needs_application {
        select_application(
            &devices.devices,
            application_request.as_deref().or(device.as_deref()),
        )?
    } else {
        None
    };

    let config = CaptureConfig {
        session_id: session_id.clone(),
        take_id: new_uuid(),
        track_ids: [new_uuid(), new_uuid(), new_uuid()],
        device_names: [
            microphone_device.as_ref().map(|device| device.name.clone()).unwrap_or_default(),
            system_device.as_ref().map(|device| device.name.clone()).unwrap_or_default(),
            application_device.as_ref().map(|device| device.name.clone()).unwrap_or_default(),
        ],
        microphone_device_id: microphone_device.as_ref().map(|device| device.id.clone()),
        system_device_id: system_device.as_ref().map(|device| device.id.clone()),
        application_device_id: application_device.as_ref().map(|device| device.id.clone()),
        consent_at_us: now_us(),
        confirmed_by,
        duration_seconds,
        durability: args.option("durability").unwrap_or("default").to_owned(),
        whisper,
    };
    let capture_id = new_uuid();
    let (commands, command_receiver) = mpsc::channel();
    let status = Arc::new(Mutex::new(CaptureStatus {
        session_id: session_id.clone(),
        state: "starting".to_owned(),
        message: "Preparing native audio inputs.".to_owned(),
    }));
    let (ready_sender, ready_receiver) = mpsc::channel();
    let (result_sender, result_receiver) = mpsc::channel();
    let worker_status = Arc::clone(&status);
    let worker_path = path.to_path_buf();
    let worker_passphrase = context.passphrase().map(str::to_owned);
    let worker_microphone = microphone_device.as_ref().map(|device| device.id.clone());
    let worker_system = system_device.as_ref().map(|device| device.id.clone());
    let worker_application = application_device.as_ref().map(|device| device.id.clone());
    let worker_capture_id = capture_id.clone();
    std::thread::Builder::new()
        .name("tutorux-cli-recording".to_owned())
        .spawn(move || {
            let result = capture_worker(
                &worker_path,
                worker_passphrase.as_deref(),
                &worker_capture_id,
                worker_microphone.as_deref(),
                worker_system.as_deref(),
                worker_application.as_deref(),
                &config,
                command_receiver,
                &ready_sender,
                &worker_status,
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
            RegistryEntry {
                commands,
                status: Arc::clone(&status),
            },
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

