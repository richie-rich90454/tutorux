use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Mutex, OnceLock};

use serde_json::json;

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{emit, open_archive, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{ArchiveRecord, RecordType};
use crate::platform::synchronized_audio::headless::HeadlessDevice;

mod start;
mod whisper;
mod worker;
mod writer;

pub use start::run_start;
use worker::capture_worker;

pub(super) const DEFAULT_DURATION_SECONDS: u64 = 0;
pub(super) const MAX_DURATION_SECONDS: u64 = 604_800;
pub(super) static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static REGISTRY: OnceLock<Mutex<HashMap<String, RegistryEntry>>> = OnceLock::new();

#[derive(Clone)]
pub(super) struct RegistryEntry {
    pub(super) commands: mpsc::Sender<CaptureCommand>,
    pub(super) status: Arc<Mutex<CaptureStatus>>,
}

#[derive(Clone)]
pub(super) struct CaptureStatus {
    pub(super) session_id: String,
    pub(super) state: String,
    pub(super) message: String,
}

pub(super) enum CaptureCommand {
    Pause(mpsc::Sender<Result<(), String>>),
    Resume(mpsc::Sender<Result<(), String>>),
    Stop(mpsc::Sender<()>),
}

pub(super) struct CaptureConfig {
    pub(super) session_id: String,
    pub(super) take_id: String,
    pub(super) track_ids: [String; 3],
    pub(super) device_names: [String; 3],
    pub(super) microphone_device_id: Option<String>,
    pub(super) system_device_id: Option<String>,
    pub(super) application_device_id: Option<String>,
    pub(super) consent_at_us: u64,
    pub(super) confirmed_by: String,
    pub(super) duration_seconds: u64,
    pub(super) durability: String,
    pub(super) whisper: Option<WhisperRequest>,
}

pub(super) struct WhisperRequest {
    pub(super) executable: String,
    pub(super) model: String,
    pub(super) language: String,
    pub(super) threads: Option<u32>,
    pub(super) diarize: bool,
}

pub(super) fn registry() -> &'static Mutex<HashMap<String, RegistryEntry>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn run_status(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    if !args.positionals.is_empty() {
        return Err(CliError("record status does not accept positional arguments.".to_owned()).into());
    }
    let Some(session_id) = args.option("session").map(str::to_lowercase) else {
        let snapshot = open_ready(path, context)?;
        let active = snapshot
            .list_records(RecordType::SESSION, false)?
            .iter()
            .filter(|session| is_archive_active(session.field("recording_state").unwrap_or("")))
            .count();
        emit(
            output,
            json!({"active_recordings": active.to_string()}),
            &format!("Active recording sessions: {active}."),
            args.json(),
        );
        return Ok(0);
    };
    if let Some(status) = registered_status(&session_id) {
        emit(
            output,
            json!({
                "sessionId": status.session_id,
                "state": status.state,
                "message": status.message,
                "worker": "in-process",
            }),
            &format!("Recording state: {}\n{}", status.state, status.message),
            args.json(),
        );
        return Ok(0);
    }
    let snapshot = open_ready(path, context)?;
    let session = require_session(&snapshot, &session_id)?;
    let raw_state = session.field("recording_state").unwrap_or("not-started");
    let state = match raw_state {
        "starting" | "initializing" | "recording" | "paused" | "finalizing" | "completed"
        | "interrupted" | "failed" | "partial" => raw_state,
        _ => "not-started",
    };
    let message = session
        .field("recording_error")
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!("Archive recording state is '{raw_state}'. No in-process worker is connected.")
        });
    emit(
        output,
        json!({
            "sessionId": session_id,
            "state": state,
            "message": message,
            "worker": "not-running",
        }),
        &format!("Recording state: {state}\n{message}"),
        args.json(),
    );
    Ok(0)
}

pub fn run_control(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    if !args.positionals.is_empty() {
        return Err(CliError(format!("record {action} does not accept positional arguments.")).into());
    }
    for flag in &args.flags {
        if flag != "json" && flag != "session" {
            return Err(CliError(format!("record {action} does not accept --{flag}.")).into());
        }
    }
    for option in args.options.keys() {
        if option != "session" {
            return Err(CliError(format!("record {action} does not accept --{option}.")).into());
        }
    }
    if args.flags.contains("session") {
        return Err(CliError("--session requires a value.".to_owned()).into());
    }
    let session_id = args.required_option("session")?.to_lowercase();
    let Some(entry) = registry().lock().ok().and_then(|map| map.get(&session_id).cloned()) else {
        let snapshot = open_ready(path, context)?;
        require_session(&snapshot, &session_id)?;
        return Err(CliError(format!(
            "No recording worker is active for session {session_id}."
        ))
        .into());
    };
    let status = Arc::clone(&entry.status);
    match action {
        "pause" | "resume" => {
            let (sender, receiver) = mpsc::channel();
            let command = if action == "pause" {
                CaptureCommand::Pause(sender)
            } else {
                CaptureCommand::Resume(sender)
            };
            let _ = entry.commands.send(command);
            match receiver.recv_timeout(std::time::Duration::from_secs(20)) {
                Ok(Ok(())) => {}
                Ok(Err(error)) => return Err(CliError(error).into()),
                Err(_) => {
                    return Err(
                        CliError("The recording worker did not respond in time.".to_owned()).into(),
                    )
                }
            }
            let snapshot = status.lock().map(|value| value.clone()).unwrap_or_else(|_| CaptureStatus {
                session_id: session_id.clone(),
                state: action.to_owned(),
                message: String::new(),
            });
            emit(
                output,
                json!({
                    "sessionId": snapshot.session_id,
                    "state": snapshot.state,
                    "message": snapshot.message,
                    "worker": "in-process",
                }),
                &format!("Recording state: {}\n{}", snapshot.state, snapshot.message),
                args.json(),
            );
            Ok(0)
        }
        "stop" => {
            if let Ok(mut map) = registry().lock() {
                map.remove(&session_id);
            }
            let (sender, receiver) = mpsc::channel();
            let _ = entry.commands.send(CaptureCommand::Stop(sender));
            let _ = receiver.recv_timeout(std::time::Duration::from_secs(30));
            let snapshot = status.lock().map(|value| value.clone()).ok();
            let (state, message) = snapshot
                .map(|value| (value.state, value.message))
                .unwrap_or_else(|| ("interrupted".to_owned(), "The recording worker has stopped.".to_owned()));
            let terminal = matches!(
                state.as_str(),
                "completed" | "interrupted" | "partial" | "failed"
            );
            emit(
                output,
                json!({
                    "sessionId": session_id,
                    "state": state,
                    "message": message,
                    "worker": "not-running",
                }),
                &format!("Recording state: {state}\n{message}"),
                args.json(),
            );
            Ok(if terminal { 0 } else { 2 })
        }
        _ => Err(CliError(format!("Unknown recording control action: {action}.")).into()),
    }
}

fn registered_status(session_id: &str) -> Option<CaptureStatus> {
    let map = registry().lock().ok()?;
    let entry = map.get(session_id)?;
    entry.status.lock().ok().map(|status| status.clone())
}

pub(super) fn select_device(
    devices: &[HeadlessDevice],
    source: &str,
    requested: Option<&str>,
) -> CliResult<Option<HeadlessDevice>> {
    let candidates: Vec<&HeadlessDevice> =
        devices.iter().filter(|device| device.source == source).collect();
    if candidates.is_empty() {
        return Err(CliError(if source == "system-audio" {
            "No native system-audio loopback device is available on this platform.".to_owned()
        } else {
            "No native microphone device is available.".to_owned()
        })
        .into());
    }
    let selected = match requested {
        Some(value) if value != "default" => candidates
            .iter()
            .find(|device| device.id == value || device.name == value)
            .copied()
            .ok_or_else(|| {
                CliError(format!(
                    "The selected {source} device '{value}' is not listed by the native audio backend."
                ))
            })?,
        _ => candidates
            .iter()
            .find(|device| device.is_default)
            .copied()
            .or_else(|| (candidates.len() == 1).then(|| candidates[0]))
            .ok_or_else(|| {
                CliError(format!(
                    "Select one {source} device; the operating-system default is ambiguous."
                ))
            })?,
    };
    Ok(Some(selected.clone()))
}

pub(super) fn select_application(
    devices: &[HeadlessDevice],
    requested: Option<&str>,
) -> CliResult<Option<HeadlessDevice>> {
    let candidates: Vec<&HeadlessDevice> = devices
        .iter()
        .filter(|device| device.source == "application-audio")
        .collect();
    if candidates.is_empty() {
        return Err(CliError(
            "No active per-application audio endpoint was found. Start playback in the target application and retry."
                .to_owned(),
        )
        .into());
    }
    let selected = match requested {
        Some(value) => candidates
            .iter()
            .find(|device| {
                device.id == value
                    || device.name == value
                    || device.process_id.map(|id| id.to_string()).as_deref() == Some(value)
            })
            .copied()
            .ok_or_else(|| {
                CliError("The selected application-audio source is no longer available.".to_owned())
            })?,
        None => candidates
            .first()
            .copied()
            .ok_or_else(|| CliError("Select an application-audio source.".to_owned()))?,
    };
    Ok(Some(selected.clone()))
}

pub(super) fn open_ready(path: &Path, context: &CliContext) -> CliResult<ArchiveSnapshot> {
    let snapshot = open_archive(path, context.passphrase())?;
    if snapshot.locked() {
        return Err(CliError(
            "This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned(),
        )
        .into());
    }
    Ok(snapshot)
}

pub(super) fn require_session(snapshot: &ArchiveSnapshot, id: &str) -> CliResult<ArchiveRecord> {
    match snapshot.get_record(RecordType::SESSION, id)? {
        Some(record) if !record.deleted() => Ok(record),
        _ => Err(CliError("Session was not found in this archive.".to_owned()).into()),
    }
}

pub(super) fn is_archive_active(state: &str) -> bool {
    matches!(
        state,
        "starting" | "initializing" | "recording" | "paused" | "finalizing"
    )
}

pub(super) fn samples_to_microseconds(samples: u64, rate: u32) -> u64 {
    if rate == 0 {
        0
    } else {
        samples.saturating_mul(1_000_000) / u64::from(rate)
    }
}

pub(super) fn track_index(track: &str) -> usize {
    match track {
        "microphone" => 0,
        "system-audio" => 1,
        _ => 2,
    }
}

pub(super) fn track_label(source: &str) -> &'static str {
    match source {
        "microphone" => "Microphone recording",
        "system-audio" => "Shared system audio",
        _ => "Application audio",
    }
}

#[cfg(unix)]
pub(super) fn install_interrupt_handler() {
    extern "C" fn handle(_: libc::c_int) {
        STOP_REQUESTED.store(true, std::sync::atomic::Ordering::Release);
    }
    unsafe {
        libc::signal(libc::SIGINT, handle as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, handle as *const () as libc::sighandler_t);
    }
}

#[cfg(windows)]
pub(super) fn install_interrupt_handler() {
    extern "C" fn handle(_: libc::c_int) {
        STOP_REQUESTED.store(true, std::sync::atomic::Ordering::Release);
    }
    unsafe {
        libc::signal(libc::SIGINT, handle as *const () as libc::sighandler_t);
    }
}

#[cfg(not(any(unix, windows)))]
pub(super) fn install_interrupt_handler() {}
