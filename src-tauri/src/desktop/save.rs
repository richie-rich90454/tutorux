use super::{
    identity::{
        archive_changed_message, archive_identity, archive_identity_and_hasher,
        archive_location_changed_message, move_file_without_replacing, normalized_save_location,
        preserve_backup_error, resolve_existing_file, same_path,
    },
    state::{DesktopState, PendingSave, SaveKind, SavePreparation},
};
use crate::archive_lock_support::LockMode;
use std::{
    fs::{self, OpenOptions},
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
    kind: Option<SaveKind>,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<SavePreparation, String> {
    let source_archive_token = archive_token.clone();
    let kind = kind.unwrap_or_default();
    if kind == SaveKind::Archive && !target_path.to_ascii_lowercase().ends_with(".tux") {
        return Err("Archive saves must use a .tux file name.".to_owned());
    }
    let target_location = normalized_save_location(Path::new(&target_path))?;
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
    let mut pending_saves = state
        .pending_saves
        .lock()
        .map_err(|_| "Archive save state is unavailable.".to_owned())?;
    if pending_saves.len() >= 64 {
        let _ = app.fs_scope().forbid_file(&temporary);
        return Err(
            "Too many unfinished archive saves are open. Finish or cancel them before starting another."
                .to_owned(),
        );
    }
    pending_saves.insert(
        token.clone(),
        PendingSave {
            target,
            target_location,
            target_identity,
            temporary: temporary.clone(),
            source_archive_token,
            create_only,
            kind,
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
    let result = (|| -> Result<(), String> {
        let target_lock = state
            .archive_locks
            .for_path(&pending.target, LockMode::Exclusive)?;
        let mut archive_write_lock = state.archive_locks.exclusive_guard(&target_lock)?;
        validate_staged_archive_file(&pending)?;
        archive_write_lock.prepare_replacement_file(&pending.temporary)?;
        let backup = publish_staged_archive_file(&pending, &token)?;
        archive_write_lock.adopt_replacement_file()?;
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
        let _ = fs::remove_file(&pending.temporary);
        if let Some((backup_directory, backup)) = backup {
            let _ = fs::remove_file(backup);
            let _ = fs::remove_dir(backup_directory);
        }
        Ok(())
    })();
    if result.is_err() {
        pending_saves.remove(&token);
        let _ = fs::remove_file(&pending.temporary);
        let _ = app.fs_scope().forbid_file(&pending.temporary);
        let backup_directory = pending
            .target
            .with_file_name(format!(".tutorux-{token}.backup"));
        if pending.target.exists() {
            let _ = fs::remove_dir_all(backup_directory);
        }
    } else {
        pending_saves.remove(&token);
        let _ = app.fs_scope().forbid_file(&pending.temporary);
    }
    result
}

/// Revalidate the staged destination under its exclusive archive lock before publication.
fn validate_staged_archive_file(pending: &PendingSave) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .open(&pending.temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("The temporary archive could not be finalized: {error}"))?;
    if pending.kind == SaveKind::Archive {
        let staged = fs::read(&pending.temporary)
            .map_err(|error| format!("The completed archive could not be read back: {error}"))?;
        if staged.is_empty() {
            return Err("The completed archive is empty and was not published.".to_owned());
        }
        crate::core::archive::ArchiveSnapshot::open_bytes(staged).map_err(|error| {
            format!("The completed archive failed validation: {}", error.message)
        })?;
    }

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

    Ok(())
}

/// Existing destinations retain a recovery copy until the caller adopts the staged file lock.
/// Windows publishes with a no-replace same-folder move; other platforms use a no-clobber hard link.
fn publish_staged_archive_file(
    pending: &PendingSave,
    token: &str,
) -> Result<Option<(std::path::PathBuf, std::path::PathBuf)>, String> {
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

    let publish = move_file_without_replacing(&pending.temporary, &pending.target);
    if let Err(error) = publish {
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

    Ok(pending
        .target_identity
        .as_ref()
        .map(|_| (backup_directory, backup)))
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

#[cfg(test)]
mod tests {
    use super::{publish_staged_archive_file, validate_staged_archive_file};
    use crate::desktop::{
        identity::{archive_identity, normalized_location_path, resolve_existing_file},
        state::{PendingSave, SaveKind},
    };
    use std::{fs, path::Path};

    fn pending_save(
        target: &Path,
        temporary: &Path,
        target_identity: Option<crate::desktop::state::ArchiveIdentity>,
    ) -> PendingSave {
        let target_location = normalized_location_path(target).expect("normalize archive path");
        let target = resolve_existing_file(&target_location)
            .expect("inspect archive path")
            .unwrap_or_else(|| target_location.clone());
        PendingSave {
            target,
            target_location,
            target_identity,
            temporary: temporary.to_path_buf(),
            source_archive_token: None,
            create_only: false,
            kind: SaveKind::Export,
        }
    }

    #[test]
    fn archive_save_rejects_empty_and_truncated_staged_files() {
        let root = tempfile::tempdir().expect("temporary directory");
        let target = root.path().join("lesson.tux");
        let temporary = root.path().join(".staged-archive.partial");
        let mut pending = pending_save(&target, &temporary, None);
        pending.kind = SaveKind::Archive;

        fs::write(&temporary, b"").expect("write empty staged archive");
        let error = validate_staged_archive_file(&pending).expect_err("reject empty archive");
        assert!(error.contains("empty"));

        fs::write(&temporary, b"not an archive").expect("write truncated staged archive");
        let error = validate_staged_archive_file(&pending).expect_err("reject truncated archive");
        assert!(error.contains("failed validation"));
    }

    #[test]
    fn save_replaces_an_existing_archive_and_keeps_a_recovery_copy_until_adoption() {
        let root = tempfile::tempdir().expect("temporary directory");
        let target = root.path().join("lesson.tux");
        let temporary = root.path().join(".staged-archive.partial");
        fs::write(&target, b"previous archive").expect("write existing archive");
        fs::write(&temporary, b"updated archive").expect("write staged archive");
        let expected = archive_identity(&target).expect("identify existing archive");
        let pending = pending_save(&target, &temporary, Some(expected));

        validate_staged_archive_file(&pending).expect("validate existing destination");
        let (backup_directory, backup) = publish_staged_archive_file(&pending, "save-test")
            .expect("publish updated archive")
            .expect("existing destination backup");

        assert_eq!(
            fs::read(&target).expect("read updated archive"),
            b"updated archive"
        );
        assert_eq!(
            fs::read(&backup).expect("read recovery archive"),
            b"previous archive"
        );
        #[cfg(windows)]
        assert!(!temporary.exists(), "the staged file is moved into place");
        #[cfg(not(windows))]
        assert!(
            temporary.exists(),
            "the staged file remains linked until adoption"
        );
        fs::remove_file(backup).expect("remove recovery archive");
        fs::remove_dir(backup_directory).expect("remove recovery folder");
    }

    #[test]
    fn save_preserves_external_changes_and_refuses_to_publish_stale_work() {
        let root = tempfile::tempdir().expect("temporary directory");
        let target = root.path().join("lesson.tux");
        let temporary = root.path().join(".staged-archive.partial");
        fs::write(&target, b"archive at open").expect("write existing archive");
        let expected = archive_identity(&target).expect("identify existing archive");
        fs::write(&temporary, b"updated archive").expect("write staged archive");
        fs::write(&target, b"external edit").expect("simulate external edit");
        let pending = pending_save(&target, &temporary, Some(expected));

        let error = validate_staged_archive_file(&pending).expect_err("reject stale save");

        assert!(error.contains("changed outside Tutorux"));
        assert_eq!(
            fs::read(&target).expect("read externally changed archive"),
            b"external edit"
        );
        assert!(
            temporary.exists(),
            "the unsaved work remains available for recovery"
        );
    }

    #[test]
    fn save_as_publishes_a_new_archive() {
        let root = tempfile::tempdir().expect("temporary directory");
        let target = root.path().join("lesson.tux");
        let temporary = root.path().join(".staged-archive.partial");
        fs::write(&temporary, b"new archive").expect("write staged archive");
        let pending = pending_save(&target, &temporary, None);

        validate_staged_archive_file(&pending).expect("validate new destination");
        let backup =
            publish_staged_archive_file(&pending, "save-as-test").expect("publish new archive");

        assert!(backup.is_none());
        assert_eq!(fs::read(&target).expect("read new archive"), b"new archive");
        #[cfg(windows)]
        assert!(!temporary.exists(), "the staged file is moved into place");
        #[cfg(not(windows))]
        assert!(
            temporary.exists(),
            "the caller retains the staged-file lock until adoption"
        );
    }

    #[test]
    fn save_as_preserves_a_destination_that_appears_after_validation() {
        let root = tempfile::tempdir().expect("temporary directory");
        let target = root.path().join("lesson.tux");
        let temporary = root.path().join(".staged-archive.partial");
        fs::write(&temporary, b"new archive").expect("write staged archive");
        let pending = pending_save(&target, &temporary, None);

        validate_staged_archive_file(&pending).expect("validate new destination");
        fs::write(&target, b"external archive").expect("simulate racing destination");
        let error = publish_staged_archive_file(&pending, "save-as-race-test")
            .expect_err("do not replace a destination created after validation");

        assert!(error.contains("without replacing"));
        assert_eq!(
            fs::read(&target).expect("read racing destination"),
            b"external archive"
        );
        assert!(temporary.exists(), "the staged archive remains available");
    }
}
