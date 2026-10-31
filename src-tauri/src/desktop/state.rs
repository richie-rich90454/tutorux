use crate::archive_lock::{ArchiveLockRegistry, SharedArchiveLock};
use serde::Serialize;
use sha2::Sha256;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::Mutex,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArchiveIdentity {
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

#[derive(Clone)]
pub(crate) struct AuthorizedArchive {
    pub(crate) path: PathBuf,
    pub(crate) location: PathBuf,
    pub(crate) identity: ArchiveIdentity,
    pub(crate) hasher: Sha256,
    pub(crate) lock: SharedArchiveLock,
}

#[derive(Default)]
pub(crate) struct DesktopState {
    pub(crate) opened_archives: Mutex<HashMap<String, AuthorizedArchive>>,
    pub(crate) archive_locks: ArchiveLockRegistry,
    pub(crate) pending_saves: Mutex<HashMap<String, PendingSave>>,
    pub(crate) pending_open: Mutex<VecDeque<PathBuf>>,
}

#[derive(Clone)]
pub(crate) struct PendingSave {
    pub(crate) target: PathBuf,
    pub(crate) target_location: PathBuf,
    pub(crate) target_identity: Option<ArchiveIdentity>,
    pub(crate) temporary: PathBuf,
    pub(crate) source_archive_token: Option<String>,
    pub(crate) create_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveSelection {
    pub(crate) token: String,
    pub(crate) size: String,
    pub(crate) name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavePreparation {
    pub(crate) token: String,
    pub(crate) temporary_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveAppendResult {
    pub(crate) size: String,
}

#[derive(Clone, Copy)]
pub(crate) struct ArchiveLocator {
    pub(crate) commit_offset: u64,
    pub(crate) generation: u64,
}
