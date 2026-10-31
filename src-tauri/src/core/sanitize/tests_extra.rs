use crate::core::archive::{
    create_encrypted_archive_bytes, new_uuid, ArchiveRecord, ArchiveSnapshot, RecordType,
};
use crate::core::sanitize::test_support::{create_source, options_student};
use crate::core::sanitize::*;

#[test]
fn rejects_stale_previews_and_invalid_selections() {
    let (snapshot, ids) = create_source();
    let options = options_student(&ids);
    let preview = preview_sanitized_copy(&snapshot, &options).unwrap();
    let changed = SanitizedCopyOptions {
        include_private_annotations: true,
        ..options.clone()
    };
    let error = create_sanitized_copy(&snapshot, &changed, &preview, None).unwrap_err();
    assert_eq!(error.code, "sanitized_copy_selection_changed");
    let credentials = preview_sanitized_copy(
        &snapshot,
        &SanitizedCopyOptions {
            include_credentials: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(credentials.credentials, 0);
    let error = preview_sanitized_copy(
        &snapshot,
        &SanitizedCopyOptions {
            include_students: [new_uuid()].into_iter().collect(),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "sanitized_copy_student_missing");
}

#[test]
fn encrypted_copy_requires_passphrase_and_includes_credentials_on_request() {
    let source_passphrase = "Source archive phrase for sanitizer";
    let destination_passphrase = "Destination archive phrase for sanitizer";
    let api_credential = "secret-provider-token-that-must-stay-encrypted";
    let student_id = new_uuid();
    let credential_id = new_uuid();
    let locked = ArchiveSnapshot::open_bytes(
        create_encrypted_archive_bytes("Protected sanitize source", "", source_passphrase, 1)
            .unwrap(),
    )
    .unwrap();
    let unlocked = locked.unlock(source_passphrase).unwrap();
    let snapshot = unlocked
        .append_records(&[
            ArchiveRecord::new(RecordType::STUDENT, &student_id, [("display_name", "Mina")]),
            ArchiveRecord::new(
                RecordType::SETTINGS,
                &credential_id,
                [
                    ("record_role", "credential"),
                    ("key", "openai-api-key"),
                    ("value", api_credential),
                ],
            ),
        ])
        .unwrap();
    let options = SanitizedCopyOptions {
        include_students: [student_id.clone()].into_iter().collect(),
        include_credentials: true,
        ..Default::default()
    };
    let preview = preview_sanitized_copy(&snapshot, &options).unwrap();
    assert_eq!(preview.students, 1);
    assert_eq!(preview.credentials, 1);
    let error = create_sanitized_copy(&snapshot, &options, &preview, None).unwrap_err();
    assert_eq!(error.code, "sanitized_copy_encryption_required");
    let copy =
        create_sanitized_copy(&snapshot, &options, &preview, Some(destination_passphrase)).unwrap();
    assert!(copy.snapshot.encrypted());
    assert!(!copy.snapshot.locked());
    assert_eq!(copy.snapshot.verify().unwrap().current_records, 4);
    let credential = copy
        .snapshot
        .get_record(RecordType::SETTINGS, &credential_id)
        .unwrap()
        .unwrap();
    assert_eq!(credential.field("value"), Some(api_credential));
    let bytes = copy
        .snapshot
        .source
        .read(0, copy.snapshot.source.size() as usize)
        .unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains(api_credential));
    let locked_output = ArchiveSnapshot::open_bytes(bytes).unwrap();
    assert!(locked_output.unlock(source_passphrase).is_err());
    let reopened = locked_output.unlock(destination_passphrase).unwrap();
    assert_eq!(reopened.verify().unwrap().current_records, 4);
}

#[test]
fn rejects_locked_source() {
    let locked = ArchiveSnapshot::open_bytes(
        create_encrypted_archive_bytes(
            "Locked source",
            "",
            "Source archive phrase for sanitizer",
            1,
        )
        .unwrap(),
    )
    .unwrap();
    let error = preview_sanitized_copy(&locked, &SanitizedCopyOptions::default()).unwrap_err();
    assert_eq!(error.code, "archive_locked");
}

#[test]
fn plan_exposes_keep_sets() {
    let (snapshot, ids) = create_source();
    let plan = plan_sanitized_copy(&snapshot, &options_student(&ids)).unwrap();
    assert_eq!(plan.summary.students, 1);
    assert!(plan.kept(RecordType::STUDENT).contains(&ids.student_a));
    assert!(!plan.kept(RecordType::STUDENT).contains(&ids.student_b));
}
