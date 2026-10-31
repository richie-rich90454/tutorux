use crate::core::error::{err, Result};

use super::checksum::read_u64;
use super::types::MAX_RECORD_PAYLOAD;

pub fn decode_stored_payload(codec: u8, flags: u8, stored_payload: &[u8]) -> Result<Vec<u8>> {
    if flags & 1 != 0 {
        return err(
            "archive_locked",
            "This record is encrypted and must be unlocked first.",
        );
    }
    if codec == 0 {
        return Ok(stored_payload.to_vec());
    }
    decode_lz4_block(stored_payload)
}

pub fn compress_record_payload(payload: &[u8]) -> Result<(u8, Vec<u8>)> {
    if payload.len() as u64 > MAX_RECORD_PAYLOAD {
        return err(
            "record_payload_limit",
            "Record exceeds the v1 uncompressed payload limit.",
        );
    }
    if payload.len() < 256 {
        return Ok((0, payload.to_vec()));
    }
    let maximum = payload.len() - 24;
    match compress_lz4_block(payload, maximum) {
        Some(block) => {
            let mut bytes = Vec::with_capacity(8 + block.len());
            bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
            bytes.extend_from_slice(&block);
            Ok((1, bytes))
        }
        None => Ok((0, payload.to_vec())),
    }
}

fn compress_lz4_block(input: &[u8], maximum_length: usize) -> Option<Vec<u8>> {
    let mut table = vec![-1i32; 1 << 16];
    let mut output: Vec<u8> = Vec::with_capacity(maximum_length.min(1024));
    let mut anchor = 0usize;
    let mut cursor = 0usize;

    let hash_sequence = |offset: usize| -> usize {
        let value = u32::from_le_bytes([
            input[offset],
            input[offset + 1],
            input[offset + 2],
            input[offset + 3],
        ]);
        ((value.wrapping_mul(2_654_435_761) >> 16) & 0xffff) as usize
    };

    while cursor + 12 <= input.len() {
        let hash = hash_sequence(cursor);
        let previous = table[hash];
        table[hash] = cursor as i32;
        if previous < 0
            || cursor - previous as usize > 65_535
            || input[previous as usize..previous as usize + 4] != input[cursor..cursor + 4]
        {
            cursor += 1;
            continue;
        }

        let mut match_length = 4usize;
        while cursor + match_length < input.len() - 5
            && input[previous as usize + match_length] == input[cursor + match_length]
        {
            match_length += 1;
        }

        let literal_length = cursor - anchor;
        let match_code = match_length - 4;
        let token_offset = output.len();
        if output.len() + 1 > maximum_length {
            return None;
        }
        output.push(0);
        output[token_offset] =
            ((literal_length.min(15) << 4) | match_code.min(15)) as u8;
        if literal_length >= 15 {
            append_length(&mut output, literal_length - 15, maximum_length)?;
        }
        if output.len() + literal_length > maximum_length {
            return None;
        }
        output.extend_from_slice(&input[anchor..cursor]);
        let distance = cursor - previous as usize;
        if output.len() + 2 > maximum_length {
            return None;
        }
        output.push((distance & 0xff) as u8);
        output.push((distance >> 8) as u8);
        if match_code >= 15 {
            append_length(&mut output, match_code - 15, maximum_length)?;
        }

        cursor += match_length;
        anchor = cursor;
        let update_start = cursor.saturating_sub(3);
        let mut position = update_start;
        while position < cursor && position + 4 <= input.len() {
            table[hash_sequence(position)] = position as i32;
            position += 1;
        }
    }

    let literal_length = input.len() - anchor;
    if output.len() + 1 > maximum_length {
        return None;
    }
    output.push((literal_length.min(15) << 4) as u8);
    if literal_length >= 15 {
        append_length(&mut output, literal_length - 15, maximum_length)?;
    }
    if output.len() + literal_length > maximum_length {
        return None;
    }
    output.extend_from_slice(&input[anchor..]);
    Some(output)
}

fn append_length(output: &mut Vec<u8>, length: usize, maximum: usize) -> Option<()> {
    let mut remaining = length;
    while remaining >= 255 {
        if output.len() + 1 > maximum {
            return None;
        }
        output.push(255);
        remaining -= 255;
    }
    if output.len() + 1 > maximum {
        return None;
    }
    output.push(remaining as u8);
    Some(())
}

pub fn decode_lz4_block(stored_payload: &[u8]) -> Result<Vec<u8>> {
    if stored_payload.len() < 8 {
        return err(
            "record_compression_invalid",
            "Compressed record is missing its decoded length.",
        );
    }
    let decoded_length = read_u64(stored_payload, 0)?;
    if decoded_length > MAX_RECORD_PAYLOAD {
        return err(
            "record_payload_limit",
            "Decoded record exceeds the v1 payload limit.",
        );
    }
    let decoded_length = decoded_length as usize;
    let mut output = vec![0u8; decoded_length];
    let mut source_offset = 8usize;
    let mut target_offset = 0usize;

    let read_extended_length = |initial: usize, cursor: &mut usize| -> Result<usize> {
        let mut length = initial;
        if initial != 15 {
            return Ok(length);
        }
        loop {
            if *cursor >= stored_payload.len() {
                return err(
                    "record_compression_invalid",
                    "LZ4 length is truncated.",
                );
            }
            let extra = stored_payload[*cursor] as usize;
            *cursor += 1;
            length += extra;
            if extra != 255 {
                return Ok(length);
            }
        }
    };

    while source_offset < stored_payload.len() {
        let token = stored_payload[source_offset];
        source_offset += 1;
        let literal_length = read_extended_length((token >> 4) as usize, &mut source_offset)?;
        if literal_length > stored_payload.len() - source_offset
            || literal_length > decoded_length - target_offset
        {
            return err(
                "record_compression_invalid",
                "LZ4 literal run exceeds its block.",
            );
        }
        output[target_offset..target_offset + literal_length]
            .copy_from_slice(&stored_payload[source_offset..source_offset + literal_length]);
        source_offset += literal_length;
        target_offset += literal_length;
        if source_offset == stored_payload.len() {
            break;
        }
        if source_offset + 2 > stored_payload.len() {
            return err(
                "record_compression_invalid",
                "LZ4 match offset is truncated.",
            );
        }
        let match_offset = stored_payload[source_offset] as usize
            | ((stored_payload[source_offset + 1] as usize) << 8);
        source_offset += 2;
        if match_offset == 0 || match_offset > target_offset {
            return err(
                "record_compression_invalid",
                "LZ4 match offset is invalid.",
            );
        }
        let match_length = read_extended_length((token & 0x0f) as usize, &mut source_offset)? + 4;
        if match_length > decoded_length - target_offset {
            return err(
                "record_compression_invalid",
                "LZ4 match exceeds its decoded length.",
            );
        }
        for index in 0..match_length {
            output[target_offset + index] = output[target_offset + index - match_offset];
        }
        target_offset += match_length;
    }

    if target_offset != decoded_length {
        return err(
            "record_compression_invalid",
            "LZ4 decoded length does not match its header.",
        );
    }
    Ok(output)
}
