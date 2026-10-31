use std::collections::{BTreeMap, HashSet};

use crate::core::archive::{sha256, ArchiveSnapshot, CommitInfo};
use crate::core::error::{err, Result};
use crate::core::format::{decode_stored_payload, RecordType, ARCHIVE_HEADER_SIZE};
use crate::core::index::{decode_index_page, read_frame_at, MAX_INDEX_DEPTH};

pub(crate) fn read_verified_index_tree(
    snapshot: &ArchiveSnapshot,
    commit: &CommitInfo,
) -> Result<(BTreeMap<String, u64>, Vec<u64>)> {
    let root_frame = read_frame_at(snapshot.source.as_ref(), commit.root_offset)?;
    if root_frame.record_type != RecordType::INDEX_PAGE
        || sha256(&root_frame.stored_payload) != commit.root_hash
    {
        return err(
            "archive_commit_root_invalid",
            "Commit root hash does not match its index page.",
        );
    }
    let mut entries: BTreeMap<String, u64> = BTreeMap::new();
    let mut page_offsets = Vec::new();
    let mut visited: HashSet<u64> = HashSet::new();
    visit_index_page(
        snapshot,
        commit,
        commit.root_offset,
        0,
        true,
        &mut entries,
        &mut page_offsets,
        &mut visited,
    )?;
    Ok((entries, page_offsets))
}

#[allow(clippy::too_many_arguments)]
fn visit_index_page(
    snapshot: &ArchiveSnapshot,
    commit: &CommitInfo,
    offset: u64,
    depth: usize,
    is_root: bool,
    entries: &mut BTreeMap<String, u64>,
    page_offsets: &mut Vec<u64>,
    visited: &mut HashSet<u64>,
) -> Result<(Option<String>, Option<String>)> {
    if depth > MAX_INDEX_DEPTH || !visited.insert(offset) {
        return err(
            "index_cycle",
            "B+ tree contains a cycle or excessive depth.",
        );
    }
    if offset >= commit.offset {
        return err(
            "index_page_invalid",
            "Index page is outside the committed archive region.",
        );
    }
    let frame = read_frame_at(snapshot.source.as_ref(), offset)?;
    if frame.record_type != RecordType::INDEX_PAGE {
        return err(
            "index_page_invalid",
            "Index page points to a non-index record.",
        );
    }
    let mut payload = decode_stored_payload(frame.codec, frame.flags, &frame.stored_payload)?;
    if snapshot.encrypted() {
        if payload.len() < 32 {
            return err(
                "archive_index_authentication_failed",
                "Encrypted index page is truncated.",
            );
        }
        let authenticated_length = payload.len() - 32;
        if let Some(key) = snapshot.data_key() {
            if !key.authentication_matches(
                "TUTORUX-INDEX-PAGE-V1",
                &payload[..authenticated_length],
                &payload[authenticated_length..],
            ) {
                return err(
                    "archive_index_authentication_failed",
                    "Encrypted archive index authentication failed.",
                );
            }
        }
        payload.truncate(authenticated_length);
    }
    page_offsets.push(offset);
    let page = decode_index_page(&payload)?;
    if page.leaf {
        if !is_root && page.entries.is_empty() {
            return err(
                "index_page_invalid",
                "A non-root leaf index page cannot be empty.",
            );
        }
        let first = page.entries.first().map(|(key, _)| key.clone());
        let last = page.entries.last().map(|(key, _)| key.clone());
        for (entry_key, value_offset) in page.entries {
            if value_offset < ARCHIVE_HEADER_SIZE
                || value_offset >= commit.offset
                || value_offset % 8 != 0
            {
                return err("index_page_invalid", "Leaf record offset is invalid.");
            }
            if entries.insert(entry_key, value_offset).is_some() {
                return err("index_page_order", "Index keys are not globally unique.");
            }
        }
        return Ok((first, last));
    }
    if page.children.len() != page.separators.len() + 1 || page.separators.is_empty() {
        return err(
            "index_page_invalid",
            "Internal index page has invalid children.",
        );
    }
    let mut first: Option<String> = None;
    let mut previous_last: Option<String> = None;
    for (index, child_offset) in page.children.iter().enumerate() {
        let child_frame = read_frame_at(snapshot.source.as_ref(), *child_offset)?;
        if child_frame.record_type != RecordType::INDEX_PAGE {
            return err(
                "index_page_invalid",
                "Internal page points to a non-index record.",
            );
        }
        let (child_first, child_last) = visit_index_page(
            snapshot,
            commit,
            *child_offset,
            depth + 1,
            false,
            entries,
            page_offsets,
            visited,
        )?;
        if index == 0 {
            first = child_first.clone();
        }
        if index > 0 {
            let separator = &page.separators[index - 1];
            if child_first.as_deref() != Some(separator.as_str())
                || previous_last
                    .as_ref()
                    .map(|previous| previous.as_str() >= separator.as_str())
                    .unwrap_or(true)
            {
                return err(
                    "index_page_order",
                    "Internal separators do not match child key ranges.",
                );
            }
        }
        if child_last.is_some() {
            previous_last = child_last;
        }
    }
    Ok((first, previous_last))
}
