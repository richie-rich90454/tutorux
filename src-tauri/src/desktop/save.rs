use super::{
    identity::{
        archive_changed_message, archive_identity, archive_identity_and_hasher,
        archive_location_changed_message, normalized_location_path, preserve_backup_error,
        resolve_existing_file, same_path,
    },
    state::{DesktopState, PendingSave, SavePreparation},
};
use crate::archive_lock_support::LockMode;
use std::{
    fs::{self, File},
    path::Path,
};
use tauri::{AppHandle, State};
use tauri_plugin_fs::FsExt;
use uuid::Uuid;

#[tauri::command]
pub(crate) fn prepare_archive_save(
    target_path: String,
    archive_token: Option<String>,
    create_only: bool,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<SavePreparation, String> {
    let source_archive_token = archive_token.clone();
    let target_location = normalized_location_path(Path::new(&target_path))?;
    let target = match resolve_existing_file(&target_location)? {
        Some(path) => path,
        None => target_location.clone(),
    };
    if create_only && target.exists() {
        return Err(
            "An archive already exists at this location. Choose a new filename to create a separate copy."
                .to_owned(),
        );
    }
    let target_lock = state.archive_locks.for_path(&target, LockMode::Shared)?;
    let _target_read_lock = state.archive_locks.shared_guard(&target_lock)?;
    let target_identity = if target.exists() {
        Some(archive_identity(&target)?)
    } else {
        None
    };
    drop(_target_read_lock);

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
                source_archive_token,
                create_only,
            },
        );
    Ok(SavePreparation {
        token,
        temporary_path: temporary.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub(crate) fn publish_archive_save(
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
    let target_lock = state
        .archive_locks
        .for_path(&pending.target, LockMode::Exclusive)?;
    let mut archive_write_lock = state.archive_locks.exclusive_guard(&target_lock)?;
    File::open(&pending.temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("The temporary archive could not be finalized: {error}"))?;

    match resolve_existing_file(&pending.target_location)? {
        Some(_) if pending.create_only => {
            return Err(
                "An archive appeared at this location. Choose a new filename; the existing archive was not changed."
                    .to_owned(),
            );
        }
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

    archive_write_lock.prepare_replacement_file(&pending.temporary)?;

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

    archive_write_lock.adopt_replacement_file()?;

    let _ = fs::remove_file(&pending.temporary);
    if pending.target_identity.is_some() {
        let _ = fs::remove_file(&backup);
        let _ = fs::remove_dir(&backup_directory);
    }
    if let Some(archive_token) = &pending.source_archive_token {
        let (identity, hasher) = archive_identity_and_hasher(&pending.target)?;
        let mut opened_archives = state
            .opened_archives
            .lock()
            .map_err(|_| "Archive access state is unavailable.".to_owned())?;
        if let Some(archive) = opened_archives.get_mut(archive_token) {
            archive_write_lock.retain_shared()?;
            archive.path = pending.target.clone();
            archive.location = pending.target_location.clone();
            archive.identity = identity;
            archive.hasher = hasher;
            archive.lock = target_lock.clone();
        }
    }
    pending_saves.remove(&token);
    let _ = app.fs_scope().forbid_file(&pending.temporary);
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_archive_save(
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
