use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::core::archive::new_uuid;
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};

use super::control_files::{
    clear, read_status, WorkerStatus, PASSPHRASE_ENV, WORKER_ID_ENV,
};

pub(super) fn run(
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
    session_id: &str,
) -> CliResult<i32> {
    if let Some(existing) = read_status(path, session_id).filter(|status| !status.is_stale()) {
        if !existing.is_terminal() {
            return Err(CliError(format!(
                "A detached recording worker for session {session_id} is already {}.",
                existing.state
            ))
            .into());
        }
        clear(path, session_id);
    }
    let worker_id = new_uuid();
    let mut child = spawn_worker(args, path, context, &worker_id)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut current: Option<WorkerStatus> = None;
    let mut exited = None;
    while Instant::now() < deadline {
        if let Some(status) = read_status(path, session_id) {
            if status.worker_id != worker_id {
                clear(path, session_id);
                return Err(CliError(format!(
                    "A detached recording worker for session {session_id} is already {}.",
                    status.state
                ))
                .into());
            }
            let ready = status.state == "recording"
                || status.state == "paused"
                || status.is_terminal();
            current = Some(status);
            if ready {
                break;
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            exited = Some(status);
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if current.is_none() {
        if let Ok(snapshot) = super::open_ready(path, context) {
            if let Ok(Some(session)) = snapshot.get_record(
                crate::core::format::RecordType::SESSION,
                session_id,
            ) {
                let state = session.field("recording_state").unwrap_or("");
                if matches!(state, "completed" | "interrupted" | "failed" | "partial") {
                    current = Some(WorkerStatus {
                        session_id: session_id.to_owned(),
                        worker_id: worker_id.clone(),
                        pid: 0,
                        state: state.to_owned(),
                        message: session
                            .field("recording_error")
                            .filter(|value| !value.is_empty())
                            .unwrap_or("The recording worker has stopped.")
                            .to_owned(),
                        heartbeat_us: crate::core::archive::now_us(),
                    });
                }
            }
        }
    }
    let Some(status) = current else {
        clear(path, session_id);
        return Err(CliError(match exited {
            Some(exit) => format!(
                "The detached recording worker exited before audio capture became active (code {:?}).",
                exit.code()
            ),
            None => "The detached recording worker did not report a ready state within 60 seconds."
                .to_owned(),
        })
        .into());
    };
    let state = status.state.clone();
    let worker = if status.is_terminal() {
        "not-running"
    } else {
        "detached"
    };
    let summary = format!("Recording {state}: {}", status.message);
    let report = json!({
        "sessionId": session_id,
        "state": state.clone(),
        "message": status.message,
        "worker": worker,
        "workerId": status.worker_id,
    });
    emit(output, report, &summary, args.json());
    Ok(if matches!(state.as_str(), "recording" | "paused" | "completed") {
        0
    } else {
        1
    })
}

fn spawn_worker(
    args: &ParsedArguments,
    path: &Path,
    context: &CliContext,
    worker_id: &str,
) -> CliResult<std::process::Child> {
    let executable = std::env::current_exe()
        .map_err(|error| CliError(format!("The CLI executable could not be located: {error}")))?;
    let mut command = Command::new(executable);
    command.arg("--archive").arg(path);
    if context.passphrase().is_some() {
        command.arg("--passphrase-env").arg(PASSPHRASE_ENV);
        command.env(PASSPHRASE_ENV, context.passphrase().unwrap_or_default());
    }
    command.arg("record").arg("start");
    for (name, value) in &args.options {
        command.arg(format!("--{name}={value}"));
    }
    for flag in &args.flags {
        if flag != "detach" && flag != "json" {
            command.arg(format!("--{flag}"));
        }
    }
    command
        .env(WORKER_ID_ENV, worker_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
        .spawn()
        .map_err(|error| CliError(format!("The detached recording worker could not start: {error}")).into())
}
