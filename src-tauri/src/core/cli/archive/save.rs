use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::core::cli::{CliError, CliResult};
use crate::core::error::{CoreError, Result};

fn stage(path: &Path, bytes: &[u8]) -> Result<tempfile::NamedTempFile> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| {
        CoreError::new(
            "archive_write_failed",
            format!("Could not create the archive directory: {error}"),
        )
    })?;
    let mut staged = tempfile::Builder::new()
        .prefix(".tutorux-")
        .suffix(".partial")
        .tempfile_in(parent)
        .map_err(|error| {
            CoreError::new(
                "archive_write_failed",
                format!("Could not create a temporary file: {error}"),
            )
        })?;
    staged.write_all(bytes).map_err(|error| {
        CoreError::new(
            "archive_write_failed",
            format!("Could not write the archive: {error}"),
        )
    })?;
    staged.as_file().sync_all().map_err(|error| {
        CoreError::new(
            "archive_write_failed",
            format!("Could not flush the archive: {error}"),
        )
    })?;
    Ok(staged)
}

pub(crate) fn save_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let staged = stage(path, bytes)?;
    let persist_error = match staged.persist(path) {
        Ok(_) => return Ok(()),
        Err(error) => error,
    };
    let tempfile::PersistError { error, file } = persist_error;
    // Windows refuses to replace a destination that another handle still has open. The complete
    // buffer is already staged and synced, so replacing the destination in place cannot publish
    // a partial archive; the staged file remains for cleanup if the fallback also fails.
    match overwrite(path, bytes) {
        Ok(()) => {
            drop(file);
            Ok(())
        }
        Err(overwrite) => Err(CoreError::new(
            "archive_write_failed",
            format!(
                "Could not publish the archive: {error}; in-place replacement also failed: {overwrite}"
            ),
        )),
    }
}

/// Replace an existing archive while holding its exclusive lock.
///
/// `expected` is the complete archive image observed before the lock was taken. Verification
/// reads through the locked handle because Windows cannot read the file through a second handle
/// while the exclusive byte-range lock is held. Publication moves the old file aside and renames
/// the staged replacement into place, so a locked destination is never overwritten in place.
pub(crate) fn replace_existing(path: &Path, expected: &[u8], replacement: &[u8]) -> CliResult<()> {
    if let Some(shared) =
        crate::archive_lock_support::ambient_archive_lock(path).map_err(CliError)?
    {
        let mut archive_lock = shared
            .lock()
            .map_err(|_| CliError("The archive lock is unavailable.".to_owned()))?;
        let was_shared = archive_lock.mode() == Some(crate::archive_lock_support::LockMode::Shared);
        if archive_lock.mode() != Some(crate::archive_lock_support::LockMode::Exclusive) {
            archive_lock.try_upgrade().map_err(CliError)?;
        }
        let result = replace_existing_locked(&mut archive_lock, path, expected, replacement);
        if was_shared {
            let _ = archive_lock.downgrade();
        }
        return result;
    }
    let mut archive_lock = crate::archive_lock_support::ArchiveLock::try_acquire(
        path,
        crate::archive_lock_support::LockMode::Exclusive,
    )
    .map_err(CliError)?;
    replace_existing_locked(&mut archive_lock, path, expected, replacement)
}

fn replace_existing_locked(
    archive_lock: &mut crate::archive_lock_support::ArchiveLock,
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
) -> CliResult<()> {
    let current = archive_lock.read_archive_bytes().map_err(CliError)?;
    if current != expected {
        return Err(CliError(
            "The archive changed on disk after this operation started. Reopen it and retry; no changes were written."
                .to_owned(),
        )
        .into());
    }

    let staged = stage(path, replacement)?;
    let (staged_file, staged_path) = staged.keep().map_err(|error| {
        CliError(format!(
            "Could not retain the staged archive: {}",
            error.error
        ))
    })?;
    drop(staged_file);
    if let Err(error) = archive_lock.prepare_replacement_file(&staged_path) {
        let _ = std::fs::remove_file(&staged_path);
        return Err(CliError(error).into());
    }

    let backup = path.with_file_name(format!(".tutorux-{}.backup", uuid::Uuid::new_v4()));
    if let Err(error) = std::fs::rename(path, &backup) {
        let _ = std::fs::remove_file(&staged_path);
        return Err(CliError(format!(
            "Could not move the previous archive into its recovery copy: {error}"
        ))
        .into());
    }
    if let Err(error) = std::fs::rename(&staged_path, path) {
        let _ = std::fs::remove_file(&staged_path);
        return Err(match std::fs::rename(&backup, path) {
            Ok(()) => CliError(format!(
                "Could not publish the archive: {error}; the previous archive was restored."
            )),
            Err(restore) => CliError(format!(
                "Could not publish the archive: {error}; the previous archive remains at {}: {restore}",
                backup.display()
            )),
        }
        .into());
    }
    archive_lock.adopt_replacement_file().map_err(CliError)?;
    let _ = std::fs::remove_file(&backup);
    Ok(())
}

pub(super) fn write_new_archive(path: &Path, bytes: &[u8]) -> CliResult<()> {
    if path.exists() {
        return Err(CliError(format!("Archive output already exists: {}", path.display())).into());
    }
    save_bytes(path, bytes)?;
    Ok(())
}

fn overwrite(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let backup = if path.exists() {
        let mut backup = tempfile::Builder::new()
            .prefix(".tutorux-")
            .suffix(".backup")
            .tempfile_in(parent)?;
        let mut source = std::fs::File::open(path)?;
        std::io::copy(&mut source, backup.as_file_mut())?;
        backup.as_file().sync_all()?;
        Some(backup)
    } else {
        None
    };
    let mut attempt = 0;
    let result = loop {
        attempt += 1;
        match overwrite_once(path, bytes) {
            Ok(()) => break Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied && attempt < 4 => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(error) => break Err(error),
        }
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            if let Some(backup) = backup {
                match backup.persist(path) {
                    Ok(_) => Err(error),
                    Err(persist_error) => {
                        let backup_path: PathBuf = persist_error.file.path().to_path_buf();
                        let restore = persist_error.file.persist(path);
                        let restore_note = match restore {
                            Ok(_) => "the previous archive was restored".to_owned(),
                            Err(restore_error) => format!(
                                "the previous archive remains at {} ({})",
                                backup_path.display(),
                                restore_error.error
                            ),
                        };
                        Err(std::io::Error::new(
                            error.kind(),
                            format!("{error}; {restore_note}"),
                        ))
                    }
                }
            } else {
                let _ = std::fs::remove_file(path);
                Err(error)
            }
        }
    }
}

fn overwrite_once(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(bytes)?;
    file.set_len(bytes.len() as u64)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::overwrite;

    #[test]
    fn overwrite_restores_original_bytes_when_the_in_place_write_fails() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("archive.tux");
        std::fs::write(&path, b"original archive").expect("write original archive");

        // Keep the file readable and replaceable, but not writable, so only the in-place rewrite
        // fails and the backup restore path runs.
        #[cfg(windows)]
        let _open_without_write_access = {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_SHARE_READ: u32 = 0x0000_0001;
            const FILE_SHARE_DELETE: u32 = 0x0000_0004;
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
                .open(&path)
                .expect("hold the archive without write sharing")
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444))
                .expect("make the archive read-only");
        }

        overwrite(&path, b"replacement archive").expect_err("in-place overwrite must fail");

        assert_eq!(
            std::fs::read(&path).expect("read restored archive"),
            b"original archive"
        );
    }
}
