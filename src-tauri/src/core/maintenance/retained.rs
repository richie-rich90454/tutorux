use std::collections::{BTreeMap, BTreeSet, HashSet};

use crate::core::archive::{is_secondary_index_prefix, valid_uuid, ArchiveSnapshot};
use crate::core::error::{err, CoreError, Result};
use crate::core::format::{record_type_name, ArchiveRecord, RecordType};
use crate::core::index::{primary_index_key, read_frame_at};

#[derive(Clone)]
pub(crate) struct RetainedRevision {
    pub(crate) record: Option<ArchiveRecord>,
    pub(crate) old_offset: Option<u64>,
    pub(crate) stored_payload: Option<Vec<u8>>,
    pub(crate) codec: u8,
    pub(crate) flags: u8,
    pub(crate) record_type: u16,
    pub(crate) id: String,
    pub(crate) revision: u64,
    pub(crate) previous_offset: u64,
}

pub(crate) struct RetainedChain {
    pub(crate) key: String,
    pub(crate) revisions: Vec<RetainedRevision>,
}

pub(crate) fn latest_record(chain: &RetainedChain) -> Option<&ArchiveRecord> {
    chain
        .revisions
        .last()
        .and_then(|revision| revision.record.as_ref())
}

pub(crate) fn single_colon_key(key: &str) -> Option<(&str, &str)> {
    let mut parts = key.split(':');
    let name = parts.next()?;
    let id = parts.next()?;
    if parts.next().is_some() || name.is_empty() || id.is_empty() {
        return None;
    }
    Some((name, id))
}

pub(crate) fn collect_retained_chains(snapshot: &ArchiveSnapshot) -> Result<Vec<RetainedChain>> {
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

pub(crate) fn remove_deleted_chains(chains: &mut Vec<RetainedChain>) -> (usize, BTreeSet<u64>) {
    let mut removed_offsets = BTreeSet::new();
    let mut removed = 0usize;
    let mut kept = Vec::with_capacity(chains.len());
    for chain in chains.drain(..) {
        let deleted = latest_record(&chain)
            .map(|record| record.deleted())
            .unwrap_or(false);
        if deleted {
            removed += 1;
            for revision in &chain.revisions {
                if let Some(offset) = revision.old_offset {
                    removed_offsets.insert(offset);
                }
            }
        } else {
            kept.push(chain);
        }
    }
    *chains = kept;
    (removed, removed_offsets)
}

pub(crate) fn prune_unreferenced_assets(
    chains: &mut Vec<RetainedChain>,
) -> Result<(usize, BTreeSet<u64>)> {
    if chains.iter().any(|chain| {
        chain
            .revisions
            .iter()
            .any(|revision| revision.record.is_none())
    }) {
        return err(
            "archive_pruning_unknown_records",
            "This archive contains records from a newer version. Keep all material data when compacting it.",
        );
    }
    let blob_chains: BTreeMap<String, usize> = chains
        .iter()
        .enumerate()
        .filter(|(_, chain)| chain.revisions[0].record_type == RecordType::ASSET_BLOB)
        .map(|(index, chain)| (chain.revisions[0].id.to_lowercase(), index))
        .collect();
    let mut pending: Vec<String> = Vec::new();
    for chain in chains.iter() {
        if chain.revisions[0].record_type != RecordType::ASSET_METADATA {
            continue;
        }
        let latest = chain
            .revisions
            .last()
            .and_then(|revision| revision.record.as_ref());
        let Some(latest) = latest else { continue };
        let role = latest.field("record_role");
        if role == Some("audio-track") || role == Some("recording-take") {
            continue;
        }
        for revision in &chain.revisions {
            if let Some(record) = &revision.record {
                add_reference(
                    &mut pending,
                    record.field("blob_id").unwrap_or(""),
                    "Material metadata",
                )?;
            }
        }
    }
    let mut retained_blobs: BTreeSet<String> = BTreeSet::new();
    let mut cursor = 0usize;
    while cursor < pending.len() {
        let id = pending[cursor].clone();
        cursor += 1;
        if retained_blobs.contains(&id) {
            continue;
        }
        let Some(index) = blob_chains.get(&id).copied() else {
            return err(
                "archive_pruning_blob_missing",
                "Material metadata refers to missing content.",
            );
        };
        let latest = latest_record(&chains[index]);
        if latest.map(|record| record.deleted()).unwrap_or(false) {
            return err(
                "archive_pruning_blob_missing",
                "Material metadata refers to deleted content.",
            );
        }
        retained_blobs.insert(id);
        for revision in &chains[index].revisions {
            if let Some(record) = &revision.record {
                if record.field("record_role") != Some("asset-blob-manifest") {
                    continue;
                }
                for chunk_id in record.field("chunk_ids").unwrap_or("").split(',') {
                    if !chunk_id.trim().is_empty() {
                        add_reference(&mut pending, chunk_id, "Material manifest")?;
                    }
                }
            }
        }
    }
    let mut removed_offsets = BTreeSet::new();
    let mut pruned = 0usize;
    let mut index = chains.len();
    while index > 0 {
        index -= 1;
        let chain = &chains[index];
        if chain.revisions[0].record_type != RecordType::ASSET_BLOB
            || retained_blobs.contains(&chain.revisions[0].id.to_lowercase())
        {
            continue;
        }
        for revision in &chain.revisions {
            if let Some(offset) = revision.old_offset {
                removed_offsets.insert(offset);
            }
        }
        chains.remove(index);
        pruned += 1;
    }
    Ok((pruned, removed_offsets))
}

fn add_reference(pending: &mut Vec<String>, value: &str, context: &str) -> Result<()> {
    let id = value.to_lowercase();
    if !valid_uuid(&id) {
        return err(
            "archive_pruning_reference_invalid",
            &format!("{context} contains an invalid material content reference."),
        );
    }
    pending.push(id);
    Ok(())
}
