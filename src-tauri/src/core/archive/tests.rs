use crate::core::archive::{new_uuid, ArchiveSnapshot};
use crate::core::format::{ArchiveRecord, RecordType};

#[test]
fn plain_archive_round_trips() {
    let bytes = super::create_archive_bytes("Test archive", "", 1).unwrap();
    let snapshot = ArchiveSnapshot::open_bytes(bytes).unwrap();
    assert_eq!(
        snapshot.get_manifest().unwrap().display_name,
        "Test archive"
    );
    let updated = snapshot
        .append_records(&[ArchiveRecord::new(
            RecordType::STUDENT,
            new_uuid(),
            [("display_name", "Mina")],
        )])
        .unwrap();
    assert_eq!(updated.get_manifest().unwrap().display_name, "Test archive");
}

#[test]
fn encrypted_archive_round_trips() {
    let passphrase = "a sufficiently long passphrase";
    let bytes = super::create_encrypted_archive_bytes("Secret archive", "", passphrase, 1).unwrap();
    let locked = ArchiveSnapshot::open_bytes(bytes).unwrap();
    assert!(locked.locked());
    let unlocked = locked.unlock(passphrase).unwrap();
    assert_eq!(
        unlocked.get_manifest().unwrap().display_name,
        "Secret archive"
    );
}

#[test]
fn reads_typescript_encrypted_fixture() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("encrypted-v1.tux");
    let bytes = std::fs::read(path).expect("fixture exists");
    let locked = ArchiveSnapshot::open_bytes(bytes).expect("fixture opens");
    assert!(locked.locked());
    let unlocked = locked
        .unlock("Tutorux cross-language fixture phrase 2026")
        .expect("fixture unlocks");
    let result = unlocked.verify().expect("fixture verifies");
    assert_eq!(result.current_records, 3);
    let students = unlocked
        .list_records(RecordType::STUDENT, true)
        .expect("students list");
    assert_eq!(students.len(), 1);
    assert_eq!(students[0].field("display_name"), Some("Interop Student"));
}
