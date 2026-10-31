use crate::core::archive::{sha256, ArchiveRecord, RecordType};

use super::helpers::{hex_encode, is_digits, is_sha256_hex};
use super::VerificationLookup;

pub(crate) struct AssetContent {
    pub(crate) bytes: Vec<u8>,
    pub(crate) issue: Option<String>,
}

pub(crate) fn collect_asset_content(
    blob: &ArchiveRecord,
    lookup: &VerificationLookup<'_>,
) -> AssetContent {
    if blob.field("record_role") != Some("asset-blob-manifest") {
        return AssetContent {
            bytes: blob.blob.clone(),
            issue: None,
        };
    }
    let chunk_count = blob.field("chunk_count").unwrap_or("");
    let chunk_ids = blob.field("chunk_ids").unwrap_or("");
    if !is_digits(chunk_count) {
        return AssetContent {
            bytes: Vec::new(),
            issue: Some("manifest chunk count is invalid.".to_owned()),
        };
    }
    let expected = chunk_count.parse::<u64>().unwrap_or(u64::MAX);
    let mut parts: Vec<u8> = Vec::new();
    let mut index: u64 = 0;
    if !chunk_ids.is_empty() {
        for raw_id in chunk_ids.split(',') {
            let id = raw_id.trim().to_lowercase();
            if !crate::core::archive::valid_uuid(&id) {
                return AssetContent {
                    bytes: Vec::new(),
                    issue: Some("manifest contains an invalid chunk identifier.".to_owned()),
                };
            }
            let chunk = lookup.get(RecordType::ASSET_BLOB, &id);
            let consistent = chunk
                .map(|chunk| {
                    chunk.field("record_role") == Some("asset-blob-chunk")
                        && chunk.field("manifest_id").map(str::to_lowercase).as_deref()
                            == Some(&blob.id.to_lowercase())
                        && chunk
                            .field("chunk_index")
                            .map(|value| value == index.to_string())
                            .unwrap_or(false)
                })
                .unwrap_or(false);
            if !consistent {
                return AssetContent {
                    bytes: Vec::new(),
                    issue: Some("manifest references missing or inconsistent chunks.".to_owned()),
                };
            }
            parts.extend_from_slice(&chunk.unwrap().blob);
            index += 1;
        }
    }
    if index != expected {
        return AssetContent {
            bytes: Vec::new(),
            issue: Some("manifest chunk count is inconsistent.".to_owned()),
        };
    }
    AssetContent {
        bytes: parts,
        issue: None,
    }
}

pub(crate) fn asset_fields_match(record: &ArchiveRecord, bytes: &[u8]) -> bool {
    let expected_bytes = record.field("byte_size").unwrap_or("");
    let expected_hash = record.field("content_hash").unwrap_or("").to_lowercase();
    is_digits(expected_bytes)
        && expected_bytes.parse::<u64>().ok() == Some(bytes.len() as u64)
        && is_sha256_hex(&expected_hash)
        && hex_encode(&sha256(bytes)) == expected_hash
}
