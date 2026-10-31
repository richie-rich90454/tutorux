use crate::core::archive::{
    commit_published_end, decode_commit, find_consistent_commit, ArchiveSnapshot,
};
use crate::core::error::{err, CoreError, Result};
use crate::core::format::decode_record_frame_header;
use crate::core::source::ByteSource;

use super::compact::compact_archive_internal;
use super::types::{ArchiveRepairResult, CompactionOptions};

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

pub fn repair_archive_result(snapshot: &ArchiveSnapshot) -> Result<ArchiveRepairResult> {
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before repairing a copy.",
        );
    }
    let mut commit = snapshot.commit.clone();
    let mut last_error: Option<CoreError> = None;
    let mut visited: std::collections::HashSet<u64> = std::collections::HashSet::new();
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
                        match compact_archive_internal(
                            &selected,
                            true,
                            &CompactionOptions::default(),
                        ) {
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
                                    purge_removed_records: compacted.purge_removed_records,
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

pub fn repair_archive(snapshot: &ArchiveSnapshot) -> Result<Vec<u8>> {
    Ok(repair_archive_result(snapshot)?.bytes)
}
