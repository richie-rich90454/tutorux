use super::*;
use crate::core::archive::{
    create_archive_bytes, create_encrypted_archive_bytes, new_uuid, verify_full, ArchiveSnapshot,
};
use crate::core::format::ArchiveRecord;
use crate::core::format::RecordType;
use crate::core::index::read_frame_at;
use crate::core::source::{CompositeSource, MemorySource};
use std::sync::Arc;

macro_rules! fields {
        ($($key:expr => $value:expr),* $(,)?) => {
            vec![$(($key.to_string(), $value.to_string())),*]
        };
    }

fn record(record_type: u16, id: &str, fields: Vec<(String, String)>) -> ArchiveRecord {
    ArchiveRecord::new(record_type, id, fields)
}

fn archive_bytes(snapshot: &ArchiveSnapshot) -> Vec<u8> {
    snapshot
        .source
        .read(0, snapshot.source.size() as usize)
        .unwrap()
}

#[test]
fn compaction_preserves_every_revision_and_unknown_payloads() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Compaction", "", 1).unwrap()).unwrap();
    let student = new_uuid();
    let extension = new_uuid();
    let first = archive
        .append_records(&[
            record(
                RecordType::STUDENT,
                &student,
                fields! {"notes" => "First revision ".repeat(64)},
            ),
            record(
                99,
                &extension,
                fields! {"extension_payload" => "First extension revision ".repeat(64)},
            ),
        ])
        .unwrap();
    let current = first
        .append_records(&[
            record(
                RecordType::STUDENT,
                &student,
                fields! {"notes" => "Second revision"},
            ),
            record(
                99,
                &extension,
                fields! {"extension_payload" => "Second extension revision"},
            ),
        ])
        .unwrap();
    let old_extension_offset = current
        .all_index_entries()
        .get(&format!("UNKNOWN:{extension}"))
        .copied()
        .unwrap();
    let old_extension_frame = read_frame_at(current.source.as_ref(), old_extension_offset).unwrap();
    let old_student_history = current.record_chain(RecordType::STUDENT, &student).unwrap();

    let result = compact_archive_result(&current).unwrap();
    assert_eq!(result.preserved_records, 7);
    assert_eq!(result.pruned_asset_records, 0);
    assert!(result.compacted_bytes < result.original_bytes);
    let compacted = ArchiveSnapshot::open_bytes(result.bytes).unwrap();
    assert_eq!(compacted.commit.generation, 1);
    assert_eq!(compacted.header.id, current.header.id);
    assert_eq!(
        compacted.all_index_entries().keys().collect::<Vec<_>>(),
        current.all_index_entries().keys().collect::<Vec<_>>()
    );
    let new_student_history = compacted
        .record_chain(RecordType::STUDENT, &student)
        .unwrap();
    assert_eq!(
        old_student_history
            .iter()
            .map(|record| record.fields.clone())
            .collect::<Vec<_>>(),
        new_student_history
            .iter()
            .map(|record| record.fields.clone())
            .collect::<Vec<_>>()
    );
    let new_extension_offset = compacted
        .all_index_entries()
        .get(&format!("UNKNOWN:{extension}"))
        .copied()
        .unwrap();
    let new_extension_frame =
        read_frame_at(compacted.source.as_ref(), new_extension_offset).unwrap();
    assert_eq!(old_extension_frame.codec, new_extension_frame.codec);
    assert_eq!(
        old_extension_frame.stored_payload,
        new_extension_frame.stored_payload
    );
    assert!(verify_full(&compacted).unwrap().valid);
}

#[test]
fn repair_selects_newest_fully_verified_generation() {
    let initial =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Repair", "", 1).unwrap()).unwrap();
    let student = new_uuid();
    let generation_two = initial
        .append_records(&[record(
            RecordType::STUDENT,
            &student,
            fields! {"display_name" => "Mina"},
        )])
        .unwrap();
    let generation_three = generation_two
        .append_records(&[record(
            RecordType::STUDENT,
            &student,
            fields! {"display_name" => "Corrupted newest revision"},
        )])
        .unwrap();
    let mut damaged_bytes = archive_bytes(&generation_three);
    let latest_offset = generation_three
        .all_index_entries()
        .get(&format!("STUDENT:{student}"))
        .copied()
        .unwrap();
    damaged_bytes[latest_offset as usize + 64] ^= 0xff;
    let corrupted_bytes = damaged_bytes.clone();
    let damaged = ArchiveSnapshot::open_bytes(damaged_bytes).unwrap();
    assert!(!verify_full(&damaged).unwrap().valid);

    let repaired = repair_archive_result(&damaged).unwrap();
    assert_eq!(repaired.selected_generation, 2);
    assert!(repaired.discarded_trailing_bytes > 0);
    let reopened = ArchiveSnapshot::open_bytes(repaired.bytes.clone()).unwrap();
    assert_eq!(reopened.commit.generation, 1);
    assert_eq!(
        reopened
            .get_record(RecordType::STUDENT, &student)
            .unwrap()
            .unwrap()
            .field("display_name"),
        Some("Mina")
    );
    assert_eq!(archive_bytes(&damaged), corrupted_bytes);
    assert!(verify_full(&reopened).unwrap().valid);
}

#[test]
fn recovers_complete_unpublished_generation() {
    let initial =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Recovery", "", 1).unwrap()).unwrap();
    let student = new_uuid();
    let complete = initial
        .append_records(&[record(
            RecordType::STUDENT,
            &student,
            fields! {"display_name" => "Mina"},
        )])
        .unwrap();
    let mut bytes = archive_bytes(&complete);
    bytes.truncate(bytes.len() - 32);
    let prior = ArchiveSnapshot::open_bytes(bytes.clone()).unwrap();
    assert_eq!(prior.commit.generation, 1);
    let inspection = inspect_recovery(&prior).unwrap();
    assert_eq!(inspection.candidate_generation, 2);
    assert!(inspection.has_unpublished_commit);
    assert!(inspection.recoverable);
    assert_eq!(inspection.recoverable_generation, 2);
    assert_eq!(inspection.recovered_generations, 1);
    let (recovered_bytes, generation, generations, discarded) =
        recover_unpublished(&prior).unwrap();
    assert_eq!(generation, 2);
    assert_eq!(generations, 1);
    assert_eq!(discarded, 0);
    let recovered = ArchiveSnapshot::open_bytes(recovered_bytes).unwrap();
    assert_eq!(
        recovered
            .get_record(RecordType::STUDENT, &student)
            .unwrap()
            .unwrap()
            .revision,
        1
    );
    assert!(verify_full(&recovered).unwrap().valid);
}

#[test]
fn recovery_discards_crash_tail_after_commit() {
    let initial =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Crash tail", "", 1).unwrap()).unwrap();
    let student = new_uuid();
    let complete = initial
        .append_records(&[record(
            RecordType::STUDENT,
            &student,
            fields! {"display_name" => "Mina"},
        )])
        .unwrap();
    let mut bytes = archive_bytes(&complete);
    bytes.truncate(bytes.len() - 32);
    bytes.extend_from_slice(&[9u8; 16]);
    let prior = ArchiveSnapshot::open_bytes(bytes).unwrap();
    assert_eq!(prior.commit.generation, 1);
    let (recovered_bytes, generation, generations, discarded) =
        recover_unpublished(&prior).unwrap();
    assert_eq!(generation, 2);
    assert_eq!(generations, 1);
    assert_eq!(discarded, 16);
    assert!(
        verify_full(&ArchiveSnapshot::open_bytes(recovered_bytes).unwrap())
            .unwrap()
            .valid
    );
}

#[test]
fn repair_finds_locator_after_crash_bytes() {
    let initial =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Locator scan", "", 1).unwrap()).unwrap();
    let student = new_uuid();
    let complete = initial
        .append_records(&[record(
            RecordType::STUDENT,
            &student,
            fields! {"display_name" => "Mina"},
        )])
        .unwrap();
    let bytes = archive_bytes(&complete);
    let locator = &bytes[bytes.len() - 32..];
    let commit_end = bytes.len() - 32;
    let mut damaged = Vec::with_capacity(bytes.len() + 24);
    damaged.extend_from_slice(&bytes[..commit_end]);
    damaged.extend_from_slice(&[1u8; 16]);
    damaged.extend_from_slice(locator);
    damaged.extend_from_slice(&[2u8; 8]);
    let snapshot = ArchiveSnapshot::open_bytes(damaged).unwrap();
    assert_eq!(snapshot.commit.generation, 2);
    assert_eq!(snapshot.source.size() - snapshot.published_end_offset, 8);
    let repaired = repair_archive_result(&snapshot).unwrap();
    assert_eq!(repaired.selected_generation, 2);
    assert_eq!(repaired.discarded_trailing_bytes, 8);
    assert_eq!(repaired.discarded_record_frames, 0);
    assert_eq!(repaired.unattributed_bytes, 8);
    let reopened = ArchiveSnapshot::open_bytes(repaired.bytes).unwrap();
    assert_eq!(
        reopened
            .get_record(RecordType::STUDENT, &student)
            .unwrap()
            .unwrap()
            .field("display_name"),
        Some("Mina")
    );
}

#[test]
fn opens_for_recovery_without_any_locator() {
    let mut bytes = create_archive_bytes("No locator", "", 1).unwrap();
    bytes.truncate(bytes.len() - 32);
    assert!(ArchiveSnapshot::open_bytes(bytes.clone()).is_err());
    let source_inspection =
        inspect_recovery_source(Arc::new(MemorySource::new(bytes.clone())), None).unwrap();
    assert!(source_inspection.recoverable);
    let recovered = ArchiveSnapshot::open_for_recovery(Arc::new(MemorySource::new(bytes))).unwrap();
    assert_eq!(recovered.commit.generation, 1);
    let inspection = inspect_recovery(&recovered).unwrap();
    assert!(inspection.recoverable);
    assert_eq!(inspection.recovered_generations, 0);
    let (published, generation, generations, discarded) = recover_unpublished(&recovered).unwrap();
    assert_eq!(generation, 1);
    assert_eq!(generations, 0);
    assert_eq!(discarded, 0);
    assert!(ArchiveSnapshot::open_bytes(published).is_ok());
}

#[test]
fn discard_tail_never_mutates_source() {
    let initial =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Discard", "", 1).unwrap()).unwrap();
    let dirty_source = Arc::new(CompositeSource::new(
        Arc::clone(&initial.source),
        Arc::new(MemorySource::new(vec![7u8; 16])),
    ));
    let dirty = ArchiveSnapshot::open(dirty_source).unwrap();
    let original_size = dirty.source.size();
    let bytes = discard_tail(&dirty).unwrap();
    assert_eq!(bytes.len() as u64, dirty.published_end_offset);
    assert_eq!(dirty.source.size(), original_size);
    assert!(
        verify_full(&ArchiveSnapshot::open_bytes(bytes).unwrap())
            .unwrap()
            .valid
    );
}

#[test]
fn compaction_preserves_opaque_payload_bytes() {
    use crate::core::format::encode_record_frame;

    let initial =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Opaque", "", 1).unwrap()).unwrap();
    let extension = new_uuid();
    let with_extension = initial
        .append_records(&[record(
            99,
            &extension,
            fields! {"extension" => "temporary structured payload"},
        )])
        .unwrap();
    let offset = with_extension
        .all_index_entries()
        .get(&format!("UNKNOWN:{extension}"))
        .copied()
        .unwrap();
    let original = read_frame_at(with_extension.source.as_ref(), offset).unwrap();
    let opaque_payload = vec![0xa5u8; original.payload_length as usize];
    let opaque_frame = encode_record_frame(
        original.record_type,
        &original.id,
        original.revision,
        original.previous_offset,
        &opaque_payload,
        original.codec,
        0,
    )
    .unwrap();
    assert_eq!(opaque_frame.len() as u64, original.end_offset - offset);
    let mut bytes = archive_bytes(&with_extension);
    bytes[offset as usize..offset as usize + opaque_frame.len()].copy_from_slice(&opaque_frame);
    let opaque = ArchiveSnapshot::open_bytes(bytes).unwrap();
    assert!(verify_full(&opaque).unwrap().valid);

    let compacted = ArchiveSnapshot::open_bytes(compact_archive(&opaque).unwrap()).unwrap();
    let copied_offset = compacted
        .all_index_entries()
        .get(&format!("UNKNOWN:{extension}"))
        .copied()
        .unwrap();
    let copied = read_frame_at(compacted.source.as_ref(), copied_offset).unwrap();
    assert_eq!(copied.stored_payload, opaque_payload);
    assert!(verify_full(&compacted).unwrap().valid);
}

#[test]
fn rebuilds_primary_index_copy() {
    let bytes = create_archive_bytes("Index repair", "", 1).unwrap();
    let rebuilt_bytes = rebuild_damaged_primary_index(Arc::new(MemorySource::new(bytes))).unwrap();
    let rebuilt = ArchiveSnapshot::open_bytes(rebuilt_bytes).unwrap();
    assert!(verify_full(&rebuilt).unwrap().valid);
    assert_eq!(rebuilt.get_manifest().unwrap().display_name, "Index repair");
}

#[test]
fn enables_encryption_and_preserves_records() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Plain", "", 1).unwrap()).unwrap();
    let student = new_uuid();
    let archive = archive
        .append_records(&[record(
            RecordType::STUDENT,
            &student,
            fields! {"display_name" => "Mina"},
        )])
        .unwrap();
    let passphrase = "encryption conversion passphrase";
    let bytes = enable_encryption(&archive, passphrase).unwrap();
    let locked = ArchiveSnapshot::open_bytes(bytes).unwrap();
    assert!(locked.locked());
    assert!(verify_full(&locked).unwrap().issues[0].contains("Unlock"));
    let unlocked = locked.unlock(passphrase).unwrap();
    assert!(verify_full(&unlocked).unwrap().valid);
    assert_eq!(
        unlocked
            .get_record(RecordType::STUDENT, &student)
            .unwrap()
            .unwrap()
            .field("display_name"),
        Some("Mina")
    );
}

#[test]
fn encrypted_compaction_and_rekey_round_trip() {
    let passphrase = "a sufficiently long passphrase";
    let locked = ArchiveSnapshot::open_bytes(
        create_encrypted_archive_bytes("Secret", "", passphrase, 1).unwrap(),
    )
    .unwrap();
    let unlocked = locked.unlock(passphrase).unwrap();
    let student = new_uuid();
    let updated = unlocked
        .append_records(&[record(
            RecordType::STUDENT,
            &student,
            fields! {"display_name" => "Mina"},
        )])
        .unwrap();
    assert!(verify_full(&updated).unwrap().valid);
    let compacted_bytes = compact_archive(&updated).unwrap();
    let compacted_locked = ArchiveSnapshot::open_bytes(compacted_bytes).unwrap();
    let compacted = compacted_locked.unlock(passphrase).unwrap();
    assert!(verify_full(&compacted).unwrap().valid);
    assert_eq!(
        compacted
            .get_record(RecordType::STUDENT, &student)
            .unwrap()
            .unwrap()
            .field("display_name"),
        Some("Mina")
    );

    let new_passphrase = "another sufficiently long passphrase";
    let rekeyed_bytes = change_passphrase(&compacted, new_passphrase).unwrap();
    let rekeyed_locked = ArchiveSnapshot::open_bytes(rekeyed_bytes).unwrap();
    assert!(rekeyed_locked.unlock(passphrase).is_err());
    let rekeyed = rekeyed_locked.unlock(new_passphrase).unwrap();
    assert!(verify_full(&rekeyed).unwrap().valid);
    assert_eq!(
        rekeyed
            .get_record(RecordType::STUDENT, &student)
            .unwrap()
            .unwrap()
            .field("display_name"),
        Some("Mina")
    );
}
