use super::state::ArchiveIdentity;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const HASH_BUFFER_BYTES: usize = 8 * 1024 * 1024;

pub(crate) fn normalized_location_path(requested: &Path) -> Result<PathBuf, String> {
    let parent = location_parent(requested);
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Could not access destination folder: {error}"))?;
    let filename = requested
        .file_name()
        .ok_or_else(|| "Archive destination needs a file name.".to_owned())?;
    Ok(parent.join(filename))
}

pub(crate) fn normalized_save_location(requested: &Path) -> Result<PathBuf, String> {
    let parent = location_parent(requested);
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Could not create the destination folder {}: {error}",
            parent.display()
        )
    })?;
    normalized_location_path(requested)
}

fn location_parent(requested: &Path) -> &Path {
    requested
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

pub(crate) fn resolve_existing_file(path: &Path) -> Result<Option<PathBuf>, String> {
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

pub(crate) fn archive_identity(path: &Path) -> Result<ArchiveIdentity, String> {
    archive_identity_and_hasher(path).map(|(identity, _)| identity)
}

pub(crate) fn archive_identity_and_hasher(path: &Path) -> Result<(ArchiveIdentity, Sha256), String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not inspect archive: {error}"))?;
    archive_identity_from_file(&mut file)
}

pub(crate) fn archive_identity_from_file(
    file: &mut File,
) -> Result<(ArchiveIdentity, Sha256), String> {
    let before = file
        .metadata()
        .map_err(|error| format!("Could not inspect archive: {error}"))?;
    if !before.is_file() {
        return Err("The archive is not a regular file.".to_owned());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Could not inspect archive: {error}"))?;
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
    let digest = hasher.clone();
    Ok((
        ArchiveIdentity {
            size,
            sha256: format!("{:x}", hasher.finalize()),
        },
        digest,
    ))
}

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
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

pub(crate) fn same_open_file(path: &Path, file: &File) -> Result<bool, String> {
    let opened = file
        .metadata()
        .map_err(|error| format!("Could not inspect the authorized archive: {error}"))?;
    let named = fs::metadata(path)
        .map_err(|error| format!("Could not inspect the authorized archive: {error}"))?;
    if !opened.is_file() || !named.is_file() {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(opened.dev() == named.dev() && opened.ino() == named.ino())
    }
    #[cfg(windows)]
    {
        Ok(opened.len() == named.len()
            && opened.created().ok() == named.created().ok()
            && opened.modified().ok() == named.modified().ok())
    }
}

pub(crate) fn archive_changed_message() -> String {
    "This archive changed outside Tutorux since it was opened. Your in-memory work is still available; use Save As to keep it without replacing the external version.".to_owned()
}

pub(crate) fn archive_location_changed_message() -> String {
    "The archive destination now points to a different file than the one selected. Your in-memory work is still available; use Save As to choose a destination.".to_owned()
}

pub(crate) fn preserve_backup_error(backup: &Path, target: &Path, reason: String) -> String {
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

#[cfg(test)]
mod tests {
    use super::normalized_save_location;

    #[test]
    fn save_location_creates_missing_folders() {
        let root = tempfile::tempdir().expect("temp dir");
        let target = root
            .path()
            .join("courses")
            .join("algebra")
            .join("archive.tux");
        let normalized = normalized_save_location(&target).expect("normalize save location");
        assert!(normalized.parent().expect("parent").is_dir());
        assert_eq!(
            normalized.file_name().and_then(|name| name.to_str()),
            Some("archive.tux")
        );
    }
}
