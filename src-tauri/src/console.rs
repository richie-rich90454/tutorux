use crate::{
    archive_identity, archive_identity_and_hasher, resolve_existing_file, same_path,
    ArchiveIdentity, DesktopState,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_COMMAND_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const OUTPUT_CHUNK_BYTES: usize = 8 * 1024;
const MAX_QUEUED_OUTPUT_CHUNKS: usize = 16;
const OUTPUT_TRUNCATION_NOTICE: &str = "\n[Output truncated at 256 KiB.]\n";
const BUNDLED_NODE_VERSION: &str = "v24.21.0";

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsoleOutput {
    run_id: String,
    text: String,
}

struct CliRuntime {
    node: PathBuf,
    entry: PathBuf,
    version: String,
}

#[tauri::command]
pub async fn command_console_availability(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<ConsoleAvailability, String> {
    ensure_main_window(&window)?;
    let app_for_runtime = app.clone();
    let runtime =
        tauri::async_runtime::spawn_blocking(move || resolve_cli_runtime(&app_for_runtime))
            .await
            .map_err(|_| "The Tutorux command runtime check could not finish.".to_owned())?;
    Ok(match runtime {
        Ok(runtime) => ConsoleAvailability {
            available: true,
            message: format!("Tutorux CLI ready · bundled runtime {}", runtime.version),
        },
        Err(message) => ConsoleAvailability {
            available: false,
            message,
        },
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
    if input.len() > MAX_COMMAND_BYTES {
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

    let app_for_runtime = app.clone();
    let runtime_result =
        tauri::async_runtime::spawn_blocking(move || resolve_cli_runtime(&app_for_runtime)).await;
    let runtime = match runtime_result {
        Ok(Ok(runtime)) => runtime,
        Ok(Err(error)) => {
            if let Ok(mut runs) = console.runs.lock() {
                runs.remove(&run_id);
            }
            return Err(error);
        }
        Err(_) => {
            if let Ok(mut runs) = console.runs.lock() {
                runs.remove(&run_id);
            }
            return Err("The Tutorux command runtime could not be prepared.".to_owned());
        }
    };

    let app_for_worker = app.clone();
    let run_id_for_worker = run_id.clone();
    let path_for_worker = archive_path.clone();
    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        execute_console_command(
            &app_for_worker,
            &run_id_for_worker,
            &runtime,
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
    let archives = desktop
        .opened_archives
        .lock()
        .map_err(|_| "Archive access state is unavailable.".to_owned())?;
    let archive = archives.get(token).ok_or_else(|| {
        "The selected archive is no longer authorized. Reopen it first.".to_owned()
    })?;
    match resolve_existing_file(&archive.location)? {
        Some(path) if same_path(&path, &archive.path) => {}
        Some(_) => return Err("The selected archive location changed. Reopen the archive.".into()),
        None => return Err("The selected archive was moved or removed. Reopen it.".into()),
    }
    if archive_identity(&archive.path)? != archive.identity {
        return Err(
            "The selected archive changed outside Tutorux. Reopen it before running a command."
                .into(),
        );
    }
    Ok((archive.path.clone(), archive.identity.clone()))
}

fn resolve_cli_runtime(app: &AppHandle) -> Result<CliRuntime, String> {
    let runtime_directory = bundled_cli_directory(app).ok_or_else(|| {
        "The bundled Tutorux command runtime is missing. Repair or reinstall Tutorux to restore it.".to_owned()
    })?;
    let node = runtime_directory.join(if cfg!(windows) { "node.exe" } else { "node" });
    if !node.is_file() {
        return Err("Tutorux's bundled command runtime is missing. Repair or reinstall Tutorux to restore it.".to_owned());
    }
    let entry = runtime_directory.join("tutorux-cli.mjs");
    if !entry.is_file() {
        return Err(
            "Tutorux's bundled CLI is missing. Repair or reinstall Tutorux to restore it."
                .to_owned(),
        );
    }
    let output = bundled_node_command(&node)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            format!("Tutorux's bundled command runtime could not be started: {error}")
        })?;
    if !output.status.success() {
        return Err("Tutorux's bundled command runtime could not report its version. Repair or reinstall Tutorux to restore it.".to_owned());
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if version != BUNDLED_NODE_VERSION {
        return Err(format!(
            "Tutorux's bundled command runtime has an unexpected version ({version}). Repair or reinstall Tutorux to restore {}.",
            BUNDLED_NODE_VERSION
        ));
    }
    Ok(CliRuntime {
        node,
        entry,
        version,
    })
}

fn bundled_cli_directory(app: &AppHandle) -> Option<PathBuf> {
    let resource_directory = app.path().resource_dir().ok()?.join("console-runtime");
    if resource_directory.is_dir() {
        return Some(resource_directory);
    }

    if cfg!(debug_assertions) {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()?
            .join("dist")
            .join("console-runtime");
        return development.is_dir().then_some(development);
    }
    None
}

fn parse_command_line(input: &str) -> Result<Vec<String>, String> {
    let mut arguments = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut token_started = false;

    for character in input.chars() {
        if escaped {
            if quote == Some('"') && character != '"' && character != '\\' {
                token.push('\\');
            }
            token.push(character);
            escaped = false;
            continue;
        }
        if let Some(open_quote) = quote {
            if character == '\\' && open_quote == '"' {
                escaped = true;
            } else if character == open_quote {
                quote = None;
            } else {
                token.push(character);
            }
            token_started = true;
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
            token_started = true;
        } else if character.is_ascii_whitespace() {
            finish_token(&mut arguments, &mut token, &mut token_started);
        } else {
            token.push(character);
            token_started = true;
        }
    }

    if escaped {
        token.push('\\');
    }
    if quote.is_some() {
        return Err("Close the quoted command argument before running it.".to_owned());
    }
    finish_token(&mut arguments, &mut token, &mut token_started);
    if arguments
        .first()
        .is_some_and(|argument| argument == "tutorux")
    {
        arguments.remove(0);
    }
    if arguments.is_empty() {
        return Err("Enter a Tutorux command to run.".to_owned());
    }
    if arguments.iter().any(|argument| {
        argument == "--archive"
            || argument.starts_with("--archive=")
            || argument == "--directory"
            || argument.starts_with("--directory=")
    }) {
        return Err(
            "The command console always uses the selected archive and directory.".to_owned(),
        );
    }
    if arguments.iter().any(|argument| argument.contains('\0')) {
        return Err("A command argument contains an unsupported null character.".to_owned());
    }
    Ok(arguments)
}

fn finish_token(arguments: &mut Vec<String>, token: &mut String, token_started: &mut bool) {
    if !*token_started {
        return;
    }
    arguments.push(std::mem::take(token));
    *token_started = false;
}

fn reject_foreground_recording(arguments: &[String]) -> Result<(), String> {
    let mut command_index = 0;
    while let Some(argument) = arguments.get(command_index) {
        match argument.as_str() {
            "--json" | "--quiet" | "--verbose" | "--no-color" => command_index += 1,
            "--passphrase-env" | "--new-passphrase-env" => command_index += 2,
            value
                if value.starts_with("--passphrase-env=")
                    || value.starts_with("--new-passphrase-env=") =>
            {
                command_index += 1;
            }
            _ => break,
        }
    }
    if arguments
        .get(command_index)
        .is_some_and(|argument| argument == "record")
        && arguments
            .get(command_index + 1)
            .is_some_and(|argument| argument == "start")
        && !arguments.iter().any(|argument| argument == "--detach")
    {
        return Err("Run foreground recording from the CLI, or add --detach so the recording worker remains controllable outside this window.".to_owned());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn execute_console_command(
    app: &AppHandle,
    run_id: &str,
    runtime: &CliRuntime,
    archive_path: &Path,
    arguments: Vec<String>,
    passphrase: &Zeroizing<String>,
    new_passphrase: &Zeroizing<String>,
    cancellation: &AtomicBool,
) -> Result<ConsoleRunResult, String> {
    if cancellation.load(Ordering::Acquire) {
        return Ok(ConsoleRunResult {
            exit_code: 130,
            cancelled: true,
            archive_changed: false,
        });
    }
    let directory = archive_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut command = bundled_node_command(&runtime.node);
    command
        .arg(&runtime.entry)
        .arg("--archive")
        .arg(archive_path)
        .arg("--directory")
        .arg(directory)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let suffix = run_id.replace('-', "");
    let current_passphrase_env = format!("TUTORUX_CONSOLE_CURRENT_{suffix}");
    let new_passphrase_env = format!("TUTORUX_CONSOLE_NEW_{suffix}");
    let mut arguments = arguments;
    if !passphrase.is_empty() {
        if has_passphrase_env_option(&arguments, "--passphrase-env") {
            return Err("Enter the current passphrase in the console field or use --passphrase-env from your environment, not both.".to_owned());
        }
        command.env(&current_passphrase_env, passphrase.as_str());
        command.arg("--passphrase-env").arg(&current_passphrase_env);
    }
    if !new_passphrase.is_empty() {
        if !supports_new_passphrase(&arguments)
            && !has_passphrase_env_option(&arguments, "--new-passphrase-env")
        {
            return Err("A new passphrase is only used by archive init, encrypt, change-passphrase, or sanitize commands.".to_owned());
        }
        command.env(&new_passphrase_env, new_passphrase.as_str());
        if !replace_passphrase_env_option(
            &mut arguments,
            "--new-passphrase-env",
            &new_passphrase_env,
        ) {
            arguments.push("--new-passphrase-env".to_owned());
            arguments.push(new_passphrase_env.clone());
        }
    }
    command.args(&arguments);

    let mut child = command
        .spawn()
        .map_err(|error| format!("The Tutorux CLI could not be started: {error}"))?;
    drop(command);
    // Keep pipe-reader memory bounded even when a command writes faster than the WebView can
    // consume events. The event loop continues draining after the display cap is reached.
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(MAX_QUEUED_OUTPUT_CHUNKS);
    let stdout_reader = child.stdout.take().map(|stream| {
        let sender = sender.clone();
        thread::spawn(move || forward_output(stream, sender))
    });
    let stderr_reader = child.stderr.take().map(|stream| {
        let sender = sender.clone();
        thread::spawn(move || forward_output(stream, sender))
    });
    drop(sender);

    let stream_limit = MAX_OUTPUT_BYTES.saturating_sub(OUTPUT_TRUNCATION_NOTICE.len());
    let mut output_size = 0usize;
    let mut truncated = false;
    let mut process_status = None;
    let mut cancelled = false;
    let mut process_observation_failed = false;
    let mut process_error: Option<String> = None;
    loop {
        if cancellation.load(Ordering::Acquire) && process_status.is_none() {
            cancelled = true;
            let _ = child.kill();
        }
        if process_status.is_none() && !process_observation_failed {
            match child.try_wait() {
                Ok(status) => process_status = status,
                Err(_) => {
                    process_observation_failed = true;
                    process_error = Some(
                        "The Tutorux CLI process status could not be observed; it was stopped."
                            .to_owned(),
                    );
                    let _ = child.kill();
                }
            }
        }

        match receiver.recv_timeout(Duration::from_millis(30)) {
            Ok(chunk) => {
                let remaining = stream_limit.saturating_sub(output_size);
                if remaining > 0 {
                    let accepted = chunk.len().min(remaining);
                    let mut text = String::from_utf8_lossy(&chunk[..accepted]).into_owned();
                    let expanded_past_limit = text.len() > remaining;
                    if expanded_past_limit {
                        let mut end = remaining;
                        while !text.is_char_boundary(end) {
                            end -= 1;
                        }
                        text.truncate(end);
                    }
                    output_size += text.len();
                    if !text.is_empty() {
                        let _ = app.emit(
                            "tutorux:console-output",
                            ConsoleOutput {
                                run_id: run_id.to_owned(),
                                text,
                            },
                        );
                    }
                    if (accepted < chunk.len() || expanded_past_limit) && !truncated {
                        truncated = true;
                        let notice = OUTPUT_TRUNCATION_NOTICE;
                        let _ = app.emit(
                            "tutorux:console-output",
                            ConsoleOutput {
                                run_id: run_id.to_owned(),
                                text: notice.to_owned(),
                            },
                        );
                    }
                } else if !truncated {
                    truncated = true;
                    let notice = OUTPUT_TRUNCATION_NOTICE;
                    let _ = app.emit(
                        "tutorux:console-output",
                        ConsoleOutput {
                            run_id: run_id.to_owned(),
                            text: notice.to_owned(),
                        },
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if process_status.is_none() {
                    match child.wait() {
                        Ok(status) => process_status = Some(status),
                        Err(_) => {
                            process_error.get_or_insert_with(|| {
                                "The Tutorux CLI process could not report its final status."
                                    .to_owned()
                            });
                        }
                    }
                }
                break;
            }
        }
    }

    if let Some(reader) = stdout_reader {
        let _ = reader.join();
    }
    if let Some(reader) = stderr_reader {
        let _ = reader.join();
    }
    if let Some(message) = process_error {
        let _ = app.emit(
            "tutorux:console-output",
            ConsoleOutput {
                run_id: run_id.to_owned(),
                text: format!("\n{message}\n"),
            },
        );
    }
    let exit_code = process_status
        .and_then(|status| status.code())
        .unwrap_or(if cancelled { 130 } else { 1 });
    Ok(ConsoleRunResult {
        exit_code,
        cancelled,
        archive_changed: false,
    })
}

fn forward_output<R: Read>(mut stream: R, sender: mpsc::SyncSender<Vec<u8>>) {
    let mut buffer = vec![0; OUTPUT_CHUNK_BYTES];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(count) => {
                if sender.send(buffer[..count].to_vec()).is_err() {
                    return;
                }
            }
        }
    }
}

fn bundled_node_command(node: &Path) -> Command {
    let mut command = Command::new(node);
    command
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("NODE_REPL_EXTERNAL_MODULE")
        .env_remove("NODE_V8_COVERAGE")
        .env_remove("TUTORUX_AUDIO_HELPER");
    command
}

fn has_passphrase_env_option(arguments: &[String], option: &str) -> bool {
    arguments
        .iter()
        .any(|argument| argument == option || argument.starts_with(&format!("{option}=")))
}

fn replace_passphrase_env_option(arguments: &mut Vec<String>, option: &str, value: &str) -> bool {
    let mut found = false;
    let mut index = 0;
    while index < arguments.len() {
        if arguments[index] == option {
            if index + 1 < arguments.len() {
                arguments[index + 1] = value.to_owned();
            } else {
                arguments.push(value.to_owned());
            }
            found = true;
            index += 2;
        } else if arguments[index].starts_with(&format!("{option}=")) {
            arguments[index] = format!("{option}={value}");
            found = true;
            index += 1;
        } else {
            index += 1;
        }
    }
    found
}

fn supports_new_passphrase(arguments: &[String]) -> bool {
    let mut command = arguments;
    while let Some(argument) = command.first() {
        if matches!(
            argument.as_str(),
            "--json" | "--quiet" | "--verbose" | "--no-color"
        ) {
            command = &command[1..];
        } else if argument == "--passphrase-env" && command.len() >= 2 {
            command = &command[2..];
        } else {
            break;
        }
    }
    command.len() >= 2
        && command[0] == "archive"
        && matches!(
            command[1].as_str(),
            "init" | "encrypt" | "change-passphrase" | "sanitize"
        )
}
