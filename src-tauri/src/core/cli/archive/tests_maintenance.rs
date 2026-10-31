use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::core::archive::{
    create_archive_bytes, new_uuid, now_us, verify_full, ArchiveSnapshot,
};
use crate::core::cli::{
    parse_arguments, CliContext, CliOutput, CliResult, Failure, ParsedArguments,
};
use crate::core::format::{ArchiveRecord, RecordType};

#[derive(Default)]
struct Output {
    stdout: Vec<String>,
    stderr: Vec<String>,
}

impl CliOutput for Output {
    fn stdout(&mut self, message: &str) {
        self.stdout.push(message.to_owned());
    }

    fn stderr(&mut self, message: &str) {
        self.stderr.push(message.to_owned());
    }
}

impl Output {
    fn json(&self) -> Value {
        serde_json::from_str(self.stdout.last().expect("stdout is empty"))
            .expect("stdout is not JSON")
    }
}

fn arguments(values: &[&str]) -> ParsedArguments {
    let raw: Vec<String> = values.iter().map(|value| (*value).to_owned()).collect();
    match parse_arguments(&raw) {
        Ok(parsed) => parsed,
        Err(Failure::Usage(message)) => panic!("could not parse test arguments: {message}"),
        Err(Failure::Core(error)) => panic!("could not parse test arguments: {}", error.message),
    }
}

fn context() -> CliContext {
    CliContext {
        passphrase: None,
        archive_path: None,
    }
}

fn run(action: &str, args: ParsedArguments, output: &mut Output) -> CliResult<i32> {
    super::run_archive_command(action, args, output, &context())
}

fn expect_ok(result: CliResult<i32>) -> i32 {
    match result {
        Ok(code) => code,
        Err(Failure::Usage(message)) => panic!("unexpected usage error: {message}"),
        Err(Failure::Core(error)) => panic!("unexpected core error: {}", error.message),
    }
}

fn expect_usage(result: CliResult<i32>) -> String {
    match result {
        Err(Failure::Usage(message)) => message,
        Ok(_) => panic!("expected a usage error"),
        Err(Failure::Core(error)) => panic!("expected a usage error, got {}", error.message),
    }
}

fn record(record_type: u16, id: &str, fields: &[(&str, &str)]) -> ArchiveRecord {
    ArchiveRecord::new(
        record_type,
        id,
        fields
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect::<Vec<_>>(),
    )
}

fn with_blob(mut record: ArchiveRecord, blob: Vec<u8>) -> ArchiveRecord {
    record.blob = blob;
    record
}

fn write_snapshot(path: &Path, snapshot: &ArchiveSnapshot) {
    let bytes = snapshot.source.read(0, snapshot.source.size() as usize).unwrap();
    std::fs::write(path, bytes).unwrap();
}

fn seeded_archive(directory: &Path) -> (PathBuf, ArchiveSnapshot) {
    let path = directory.join("archive.tux");
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Seed", "", now_us()).unwrap()).unwrap();
    let student_id = new_uuid();
    let session_id = new_uuid();
    let archive = archive
        .append_records(&[
            record(RecordType::STUDENT, &student_id, &[("display_name", "Mina")]),
            record(
                RecordType::SESSION,
                &session_id,
                &[
                    ("student_id", student_id.as_str()),
                    ("session_type", "notes-only"),
                ],
            ),
            record(
                RecordType::ANNOTATION,
                &new_uuid(),
                &[("session_id", &session_id), ("text", "Hello")],
            ),
        ])
        .unwrap();
    write_snapshot(&path, &archive);
    (path, archive)
}

#[test]
fn verify_full_reports_full_semantic_counts() {
    let directory = tempfile::tempdir().unwrap();
    let (path, archive) = seeded_archive(directory.path());
    let mut output = Output::default();
    let code = expect_ok(run(
        "verify",
        arguments(&[path.to_str().unwrap(), "--full", "--json"]),
        &mut output,
    ));
    assert_eq!(code, 0);
    let value = output.json();
    assert_eq!(value["verificationScope"], "full-semantic");
    assert_eq!(value["valid"], true);
    assert_eq!(value["verified"], true);
    assert_eq!(value["historicalRevisionsVerified"], Value::Null);
    assert_eq!(value["commitsVerified"], Value::Null);
    assert!(value["records_checked"].as_u64().unwrap() >= archive.index_entry_count() as u64);
    assert!(value["index_pages_checked"].as_u64().unwrap() >= 1);
    assert_eq!(
        value["recordsVerified"].as_u64().unwrap(),
        value["records"].as_u64().unwrap()
    );
}

#[test]
fn verify_history_reports_revisions_and_commits() {
    let directory = tempfile::tempdir().unwrap();
    let (path, _) = seeded_archive(directory.path());
    let mut output = Output::default();
    let code = expect_ok(run(
        "verify",
        arguments(&[path.to_str().unwrap(), "--history", "--json"]),
        &mut output,
    ));
    assert_eq!(code, 0);
    let value = output.json();
    assert_eq!(
        value["verificationScope"],
        "reachable-revisions-and-committed-generations"
    );
    assert_eq!(value["valid"], true);
    assert_eq!(value["historicalRevisionsVerified"], 1);
    assert_eq!(value["commitsVerified"], 2);
    assert!(value["records_checked"].as_u64().unwrap() > 0);
}

#[test]
fn compact_prunes_unreferenced_assets_and_reports_counts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.tux");
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Compact", "", now_us()).unwrap())
            .unwrap();
    let manifest = new_uuid();
    let chunk = new_uuid();
    let archive = archive
        .append_records(&[
            with_blob(
                record(
                    RecordType::ASSET_BLOB,
                    &chunk,
                    &[
                        ("record_role", "asset-blob-chunk"),
                        ("manifest_id", manifest.as_str()),
                        ("chunk_index", "0"),
                    ],
                ),
                vec![1, 2],
            ),
            with_blob(
                record(
                    RecordType::ASSET_BLOB,
                    &manifest,
                    &[
                        ("record_role", "asset-blob-manifest"),
                        ("chunk_count", "1"),
                        ("chunk_ids", chunk.as_str()),
                    ],
                ),
                Vec::new(),
            ),
        ])
        .unwrap();
    write_snapshot(&path, &archive);
    let original = std::fs::read(&path).unwrap();

    let mut preview = Output::default();
    expect_ok(run(
        "compact",
        arguments(&[
            path.to_str().unwrap(),
            "--prune-unreferenced-assets",
            "--preview",
            "--json",
        ]),
        &mut preview,
    ));
    let preview = preview.json();
    assert_eq!(preview["applied"], false);
    assert_eq!(preview["prunedAssetRecords"], 2);
    assert_eq!(std::fs::read(&path).unwrap(), original);

    let mut applied = Output::default();
    expect_ok(run(
        "compact",
        arguments(&[
            path.to_str().unwrap(),
            "--prune-unreferenced-assets",
            "--json",
        ]),
        &mut applied,
    ));
    let applied = applied.json();
    assert_eq!(applied["applied"], true);
    assert_eq!(applied["prunedAssetRecords"], 2);
    assert!(applied["recordsPreserved"].as_u64().unwrap() >= 1);
    assert_ne!(std::fs::read(&path).unwrap(), original);
    let compacted = ArchiveSnapshot::open_bytes(std::fs::read(&path).unwrap()).unwrap();
    assert!(verify_full(&compacted).unwrap().valid);
    assert!(compacted
        .get_record(RecordType::ASSET_BLOB, &manifest)
        .unwrap()
        .is_none());
}

#[test]
fn backfill_reports_conflicting_counts_without_writing() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.tux");
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Backfill", "", now_us()).unwrap())
            .unwrap();
    let content_hash = "a".repeat(64);
    let archive = archive
        .append_records(&[
            with_blob(
                record(
                    RecordType::ASSET_BLOB,
                    &new_uuid(),
                    &[("content_hash", content_hash.as_str())],
                ),
                vec![1],
            ),
            with_blob(
                record(
                    RecordType::ASSET_BLOB,
                    &new_uuid(),
                    &[("content_hash", content_hash.as_str())],
                ),
                vec![2],
            ),
        ])
        .unwrap();
    write_snapshot(&path, &archive);
    let original = std::fs::read(&path).unwrap();

    let mut preview = Output::default();
    expect_ok(run(
        "backfill-indexes",
        arguments(&[path.to_str().unwrap(), "--json"]),
        &mut preview,
    ));
    let preview = preview.json();
    assert_eq!(preview["addedEntries"], 0);
    assert_eq!(preview["conflictingEntries"], 1);
    assert_eq!(preview["schemaVersionsUpdated"], false);
    assert_eq!(preview["applied"], false);
    assert_eq!(preview["previousGeneration"], preview["resultingGeneration"]);
    assert_eq!(std::fs::read(&path).unwrap(), original);

    let mut applied = Output::default();
    expect_ok(run(
        "backfill-indexes",
        arguments(&[path.to_str().unwrap(), "--apply", "--json"]),
        &mut applied,
    ));
    let applied = applied.json();
    assert_eq!(applied["applied"], true);
    assert_eq!(applied["conflictingEntries"], 1);
    assert_eq!(std::fs::read(&path).unwrap(), original);
}

#[test]
fn purge_trash_previews_without_writing_and_applies() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.tux");
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Trash", "", now_us()).unwrap()).unwrap();
    let kept = new_uuid();
    let deleted = new_uuid();
    let archive = archive
        .append_records(&[
            record(RecordType::STUDENT, &kept, &[("display_name", "Mina")]),
            record(RecordType::STUDENT, &deleted, &[("display_name", "Ben")]),
        ])
        .unwrap();
    let archive = archive
        .append_records(&[record(
            RecordType::STUDENT,
            &deleted,
            &[("display_name", "Ben"), ("_deleted", "true")],
        )])
        .unwrap();
    write_snapshot(&path, &archive);
    let original = std::fs::read(&path).unwrap();

    let mut preview = Output::default();
    expect_ok(run(
        "purge-trash",
        arguments(&[path.to_str().unwrap(), "--json"]),
        &mut preview,
    ));
    let preview = preview.json();
    assert_eq!(preview["status"], "preview");
    assert_eq!(preview["applied"], false);
    assert_eq!(preview["deletedRecords"], 1);
    assert_eq!(preview["blockers"], serde_json::json!([]));
    assert_eq!(preview["purgeRemovedRecords"], 0);
    assert_eq!(std::fs::read(&path).unwrap(), original);

    let mut applied = Output::default();
    expect_ok(run(
        "purge-trash",
        arguments(&[path.to_str().unwrap(), "--apply", "--json"]),
        &mut applied,
    ));
    let applied = applied.json();
    assert_eq!(applied["status"], "purged");
    assert_eq!(applied["applied"], true);
    assert_eq!(applied["deletedRecords"], 1);
    assert_eq!(applied["purgeRemovedRecords"], 1);
    assert_ne!(std::fs::read(&path).unwrap(), original);
    let reopened = ArchiveSnapshot::open_bytes(std::fs::read(&path).unwrap()).unwrap();
    assert!(reopened
        .get_record(RecordType::STUDENT, &deleted)
        .unwrap()
        .is_none());
    assert!(reopened
        .get_record(RecordType::STUDENT, &kept)
        .unwrap()
        .is_some());
    assert!(verify_full(&reopened).unwrap().valid);
}

#[test]
fn repair_recovers_a_checksum_damaged_header() {
    let directory = tempfile::tempdir().unwrap();
    let (path, archive) = seeded_archive(directory.path());
    let generation = archive.commit.generation;
    let mut damaged = std::fs::read(&path).unwrap();
    damaged[62] ^= 0xff;
    std::fs::write(&path, &damaged).unwrap();
    let destination = directory.path().join("repaired.tux");

    let mut output = Output::default();
    let code = expect_ok(run(
        "repair",
        arguments(&[
            path.to_str().unwrap(),
            "--output",
            destination.to_str().unwrap(),
            "--confirm-sensitive",
            "--json",
        ]),
        &mut output,
    ));
    assert_eq!(code, 0);
    let value = output.json();
    assert_eq!(value["status"], "repaired-copy");
    assert_eq!(value["original_preserved"], true);
    assert_eq!(
        value["selected_verified_generation"],
        generation.to_string()
    );
    assert_eq!(value["discarded_bytes"], "0");
    assert_eq!(value["discarded_record_frames"], 0);
    assert_eq!(std::fs::read(&path).unwrap(), damaged);
    let repaired = ArchiveSnapshot::open_bytes(std::fs::read(&destination).unwrap()).unwrap();
    assert!(verify_full(&repaired).unwrap().valid);
    assert_eq!(repaired.commit.generation, 1);
}

#[test]
fn recover_reports_a_damaged_header_and_refuses_in_place_apply() {
    let directory = tempfile::tempdir().unwrap();
    let (path, archive) = seeded_archive(directory.path());
    let generation = archive.commit.generation;
    let mut damaged = std::fs::read(&path).unwrap();
    damaged[62] ^= 0xff;
    std::fs::write(&path, &damaged).unwrap();

    let mut inspect = Output::default();
    let code = expect_ok(run(
        "recover",
        arguments(&[path.to_str().unwrap(), "--json"]),
        &mut inspect,
    ));
    assert_eq!(code, 0);
    let inspect = inspect.json();
    assert_eq!(inspect["inspection"]["archive_header_valid"], false);
    assert_eq!(inspect["inspection"]["header_repair_candidate"], true);
    assert_eq!(inspect["inspection"]["header_repair_available"], true);
    assert_eq!(
        inspect["inspection"]["header_repair_generation"],
        generation.to_string()
    );
    assert_eq!(inspect["applied"], false);

    let mut apply = Output::default();
    let message = expect_usage(run(
        "recover",
        arguments(&[path.to_str().unwrap(), "--apply", "--json"]),
        &mut apply,
    ));
    assert!(message.contains("archive repair"));
    assert_eq!(std::fs::read(&path).unwrap(), damaged);
}
