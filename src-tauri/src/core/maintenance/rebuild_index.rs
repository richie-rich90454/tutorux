use std::collections::BTreeMap;
use std::sync::Arc;

use crate::core::error::{err, CoreError, Result};
use crate::core::format::{decode_archive_header, ArchiveRecord, RecordType};
use crate::core::index::read_frame_at;
use crate::core::source::ByteSource;

use super::rebuild::rebuild_archive;

pub fn rebuild_damaged_primary_index(source: Arc<dyn ByteSource>) -> Result<Vec<u8>> {
    let header = decode_archive_header(&source.read(0, 64)?)?;
    if header.capabilities & crate::core::format::CAPABILITY_ENCRYPTED != 0 {
        return err(
            "archive_index_repair_encrypted",
            "Rebuilding a damaged encrypted index is not supported.",
        );
    }
    let mut records: BTreeMap<(u16, String, u64), ArchiveRecord> = BTreeMap::new();
    let mut offset = 64u64;
    while offset + 64 <= source.size() {
        let frame = match read_frame_at(source.as_ref(), offset) {
            Ok(frame) => frame,
            Err(_) => {
                offset += 8;
                continue;
            }
        };
        let record_type = frame.record_type;
        if record_type != RecordType::INDEX_PAGE
            && record_type != RecordType::COMMIT
            && record_type != RecordType::ENCRYPTION
        {
            if crate::core::format::record_type_name(record_type) == "unknown" {
                return err(
                    "archive_index_repair_unknown",
                    "Archive contains unknown records whose indexes cannot be reconstructed safely.",
                );
            }
            if let Ok(record) = decode_frame_for_rebuild(&frame) {
                records.insert(
                    (record_type, record.id.to_lowercase(), record.revision),
                    record,
                );
            }
        }
        offset = frame.end_offset;
    }
    let manifest = records
        .values()
        .find(|record| {
            record.record_type == RecordType::SETTINGS
                && record.id.eq_ignore_ascii_case(&header.id)
                && record.field("record_role") == Some("archive-manifest")
        })
        .cloned()
        .ok_or_else(|| {
            CoreError::new(
                "archive_manifest_missing",
                "Archive manifest is missing or invalid.",
            )
        })?;
    let expected_created_at = header.created_at_us.to_string();
    if manifest.field("_deleted") == Some("true")
        || manifest.field("created_at_us") != Some(expected_created_at.as_str())
    {
        return err(
            "archive_index_repair_manifest",
            "The archive identity does not match its retained manifest.",
        );
    }
    let records: Vec<ArchiveRecord> = records.into_values().collect();
    rebuild_archive(&header, manifest, records, None, None)
}

fn decode_frame_for_rebuild(frame: &crate::core::format::RecordFrame) -> Result<ArchiveRecord> {
    if frame.flags & 1 != 0 {
        return err(
            "archive_locked",
            "Unlock this archive before rebuilding its primary index.",
        );
    }
    let payload = crate::core::format::decode_stored_payload(
        frame.codec,
        frame.flags,
        &frame.stored_payload,
    )?;
    crate::core::format::decode_record_payload(
        frame.record_type,
        &frame.id,
        frame.revision,
        frame.previous_offset,
        &payload,
    )
}
