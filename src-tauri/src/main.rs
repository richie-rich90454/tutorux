mod ai_transport;
mod credentials;
mod transcription;

use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    ipc::Response,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_fs::FsExt;
use uuid::Uuid;

const MAX_RANGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_EXPORT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Default)]
struct DesktopState {
    opened_archives: Mutex<HashMap<String, PathBuf>>,
    pending_saves: Mutex<HashMap<String, PendingSave>>,
    pending_open: Mutex<VecDeque<PathBuf>>,
}

#[derive(Clone)]
struct PendingSave {
    target: PathBuf,
    temporary: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveSelection {
    token: String,
    size: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavePreparation {
    token: String,
    temporary_path: String,
}

#[tauri::command]
fn authorize_archive_path(
    path: String,
    state: State<'_, DesktopState>,
) -> Result<ArchiveSelection, String> {
    let selected =
        fs::canonicalize(path).map_err(|error| format!("Could not open archive: {error}"))?;
    let metadata =
        fs::metadata(&selected).map_err(|error| format!("Could not inspect archive: {error}"))?;
    if !metadata.is_file() {
        return Err("The selected archive is not a regular file.".to_owned());
    }
    let token = Uuid::new_v4().to_string();
    let name = selected
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Tutorux archive.tux")
        .to_owned();
    state
        .opened_archives
        .lock()
        .map_err(|_| "Archive access state is unavailable.".to_owned())?
        .insert(token.clone(), selected);
    Ok(ArchiveSelection {
        token,
        size: metadata.len().to_string(),
        name,
    })
}

#[tauri::command]
fn close_archive(archive_token: String, state: State<'_, DesktopState>) -> Result<(), String> {
    state
        .opened_archives
        .lock()
        .map_err(|_| "Archive access state is unavailable.".to_owned())?
        .remove(&archive_token);
    Ok(())
}

#[tauri::command]
fn read_archive_range(
    archive_token: String,
    offset: String,
    length: usize,
    state: State<'_, DesktopState>,
) -> Result<Response, String> {
    if length > MAX_RANGE_BYTES {
        return Err("Archive reads are limited to 4 MiB per request.".to_owned());
    }
    let offset = offset
        .parse::<u64>()
        .map_err(|_| "Archive offset is invalid.".to_owned())?;
    let path = state
        .opened_archives
        .lock()
        .map_err(|_| "Archive access state is unavailable.".to_owned())?
        .get(&archive_token)
        .cloned()
        .ok_or_else(|| "Archive access has expired. Reopen the file to continue.".to_owned())?;
    let mut file = File::open(path).map_err(|error| format!("Could not read archive: {error}"))?;
    let size = file
        .metadata()
        .map_err(|error| format!("Could not inspect archive: {error}"))?
        .len();
    let end = offset
        .checked_add(length as u64)
        .ok_or_else(|| "Archive range is out of bounds.".to_owned())?;
    if end > size {
        return Err("Archive range is out of bounds.".to_owned());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Could not seek in archive: {error}"))?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Could not read archive: {error}"))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn prepare_archive_save(
    target_path: String,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<SavePreparation, String> {
    let requested_target = PathBuf::from(target_path);
    let parent = requested_target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Could not access destination folder: {error}"))?;
    let filename = requested_target
        .file_name()
        .ok_or_else(|| "Archive destination needs a file name.".to_owned())?;
    let target = parent.join(filename);
    if target.is_dir() {
        return Err("The archive destination is a folder.".to_owned());
    }

    let token = Uuid::new_v4().to_string();
    let temporary = parent.join(format!(".tutorux-{token}.partial"));
    app.fs_scope()
        .allow_file(&temporary)
        .map_err(|error| format!("Could not authorize the temporary archive: {error}"))?;
    state
        .pending_saves
        .lock()
        .map_err(|_| "Archive save state is unavailable.".to_owned())?
        .insert(
            token.clone(),
            PendingSave {
                target,
                temporary: temporary.clone(),
            },
        );
    Ok(SavePreparation {
        token,
        temporary_path: temporary.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn publish_archive_save(
    token: String,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let pending = state
        .pending_saves
        .lock()
        .map_err(|_| "Archive save state is unavailable.".to_owned())?
        .get(&token)
        .cloned()
        .ok_or_else(|| "Archive save has expired. Start the save again.".to_owned())?;
    File::open(&pending.temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("The temporary archive could not be finalized: {error}"))?;

    let backup = pending
        .target
        .with_file_name(format!(".tutorux-{token}.backup"));
    let had_target = pending.target.exists();
    if had_target {
        fs::rename(&pending.target, &backup)
            .map_err(|error| format!("Could not preserve the previous archive: {error}"))?;
    }
    if let Err(error) = fs::rename(&pending.temporary, &pending.target) {
        if had_target {
            let _ = fs::rename(&backup, &pending.target);
        }
        return Err(format!("Could not publish the new archive: {error}"));
    }
    if had_target {
        let _ = fs::remove_file(backup);
    }
    state
        .pending_saves
        .lock()
        .map_err(|_| "Archive save state is unavailable.".to_owned())?
        .remove(&token);
    let _ = app.fs_scope().forbid_file(&pending.temporary);
    Ok(())
}

#[tauri::command]
fn cancel_archive_save(
    token: String,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let pending = state
        .pending_saves
        .lock()
        .map_err(|_| "Archive save state is unavailable.".to_owned())?
        .remove(&token);
    if let Some(pending) = pending {
        let _ = fs::remove_file(&pending.temporary);
        let _ = app.fs_scope().forbid_file(&pending.temporary);
    }
    Ok(())
}

#[tauri::command]
fn take_pending_open_archive(state: State<'_, DesktopState>) -> Result<Option<String>, String> {
    let path = state
        .pending_open
        .lock()
        .map_err(|_| "Launch file state is unavailable.".to_owned())?
        .pop_front();
    Ok(path.map(|path| path.to_string_lossy().into_owned()))
}

fn archive_launch_path(
    arguments: impl IntoIterator<Item = PathBuf>,
    current_directory: &Path,
) -> Option<PathBuf> {
    arguments
        .into_iter()
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("tux"))
        })
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                current_directory.join(path)
            }
        })
}

#[tauri::command]
fn write_export_file(path: String, contents: String) -> Result<(), String> {
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("Transcript export exceeds the 256 MiB safety limit.".to_owned());
    }
    let requested = PathBuf::from(path);
    let parent = requested
        .parent()
        .filter(|folder| !folder.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Could not access export folder: {error}"))?;
    let filename = requested
        .file_name()
        .ok_or_else(|| "Export destination needs a file name.".to_owned())?;
    let target = parent.join(filename);
    if target.is_dir() {
        return Err("The export destination is a folder.".to_owned());
    }

    let token = Uuid::new_v4().to_string();
    let temporary = parent.join(format!(".tutorux-export-{token}.partial"));
    let backup = parent.join(format!(".tutorux-export-{token}.backup"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create transcript export: {error}"))?;
    if let Err(error) = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not write transcript export: {error}"));
    }
    drop(file);

    let had_target = target.exists();
    if had_target {
        if let Err(error) = fs::rename(&target, &backup) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("Could not preserve the existing export: {error}"));
        }
    }
    if let Err(error) = fs::rename(&temporary, &target) {
        if had_target {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not publish transcript export: {error}"));
    }
    if had_target {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn install_native_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();
    let open_archive = MenuItem::with_id(
        handle,
        "archive.open",
        "Open Archive…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let save_archive = MenuItem::with_id(
        handle,
        "archive.save",
        "Save Archive",
        true,
        Some("CmdOrCtrl+S"),
    )?;
    let quick_actions = MenuItem::with_id(
        handle,
        "app.quick-actions",
        "Quick Actions…",
        true,
        Some("CmdOrCtrl+K"),
    )?;
    let preferences = MenuItem::with_id(
        handle,
        "app.preferences",
        "Preferences…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let toggle_appearance = MenuItem::with_id(
        handle,
        "app.toggle-appearance",
        "Toggle Appearance",
        true,
        Some("CmdOrCtrl+Shift+L"),
    )?;
    let quit = MenuItem::with_id(
        handle,
        "app.quit",
        "Quit Tutorux",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let separator = PredefinedMenuItem::separator(handle)?;
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[&open_archive, &save_archive, &separator, &quit],
    )?;
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&quick_actions, &toggle_appearance, &preferences],
    )?;

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        handle,
        "Tutorux",
        true,
        &[
            &PredefinedMenuItem::about(handle, Some("About Tutorux"), None)?,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
    )?;
    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu])?;
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(DesktopState::default())
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, current_directory| {
                if let Some(path) = archive_launch_path(
                    arguments.into_iter().skip(1).map(PathBuf::from),
                    Path::new(&current_directory),
                ) {
                    if let Ok(mut pending) = app.state::<DesktopState>().pending_open.lock() {
                        pending.push_back(path);
                        let _ = app.emit("tutorux:native-command", "open-launch-archive");
                    }
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let current_directory = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            if let Some(path) = archive_launch_path(
                std::env::args_os().skip(1).map(PathBuf::from),
                &current_directory,
            ) {
                app.state::<DesktopState>()
                    .pending_open
                    .lock()
                    .map_err(|_| std::io::Error::other("Launch archive state is unavailable."))?
                    .push_back(path);
            }
            install_native_menu(app)
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "archive.open" => {
                let _ = app.emit("tutorux:native-command", "open");
            }
            "archive.save" => {
                let _ = app.emit("tutorux:native-command", "save");
            }
            "app.quick-actions" => {
                let _ = app.emit("tutorux:native-command", "quick-actions");
            }
            "app.preferences" => {
                let _ = app.emit("tutorux:native-command", "preferences");
            }
            "app.toggle-appearance" => {
                let _ = app.emit("tutorux:native-command", "toggle-appearance");
            }
            "app.quit" => app.exit(0),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            credentials::ai_credential_store_available,
            credentials::has_ai_credential,
            credentials::save_ai_credential,
            credentials::remove_ai_credential,
            authorize_archive_path,
            close_archive,
            read_archive_range,
            prepare_archive_save,
            publish_archive_save,
            cancel_archive_save,
            take_pending_open_archive,
            write_export_file,
            ai_transport::send_ai_request,
            transcription::transcribe_whisper
        ])
        .run(tauri::generate_context!())
        .expect("Tutorux desktop host failed to start");
}

#[cfg(test)]
mod tests {
    use super::archive_launch_path;
    use std::path::{Path, PathBuf};

    #[test]
    fn archive_launch_path_ignores_non_archives_and_resolves_relative_paths() {
        let cwd = Path::new("launch-directory");
        let path = archive_launch_path(
            [
                PathBuf::from("Tutorux.exe"),
                PathBuf::from("lessons/Math.TUX"),
                PathBuf::from("ignored.tux"),
            ],
            cwd,
        );

        assert_eq!(path, Some(cwd.join("lessons/Math.TUX")));
    }

    #[test]
    fn archive_launch_path_preserves_absolute_paths() {
        let absolute_path = std::env::current_dir()
            .expect("test working directory should be available")
            .join("lesson.tux");
        let path = archive_launch_path([absolute_path.clone()], Path::new("other-directory"));

        assert_eq!(path, Some(absolute_path));
    }
}
