use std::collections::{BTreeMap, BTreeSet};

use crate::core::error::{err, Result};
use crate::core::format::{ArchiveRecord, RecordType};
use crate::core::index::primary_index_key;

use super::indexes::{
    guide_cited_source_ids, is_guide_source_record, mark_guide_blocks_stale,
    preserve_guide_source_history, secondary_index_keys, secondary_index_migrations,
};
use super::support::{
    has_sensitive_credential_material, is_credential_settings_record, is_supported_manifest,
    now_us, valid_uuid,
};
use super::ArchiveSnapshot;

pub(crate) struct PreparedTransaction {
    pub(crate) index: BTreeMap<String, u64>,
    pub(crate) manifest_fields: BTreeMap<String, String>,
    pub(crate) write_changes: Vec<ArchiveRecord>,
}

pub(crate) fn prepare_transaction(
    snapshot: &ArchiveSnapshot,
    changes: &[ArchiveRecord],
) -> Result<PreparedTransaction> {
    let explicit_manifest = changes.iter().find(|record| {
        record.record_type == RecordType::SETTINGS
            && record.id.eq_ignore_ascii_case(&snapshot.header.id)
    });
    let stored_manifest = snapshot.get_record(RecordType::SETTINGS, &snapshot.header.id)?;
    let current_manifest = explicit_manifest.cloned().or(stored_manifest.clone());
    if !is_supported_manifest(current_manifest.as_ref()) {
        return err(
            "archive_manifest_missing",
            "Archive manifest is missing or invalid.",
        );
    }
    for change in changes {
        if change.record_type != RecordType::SETTINGS {
            continue;
        }
        let credential_record = is_credential_settings_record(change);
        let sensitive_material = has_sensitive_credential_material(change);
        if credential_record && !snapshot.encrypted() {
            return err(
                "credential_encryption_required",
                "Credential records can be stored only in an encrypted archive.",
            );
        }
        if sensitive_material && !credential_record {
            return err(
                "sensitive_setting_key_rejected",
                "Credential-bearing settings must use the encrypted credential representation.",
            );
        }
    }

    let mut audio_session_ids = BTreeSet::new();
    for change in changes {
        if change.record_type != RecordType::AUDIO_CHUNK {
            continue;
        }
        let session_id = change.field("session_id").unwrap_or("").to_lowercase();
        if valid_uuid(&session_id) {
            audio_session_ids.insert(session_id);
        }
        let previous = snapshot.get_record(RecordType::AUDIO_CHUNK, &change.id)?;
        let identity = |record: &ArchiveRecord| {
            format!(
                "{}\u{0}{}\u{0}{}",
                record.field("session_id").unwrap_or("").to_lowercase(),
                record.field("track_id").unwrap_or("").to_lowercase(),
                record.field("sequence_number").unwrap_or("")
            )
        };
        if let Some(previous) = previous {
            if identity(&previous) != identity(change) {
                return err(
                    "audio_chunk_identity_immutable",
                    "An audio chunk's session, track, and sequence identity cannot change.",
                );
            }
        }
    }

    let students = snapshot.list_records(RecordType::STUDENT, true)?;
    let sessions = snapshot.list_records(RecordType::SESSION, true)?;
    let mut student_by_id: BTreeMap<String, ArchiveRecord> = students
        .into_iter()
        .map(|record| (record.id.to_lowercase(), record))
        .collect();
    let mut session_by_id: BTreeMap<String, ArchiveRecord> = sessions
        .into_iter()
        .map(|record| (record.id.to_lowercase(), record))
        .collect();
    for change in changes {
        if change.record_type == RecordType::STUDENT {
            student_by_id.insert(change.id.to_lowercase(), change.clone());
        }
        if change.record_type == RecordType::SESSION {
            session_by_id.insert(change.id.to_lowercase(), change.clone());
        }
    }

    let mut manifest_fields = current_manifest.as_ref().unwrap().fields.clone();
    let (student_count, session_count) =
        super::support::manifest_counts(&student_by_id, &session_by_id);
    manifest_fields.insert("student_count".to_owned(), student_count);
    manifest_fields.insert("session_count".to_owned(), session_count);
    manifest_fields.insert("updated_at_us".to_owned(), now_us().to_string());

    let mut index = snapshot.index.clone();
    backfill_legacy_secondary_indexes(snapshot, &mut index, &mut manifest_fields)?;

    let has_guide_index_changes = changes
        .iter()
        .any(|record| record.record_type == RecordType::GUIDE || is_guide_source_record(record));
    if has_guide_index_changes
        && manifest_fields.get("guide_source_index_version") != Some(&"1".to_owned())
    {
        for guide in snapshot.list_records(RecordType::GUIDE, true)? {
            let Some(guide_offset) = index
                .get(&primary_index_key(RecordType::GUIDE, &guide.id))
                .copied()
            else {
                continue;
            };
            for alias in secondary_index_keys(&guide)? {
                if alias.starts_with("GUIDESOURCE:") {
                    index.insert(alias, guide_offset);
                }
            }
        }
        manifest_fields.insert("guide_source_index_version".to_owned(), "1".to_owned());
    }

    let manifest_changed = changes.iter().any(|record| {
        record.record_type == RecordType::SETTINGS
            && record.id.eq_ignore_ascii_case(&snapshot.header.id)
    });
    let write_changes: Vec<ArchiveRecord> = if manifest_changed {
        changes
            .iter()
            .map(|record| {
                if record.record_type == RecordType::SETTINGS
                    && record.id.eq_ignore_ascii_case(&snapshot.header.id)
                {
                    let mut updated = record.clone();
                    updated.fields = manifest_fields.clone();
                    updated
                } else {
                    record.clone()
                }
            })
            .collect()
    } else {
        let mut updated_manifest = current_manifest.as_ref().unwrap().clone();
        updated_manifest.fields = manifest_fields.clone();
        let mut updated = changes.to_vec();
        updated.push(updated_manifest);
        updated
    };

    let mut changes_by_key: BTreeMap<String, ArchiveRecord> = BTreeMap::new();
    for record in write_changes {
        let key = primary_index_key(record.record_type, &record.id);
        if changes_by_key.insert(key, record).is_some() {
            return err(
                "record_duplicate",
                "A single archive transaction cannot update one record twice.",
            );
        }
    }
    let keys: Vec<String> = changes_by_key.keys().cloned().collect();
    for key in keys {
        let record = changes_by_key[&key].clone();
        if record.record_type != RecordType::GUIDE {
            continue;
        }
        if let Some(previous) = snapshot.get_record(RecordType::GUIDE, &record.id)? {
            changes_by_key.insert(
                key,
                preserve_guide_source_history(&previous, &record, &index),
            );
        }
    }

    let mut stale_guides: BTreeMap<String, ArchiveRecord> = BTreeMap::new();
    let changed_guide_source_ids: BTreeSet<String> = changes
        .iter()
        .filter(|record| is_guide_source_record(record))
        .map(|record| record.id.to_lowercase())
        .collect();
    for source_id in &changed_guide_source_ids {
        let mut candidate_ids = BTreeSet::new();
        let prefix = format!("GUIDESOURCE:{source_id}:");
        for alias in index.keys() {
            if let Some(guide_id) = alias.strip_prefix(&prefix) {
                candidate_ids.insert(guide_id.to_owned());
            }
        }
        for record in changes_by_key.values() {
            if record.record_type == RecordType::GUIDE
                && guide_cited_source_ids(record).contains(source_id)
            {
                candidate_ids.insert(record.id.to_lowercase());
            }
        }
        for guide_id in candidate_ids {
            let key = primary_index_key(RecordType::GUIDE, &guide_id);
            let current = stale_guides
                .get(&guide_id)
                .cloned()
                .or_else(|| changes_by_key.get(&key).cloned());
            let current = match current {
                Some(record) => Some(record),
                None => snapshot.get_record(RecordType::GUIDE, &guide_id)?,
            };
            let Some(current) = current else { continue };
            if current.deleted() {
                continue;
            }
            let updated = mark_guide_blocks_stale(&current, source_id);
            if updated != current {
                stale_guides.insert(
                    guide_id,
                    preserve_guide_source_history(&current, &updated, &index),
                );
            }
        }
    }
    for (guide_id, guide) in stale_guides {
        changes_by_key.insert(primary_index_key(RecordType::GUIDE, &guide_id), guide);
    }

    if !audio_session_ids.is_empty() {
        manifest_fields.insert("audio_chunk_index_version".to_owned(), "1".to_owned());
        for session_id in &audio_session_ids {
            let key = primary_index_key(RecordType::SESSION, session_id);
            if let Some(changed_session) = changes_by_key.get(&key) {
                if changed_session.field("audio_chunk_index_version") != Some("1") {
                    let mut updated = changed_session.clone();
                    updated
                        .fields
                        .insert("audio_chunk_index_version".to_owned(), "1".to_owned());
                    changes_by_key.insert(key, updated);
                }
                continue;
            }
            if let Some(stored_session) = snapshot.get_record(RecordType::SESSION, session_id)? {
                if stored_session.field("audio_chunk_index_version") == Some("1") {
                    continue;
                }
                let mut updated = stored_session;
                updated
                    .fields
                    .insert("audio_chunk_index_version".to_owned(), "1".to_owned());
                changes_by_key.insert(key, updated);
            }
        }
    }
    let mut write_changes: Vec<ArchiveRecord> = changes_by_key.values().cloned().collect();
    if let Some(manifest) = write_changes.iter_mut().find(|record| {
        record.record_type == RecordType::SETTINGS
            && record.id.eq_ignore_ascii_case(&snapshot.header.id)
    }) {
        for (name, value) in &manifest_fields {
            manifest.fields.insert(name.clone(), value.clone());
        }
    }
    Ok(PreparedTransaction {
        index,
        manifest_fields,
        write_changes,
    })
}

pub(crate) fn backfill_legacy_secondary_indexes(
    snapshot: &ArchiveSnapshot,
    index: &mut BTreeMap<String, u64>,
    manifest_fields: &mut BTreeMap<String, String>,
) -> Result<()> {
    for migration in secondary_index_migrations() {
        manifest_fields.insert(migration.version_field.to_owned(), "1".to_owned());
    }
    let stored_manifest = snapshot.get_record(RecordType::SETTINGS, &snapshot.header.id)?;
    let legacy_fields: BTreeSet<&'static str> = secondary_index_migrations()
        .iter()
        .filter(|migration| {
            stored_manifest
                .as_ref()
                .and_then(|record| record.field(migration.version_field))
                != Some("1")
        })
        .map(|migration| migration.version_field)
        .collect();
    let mut conflicting: BTreeSet<&'static str> = BTreeSet::new();
    for migration in secondary_index_migrations() {
        if !legacy_fields.contains(migration.version_field) {
            continue;
        }
        for record in snapshot.list_records(migration.record_type, true)? {
            let Some(offset) = index
                .get(&primary_index_key(record.record_type, &record.id))
                .copied()
            else {
                continue;
            };
            for key in secondary_index_keys(&record)? {
                if !key.starts_with(migration.prefix) {
                    continue;
                }
                match index.get(&key).copied() {
                    None => {
                        index.insert(key, offset);
                    }
                    Some(existing) if existing == offset => {}
                    Some(_) => {
                        conflicting.insert(migration.version_field);
                    }
                }
            }
        }
    }
    for field in conflicting {
        manifest_fields.insert(field.to_owned(), "0".to_owned());
    }
    Ok(())
}
