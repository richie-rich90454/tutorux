use crate::core::archive::ArchiveSnapshot;
use crate::core::crypto::{wrap_data_key, ArchiveDataKey};
use crate::core::error::{err, Result};

use super::common::{apply_index_version_flags, require_clean_tail, require_valid_full};
use super::rebuild::rebuild_and_verify;
use super::retained::collect_retained_chains;

pub fn enable_encryption(snapshot: &ArchiveSnapshot, passphrase: &str) -> Result<Vec<u8>> {
    if snapshot.encrypted() {
        return err(
            "archive_already_encrypted",
            "This archive is already encrypted.",
        );
    }
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before changing its encryption.",
        );
    }
    require_clean_tail(snapshot)?;
    require_valid_full(snapshot, "archive_encryption_source_invalid")?;
    let key = ArchiveDataKey::create_random();
    let envelope = wrap_data_key(passphrase, &key, &snapshot.header.id)?;
    let mut chains = collect_retained_chains(snapshot)?;
    apply_index_version_flags(&mut chains, &snapshot.header.id)?;
    let (bytes, _) = rebuild_and_verify(
        &snapshot.header,
        chains,
        Some(snapshot.all_index_entries()),
        &std::collections::BTreeSet::new(),
        None,
        Some(&key),
        Some(&envelope),
        "archive_encryption_verification_failed",
    )?;
    Ok(bytes)
}

pub fn change_passphrase(snapshot: &ArchiveSnapshot, passphrase: &str) -> Result<Vec<u8>> {
    if !snapshot.encrypted() {
        return err("archive_not_encrypted", "This archive is not encrypted.");
    }
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before changing its passphrase.",
        );
    }
    require_clean_tail(snapshot)?;
    require_valid_full(snapshot, "archive_encryption_source_invalid")?;
    let key = ArchiveDataKey::create_random();
    let envelope = wrap_data_key(passphrase, &key, &snapshot.header.id)?;
    let mut chains = collect_retained_chains(snapshot)?;
    apply_index_version_flags(&mut chains, &snapshot.header.id)?;
    let (bytes, _) = rebuild_and_verify(
        &snapshot.header,
        chains,
        Some(snapshot.all_index_entries()),
        &std::collections::BTreeSet::new(),
        snapshot.data_key(),
        Some(&key),
        Some(&envelope),
        "archive_rekey_verification_failed",
    )?;
    Ok(bytes)
}
