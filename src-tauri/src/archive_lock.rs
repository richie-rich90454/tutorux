use std::{
    collections::HashMap,
    ops::{Deref, DerefMut},
    path::Path,
    sync::{Arc, Mutex, MutexGuard, Weak},
};
use tutorux_archive_lock::{archive_lock_key, ArchiveLock, LockMode};

pub(crate) type SharedArchiveLock = Arc<Mutex<ArchiveLock>>;

#[derive(Default)]
pub(crate) struct ArchiveLockRegistry {
    locks: Mutex<HashMap<String, Weak<Mutex<ArchiveLock>>>>,
}

impl ArchiveLockRegistry {
    pub(crate) fn for_path(&self, path: &Path, mode: LockMode) -> Result<SharedArchiveLock, String> {
        let key = archive_lock_key(path)?;
        let mut locks = self
            .locks
            .lock()
            .map_err(|_| "Archive lock state is unavailable.".to_owned())?;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            return Ok(lock);
        }

        let lock = Arc::new(Mutex::new(ArchiveLock::try_acquire(path, mode)?));
        locks.insert(key, Arc::downgrade(&lock));
        Ok(lock)
    }

    pub(crate) fn shared_guard<'a>(
        &self,
        lock: &'a SharedArchiveLock,
    ) -> Result<MutexGuard<'a, ArchiveLock>, String> {
        let mut guard = lock
            .lock()
            .map_err(|_| "Archive lock state is unavailable.".to_owned())?;
        match guard.mode() {
            Some(LockMode::Shared) => {}
            Some(LockMode::Exclusive) => {
                return Err("Archive lock is in an unexpected exclusive state.".to_owned());
            }
            None => guard.try_reacquire(LockMode::Shared)?,
        }
        Ok(guard)
    }

    pub(crate) fn exclusive_guard<'a>(
        &self,
        lock: &'a SharedArchiveLock,
    ) -> Result<ExclusiveArchiveLockGuard<'a>, String> {
        let mut guard = lock
            .lock()
            .map_err(|_| "Archive lock state is unavailable.".to_owned())?;
        let previous_mode = guard.mode();
        match previous_mode {
            Some(LockMode::Shared) => guard.try_upgrade()?,
            Some(LockMode::Exclusive) => {}
            None => guard.try_reacquire(LockMode::Exclusive)?,
        }
        Ok(ExclusiveArchiveLockGuard {
            guard,
            previous_mode,
            keep_shared: false,
        })
    }
}

pub(crate) struct ExclusiveArchiveLockGuard<'a> {
    guard: MutexGuard<'a, ArchiveLock>,
    previous_mode: Option<LockMode>,
    keep_shared: bool,
}

impl ExclusiveArchiveLockGuard<'_> {
    /// Keep a shared lease after a successful publication so an open archive token stays valid.
    pub(crate) fn retain_shared(&mut self) -> Result<(), String> {
        self.guard.downgrade()?;
        self.keep_shared = true;
        Ok(())
    }
}

impl Deref for ExclusiveArchiveLockGuard<'_> {
    type Target = ArchiveLock;

    fn deref(&self) -> &Self::Target {
        &self.guard
    }
}

impl DerefMut for ExclusiveArchiveLockGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.guard
    }
}

impl Drop for ExclusiveArchiveLockGuard<'_> {
    fn drop(&mut self) {
        if self.keep_shared || self.previous_mode == Some(LockMode::Shared) {
            if self.guard.mode() == Some(LockMode::Exclusive) {
                let _ = self.guard.downgrade();
            }
        } else {
            let _ = self.guard.release();
        }
    }
}
