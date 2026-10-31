use std::collections::BTreeMap;

use crate::core::error::{err, CoreError, Result};

use super::checksum::{has_magic, read_u16, read_u32, read_u64};
use super::types::{ArchiveRecord, MAX_RECORD_PAYLOAD};

pub fn validate_record_payload_size(
    fields: &BTreeMap<String, String>,
    blob_length: usize,
    maximum: u64,
) -> Result<u64> {
    if blob_length as u64 > maximum.saturating_sub(16) {
        return err(
            "record_payload_limit",
            "Record payload exceeds the v1 limit.",
        );
    }
    let mut total = 16u64 + blob_length as u64;
    if fields.len() > 0xffff {
        return err("record_field_limit", "Record contains too many fields.");
    }
    for (key, value) in fields {
        if key.is_empty() || key.len() > 0xffff {
            return err(
                "record_field_limit",
                "Record field exceeds format limits.",
            );
        }
        total += 6 + key.len() as u64 + value.len() as u64;
        if total > maximum {
            return err(
                "record_payload_limit",
                "Record payload exceeds the v1 limit.",
            );
        }
    }
    Ok(total)
}

pub fn encode_record_payload(record: &ArchiveRecord) -> Result<Vec<u8>> {
    let total = validate_record_payload_size(&record.fields, record.blob.len(), MAX_RECORD_PAYLOAD)?;
    let mut output = vec![0u8; total as usize];
    output[..4].copy_from_slice(b"TXMD");
    output[4..6].copy_from_slice(&1u16.to_le_bytes());
    output[6..8].copy_from_slice(&(record.fields.len() as u16).to_le_bytes());
    output[8..16].copy_from_slice(&(record.blob.len() as u64).to_le_bytes());
    let mut cursor = 16usize;
    for (key, value) in &record.fields {
        output[cursor..cursor + 2].copy_from_slice(&(key.len() as u16).to_le_bytes());
        output[cursor + 2..cursor + 6].copy_from_slice(&(value.len() as u32).to_le_bytes());
        cursor += 6;
        output[cursor..cursor + key.len()].copy_from_slice(key.as_bytes());
        cursor += key.len();
        output[cursor..cursor + value.len()].copy_from_slice(value.as_bytes());
        cursor += value.len();
    }
    output[cursor..].copy_from_slice(&record.blob);
    Ok(output)
}

pub fn decode_record_payload(
    record_type: u16,
    id: &str,
    revision: u64,
    previous_offset: u64,
    payload: &[u8],
) -> Result<ArchiveRecord> {
    if payload.len() < 16 || !has_magic(payload, 0, b"TXMD") {
        return err(
            "record_payload_invalid",
            "Domain record payload is malformed.",
        );
    }
    if read_u16(payload, 4)? != 1 {
        return err("record_schema_unsupported", "Unsupported record schema.");
    }
    let count = read_u16(payload, 6)? as usize;
    let blob_length = read_u64(payload, 8)?;
    let mut fields = BTreeMap::new();
    let mut cursor = 16usize;
    for _ in 0..count {
        let key_length = read_u16(payload, cursor)? as usize;
        let value_length = read_u32(payload, cursor + 2)? as usize;
        cursor += 6;
        if key_length == 0 || cursor + key_length + value_length > payload.len() {
            return err(
                "record_field_invalid",
                "Record field exceeds its payload.",
            );
        }
        let key = std::str::from_utf8(&payload[cursor..cursor + key_length])
            .map_err(|_| CoreError::new("record_text_invalid", "Record text is not valid UTF-8."))?
            .to_owned();
        cursor += key_length;
        let value = std::str::from_utf8(&payload[cursor..cursor + value_length])
            .map_err(|_| CoreError::new("record_text_invalid", "Record text is not valid UTF-8."))?
            .to_owned();
        cursor += value_length;
        if fields.insert(key, value).is_some() {
            return err(
                "record_field_duplicate",
                "Record contains duplicate field names.",
            );
        }
    }
    if blob_length != (payload.len() - cursor) as u64 {
        return err(
            "record_blob_invalid",
            "Record blob length is inconsistent.",
        );
    }
    Ok(ArchiveRecord {
        record_type,
        id: id.to_owned(),
        revision,
        previous_offset,
        fields,
        blob: payload[cursor..].to_vec(),
    })
}
