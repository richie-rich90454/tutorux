use super::{
    identity::{
        archive_changed_message, archive_identity_from_file, archive_location_changed_message,
        resolve_existing_file, same_open_file, same_path,
    },
    state::{ArchiveAppendResult, ArchiveIdentity, ArchiveLocator, DesktopState},
};
use sha2::Digest;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
};
use tauri::State;
use zeroize::Zeroizing;

const MAX_AUDIO_GENERATION_BYTES: usize = 8 * 1024 * 1024;
const ARCHIVE_LOCATOR_BYTES: usize = 32;

#[tauri::command]
pub(crate) fn append_audio_archive_generation(
    window: tauri::WebviewWindow,
    archive_token: String,
    expected_size: String,
    generation: String,
    bytes: Vec<u8>,
    state: State<'_, DesktopState>,
) -> Result<ArchiveAppendResult, String> {
    if window.label() != "main" {
        return Err(
            "Microphone checkpoints are only available from the main application window."
                .to_owned(),
        );
    }
    let expected_size = expected_size
        .parse::<u64>()
        .map_err(|_| "The microphone archive size is invalid.".to_owned())?;
    let generation = generation
        .parse::<u64>()
        .map_err(|_| "The microphone archive generation is invalid.".to_owned())?;
    if bytes.len() < ARCHIVE_LOCATOR_BYTES || bytes.len() > MAX_AUDIO_GENERATION_BYTES {
        return Err("A microphone archive checkpoint has an unsupported generation size.".into());
    }
    let bytes = Zeroizing::new(bytes);

    let archive_lock = state
        .opened_archives
        .lock()
        .map_err(|_| "Archive access state is unavailable.".to_owned())?
        .get(&archive_token)
        .map(|archive| archive.lock.clone())
        .ok_or_else(|| {
            "Archive access has expired. Reopen the file before recording.".to_owned()
        })?;
    let _archive_write_lock = state.archive_locks.exclusive_guard(&archive_lock)?;
    let mut archives = state
        .opened_archives
        .lock()
        .map_err(|_| "Archive access state is unavailable.".to_owned())?;
    let archive = archives.get_mut(&archive_token).ok_or_else(|| {
        "Archive access has expired. Reopen the file before recording.".to_owned()
    })?;
    match resolve_existing_file(&archive.location)? {
        Some(path) if same_path(&path, &archive.path) => {}
        Some(_) => return Err(archive_location_changed_message()),
        None => return Err(archive_changed_message()),
    }

    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .open(&archive.path)
        .map_err(|error| format!("Could not open the authorized archive for recording: {error}"))?;
    if !same_open_file(&archive.path, &file)? {
        return Err(archive_changed_message());
    }
    let (current_identity, mut hasher) = archive_identity_from_file(&mut file)?;
    if current_identity != archive.identity || current_identity.size != expected_size {
        return Err(archive_changed_message());
    }
    let mut previous_locator = [0_u8; ARCHIVE_LOCATOR_BYTES];
    file.seek(SeekFrom::End(-(ARCHIVE_LOCATOR_BYTES as i64)))
        .map_err(|_| {
            "The authorized file does not end at a published archive generation.".to_owned()
        })?;
    file.read_exact(&mut previous_locator)
        .map_err(|error| format!("Could not inspect the published archive generation: {error}"))?;
    let previous = decode_archive_locator(&previous_locator)?;
    if previous.generation.checked_add(1) != Some(generation) {
        return Err("The microphone checkpoint is based on a stale archive generation.".into());
    }
    validate_audio_archive_generation(&bytes, expected_size, generation, previous)?;
    let expected_new_size = expected_size
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "The archive size exceeds the supported range.".to_owned())?;

    let locator_offset = bytes.len() - ARCHIVE_LOCATOR_BYTES;
    file.seek(SeekFrom::End(0))
        .map_err(|error| format!("Could not seek to the archive end: {error}"))?;
    file.write_all(&bytes[..locator_offset])
        .map_err(|error| format!("Could not append the microphone checkpoint: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush microphone checkpoint data: {error}"))?;
    file.write_all(&bytes[locator_offset..])
        .map_err(|error| format!("Could not publish the microphone checkpoint: {error}"))?;
    file.sync_all().map_err(|error| {
        format!("Could not flush the microphone checkpoint publication: {error}")
    })?;
    verify_audio_archive_append(&mut file, expected_size, &bytes)?;

    if file
        .metadata()
        .map_err(|error| format!("Could not inspect the updated archive: {error}"))?
        .len()
        != expected_new_size
    {
        return Err("The microphone checkpoint ended at an unexpected archive size.".into());
    }
    if !same_open_file(&archive.path, &file)? {
        return Err(archive_changed_message());
    }
    match resolve_existing_file(&archive.location)? {
        Some(path) if same_path(&path, &archive.path) => {}
        Some(_) => return Err(archive_location_changed_message()),
        None => return Err(archive_changed_message()),
    }
    hasher.update(&*bytes);
    archive.identity = ArchiveIdentity {
        size: expected_new_size,
        sha256: format!("{:x}", hasher.clone().finalize()),
    };
    archive.hasher = hasher;
    Ok(ArchiveAppendResult {
        size: expected_new_size.to_string(),
    })
}

fn decode_archive_locator(bytes: &[u8]) -> Result<ArchiveLocator, String> {
    if bytes.len() != ARCHIVE_LOCATOR_BYTES
        || &bytes[..8] != b"TUXLOC1\0"
        || u32::from_le_bytes(
            bytes[24..28]
                .try_into()
                .map_err(|_| "Archive locator is invalid.")?,
        ) != archive_crc32(&bytes[..24])
        || bytes[28..32] != [0; 4]
    {
        return Err("The microphone checkpoint requires a valid published archive locator.".into());
    }
    Ok(ArchiveLocator {
        commit_offset: u64::from_le_bytes(
            bytes[8..16]
                .try_into()
                .map_err(|_| "Archive locator is invalid.")?,
        ),
        generation: u64::from_le_bytes(
            bytes[16..24]
                .try_into()
                .map_err(|_| "Archive locator is invalid.")?,
        ),
    })
}

fn validate_audio_archive_generation(
    bytes: &[u8],
    previous_size: u64,
    generation: u64,
    previous: ArchiveLocator,
) -> Result<(), String> {
    if bytes.len() < ARCHIVE_LOCATOR_BYTES + 64 + 92 {
        return Err("The microphone checkpoint is missing its commit record.".into());
    }
    let locator_offset = bytes.len() - ARCHIVE_LOCATOR_BYTES;
    let locator = decode_archive_locator(&bytes[locator_offset..])?;
    if locator.generation != generation {
        return Err("The microphone checkpoint generation locator does not match.".into());
    }
    let relative_commit_offset = locator
        .commit_offset
        .checked_sub(previous_size)
        .and_then(|offset| usize::try_from(offset).ok())
        .ok_or_else(|| {
            "The microphone checkpoint points outside its appended generation.".to_owned()
        })?;
    if relative_commit_offset % 8 != 0 || relative_commit_offset + 64 > locator_offset {
        return Err("The microphone checkpoint commit offset is invalid.".into());
    }
    let header = &bytes[relative_commit_offset..relative_commit_offset + 64];
    let payload_len = u64::from_le_bytes(
        header[12..20]
            .try_into()
            .map_err(|_| "The microphone checkpoint commit header is invalid.")?,
    );
    let payload_len = usize::try_from(payload_len)
        .map_err(|_| "The microphone checkpoint commit payload is too large.".to_owned())?;
    let payload_end = relative_commit_offset
        .checked_add(64)
        .and_then(|offset| offset.checked_add(payload_len))
        .ok_or_else(|| "The microphone checkpoint commit size is invalid.".to_owned())?;
    let padding_len = (8 - payload_len % 8) % 8;
    let frame_end = payload_end
        .checked_add(padding_len)
        .ok_or_else(|| "The microphone checkpoint commit size is invalid.".to_owned())?;
    if &header[..4] != b"TXRC"
        || u16::from_le_bytes(
            header[4..6]
                .try_into()
                .map_err(|_| "Invalid commit header.")?,
        ) != 251
        || u16::from_le_bytes(
            header[6..8]
                .try_into()
                .map_err(|_| "Invalid commit header.")?,
        ) != 1
        || u32::from_le_bytes(
            header[8..12]
                .try_into()
                .map_err(|_| "Invalid commit header.")?,
        ) != 64
        || header[20..36] != [0; 16]
        || u64::from_le_bytes(
            header[36..44]
                .try_into()
                .map_err(|_| "Invalid commit header.")?,
        ) != generation
        || u64::from_le_bytes(
            header[44..52]
                .try_into()
                .map_err(|_| "Invalid commit header.")?,
        ) != previous.commit_offset
        || header[52] > 1
        || header[53] & !1 != 0
        || header[54..56] != [0; 2]
        || u32::from_le_bytes(
            header[60..64]
                .try_into()
                .map_err(|_| "Invalid commit header.")?,
        ) != archive_crc32(&header[..60])
        || payload_len < 92
        || frame_end != locator_offset
    {
        return Err("The microphone checkpoint commit record is malformed.".into());
    }
    let payload = &bytes[relative_commit_offset + 64..payload_end];
    if u32::from_le_bytes(
        header[56..60]
            .try_into()
            .map_err(|_| "Invalid commit checksum.")?,
    ) != archive_crc32(payload)
        || payload.len() < 92
        || &payload[..4] != b"TXCM"
        || u16::from_le_bytes(
            payload[4..6]
                .try_into()
                .map_err(|_| "Invalid commit payload.")?,
        ) != 1
        || payload[6..8] != [0; 2]
        || u64::from_le_bytes(
            payload[8..16]
                .try_into()
                .map_err(|_| "Invalid commit payload.")?,
        ) != generation
        || u64::from_le_bytes(
            payload[16..24]
                .try_into()
                .map_err(|_| "Invalid commit payload.")?,
        ) != previous.commit_offset
        || bytes[payload_end..frame_end].iter().any(|byte| *byte != 0)
    {
        return Err("The microphone checkpoint commit payload is invalid.".into());
    }
    Ok(())
}

fn archive_crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0_u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

fn verify_audio_archive_append(
    file: &mut File,
    offset: u64,
    expected: &[u8],
) -> Result<(), String> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Could not verify the microphone checkpoint: {error}"))?;
    let mut buffer = Zeroizing::new(vec![0_u8; 64 * 1024]);
    let mut copied = 0;
    while copied < expected.len() {
        let count = (expected.len() - copied).min(buffer.len());
        file.read_exact(&mut buffer[..count])
            .map_err(|error| format!("Could not verify the microphone checkpoint: {error}"))?;
        if buffer[..count] != expected[copied..copied + count] {
            return Err(
                "The microphone checkpoint did not match the bytes written to the archive.".into(),
            );
        }
        copied += count;
    }
    Ok(())
}
