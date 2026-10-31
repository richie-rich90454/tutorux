use crate::core::error::{err, Result};

use super::checksum::{crc32, has_magic, read_u16, read_u32, read_u64};
use super::header::{uuid_from_bytes, uuid_to_bytes};
use super::types::{RecordFrame, MAX_RECORD_PAYLOAD, RECORD_HEADER_SIZE};

pub fn encode_record_frame(
    record_type: u16,
    id: &str,
    revision: u64,
    previous_offset: u64,
    stored_payload: &[u8],
    codec: u8,
    flags: u8,
) -> Result<Vec<u8>> {
    let header = encode_record_frame_header(
        record_type,
        id,
        revision,
        previous_offset,
        stored_payload.len() as u64,
        codec,
        flags,
        crc32(stored_payload),
    )?;
    let padding = (8 - (stored_payload.len() % 8)) % 8;
    let mut output = vec![0u8; RECORD_HEADER_SIZE + stored_payload.len() + padding];
    output[..RECORD_HEADER_SIZE].copy_from_slice(&header);
    output[RECORD_HEADER_SIZE..RECORD_HEADER_SIZE + stored_payload.len()].copy_from_slice(stored_payload);
    Ok(output)
}

#[allow(clippy::too_many_arguments)]
pub fn encode_record_frame_header(
    record_type: u16,
    id: &str,
    revision: u64,
    previous_offset: u64,
    payload_length: u64,
    codec: u8,
    flags: u8,
    payload_checksum: u32,
) -> Result<Vec<u8>> {
    if payload_length > MAX_RECORD_PAYLOAD {
        return err(
            "record_payload_limit",
            "Record exceeds the v1 payload limit.",
        );
    }
    if codec > 1 {
        return err("record_codec_invalid", "Record framing codec is invalid.");
    }
    if flags & !1 != 0 {
        return err("record_flags_invalid", "Record framing flags are invalid.");
    }
    let mut header = vec![0u8; RECORD_HEADER_SIZE];
    header[..4].copy_from_slice(b"TXRC");
    header[4..6].copy_from_slice(&record_type.to_le_bytes());
    header[6..8].copy_from_slice(&1u16.to_le_bytes());
    header[8..12].copy_from_slice(&(RECORD_HEADER_SIZE as u32).to_le_bytes());
    header[12..20].copy_from_slice(&payload_length.to_le_bytes());
    header[20..36].copy_from_slice(&uuid_to_bytes(id)?);
    header[36..44].copy_from_slice(&revision.to_le_bytes());
    header[44..52].copy_from_slice(&previous_offset.to_le_bytes());
    header[52] = codec;
    header[53] = flags;
    header[56..60].copy_from_slice(&payload_checksum.to_le_bytes());
    let checksum = crc32(&header[..60]);
    header[60..64].copy_from_slice(&checksum.to_le_bytes());
    Ok(header)
}

pub fn decode_record_frame_header(header: &[u8], absolute_offset: u64) -> Result<RecordFrame> {
    if absolute_offset % 8 != 0 {
        return err(
            "record_offset_invalid",
            "Record offset is unaligned or outside the archive.",
        );
    }
    if header.len() < RECORD_HEADER_SIZE || !has_magic(header, 0, b"TXRC") {
        return err(
            "record_header_invalid",
            "Record header magic or length is invalid.",
        );
    }
    let record_type = read_u16(header, 4)?;
    let version = read_u16(header, 6)?;
    let header_length = read_u32(header, 8)?;
    let payload_length = read_u64(header, 12)?;
    if version != 1 || header_length != RECORD_HEADER_SIZE as u32 || payload_length > MAX_RECORD_PAYLOAD
    {
        return err(
            "record_header_invalid",
            "Record framing fields are invalid.",
        );
    }
    let codec = header[52];
    let flags = header[53];
    let reserved = read_u16(header, 54)?;
    let payload_checksum = read_u32(header, 56)?;
    let header_checksum = read_u32(header, 60)?;
    if reserved != 0
        || flags & !1 != 0
        || codec > 1
        || crc32(&header[..60]) != header_checksum
    {
        return err(
            "record_header_checksum",
            "Record header checksum or codec is invalid.",
        );
    }
    Ok(RecordFrame {
        record_type,
        id: uuid_from_bytes(&header[20..36])?,
        revision: read_u64(header, 36)?,
        previous_offset: read_u64(header, 44)?,
        codec,
        flags,
        payload_length,
        payload_checksum,
        stored_payload: Vec::new(),
        end_offset: 0,
    })
}

/// Decode a frame from a buffer that begins with its 64-byte header.
pub fn decode_record_frame(bytes: &[u8], absolute_offset: u64) -> Result<RecordFrame> {
    if absolute_offset % 8 != 0 {
        return err(
            "record_offset_invalid",
            "Record offset is unaligned or outside the archive.",
        );
    }
    if bytes.len() < RECORD_HEADER_SIZE {
        return err(
            "record_header_invalid",
            "Record header magic or length is invalid.",
        );
    }
    let mut frame = decode_record_frame_header(&bytes[..RECORD_HEADER_SIZE], absolute_offset)?;
    let payload_length = frame.payload_length as usize;
    if payload_length > bytes.len() - RECORD_HEADER_SIZE {
        return err(
            "record_offset_invalid",
            "Record payload extends beyond the archive.",
        );
    }
    let payload_end = RECORD_HEADER_SIZE + payload_length;
    let padding = (8 - (payload_length % 8)) % 8;
    if padding > bytes.len() - payload_end {
        return err(
            "record_offset_invalid",
            "Record alignment padding is truncated.",
        );
    }
    let stored_payload = &bytes[RECORD_HEADER_SIZE..payload_end];
    if crc32(stored_payload) != frame.payload_checksum {
        return err(
            "record_payload_checksum",
            "Record payload checksum is invalid.",
        );
    }
    if bytes[payload_end..payload_end + padding]
        .iter()
        .any(|byte| *byte != 0)
    {
        return err(
            "record_padding_invalid",
            "Record alignment padding must be zero.",
        );
    }
    frame.stored_payload = stored_payload.to_vec();
    frame.end_offset = absolute_offset + payload_end as u64 + padding as u64;
    Ok(frame)
}
