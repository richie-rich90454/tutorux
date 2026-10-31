use crate::core::archive::{
    create_archive_bytes, new_uuid, ArchiveRecord, ArchiveSnapshot, RecordType,
};

macro_rules! fields {
    ($($key:expr => $value:expr),* $(,)?) => {
        vec![$(($key.to_string(), $value.to_string())),*]
    };
}

fn record(record_type: u16, id: &str, fields: Vec<(String, String)>) -> ArchiveRecord {
    ArchiveRecord::new(record_type, id, fields)
}

#[test]
fn append_marks_cited_guide_blocks_stale() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Guide freshness", "", 1).unwrap())
            .unwrap();
    let source_id = new_uuid();
    let guide_id = new_uuid();
    let source = record(
        RecordType::STUDENT,
        &source_id,
        fields! {"display_name" => "Mina"},
    );
    let guide = record(
        RecordType::GUIDE,
        &guide_id,
        fields! {
            "section_count" => "1",
            "section.0.heading" => "Observed progress",
            "section.0.block_count" => "1",
            "section.0.block.0.kind" => "paragraph",
            "section.0.block.0.text" => "Mina explained the scale factor.",
            "section.0.block.0.source_ids" => source_id,
            "section.0.block.0.stale" => "false",
            "stale_block_count" => "0"
        },
    );
    let source_archive = archive.append_records(&[source.clone()]).unwrap();
    let created = source_archive.append_records(&[guide]).unwrap();
    let changed = created
        .append_records(&[record(
            RecordType::STUDENT,
            &source_id,
            fields! {"display_name" => "Mina updated"},
        )])
        .unwrap();
    let stale = changed
        .get_record(RecordType::GUIDE, &guide_id)
        .unwrap()
        .unwrap();
    assert_eq!(stale.revision, 2);
    assert_eq!(stale.field("section.0.block.0.stale"), Some("true"));
    assert_eq!(stale.field("stale_block_count"), Some("1"));
    assert_eq!(stale.field("stale_source_id"), Some(source_id.as_str()));

    let mut reviewed = stale.clone();
    reviewed
        .fields
        .insert("section.0.block.0.source_ids".to_owned(), String::new());
    reviewed
        .fields
        .insert("section.0.block.0.stale".to_owned(), "false".to_owned());
    reviewed
        .fields
        .insert("stale_block_count".to_owned(), "0".to_owned());
    let reviewed_archive = changed.append_records(&[reviewed]).unwrap();
    let reviewed_guide = reviewed_archive
        .get_record(RecordType::GUIDE, &guide_id)
        .unwrap()
        .unwrap();
    let changed_again = reviewed_archive
        .append_records(&[record(
            RecordType::STUDENT,
            &source_id,
            fields! {"display_name" => "Mina updated again"},
        )])
        .unwrap();
    let still = changed_again
        .get_record(RecordType::GUIDE, &guide_id)
        .unwrap()
        .unwrap();
    assert_eq!(still.revision, reviewed_guide.revision);
    assert_eq!(still.field("stale_block_count"), Some("0"));
}

#[test]
fn append_keeps_audio_chunk_identity_immutable() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Audio identity", "", 1).unwrap())
            .unwrap();
    let session = new_uuid();
    let track = new_uuid();
    let chunk = new_uuid();
    let archive = archive
        .append_records(&[record(
            RecordType::AUDIO_CHUNK,
            &chunk,
            fields! {
                "session_id" => session,
                "track_id" => track,
                "sequence_number" => "0",
                "codec" => "aac"
            },
        )])
        .unwrap();
    let error = archive
        .append_records(&[record(
            RecordType::AUDIO_CHUNK,
            &chunk,
            fields! {
                "session_id" => session,
                "track_id" => track,
                "sequence_number" => "1",
                "codec" => "aac"
            },
        )])
        .unwrap_err();
    assert_eq!(error.code, "audio_chunk_identity_immutable");
}

#[test]
fn append_requires_a_clean_committed_tail() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Studio", "", 1).unwrap()).unwrap();
    let dirty_source = std::sync::Arc::new(crate::core::source::CompositeSource::new(
        std::sync::Arc::clone(&archive.source),
        std::sync::Arc::new(crate::core::source::MemorySource::new(vec![1, 2, 3])),
    ));
    let dirty = ArchiveSnapshot::open(dirty_source).unwrap();
    let error = dirty
        .append_records(&[record(
            RecordType::STUDENT,
            &new_uuid(),
            fields! {"display_name" => "Mina"},
        )])
        .unwrap_err();
    assert_eq!(error.code, "archive_recovery_required");
}

struct BytesStaging {
    bytes: Vec<u8>,
}

impl crate::core::archive::ArchiveStaging for BytesStaging {
    fn append(&mut self, bytes: &[u8]) -> crate::core::error::Result<()> {
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn seal(
        &mut self,
    ) -> crate::core::error::Result<std::sync::Arc<dyn crate::core::source::ByteSource>> {
        Ok(std::sync::Arc::new(crate::core::source::MemorySource::new(
            self.bytes.clone(),
        )))
    }

    fn abort(&mut self) -> crate::core::error::Result<()> {
        self.bytes.clear();
        Ok(())
    }
}

#[test]
fn staged_asset_append_uses_staging_and_verifies_indexes() {
    let archive =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Staged assets", "", 1).unwrap()).unwrap();
    let blob = new_uuid();
    let metadata = new_uuid();
    let mut staging = BytesStaging { bytes: Vec::new() };
    let updated = crate::core::archive::append_staged_asset_records(
        &archive,
        vec![
            ArchiveRecord::new(
                RecordType::ASSET_BLOB,
                &blob,
                [("content_hash", "a".repeat(64))],
            ),
            ArchiveRecord::new(
                RecordType::ASSET_METADATA,
                &metadata,
                [("record_role", "material"), ("blob_id", blob.as_str())],
            ),
        ],
        &mut staging,
    )
    .unwrap();
    assert_eq!(updated.commit.generation, 2);
    assert!(!staging.bytes.is_empty());
    assert!(updated
        .get_record(RecordType::ASSET_BLOB, &blob)
        .unwrap()
        .is_some());
    assert!(updated
        .get_record(RecordType::ASSET_METADATA, &metadata)
        .unwrap()
        .is_some());
    assert!(updated.verify().is_ok());
}
