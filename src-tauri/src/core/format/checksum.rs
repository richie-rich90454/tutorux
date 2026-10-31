use std::sync::OnceLock;

use crate::core::error::{CoreError, Result};

pub fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (index, slot) in table.iter_mut().enumerate() {
            let mut value = index as u32;
            for _ in 0..8 {
                value = if value & 1 == 1 {
                    (value >> 1) ^ 0xedb8_8320
                } else {
                    value >> 1
                };
            }
            *slot = value;
        }
        table
    });
    let mut state = 0xffff_ffffu32;
    for byte in bytes {
        state = (state >> 8) ^ table[((state ^ u32::from(*byte)) & 0xff) as usize];
    }
    !state
}

pub(super) fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| CoreError::new("archive_truncated", "Archive field is truncated."))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

pub(super) fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| CoreError::new("archive_truncated", "Archive field is truncated."))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

pub(super) fn read_u64(bytes: &[u8], offset: usize) -> Result<u64> {
    let slice = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| CoreError::new("archive_truncated", "Archive field is truncated."))?;
    Ok(u64::from_le_bytes([
        slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
    ]))
}

pub(super) fn has_magic(bytes: &[u8], offset: usize, magic: &[u8]) -> bool {
    bytes
        .get(offset..offset + magic.len())
        .map(|slice| slice == magic)
        .unwrap_or(false)
}
