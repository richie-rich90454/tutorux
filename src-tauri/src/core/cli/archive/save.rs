use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::core::cli::{CliError, CliResult};
use crate::core::error::{CoreError, Result};

pub(crate) fn save_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
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
