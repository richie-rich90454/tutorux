use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;

use crate::core::archive::verify_full;
use crate::core::archive::{
    commit_published_end, decode_commit, encode_commit_payload, encode_locator,
    encode_record_for_write, find_consistent_commit, is_secondary_index_prefix, new_uuid,
    scan_commit_frame_offsets, secondary_index_keys, secondary_index_migrations, sha256,
    valid_uuid, ArchiveSnapshot, CommitInfo,
};
use crate::core::crypto::{
    envelope_from_record, envelope_to_record, wrap_data_key, ArchiveDataKey, ArchiveEnvelope,
    RecordEncryptionContext,
};
use crate::core::error::{err, CoreError, Result};
use crate::core::format::{
    decode_archive_header, decode_record_frame_header, encode_archive_header, encode_record_frame,
    record_type_name, ArchiveHeader, ArchiveRecord, RecordType, CAPABILITY_ENCRYPTED, ZERO_UUID,
};
use crate::core::index::{
    build_index_tree, encode_index_page, primary_index_key, read_frame_at, IndexPage,
};
use crate::core::source::ByteSource;

#[derive(Clone)]
struct RetainedRevision {
    record: Option<ArchiveRecord>,
    old_offset: Option<u64>,
    stored_payload: Option<Vec<u8>>,
    codec: u8,
    flags: u8,
    record_type: u16,
    id: String,
    revision: u64,
    previous_offset: u64,
}

struct RetainedChain {
    key: String,
    revisions: Vec<RetainedRevision>,
}

impl RetainedRevision {
    fn latest_record(chain: &RetainedChain) -> Option<&ArchiveRecord> {
        chain
            .revisions
            .last()
            .and_then(|revision| revision.record.as_ref())
    }
}

fn build_archive(
    header: &ArchiveHeader,
    chains: Vec<RetainedChain>,
    original_index: Option<&BTreeMap<String, u64>>,
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
    let empty_root_payload = encode_index_page(&IndexPage {
        leaf: true,
        entries: Vec::new(),
        separators: Vec::new(),
        children: Vec::new(),
    })?;
    let empty_root_payload = if let Some(key) = target_key {
        let mut payload = empty_root_payload.clone();
        payload.extend_from_slice(
            &key.authenticate_bytes("TUTORUX-INDEX-PAGE-V1", &empty_root_payload),
        );
        payload
    } else {
        empty_root_payload
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

    let mut chain_offsets: Vec<(String, u64)> = Vec::new();
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
        chain_offsets.push((chain.key.clone(), latest_offset));
    }

    for (key, latest_offset) in &chain_offsets {
        let Some(chain) = chains.iter().find(|chain| &chain.key == key) else {
            continue;
        };
        let Some(record) = RetainedRevision::latest_record(chain) else {
            continue;
        };
        for alias in secondary_index_keys(record)? {
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
            if chain_keys.contains(key) || is_secondary_index_prefix(key) {
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

fn collect_retained_chains(snapshot: &ArchiveSnapshot) -> Result<Vec<RetainedChain>> {
    let mut primary_keys: BTreeSet<String> = BTreeSet::new();
    for (key, offset) in snapshot.all_index_entries() {
        let Some((_, id)) = single_colon_key(key) else {
            continue;
        };
        if !valid_uuid(id) {
            continue;
        }
        let frame = read_frame_at(snapshot.source.as_ref(), *offset)?;
        if key == &primary_index_key(frame.record_type, &frame.id) {
            primary_keys.insert(key.clone());
        }
    }

    let mut chains: BTreeMap<String, RetainedChain> = BTreeMap::new();
    let mut seen_offsets: HashSet<u64> = HashSet::new();
    for key in &primary_keys {
        let latest_offset = snapshot
            .all_index_entries()
            .get(key)
            .copied()
            .ok_or_else(|| {
                CoreError::new("record_index_mismatch", "Archive index entry disappeared.")
            })?;
        let chain = collect_chain(
            snapshot,
            key.clone(),
            latest_offset,
            false,
            &mut seen_offsets,
        )?;
        chains.insert(key.clone(), chain);
    }

    let mut opaque_keys: Vec<(String, u64)> = Vec::new();
    for (key, offset) in snapshot.all_index_entries() {
        if primary_keys.contains(key) || is_secondary_index_prefix(key) {
            continue;
        }
        let frame = read_frame_at(snapshot.source.as_ref(), *offset)?;
        if record_type_name(frame.record_type) == "unknown" {
            opaque_keys.push((key.clone(), *offset));
        }
    }
    opaque_keys.sort();
    for (key, offset) in opaque_keys {
        if chains.contains_key(&key) {
            return err(
                "archive_compaction_index_unreachable",
                "An opaque index entry shares a revision that cannot be retained safely.",
            );
        }
        let chain = collect_chain(snapshot, key.clone(), offset, true, &mut seen_offsets)?;
        chains.insert(key, chain);
    }

    Ok(chains.into_values().collect())
}

fn collect_chain(
    snapshot: &ArchiveSnapshot,
    key: String,
    latest_offset: u64,
    opaque_only: bool,
    seen_offsets: &mut HashSet<u64>,
) -> Result<RetainedChain> {
    let mut revisions = Vec::new();
    let mut offset = latest_offset;
    let mut visited: HashSet<u64> = HashSet::new();
    let mut newer: Option<(u16, String, u64)> = None;
    while offset != 0 {
        if !visited.insert(offset) || !seen_offsets.insert(offset) {
            return err(
                "revision_lineage_invalid",
                "Record revision chain contains a cycle or shared frame.",
            );
        }
        let frame = read_frame_at(snapshot.source.as_ref(), offset)?;
        let identity = (frame.record_type, frame.id.to_lowercase(), frame.revision);
        if let Some(newer) = &newer {
            if frame.record_type != newer.0
                || !frame.id.eq_ignore_ascii_case(&newer.1)
                || frame.revision + 1 != newer.2
            {
                return err(
                    "revision_lineage_invalid",
                    "Record revision lineage is inconsistent.",
                );
            }
        }
        if frame.previous_offset != 0 && frame.previous_offset >= offset {
            return err(
                "revision_lineage_invalid",
                "Record revision points forward in the archive.",
            );
        }
        let known = record_type_name(frame.record_type) != "unknown";
        if opaque_only && known {
            return err(
                "revision_lineage_invalid",
                "An opaque secondary index points to a known record.",
            );
        }
        let record = if known {
            Some(snapshot.decode_frame_record(&frame)?)
        } else {
            snapshot.decode_frame_payload(&frame)?;
            None
        };
        revisions.push(RetainedRevision {
            record,
            old_offset: Some(offset),
            stored_payload: Some(frame.stored_payload.clone()),
            codec: frame.codec,
            flags: frame.flags,
            record_type: frame.record_type,
            id: frame.id.clone(),
            revision: frame.revision,
            previous_offset: frame.previous_offset,
        });
        newer = Some(identity);
        offset = frame.previous_offset;
    }
    revisions.reverse();
    Ok(RetainedChain { key, revisions })
}

fn require_clean_tail(snapshot: &ArchiveSnapshot) -> Result<()> {
    if snapshot.source.size() != snapshot.published_end_offset {
        return err(
            "archive_recovery_required",
            "This archive has uncommitted trailing data. Review or recover it before making changes.",
        );
    }
    Ok(())
}

fn apply_index_version_flags(chains: &mut [RetainedChain], archive_id: &str) -> Result<()> {
    let mut version_fields: BTreeSet<&'static str> = BTreeSet::new();
    for chain in chains.iter() {
        let Some(record) = RetainedRevision::latest_record(chain) else {
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

fn require_valid_full(snapshot: &ArchiveSnapshot, code: &str) -> Result<()> {
    let report = verify_full(snapshot)?;
    if !report.valid {
        return err(code, &report.issues.join("; "));
    }
    Ok(())
}

fn open_rebuilt(bytes: Vec<u8>, key: Option<&ArchiveDataKey>) -> Result<ArchiveSnapshot> {
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
    let bytes = build_archive(header, chains, None, None, data_key, envelope)?;
    let opened = open_rebuilt(bytes.clone(), data_key)?;
    require_valid_full(&opened, "archive_rebuild_failed")?;
    opened.get_manifest()?;
    Ok(bytes)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionResult {
    pub bytes: Vec<u8>,
    pub original_bytes: u64,
    pub compacted_bytes: u64,
    pub preserved_records: usize,
    pub pruned_asset_records: usize,
}

fn compact_archive_internal(
    snapshot: &ArchiveSnapshot,
    allow_unpublished_tail: bool,
) -> Result<CompactionResult> {
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before compacting it.",
        );
    }
    if !allow_unpublished_tail {
        require_clean_tail(snapshot)?;
    }
    snapshot.get_manifest()?;
    require_valid_full(snapshot, "archive_compaction_source_invalid")?;
    let mut chains = collect_retained_chains(snapshot)?;
    if !chains
        .iter()
        .any(|chain| chain.key == primary_index_key(RecordType::SETTINGS, &snapshot.header.id))
    {
        return err(
            "archive_compaction_primary_index_missing",
            "The archive has no primary records to compact.",
        );
    }
    apply_index_version_flags(&mut chains, &snapshot.header.id)?;
    let preserved_records = chains.iter().map(|chain| chain.revisions.len()).sum();
    let envelope = if snapshot.encrypted() {
        let record = snapshot
            .get_record(RecordType::ENCRYPTION, &snapshot.header.id)?
            .ok_or_else(|| {
                CoreError::new(
                    "archive_encryption_metadata_missing",
                    "Encrypted archive is missing its key-wrapping metadata.",
                )
            })?;
        Some(envelope_from_record(&record, &snapshot.header.id)?)
    } else {
        None
    };
    let bytes = build_archive(
        &snapshot.header,
        chains,
        Some(snapshot.all_index_entries()),
        snapshot.data_key(),
        snapshot.data_key(),
        envelope.as_ref(),
    )?;
    let compacted = open_rebuilt(bytes.clone(), snapshot.data_key())?;
    require_valid_full(&compacted, "archive_compaction_verification_failed")?;
    compacted.get_manifest()?;
    Ok(CompactionResult {
        original_bytes: snapshot.source.size(),
        compacted_bytes: bytes.len() as u64,
        preserved_records,
        pruned_asset_records: 0,
        bytes,
    })
}

/// Compact an archive to every reachable revision while preserving stored payloads.
pub fn compact_archive(snapshot: &ArchiveSnapshot) -> Result<Vec<u8>> {
    Ok(compact_archive_internal(snapshot, false)?.bytes)
}

pub fn compact_archive_result(snapshot: &ArchiveSnapshot) -> Result<CompactionResult> {
    compact_archive_internal(snapshot, false)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveRepairResult {
    pub bytes: Vec<u8>,
    pub original_bytes: u64,
    pub compacted_bytes: u64,
    pub preserved_records: usize,
    pub pruned_asset_records: usize,
    pub selected_generation: u64,
    pub discarded_trailing_bytes: u64,
    pub discarded_region_start: u64,
    pub discarded_region_end: u64,
    pub discarded_record_frames: usize,
    pub discarded_record_frame_bytes: u64,
    pub unattributed_bytes: u64,
}

struct DiscardedRegionSummary {
    record_frames: usize,
    record_frame_bytes: u64,
    unattributed_bytes: u64,
}

fn summarize_discarded_region(
    source: &dyn ByteSource,
    start: u64,
    end: u64,
) -> Result<DiscardedRegionSummary> {
    if start > end {
        return err(
            "archive_repair_range_invalid",
            "The selected repair boundary exceeds the source archive size.",
        );
    }
    let mut summary = DiscardedRegionSummary {
        record_frames: 0,
        record_frame_bytes: 0,
        unattributed_bytes: 0,
    };
    let chunk_size = 4 * 1024 * 1024u64;
    let mut offset = start;
    while offset < end {
        let remaining = end - offset;
        if remaining < 64 {
            summary.unattributed_bytes += remaining;
            break;
        }
        let scan_length = remaining.min(chunk_size) as usize;
        let read_length = (remaining.min(scan_length as u64 + 56)) as usize;
        let bytes = source.read(offset, read_length)?;
        let mut found = false;
        let mut index = 0usize;
        while index < scan_length && index + 64 <= bytes.len() {
            if &bytes[index..index + 4] != b"TXRC" {
                index += 8;
                continue;
            }
            let header = match decode_record_frame_header(
                &bytes[index..index + 64],
                offset + index as u64,
            ) {
                Ok(header) => header,
                Err(_) => {
                    index += 8;
                    continue;
                }
            };
            let padding = (8 - (header.payload_length % 8)) % 8;
            let frame_bytes = 64 + header.payload_length + padding;
            if frame_bytes > remaining - index as u64 {
                index += 8;
                continue;
            }
            summary.unattributed_bytes += index as u64;
            summary.record_frames += 1;
            summary.record_frame_bytes += frame_bytes;
            offset += index as u64 + frame_bytes;
            found = true;
            break;
        }
        if found {
            continue;
        }
        if remaining <= chunk_size {
            summary.unattributed_bytes += remaining;
            break;
        }
        summary.unattributed_bytes += chunk_size;
        offset += chunk_size;
    }
    Ok(summary)
}

/// Create a compacted copy from the newest generation that passes full verification.
pub fn repair_archive_result(snapshot: &ArchiveSnapshot) -> Result<ArchiveRepairResult> {
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before repairing a copy.",
        );
    }
    let mut commit = snapshot.commit.clone();
    let mut last_error: Option<CoreError> = None;
    let mut visited: HashSet<u64> = HashSet::new();
    for _ in 0..1024 {
        if !visited.insert(commit.offset) {
            break;
        }
        let mut selected_commit = commit.clone();
        match find_consistent_commit(snapshot.source.as_ref(), &snapshot.header, commit.clone()) {
            Ok(Some((candidate, index_entries))) => {
                selected_commit = candidate.clone();
                match commit_published_end(snapshot.source.as_ref(), &candidate) {
                    Ok(published_end) => {
                        let selected = snapshot.open_generation(
                            candidate.clone(),
                            index_entries,
                            published_end,
                        );
                        match compact_archive_internal(&selected, true) {
                            Ok(compacted) => {
                                let discarded = summarize_discarded_region(
                                    snapshot.source.as_ref(),
                                    published_end,
                                    snapshot.source.size(),
                                )?;
                                return Ok(ArchiveRepairResult {
                                    bytes: compacted.bytes,
                                    original_bytes: snapshot.source.size(),
                                    compacted_bytes: compacted.compacted_bytes,
                                    preserved_records: compacted.preserved_records,
                                    pruned_asset_records: compacted.pruned_asset_records,
                                    selected_generation: candidate.generation,
                                    discarded_trailing_bytes: snapshot
                                        .source
                                        .size()
                                        .saturating_sub(published_end),
                                    discarded_region_start: published_end,
                                    discarded_region_end: snapshot.source.size(),
                                    discarded_record_frames: discarded.record_frames,
                                    discarded_record_frame_bytes: discarded.record_frame_bytes,
                                    unattributed_bytes: discarded.unattributed_bytes,
                                });
                            }
                            Err(error) => last_error = Some(error),
                        }
                    }
                    Err(error) => last_error = Some(error),
                }
            }
            Ok(None) => {}
            Err(error) => last_error = Some(error),
        }
        if selected_commit.previous_offset == 0 {
            break;
        }
        match decode_commit(snapshot.source.as_ref(), selected_commit.previous_offset) {
            Ok(previous) => {
                if previous.generation + 1 != selected_commit.generation {
                    last_error = Some(CoreError::new(
                        "archive_repair_commit_chain_invalid",
                        "Previous commit generation is not consecutive.",
                    ));
                    break;
                }
                commit = previous;
            }
            Err(error) => {
                last_error = Some(error);
                break;
            }
        }
    }
    Err(CoreError::new(
        "archive_repair_no_verified_generation",
        match last_error {
            Some(error) => format!(
                "No committed generation passed full verification: {}",
                error.message
            ),
            None => "No committed generation passed full verification.".to_owned(),
        },
    ))
}

/// Repair an archive copy after discarding unreachable or corrupt trailing data.
pub fn repair_archive(snapshot: &ArchiveSnapshot) -> Result<Vec<u8>> {
    Ok(repair_archive_result(snapshot)?.bytes)
}

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
    let bytes = build_archive(
        &snapshot.header,
        chains,
        Some(snapshot.all_index_entries()),
        None,
        Some(&key),
        Some(&envelope),
    )?;
    let opened = open_rebuilt(bytes.clone(), Some(&key))?;
    require_valid_full(&opened, "archive_encryption_verification_failed")?;
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
    let bytes = build_archive(
        &snapshot.header,
        chains,
        Some(snapshot.all_index_entries()),
        snapshot.data_key(),
        Some(&key),
        Some(&envelope),
    )?;
    let opened = open_rebuilt(bytes.clone(), Some(&key))?;
    require_valid_full(&opened, "archive_rekey_verification_failed")?;
    Ok(bytes)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryInspection {
    pub committed_generation: u64,
    pub candidate_generation: u64,
    pub recoverable_generation: u64,
    pub trailing_bytes: u64,
    pub has_unpublished_commit: bool,
    pub encrypted: bool,
    pub locked: bool,
    pub recoverable: bool,
    pub recovered_generations: usize,
    pub discarded_trailing_bytes: u64,
    pub issues: Vec<String>,
}

pub fn inspect_recovery_source(
    source: Arc<dyn ByteSource>,
    passphrase: Option<&str>,
) -> Result<RecoveryInspection> {
    let snapshot = ArchiveSnapshot::open_for_recovery(source)?;
    let snapshot = match passphrase {
        Some(passphrase) if snapshot.locked() => snapshot.unlock(passphrase)?,
        _ => snapshot,
    };
    inspect_recovery(&snapshot)
}

pub fn inspect_recovery(snapshot: &ArchiveSnapshot) -> Result<RecoveryInspection> {
    let trailing_bytes = snapshot
        .source
        .size()
        .saturating_sub(snapshot.published_end_offset);
    let commit_offsets = scan_commit_frame_offsets(snapshot.source.as_ref())?;
    let after_base: Vec<u64> = commit_offsets
        .into_iter()
        .filter(|offset| *offset > snapshot.commit.offset)
        .collect();
    let candidate_generation = after_base
        .iter()
        .filter_map(|offset| decode_commit(snapshot.source.as_ref(), *offset).ok())
        .map(|commit| commit.generation)
        .max()
        .unwrap_or(0);
    let mut issues = Vec::new();
    let mut recoverable = false;
    let mut recoverable_generation = 0u64;
    let mut recovered_generations = 0usize;
    let mut discarded_trailing_bytes = 0u64;
    if snapshot.locked() {
        issues.push(
            "A passphrase is required to authenticate and verify the unpublished generation."
                .to_owned(),
        );
    } else {
        match recover_unpublished(snapshot) {
            Ok((_bytes, generation, generations, discarded)) => {
                recoverable = true;
                recoverable_generation = generation;
                recovered_generations = generations;
                discarded_trailing_bytes = discarded;
            }
            Err(error) if error.code == "archive_recovery_not_available" => {}
            Err(error) => issues.push(error.message),
        }
    }
    if trailing_bytes > 0 && after_base.is_empty() {
        issues.push(
            "Trailing archive bytes do not contain a complete unpublished commit; they were left untouched."
                .to_owned(),
        );
    }
    if !after_base.is_empty() && !recoverable {
        issues.push(
            "Complete commit frames were found after the selected generation, but none passed full verification."
                .to_owned(),
        );
    }
    Ok(RecoveryInspection {
        committed_generation: snapshot.commit.generation,
        candidate_generation,
        recoverable_generation,
        trailing_bytes,
        has_unpublished_commit: !after_base.is_empty(),
        encrypted: snapshot.encrypted(),
        locked: snapshot.locked(),
        recoverable,
        recovered_generations,
        discarded_trailing_bytes,
        issues,
    })
}

fn scan_unpublished_commit(
    snapshot: &ArchiveSnapshot,
) -> Result<Option<(CommitInfo, BTreeMap<String, u64>)>> {
    let offsets = scan_commit_frame_offsets(snapshot.source.as_ref())?;
    for offset in offsets.into_iter().rev() {
        if offset <= snapshot.commit.offset || offset < snapshot.published_end_offset {
            continue;
        }
        let Ok(commit) = decode_commit(snapshot.source.as_ref(), offset) else {
            continue;
        };
        if commit.previous_offset != snapshot.commit.offset
            || commit.generation != snapshot.commit.generation + 1
        {
            continue;
        }
        if let Ok(Some((consistent, index))) =
            find_consistent_commit(snapshot.source.as_ref(), &snapshot.header, commit)
        {
            if consistent.offset == offset {
                return Ok(Some((consistent, index)));
            }
        }
    }
    Ok(None)
}

fn is_known_type_name(name: &str) -> bool {
    name == "UNKNOWN"
        || (1..=14u16).any(|record_type| record_type_name(record_type).to_uppercase() == name)
}

fn transaction_primary_record_count(
    snapshot: &ArchiveSnapshot,
    index: &BTreeMap<String, u64>,
    commit: &CommitInfo,
) -> usize {
    index
        .iter()
        .filter(|(key, offset)| {
            let Some((type_name, id)) = single_colon_key(key) else {
                return false;
            };
            is_known_type_name(type_name)
                && valid_uuid(id)
                && **offset >= snapshot.published_end_offset
                && **offset < commit.offset
        })
        .count()
}

fn single_colon_key(key: &str) -> Option<(&str, &str)> {
    let mut parts = key.split(':');
    let name = parts.next()?;
    let id = parts.next()?;
    if parts.next().is_some() || name.is_empty() || id.is_empty() {
        return None;
    }
    Some((name, id))
}

pub fn recover_unpublished(snapshot: &ArchiveSnapshot) -> Result<(Vec<u8>, u64, usize, u64)> {
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before recovering an unpublished generation.",
        );
    }
    let base_locator = match commit_published_end(snapshot.source.as_ref(), &snapshot.commit) {
        Ok(end) => Some(end),
        Err(error) if error.code == "archive_locator_invalid" => None,
        Err(error) => return Err(error),
    };
    if base_locator.is_none() && snapshot.published_end_offset != commit_frame_end(snapshot)? {
        return err(
            "archive_recovery_validation_failed",
            "The published boundary does not match the selected commit.",
        );
    }
    let mut previous = snapshot.clone();
    let mut recovered_commit: Option<CommitInfo> = None;
    let mut recovered_end = snapshot.published_end_offset;
    let mut recovered_generations = 0usize;
    while recovered_generations < 1024 {
        let Some((commit, index)) = scan_unpublished_commit(&previous)? else {
            break;
        };
        let record_count = transaction_primary_record_count(&previous, &index, &commit);
        if record_count as u64 != commit.record_count {
            if recovered_commit.is_some() {
                break;
            }
            return err(
                "archive_recovery_validation_failed",
                "The unpublished generation record count does not match its current primary index.",
            );
        }
        let frame = read_frame_at(snapshot.source.as_ref(), commit.offset)?;
        let candidate_end = frame.end_offset;
        let next = previous.open_generation(commit.clone(), index, candidate_end);
        let verification = verify_full(&next)?;
        if !verification.valid {
            if recovered_commit.is_some() {
                break;
            }
            return err(
                "archive_recovery_validation_failed",
                &verification.issues.join("; "),
            );
        }
        next.get_manifest()?;
        previous = next;
        recovered_commit = Some(commit);
        recovered_end = candidate_end;
        recovered_generations += 1;
    }
    if recovered_generations == 1024 && scan_unpublished_commit(&previous)?.is_some() {
        return err(
            "archive_recovery_generation_limit",
            "The unpublished generation chain exceeds the recovery limit.",
        );
    }
    let Some(commit) = recovered_commit else {
        if base_locator.is_none() {
            let end = commit_frame_end(snapshot)?;
            let mut bytes = snapshot.source.read(0, end as usize)?;
            bytes.extend_from_slice(&encode_locator(
                snapshot.commit.offset,
                snapshot.commit.generation,
            ));
            let published = ArchiveSnapshot::open(Arc::new(
                crate::core::source::MemorySource::new(bytes.clone()),
            ))?;
            let mut unlocked = published;
            if snapshot.encrypted() {
                if let Some(key) = snapshot.data_key() {
                    unlocked.set_data_key(key.clone());
                }
            }
            let verification = verify_full(&unlocked)?;
            if !verification.valid {
                return err(
                    "archive_recovery_validation_failed",
                    &verification.issues.join("; "),
                );
            }
            return Ok((
                bytes,
                snapshot.commit.generation,
                0,
                snapshot.source.size().saturating_sub(end),
            ));
        }
        return err(
            "archive_recovery_not_available",
            "No complete unpublished generation follows the latest published generation.",
        );
    };
    let mut bytes = snapshot.source.read(0, recovered_end as usize)?;
    bytes.extend_from_slice(&encode_locator(commit.offset, commit.generation));
    Ok((
        bytes,
        commit.generation,
        recovered_generations,
        snapshot.source.size().saturating_sub(recovered_end),
    ))
}

fn commit_frame_end(snapshot: &ArchiveSnapshot) -> Result<u64> {
    Ok(read_frame_at(snapshot.source.as_ref(), snapshot.commit.offset)?.end_offset)
}

pub fn discard_tail(snapshot: &ArchiveSnapshot) -> Result<Vec<u8>> {
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before discarding uncommitted data.",
        );
    }
    if snapshot.source.size() <= snapshot.published_end_offset {
        return snapshot.source.read(0, snapshot.source.size() as usize);
    }
    let bytes = snapshot
        .source
        .read(0, snapshot.published_end_offset as usize)?;
    let truncated = ArchiveSnapshot::open_for_recovery(Arc::new(
        crate::core::source::MemorySource::new(bytes.clone()),
    ))?;
    let truncated = if snapshot.encrypted() {
        match snapshot.data_key() {
            Some(key) => {
                let mut unlocked = truncated;
                unlocked.set_data_key(key.clone());
                unlocked
            }
            None => truncated,
        }
    } else {
        truncated
    };
    require_valid_full(&truncated, "archive_recovery_validation_failed")?;
    Ok(bytes)
}

pub fn rebuild_damaged_primary_index(source: Arc<dyn ByteSource>) -> Result<Vec<u8>> {
    let header = decode_archive_header(&source.read(0, 64)?)?;
    if header.capabilities & CAPABILITY_ENCRYPTED != 0 {
        return err(
            "archive_index_repair_encrypted",
            "Rebuilding a damaged encrypted index is not supported.",
        );
    }
    let mut records: BTreeMap<(u16, String, u64), ArchiveRecord> = BTreeMap::new();
    let mut offset = 64u64;
    while offset + 64 <= source.size() {
        let frame = match read_frame_at(source.as_ref(), offset) {
            Ok(frame) => frame,
            Err(_) => {
                offset += 8;
                continue;
            }
        };
        let record_type = frame.record_type;
        if record_type != RecordType::INDEX_PAGE
            && record_type != RecordType::COMMIT
            && record_type != RecordType::ENCRYPTION
        {
            if record_type_name(record_type) == "unknown" {
                return err(
                    "archive_index_repair_unknown",
                    "Archive contains unknown records whose indexes cannot be reconstructed safely.",
                );
            }
            if let Ok(record) = decode_frame_for_rebuild(&frame) {
                records.insert(
                    (record_type, record.id.to_lowercase(), record.revision),
                    record,
                );
            }
        }
        offset = frame.end_offset;
    }
    let manifest = records
        .values()
        .find(|record| {
            record.record_type == RecordType::SETTINGS
                && record.id.eq_ignore_ascii_case(&header.id)
                && record.field("record_role") == Some("archive-manifest")
        })
        .cloned()
        .ok_or_else(|| {
            CoreError::new(
                "archive_manifest_missing",
                "Archive manifest is missing or invalid.",
            )
        })?;
    let expected_created_at = header.created_at_us.to_string();
    if manifest.field("_deleted") == Some("true")
        || manifest.field("created_at_us") != Some(expected_created_at.as_str())
    {
        return err(
            "archive_index_repair_manifest",
            "The archive identity does not match its retained manifest.",
        );
    }
    let records: Vec<ArchiveRecord> = records.into_values().collect();
    rebuild_archive(&header, manifest, records, None, None)
}

fn decode_frame_for_rebuild(frame: &crate::core::format::RecordFrame) -> Result<ArchiveRecord> {
    if frame.flags & 1 != 0 {
        return err(
            "archive_locked",
            "Unlock this archive before rebuilding its primary index.",
        );
    }
    let payload = crate::core::format::decode_stored_payload(
        frame.codec,
        frame.flags,
        &frame.stored_payload,
    )?;
    crate::core::format::decode_record_payload(
        frame.record_type,
        &frame.id,
        frame.revision,
        frame.previous_offset,
        &payload,
    )
}

pub fn backfill_secondary_indexes(snapshot: &ArchiveSnapshot) -> Result<Vec<u8>> {
    compact_archive(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::archive::{
        create_archive_bytes, create_encrypted_archive_bytes, new_uuid, verify_full,
    };
    use crate::core::format::ArchiveRecord;
    use crate::core::source::{CompositeSource, MemorySource};

    macro_rules! fields {
        ($($key:expr => $value:expr),* $(,)?) => {
            vec![$(($key.to_string(), $value.to_string())),*]
        };
    }

    fn record(record_type: u16, id: &str, fields: Vec<(String, String)>) -> ArchiveRecord {
        ArchiveRecord::new(record_type, id, fields)
    }

    fn archive_bytes(snapshot: &ArchiveSnapshot) -> Vec<u8> {
        snapshot
            .source
            .read(0, snapshot.source.size() as usize)
            .unwrap()
    }

    #[test]
    fn compaction_preserves_every_revision_and_unknown_payloads() {
        let archive =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Compaction", "", 1).unwrap())
                .unwrap();
        let student = new_uuid();
        let extension = new_uuid();
        let first = archive
            .append_records(&[
                record(
                    RecordType::STUDENT,
                    &student,
                    fields! {"notes" => "First revision ".repeat(64)},
                ),
                record(
                    99,
                    &extension,
                    fields! {"extension_payload" => "First extension revision ".repeat(64)},
                ),
            ])
            .unwrap();
        let current = first
            .append_records(&[
                record(
                    RecordType::STUDENT,
                    &student,
                    fields! {"notes" => "Second revision"},
                ),
                record(
                    99,
                    &extension,
                    fields! {"extension_payload" => "Second extension revision"},
                ),
            ])
            .unwrap();
        let old_extension_offset = current
            .all_index_entries()
            .get(&format!("UNKNOWN:{extension}"))
            .copied()
            .unwrap();
        let old_extension_frame =
            read_frame_at(current.source.as_ref(), old_extension_offset).unwrap();
        let old_student_history = current.record_chain(RecordType::STUDENT, &student).unwrap();

        let result = compact_archive_result(&current).unwrap();
        assert_eq!(result.preserved_records, 7);
        assert_eq!(result.pruned_asset_records, 0);
        assert!(result.compacted_bytes < result.original_bytes);
        let compacted = ArchiveSnapshot::open_bytes(result.bytes).unwrap();
        assert_eq!(compacted.commit.generation, 1);
        assert_eq!(compacted.header.id, current.header.id);
        assert_eq!(
            compacted.all_index_entries().keys().collect::<Vec<_>>(),
            current.all_index_entries().keys().collect::<Vec<_>>()
        );
        let new_student_history = compacted
            .record_chain(RecordType::STUDENT, &student)
            .unwrap();
        assert_eq!(
            old_student_history
                .iter()
                .map(|record| record.fields.clone())
                .collect::<Vec<_>>(),
            new_student_history
                .iter()
                .map(|record| record.fields.clone())
                .collect::<Vec<_>>()
        );
        let new_extension_offset = compacted
            .all_index_entries()
            .get(&format!("UNKNOWN:{extension}"))
            .copied()
            .unwrap();
        let new_extension_frame =
            read_frame_at(compacted.source.as_ref(), new_extension_offset).unwrap();
        assert_eq!(old_extension_frame.codec, new_extension_frame.codec);
        assert_eq!(
            old_extension_frame.stored_payload,
            new_extension_frame.stored_payload
        );
        assert!(verify_full(&compacted).unwrap().valid);
    }

    #[test]
    fn repair_selects_newest_fully_verified_generation() {
        let initial =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Repair", "", 1).unwrap()).unwrap();
        let student = new_uuid();
        let generation_two = initial
            .append_records(&[record(
                RecordType::STUDENT,
                &student,
                fields! {"display_name" => "Mina"},
            )])
            .unwrap();
        let generation_three = generation_two
            .append_records(&[record(
                RecordType::STUDENT,
                &student,
                fields! {"display_name" => "Corrupted newest revision"},
            )])
            .unwrap();
        let mut damaged_bytes = archive_bytes(&generation_three);
        let latest_offset = generation_three
            .all_index_entries()
            .get(&format!("STUDENT:{student}"))
            .copied()
            .unwrap();
        damaged_bytes[latest_offset as usize + 64] ^= 0xff;
        let corrupted_bytes = damaged_bytes.clone();
        let damaged = ArchiveSnapshot::open_bytes(damaged_bytes).unwrap();
        assert!(!verify_full(&damaged).unwrap().valid);

        let repaired = repair_archive_result(&damaged).unwrap();
        assert_eq!(repaired.selected_generation, 2);
        assert!(repaired.discarded_trailing_bytes > 0);
        let reopened = ArchiveSnapshot::open_bytes(repaired.bytes.clone()).unwrap();
        assert_eq!(reopened.commit.generation, 1);
        assert_eq!(
            reopened
                .get_record(RecordType::STUDENT, &student)
                .unwrap()
                .unwrap()
                .field("display_name"),
            Some("Mina")
        );
        assert_eq!(archive_bytes(&damaged), corrupted_bytes);
        assert!(verify_full(&reopened).unwrap().valid);
    }

    #[test]
    fn recovers_complete_unpublished_generation() {
        let initial =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Recovery", "", 1).unwrap()).unwrap();
        let student = new_uuid();
        let complete = initial
            .append_records(&[record(
                RecordType::STUDENT,
                &student,
                fields! {"display_name" => "Mina"},
            )])
            .unwrap();
        let mut bytes = archive_bytes(&complete);
        bytes.truncate(bytes.len() - 32);
        let prior = ArchiveSnapshot::open_bytes(bytes.clone()).unwrap();
        assert_eq!(prior.commit.generation, 1);
        let inspection = inspect_recovery(&prior).unwrap();
        assert_eq!(inspection.candidate_generation, 2);
        assert!(inspection.has_unpublished_commit);
        assert!(inspection.recoverable);
        assert_eq!(inspection.recoverable_generation, 2);
        assert_eq!(inspection.recovered_generations, 1);
        let (recovered_bytes, generation, generations, discarded) =
            recover_unpublished(&prior).unwrap();
        assert_eq!(generation, 2);
        assert_eq!(generations, 1);
        assert_eq!(discarded, 0);
        let recovered = ArchiveSnapshot::open_bytes(recovered_bytes).unwrap();
        assert_eq!(
            recovered
                .get_record(RecordType::STUDENT, &student)
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        assert!(verify_full(&recovered).unwrap().valid);
    }

    #[test]
    fn recovery_discards_crash_tail_after_commit() {
        let initial =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Crash tail", "", 1).unwrap())
                .unwrap();
        let student = new_uuid();
        let complete = initial
            .append_records(&[record(
                RecordType::STUDENT,
                &student,
                fields! {"display_name" => "Mina"},
            )])
            .unwrap();
        let mut bytes = archive_bytes(&complete);
        bytes.truncate(bytes.len() - 32);
        bytes.extend_from_slice(&[9u8; 16]);
        let prior = ArchiveSnapshot::open_bytes(bytes).unwrap();
        assert_eq!(prior.commit.generation, 1);
        let (recovered_bytes, generation, generations, discarded) =
            recover_unpublished(&prior).unwrap();
        assert_eq!(generation, 2);
        assert_eq!(generations, 1);
        assert_eq!(discarded, 16);
        assert!(
            verify_full(&ArchiveSnapshot::open_bytes(recovered_bytes).unwrap())
                .unwrap()
                .valid
        );
    }

    #[test]
    fn repair_finds_locator_after_crash_bytes() {
        let initial =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Locator scan", "", 1).unwrap())
                .unwrap();
        let student = new_uuid();
        let complete = initial
            .append_records(&[record(
                RecordType::STUDENT,
                &student,
                fields! {"display_name" => "Mina"},
            )])
            .unwrap();
        let bytes = archive_bytes(&complete);
        let locator = &bytes[bytes.len() - 32..];
        let commit_end = bytes.len() - 32;
        let mut damaged = Vec::with_capacity(bytes.len() + 24);
        damaged.extend_from_slice(&bytes[..commit_end]);
        damaged.extend_from_slice(&[1u8; 16]);
        damaged.extend_from_slice(locator);
        damaged.extend_from_slice(&[2u8; 8]);
        let snapshot = ArchiveSnapshot::open_bytes(damaged).unwrap();
        assert_eq!(snapshot.commit.generation, 2);
        assert_eq!(snapshot.source.size() - snapshot.published_end_offset, 8);
        let repaired = repair_archive_result(&snapshot).unwrap();
        assert_eq!(repaired.selected_generation, 2);
        assert_eq!(repaired.discarded_trailing_bytes, 8);
        assert_eq!(repaired.discarded_record_frames, 0);
        assert_eq!(repaired.unattributed_bytes, 8);
        let reopened = ArchiveSnapshot::open_bytes(repaired.bytes).unwrap();
        assert_eq!(
            reopened
                .get_record(RecordType::STUDENT, &student)
                .unwrap()
                .unwrap()
                .field("display_name"),
            Some("Mina")
        );
    }

    #[test]
    fn opens_for_recovery_without_any_locator() {
        let mut bytes = create_archive_bytes("No locator", "", 1).unwrap();
        bytes.truncate(bytes.len() - 32);
        assert!(ArchiveSnapshot::open_bytes(bytes.clone()).is_err());
        let source_inspection =
            inspect_recovery_source(Arc::new(MemorySource::new(bytes.clone())), None).unwrap();
        assert!(source_inspection.recoverable);
        let recovered =
            ArchiveSnapshot::open_for_recovery(Arc::new(MemorySource::new(bytes))).unwrap();
        assert_eq!(recovered.commit.generation, 1);
        let inspection = inspect_recovery(&recovered).unwrap();
        assert!(inspection.recoverable);
        assert_eq!(inspection.recovered_generations, 0);
        let (published, generation, generations, discarded) =
            recover_unpublished(&recovered).unwrap();
        assert_eq!(generation, 1);
        assert_eq!(generations, 0);
        assert_eq!(discarded, 0);
        assert!(ArchiveSnapshot::open_bytes(published).is_ok());
    }

    #[test]
    fn discard_tail_never_mutates_source() {
        let initial =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Discard", "", 1).unwrap()).unwrap();
        let dirty_source = Arc::new(CompositeSource::new(
            Arc::clone(&initial.source),
            Arc::new(MemorySource::new(vec![7u8; 16])),
        ));
        let dirty = ArchiveSnapshot::open(dirty_source).unwrap();
        let original_size = dirty.source.size();
        let bytes = discard_tail(&dirty).unwrap();
        assert_eq!(bytes.len() as u64, dirty.published_end_offset);
        assert_eq!(dirty.source.size(), original_size);
        assert!(
            verify_full(&ArchiveSnapshot::open_bytes(bytes).unwrap())
                .unwrap()
                .valid
        );
    }

    #[test]
    fn compaction_preserves_opaque_payload_bytes() {
        use crate::core::format::encode_record_frame;

        let initial =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Opaque", "", 1).unwrap()).unwrap();
        let extension = new_uuid();
        let with_extension = initial
            .append_records(&[record(
                99,
                &extension,
                fields! {"extension" => "temporary structured payload"},
            )])
            .unwrap();
        let offset = with_extension
            .all_index_entries()
            .get(&format!("UNKNOWN:{extension}"))
            .copied()
            .unwrap();
        let original = read_frame_at(with_extension.source.as_ref(), offset).unwrap();
        let opaque_payload = vec![0xa5u8; original.payload_length as usize];
        let opaque_frame = encode_record_frame(
            original.record_type,
            &original.id,
            original.revision,
            original.previous_offset,
            &opaque_payload,
            original.codec,
            0,
        )
        .unwrap();
        assert_eq!(opaque_frame.len() as u64, original.end_offset - offset);
        let mut bytes = archive_bytes(&with_extension);
        bytes[offset as usize..offset as usize + opaque_frame.len()].copy_from_slice(&opaque_frame);
        let opaque = ArchiveSnapshot::open_bytes(bytes).unwrap();
        assert!(verify_full(&opaque).unwrap().valid);

        let compacted = ArchiveSnapshot::open_bytes(compact_archive(&opaque).unwrap()).unwrap();
        let copied_offset = compacted
            .all_index_entries()
            .get(&format!("UNKNOWN:{extension}"))
            .copied()
            .unwrap();
        let copied = read_frame_at(compacted.source.as_ref(), copied_offset).unwrap();
        assert_eq!(copied.stored_payload, opaque_payload);
        assert!(verify_full(&compacted).unwrap().valid);
    }

    #[test]
    fn rebuilds_primary_index_copy() {
        let bytes = create_archive_bytes("Index repair", "", 1).unwrap();
        let rebuilt_bytes =
            rebuild_damaged_primary_index(Arc::new(MemorySource::new(bytes))).unwrap();
        let rebuilt = ArchiveSnapshot::open_bytes(rebuilt_bytes).unwrap();
        assert!(verify_full(&rebuilt).unwrap().valid);
        assert_eq!(rebuilt.get_manifest().unwrap().display_name, "Index repair");
    }

    #[test]
    fn enables_encryption_and_preserves_records() {
        let archive =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Plain", "", 1).unwrap()).unwrap();
        let student = new_uuid();
        let archive = archive
            .append_records(&[record(
                RecordType::STUDENT,
                &student,
                fields! {"display_name" => "Mina"},
            )])
            .unwrap();
        let passphrase = "encryption conversion passphrase";
        let bytes = enable_encryption(&archive, passphrase).unwrap();
        let locked = ArchiveSnapshot::open_bytes(bytes).unwrap();
        assert!(locked.locked());
        assert!(verify_full(&locked).unwrap().issues[0].contains("Unlock"));
        let unlocked = locked.unlock(passphrase).unwrap();
        assert!(verify_full(&unlocked).unwrap().valid);
        assert_eq!(
            unlocked
                .get_record(RecordType::STUDENT, &student)
                .unwrap()
                .unwrap()
                .field("display_name"),
            Some("Mina")
        );
    }

    #[test]
    fn encrypted_compaction_and_rekey_round_trip() {
        let passphrase = "a sufficiently long passphrase";
        let locked = ArchiveSnapshot::open_bytes(
            create_encrypted_archive_bytes("Secret", "", passphrase, 1).unwrap(),
        )
        .unwrap();
        let unlocked = locked.unlock(passphrase).unwrap();
        let student = new_uuid();
        let updated = unlocked
            .append_records(&[record(
                RecordType::STUDENT,
                &student,
                fields! {"display_name" => "Mina"},
            )])
            .unwrap();
        assert!(verify_full(&updated).unwrap().valid);
        let compacted_bytes = compact_archive(&updated).unwrap();
        let compacted_locked = ArchiveSnapshot::open_bytes(compacted_bytes).unwrap();
        let compacted = compacted_locked.unlock(passphrase).unwrap();
        assert!(verify_full(&compacted).unwrap().valid);
        assert_eq!(
            compacted
                .get_record(RecordType::STUDENT, &student)
                .unwrap()
                .unwrap()
                .field("display_name"),
            Some("Mina")
        );

        let new_passphrase = "another sufficiently long passphrase";
        let rekeyed_bytes = change_passphrase(&compacted, new_passphrase).unwrap();
        let rekeyed_locked = ArchiveSnapshot::open_bytes(rekeyed_bytes).unwrap();
        assert!(rekeyed_locked.unlock(passphrase).is_err());
        let rekeyed = rekeyed_locked.unlock(new_passphrase).unwrap();
        assert!(verify_full(&rekeyed).unwrap().valid);
        assert_eq!(
            rekeyed
                .get_record(RecordType::STUDENT, &student)
                .unwrap()
                .unwrap()
                .field("display_name"),
            Some("Mina")
        );
    }
}
