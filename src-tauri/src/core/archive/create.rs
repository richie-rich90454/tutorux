use crate::core::crypto::{envelope_to_record, wrap_data_key, ArchiveDataKey};
use crate::core::error::{err, Result};
use crate::core::format::{
    encode_archive_header, encode_record_frame, encode_record_payload, ArchiveHeader,
    ArchiveRecord, RecordType, CAPABILITY_ENCRYPTED, ZERO_UUID,
};
use crate::core::index::{build_index_tree, encode_index_page, primary_index_key, IndexPage};
use std::collections::BTreeMap;

use super::commit::{encode_commit_payload, encode_locator};
use super::support::{new_uuid, sha256};

pub fn create_archive_bytes(
    display_name: &str,
    description: &str,
    created_at_us: u64,
) -> Result<Vec<u8>> {
    if display_name.trim().is_empty() {
        return err("archive_name_invalid", "Archive name must not be empty.");
    }
    let header = ArchiveHeader {
        id: new_uuid(),
        major_version: 1,
        minor_version: 0,
        created_at_us,
        capabilities: 0,
    };
    let encoded_header = encode_archive_header(&header);
    let empty_root_payload = encode_index_page(&IndexPage {
        leaf: true,
        entries: Vec::new(),
        separators: Vec::new(),
        children: Vec::new(),
    })?;
    let empty_root = encode_record_frame(
        RecordType::INDEX_PAGE,
        ZERO_UUID,
        1,
        0,
        &empty_root_payload,
        0,
        0,
    )?;
    let manifest = create_manifest(&header, display_name, description, created_at_us);
    let manifest_offset = crate::core::format::ARCHIVE_HEADER_SIZE + empty_root.len() as u64;
    let manifest_payload = encode_record_payload(&manifest)?;
    let manifest_frame = encode_record_frame(
        manifest.record_type,
        &manifest.id,
        manifest.revision,
        manifest.previous_offset,
        &manifest_payload,
        0,
        0,
    )?;
    let root_payload = encode_index_page(&IndexPage {
        leaf: true,
        entries: vec![(
            primary_index_key(RecordType::SETTINGS, &header.id),
            manifest_offset,
        )],
        separators: Vec::new(),
        children: Vec::new(),
    })?;
    let root_offset = manifest_offset + manifest_frame.len() as u64;
    let root_frame =
        encode_record_frame(RecordType::INDEX_PAGE, ZERO_UUID, 1, 0, &root_payload, 0, 0)?;
    let root_hash = sha256(&root_payload);
    let commit_offset = root_offset + root_frame.len() as u64;
    let commit_payload = encode_commit_payload(1, 0, root_offset, &root_hash, &new_uuid(), 1);
    let commit_frame =
        encode_record_frame(RecordType::COMMIT, ZERO_UUID, 1, 0, &commit_payload, 0, 0)?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&encoded_header);
    bytes.extend_from_slice(&empty_root);
    bytes.extend_from_slice(&manifest_frame);
    bytes.extend_from_slice(&root_frame);
    bytes.extend_from_slice(&commit_frame);
    bytes.extend_from_slice(&encode_locator(commit_offset, 1));
    Ok(bytes)
}

pub fn create_encrypted_archive_bytes(
    display_name: &str,
    description: &str,
    passphrase: &str,
    created_at_us: u64,
) -> Result<Vec<u8>> {
    if display_name.trim().is_empty() {
        return err("archive_name_invalid", "Archive name must not be empty.");
    }
    let header = ArchiveHeader {
        id: new_uuid(),
        major_version: 1,
        minor_version: 0,
        created_at_us,
        capabilities: CAPABILITY_ENCRYPTED,
    };
    let encoded_header = encode_archive_header(&header);
    let data_key = ArchiveDataKey::create_random();
    let envelope = wrap_data_key(passphrase, &data_key, &header.id)?;
    let empty_root_body = encode_index_page(&IndexPage {
        leaf: true,
        entries: Vec::new(),
        separators: Vec::new(),
        children: Vec::new(),
    })?;
    let mut empty_root_payload = empty_root_body.clone();
    empty_root_payload
        .extend_from_slice(&data_key.authenticate_bytes("TUTORUX-INDEX-PAGE-V1", &empty_root_body));
    let empty_root = encode_record_frame(
        RecordType::INDEX_PAGE,
        ZERO_UUID,
        1,
        0,
        &empty_root_payload,
        0,
        0,
    )?;
    let encryption_record = envelope_to_record(&envelope, &header.id)?;
    let encryption_payload = encode_record_payload(&encryption_record)?;
    let encryption_frame = encode_record_frame(
        encryption_record.record_type,
        &encryption_record.id,
        encryption_record.revision,
        encryption_record.previous_offset,
        &encryption_payload,
        0,
        0,
    )?;
    let mut manifest = create_manifest(&header, display_name, description, created_at_us);
    let manifest_authentication =
        data_key.authenticate_bytes("TUTORUX-MANIFEST-V1", &encode_record_payload(&manifest)?);
    manifest.fields.insert(
        "manifest_auth".to_owned(),
        manifest_authentication
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    );
    let manifest_payload = encode_record_payload(&manifest)?;
    let manifest_frame = encode_record_frame(
        manifest.record_type,
        &manifest.id,
        manifest.revision,
        manifest.previous_offset,
        &manifest_payload,
        0,
        0,
    )?;
    let encryption_offset = crate::core::format::ARCHIVE_HEADER_SIZE + empty_root.len() as u64;
    let manifest_offset = encryption_offset + encryption_frame.len() as u64;
    let root_offset = manifest_offset + manifest_frame.len() as u64;
    let mut entries: Vec<(String, u64)> = vec![
        (
            primary_index_key(RecordType::ENCRYPTION, &header.id),
            encryption_offset,
        ),
        (
            primary_index_key(RecordType::SETTINGS, &header.id),
            manifest_offset,
        ),
    ];
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let tree = build_index_tree(
        &entries,
        root_offset,
        Some(&|payload| data_key.authenticate_bytes("TUTORUX-INDEX-PAGE-V1", payload)),
    )?;
    let transaction_id = new_uuid();
    let commit_body = encode_commit_payload(
        1,
        0,
        tree.root_offset,
        &sha256(&tree.root_payload),
        &transaction_id,
        2,
    );
    let mut commit_payload = commit_body.clone();
    commit_payload
        .extend_from_slice(&data_key.authenticate_bytes("TUTORUX-COMMIT-V1", &commit_body));
    let commit_offset = tree.end_offset;
    let commit_frame =
        encode_record_frame(RecordType::COMMIT, ZERO_UUID, 1, 0, &commit_payload, 0, 0)?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&encoded_header);
    bytes.extend_from_slice(&empty_root);
    bytes.extend_from_slice(&encryption_frame);
    bytes.extend_from_slice(&manifest_frame);
    for frame in &tree.frames {
        bytes.extend_from_slice(frame);
    }
    bytes.extend_from_slice(&commit_frame);
    bytes.extend_from_slice(&encode_locator(commit_offset, 1));
    Ok(bytes)
}

fn create_manifest(
    header: &ArchiveHeader,
    display_name: &str,
    description: &str,
    created_at_us: u64,
) -> ArchiveRecord {
    ArchiveRecord {
        record_type: RecordType::SETTINGS,
        id: header.id.clone(),
        revision: 1,
        previous_offset: 0,
        fields: BTreeMap::from([
            ("record_role".to_owned(), "archive-manifest".to_owned()),
            ("display_name".to_owned(), display_name.to_owned()),
            ("description".to_owned(), description.to_owned()),
            ("student_count".to_owned(), "0".to_owned()),
            ("session_count".to_owned(), "0".to_owned()),
            ("created_at_us".to_owned(), created_at_us.to_string()),
        ]),
        blob: Vec::new(),
    }
}
