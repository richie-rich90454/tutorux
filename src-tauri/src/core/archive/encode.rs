use crate::core::crypto::{ArchiveDataKey, RecordEncryptionContext};
use crate::core::error::{CoreError, Result};
use crate::core::format::{
    compress_record_payload, encode_record_frame, encode_record_payload, ArchiveHeader,
    ArchiveRecord, RecordType, CAPABILITY_ENCRYPTED,
};

pub fn encode_record_for_write(
    header: &ArchiveHeader,
    data_key: Option<&ArchiveDataKey>,
    record: &ArchiveRecord,
) -> Result<Vec<u8>> {
    let encrypted = header.capabilities & CAPABILITY_ENCRYPTED != 0;
    let is_metadata = record.id.eq_ignore_ascii_case(&header.id);
    let is_manifest = record.record_type == RecordType::SETTINGS && is_metadata;
    let is_encryption_metadata = record.record_type == RecordType::ENCRYPTION && is_metadata;
    let mut record_to_write = record.clone();
    if encrypted && is_manifest {
        let key = data_key.ok_or_else(|| {
            CoreError::new("archive_locked", "Unlock this archive before editing it.")
        })?;
        record_to_write.fields.remove("manifest_auth");
        let unsigned_payload = encode_record_payload(&record_to_write)?;
        let authentication = key.authenticate_bytes("TUTORUX-MANIFEST-V1", &unsigned_payload);
        record_to_write.fields.insert(
            "manifest_auth".to_owned(),
            authentication
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        );
    }
    let payload = encode_record_payload(&record_to_write)?;
    let can_compress = record_to_write.record_type != RecordType::ASSET_BLOB
        && (record_to_write.record_type != RecordType::AUDIO_CHUNK
            || record_to_write.field("codec") == Some("none"));
    let (codec, encoded_payload) = if can_compress {
        compress_record_payload(&payload)?
    } else {
        (0, payload)
    };
    let protect = encrypted && !is_manifest && !is_encryption_metadata;
    let (stored_payload, flags) = if protect {
        let key = data_key.ok_or_else(|| {
            CoreError::new("archive_locked", "Unlock this archive before editing it.")
        })?;
        (
            key.encrypt_record_payload(
                &encoded_payload,
                &RecordEncryptionContext {
                    archive_id: &header.id,
                    record_type: record_to_write.record_type,
                    record_id: &record_to_write.id,
                    revision: record_to_write.revision,
                    previous_offset: record_to_write.previous_offset,
                    codec,
                },
            )?,
            1,
        )
    } else {
        (encoded_payload, 0)
    };
    encode_record_frame(
        record_to_write.record_type,
        &record_to_write.id,
        record_to_write.revision,
        record_to_write.previous_offset,
        &stored_payload,
        codec,
        flags,
    )
}
