use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::core::archive::{create_archive_bytes, new_uuid, now_us, ArchiveSnapshot};
use crate::core::cli::{
    parse_arguments, CliContext, CliOutput, CliResult, Failure, ParsedArguments,
};
use crate::core::format::{ArchiveRecord, RecordType};

use super::save;

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
        serde_json::from_str(self.stdout.last().expect("stdout is empty")).expect("stdout is not JSON")
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

fn run(
    action: &str,
    args: ParsedArguments,
    output: &mut Output,
) -> CliResult<i32> {
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

fn seeded_archive(directory: &Path) -> (PathBuf, u64) {
    let path = directory.join("archive.tux");
    let snapshot =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Seed", "", now_us()).unwrap()).unwrap();
    let student_id = new_uuid();
    let session_id = new_uuid();
    let student = ArchiveRecord::new(
        RecordType::STUDENT,
        student_id.clone(),
        [("display_name", "Mina".to_owned())],
    );
    let session = ArchiveRecord::new(
        RecordType::SESSION,
        session_id.clone(),
        [
            ("student_id", student_id.clone()),
            ("session_type", "notes-only".to_owned()),
        ],
    );
    let annotation = ArchiveRecord::new(
        RecordType::ANNOTATION,
        new_uuid(),
        [
            ("session_id", session_id.clone()),
            ("text", "Hello".to_owned()),
        ],
    );
    let next = snapshot.append_records(&[student, session, annotation]).unwrap();
    std::fs::write(
        &path,
        next.source.read(0, next.source.size() as usize).unwrap(),
    )
    .unwrap();
    (path, next.commit.generation)
}

#[test]
fn init_reports_created_without_an_encrypted_field() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.tux");
    let mut output = Output::default();
    let code = expect_ok(run(
        "init",
        arguments(&[
            path.to_str().unwrap(),
            "--name",
            "Test archive",
            "--json",
        ]),
        &mut output,
    ));
    assert_eq!(code, 0);
    let value = output.json();
    let keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["bytes", "created", "name", "path"]);
    assert_eq!(value["name"], "Test archive");
    assert_eq!(value["created"], true);
    assert!(path.is_file());
}

#[test]
fn init_over_an_existing_path_is_a_usage_error() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.tux");
    std::fs::write(&path, b"existing").unwrap();
    let mut output = Output::default();
    let message = expect_usage(run(
        "init",
        arguments(&[path.to_str().unwrap(), "--name", "Again", "--json"]),
        &mut output,
    ));
    assert!(message.contains("Archive output already exists"));
}

#[test]
fn info_reports_verified_for_a_healthy_archive() {
    let directory = tempfile::tempdir().unwrap();
    let (path, _) = seeded_archive(directory.path());
    let mut output = Output::default();
    let code = expect_ok(run("info", arguments(&[path.to_str().unwrap(), "--json"]), &mut output));
    assert_eq!(code, 0);
    let value = output.json();
    assert_eq!(value["verified"], true);
    assert_eq!(value["valid"], true);
    assert_eq!(value["records"], value["recordsVerified"]);
    assert_eq!(value["health"], "healthy");
}

#[test]
fn sanitize_preview_reports_counts_without_writing() {
    let directory = tempfile::tempdir().unwrap();
    let (path, generation) = seeded_archive(directory.path());
    let destination = directory.path().join("sanitized.tux");
    let mut output = Output::default();
    let code = expect_ok(run(
        "sanitize",
        arguments(&[
            path.to_str().unwrap(),
            "--output",
            destination.to_str().unwrap(),
            "--json",
        ]),
        &mut output,
    ));
    assert_eq!(code, 0);
    let value = output.json();
    assert_eq!(value["status"], "preview-required");
    assert_eq!(value["students"], 1);
    assert_eq!(value["sessions"], 1);
    assert_eq!(value["annotations"], 1);
    assert_eq!(value["assets"], 0);
    assert_eq!(value["evidence_items"], 0);
    assert_eq!(value["guides"], 0);
    assert_eq!(value["recording_tracks"], 0);
    assert_eq!(value["recording_chunks"], 0);
    assert_eq!(value["generation_logs"], 0);
    assert_eq!(value["credentials"], 0);
    assert_eq!(value["encrypted_output"], false);
    assert_eq!(value["source_generation"], generation.to_string());
    assert_eq!(
        value["selection_fingerprint"].as_str().unwrap().len(),
        64
    );
    assert!(!destination.exists());
}

#[test]
fn sanitize_confirmation_publishes_the_reviewed_selection() {
    let directory = tempfile::tempdir().unwrap();
    let (path, generation) = seeded_archive(directory.path());
    let destination = directory.path().join("sanitized.tux");
    let mut preview = Output::default();
    expect_ok(run(
        "sanitize",
        arguments(&[
            path.to_str().unwrap(),
            "--output",
            destination.to_str().unwrap(),
            "--json",
        ]),
        &mut preview,
    ));
    let preview = preview.json();
    let fingerprint = preview["selection_fingerprint"].as_str().unwrap().to_owned();
    let mut output = Output::default();
    let code = expect_ok(run(
        "sanitize",
        arguments(&[
            path.to_str().unwrap(),
            "--output",
            destination.to_str().unwrap(),
            "--confirm-sensitive",
            "--expected-generation",
            &generation.to_string(),
            "--expected-selection",
            &fingerprint,
            "--expected-output",
            destination.to_str().unwrap(),
            "--expected-encrypted-output",
            "no",
            "--json",
        ]),
        &mut output,
    ));
    assert_eq!(code, 0);
    let value = output.json();
    assert_eq!(value["status"], "created");
    assert_eq!(value["students"], 1);
    assert_eq!(value["sessions"], 1);
    assert_eq!(value["annotations"], 1);
    assert!(destination.is_file());
    let copied = ArchiveSnapshot::open_bytes(std::fs::read(&destination).unwrap()).unwrap();
    let students = copied.list_record_metadata(RecordType::STUDENT, true).unwrap();
    let sessions = copied.list_record_metadata(RecordType::SESSION, true).unwrap();
    let annotations = copied.list_record_metadata(RecordType::ANNOTATION, true).unwrap();
    assert_eq!(students.len(), 1);
    assert_eq!(sessions.len(), 1);
    assert_eq!(annotations.len(), 1);
    assert_eq!(
        annotations[0].field("session_id"),
        Some(sessions[0].id.as_str())
    );
    copied.verify().unwrap();
}

#[test]
fn sanitize_confirmation_requires_every_reviewed_field() {
    let directory = tempfile::tempdir().unwrap();
    let (path, _) = seeded_archive(directory.path());
    let destination = directory.path().join("sanitized.tux");
    let mut output = Output::default();
    let message = expect_usage(run(
        "sanitize",
        arguments(&[
            path.to_str().unwrap(),
            "--output",
            destination.to_str().unwrap(),
            "--confirm-sensitive",
            "--json",
        ]),
        &mut output,
    ));
    assert!(message.contains("Confirm the reviewed preview"));
}

#[test]
fn sanitize_confirmation_rejects_a_different_selection() {
    let directory = tempfile::tempdir().unwrap();
    let (path, generation) = seeded_archive(directory.path());
    let destination = directory.path().join("sanitized.tux");
    let mut output = Output::default();
    let message = expect_usage(run(
        "sanitize",
        arguments(&[
            path.to_str().unwrap(),
            "--output",
            destination.to_str().unwrap(),
            "--confirm-sensitive",
            "--expected-generation",
            &generation.to_string(),
            "--expected-selection",
            &"0".repeat(64),
            "--expected-output",
            destination.to_str().unwrap(),
            "--expected-encrypted-output",
            "no",
            "--json",
        ]),
        &mut output,
    ));
    assert!(message.contains("selection differs"));
}

#[test]
fn save_replaces_the_destination_while_a_source_handle_is_open() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.tux");
    std::fs::write(&path, b"old archive bytes").unwrap();
    let source = crate::core::source::FileSource::open(&path).unwrap();
    save::save_bytes(&path, b"replacement archive bytes").unwrap();
    drop(source);
    assert_eq!(std::fs::read(&path).unwrap(), b"replacement archive bytes");
}
