use super::helpers::hex_encode;
use super::*;
use crate::core::archive::{
    create_archive_bytes, create_encrypted_archive_bytes, new_uuid, sha256, ArchiveSnapshot,
};
use crate::core::format::ArchiveRecord;
use crate::core::format::RecordType;

macro_rules! fields {
        ($($key:expr => $value:expr),* $(,)?) => {
            vec![$(($key.to_string(), $value.to_string())),*]
        };
    }

fn record(record_type: u16, id: &str, fields: Vec<(String, String)>) -> ArchiveRecord {
    ArchiveRecord::new(record_type, id, fields)
}

fn all_domain_records() -> Vec<ArchiveRecord> {
    let student = new_uuid();
    let session = new_uuid();
    let track = new_uuid();
    let chunk = new_uuid();
    let transcript = new_uuid();
    let annotation = new_uuid();
    let asset_blob = new_uuid();
    let asset = new_uuid();
    let evidence_node = new_uuid();
    let evidence_edge = new_uuid();
    let guide = new_uuid();
    let job = new_uuid();
    let waveform = new_uuid();
    let content = [1u8, 2, 3, 4, 5];
    let content_hash = hex_encode(&sha256(&content));
    vec![
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
        record(
            RecordType::AUDIO_CHUNK,
            &chunk,
            fields! {
                "session_id" => session,
                "track_id" => track,
                "sequence_number" => "0",
                "codec" => "none"
            },
        ),
        record(
            RecordType::TRANSCRIPT_SEGMENT,
            &transcript,
            fields! {
                "session_id" => session,
                "start_time_us" => "0",
                "end_time_us" => "1000",
                "text" => "Hello"
            },
        ),
        record(
            RecordType::ANNOTATION,
            &annotation,
            fields! {"session_id" => session, "start_time_us" => "10", "text" => "Note"},
        ),
        ArchiveRecord {
            record_type: RecordType::ASSET_BLOB,
            id: asset_blob.clone(),
            revision: 0,
            previous_offset: 0,
            fields: BTreeMap::new(),
            blob: content.to_vec(),
        },
        record(
            RecordType::ASSET_METADATA,
            &asset,
            fields! {
                "session_id" => session,
                "record_role" => "material",
                "blob_id" => asset_blob,
                "byte_size" => content.len(),
                "content_hash" => content_hash
            },
        ),
        record(
            RecordType::EVIDENCE_NODE,
            &evidence_node,
            fields! {"session_id" => session, "kind" => "observation"},
        ),
        record(
            RecordType::EVIDENCE_EDGE,
            &evidence_edge,
            fields! {"from_id" => evidence_node, "to_id" => evidence_node},
        ),
        record(
            RecordType::GUIDE,
            &guide,
            fields! {
                "title" => "Guide",
                "session_id" => session,
                "section_count" => "1",
                "section.0.heading" => "Evidence",
                "section.0.block_count" => "1",
                "section.0.block.0.kind" => "paragraph",
                "section.0.block.0.text" => "Mina used a number line.",
                "section.0.block.0.source_ids" => session
            },
        ),
        record(
            RecordType::AI_JOB,
            &job,
            fields! {"session_id" => session, "status" => "complete"},
        ),
        record(
            RecordType::WAVEFORM_INDEX,
            &waveform,
            fields! {"session_id" => session, "track_id" => track},
        ),
    ]
}

#[test]
fn full_verification_accepts_every_domain_type() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("All types", "", 1).unwrap()).unwrap();
    let archive = archive.append_records(&all_domain_records()).unwrap();
    let report = verify_full(&archive).unwrap();
    assert!(report.valid, "{:?}", report.issues);
    assert_eq!(report.generation, 2);
    assert_eq!(report.live_records, 13);
    let history = verify_history(&archive).unwrap();
    assert_eq!(history.verified_commits, 2);
    assert_eq!(history.historical_revisions, 1);
}

#[test]
fn full_verification_reports_dangling_references() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Dangling", "", 1).unwrap()).unwrap();
    let student = new_uuid();
    let missing_from = new_uuid();
    let missing_to = new_uuid();
    let missing_blob = new_uuid();
    let archive = archive
        .append_records(&[
            record(
                RecordType::SESSION,
                &new_uuid(),
                fields! {"student_id" => student, "title" => "Missing student"},
            ),
            record(
                RecordType::EVIDENCE_EDGE,
                &new_uuid(),
                fields! {"from_id" => missing_from, "to_id" => missing_to},
            ),
            record(
                RecordType::ASSET_METADATA,
                &new_uuid(),
                fields! {
                    "record_role" => "material",
                    "blob_id" => missing_blob,
                    "byte_size" => "0",
                    "content_hash" => "0".repeat(64)
                },
            ),
        ])
        .unwrap();
    let report = verify_full(&archive).unwrap();
    assert!(!report.valid);
    let joined = report.issues.join("\n");
    assert!(joined.contains("missing student"), "{joined}");
    assert!(joined.contains("missing node"), "{joined}");
    assert!(joined.contains("missing blob"), "{joined}");
    assert!(report.records_checked > 0);
    assert!(report.index_pages_checked > 0);
}

#[test]
fn full_verification_checks_asset_manifest_content() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Assets", "", 1).unwrap()).unwrap();
    let manifest_id = new_uuid();
    let chunk_one = new_uuid();
    let chunk_two = new_uuid();
    let metadata = new_uuid();
    let content = [9u8, 8, 7, 6];
    let digest = hex_encode(&sha256(&content));
    let archive = archive
        .append_records(&[
            ArchiveRecord {
                record_type: RecordType::ASSET_BLOB,
                id: chunk_one.clone(),
                revision: 0,
                previous_offset: 0,
                fields: fields! {
                    "record_role" => "asset-blob-chunk",
                    "manifest_id" => manifest_id,
                    "chunk_index" => "0"
                }
                .into_iter()
                .collect(),
                blob: content[..2].to_vec(),
            },
            ArchiveRecord {
                record_type: RecordType::ASSET_BLOB,
                id: chunk_two.clone(),
                revision: 0,
                previous_offset: 0,
                fields: fields! {
                    "record_role" => "asset-blob-chunk",
                    "manifest_id" => manifest_id,
                    "chunk_index" => "1"
                }
                .into_iter()
                .collect(),
                blob: content[2..].to_vec(),
            },
            record(
                RecordType::ASSET_BLOB,
                &manifest_id,
                fields! {
                    "record_role" => "asset-blob-manifest",
                    "chunk_count" => "2",
                    "chunk_ids" => format!("{chunk_one},{chunk_two}")
                },
            ),
            record(
                RecordType::ASSET_METADATA,
                &metadata,
                fields! {
                    "record_role" => "material",
                    "blob_id" => manifest_id,
                    "byte_size" => content.len(),
                    "content_hash" => digest
                },
            ),
        ])
        .unwrap();
    let report = verify_full(&archive).unwrap();
    assert!(report.valid, "{:?}", report.issues);

    let tampered = archive
        .append_records(&[record(
            RecordType::ASSET_METADATA,
            &metadata,
            fields! {
                "record_role" => "material",
                "blob_id" => manifest_id,
                "byte_size" => content.len(),
                "content_hash" => "0".repeat(64)
            },
        )])
        .unwrap();
    let report = verify_full(&tampered).unwrap();
    assert!(!report.valid);
    assert!(report.issues.join("\n").contains("does not match its hash"));
}

#[test]
fn full_verification_reports_locked_archives() {
    let locked = ArchiveSnapshot::open_bytes(
        create_encrypted_archive_bytes("Locked", "", "correct horse battery staple", 1).unwrap(),
    )
    .unwrap();
    let report = verify_full(&locked).unwrap();
    assert!(!report.valid);
    assert!(report.issues[0].contains("Unlock"));
}

#[test]
fn verifies_typescript_fixture_fully() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("encrypted-v1.tux");
    let bytes = std::fs::read(path).expect("fixture exists");
    let locked = ArchiveSnapshot::open_bytes(bytes).expect("fixture opens");
    let unlocked = locked
        .unlock("Tutorux cross-language fixture phrase 2026")
        .expect("fixture unlocks");
    let report = verify_full(&unlocked).unwrap();
    assert!(report.valid, "{:?}", report.issues);
}
