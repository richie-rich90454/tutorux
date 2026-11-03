use super::{
    archive::authorize_archive_path_blocking,
    save::{prepare_archive_save_blocking, publish_archive_save_blocking, SaveScope},
    state::{DesktopState, SaveKind},
};
use crate::core::archive::create_archive_bytes;
use std::{fs, path::Path};

struct NoopScope;

impl SaveScope for NoopScope {
    fn allow_file(&self, _path: &Path) -> Result<(), String> {
        Ok(())
    }

    fn forbid_file(&self, _path: &Path) {}
}

fn stage_save(
    state: &DesktopState,
    target: &Path,
    staged: &[u8],
    archive_token: Option<String>,
    create_only: bool,
) -> Result<String, String> {
    let preparation = prepare_archive_save_blocking(
        target.to_string_lossy().into_owned(),
        archive_token,
        create_only,
        Some(SaveKind::Archive),
        &NoopScope,
        state,
    )?;
    fs::write(&preparation.temporary_path, staged)
        .map_err(|error| format!("stage archive bytes: {error}"))?;
    publish_archive_save_blocking(preparation.token.clone(), &NoopScope, state)?;
    Ok(preparation.token)
}

#[test]
fn created_archive_can_be_authorized_saved_and_reopened_while_locked() {
    let state = DesktopState::default();
    let directory = tempfile::tempdir().expect("temporary directory");
    let target = directory.path().join("created.tux");
    let initial = create_archive_bytes("Created", "", 1).expect("create archive bytes");

    // Create: the destination does not exist yet, so publication adopts the staged file.
    stage_save(&state, &target, &initial, None, true).expect("publish a new archive");
    assert_eq!(fs::read(&target).expect("read created archive"), initial);

    // Authorization hashes the file while holding its own shared lock. On Windows a
    // second read handle fails with ERROR_LOCK_VIOLATION, which used to surface as
    // "Could not verify archive contents" immediately after creation.
    let first = authorize_archive_path_blocking(target.to_str().expect("archive path"), &state)
        .expect("authorize the archive created under the lock");
    assert_eq!(first.size, initial.len().to_string());

    // A normal save through the original token hashes the current destination under
    // the exclusive lock, validates the staged generation, and re-adopts the result.
    let updated = create_archive_bytes("Created again", "", 2).expect("create updated bytes");
    stage_save(&state, &target, &updated, Some(first.token.clone()), false)
        .expect("save over the authorized archive");
    assert_eq!(fs::read(&target).expect("read updated archive"), updated);

    // The token survived publication and can authorize the replaced file again.
    let reopened = authorize_archive_path_blocking(target.to_str().expect("archive path"), &state)
        .expect("re-authorize the replaced archive");
    assert_eq!(reopened.size, updated.len().to_string());

    // A stale token from before the replacement still resolves the latest path identity,
    // so it cannot report Tutorux's own write as an external change.
    stage_save(&state, &target, &initial, Some(first.token), false)
        .expect("save again through the pre-replacement token");
    assert_eq!(fs::read(&target).expect("read final archive"), initial);
}

#[test]
fn save_as_never_replaces_a_file_created_after_preparation() {
    let state = DesktopState::default();
    let directory = tempfile::tempdir().expect("temporary directory");
    let target = directory.path().join("copy.tux");
    let initial = create_archive_bytes("Source", "", 1).expect("create archive bytes");
    let staged = create_archive_bytes("Copy", "", 2).expect("create staged bytes");

    let preparation = prepare_archive_save_blocking(
        target.to_string_lossy().into_owned(),
        None,
        true,
        Some(SaveKind::Archive),
        &NoopScope,
        &state,
    )
    .expect("prepare the copy");
    fs::write(&preparation.temporary_path, &staged).expect("stage the copy");

    fs::write(&target, &initial).expect("a foreign writer creates the destination");
    let error = publish_archive_save_blocking(preparation.token, &NoopScope, &state)
        .expect_err("do not replace a destination that appeared after preparation");
    assert!(
        error.contains("An archive appeared")
            || error.contains("already exists")
            || error.contains("changed outside Tutorux"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(&target).expect("read foreign archive"), initial);
}
