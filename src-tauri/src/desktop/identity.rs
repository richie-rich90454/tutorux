use super::state::{ArchiveIdentity, DesktopState};
use crate::archive_lock_support::archive_lock_key;
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

/// Record the last identity Tutorux itself observed for a canonical archive path.
/// Every token and every write path for the same file shares this value, so a
/// re-authorization or a stale token cannot report Tutorux's own write as external.
pub(crate) fn remember_archive_identity(
    state: &DesktopState,
    path: &Path,
    identity: &ArchiveIdentity,
) -> Result<(), String> {
    let key = archive_lock_key(path)?;
    state
        .archive_identities
        .lock()
        .map_err(|_| "Archive identity state is unavailable.".to_owned())?
        .insert(key, identity.clone());
    Ok(())
}

pub(crate) fn known_archive_identity(
    state: &DesktopState,
    path: &Path,
) -> Result<Option<ArchiveIdentity>, String> {
    let key = archive_lock_key(path)?;
    Ok(state
        .archive_identities
        .lock()
        .map_err(|_| "Archive identity state is unavailable.".to_owned())?
        .get(&key)
        .cloned())
}

pub(crate) fn archive_identity_and_hasher(
    path: &Path,
) -> Result<(ArchiveIdentity, Sha256), String> {
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
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
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
        let named_file = File::open(path)
            .map_err(|error| format!("Could not inspect the authorized archive: {error}"))?;
        // File IDs identify the same file object. Timestamps are not reliable here:
        // our own append changes them and NTFS granularity differs between handles.
        Ok(
            match (
                windows_file_identity(file),
                windows_file_identity(&named_file),
            ) {
                (Some(left), Some(right)) => left == right,
                _ => opened.len() == named.len(),
            },
        )
    }
}

#[cfg(windows)]
fn windows_file_identity(file: &File) -> Option<(u32, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let result = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
    (result != 0).then(|| {
        (
            information.dwVolumeSerialNumber,
            (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        )
    })
}

pub(crate) fn archive_changed_message() -> String {
    "This archive changed outside Tutorux since it was opened. Your in-memory work is still available; use Save As to keep it without replacing the external version.".to_owned()
}

pub(crate) fn archive_location_changed_message() -> String {
    "The archive destination now points to a different file than the one selected. Your in-memory work is still available; use Save As to choose a destination.".to_owned()
}

pub(crate) fn preserve_backup_error(backup: &Path, target: &Path, reason: String) -> String {
    match move_file_without_replacing(backup, target) {
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

/// Move a same-volume file only when its destination does not already exist.
#[cfg(windows)]
pub(crate) fn move_file_without_replacing(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::{io, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::Storage::FileSystem::MoveFileW;

    fn nul_terminated_path(path: &Path) -> io::Result<Vec<u16>> {
        let mut encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
        if encoded.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows paths cannot contain a null character.",
            ));
        }
        encoded.push(0);
        Ok(encoded)
    }

    let source = nul_terminated_path(source)?;
    let target = nul_terminated_path(target)?;

    // SAFETY: both arguments are valid, NUL-terminated UTF-16 paths kept alive for the call.
    // MoveFileW reads these paths synchronously and fails if the destination already exists.
    let result = unsafe { MoveFileW(source.as_ptr(), target.as_ptr()) };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn move_file_without_replacing(source: &Path, target: &Path) -> std::io::Result<()> {
    // Hard-link creation is atomic and fails if another process recreated the target path.
    fs::hard_link(source, target)
}

#[cfg(test)]
mod tests {
    use super::{
        known_archive_identity, move_file_without_replacing, normalized_save_location,
        preserve_backup_error, remember_archive_identity, same_open_file,
    };
    use crate::desktop::state::{ArchiveIdentity, DesktopState};
    use std::fs;

    #[test]
    fn an_open_handle_matches_its_named_path() {
        let root = tempfile::tempdir().expect("temporary directory");
        let path = root.path().join("lesson.tux");
        fs::write(&path, b"archive").expect("write archive");
        let file = fs::File::open(&path).expect("open archive");
        assert!(same_open_file(&path, &file).expect("compare archive handle"));
    }

    #[test]
    fn identities_are_shared_by_canonical_path() {
        let root = tempfile::tempdir().expect("temporary directory");
        let path = root.path().join("lesson.tux");
        fs::write(&path, b"archive").expect("write archive");
        let state = DesktopState::default();
        let identity = ArchiveIdentity {
            size: 7,
            sha256: "ab".repeat(32),
        };

        assert_eq!(
            known_archive_identity(&state, &path).expect("read identity"),
            None
        );
        remember_archive_identity(&state, &path, &identity).expect("remember identity");
        assert_eq!(
            known_archive_identity(&state, &path).expect("read identity"),
            Some(identity)
        );
    }

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

    #[test]
    fn restoring_a_backup_never_replaces_a_file_that_appeared_at_the_destination() {
        let root = tempfile::tempdir().expect("temporary directory");
        let backup = root.path().join("backup.tux");
        let target = root.path().join("archive.tux");
        fs::write(&backup, b"original archive").expect("write recovery archive");
        fs::write(&target, b"external replacement").expect("write external replacement");

        let message = preserve_backup_error(
            &backup,
            &target,
            "The staged archive could not be published.".to_owned(),
        );

        assert!(message.contains("could not safely restore"));
        assert_eq!(
            fs::read(&backup).expect("read preserved backup"),
            b"original archive"
        );
        assert_eq!(
            fs::read(&target).expect("read external replacement"),
            b"external replacement"
        );
    }

    #[test]
    fn move_without_replacing_succeeds_when_the_destination_is_empty() {
        let root = tempfile::tempdir().expect("temporary directory");
        let source = root.path().join("source.tux");
        let target = root.path().join("target.tux");
        fs::write(&source, b"archive").expect("write staged archive");

        move_file_without_replacing(&source, &target).expect("move archive without replacement");

        #[cfg(windows)]
        assert!(!source.exists());
        #[cfg(not(windows))]
        assert!(source.exists());
        assert_eq!(
            fs::read(&target).expect("read published archive"),
            b"archive"
        );
    }
}
