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

#[test]
fn locator_straddling_a_recovery_chunk_boundary_is_found() {
    let mut bytes = super::create_archive_bytes("Boundary", "", 1).unwrap();
    let locator = bytes
        .windows(8)
        .rposition(|window| window == b"TUXLOC1\0")
        .expect("created archive has a publication locator");
    let original_length = bytes.len();
    // Place the last locator five bytes before a 64 KiB scan boundary. The scan
    // reads an overlap but previously discarded candidates before chunk_start.
    bytes.extend(std::iter::repeat_n(0u8, 65_536 + 5 - 32));
    let snapshot = ArchiveSnapshot::open_bytes(bytes).expect("archive with a crash tail opens");
    assert_eq!(snapshot.published_end_offset, original_length as u64);
    assert_eq!(snapshot.commit.generation, 1);
    assert!(snapshot.published_end_offset < snapshot.source.size());
    assert!(snapshot.published_end_offset > 0);
    assert_eq!(locator + 32, original_length);
}

#[test]
fn every_truncation_of_a_valid_archive_is_rejected_without_panicking() {
    let bytes = super::create_archive_bytes("Truncation", "", 1).unwrap();
    for length in 0..bytes.len() {
        assert!(
            ArchiveSnapshot::open_bytes(bytes[..length].to_vec()).is_err(),
            "a truncated archive opened at byte {length}"
        );
    }
}

#[test]
fn mutated_archive_bytes_never_panic_the_parser() {
    let bytes = super::create_archive_bytes("Mutations", "", 1).unwrap();
    for index in 0..bytes.len() {
        for mask in [0x01u8, 0x80, 0xff] {
            let mut mutated = bytes.clone();
            mutated[index] ^= mask;
            let _ = ArchiveSnapshot::open_bytes(mutated);
        }
    }
}

#[test]
fn random_archive_shaped_input_never_panics_the_parser() {
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    for length in 0..512usize {
        let mut bytes = vec![0u8; length];
        for byte in &mut bytes {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *byte = state as u8;
        }
        if bytes.len() >= 8 {
            bytes[..8].copy_from_slice(b"TUTORUX\0");
        }
        let _ = ArchiveSnapshot::open_bytes(bytes);
    }
}
