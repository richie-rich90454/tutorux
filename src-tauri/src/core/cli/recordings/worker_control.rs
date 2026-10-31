use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::core::archive::{now_us, ArchiveSnapshot};
use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::RecordType;

use super::helpers::{open_unlocked, require_session};
use super::native_capture::{
    clear_control_files, read_worker_status, write_worker_command, WorkerStatus,
};

pub(super) fn status(
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let Some(session_id) = args.option("session").map(str::to_lowercase) else {
        let active = snapshot
            .list_records(RecordType::SESSION, false)?
            .iter()
            .filter(|session| {
                matches!(
                    session.field("recording_state"),
                    Some("starting")
                        | Some("initializing")
                        | Some("recording")
                        | Some("paused")
                        | Some("finalizing")
                )
            })
            .count();
        emit(
            output,
            json!({"active_recordings": active.to_string()}),
            &format!("Active recording sessions: {active}."),
            args.json(),
        );
        return Ok(0);
    };
    let session = require_session(&snapshot, &session_id)?;
    if let Some(status) = read_worker_status(path, &session_id) {
        if !status.is_stale() {
            emit_status(output, &status, args.json());
            return Ok(0);
        }
        clear_control_files(path, &session_id);
        if matches!(
            session.field("recording_state"),
            Some("starting") | Some("initializing") | Some("recording") | Some("paused") | Some("finalizing")
        ) {
            expire(path, &snapshot, &session_id)?;
            let message = "The detached recording worker exited unexpectedly; committed audio chunks can be recovered.";
            emit(
                output,
                json!({
                    "sessionId": session_id,
                    "state": "interrupted",
                    "message": message,
                    "worker": "not-running",
                }),
                &format!("Recording state: interrupted\n{message}"),
                args.json(),
            );
            return Ok(0);
        }
    }
    let raw_state = session.field("recording_state").unwrap_or("not-started");
    let state = control_state(raw_state);
    let message = session
        .field("recording_error")
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!("Archive recording state is '{raw_state}'. No detached worker is connected.")
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

pub(super) fn action(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_unlocked(path, context)?;
    let session_id = args.required_option("session")?.to_lowercase();
    require_session(&snapshot, &session_id)?;
    let Some(status) = read_worker_status(path, &session_id) else {
        return Err(CliError(format!(
            "No detached recording worker is active for session {session_id}."
        ))
        .into());
    };
    if status.is_stale() {
        clear_control_files(path, &session_id);
        expire(path, &snapshot, &session_id)?;
        return Err(CliError(format!(
            "No detached recording worker is active for session {session_id}."
        ))
        .into());
    }
    match action {
        "pause" => {
            if status.state != "recording" {
                return Err(CliError("Recording is not in the active state.".to_owned()).into());
            }
            write_worker_command(path, &session_id, true, false).map_err(CliError)?;
        }
        "resume" => {
            if status.state != "paused" {
                return Err(CliError("Recording is not paused.".to_owned()).into());
            }
            write_worker_command(path, &session_id, false, false).map_err(CliError)?;
        }
        "stop" => {
            if status.is_terminal() {
                clear_control_files(path, &session_id);
                emit_status(output, &status, args.json());
                return Ok(0);
            }
            write_worker_command(path, &session_id, false, true).map_err(CliError)?;
        }
        _ => {
            return Err(CliError(format!("Unknown recording control action: {action}.")).into())
        }
    }
    let expected = match action {
        "pause" => Some("paused"),
        "resume" => Some("recording"),
        _ => None,
    };
    let deadline = Instant::now()
        + if action == "stop" {
            Duration::from_secs(30)
        } else {
            Duration::from_secs(5)
        };
    let mut current = status;
    while Instant::now() < deadline {
        if let Some(status) = read_worker_status(path, &session_id) {
            current = status;
            if expected.is_some_and(|expected| expected == current.state)
                || (action == "stop" && current.is_terminal())
            {
                break;
            }
        } else if action == "stop" {
            let fresh = open_unlocked(path, context)?;
            if let Some(session) = fresh
                .get_record(RecordType::SESSION, &session_id)?
                .filter(|session| !session.deleted())
            {
                let state = control_state(session.field("recording_state").unwrap_or(""));
                if matches!(state, "completed" | "interrupted" | "partial" | "failed") {
                    current.state = state.to_owned();
                    current.message = session
                        .field("recording_error")
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| "The recording worker has stopped.".to_owned());
                    break;
                }
            } else {
                break;
            }
        } else {
            return Err(CliError(
                "The detached recording worker stopped before confirming the requested state."
                    .to_owned(),
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let confirmed = expected.is_some_and(|expected| expected == current.state)
        || (action == "stop"
            && matches!(
                current.state.as_str(),
                "completed" | "interrupted" | "partial" | "failed"
            ));
    if action == "stop" && confirmed {
        clear_control_files(path, &session_id);
    }
    emit_status(output, &current, args.json());
    Ok(if confirmed { 0 } else { 2 })
}

fn expire(path: &Path, snapshot: &ArchiveSnapshot, session_id: &str) -> CliResult<()> {
    let Some(mut session) = snapshot
        .get_record(RecordType::SESSION, session_id)?
        .filter(|session| !session.deleted())
    else {
        return Ok(());
    };
    if !matches!(
        session.field("recording_state"),
        Some("starting") | Some("initializing") | Some("recording") | Some("paused") | Some("finalizing")
    ) {
        return Ok(());
    }
    session
        .fields
        .insert("recording_state".to_owned(), "interrupted".to_owned());
    session.fields.insert(
        "recording_error".to_owned(),
        "The detached recording worker exited unexpectedly; committed audio chunks can be recovered."
            .to_owned(),
    );
    session
        .fields
        .insert("updated_at_us".to_owned(), now_us().to_string());
    let next = snapshot.append_records(&[session])?;
    crate::core::cli::records::save_replacing(path, &next)?;
    Ok(())
}

fn emit_status(output: &mut dyn CliOutput, status: &WorkerStatus, json_output: bool) {
    let mut report = json!({
        "sessionId": status.session_id,
        "state": status.state,
        "message": status.message,
        "worker": if status.is_terminal() { "not-running" } else { "detached" },
    });
    if !status.is_terminal() {
        report["workerId"] = json!(status.worker_id);
    }
    emit(
        output,
        report,
        &format!("Recording state: {}\n{}", status.state, status.message),
        json_output,
    );
}

fn control_state(state: &str) -> &str {
    match state {
        "starting" | "initializing" | "recording" | "paused" | "finalizing" | "completed"
        | "interrupted" | "failed" => state,
        "partial" => "partial",
        _ => "not-started",
    }
}
