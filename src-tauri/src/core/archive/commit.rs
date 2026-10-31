use std::collections::BTreeMap;

use crate::core::error::{err, CoreError, Result};
use crate::core::format::{
    decode_stored_payload, ArchiveHeader, RecordType, ARCHIVE_HEADER_SIZE, CAPABILITY_ENCRYPTED,
    ZERO_UUID,
};
use crate::core::index::{read_frame_at, read_index_tree};
use crate::core::source::ByteSource;

use super::support::sha256;
use super::{CommitInfo, LOCATOR_SIZE};

pub fn encode_commit_payload(
    generation: u64,
    previous_offset: u64,
    root_offset: u64,
    root_hash: &[u8],
    transaction_id: &str,
    record_count: u64,
) -> Vec<u8> {
    let mut payload = vec![0u8; 92];
    payload[..4].copy_from_slice(b"TXCM");
    payload[4..6].copy_from_slice(&1u16.to_le_bytes());
    payload[8..16].copy_from_slice(&generation.to_le_bytes());
    payload[16..24].copy_from_slice(&previous_offset.to_le_bytes());
    payload[24..32].copy_from_slice(&root_offset.to_le_bytes());
    payload[32..64].copy_from_slice(root_hash);
    payload[64..80].copy_from_slice(
        &crate::core::format::uuid_to_bytes(transaction_id).expect("valid transaction id"),
    );
    payload[80..88].copy_from_slice(&record_count.to_le_bytes());
    payload[88..92].copy_from_slice(&1u32.to_le_bytes());
    payload
}

pub fn encode_locator(commit_offset: u64, generation: u64) -> Vec<u8> {
    let mut locator = vec![0u8; LOCATOR_SIZE as usize];
    locator[..8].copy_from_slice(b"TUXLOC1\0");
    locator[8..16].copy_from_slice(&commit_offset.to_le_bytes());
    locator[16..24].copy_from_slice(&generation.to_le_bytes());
    let checksum = crate::core::format::crc32(&locator[..24]);
    locator[24..28].copy_from_slice(&checksum.to_le_bytes());
    locator
}

pub(crate) fn valid_locator(locator: &[u8]) -> bool {
    locator.len() == LOCATOR_SIZE as usize
        && &locator[..8] == b"TUXLOC1\0"
        && crate::core::format::crc32(&locator[..24])
            == u32::from_le_bytes([locator[24], locator[25], locator[26], locator[27]])
        && locator[28..32].iter().all(|byte| *byte == 0)
}

pub fn decode_commit(source: &dyn ByteSource, offset: u64) -> Result<CommitInfo> {
    let frame = read_frame_at(source, offset)?;
    let payload = decode_stored_payload(frame.codec, frame.flags, &frame.stored_payload)?;
    if frame.record_type != RecordType::COMMIT
        || frame.id != ZERO_UUID
        || (payload.len() != 92 && payload.len() != 124)
        || &payload[..4] != b"TXCM"
    {
        return err("commit_invalid", "Commit record has an invalid structure.");
    }
    let version = u16::from_le_bytes([payload[4], payload[5]]);
    let reserved = u16::from_le_bytes([payload[6], payload[7]]);
    let generation = u64::from_le_bytes(payload[8..16].try_into().unwrap());
    let previous_offset = u64::from_le_bytes(payload[16..24].try_into().unwrap());
    let root_offset = u64::from_le_bytes(payload[24..32].try_into().unwrap());
    let root_hash = payload[32..64].to_vec();
    let transaction_id = crate::core::format::uuid_from_bytes(&payload[64..80])?;
    let record_count = u64::from_le_bytes(payload[80..88].try_into().unwrap());
    let archive_version = u32::from_le_bytes(payload[88..92].try_into().unwrap());
    if version != 1
        || reserved != 0
        || generation == 0
        || archive_version != 1
        || frame.revision != generation
        || frame.previous_offset != previous_offset
        || root_offset < ARCHIVE_HEADER_SIZE
        || root_offset >= offset
        || previous_offset >= offset
    {
        return err("commit_invalid", "Commit metadata is invalid.");
    }
    Ok(CommitInfo {
        generation,
        offset,
        previous_offset,
        root_offset,
        root_hash,
        transaction_id,
        record_count,
    })
}

pub(crate) fn locator_matches(locator: &[u8], commit: &CommitInfo) -> bool {
    valid_locator(locator)
        && u64::from_le_bytes(locator[8..16].try_into().unwrap()) == commit.offset
        && u64::from_le_bytes(locator[16..24].try_into().unwrap()) == commit.generation
}

pub fn commit_published_end(source: &dyn ByteSource, commit: &CommitInfo) -> Result<u64> {
    let frame = read_frame_at(source, commit.offset)?;
    if frame.record_type != RecordType::COMMIT {
        return err(
            "archive_commit_invalid",
            "Commit offset points to a non-commit record.",
        );
    }
    let locator_offset = frame.end_offset;
    if source.size().saturating_sub(locator_offset) >= LOCATOR_SIZE {
        let locator = source.read(locator_offset, LOCATOR_SIZE as usize)?;
        if locator_matches(&locator, commit) {
            return Ok(locator_offset + LOCATOR_SIZE);
        }
    }
    let chunk_size = 64 * 1024u64;
    let mut position = locator_offset;
    while position + LOCATOR_SIZE <= source.size() {
        let length = (source.size() - position).min(chunk_size) as usize;
        let bytes = source.read(position, length)?;
        for index in 0..=bytes.len().saturating_sub(LOCATOR_SIZE as usize) {
            if &bytes[index..index + 8] != b"TUXLOC1\0" {
                continue;
            }
            let locator = &bytes[index..index + LOCATOR_SIZE as usize];
            if locator_matches(locator, commit) {
                return Ok(position + index as u64 + LOCATOR_SIZE);
            }
        }
        position += length as u64;
    }
    err(
        "archive_locator_invalid",
        "A commit publication locator is invalid or points to a different generation.",
    )
}

pub fn scan_commit_frame_offsets(source: &dyn ByteSource) -> Result<Vec<u64>> {
    let mut offsets = Vec::new();
    let chunk_size = 64 * 1024u64;
    let mut cursor = ARCHIVE_HEADER_SIZE;
    while cursor + 64 <= source.size() {
        let length = (source.size() - cursor).min(chunk_size + 63) as usize;
        let bytes = source.read(cursor, length)?;
        let mut local = 0usize;
        while local + 64 <= bytes.len() {
            if &bytes[local..local + 4] == b"TXRC" {
                let absolute = cursor + local as u64;
                if let Ok(frame) = read_frame_at(source, absolute) {
                    if frame.record_type == RecordType::COMMIT
                        && decode_commit(source, absolute).is_ok()
                    {
                        offsets.push(absolute);
                    }
                }
            }
            local += 8;
        }
        cursor += chunk_size;
    }
    offsets.sort_unstable();
    offsets.dedup();
    Ok(offsets)
}

pub fn find_consistent_commit(
    source: &dyn ByteSource,
    header: &ArchiveHeader,
    first: CommitInfo,
) -> Result<Option<(CommitInfo, BTreeMap<String, u64>)>> {
    let mut commit = Some(first);
    for _ in 0..1024 {
        let Some(current) = commit else {
            return Ok(None);
        };
        let valid_chain = if current.previous_offset == 0 {
            current.generation == 1
        } else {
            decode_commit(source, current.previous_offset)
                .map(|previous| previous.generation + 1 == current.generation)
                .unwrap_or(false)
        };
        if !valid_chain {
            commit = if current.previous_offset == 0 {
                None
            } else {
                decode_commit(source, current.previous_offset).ok()
            };
            continue;
        }
        let root_result = read_frame_at(source, current.root_offset).and_then(|root_frame| {
            if root_frame.record_type != RecordType::INDEX_PAGE
                || sha256(&root_frame.stored_payload) != current.root_hash
            {
                return Err(CoreError::new(
                    "commit_invalid",
                    "Commit root hash does not match its index page.",
                ));
            }
            let encrypted = header.capabilities & CAPABILITY_ENCRYPTED != 0;
            read_index_tree(source, current.offset, current.root_offset, encrypted, None)
        });
        match root_result {
            Ok(index) => return Ok(Some((current, index))),
            Err(_) => {
                commit = if current.previous_offset == 0 {
                    None
                } else {
                    decode_commit(source, current.previous_offset).ok()
                };
            }
        }
    }
    Ok(None)
}
