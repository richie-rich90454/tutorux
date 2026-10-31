use std::collections::BTreeSet;

use crate::core::archive::{secondary_index_keys, secondary_index_migrations, ArchiveSnapshot};
use crate::core::crypto::ArchiveDataKey;
use crate::core::error::{err, CoreError, Result};
use crate::core::format::RecordType;
use crate::core::index::primary_index_key;
use crate::core::verify::verify_full;

use super::retained::{latest_record, RetainedChain};

pub(crate) fn require_clean_tail(snapshot: &ArchiveSnapshot) -> Result<()> {
    if snapshot.source.size() != snapshot.published_end_offset {
        return err(
            "archive_recovery_required",
            "This archive has uncommitted trailing data. Review or recover it before making changes.",
        );
    }
    Ok(())
}

pub(crate) fn require_valid_full(snapshot: &ArchiveSnapshot, code: &str) -> Result<()> {
    let report = verify_full(snapshot)?;
    if !report.valid {
        return err(code, &report.issues.join("; "));
    }
    Ok(())
}

pub(crate) fn open_rebuilt(
    bytes: Vec<u8>,
    key: Option<&ArchiveDataKey>,
) -> Result<ArchiveSnapshot> {
    let snapshot = ArchiveSnapshot::open_bytes(bytes)?;
    match key {
        Some(key) => {
            let mut unlocked = snapshot;
            unlocked.set_data_key(key.clone());
            unlocked.verify_authenticated()?;
            Ok(unlocked)
        }
        None => Ok(snapshot),
    }
}

pub(crate) fn apply_index_version_flags(
    chains: &mut [RetainedChain],
    archive_id: &str,
) -> Result<()> {
    let mut version_fields: BTreeSet<&'static str> = BTreeSet::new();
    for chain in chains.iter() {
        let Some(record) = latest_record(chain) else {
            continue;
        };
        for key in secondary_index_keys(record)? {
            if key.starts_with("AUDIOSESSION:") {
                version_fields.insert("audio_chunk_index_version");
            }
            if key.starts_with("GUIDESOURCE:") {
                version_fields.insert("guide_source_index_version");
            }
            for migration in secondary_index_migrations() {
                if key.starts_with(migration.prefix) {
                    version_fields.insert(migration.version_field);
                }
            }
        }
        if record.record_type == RecordType::SESSION
            && record.field("audio_chunk_index_version") == Some("1")
        {
            version_fields.insert("audio_chunk_index_version");
        }
    }
    if version_fields.is_empty() {
        return Ok(());
    }
    let manifest_key = primary_index_key(RecordType::SETTINGS, archive_id);
    let chain = chains
        .iter_mut()
        .find(|chain| chain.key == manifest_key)
        .ok_or_else(|| {
            CoreError::new(
                "archive_manifest_missing",
                "Archive manifest is missing or invalid.",
            )
        })?;
    let revision = chain.revisions.last_mut().ok_or_else(|| {
        CoreError::new(
            "archive_manifest_missing",
            "Archive manifest is missing or invalid.",
        )
    })?;
    let record = revision.record.as_mut().ok_or_else(|| {
        CoreError::new(
            "archive_manifest_missing",
            "Archive manifest is missing or invalid.",
        )
    })?;
    for field in version_fields {
        record.fields.insert(field.to_owned(), "1".to_owned());
    }
    Ok(())
}
