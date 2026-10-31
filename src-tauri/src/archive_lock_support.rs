//! Cross-process archive locks shared by the desktop host and native CLI helper.
//!
//! Path-keyed locks preserve identity across atomic replacement; locks on the opened archive file
//! also coordinate hard-link aliases while they refer to the same file object.

use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File, OpenOptions, TryLockError},
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockMode {
    Shared,
    Exclusive,
}

pub struct ArchiveLock {
    file: File,
    archive_file: Option<File>,
    replacement_file: Option<File>,
    archive_path: PathBuf,
    mode: Option<LockMode>,
}

impl ArchiveLock {
    pub fn try_acquire(path: &Path, mode: LockMode) -> Result<Self, String> {
        let archive_path = canonical_archive_path(path)?;
        let target = lock_file_path(&archive_path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Prevent the lock file from being renamed while handles are open. The file itself
            // is never replaced or removed; only the archive next to it is atomically replaced.
            options.share_mode(0x0000_0001 | 0x0000_0002);
        }

        let file = options
            .open(&target)
            .map_err(|error| format!("Could not open the archive lock: {error}"))?;
        lock_file(&file, mode, "archive path")?;
        let archive_file = match lock_archive_file(&archive_path, mode) {
            Ok(file) => file,
            Err(error) => {
                let _ = file.unlock();
                return Err(error);
            }
        };
        Ok(Self {
            file,
            archive_file,
            replacement_file: None,
            archive_path,
            mode: Some(mode),
        })
    }

    pub fn mode(&self) -> Option<LockMode> {
        self.mode
    }

    pub fn try_reacquire(&mut self, mode: LockMode) -> Result<(), String> {
        if self.mode.is_some() {
            return Err(
                "The archive lock must be released before it can be reacquired.".to_owned(),
            );
        }
        self.release_replacement_file();
        self.release_archive_file();
        lock_file(&self.file, mode, "archive path")?;
        let archive_file = match lock_archive_file(&self.archive_path, mode) {
            Ok(file) => file,
            Err(error) => {
                let _ = self.file.unlock();
                return Err(error);
            }
        };
        self.archive_file = archive_file;
        self.mode = Some(mode);
        Ok(())
    }

    /// Upgrade path identity first, then the opened archive's file identity.
    ///
    /// The path lock remains stable when the archive is replaced. The archive handle lock also
    /// coordinates hard-link aliases while both processes still refer to the same file object.
    /// The conversion briefly releases each shared lock; on failure both shared locks are
    /// restored before returning, and callers must revalidate their source identity after success.
    pub fn try_upgrade(&mut self) -> Result<(), String> {
        match self.mode {
            Some(LockMode::Exclusive) => return Ok(()),
            Some(LockMode::Shared) => {}
            None => return Err("The archive lock has already been released.".to_owned()),
        }
        if self.replacement_file.is_some() {
            return Err(
                "Adopt or discard the staged replacement before upgrading the archive lock."
                    .to_owned(),
            );
        }

        self.file
            .unlock()
            .map_err(|error| format!("Could not begin archive path-lock upgrade: {error}"))?;
        self.mode = None;
        match self.file.try_lock() {
            Ok(()) => {
                self.mode = Some(LockMode::Exclusive);
            }
            Err(TryLockError::WouldBlock) => {
                self.restore_path_shared()?;
                return Err(locked_error("archive path"));
            }
            Err(TryLockError::Error(error)) => {
                self.restore_path_shared()?;
                return Err(format!("Could not upgrade archive path lock: {error}"));
            }
        }

        if let Err(error) = self.upgrade_archive_file() {
            if let Err(restore_error) = self.restore_path_shared() {
                return Err(format!(
                    "{error} Could not restore the shared archive path lock: {restore_error}"
                ));
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn downgrade(&mut self) -> Result<(), String> {
        match self.mode {
            Some(LockMode::Shared) => return Ok(()),
            Some(LockMode::Exclusive) => {}
            None => return Err("The archive lock has already been released.".to_owned()),
        }
        self.release_replacement_file();
        self.downgrade_archive_file()?;
        self.file
            .unlock()
            .map_err(|error| format!("Could not release the archive path write lock: {error}"))?;
        self.mode = None;
        match self.file.lock_shared() {
            Ok(()) => {
                self.mode = Some(LockMode::Shared);
                Ok(())
            }
            Err(error) => {
                self.release_archive_file();
                Err(format!(
                    "Could not restore the shared archive path lock: {error}"
                ))
            }
        }
    }

    pub fn release(&mut self) -> Result<(), String> {
        if self.mode.is_none() {
            self.release_replacement_file();
            self.release_archive_file();
            return Ok(());
        }
        self.release_replacement_file();
        if let Some(file) = self.archive_file.as_ref() {
            file.unlock()
                .map_err(|error| format!("Could not release the archive file lock: {error}"))?;
        }
        self.archive_file = None;
        self.file
            .unlock()
            .map_err(|error| format!("Could not release the archive path lock: {error}"))?;
        self.mode = None;
        Ok(())
    }

    /// Lock a staged replacement before publication so its file identity stays protected
    /// continuously when it becomes the archive at `archive_path`.
    pub fn prepare_replacement_file(&mut self, replacement_path: &Path) -> Result<(), String> {
        if self.mode != Some(LockMode::Exclusive) {
            return Err(
                "A replacement file can only be prepared while holding the exclusive archive lock."
                    .to_owned(),
            );
        }
        if self.replacement_file.is_some() {
            return Err("An archive replacement file is already prepared.".to_owned());
        }
        self.replacement_file = lock_archive_file(replacement_path, LockMode::Exclusive)?;
        if self.replacement_file.is_none() {
            return Err("The staged archive replacement does not exist.".to_owned());
        }
        Ok(())
    }

    /// Adopt the already locked staged file after it has been published at the archive path.
    pub fn adopt_replacement_file(&mut self) -> Result<(), String> {
        if self.mode != Some(LockMode::Exclusive) {
            return Err(
                "A replacement file can only be adopted while holding the exclusive archive lock."
                    .to_owned(),
            );
        }
        let replacement = self
            .replacement_file
            .take()
            .ok_or_else(|| "No locked archive replacement is prepared.".to_owned())?;
        self.archive_file = Some(replacement);
        Ok(())
    }

    fn upgrade_archive_file(&mut self) -> Result<(), String> {
        let Some(shared_file) = self.archive_file.take() else {
            self.archive_file = lock_archive_file(&self.archive_path, LockMode::Exclusive)?;
            return Ok(());
        };
        if let Err(error) = shared_file.unlock() {
            self.archive_file = Some(shared_file);
            return Err(format!(
                "Could not begin archive file-lock upgrade: {error}"
            ));
        }
        match lock_archive_file(&self.archive_path, LockMode::Exclusive) {
            Ok(exclusive_file) => {
                self.archive_file = exclusive_file;
                Ok(())
            }
            Err(error) => {
                match shared_file.lock_shared() {
                    Ok(()) => {
                        self.archive_file = Some(shared_file);
                        Err(error)
                    }
                    Err(restore_error) => {
                        let _ = self.file.unlock();
                        self.mode = None;
                        Err(format!("{error} Could not restore the shared archive file lock: {restore_error}"))
                    }
                }
            }
        }
    }

    fn downgrade_archive_file(&mut self) -> Result<(), String> {
        let Some(file) = self.archive_file.as_ref() else {
            return Ok(());
        };
        file.unlock()
            .map_err(|error| format!("Could not release the archive file write lock: {error}"))?;
        match file.lock_shared() {
            Ok(()) => Ok(()),
            Err(error) => {
                if file.lock().is_ok() {
                    return Err(format!("Could not restore the exclusive archive file lock after downgrade: {error}"));
                }
                self.archive_file = None;
                self.mode = None;
                let _ = self.file.unlock();
                Err(format!(
                    "Could not restore the archive file lock after downgrade: {error}"
                ))
            }
        }
    }

    fn restore_path_shared(&mut self) -> Result<(), String> {
        if self.mode == Some(LockMode::Exclusive) {
            if let Err(error) = self.file.unlock() {
                self.release_archive_file();
                let _ = self.file.unlock();
                self.mode = None;
                return Err(format!(
                    "Could not release the archive path write lock: {error}"
                ));
            }
        }
        self.mode = None;
        match self.file.lock_shared() {
            Ok(()) => {
                self.mode = Some(LockMode::Shared);
                Ok(())
            }
            Err(error) => {
                self.release_archive_file();
                let _ = self.file.unlock();
                Err(format!(
                    "Could not restore the archive path read lock: {error}"
                ))
            }
        }
    }

    fn release_archive_file(&mut self) {
        if let Some(file) = self.archive_file.take() {
            let _ = file.unlock();
        }
    }

    fn release_replacement_file(&mut self) {
        if let Some(file) = self.replacement_file.take() {
            let _ = file.unlock();
        }
    }
}

impl Drop for ArchiveLock {
    fn drop(&mut self) {
        self.release_replacement_file();
        self.release_archive_file();
        let _ = self.file.unlock();
        self.mode = None;
    }
}

fn lock_file(file: &File, mode: LockMode, identity: &str) -> Result<(), String> {
    let result = match mode {
        LockMode::Shared => file.try_lock_shared(),
        LockMode::Exclusive => file.try_lock(),
    };
    match result {
        Ok(()) => Ok(()),
        Err(TryLockError::WouldBlock) => Err(locked_error(identity)),
        Err(TryLockError::Error(error)) => {
            Err(format!("Could not acquire {identity} lock: {error}"))
        }
    }
}

fn lock_archive_file(path: &Path, mode: LockMode) -> Result<Option<File>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    if mode == LockMode::Exclusive {
        options.write(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Could not open the archive for locking: {error}"))?;
    lock_file(&file, mode, "archive file")?;
    Ok(Some(file))
}

fn locked_error(identity: &str) -> String {
    format!("archive_locked: The archive is in use by another Tutorux operation ({identity}).")
}

/// Return a path-derived key shared by desktop and CLI lock registries.
pub fn archive_lock_key(path: &Path) -> Result<String, String> {
    let canonical = canonical_archive_path(path)?;
    let digest = Sha256::digest(normalized_path(&canonical).as_bytes());
    let mut result = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(result, "{byte:02x}");
    }
    Ok(result)
}

fn lock_file_path(path: &Path) -> Result<PathBuf, String> {
    let root = per_user_lock_directory()?;
    if let Some(parent) = root.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create archive lock parent directory: {error}"))?;
    }
    match create_private_lock_directory(&root) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(&root)
                .map_err(|error| format!("Could not inspect archive lock directory: {error}"))?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("The archive lock directory is not a safe directory.".to_owned());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err("The archive lock directory has unsafe permissions.".to_owned());
                }
            }
        }
        Err(error) => return Err(format!("Could not create archive lock directory: {error}")),
    }
    Ok(root.join(format!("{}.lock", archive_lock_key(path)?)))
}

fn per_user_lock_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let root = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("USERPROFILE")
                    .map(|home| PathBuf::from(home).join("AppData").join("Local"))
            })
            .ok_or_else(|| {
                "Could not locate the current user's local application data directory.".to_owned()
            })?;
        return Ok(root.join("Tutorux").join("archive-locks-v1"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Could not locate the current user's home directory.".to_owned())?;
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("Tutorux")
            .join("archive-locks-v1"));
    }
    #[cfg(target_os = "linux")]
    {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Could not locate the current user's home directory.".to_owned())?;
        return Ok(home
            .join(".local")
            .join("state")
            .join("tutorux")
            .join("archive-locks-v1"));
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Ok(env::temp_dir().join("tutorux-archive-locks-v1"))
    }
}

#[cfg(unix)]
fn create_private_lock_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    builder.create(path)
}

#[cfg(not(unix))]
fn create_private_lock_directory(path: &Path) -> io::Result<()> {
    fs::create_dir(path)
}

fn canonical_archive_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return fs::canonicalize(path)
            .map_err(|error| format!("Could not resolve archive lock path: {error}"));
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| "Archive lock path needs a file name.".to_owned())?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("Could not resolve archive lock directory: {error}"))?;
    Ok(canonical_parent.join(file_name))
}

fn normalized_path(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix("//?/UNC/") {
            value = format!("//{rest}");
        } else if let Some(rest) = value.strip_prefix("//?/") {
            value = rest.to_owned();
        }
        value = value.to_lowercase();
    }
    value
}
