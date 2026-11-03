use super::{
    identity::{normalized_location_path, remember_archive_identity},
    state::{ArchiveIdentity, ArchiveSelection, AuthorizedArchive, DesktopState},
};
use crate::archive_lock_support::LockMode;
use sha2::Digest;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::Path,
};
use tauri::{ipc::Response, AppHandle, Manager, State};
use uuid::Uuid;

const MAX_RANGE_BYTES: usize = 4 * 1024 * 1024;

#[tauri::command]
pub(crate) async fn authorize_archive_path(
    path: String,
    app: AppHandle,
) -> Result<ArchiveSelection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        authorize_archive_path_blocking(&path, &state)
    })
    .await
    .map_err(|_| "The archive could not be authorized.".to_owned())?
}

fn authorize_archive_path_blocking(
    path: &str,
    state: &State<'_, DesktopState>,
) -> Result<ArchiveSelection, String> {
    let location = normalized_location_path(Path::new(path))?;
    let selected =
        fs::canonicalize(&location).map_err(|error| format!("Could not open archive: {error}"))?;
    let metadata =
        fs::metadata(&selected).map_err(|error| format!("Could not inspect archive: {error}"))?;
    if !metadata.is_file() {
        return Err("The selected archive is not a regular file.".to_owned());
    }
    if !selected
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("tux"))
    {
        return Err("Tutorux can only open .tux archives.".to_owned());
    }
    {
        let mut header = [0u8; 8];
        File::open(&selected)
            .and_then(|mut file| file.read_exact(&mut header))
            .map_err(|error| format!("Could not read archive header: {error}"))?;
        if &header != b"TUTORUX\0" {
            return Err("The selected file is not a Tutorux archive.".to_owned());
        }
    }
    let archive_lock = state.archive_locks.for_path(&selected, LockMode::Shared)?;
    let mut archive_read_lock = state.archive_locks.shared_guard(&archive_lock)?;
    let (size, hasher) = archive_read_lock.hash_archive()?;
    let identity = ArchiveIdentity {
        size,
        sha256: format!("{:x}", hasher.clone().finalize()),
    };
    drop(archive_read_lock);
    remember_archive_identity(state, &selected, &identity)?;
    let token = Uuid::new_v4().to_string();
    let name = selected
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Tutorux archive.tux")
        .to_owned();
    state
        .opened_archives
        .lock()
        .map_err(|_| "Archive access state is unavailable.".to_owned())?
        .insert(
            token.clone(),
            AuthorizedArchive {
                path: selected,
                location,
                identity: identity.clone(),
                hasher,
                lock: archive_lock,
            },
        );
    Ok(ArchiveSelection {
        token,
        size: identity.size.to_string(),
        name,
    })
}

#[tauri::command]
pub(crate) fn close_archive(
    archive_token: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state
        .opened_archives
        .lock()
        .map_err(|_| "Archive access state is unavailable.".to_owned())?
        .remove(&archive_token);
    Ok(())
}

#[tauri::command]
pub(crate) fn read_archive_range(
    archive_token: String,
    offset: String,
    length: usize,
    state: State<'_, DesktopState>,
) -> Result<Response, String> {
    if length > MAX_RANGE_BYTES {
        return Err("Archive reads are limited to 4 MiB per request.".to_owned());
    }
    let offset = offset
        .parse::<u64>()
        .map_err(|_| "Archive offset is invalid.".to_owned())?;
    let (path, archive_lock) = state
        .opened_archives
        .lock()
        .map_err(|_| "Archive access state is unavailable.".to_owned())?
        .get(&archive_token)
        .map(|archive| (archive.path.clone(), archive.lock.clone()))
        .ok_or_else(|| "Archive access has expired. Reopen the file to continue.".to_owned())?;
    let _archive_read_lock = state.archive_locks.shared_guard(&archive_lock)?;
    let mut file = File::open(path).map_err(|error| format!("Could not read archive: {error}"))?;
    let size = file
        .metadata()
        .map_err(|error| format!("Could not inspect archive: {error}"))?
        .len();
    let end = offset
        .checked_add(length as u64)
        .ok_or_else(|| "Archive range is out of bounds.".to_owned())?;
    if end > size {
        return Err("Archive range is out of bounds.".to_owned());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Could not seek in archive: {error}"))?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Could not read archive: {error}"))?;
    Ok(Response::new(bytes))
}
