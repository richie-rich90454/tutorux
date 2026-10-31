use std::collections::BTreeMap;
use std::sync::Arc;

use crate::core::archive::{
    commit_published_end, decode_commit, encode_locator, scan_commit_frame_offsets,
    ArchiveSnapshot, CommitInfo,
};
use crate::core::error::{err, Result};
use crate::core::format::{record_type_name, CAPABILITY_ENCRYPTED};
use crate::core::index::read_frame_at;
use crate::core::source::ByteSource;
use crate::core::verify::verify_full;

use super::common::require_valid_full;
use super::header::{
    recover_checksum_damaged_archive_header, recover_magic_damaged_archive_header,
};
use super::types::RecoveryInspection;

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
        archive_header_valid: true,
        recovery_assessment_complete: true,
        header_repair_candidate: false,
        header_repair_available: false,
        header_repair_generation: 0,
        committed_generation: snapshot.commit.generation,
        candidate_generation,
        recoverable_generation,
        trailing_bytes,
        has_unpublished_commit: !after_base.is_empty(),
        encrypted: snapshot.encrypted(),
        requires_passphrase: snapshot.locked(),
        locked: snapshot.locked(),
        recoverable,
        recovered_generations,
        discarded_trailing_bytes,
        issues,
    })
}

pub fn inspect_recovery_source(
    source: Arc<dyn ByteSource>,
    passphrase: Option<&str>,
) -> Result<RecoveryInspection> {
    match ArchiveSnapshot::open_for_recovery(Arc::clone(&source)) {
        Ok(snapshot) => inspect_recovery(&snapshot),
        Err(error)
            if error.code == "archive_header_checksum" || error.code == "archive_magic_invalid" =>
        {
            inspect_damaged_header(source, passphrase, error.code.as_str())
        }
        Err(error) => Ok(RecoveryInspection {
            archive_header_valid: false,
            recovery_assessment_complete: false,
            header_repair_candidate: false,
            header_repair_available: false,
            header_repair_generation: 0,
            committed_generation: 0,
            candidate_generation: 0,
            recoverable_generation: 0,
            trailing_bytes: 0,
            has_unpublished_commit: false,
            encrypted: raw_encrypted(source.as_ref()),
            requires_passphrase: false,
            locked: false,
            recoverable: false,
            recovered_generations: 0,
            discarded_trailing_bytes: 0,
            issues: vec![error.message],
        }),
    }
}

fn inspect_damaged_header(
    source: Arc<dyn ByteSource>,
    passphrase: Option<&str>,
    code: &str,
) -> Result<RecoveryInspection> {
    let mut issues = Vec::new();
    let mut requires_passphrase = false;
    let mut header_repair_available = false;
    let mut header_repair_generation = 0u64;
    let mut repaired_snapshot: Option<ArchiveSnapshot> = None;
    let recovered = if code == "archive_header_checksum" {
        recover_checksum_damaged_archive_header(Arc::clone(&source), passphrase)
    } else {
        recover_magic_damaged_archive_header(Arc::clone(&source), passphrase)
    };
    match recovered {
        Ok(snapshot) => match verify_full(&snapshot) {
            Ok(report) if report.valid => {
                header_repair_available = true;
                header_repair_generation = snapshot.commit.generation;
                repaired_snapshot = Some(snapshot);
                issues.push(
                    "The header is damaged, but the reconstructed identity and complete archive passed full verification. Create a separate repaired copy with 'archive repair FILE --output COPY.tux --confirm-sensitive'."
                        .to_owned(),
                );
            }
            Ok(report) => issues.push(format!(
                "Header reconstruction passed only partial verification: {}",
                report.issues.join("; ")
            )),
            Err(error) => issues.push(format!(
                "Header reconstruction passed only partial verification: {}",
                error.message
            )),
        },
        Err(error) if error.code == "archive_locked" => {
            requires_passphrase = true;
            issues.push(
                "A header repair candidate was found. Supply the archive passphrase to complete verification, then create a separate repaired copy with 'archive repair'."
                    .to_owned(),
            );
        }
        Err(error) => {
            issues.push(format!(
                "The archive header is damaged and could not be reconstructed safely: {}",
                error.message
            ));
            issues.push(
                "Restore the fixed header from a known-good backup before in-place recovery; no archive bytes were changed."
                    .to_owned(),
            );
        }
    }
    let mut inspection = if let Some(snapshot) = repaired_snapshot {
        let mut inspection = inspect_recovery(&snapshot)?;
        inspection.header_repair_available = true;
        inspection.header_repair_generation = header_repair_generation;
        inspection
    } else {
        RecoveryInspection {
            archive_header_valid: false,
            recovery_assessment_complete: false,
            header_repair_candidate: true,
            header_repair_available: false,
            header_repair_generation: 0,
            committed_generation: 0,
            candidate_generation: 0,
            recoverable_generation: 0,
            trailing_bytes: 0,
            has_unpublished_commit: false,
            encrypted: raw_encrypted(source.as_ref()),
            requires_passphrase,
            locked: false,
            recoverable: false,
            recovered_generations: 0,
            discarded_trailing_bytes: 0,
            issues: Vec::new(),
        }
    };
    inspection.archive_header_valid = false;
    inspection.header_repair_candidate = true;
    inspection.header_repair_available = header_repair_available;
    inspection.recovery_assessment_complete = header_repair_available;
    inspection.requires_passphrase = requires_passphrase;
    inspection.issues.extend(issues);
    Ok(inspection)
}

fn raw_encrypted(source: &dyn ByteSource) -> bool {
    source
        .read(0, 64)
        .ok()
        .filter(|bytes| bytes.len() == 64)
        .map(|bytes| {
            u64::from_le_bytes([
                bytes[40], bytes[41], bytes[42], bytes[43], bytes[44], bytes[45], bytes[46],
                bytes[47],
            ]) & CAPABILITY_ENCRYPTED
                != 0
        })
        .unwrap_or(false)
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
        if let Ok(Some((consistent, index))) = crate::core::archive::find_consistent_commit(
            snapshot.source.as_ref(),
            &snapshot.header,
            commit,
        ) {
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
            let Some((type_name, id)) = super::retained::single_colon_key(key) else {
                return false;
            };
            is_known_type_name(type_name)
                && crate::core::archive::valid_uuid(id)
                && **offset >= snapshot.published_end_offset
                && **offset < commit.offset
        })
        .count()
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
            let mut published = ArchiveSnapshot::open(Arc::new(
                crate::core::source::MemorySource::new(bytes.clone()),
            ))?;
            if snapshot.encrypted() {
                if let Some(key) = snapshot.data_key() {
                    published.set_data_key(key.clone());
                }
            }
            let verification = verify_full(&published)?;
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
    let mut truncated = truncated;
    if snapshot.encrypted() {
        if let Some(key) = snapshot.data_key() {
            truncated.set_data_key(key.clone());
        }
    }
    require_valid_full(&truncated, "archive_recovery_validation_failed")?;
    Ok(bytes)
}
