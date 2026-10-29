mod ai_transport;
mod credentials;
mod platform;
mod transcription;

use serde::Serialize;
use sha2::{Digest, Sha256};
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
const HASH_BUFFER_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct ArchiveIdentity {
    size: u64,
    sha256: String,
}

#[derive(Clone)]
struct AuthorizedArchive {
    path: PathBuf,
    location: PathBuf,
    identity: ArchiveIdentity,
}

#[derive(Default)]
struct DesktopState {
    opened_archives: Mutex<HashMap<String, AuthorizedArchive>>,
    pending_saves: Mutex<HashMap<String, PendingSave>>,
    pending_open: Mutex<VecDeque<PathBuf>>,
}

#[derive(Clone)]
struct PendingSave {
    target: PathBuf,
    target_location: PathBuf,
    target_identity: Option<ArchiveIdentity>,
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
    let location = normalized_location_path(Path::new(&path))?;
    let selected =
        fs::canonicalize(&location).map_err(|error| format!("Could not open archive: {error}"))?;
    let metadata =
        fs::metadata(&selected).map_err(|error| format!("Could not inspect archive: {error}"))?;
    if !metadata.is_file() {
        return Err("The selected archive is not a regular file.".to_owned());
    }
    let identity = archive_identity(&selected)?;
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
        .insert(
            token.clone(),
            AuthorizedArchive {
                path: selected,
                location,
                identity: identity.clone(),
            },
        );
    Ok(ArchiveSelection {
        token,
        size: identity.size.to_string(),
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
        .map(|archive| archive.path.clone())
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
    archive_token: Option<String>,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<SavePreparation, String> {
    let target_location = normalized_location_path(Path::new(&target_path))?;
    let target = match resolve_existing_file(&target_location)? {
        Some(path) => path,
        None => target_location.clone(),
    };
    let target_identity = if target.exists() {
        Some(archive_identity(&target)?)
    } else {
        None
    };

    if let Some(archive_token) = archive_token {
        let archive = state
            .opened_archives
            .lock()
            .map_err(|_| "Archive access state is unavailable.".to_owned())?
            .get(&archive_token)
            .cloned()
            .ok_or_else(|| {
                "Archive access has expired. Reopen the file before saving.".to_owned()
            })?;
        let same_location = same_path(&target_location, &archive.location);
        let same_file = same_path(&target, &archive.path);
        if same_location || same_file {
            if same_location && !same_file {
                return Err(archive_location_changed_message());
            }
            if !same_file || target_identity.as_ref() != Some(&archive.identity) {
                return Err(archive_changed_message());
            }
        }
    }

    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "Could not determine the archive destination folder.".to_owned())?;

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
                target_location,
                target_identity,
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
    let mut pending_saves = state
        .pending_saves
        .lock()
        .map_err(|_| "Archive save state is unavailable.".to_owned())?;
    let pending = pending_saves
        .get(&token)
        .cloned()
        .ok_or_else(|| "Archive save has expired. Start the save again.".to_owned())?;
    File::open(&pending.temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("The temporary archive could not be finalized: {error}"))?;

    match resolve_existing_file(&pending.target_location)? {
        Some(path) if same_path(&path, &pending.target) => {}
        Some(_) => return Err(archive_location_changed_message()),
        None if pending.target_identity.is_some() => return Err(archive_changed_message()),
        None => {}
    }

    if let Some(expected) = &pending.target_identity {
        let current = archive_identity(&pending.target).map_err(|_| archive_changed_message())?;
        if &current != expected {
            return Err(archive_changed_message());
        }
    }

    let backup_directory = pending
        .target
        .with_file_name(format!(".tutorux-{token}.backup"));
    let backup = backup_directory.join("previous-archive");
    if pending.target_identity.is_some() {
        fs::create_dir(&backup_directory)
            .map_err(|error| format!("Could not reserve a safe archive backup: {error}"))?;
        if let Err(error) = fs::rename(&pending.target, &backup) {
            let _ = fs::remove_dir(&backup_directory);
            return Err(format!(
                "Could not move the previous archive into its recovery copy: {error}"
            ));
        }
        let moved_identity = match archive_identity(&backup) {
            Ok(identity) => identity,
            Err(error) => {
                return Err(preserve_backup_error(
                    &backup,
                    &pending.target,
                    format!("Could not verify the moved archive: {error}"),
                ));
            }
        };
        if Some(&moved_identity) != pending.target_identity.as_ref() {
            return Err(preserve_backup_error(
                &backup,
                &pending.target,
                archive_changed_message(),
            ));
        }
    }

    if let Err(error) = fs::hard_link(&pending.temporary, &pending.target) {
        if pending.target_identity.is_some() {
            return Err(preserve_backup_error(
                &backup,
                &pending.target,
                format!("Could not publish the completed archive safely: {error}"),
            ));
        }
        return Err(format!(
            "Could not publish the completed archive without replacing a file that appeared in the destination: {error}"
        ));
    }

    let _ = fs::remove_file(&pending.temporary);
    if pending.target_identity.is_some() {
        let _ = fs::remove_file(&backup);
        let _ = fs::remove_dir(&backup_directory);
    }
    pending_saves.remove(&token);
    let _ = app.fs_scope().forbid_file(&pending.temporary);
    Ok(())
}

fn normalized_location_path(requested: &Path) -> Result<PathBuf, String> {
    let parent = requested
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Could not access destination folder: {error}"))?;
    let filename = requested
        .file_name()
        .ok_or_else(|| "Archive destination needs a file name.".to_owned())?;
    Ok(parent.join(filename))
}

fn resolve_existing_file(path: &Path) -> Result<Option<PathBuf>, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let resolved = fs::canonicalize(path)
                .map_err(|error| format!("Could not inspect archive destination: {error}"))?;
            let metadata = fs::metadata(&resolved)
                .map_err(|error| format!("Could not inspect archive destination: {error}"))?;
            if !metadata.is_file() {
                return Err("The archive destination is not a regular file.".to_owned());
            }
            Ok(Some(resolved))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not inspect archive destination: {error}")),
    }
}

fn archive_identity(path: &Path) -> Result<ArchiveIdentity, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not inspect archive: {error}"))?;
    let before = file
        .metadata()
        .map_err(|error| format!("Could not inspect archive: {error}"))?;
    if !before.is_file() {
        return Err("The archive is not a regular file.".to_owned());
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; HASH_BUFFER_BYTES];
    let mut size = 0_u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not verify archive contents: {error}"))?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .ok_or_else(|| "Archive is too large to verify safely.".to_owned())?;
        hasher.update(&buffer[..count]);
    }
    let after = file
        .metadata()
        .map_err(|error| format!("Could not verify archive contents: {error}"))?;
    if size != before.len() || size != after.len() {
        return Err(
            "The archive changed while Tutorux was verifying it. Reopen it and try again."
                .to_owned(),
        );
    }
    Ok(ArchiveIdentity {
        size,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(any(windows, target_os = "macos"))]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        left == right
    }
}

fn archive_changed_message() -> String {
    "This archive changed outside Tutorux since it was opened. Your in-memory work is still available; use Save As to keep it without replacing the external version.".to_owned()
}

fn archive_location_changed_message() -> String {
    "The archive destination now points to a different file than the one selected. Your in-memory work is still available; use Save As to choose a destination.".to_owned()
}

fn preserve_backup_error(backup: &Path, target: &Path, reason: String) -> String {
    match fs::hard_link(backup, target) {
        Ok(()) => {
            let _ = fs::remove_file(backup);
            if let Some(directory) = backup.parent() {
                let _ = fs::remove_dir(directory);
            }
            reason
        }
        Err(restore_error) => format!(
            "{reason} Tutorux preserved the previous archive at {} because it could not safely restore it to the destination: {restore_error}",
            backup.display()
        ),
    }
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
        .manage(platform::audio_capture::AudioCaptureState::default())
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
            transcription::begin_whisper_run,
            transcription::cancel_whisper_run,
            transcription::end_whisper_run,
            transcription::transcribe_whisper,
            platform::audio_capture::begin_audio_capture,
            platform::audio_capture::append_audio_capture_chunk,
            platform::audio_capture::pause_audio_capture,
            platform::audio_capture::resume_audio_capture,
            platform::audio_capture::finish_audio_capture,
            platform::audio_capture::discard_audio_capture
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
