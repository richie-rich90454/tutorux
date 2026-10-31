use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::archive::now_us;

pub(crate) const WORKER_ID_ENV: &str = "TUTORUX_RECORDING_WORKER_ID";
pub(crate) const PASSPHRASE_ENV: &str = "TUTORUX_RECORDING_PASSPHRASE";
const STALE_AFTER_US: u64 = 30_000_000;
const HEARTBEAT_EVERY_US: u64 = 500_000;

#[derive(Clone, Debug)]
pub(crate) struct WorkerStatus {
    pub(crate) session_id: String,
    pub(crate) worker_id: String,
    pub(crate) pid: u32,
    pub(crate) state: String,
    pub(crate) message: String,
    pub(crate) heartbeat_us: u64,
}

impl WorkerStatus {
    fn to_value(&self) -> Value {
        json!({
            "protocol": 1,
            "sessionId": self.session_id,
            "workerId": self.worker_id,
            "pid": self.pid,
            "state": self.state,
            "message": self.message,
            "heartbeatUs": self.heartbeat_us.to_string(),
        })
    }

    fn from_value(value: &Value) -> Option<Self> {
        let pid = value.get("pid")?.as_u64()?;
        if pid == 0 || pid > u64::from(u32::MAX) {
            return None;
        }
        Some(Self {
            session_id: value.get("sessionId")?.as_str()?.to_owned(),
            worker_id: value.get("workerId")?.as_str()?.to_owned(),
            pid: u32::try_from(pid).ok()?,
            state: value.get("state")?.as_str()?.to_owned(),
            message: value.get("message")?.as_str()?.to_owned(),
            heartbeat_us: value
                .get("heartbeatUs")
                .and_then(Value::as_str)
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        })
    }

    pub(crate) fn is_stale(&self) -> bool {
        now_us().saturating_sub(self.heartbeat_us) > STALE_AFTER_US
    }

    pub(crate) fn is_terminal(&self) -> bool {
        matches!(
            self.state.as_str(),
            "completed" | "interrupted" | "failed" | "partial"
        )
    }
}

pub(super) fn status_path(archive: &Path, session_id: &str) -> PathBuf {
    state_directory().join(format!("{}.status.json", key(archive, session_id)))
}

pub(super) fn command_path(archive: &Path, session_id: &str) -> PathBuf {
    state_directory().join(format!("{}.command.json", key(archive, session_id)))
}

pub(crate) fn read_status(archive: &Path, session_id: &str) -> Option<WorkerStatus> {
    let bytes = std::fs::read(status_path(archive, session_id)).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let status = WorkerStatus::from_value(&value)?;
    (status.session_id.eq_ignore_ascii_case(session_id)).then_some(status)
}

fn write_status(
    archive: &Path,
    session_id: &str,
    status: &WorkerStatus,
) -> Result<(), String> {
    let directory = state_directory();
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the recording state directory: {error}"))?;
    restrict_directory(&directory)?;
    let bytes = serde_json::to_vec_pretty(&status.to_value())
        .map_err(|error| format!("Could not encode recording worker state: {error}"))?;
    crate::core::cli::write_file_atomically(&status_path(archive, session_id), &bytes)
        .map_err(|error| error.message)
}

#[derive(Default)]
pub(super) struct WorkerControl {
    archive: PathBuf,
    session_id: String,
    status: Option<WorkerStatus>,
    last_write_us: u64,
    last_pause: bool,
    terminal: bool,
}

pub(super) enum ControlRequest {
    None,
    Pause,
    Resume,
    Stop,
}

impl WorkerControl {
    pub(super) fn start(archive: &Path, session_id: &str, worker_id: &str) -> Result<Self, String> {
        let mut control = Self {
            archive: archive.to_path_buf(),
            session_id: session_id.to_owned(),
            status: Some(WorkerStatus {
                session_id: session_id.to_owned(),
                worker_id: worker_id.to_owned(),
                pid: std::process::id(),
                state: "starting".to_owned(),
                message: "The detached recording worker is starting.".to_owned(),
                heartbeat_us: now_us(),
            }),
            last_write_us: 0,
            last_pause: false,
            terminal: false,
        };
        let _ = std::fs::remove_file(command_path(archive, session_id));
        control.write("starting", "The detached recording worker is starting.")?;
        Ok(control)
    }

    pub(super) fn write(&mut self, state: &str, message: &str) -> Result<(), String> {
        let Some(status) = self.status.as_mut() else {
            return Ok(());
        };
        status.state = state.to_owned();
        status.message = message.to_owned();
        status.heartbeat_us = now_us();
        write_status(&self.archive, &self.session_id, status)?;
        self.last_write_us = now_us();
        Ok(())
    }

    pub(super) fn heartbeat(&mut self) {
        if self.terminal || self.status.is_none() {
            return;
        }
        if now_us().saturating_sub(self.last_write_us) < HEARTBEAT_EVERY_US {
            return;
        }
        if let Some(status) = self.status.as_mut() {
            status.heartbeat_us = now_us();
            let _ = write_status(&self.archive, &self.session_id, status);
            self.last_write_us = now_us();
        }
    }

    pub(super) fn poll(&mut self) -> ControlRequest {
        let Some(bytes) = std::fs::read(command_path(&self.archive, &self.session_id)).ok() else {
            return ControlRequest::None;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return ControlRequest::None;
        };
        if value.get("stop").and_then(Value::as_bool) == Some(true) {
            return ControlRequest::Stop;
        }
        let pause = value.get("pause").and_then(Value::as_bool).unwrap_or(false);
        if pause == self.last_pause {
            return ControlRequest::None;
        }
        self.last_pause = pause;
        if pause {
            ControlRequest::Pause
        } else {
            ControlRequest::Resume
        }
    }

    pub(super) fn finish(&mut self, state: &str, message: &str) {
        if self.terminal {
            return;
        }
        let _ = self.write(state, message);
        self.terminal = true;
        let _ = std::fs::remove_file(status_path(&self.archive, &self.session_id));
        let _ = std::fs::remove_file(command_path(&self.archive, &self.session_id));
    }
}

pub(crate) fn write_command(
    archive: &Path,
    session_id: &str,
    pause: bool,
    stop: bool,
) -> Result<(), String> {
    let directory = state_directory();
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the recording state directory: {error}"))?;
    restrict_directory(&directory)?;
    let value = json!({
        "protocol": 1,
        "pause": pause,
        "stop": stop,
        "requestedAtUs": now_us().to_string(),
    });
    let bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("Could not encode the recording control request: {error}"))?;
    crate::core::cli::write_file_atomically(&command_path(archive, session_id), &bytes)
        .map_err(|error| error.message)
}

pub(crate) fn clear(archive: &Path, session_id: &str) {
    let _ = std::fs::remove_file(status_path(archive, session_id));
    let _ = std::fs::remove_file(command_path(archive, session_id));
}

fn state_directory() -> PathBuf {
    if let Ok(value) = std::env::var("TUTORUX_STATE_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("recordings");
        }
    }
    #[cfg(windows)]
    {
        if let Ok(value) = std::env::var("LOCALAPPDATA") {
            if !value.trim().is_empty() {
                return PathBuf::from(value).join("tutorux").join("recordings");
            }
        }
        return std::env::temp_dir().join("tutorux").join("recordings");
    }
    #[cfg(unix)]
    {
        if let Ok(value) = std::env::var("XDG_STATE_HOME") {
            if !value.trim().is_empty() {
                return PathBuf::from(value).join("tutorux").join("recordings");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            if !home.trim().is_empty() {
                return PathBuf::from(home)
                    .join(".local")
                    .join("state")
                    .join("tutorux")
                    .join("recordings");
            }
        }
        std::env::temp_dir().join("tutorux").join("recordings")
    }
    #[cfg(not(any(windows, unix)))]
    {
        std::env::temp_dir().join("tutorux").join("recordings")
    }
}

fn key(archive: &Path, session_id: &str) -> String {
    let canonical = std::fs::canonicalize(archive).unwrap_or_else(|_| archive.to_path_buf());
    let mut material = canonical.to_string_lossy().into_owned().into_bytes();
    material.push(0);
    material.extend_from_slice(session_id.to_ascii_lowercase().as_bytes());
    hex::encode(crate::core::archive::sha256(&material))
        .chars()
        .take(32)
        .collect()
}

fn restrict_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::symlink_metadata(directory)
            .map_err(|error| format!("Could not inspect the recording state directory: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("The recording state directory is unsafe.".to_owned());
        }
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| {
                    format!("Could not secure the recording state directory: {error}")
                })?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
    }
    Ok(())
}
