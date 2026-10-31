use std::collections::{BTreeMap, BTreeSet};

use crate::core::archive::{
    encode_commit_payload, encode_locator, encode_record_for_write, new_uuid, sha256,
    ArchiveSnapshot,
};
use crate::core::crypto::{
    envelope_to_record, ArchiveDataKey, ArchiveEnvelope, RecordEncryptionContext,
};
use crate::core::error::{err, CoreError, Result};
use crate::core::format::{
    encode_archive_header, encode_record_frame, ArchiveHeader, ArchiveRecord, RecordType,
    CAPABILITY_ENCRYPTED, ZERO_UUID,
};
use crate::core::index::{build_index_tree, encode_index_page, primary_index_key, IndexPage};

use super::common::{apply_index_version_flags, open_rebuilt, require_valid_full};
use super::retained::{latest_record, RetainedChain, RetainedRevision};

pub(crate) fn build_archive(
    header: &ArchiveHeader,
    chains: Vec<RetainedChain>,
    original_index: Option<&BTreeMap<String, u64>>,
    removed_offsets: &BTreeSet<u64>,
    source_key: Option<&ArchiveDataKey>,
    target_key: Option<&ArchiveDataKey>,
    envelope: Option<&ArchiveEnvelope>,
) -> Result<Vec<u8>> {
    if target_key.is_some() != envelope.is_some() {
        return err(
            "archive_encryption_metadata_invalid",
            "A rebuilt encrypted archive needs both a data key and a key envelope.",
        );
    }
    if header.capabilities & CAPABILITY_ENCRYPTED != 0 && target_key.is_none() {
        return err(
            "archive_locked",
            "Unlock this archive before rebuilding its encrypted records.",
        );
    }
    let mut rebuilt_header = header.clone();
    rebuilt_header.capabilities = if target_key.is_some() {
        CAPABILITY_ENCRYPTED
    } else {
        0
    };
    let mut bytes = encode_archive_header(&rebuilt_header);
    let empty_root_body = encode_index_page(&IndexPage {
        leaf: true,
        entries: Vec::new(),
        separators: Vec::new(),
        children: Vec::new(),
    })?;
    let empty_root_payload = if let Some(key) = target_key {
        let mut payload = empty_root_body.clone();
        payload
            .extend_from_slice(&key.authenticate_bytes("TUTORUX-INDEX-PAGE-V1", &empty_root_body));
        payload
    } else {
        empty_root_body
    };
    bytes.extend_from_slice(&encode_record_frame(
        RecordType::INDEX_PAGE,
        ZERO_UUID,
        1,
        0,
        &empty_root_payload,
        0,
        0,
    )?);

    let mut index: BTreeMap<String, u64> = BTreeMap::new();
    let mut relocated: BTreeMap<u64, u64> = BTreeMap::new();
    let mut written_records = 0usize;
    let envelope_key = primary_index_key(RecordType::ENCRYPTION, &rebuilt_header.id);

    if let (Some(key), Some(envelope)) = (target_key, envelope) {
        let record = envelope_to_record(envelope, &rebuilt_header.id)?;
        let frame = encode_record_for_write(&rebuilt_header, Some(key), &record)?;
        let offset = bytes.len() as u64;
        index.insert(envelope_key.clone(), offset);
        bytes.extend_from_slice(&frame);
        written_records += 1;
    }

    let mut chain_offsets: Vec<(String, u64, Option<ArchiveRecord>)> = Vec::new();
    for chain in &chains {
        if envelope.is_some() && chain.key == envelope_key {
            continue;
        }
        let mut previous_offset = 0u64;
        let mut latest_offset = 0u64;
        for revision in &chain.revisions {
            let new_offset = bytes.len() as u64;
            let encoded = encode_retained_revision(
                &rebuilt_header,
                revision,
                previous_offset,
                source_key,
                target_key,
            )?;
            bytes.extend_from_slice(&encoded);
            if let Some(old_offset) = revision.old_offset {
                relocated.insert(old_offset, new_offset);
            }
            previous_offset = new_offset;
            latest_offset = new_offset;
            written_records += 1;
        }
        if latest_offset == 0 {
            continue;
        }
        index.insert(chain.key.clone(), latest_offset);
        chain_offsets.push((
            chain.key.clone(),
            latest_offset,
            latest_record(chain).cloned(),
        ));
    }

    for (_, latest_offset, record) in &chain_offsets {
        let Some(record) = record else { continue };
        for alias in crate::core::archive::secondary_index_keys(record)? {
            match index.get(&alias).copied() {
                None => {
                    index.insert(alias, *latest_offset);
                }
                Some(existing) if existing == *latest_offset => {}
                Some(_) => {
                    return err(
                        "archive_compaction_index_conflict",
                        "Secondary indexes would reference more than one record.",
                    )
                }
            }
        }
    }

    if let Some(original) = original_index {
        let chain_keys: BTreeSet<&String> = chains.iter().map(|chain| &chain.key).collect();
        for (key, old_offset) in original {
            if chain_keys.contains(key) || crate::core::archive::is_secondary_index_prefix(key) {
                continue;
            }
            if removed_offsets.contains(old_offset) {
                continue;
            }
            if envelope.is_some() && key == &envelope_key {
                continue;
            }
            let Some(new_offset) = relocated.get(old_offset).copied() else {
                return err(
                    "archive_compaction_index_unreachable",
                    "An index entry points to a revision that cannot be retained.",
                );
            };
            match index.get(key).copied() {
                None => {
                    index.insert(key.clone(), new_offset);
                }
                Some(existing) if existing == new_offset => {}
                Some(_) => {
                    return err(
                        "archive_compaction_index_conflict",
                        "Secondary indexes would reference more than one record.",
                    )
                }
            }
        }
    }

    let ordered: Vec<(String, u64)> = index
        .iter()
        .map(|(key, offset)| (key.clone(), *offset))
        .collect();
    let authenticate_ref = target_key
        .map(|key| move |payload: &[u8]| key.authenticate_bytes("TUTORUX-INDEX-PAGE-V1", payload));
    let tree = build_index_tree(
        &ordered,
        bytes.len() as u64,
        authenticate_ref
            .as_ref()
            .map(|f| f as &dyn Fn(&[u8]) -> Vec<u8>),
    )?;
    for frame in &tree.frames {
        bytes.extend_from_slice(frame);
    }

    let root_hash = sha256(&tree.root_payload);
    let transaction_id = new_uuid();
    let commit_body = encode_commit_payload(
        1,
        0,
        tree.root_offset,
        &root_hash,
        &transaction_id,
        written_records as u64,
    );
    let commit_payload = if let Some(key) = target_key {
        let mut payload = commit_body.clone();
        payload.extend_from_slice(&key.authenticate_bytes("TUTORUX-COMMIT-V1", &commit_body));
        payload
    } else {
        commit_body
    };
    let commit_offset = tree.end_offset;
    bytes.extend_from_slice(&encode_record_frame(
        RecordType::COMMIT,
        ZERO_UUID,
        1,
        0,
        &commit_payload,
        0,
        0,
    )?);
    bytes.extend_from_slice(&encode_locator(commit_offset, 1));
    Ok(bytes)
}

fn encode_retained_revision(
    header: &ArchiveHeader,
    revision: &RetainedRevision,
    previous_offset: u64,
    source_key: Option<&ArchiveDataKey>,
    target_key: Option<&ArchiveDataKey>,
) -> Result<Vec<u8>> {
    let metadata = revision.id.eq_ignore_ascii_case(&header.id)
        && (revision.record_type == RecordType::SETTINGS
            || revision.record_type == RecordType::ENCRYPTION);
    let Some(stored_payload) = revision.stored_payload.as_ref() else {
        let record = revision.record.as_ref().ok_or_else(|| {
            CoreError::new(
                "archive_compaction_record_missing",
                "A retained revision has no encoded contents.",
            )
        })?;
        let mut write = record.clone();
        write.previous_offset = previous_offset;
        return encode_record_for_write(header, target_key, &write);
    };
    if metadata {
        let record = revision.record.as_ref().ok_or_else(|| {
            CoreError::new(
                "archive_compaction_record_missing",
                "An archive metadata revision could not be decoded.",
            )
        })?;
        let mut write = record.clone();
        write.previous_offset = previous_offset;
        return encode_record_for_write(header, target_key, &write);
    }
    if let Some(key) = target_key {
        let codec_payload = if revision.flags & 1 != 0 {
            let source_key = source_key.ok_or_else(|| {
                CoreError::new(
                    "archive_locked",
                    "Unlock this archive before compacting its encrypted records.",
                )
            })?;
            source_key.decrypt_record_payload(
                stored_payload,
                &RecordEncryptionContext {
                    archive_id: &header.id,
                    record_type: revision.record_type,
                    record_id: &revision.id,
                    revision: revision.revision,
                    previous_offset: revision.previous_offset,
                    codec: revision.codec,
                },
            )?
        } else {
            stored_payload.clone()
        };
        let encrypted = key.encrypt_record_payload(
            &codec_payload,
            &RecordEncryptionContext {
                archive_id: &header.id,
                record_type: revision.record_type,
                record_id: &revision.id,
                revision: revision.revision,
                previous_offset,
                codec: revision.codec,
            },
        )?;
        return encode_record_frame(
            revision.record_type,
            &revision.id,
            revision.revision,
            previous_offset,
            &encrypted,
            revision.codec,
            1,
        );
    }
    if revision.flags & 1 != 0 {
        return err(
            "archive_record_unencrypted",
            "Encrypted archive contains a plaintext data record.",
        );
    }
    encode_record_frame(
        revision.record_type,
        &revision.id,
        revision.revision,
        previous_offset,
        stored_payload,
        revision.codec,
        0,
    )
}

pub fn rebuild_archive(
    header: &ArchiveHeader,
    manifest: ArchiveRecord,
    records: Vec<ArchiveRecord>,
    data_key: Option<&ArchiveDataKey>,
    envelope: Option<&ArchiveEnvelope>,
) -> Result<Vec<u8>> {
    let mut grouped: BTreeMap<(u16, String), Vec<ArchiveRecord>> = BTreeMap::new();
    for record in records {
        if record.record_type == RecordType::INDEX_PAGE || record.record_type == RecordType::COMMIT
        {
            continue;
        }
        if record.record_type == RecordType::ENCRYPTION {
            continue;
        }
        grouped
            .entry((record.record_type, record.id.to_lowercase()))
            .or_default()
            .push(record);
    }
    let manifest_key = (RecordType::SETTINGS, header.id.to_lowercase());
    if !grouped.contains_key(&manifest_key) {
        let mut manifest = manifest;
        manifest.id = header.id.clone();
        grouped.insert(manifest_key.clone(), vec![manifest]);
    }
    let mut chains = Vec::new();
    for ((record_type, id), mut revisions) in grouped {
        revisions.sort_by(|left, right| left.revision.cmp(&right.revision));
        chains.push(RetainedChain {
            key: primary_index_key(record_type, &id),
            revisions: revisions
                .into_iter()
                .map(|record| RetainedRevision {
                    record_type: record.record_type,
                    id: record.id.to_lowercase(),
                    revision: record.revision,
                    previous_offset: record.previous_offset,
                    record: Some(record),
                    old_offset: None,
                    stored_payload: None,
                    codec: 0,
                    flags: 0,
                })
                .collect(),
        });
    }
    apply_index_version_flags(&mut chains, &header.id)?;
    let bytes = build_archive(
        header,
        chains,
        None,
        &BTreeSet::new(),
        None,
        data_key,
        envelope,
    )?;
    let opened = open_rebuilt(bytes.clone(), data_key)?;
    require_valid_full(&opened, "archive_rebuild_failed")?;
    opened.get_manifest()?;
    Ok(bytes)
}

pub(crate) fn rebuild_and_verify(
    header: &ArchiveHeader,
    chains: Vec<RetainedChain>,
    original_index: Option<&BTreeMap<String, u64>>,
    removed_offsets: &BTreeSet<u64>,
    source_key: Option<&ArchiveDataKey>,
    target_key: Option<&ArchiveDataKey>,
    envelope: Option<&ArchiveEnvelope>,
    error_code: &str,
) -> Result<(Vec<u8>, ArchiveSnapshot)> {
    let bytes = build_archive(
        header,
        chains,
        original_index,
        removed_offsets,
        source_key,
        target_key,
        envelope,
    )?;
    let opened = open_rebuilt(bytes.clone(), target_key)?;
    require_valid_full(&opened, error_code)?;
    opened.get_manifest()?;
    Ok((bytes, opened))
}
