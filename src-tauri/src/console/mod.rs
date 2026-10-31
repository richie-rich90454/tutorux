mod output;
mod parser;
mod session;

use crate::desktop::{
    archive_identity, archive_identity_and_hasher, resolve_existing_file, same_path,
    ArchiveIdentity, DesktopState,
};
use parser::{parse_command_line, reject_foreground_recording};
use serde::Serialize;
use session::execute_console_command;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, State, WebviewWindow};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Default)]
pub struct ConsoleState {
    runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleAvailability {
    available: bool,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleRunResult {
    exit_code: i32,
    cancelled: bool,
    archive_changed: bool,
}

#[tauri::command]
pub fn command_console_availability(window: WebviewWindow) -> Result<ConsoleAvailability, String> {
    ensure_main_window(&window)?;
    Ok(ConsoleAvailability {
        available: true,
        message: "In-process command runtime ready.".to_owned(),
    })
}

#[tauri::command]
pub async fn run_command_console(
    app: AppHandle,
    window: WebviewWindow,
    desktop: State<'_, DesktopState>,
    console: State<'_, ConsoleState>,
    run_id: String,
    archive_token: String,
    input: String,
    passphrase: String,
    new_passphrase: String,
) -> Result<ConsoleRunResult, String> {
    ensure_main_window(&window)?;
    let passphrase = Zeroizing::new(passphrase);
    let new_passphrase = Zeroizing::new(new_passphrase);
    Uuid::parse_str(&run_id).map_err(|_| "The console run identifier is invalid.".to_owned())?;
    if input.len() > parser::MAX_COMMAND_BYTES {
        return Err("Keep a console command under 64 KiB.".to_owned());
    }

    let arguments = parse_command_line(&input)?;
    reject_foreground_recording(&arguments)?;
    let (archive_path, starting_identity) = selected_archive_path(&desktop, &archive_token)?;
    let cancellation = Arc::new(AtomicBool::new(false));
    {
        let mut runs = console
            .runs
            .lock()
            .map_err(|_| "The command console is unavailable.".to_owned())?;
        if !runs.is_empty() {
            return Err(
                "A Tutorux command is already running. Wait for it to finish first.".to_owned(),
            );
        }
        runs.insert(run_id.clone(), Arc::clone(&cancellation));
    }

    let app_for_worker = app.clone();
    let run_id_for_worker = run_id.clone();
    let path_for_worker = archive_path.clone();
    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        execute_console_command(
            &app_for_worker,
            &run_id_for_worker,
            &path_for_worker,
            arguments,
            &passphrase,
            &new_passphrase,
            &cancellation,
        )
    })
    .await;
    if let Ok(mut runs) = console.runs.lock() {
        runs.remove(&run_id);
    }
    let worker_result = match worker_result {
        Ok(result) => result,
        Err(_) => Err("The Tutorux command worker stopped unexpectedly.".to_owned()),
    };

    // The command may have replaced the archive on disk. Refresh the authorized identity so the
    // open workspace can reopen it without tripping external-change protection.
    let path_for_identity = archive_path.clone();
    let identity_result = tauri::async_runtime::spawn_blocking(move || {
        archive_identity_and_hasher(&path_for_identity)
    })
    .await;
    let archive_changed = match identity_result {
        Ok(Ok((identity, hasher))) => {
            let changed = identity != starting_identity;
            if changed {
                if let Ok(mut archives) = desktop.opened_archives.lock() {
                    if let Some(archive) = archives.get_mut(&archive_token) {
                        if same_path(&archive.path, &archive_path) {
                            archive.identity = identity;
                            archive.hasher = hasher;
                        }
                    }
                }
            }
            changed
        }
        Ok(Err(error)) => {
            if worker_result.is_ok() {
                return Err(error);
            }
            false
        }
        Err(_) => {
            if worker_result.is_ok() {
                return Err(
                    "Tutorux could not refresh the selected archive after the command.".to_owned(),
                );
            }
            false
        }
    };
    let mut result = worker_result?;
    result.archive_changed = archive_changed;
    Ok(result)
}

#[tauri::command]
pub fn cancel_command_console(
    window: WebviewWindow,
    console: State<'_, ConsoleState>,
    run_id: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let runs = console
        .runs
        .lock()
        .map_err(|_| "The command console is unavailable.".to_owned())?;
    let stop = runs
        .get(&run_id)
        .ok_or_else(|| "That console command is no longer running.".to_owned())?;
    stop.store(true, Ordering::Release);
    Ok(())
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("The command console is only available in the main Tutorux window.".to_owned());
    }
    Ok(())
}

fn selected_archive_path(
    desktop: &DesktopState,
    token: &str,
) -> Result<(PathBuf, ArchiveIdentity), String> {
    let (path, location, identity) = {
        let archives = desktop
            .opened_archives
            .lock()
            .map_err(|_| "Archive access state is unavailable.".to_owned())?;
        let archive = archives.get(token).ok_or_else(|| {
            "The selected archive is no longer authorized. Reopen it first.".to_owned()
        })?;
        (
            archive.path.clone(),
            archive.location.clone(),
            archive.identity.clone(),
        )
    };
    match resolve_existing_file(&location)? {
        Some(current) if same_path(&current, &path) => {}
        Some(_) => return Err("The selected archive location changed. Reopen the archive.".into()),
        None => return Err("The selected archive was moved or removed. Reopen it.".into()),
    }
    if archive_identity(&path)? != identity {
        return Err(
            "The selected archive changed outside Tutorux. Reopen it before running a command."
                .into(),
        );
    }
    Ok((path, identity))
}
