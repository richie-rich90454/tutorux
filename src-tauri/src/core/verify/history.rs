use std::collections::HashSet;

use crate::core::archive::{decode_commit, find_consistent_commit, valid_uuid, ArchiveSnapshot};
use crate::core::error::{err, Result};
use crate::core::index::{primary_index_key, read_frame_at};

use super::full::verify_full;
use super::helpers::single_colon_key;
use super::HistoryVerificationResult;

pub fn verify_history(snapshot: &ArchiveSnapshot) -> Result<HistoryVerificationResult> {
    let current = verify_full(snapshot)?;
    if !current.valid {
        return err(
            "archive_verification_failed",
            &format!("Archive is not fully valid: {}", current.issues.join("; ")),
        );
    }
    let mut visited_frames: HashSet<u64> = HashSet::new();
    let mut historical_revisions = 0usize;
    for (key, latest_offset) in snapshot.all_index_entries() {
        let Some((_, id)) = single_colon_key(key) else {
            continue;
        };
        if !valid_uuid(id) {
            continue;
        }
        let latest = read_frame_at(snapshot.source.as_ref(), *latest_offset)?;
        if key != &primary_index_key(latest.record_type, &latest.id) {
            continue;
        }
        let mut offset = *latest_offset;
        let mut newer: Option<u64> = None;
        while offset != 0 {
            if !visited_frames.insert(offset) {
                return err(
                    "revision_cycle",
                    "Archive revision history contains a cycle or shared record frame.",
                );
            }
            let frame = read_frame_at(snapshot.source.as_ref(), offset)?;
            if frame.end_offset > snapshot.commit.offset
                || frame.record_type != latest.record_type
                || !frame.id.eq_ignore_ascii_case(&latest.id)
                || newer
                    .map(|revision| frame.revision >= revision || frame.revision + 1 != revision)
                    .unwrap_or(false)
                || (frame.previous_offset != 0 && frame.previous_offset >= offset)
            {
                return err(
                    "revision_lineage_invalid",
                    "Archive revision history contains an invalid or out-of-order link.",
                );
            }
            snapshot.verify_revision_frame(&frame)?;
            if newer.is_some() {
                historical_revisions += 1;
            }
            newer = Some(frame.revision);
            offset = frame.previous_offset;
        }
    }

    let mut commit = snapshot.commit.clone();
    let mut verified_commits = 0usize;
    let mut verified_generation_records = 0usize;
    let mut commits: HashSet<u64> = HashSet::new();
    loop {
        if commits.len() >= 1_000_000 || !commits.insert(commit.offset) {
            return err(
                "archive_commit_chain_invalid",
                "Archive commit history contains a cycle or exceeds the verification limit.",
            );
        }
        let consistent =
            find_consistent_commit(snapshot.source.as_ref(), &snapshot.header, commit.clone())?
                .filter(|(candidate, _)| candidate.offset == commit.offset);
        let Some((candidate, index_entries)) = consistent else {
            return err(
                "archive_commit_chain_invalid",
                "A historical commit or index tree is invalid.",
            );
        };
        let view =
            snapshot.open_generation(candidate.clone(), index_entries, snapshot.source.size());
        view.get_manifest()?;
        let verified = verify_full(&view)?;
        if !verified.valid {
            return err(
                "archive_commit_chain_invalid",
                &format!(
                    "Generation {} is not fully valid: {}",
                    candidate.generation,
                    verified.issues.join("; ")
                ),
            );
        }
        verified_generation_records += verified.current_records;
        verified_commits += 1;
        if candidate.previous_offset == 0 {
            if candidate.generation != 1 {
                return err(
                    "archive_commit_chain_invalid",
                    "The initial commit generation is invalid.",
                );
            }
            break;
        }
        if candidate.previous_offset >= candidate.offset {
            return err(
                "archive_commit_chain_invalid",
                "A commit points forward in the archive.",
            );
        }
        let previous = decode_commit(snapshot.source.as_ref(), candidate.previous_offset)?;
        if previous.generation + 1 != candidate.generation {
            return err(
                "archive_commit_chain_invalid",
                "Archive commit generations are not consecutive.",
            );
        }
        commit = previous;
    }

    Ok(HistoryVerificationResult {
        current,
        historical_revisions,
        verified_commits,
        verified_generation_records,
    })
}
