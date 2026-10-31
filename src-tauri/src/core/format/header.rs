use crate::core::error::{err, CoreError, Result};

use super::checksum::{crc32, has_magic, read_u16, read_u32, read_u64};
use super::types::{
    ArchiveHeader, ARCHIVE_HEADER_SIZE, CAPABILITY_ENCRYPTED, SUPPORTED_ARCHIVE_MAJOR,
    SUPPORTED_ARCHIVE_MINOR,
};

pub fn valid_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            8 | 13 | 18 | 23 => {
                if *byte != b'-' {
                    return false;
                }
            }
            _ => {
                if !byte.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

pub fn uuid_to_bytes(value: &str) -> Result<[u8; 16]> {
    if !valid_uuid(value) {
        return err("id_invalid", "Identifier must be a 128-bit hexadecimal UUID.");
    }
    let hex: String = value.chars().filter(|character| *character != '-').collect();
    let mut output = [0u8; 16];
    for (index, slot) in output.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
            .map_err(|_| CoreError::new("id_invalid", "Identifier must be a 128-bit UUID."))?;
    }
    Ok(output)
}

pub fn uuid_from_bytes(bytes: &[u8]) -> Result<String> {
    if bytes.len() != 16 {
        return err("id_invalid", "Identifier must be a 128-bit UUID.");
    }
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

pub fn inspect_archive_version(bytes: &[u8]) -> Result<(u16, u16)> {
    if bytes.len() < ARCHIVE_HEADER_SIZE as usize || !has_magic(bytes, 0, b"TUTORUX\0") {
        return err("archive_magic_invalid", "File is not a Tutorux archive.");
    }
    let expected = read_u32(bytes, 60)?;
    if crc32(&bytes[..60]) != expected {
        return err("archive_header_checksum", "Archive header checksum is invalid.");
    }
    if read_u32(bytes, 12)? != ARCHIVE_HEADER_SIZE as u32 {
        return err(
            "archive_header_invalid",
            "Archive header fields are invalid.",
        );
    }
    Ok((read_u16(bytes, 8)?, read_u16(bytes, 10)?))
}

pub fn encode_archive_header(header: &ArchiveHeader) -> Vec<u8> {
    let mut bytes = vec![0u8; ARCHIVE_HEADER_SIZE as usize];
    bytes[..8].copy_from_slice(b"TUTORUX\0");
    bytes[8..10].copy_from_slice(&header.major_version.to_le_bytes());
    bytes[10..12].copy_from_slice(&header.minor_version.to_le_bytes());
    bytes[12..16].copy_from_slice(&(ARCHIVE_HEADER_SIZE as u32).to_le_bytes());
    bytes[16..32].copy_from_slice(&uuid_to_bytes(&header.id).expect("valid archive id"));
    bytes[32..40].copy_from_slice(&header.created_at_us.to_le_bytes());
    bytes[40..48].copy_from_slice(&header.capabilities.to_le_bytes());
    let checksum = crc32(&bytes[..60]);
    bytes[60..64].copy_from_slice(&checksum.to_le_bytes());
    bytes
}

pub fn decode_archive_header(bytes: &[u8]) -> Result<ArchiveHeader> {
    let (major, minor) = inspect_archive_version(bytes)?;
    if bytes[48..60].iter().any(|byte| *byte != 0) {
        return err(
            "archive_header_reserved",
            "Reserved archive header bytes must be zero.",
        );
    }
    if major != SUPPORTED_ARCHIVE_MAJOR || minor > SUPPORTED_ARCHIVE_MINOR {
        return err(
            "archive_version_unsupported",
            "This archive format version is not supported.",
        );
    }
    let capabilities = read_u64(bytes, 40)?;
    if capabilities & !CAPABILITY_ENCRYPTED != 0 {
        return err(
            "archive_capability_unsupported",
            "This archive requires capabilities that this application does not understand.",
        );
    }
    Ok(ArchiveHeader {
        id: uuid_from_bytes(&bytes[16..32])?,
        major_version: major,
        minor_version: minor,
        created_at_us: read_u64(bytes, 32)?,
        capabilities,
    })
}
