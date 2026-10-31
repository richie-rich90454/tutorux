use std::sync::Arc;

use crate::core::archive::ArchiveSnapshot;
use crate::core::error::{err, CoreError, Result};
use crate::core::format::{
    crc32, decode_archive_header, ArchiveRecord, RecordType, ARCHIVE_HEADER_SIZE,
};
use crate::core::source::ByteSource;

struct SuffixSource {
    source: Arc<dyn ByteSource>,
    start: u64,
    size: u64,
}

impl SuffixSource {
    fn new(source: Arc<dyn ByteSource>, start: u64) -> Result<Self> {
        if start > source.size() {
            return err(
                "archive_header_recovery_unavailable",
                "The archive suffix starts beyond the source.",
            );
        }
        let size = source.size() - start;
        Ok(Self {
            source,
            start,
            size,
        })
    }
}

impl ByteSource for SuffixSource {
    fn size(&self) -> u64 {
        self.size
    }

    fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>> {
        if offset > self.size || length as u64 > self.size - offset {
            return err(
                "archive_read_out_of_bounds",
                "Archive read is outside the source bounds.",
            );
        }
        self.source.read(self.start + offset, length)
    }
}

pub fn recover_checksum_damaged_archive_header(
    source: Arc<dyn ByteSource>,
    passphrase: Option<&str>,
) -> Result<ArchiveSnapshot> {
    let original = read_header(source.as_ref())?;
    let mut corrected = original.clone();
    let checksum = crc32(&corrected[..60]);
    let stored = u32::from_le_bytes([corrected[60], corrected[61], corrected[62], corrected[63]]);
    if stored == checksum {
        return err(
            "archive_header_recovery_unavailable",
            "The header checksum is valid; checksum repair is not applicable.",
        );
    }
    corrected[60..64].copy_from_slice(&checksum.to_le_bytes());
    verify_recovered_archive_header(source, corrected, passphrase)
}

pub fn recover_magic_damaged_archive_header(
    source: Arc<dyn ByteSource>,
    passphrase: Option<&str>,
) -> Result<ArchiveSnapshot> {
    let original = read_header(source.as_ref())?;
    if &original[..8] == b"TUTORUX\0" {
        return err(
            "archive_header_recovery_unavailable",
            "The archive magic is intact; magic repair is not applicable.",
        );
    }
    let mut corrected = original.clone();
    corrected[..8].copy_from_slice(b"TUTORUX\0");
    let stored = u32::from_le_bytes([corrected[60], corrected[61], corrected[62], corrected[63]]);
    if stored != crc32(&corrected[..60]) {
        return err(
            "archive_header_recovery_unavailable",
            "The stored checksum does not confirm the reconstructed archive magic.",
        );
    }
    verify_recovered_archive_header(source, corrected, passphrase)
}

fn read_header(source: &dyn ByteSource) -> Result<Vec<u8>> {
    if source.size() < ARCHIVE_HEADER_SIZE {
        return err(
            "archive_header_recovery_unavailable",
            "A complete archive header is required for header repair.",
        );
    }
    let bytes = source.read(0, ARCHIVE_HEADER_SIZE as usize)?;
    if bytes.len() != ARCHIVE_HEADER_SIZE as usize {
        return err(
            "archive_header_recovery_unavailable",
            "The archive header could not be read completely.",
        );
    }
    Ok(bytes)
}

fn verify_recovered_archive_header(
    source: Arc<dyn ByteSource>,
    corrected: Vec<u8>,
    passphrase: Option<&str>,
) -> Result<ArchiveSnapshot> {
    let header = decode_archive_header(&corrected)?;
    let repaired_source: Arc<dyn ByteSource> = Arc::new(crate::core::source::CompositeSource::new(
        Arc::new(crate::core::source::MemorySource::new(corrected)),
        Arc::new(SuffixSource::new(source, ARCHIVE_HEADER_SIZE)?),
    ));
    let mut opened = ArchiveSnapshot::open(repaired_source)?;
    if opened.encrypted() {
        let passphrase = passphrase.ok_or_else(|| {
            CoreError::new(
                "archive_locked",
                "Provide the passphrase to verify a repaired encrypted header.",
            )
        })?;
        opened = opened.unlock(passphrase)?;
    }
    opened.verify()?;
    let manifest = opened.get_record(RecordType::SETTINGS, &header.id)?;
    if !valid_manifest(manifest.as_ref(), &header) {
        return err(
            "archive_header_recovery_unverified",
            "The header identity and creation time do not match the verified archive manifest.",
        );
    }
    Ok(opened)
}

fn valid_manifest(
    manifest: Option<&ArchiveRecord>,
    header: &crate::core::format::ArchiveHeader,
) -> bool {
    match manifest {
        Some(manifest) => {
            manifest.field("_deleted") != Some("true")
                && manifest.field("record_role") == Some("archive-manifest")
                && manifest.field("created_at_us")
                    == Some(header.created_at_us.to_string().as_str())
        }
        None => false,
    }
}
