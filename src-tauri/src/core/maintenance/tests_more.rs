use crate::core::archive::{
    create_archive_bytes, create_encrypted_archive_bytes, new_uuid, verify_full, ArchiveRecord,
    ArchiveSnapshot, RecordType,
};
use crate::core::format::ArchiveRecord as FormatRecord;
use crate::core::maintenance::{
    backfill_archive_secondary_indexes, compact_archive_with_options, inspect_recovery_source,
    plan_trash_purge, purge_trashed_archive_snapshot, recover_checksum_damaged_archive_header,
    recover_magic_damaged_archive_header, CompactionOptions,
};
use crate::core::source::MemorySource;
use std::sync::Arc;

macro_rules! fields {
    ($($key:expr => $value:expr),* $(,)?) => {
        vec![$(($key.to_string(), $value.to_string())),*]
    };
}

fn record(record_type: u16, id: &str, fields: Vec<(String, String)>) -> FormatRecord {
    ArchiveRecord::new(record_type, id, fields)
}

fn with_blob(mut record: FormatRecord, blob: Vec<u8>) -> FormatRecord {
    record.blob = blob;
    record
}

#[test]
fn trash_plan_and_purge_remove_deleted_records() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Trash", "", 1).unwrap()).unwrap();
    let student_a = new_uuid();
    let student_b = new_uuid();
    let with_students = archive
        .append_records(&[
            record(
                RecordType::STUDENT,
                &student_a,
                fields! {"display_name" => "Amina"},
            ),
            record(
                RecordType::STUDENT,
                &student_b,
                fields! {"display_name" => "Ben"},
            ),
        ])
        .unwrap();
    let deleted = with_students
        .append_records(&[record(
            RecordType::STUDENT,
            &student_b,
            fields! {"display_name" => "Ben", "_deleted" => "true"},
        )])
        .unwrap();
    let plan = plan_trash_purge(&deleted).unwrap();
    assert_eq!(plan.deleted_records, 1);
    assert!(plan.blockers.is_empty());
    let result = purge_trashed_archive_snapshot(&deleted).unwrap();
    assert_eq!(result.purge_removed_records, 1);
    let reopened = ArchiveSnapshot::open_bytes(result.bytes).unwrap();
    assert!(reopened
        .get_record(RecordType::STUDENT, &student_b)
        .unwrap()
        .is_none());
    assert!(reopened
        .get_record(RecordType::STUDENT, &student_a)
        .unwrap()
        .is_some());
    assert!(verify_full(&reopened).unwrap().valid);
}

#[test]
fn trash_plan_reports_active_references_as_blockers() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Trash block", "", 1).unwrap()).unwrap();
    let student = new_uuid();
    let session = new_uuid();
    let with_session = archive
        .append_records(&[
            record(
                RecordType::STUDENT,
                &student,
                fields! {"display_name" => "Mina"},
            ),
            record(
                RecordType::SESSION,
                &session,
                fields! {"student_id" => student, "title" => "Algebra"},
            ),
        ])
        .unwrap();
    let deleted = with_session
        .append_records(&[record(
            RecordType::STUDENT,
            &student,
            fields! {"display_name" => "Mina", "_deleted" => "true"},
        )])
        .unwrap();
    let plan = plan_trash_purge(&deleted).unwrap();
    assert_eq!(plan.deleted_records, 1);
    assert_eq!(plan.blockers.len(), 1);
    assert_eq!(plan.blockers[0].record_id, student);
    assert!(!plan.blockers[0].references.is_empty());
    let error = purge_trashed_archive_snapshot(&deleted).unwrap_err();
    assert_eq!(error.code, "trash_purge_reference_blocked");
}

#[test]
fn repairs_checksum_and_magic_damaged_headers() {
    let bytes = create_archive_bytes("Header repair", "", 1).unwrap();
    let mut checksum_damaged = bytes.clone();
    checksum_damaged[62] ^= 0xff;
    let error = ArchiveSnapshot::open_bytes(checksum_damaged.clone()).unwrap_err();
    assert_eq!(error.code, "archive_header_checksum");
    let recovered = recover_checksum_damaged_archive_header(
        Arc::new(MemorySource::new(checksum_damaged.clone())),
        None,
    )
    .unwrap();
    assert_eq!(
        recovered.get_manifest().unwrap().display_name,
        "Header repair"
    );
    assert_eq!(checksum_damaged[62], bytes[62] ^ 0xff);

    let mut magic_damaged = bytes.clone();
    magic_damaged[0] ^= 0xff;
    let error = ArchiveSnapshot::open_bytes(magic_damaged.clone()).unwrap_err();
    assert_eq!(error.code, "archive_magic_invalid");
    let recovered =
        recover_magic_damaged_archive_header(Arc::new(MemorySource::new(magic_damaged)), None)
            .unwrap();
    assert_eq!(
        recovered.get_manifest().unwrap().display_name,
        "Header repair"
    );

    let inspection = inspect_recovery_source(
        Arc::new(MemorySource::new({
            let mut damaged = bytes.clone();
            damaged[0] ^= 0xff;
            damaged
        })),
        None,
    )
    .unwrap();
    assert!(!inspection.archive_header_valid);
    assert!(inspection.header_repair_candidate);
    assert!(inspection.header_repair_available);
    assert_eq!(inspection.header_repair_generation, 1);
}

#[test]
fn repairs_encrypted_header_with_passphrase() {
    let passphrase = "a sufficiently long passphrase";
    let bytes = create_encrypted_archive_bytes("Encrypted repair", "", passphrase, 1).unwrap();
    let mut damaged = bytes;
    damaged[62] ^= 0xff;
    let error =
        recover_checksum_damaged_archive_header(Arc::new(MemorySource::new(damaged.clone())), None)
            .unwrap_err();
    assert_eq!(error.code, "archive_locked");
    let recovered = recover_checksum_damaged_archive_header(
        Arc::new(MemorySource::new(damaged)),
        Some(passphrase),
    )
    .unwrap();
    assert!(!recovered.locked());
    assert_eq!(
        recovered.get_manifest().unwrap().display_name,
        "Encrypted repair"
    );
}

fn referenced_asset_records() -> (Vec<FormatRecord>, String, String) {
    let manifest = new_uuid();
    let chunk = new_uuid();
    let metadata = new_uuid();
    let content = [9u8, 8, 7, 6];
    let digest = crate::core::archive::sha256(&content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    (
        vec![
            with_blob(
                record(
                    RecordType::ASSET_BLOB,
                    &chunk,
                    fields! {
                        "record_role" => "asset-blob-chunk",
                        "manifest_id" => manifest,
                        "chunk_index" => "0"
                    },
                ),
                content.to_vec(),
            ),
            with_blob(
                record(
                    RecordType::ASSET_BLOB,
                    &manifest,
                    fields! {
                        "record_role" => "asset-blob-manifest",
                        "chunk_count" => "1",
                        "chunk_ids" => chunk
                    },
                ),
                Vec::new(),
            ),
            record(
                RecordType::ASSET_METADATA,
                &metadata,
                fields! {
                    "record_role" => "material",
                    "blob_id" => manifest,
                    "byte_size" => content.len(),
                    "content_hash" => digest
                },
            ),
        ],
        manifest,
        chunk,
    )
}

#[test]
fn compaction_prunes_unreferenced_asset_chains() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Prune", "", 1).unwrap()).unwrap();
    let (mut records, manifest, chunk) = referenced_asset_records();
    let orphan_manifest = new_uuid();
    let orphan_chunk = new_uuid();
    records.push(with_blob(
        record(
            RecordType::ASSET_BLOB,
            &orphan_chunk,
            fields! {"record_role" => "asset-blob-chunk", "manifest_id" => orphan_manifest, "chunk_index" => "0"},
        ),
        vec![1, 2],
    ));
    records.push(with_blob(
        record(
            RecordType::ASSET_BLOB,
            &orphan_manifest,
            fields! {"record_role" => "asset-blob-manifest", "chunk_count" => "1", "chunk_ids" => orphan_chunk},
        ),
        Vec::new(),
    ));
    let archive = archive.append_records(&records).unwrap();
    assert!(verify_full(&archive).unwrap().valid);
    let result = compact_archive_with_options(
        &archive,
        &CompactionOptions {
            prune_unreferenced_assets: true,
            purge_deleted_records: false,
        },
    )
    .unwrap();
    assert_eq!(result.pruned_asset_records, 2);
    let compacted = ArchiveSnapshot::open_bytes(result.bytes).unwrap();
    assert!(compacted
        .get_record(RecordType::ASSET_BLOB, &manifest)
        .unwrap()
        .is_some());
    assert!(compacted
        .get_record(RecordType::ASSET_BLOB, &chunk)
        .unwrap()
        .is_some());
    assert!(compacted
        .get_record(RecordType::ASSET_BLOB, &orphan_manifest)
        .unwrap()
        .is_none());
    assert!(compacted
        .get_record(RecordType::ASSET_BLOB, &orphan_chunk)
        .unwrap()
        .is_none());
    assert!(verify_full(&compacted).unwrap().valid);
}

#[test]
fn compaction_refuses_pruning_with_unknown_records() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Prune unknown", "", 1).unwrap()).unwrap();
    let archive = archive
        .append_records(&[record(99, &new_uuid(), fields! {"extension" => "opaque"})])
        .unwrap();
    let error = compact_archive_with_options(
        &archive,
        &CompactionOptions {
            prune_unreferenced_assets: true,
            purge_deleted_records: false,
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "archive_pruning_unknown_records");
}

#[test]
fn backfill_adds_missing_secondary_aliases() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Backfill add", "", 1).unwrap()).unwrap();
    let student = new_uuid();
    let session = new_uuid();
    let archive = archive
        .append_records(&[
            record(
                RecordType::STUDENT,
                &student,
                fields! {"display_name" => "Mina"},
            ),
            record(
                RecordType::SESSION,
                &session,
                fields! {"student_id" => student, "title" => "Algebra"},
            ),
        ])
        .unwrap();
    let alias = format!("STUDENTSESSION:{student}:{session}");
    let mut without_alias = archive.clone();
    without_alias.index.remove(&alias);
    let result = backfill_archive_secondary_indexes(&without_alias).unwrap();
    assert_eq!(result.added_entries, 1);
    assert_eq!(result.conflicting_entries, 0);
    assert!(result.snapshot.all_index_entries().contains_key(&alias));
    assert_eq!(
        result.snapshot.commit.generation,
        archive.commit.generation + 1
    );
    assert!(verify_full(&result.snapshot).unwrap().valid);
}

#[test]
fn backfill_reports_added_conflicting_and_version_state() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Backfill", "", 1).unwrap()).unwrap();
    let content_hash = "a".repeat(64);
    let archive = archive
        .append_records(&[
            record(
                RecordType::ASSET_BLOB,
                &new_uuid(),
                fields! {"content_hash" => content_hash},
            ),
            record(
                RecordType::ASSET_BLOB,
                &new_uuid(),
                fields! {"content_hash" => content_hash},
            ),
        ])
        .unwrap();
    let result = backfill_archive_secondary_indexes(&archive).unwrap();
    assert_eq!(result.added_entries, 0);
    assert_eq!(result.conflicting_entries, 1);
    assert!(!result.schema_versions_updated);
    assert_eq!(result.snapshot.commit.generation, archive.commit.generation);
}
