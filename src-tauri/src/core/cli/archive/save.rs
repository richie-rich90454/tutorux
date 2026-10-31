use std::io::Write;
use std::path::Path;

use crate::core::cli::{CliError, CliResult};
use crate::core::error::{CoreError, Result};

pub(super) fn save_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
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
        return Err(CliError(format!(
            "Archive output already exists: {}",
            path.display()
        ))
        .into());
    }
    save_bytes(path, bytes)?;
    Ok(())
}

fn overwrite(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match overwrite_once(path, bytes) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied && attempt < 4 => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(error) => return Err(error),
        }
    }
}

fn overwrite_once(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
