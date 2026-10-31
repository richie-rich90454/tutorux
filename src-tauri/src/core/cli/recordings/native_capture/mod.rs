use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Mutex, OnceLock};

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{open_archive, CliContext, CliError, CliResult};
use crate::core::format::{ArchiveRecord, RecordType};
use crate::platform::synchronized_audio::headless::HeadlessDevice;

mod control_files;
mod detach;
mod ffmpeg_capture;
mod start;
mod start_options;
mod whisper;
mod whisper_wav;
mod worker;
mod writer;

pub(super) use control_files::{
    clear as clear_control_files, read_status as read_worker_status,
    write_command as write_worker_command, WorkerStatus,
};
pub use start::run_start;
use ffmpeg_capture::FfmpegPlan;
use worker::capture_worker;

pub(super) const DEFAULT_DURATION_SECONDS: u64 = 0;
pub(super) const MAX_DURATION_SECONDS: u64 = 604_800;
pub(super) static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static REGISTRY: OnceLock<Mutex<HashMap<String, RegistryEntry>>> = OnceLock::new();

#[derive(Clone)]
pub(super) struct RegistryEntry {
    pub(super) commands: mpsc::Sender<CaptureCommand>,
}

#[derive(Clone)]
pub(super) struct CaptureStatus {
    pub(super) state: String,
    pub(super) message: String,
}

pub(super) enum CaptureCommand {
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

pub(super) struct CaptureSources {
    pub(super) microphone_id: Option<String>,
    pub(super) system_id: Option<String>,
    pub(super) application_id: Option<String>,
    pub(super) ffmpeg: Option<FfmpegPlan>,
}

pub(super) struct WhisperRequest {
    pub(super) executable: String,
    pub(super) model: String,
    pub(super) language: String,
    pub(super) threads: Option<u32>,
    pub(super) diarize: bool,
    pub(super) window_seconds: u32,
}

pub(super) fn registry() -> &'static Mutex<HashMap<String, RegistryEntry>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
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
